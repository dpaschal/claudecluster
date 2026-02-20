import { EventEmitter } from 'events';
import { Logger } from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { RaftNode, PeerInfo } from './raft.js';
import { MembershipManager, NodeInfo } from './membership.js';
import { GrpcClientPool, AgentClient } from '../grpc/client.js';
import { randomUUID } from 'crypto';

export interface UpdaterConfig {
  membership: MembershipManager;
  raft: RaftNode;
  clientPool: GrpcClientPool;
  logger: Logger;
  selfNodeId: string;
  distDir: string;
  heartbeatIntervalMs?: number;
  /** Called before restarting a node — sends Telegram + wall notification, waits grace period. */
  notifyFn?: (nodeId: string, message: string) => Promise<void>;
  /** Called to squelch/unsquelch health alerts during rolling updates. */
  squelchFn?: (minutes: number) => Promise<void>;
  /** Grace period (ms) to wait after notification before restarting. Default: 30000. */
  preRestartGraceMs?: number;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  nodes: NodeInfo[];
  followers: NodeInfo[];
  quorumSize: number;
  votingCount: number;
}

export interface UpdateProgress {
  phase: 'preflight' | 'add' | 'activate' | 'stabilize' | 'commit' | 'rollback' | 'leader-restart' | 'complete' | 'aborted';
  nodeId?: string;
  message: string;
}

export type UpdateResult = {
  success: boolean;
  nodesUpdated: string[];
  nodesRolledBack: string[];
  error?: string;
};

export class RollingUpdater extends EventEmitter {
  private config: UpdaterConfig;
  private heartbeatMs: number;

  private preRestartGraceMs: number;

  constructor(config: UpdaterConfig) {
    super();
    this.config = config;
    this.heartbeatMs = config.heartbeatIntervalMs ?? 5000;
    this.preRestartGraceMs = config.preRestartGraceMs ?? 30000;
  }

