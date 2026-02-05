import { Logger } from 'winston';
import { ClusterStateManager, ClaudeSession, ContextEntry, ContextType, ContextVisibility } from '../cluster/state.js';
import { MembershipManager, NodeInfo } from '../cluster/membership.js';
import { TaskScheduler, TaskSpec, TaskStatus, TaskType } from '../cluster/scheduler.js';
import { KubernetesAdapter, K8sJobSpec } from '../kubernetes/adapter.js';
import { randomUUID } from 'crypto';

export interface ToolHandler {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolsConfig {
  stateManager: ClusterStateManager;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  k8sAdapter: KubernetesAdapter;
  sessionId: string;
  nodeId: string;
  logger: Logger;
}

export function createTools(config: ToolsConfig): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();

  // cluster_status - Get current cluster state
  tools.set('cluster_status', {
    description: 'Get the current state of the Claude Cluster including nodes, resources, and active tasks',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return config.stateManager.getState();
    },
  });

  // list_nodes - List all cluster nodes
  tools.set('list_nodes', {
    description: 'List all nodes in the cluster with their status and resources',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by node status (active, offline, draining)',
          enum: ['active', 'offline', 'draining', 'pending_approval'],
        },
      },
    },
    handler: async (args) => {
      let nodes = config.membership.getAllNodes();

      if (args.status) {
        nodes = nodes.filter(n => n.status === args.status);
      }

      return nodes.map(n => ({
        nodeId: n.nodeId,
        hostname: n.hostname,
        ip: n.tailscaleIp,
        role: n.role,
        status: n.status,
        resources: n.resources ? {
          cpuCores: n.resources.cpuCores,
          memoryGb: (n.resources.memoryBytes / (1024 ** 3)).toFixed(1),
          memoryAvailableGb: (n.resources.memoryAvailableBytes / (1024 ** 3)).toFixed(1),
          cpuUsagePercent: n.resources.cpuUsagePercent.toFixed(1),
          gpus: n.resources.gpus.map(g => ({
            name: g.name,
            memoryGb: (g.memoryBytes / (1024 ** 3)).toFixed(1),
            utilization: g.utilizationPercent,
            gamingActive: g.inUseForGaming,
          })),
          gamingDetected: n.resources.gamingDetected,
        } : null,
      }));
    },
  });

  // submit_task - Submit a task for distributed execution
  tools.set('submit_task', {
    description: 'Submit a task for execution on the cluster. Returns task ID for tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Task type',
          enum: ['shell', 'container', 'subagent'],
        },
        command: {
          type: 'string',
          description: 'For shell tasks: the command to run',
        },
        image: {
          type: 'string',
          description: 'For container tasks: the Docker image',
        },
        prompt: {
          type: 'string',
          description: 'For subagent tasks: the prompt for the agent',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the task',
        },
        targetNode: {
          type: 'string',
          description: 'Specific node to run on (optional)',
        },
        priority: {
          type: 'number',
          description: 'Task priority (0-10, higher is more urgent)',
        },
        requiresGpu: {
          type: 'boolean',
          description: 'Whether this task needs GPU access',
        },
        avoidGamingNodes: {
          type: 'boolean',
          description: 'Avoid nodes with active gaming',
        },
      },
      required: ['type'],
    },
    handler: async (args) => {
      const taskId = randomUUID();
      const type = args.type as TaskType;

      const spec: TaskSpec = {
        taskId,
        type,
        submitterNode: config.nodeId,
        submitterSession: config.sessionId,
        priority: (args.priority as number) ?? 5,
        requirements: {
          requiresGpu: args.requiresGpu as boolean,
        },
        constraints: {
          avoidGamingNodes: args.avoidGamingNodes as boolean,
        },
        targetNodes: args.targetNode ? [args.targetNode as string] : undefined,
      };

      switch (type) {
        case 'shell':
          if (!args.command) {
            throw new Error('Shell task requires command');
          }
          spec.shell = {
            command: args.command as string,
            workingDirectory: args.workingDirectory as string,
          };
          break;

        case 'container':
          if (!args.image) {
            throw new Error('Container task requires image');
          }
          spec.container = {
            image: args.image as string,
            command: args.command ? [args.command as string] : undefined,
          };
          break;

        case 'subagent':
          if (!args.prompt) {
            throw new Error('Subagent task requires prompt');
          }
          spec.subagent = {
            prompt: args.prompt as string,
          };
          break;
      }

      const result = await config.scheduler.submit(spec);

      return {
        taskId,
        accepted: result.accepted,
        assignedNode: result.assignedNode,
        reason: result.reason,
      };
    },
  });

  // get_task_result - Get result of a submitted task
  tools.set('get_task_result', {
    description: 'Get the status and result of a previously submitted task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID returned from submit_task',
        },
      },
      required: ['taskId'],
    },
    handler: async (args) => {
      const status = config.scheduler.getStatus(args.taskId as string);

      if (!status) {
        return { error: 'Task not found' };
      }

      return {
        taskId: status.taskId,
        state: status.state,
        assignedNode: status.assignedNode,
        startedAt: status.startedAt,
        completedAt: status.completedAt,
        exitCode: status.exitCode,
        error: status.error,
        stdout: status.result?.stdout?.toString(),
        stderr: status.result?.stderr?.toString(),
      };
    },
  });

  // run_distributed - Run a command on multiple nodes
  tools.set('run_distributed', {
    description: 'Run a shell command on multiple nodes in parallel',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to run',
        },
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of node IDs or hostnames (empty for all active nodes)',
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      const command = args.command as string;
      let targetNodes = args.nodes as string[] | undefined;

      if (!targetNodes || targetNodes.length === 0) {
        targetNodes = config.membership.getActiveNodes().map(n => n.nodeId);
      }

      const tasks = await Promise.all(targetNodes.map(async (node) => {
        const taskId = randomUUID();
        const spec: TaskSpec = {
          taskId,
          type: 'shell',
          submitterNode: config.nodeId,
          submitterSession: config.sessionId,
          shell: { command },
          targetNodes: [node],
        };

        const result = await config.scheduler.submit(spec);
        return { node, taskId, accepted: result.accepted };
      }));

      return {
        submitted: tasks.length,
        tasks,
      };
    },
  });

  // dispatch_subagents - Launch parallel Claude subagents
  tools.set('dispatch_subagents', {
    description: 'Launch Claude subagents on multiple nodes in parallel',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The prompt/task for each subagent',
        },
        count: {
          type: 'number',
          description: 'Number of subagents to launch',
        },
        contextSummary: {
          type: 'string',
          description: 'Shared context to provide to all subagents',
        },
      },
      required: ['prompt', 'count'],
    },
    handler: async (args) => {
      const prompt = args.prompt as string;
      const count = args.count as number;
      const contextSummary = args.contextSummary as string | undefined;

      const tasks = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const taskId = randomUUID();
          const spec: TaskSpec = {
            taskId,
            type: 'subagent',
            submitterNode: config.nodeId,
            submitterSession: config.sessionId,
            subagent: {
              prompt: `Agent ${i + 1}/${count}: ${prompt}`,
              contextSummary,
            },
          };

          const result = await config.scheduler.submit(spec);
          return { taskId, accepted: result.accepted, assignedNode: result.assignedNode };
        })
      );

      return {
        launched: tasks.filter(t => t.accepted).length,
        tasks,
      };
    },
  });

  // scale_cluster - Request cluster scaling
  tools.set('scale_cluster', {
    description: 'Request addition or removal of cluster nodes',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'drain'],
          description: 'Scaling action',
        },
        nodeId: {
          type: 'string',
          description: 'For remove/drain: the node ID',
        },
      },
      required: ['action'],
    },
    handler: async (args) => {
      const action = args.action as string;

      switch (action) {
        case 'add':
          return {
            message: 'To add nodes, start the claudecluster agent on a new machine with Tailscale connected',
            clusterTag: 'claudecluster',
          };

        case 'remove':
        case 'drain':
          if (!args.nodeId) {
            throw new Error(`${action} requires nodeId`);
          }
          const graceful = action === 'drain';
          const success = await config.membership.removeNode(args.nodeId as string, graceful);
          return { success, nodeId: args.nodeId, graceful };

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });

  // k8s_list_clusters - List available Kubernetes clusters
  tools.set('k8s_list_clusters', {
    description: 'List all available Kubernetes clusters (GKE, K8s, K3s)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const clusters = config.k8sAdapter.listClusters();
      return clusters.map(c => ({
        name: c.name,
        type: c.type,
        context: c.context,
        nodes: c.nodes.length,
        totalCpu: c.totalCpu,
        totalMemoryGb: (c.totalMemory / (1024 ** 3)).toFixed(1),
        gpuNodes: c.gpuNodes,
      }));
    },
  });

  // k8s_submit_job - Submit a Kubernetes job
  tools.set('k8s_submit_job', {
    description: 'Submit a job to a Kubernetes cluster',
    inputSchema: {
      type: 'object',
      properties: {
        cluster: {
          type: 'string',
          description: 'Kubernetes cluster context name',
        },
        image: {
          type: 'string',
          description: 'Container image to run',
        },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command to run',
        },
        namespace: {
          type: 'string',
          description: 'Kubernetes namespace (default: default)',
        },
        cpuLimit: {
          type: 'string',
          description: 'CPU limit (e.g., "2", "500m")',
        },
        memoryLimit: {
          type: 'string',
          description: 'Memory limit (e.g., "4Gi", "512Mi")',
        },
        gpuLimit: {
          type: 'number',
          description: 'Number of GPUs to request',
        },
      },
      required: ['cluster', 'image'],
    },
    handler: async (args) => {
      const jobName = `claudecluster-${Date.now()}`;

      const spec: K8sJobSpec = {
        name: jobName,
        namespace: args.namespace as string,
        image: args.image as string,
        command: args.command as string[],
        cpuLimit: args.cpuLimit as string,
        memoryLimit: args.memoryLimit as string,
        gpuLimit: args.gpuLimit as number,
      };

      const name = await config.k8sAdapter.submitJob(args.cluster as string, spec);

      return {
        jobName: name,
        cluster: args.cluster,
        namespace: args.namespace ?? 'default',
      };
    },
  });

  // k8s_get_resources - Get Kubernetes cluster resources
  tools.set('k8s_get_resources', {
    description: 'Get resource information for a Kubernetes cluster',
    inputSchema: {
      type: 'object',
      properties: {
        cluster: {
          type: 'string',
          description: 'Kubernetes cluster context name',
        },
      },
      required: ['cluster'],
    },
    handler: async (args) => {
      const resources = await config.k8sAdapter.getClusterResources(args.cluster as string);

      if (!resources) {
        return { error: 'Cluster not found or inaccessible' };
      }

      return {
        totalCpu: resources.totalCpu,
        totalMemoryGb: (resources.totalMemory / (1024 ** 3)).toFixed(1),
        allocatableCpu: resources.allocatableCpu,
        allocatableMemoryGb: (resources.allocatableMemory / (1024 ** 3)).toFixed(1),
        gpuCount: resources.gpuCount,
        runningPods: resources.runningPods,
      };
    },
  });

  // k8s_scale - Scale a Kubernetes deployment
  tools.set('k8s_scale', {
    description: 'Scale a Kubernetes deployment',
    inputSchema: {
      type: 'object',
      properties: {
        cluster: {
          type: 'string',
          description: 'Kubernetes cluster context name',
        },
        deployment: {
          type: 'string',
          description: 'Deployment name',
        },
        replicas: {
          type: 'number',
          description: 'Desired number of replicas',
        },
        namespace: {
          type: 'string',
          description: 'Kubernetes namespace (default: default)',
        },
      },
      required: ['cluster', 'deployment', 'replicas'],
    },
    handler: async (args) => {
      const success = await config.k8sAdapter.scaleDeployment(
        args.cluster as string,
        args.deployment as string,
        args.replicas as number,
        args.namespace as string
      );

      return {
        success,
        deployment: args.deployment,
        replicas: args.replicas,
      };
    },
  });

  // list_sessions - List active Claude sessions
  tools.set('list_sessions', {
    description: 'List active Claude sessions in the cluster',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Filter by project name',
        },
        node: {
          type: 'string',
          description: 'Filter by node ID',
        },
      },
    },
    handler: async (args) => {
      const sessions = config.stateManager.getSessions({
        projectFilter: args.project as string,
        nodeFilter: args.node as string,
        excludeInvisible: true,
      });

      return sessions.map(s => ({
        sessionId: s.sessionId,
        nodeId: s.nodeId,
        project: s.project,
        workingDirectory: s.workingDirectory,
        startedAt: new Date(s.startedAt).toISOString(),
        lastActive: new Date(s.lastActive).toISOString(),
        contextSummary: s.contextSummary,
      }));
    },
  });

  // relay_to_session - Send a message to another Claude session
  tools.set('relay_to_session', {
    description: 'Send a message or task to another Claude session in the cluster',
    inputSchema: {
      type: 'object',
      properties: {
        targetSession: {
          type: 'string',
          description: 'Target session ID',
        },
        message: {
          type: 'string',
          description: 'Message or prompt to send',
        },
        includeContext: {
          type: 'boolean',
          description: 'Include your current context summary',
        },
      },
      required: ['targetSession', 'message'],
    },
    handler: async (args) => {
      const taskId = randomUUID();
      const session = config.stateManager.getSession(config.sessionId);

      const spec: TaskSpec = {
        taskId,
        type: 'claude_relay',
        submitterNode: config.nodeId,
        submitterSession: config.sessionId,
        claudeRelay: {
          targetSessionId: args.targetSession as string,
          prompt: args.message as string,
          fullContext: args.includeContext ? session?.contextSummary : undefined,
          awaitResponse: true,
        },
      };

      const result = await config.scheduler.submit(spec);

      return {
        taskId,
        accepted: result.accepted,
        targetSession: args.targetSession,
      };
    },
  });

  // publish_context - Share context with other sessions
  tools.set('publish_context', {
    description: 'Publish context information to be shared with other Claude sessions',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['project_summary', 'decision', 'error_solution', 'file_change', 'learning'],
          description: 'Type of context',
        },
        key: {
          type: 'string',
          description: 'Context key/identifier',
        },
        value: {
          type: 'string',
          description: 'Context value/content',
        },
        visibility: {
          type: 'string',
          enum: ['cluster', 'project', 'session'],
          description: 'Who can see this context',
        },
      },
      required: ['type', 'key', 'value'],
    },
    handler: async (args) => {
      const session = config.stateManager.getSession(config.sessionId);

      const entry: ContextEntry = {
        entryId: randomUUID(),
        sessionId: config.sessionId,
        nodeId: config.nodeId,
        project: session?.project ?? '',
        type: args.type as ContextType,
        key: args.key as string,
        value: args.value as string,
        timestamp: Date.now(),
        vectorClock: Date.now(),
        visibility: (args.visibility as ContextVisibility) ?? 'cluster',
      };

      config.stateManager.publishContext(entry);

      return {
        entryId: entry.entryId,
        published: true,
      };
    },
  });

  // query_context - Query shared context
  tools.set('query_context', {
    description: 'Query shared context from other Claude sessions',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Filter by project',
        },
        type: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by context types',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to return',
        },
      },
    },
    handler: async (args) => {
      const entries = config.stateManager.queryContext({
        projectFilter: args.project as string,
        typeFilter: args.type as ContextType[],
        limit: args.limit as number ?? 20,
        sessionId: config.sessionId,
      });

      return entries.map(e => ({
        entryId: e.entryId,
        type: e.type,
        key: e.key,
        value: e.value,
        project: e.project,
        sessionId: e.sessionId,
        timestamp: new Date(e.timestamp).toISOString(),
      }));
    },
  });

  return tools;
}
