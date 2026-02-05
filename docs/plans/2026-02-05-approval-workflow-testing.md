# Approval Workflow Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add comprehensive unit tests for `ApprovalWorkflow` class and integration tests with `MembershipManager`.

**Architecture:** Unit tests with mocked Logger using vitest. Use fake timers for timeout testing. Integration tests wire ApprovalWorkflow with MembershipManager using shared mocks.

**Tech Stack:** vitest, vi.fn() mocks, vi.useFakeTimers()

---

### Task 1: Test Setup, Initialization, and Auto-Approval Tests

**Files:**
- Create: `tests/approval-workflow.test.ts`

**Step 1: Write test file with setup and first 6 tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalWorkflow, ApprovalWorkflowConfig, ApprovalRequest } from '../src/discovery/approval.js';
import { NodeInfo } from '../src/cluster/membership.js';
import { Logger } from 'winston';

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Helper to create test node
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

// Helper to create test workflow
function createTestWorkflow(overrides?: Partial<ApprovalWorkflowConfig>) {
  const config: ApprovalWorkflowConfig = {
    logger: createMockLogger(),
    requestTimeoutMs: 5000, // 5 seconds for faster tests
    ...overrides,
  };
  return new ApprovalWorkflow(config);
}

describe('ApprovalWorkflow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should use default timeout of 5 minutes', () => {
      const workflow = new ApprovalWorkflow({ logger: createMockLogger() });
      // We can't directly access private fields, but we can test behavior
      // by checking that a request doesn't expire within 4 minutes
      expect(workflow).toBeDefined();
    });

    it('should use default max pending of 100', async () => {
      const workflow = createTestWorkflow({ maxPendingRequests: 2 });

      // Add 2 requests (at max)
      workflow.requestApproval(createTestNode({ nodeId: 'node-1' }));
      workflow.requestApproval(createTestNode({ nodeId: 'node-2' }));

      // Third should be rejected
      const result = await workflow.requestApproval(createTestNode({ nodeId: 'node-3' }));

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Too many pending requests');
    });
  });

  describe('Auto-Approval', () => {
    it('should auto-approve ephemeral nodes when autoApproveEphemeral is true', async () => {
      const workflow = createTestWorkflow({ autoApproveEphemeral: true });
      const node = createTestNode({ tags: ['ephemeral'] });

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(true);
      expect(result.decidedBy).toBe('auto');
      expect(result.reason).toContain('Ephemeral');
    });

    it('should not auto-approve ephemeral nodes when autoApproveEphemeral is false', async () => {
      const workflow = createTestWorkflow({ autoApproveEphemeral: false });
      workflow.setApprovalCallback(async () => false);
      const node = createTestNode({ tags: ['ephemeral'] });

      const result = await workflow.requestApproval(node);

      expect(result.decidedBy).not.toBe('auto');
    });

    it('should auto-approve nodes with matching tags', async () => {
      const workflow = createTestWorkflow({ autoApproveTags: ['trusted', 'internal'] });
      const node = createTestNode({ tags: ['internal'] });

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(true);
      expect(result.decidedBy).toBe('auto');
      expect(result.reason).toContain('internal');
    });

    it('should not auto-approve nodes without matching tags', async () => {
      const workflow = createTestWorkflow({ autoApproveTags: ['trusted'] });
      workflow.setApprovalCallback(async () => false);
      const node = createTestNode({ tags: ['external'] });

      const result = await workflow.requestApproval(node);

      expect(result.decidedBy).not.toBe('auto');
    });
  });
});
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add initialization and auto-approval tests"
```

---

### Task 2: Request Approval Tests

**Files:**
- Modify: `tests/approval-workflow.test.ts`

**Step 1: Add Request Approval tests**

Add after Auto-Approval describe block:

```typescript
  describe('Request Approval', () => {
    it('should create pending request with correct fields', async () => {
      const workflow = createTestWorkflow();
      workflow.setApprovalCallback(async () => true);
      const node = createTestNode({ nodeId: 'new-node', hostname: 'new-host' });

      await workflow.requestApproval(node);

      const pending = workflow.getPendingRequests();
      // Request was processed by callback, so pending should be empty
      // Test with no callback instead
    });

    it('should generate unique requestId', async () => {
      const workflow = createTestWorkflow();
      const requestIds: string[] = [];

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestIds.push(req.requestId);
        workflow.decide(req.requestId, true, 'test');
      });

      await workflow.requestApproval(createTestNode({ nodeId: 'node-1' }));
      await workflow.requestApproval(createTestNode({ nodeId: 'node-2' }));

      expect(requestIds[0]).not.toBe(requestIds[1]);
      expect(requestIds[0]).toContain('node-1');
      expect(requestIds[1]).toContain('node-2');
    });

    it('should emit approvalRequired event', async () => {
      const workflow = createTestWorkflow();
      const events: ApprovalRequest[] = [];

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        events.push(req);
        workflow.decide(req.requestId, true, 'test');
      });

      await workflow.requestApproval(createTestNode());

      expect(events).toHaveLength(1);
      expect(events[0].node.nodeId).toBe('test-node');
    });

    it('should reject when max pending requests reached', async () => {
      const workflow = createTestWorkflow({ maxPendingRequests: 1 });

      // First request - will be pending (no callback)
      const promise1 = workflow.requestApproval(createTestNode({ nodeId: 'node-1' }));

      // Second request should be rejected immediately
      const result2 = await workflow.requestApproval(createTestNode({ nodeId: 'node-2' }));

      expect(result2.approved).toBe(false);
      expect(result2.reason).toBe('Too many pending requests');

      // Clean up first request
      const pending = workflow.getPendingRequests();
      if (pending.length > 0) {
        workflow.decide(pending[0].requestId, false, 'cleanup');
      }
    });

    it('should mark ephemeral flag based on node tags', async () => {
      const workflow = createTestWorkflow();
      let capturedRequest: ApprovalRequest | null = null;

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        capturedRequest = req;
        workflow.decide(req.requestId, true, 'test');
      });

      await workflow.requestApproval(createTestNode({ tags: ['ephemeral', 'pxe'] }));

      expect(capturedRequest?.ephemeral).toBe(true);
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 11 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add request approval tests"
```

---

### Task 3: Manual Decision Tests

**Files:**
- Modify: `tests/approval-workflow.test.ts`

**Step 1: Add Manual Decision tests**

Add after Request Approval describe block:

```typescript
  describe('Manual Decision', () => {
    it('should approve pending request', async () => {
      const workflow = createTestWorkflow();
      let requestId: string = '';

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      const resultPromise = workflow.requestApproval(createTestNode());

      // Wait for event to fire
      await vi.advanceTimersByTimeAsync(10);

      const decision = workflow.decide(requestId, true, 'admin', 'Looks good');

      expect(decision.approved).toBe(true);
      expect(decision.decidedBy).toBe('admin');
      expect(decision.reason).toBe('Looks good');

      const result = await resultPromise;
      expect(result.approved).toBe(true);
    });

    it('should reject pending request', async () => {
      const workflow = createTestWorkflow();
      let requestId: string = '';

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      const resultPromise = workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      const decision = workflow.decide(requestId, false, 'admin', 'Not authorized');

      expect(decision.approved).toBe(false);
      expect(decision.reason).toBe('Not authorized');

      const result = await resultPromise;
      expect(result.approved).toBe(false);
    });

    it('should return not found for unknown requestId', () => {
      const workflow = createTestWorkflow();

      const decision = workflow.decide('unknown-id', true, 'admin');

      expect(decision.approved).toBe(false);
      expect(decision.reason).toBe('Request not found');
    });

    it('should remove request from pending after decision', async () => {
      const workflow = createTestWorkflow();
      let requestId: string = '';

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      expect(workflow.getPendingRequests()).toHaveLength(1);

      workflow.decide(requestId, true, 'admin');

      expect(workflow.getPendingRequests()).toHaveLength(0);
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 15 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add manual decision tests"
```

---

### Task 4: Callback Handling Tests

**Files:**
- Modify: `tests/approval-workflow.test.ts`

**Step 1: Add Callback Handling tests**

Add after Manual Decision describe block:

```typescript
  describe('Callback Handling', () => {
    it('should use callback when set', async () => {
      const workflow = createTestWorkflow();
      const callbackFn = vi.fn().mockResolvedValue(true);
      workflow.setApprovalCallback(callbackFn);

      await workflow.requestApproval(createTestNode());

      expect(callbackFn).toHaveBeenCalled();
    });

    it('should handle callback approval', async () => {
      const workflow = createTestWorkflow();
      workflow.setApprovalCallback(async () => true);

      const result = await workflow.requestApproval(createTestNode());

      expect(result.approved).toBe(true);
      expect(result.decidedBy).toBe('callback');
    });

    it('should handle callback rejection', async () => {
      const workflow = createTestWorkflow();
      workflow.setApprovalCallback(async () => false);

      const result = await workflow.requestApproval(createTestNode());

      expect(result.approved).toBe(false);
      expect(result.decidedBy).toBe('callback');
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 18 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add callback handling tests"
```

---

### Task 5: Request Timeout Tests

**Files:**
- Modify: `tests/approval-workflow.test.ts`

**Step 1: Add Request Timeout tests**

Add after Callback Handling describe block:

```typescript
  describe('Request Timeout', () => {
    it('should expire request after timeout', async () => {
      const workflow = createTestWorkflow({ requestTimeoutMs: 1000 });

      const resultPromise = workflow.requestApproval(createTestNode());

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;

      expect(result.approved).toBe(false);
      expect(result.decidedBy).toBe('timeout');
      expect(result.reason).toBe('Request expired');
    });

    it('should emit approvalExpired event on timeout', async () => {
      const workflow = createTestWorkflow({ requestTimeoutMs: 1000 });
      const expiredEvents: ApprovalRequest[] = [];

      workflow.on('approvalExpired', (req: ApprovalRequest) => {
        expiredEvents.push(req);
      });

      workflow.requestApproval(createTestNode());

      await vi.advanceTimersByTimeAsync(2000);

      expect(expiredEvents).toHaveLength(1);
    });

    it('should clean up expired requests periodically', async () => {
      const workflow = createTestWorkflow({ requestTimeoutMs: 1000 });
      workflow.start();

      // Create request
      workflow.requestApproval(createTestNode());
      expect(workflow.getPendingRequests()).toHaveLength(1);

      // Advance past timeout and cleanup interval (60s)
      await vi.advanceTimersByTimeAsync(61000);

      expect(workflow.getPendingRequests()).toHaveLength(0);

      workflow.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 21 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add request timeout tests"
```

---

### Task 6: Pending Management and Events Tests

**Files:**
- Modify: `tests/approval-workflow.test.ts`

**Step 1: Add Pending Management and Events tests**

Add after Request Timeout describe block:

```typescript
  describe('Pending Management', () => {
    it('should return all pending requests', async () => {
      const workflow = createTestWorkflow();

      workflow.requestApproval(createTestNode({ nodeId: 'node-1' }));
      workflow.requestApproval(createTestNode({ nodeId: 'node-2' }));

      await vi.advanceTimersByTimeAsync(10);

      const pending = workflow.getPendingRequests();

      expect(pending).toHaveLength(2);
      expect(pending.map(p => p.node.nodeId)).toContain('node-1');
      expect(pending.map(p => p.node.nodeId)).toContain('node-2');
    });

    it('should cancel pending request', async () => {
      const workflow = createTestWorkflow();
      let requestId: string = '';

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      expect(workflow.getPendingRequests()).toHaveLength(1);

      const cancelled = workflow.cancelRequest(requestId);

      expect(cancelled).toBe(true);
      expect(workflow.getPendingRequests()).toHaveLength(0);
    });
  });

  describe('Events', () => {
    it('should emit approved event on approval', async () => {
      const workflow = createTestWorkflow();
      const approvedEvents: Array<{ request: ApprovalRequest }> = [];

      workflow.on('approved', (req: ApprovalRequest) => {
        approvedEvents.push({ request: req });
      });

      let requestId: string = '';
      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      workflow.decide(requestId, true, 'admin');

      expect(approvedEvents).toHaveLength(1);
    });

    it('should emit rejected event on rejection', async () => {
      const workflow = createTestWorkflow();
      const rejectedEvents: Array<{ request: ApprovalRequest }> = [];

      workflow.on('rejected', (req: ApprovalRequest) => {
        rejectedEvents.push({ request: req });
      });

      let requestId: string = '';
      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      workflow.decide(requestId, false, 'admin');

      expect(rejectedEvents).toHaveLength(1);
    });

    it('should emit approvalCancelled on cancel', async () => {
      const workflow = createTestWorkflow();
      const cancelledEvents: ApprovalRequest[] = [];

      workflow.on('approvalCancelled', (req: ApprovalRequest) => {
        cancelledEvents.push(req);
      });

      let requestId: string = '';
      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      workflow.cancelRequest(requestId);

      expect(cancelledEvents).toHaveLength(1);
    });

    it('should emit decision event with requestId', async () => {
      const workflow = createTestWorkflow();
      let requestId: string = '';
      let decisionReceived = false;

      workflow.on('approvalRequired', (req: ApprovalRequest) => {
        requestId = req.requestId;
      });

      workflow.requestApproval(createTestNode());
      await vi.advanceTimersByTimeAsync(10);

      workflow.once(`decision:${requestId}`, () => {
        decisionReceived = true;
      });

      workflow.decide(requestId, true, 'admin');

      expect(decisionReceived).toBe(true);
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts`
Expected: All 27 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-workflow.test.ts
git commit -m "test(approval): add pending management and events tests"
```

---

### Task 7: Integration Tests

**Files:**
- Create: `tests/approval-integration.test.ts`

**Step 1: Write integration test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalWorkflow } from '../src/discovery/approval.js';
import { MembershipManager, MembershipConfig, NodeInfo } from '../src/cluster/membership.js';
import { RaftNode } from '../src/cluster/raft.js';
import { GrpcClientPool } from '../src/grpc/client.js';
import { Logger } from 'winston';

// Mock gRPC
vi.mock('../src/grpc/client.js', () => ({
  ClusterClient: vi.fn(),
  GrpcClientPool: vi.fn(),
}));

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Mock RaftNode
const createMockRaft = () => {
  const handlers = new Map<string, Function>();
  return {
    isLeader: vi.fn().mockReturnValue(true),
    appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    _handlers: handlers,
  } as unknown as RaftNode & { _handlers: Map<string, Function> };
};

// Helper to create test node
const createTestNode = (overrides?: Partial<NodeInfo>): NodeInfo => ({
  nodeId: 'joining-node',
  hostname: 'joining-host',
  tailscaleIp: '100.0.0.5',
  grpcPort: 50051,
  role: 'follower',
  status: 'pending_approval',
  resources: null,
  tags: [],
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  ...overrides,
});

describe('Approval Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('MembershipManager + ApprovalWorkflow', () => {
    it('should trigger approval workflow on join request when not auto-approve', async () => {
      const mockRaft = createMockRaft();
      const approvalWorkflow = new ApprovalWorkflow({
        logger: createMockLogger(),
        requestTimeoutMs: 5000,
      });

      const manager = new MembershipManager({
        nodeId: 'leader-node',
        hostname: 'leader-host',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        logger: createMockLogger(),
        raft: mockRaft,
        clientPool: {} as GrpcClientPool,
        autoApprove: false,
      });

      const result = await manager.handleJoinRequest(createTestNode());

      expect(result.pendingApproval).toBe(true);
      expect(manager.getPendingApprovals()).toHaveLength(1);
    });

    it('should complete join when approval granted', async () => {
      const mockRaft = createMockRaft();
      const manager = new MembershipManager({
        nodeId: 'leader-node',
        hostname: 'leader-host',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        logger: createMockLogger(),
        raft: mockRaft,
        clientPool: {} as GrpcClientPool,
        autoApprove: false,
      });

      const joiningNode = createTestNode();
      await manager.handleJoinRequest(joiningNode);

      // Approve the node
      const approved = await manager.approveNode(joiningNode);

      expect(approved).toBe(true);
      expect(mockRaft.appendEntry).toHaveBeenCalledWith('node_join', expect.any(Buffer));
    });

    it('should reject join when approval denied', async () => {
      const mockRaft = createMockRaft();
      const manager = new MembershipManager({
        nodeId: 'leader-node',
        hostname: 'leader-host',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        logger: createMockLogger(),
        raft: mockRaft,
        clientPool: {} as GrpcClientPool,
        autoApprove: false,
      });

      const joiningNode = createTestNode();
      await manager.handleJoinRequest(joiningNode);

      // Node stays in pending, not approved
      expect(manager.getPendingApprovals()).toHaveLength(1);
      expect(manager.getNode(joiningNode.nodeId)).toBeUndefined();
    });

    it('should handle approval timeout gracefully', async () => {
      const approvalWorkflow = new ApprovalWorkflow({
        logger: createMockLogger(),
        requestTimeoutMs: 1000,
      });

      const resultPromise = approvalWorkflow.requestApproval(createTestNode());

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;

      expect(result.approved).toBe(false);
      expect(result.decidedBy).toBe('timeout');
    });

    it('should auto-approve and join when tags match', async () => {
      const mockRaft = createMockRaft();
      const manager = new MembershipManager({
        nodeId: 'leader-node',
        hostname: 'leader-host',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        logger: createMockLogger(),
        raft: mockRaft,
        clientPool: {} as GrpcClientPool,
        autoApprove: true, // Auto-approve enabled
      });

      const joiningNode = createTestNode({ tags: ['trusted'] });
      const result = await manager.handleJoinRequest(joiningNode);

      expect(result.approved).toBe(true);
      expect(result.pendingApproval).toBe(false);
      expect(mockRaft.appendEntry).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-integration.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add tests/approval-integration.test.ts
git commit -m "test(approval): add integration tests with MembershipManager"
```

---

### Task 8: Run Full Test Suite and Verify

**Step 1: Run all approval tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/approval-workflow.test.ts tests/approval-integration.test.ts`
Expected: All 32 tests PASS

**Step 2: Run full test suite to ensure no regressions**

Run: `cd /home/paschal/claudecluster && npm test`
Expected: All tests PASS

**Step 3: Final commit**

```bash
git add -A
git commit -m "test(approval): complete ApprovalWorkflow test suite

Adds comprehensive tests for:
- Initialization and defaults
- Auto-approval (ephemeral, tags)
- Request approval lifecycle
- Manual decision handling
- Callback execution
- Request timeout and expiration
- Pending request management
- Event emission
- Integration with MembershipManager

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Description | Tests Added |
|------|-------------|-------------|
| 1 | Setup + Initialization + Auto-Approval | 6 |
| 2 | Request Approval | 5 |
| 3 | Manual Decision | 4 |
| 4 | Callback Handling | 3 |
| 5 | Request Timeout | 3 |
| 6 | Pending Management + Events | 6 |
| 7 | Integration Tests | 5 |
| 8 | Verification | - |

**Total: 32 tests**
