import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTools, ToolHandler, ToolsConfig } from '../src/mcp/tools.js';
import { ClusterStateManager, ClaudeSession, ContextEntry, ContextType, ContextVisibility } from '../src/cluster/state.js';
import { MembershipManager, NodeInfo, NodeResources } from '../src/cluster/membership.js';
import { TaskScheduler, TaskSpec, TaskStatus } from '../src/cluster/scheduler.js';
import { KubernetesAdapter, K8sCluster, K8sResources, K8sJobSpec } from '../src/kubernetes/adapter.js';
import { Logger } from 'winston';

// Mock helper functions
function createMockNodeResources(): NodeResources {
  return {
    cpuCores: 16,
    memoryBytes: 32 * 1024 * 1024 * 1024,
    memoryAvailableBytes: 16 * 1024 * 1024 * 1024,
    gpus: [{
      name: 'RTX 4090',
      memoryBytes: 24 * 1024 * 1024 * 1024,
      memoryAvailableBytes: 20 * 1024 * 1024 * 1024,
      utilizationPercent: 10,
      inUseForGaming: false,
    }],
    diskBytes: 1024 * 1024 * 1024 * 1024,
    diskAvailableBytes: 500 * 1024 * 1024 * 1024,
    cpuUsagePercent: 25,
    gamingDetected: false,
  };
}

function createMockNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    nodeId: 'node-1',
    hostname: 'rog2',
    tailscaleIp: '100.104.78.123',
    grpcPort: 50051,
    role: 'leader',
    status: 'active',
    resources: createMockNodeResources(),
    tags: ['gpu', 'development'],
    joinedAt: Date.now() - 3600000,
    lastSeen: Date.now(),
    ...overrides,
  } as NodeInfo;
}

function createMockSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'session-1',
    nodeId: 'node-1',
    project: 'test-project',
    workingDirectory: '/home/user/project',
    mode: 'normal',
    startedAt: Date.now() - 3600000,
    lastActive: Date.now(),
    contextSummary: 'Working on tests',
    ...overrides,
  };
}

function createMockContextEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    entryId: 'entry-1',
    sessionId: 'session-1',
    nodeId: 'node-1',
    project: 'test-project',
    type: 'decision',
    key: 'test-key',
    value: 'test-value',
    timestamp: Date.now(),
    vectorClock: Date.now(),
    visibility: 'cluster',
    ...overrides,
  };
}

