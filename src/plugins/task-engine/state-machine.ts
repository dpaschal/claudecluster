import Database from 'better-sqlite3';
import { Logger } from 'winston';
import type { LogEntryType } from '../../cluster/raft.js';
import type {
  TaskRecord,
  TaskEventRecord,
  TaskSubmitPayload,
  TaskAssignPayload,
  TaskStartedPayload,
  TaskCompletePayload,
  TaskFailedPayload,
  TaskCancelPayload,
  TaskRetryPayload,
  TaskDeadLetterPayload,
  RetryPolicy,
  TaskEngineState,
} from './types.js';
import { DEFAULT_RETRY_POLICY } from './types.js';

export interface StateMachineAction {
  type: 'retry' | 'dead_letter' | 'cancel_running' | 'schedule' | 'workflow_advance';
  taskId?: string;
  workflowId?: string;
  nodeId?: string;
  attempt?: number;
  scheduledAfter?: string;
  reason?: string;
}

export class TaskStateMachine {
  private db: Database.Database;
  private nodeId: string;
  private logger: Logger;

  // Prepared statements
  private stmtInsertTask: Database.Statement;
  private stmtInsertEvent: Database.Statement;
  private stmtGetTask: Database.Statement;
  private stmtUpdateTaskState: Database.Statement;

  constructor(db: Database.Database, nodeId: string, logger: Logger) {
    this.db = db;
    this.nodeId = nodeId;
    this.logger = logger;

    this.stmtInsertTask = db.prepare(`
      INSERT INTO te_tasks (id, workflow_id, task_key, type, state, priority, spec, constraints, retry_policy, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertEvent = db.prepare(`
      INSERT INTO te_task_events (task_id, event_type, node_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetTask = db.prepare(`SELECT * FROM te_tasks WHERE id = ?`);

    this.stmtUpdateTaskState = db.prepare(`UPDATE te_tasks SET state = ? WHERE id = ?`);
  }

  /**
   * Apply a committed Raft log entry to the local SQLite state.
   * Returns an action the leader should take, or null.
   */
  applyEntry(type: string, payload: unknown): StateMachineAction | null {
    switch (type as LogEntryType) {
      case 'task_submit':
        return this.handleTaskSubmit(payload as TaskSubmitPayload);
      case 'task_assign':
        return this.handleTaskAssign(payload as TaskAssignPayload);
      case 'task_started':
        return this.handleTaskStarted(payload as TaskStartedPayload);
      case 'task_complete':
        return this.handleTaskComplete(payload as TaskCompletePayload);
      case 'task_failed':
        return this.handleTaskFailed(payload as TaskFailedPayload);
      case 'task_cancel':
        return this.handleTaskCancel(payload as TaskCancelPayload);
      case 'task_retry':
        return this.handleTaskRetry(payload as TaskRetryPayload);
      case 'task_dead_letter':
        return this.handleTaskDeadLetter(payload as TaskDeadLetterPayload);
      case 'workflow_submit':
        // TODO: Implement in Phase 2 (workflow state machine)
        this.logger.debug('workflow_submit stub — not yet implemented');
        return null;
      case 'workflow_advance':
        // TODO: Implement in Phase 2 (workflow state machine)
        this.logger.debug('workflow_advance stub — not yet implemented');
        return null;
      default:
        return null;
    }
  }

  // ── Entry handlers ──────────────────────────────────────────────

  private handleTaskSubmit(payload: TaskSubmitPayload): StateMachineAction | null {
    const now = new Date().toISOString();
    const state: TaskEngineState = payload.workflowId ? 'pending' : 'queued';

    this.stmtInsertTask.run(
      payload.taskId,
      payload.workflowId ?? null,
      payload.taskKey ?? null,
      payload.type,
      state,
      payload.priority ?? 0,
      JSON.stringify(payload.spec),
      payload.constraints ? JSON.stringify(payload.constraints) : null,
      payload.retryPolicy ? JSON.stringify(payload.retryPolicy) : null,
      0, // attempt
      now,
    );

    this.insertEvent(payload.taskId, 'submitted', payload.submitterNode, null, now);

    this.logger.debug(`task_submit: ${payload.taskId} → ${state}`);
    return null;
  }

  private handleTaskAssign(payload: TaskAssignPayload): StateMachineAction | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE te_tasks SET state = 'assigned', assigned_node = ?, assigned_at = ? WHERE id = ?
    `).run(payload.nodeId, now, payload.taskId);

    this.insertEvent(payload.taskId, 'assigned', payload.nodeId, null, now);

    this.logger.debug(`task_assign: ${payload.taskId} → assigned on ${payload.nodeId}`);
    return null;
  }

  private handleTaskStarted(payload: TaskStartedPayload): StateMachineAction | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE te_tasks SET state = 'running', started_at = ? WHERE id = ?
    `).run(now, payload.taskId);

    this.insertEvent(payload.taskId, 'started', payload.nodeId, null, now);

    this.logger.debug(`task_started: ${payload.taskId} → running on ${payload.nodeId}`);
    return null;
  }

