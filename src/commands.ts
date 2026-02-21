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
          ? `INSERT OR REPLACE INTO timeline_context (key, value, category, label, source, pinned, updated_at) VALUES ('health_squelch_until', ?, 'machine', 'Health Alert Squelch', 'cortex-cli', 0, datetime('now'))`
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

  // ── cortex test ────────────────────────────────────────
  program
    .command('test')
    .description('Run cluster integration tests')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('--failover', 'Include leader failover test (destructive)')
    .option('--bot', 'Include Telegram bot test')
    .action(async (opts) => {
      const { runClusterTests, printResults } = await import('./cli/test-runner.js');
      const results = await runClusterTests({
        address: opts.address,
        failover: opts.failover,
        bot: opts.bot,
      });
      printResults(results);
      const failed = results.some(r => !r.passed);
      process.exit(failed ? 1 : 0);
    });

  // ── cortex events ──────────────────────────────────────
  program
    .command('events')
    .description('Show cluster event history')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('--since <duration>', 'Time window (e.g. 1h, 30m, 7d)', '24h')
    .option('-t, --type <type>', 'Filter by type (election, node_join, task_failed, etc.)')
    .option('-n, --limit <count>', 'Max events to show', '50')
    .action(async (opts) => {
      const { runEvents } = await import('./cli/events.js');
      await runEvents({
        address: opts.address,
        since: opts.since,
        type: opts.type,
        limit: parseInt(opts.limit, 10),
      });
    });

  // ── cortex top ────────────────────────────────────────
  program
    .command('top')
    .description('Live cluster resource dashboard')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('-1, --once', 'Print once and exit (no refresh)')
    .option('-i, --interval <seconds>', 'Refresh interval', '2')
    .action(async (opts) => {
      const { runTop } = await import('./cli/top.js');
      await runTop({
        address: opts.address,
        once: opts.once,
        interval: parseInt(opts.interval, 10),
      });
    });

  // ── cortex run ────────────────────────────────────────
  program
    .command('run')
    .argument('<command>', 'Command to execute on nodes')
    .description('Run a command across all cluster nodes')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('--nodes <list>', 'Comma-separated node names (default: all active)')
    .option('--user <user>', 'SSH user', 'paschal')
    .action(async (command: string, opts: any) => {
      const { runRun } = await import('./cli/run.js');
      await runRun({
        address: opts.address,
        nodes: opts.nodes,
        user: opts.user,
        command,
      });
    });

  // ── cortex ssh ────────────────────────────────────────
  program
    .command('ssh')
    .argument('<node>', 'Node name to SSH into')
    .description('SSH into a cluster node by name')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('--user <user>', 'SSH user', 'paschal')
    .action(async (nodeName: string, opts: any) => {
      const { pool, client } = await connectOrDie(opts.address);
      try {
        const state = await client.getClusterState();
        const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
        const target = nodes.find((n: any) => {
          const sn = shortName(n.node_id).toLowerCase();
          const hn = (n.hostname ?? '').toLowerCase();
          return sn === nodeName.toLowerCase() || hn === nodeName.toLowerCase();
        });
        if (!target) {
          console.error(chalk.red(`Node "${nodeName}" not found. Available: ${nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
          process.exit(1);
        }
        pool.closeAll();
        const { execSync } = await import('child_process');
        execSync(`ssh -o StrictHostKeyChecking=no ${opts.user}@${target.tailscale_ip}`, { stdio: 'inherit' });
      } catch (err: any) {
        if (err.status !== undefined) process.exit(err.status); // SSH exit code
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      } finally {
        pool.closeAll();
      }
    });

  // ── cortex logs ───────────────────────────────────────
  program
    .command('logs')
    .argument('[node]', 'Node name (default: all nodes)')
    .description('Tail cortex service logs from cluster nodes')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <count>', 'Number of lines to show', '50')
    .option('--user <user>', 'SSH user', 'paschal')
    .option('--grep <pattern>', 'Filter log lines by pattern')
    .action(async (nodeName: string | undefined, opts: any) => {
      const { runLogs } = await import('./cli/logs.js');
      await runLogs({
        address: opts.address,
        follow: opts.follow,
        lines: parseInt(opts.lines, 10),
        node: nodeName,
        user: opts.user,
        grep: opts.grep,
      });
    });

  // ── cortex drain ──────────────────────────────────────
  program
    .command('drain')
    .argument('<node>', 'Node to drain tasks from')
    .description('Drain all tasks from a node (reschedule to others)')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (nodeName: string, opts: any) => {
      const { runDrain } = await import('./cli/node-ops.js');
      await runDrain(nodeName, { address: opts.address });
    });

  // ── cortex cordon ─────────────────────────────────────
  program
    .command('cordon')
    .argument('<node>', 'Node to cordon (disable scheduling)')
    .description('Mark a node as unschedulable')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (nodeName: string, opts: any) => {
      const { runCordon } = await import('./cli/node-ops.js');
      await runCordon(nodeName, { address: opts.address });
    });

  // ── cortex uncordon ───────────────────────────────────
  program
    .command('uncordon')
    .argument('<node>', 'Node to uncordon (re-enable scheduling)')
    .description('Re-enable scheduling on a cordoned node')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .action(async (nodeName: string, opts: any) => {
      const { runUncordon } = await import('./cli/node-ops.js');
      await runUncordon(nodeName, { address: opts.address });
    });

  // ── cortex tasks ──────────────────────────────────────
  {
    const tasksCmd = program
      .command('tasks')
      .description('Task management (list, view, cancel)');

    tasksCmd
      .command('list')
      .description('List tasks')
      .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
      .option('--state <state>', 'Filter by state (queued, running, completed, failed)')
      .option('-n, --limit <count>', 'Max tasks to show', '25')
      .action(async (opts: any) => {
        const { runTasksList } = await import('./cli/tasks.js');
        await runTasksList({ address: opts.address, state: opts.state, limit: parseInt(opts.limit, 10) });
      });

    tasksCmd
      .command('view')
      .argument('<id>', 'Task ID')
      .description('Show task details')
      .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
      .action(async (taskId: string, opts: any) => {
        const { runTasksView } = await import('./cli/tasks.js');
        await runTasksView(taskId, { address: opts.address });
      });

    tasksCmd
      .command('cancel')
      .argument('<id>', 'Task ID')
      .description('Cancel a running or queued task')
      .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
      .action(async (taskId: string, opts: any) => {
        const { runTasksCancel } = await import('./cli/tasks.js');
        await runTasksCancel(taskId, { address: opts.address });
      });
  }

  // ── cortex snapshot ───────────────────────────────────
  {
    const snapCmd = program
      .command('snapshot')
      .description('Manage shared memory snapshots');

    snapCmd
      .command('create')
      .argument('[name]', 'Snapshot name (default: timestamped)')
      .description('Create a snapshot of the shared memory database')
      .action(async (name?: string) => {
        const { runSnapshotCreate } = await import('./cli/snapshot.js');
        await runSnapshotCreate(name);
      });

    snapCmd
      .command('list')
      .description('List available snapshots')
      .action(async () => {
        const { runSnapshotList } = await import('./cli/snapshot.js');
        await runSnapshotList();
      });

    snapCmd
      .command('restore')
      .argument('<name>', 'Snapshot name or path')
      .description('Restore shared memory from a snapshot')
      .action(async (name: string) => {
        const { runSnapshotRestore } = await import('./cli/snapshot.js');
        await runSnapshotRestore(name);
      });
  }

  // ── cortex diag ───────────────────────────────────────
  program
    .command('diag')
    .description('Collect diagnostic bundle from all cluster nodes')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('-o, --output <path>', 'Output directory (default: /tmp/cortex-diag-<timestamp>)')
    .option('--user <user>', 'SSH user', 'paschal')
    .action(async (opts) => {
      const { runDiag } = await import('./cli/diag.js');
      await runDiag({ address: opts.address, output: opts.output, user: opts.user });
    });

  // ── cortex config ─────────────────────────────────────
  {
    const configCmd = program
      .command('config')
      .description('View and compare node configuration');

    configCmd
      .command('show')
      .description('Show local node configuration')
      .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
      .option('--user <user>', 'SSH user', 'paschal')
      .action(async (opts: any) => {
        const { runConfigShow } = await import('./cli/config.js');
        await runConfigShow({ address: opts.address, user: opts.user });
      });

    configCmd
      .command('diff')
      .description('Compare configuration across all nodes')
      .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
      .option('--user <user>', 'SSH user', 'paschal')
      .action(async (opts: any) => {
        const { runConfigDiff } = await import('./cli/config.js');
        await runConfigDiff({ address: opts.address, user: opts.user });
      });
  }

  // ── cortex deploy ───────────────────────────────────────
  program
    .command('deploy')
    .description('Build, sync, and rolling-restart the cluster')
    .option('-a, --address <addr>', 'gRPC address', 'localhost:50051')
    .option('--no-build', 'Skip the build step')
    .option('--squelch <minutes>', 'Alert squelch duration', '10')
    .option('--pause <seconds>', 'Pause between restarts', '15')
    .option('--dist <path>', 'Local dist directory', process.cwd() + '/dist')
    .option('--remote-dist <path>', 'Remote dist directory', '/home/paschal/claudecluster/dist')
    .option('--user <user>', 'SSH user for remote nodes', 'paschal')
    .action(async (opts) => {
      const { execSync } = await import('child_process');
      const os = await import('os');
      const localHostname = os.hostname();
      const pauseMs = parseInt(opts.pause, 10) * 1000;
      const squelchMins = parseInt(opts.squelch, 10);

      const run = (cmd: string, label: string): boolean => {
        try {
          execSync(cmd, { stdio: 'inherit', timeout: 120000 });
          return true;
        } catch {
          console.error(chalk.red(`  ✗ ${label} failed`));
          return false;
        }
      };

      const step = (msg: string) => console.log(chalk.cyan(`\n  ▸ ${msg}`));
      const ok = (msg: string) => console.log(chalk.green(`  ✓ ${msg}`));
      const skip = (msg: string) => console.log(chalk.dim(`  ⊘ ${msg}`));

      console.log(chalk.bold('\n  Cortex Deploy\n'));

      // Step 1: Build
      if (opts.build) {
        step('Building...');
        if (!run('npm run build', 'build')) process.exit(1);
        ok('Build complete');
      } else {
        skip('Build skipped (--no-build)');
      }

      // Step 2: Get cluster state
      step('Fetching cluster state...');
      const { pool, client } = await connectOrDie(opts.address);
      let state: any;
      try {
        state = await client.getClusterState();
      } catch (err: any) {
        console.error(chalk.red(`  ✗ Cannot get cluster state: ${err.message}`));
        pool.closeAll();
        process.exit(1);
      }
      pool.closeAll();

      const nodes = state.nodes
        .filter((n: any) => !n.node_id.endsWith('-mcp'))
        .map((n: any) => ({
          id: n.node_id,
          name: shortName(n.node_id),
          hostname: n.hostname,
          ip: n.tailscale_ip,
          isLeader: n.node_id === state.leader_id,
          isLocal: n.hostname === localHostname,
        }));

      const followers = nodes.filter((n: any) => !n.isLeader);
      const leader = nodes.find((n: any) => n.isLeader);

      ok(`${nodes.length} nodes, leader: ${leader?.name ?? 'NONE'}`);

      // Step 3: Squelch
      step(`Squelching alerts (${squelchMins}m)...`);
      run(`cctl squelch ${squelchMins}`, 'squelch');

      // Step 4: Rsync to remote nodes
      step('Syncing dist/ to remote nodes...');
      const remoteNodes = nodes.filter((n: any) => !n.isLocal);
      for (const node of remoteNodes) {
        const dest = `${opts.user}@${node.ip}:${opts.remoteDist}/`;
        const rsyncOk = run(
          `rsync -az --delete "${opts.dist}/" "${dest}"`,
          `rsync → ${node.name}`,
        );
        if (rsyncOk) {
          ok(`cortex@${node.name} synced`);
        }
      }

      // Step 5: Rolling restart — followers first, leader last
      step('Rolling restart...');
      const restartOrder = [...followers, ...(leader ? [leader] : [])];

      for (let i = 0; i < restartOrder.length; i++) {
        const node = restartOrder[i];
        const label = node.isLeader ? `cortex@${node.name} (leader)` : `cortex@${node.name}`;

        if (node.isLocal) {
          run('sudo systemctl restart cortex', label);
        } else {
          run(
            `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${opts.user}@${node.ip} "sudo systemctl restart cortex"`,
            label,
          );
        }
        ok(`${label} restarted`);

        // Pause between restarts (skip after last node)
        if (i < restartOrder.length - 1) {
          process.stdout.write(chalk.dim(`    waiting ${opts.pause}s...`));
          await new Promise(r => setTimeout(r, pauseMs));
          process.stdout.write(chalk.dim(' done\n'));
        }
      }

      // Step 6: Verify
      step('Verifying (waiting for cluster to settle)...');
      await new Promise(r => setTimeout(r, 15000)); // let the cluster settle after leader restart
      run('cctl status', 'status');

      // Step 7: Unsquelch
      step('Unsquelching alerts...');
      run('cctl squelch 0', 'unsquelch');

      console.log(chalk.bold.green('\n  Deploy complete ✓\n'));
    });
}
