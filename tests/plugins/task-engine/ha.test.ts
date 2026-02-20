import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { EventEmitter } from 'events';
import { TaskEnginePlugin } from '../../../src/plugins/task-engine/index.js';
import { TaskStateMachine } from '../../../src/plugins/task-engine/state-machine.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type { PluginContext } from '../../../src/plugins/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'error' })],
});

function createMockContext(): {
  ctx: PluginContext;
  db: Database.Database;
  raftEmitter: EventEmitter;
  membershipEmitter: EventEmitter;
  entryLog: Array<{ type: string; data: Buffer }>;
} {
  const db = new Database(':memory:');
  runMigrations(db);

  const raftEmitter = new EventEmitter();
  const membershipEmitter = new EventEmitter();
  const entryLog: Array<{ type: string; data: Buffer }> = [];

  const mockRaft = Object.assign(raftEmitter, {
    isLeader: vi.fn(() => true),
    getLeaderId: vi.fn(() => 'test-node'),
    appendEntry: vi.fn(async (type: string, data: Buffer) => {
      entryLog.push({ type, data });
      return { success: true, index: entryLog.length };
    }),
  });

  const mockMembership = Object.assign(membershipEmitter, {
    getActiveNodes: vi.fn(() => [
      {
        nodeId: 'node-a',
        hostname: 'node-a',
        tailscaleIp: '100.0.0.1',
        grpcPort: 50051,
        role: 'leader',
        status: 'active',
        resources: {
          cpuCores: 8,
          memoryBytes: 16e9,
          memoryAvailableBytes: 8e9,
          gpus: [],
          diskBytes: 500e9,
          diskAvailableBytes: 250e9,
          cpuUsagePercent: 30,
          gamingDetected: false,
        },
        tags: [],
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      },
      {
        nodeId: 'node-b',
        hostname: 'node-b',
        tailscaleIp: '100.0.0.2',
        grpcPort: 50051,
        role: 'follower',
        status: 'active',
        resources: {
          cpuCores: 4,
          memoryBytes: 8e9,
          memoryAvailableBytes: 4e9,
          gpus: [],
          diskBytes: 200e9,
          diskAvailableBytes: 100e9,
          cpuUsagePercent: 50,
          gamingDetected: false,
        },
        tags: [],
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      },
    ]),
    getAllNodes: vi.fn(() => []),
    getNode: vi.fn(() => undefined),
  });

  const ctx: PluginContext = {
    raft: mockRaft as any,
    membership: mockMembership as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: { db } as any,
    memoryReplicator: {} as any,
    logger,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: {},
    events: new EventEmitter(),
  };

  return { ctx, db, raftEmitter, membershipEmitter, entryLog };
}

function simulateRaftCommits(
  raftEmitter: EventEmitter,
  entryLog: Array<{ type: string; data: Buffer }>,
  startIndex = 0,
): void {
  for (let i = startIndex; i < entryLog.length; i++) {
    raftEmitter.emit('entryCommitted', entryLog[i]);
  }
}

function parseEntryPayload(entry: { type: string; data: Buffer }): any {
  const parsed = JSON.parse(entry.data.toString());
  return parsed.payload ?? parsed;
}

