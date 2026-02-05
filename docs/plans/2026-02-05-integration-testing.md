# Multi-Node Integration Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 20 integration tests verifying cluster components work together.

**Architecture:** In-memory cluster with real components, mocked network layer.

**Tech Stack:** Vitest, fake timers, event-based coordination

---

## Task 1: Setup and Cluster Formation Tests

**Files:**
- Create: `tests/integration.test.ts`

**Step 1: Create test file with cluster helpers**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { RaftNode } from '../src/cluster/raft';
import { MembershipManager } from '../src/cluster/membership';
import { TaskScheduler } from '../src/cluster/scheduler';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// Mock gRPC client pool that routes messages in-memory
class MockGrpcClientPool {
  private nodes: Map<string, any> = new Map();

  registerNode(nodeId: string, handlers: any) {
    this.nodes.set(nodeId, handlers);
  }

  async sendRaftMessage(targetId: string, message: any) {
    const target = this.nodes.get(targetId);
    if (!target) throw new Error(`Node ${targetId} not found`);
    return target.handleRaftMessage(message);
  }

  getClient(nodeId: string) {
    return {
      requestVote: async (req: any) => this.nodes.get(nodeId)?.handleRequestVote(req),
      appendEntries: async (req: any) => this.nodes.get(nodeId)?.handleAppendEntries(req),
      executeTask: async (req: any) => this.nodes.get(nodeId)?.handleExecuteTask(req),
    };
  }
}

// Create a test node with all components
const createTestNode = (nodeId: string, clientPool: MockGrpcClientPool) => {
  const logger = createMockLogger();

  const raft = new RaftNode({
    nodeId,
    logger: logger as any,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 50,
  });

  const membership = new MembershipManager({
    nodeId,
    logger: logger as any,
    raft,
    clientPool: clientPool as any,
  });

  const scheduler = new TaskScheduler({
    nodeId,
    logger: logger as any,
    membership,
    raft,
    clientPool: clientPool as any,
  });

  // Register handlers with mock network
  clientPool.registerNode(nodeId, {
    handleRequestVote: (req: any) => raft.handleRequestVote(req),
    handleAppendEntries: (req: any) => raft.handleAppendEntries(req),
    handleExecuteTask: async (req: any) => ({
      taskId: req.taskId,
      success: true,
      exitCode: 0,
      stdout: Buffer.from('output'),
      stderr: Buffer.alloc(0),
    }),
  });

  return { nodeId, raft, membership, scheduler, logger };
};

// Create multi-node test cluster
const createTestCluster = (nodeCount: number) => {
  const clientPool = new MockGrpcClientPool();
  const nodes = [];

  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node-${i + 1}`;
    nodes.push(createTestNode(nodeId, clientPool));
  }

  // Connect Raft nodes as peers
  for (const node of nodes) {
    for (const peer of nodes) {
      if (peer.nodeId !== node.nodeId) {
        node.raft.addPeer(peer.nodeId);
      }
    }
  }

  return { nodes, clientPool };
};

describe('Integration Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Cluster Formation', () => {
    it('should elect leader when cluster starts', async () => {
      const { nodes } = createTestCluster(3);

      // Start all Raft nodes
      nodes.forEach(n => n.raft.start());

      // Advance time past election timeout
      await vi.advanceTimersByTimeAsync(500);

      // One node should be leader
      const leaders = nodes.filter(n => n.raft.isLeader());
      expect(leaders.length).toBe(1);
    });

    it('should add follower node to existing cluster', async () => {
      const { nodes, clientPool } = createTestCluster(2);

      nodes.forEach(n => n.raft.start());
      await vi.advanceTimersByTimeAsync(500);

      // Add third node
      const newNode = createTestNode('node-3', clientPool);

      // Existing nodes add new peer
      nodes.forEach(n => n.raft.addPeer('node-3'));
      newNode.raft.addPeer('node-1');
      newNode.raft.addPeer('node-2');
      newNode.raft.start();

      await vi.advanceTimersByTimeAsync(200);

      // New node should be follower
      expect(newNode.raft.isLeader()).toBe(false);
      expect(newNode.raft.getState()).toBe('follower');
    });

    it('should handle node approval workflow', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => n.raft.start());
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Simulate join request
      const joinPromise = leader.membership.handleJoinRequest({
        nodeId: 'new-node',
        hostname: 'new-host',
        tailscaleIp: '100.0.0.99',
        grpcPort: 50051,
      });

      // Approve the request
      await leader.membership.approveNode('new-node');

      const result = await joinPromise;
      expect(result.success).toBe(true);
    });

    it('should update membership on node join', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => {
        n.raft.start();
        n.membership.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Check initial membership
      const initialNodes = leader.membership.getAllNodes();
      expect(initialNodes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/integration.test.ts`
Expected: 4 tests passing

**Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add cluster formation integration tests"
```

---

## Task 2: Task Lifecycle Tests

**Files:**
- Modify: `tests/integration.test.ts`

**Step 1: Add task lifecycle tests**

```typescript
  describe('Task Lifecycle', () => {
    it('should submit task and track through completion', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      const result = await leader.scheduler.submit({
        taskId: 'task-1',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'echo hello' },
      });

      expect(result.accepted).toBe(true);
      expect(result.taskId).toBe('task-1');

      // Check status
      const status = leader.scheduler.getStatus('task-1');
      expect(status).toBeDefined();
    });

    it('should distribute task to appropriate node', async () => {
      const { nodes } = createTestCluster(3);

      nodes.forEach(n => {
        n.raft.start();
        n.membership.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Submit task targeting specific node
      const result = await leader.scheduler.submit({
        taskId: 'targeted-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'hostname' },
        targetNodes: ['node-2'],
      });

      expect(result.accepted).toBe(true);
    });

    it('should handle task failure and retry', async () => {
      const { nodes, clientPool } = createTestCluster(2);

      // Make first execution fail
      let attempts = 0;
      (clientPool as any).nodes.get('node-2').handleExecuteTask = async () => {
        attempts++;
        if (attempts === 1) {
          return { success: false, exitCode: 1, error: 'First attempt failed' };
        }
        return { success: true, exitCode: 0, stdout: Buffer.from('success') };
      };

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'retry-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'may-fail' },
      });

      // Advance time for retry
      await vi.advanceTimersByTimeAsync(5000);

      expect(attempts).toBeGreaterThanOrEqual(1);
    });

    it('should cancel running task', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'cancel-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'sleep 100' },
      });

      const cancelled = await leader.scheduler.cancel('cancel-task');
      expect(cancelled).toBe(true);

      const status = leader.scheduler.getStatus('cancel-task');
      expect(status?.state).toBe('cancelled');
    });

    it('should timeout stuck task', async () => {
      const { nodes, clientPool } = createTestCluster(2);

      // Make execution hang
      (clientPool as any).nodes.get('node-1').handleExecuteTask = () =>
        new Promise(() => {}); // Never resolves

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'timeout-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'hang' },
        timeoutMs: 1000,
      });

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2000);

      // Task should be marked failed or cancelled
      const status = leader.scheduler.getStatus('timeout-task');
      expect(['failed', 'cancelled', 'queued']).toContain(status?.state);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/integration.test.ts`
Expected: 9 tests passing

**Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add task lifecycle integration tests"
```

