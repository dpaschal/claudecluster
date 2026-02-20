import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { TaskStateMachine, StateMachineAction } from '../../../src/plugins/task-engine/state-machine.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type {
  TaskRecord,
  WorkflowSubmitPayload,
  WorkflowRecord,
} from '../../../src/plugins/task-engine/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'warn' })],
});

let db: Database.Database;
let sm: TaskStateMachine;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  sm = new TaskStateMachine(db, 'test-node', logger);
});

afterEach(() => db.close());

// ── Helpers ───────────────────────────────────────────────────────

function getTaskByKey(workflowId: string, taskKey: string): TaskRecord | undefined {
  return db.prepare(
    "SELECT * FROM te_tasks WHERE workflow_id = ? AND task_key = ?",
  ).get(workflowId, taskKey) as TaskRecord | undefined;
}

function getWorkflow(workflowId: string): WorkflowRecord | undefined {
  return db.prepare('SELECT * FROM te_workflows WHERE id = ?').get(workflowId) as WorkflowRecord | undefined;
}

function getAllTasks(workflowId: string): TaskRecord[] {
  return db.prepare(
    'SELECT * FROM te_tasks WHERE workflow_id = ? ORDER BY created_at ASC',
  ).all(workflowId) as TaskRecord[];
}

/** Drive a task through assign -> started -> complete lifecycle */
function completeTask(taskId: string, result = { exitCode: 0, stdout: 'OK', stderr: '' }): StateMachineAction | null {
  sm.applyEntry('task_assign', { taskId, nodeId: 'node-a' });
  sm.applyEntry('task_started', { taskId, nodeId: 'node-a' });
  return sm.applyEntry('task_complete', { taskId, result });
}

/** Drive a task through assign -> started -> failed lifecycle (non-retryable) */
function failTask(taskId: string, error: string): StateMachineAction | null {
  sm.applyEntry('task_assign', { taskId, nodeId: 'node-a' });
  sm.applyEntry('task_started', { taskId, nodeId: 'node-a' });
  return sm.applyEntry('task_failed', { taskId, error, nodeId: 'node-a' });
}

// ── CI/CD DAG definition ──────────────────────────────────────────

const cicdDefinition = {
  name: 'ci-cd-pipeline',
  tasks: {
    lint: {
      type: 'shell' as const,
      spec: { command: 'npm run lint' },
    },
    test: {
      type: 'shell' as const,
      spec: { command: 'npm test' },
    },
    build: {
      type: 'shell' as const,
      spec: { command: 'npm run build' },
      dependsOn: ['lint', 'test'],
    },
    deploy: {
      type: 'shell' as const,
      spec: { command: 'kubectl apply -f deploy.yaml' },
      dependsOn: ['build'],
      condition: 'parent.build.exitCode === 0',
    },
  },
};

