/**
 * cortex top — Live cluster resource dashboard.
 * Polls AgentService.GetResources() on each node, displays refreshing table.
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

function formatBytes(bytes: string | number): string {
  const b = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (b === 0 || isNaN(b)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function cpuBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent > 80 ? chalk.red : percent > 50 ? chalk.yellow : chalk.green;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function memBar(used: number, total: number, width: number = 20): string {
  if (total === 0) return chalk.dim('░'.repeat(width));
  const percent = (used / total) * 100;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent > 85 ? chalk.red : percent > 60 ? chalk.yellow : chalk.green;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

export interface TopOpts {
  address: string;
  once?: boolean;
  interval: number;
}

interface NodeSnapshot {
  name: string;
  isLeader: boolean;
  cpuCores: number;
  cpuPercent: number;
  memTotal: number;
  memAvail: number;
  diskTotal: number;
  diskAvail: number;
  gaming: boolean;
  healthy: boolean;
  error?: string;
}

async function collectSnapshots(pool: GrpcClientPool, client: ClusterClient): Promise<NodeSnapshot[]> {
  const state = await client.getClusterState();
  const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
  const snapshots: NodeSnapshot[] = [];

  const promises = nodes.map(async (node: any) => {
    const name = shortName(node.node_id);
    const isLeader = node.node_id === state.leader_id;
    const addr = `${node.tailscale_ip}:${node.grpc_port || 50051}`;

    try {
      const ready = await pool.waitForReady(addr, 3000);
      if (!ready) {
        return { name, isLeader, cpuCores: 0, cpuPercent: 0, memTotal: 0, memAvail: 0, diskTotal: 0, diskAvail: 0, gaming: false, healthy: false, error: 'unreachable' };
      }
      const conn = pool.getConnection(addr);
      const res: any = await pool.call(conn.agentClient, 'GetResources', {}, 5000);
      return {
        name,
        isLeader,
        cpuCores: res.cpu_cores ?? 0,
        cpuPercent: res.cpu_usage_percent ?? 0,
        memTotal: parseInt(res.memory_bytes ?? '0'),
        memAvail: parseInt(res.memory_available_bytes ?? '0'),
        diskTotal: parseInt(res.disk_bytes ?? '0'),
        diskAvail: parseInt(res.disk_available_bytes ?? '0'),
        gaming: res.gaming_detected ?? false,
        healthy: true,
      };
    } catch {
      return { name, isLeader, cpuCores: 0, cpuPercent: 0, memTotal: 0, memAvail: 0, diskTotal: 0, diskAvail: 0, gaming: false, healthy: false, error: 'error' };
    }
  });

  return Promise.all(promises);
}

function render(snapshots: NodeSnapshot[], term: string, leader: string): string {
  const lines: string[] = [];
  const now = new Date().toLocaleTimeString(undefined, { hour12: false });

  lines.push('');
  lines.push(chalk.bold(`  cortex top`) + chalk.dim(`  ${now}  term ${term}  leader ${leader}`));
  lines.push('');

  // Header
  const W = { name: 14, cpu: 8, cpuBar: 22, mem: 10, memBar: 22, disk: 10, flags: 8 };
  lines.push(chalk.dim(
    '  ' + 'NODE'.padEnd(W.name) + 'CPU'.padEnd(W.cpu) + ''.padEnd(W.cpuBar) +
    'MEM'.padEnd(W.mem) + ''.padEnd(W.memBar) + 'DISK'.padEnd(W.disk) + 'FLAGS'
  ));
  lines.push(chalk.dim('  ' + '─'.repeat(90)));

  // Totals
  let totalCpu = 0, totalMem = 0, totalMemAvail = 0, totalDisk = 0, totalDiskAvail = 0;

  for (const s of snapshots) {
    if (!s.healthy) {
      const nameStr = (s.isLeader ? '* ' : '  ') + s.name;
      lines.push(chalk.dim(`  ${nameStr.padEnd(W.name)}${(s.error ?? 'offline').padEnd(W.cpu + W.cpuBar + W.mem + W.memBar + W.disk)}`) + chalk.dim('-'));
      continue;
    }

    totalCpu += s.cpuPercent;
    totalMem += s.memTotal;
    totalMemAvail += s.memAvail;
    totalDisk += s.diskTotal;
    totalDiskAvail += s.diskAvail;

    const nameStr = (s.isLeader ? '* ' : '  ') + s.name;
    const cpuStr = `${s.cpuPercent.toFixed(0)}%`.padEnd(W.cpu);
    const cpuB = cpuBar(s.cpuPercent) + '  ';
    const memUsed = s.memTotal - s.memAvail;
    const memStr = `${formatBytes(memUsed)}`.padEnd(W.mem);
    const memB = memBar(memUsed, s.memTotal) + '  ';
    const diskUsed = s.diskTotal - s.diskAvail;
    const diskStr = `${formatBytes(diskUsed)}`.padEnd(W.disk);

    const flags: string[] = [];
    if (s.gaming) flags.push(chalk.magenta('gaming'));
    if (s.isLeader) flags.push(chalk.green('leader'));

    const nameColored = s.isLeader ? chalk.green(nameStr.padEnd(W.name)) : nameStr.padEnd(W.name);

    lines.push(`  ${nameColored}${cpuStr}${cpuB}${memStr}${memB}${diskStr}${flags.join(' ')}`);
  }

  // Summary
  const healthyCount = snapshots.filter(s => s.healthy).length;
  const avgCpu = healthyCount > 0 ? (totalCpu / healthyCount).toFixed(0) : '0';
  lines.push(chalk.dim('  ' + '─'.repeat(90)));
  lines.push(chalk.dim(`  ${healthyCount} nodes  avg cpu ${avgCpu}%  mem ${formatBytes(totalMem - totalMemAvail)}/${formatBytes(totalMem)}  disk ${formatBytes(totalDisk - totalDiskAvail)}/${formatBytes(totalDisk)}`));
  lines.push('');

  return lines.join('\n');
}

export async function runTop(opts: TopOpts): Promise<void> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(opts.address, 5000);

  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${opts.address}`));
    process.exit(1);
  }

  const client = new ClusterClient(pool, opts.address);

  const refresh = async () => {
    try {
      const state = await client.getClusterState();
      const snapshots = await collectSnapshots(pool, client);
      const output = render(
        snapshots,
        state.term as string,
        state.leader_id ? shortName(state.leader_id) : 'NONE',
      );

      if (!opts.once) {
        // Clear screen and move cursor to top
        process.stdout.write('\x1B[2J\x1B[H');
      }
      process.stdout.write(output);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
    }
  };

  await refresh();

  if (opts.once) {
    pool.closeAll();
    return;
  }

  // Refresh loop
  const intervalId = setInterval(refresh, opts.interval * 1000);

  // Clean exit on Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(intervalId);
    pool.closeAll();
    console.log();
    process.exit(0);
  });
}