  private handleTaskComplete(payload: TaskCompletePayload): StateMachineAction | null {
    const now = new Date().toISOString();
    const task = this.getTask(payload.taskId);
    if (!task) {
      this.logger.warn(`task_complete: unknown task ${payload.taskId}`);
      return null;
    }

    this.db.prepare(`
      UPDATE te_tasks SET state = 'completed', result = ?, completed_at = ? WHERE id = ?
    `).run(JSON.stringify(payload.result), now, payload.taskId);

    this.insertEvent(payload.taskId, 'completed', task.assigned_node ?? this.nodeId, null, now);

    this.logger.debug(`task_complete: ${payload.taskId} → completed`);

    // If part of a workflow, signal workflow_advance
    if (task.workflow_id) {
      return {
        type: 'workflow_advance',
        taskId: payload.taskId,
        workflowId: task.workflow_id,
      };
    }

    return null;
  }

  private handleTaskFailed(payload: TaskFailedPayload): StateMachineAction | null {
    const now = new Date().toISOString();
    const task = this.getTask(payload.taskId);
    if (!task) {
      this.logger.warn(`task_failed: unknown task ${payload.taskId}`);
      return null;
    }

    // Update error field (keep state as-is for now — retry or dead_letter will change it)
    this.db.prepare(`
      UPDATE te_tasks SET error = ? WHERE id = ?
    `).run(payload.error, payload.taskId);

    this.insertEvent(payload.taskId, 'failed', payload.nodeId, payload.error, now);

    // Determine retry policy
    const retryPolicy: RetryPolicy = task.retry_policy
      ? JSON.parse(task.retry_policy)
      : DEFAULT_RETRY_POLICY;

    if (retryPolicy.retryable && task.attempt < retryPolicy.maxRetries) {
      const nextAttempt = task.attempt + 1;
      const backoffMs = retryPolicy.backoffMs * Math.pow(retryPolicy.backoffMultiplier, task.attempt);
      const scheduledAfter = new Date(Date.now() + backoffMs).toISOString();

      return {
        type: 'retry',
        taskId: payload.taskId,
        attempt: nextAttempt,
        scheduledAfter,
      };
    }

    return {
      type: 'dead_letter',
      taskId: payload.taskId,
      reason: `Max retries exhausted (${retryPolicy.maxRetries}) or not retryable`,
    };
  }

