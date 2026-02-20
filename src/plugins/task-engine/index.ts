import { randomUUID } from 'node:crypto';
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { TaskStateMachine, StateMachineAction } from './state-machine.js';
import { ResourceAwareScheduler } from './scheduler.js';
import { runMigrations } from './migrations.js';
import type {
  TaskType,
  TaskConstraints,
  RetryPolicy,
  TaskSubmitPayload,
  TaskEngineState,
  WorkflowSubmitPayload,
  WorkflowState,
  WorkflowTaskDef,
} from './types.js';
import type Database from 'better-sqlite3';
import type { Logger } from 'winston';

const SCHEDULE_INTERVAL_MS = 2000;

export class TaskEnginePlugin implements Plugin {
  name = 'task-engine';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private ctx!: PluginContext;
  private db!: Database.Database;
  private logger!: Logger;
  private stateMachine!: TaskStateMachine;
  private scheduler!: ResourceAwareScheduler;

  private scheduleInterval: NodeJS.Timeout | null = null;
  private entryCommittedHandler: ((entry: { type: string; data: Buffer }) => void) | null = null;
  private nodeOfflineHandler: ((nodeId: string) => void) | null = null;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;

    // Get raw better-sqlite3 Database instance
    this.db = (ctx.sharedMemoryDb as any).db;

    // Run SQLite migrations
    runMigrations(this.db);

    // Create state machine and scheduler
    this.stateMachine = new TaskStateMachine(this.db, ctx.nodeId, this.logger);
    this.scheduler = new ResourceAwareScheduler({
      raft: ctx.raft,
      membership: ctx.membership,
      logger: this.logger,
    });

    // Register MCP tools
    this.registerTools();

    // Listen for committed Raft entries
    this.entryCommittedHandler = (entry: { type: string; data: Buffer }) => {
      this.handleEntryCommitted(entry);
    };
    ctx.raft.on('entryCommitted', this.entryCommittedHandler);

