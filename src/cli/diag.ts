/**
 * cortex diag — Collect diagnostic bundle from all cluster nodes.
 * Like Isilon's isi_gather_info.
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

export interface DiagOpts {
  address: string;
  output?: string;
  user: string;
}

interface NodeTarget {
  name: string;
  ip: string;
  hostname: string;
  isLocal: boolean;
  isLeader: boolean;
}

function runCmd(cmd: string, timeoutMs: number = 15000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    return `[error: ${(err.stderr ?? err.message ?? 'unknown').toString().trim()}]`;
  }
}

function sshCmd(ip: string, user: string, cmd: string): string {
  return runCmd(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${user}@${ip} ${JSON.stringify(cmd)}`);
}

export async function runDiag(opts: DiagOpts): Promise<void> {
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
    const nodes: NodeTarget[] = state.nodes
      .filter((n: any) => !n.node_id.endsWith('-mcp'))
      .map((n: any) => ({
        name: shortName(n.node_id),
        ip: n.tailscale_ip,
        hostname: n.hostname ?? '',
        isLocal: n.hostname === localHostname,
        isLeader: n.node_id === state.leader_id,
      }));

    pool.closeAll();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const diagDir = opts.output ?? path.join(os.tmpdir(), `cortex-diag-${timestamp}`);
    fs.mkdirSync(diagDir, { recursive: true });

    console.log(chalk.bold('\n  Cortex Diagnostics'));
    console.log(chalk.dim(`  Collecting from ${nodes.length} nodes...\n`));

    // Cluster summary
    const summary: Record<string, any> = {
      timestamp: new Date().toISOString(),
      term: state.term,
      leader: state.leader_id ? shortName(state.leader_id) : 'NONE',
      nodes: nodes.map(n => ({ name: n.name, ip: n.ip, leader: n.isLeader })),
      activeTasks: state.active_tasks,
      queuedTasks: state.queued_tasks,
    };
    fs.writeFileSync(path.join(diagDir, 'cluster-summary.json'), JSON.stringify(summary, null, 2));
    console.log(chalk.green('  [cluster] summary'));

    // Per-node diagnostics
    for (const node of nodes) {
      const nodeDir = path.join(diagDir, node.name);
      fs.mkdirSync(nodeDir, { recursive: true });

      const step = (label: string) => process.stdout.write(chalk.dim(`  [${node.name}] ${label}...`));
      const done = () => process.stdout.write(chalk.green(' ok\n'));

      // Service status
      step('service status');
      const serviceStatus = node.isLocal
        ? runCmd('systemctl status cortex.service --no-pager -l 2>&1 || true')
        : sshCmd(node.ip, opts.user, 'systemctl status cortex.service --no-pager -l 2>&1 || true');
      fs.writeFileSync(path.join(nodeDir, 'service-status.txt'), serviceStatus);
      done();

      // Journal logs (last 200 lines)
      step('journal logs');
      const journalCmd = 'journalctl -u cortex.service -n 200 --no-pager --output=short-iso 2>&1 || true';
      const logs = node.isLocal ? runCmd(journalCmd) : sshCmd(node.ip, opts.user, journalCmd);
      fs.writeFileSync(path.join(nodeDir, 'journal.log'), logs);
      done();

      // Disk usage
      step('disk usage');
      const df = node.isLocal
        ? runCmd('df -h / 2>&1')
        : sshCmd(node.ip, opts.user, 'df -h / 2>&1');
      fs.writeFileSync(path.join(nodeDir, 'disk.txt'), df);
      done();

      // Memory info
      step('memory');
      const mem = node.isLocal
        ? runCmd('free -h 2>&1')
        : sshCmd(node.ip, opts.user, 'free -h 2>&1');
      fs.writeFileSync(path.join(nodeDir, 'memory.txt'), mem);
      done();

      // Cortex config
      step('config');
      const configCmd = 'cat /home/paschal/claudecluster/config/default.yaml 2>/dev/null || echo "no config"';
      const config = node.isLocal ? runCmd(configCmd) : sshCmd(node.ip, opts.user, configCmd);
      fs.writeFileSync(path.join(nodeDir, 'config.yaml'), config);
      done();

      // Version
      step('version');
      const versionCmd = 'cat /home/paschal/claudecluster/dist/version.json 2>/dev/null || echo "{}"';
      const version = node.isLocal ? runCmd(versionCmd) : sshCmd(node.ip, opts.user, versionCmd);
      fs.writeFileSync(path.join(nodeDir, 'version.json'), version);
      done();

      // Raft state
      step('raft state');
      const raftCmd = 'cat ~/.cortex/raft-state.json 2>/dev/null || echo "{}"';
      const raftState = node.isLocal ? runCmd(raftCmd) : sshCmd(node.ip, opts.user, raftCmd);
      fs.writeFileSync(path.join(nodeDir, 'raft-state.json'), raftState);
      done();
    }

    // Create tarball
    const tarPath = `${diagDir}.tar.gz`;
    runCmd(`tar -czf ${tarPath} -C ${path.dirname(diagDir)} ${path.basename(diagDir)}`);

    // Cleanup raw directory
    fs.rmSync(diagDir, { recursive: true });

    console.log(chalk.bold.green(`\n  Diagnostic bundle: ${tarPath}`));
    const stat = fs.statSync(tarPath);
    console.log(chalk.dim(`  Size: ${(stat.size / 1024).toFixed(0)} KB, ${nodes.length} nodes\n`));
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
}
