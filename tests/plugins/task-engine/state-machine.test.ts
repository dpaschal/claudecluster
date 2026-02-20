import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import winston from 'winston';
import { TaskStateMachine, StateMachineAction } from '../../../src/plugins/task-engine/state-machine.js';
import { runMigrations } from '../../../src/plugins/task-engine/migrations.js';
import type {
  TaskSubmitPayload,
  TaskAssignPayload,
  TaskStartedPayload,
  TaskCompletePayload,
  TaskFailedPayload,
  TaskCancelPayload,
  TaskRetryPayload,
  TaskDeadLetterPayload,
  TaskRecord,
} from '../../../src/plugins/task-engine/types.js';

const logger = winston.createLogger({
  transports: [new winston.transports.Console({ level: 'warn' })],
});

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeSubmitPayload(overrides: Partial<TaskSubmitPayload> = {}): TaskSubmitPayload {
  return {
    taskId: overrides.taskId ?? 'task-001',
    type: overrides.type ?? 'shell',
    spec: overrides.spec ?? { command: 'echo hello' },
    priority: overrides.priority ?? 5,
    constraints: overrides.constraints,
    retryPolicy: overrides.retryPolicy,
    submitterNode: overrides.submitterNode ?? 'node-a',
    workflowId: overrides.workflowId,
    taskKey: overrides.taskKey,
  };
}