    // Listen for node offline events for HA re-queue
    this.nodeOfflineHandler = (nodeId: string) => {
      this.handleNodeOffline(nodeId);
    };
    ctx.membership.on('nodeOffline', this.nodeOfflineHandler);
  }

  async start(): Promise<void> {
    // Start the scheduling loop (leader only)
    this.scheduleInterval = setInterval(() => {
      this.runSchedulingCycle().catch((err) => {
        this.logger.error('Scheduling cycle error', { error: err.message });
      });
    }, SCHEDULE_INTERVAL_MS);

    this.logger.info('Task engine plugin started');
  }

  async stop(): Promise<void> {
    // Clear scheduling interval
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
    }

    // Remove event listeners
    if (this.entryCommittedHandler) {
      this.ctx.raft.removeListener('entryCommitted', this.entryCommittedHandler);
      this.entryCommittedHandler = null;
    }

    if (this.nodeOfflineHandler) {
      this.ctx.membership.removeListener('nodeOffline', this.nodeOfflineHandler);
      this.nodeOfflineHandler = null;
    }

    this.logger.info('Task engine plugin stopped');
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  // Expose for testing
  getStateMachine(): TaskStateMachine {
    return this.stateMachine;
  }

  // ── Tool Registration ──────────────────────────────────────────

  private registerTools(): void {
    this.tools.set('submit_task', {
      description: 'Submit a task for execution on the cluster',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Task type: shell, container, subagent, k8s_job, claude_relay',
          },
          command: { type: 'string', description: 'For shell tasks: the command to run' },
          image: { type: 'string', description: 'For container tasks: the Docker image' },
          prompt: { type: 'string', description: 'For subagent tasks: the prompt for the agent' },
          priority: { type: 'number', description: 'Task priority (0-10, higher is more urgent)' },
          requiresGpu: { type: 'boolean', description: 'Whether this task needs GPU access' },
          avoidGamingNodes: { type: 'boolean', description: 'Avoid nodes with active gaming' },
          targetNode: { type: 'string', description: 'Specific node to run on (optional)' },
          workingDirectory: { type: 'string', description: 'Working directory for the task' },
          retryable: { type: 'boolean', description: 'Whether the task can be retried (default true)' },
          maxRetries: { type: 'number', description: 'Maximum retry attempts (default 3)' },
        },
        required: ['type'],
      },
      handler: async (args) => this.handleSubmitTask(args),
    });

    this.tools.set('get_task_result', {
      description: 'Get the status and result of a previously submitted task',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task ID returned from submit_task' },
        },
        required: ['taskId'],
      },
      handler: async (args) => this.handleGetTaskResult(args),
    });

    this.tools.set('list_tasks', {
      description: 'List tasks with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by task state' },
          workflowId: { type: 'string', description: 'Filter by workflow ID' },
          nodeId: { type: 'string', description: 'Filter by assigned node ID' },
          limit: { type: 'number', description: 'Maximum results (default 50)' },
          offset: { type: 'number', description: 'Offset for pagination' },
        },
      },
      handler: async (args) => this.handleListTasks(args),
    });

    this.tools.set('cancel_task', {
      description: 'Cancel a queued or running task',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task ID to cancel' },
        },
        required: ['taskId'],
      },
      handler: async (args) => this.handleCancelTask(args),
    });

    this.tools.set('list_dead_letter_tasks', {
      description: 'List tasks that have been moved to the dead letter queue',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum results (default 50)' },
        },
      },
      handler: async (args) => this.handleListDeadLetterTasks(args),
    });

    this.tools.set('retry_dead_letter_task', {
      description: 'Retry a task from the dead letter queue',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The dead letter task ID to retry' },
        },
        required: ['taskId'],
      },
      handler: async (args) => this.handleRetryDeadLetterTask(args),
    });

    this.tools.set('drain_node_tasks', {
      description: 'Drain all tasks from a node, re-queuing them for scheduling',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The node ID to drain tasks from' },
        },
        required: ['nodeId'],
      },
      handler: async (args) => this.handleDrainNodeTasks(args),
    });

    this.tools.set('run_distributed', {
      description: 'Run a shell command on multiple nodes in parallel',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run' },
          nodes: {
            type: 'array',
            description: 'List of node IDs or hostnames (empty for all active nodes)',
          },
        },
        required: ['command'],
      },
      handler: async (args) => this.handleRunDistributed(args),
    });

    this.tools.set('dispatch_subagents', {
      description: 'Launch Claude subagents on multiple nodes in parallel',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt/task for each subagent' },
          count: { type: 'number', description: 'Number of subagents to launch' },
          contextSummary: { type: 'string', description: 'Shared context to provide to all subagents' },
        },
        required: ['prompt', 'count'],
      },
      handler: async (args) => this.handleDispatchSubagents(args),
    });

    this.tools.set('submit_workflow', {
      description: 'Submit a workflow DAG for execution on the cluster',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name' },
          tasks: {
            type: 'object',
            description: 'Map of task key to task definition (type, spec, dependsOn, etc.)',
          },
        },
        required: ['name', 'tasks'],
      },
      handler: async (args) => this.handleSubmitWorkflow(args),
    });

    this.tools.set('list_workflows', {
      description: 'List workflows with optional state filter',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by workflow state (pending, running, completed, failed, cancelled)' },
          limit: { type: 'number', description: 'Maximum results (default 50)' },
        },
      },
      handler: async (args) => this.handleListWorkflows(args),
    });

    this.tools.set('get_workflow_status', {
      description: 'Get detailed status of a workflow including per-task states',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'The workflow ID' },
        },
        required: ['workflowId'],
      },
      handler: async (args) => this.handleGetWorkflowStatus(args),
    });
  }

  // ── Tool Handlers ──────────────────────────────────────────────

  private async handleSubmitTask(args: Record<string, unknown>): Promise<unknown> {
    const taskType = args.type as TaskType;
    const taskId = randomUUID();

    // Build spec from type-specific fields
    const spec: Record<string, unknown> = {};
    if (args.command) spec.command = args.command;
    if (args.image) spec.image = args.image;
    if (args.prompt) spec.prompt = args.prompt;
    if (args.workingDirectory) spec.workingDirectory = args.workingDirectory;
    if (args.contextSummary) spec.contextSummary = args.contextSummary;

    // Build constraints
    const constraints: TaskConstraints | undefined =
      args.requiresGpu || args.avoidGamingNodes || args.targetNode
        ? {
            requiresGpu: args.requiresGpu as boolean | undefined,
            avoidGaming: args.avoidGamingNodes as boolean | undefined,
            targetNode: args.targetNode as string | undefined,
          }
        : undefined;

    // Build retry policy
    const retryPolicy: RetryPolicy | undefined =
      args.retryable !== undefined || args.maxRetries !== undefined
        ? {
            retryable: (args.retryable as boolean) ?? true,
            maxRetries: (args.maxRetries as number) ?? 3,
            backoffMs: 1000,
            backoffMultiplier: 2,
          }
        : undefined;

    const payload: TaskSubmitPayload = {
      taskId,
      type: taskType,
      spec,
      priority: (args.priority as number) ?? 0,
      constraints,
      retryPolicy,
      submitterNode: this.ctx.nodeId,
    };

    const data = Buffer.from(JSON.stringify({ type: 'task_submit', payload }));
    const result = await this.ctx.raft.appendEntry('task_submit', data);

    if (!result.success) {
      return { accepted: false, error: 'Failed to append Raft entry (not leader?)' };
    }

    return { accepted: true, taskId };
  }

  private async handleGetTaskResult(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.taskId as string;
    const task = this.stateMachine.getTask(taskId);

    if (!task) {
      return { error: `Task ${taskId} not found` };
    }

    return {
      taskId: task.id,
      state: task.state,
      type: task.type,
      priority: task.priority,
      assignedNode: task.assigned_node,
      attempt: task.attempt,
      result: task.result ? JSON.parse(task.result) : null,
      error: task.error,
      createdAt: task.created_at,
      assignedAt: task.assigned_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
    };
  }

  private async handleListTasks(args: Record<string, unknown>): Promise<unknown> {
    const limit = (args.limit as number) ?? 50;
    const offset = (args.offset as number) ?? 0;
    const state = args.state as TaskEngineState | undefined;

    // Use the state machine's list method
    let tasks = this.stateMachine.listTasks({ state, limit, offset });

    // Apply additional filters
    if (args.workflowId) {
      tasks = tasks.filter((t) => t.workflow_id === args.workflowId);
    }
    if (args.nodeId) {
      tasks = tasks.filter((t) => t.assigned_node === args.nodeId);
    }

    return {
      tasks: tasks.map((t) => ({
        taskId: t.id,
        state: t.state,
        type: t.type,
        priority: t.priority,
        assignedNode: t.assigned_node,
        attempt: t.attempt,
        createdAt: t.created_at,
        workflowId: t.workflow_id,
      })),
      total: tasks.length,
      limit,
      offset,
    };
  }

  private async handleCancelTask(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.taskId as string;
    const task = this.stateMachine.getTask(taskId);

    if (!task) {
      return { cancelled: false, error: `Task ${taskId} not found` };
    }

    if (task.state === 'completed' || task.state === 'cancelled' || task.state === 'dead_letter') {
      return { cancelled: false, error: `Task ${taskId} is in terminal state: ${task.state}` };
    }

    const data = Buffer.from(JSON.stringify({ type: 'task_cancel', payload: { taskId } }));
    const result = await this.ctx.raft.appendEntry('task_cancel', data);

    if (!result.success) {
      return { cancelled: false, error: 'Failed to append Raft entry' };
    }

    return { cancelled: true, taskId };
  }

  private async handleListDeadLetterTasks(args: Record<string, unknown>): Promise<unknown> {
    const limit = (args.limit as number) ?? 50;
    const tasks = this.stateMachine.getDeadLetterTasks();

    return {
      tasks: tasks.slice(0, limit).map((t) => ({
        taskId: t.id,
        type: t.type,
        error: t.error,
        attempt: t.attempt,
        deadLetteredAt: t.dead_lettered_at,
        createdAt: t.created_at,
      })),
      total: Math.min(tasks.length, limit),
    };
  }

  private async handleRetryDeadLetterTask(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.taskId as string;
    const task = this.stateMachine.getTask(taskId);

    if (!task) {
      return { retried: false, error: `Task ${taskId} not found` };
    }
    if (task.state !== 'dead_letter') {
      return { retried: false, error: `Task ${taskId} is not in dead_letter state (current: ${task.state})` };
    }

    // Re-queue via task_retry entry with attempt reset
    const data = Buffer.from(
      JSON.stringify({
        type: 'task_retry',
        payload: {
          taskId,
          attempt: 0,
          scheduledAfter: new Date().toISOString(),
        },
      }),
    );
    const result = await this.ctx.raft.appendEntry('task_retry', data);

    if (!result.success) {
      return { retried: false, error: 'Failed to append Raft entry' };
    }

    return { retried: true, taskId };
  }

  private async handleDrainNodeTasks(args: Record<string, unknown>): Promise<unknown> {
    const nodeId = args.nodeId as string;
    const tasks = this.stateMachine.getTasksOnNode(nodeId);

    let requeued = 0;
    for (const task of tasks) {
      const data = Buffer.from(
        JSON.stringify({
          type: 'task_retry',
          payload: {
            taskId: task.id,
            attempt: task.attempt,
            scheduledAfter: new Date().toISOString(),
          },
        }),
      );
      const result = await this.ctx.raft.appendEntry('task_retry', data);
      if (result.success) requeued++;
    }

    return { drained: true, nodeId, tasksRequeued: requeued, totalTasks: tasks.length };
  }

  private async handleRunDistributed(args: Record<string, unknown>): Promise<unknown> {
    const command = args.command as string;
    const targetNodes = args.nodes as string[] | undefined;

    // Determine target nodes
    const activeNodes = this.ctx.membership.getActiveNodes();
    const nodes = targetNodes?.length
      ? activeNodes.filter((n) => targetNodes.includes(n.nodeId) || targetNodes.includes(n.hostname))
      : activeNodes;

    if (nodes.length === 0) {
      return { error: 'No matching active nodes found' };
    }

    // Submit one shell task per node
    const taskIds: string[] = [];
    for (const node of nodes) {
      const taskId = randomUUID();
      const payload: TaskSubmitPayload = {
        taskId,
        type: 'shell',
        spec: { command },
        priority: 5,
        constraints: { targetNode: node.nodeId },
        submitterNode: this.ctx.nodeId,
      };

      const data = Buffer.from(JSON.stringify({ type: 'task_submit', payload }));
      const result = await this.ctx.raft.appendEntry('task_submit', data);
      if (result.success) {
        taskIds.push(taskId);
      }
    }

    return { submitted: taskIds.length, nodes: nodes.map((n) => n.nodeId), taskIds };
  }

  private async handleDispatchSubagents(args: Record<string, unknown>): Promise<unknown> {
    const prompt = args.prompt as string;
    const count = args.count as number;
    const contextSummary = args.contextSummary as string | undefined;

    const taskIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const taskId = randomUUID();
      const payload: TaskSubmitPayload = {
        taskId,
        type: 'subagent',
        spec: { prompt, contextSummary },
        priority: 5,
        submitterNode: this.ctx.nodeId,
      };

      const data = Buffer.from(JSON.stringify({ type: 'task_submit', payload }));
      const result = await this.ctx.raft.appendEntry('task_submit', data);
      if (result.success) {
        taskIds.push(taskId);
      }
    }

    return { submitted: taskIds.length, count, taskIds };
  }

  // ── Workflow Tool Handlers ──────────────────────────────────────

  private async handleSubmitWorkflow(args: Record<string, unknown>): Promise<unknown> {
    const workflowId = randomUUID();
    const name = args.name as string;
    const tasks = args.tasks as Record<string, WorkflowTaskDef>;

    const payload: WorkflowSubmitPayload = {
      workflowId,
      definition: { name, tasks },
    };

    const data = Buffer.from(JSON.stringify({ type: 'workflow_submit', payload }));
    const result = await this.ctx.raft.appendEntry('workflow_submit', data);

    if (!result.success) {
      return { accepted: false, error: 'Failed to append Raft entry (not leader?)' };
    }

    return { accepted: true, workflowId };
  }

  private async handleListWorkflows(args: Record<string, unknown>): Promise<unknown> {
    const limit = (args.limit as number) ?? 50;
    const state = args.state as WorkflowState | undefined;

    const workflows = this.stateMachine.listWorkflows({ state, limit });

    return {
      workflows: workflows.map((w) => ({
        workflowId: w.id,
        name: w.name,
        state: w.state,
        createdAt: w.created_at,
        completedAt: w.completed_at,
      })),
      total: workflows.length,
    };
  }

  private async handleGetWorkflowStatus(args: Record<string, unknown>): Promise<unknown> {
    const workflowId = args.workflowId as string;
    const workflow = this.stateMachine.getWorkflow(workflowId);

    if (!workflow) {
      return { error: `Workflow ${workflowId} not found` };
    }

    const workflowTasks = this.stateMachine.getWorkflowTasks(workflowId);
    const tasks: Record<string, {
      state: string;
      assignedNode: string | null;
      result: unknown;
      error: string | null;
    }> = {};

    for (const t of workflowTasks) {
      const key = t.task_key ?? t.id;
      tasks[key] = {
        state: t.state,
        assignedNode: t.assigned_node,
        result: t.result ? JSON.parse(t.result) : null,
        error: t.error,
      };
    }

    return {
      workflowId: workflow.id,
      name: workflow.name,
      state: workflow.state,
      tasks,
      context: JSON.parse(workflow.context),
      createdAt: workflow.created_at,
      completedAt: workflow.completed_at,
    };
  }

  // ── Raft Entry Handling ────────────────────────────────────────

  private handleEntryCommitted(entry: { type: string; data: Buffer }): void {
    // Only process task engine entry types
    const taskTypes = [
      'task_submit', 'task_assign', 'task_started', 'task_complete',
      'task_failed', 'task_cancel', 'task_retry', 'task_dead_letter',
      'workflow_submit', 'workflow_advance',
    ];

    if (!taskTypes.includes(entry.type)) return;

    let payload: unknown;
    try {
      const parsed = JSON.parse(entry.data.toString());
      payload = parsed.payload ?? parsed;
    } catch {
      this.logger.error('Failed to parse Raft entry data', { type: entry.type });
      return;
    }

    try {
      const action = this.stateMachine.applyEntry(entry.type, payload);
      if (action && this.ctx.raft.isLeader()) {
        this.handleStateMachineAction(action);
      }
    } catch (err: any) {
      // Handle duplicate inserts gracefully (idempotent)
      if (err.message?.includes('UNIQUE constraint failed') || err.message?.includes('SQLITE_CONSTRAINT')) {
        this.logger.debug('Duplicate entry ignored (idempotent)', { type: entry.type });
      } else {
        this.logger.error('Failed to apply Raft entry to state machine', {
          type: entry.type,
          error: err.message,
        });
      }
    }
  }

  private handleStateMachineAction(action: StateMachineAction): void {
    switch (action.type) {
      case 'retry': {
        const data = Buffer.from(
          JSON.stringify({
            type: 'task_retry',
            payload: {
              taskId: action.taskId,
              attempt: action.attempt,
              scheduledAfter: action.scheduledAfter,
            },
          }),
        );
        this.ctx.raft.appendEntry('task_retry', data);
        break;
      }
      case 'dead_letter': {
        const data = Buffer.from(
          JSON.stringify({
            type: 'task_dead_letter',
            payload: {
              taskId: action.taskId,
              reason: action.reason,
            },
          }),
        );
        this.ctx.raft.appendEntry('task_dead_letter', data);
        break;
      }
      case 'cancel_running': {
        // In production: send gRPC CancelExecution to the assigned node
        this.logger.info('Would cancel running task on node', {
          taskId: action.taskId,
          nodeId: action.nodeId,
        });
        break;
      }
      case 'schedule': {
        // Task was re-queued with a scheduled_after — the next scheduling cycle will pick it up
        this.logger.debug('Task re-scheduled', { taskId: action.taskId, after: action.scheduledAfter });
        break;
      }
      case 'workflow_advance': {
        // TODO: Implement in Phase 2
        this.logger.debug('workflow_advance stub', { workflowId: action.workflowId });
        break;
      }
    }
  }

  // ── Scheduling Loop ────────────────────────────────────────────

  private async runSchedulingCycle(): Promise<void> {
    if (!this.ctx.raft.isLeader()) return;

    const queuedTasks = this.stateMachine.getQueuedTasks();
    if (queuedTasks.length === 0) return;

    // Update running task counts per node
    const activeNodes = this.ctx.membership.getActiveNodes();
    for (const node of activeNodes) {
      const running = this.stateMachine.getTasksOnNode(node.nodeId);
      this.scheduler.setRunningTaskCount(node.nodeId, running.length);
    }

    // For each queued task, pick a node and assign
    for (const task of queuedTasks) {
      const node = this.scheduler.pickNode(task);
      if (!node) {
        this.logger.debug('No suitable node for task', { taskId: task.id });
        continue;
      }

      // Append task_assign entry
      const data = Buffer.from(
        JSON.stringify({
          type: 'task_assign',
          payload: { taskId: task.id, nodeId: node.nodeId },
        }),
      );
      const result = await this.ctx.raft.appendEntry('task_assign', data);
      if (result.success) {
        this.logger.debug('Task assigned', { taskId: task.id, nodeId: node.nodeId });

        // Dispatch to node asynchronously
        this.dispatchToNode(task.id, node.nodeId, node.tailscaleIp, node.grpcPort).catch((err) => {
          this.logger.error('Failed to dispatch task to node', {
            taskId: task.id,
            nodeId: node.nodeId,
            error: err.message,
          });
        });
      }
    }
  }

  private async dispatchToNode(
    taskId: string,
    nodeId: string,
    tailscaleIp: string,
    grpcPort: number,
  ): Promise<void> {
    const task = this.stateMachine.getTask(taskId);
    if (!task) return;

    const spec = JSON.parse(task.spec);
    const address = `${tailscaleIp}:${grpcPort}`;

    try {
      const { AgentClient } = await import('../../grpc/client.js');
      const agentClient = new AgentClient(this.ctx.clientPool, address);

      // Mark task as started
      const startedData = Buffer.from(
        JSON.stringify({
          type: 'task_started',
          payload: { taskId, nodeId },
        }),
      );
      await this.ctx.raft.appendEntry('task_started', startedData);

      // Execute via gRPC
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      const taskSpec: Record<string, unknown> = {
        task_id: taskId,
        type: task.type,
        submitter_node: this.ctx.nodeId,
      };

      // Type-specific spec
      if (task.type === 'shell' && spec.command) {
        taskSpec.shell = { command: spec.command, working_directory: spec.workingDirectory ?? '' };
      } else if (task.type === 'subagent' && spec.prompt) {
        taskSpec.subagent = { prompt: spec.prompt, context_summary: spec.contextSummary ?? '' };
      } else if (task.type === 'container' && spec.image) {
        taskSpec.container = { image: spec.image, command: spec.command ?? '' };
      }

      for await (const response of agentClient.executeTask({ spec: taskSpec as any })) {
        if (response.output) {
          const data = response.output.data?.toString() ?? '';
          if (response.output.type === 'stderr') {
            stderr += data;
          } else {
            stdout += data;
          }
        }
        if (response.status) {
          exitCode = response.status.exit_code ?? 0;
        }
      }

      // Mark task as completed
      const completeData = Buffer.from(
        JSON.stringify({
          type: 'task_complete',
          payload: { taskId, result: { exitCode, stdout, stderr } },
        }),
      );
      await this.ctx.raft.appendEntry('task_complete', completeData);
    } catch (err: any) {
      // Mark task as failed
      const failedData = Buffer.from(
        JSON.stringify({
          type: 'task_failed',
          payload: { taskId, error: err.message, nodeId },
        }),
      );
      await this.ctx.raft.appendEntry('task_failed', failedData);
    }
  }

  // ── HA Re-queue ────────────────────────────────────────────────

  private handleNodeOffline(nodeId: string): void {
    if (!this.ctx.raft.isLeader()) return;

    const tasks = this.stateMachine.getTasksOnNode(nodeId);
    if (tasks.length === 0) return;

    this.logger.warn('Node went offline, re-queuing tasks', { nodeId, taskCount: tasks.length });

    for (const task of tasks) {
      const data = Buffer.from(
        JSON.stringify({
          type: 'task_retry',
          payload: {
            taskId: task.id,
            attempt: task.attempt,
            scheduledAfter: new Date().toISOString(),
          },
        }),
      );
      this.ctx.raft.appendEntry('task_retry', data).catch((err) => {
        this.logger.error('Failed to re-queue task from offline node', {
          taskId: task.id,
          error: err.message,
        });
      });
    }
  }
}