describe('Failure Detection & HA Re-queue', () => {
  let plugin: TaskEnginePlugin;
  let ctx: PluginContext;
  let db: Database.Database;
  let raftEmitter: EventEmitter;
  let membershipEmitter: EventEmitter;
  let entryLog: Array<{ type: string; data: Buffer }>;

  beforeEach(async () => {
    const mocks = createMockContext();
    ctx = mocks.ctx;
    db = mocks.db;
    raftEmitter = mocks.raftEmitter;
    membershipEmitter = mocks.membershipEmitter;
    entryLog = mocks.entryLog;

    plugin = new TaskEnginePlugin();
    await plugin.init(ctx);
  });

  // Helper: submit a task and commit it, return the taskId
  async function submitTask(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const tools = plugin.getTools();
    const result = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'echo test',
      ...overrides,
    })) as any;
    return result.taskId;
  }

  // Helper: submit a task, commit it, then set it to running/assigned on a node
  async function submitAndAssignTask(
    nodeId: string,
    state: 'running' | 'assigned' = 'running',
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const taskId = await submitTask(overrides);
    const prevLen = entryLog.length;
    simulateRaftCommits(raftEmitter, entryLog, prevLen - 1);

    // Manually set task state in DB to simulate assignment/running
    db.prepare(`UPDATE te_tasks SET state = ?, assigned_node = ? WHERE id = ?`).run(
      state,
      nodeId,
      taskId,
    );

    return taskId;
  }

  // ── 1. Node offline re-queues running tasks ─────────────────────

  it('re-queues both running tasks when a node goes offline', async () => {
    // Submit 2 tasks, commit them, set both to running on node-b
    const taskId1 = await submitAndAssignTask('node-b', 'running');
    const taskId2 = await submitAndAssignTask('node-b', 'running');

    const prevEntryCount = entryLog.length;

    // Simulate node-b going offline
    membershipEmitter.emit('nodeOffline', 'node-b');

    // Wait for async appendEntry calls
    await vi.waitFor(() => {
      expect(entryLog.length).toBe(prevEntryCount + 2);
    });

    // Verify 2 task_retry entries were appended
    const retryEntries = entryLog.slice(prevEntryCount);
    expect(retryEntries).toHaveLength(2);

    const retryTaskIds = retryEntries.map((e) => {
      expect(e.type).toBe('task_retry');
      return parseEntryPayload(e).taskId;
    });

    expect(retryTaskIds).toContain(taskId1);
    expect(retryTaskIds).toContain(taskId2);
  });

  // ── 2. Node offline re-queues assigned tasks too ────────────────

  it('re-queues assigned (not yet running) tasks on offline node', async () => {
    const taskId = await submitAndAssignTask('node-b', 'assigned');

    const prevEntryCount = entryLog.length;

    membershipEmitter.emit('nodeOffline', 'node-b');

    await vi.waitFor(() => {
      expect(entryLog.length).toBe(prevEntryCount + 1);
    });

    const retryEntry = entryLog[entryLog.length - 1];
    expect(retryEntry.type).toBe('task_retry');
    expect(parseEntryPayload(retryEntry).taskId).toBe(taskId);
  });

  // ── 3. Node offline doesn't touch tasks on other nodes ──────────

  it('only re-queues tasks on the offline node, not other nodes', async () => {
    const taskOnA = await submitAndAssignTask('node-a', 'running');
    const taskOnB = await submitAndAssignTask('node-b', 'running');

    const prevEntryCount = entryLog.length;

    // Only node-b goes offline
    membershipEmitter.emit('nodeOffline', 'node-b');

    await vi.waitFor(() => {
      expect(entryLog.length).toBe(prevEntryCount + 1);
    });

    // Only the node-b task should have a retry entry
    const retryEntries = entryLog.slice(prevEntryCount);
    expect(retryEntries).toHaveLength(1);
    expect(retryEntries[0].type).toBe('task_retry');
    expect(parseEntryPayload(retryEntries[0]).taskId).toBe(taskOnB);

    // node-a task should remain running in DB
    const nodeATask = db
      .prepare('SELECT * FROM te_tasks WHERE id = ?')
      .get(taskOnA) as any;
    expect(nodeATask.state).toBe('running');
    expect(nodeATask.assigned_node).toBe('node-a');
  });

  // ── 4. Non-leader ignores nodeOffline ───────────────────────────

  it('does not re-queue tasks when not the leader', async () => {
    const taskId = await submitAndAssignTask('node-b', 'running');

    const prevEntryCount = entryLog.length;

    // Make this node a follower
    (ctx.raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(false);

    membershipEmitter.emit('nodeOffline', 'node-b');

    // Give async code a chance to run (if it incorrectly does)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No new entries should have been appended
    expect(entryLog.length).toBe(prevEntryCount);
  });

  // ── 5. Retry with backoff (state machine level) ─────────────────

  describe('retry with backoff (state machine)', () => {
    let sm: TaskStateMachine;
    let smDb: Database.Database;

    beforeEach(() => {
      smDb = new Database(':memory:');
      runMigrations(smDb);
      sm = new TaskStateMachine(smDb, 'test-node', logger);
    });

    it('retries with increasing backoff until maxRetries exhausted, then dead letters', () => {
      const taskId = 'test-task-retry';
      const retryPolicy = {
        maxRetries: 3,
        backoffMs: 1000,
        backoffMultiplier: 2,
        retryable: true,
      };

      // Submit the task with custom retry policy
      sm.applyEntry('task_submit', {
        taskId,
        type: 'shell',
        spec: { command: 'flaky-job' },
        priority: 5,
        retryPolicy,
        submitterNode: 'test-node',
      });

      // Assign and start
      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      // ── Failure 1: attempt=0, should retry with attempt=1 ──
      let action = sm.applyEntry('task_failed', {
        taskId,
        error: 'connection reset',
        nodeId: 'node-b',
      });

      expect(action).not.toBeNull();
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(1);
      // backoff = 1000 * 2^0 = 1000ms
      expect(action!.scheduledAfter).toBeDefined();

      // Apply the retry (simulates the Raft commit of task_retry)
      sm.applyEntry('task_retry', {
        taskId,
        attempt: action!.attempt,
        scheduledAfter: action!.scheduledAfter,
      });

      let task = sm.getTask(taskId)!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(1);
      expect(task.scheduled_after).toBeDefined();

      // Re-assign and start again
      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      // ── Failure 2: attempt=1, should retry with attempt=2 ──
      action = sm.applyEntry('task_failed', {
        taskId,
        error: 'timeout',
        nodeId: 'node-b',
      });

      expect(action).not.toBeNull();
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(2);
      // backoff = 1000 * 2^1 = 2000ms

      // Apply retry
      sm.applyEntry('task_retry', {
        taskId,
        attempt: action!.attempt,
        scheduledAfter: action!.scheduledAfter,
      });

      task = sm.getTask(taskId)!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(2);

      // Re-assign and start again
      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      // ── Failure 3: attempt=2, maxRetries=3, should retry with attempt=3 ──
      action = sm.applyEntry('task_failed', {
        taskId,
        error: 'OOM killed',
        nodeId: 'node-b',
      });

      // attempt=2 < maxRetries=3, so still retries
      expect(action).not.toBeNull();
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(3);
      // backoff = 1000 * 2^2 = 4000ms

      // Apply retry
      sm.applyEntry('task_retry', {
        taskId,
        attempt: action!.attempt,
        scheduledAfter: action!.scheduledAfter,
      });

      task = sm.getTask(taskId)!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(3);

      // Re-assign and start again
      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      // ── Failure 4: attempt=3 >= maxRetries=3, should dead letter ──
      action = sm.applyEntry('task_failed', {
        taskId,
        error: 'persistent failure',
        nodeId: 'node-b',
      });

      expect(action).not.toBeNull();
      expect(action!.type).toBe('dead_letter');
      expect(action!.taskId).toBe(taskId);
      expect(action!.reason).toContain('Max retries exhausted');

      // Apply the dead letter entry
      sm.applyEntry('task_dead_letter', {
        taskId,
        reason: action!.reason,
      });

      task = sm.getTask(taskId)!;
      expect(task.state).toBe('dead_letter');
      expect(task.dead_lettered_at).toBeDefined();
    });

    it('applies exponential backoff correctly', () => {
      const taskId = 'test-backoff';
      const retryPolicy = {
        maxRetries: 5,
        backoffMs: 500,
        backoffMultiplier: 3,
        retryable: true,
      };

      sm.applyEntry('task_submit', {
        taskId,
        type: 'shell',
        spec: { command: 'test' },
        retryPolicy,
        submitterNode: 'test-node',
      });

      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      const beforeFail = Date.now();

      // Fail at attempt=0: backoff = 500 * 3^0 = 500ms
      const action = sm.applyEntry('task_failed', {
        taskId,
        error: 'err',
        nodeId: 'node-b',
      });

      expect(action!.type).toBe('retry');
      const scheduledTime = new Date(action!.scheduledAfter!).getTime();
      // scheduledAfter should be approximately now + 500ms
      expect(scheduledTime).toBeGreaterThanOrEqual(beforeFail + 400);
      expect(scheduledTime).toBeLessThanOrEqual(beforeFail + 1000);
    });
  });

  // ── 6. Non-retryable task goes straight to dead letter ──────────

  describe('non-retryable tasks', () => {
    let sm: TaskStateMachine;
    let smDb: Database.Database;

    beforeEach(() => {
      smDb = new Database(':memory:');
      runMigrations(smDb);
      sm = new TaskStateMachine(smDb, 'test-node', logger);
    });

    it('goes straight to dead letter on first failure', () => {
      const taskId = 'non-retryable-task';
      const retryPolicy = {
        maxRetries: 3,
        backoffMs: 1000,
        backoffMultiplier: 2,
        retryable: false,
      };

      sm.applyEntry('task_submit', {
        taskId,
        type: 'shell',
        spec: { command: 'one-shot' },
        retryPolicy,
        submitterNode: 'test-node',
      });

      sm.applyEntry('task_assign', { taskId, nodeId: 'node-b' });
      sm.applyEntry('task_started', { taskId, nodeId: 'node-b' });

      const action = sm.applyEntry('task_failed', {
        taskId,
        error: 'fatal error',
        nodeId: 'node-b',
      });

      // Should go straight to dead_letter despite maxRetries=3
      expect(action).not.toBeNull();
      expect(action!.type).toBe('dead_letter');
      expect(action!.taskId).toBe(taskId);
      expect(action!.reason).toContain('not retryable');
    });
  });

  // ── 7. Multiple tasks on offline node all get re-queued ─────────

  it('re-queues all 5 tasks when their node goes offline', async () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const taskId = await submitAndAssignTask('node-b', 'running', {
        command: `job-${i}`,
      });
      taskIds.push(taskId);
    }

    const prevEntryCount = entryLog.length;

    membershipEmitter.emit('nodeOffline', 'node-b');

    await vi.waitFor(() => {
      expect(entryLog.length).toBe(prevEntryCount + 5);
    });

    const retryEntries = entryLog.slice(prevEntryCount);
    expect(retryEntries).toHaveLength(5);

    const retryTaskIds = retryEntries.map((e) => {
      expect(e.type).toBe('task_retry');
      return parseEntryPayload(e).taskId;
    });

    // Every submitted task should have a retry entry
    for (const taskId of taskIds) {
      expect(retryTaskIds).toContain(taskId);
    }
  });

  // ── 8. Retry entry resets task state correctly ──────────────────

  it('task_retry resets task to queued with correct attempt and scheduled_after', async () => {
    const taskId = await submitAndAssignTask('node-b', 'running');

    const prevLen = entryLog.length;

    membershipEmitter.emit('nodeOffline', 'node-b');

    await vi.waitFor(() => {
      expect(entryLog.length).toBe(prevLen + 1);
    });

    // Now simulate the Raft commit of the retry entry
    simulateRaftCommits(raftEmitter, entryLog, prevLen);

    const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(taskId) as any;
    expect(task.state).toBe('queued');
    expect(task.assigned_node).toBeNull();
    expect(task.started_at).toBeNull();
    expect(task.scheduled_after).toBeDefined();
  });

  // ── 9. No tasks on offline node is a no-op ─────────────────────

  it('does nothing when offline node has no tasks', async () => {
    // Submit a task on node-a only
    await submitAndAssignTask('node-a', 'running');

    const prevEntryCount = entryLog.length;

    // node-c goes offline (has no tasks)
    membershipEmitter.emit('nodeOffline', 'node-c');

    // Give async code a chance to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No retry entries should be appended
    expect(entryLog.length).toBe(prevEntryCount);
  });
});