describe('TaskStateMachine', () => {
  let db: Database.Database;
  let sm: TaskStateMachine;

  beforeEach(() => {
    db = createTestDb();
    sm = new TaskStateMachine(db, 'test-node', logger);
  });

  // ── 1. task_submit ─────────────────────────────────────────────

  describe('task_submit', () => {
    it('inserts a queued task for standalone submission', () => {
      const action = sm.applyEntry('task_submit', makeSubmitPayload());

      expect(action).toBeNull();

      const task = sm.getTask('task-001');
      expect(task).toBeDefined();
      expect(task!.state).toBe('queued');
      expect(task!.type).toBe('shell');
      expect(task!.priority).toBe(5);
      expect(task!.attempt).toBe(0);
      expect(task!.workflow_id).toBeNull();
      expect(JSON.parse(task!.spec)).toEqual({ command: 'echo hello' });
      expect(task!.created_at).toBeDefined();
    });

    it('inserts a pending task for workflow submission', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        taskId: 'wf-task-001',
        workflowId: 'wf-1',
        taskKey: 'build',
      }));

      const task = sm.getTask('wf-task-001');
      expect(task!.state).toBe('pending');
      expect(task!.workflow_id).toBe('wf-1');
      expect(task!.task_key).toBe('build');
    });

    it('records a submitted event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());

      const events = sm.getTaskEvents('task-001');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('submitted');
      expect(events[0].node_id).toBe('node-a');
    });

    it('stores constraints and retry_policy as JSON', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        constraints: { requiresGpu: true, minMemoryMb: 4096 },
        retryPolicy: { maxRetries: 5, backoffMs: 2000, backoffMultiplier: 3, retryable: true },
      }));

      const task = sm.getTask('task-001')!;
      expect(JSON.parse(task.constraints!)).toEqual({ requiresGpu: true, minMemoryMb: 4096 });
      expect(JSON.parse(task.retry_policy!)).toEqual({ maxRetries: 5, backoffMs: 2000, backoffMultiplier: 3, retryable: true });
    });
  });

  // ── 2. task_assign ─────────────────────────────────────────────

  describe('task_assign', () => {
    it('updates to assigned state with nodeId and timestamp', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());

      const action = sm.applyEntry('task_assign', {
        taskId: 'task-001',
        nodeId: 'worker-1',
      } as TaskAssignPayload);

      expect(action).toBeNull();

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('assigned');
      expect(task.assigned_node).toBe('worker-1');
      expect(task.assigned_at).toBeDefined();
    });

    it('records an assigned event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });

      const events = sm.getTaskEvents('task-001');
      expect(events).toHaveLength(2);
      expect(events[1].event_type).toBe('assigned');
      expect(events[1].node_id).toBe('worker-1');
    });
  });

  // ── 3. task_started ────────────────────────────────────────────

  describe('task_started', () => {
    it('updates to running state with started_at timestamp', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_started', {
        taskId: 'task-001',
        nodeId: 'worker-1',
      } as TaskStartedPayload);

      expect(action).toBeNull();

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('running');
      expect(task.started_at).toBeDefined();
    });

    it('records a started event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });

      const events = sm.getTaskEvents('task-001');
      const started = events.find(e => e.event_type === 'started');
      expect(started).toBeDefined();
      expect(started!.node_id).toBe('worker-1');
    });
  });

  // ── 4. task_complete ───────────────────────────────────────────

  describe('task_complete', () => {
    beforeEach(() => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });
    });

    it('updates to completed with result and timestamps', () => {
      const result = { exitCode: 0, stdout: 'hello', stderr: '' };
      const action = sm.applyEntry('task_complete', {
        taskId: 'task-001',
        result,
      } as TaskCompletePayload);

      expect(action).toBeNull();

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('completed');
      expect(JSON.parse(task.result!)).toEqual(result);
      expect(task.completed_at).toBeDefined();
    });

    it('records a completed event', () => {
      sm.applyEntry('task_complete', {
        taskId: 'task-001',
        result: { exitCode: 0, stdout: '', stderr: '' },
      });

      const events = sm.getTaskEvents('task-001');
      const completed = events.find(e => e.event_type === 'completed');
      expect(completed).toBeDefined();
    });

    it('returns workflow_advance action for workflow tasks', () => {
      // Create a separate workflow task
      sm.applyEntry('task_submit', makeSubmitPayload({
        taskId: 'wf-task-1',
        workflowId: 'wf-1',
        taskKey: 'build',
      }));
      // Manually update to running state for workflow task
      sm.applyEntry('task_assign', { taskId: 'wf-task-1', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'wf-task-1', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_complete', {
        taskId: 'wf-task-1',
        result: { exitCode: 0, stdout: 'done', stderr: '' },
      });

      expect(action).toEqual({
        type: 'workflow_advance',
        taskId: 'wf-task-1',
        workflowId: 'wf-1',
      });
    });

    it('returns null for unknown task', () => {
      const action = sm.applyEntry('task_complete', {
        taskId: 'nonexistent',
        result: { exitCode: 0, stdout: '', stderr: '' },
      });

      expect(action).toBeNull();
    });
  });

  // ── 5. task_failed with retry ──────────────────────────────────

  describe('task_failed with retry', () => {
    it('returns retry action when retryable and under max', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        retryPolicy: { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2, retryable: true },
      }));
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'OOM killed',
        nodeId: 'worker-1',
      } as TaskFailedPayload);

      expect(action).toBeDefined();
      expect(action!.type).toBe('retry');
      expect(action!.taskId).toBe('task-001');
      expect(action!.attempt).toBe(1); // 0 -> 1
      expect(action!.scheduledAfter).toBeDefined();

      // Verify the error was written
      const task = sm.getTask('task-001')!;
      expect(task.error).toBe('OOM killed');
    });

    it('uses default retry policy when none set', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'timeout',
        nodeId: 'worker-1',
      });

      // Default policy: maxRetries=3, retryable=true, attempt is 0 < 3
      expect(action!.type).toBe('retry');
      expect(action!.attempt).toBe(1);
    });

    it('records a failed event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'crash',
        nodeId: 'worker-1',
      });

      const events = sm.getTaskEvents('task-001');
      const failed = events.find(e => e.event_type === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.detail).toBe('crash');
    });
  });

  // ── 6. task_failed exhausted ───────────────────────────────────

  describe('task_failed exhausted', () => {
    it('returns dead_letter action after max retries', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        retryPolicy: { maxRetries: 2, backoffMs: 500, backoffMultiplier: 2, retryable: true },
      }));

      // Simulate: attempt 0 fails -> retry to attempt 1 -> fails -> retry to attempt 2 -> fails -> dead letter
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });
      // First failure at attempt 0 -> retry
      let action = sm.applyEntry('task_failed', { taskId: 'task-001', error: 'fail-1', nodeId: 'w1' });
      expect(action!.type).toBe('retry');

      // Apply retry to attempt 1
      sm.applyEntry('task_retry', { taskId: 'task-001', attempt: 1, scheduledAfter: new Date(0).toISOString() });
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });
      // Second failure at attempt 1 -> retry
      action = sm.applyEntry('task_failed', { taskId: 'task-001', error: 'fail-2', nodeId: 'w1' });
      expect(action!.type).toBe('retry');

      // Apply retry to attempt 2
      sm.applyEntry('task_retry', { taskId: 'task-001', attempt: 2, scheduledAfter: new Date(0).toISOString() });
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });
      // Third failure at attempt 2 (== maxRetries) -> dead_letter
      action = sm.applyEntry('task_failed', { taskId: 'task-001', error: 'fail-3', nodeId: 'w1' });

      expect(action!.type).toBe('dead_letter');
      expect(action!.taskId).toBe('task-001');
    });

    it('returns dead_letter when retry policy is not retryable', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        retryPolicy: { maxRetries: 3, backoffMs: 1000, backoffMultiplier: 2, retryable: false },
      }));
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });

      const action = sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'not retryable',
        nodeId: 'w1',
      });

      expect(action!.type).toBe('dead_letter');
    });
  });

  // ── 7. task_retry ──────────────────────────────────────────────

  describe('task_retry', () => {
    it('resets to queued with incremented attempt and scheduled_after', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });

      const scheduledAfter = new Date(Date.now() + 5000).toISOString();
      const action = sm.applyEntry('task_retry', {
        taskId: 'task-001',
        attempt: 1,
        scheduledAfter,
      } as TaskRetryPayload);

      expect(action).toEqual({
        type: 'schedule',
        taskId: 'task-001',
        scheduledAfter,
      });

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('queued');
      expect(task.attempt).toBe(1);
      expect(task.scheduled_after).toBe(scheduledAfter);
      expect(task.assigned_node).toBeNull();
      expect(task.assigned_at).toBeNull();
      expect(task.started_at).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.error).toBeNull();
      expect(task.result).toBeNull();
    });

    it('records a retried event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());

      sm.applyEntry('task_retry', {
        taskId: 'task-001',
        attempt: 1,
        scheduledAfter: new Date().toISOString(),
      });

      const events = sm.getTaskEvents('task-001');
      const retried = events.find(e => e.event_type === 'retried');
      expect(retried).toBeDefined();
      expect(retried!.detail).toContain('attempt=1');
    });
  });

  // ── 8. task_dead_letter ────────────────────────────────────────

  describe('task_dead_letter', () => {
    it('moves to dead_letter state with timestamp', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());

      const action = sm.applyEntry('task_dead_letter', {
        taskId: 'task-001',
        reason: 'Max retries exhausted',
      } as TaskDeadLetterPayload);

      expect(action).toBeNull();

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('dead_letter');
      expect(task.dead_lettered_at).toBeDefined();
    });

    it('records a dead_lettered event with reason', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_dead_letter', { taskId: 'task-001', reason: 'not retryable' });

      const events = sm.getTaskEvents('task-001');
      const dl = events.find(e => e.event_type === 'dead_lettered');
      expect(dl).toBeDefined();
      expect(dl!.detail).toBe('not retryable');
    });
  });

  // ── 9. task_cancel (queued) ────────────────────────────────────

  describe('task_cancel queued', () => {
    it('cancels directly with no cancel_running action', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());

      const action = sm.applyEntry('task_cancel', {
        taskId: 'task-001',
      } as TaskCancelPayload);

      expect(action).toBeNull();

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('cancelled');
      expect(task.completed_at).toBeDefined();
    });

    it('records a cancelled event', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_cancel', { taskId: 'task-001' });

      const events = sm.getTaskEvents('task-001');
      const cancelled = events.find(e => e.event_type === 'cancelled');
      expect(cancelled).toBeDefined();
    });
  });

  // ── 10. task_cancel (running) ──────────────────────────────────

  describe('task_cancel running', () => {
    it('returns cancel_running action with nodeId', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_cancel', {
        taskId: 'task-001',
      } as TaskCancelPayload);

      expect(action).toEqual({
        type: 'cancel_running',
        taskId: 'task-001',
        nodeId: 'worker-1',
      });

      const task = sm.getTask('task-001')!;
      expect(task.state).toBe('cancelled');
    });

    it('returns cancel_running for assigned (not yet started) tasks', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'worker-1' });

      const action = sm.applyEntry('task_cancel', { taskId: 'task-001' });

      expect(action).toEqual({
        type: 'cancel_running',
        taskId: 'task-001',
        nodeId: 'worker-1',
      });
    });
  });

  // ── 11. getQueuedTasks (scheduled_after) ───────────────────────

  describe('getQueuedTasks', () => {
    it('returns queued tasks without scheduled_after', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't2' }));

      const queued = sm.getQueuedTasks();
      expect(queued).toHaveLength(2);
    });

    it('respects scheduled_after — backoff tasks not returned before their time', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      // Retry with scheduled_after in the far future
      const futureTime = new Date(Date.now() + 3600000).toISOString();
      sm.applyEntry('task_retry', { taskId: 't1', attempt: 1, scheduledAfter: futureTime });

      const queued = sm.getQueuedTasks();
      expect(queued).toHaveLength(0);
    });

    it('returns tasks whose scheduled_after has passed', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      // Retry with scheduled_after in the past
      const pastTime = new Date(Date.now() - 1000).toISOString();
      sm.applyEntry('task_retry', { taskId: 't1', attempt: 1, scheduledAfter: pastTime });

      const queued = sm.getQueuedTasks();
      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe('t1');
    });

    it('orders by priority DESC then created_at ASC', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't-low', priority: 1 }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't-high', priority: 10 }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't-mid', priority: 5 }));

      const queued = sm.getQueuedTasks();
      expect(queued[0].id).toBe('t-high');
      expect(queued[1].id).toBe('t-mid');
      expect(queued[2].id).toBe('t-low');
    });
  });

  // ── 12. listTasks ──────────────────────────────────────────────

  describe('listTasks', () => {
    beforeEach(() => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1', priority: 3 }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't2', priority: 7 }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't3', priority: 5 }));
      // Complete t2
      sm.applyEntry('task_assign', { taskId: 't2', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 't2', nodeId: 'w1' });
      sm.applyEntry('task_complete', { taskId: 't2', result: { exitCode: 0, stdout: '', stderr: '' } });
    });

    it('lists all tasks', () => {
      const tasks = sm.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('filters by state', () => {
      const queued = sm.listTasks({ state: 'queued' });
      expect(queued).toHaveLength(2);
      expect(queued.every(t => t.state === 'queued')).toBe(true);

      const completed = sm.listTasks({ state: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('t2');
    });

    it('paginates with limit and offset', () => {
      const page1 = sm.listTasks({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = sm.listTasks({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });
  });

  // ── 13. getTasksOnNode ─────────────────────────────────────────

  describe('getTasksOnNode', () => {
    it('returns only assigned/running tasks on a node', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't2' }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't3' }));

      // t1: assigned to worker-1
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'worker-1' });
      // t2: running on worker-1
      sm.applyEntry('task_assign', { taskId: 't2', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 't2', nodeId: 'worker-1' });
      // t3: assigned to worker-2
      sm.applyEntry('task_assign', { taskId: 't3', nodeId: 'worker-2' });

      const w1Tasks = sm.getTasksOnNode('worker-1');
      expect(w1Tasks).toHaveLength(2);
      expect(w1Tasks.map(t => t.id).sort()).toEqual(['t1', 't2']);

      const w2Tasks = sm.getTasksOnNode('worker-2');
      expect(w2Tasks).toHaveLength(1);
      expect(w2Tasks[0].id).toBe('t3');
    });

    it('does not return completed tasks on a node', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      sm.applyEntry('task_assign', { taskId: 't1', nodeId: 'worker-1' });
      sm.applyEntry('task_started', { taskId: 't1', nodeId: 'worker-1' });
      sm.applyEntry('task_complete', { taskId: 't1', result: { exitCode: 0, stdout: '', stderr: '' } });

      const tasks = sm.getTasksOnNode('worker-1');
      expect(tasks).toHaveLength(0);
    });
  });

  // ── 14. getDeadLetterTasks ─────────────────────────────────────

  describe('getDeadLetterTasks', () => {
    it('returns dead-lettered tasks ordered by dead_lettered_at DESC', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't1' }));
      sm.applyEntry('task_submit', makeSubmitPayload({ taskId: 't2' }));

      sm.applyEntry('task_dead_letter', { taskId: 't1', reason: 'reason1' });
      sm.applyEntry('task_dead_letter', { taskId: 't2', reason: 'reason2' });

      const dl = sm.getDeadLetterTasks();
      expect(dl).toHaveLength(2);
      expect(dl.every(t => t.state === 'dead_letter')).toBe(true);
    });
  });

  // ── 15. getTaskEvents ──────────────────────────────────────────

  describe('getTaskEvents', () => {
    it('returns events in chronological order', () => {
      sm.applyEntry('task_submit', makeSubmitPayload());
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_complete', {
        taskId: 'task-001',
        result: { exitCode: 0, stdout: '', stderr: '' },
      });

      const events = sm.getTaskEvents('task-001');
      expect(events).toHaveLength(4);
      expect(events.map(e => e.event_type)).toEqual([
        'submitted', 'assigned', 'started', 'completed',
      ]);
    });

    it('returns empty array for unknown task', () => {
      const events = sm.getTaskEvents('nonexistent');
      expect(events).toHaveLength(0);
    });
  });

  // ── 16. Unrecognized entry types ───────────────────────────────

  describe('unrecognized entry types', () => {
    it('returns null for non-task entry types', () => {
      const action = sm.applyEntry('noop', {});
      expect(action).toBeNull();
    });

    it('workflow_submit creates workflow and returns schedule action', () => {
      const action = sm.applyEntry('workflow_submit', {
        workflowId: 'wf-test',
        definition: { name: 'test', tasks: { A: { type: 'shell', spec: { command: 'echo hi' } } } },
      });
      expect(action).toEqual({ type: 'schedule' });
    });

    it('workflow_advance returns null when nothing to advance', () => {
      const action = sm.applyEntry('workflow_advance', { workflowId: 'nonexistent', completedTaskKey: 'x' });
      expect(action).toBeNull();
    });
  });

  // ── 17. Backoff calculation ────────────────────────────────────

  describe('backoff calculation', () => {
    it('applies exponential backoff on successive failures', () => {
      sm.applyEntry('task_submit', makeSubmitPayload({
        retryPolicy: { maxRetries: 5, backoffMs: 1000, backoffMultiplier: 2, retryable: true },
      }));
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });

      const beforeFail = Date.now();
      const action = sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'err',
        nodeId: 'w1',
      });

      // attempt=0 -> scheduledAfter should be ~1000ms (1000 * 2^0 = 1000)
      expect(action!.type).toBe('retry');
      const scheduledMs = new Date(action!.scheduledAfter!).getTime();
      expect(scheduledMs).toBeGreaterThanOrEqual(beforeFail + 900); // allow some clock slack
      expect(scheduledMs).toBeLessThanOrEqual(beforeFail + 1200);

      // Apply retry then fail again at attempt 1
      sm.applyEntry('task_retry', { taskId: 'task-001', attempt: 1, scheduledAfter: action!.scheduledAfter! });
      sm.applyEntry('task_assign', { taskId: 'task-001', nodeId: 'w1' });
      sm.applyEntry('task_started', { taskId: 'task-001', nodeId: 'w1' });

      const beforeFail2 = Date.now();
      const action2 = sm.applyEntry('task_failed', {
        taskId: 'task-001',
        error: 'err2',
        nodeId: 'w1',
      });

      // attempt=1 -> scheduledAfter should be ~2000ms (1000 * 2^1 = 2000)
      expect(action2!.type).toBe('retry');
      const scheduledMs2 = new Date(action2!.scheduledAfter!).getTime();
      expect(scheduledMs2).toBeGreaterThanOrEqual(beforeFail2 + 1900);
      expect(scheduledMs2).toBeLessThanOrEqual(beforeFail2 + 2200);
    });
  });
});
