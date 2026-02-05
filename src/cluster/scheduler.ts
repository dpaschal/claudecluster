import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { MembershipManager, NodeInfo, NodeResources } from './membership.js';
import { RaftNode } from './raft.js';
import { AgentClient, GrpcClientPool } from '../grpc/client.js';

export interface TaskSpec {
  taskId: string;
  type: TaskType;
  submitterNode: string;
  submitterSession?: string;
  shell?: ShellTaskSpec;
  container?: ContainerTaskSpec;
  subagent?: SubagentTaskSpec;
  k8sJob?: K8sJobTaskSpec;
  claudeRelay?: ClaudeRelayTaskSpec;
  requirements?: ResourceRequirements;
  constraints?: TaskConstraints;
  priority?: number;
  timeoutMs?: number;
  environment?: Record<string, string>;
  targetNodes?: string[];
}

export type TaskType = 'shell' | 'container' | 'subagent' | 'k8s_job' | 'claude_relay';

export interface ShellTaskSpec {
  command: string;
  workingDirectory?: string;
  sandboxed?: boolean;
}

export interface ContainerTaskSpec {
  image: string;
  command?: string[];
  args?: string[];
  labels?: Record<string, string>;
  mounts?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
}

export interface SubagentTaskSpec {
  prompt: string;
  model?: string;
  tools?: string[];
  contextSummary?: string;
  maxTurns?: number;
}

export interface K8sJobTaskSpec {
  clusterContext: string;
  namespace?: string;
  image: string;
  command?: string[];
  labels?: Record<string, string>;
  resources?: ResourceRequirements;
}

export interface ClaudeRelayTaskSpec {
  targetSessionId: string;
  prompt: string;
  fullContext?: string;
  awaitResponse?: boolean;
}

export interface ResourceRequirements {
  cpuCores?: number;
  memoryBytes?: number;
  requiresGpu?: boolean;
  gpuMemoryBytes?: number;
}

export interface TaskConstraints {
  allowedNodes?: string[];
  excludedNodes?: string[];
  preferLocal?: boolean;
  avoidGamingNodes?: boolean;
}

export interface QueuedTask {
  spec: TaskSpec;
  queuedAt: number;
  attempts: number;
}

export interface RunningTask {
  spec: TaskSpec;
  assignedNode: string;
  startedAt: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  error?: string;
  artifacts?: Map<string, Buffer>;
}

export type TaskState = 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskStatus {
  taskId: string;
  state: TaskState;
  assignedNode?: string;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  error?: string;
  result?: TaskResult;
}

export interface SchedulerConfig {
  nodeId: string;
  logger: Logger;
  membership: MembershipManager;
  raft: RaftNode;
  clientPool: GrpcClientPool;
  maxQueueSize?: number;
  maxRetries?: number;
  schedulingIntervalMs?: number;
}

export class TaskScheduler extends EventEmitter {
  private config: SchedulerConfig;
  private taskQueue: Map<string, QueuedTask> = new Map();
  private runningTasks: Map<string, RunningTask> = new Map();
  private taskStatuses: Map<string, TaskStatus> = new Map();
  private schedulingInterval: NodeJS.Timeout | null = null;

  private maxQueueSize: number;
  private maxRetries: number;

  constructor(config: SchedulerConfig) {
    super();
    this.config = config;
    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.maxRetries = config.maxRetries ?? 3;
  }

  start(): void {
    const interval = this.config.schedulingIntervalMs ?? 1000;
    this.schedulingInterval = setInterval(() => this.scheduleNext(), interval);
    this.config.logger.info('Task scheduler started');
  }

  stop(): void {
    if (this.schedulingInterval) {
      clearInterval(this.schedulingInterval);
      this.schedulingInterval = null;
    }
    this.config.logger.info('Task scheduler stopped');
  }

  // Submit a new task
  async submit(spec: TaskSpec): Promise<{ accepted: boolean; taskId: string; assignedNode?: string; reason?: string }> {
    // Validate task
    const validation = this.validateTask(spec);
    if (!validation.valid) {
      return { accepted: false, taskId: spec.taskId, reason: validation.reason };
    }

    // Check queue size
    if (this.taskQueue.size >= this.maxQueueSize) {
      return { accepted: false, taskId: spec.taskId, reason: 'Queue full' };
    }

    // If leader, replicate to Raft log
    if (this.config.raft.isLeader()) {
      const data = Buffer.from(JSON.stringify(spec));
      const { success } = await this.config.raft.appendEntry('task_submit', data);
      if (!success) {
        return { accepted: false, taskId: spec.taskId, reason: 'Failed to replicate task' };
      }
    }

    // Add to queue
    this.taskQueue.set(spec.taskId, {
      spec,
      queuedAt: Date.now(),
      attempts: 0,
    });

    this.taskStatuses.set(spec.taskId, {
      taskId: spec.taskId,
      state: 'queued',
    });

    this.config.logger.info('Task submitted', { taskId: spec.taskId, type: spec.type });
    this.emit('taskSubmitted', spec);

    // Try immediate scheduling for high priority
    if (spec.priority && spec.priority > 5) {
      const node = this.scheduleTask(spec);
      if (node) {
        return { accepted: true, taskId: spec.taskId, assignedNode: node };
      }
    }

    return { accepted: true, taskId: spec.taskId };
  }

