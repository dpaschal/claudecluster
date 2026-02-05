# Kubernetes Adapter Testing Design

## Goal

Add comprehensive unit tests for `KubernetesAdapter` class with mocked @kubernetes/client-node.

## Scope

**In scope:**
- Unit tests for cluster discovery
- Cluster type detection (GKE, K3s, K8s)
- Resource monitoring
- Job submission and status tracking
- Job logs retrieval
- Deployment scaling

**Out of scope:**
- Integration tests with real K8s clusters
- End-to-end job execution

## Test Structure

**File:** `tests/kubernetes-adapter.test.ts`

```
describe('KubernetesAdapter')
  describe('Cluster Discovery')        - 4 tests
  describe('Cluster Type Detection')   - 4 tests
  describe('Resource Monitoring')      - 4 tests
  describe('Job Management')           - 6 tests
  describe('Deployment Scaling')       - 2 tests
```

**Total: 20 tests**

## Mock Strategy

### @kubernetes/client-node Mock
```typescript
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromDefault: vi.fn(),
    loadFromFile: vi.fn(),
    getContexts: vi.fn().mockReturnValue([]),
    setCurrentContext: vi.fn(),
    makeApiClient: vi.fn(),
  })),
  CoreV1Api: vi.fn(),
  BatchV1Api: vi.fn(),
  AppsV1Api: vi.fn(),
}));
```

### Mock Cluster Factory
```typescript
const createMockCluster = (type: 'gke' | 'k3s' | 'k8s' = 'k8s') => ({
  name: `test-${type}-cluster`,
  context: `ctx-${type}`,
  server: type === 'gke' ? 'https://1.2.3.4.gke.cloud.google.com' : 'https://k8s.local:6443',
  nodes: [createMockNode()],
  resources: { cpuCores: 8, memoryBytes: 16e9, gpuCount: 0 },
});

const createMockNode = (overrides?: Partial<K8sNode>) => ({
  name: 'node-1',
  status: 'Ready',
  labels: {},
  allocatable: { cpu: '4', memory: '8Gi' },
  capacity: { cpu: '4', memory: '8Gi' },
  ...overrides,
});
```

## Test Cases

### Cluster Discovery (4 tests)
1. Should discover clusters from default kubeconfig
2. Should discover clusters from custom kubeconfig path
3. Should handle missing kubeconfig gracefully
4. Should return empty array when no contexts configured

### Cluster Type Detection (4 tests)
1. Should detect GKE cluster from server URL
2. Should detect K3s cluster from node labels
3. Should detect generic K8s cluster
4. Should return unknown for unrecognized clusters

### Resource Monitoring (4 tests)
1. Should aggregate resources across all nodes
2. Should parse Kubernetes resource units (m, Ki, Mi, Gi)
3. Should track GPU resources when available
4. Should count running pods

### Job Management (6 tests)
1. Should submit job with correct spec
2. Should get job status showing running
3. Should get job status showing completed
4. Should get job status showing failed
5. Should retrieve job logs from pod
6. Should delete job with propagation policy

### Deployment Scaling (2 tests)
1. Should scale deployment to specified replicas
2. Should handle scaling non-existent deployment

## Success Criteria

- All 20 tests pass
- No regressions in existing tests
- Full coverage of KubernetesAdapter public API
