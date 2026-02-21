/**
 * cortex config — View and compare configuration across nodes.
 */

import chalk from 'chalk';
import { execSync } from 'child_process';
import { GrpcClientPool, ClusterClient } from '../grpc/client.js';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function shortName(nodeId: string): string {
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  return parts.slice(0, -1).join('-');
}

const CONFIG_PATH = '/home/paschal/claudecluster/config/default.yaml';

export interface ConfigOpts {
  address: string;
  user: string;
}

function runCmd(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    return `[error: ${(err.stderr ?? err.message ?? 'unknown').toString().trim()}]`;
  }
}

export async function runConfigShow(opts: ConfigOpts): Promise<void> {
  // Read local config
  const localConfig = CONFIG_PATH;

  if (!fs.existsSync(localConfig)) {
    console.error(chalk.red(`Config not found at ${localConfig}`));
    process.exit(1);
  }

  const content = fs.readFileSync(localConfig, 'utf-8');

  console.log(chalk.bold('\n  Cortex Configuration'));
  console.log(chalk.dim(`  Source: ${localConfig}\n`));
  console.log(content);
}

export async function runConfigDiff(opts: ConfigOpts): Promise<void> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(opts.address, 5000);

  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${opts.address}`));
    process.exit(1);
  }

  const client = new ClusterClient(pool, opts.address);
  const localHostname = os.hostname();

  try {
    const state = await client.getClusterState();
    const nodes = state.nodes
      .filter((n: any) => !n.node_id.endsWith('-mcp'))
      .map((n: any) => ({
        name: shortName(n.node_id),
        ip: n.tailscale_ip,
        hostname: n.hostname ?? '',
        isLocal: n.hostname === localHostname,
      }));

    pool.closeAll();

    console.log(chalk.bold('\n  Cortex Config Diff'));
    console.log(chalk.dim(`  Comparing ${CONFIG_PATH} across ${nodes.length} nodes\n`));

    // Fetch config from each node
    const configs: Map<string, string> = new Map();
    for (const node of nodes) {
      const config = node.isLocal
        ? (fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8').trim() : '[not found]')
        : runCmd(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${opts.user}@${node.ip} "cat ${CONFIG_PATH} 2>/dev/null || echo '[not found]'"`);
      configs.set(node.name, config);
    }

    // Compare: group nodes by config content
    const groups = new Map<string, string[]>();
    for (const [name, config] of configs) {
      const existing = [...groups.entries()].find(([k]) => k === config);
      if (existing) {
        existing[1].push(name);
      } else {
        groups.set(config, [name]);
      }
    }

    if (groups.size === 1) {
      const nodeList = [...groups.values()][0].join(', ');
      console.log(chalk.green(`  All nodes identical: ${nodeList}`));
      console.log();
      return;
    }

    // Show differences
    console.log(chalk.yellow(`  ${groups.size} different configurations found:\n`));

    let groupNum = 0;
    for (const [config, nodeNames] of groups) {
      groupNum++;
      const color = groupNum === 1 ? chalk.green : chalk.yellow;
      console.log(color(`  Group ${groupNum}: ${nodeNames.join(', ')}`));

      if (config === '[not found]') {
        console.log(chalk.dim('    (config file not found)'));
      } else {
        // Show first 10 lines as preview
        const lines = config.split('\n');
        const preview = lines.slice(0, 10);
        for (const line of preview) {
          console.log(chalk.dim(`    ${line}`));
        }
        if (lines.length > 10) {
          console.log(chalk.dim(`    ... (${lines.length - 10} more lines)`));
        }
      }
      console.log();
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