  // Get task status
  getStatus(taskId: string): TaskStatus | undefined {
    return this.taskStatuses.get(taskId);
  }

  // Cancel a task
  async cancel(taskId: string): Promise<boolean> {
    // If queued, just remove from queue
    if (this.taskQueue.has(taskId)) {
      this.taskQueue.delete(taskId);
      this.updateStatus(taskId, 'cancelled');
      return true;
    }

    // If running, tell the agent to cancel
    const running = this.runningTasks.get(taskId);
    if (running) {
      try {
        const client = new AgentClient(this.config.clientPool, running.assignedNode);
        await client.cancelExecution(taskId);
        this.updateStatus(taskId, 'cancelled');
        return true;
      } catch (error) {
        this.config.logger.error('Failed to cancel task', { taskId, error });
        return false;
      }
    }

    return false;
  }

  // Get queue and running counts
  getQueuedCount(): number {
    return this.taskQueue.size;
  }

  getRunningCount(): number {
    return this.runningTasks.size;
  }

  // Main scheduling loop
  private scheduleNext(): void {
    if (!this.config.raft.isLeader()) {
      return; // Only leader schedules
    }

    // Sort queue by priority (higher first) then by queue time (older first)
    const queue = Array.from(this.taskQueue.values())
      .sort((a, b) => {
        const priorityDiff = (b.spec.priority ?? 0) - (a.spec.priority ?? 0);
        if (priorityDiff !== 0) return priorityDiff;
        return a.queuedAt - b.queuedAt;
      });

    for (const queued of queue) {
      const assignedNode = this.scheduleTask(queued.spec);
      if (assignedNode) {
        this.taskQueue.delete(queued.spec.taskId);
        this.dispatchTask(queued.spec, assignedNode);
      }
    }
  }

  // Find best node for a task
  private scheduleTask(spec: TaskSpec): string | null {
    const candidates = this.getCandidateNodes(spec);

    if (candidates.length === 0) {
      return null;
    }

    // Score each candidate
    const scored = candidates.map(node => ({
      node,
      score: this.scoreNode(node, spec),
    }));

    // Sort by score (higher is better)
    scored.sort((a, b) => b.score - a.score);

    return `${scored[0].node.tailscaleIp}:${scored[0].node.grpcPort}`;
  }

  // Get nodes that can run this task
  private getCandidateNodes(spec: TaskSpec): NodeInfo[] {
    let candidates = this.config.membership.getActiveNodes();

    // Apply constraints
    const constraints = spec.constraints ?? {};

    // Target nodes override
    if (spec.targetNodes && spec.targetNodes.length > 0) {
      candidates = candidates.filter(n =>
        spec.targetNodes!.includes(n.nodeId) || spec.targetNodes!.includes(n.hostname)
      );
    }

    // Allowed nodes
    if (constraints.allowedNodes && constraints.allowedNodes.length > 0) {
      candidates = candidates.filter(n =>
        constraints.allowedNodes!.includes(n.nodeId) || constraints.allowedNodes!.includes(n.hostname)
      );
    }

    // Excluded nodes
    if (constraints.excludedNodes && constraints.excludedNodes.length > 0) {
      candidates = candidates.filter(n =>
        !constraints.excludedNodes!.includes(n.nodeId) && !constraints.excludedNodes!.includes(n.hostname)
      );
    }

    // Avoid gaming nodes
    if (constraints.avoidGamingNodes) {
      candidates = candidates.filter(n => !n.resources?.gamingDetected);
    }

    // Filter by resource requirements
    const requirements = spec.requirements ?? {};
    candidates = candidates.filter(n => this.meetsRequirements(n, requirements));

    return candidates;
  }