  private handleTaskCancel(payload: TaskCancelPayload): StateMachineAction | null {
    const now = new Date().toISOString();
    const task = this.getTask(payload.taskId);
    if (!task) {
      this.logger.warn(`task_cancel: unknown task ${payload.taskId}`);
      return null;
    }

    const wasRunning = task.state === 'running' || task.state === 'assigned';
    const assignedNode = task.assigned_node;

    this.db.prepare(`
      UPDATE te_tasks SET state = 'cancelled', completed_at = ? WHERE id = ?
    `).run(now, payload.taskId);

    this.insertEvent(payload.taskId, 'cancelled', this.nodeId, null, now);

    this.logger.debug(`task_cancel: ${payload.taskId} → cancelled`);

    // If it was running on a node, signal cancellation
    if (wasRunning && assignedNode) {
      return {
        type: 'cancel_running',
        taskId: payload.taskId,
        nodeId: assignedNode,
      };
    }

    return null;
  }

  private handleTaskRetry(payload: TaskRetryPayload): StateMachineAction | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE te_tasks
      SET state = 'queued',
          attempt = ?,
          assigned_node = NULL,
          assigned_at = NULL,
          started_at = NULL,
          completed_at = NULL,
          error = NULL,
          result = NULL,
          scheduled_after = ?
      WHERE id = ?
    `).run(payload.attempt, payload.scheduledAfter, payload.taskId);

    this.insertEvent(payload.taskId, 'retried', this.nodeId, `attempt=${payload.attempt} scheduledAfter=${payload.scheduledAfter}`, now);

    this.logger.debug(`task_retry: ${payload.taskId} → queued (attempt ${payload.attempt}, after ${payload.scheduledAfter})`);

    return {
      type: 'schedule',
      taskId: payload.taskId,
      scheduledAfter: payload.scheduledAfter,
    };
  }

  private handleTaskDeadLetter(payload: TaskDeadLetterPayload): StateMachineAction | null {
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE te_tasks SET state = 'dead_letter', dead_lettered_at = ? WHERE id = ?
    `).run(now, payload.taskId);

    this.insertEvent(payload.taskId, 'dead_lettered', this.nodeId, payload.reason, now);

    this.logger.debug(`task_dead_letter: ${payload.taskId} → dead_letter (${payload.reason})`);
    return null;
  }

  // ── Event helper ────────────────────────────────────────────────

  private insertEvent(
    taskId: string,
    eventType: string,
    nodeId: string,
    detail: string | null,
    createdAt: string,
  ): void {
    this.stmtInsertEvent.run(taskId, eventType, nodeId, detail, createdAt);
  }

  // ── Query helpers ───────────────────────────────────────────────

  getTask(taskId: string): TaskRecord | undefined {
    return this.stmtGetTask.get(taskId) as TaskRecord | undefined;
  }

  listTasks(options?: {
    state?: TaskEngineState;
    limit?: number;
    offset?: number;
  }): TaskRecord[] {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    if (options?.state) {
      return this.db.prepare(`
        SELECT * FROM te_tasks WHERE state = ? ORDER BY priority DESC, created_at ASC LIMIT ? OFFSET ?
      `).all(options.state, limit, offset) as TaskRecord[];
    }

    return this.db.prepare(`
      SELECT * FROM te_tasks ORDER BY priority DESC, created_at ASC LIMIT ? OFFSET ?
    `).all(limit, offset) as TaskRecord[];
  }

  getQueuedTasks(): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_tasks
      WHERE state = 'queued'
        AND (scheduled_after IS NULL OR scheduled_after <= ?)
      ORDER BY priority DESC, created_at ASC
    `).all(new Date().toISOString()) as TaskRecord[];
  }

  getTasksOnNode(nodeId: string): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_tasks
      WHERE assigned_node = ?
        AND state IN ('assigned', 'running')
      ORDER BY priority DESC, created_at ASC
    `).all(nodeId) as TaskRecord[];
  }

  getDeadLetterTasks(): TaskRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_tasks
      WHERE state = 'dead_letter'
      ORDER BY dead_lettered_at DESC
    `).all() as TaskRecord[];
  }

  getTaskEvents(taskId: string): TaskEventRecord[] {
    return this.db.prepare(`
      SELECT * FROM te_task_events
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as TaskEventRecord[];
  }
}
