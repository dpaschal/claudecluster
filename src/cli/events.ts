/**
 * cortex events — Cluster event log viewer.
 * Queries infra_events from shared memory + Raft state for cluster history.
 */

import chalk from 'chalk';
import { GrpcClientPool, ClusterClient } from '../grpc/client.js';
import winston from 'winston';
import crypto from 'crypto';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function shortName(nodeId: string): string {
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  return parts.slice(0, -1).join('-');
}

interface EventRow {
  id: number;
  type: string;
  occurred_at: string;
  source: string;
  details: string;
}

export interface EventsOpts {
  address: string;
  since?: string;
  type?: string;
  limit: number;
}

function parseSince(since: string): string {
  const now = Date.now();
  const match = since.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!;
    return new Date(now - val * ms).toISOString();
  }
  // Try as ISO date
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d.toISOString();
  return new Date(now - 3600000).toISOString(); // default 1h
}

function colorType(type: string): string {
  switch (type) {
    case 'election': return chalk.yellow(type);
    case 'node_join': return chalk.green(type);
    case 'node_leave': return chalk.red(type);
    case 'task_complete': return chalk.green(type);
    case 'task_failed': return chalk.red(type);
    case 'deploy': return chalk.cyan(type);
    case 'alert': return chalk.red(type);
    default: return chalk.dim(type);
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

async function queryEvents(client: ClusterClient, opts: EventsOpts): Promise<EventRow[]> {
  const sinceIso = opts.since ? parseSince(opts.since) : parseSince('24h');

  // Query infra_events from shared memory via ForwardMemoryWrite (read-only select not available via gRPC)
  // Instead, we use a write that reads: insert a temporary query marker, then clean up
  // Actually, we need to query locally. Use a different approach: submit a shell task that queries SQLite.
  // Simplest: query via the cluster state to get the leader, then SSH to it.
  //
  // Best approach: query the local shared-memory.db directly since it's replicated to all nodes.
  const path = await import('path');
  const os = await import('os');
  const dbPath = path.join(os.homedir(), '.cortex', 'shared-memory.db');

  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });

    let sql = `SELECT id, type, occurred_at, source, details FROM infra_events WHERE occurred_at >= ?`;
    const params: any[] = [sinceIso];

    if (opts.type && opts.type !== 'all') {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }

    sql += ` ORDER BY occurred_at DESC LIMIT ?`;
    params.push(opts.limit);

    const rows = db.prepare(sql).all(...params) as EventRow[];
    db.close();
    return rows.reverse(); // chronological order
  } catch (err: any) {
    if (err.code === 'SQLITE_ERROR' || err.message?.includes('no such table')) {
      return []; // table doesn't exist yet
    }
    throw err;
  }
}

async function queryRaftHistory(client: ClusterClient): Promise<{ term: string; leaderId: string; leaderName: string }> {
  const state = await client.getClusterState();
  return {
    term: state.term as string,
    leaderId: state.leader_id,
    leaderName: state.leader_id ? shortName(state.leader_id) : 'NONE',
  };
}

export async function runEvents(opts: EventsOpts): Promise<void> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(opts.address, 5000);

  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${opts.address}`));
    process.exit(1);
  }

  const client = new ClusterClient(pool, opts.address);

  try {
    // Get current Raft state
    const raft = await queryRaftHistory(client);

    console.log(chalk.bold('\n  Cortex Cluster Events'));
    console.log(chalk.dim(`  Current: term ${raft.term}, leader ${raft.leaderName}`));
    console.log();

    // Query events from local shared memory
    const events = await queryEvents(client, opts);

    if (events.length === 0) {
      console.log(chalk.dim(`  No events found${opts.since ? ` since ${opts.since}` : ' in last 24h'}.`));
      console.log(chalk.dim(`  Events are recorded as the cluster operates.`));
      console.log();
      pool.closeAll();
      return;
    }

    // Column widths
    const W = { time: 20, type: 16, source: 16 };
    console.log(chalk.dim(
      '  ' + 'TIME'.padEnd(W.time) + 'TYPE'.padEnd(W.type) + 'SOURCE'.padEnd(W.source) + 'DETAILS'
    ));
    console.log(chalk.dim('  ' + '─'.repeat(76)));

    for (const ev of events) {
      const time = formatTime(ev.occurred_at);
      const type = colorType(ev.type);
      const source = ev.source || '-';

      let details = '';
      try {
        const d = JSON.parse(ev.details);
        details = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(' ');
      } catch {
        details = ev.details || '';
      }

      // Pad the raw type for alignment (strip ANSI for padding calc)
      const typePadded = ev.type.padEnd(W.type - 2);
      console.log(
        `  ${chalk.dim(time.padEnd(W.time))}${colorType(typePadded)}  ${source.padEnd(W.source)}${details}`
      );
    }

    console.log(chalk.dim(`\n  ${events.length} event(s) shown`));
    console.log();
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}