  // Check if a node meets resource requirements
  private meetsRequirements(node: NodeInfo, requirements: ResourceRequirements): boolean {
    // If no specific requirements, allow scheduling even without resource info
    const hasRequirements = requirements.cpuCores || requirements.memoryBytes ||
                           requirements.requiresGpu || requirements.gpuMemoryBytes;
    if (!hasRequirements) {
      return true; // No requirements specified, any node works
    }

    if (!node.resources) {
      return false; // Has requirements but no resource info, can't verify
    }

    const resources = node.resources;

    // CPU
    if (requirements.cpuCores) {
      const availableCores = resources.cpuCores * (1 - resources.cpuUsagePercent / 100);
      if (availableCores < requirements.cpuCores) {
        return false;
      }
    }

    // Memory
    if (requirements.memoryBytes) {
      if (resources.memoryAvailableBytes < requirements.memoryBytes) {
        return false;
      }
    }

    // GPU
    if (requirements.requiresGpu) {
      const availableGpu = resources.gpus.find(g => !g.inUseForGaming);
      if (!availableGpu) {
        return false;
      }

      if (requirements.gpuMemoryBytes && availableGpu.memoryAvailableBytes < requirements.gpuMemoryBytes) {
        return false;
      }
    }

    return true;
  }

  // Score a node for task assignment (higher is better)
  private scoreNode(node: NodeInfo, spec: TaskSpec): number {
    let score = 0;
    const resources = node.resources;

    if (!resources) {
      return 0;
    }

    // Prefer nodes with more available resources
    const cpuAvailable = 1 - resources.cpuUsagePercent / 100;
    const memoryAvailable = resources.memoryAvailableBytes / resources.memoryBytes;

    score += cpuAvailable * 30;
    score += memoryAvailable * 30;

    // Prefer local node if specified
    if (spec.constraints?.preferLocal && node.nodeId === spec.submitterNode) {
      score += 50;
    }

    // Penalty for gaming activity (even if not strictly avoided)
    if (resources.gamingDetected) {
      score -= 40;
    }

    // Bonus for nodes with fewer running tasks
    const nodeRunningTasks = Array.from(this.runningTasks.values())
      .filter(t => t.assignedNode.includes(node.tailscaleIp)).length;
    score -= nodeRunningTasks * 10;

    // GPU bonus for GPU tasks
    if (spec.requirements?.requiresGpu) {
      const availableGpu = resources.gpus.find(g => !g.inUseForGaming);
      if (availableGpu) {
        const gpuAvailable = availableGpu.memoryAvailableBytes / availableGpu.memoryBytes;
        score += gpuAvailable * 20;
      }
    }

    return score;
  }

  // Dispatch task to a node
  private async dispatchTask(spec: TaskSpec, nodeAddress: string): Promise<void> {
    this.runningTasks.set(spec.taskId, {
      spec,
      assignedNode: nodeAddress,
      startedAt: Date.now(),
    });

    this.updateStatus(spec.taskId, 'assigned', nodeAddress);
    this.config.logger.info('Task assigned', { taskId: spec.taskId, node: nodeAddress });
    this.emit('taskAssigned', spec, nodeAddress);

    try {
      const client = new AgentClient(this.config.clientPool, nodeAddress);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = client.executeTask({ spec: this.specToProto(spec) as any });

      let stdout: Buffer[] = [];
      let stderr: Buffer[] = [];

      this.updateStatus(spec.taskId, 'running', nodeAddress);

      for await (const response of stream as AsyncIterable<{ output?: { type: string; data: Buffer }; status?: TaskStatus }>) {
        if (response.output) {
          if (response.output.type === 'OUTPUT_TYPE_STDOUT') {
            stdout.push(response.output.data);
          } else if (response.output.type === 'OUTPUT_TYPE_STDERR') {
            stderr.push(response.output.data);
          }
          this.emit('taskOutput', spec.taskId, response.output);
        }

        if (response.status) {
          this.handleTaskCompletion(spec.taskId, {
            taskId: spec.taskId,
            success: response.status.exitCode === 0,
            exitCode: response.status.exitCode ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            error: response.status.error,
          });
        }
      }
    } catch (error) {
      this.config.logger.error('Task execution failed', { taskId: spec.taskId, error });
      this.handleTaskFailure(spec, error instanceof Error ? error.message : String(error));
    }
  }

  // Handle task completion
  private handleTaskCompletion(taskId: string, result: TaskResult): void {
    this.runningTasks.delete(taskId);

    const status = this.taskStatuses.get(taskId);
    if (status) {
      status.state = result.success ? 'completed' : 'failed';
      status.completedAt = Date.now();
      status.exitCode = result.exitCode;
      status.error = result.error;
      status.result = result;
    }

    this.config.logger.info('Task completed', {
      taskId,
      success: result.success,
      exitCode: result.exitCode,
    });

    this.emit('taskCompleted', taskId, result);
  }

