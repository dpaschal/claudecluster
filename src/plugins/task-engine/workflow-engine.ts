import Database from 'better-sqlite3';
import { Logger } from 'winston';
import { evaluateCondition } from './condition-eval.js';
import type { TaskRecord } from './types.js';

export interface ReadyTask {
  taskKey: string;
  taskId: string;
}

export interface SkippedTask {
  taskKey: string;
  taskId: string;
}

export interface WorkflowEvalResult {
  readyTasks: ReadyTask[];
  skippedTasks: SkippedTask[];
  workflowComplete: boolean;
  workflowState: 'running' | 'completed' | 'failed';
}

export class WorkflowEngine {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /**
   * Evaluate which tasks in a workflow are ready to run after a task completes.
   */
  evaluateWorkflow(workflowId: string): WorkflowEvalResult {
    const readyTasks: ReadyTask[] = [];
    const skippedTasks: SkippedTask[] = [];

    // Get all tasks in this workflow
    const tasks = this.db
      .prepare('SELECT * FROM te_tasks WHERE workflow_id = ?')
      .all(workflowId) as TaskRecord[];

    // Get all dependencies
    const deps = this.db
      .prepare('SELECT * FROM te_task_dependencies WHERE workflow_id = ?')
      .all(workflowId) as Array<{
      task_key: string;
      depends_on_key: string;
      condition: string | null;
    }>;

    // Build dependency map: taskKey -> [{ dependsOnKey, condition }]
    const depMap = new Map<string, Array<{ dependsOnKey: string; condition: string | null }>>();
    for (const dep of deps) {
      if (!depMap.has(dep.task_key)) depMap.set(dep.task_key, []);
      depMap.get(dep.task_key)!.push({
        dependsOnKey: dep.depends_on_key,
        condition: dep.condition,
      });
    }

    // Build task lookup by key
    const taskByKey = new Map<string, TaskRecord>();
    for (const task of tasks) {
      if (task.task_key) taskByKey.set(task.task_key, task);
    }

    // Build parent results for condition evaluation
    const parentResults: Record<
      string,
      { exitCode: number; stdout: string; stderr: string; state: string }
    > = {};
    for (const task of tasks) {
      if (!task.task_key) continue;
      if (task.result) {
        try {
          const result = JSON.parse(task.result);
          parentResults[task.task_key] = {
            exitCode: result.exitCode ?? -1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            state: task.state,
          };
        } catch {
          parentResults[task.task_key] = {
            exitCode: -1,
            stdout: '',
            stderr: '',
            state: task.state,
          };
        }
      } else {
        parentResults[task.task_key] = {
          exitCode: -1,
          stdout: '',
          stderr: '',
          state: task.state,
        };
      }
    }

    // Get workflow context
    const workflow = this.db
      .prepare('SELECT context FROM te_workflows WHERE id = ?')
      .get(workflowId) as { context: string } | undefined;
    const workflowContext = workflow?.context ? JSON.parse(workflow.context) : {};

    // Evaluate each pending task
    for (const task of tasks) {
      if (task.state !== 'pending' || !task.task_key) continue;

      const taskDeps = depMap.get(task.task_key) ?? [];

      // Check if ALL dependencies are in a terminal state (completed, skipped, failed, cancelled, dead_letter)
      const allDepsTerminal = taskDeps.every((dep) => {
        const depTask = taskByKey.get(dep.dependsOnKey);
        return (
          depTask &&
          ['completed', 'skipped', 'failed', 'cancelled', 'dead_letter'].includes(depTask.state)
        );
      });

      if (!allDepsTerminal) continue;

      // All deps are terminal -- evaluate conditions
      let shouldRun = true;

      if (taskDeps.length > 0) {
        const hasConditions = taskDeps.some((d) => d.condition);

        if (hasConditions) {
          // Evaluate each edge -- task runs only if ALL conditions pass
          shouldRun = taskDeps.every((dep) => {
            if (!dep.condition) {
              // No condition on this edge -- just check dep completed
              const depTask = taskByKey.get(dep.dependsOnKey);
              return depTask?.state === 'completed';
            }
            return evaluateCondition(dep.condition, parentResults, workflowContext);
          });
        } else {
          // No conditions -- run only if all deps completed successfully
          shouldRun = taskDeps.every((dep) => {
            const depTask = taskByKey.get(dep.dependsOnKey);
            return depTask?.state === 'completed';
          });
        }
      }

      if (shouldRun) {
        readyTasks.push({ taskKey: task.task_key, taskId: task.id });
      } else {
        skippedTasks.push({ taskKey: task.task_key, taskId: task.id });
      }
    }

    // Check workflow completion
    const allTerminal = tasks.every((t) =>
      ['completed', 'failed', 'cancelled', 'skipped', 'dead_letter'].includes(t.state),
    );
    const anyFailed = tasks.some((t) => ['failed', 'dead_letter'].includes(t.state));

    return {
      readyTasks,
      skippedTasks,
      workflowComplete: allTerminal,
      workflowState: allTerminal ? (anyFailed ? 'failed' : 'completed') : 'running',
    };
  }
}
