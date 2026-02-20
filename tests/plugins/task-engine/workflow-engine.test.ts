import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { TaskStateMachine } from '../../../src/plugins/task-engine/state-machine.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type {
  WorkflowSubmitPayload,
  WorkflowAdvancePayload,
  WorkflowDefinition,
  TaskRecord,
  WorkflowRecord,
} from '../../../src/plugins/task-engine/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'warn' })],
});

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

/** Helper: look up a workflow task by its task_key */
function getTaskByKey(db: Database.Database, workflowId: string, taskKey: string): TaskRecord | undefined {
  return db
    .prepare('SELECT * FROM te_tasks WHERE workflow_id = ? AND task_key = ?')
    .get(workflowId, taskKey) as TaskRecord | undefined;
}

/** Helper: complete a workflow task through the full lifecycle (assign -> start -> complete) */
function completeTask(
  sm: TaskStateMachine,
  taskId: string,
  result: { exitCode: number; stdout: string; stderr: string } = { exitCode: 0, stdout: '', stderr: '' },
) {
  sm.applyEntry('task_assign', { taskId, nodeId: 'worker-1' });
  sm.applyEntry('task_started', { taskId, nodeId: 'worker-1' });
  return sm.applyEntry('task_complete', { taskId, result });
}

/** Helper: dead-letter a task (fail with non-retryable policy) */
function deadLetterTask(sm: TaskStateMachine, taskId: string) {
  sm.applyEntry('task_assign', { taskId, nodeId: 'worker-1' });
  sm.applyEntry('task_started', { taskId, nodeId: 'worker-1' });
  const action = sm.applyEntry('task_failed', { taskId, error: 'fatal', nodeId: 'worker-1' });
  if (action?.type === 'dead_letter') {
    sm.applyEntry('task_dead_letter', { taskId, reason: action.reason ?? 'fatal' });
  } else if (action?.type === 'retry') {
    // Exhaust retries
    sm.applyEntry('task_retry', { taskId, attempt: action.attempt!, scheduledAfter: new Date(0).toISOString() });
    return deadLetterTask(sm, taskId);
  }
}