  // Handle task failure with potential retry
  private handleTaskFailure(spec: TaskSpec, error: string): void {
    this.runningTasks.delete(spec.taskId);

    const queued = this.taskQueue.get(spec.taskId);
    const attempts = queued?.attempts ?? 0;

    if (attempts < this.maxRetries) {
      // Re-queue for retry
      this.taskQueue.set(spec.taskId, {
        spec,
        queuedAt: Date.now(),
        attempts: attempts + 1,
      });
      this.updateStatus(spec.taskId, 'queued');
      this.config.logger.info('Task re-queued for retry', {
        taskId: spec.taskId,
        attempt: attempts + 1,
      });
    } else {
      this.updateStatus(spec.taskId, 'failed');
      const status = this.taskStatuses.get(spec.taskId);
      if (status) {
        status.error = error;
      }
      this.config.logger.error('Task failed after max retries', {
        taskId: spec.taskId,
        error,
      });
      this.emit('taskFailed', spec.taskId, error);
    }
  }

  // Update task status
  private updateStatus(taskId: string, state: TaskState, assignedNode?: string): void {
    let status = this.taskStatuses.get(taskId);
    if (!status) {
      status = { taskId, state };
      this.taskStatuses.set(taskId, status);
    }

    status.state = state;
    if (assignedNode) {
      status.assignedNode = assignedNode;
    }
    if (state === 'running') {
      status.startedAt = Date.now();
    }
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      status.completedAt = Date.now();
    }

    this.emit('statusChanged', status);
  }

  // Validate task spec
  private validateTask(spec: TaskSpec): { valid: boolean; reason?: string } {
    if (!spec.taskId) {
      return { valid: false, reason: 'Missing taskId' };
    }

    if (!spec.type) {
      return { valid: false, reason: 'Missing task type' };
    }

    switch (spec.type) {
      case 'shell':
        if (!spec.shell?.command) {
          return { valid: false, reason: 'Shell task missing command' };
        }
        break;
      case 'container':
        if (!spec.container?.image) {
          return { valid: false, reason: 'Container task missing image' };
        }
        break;
      case 'subagent':
        if (!spec.subagent?.prompt) {
          return { valid: false, reason: 'Subagent task missing prompt' };
        }
        break;
      case 'k8s_job':
        if (!spec.k8sJob?.image || !spec.k8sJob?.clusterContext) {
          return { valid: false, reason: 'K8s job missing image or context' };
        }
        break;
      case 'claude_relay':
        if (!spec.claudeRelay?.targetSessionId || !spec.claudeRelay?.prompt) {
          return { valid: false, reason: 'Claude relay missing target or prompt' };
        }
        break;
      default:
        return { valid: false, reason: `Unknown task type: ${spec.type}` };
    }

    return { valid: true };
  }

  // Convert spec to proto format
  private specToProto(spec: TaskSpec): Record<string, unknown> {
    return {
      task_id: spec.taskId,
      type: `TASK_TYPE_${spec.type.toUpperCase()}`,
      submitter_node: spec.submitterNode,
      submitter_session: spec.submitterSession,
      shell: spec.shell ? {
        command: spec.shell.command,
        working_directory: spec.shell.workingDirectory,
        sandboxed: spec.shell.sandboxed,
      } : undefined,
      container: spec.container ? {
        image: spec.container.image,
        command: spec.container.command,
        args: spec.container.args,
        labels: spec.container.labels,
        mounts: spec.container.mounts?.map(m => ({
          host_path: m.hostPath,
          container_path: m.containerPath,
          read_only: m.readOnly,
        })),
      } : undefined,
      subagent: spec.subagent ? {
        prompt: spec.subagent.prompt,
        model: spec.subagent.model,
        tools: spec.subagent.tools,
        context_summary: spec.subagent.contextSummary,
        max_turns: spec.subagent.maxTurns,
      } : undefined,
      k8s_job: spec.k8sJob ? {
        cluster_context: spec.k8sJob.clusterContext,
        namespace: spec.k8sJob.namespace,
        image: spec.k8sJob.image,
        command: spec.k8sJob.command,
        labels: spec.k8sJob.labels,
      } : undefined,
      claude_relay: spec.claudeRelay ? {
        target_session_id: spec.claudeRelay.targetSessionId,
        prompt: spec.claudeRelay.prompt,
        full_context: spec.claudeRelay.fullContext,
        await_response: spec.claudeRelay.awaitResponse,
      } : undefined,
      requirements: spec.requirements ? {
        cpu_cores: spec.requirements.cpuCores,
        memory_bytes: spec.requirements.memoryBytes?.toString(),
        requires_gpu: spec.requirements.requiresGpu,
        gpu_memory_bytes: spec.requirements.gpuMemoryBytes?.toString(),
      } : undefined,
      constraints: spec.constraints ? {
        allowed_nodes: spec.constraints.allowedNodes,
        excluded_nodes: spec.constraints.excludedNodes,
        prefer_local: spec.constraints.preferLocal,
        avoid_gaming_nodes: spec.constraints.avoidGamingNodes,
      } : undefined,
      priority: spec.priority,
      timeout_ms: spec.timeoutMs?.toString(),
      environment: spec.environment,
      target_nodes: spec.targetNodes,
    };
  }
}