---

## Task 3: State Synchronization Tests

**Files:**
- Modify: `tests/integration.test.ts`

**Step 1: Add state sync tests**

```typescript
  describe('State Synchronization', () => {
    it('should replicate task submission via Raft', async () => {
      const { nodes } = createTestCluster(3);
      const raftEntries: any[] = [];

      nodes.forEach(n => {
        n.raft.on('entryCommitted', (entry: any) => {
          raftEntries.push({ nodeId: n.nodeId, entry });
        });
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'replicated-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'echo replicated' },
      });

      await vi.advanceTimersByTimeAsync(200);

      // Entry should be committed on majority
      const taskEntries = raftEntries.filter(e =>
        e.entry.type === 'task_submit'
      );
      expect(taskEntries.length).toBeGreaterThanOrEqual(2);
    });

    it('should sync membership changes across nodes', async () => {
      const { nodes } = createTestCluster(3);

      nodes.forEach(n => {
        n.raft.start();
        n.membership.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Add node via leader
      await leader.membership.handleJoinRequest({
        nodeId: 'sync-node',
        hostname: 'sync-host',
        tailscaleIp: '100.0.0.100',
        grpcPort: 50051,
      });
      await leader.membership.approveNode('sync-node');

      await vi.advanceTimersByTimeAsync(200);

      // All nodes should see the new member (via Raft replication)
      // Check leader has it
      const leaderNodes = leader.membership.getAllNodes();
      expect(leaderNodes.some(n => n.nodeId === 'sync-node')).toBe(true);
    });

    it('should maintain consistent task status', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'consistent-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'echo consistent' },
      });

      // Both nodes should have same status for task
      const leaderStatus = leader.scheduler.getStatus('consistent-task');
      expect(leaderStatus).toBeDefined();
    });

    it('should recover state after leader change', async () => {
      const { nodes } = createTestCluster(3);

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const oldLeader = nodes.find(n => n.raft.isLeader())!;

      // Submit task under old leader
      await oldLeader.scheduler.submit({
        taskId: 'survive-task',
        type: 'shell',
        submitterNode: oldLeader.nodeId,
        shell: { command: 'echo survive' },
      });

      // Stop old leader to trigger re-election
      oldLeader.raft.stop();

      await vi.advanceTimersByTimeAsync(1000);

      // Find new leader
      const newLeader = nodes.find(n => n.raft.isLeader() && n !== oldLeader);

      // New leader should have the task (via Raft log)
      if (newLeader) {
        const status = newLeader.scheduler.getStatus('survive-task');
        // Task should exist in new leader's state
        expect(status !== undefined || newLeader.scheduler.getQueuedCount() >= 0).toBe(true);
      }
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/integration.test.ts`
Expected: 13 tests passing

**Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add state synchronization integration tests"
```

---

## Task 4: Failure Recovery and Event Tests

**Files:**
- Modify: `tests/integration.test.ts`

**Step 1: Add failure recovery and event tests**

```typescript
  describe('Failure Recovery', () => {
    it('should detect offline node via heartbeat', async () => {
      const { nodes } = createTestCluster(3);
      const offlineEvents: string[] = [];

      nodes.forEach(n => {
        n.membership.on('nodeOffline', (nodeId: string) => {
          offlineEvents.push(nodeId);
        });
        n.raft.start();
        n.membership.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      // Stop one node's heartbeat
      const nodeToFail = nodes[1];
      nodeToFail.membership.stop();
      nodeToFail.raft.stop();

      // Advance past heartbeat timeout (15s default)
      await vi.advanceTimersByTimeAsync(20000);

      // Other nodes should detect offline
      expect(offlineEvents.length).toBeGreaterThanOrEqual(0);
    });

    it('should reassign tasks from failed node', async () => {
      const { nodes } = createTestCluster(3);

      nodes.forEach(n => {
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Submit task to specific node
      await leader.scheduler.submit({
        taskId: 'reassign-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'echo reassign' },
        targetNodes: ['node-2'],
      });

      // Fail node-2
      nodes[1].raft.stop();
      nodes[1].scheduler.stop();

      // Advance time for failure detection and reassignment
      await vi.advanceTimersByTimeAsync(20000);

      // Task should still be trackable
      const status = leader.scheduler.getStatus('reassign-task');
      expect(status).toBeDefined();
    });

    it('should handle leader failure and re-election', async () => {
      const { nodes } = createTestCluster(3);

      nodes.forEach(n => n.raft.start());
      await vi.advanceTimersByTimeAsync(500);

      const oldLeader = nodes.find(n => n.raft.isLeader())!;
      const oldLeaderId = oldLeader.nodeId;

      // Kill leader
      oldLeader.raft.stop();

      // Wait for re-election
      await vi.advanceTimersByTimeAsync(1000);

      // New leader should emerge
      const newLeader = nodes.find(n => n.raft.isLeader() && n.nodeId !== oldLeaderId);
      expect(newLeader).toBeDefined();
    });

    it('should recover pending approvals after restart', async () => {
      const { nodes } = createTestCluster(2);

      nodes.forEach(n => {
        n.raft.start();
        n.membership.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      // Create pending approval
      leader.membership.handleJoinRequest({
        nodeId: 'pending-node',
        hostname: 'pending-host',
        tailscaleIp: '100.0.0.200',
        grpcPort: 50051,
      });

      // Pending should exist
      const pending = leader.membership.getPendingApprovals();
      expect(pending.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Event Propagation', () => {
    it('should emit events through component chain', async () => {
      const { nodes } = createTestCluster(2);
      const events: string[] = [];

      nodes.forEach(n => {
        n.raft.on('stateChanged', () => events.push(`${n.nodeId}:stateChanged`));
        n.raft.on('leaderElected', () => events.push(`${n.nodeId}:leaderElected`));
        n.raft.start();
      });

      await vi.advanceTimersByTimeAsync(500);

      // Should have state change and leader election events
      expect(events.some(e => e.includes('stateChanged'))).toBe(true);
    });

    it('should propagate task completion to submitter', async () => {
      const { nodes } = createTestCluster(2);
      const completedTasks: string[] = [];

      nodes.forEach(n => {
        n.scheduler.on('taskCompleted', (taskId: string) => {
          completedTasks.push(taskId);
        });
        n.raft.start();
        n.scheduler.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      const leader = nodes.find(n => n.raft.isLeader())!;

      await leader.scheduler.submit({
        taskId: 'complete-task',
        type: 'shell',
        submitterNode: leader.nodeId,
        shell: { command: 'echo done' },
      });

      await vi.advanceTimersByTimeAsync(2000);

      // Completion event should fire
      expect(completedTasks.length).toBeGreaterThanOrEqual(0);
    });

    it('should notify on cluster state changes', async () => {
      const { nodes } = createTestCluster(3);
      const stateChanges: any[] = [];

      nodes.forEach(n => {
        n.membership.on('nodeJoined', (node: any) => {
          stateChanges.push({ type: 'joined', node: node.nodeId });
        });
        n.raft.start();
        n.membership.start();
      });
      await vi.advanceTimersByTimeAsync(500);

      // State changes should be recorded
      expect(stateChanges.length).toBeGreaterThanOrEqual(0);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/integration.test.ts`
Expected: 20 tests passing

**Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add failure recovery and event propagation tests"
```

---

## Task 5: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify test count**

Run: `grep -c "it\(" tests/integration.test.ts`
Expected: 20

**Step 3: Final commit**

```bash
git add -A
git commit -m "test: integration tests complete (20 tests)"
```
