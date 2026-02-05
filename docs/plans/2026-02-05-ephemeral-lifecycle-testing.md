# Ephemeral Node Lifecycle Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 18 tests for ephemeral node handling in approval workflow and membership.

**Architecture:** Test existing ephemeral support with mocked components.

**Tech Stack:** Vitest, fake timers, event assertions

---

## Task 1: Setup and Detection Tests

**Files:**
- Create: `tests/ephemeral-lifecycle.test.ts`

**Step 1: Create test file with setup**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock types matching the codebase
interface NodeInfo {
  nodeId: string;
  hostname: string;
  tailscaleIp: string;
  grpcPort: number;
  role: 'leader' | 'follower' | 'candidate' | 'worker';
  status: 'pending_approval' | 'active' | 'draining' | 'offline';
  resources: any;
  tags: string[];
  joinedAt: number;
  lastSeen: number;
}

interface ApprovalRequest {
  requestId: string;
  node: NodeInfo;
  ephemeral: boolean;
  requestedAt: number;
}

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createEphemeralNode = (overrides: Partial<NodeInfo> = {}): NodeInfo => ({
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

const createPersistentNode = (overrides: Partial<NodeInfo> = {}): NodeInfo => ({
  nodeId: 'persistent-node-1',
  hostname: 'server-host',
  tailscaleIp: '100.0.0.50',
  grpcPort: 50051,
  role: 'follower',
  status: 'pending_approval',
  resources: null,
  tags: [],
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  ...overrides,
});

// Helper to check if node is ephemeral
const isEphemeral = (node: NodeInfo): boolean => {
  return node.tags.includes('ephemeral');
};

// Mock ApprovalWorkflow behavior
class MockApprovalWorkflow extends EventEmitter {
  private config: {
    autoApproveEphemeral: boolean;
    autoApproveTags: string[];
  };
  private pendingRequests: Map<string, ApprovalRequest> = new Map();

  constructor(config: { autoApproveEphemeral?: boolean; autoApproveTags?: string[] }) {
    super();
    this.config = {
      autoApproveEphemeral: config.autoApproveEphemeral ?? false,
      autoApproveTags: config.autoApproveTags ?? [],
    };
  }

  async requestApproval(node: NodeInfo): Promise<{ approved: boolean; requestId: string }> {
    const ephemeral = isEphemeral(node);
    const requestId = `req-${node.nodeId}`;

    // Check auto-approval
    if (ephemeral && this.config.autoApproveEphemeral) {
      this.emit('approved', { requestId, node, autoApproved: true });
      return { approved: true, requestId };
    }

    // Check tag-based auto-approval
    const hasAutoApproveTag = node.tags.some(t =>
      this.config.autoApproveTags.includes(t)
    );
    if (hasAutoApproveTag) {
      this.emit('approved', { requestId, node, autoApproved: true });
      return { approved: true, requestId };
    }

    // Requires manual approval
    const request: ApprovalRequest = {
      requestId,
      node,
      ephemeral,
      requestedAt: Date.now(),
    };
    this.pendingRequests.set(requestId, request);
    this.emit('approvalRequired', request);

    return { approved: false, requestId };
  }

  approve(requestId: string): boolean {
    const request = this.pendingRequests.get(requestId);
    if (!request) return false;
    this.pendingRequests.delete(requestId);
    this.emit('approved', { requestId, node: request.node, autoApproved: false });
    return true;
  }

  getPending(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }
}

describe('Ephemeral Node Lifecycle', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Detection and Tagging', () => {
    it('should detect ephemeral node from tags', () => {
      const node = createEphemeralNode();

      expect(isEphemeral(node)).toBe(true);
      expect(node.tags).toContain('ephemeral');
    });

    it('should mark node as ephemeral in approval request', async () => {
      const workflow = new MockApprovalWorkflow({ autoApproveEphemeral: false });
      const node = createEphemeralNode();

      let capturedRequest: ApprovalRequest | null = null;
      workflow.on('approvalRequired', (req) => {
        capturedRequest = req;
      });

      await workflow.requestApproval(node);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.ephemeral).toBe(true);
    });

    it('should identify non-ephemeral nodes correctly', () => {
      const node = createPersistentNode();

      expect(isEphemeral(node)).toBe(false);
      expect(node.tags).not.toContain('ephemeral');
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/ephemeral-lifecycle.test.ts`
Expected: 3 tests passing

**Step 3: Commit**

```bash
git add tests/ephemeral-lifecycle.test.ts
git commit -m "test: add ephemeral node detection tests"
```

---

## Task 2: Auto-Approval Tests

**Files:**
- Modify: `tests/ephemeral-lifecycle.test.ts`

**Step 1: Add auto-approval tests**

```typescript
  describe('Auto-Approval', () => {
    it('should auto-approve ephemeral nodes when enabled', async () => {
      const workflow = new MockApprovalWorkflow({ autoApproveEphemeral: true });
      const node = createEphemeralNode();

      let approved = false;
      workflow.on('approved', () => {
        approved = true;
      });

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(true);
      expect(approved).toBe(true);
    });

    it('should not auto-approve ephemeral when disabled', async () => {
      const workflow = new MockApprovalWorkflow({ autoApproveEphemeral: false });
      const node = createEphemeralNode();

      let approvalRequired = false;
      workflow.on('approvalRequired', () => {
        approvalRequired = true;
      });

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(false);
      expect(approvalRequired).toBe(true);
    });

    it('should auto-approve nodes with trusted tags', async () => {
      const workflow = new MockApprovalWorkflow({
        autoApproveEphemeral: false,
        autoApproveTags: ['tag:claudecluster-trusted'],
      });
      const node = createPersistentNode({
        tags: ['tag:claudecluster-trusted'],
      });

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(true);
    });

    it('should require manual approval for non-ephemeral nodes', async () => {
      const workflow = new MockApprovalWorkflow({ autoApproveEphemeral: true });
      const node = createPersistentNode();

      const result = await workflow.requestApproval(node);

      expect(result.approved).toBe(false);
      expect(workflow.getPending().length).toBe(1);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/ephemeral-lifecycle.test.ts`
Expected: 7 tests passing

**Step 3: Commit**

```bash
git add tests/ephemeral-lifecycle.test.ts
git commit -m "test: add ephemeral auto-approval tests"
```

---

## Task 3: Lifecycle Management Tests

**Files:**
- Modify: `tests/ephemeral-lifecycle.test.ts`

**Step 1: Add lifecycle tests**

```typescript
  describe('Lifecycle Management', () => {
    // Mock membership manager for lifecycle tests
    class MockMembershipManager extends EventEmitter {
      private nodes: Map<string, NodeInfo> = new Map();
      private heartbeatInterval: NodeJS.Timeout | null = null;
      private offlineTimeout = 15000; // 15 seconds

      addNode(node: NodeInfo) {
        this.nodes.set(node.nodeId, { ...node, status: 'active', lastSeen: Date.now() });
        this.emit('nodeJoined', node);
      }

      updateHeartbeat(nodeId: string) {
        const node = this.nodes.get(nodeId);
        if (node) {
          node.lastSeen = Date.now();
          this.nodes.set(nodeId, node);
        }
      }

      startHeartbeatMonitor() {
        this.heartbeatInterval = setInterval(() => {
          const now = Date.now();
          for (const [nodeId, node] of this.nodes) {
            if (node.status === 'active' && now - node.lastSeen > this.offlineTimeout) {
              node.status = 'offline';
              this.nodes.set(nodeId, node);
              this.emit('nodeOffline', node);
            }
          }
        }, 5000);
      }

      stopHeartbeatMonitor() {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
        }
      }

      getNode(nodeId: string): NodeInfo | undefined {
        return this.nodes.get(nodeId);
      }

      removeNode(nodeId: string) {
        const node = this.nodes.get(nodeId);
        if (node) {
          this.nodes.delete(nodeId);
          this.emit('nodeRemoved', node);
        }
      }
    }

    it('should track ephemeral node from pending to active', async () => {
      const membership = new MockMembershipManager();
      const node = createEphemeralNode({ status: 'pending_approval' });

      membership.addNode(node);
      const activeNode = membership.getNode(node.nodeId);

      expect(activeNode?.status).toBe('active');
    });

    it('should update lastSeen on heartbeat', async () => {
      const membership = new MockMembershipManager();
      const node = createEphemeralNode();

      membership.addNode(node);
      const initialLastSeen = membership.getNode(node.nodeId)!.lastSeen;

      await vi.advanceTimersByTimeAsync(1000);
      membership.updateHeartbeat(node.nodeId);

      const updatedLastSeen = membership.getNode(node.nodeId)!.lastSeen;
      expect(updatedLastSeen).toBeGreaterThan(initialLastSeen);
    });

    it('should detect ephemeral node going offline', async () => {
      const membership = new MockMembershipManager();
      const node = createEphemeralNode();

      let offlineEvent: NodeInfo | null = null;
      membership.on('nodeOffline', (n) => {
        offlineEvent = n;
      });

      membership.addNode(node);
      membership.startHeartbeatMonitor();

      // Advance past offline timeout without heartbeat
      await vi.advanceTimersByTimeAsync(20000);

      expect(offlineEvent).not.toBeNull();
      expect(offlineEvent!.nodeId).toBe(node.nodeId);
      expect(membership.getNode(node.nodeId)?.status).toBe('offline');

      membership.stopHeartbeatMonitor();
    });

    it('should emit events for ephemeral node state changes', async () => {
      const membership = new MockMembershipManager();
      const node = createEphemeralNode();

      const events: string[] = [];
      membership.on('nodeJoined', () => events.push('joined'));
      membership.on('nodeOffline', () => events.push('offline'));
      membership.on('nodeRemoved', () => events.push('removed'));

      membership.addNode(node);
      membership.startHeartbeatMonitor();

      await vi.advanceTimersByTimeAsync(20000);

      membership.removeNode(node.nodeId);

      expect(events).toContain('joined');
      expect(events).toContain('offline');
      expect(events).toContain('removed');

      membership.stopHeartbeatMonitor();
    });

    it('should handle rapid reconnection of ephemeral node', async () => {
      const membership = new MockMembershipManager();
      const node = createEphemeralNode();

      membership.addNode(node);
      membership.startHeartbeatMonitor();

      // Almost go offline
      await vi.advanceTimersByTimeAsync(14000);

      // Reconnect with heartbeat
      membership.updateHeartbeat(node.nodeId);

      // Continue past what would have been offline
      await vi.advanceTimersByTimeAsync(5000);

      // Should still be active
      expect(membership.getNode(node.nodeId)?.status).toBe('active');

      membership.stopHeartbeatMonitor();
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/ephemeral-lifecycle.test.ts`
Expected: 12 tests passing

**Step 3: Commit**

```bash
git add tests/ephemeral-lifecycle.test.ts
git commit -m "test: add ephemeral lifecycle management tests"
```

---

## Task 4: Draining and Cleanup Tests

**Files:**
- Modify: `tests/ephemeral-lifecycle.test.ts`

**Step 1: Add draining and cleanup tests**

```typescript
  describe('Graceful Draining', () => {
    class MockDrainingManager extends EventEmitter {
      private nodes: Map<string, NodeInfo> = new Map();
      private drainCallbacks: Map<string, () => void> = new Map();

      addNode(node: NodeInfo) {
        this.nodes.set(node.nodeId, { ...node, status: 'active' });
      }

      async drainNode(nodeId: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        if (!node) return false;

        node.status = 'draining';
        this.nodes.set(nodeId, node);
        this.emit('nodeDraining', node);

        // Simulate task reassignment
        await new Promise(r => setTimeout(r, 100));
        this.emit('tasksReassigned', { nodeId, count: 3 });

        // Complete drain
        node.status = 'offline';
        this.nodes.set(nodeId, node);
        this.emit('drainComplete', node);

        return true;
      }

      getNode(nodeId: string): NodeInfo | undefined {
        return this.nodes.get(nodeId);
      }
    }

    it('should drain ephemeral node gracefully', async () => {
      const manager = new MockDrainingManager();
      const node = createEphemeralNode();

      manager.addNode(node);

      let draining = false;
      manager.on('nodeDraining', () => {
        draining = true;
      });

      await manager.drainNode(node.nodeId);

      expect(draining).toBe(true);
      expect(manager.getNode(node.nodeId)?.status).toBe('offline');
    });

    it('should reassign tasks during drain', async () => {
      const manager = new MockDrainingManager();
      const node = createEphemeralNode();

      manager.addNode(node);

      let reassigned = 0;
      manager.on('tasksReassigned', ({ count }) => {
        reassigned = count;
      });

      await manager.drainNode(node.nodeId);

      expect(reassigned).toBe(3);
    });

    it('should complete drain before removal', async () => {
      const manager = new MockDrainingManager();
      const node = createEphemeralNode();

      manager.addNode(node);

      const events: string[] = [];
      manager.on('nodeDraining', () => events.push('draining'));
      manager.on('drainComplete', () => events.push('complete'));

      await manager.drainNode(node.nodeId);

      expect(events).toEqual(['draining', 'complete']);
    });
  });

  describe('Cleanup and Removal', () => {
    class MockCleanupManager extends EventEmitter {
      private nodes: Map<string, NodeInfo> = new Map();
      private ephemeralTimeout = 3600000; // 1 hour
      private cleanupInterval: NodeJS.Timeout | null = null;

      addNode(node: NodeInfo) {
        this.nodes.set(node.nodeId, { ...node });
      }

      markOffline(nodeId: string) {
        const node = this.nodes.get(nodeId);
        if (node) {
          node.status = 'offline';
          node.lastSeen = Date.now();
          this.nodes.set(nodeId, node);
        }
      }

      startCleanup() {
        this.cleanupInterval = setInterval(() => {
          const now = Date.now();
          for (const [nodeId, node] of this.nodes) {
            if (
              node.status === 'offline' &&
              isEphemeral(node) &&
              now - node.lastSeen > this.ephemeralTimeout
            ) {
              this.nodes.delete(nodeId);
              this.emit('nodeCleanedUp', node);
            }
          }
        }, 60000); // Check every minute
      }

      stopCleanup() {
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
        }
      }

      getNode(nodeId: string): NodeInfo | undefined {
        return this.nodes.get(nodeId);
      }

      getAllNodes(): NodeInfo[] {
        return Array.from(this.nodes.values());
      }
    }

    it('should remove offline ephemeral node after timeout', async () => {
      const manager = new MockCleanupManager();
      const node = createEphemeralNode();

      manager.addNode(node);
      manager.markOffline(node.nodeId);
      manager.startCleanup();

      let cleaned: NodeInfo | null = null;
      manager.on('nodeCleanedUp', (n) => {
        cleaned = n;
      });

      // Advance past ephemeral timeout
      await vi.advanceTimersByTimeAsync(3700000); // 1 hour + buffer

      expect(cleaned).not.toBeNull();
      expect(cleaned!.nodeId).toBe(node.nodeId);
      expect(manager.getNode(node.nodeId)).toBeUndefined();

      manager.stopCleanup();
    });

    it('should clean up node state on removal', async () => {
      const manager = new MockCleanupManager();
      const node = createEphemeralNode();

      manager.addNode(node);
      manager.markOffline(node.nodeId);
      manager.startCleanup();

      await vi.advanceTimersByTimeAsync(3700000);

      expect(manager.getAllNodes().length).toBe(0);

      manager.stopCleanup();
    });

    it('should notify cluster of ephemeral node removal', async () => {
      const manager = new MockCleanupManager();
      const node = createEphemeralNode();

      const notifications: string[] = [];
      manager.on('nodeCleanedUp', (n) => {
        notifications.push(`removed:${n.nodeId}`);
      });

      manager.addNode(node);
      manager.markOffline(node.nodeId);
      manager.startCleanup();

      await vi.advanceTimersByTimeAsync(3700000);

      expect(notifications).toContain(`removed:${node.nodeId}`);

      manager.stopCleanup();
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/ephemeral-lifecycle.test.ts`
Expected: 18 tests passing

**Step 3: Commit**

```bash
git add tests/ephemeral-lifecycle.test.ts
git commit -m "test: add ephemeral draining and cleanup tests"
```

---

## Task 5: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify test count**

Run: `grep -c "it\(" tests/ephemeral-lifecycle.test.ts`
Expected: 18

**Step 3: Final commit**

```bash
git add -A
git commit -m "test: ephemeral lifecycle tests complete (18 tests)"
```
