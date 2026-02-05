# Kubernetes Adapter Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 20 unit tests for KubernetesAdapter covering discovery, detection, monitoring, and jobs.

**Architecture:** Mock @kubernetes/client-node to test adapter logic without real clusters.

**Tech Stack:** Vitest, vi.mock, K8s client mocks

---

## Task 1: Setup and Discovery Tests

**Files:**
- Create: `tests/kubernetes-adapter.test.ts`

**Step 1: Create test file with mocks**

```typescript
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { KubernetesAdapter } from '../src/kubernetes/adapter';

// Mock @kubernetes/client-node
vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1Api = {
    listNode: vi.fn(),
    listNamespacedPod: vi.fn(),
    readNamespacedPodLog: vi.fn(),
  };

  const mockBatchV1Api = {
    createNamespacedJob: vi.fn(),
    readNamespacedJob: vi.fn(),
    deleteNamespacedJob: vi.fn(),
  };

  const mockAppsV1Api = {
    patchNamespacedDeploymentScale: vi.fn(),
  };

  const mockKubeConfig = {
    loadFromDefault: vi.fn(),
    loadFromFile: vi.fn(),
    getContexts: vi.fn().mockReturnValue([]),
    setCurrentContext: vi.fn(),
    makeApiClient: vi.fn((ApiClass: any) => {
      if (ApiClass.name === 'CoreV1Api') return mockCoreV1Api;
      if (ApiClass.name === 'BatchV1Api') return mockBatchV1Api;
      if (ApiClass.name === 'AppsV1Api') return mockAppsV1Api;
      return {};
    }),
    getCurrentCluster: vi.fn().mockReturnValue({ server: 'https://k8s.local:6443' }),
  };

  return {
    KubeConfig: vi.fn().mockImplementation(() => mockKubeConfig),
    CoreV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    _mockKubeConfig: mockKubeConfig,
    _mockCoreV1Api: mockCoreV1Api,
    _mockBatchV1Api: mockBatchV1Api,
    _mockAppsV1Api: mockAppsV1Api,
  };
});

import * as k8s from '@kubernetes/client-node';

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createMockNodeResponse = (nodes: Array<{ name: string; labels?: Record<string, string> }>) => ({
  body: {
    items: nodes.map(n => ({
      metadata: { name: n.name, labels: n.labels ?? {} },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        allocatable: { cpu: '4', memory: '8Gi' },
        capacity: { cpu: '4', memory: '8Gi' },
      },
    })),
  },
});

const createMockPodResponse = (count: number) => ({
  body: {
    items: Array(count).fill({ metadata: { name: 'pod' } }),
  },
});

describe('KubernetesAdapter', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let mockKubeConfig: any;
  let mockCoreV1Api: any;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    mockKubeConfig = (k8s as any)._mockKubeConfig;
    mockCoreV1Api = (k8s as any)._mockCoreV1Api;
  });

  describe('Cluster Discovery', () => {
    it('should discover clusters from default kubeconfig', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'ctx-1', cluster: 'cluster-1' },
        { name: 'ctx-2', cluster: 'cluster-2' },
      ]);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node-1' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(5));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters.length).toBe(2);
      expect(mockKubeConfig.loadFromDefault).toHaveBeenCalled();
    });

    it('should discover clusters from custom kubeconfig path', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'custom-ctx', cluster: 'custom-cluster' },
      ]);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node-1' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({
        logger: logger as any,
        kubeconfigPath: '/custom/kubeconfig',
      });
      const clusters = await adapter.discoverClusters();

      expect(clusters.length).toBe(1);
      expect(mockKubeConfig.loadFromFile).toHaveBeenCalledWith('/custom/kubeconfig');
    });

    it('should handle missing kubeconfig gracefully', async () => {
      mockKubeConfig.loadFromDefault.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should return empty array when no contexts configured', async () => {
      mockKubeConfig.getContexts.mockReturnValue([]);

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters).toEqual([]);
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-adapter.test.ts`
Expected: 4 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-adapter.test.ts
git commit -m "test: add kubernetes adapter discovery tests"
```

---

## Task 2: Cluster Type Detection Tests

**Files:**
- Modify: `tests/kubernetes-adapter.test.ts`

**Step 1: Add detection tests**

```typescript
  describe('Cluster Type Detection', () => {
    it('should detect GKE cluster from server URL', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'gke-ctx', cluster: 'gke-cluster' },
      ]);
      mockKubeConfig.getCurrentCluster.mockReturnValue({
        server: 'https://35.200.1.1.gke.cloud.google.com',
      });
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'gke-node' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].type).toBe('gke');
    });

    it('should detect K3s cluster from node labels', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'k3s-ctx', cluster: 'k3s-cluster' },
      ]);
      mockKubeConfig.getCurrentCluster.mockReturnValue({
        server: 'https://192.168.1.100:6443',
      });
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([
        { name: 'k3s-node', labels: { 'k3s.io/hostname': 'k3s-node' } },
      ]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].type).toBe('k3s');
    });

    it('should detect generic K8s cluster', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'k8s-ctx', cluster: 'k8s-cluster' },
      ]);
      mockKubeConfig.getCurrentCluster.mockReturnValue({
        server: 'https://k8s-api.example.com:6443',
      });
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([
        { name: 'k8s-node', labels: { 'kubernetes.io/os': 'linux' } },
      ]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].type).toBe('k8s');
    });

    it('should return unknown for unrecognized clusters', async () => {
      mockKubeConfig.getContexts.mockReturnValue([
        { name: 'mystery-ctx', cluster: 'mystery-cluster' },
      ]);
      mockKubeConfig.getCurrentCluster.mockReturnValue(null);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].type).toBe('unknown');
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-adapter.test.ts`
Expected: 8 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-adapter.test.ts
git commit -m "test: add kubernetes cluster type detection tests"
```

