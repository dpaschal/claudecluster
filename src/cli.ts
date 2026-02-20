/**
 * CLI subcommands for the cortex binary (isi-style management CLI).
 * Called from index.ts when a subcommand is detected.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import winston from 'winston';
import { GrpcClientPool, ClusterClient } from './grpc/client.js';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function createClient(address: string): { pool: GrpcClientPool; client: ClusterClient } {
  const pool = new GrpcClientPool({ logger });
  const client = new ClusterClient(pool, address);
  return { pool, client };
}

function formatBytes(bytes: string | number): string {
  const b = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (b === 0 || isNaN(b)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function shortName(nodeId: string): string {
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  return parts.slice(0, -1).join('-');
}

async function connectOrDie(address: string): Promise<{ pool: GrpcClientPool; client: ClusterClient }> {
  const { pool, client } = createClient(address);
  await pool.loadProto();
  const ready = await pool.waitForReady(address, 5000);
  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${address}`));
    process.exit(1);
  }
  return { pool, client };
}

/**
 * Register all CLI subcommands on the given commander program.
 */
export function registerCliCommands(program: Command): void {

  // ── cortex status ─────────────────────────────────────────
  program
    .command('status')
    .description('Show cluster status, health, and node details')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (opts) => {
      const { pool, client } = await connectOrDie(opts.address);
      try {
        const state = await client.getClusterState();
        const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
        const leaderName = state.leader_id ? shortName(state.leader_id) : 'NONE';
        const activeNodes = nodes.filter((n: any) => n.status?.includes('ACTIVE'));
        const totalVoting = nodes.length;
        const hasLeader = !!state.leader_id;
        const quorumNeeded = Math.floor(totalVoting / 2) + 1;
        const quorumMet = activeNodes.length >= quorumNeeded;

        let overall = 'HEALTHY';
        let overallColor = chalk.green;
        if (!hasLeader) { overall = 'CRITICAL'; overallColor = chalk.red; }
        else if (!quorumMet) { overall = 'CRITICAL'; overallColor = chalk.red; }
        else if (activeNodes.length < totalVoting) { overall = 'DEGRADED'; overallColor = chalk.yellow; }

        console.log(chalk.bold(`\n  Cortex Cluster Status\n`));
        console.log(`  Health:  ${overallColor.bold(overall)}    Leader: ${hasLeader ? chalk.green(leaderName) : chalk.red('NONE')}    Term: ${state.term}`);
        console.log(`  Nodes:   ${activeNodes.length}/${totalVoting} active    Quorum: ${quorumMet ? chalk.green('met') : chalk.red('NOT MET')} (need ${quorumNeeded})    Tasks: ${state.active_tasks ?? 0} active, ${state.queued_tasks ?? 0} queued`);
        console.log();

        // Node table
        const W = { name: 18, role: 12, status: 10, ip: 18, cpu: 8, mem: 12 };
        console.log(chalk.dim(
          '  ' + 'NAME'.padEnd(W.name) + 'ROLE'.padEnd(W.role) + 'STATUS'.padEnd(W.status) +
          'IP'.padEnd(W.ip) + 'CPU'.padEnd(W.cpu) + 'MEM'
        ));
        console.log(chalk.dim('  ' + '─'.repeat(76)));

        for (const node of nodes) {
          const name = shortName(node.node_id);
          const isLeader = node.node_id === state.leader_id;
          const role = node.role?.replace('NODE_ROLE_', '').toLowerCase() ?? '?';
          const status = node.status?.replace('NODE_STATUS_', '').toLowerCase() ?? '?';
          const ip = node.tailscale_ip ?? '';
          const cpu = node.resources?.cpu_cores ? `${node.resources.cpu_cores}c` : '-';
          const mem = node.resources?.memory_bytes && node.resources.memory_bytes !== '0'
            ? formatBytes(node.resources.memory_bytes) : '-';

          const nameRaw = isLeader ? `* ${name}` : `  ${name}`;
          const cols = '  ' + [
            nameRaw.padEnd(W.name),
            role.padEnd(W.role),
            status.padEnd(W.status),
            ip.padEnd(W.ip),
            cpu.padEnd(W.cpu),
            mem,
          ].join('');

          if (isLeader) {
            console.log(chalk.green(cols));
          } else if (status !== 'active') {
            console.log(chalk.dim(cols));
          } else {
            console.log(cols);
          }
        }
        console.log();
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      } finally {
        pool.closeAll();
      }
    });

  // ── cortex squelch ───────────────────────────────────────
  program
    .command('squelch')
    .argument('[minutes]', 'Minutes to squelch (0 to clear, default: 30)', '30')
    .description('Suppress health alert notifications for maintenance')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (minutes: string, opts: any) => {
      const mins = parseInt(minutes, 10);
      if (isNaN(mins) || mins < 0) {
        console.error(chalk.red('Minutes must be a non-negative number'));
        process.exit(1);
      }
      const { pool, client } = await connectOrDie(opts.address);
      try {
        const untilMs = mins > 0 ? Date.now() + (mins * 60000) : 0;
        const crypto = await import('crypto');
        const sql = mins > 0
          ? `INSERT OR REPLACE INTO timeline_context (key, value, category, label, source, pinned, updated_at) VALUES ('health_squelch_until', ?, 'system', 'Health Alert Squelch', 'cortex-cli', 0, datetime('now'))`
          : `DELETE FROM timeline_context WHERE key = 'health_squelch_until'`;
        const params = mins > 0 ? [String(untilMs)] : [];
        const paramsJson = JSON.stringify(params);
        const checksum = crypto.createHash('sha256').update(sql + paramsJson).digest('hex');

        await client.forwardMemoryWrite({
          sql,
          params: paramsJson,
          checksum,
          classification: 'internal',
          table: 'timeline_context',
        });

        if (mins > 0) {
          const until = new Date(untilMs).toLocaleTimeString();
          console.log(chalk.yellow(`🔇 Alerts squelched for ${mins} minutes (until ${until})`));
        } else {
          console.log(chalk.green(`🔔 Alerts unsquelched — notifications re-enabled`));
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      } finally {
        pool.closeAll();
      }
    });

  // ── cortex switch-leader ──────────────────────────────────
  program
    .command('switch-leader')
    .argument('[name]', 'Node to prefer as next leader (Raft picks)')
    .description('Step down current leader, triggering a new election')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (name: string | undefined, opts: any) => {
      const { pool, client } = await connectOrDie(opts.address);
      try {
        const state = await client.getClusterState();
        const leaderNode = state.nodes.find((n: any) => n.node_id === state.leader_id);
        if (!leaderNode) {
          console.error(chalk.red('No leader found in cluster'));
          process.exit(1);
        }

        if (name) {
          const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
          const target = nodes.find((n: any) => shortName(n.node_id) === name || n.hostname === name);
          if (!target) {
            console.error(chalk.red(`Node "${name}" not found. Available: ${nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
            process.exit(1);
          }
          if (target.node_id === state.leader_id) {
            console.log(chalk.yellow(`${name} is already the leader.`));
            process.exit(0);
          }
        }

        const leaderName = shortName(leaderNode.node_id);
        const leaderAddr = `${leaderNode.tailscale_ip}:${leaderNode.grpc_port}`;

        console.log(`Current leader: ${chalk.green(leaderName)} (term ${state.term})`);
        console.log(`Requesting step-down...`);

        const leaderConn = await connectOrDie(leaderAddr);
        const conn = leaderConn.pool.getConnection(leaderAddr);
        const response: any = await leaderConn.pool.call(
          conn.clusterClient,
          'TransferLeadership',
          { target_node_id: name ?? '' },
        );
        leaderConn.pool.closeAll();

        if (response.success) {
          console.log(chalk.green(`Done. ${response.message}`));
          if (name) {
            console.log(chalk.dim(`(Raft election — ${name} may or may not win)`));
          }
        } else {
          console.error(chalk.red(`Failed: ${response.message}`));
          process.exit(1);
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      } finally {
        pool.closeAll();
      }
    });
}
