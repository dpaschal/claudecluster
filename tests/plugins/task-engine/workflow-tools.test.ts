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

describe('Workflow MCP Tools', () => {
  let plugin: TaskEnginePlugin;
  let ctx: PluginContext;
  let db: Database.Database;
  let raftEmitter: EventEmitter;
  let entryLog: Array<{ type: string; data: Buffer }>;

  beforeEach(async () => {
    const mocks = createMockContext();
    ctx = mocks.ctx;
    db = mocks.db;
    raftEmitter = mocks.raftEmitter;
    entryLog = mocks.entryLog;

    plugin = new TaskEnginePlugin();
    await plugin.init(ctx);
  });

  // ── submit_workflow ─────────────────────────────────────────

  it('submit_workflow returns accepted: true with workflowId', async () => {
    const tools = plugin.getTools();
    const submitWorkflow = tools.get('submit_workflow')!;

    const result = (await submitWorkflow.handler({
      name: 'build-pipeline',
      tasks: {
        build: { type: 'shell', spec: { command: 'npm run build' } },
        test: { type: 'shell', spec: { command: 'npm test' }, dependsOn: ['build'] },
      },
    })) as any;

    expect(result.accepted).toBe(true);
    expect(result.workflowId).toBeDefined();
    expect(typeof result.workflowId).toBe('string');
  });

  it('submit_workflow appends a workflow_submit Raft entry', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('submit_workflow')!.handler({
      name: 'deploy',
      tasks: {
        lint: { type: 'shell', spec: { command: 'npm run lint' } },
      },
    })) as any;

    expect(entryLog).toHaveLength(1);
    expect(entryLog[0].type).toBe('workflow_submit');

    const parsed = JSON.parse(entryLog[0].data.toString());
    expect(parsed.type).toBe('workflow_submit');
    expect(parsed.payload.workflowId).toBe(result.workflowId);
    expect(parsed.payload.definition.name).toBe('deploy');
    expect(parsed.payload.definition.tasks.lint).toBeDefined();
  });

  it('submit_workflow creates workflow in SQLite after Raft commit', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('submit_workflow')!.handler({
      name: 'ci-pipeline',
      tasks: {
        build: { type: 'shell', spec: { command: 'make build' } },
        test: { type: 'shell', spec: { command: 'make test' }, dependsOn: ['build'] },
        deploy: { type: 'shell', spec: { command: 'make deploy' }, dependsOn: ['test'] },
      },
    })) as any;

    // Before Raft commit - no workflow in DB
    let workflow = db.prepare('SELECT * FROM te_workflows WHERE id = ?').get(result.workflowId) as any;
    expect(workflow).toBeUndefined();

    // Simulate Raft commit
    simulateRaftCommits(raftEmitter, entryLog);

    // After commit - workflow exists with correct state
    workflow = db.prepare('SELECT * FROM te_workflows WHERE id = ?').get(result.workflowId) as any;
    expect(workflow).toBeDefined();
    expect(workflow.name).toBe('ci-pipeline');
    expect(workflow.state).toBe('running');
    expect(workflow.created_at).toBeDefined();
  });

  it('submit_workflow sets root tasks to queued and dependent tasks to pending', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('submit_workflow')!.handler({
      name: 'dag-test',
      tasks: {
        root_a: { type: 'shell', spec: { command: 'echo A' } },
        root_b: { type: 'shell', spec: { command: 'echo B' } },
        child: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['root_a', 'root_b'] },
        grandchild: { type: 'shell', spec: { command: 'echo D' }, dependsOn: ['child'] },
      },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    const tasks = db.prepare('SELECT * FROM te_tasks WHERE workflow_id = ?').all(result.workflowId) as any[];
    expect(tasks).toHaveLength(4);

    // Build lookup by task_key
    const byKey: Record<string, any> = {};
    for (const t of tasks) {
      byKey[t.task_key] = t;
    }

    // Root tasks (no dependsOn) should be queued
    expect(byKey['root_a'].state).toBe('queued');
    expect(byKey['root_b'].state).toBe('queued');

    // Dependent tasks should be pending
    expect(byKey['child'].state).toBe('pending');
    expect(byKey['grandchild'].state).toBe('pending');

    // All tasks should have the workflow_id set
    for (const t of tasks) {
      expect(t.workflow_id).toBe(result.workflowId);
    }
  });

  it('submit_workflow creates dependency records in te_task_dependencies', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('submit_workflow')!.handler({
      name: 'dep-check',
      tasks: {
        build: { type: 'shell', spec: { command: 'build' } },
        test: { type: 'shell', spec: { command: 'test' }, dependsOn: ['build'] },
        deploy: { type: 'shell', spec: { command: 'deploy' }, dependsOn: ['build', 'test'] },
      },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    const deps = db.prepare('SELECT * FROM te_task_dependencies WHERE workflow_id = ?').all(result.workflowId) as any[];
    expect(deps).toHaveLength(3); // test->build, deploy->build, deploy->test

    const depPairs = deps.map((d: any) => `${d.task_key}->${d.depends_on_key}`).sort();
    expect(depPairs).toEqual(['deploy->build', 'deploy->test', 'test->build']);
  });

  it('submit_workflow returns error when Raft append fails', async () => {
    const tools = plugin.getTools();

    // Override appendEntry to fail
    (ctx.raft.appendEntry as any).mockResolvedValueOnce({ success: false });

    const result = (await tools.get('submit_workflow')!.handler({
      name: 'will-fail',
      tasks: {
        a: { type: 'shell', spec: { command: 'echo' } },
      },
    })) as any;

    expect(result.accepted).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── list_workflows ──────────────────────────────────────────

  it('list_workflows returns all workflows', async () => {
    const tools = plugin.getTools();

    // Submit 2 workflows
    await tools.get('submit_workflow')!.handler({
      name: 'workflow-1',
      tasks: { a: { type: 'shell', spec: { command: 'echo 1' } } },
    });
    await tools.get('submit_workflow')!.handler({
      name: 'workflow-2',
      tasks: { b: { type: 'shell', spec: { command: 'echo 2' } } },
    });

    simulateRaftCommits(raftEmitter, entryLog);

    const result = (await tools.get('list_workflows')!.handler({})) as any;
    expect(result.workflows).toHaveLength(2);
    expect(result.total).toBe(2);

    // Verify workflow fields
    for (const w of result.workflows) {
      expect(w.workflowId).toBeDefined();
      expect(w.name).toBeDefined();
      expect(w.state).toBe('running');
      expect(w.createdAt).toBeDefined();
    }
  });

  it('list_workflows filters by state', async () => {
    const tools = plugin.getTools();

    // Submit 2 workflows
    const r1 = (await tools.get('submit_workflow')!.handler({
      name: 'wf-running',
      tasks: { a: { type: 'shell', spec: { command: 'echo' } } },
    })) as any;
    const r2 = (await tools.get('submit_workflow')!.handler({
      name: 'wf-completed',
      tasks: { b: { type: 'shell', spec: { command: 'echo' } } },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Force second workflow to completed
    db.prepare("UPDATE te_workflows SET state = 'completed' WHERE id = ?").run(r2.workflowId);

    // Filter by running
    const runningResult = (await tools.get('list_workflows')!.handler({ state: 'running' })) as any;
    expect(runningResult.workflows).toHaveLength(1);
    expect(runningResult.workflows[0].name).toBe('wf-running');

    // Filter by completed
    const completedResult = (await tools.get('list_workflows')!.handler({ state: 'completed' })) as any;
    expect(completedResult.workflows).toHaveLength(1);
    expect(completedResult.workflows[0].name).toBe('wf-completed');
  });

  it('list_workflows respects limit parameter', async () => {
    const tools = plugin.getTools();

    // Submit 3 workflows
    for (let i = 0; i < 3; i++) {
      await tools.get('submit_workflow')!.handler({
        name: `wf-${i}`,
        tasks: { a: { type: 'shell', spec: { command: 'echo' } } },
      });
    }

    simulateRaftCommits(raftEmitter, entryLog);

    const result = (await tools.get('list_workflows')!.handler({ limit: 2 })) as any;
    expect(result.workflows).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('list_workflows returns empty array when no workflows exist', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('list_workflows')!.handler({})) as any;
    expect(result.workflows).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  // ── get_workflow_status ─────────────────────────────────────

  it('get_workflow_status returns workflow with per-task details', async () => {
    const tools = plugin.getTools();

    const submitResult = (await tools.get('submit_workflow')!.handler({
      name: 'status-check',
      tasks: {
        build: { type: 'shell', spec: { command: 'make build' }, priority: 5 },
        test: { type: 'shell', spec: { command: 'make test' }, dependsOn: ['build'] },
      },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    const status = (await tools.get('get_workflow_status')!.handler({
      workflowId: submitResult.workflowId,
    })) as any;

    expect(status.workflowId).toBe(submitResult.workflowId);
    expect(status.name).toBe('status-check');
    expect(status.state).toBe('running');
    expect(status.context).toEqual({});
    expect(status.createdAt).toBeDefined();
    expect(status.completedAt).toBeNull();

    // Per-task details keyed by task_key
    expect(status.tasks).toBeDefined();
    expect(status.tasks.build).toBeDefined();
    expect(status.tasks.build.state).toBe('queued');
    expect(status.tasks.build.assignedNode).toBeNull();
    expect(status.tasks.build.result).toBeNull();
    expect(status.tasks.build.error).toBeNull();

    expect(status.tasks.test).toBeDefined();
    expect(status.tasks.test.state).toBe('pending');
  });

  it('get_workflow_status returns error for unknown workflow', async () => {
    const tools = plugin.getTools();

    const result = (await tools.get('get_workflow_status')!.handler({
      workflowId: 'nonexistent-workflow-id',
    })) as any;

    expect(result.error).toContain('not found');
  });

  it('get_workflow_status reflects task completion state', async () => {
    const tools = plugin.getTools();

    const submitResult = (await tools.get('submit_workflow')!.handler({
      name: 'completion-check',
      tasks: {
        step1: { type: 'shell', spec: { command: 'echo done' } },
        step2: { type: 'shell', spec: { command: 'echo next' }, dependsOn: ['step1'] },
      },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Get step1 task ID
    const tasks = db.prepare('SELECT * FROM te_tasks WHERE workflow_id = ?').all(submitResult.workflowId) as any[];
    const step1 = tasks.find((t: any) => t.task_key === 'step1');

    // Simulate step1 completing
    db.prepare(`
      UPDATE te_tasks SET state = 'completed', result = ?, assigned_node = 'node-a' WHERE id = ?
    `).run(JSON.stringify({ exitCode: 0, stdout: 'done', stderr: '' }), step1.id);

    const status = (await tools.get('get_workflow_status')!.handler({
      workflowId: submitResult.workflowId,
    })) as any;

    expect(status.tasks.step1.state).toBe('completed');
    expect(status.tasks.step1.assignedNode).toBe('node-a');
    expect(status.tasks.step1.result).toEqual({ exitCode: 0, stdout: 'done', stderr: '' });
    expect(status.tasks.step1.error).toBeNull();

    // step2 still pending (no workflow_advance yet)
    expect(status.tasks.step2.state).toBe('pending');
  });

  it('get_workflow_status shows completed workflow state', async () => {
    const tools = plugin.getTools();

    const submitResult = (await tools.get('submit_workflow')!.handler({
      name: 'completed-wf',
      tasks: {
        only: { type: 'shell', spec: { command: 'echo' } },
      },
    })) as any;

    simulateRaftCommits(raftEmitter, entryLog);

    // Force workflow and task to completed state
    db.prepare("UPDATE te_workflows SET state = 'completed', completed_at = datetime('now') WHERE id = ?").run(submitResult.workflowId);
    const tasks = db.prepare('SELECT * FROM te_tasks WHERE workflow_id = ?').all(submitResult.workflowId) as any[];
    db.prepare("UPDATE te_tasks SET state = 'completed' WHERE id = ?").run(tasks[0].id);

    const status = (await tools.get('get_workflow_status')!.handler({
      workflowId: submitResult.workflowId,
    })) as any;

    expect(status.state).toBe('completed');
    expect(status.completedAt).toBeDefined();
    expect(status.tasks.only.state).toBe('completed');
  });

  // ── Tool registration ────────────────────────────────────────

  it('workflow tools have correct inputSchema and handler', () => {
    const tools = plugin.getTools();

    const submitWorkflow = tools.get('submit_workflow')!;
    expect(submitWorkflow.description).toBeTruthy();
    expect(submitWorkflow.inputSchema.required).toEqual(['name', 'tasks']);
    expect(typeof submitWorkflow.handler).toBe('function');

    const listWorkflows = tools.get('list_workflows')!;
    expect(listWorkflows.description).toBeTruthy();
    expect(listWorkflows.inputSchema.properties.state).toBeDefined();
    expect(listWorkflows.inputSchema.properties.limit).toBeDefined();
    expect(typeof listWorkflows.handler).toBe('function');

    const getWorkflowStatus = tools.get('get_workflow_status')!;
    expect(getWorkflowStatus.description).toBeTruthy();
    expect(getWorkflowStatus.inputSchema.required).toEqual(['workflowId']);
    expect(typeof getWorkflowStatus.handler).toBe('function');
  });
});
