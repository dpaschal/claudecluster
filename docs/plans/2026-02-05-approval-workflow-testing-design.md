# Approval Workflow Testing Design

## Goal

Add comprehensive unit tests for `ApprovalWorkflow` class and integration tests with `MembershipManager`.

## Scope

**In scope:**
- Unit tests for ApprovalWorkflow (27 tests)
- Integration tests with MembershipManager (5 tests)
- Auto-approval logic
- Request lifecycle (create, decide, cancel)
- Timeout/expiration handling
- Callback execution
- Event emission

**Out of scope:**
- UI/CLI approval interface testing
- Network-level integration

## Test Structure

**Files:**
- `tests/approval-workflow.test.ts` - Unit tests
- `tests/approval-integration.test.ts` - Integration tests

### Unit Tests (27 tests)

```
describe('ApprovalWorkflow')
  describe('Initialization')           - 2 tests
  describe('Auto-Approval')             - 4 tests
  describe('Request Approval')          - 5 tests
  describe('Manual Decision')           - 4 tests
  describe('Callback Handling')         - 3 tests
  describe('Request Timeout')           - 3 tests
  describe('Pending Management')        - 2 tests
  describe('Events')                    - 4 tests
```

### Integration Tests (5 tests)

```
describe('Approval Integration')
  describe('MembershipManager + ApprovalWorkflow')  - 5 tests
```

## Test Cases

### Initialization (2 tests)
1. Should use default timeout of 5 minutes
2. Should use default max pending of 100

### Auto-Approval (4 tests)
1. Should auto-approve ephemeral nodes when autoApproveEphemeral is true
2. Should not auto-approve ephemeral nodes when autoApproveEphemeral is false
3. Should auto-approve nodes with matching tags
4. Should not auto-approve nodes without matching tags

### Request Approval (5 tests)
1. Should create pending request with correct fields
2. Should generate unique requestId
3. Should emit approvalRequired event
4. Should reject when max pending requests reached
5. Should mark ephemeral flag based on node tags

### Manual Decision (4 tests)
1. Should approve pending request
2. Should reject pending request
3. Should return not found for unknown requestId
4. Should remove request from pending after decision

### Callback Handling (3 tests)
1. Should use callback when set
2. Should handle callback approval
3. Should handle callback rejection

### Request Timeout (3 tests)
1. Should expire request after timeout
2. Should emit approvalExpired event on timeout
3. Should clean up expired requests periodically

### Pending Management (2 tests)
1. Should return all pending requests
2. Should cancel pending request

### Events (4 tests)
1. Should emit approved event on approval
2. Should emit rejected event on rejection
3. Should emit approvalCancelled on cancel
4. Should emit decision event with requestId

### Integration Tests (5 tests)
1. Should trigger approval workflow on join request when not auto-approve
2. Should complete join when approval granted
3. Should reject join when approval denied
4. Should handle approval timeout gracefully
5. Should auto-approve and join when tags match

## Mock Strategy

### Logger Mock
```typescript
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);
```

### NodeInfo Factory
```typescript
const createTestNode = (overrides?: Partial<NodeInfo>): NodeInfo => ({
  nodeId: 'test-node',
  hostname: 'test-host',
  tailscaleIp: '100.0.0.1',
  grpcPort: 50051,
  role: 'follower',
  status: 'pending_approval',
  resources: null,
  tags: [],
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  ...overrides,
});
```

## Timer Strategy

Use `vi.useFakeTimers()` for:
- Request timeout testing
- Cleanup interval testing
- Expiration logic

## Success Criteria

- All 32 tests pass
- No regressions in existing tests
- Full coverage of ApprovalWorkflow public API
- Integration tests verify MembershipManager + ApprovalWorkflow work together
