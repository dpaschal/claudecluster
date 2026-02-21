/**
 * cortex logs — Cross-node log viewer.
 * Tails journalctl from cortex.service on one or all nodes via SSH.
 */

import chalk from 'chalk';
import { spawn } from 'child_process';
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

const NODE_COLORS = [chalk.cyan, chalk.green, chalk.yellow, chalk.magenta, chalk.blue, chalk.white];

export interface LogsOpts {
  address: string;
  follow?: boolean;
  lines: number;
  node?: string;
  user: string;
  grep?: string;
}

interface NodeTarget {
  name: string;
  ip: string;
  isLocal: boolean;
}

async function resolveNodes(pool: GrpcClientPool, client: ClusterClient, nodeName?: string): Promise<NodeTarget[]> {
  const os = await import('os');
  const localHostname = os.hostname();
  const state = await client.getClusterState();
  let nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));

  if (nodeName) {
    const name = nodeName.toLowerCase();
    nodes = nodes.filter((n: any) => {
      const sn = shortName(n.node_id).toLowerCase();
      const hn = (n.hostname ?? '').toLowerCase();
      return sn === name || hn === name;
    });
  }

  return nodes.map((n: any) => ({
    name: shortName(n.node_id),
    ip: n.tailscale_ip,
    isLocal: n.hostname === localHostname,
  }));
}

export async function runLogs(opts: LogsOpts): Promise<void> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(opts.address, 5000);

  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${opts.address}`));
    process.exit(1);
  }

  const client = new ClusterClient(pool, opts.address);

  try {
    const nodes = await resolveNodes(pool, client, opts.node);

    if (nodes.length === 0) {
      console.error(chalk.red(`Node "${opts.node}" not found`));
      process.exit(1);
    }

    pool.closeAll(); // done with gRPC, switch to SSH

    const children: ReturnType<typeof spawn>[] = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const color = NODE_COLORS[i % NODE_COLORS.length];
      const prefix = color(`[${node.name}]`);

      const journalArgs = [
        'journalctl', '-u', 'cortex.service',
        `-n${opts.lines}`,
        '--no-pager',
        '--output=short-iso',
      ];
      if (opts.follow) journalArgs.push('-f');
      if (opts.grep) journalArgs.push(`--grep=${opts.grep}`);

      let child: ReturnType<typeof spawn>;

      if (node.isLocal) {
        child = spawn('journalctl', journalArgs.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        child = spawn('ssh', [
          '-o', 'ConnectTimeout=5',
          '-o', 'StrictHostKeyChecking=no',
          `${opts.user}@${node.ip}`,
          journalArgs.join(' '),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      }

      children.push(child);

      let buffer = '';
      child.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            console.log(`${prefix} ${line}`);
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error(`${prefix} ${chalk.red(msg)}`);
        }
      });

      child.on('close', (code) => {
        if (!opts.follow && code !== 0 && code !== null) {
          console.error(`${prefix} ${chalk.red(`exited ${code}`)}`);
        }
      });
    }

    // For follow mode, keep running until Ctrl+C
    if (opts.follow) {
      process.on('SIGINT', () => {
        for (const child of children) {
          child.kill();
        }
        console.log();
        process.exit(0);
      });

      // Keep event loop alive
      await new Promise(() => {});
    } else {
      // Wait for all children to finish
      await Promise.all(children.map(child =>
        new Promise<void>(resolve => child.on('close', () => resolve()))
      ));
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
