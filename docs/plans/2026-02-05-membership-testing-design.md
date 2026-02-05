# Membership Manager Testing Design

## Goal

Add comprehensive unit tests for `MembershipManager` class covering join flow and failure detection with full mock isolation.

## Scope

**In scope:**
- Join cluster flow (client side)
- Handle join request (leader side)
- Node approval via Raft
- Heartbeat sending
- Failure detection
- Node removal
- Raft entry handling (node_join/node_leave commits)

**Out of scope:**
- Proto conversion helpers (already working)
- Resource updates (trivial setter)
- Integration tests with real RaftNode (future work)

## Test Structure

**File:** `tests/membership-manager.test.ts`

```
describe('MembershipManager')
  describe('Initialization')        - 3 tests
  describe('Join Cluster')          - 5 tests
  describe('Handle Join Request')   - 4 tests
  describe('Approve Node')          - 3 tests
  describe('Heartbeat')             - 5 tests
  describe('Failure Detection')     - 4 tests
  describe('Node Removal')          - 3 tests
  describe('Raft Entry Handling')   - 7 tests
```

**Total: ~34 tests**

## Mock Strategy

### RaftNode Mock

```typescript
const createMockRaft = () => {
  const handlers = new Map<string, Function>();
  return {
    isLeader: vi.fn().mockReturnValue(false),
    appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
  };
};
```

### ClusterClient Mock

```typescript
vi.mock('../src/grpc/client.js', () => ({
  ClusterClient: vi.fn().mockImplementation(() => ({
    registerNode: vi.fn(),
    heartbeat: vi.fn(),
  })),
  GrpcClientPool: vi.fn(),
}));
```

### Logger Mock

```typescript
const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
```

## Test Cases

### Initialization (3 tests)

1. Should register self node on creation
2. Should set up Raft event listeners
3. Should default to follower role

### Join Cluster (5 tests)

1. Should call registerNode on seed address
2. Should set status to pending_approval when response.pending_approval
3. Should set status to active and store leader address when approved
4. Should add Raft peers for each returned peer
5. Should return false on network error

### Handle Join Request (4 tests)

1. Should redirect to leader when not leader (return leaderAddress)
2. Should auto-approve when autoApprove config is true
3. Should add to pendingApprovals when manual approval required
4. Should emit nodeJoinRequest event for pending nodes

### Approve Node (3 tests)

1. Should return false when not leader
2. Should call raft.appendEntry with node_join type and node data
3. Should remove from pendingApprovals on success

### Heartbeat (5 tests)

1. Should not send heartbeat when node is leader
2. Should not send heartbeat when no leader address known
3. Should call client.heartbeat with node_id and resources
4. Should update lastSeen on acknowledged heartbeat
5. Should handle heartbeat failure gracefully (no throw)

### Failure Detection (4 tests)

1. Should not mark self as offline
2. Should mark node as offline when lastSeen exceeds timeout
3. Should emit nodeOffline event for timed-out nodes
4. Should not mark recently-seen nodes as offline

### Node Removal (3 tests)

1. Should return false when not leader
2. Should set status to draining for graceful removal
3. Should call raft.appendEntry with node_leave type

### Raft Entry Handling (7 tests)

1. Should add node to membership on node_join commit
2. Should call raft.addPeer when node_join commits
3. Should emit nodeJoined event on node_join commit
4. Should remove node from membership on node_leave commit
5. Should call raft.removePeer when node_leave commits
6. Should emit nodeLeft event on node_leave commit
7. Should ignore noop entries

## Timer Strategy

Use `vi.useFakeTimers()` for deterministic testing of:
- Heartbeat intervals
- Failure detection intervals
- Timeout thresholds

```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});
```

## Success Criteria

- All 34 tests pass
- No regressions in existing tests (83 total)
- Tests cover happy path and error cases for join/failure flows
