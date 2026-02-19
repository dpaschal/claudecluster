import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock @kubernetes/client-node module
vi.mock('@kubernetes/client-node', () => {
  const mockKubeConfig = vi.fn().mockImplementation(() => ({
    loadFromDefault: vi.fn(),
    loadFromFile: vi.fn(),
    getContexts: vi.fn().mockReturnValue([]),
    getContextObject: vi.fn(),
    getCluster: vi.fn(),
    getUser: vi.fn(),
    setCurrentContext: vi.fn(),
    makeApiClient: vi.fn(),
    loadFromClusterAndUser: vi.fn(),
  }));

  return {
    KubeConfig: mockKubeConfig,
    CoreV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
  };
});

// Import after mocking
import * as k8s from '@kubernetes/client-node';
import { KubernetesAdapter, K8sJobSpec, KubernetesAdapterConfig } from '../src/kubernetes/adapter';

// Create mock logger
function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('winston').Logger;
}

// Create mock node data
function createMockNode(name: string, options: {
  cpu?: string;
  memory?: string;
  gpu?: number;
  ready?: boolean;
  labels?: Record<string, string>;
} = {}) {
  const { cpu = '4', memory = '16Gi', gpu = 0, ready = true, labels = {} } = options;
  return {
    metadata: {
      name,
      labels: {
        'kubernetes.io/hostname': name,
        ...labels,
      },
    },
    status: {
      capacity: {
        cpu,
        memory,
        ...(gpu > 0 ? { 'nvidia.com/gpu': gpu.toString() } : {}),
      },
      allocatable: {
        cpu,
        memory,
        ...(gpu > 0 ? { 'nvidia.com/gpu': gpu.toString() } : {}),
      },
      conditions: [{
        type: 'Ready',
        status: ready ? 'True' : 'False',
      }],
    },
  };
}

// Create mock job data
function createMockJob(name: string, namespace: string = 'default', status: {
  active?: number;
  succeeded?: number;
  failed?: number;
  startTime?: string;
  completionTime?: string;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
} = {}) {
  return {
    metadata: { name, namespace },
    status: {
      active: status.active ?? 0,
      succeeded: status.succeeded ?? 0,
      failed: status.failed ?? 0,
      startTime: status.startTime,
      completionTime: status.completionTime,
      conditions: status.conditions ?? [],
    },
  };
}

