# Ephemeral Node Lifecycle Testing Design

## Goal

Add comprehensive tests for ephemeral node handling in the existing approval workflow and membership management.

## Scope

**In scope:**
- Ephemeral node detection and tagging
- Auto-approval for ephemeral nodes
- Ephemeral node lifecycle (join, active, offline, removal)
- Graceful draining of ephemeral nodes
- TTL and cleanup behavior

**Out of scope:**
- PXE boot image generation (not implemented)
- netboot.xyz integration (not implemented)
- Boot-time configuration (not implemented)

## Test Structure

**File:** `tests/ephemeral-lifecycle.test.ts`

```
describe('Ephemeral Node Lifecycle')
  describe('Detection and Tagging')     - 3 tests
  describe('Auto-Approval')             - 4 tests
  describe('Lifecycle Management')      - 5 tests
  describe('Graceful Draining')         - 3 tests
  describe('Cleanup and Removal')       - 3 tests
```

**Total: 18 tests**

## Mock Strategy

```typescript
const createEphemeralNode = (overrides?: Partial<NodeInfo>): NodeInfo => ({
  nodeId: 'ephemeral-node-1',
  hostname: 'pxe-host',
  tailscaleIp: '100.0.0.99',
  grpcPort: 50051,
  role: 'worker',
  status: 'pending_approval',
  resources: null,
  tags: ['ephemeral'],
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  ...overrides,
});
```

## Test Cases

### Detection and Tagging (3 tests)
1. Should detect ephemeral node from tags
2. Should mark node as ephemeral in approval request
3. Should identify non-ephemeral nodes correctly

### Auto-Approval (4 tests)
1. Should auto-approve ephemeral nodes when enabled
2. Should not auto-approve ephemeral when disabled
3. Should auto-approve nodes with trusted tags
4. Should require manual approval for non-ephemeral nodes

### Lifecycle Management (5 tests)
1. Should track ephemeral node from pending to active
2. Should update lastSeen on heartbeat
3. Should detect ephemeral node going offline
4. Should emit events for ephemeral node state changes
5. Should handle rapid reconnection of ephemeral node

### Graceful Draining (3 tests)
1. Should drain ephemeral node gracefully
2. Should reassign tasks during drain
3. Should complete drain before removal

### Cleanup and Removal (3 tests)
1. Should remove offline ephemeral node after timeout
2. Should clean up node state on removal
3. Should notify cluster of ephemeral node removal

## Success Criteria

- All 18 tests pass
- No regressions in existing tests
- Full coverage of ephemeral node paths in approval/membership
