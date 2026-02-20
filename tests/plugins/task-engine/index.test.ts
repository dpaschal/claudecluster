import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { EventEmitter } from 'events';
import { TaskEnginePlugin } from '../../../src/plugins/task-engine/index.js';
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
      {
        nodeId: 'node-c',
        hostname: 'node-c',
        tailscaleIp: '100.0.0.3',
        grpcPort: 50051,
        role: 'follower',
        status: 'active',
        resources: {
          cpuCores: 16,
          memoryBytes: 32e9,
          memoryAvailableBytes: 16e9,
          gpus: [],
          diskBytes: 1e12,
          diskAvailableBytes: 500e9,
          cpuUsagePercent: 10,
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

/**
 * Helper: after calling a tool that appends a Raft entry, simulate
 * the Raft commit by emitting entryCommitted for each entry in the log.
 */
function simulateRaftCommits(
  raftEmitter: EventEmitter,
  entryLog: Array<{ type: string; data: Buffer }>,
  startIndex = 0,
): void {
  for (let i = startIndex; i < entryLog.length; i++) {
    raftEmitter.emit('entryCommitted', entryLog[i]);
  }
}

describe('TaskEnginePlugin', () => {
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

  // ── 1. Plugin metadata ───────────────────────────────────────

  it('has correct name and version', () => {
    expect(plugin.name).toBe('task-engine');
    expect(plugin.version).toBe('1.0.0');
  });

  // ── 2. Tool registration ─────────────────────────────────────

  it('registers all 12 MCP tools after init', () => {
    const tools = plugin.getTools();
    expect(tools.size).toBe(12);

    const expectedTools = [
      'submit_task',
      'get_task_result',
      'list_tasks',
      'cancel_task',
      'list_dead_letter_tasks',
      'retry_dead_letter_task',
      'drain_node_tasks',
      'run_distributed',
      'dispatch_subagents',
      'submit_workflow',
      'list_workflows',
      'get_workflow_status',
    ];

    for (const name of expectedTools) {
      expect(tools.has(name), `Missing tool: ${name}`).toBe(true);
      const tool = tools.get(name)!;
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  // ── 3. submit_task ───────────────────────────────────────────

  it('submit_task creates a task and returns accepted: true with taskId', async () => {
    const tools = plugin.getTools();
    const submitTool = tools.get('submit_task')!;

    const result = (await submitTool.handler({
      type: 'shell',
      command: 'echo hello',
      priority: 7,
    })) as any;

    expect(result.accepted).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(typeof result.taskId).toBe('string');

    // Verify Raft appendEntry was called
    expect(ctx.raft.appendEntry).toHaveBeenCalledOnce();
    expect(entryLog).toHaveLength(1);
    expect(entryLog[0].type).toBe('task_submit');

    // Simulate Raft commit so state machine updates
    simulateRaftCommits(raftEmitter, entryLog);

    // Verify task exists in SQLite
    const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(result.taskId) as any;
    expect(task).toBeDefined();
    expect(task.state).toBe('queued');
    expect(task.type).toBe('shell');
    expect(task.priority).toBe(7);
  });

  // ── 4. get_task_result ───────────────────────────────────────

  it('get_task_result returns task state from SQLite', async () => {
    const tools = plugin.getTools();

    // Submit a task first
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'ls -la',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Query the task
    const getResult = (await tools.get('get_task_result')!.handler({
      taskId: submitResult.taskId,
    })) as any;

    expect(getResult.taskId).toBe(submitResult.taskId);
    expect(getResult.state).toBe('queued');
    expect(getResult.type).toBe('shell');
    expect(getResult.createdAt).toBeDefined();
  });

  it('get_task_result returns error for unknown task', async () => {
    const tools = plugin.getTools();
    const result = (await tools.get('get_task_result')!.handler({
      taskId: 'nonexistent-task',
    })) as any;

    expect(result.error).toContain('not found');
  });

  // ── 5. list_tasks ────────────────────────────────────────────

  it('list_tasks returns paginated results', async () => {
    const tools = plugin.getTools();
    const submitTool = tools.get('submit_task')!;

    // Submit 3 tasks
    await submitTool.handler({ type: 'shell', command: 'echo 1' });
    await submitTool.handler({ type: 'shell', command: 'echo 2' });
    await submitTool.handler({ type: 'shell', command: 'echo 3' });

    simulateRaftCommits(raftEmitter, entryLog);

    // Query with limit 2
    const result = (await tools.get('list_tasks')!.handler({
      limit: 2,
    })) as any;

    expect(result.tasks).toHaveLength(2);
    expect(result.limit).toBe(2);

    // Query all
    const allResult = (await tools.get('list_tasks')!.handler({})) as any;
    expect(allResult.tasks).toHaveLength(3);
  });

  // ── 6. cancel_task ───────────────────────────────────────────

  it('cancel_task works on a queued task', async () => {
    const tools = plugin.getTools();

    // Submit a task
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'sleep 10',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);
    const preCancelLen = entryLog.length;

    // Cancel it
    const cancelResult = (await tools.get('cancel_task')!.handler({
      taskId: submitResult.taskId,
    })) as any;

    expect(cancelResult.cancelled).toBe(true);
    expect(cancelResult.taskId).toBe(submitResult.taskId);

    // Simulate the cancel commit (only new entries)
    simulateRaftCommits(raftEmitter, entryLog, preCancelLen);

    // Verify state
    const task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(submitResult.taskId) as any;
    expect(task.state).toBe('cancelled');
  });

  it('cancel_task rejects already-completed tasks', async () => {
    const tools = plugin.getTools();

    // Submit then complete a task via direct DB manipulation
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'echo done',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Force complete in DB
    db.prepare("UPDATE te_tasks SET state = 'completed' WHERE id = ?").run(submitResult.taskId);

    const cancelResult = (await tools.get('cancel_task')!.handler({
      taskId: submitResult.taskId,
    })) as any;

    expect(cancelResult.cancelled).toBe(false);
    expect(cancelResult.error).toContain('terminal state');
  });

  // ── 7. run_distributed ───────────────────────────────────────

  it('run_distributed creates N task submissions (one per node)', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('run_distributed')!.handler({
      command: 'uptime',
    })) as any;

    // Should have submitted 3 tasks (one per active node)
    expect(result.submitted).toBe(3);
    expect(result.taskIds).toHaveLength(3);
    expect(result.nodes).toEqual(['node-a', 'node-b', 'node-c']);

    // Each should be a task_submit entry
    expect(entryLog).toHaveLength(3);
    for (const entry of entryLog) {
      expect(entry.type).toBe('task_submit');
      const parsed = JSON.parse(entry.data.toString());
      expect(parsed.payload.type).toBe('shell');
      expect(parsed.payload.spec.command).toBe('uptime');
      expect(parsed.payload.constraints.targetNode).toBeDefined();
    }
  });

  it('run_distributed filters to specified nodes', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('run_distributed')!.handler({
      command: 'whoami',
      nodes: ['node-a', 'node-c'],
    })) as any;

    expect(result.submitted).toBe(2);
    expect(result.nodes).toEqual(['node-a', 'node-c']);
  });

  // ── 8. dispatch_subagents ────────────────────────────────────

  it('dispatch_subagents creates N subagent tasks', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('dispatch_subagents')!.handler({
      prompt: 'Run unit tests and report results',
      count: 4,
      contextSummary: 'Testing distributed task engine',
    })) as any;

    expect(result.submitted).toBe(4);
    expect(result.count).toBe(4);
    expect(result.taskIds).toHaveLength(4);

    // Verify each is a subagent task
    expect(entryLog).toHaveLength(4);
    for (const entry of entryLog) {
      expect(entry.type).toBe('task_submit');
      const parsed = JSON.parse(entry.data.toString());
      expect(parsed.payload.type).toBe('subagent');
      expect(parsed.payload.spec.prompt).toBe('Run unit tests and report results');
      expect(parsed.payload.spec.contextSummary).toBe('Testing distributed task engine');
    }
  });

  // ── 9. Raft entry committed handler ──────────────────────────

  it('entryCommitted handler applies state machine transitions', async () => {
    const tools = plugin.getTools();

    // Submit a task
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'echo test',
      priority: 3,
    })) as any;

    // Before Raft commit, task should NOT exist in DB
    let task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(submitResult.taskId) as any;
    expect(task).toBeUndefined();

    // Simulate Raft commit
    simulateRaftCommits(raftEmitter, entryLog);

    // After commit, task should exist
    task = db.prepare('SELECT * FROM te_tasks WHERE id = ?').get(submitResult.taskId) as any;
    expect(task).toBeDefined();
    expect(task.state).toBe('queued');
    expect(task.priority).toBe(3);
  });

  // ── 10. Node offline HA re-queue ─────────────────────────────

  it('re-queues tasks when a node goes offline', async () => {
    const tools = plugin.getTools();

    // Submit and commit a task
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'long-running-job',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Manually assign the task to node-b in DB
    db.prepare("UPDATE te_tasks SET state = 'running', assigned_node = 'node-b' WHERE id = ?").run(
      submitResult.taskId,
    );

    const prevEntryCount = entryLog.length;

    // Simulate node-b going offline
    membershipEmitter.emit('nodeOffline', 'node-b');

    // Should have appended a task_retry entry
    expect(entryLog.length).toBeGreaterThan(prevEntryCount);
    const retryEntry = entryLog[entryLog.length - 1];
    expect(retryEntry.type).toBe('task_retry');
    const parsed = JSON.parse(retryEntry.data.toString());
    expect(parsed.payload.taskId).toBe(submitResult.taskId);
  });

  // ── 11. dead_letter tools ────────────────────────────────────

  it('list_dead_letter_tasks returns dead letter queue', async () => {
    const tools = plugin.getTools();

    // Submit and commit a task
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'fail-job',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Force into dead_letter state
    db.prepare("UPDATE te_tasks SET state = 'dead_letter', dead_lettered_at = datetime('now') WHERE id = ?").run(
      submitResult.taskId,
    );

    const result = (await tools.get('list_dead_letter_tasks')!.handler({})) as any;
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe(submitResult.taskId);
  });

  it('retry_dead_letter_task re-queues a dead letter task', async () => {
    const tools = plugin.getTools();

    // Submit and commit
    const submitResult = (await tools.get('submit_task')!.handler({
      type: 'shell',
      command: 'retry-me',
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Force into dead_letter state
    db.prepare("UPDATE te_tasks SET state = 'dead_letter' WHERE id = ?").run(submitResult.taskId);

    const prevLen = entryLog.length;
    const result = (await tools.get('retry_dead_letter_task')!.handler({
      taskId: submitResult.taskId,
    })) as any;

    expect(result.retried).toBe(true);
    expect(result.taskId).toBe(submitResult.taskId);

    // Should have appended a task_retry entry
    expect(entryLog.length).toBeGreaterThan(prevLen);
    expect(entryLog[entryLog.length - 1].type).toBe('task_retry');
  });

  // ── 12. stop() cleanup ──────────────────────────────────────

  it('stop() cleans up listeners and interval', async () => {
    await plugin.start();

    // Verify event listeners are attached
    expect(raftEmitter.listenerCount('entryCommitted')).toBeGreaterThan(0);
    expect(membershipEmitter.listenerCount('nodeOffline')).toBeGreaterThan(0);

    await plugin.stop();

    // Listeners should be removed
    expect(raftEmitter.listenerCount('entryCommitted')).toBe(0);
    expect(membershipEmitter.listenerCount('nodeOffline')).toBe(0);
  });
});