describe('Workflow Engine', () => {
  let db: Database.Database;
  let sm: TaskStateMachine;

  beforeEach(() => {
    db = createTestDb();
    sm = new TaskStateMachine(db, 'test-node', logger);
  });

  // ── 1. Linear chain (A -> B -> C) ──────────────────────────────

  describe('linear chain (A -> B -> C)', () => {
    const workflowId = 'wf-linear';
    const definition: WorkflowDefinition = {
      name: 'linear-chain',
      tasks: {
        A: { type: 'shell', spec: { command: 'echo A' } },
        B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
        C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['B'] },
      },
    };

    it('submits workflow with root task A queued, B and C pending', () => {
      const action = sm.applyEntry('workflow_submit', { workflowId, definition } as WorkflowSubmitPayload);

      expect(action).toEqual({ type: 'schedule' });

      const taskA = getTaskByKey(db, workflowId, 'A')!;
      const taskB = getTaskByKey(db, workflowId, 'B')!;
      const taskC = getTaskByKey(db, workflowId, 'C')!;

      expect(taskA.state).toBe('queued');
      expect(taskB.state).toBe('pending');
      expect(taskC.state).toBe('pending');

      // Verify workflow record
      const wf = sm.getWorkflow(workflowId)!;
      expect(wf.name).toBe('linear-chain');
      expect(wf.state).toBe('running');
    });

    it('advances B to queued after A completes', () => {
      sm.applyEntry('workflow_submit', { workflowId, definition });

      const taskA = getTaskByKey(db, workflowId, 'A')!;
      const completeAction = completeTask(sm, taskA.id);
      expect(completeAction).toEqual({
        type: 'workflow_advance',
        taskId: taskA.id,
        workflowId,
      });

      // Now advance the workflow
      const advanceAction = sm.applyEntry('workflow_advance', {
        workflowId,
        completedTaskKey: 'A',
      } as WorkflowAdvancePayload);

      expect(advanceAction).toEqual({ type: 'schedule' });

      const taskB = getTaskByKey(db, workflowId, 'B')!;
      const taskC = getTaskByKey(db, workflowId, 'C')!;
      expect(taskB.state).toBe('queued');
      expect(taskC.state).toBe('pending');
    });

    it('completes the full chain A -> B -> C and marks workflow completed', () => {
      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A
      const taskA = getTaskByKey(db, workflowId, 'A')!;
      completeTask(sm, taskA.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      // Complete B
      const taskB = getTaskByKey(db, workflowId, 'B')!;
      completeTask(sm, taskB.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'B' });

      // Complete C
      const taskC = getTaskByKey(db, workflowId, 'C')!;
      completeTask(sm, taskC.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'C' });

      // Verify all tasks completed
      expect(getTaskByKey(db, workflowId, 'A')!.state).toBe('completed');
      expect(getTaskByKey(db, workflowId, 'B')!.state).toBe('completed');
      expect(getTaskByKey(db, workflowId, 'C')!.state).toBe('completed');

      // Verify workflow completed
      const wf = sm.getWorkflow(workflowId)!;
      expect(wf.state).toBe('completed');
      expect(wf.completed_at).toBeDefined();
    });
  });

  // ── 2. Fan-out (A -> [B, C]) ──────────────────────────────────

  describe('fan-out (A -> [B, C])', () => {
    const workflowId = 'wf-fanout';
    const definition: WorkflowDefinition = {
      name: 'fan-out',
      tasks: {
        A: { type: 'shell', spec: { command: 'echo A' } },
        B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
        C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['A'] },
      },
    };

    it('queues both B and C simultaneously after A completes', () => {
      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A
      const taskA = getTaskByKey(db, workflowId, 'A')!;
      completeTask(sm, taskA.id);

      const action = sm.applyEntry('workflow_advance', {
        workflowId,
        completedTaskKey: 'A',
      });

      expect(action).toEqual({ type: 'schedule' });

      const taskB = getTaskByKey(db, workflowId, 'B')!;
      const taskC = getTaskByKey(db, workflowId, 'C')!;
      expect(taskB.state).toBe('queued');
      expect(taskC.state).toBe('queued');
    });
  });

  // ── 3. Fan-in ([B, C] -> D) ──────────────────────────────────

  describe('fan-in ([B, C] -> D)', () => {
    const workflowId = 'wf-fanin';
    const definition: WorkflowDefinition = {
      name: 'fan-in',
      tasks: {
        A: { type: 'shell', spec: { command: 'echo A' } },
        B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
        C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['A'] },
        D: { type: 'shell', spec: { command: 'echo D' }, dependsOn: ['B', 'C'] },
      },
    };

    it('keeps D pending until both B and C complete', () => {
      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A -> B and C become queued
      const taskA = getTaskByKey(db, workflowId, 'A')!;
      completeTask(sm, taskA.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      // Complete B only
      const taskB = getTaskByKey(db, workflowId, 'B')!;
      completeTask(sm, taskB.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'B' });

      // D should still be pending (C not done yet)
      expect(getTaskByKey(db, workflowId, 'D')!.state).toBe('pending');

      // Complete C
      const taskC = getTaskByKey(db, workflowId, 'C')!;
      completeTask(sm, taskC.id);
      const action = sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'C' });

      // Now D should be queued
      expect(action).toEqual({ type: 'schedule' });
      expect(getTaskByKey(db, workflowId, 'D')!.state).toBe('queued');
    });

    it('completes the full fan-in workflow', () => {
      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A
      completeTask(sm, getTaskByKey(db, workflowId, 'A')!.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      // Complete B and C
      completeTask(sm, getTaskByKey(db, workflowId, 'B')!.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'B' });
      completeTask(sm, getTaskByKey(db, workflowId, 'C')!.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'C' });

      // Complete D
      completeTask(sm, getTaskByKey(db, workflowId, 'D')!.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'D' });

      const wf = sm.getWorkflow(workflowId)!;
      expect(wf.state).toBe('completed');
    });
  });

  // ── 4. Conditional branch ───────────────────────────────────────

  describe('conditional branch', () => {
    const workflowId = 'wf-cond';

    it('queues B and skips C when A exits with code 0', () => {
      const definition: WorkflowDefinition = {
        name: 'conditional',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: {
            type: 'shell',
            spec: { command: 'echo B' },
            dependsOn: ['A'],
            condition: 'parent.A.exitCode === 0',
          },
          C: {
            type: 'shell',
            spec: { command: 'echo C' },
            dependsOn: ['A'],
            condition: 'parent.A.exitCode !== 0',
          },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A with exitCode=0
      const taskA = getTaskByKey(db, workflowId, 'A')!;
      completeTask(sm, taskA.id, { exitCode: 0, stdout: 'success', stderr: '' });

      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      const taskB = getTaskByKey(db, workflowId, 'B')!;
      const taskC = getTaskByKey(db, workflowId, 'C')!;
      expect(taskB.state).toBe('queued');
      expect(taskC.state).toBe('skipped');
    });

    it('queues C and skips B when A exits with non-zero code', () => {
      const wfId = 'wf-cond-2';
      const definition: WorkflowDefinition = {
        name: 'conditional-fail',
        tasks: {
          A: { type: 'shell', spec: { command: 'false' } },
          B: {
            type: 'shell',
            spec: { command: 'echo B' },
            dependsOn: ['A'],
            condition: 'parent.A.exitCode === 0',
          },
          C: {
            type: 'shell',
            spec: { command: 'echo C' },
            dependsOn: ['A'],
            condition: 'parent.A.exitCode !== 0',
          },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId: wfId, definition });

      // Complete A with exitCode=1
      const taskA = getTaskByKey(db, wfId, 'A')!;
      completeTask(sm, taskA.id, { exitCode: 1, stdout: '', stderr: 'error' });

      sm.applyEntry('workflow_advance', { workflowId: wfId, completedTaskKey: 'A' });

      const taskB = getTaskByKey(db, wfId, 'B')!;
      const taskC = getTaskByKey(db, wfId, 'C')!;
      expect(taskB.state).toBe('skipped');
      expect(taskC.state).toBe('queued');
    });
  });

  // ── 5. Workflow failure detection ──────────────────────────────

  describe('workflow failure detection', () => {
    const workflowId = 'wf-fail';

    it('marks workflow as failed when a task is dead-lettered and no progress possible', () => {
      const definition: WorkflowDefinition = {
        name: 'will-fail',
        tasks: {
          A: {
            type: 'shell',
            spec: { command: 'echo A' },
            retryPolicy: { maxRetries: 0, backoffMs: 100, backoffMultiplier: 1, retryable: false },
          },
          B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Fail task A (non-retryable -> immediate dead letter)
      const taskA = getTaskByKey(db, workflowId, 'A')!;
      sm.applyEntry('task_assign', { taskId: taskA.id, nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: taskA.id, nodeId: 'worker-1' });
      const failAction = sm.applyEntry('task_failed', {
        taskId: taskA.id,
        error: 'fatal error',
        nodeId: 'worker-1',
      });

      expect(failAction?.type).toBe('dead_letter');
      sm.applyEntry('task_dead_letter', { taskId: taskA.id, reason: failAction!.reason! });

      // Advance workflow -- B should be skipped (dep failed), workflow should be failed
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      const taskB = getTaskByKey(db, workflowId, 'B')!;
      expect(taskB.state).toBe('skipped');

      const wf = sm.getWorkflow(workflowId)!;
      expect(wf.state).toBe('failed');
      expect(wf.completed_at).toBeDefined();
    });
  });

  // ── 6. JS condition with string matching ──────────────────────

  describe('JS condition with string matching', () => {
    const workflowId = 'wf-string';

    it('evaluates conditions that check stdout content', () => {
      const definition: WorkflowDefinition = {
        name: 'string-match',
        tasks: {
          check: { type: 'shell', spec: { command: 'echo "version: 2.0"' } },
          upgrade: {
            type: 'shell',
            spec: { command: 'upgrade.sh' },
            dependsOn: ['check'],
            condition: 'parent.check.stdout.includes("version: 1.")',
          },
          skip_upgrade: {
            type: 'shell',
            spec: { command: 'echo "already up to date"' },
            dependsOn: ['check'],
            condition: '!parent.check.stdout.includes("version: 1.")',
          },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete check with stdout containing version 2.0
      const checkTask = getTaskByKey(db, workflowId, 'check')!;
      completeTask(sm, checkTask.id, {
        exitCode: 0,
        stdout: 'version: 2.0',
        stderr: '',
      });

      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'check' });

      // upgrade should be skipped (stdout doesn't contain "version: 1.")
      // skip_upgrade should be queued
      expect(getTaskByKey(db, workflowId, 'upgrade')!.state).toBe('skipped');
      expect(getTaskByKey(db, workflowId, 'skip_upgrade')!.state).toBe('queued');
    });

    it('queues upgrade when stdout contains version 1.x', () => {
      const wfId = 'wf-string-2';
      const definition: WorkflowDefinition = {
        name: 'string-match-v1',
        tasks: {
          check: { type: 'shell', spec: { command: 'echo "version: 1.5"' } },
          upgrade: {
            type: 'shell',
            spec: { command: 'upgrade.sh' },
            dependsOn: ['check'],
            condition: 'parent.check.stdout.includes("version: 1.")',
          },
          skip_upgrade: {
            type: 'shell',
            spec: { command: 'echo "already up to date"' },
            dependsOn: ['check'],
            condition: '!parent.check.stdout.includes("version: 1.")',
          },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId: wfId, definition });

      const checkTask = getTaskByKey(db, wfId, 'check')!;
      completeTask(sm, checkTask.id, {
        exitCode: 0,
        stdout: 'version: 1.5',
        stderr: '',
      });

      sm.applyEntry('workflow_advance', { workflowId: wfId, completedTaskKey: 'check' });

      expect(getTaskByKey(db, wfId, 'upgrade')!.state).toBe('queued');
      expect(getTaskByKey(db, wfId, 'skip_upgrade')!.state).toBe('skipped');
    });
  });

  // ── 7. Workflow submit creates proper dependencies ──────────────

  describe('workflow dependencies', () => {
    it('stores dependency records in te_task_dependencies', () => {
      const workflowId = 'wf-deps';
      const definition: WorkflowDefinition = {
        name: 'deps-test',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
          C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['A', 'B'] },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      const deps = db
        .prepare('SELECT * FROM te_task_dependencies WHERE workflow_id = ? ORDER BY task_key, depends_on_key')
        .all(workflowId) as Array<{ task_key: string; depends_on_key: string; condition: string | null }>;

      expect(deps).toHaveLength(3);
      expect(deps[0]).toMatchObject({ task_key: 'B', depends_on_key: 'A' });
      expect(deps[1]).toMatchObject({ task_key: 'C', depends_on_key: 'A' });
      expect(deps[2]).toMatchObject({ task_key: 'C', depends_on_key: 'B' });
    });

    it('stores conditions on dependency edges', () => {
      const workflowId = 'wf-cond-deps';
      const definition: WorkflowDefinition = {
        name: 'cond-deps-test',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: {
            type: 'shell',
            spec: { command: 'echo B' },
            dependsOn: ['A'],
            condition: 'parent.A.exitCode === 0',
          },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      const deps = db
        .prepare('SELECT * FROM te_task_dependencies WHERE workflow_id = ?')
        .all(workflowId) as Array<{ task_key: string; depends_on_key: string; condition: string | null }>;

      expect(deps).toHaveLength(1);
      expect(deps[0].condition).toBe('parent.A.exitCode === 0');
    });
  });

  // ── 8. Task priorities are preserved in workflows ──────────────

  describe('task priorities in workflows', () => {
    it('preserves priority from workflow task definitions', () => {
      const workflowId = 'wf-priority';
      const definition: WorkflowDefinition = {
        name: 'priority-test',
        tasks: {
          low: { type: 'shell', spec: { command: 'echo low' }, priority: 1 },
          high: { type: 'shell', spec: { command: 'echo high' }, priority: 10 },
          default: { type: 'shell', spec: { command: 'echo default' } },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      expect(getTaskByKey(db, workflowId, 'low')!.priority).toBe(1);
      expect(getTaskByKey(db, workflowId, 'high')!.priority).toBe(10);
      expect(getTaskByKey(db, workflowId, 'default')!.priority).toBe(0);
    });
  });

  // ── 9. Multiple root tasks ─────────────────────────────────────

  describe('multiple root tasks', () => {
    it('queues all root tasks on submit', () => {
      const workflowId = 'wf-multi-root';
      const definition: WorkflowDefinition = {
        name: 'multi-root',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: { type: 'shell', spec: { command: 'echo B' } },
          C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['A', 'B'] },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      expect(getTaskByKey(db, workflowId, 'A')!.state).toBe('queued');
      expect(getTaskByKey(db, workflowId, 'B')!.state).toBe('queued');
      expect(getTaskByKey(db, workflowId, 'C')!.state).toBe('pending');
    });
  });

  // ── 10. Workflow advance returns null when nothing to do ───────

  describe('workflow advance with nothing to do', () => {
    it('returns null when no tasks become ready', () => {
      const workflowId = 'wf-noop';
      const definition: WorkflowDefinition = {
        name: 'noop',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
          C: { type: 'shell', spec: { command: 'echo C' }, dependsOn: ['A'] },
          D: { type: 'shell', spec: { command: 'echo D' }, dependsOn: ['B', 'C'] },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      // Complete A -> B and C become queued
      completeTask(sm, getTaskByKey(db, workflowId, 'A')!.id);
      sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'A' });

      // Complete B but not C -> D stays pending, advance returns null
      completeTask(sm, getTaskByKey(db, workflowId, 'B')!.id);
      const action = sm.applyEntry('workflow_advance', { workflowId, completedTaskKey: 'B' });

      expect(action).toBeNull();
      expect(getTaskByKey(db, workflowId, 'D')!.state).toBe('pending');
    });
  });

  // ── 11. getWorkflowTasks helper ────────────────────────────────

  describe('getWorkflowTasks', () => {
    it('returns all tasks for a workflow', () => {
      const workflowId = 'wf-list';
      const definition: WorkflowDefinition = {
        name: 'list-test',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo A' } },
          B: { type: 'shell', spec: { command: 'echo B' }, dependsOn: ['A'] },
        },
      };

      sm.applyEntry('workflow_submit', { workflowId, definition });

      const tasks = sm.getWorkflowTasks(workflowId);
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.task_key).sort()).toEqual(['A', 'B']);
    });
  });

  // ── 12. Existing state machine tests still pass with workflow stubs removed ──

  describe('backward compatibility', () => {
    it('workflow_submit no longer returns null (stubs replaced)', () => {
      const definition: WorkflowDefinition = {
        name: 'test',
        tasks: {
          A: { type: 'shell', spec: { command: 'echo hello' } },
        },
      };

      const action = sm.applyEntry('workflow_submit', {
        workflowId: 'wf-compat',
        definition,
      });

      // Should now return a schedule action instead of null
      expect(action).toEqual({ type: 'schedule' });
    });
  });
});
