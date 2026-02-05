# MCP Tools Testing Design

## Goal

Add comprehensive unit tests for MCP tools with mocked cluster components.

## Scope

**In scope:**
- Unit tests for all 17 MCP tools
- Mocked scheduler, membership, state manager, K8s adapter
- Input validation and error handling
- Tool output format verification

**Out of scope:**
- Integration tests with live cluster
- Claude Code end-to-end testing
- Documentation

## Test Structure

**File:** `tests/mcp-tools.test.ts`

```
describe('MCP Tools')
  describe('Cluster Management')      - 6 tests
  describe('Distributed Execution')   - 4 tests
  describe('Kubernetes Tools')        - 4 tests
  describe('Session Tools')           - 4 tests
  describe('Context Tools')           - 4 tests
```

**Total: 22 tests**

## Mock Strategy

```typescript
const createMockScheduler = () => ({
  submit: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1' }),
  getStatus: vi.fn().mockReturnValue({ state: 'completed', exitCode: 0 }),
  cancel: vi.fn().mockResolvedValue(true),
  getQueuedCount: vi.fn().mockReturnValue(5),
  getRunningCount: vi.fn().mockReturnValue(3),
});

const createMockMembership = () => ({
  getAllNodes: vi.fn().mockReturnValue([createTestNode()]),
  getActiveNodes: vi.fn().mockReturnValue([createTestNode()]),
  removeNode: vi.fn().mockResolvedValue(true),
  getNode: vi.fn().mockReturnValue(createTestNode()),
});

const createMockStateManager = () => ({
  getState: vi.fn().mockReturnValue({ leader: 'node-1', term: 5 }),
  getSessions: vi.fn().mockReturnValue([]),
  publishContext: vi.fn().mockResolvedValue({ id: 'ctx-1' }),
  queryContext: vi.fn().mockReturnValue([]),
});

const createMockK8sAdapter = () => ({
  listClusters: vi.fn().mockReturnValue([]),
  submitJob: vi.fn().mockResolvedValue('job-1'),
  scaleDeployment: vi.fn().mockResolvedValue(undefined),
});
```

## Test Cases

### Cluster Management (6 tests)
1. cluster_status should return leader and node count
2. list_nodes should filter by status
3. submit_task should validate task spec
4. submit_task should return task ID
5. get_task_result should return task status
6. scale_cluster should call membership remove

### Distributed Execution (4 tests)
1. run_distributed should execute on multiple nodes
2. run_distributed should aggregate results
3. dispatch_subagents should create subagent tasks
4. dispatch_subagents should respect max_concurrent

### Kubernetes Tools (4 tests)
1. k8s_list_clusters should return cluster info
2. k8s_submit_job should create job
3. k8s_submit_job should validate required fields
4. k8s_scale should update deployment replicas

### Session Tools (4 tests)
1. list_sessions should return active sessions
2. list_sessions should filter by project
3. relay_to_session should validate session exists
4. relay_to_session should send message

### Context Tools (4 tests)
1. publish_context should store entry
2. publish_context should validate type
3. query_context should filter by type
4. query_context should respect visibility

## Success Criteria

- All 22 tests pass
- No regressions in existing tests
- Full coverage of tool input validation
