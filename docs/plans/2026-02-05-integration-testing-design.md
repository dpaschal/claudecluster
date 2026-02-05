# Multi-Node Integration Testing Design

## Goal

Add integration tests that verify cluster components work together correctly.

## Scope

**In scope:**
- Raft + MembershipManager integration
- Scheduler + TaskExecutor integration
- State replication across components
- Event propagation testing
- Error recovery scenarios

**Out of scope:**
- Real network testing (requires multiple machines)
- gRPC network layer (mocked)
- mTLS handshakes (covered in security tests)

## Test Structure

**File:** `tests/integration.test.ts`

```
describe('Integration Tests')
  describe('Cluster Formation')        - 4 tests
  describe('Task Lifecycle')           - 5 tests
  describe('State Synchronization')    - 4 tests
  describe('Failure Recovery')         - 4 tests
  describe('Event Propagation')        - 3 tests
```

**Total: 20 tests**

## Test Cases

### Cluster Formation (4 tests)
1. Should elect leader when cluster starts
2. Should add follower node to existing cluster
3. Should handle node approval workflow
4. Should update membership on node join

### Task Lifecycle (5 tests)
1. Should submit task and track through completion
2. Should distribute task to appropriate node
3. Should handle task failure and retry
4. Should cancel running task
5. Should timeout stuck task

### State Synchronization (4 tests)
1. Should replicate task submission via Raft
2. Should sync membership changes across nodes
3. Should maintain consistent task status
4. Should recover state after leader change

### Failure Recovery (4 tests)
1. Should detect offline node via heartbeat
2. Should reassign tasks from failed node
3. Should handle leader failure and re-election
4. Should recover pending approvals after restart

### Event Propagation (3 tests)
1. Should emit events through component chain
2. Should propagate task completion to submitter
3. Should notify on cluster state changes

## Mock Strategy

Create in-memory cluster with real components but mocked network:

```typescript
const createTestCluster = (nodeCount: number) => {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      raft: new RaftNode({ ... }),
      membership: new MembershipManager({ ... }),
      scheduler: new TaskScheduler({ ... }),
      // Mock gRPC to route messages in-memory
    });
  }
  return { nodes, mockNetwork };
};
```

## Success Criteria

- All 20 tests pass
- Tests complete in < 30 seconds
- No flaky timing-dependent failures
- Full component interaction coverage
