/**
 * cortex tasks — Task management CLI.
 * Wraps task-engine gRPC RPCs for list/view/cancel.
 */

import chalk from 'chalk';
import { GrpcClientPool, ClusterClient } from '../grpc/client.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function shortName(nodeId: string): string {
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  return parts.slice(0, -1).join('-');
}

function formatState(state: string): string {
  const s = state.replace('TASK_STATE_', '').toLowerCase();
  switch (s) {
    case 'completed': return chalk.green(s);
    case 'running': return chalk.cyan(s);
    case 'queued':
    case 'assigned': return chalk.yellow(s);
    case 'failed': return chalk.red(s);
    case 'cancelled': return chalk.dim(s);
    default: return s;
  }
}

function formatTime(ts: string | number): string {
  const n = typeof ts === 'string' ? parseInt(ts) : ts;
  if (!n || n === 0) return '-';
  return new Date(n).toLocaleString(undefined, {
    month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function formatDuration(startMs: number, endMs: number): string {
  if (!startMs) return '-';
  const end = endMs || Date.now();
  const dur = end - startMs;
  if (dur < 1000) return `${dur}ms`;
  if (dur < 60000) return `${(dur / 1000).toFixed(1)}s`;
  return `${(dur / 60000).toFixed(1)}m`;
}

export interface TasksListOpts {
  address: string;
  state?: string;
  limit: number;
}

export interface TasksViewOpts {
  address: string;
}

export interface TasksCancelOpts {
  address: string;
}

async function connectOrDie(address: string): Promise<{ pool: GrpcClientPool; client: ClusterClient }> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(address, 5000);
  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${address}`));
    process.exit(1);
  }
  return { pool, client: new ClusterClient(pool, address) };
}

export async function runTasksList(opts: TasksListOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const state = await client.getClusterState();

    console.log(chalk.bold('\n  Cortex Tasks'));
    console.log(chalk.dim(`  Active: ${state.active_tasks ?? 0}  Queued: ${state.queued_tasks ?? 0}`));
    console.log();

    // Query tasks from local shared memory
    const path = await import('path');
    const os = await import('os');
    const dbPath = path.join(os.homedir(), '.cortex', 'shared-memory.db');

    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });

      let sql = `SELECT * FROM task_agent_tasks`;
      const params: any[] = [];

      if (opts.state) {
        sql += ` WHERE status = ?`;
        params.push(opts.state);
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(opts.limit);

      const rows = db.prepare(sql).all(...params) as any[];
      db.close();

      if (rows.length === 0) {
        console.log(chalk.dim('  No tasks found.'));
        console.log();
        return;
      }

      const W = { id: 12, type: 12, status: 12, agent: 14, created: 20 };
      console.log(chalk.dim(
        '  ' + 'ID'.padEnd(W.id) + 'TYPE'.padEnd(W.type) + 'STATUS'.padEnd(W.status) +
        'AGENT'.padEnd(W.agent) + 'CREATED'
      ));
      console.log(chalk.dim('  ' + '─'.repeat(68)));

      for (const row of rows) {
        const id = (row.id?.toString() ?? '-').slice(0, 10).padEnd(W.id);
        const type = (row.task_type ?? '-').padEnd(W.type);
        const status = (row.status ?? '-');
        const agent = (row.agent_id ? shortName(row.agent_id) : '-').padEnd(W.agent);
        const created = formatTime(row.created_at);

        console.log(`  ${id}${type}${formatState(status).padEnd(W.status + 10)}${agent}${created}`);
      }

      console.log(chalk.dim(`\n  ${rows.length} task(s) shown`));
      console.log();
    } catch (err: any) {
      if (err.message?.includes('no such table')) {
        console.log(chalk.dim('  No task history available.'));
        console.log();
      } else {
        throw err;
      }
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}

export async function runTasksView(taskId: string, opts: TasksViewOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const status: any = await client.getTaskStatus(taskId);

    console.log(chalk.bold(`\n  Task ${taskId}\n`));
    console.log(`  State:     ${formatState(status.state ?? 'unknown')}`);
    console.log(`  Node:      ${status.assigned_node ? shortName(status.assigned_node) : '-'}`);
    console.log(`  Started:   ${formatTime(status.started_at)}`);
    console.log(`  Completed: ${formatTime(status.completed_at)}`);

    const startMs = parseInt(status.started_at ?? '0');
    const endMs = parseInt(status.completed_at ?? '0');
    if (startMs) {
      console.log(`  Duration:  ${formatDuration(startMs, endMs)}`);
    }

    if (status.exit_code !== undefined && status.exit_code !== 0) {
      console.log(`  Exit code: ${chalk.red(status.exit_code)}`);
    }
    if (status.error) {
      console.log(`  Error:     ${chalk.red(status.error)}`);
    }

    if (status.result?.stdout?.length > 0) {
      console.log(chalk.dim('\n  ── stdout ──'));
      console.log(`  ${status.result.stdout.toString().trim().split('\n').join('\n  ')}`);
    }
    if (status.result?.stderr?.length > 0) {
      console.log(chalk.dim('\n  ── stderr ──'));
      console.log(`  ${chalk.red(status.result.stderr.toString().trim().split('\n').join('\n  '))}`);
    }

    console.log();
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}

export async function runTasksCancel(taskId: string, opts: TasksCancelOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const resp = await client.cancelTask(taskId);

    if (resp.cancelled) {
      console.log(chalk.green(`Task ${taskId} cancelled`));
    } else {
      console.error(chalk.red(`Task ${taskId} could not be cancelled (may already be completed)`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}
