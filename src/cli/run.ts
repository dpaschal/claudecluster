/**
 * cortex run — Execute a command across cluster nodes in parallel.
 * Like Isilon's isi_for_array.
 */

import chalk from 'chalk';
import { execSync } from 'child_process';
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

// Rotate through colors for per-node output
const NODE_COLORS = [chalk.cyan, chalk.green, chalk.yellow, chalk.magenta, chalk.blue, chalk.white];

export interface RunOpts {
  address: string;
  nodes?: string;
  user: string;
  command: string;
}

interface NodeTarget {
  name: string;
  ip: string;
  isLocal: boolean;
}

async function resolveNodes(pool: GrpcClientPool, client: ClusterClient, filter?: string): Promise<NodeTarget[]> {
  const os = await import('os');
  const localHostname = os.hostname();
  const state = await client.getClusterState();
  let nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp') && n.status?.includes('ACTIVE'));

  if (filter) {
    const names = filter.split(',').map(s => s.trim().toLowerCase());
    nodes = nodes.filter((n: any) => {
      const sn = shortName(n.node_id).toLowerCase();
      const hn = (n.hostname ?? '').toLowerCase();
      return names.some(name => sn === name || hn === name);
    });
  }

  return nodes.map((n: any) => ({
    name: shortName(n.node_id),
    ip: n.tailscale_ip,
    isLocal: n.hostname === localHostname,
  }));
}

function runOnNode(node: NodeTarget, command: string, user: string): { stdout: string; stderr: string; exitCode: number } {
  const cmd = node.isLocal
    ? command
    : `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${user}@${node.ip} ${JSON.stringify(command)}`;

  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trimEnd(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString().trimEnd(),
      stderr: (err.stderr ?? '').toString().trimEnd(),
      exitCode: err.status ?? 1,
    };
  }
}

export async function runRun(opts: RunOpts): Promise<void> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(opts.address, 5000);

  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${opts.address}`));
    process.exit(1);
  }

  const client = new ClusterClient(pool, opts.address);

  try {
    const nodes = await resolveNodes(pool, client, opts.nodes);

    if (nodes.length === 0) {
      console.error(chalk.red('No matching nodes found'));
      process.exit(1);
    }

    console.log(chalk.dim(`\n  Running on ${nodes.length} node(s): ${nodes.map(n => n.name).join(', ')}\n`));

    let anyFailed = false;

    // Run sequentially to keep output clean (parallel would interleave)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const color = NODE_COLORS[i % NODE_COLORS.length];
      const prefix = color(`[${node.name}]`);

      const result = runOnNode(node, opts.command, opts.user);

      if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
          console.log(`  ${prefix} ${line}`);
        }
      }
      if (result.stderr) {
        for (const line of result.stderr.split('\n')) {
          console.log(`  ${prefix} ${chalk.red(line)}`);
        }
      }
      if (result.exitCode !== 0) {
        console.log(`  ${prefix} ${chalk.red(`exit ${result.exitCode}`)}`);
        anyFailed = true;
      }
    }

    console.log();
    process.exit(anyFailed ? 1 : 0);
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}