describe('KubernetesAdapter', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockKubeConfig: any;
  let mockCoreApi: any;
  let mockBatchApi: any;
  let mockAppsApi: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();

    // Setup mock APIs
    mockCoreApi = {
      listNode: vi.fn(),
      listPodForAllNamespaces: vi.fn(),
      listNamespacedPod: vi.fn(),
      readNamespacedPodLog: vi.fn(),
    };

    mockBatchApi = {
      createNamespacedJob: vi.fn(),
      readNamespacedJob: vi.fn(),
      deleteNamespacedJob: vi.fn(),
    };

    mockAppsApi = {
      patchNamespacedDeploymentScale: vi.fn(),
    };

    // Setup KubeConfig mock
    mockKubeConfig = {
      loadFromDefault: vi.fn(),
      loadFromFile: vi.fn(),
      getContexts: vi.fn().mockReturnValue([]),
      getContextObject: vi.fn(),
      getCluster: vi.fn(),
      getUser: vi.fn(),
      setCurrentContext: vi.fn(),
      loadFromClusterAndUser: vi.fn(),
      makeApiClient: vi.fn((apiClass: any) => {
        if (apiClass === k8s.CoreV1Api) return mockCoreApi;
        if (apiClass === k8s.BatchV1Api) return mockBatchApi;
        if (apiClass === k8s.AppsV1Api) return mockAppsApi;
        return {};
      }),
    };

    (k8s.KubeConfig as any).mockImplementation(() => mockKubeConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================
  // 1. Initialization Tests (2 tests)
  // ============================================
  describe('Initialization', () => {
    it('should create adapter with config', () => {
      const config: KubernetesAdapterConfig = {
        logger: mockLogger,
      };

      const adapter = new KubernetesAdapter(config);

      expect(adapter).toBeInstanceOf(KubernetesAdapter);
      expect(adapter).toBeInstanceOf(EventEmitter);
    });

    it('should load custom kubeconfig path', async () => {
      const customPath = '/custom/path/kubeconfig';
      const config: KubernetesAdapterConfig = {
        logger: mockLogger,
        kubeconfigPath: customPath,
      };

      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      expect(mockKubeConfig.loadFromFile).toHaveBeenCalledWith(customPath);
      expect(mockKubeConfig.loadFromDefault).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // 2. Cluster Discovery Tests (4 tests)
  // ============================================
  describe('Cluster Discovery', () => {
    it('should discover clusters from kubeconfig', async () => {
      const contexts = [
        { name: 'prod-cluster', cluster: 'prod', user: 'admin' },
        { name: 'dev-cluster', cluster: 'dev', user: 'developer' },
      ];

      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockImplementation((name: string) => {
        const ctx = contexts.find(c => c.name === name);
        return ctx ? { name, cluster: ctx.cluster, user: ctx.user } : null;
      });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });

      mockCoreApi.listNode.mockResolvedValue({
        items: [createMockNode('node-1', { cpu: '8', memory: '32Gi' })],
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      const clusters = await adapter.discoverClusters();

      expect(clusters).toHaveLength(2);
      expect(clusters[0].context).toBe('prod-cluster');
      expect(clusters[1].context).toBe('dev-cluster');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Discovered Kubernetes clusters',
        expect.objectContaining({ count: 2 })
      );
    });

    it('should handle missing kubeconfig gracefully', async () => {
      mockKubeConfig.loadFromDefault.mockImplementation(() => {
        throw new Error('ENOENT: kubeconfig not found');
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      const clusters = await adapter.discoverClusters();

      expect(clusters).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to load kubeconfig',
        expect.objectContaining({ error: expect.anything() })
      );
    });

    it('should detect cluster type (gke, k3s, k8s)', async () => {
      const contexts = [
        { name: 'gke_myproject_us-central1_cluster1', cluster: 'gke-cluster', user: 'gke-user' },
        { name: 'k3s-local', cluster: 'k3s', user: 'k3s-user' },
        { name: 'vanilla-k8s', cluster: 'k8s', user: 'admin' },
      ];

      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockImplementation((name: string) => {
        const ctx = contexts.find(c => c.name === name);
        return ctx ? { name, cluster: ctx.cluster, user: ctx.user } : null;
      });

      mockKubeConfig.getCluster.mockImplementation((clusterName: string) => {
        if (clusterName === 'gke-cluster') {
          return { server: 'https://35.192.0.1.gke.io' };
        }
        if (clusterName === 'k3s') {
          return { server: 'https://192.168.1.100:6443' };
        }
        return { server: 'https://api.kubernetes.local' };
      });
      mockKubeConfig.getUser.mockReturnValue({ name: 'user' });

      const k3sNode = createMockNode('k3s-node', {
        labels: { 'k3s.io/hostname': 'k3s-local' },
      });
      const regularNode = createMockNode('regular-node');

      mockCoreApi.listNode.mockImplementation(() => {
        const currentContext = mockKubeConfig.getContexts()[0];
        if (currentContext?.name?.includes('k3s')) {
          return Promise.resolve({ items: [k3sNode] });
        }
        return Promise.resolve({ items: [regularNode] });
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      const clusters = await adapter.discoverClusters();

      expect(clusters).toHaveLength(3);
      // GKE detected by server URL pattern
      const gkeCluster = clusters.find(c => c.context.includes('gke_'));
      expect(gkeCluster?.type).toBe('gke');
    });

    it('should list discovered clusters', async () => {
      const contexts = [{ name: 'test-cluster', cluster: 'test', user: 'admin' }];

      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockReturnValue({ name: 'test-cluster', cluster: 'test', user: 'admin' });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });
      mockCoreApi.listNode.mockResolvedValue({
        items: [createMockNode('node-1')],
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);

      // Before discovery
      expect(adapter.listClusters()).toHaveLength(0);

      await adapter.discoverClusters();

      // After discovery
      const listed = adapter.listClusters();
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe('test-cluster');
    });
  });

  // ============================================
  // 3. Cluster Resources Tests (3 tests)
  // ============================================
  describe('Cluster Resources', () => {
    beforeEach(async () => {
      // Setup a discovered cluster
      const contexts = [{ name: 'resource-test', cluster: 'test', user: 'admin' }];
      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockReturnValue({ name: 'resource-test', cluster: 'test', user: 'admin' });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });
    });

    it('should get cluster resources', async () => {
      const nodes = [
        createMockNode('node-1', { cpu: '4', memory: '16Gi' }),
        createMockNode('node-2', { cpu: '8', memory: '32Gi' }),
      ];

      mockCoreApi.listNode.mockResolvedValue({ items: nodes });
      mockCoreApi.listPodForAllNamespaces.mockResolvedValue({
        items: [
          { status: { phase: 'Running' } },
          { status: { phase: 'Running' } },
          { status: { phase: 'Pending' } },
        ],
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const resources = await adapter.getClusterResources('resource-test');

      expect(resources).not.toBeNull();
      expect(resources!.totalCpu).toBe(12); // 4 + 8
      expect(resources!.runningPods).toBe(2);
    });

    it('should return null for unknown context', async () => {
      mockCoreApi.listNode.mockResolvedValue({ items: [createMockNode('node-1')] });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const resources = await adapter.getClusterResources('unknown-context');

      expect(resources).toBeNull();
    });

    it('should count GPUs from node labels', async () => {
      const nodes = [
        createMockNode('gpu-node-1', { cpu: '8', memory: '64Gi', gpu: 2 }),
        createMockNode('gpu-node-2', { cpu: '8', memory: '64Gi', gpu: 4 }),
        createMockNode('cpu-node', { cpu: '16', memory: '128Gi', gpu: 0 }),
      ];

      mockCoreApi.listNode.mockResolvedValue({ items: nodes });
      mockCoreApi.listPodForAllNamespaces.mockResolvedValue({ items: [] });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const resources = await adapter.getClusterResources('resource-test');

      expect(resources).not.toBeNull();
      expect(resources!.gpuCount).toBe(6); // 2 + 4
    });
  });

  // ============================================
  // 4. Job Management Tests (6 tests)
  // ============================================
  describe('Job Management', () => {
    beforeEach(async () => {
      const contexts = [{ name: 'job-test', cluster: 'test', user: 'admin' }];
      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockReturnValue({ name: 'job-test', cluster: 'test', user: 'admin' });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });
      mockCoreApi.listNode.mockResolvedValue({ items: [createMockNode('node-1')] });
    });

    it('should submit job with spec', async () => {
      const jobSpec: K8sJobSpec = {
        name: 'test-job',
        namespace: 'production',
        image: 'node:20',
        command: ['npm', 'run', 'build'],
        env: { NODE_ENV: 'production' },
        cpuRequest: '500m',
        memoryRequest: '512Mi',
        cpuLimit: '2',
        memoryLimit: '2Gi',
        labels: { app: 'test-app' },
        ttlSecondsAfterFinished: 7200,
        backoffLimit: 5,
      };

      mockBatchApi.createNamespacedJob.mockResolvedValue({
        metadata: { name: 'test-job', namespace: 'production' },
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const jobName = await adapter.submitJob('job-test', jobSpec);

      expect(jobName).toBe('test-job');
      expect(mockBatchApi.createNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'production',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'test-job',
              labels: expect.objectContaining({
                'app.kubernetes.io/managed-by': 'cortex',
                app: 'test-app',
              }),
            }),
          }),
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Submitted Kubernetes job',
        expect.objectContaining({ name: 'test-job' })
      );
    });

    it('should get job status', async () => {
      const mockJob = createMockJob('status-test-job', 'default', {
        active: 1,
        succeeded: 0,
        failed: 0,
        startTime: '2024-01-15T10:00:00Z',
        conditions: [{ type: 'Running', status: 'True' }],
      });

      mockBatchApi.readNamespacedJob.mockResolvedValue(mockJob);

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const status = await adapter.getJobStatus('job-test', 'status-test-job', 'default');

      expect(status).not.toBeNull();
      expect(status!.name).toBe('status-test-job');
      expect(status!.active).toBe(1);
      expect(status!.succeeded).toBe(0);
      expect(status!.conditions).toHaveLength(1);
      expect(status!.conditions[0].type).toBe('Running');
    });

    it('should get job logs', async () => {
      const pods = [
        { metadata: { name: 'test-job-abc123' }, status: { phase: 'Running' } },
      ];

      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: pods });
      mockCoreApi.readNamespacedPodLog.mockResolvedValue('Job output logs here\nLine 2');

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const logs = await adapter.getJobLogs('job-test', 'test-job', 'default');

      expect(logs).toBe('Job output logs here\nLine 2');
      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'default',
          labelSelector: 'job-name=test-job',
        })
      );
    });

    it('should delete job', async () => {
      mockBatchApi.deleteNamespacedJob.mockResolvedValue({});

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const deleted = await adapter.deleteJob('job-test', 'delete-me', 'default');

      expect(deleted).toBe(true);
      expect(mockBatchApi.deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'delete-me',
          namespace: 'default',
          propagationPolicy: 'Background',
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Deleted Kubernetes job',
        expect.objectContaining({ name: 'delete-me' })
      );
    });

    it('should handle job not found', async () => {
      mockBatchApi.readNamespacedJob.mockRejectedValue(new Error('Job not found'));

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const status = await adapter.getJobStatus('job-test', 'nonexistent-job', 'default');

      expect(status).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get job status',
        expect.objectContaining({ name: 'nonexistent-job' })
      );
    });

    it('should use default namespace', async () => {
      const mockJob = createMockJob('default-ns-job', 'default', { succeeded: 1 });
      mockBatchApi.readNamespacedJob.mockResolvedValue(mockJob);

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      // Call without namespace parameter
      const status = await adapter.getJobStatus('job-test', 'default-ns-job');

      expect(status).not.toBeNull();
      expect(status!.namespace).toBe('default');
      expect(mockBatchApi.readNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'default' })
      );
    });
  });

  // ============================================
  // 5. Scaling Tests (3 tests)
  // ============================================
  describe('Scaling', () => {
    beforeEach(async () => {
      const contexts = [{ name: 'scale-test', cluster: 'test', user: 'admin' }];
      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockReturnValue({ name: 'scale-test', cluster: 'test', user: 'admin' });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });
      mockCoreApi.listNode.mockResolvedValue({ items: [createMockNode('node-1')] });
    });

    it('should scale deployment up', async () => {
      mockAppsApi.patchNamespacedDeploymentScale.mockResolvedValue({
        spec: { replicas: 5 },
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const result = await adapter.scaleDeployment('scale-test', 'my-deployment', 5, 'production');

      expect(result).toBe(true);
      expect(mockAppsApi.patchNamespacedDeploymentScale).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-deployment',
          namespace: 'production',
          body: { spec: { replicas: 5 } },
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Scaled deployment',
        expect.objectContaining({ name: 'my-deployment', replicas: 5 })
      );
    });

    it('should scale deployment down', async () => {
      mockAppsApi.patchNamespacedDeploymentScale.mockResolvedValue({
        spec: { replicas: 1 },
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const result = await adapter.scaleDeployment('scale-test', 'my-deployment', 1, 'default');

      expect(result).toBe(true);
      expect(mockAppsApi.patchNamespacedDeploymentScale).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { spec: { replicas: 1 } },
        })
      );
    });

    it('should handle scale error', async () => {
      mockAppsApi.patchNamespacedDeploymentScale.mockRejectedValue(
        new Error('Forbidden: insufficient permissions')
      );

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      const result = await adapter.scaleDeployment('scale-test', 'my-deployment', 10, 'default');

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to scale deployment',
        expect.objectContaining({
          name: 'my-deployment',
          error: expect.anything(),
        })
      );
    });
  });

  // ============================================
  // 6. Error Handling Tests (2 tests)
  // ============================================
  describe('Error Handling', () => {
    it('should emit error on probe failure', async () => {
      const contexts = [
        { name: 'working-cluster', cluster: 'working', user: 'admin' },
        { name: 'failing-cluster', cluster: 'failing', user: 'admin' },
      ];

      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockImplementation((name: string) => {
        const ctx = contexts.find(c => c.name === name);
        return ctx ? { name, cluster: ctx.cluster, user: ctx.user } : null;
      });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });

      let callCount = 0;
      mockCoreApi.listNode.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve({ items: [createMockNode('node-1')] });
      });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      const clusters = await adapter.discoverClusters();

      // Only the working cluster should be discovered
      expect(clusters).toHaveLength(1);
      expect(clusters[0].context).toBe('working-cluster');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Failed to probe cluster',
        expect.objectContaining({ context: 'failing-cluster' })
      );
    });

    it('should handle API errors gracefully', async () => {
      const contexts = [{ name: 'api-error-test', cluster: 'test', user: 'admin' }];
      mockKubeConfig.getContexts.mockReturnValue(contexts);
      mockKubeConfig.getContextObject.mockReturnValue({ name: 'api-error-test', cluster: 'test', user: 'admin' });
      mockKubeConfig.getCluster.mockReturnValue({ server: 'https://api.example.com' });
      mockKubeConfig.getUser.mockReturnValue({ name: 'admin' });
      mockCoreApi.listNode.mockResolvedValue({ items: [createMockNode('node-1')] });

      const config: KubernetesAdapterConfig = { logger: mockLogger };
      const adapter = new KubernetesAdapter(config);
      await adapter.discoverClusters();

      // Simulate API error on resource fetch
      mockCoreApi.listNode.mockRejectedValue(new Error('API server unavailable'));

      const resources = await adapter.getClusterResources('api-error-test');

      expect(resources).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get cluster resources',
        expect.objectContaining({
          context: 'api-error-test',
          error: expect.anything(),
        })
      );
    });
  });
});