function createMockK8sCluster(overrides: Partial<K8sCluster> = {}): K8sCluster {
  return {
    name: 'test-cluster',
    type: 'gke',
    context: 'gke_project_region_cluster',
    server: 'https://kubernetes.default',
    nodes: [],
    totalCpu: 16,
    totalMemory: 32 * 1024 * 1024 * 1024,
    gpuNodes: 1,
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createMockStateManager() {
  return {
    getState: vi.fn().mockReturnValue({
      clusterId: 'cluster-1',
      leaderId: 'node-1',
      term: 1,
      nodes: [createMockNode()],
      totalResources: { cpuCores: 16, memoryBytes: 32 * 1024 * 1024 * 1024, gpuCount: 1, gpuMemoryBytes: 24 * 1024 * 1024 * 1024 },
      availableResources: { cpuCores: 12, memoryBytes: 16 * 1024 * 1024 * 1024, gpuCount: 1, gpuMemoryBytes: 20 * 1024 * 1024 * 1024 },
      activeTasks: 2,
      queuedTasks: 5,
    }),
    getSessions: vi.fn().mockReturnValue([createMockSession()]),
    getSession: vi.fn().mockReturnValue(createMockSession()),
    publishContext: vi.fn(),
    queryContext: vi.fn().mockReturnValue([createMockContextEntry()]),
  } as unknown as ClusterStateManager;
}

function createMockMembership() {
  const nodes = [
    createMockNode(),
    createMockNode({ nodeId: 'node-2', hostname: 'terminus', tailscaleIp: '100.85.203.53', role: 'follower' }),
  ];
  return {
    getAllNodes: vi.fn().mockReturnValue(nodes),
    getActiveNodes: vi.fn().mockReturnValue(nodes),
    removeNode: vi.fn().mockResolvedValue(true),
  } as unknown as MembershipManager;
}

function createMockScheduler() {
  return {
    submit: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1', assignedNode: '100.104.78.123:50051' }),
    getStatus: vi.fn().mockReturnValue({
      taskId: 'task-1',
      state: 'completed',
      assignedNode: '100.104.78.123:50051',
      startedAt: Date.now() - 60000,
      completedAt: Date.now(),
      exitCode: 0,
      result: {
        taskId: 'task-1',
        success: true,
        exitCode: 0,
        stdout: Buffer.from('Hello World'),
        stderr: Buffer.from(''),
      },
    } as TaskStatus),
  } as unknown as TaskScheduler;
}

function createMockK8sAdapter() {
  return {
    listClusters: vi.fn().mockReturnValue([createMockK8sCluster()]),
    submitJob: vi.fn().mockResolvedValue('claudecluster-123456'),
    getClusterResources: vi.fn().mockResolvedValue({
      totalCpu: 16,
      totalMemory: 32 * 1024 * 1024 * 1024,
      allocatableCpu: 14,
      allocatableMemory: 28 * 1024 * 1024 * 1024,
      gpuCount: 1,
      runningPods: 10,
    } as K8sResources),
    scaleDeployment: vi.fn().mockResolvedValue(true),
  } as unknown as KubernetesAdapter;
}

function createToolsConfig(overrides: Partial<ToolsConfig> = {}): ToolsConfig {
  return {
    stateManager: createMockStateManager(),
    membership: createMockMembership(),
    scheduler: createMockScheduler(),
    k8sAdapter: createMockK8sAdapter(),
    sessionId: 'session-1',
    nodeId: 'node-1',
    logger: createMockLogger(),
    ...overrides,
  };
}

describe('MCP Tools', () => {
  describe('Tool Registration', () => {
    it('should create all 15 tools', () => {
      const config = createToolsConfig();
      const tools = createTools(config);

      expect(tools.size).toBe(15);
      expect(tools.has('cluster_status')).toBe(true);
      expect(tools.has('list_nodes')).toBe(true);
      expect(tools.has('submit_task')).toBe(true);
      expect(tools.has('get_task_result')).toBe(true);
      expect(tools.has('run_distributed')).toBe(true);
      expect(tools.has('dispatch_subagents')).toBe(true);
      expect(tools.has('scale_cluster')).toBe(true);
      expect(tools.has('k8s_list_clusters')).toBe(true);
      expect(tools.has('k8s_submit_job')).toBe(true);
      expect(tools.has('k8s_get_resources')).toBe(true);
      expect(tools.has('k8s_scale')).toBe(true);
      expect(tools.has('list_sessions')).toBe(true);
      expect(tools.has('relay_to_session')).toBe(true);
      expect(tools.has('publish_context')).toBe(true);
      expect(tools.has('query_context')).toBe(true);
    });

    it('each tool should have description and inputSchema', () => {
      const config = createToolsConfig();
      const tools = createTools(config);

      for (const [name, tool] of tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe('string');
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
        expect(typeof tool.handler).toBe('function');
      }
    });
  });

  describe('Cluster Status Tools', () => {
    it('cluster_status should return state', async () => {
      const stateManager = createMockStateManager();
      const config = createToolsConfig({ stateManager });
      const tools = createTools(config);
      const tool = tools.get('cluster_status')!;

      const result = await tool.handler({});

      expect(stateManager.getState).toHaveBeenCalled();
      expect(result).toHaveProperty('clusterId', 'cluster-1');
      expect(result).toHaveProperty('leaderId', 'node-1');
      expect(result).toHaveProperty('activeTasks', 2);
      expect(result).toHaveProperty('queuedTasks', 5);
    });

    it('list_nodes should return all nodes', async () => {
      const membership = createMockMembership();
      const config = createToolsConfig({ membership });
      const tools = createTools(config);
      const tool = tools.get('list_nodes')!;

      const result = await tool.handler({}) as unknown[];

      expect(membership.getAllNodes).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('nodeId', 'node-1');
      expect(result[0]).toHaveProperty('hostname', 'rog2');
      expect(result[1]).toHaveProperty('nodeId', 'node-2');
    });

    it('list_nodes should filter by status', async () => {
      const offlineNode = createMockNode({ nodeId: 'node-3', status: 'offline' });
      const membership = {
        getAllNodes: vi.fn().mockReturnValue([
          createMockNode(),
          createMockNode({ nodeId: 'node-2', status: 'active' }),
          offlineNode,
        ]),
      } as unknown as MembershipManager;
      const config = createToolsConfig({ membership });
      const tools = createTools(config);
      const tool = tools.get('list_nodes')!;

      const result = await tool.handler({ status: 'active' }) as unknown[];

      expect(result).toHaveLength(2);
      expect(result.every((n: Record<string, unknown>) => n.status === 'active')).toBe(true);
    });
  });

  describe('Task Tools', () => {
    it('submit_task should submit shell task', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('submit_task')!;

      const result = await tool.handler({
        type: 'shell',
        command: 'npm run build',
        workingDirectory: '/home/user/project',
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalled();
      const submittedSpec = (scheduler.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as TaskSpec;
      expect(submittedSpec.type).toBe('shell');
      expect(submittedSpec.shell?.command).toBe('npm run build');
      expect(submittedSpec.shell?.workingDirectory).toBe('/home/user/project');
      expect(result.accepted).toBe(true);
    });

    it('submit_task should submit container task', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('submit_task')!;

      const result = await tool.handler({
        type: 'container',
        image: 'node:20',
        command: 'npm test',
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalled();
      const submittedSpec = (scheduler.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as TaskSpec;
      expect(submittedSpec.type).toBe('container');
      expect(submittedSpec.container?.image).toBe('node:20');
      expect(result.accepted).toBe(true);
    });

    it('submit_task should submit subagent task', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('submit_task')!;

      const result = await tool.handler({
        type: 'subagent',
        prompt: 'Analyze the codebase',
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalled();
      const submittedSpec = (scheduler.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as TaskSpec;
      expect(submittedSpec.type).toBe('subagent');
      expect(submittedSpec.subagent?.prompt).toBe('Analyze the codebase');
      expect(result.accepted).toBe(true);
    });

    it('get_task_result should return task status', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('get_task_result')!;

      const result = await tool.handler({ taskId: 'task-1' }) as Record<string, unknown>;

      expect(scheduler.getStatus).toHaveBeenCalledWith('task-1');
      expect(result.taskId).toBe('task-1');
      expect(result.state).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Hello World');
    });

    it('run_distributed should submit to multiple nodes', async () => {
      const scheduler = createMockScheduler();
      const membership = createMockMembership();
      const config = createToolsConfig({ scheduler, membership });
      const tools = createTools(config);
      const tool = tools.get('run_distributed')!;

      const result = await tool.handler({
        command: 'uptime',
        nodes: ['node-1', 'node-2'],
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalledTimes(2);
      expect(result.submitted).toBe(2);
      expect(result.tasks).toHaveLength(2);
    });
  });

  describe('Subagent Tools', () => {
    it('dispatch_subagents should create multiple tasks', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('dispatch_subagents')!;

      const result = await tool.handler({
        prompt: 'Analyze module',
        count: 3,
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalledTimes(3);
      expect(result.launched).toBe(3);
      expect(result.tasks).toHaveLength(3);
    });

    it('dispatch_subagents should use prompts array with agent numbering', async () => {
      const scheduler = createMockScheduler();
      const config = createToolsConfig({ scheduler });
      const tools = createTools(config);
      const tool = tools.get('dispatch_subagents')!;

      await tool.handler({
        prompt: 'Test task',
        count: 2,
        contextSummary: 'Shared context',
      });

      const calls = (scheduler.submit as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].subagent.prompt).toContain('Agent 1/2');
      expect(calls[1][0].subagent.prompt).toContain('Agent 2/2');
      expect(calls[0][0].subagent.contextSummary).toBe('Shared context');
    });
  });

  describe('Cluster Management', () => {
    it('scale_cluster should approve pending nodes', async () => {
      const config = createToolsConfig();
      const tools = createTools(config);
      const tool = tools.get('scale_cluster')!;

      const result = await tool.handler({ action: 'add' }) as Record<string, unknown>;

      expect(result.message).toContain('To add nodes');
      expect(result.clusterTag).toBe('claudecluster');
    });

    it('scale_cluster should remove nodes', async () => {
      const membership = createMockMembership();
      const config = createToolsConfig({ membership });
      const tools = createTools(config);
      const tool = tools.get('scale_cluster')!;

      const result = await tool.handler({
        action: 'remove',
        nodeId: 'node-2',
      }) as Record<string, unknown>;

      expect(membership.removeNode).toHaveBeenCalledWith('node-2', false);
      expect(result.success).toBe(true);
      expect(result.nodeId).toBe('node-2');
      expect(result.graceful).toBe(false);
    });
  });

  describe('Kubernetes Tools', () => {
    it('k8s_list_clusters should return clusters', async () => {
      const k8sAdapter = createMockK8sAdapter();
      const config = createToolsConfig({ k8sAdapter });
      const tools = createTools(config);
      const tool = tools.get('k8s_list_clusters')!;

      const result = await tool.handler({}) as unknown[];

      expect(k8sAdapter.listClusters).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('name', 'test-cluster');
      expect(result[0]).toHaveProperty('type', 'gke');
    });

    it('k8s_submit_job should submit job', async () => {
      const k8sAdapter = createMockK8sAdapter();
      const config = createToolsConfig({ k8sAdapter });
      const tools = createTools(config);
      const tool = tools.get('k8s_submit_job')!;

      const result = await tool.handler({
        cluster: 'gke_project_region_cluster',
        image: 'node:20',
        command: ['npm', 'test'],
        namespace: 'default',
      }) as Record<string, unknown>;

      expect(k8sAdapter.submitJob).toHaveBeenCalled();
      const [clusterArg, specArg] = (k8sAdapter.submitJob as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(clusterArg).toBe('gke_project_region_cluster');
      expect(specArg.image).toBe('node:20');
      expect(result.cluster).toBe('gke_project_region_cluster');
      expect(result.namespace).toBe('default');
    });

    it('k8s_get_resources should return resources', async () => {
      const k8sAdapter = createMockK8sAdapter();
      const config = createToolsConfig({ k8sAdapter });
      const tools = createTools(config);
      const tool = tools.get('k8s_get_resources')!;

      const result = await tool.handler({
        cluster: 'gke_project_region_cluster',
      }) as Record<string, unknown>;

      expect(k8sAdapter.getClusterResources).toHaveBeenCalledWith('gke_project_region_cluster');
      expect(result.totalCpu).toBe(16);
      expect(result.runningPods).toBe(10);
    });

    it('k8s_scale should scale deployment', async () => {
      const k8sAdapter = createMockK8sAdapter();
      const config = createToolsConfig({ k8sAdapter });
      const tools = createTools(config);
      const tool = tools.get('k8s_scale')!;

      const result = await tool.handler({
        cluster: 'gke_project_region_cluster',
        deployment: 'my-app',
        replicas: 5,
        namespace: 'production',
      }) as Record<string, unknown>;

      expect(k8sAdapter.scaleDeployment).toHaveBeenCalledWith(
        'gke_project_region_cluster',
        'my-app',
        5,
        'production'
      );
      expect(result.success).toBe(true);
      expect(result.deployment).toBe('my-app');
      expect(result.replicas).toBe(5);
    });
  });

  describe('Session Tools', () => {
    it('list_sessions should return sessions', async () => {
      const stateManager = createMockStateManager();
      const config = createToolsConfig({ stateManager });
      const tools = createTools(config);
      const tool = tools.get('list_sessions')!;

      const result = await tool.handler({}) as unknown[];

      expect(stateManager.getSessions).toHaveBeenCalledWith({
        projectFilter: undefined,
        nodeFilter: undefined,
        excludeInvisible: true,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('sessionId', 'session-1');
      expect(result[0]).toHaveProperty('project', 'test-project');
    });

    it('relay_to_session should submit relay task', async () => {
      const scheduler = createMockScheduler();
      const stateManager = createMockStateManager();
      const config = createToolsConfig({ scheduler, stateManager });
      const tools = createTools(config);
      const tool = tools.get('relay_to_session')!;

      const result = await tool.handler({
        targetSession: 'session-2',
        message: 'Please continue this work',
        includeContext: true,
      }) as Record<string, unknown>;

      expect(scheduler.submit).toHaveBeenCalled();
      const submittedSpec = (scheduler.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as TaskSpec;
      expect(submittedSpec.type).toBe('claude_relay');
      expect(submittedSpec.claudeRelay?.targetSessionId).toBe('session-2');
      expect(submittedSpec.claudeRelay?.prompt).toBe('Please continue this work');
      expect(result.accepted).toBe(true);
      expect(result.targetSession).toBe('session-2');
    });
  });

  describe('Context Tools', () => {
    it('publish_context should store context', async () => {
      const stateManager = createMockStateManager();
      const config = createToolsConfig({ stateManager });
      const tools = createTools(config);
      const tool = tools.get('publish_context')!;

      const result = await tool.handler({
        type: 'decision',
        key: 'architecture-choice',
        value: 'Using microservices pattern',
        visibility: 'cluster',
      }) as Record<string, unknown>;

      expect(stateManager.publishContext).toHaveBeenCalled();
      const publishedEntry = (stateManager.publishContext as ReturnType<typeof vi.fn>).mock.calls[0][0] as ContextEntry;
      expect(publishedEntry.type).toBe('decision');
      expect(publishedEntry.key).toBe('architecture-choice');
      expect(publishedEntry.value).toBe('Using microservices pattern');
      expect(publishedEntry.visibility).toBe('cluster');
      expect(result.published).toBe(true);
    });

    it('query_context should search context', async () => {
      const stateManager = createMockStateManager();
      const config = createToolsConfig({ stateManager });
      const tools = createTools(config);
      const tool = tools.get('query_context')!;

      const result = await tool.handler({
        project: 'test-project',
        type: ['decision', 'learning'],
        limit: 10,
      }) as unknown[];

      expect(stateManager.queryContext).toHaveBeenCalledWith({
        projectFilter: 'test-project',
        typeFilter: ['decision', 'learning'],
        limit: 10,
        sessionId: 'session-1',
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('type', 'decision');
      expect(result[0]).toHaveProperty('key', 'test-key');
    });
  });
});