  /**
   * Tap on Shoulder: notify before restarting a node.
   * Sends Telegram notification + wall message on the target node, then waits grace period.
   */
  private async notifyBeforeRestart(node: NodeInfo): Promise<void> {
    const shortName = node.nodeId.split('-')[0];
    const graceSec = Math.round(this.preRestartGraceMs / 1000);
    const msg = `🔄 ISSU: ${shortName} restarting in ${graceSec}s for rolling update. Wrap up any work on this node.`;

    // Send Telegram notification via notifyFn
    if (this.config.notifyFn) {
      try {
        await this.config.notifyFn(node.nodeId, msg);
      } catch (err) {
        this.config.logger.warn('Pre-restart Telegram notification failed', {
          nodeId: node.nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Send wall message on the target node
    try {
      await this.runShellOnNode(node, `wall "${msg}"`, 5000);
    } catch {
      // Best effort — node may not have wall or user sessions
    }

    // Wait grace period
    this.progress('activate', node.nodeId, `Waiting ${graceSec}s grace period before restart...`);
    await this.sleep(this.preRestartGraceMs);
  }

  /**
   * Phase 0: Pre-flight checks.
   * Verifies leader status, quorum safety, and node health.
   */
  async preflight(): Promise<PreflightResult> {
    const { raft, membership, selfNodeId } = this.config;

    // Must be leader
    if (!raft.isLeader()) {
      return {
        ok: false,
        reason: 'Rolling update must be initiated from the leader node',
        nodes: [], followers: [], quorumSize: 0, votingCount: 0,
      };
    }

    // Enumerate nodes
    const allNodes = membership.getAllNodes();
    const followers = allNodes.filter(n => n.nodeId !== selfNodeId);

    // Quorum math
    const votingPeers = raft.getPeers().filter((p: PeerInfo) => p.votingMember);
    const votingCount = votingPeers.length + 1; // +1 for self
    const quorumSize = Math.floor(votingCount / 2) + 1;
    const canLose = votingCount - quorumSize;

    if (canLose < 1) {
      return {
        ok: false,
        reason: `Quorum unsafe: ${votingCount} voting nodes, quorum=${quorumSize}, can lose ${canLose} (need at least 1)`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    // Health gate: all nodes must be active
    const unhealthy = allNodes.filter(n => n.status !== 'active');
    if (unhealthy.length > 0) {
      const names = unhealthy.map(n => `${n.nodeId} (${n.status})`).join(', ');
      return {
        ok: false,
        reason: `Unhealthy nodes: ${names}`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    // Freshness gate: all followers must have recent lastSeen
    const staleThreshold = Date.now() - (this.heartbeatMs * 2);
    const staleNodes = followers.filter(n => n.lastSeen < staleThreshold);
    if (staleNodes.length > 0) {
      const names = staleNodes.map(n => `${n.nodeId} (stale ${Math.round((Date.now() - n.lastSeen) / 1000)}s)`).join(', ');
      return {
        ok: false,
        reason: `Nodes with stale heartbeats: ${names}`,
        nodes: allNodes, followers, quorumSize, votingCount,
      };
    }

    return {
      ok: true,
      nodes: allNodes,
      followers,
      quorumSize,
      votingCount,
    };
  }

  /**
   * Execute a shell command on a remote node via AgentClient.executeTask().
   * Returns stdout, stderr, and exit code.
   */
  async runShellOnNode(
    node: NodeInfo,
    command: string,
    timeoutMs: number = 120000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const agent = new AgentClient(this.config.clientPool, address);

    let stdout = '';
    let stderr = '';
    let exitCode = -1;

    const request = {
      spec: {
        task_id: randomUUID(),
        type: 'TASK_TYPE_SHELL',
        submitter_node: this.config.selfNodeId,
        shell: {
          command,
          working_directory: this.config.distDir.replace('/dist', ''),
        },
        timeout_ms: timeoutMs.toString(),
      },
    };

    for await (const response of agent.executeTask(request)) {
      if (response.output) {
        const data = response.output.data?.toString() ?? '';
        if (response.output.type === 'stdout' || response.output.type === 'TASK_OUTPUT_STDOUT') {
          stdout += data;
        } else {
          stderr += data;
        }
      }
      if (response.status) {
        exitCode = response.status.exit_code ?? -1;
      }
    }

    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }

  /**
   * Phases 1-3 for a single follower: Add (backup+rsync+verify) → Activate (restart+healthcheck+stabilize) → Commit or Rollback.
   */
  async upgradeFollower(node: NodeInfo): Promise<{ success: boolean; rolledBack: boolean; error?: string }> {
    const nodeId = node.nodeId;
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const distDir = this.config.distDir;
    const baseDir = path.dirname(distDir);
    const selfNode = this.config.membership.getAllNodes().find(n => n.nodeId === this.config.selfNodeId);
    const leaderIp = selfNode?.tailscaleIp ?? '127.0.0.1';

    try {
      // --- Phase 1: Add ---

      // Backup
      this.progress('add', nodeId, 'Backing up dist/ to dist.bak/');
      const backup = await this.runShellOnNode(node, `cd ${baseDir} && rm -rf dist.bak && cp -a dist dist.bak`);
      if (backup.exitCode !== 0) {
        return { success: false, rolledBack: false, error: `Backup failed: ${backup.stderr}` };
      }

      // Rsync
      this.progress('add', nodeId, 'Syncing new dist/ from leader');
      const rsync = await this.runShellOnNode(node, `rsync -az --delete ${leaderIp}:${distDir}/ ${distDir}/`);
      if (rsync.exitCode !== 0) {
        this.progress('rollback', nodeId, 'Rsync failed, restoring backup');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: `Rsync failed: ${rsync.stderr}` };
      }

      // Verify
      this.progress('add', nodeId, 'Verifying version.json');
      const verify = await this.runShellOnNode(node, `cat ${distDir}/version.json`);
      if (verify.exitCode !== 0) {
        this.progress('rollback', nodeId, 'Version verify failed, restoring backup');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: `Version verify failed: ${verify.stderr}` };
      }

      // --- Phase 2: Activate ---

      // Tap on Shoulder: notify before restart
      await this.notifyBeforeRestart(node);

      // Restart
      this.progress('activate', nodeId, 'Restarting cortex service');
      try {
        await this.runShellOnNode(node, 'systemctl restart cortex', 10000);
      } catch {
        // Expected: connection drops when the service restarts
        this.progress('activate', nodeId, 'Connection dropped (expected during restart)');
      }

      // Close stale gRPC connection
      this.config.clientPool.closeConnection(address);

      // Poll healthCheck
      this.progress('activate', nodeId, 'Polling health check...');
      const healthy = await this.pollHealthCheck(node, 60000);
      if (!healthy) {
        this.progress('rollback', nodeId, 'Health check timed out, rolling back');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: 'Health check timed out after 60s' };
      }

      // Stabilization
      this.progress('stabilize', nodeId, 'Waiting for stabilization (membership + heartbeats)...');
      const stable = await this.waitForStabilization(node, this.heartbeatMs * 4);
      if (!stable) {
        this.progress('rollback', nodeId, 'Stabilization failed, rolling back');
        await this.rollbackNode(node);
        return { success: false, rolledBack: true, error: 'Node did not stabilize after restart' };
      }

      // --- Phase 3: Commit ---
      this.progress('commit', nodeId, 'Removing dist.bak/ (commit)');
      await this.runShellOnNode(node, `rm -rf ${baseDir}/dist.bak`);

      this.progress('complete', nodeId, 'Upgrade committed successfully');
      return { success: true, rolledBack: false };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.progress('rollback', nodeId, `Unexpected error: ${msg}`);
      try {
        await this.rollbackNode(node);
      } catch {
        // Best effort rollback
      }
      return { success: false, rolledBack: true, error: msg };
    }
  }

  /**
   * Rollback a node: restore dist.bak and restart.
   */
  async rollbackNode(node: NodeInfo): Promise<void> {
    const baseDir = path.dirname(this.config.distDir);
    const address = `${node.tailscaleIp}:${node.grpcPort}`;

    try {
      await this.runShellOnNode(node, `cd ${baseDir} && rm -rf dist && mv dist.bak dist`);
    } catch {
      // If we can't reach the node, try after closing the connection
      this.config.clientPool.closeConnection(address);
      try {
        await this.runShellOnNode(node, `cd ${baseDir} && rm -rf dist && mv dist.bak dist`);
      } catch {
        this.config.logger.error('Failed to rollback node — manual intervention required', { nodeId: node.nodeId });
        return;
      }
    }

    try {
      await this.runShellOnNode(node, 'systemctl restart cortex', 10000);
    } catch {
      // Expected connection drop
    }

    this.config.clientPool.closeConnection(address);
  }

  /**
   * Poll healthCheck until healthy or timeout.
   */
  private async pollHealthCheck(node: NodeInfo, timeoutMs: number): Promise<boolean> {
    const address = `${node.tailscaleIp}:${node.grpcPort}`;
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2000;

    while (Date.now() < deadline) {
      try {
        const agent = new AgentClient(this.config.clientPool, address);
        const response = await agent.healthCheck();
        if (response.healthy) {
          return true;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(pollIntervalMs);
    }

    return false;
  }

  /**
   * Wait for a node to be active in membership with fresh heartbeats.
   */
  private async waitForStabilization(node: NodeInfo, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = this.config.membership.getAllNodes().find(n => n.nodeId === node.nodeId);
      if (current && current.status === 'active') {
        const age = Date.now() - current.lastSeen;
        if (age < this.heartbeatMs * 2) {
          return true;
        }
      }
      await this.sleep(1000);
    }

    return false;
  }

  private progress(phase: UpdateProgress['phase'], nodeId: string, message: string): void {
    const event: UpdateProgress = { phase, nodeId, message };
    this.config.logger.info(`[ISSU] ${phase} ${nodeId}: ${message}`);
    this.emit('progress', event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute the full rolling update (Phases 0-4).
   * dryRun: true runs only preflight and reports results.
   */
  async execute(options: { dryRun?: boolean } = {}): Promise<UpdateResult> {
    const nodesUpdated: string[] = [];
    const nodesRolledBack: string[] = [];

    // Phase 0: Preflight
    this.progress('preflight', this.config.selfNodeId, 'Running pre-flight checks');
    const preflight = await this.preflight();

    if (!preflight.ok) {
      this.progress('aborted', this.config.selfNodeId, `Pre-flight failed: ${preflight.reason}`);
      return { success: false, nodesUpdated, nodesRolledBack, error: preflight.reason };
    }

    this.progress('preflight', this.config.selfNodeId,
      `Pre-flight passed: ${preflight.votingCount} voting nodes, quorum=${preflight.quorumSize}, ${preflight.followers.length} followers to update`);

    if (options.dryRun) {
      return { success: true, nodesUpdated, nodesRolledBack };
    }

    // Auto-squelch health alerts for the duration of the rolling update
    if (this.config.squelchFn) {
      try {
        // Estimate: ~2 min per follower + 1 min leader + buffer
        const estimatedMinutes = Math.max(10, (preflight.followers.length + 1) * 3);
        await this.config.squelchFn(estimatedMinutes);
        this.progress('preflight', this.config.selfNodeId, `Health alerts squelched for ${estimatedMinutes} minutes`);
      } catch {
        // Non-fatal — continue without squelching
      }
    }

    // Phases 1-3: Upgrade each follower sequentially
    for (const follower of preflight.followers) {
      this.progress('add', follower.nodeId, `Starting upgrade (${nodesUpdated.length + 1}/${preflight.followers.length})`);

      const result = await this.upgradeFollower(follower);

      if (result.rolledBack) {
        nodesRolledBack.push(follower.nodeId);
      }

      if (!result.success) {
        this.progress('aborted', this.config.selfNodeId,
          `Aborting rolling update: ${follower.nodeId} failed — ${result.error}`);
        // Unsquelch alerts on abort so real issues are visible
        if (this.config.squelchFn) {
          try { await this.config.squelchFn(0); } catch { /* best effort */ }
        }
        return {
          success: false,
          nodesUpdated,
          nodesRolledBack,
          error: `Failed on ${follower.nodeId}: ${result.error}`,
        };
      }

      nodesUpdated.push(follower.nodeId);
    }

    // Phase 4: Leader self-update
    this.progress('leader-restart', this.config.selfNodeId, 'All followers updated. Restarting leader...');
    await this.upgradeLeader();

    // If we get here, the restart hasn't happened yet (exec is async)
    return { success: true, nodesUpdated, nodesRolledBack };
  }

  /**
   * Phase 4: Leader self-update.
   * Backs up dist/, then restarts own service. The process will die and be restarted by systemd.
   */
  private async upgradeLeader(): Promise<void> {
    const distDir = this.config.distDir;
    const baseDir = path.dirname(distDir);

    // Backup current dist
    const bakDir = path.join(baseDir, 'dist.bak');
    try {
      if (fs.existsSync(bakDir)) {
        fs.rmSync(bakDir, { recursive: true });
      }
      fs.cpSync(distDir, bakDir, { recursive: true });
    } catch (error) {
      this.config.logger.warn('Failed to create leader backup', { error });
      // Continue anyway — the build is already in place
    }

    // Tap on Shoulder: notify before leader restart
    const selfNode = this.config.membership.getAllNodes().find(n => n.nodeId === this.config.selfNodeId);
    if (selfNode) {
      await this.notifyBeforeRestart(selfNode);
    }

    // Restart self via systemctl. This will kill our process.
    this.progress('leader-restart', this.config.selfNodeId, 'Executing systemctl restart cortex');
    exec('systemctl restart cortex');
  }
}