---

## Task 3: Resource Monitoring Tests

**Files:**
- Modify: `tests/kubernetes-adapter.test.ts`

**Step 1: Add resource tests**

```typescript
  describe('Resource Monitoring', () => {
    it('should aggregate resources across all nodes', async () => {
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: 'node-1', labels: {} },
              status: {
                conditions: [{ type: 'Ready', status: 'True' }],
                allocatable: { cpu: '4', memory: '8Gi' },
                capacity: { cpu: '4', memory: '8Gi' },
              },
            },
            {
              metadata: { name: 'node-2', labels: {} },
              status: {
                conditions: [{ type: 'Ready', status: 'True' }],
                allocatable: { cpu: '8', memory: '16Gi' },
                capacity: { cpu: '8', memory: '16Gi' },
              },
            },
          ],
        },
      });
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      // 4 + 8 = 12 CPU cores
      expect(clusters[0].resources.cpuCores).toBe(12);
      // 8Gi + 16Gi = 24Gi
      expect(clusters[0].resources.memoryBytes).toBeGreaterThan(20e9);
    });

    it('should parse Kubernetes resource units', async () => {
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue({
        body: {
          items: [{
            metadata: { name: 'node', labels: {} },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              allocatable: { cpu: '2000m', memory: '4096Mi' },
              capacity: { cpu: '2000m', memory: '4096Mi' },
            },
          }],
        },
      });
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      // 2000m = 2 cores
      expect(clusters[0].resources.cpuCores).toBe(2);
      // 4096Mi ~ 4GB
      expect(clusters[0].resources.memoryBytes).toBeGreaterThan(4e9);
    });

    it('should track GPU resources when available', async () => {
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue({
        body: {
          items: [{
            metadata: { name: 'gpu-node', labels: {} },
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              allocatable: {
                cpu: '16',
                memory: '64Gi',
                'nvidia.com/gpu': '4',
              },
              capacity: {
                cpu: '16',
                memory: '64Gi',
                'nvidia.com/gpu': '4',
              },
            },
          }],
        },
      });
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].resources.gpuCount).toBe(4);
    });

    it('should count running pods', async () => {
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(42));

      const adapter = new KubernetesAdapter({ logger: logger as any });
      const clusters = await adapter.discoverClusters();

      expect(clusters[0].runningPods).toBe(42);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-adapter.test.ts`