// ═══════════════════════════════════════════════════════════════════
// Test 1: Full DAG lifecycle (happy path)
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Full DAG lifecycle (happy path)', () => {
  it('executes lint + test -> build -> deploy in correct order', () => {
    // 1. Submit workflow
    const submitAction = sm.applyEntry('workflow_submit', {
      workflowId: 'wf-1',
      definition: cicdDefinition,
    } as WorkflowSubmitPayload);

    expect(submitAction).toEqual({ type: 'schedule' });

    // Verify workflow created
    const wf = getWorkflow('wf-1');
    expect(wf).toBeDefined();
    expect(wf!.state).toBe('running');
    expect(wf!.name).toBe('ci-cd-pipeline');

    // Verify 4 tasks created
    const allTasks = getAllTasks('wf-1');
    expect(allTasks).toHaveLength(4);

    // 2. Verify roots (lint, test) are queued; dependents (build, deploy) are pending
    const lint = getTaskByKey('wf-1', 'lint')!;
    const test = getTaskByKey('wf-1', 'test')!;
    const build = getTaskByKey('wf-1', 'build')!;
    const deploy = getTaskByKey('wf-1', 'deploy')!;

    expect(lint.state).toBe('queued');
    expect(test.state).toBe('queued');
    expect(build.state).toBe('pending');
    expect(deploy.state).toBe('pending');

    // 3. Complete lint -> workflow_advance -> build still pending (test not done)
    const lintCompleteAction = completeTask(lint.id);
    expect(lintCompleteAction).toEqual({
      type: 'workflow_advance',
      taskId: lint.id,
      workflowId: 'wf-1',
    });

    const advanceAfterLint = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-1',
      completedTaskKey: 'lint',
    });
    // build should NOT become queued yet (test still running)
    expect(getTaskByKey('wf-1', 'build')!.state).toBe('pending');
    expect(getTaskByKey('wf-1', 'deploy')!.state).toBe('pending');

    // 4. Complete test -> workflow_advance -> build becomes queued
    const testCompleteAction = completeTask(test.id);
    expect(testCompleteAction).toEqual({
      type: 'workflow_advance',
      taskId: test.id,
      workflowId: 'wf-1',
    });

    const advanceAfterTest = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-1',
      completedTaskKey: 'test',
    });
    expect(advanceAfterTest).toEqual({ type: 'schedule' });
    expect(getTaskByKey('wf-1', 'build')!.state).toBe('queued');
    expect(getTaskByKey('wf-1', 'deploy')!.state).toBe('pending');

    // 5. Complete build (exitCode=0) -> workflow_advance -> deploy becomes queued
    const buildTask = getTaskByKey('wf-1', 'build')!;
    const buildCompleteAction = completeTask(buildTask.id, { exitCode: 0, stdout: 'Build OK', stderr: '' });
    expect(buildCompleteAction).toEqual({
      type: 'workflow_advance',
      taskId: buildTask.id,
      workflowId: 'wf-1',
    });

    const advanceAfterBuild = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-1',
      completedTaskKey: 'build',
    });
    expect(advanceAfterBuild).toEqual({ type: 'schedule' });
    expect(getTaskByKey('wf-1', 'deploy')!.state).toBe('queued');

    // 6. Complete deploy -> workflow_advance -> workflow completed
    const deployTask = getTaskByKey('wf-1', 'deploy')!;
    const deployCompleteAction = completeTask(deployTask.id);
    expect(deployCompleteAction).toEqual({
      type: 'workflow_advance',
      taskId: deployTask.id,
      workflowId: 'wf-1',
    });

    sm.applyEntry('workflow_advance', {
      workflowId: 'wf-1',
      completedTaskKey: 'deploy',
    });

    // Verify workflow final state = completed
    const finalWf = getWorkflow('wf-1')!;
    expect(finalWf.state).toBe('completed');
    expect(finalWf.completed_at).toBeDefined();

    // All tasks completed
    const finalTasks = getAllTasks('wf-1');
    expect(finalTasks.every(t => t.state === 'completed')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 2: Condition-based skipping
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Condition-based skipping', () => {
  it('skips deploy when build fails (exitCode !== 0)', () => {
    // Submit same CI/CD DAG
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-skip',
      definition: cicdDefinition,
    });

    const lint = getTaskByKey('wf-skip', 'lint')!;
    const test = getTaskByKey('wf-skip', 'test')!;

    // Complete lint and test
    completeTask(lint.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-skip', completedTaskKey: 'lint' });

    completeTask(test.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-skip', completedTaskKey: 'test' });

    // Build is now queued
    const build = getTaskByKey('wf-skip', 'build')!;
    expect(build.state).toBe('queued');

    // Complete build with exitCode=1 (failure)
    completeTask(build.id, { exitCode: 1, stdout: '', stderr: 'Build error' });

    // workflow_advance should evaluate deploy's condition and skip it
    const advanceAction = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-skip',
      completedTaskKey: 'build',
    });

    // deploy should be skipped because condition `parent.build.exitCode === 0` is false
    const deploy = getTaskByKey('wf-skip', 'deploy')!;
    expect(deploy.state).toBe('skipped');

    // Workflow should be completed (all tasks terminal)
    // The build completed (state=completed even with exitCode=1, since we used task_complete not task_failed)
    // but deploy was skipped; no tasks are "failed" state, so workflow = completed
    const wf = getWorkflow('wf-skip')!;
    expect(wf.state).toBe('completed');
    expect(wf.completed_at).toBeDefined();
  });

  it('marks workflow as failed when a task is in failed state', () => {
    // Use a different DAG with non-retryable tasks
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-fail-cond',
      definition: {
        name: 'fail-pipeline',
        tasks: {
          lint: {
            type: 'shell' as const,
            spec: { command: 'lint' },
            retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1, retryable: false },
          },
          build: {
            type: 'shell' as const,
            spec: { command: 'build' },
            dependsOn: ['lint'],
          },
        },
      },
    });

    const lint = getTaskByKey('wf-fail-cond', 'lint')!;

    // Fail lint (non-retryable -> dead_letter)
    const failAction = failTask(lint.id, 'lint crash');
    expect(failAction!.type).toBe('dead_letter');

    // Apply dead_letter
    sm.applyEntry('task_dead_letter', { taskId: lint.id, reason: 'not retryable' });

    // The dead_letter doesn't trigger workflow_advance automatically,
    // but in a real system the leader would also produce a workflow_advance.
    // Simulate that:
    sm.applyEntry('workflow_advance', { workflowId: 'wf-fail-cond', completedTaskKey: 'lint' });

    // Build should be skipped (dep lint is dead_letter, not completed)
    const build = getTaskByKey('wf-fail-cond', 'build')!;
    expect(build.state).toBe('skipped');

    // Workflow should be failed (lint is dead_letter)
    const wf = getWorkflow('wf-fail-cond')!;
    expect(wf.state).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 3: Fan-out / fan-in
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Fan-out / fan-in', () => {
  it('fans out from setup to 3 workers, then fans in to aggregate', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-fan',
      definition: {
        name: 'fan-out-fan-in',
        tasks: {
          setup: {
            type: 'shell' as const,
            spec: { command: 'initialize' },
          },
          'worker-1': {
            type: 'shell' as const,
            spec: { command: 'process chunk 1' },
            dependsOn: ['setup'],
          },
          'worker-2': {
            type: 'shell' as const,
            spec: { command: 'process chunk 2' },
            dependsOn: ['setup'],
          },
          'worker-3': {
            type: 'shell' as const,
            spec: { command: 'process chunk 3' },
            dependsOn: ['setup'],
          },
          aggregate: {
            type: 'shell' as const,
            spec: { command: 'combine results' },
            dependsOn: ['worker-1', 'worker-2', 'worker-3'],
          },
        },
      },
    });

    // Verify initial states
    expect(getTaskByKey('wf-fan', 'setup')!.state).toBe('queued');
    expect(getTaskByKey('wf-fan', 'worker-1')!.state).toBe('pending');
    expect(getTaskByKey('wf-fan', 'worker-2')!.state).toBe('pending');
    expect(getTaskByKey('wf-fan', 'worker-3')!.state).toBe('pending');
    expect(getTaskByKey('wf-fan', 'aggregate')!.state).toBe('pending');

    // Complete setup -> all 3 workers become queued (fan-out)
    const setup = getTaskByKey('wf-fan', 'setup')!;
    completeTask(setup.id);
    const advanceAfterSetup = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-fan',
      completedTaskKey: 'setup',
    });
    expect(advanceAfterSetup).toEqual({ type: 'schedule' });

    expect(getTaskByKey('wf-fan', 'worker-1')!.state).toBe('queued');
    expect(getTaskByKey('wf-fan', 'worker-2')!.state).toBe('queued');
    expect(getTaskByKey('wf-fan', 'worker-3')!.state).toBe('queued');
    expect(getTaskByKey('wf-fan', 'aggregate')!.state).toBe('pending');

    // Complete worker-1 -> aggregate still pending (2 workers remain)
    const w1 = getTaskByKey('wf-fan', 'worker-1')!;
    completeTask(w1.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-fan', completedTaskKey: 'worker-1' });
    expect(getTaskByKey('wf-fan', 'aggregate')!.state).toBe('pending');

    // Complete worker-2 -> aggregate still pending (1 worker remains)
    const w2 = getTaskByKey('wf-fan', 'worker-2')!;
    completeTask(w2.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-fan', completedTaskKey: 'worker-2' });
    expect(getTaskByKey('wf-fan', 'aggregate')!.state).toBe('pending');

    // Complete worker-3 -> aggregate becomes queued (fan-in)
    const w3 = getTaskByKey('wf-fan', 'worker-3')!;
    completeTask(w3.id);
    const advanceAfterW3 = sm.applyEntry('workflow_advance', {
      workflowId: 'wf-fan',
      completedTaskKey: 'worker-3',
    });
    expect(advanceAfterW3).toEqual({ type: 'schedule' });
    expect(getTaskByKey('wf-fan', 'aggregate')!.state).toBe('queued');

    // Complete aggregate -> workflow completed
    const agg = getTaskByKey('wf-fan', 'aggregate')!;
    completeTask(agg.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-fan', completedTaskKey: 'aggregate' });

    const wf = getWorkflow('wf-fan')!;
    expect(wf.state).toBe('completed');
    expect(wf.completed_at).toBeDefined();

    // All 5 tasks completed
    const finalTasks = getAllTasks('wf-fan');
    expect(finalTasks).toHaveLength(5);
    expect(finalTasks.every(t => t.state === 'completed')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 4: Task failure with workflow state
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Task failure with workflow state', () => {
  it('workflow reaches failed state when a task is dead-lettered', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-dead',
      definition: {
        name: 'failure-pipeline',
        tasks: {
          init: {
            type: 'shell' as const,
            spec: { command: 'init' },
            retryPolicy: { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1, retryable: true },
          },
          process: {
            type: 'shell' as const,
            spec: { command: 'process' },
            dependsOn: ['init'],
          },
        },
      },
    });

    const init = getTaskByKey('wf-dead', 'init')!;
    expect(init.state).toBe('queued');

    // First failure -> retry
    sm.applyEntry('task_assign', { taskId: init.id, nodeId: 'node-a' });
    sm.applyEntry('task_started', { taskId: init.id, nodeId: 'node-a' });
    const failAction1 = sm.applyEntry('task_failed', {
      taskId: init.id,
      error: 'OOM',
      nodeId: 'node-a',
    });
    expect(failAction1!.type).toBe('retry');

    // Apply retry
    sm.applyEntry('task_retry', {
      taskId: init.id,
      attempt: failAction1!.attempt!,
      scheduledAfter: new Date(0).toISOString(),
    });

    // Second failure -> dead_letter (maxRetries=1, now at attempt=1)
    sm.applyEntry('task_assign', { taskId: init.id, nodeId: 'node-a' });
    sm.applyEntry('task_started', { taskId: init.id, nodeId: 'node-a' });
    const failAction2 = sm.applyEntry('task_failed', {
      taskId: init.id,
      error: 'OOM again',
      nodeId: 'node-a',
    });
    expect(failAction2!.type).toBe('dead_letter');

    // Apply dead_letter
    sm.applyEntry('task_dead_letter', { taskId: init.id, reason: 'Max retries exhausted' });

    // Workflow advance: process should be skipped (dep is dead_letter, not completed)
    sm.applyEntry('workflow_advance', { workflowId: 'wf-dead', completedTaskKey: 'init' });

    const process = getTaskByKey('wf-dead', 'process')!;
    expect(process.state).toBe('skipped');

    // Workflow should be failed
    const wf = getWorkflow('wf-dead')!;
    expect(wf.state).toBe('failed');
    expect(wf.completed_at).toBeDefined();
  });

  it('workflow reaches failed when task_failed leads to dead_letter mid-chain', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-mid-fail',
      definition: {
        name: 'mid-failure',
        tasks: {
          a: {
            type: 'shell' as const,
            spec: { command: 'a' },
          },
          b: {
            type: 'shell' as const,
            spec: { command: 'b' },
            dependsOn: ['a'],
            retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1, retryable: false },
          },
          c: {
            type: 'shell' as const,
            spec: { command: 'c' },
            dependsOn: ['b'],
          },
        },
      },
    });

    // Complete a
    const a = getTaskByKey('wf-mid-fail', 'a')!;
    completeTask(a.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-mid-fail', completedTaskKey: 'a' });
    expect(getTaskByKey('wf-mid-fail', 'b')!.state).toBe('queued');

    // Fail b (non-retryable -> dead_letter immediately)
    const b = getTaskByKey('wf-mid-fail', 'b')!;
    const bFailAction = failTask(b.id, 'segfault');
    expect(bFailAction!.type).toBe('dead_letter');
    sm.applyEntry('task_dead_letter', { taskId: b.id, reason: 'not retryable' });

    // Advance workflow
    sm.applyEntry('workflow_advance', { workflowId: 'wf-mid-fail', completedTaskKey: 'b' });

    // c should be skipped (dep b is dead_letter)
    expect(getTaskByKey('wf-mid-fail', 'c')!.state).toBe('skipped');

    // Workflow should be failed
    const wf = getWorkflow('wf-mid-fail')!;
    expect(wf.state).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 5: Workflow with complex conditions
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Complex condition evaluation', () => {
  it('evaluates condition based on parent stdout', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-cond-stdout',
      definition: {
        name: 'stdout-condition',
        tasks: {
          check: {
            type: 'shell' as const,
            spec: { command: 'echo deploy-ready' },
          },
          deploy: {
            type: 'shell' as const,
            spec: { command: 'deploy' },
            dependsOn: ['check'],
            condition: 'parent.check.stdout.includes("deploy-ready")',
          },
        },
      },
    });

    // Complete check with stdout containing "deploy-ready"
    const check = getTaskByKey('wf-cond-stdout', 'check')!;
    completeTask(check.id, { exitCode: 0, stdout: 'deploy-ready', stderr: '' });

    sm.applyEntry('workflow_advance', {
      workflowId: 'wf-cond-stdout',
      completedTaskKey: 'check',
    });

    // deploy should become queued (condition passes)
    expect(getTaskByKey('wf-cond-stdout', 'deploy')!.state).toBe('queued');
  });

  it('skips task when stdout condition fails', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-cond-fail-stdout',
      definition: {
        name: 'stdout-fail',
        tasks: {
          check: {
            type: 'shell' as const,
            spec: { command: 'echo not-ready' },
          },
          deploy: {
            type: 'shell' as const,
            spec: { command: 'deploy' },
            dependsOn: ['check'],
            condition: 'parent.check.stdout.includes("deploy-ready")',
          },
        },
      },
    });

    const check = getTaskByKey('wf-cond-fail-stdout', 'check')!;
    completeTask(check.id, { exitCode: 0, stdout: 'not-ready', stderr: '' });

    sm.applyEntry('workflow_advance', {
      workflowId: 'wf-cond-fail-stdout',
      completedTaskKey: 'check',
    });

    // deploy should be skipped
    expect(getTaskByKey('wf-cond-fail-stdout', 'deploy')!.state).toBe('skipped');

    // Workflow completes (all terminal)
    const wf = getWorkflow('wf-cond-fail-stdout')!;
    expect(wf.state).toBe('completed');
  });

  it('evaluates condition accessing workflow.context', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-ctx',
      definition: {
        name: 'context-condition',
        tasks: {
          setup: {
            type: 'shell' as const,
            spec: { command: 'setup' },
          },
          deploy_prod: {
            type: 'shell' as const,
            spec: { command: 'deploy --prod' },
            dependsOn: ['setup'],
            condition: 'workflow.context.env === "production"',
          },
        },
      },
    });

    // Set workflow context to production
    db.prepare("UPDATE te_workflows SET context = ? WHERE id = ?")
      .run(JSON.stringify({ env: 'production' }), 'wf-ctx');

    const setup = getTaskByKey('wf-ctx', 'setup')!;
    completeTask(setup.id);

    sm.applyEntry('workflow_advance', {
      workflowId: 'wf-ctx',
      completedTaskKey: 'setup',
    });

    // deploy_prod should be queued (context.env === "production")
    expect(getTaskByKey('wf-ctx', 'deploy_prod')!.state).toBe('queued');
  });

  it('skips task when workflow.context condition fails', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-ctx-skip',
      definition: {
        name: 'context-skip',
        tasks: {
          setup: {
            type: 'shell' as const,
            spec: { command: 'setup' },
          },
          deploy_prod: {
            type: 'shell' as const,
            spec: { command: 'deploy --prod' },
            dependsOn: ['setup'],
            condition: 'workflow.context.env === "production"',
          },
        },
      },
    });

    // Set workflow context to staging (NOT production)
    db.prepare("UPDATE te_workflows SET context = ? WHERE id = ?")
      .run(JSON.stringify({ env: 'staging' }), 'wf-ctx-skip');

    const setup = getTaskByKey('wf-ctx-skip', 'setup')!;
    completeTask(setup.id);

    sm.applyEntry('workflow_advance', {
      workflowId: 'wf-ctx-skip',
      completedTaskKey: 'setup',
    });

    // deploy_prod should be skipped
    expect(getTaskByKey('wf-ctx-skip', 'deploy_prod')!.state).toBe('skipped');
  });

  it('handles compound conditions with multiple parent references', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-compound',
      definition: {
        name: 'compound-conditions',
        tasks: {
          lint: {
            type: 'shell' as const,
            spec: { command: 'lint' },
          },
          test: {
            type: 'shell' as const,
            spec: { command: 'test' },
          },
          release: {
            type: 'shell' as const,
            spec: { command: 'release' },
            dependsOn: ['lint', 'test'],
            condition: 'parent.lint.exitCode === 0 && parent.test.exitCode === 0 && parent.test.stdout.includes("PASS")',
          },
        },
      },
    });

    const lint = getTaskByKey('wf-compound', 'lint')!;
    const test = getTaskByKey('wf-compound', 'test')!;

    completeTask(lint.id, { exitCode: 0, stdout: 'Clean', stderr: '' });
    sm.applyEntry('workflow_advance', { workflowId: 'wf-compound', completedTaskKey: 'lint' });

    completeTask(test.id, { exitCode: 0, stdout: 'All tests PASS', stderr: '' });
    sm.applyEntry('workflow_advance', { workflowId: 'wf-compound', completedTaskKey: 'test' });

    // release should be queued (both conditions pass)
    expect(getTaskByKey('wf-compound', 'release')!.state).toBe('queued');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test 6: Edge cases and cascading behavior
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Integration: Edge cases', () => {
  it('cascades skips through multiple layers', () => {
    // A -> B -> C -> D, if A fails then B, C, D should all be skipped
    // The state machine cascade does initial + one re-evaluation per workflow_advance call,
    // so deeper chains need additional workflow_advance calls (as the leader would produce).
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-cascade',
      definition: {
        name: 'cascade-skip',
        tasks: {
          a: {
            type: 'shell' as const,
            spec: { command: 'a' },
            retryPolicy: { maxRetries: 0, backoffMs: 0, backoffMultiplier: 1, retryable: false },
          },
          b: {
            type: 'shell' as const,
            spec: { command: 'b' },
            dependsOn: ['a'],
          },
          c: {
            type: 'shell' as const,
            spec: { command: 'c' },
            dependsOn: ['b'],
          },
          d: {
            type: 'shell' as const,
            spec: { command: 'd' },
            dependsOn: ['c'],
          },
        },
      },
    });

    // Fail a -> dead_letter
    const a = getTaskByKey('wf-cascade', 'a')!;
    const failAction = failTask(a.id, 'crash');
    expect(failAction!.type).toBe('dead_letter');
    sm.applyEntry('task_dead_letter', { taskId: a.id, reason: 'not retryable' });

    // First advance: cascades skips through b and c (initial pass + one cascade re-eval)
    sm.applyEntry('workflow_advance', { workflowId: 'wf-cascade', completedTaskKey: 'a' });

    expect(getTaskByKey('wf-cascade', 'b')!.state).toBe('skipped');
    expect(getTaskByKey('wf-cascade', 'c')!.state).toBe('skipped');
    // d is still pending after one cascade -- needs another advance
    expect(getTaskByKey('wf-cascade', 'd')!.state).toBe('pending');

    // Second advance: d's dep (c) is now terminal (skipped), so d gets skipped too
    sm.applyEntry('workflow_advance', { workflowId: 'wf-cascade', completedTaskKey: 'c' });
    expect(getTaskByKey('wf-cascade', 'd')!.state).toBe('skipped');

    // Workflow failed (a is dead_letter)
    const wf = getWorkflow('wf-cascade')!;
    expect(wf.state).toBe('failed');
  });

  it('handles single-task workflow', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-single',
      definition: {
        name: 'single-task',
        tasks: {
          only: {
            type: 'shell' as const,
            spec: { command: 'echo done' },
          },
        },
      },
    });

    const only = getTaskByKey('wf-single', 'only')!;
    expect(only.state).toBe('queued');

    completeTask(only.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-single', completedTaskKey: 'only' });

    const wf = getWorkflow('wf-single')!;
    expect(wf.state).toBe('completed');
  });

  it('diamond dependency pattern resolves correctly', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-diamond',
      definition: {
        name: 'diamond',
        tasks: {
          a: { type: 'shell' as const, spec: { command: 'a' } },
          b: { type: 'shell' as const, spec: { command: 'b' }, dependsOn: ['a'] },
          c: { type: 'shell' as const, spec: { command: 'c' }, dependsOn: ['a'] },
          d: { type: 'shell' as const, spec: { command: 'd' }, dependsOn: ['b', 'c'] },
        },
      },
    });

    expect(getTaskByKey('wf-diamond', 'a')!.state).toBe('queued');
    expect(getTaskByKey('wf-diamond', 'b')!.state).toBe('pending');
    expect(getTaskByKey('wf-diamond', 'c')!.state).toBe('pending');
    expect(getTaskByKey('wf-diamond', 'd')!.state).toBe('pending');

    // Complete a -> b and c become queued
    const a = getTaskByKey('wf-diamond', 'a')!;
    completeTask(a.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-diamond', completedTaskKey: 'a' });

    expect(getTaskByKey('wf-diamond', 'b')!.state).toBe('queued');
    expect(getTaskByKey('wf-diamond', 'c')!.state).toBe('queued');
    expect(getTaskByKey('wf-diamond', 'd')!.state).toBe('pending');

    // Complete b but not c -> d still pending
    const b = getTaskByKey('wf-diamond', 'b')!;
    completeTask(b.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-diamond', completedTaskKey: 'b' });
    expect(getTaskByKey('wf-diamond', 'd')!.state).toBe('pending');

    // Complete c -> d becomes queued
    const c = getTaskByKey('wf-diamond', 'c')!;
    completeTask(c.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-diamond', completedTaskKey: 'c' });
    expect(getTaskByKey('wf-diamond', 'd')!.state).toBe('queued');

    // Complete d -> workflow completed
    const d = getTaskByKey('wf-diamond', 'd')!;
    completeTask(d.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-diamond', completedTaskKey: 'd' });

    const wf = getWorkflow('wf-diamond')!;
    expect(wf.state).toBe('completed');
  });

  it('tracks task events throughout the workflow lifecycle', () => {
    sm.applyEntry('workflow_submit', {
      workflowId: 'wf-events',
      definition: {
        name: 'event-tracking',
        tasks: {
          step1: { type: 'shell' as const, spec: { command: 'step1' } },
          step2: { type: 'shell' as const, spec: { command: 'step2' }, dependsOn: ['step1'] },
        },
      },
    });

    const step1 = getTaskByKey('wf-events', 'step1')!;
    completeTask(step1.id);
    sm.applyEntry('workflow_advance', { workflowId: 'wf-events', completedTaskKey: 'step1' });

    // Verify step1 has full event lifecycle
    const step1Events = sm.getTaskEvents(step1.id);
    const eventTypes = step1Events.map(e => e.event_type);
    expect(eventTypes).toContain('submitted');
    expect(eventTypes).toContain('assigned');
    expect(eventTypes).toContain('started');
    expect(eventTypes).toContain('completed');

    // Verify step2 was submitted when workflow was created, then re-submitted when advanced
    const step2 = getTaskByKey('wf-events', 'step2')!;
    const step2Events = sm.getTaskEvents(step2.id);
    expect(step2Events.some(e => e.event_type === 'submitted')).toBe(true);
  });
});