Expected: 12 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-adapter.test.ts
git commit -m "test: add kubernetes resource monitoring tests"
```

---

## Task 4: Job Management Tests

**Files:**
- Modify: `tests/kubernetes-adapter.test.ts`

**Step 1: Add job management tests**

```typescript
  describe('Job Management', () => {
    let mockBatchV1Api: any;

    beforeEach(() => {
      mockBatchV1Api = (k8s as any)._mockBatchV1Api;
      // Setup cluster discovery
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));
    });

    it('should submit job with correct spec', async () => {
      mockBatchV1Api.createNamespacedJob.mockResolvedValue({
        body: { metadata: { name: 'test-job' } },
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      const jobName = await adapter.submitJob('ctx', {
        name: 'test-job',
        namespace: 'default',
        image: 'alpine:latest',
        command: ['echo', 'hello'],
        cpuLimit: '1',
        memoryLimit: '512Mi',
      });

      expect(jobName).toBe('test-job');
      expect(mockBatchV1Api.createNamespacedJob).toHaveBeenCalledWith(
        'default',
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'test-job' }),
          spec: expect.objectContaining({
            template: expect.objectContaining({
              spec: expect.objectContaining({
                containers: expect.arrayContaining([
                  expect.objectContaining({
                    image: 'alpine:latest',
                    command: ['echo', 'hello'],
                  }),
                ]),
              }),
            }),
          }),
        })
      );
    });

    it('should get job status showing running', async () => {
      mockBatchV1Api.readNamespacedJob.mockResolvedValue({
        body: {
          status: { active: 1, succeeded: 0, failed: 0 },
        },
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      const status = await adapter.getJobStatus('ctx', 'running-job');

      expect(status.active).toBe(1);
      expect(status.succeeded).toBe(0);
    });

    it('should get job status showing completed', async () => {
      mockBatchV1Api.readNamespacedJob.mockResolvedValue({
        body: {
          status: {
            active: 0,
            succeeded: 1,
            failed: 0,
            completionTime: '2024-01-01T00:00:00Z',
            conditions: [{ type: 'Complete', status: 'True' }],
          },
        },
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      const status = await adapter.getJobStatus('ctx', 'completed-job');

      expect(status.succeeded).toBe(1);
      expect(status.completionTime).toBeDefined();
    });

    it('should get job status showing failed', async () => {
      mockBatchV1Api.readNamespacedJob.mockResolvedValue({
        body: {
          status: {
            active: 0,
            succeeded: 0,
            failed: 1,
            conditions: [{ type: 'Failed', status: 'True', message: 'BackoffLimitExceeded' }],
          },
        },
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      const status = await adapter.getJobStatus('ctx', 'failed-job');

      expect(status.failed).toBe(1);
      expect(status.conditions?.[0].message).toBe('BackoffLimitExceeded');
    });

    it('should retrieve job logs from pod', async () => {
      mockCoreV1Api.listNamespacedPod.mockResolvedValue({
        body: {
          items: [{ metadata: { name: 'job-pod-xyz' } }],
        },
      });
      mockCoreV1Api.readNamespacedPodLog.mockResolvedValue({
        body: 'Job output line 1\nJob output line 2\n',
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      const logs = await adapter.getJobLogs('ctx', 'test-job');

      expect(logs).toContain('Job output line 1');
      expect(mockCoreV1Api.readNamespacedPodLog).toHaveBeenCalled();
    });

    it('should delete job with propagation policy', async () => {
      mockBatchV1Api.deleteNamespacedJob.mockResolvedValue({});

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      await adapter.deleteJob('ctx', 'old-job');

      expect(mockBatchV1Api.deleteNamespacedJob).toHaveBeenCalledWith(
        'old-job',
        'default',
        undefined,
        undefined,
        undefined,
        undefined,
        'Background'
      );
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-adapter.test.ts`
Expected: 18 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-adapter.test.ts
git commit -m "test: add kubernetes job management tests"
```

---

## Task 5: Deployment Scaling Tests

**Files:**
- Modify: `tests/kubernetes-adapter.test.ts`

**Step 1: Add scaling tests**

```typescript
  describe('Deployment Scaling', () => {
    let mockAppsV1Api: any;

    beforeEach(() => {
      mockAppsV1Api = (k8s as any)._mockAppsV1Api;
      mockKubeConfig.getContexts.mockReturnValue([{ name: 'ctx', cluster: 'cluster' }]);
      mockCoreV1Api.listNode.mockResolvedValue(createMockNodeResponse([{ name: 'node' }]));
      mockCoreV1Api.listNamespacedPod.mockResolvedValue(createMockPodResponse(0));
    });

    it('should scale deployment to specified replicas', async () => {
      mockAppsV1Api.patchNamespacedDeploymentScale.mockResolvedValue({
        body: { spec: { replicas: 5 } },
      });

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      await adapter.scaleDeployment('ctx', 'my-deployment', 5);

      expect(mockAppsV1Api.patchNamespacedDeploymentScale).toHaveBeenCalledWith(
        'my-deployment',
        'default',
        { spec: { replicas: 5 } }
      );
    });

    it('should handle scaling non-existent deployment', async () => {
      mockAppsV1Api.patchNamespacedDeploymentScale.mockRejectedValue(
        new Error('deployments.apps "missing" not found')
      );

      const adapter = new KubernetesAdapter({ logger: logger as any });
      await adapter.discoverClusters();

      await expect(
        adapter.scaleDeployment('ctx', 'missing', 3)
      ).rejects.toThrow('not found');
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-adapter.test.ts`
Expected: 20 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-adapter.test.ts
git commit -m "test: add kubernetes deployment scaling tests"
```

---

## Task 6: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify test count**

Run: `grep -c "it\(" tests/kubernetes-adapter.test.ts`
Expected: 20

**Step 3: Final commit**

```bash
git add -A
git commit -m "test: kubernetes adapter tests complete (20 tests)"
```
