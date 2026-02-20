import { Plugin, PluginContext, ToolHandler } from '../types.js';

interface HealthAlert {
  level: 'warning' | 'critical';
  message: string;
  timestamp: string;
}

interface TermSample {
  term: number;
  timestamp: number;
}

export class ClusterHealthPlugin implements Plugin {
  name = 'cluster-health';
  version = '1.0.0';

  private ctx: PluginContext | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private tools: Map<string, ToolHandler> = new Map();

  // Track term velocity
  private termHistory: TermSample[] = [];
  private lastAlertedTerm = 0;
  private lastLeaderCheck = 0;
  private noLeaderSince = 0;
  private becameLeaderAt = 0;       // Timestamp when this node became leader

  // Config defaults
  private intervalMs = 15000;        // Check every 15s
  private termWindowMs = 300000;     // 5-minute window for term velocity
  private termVelocityThreshold = 5; // >5 elections in 5 min = alert
  private noLeaderAlertMs = 30000;   // Alert if no leader for 30s
  private alertCooldownMs = 300000;  // Don't repeat same alert within 5 min
  private leaderGracePeriodMs = 60000; // Wait 60s after becoming leader before alerting
  private lastAlerts: Map<string, number> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Apply config overrides
    const cfg = ctx.config;
    if (cfg.intervalMs) this.intervalMs = cfg.intervalMs as number;
    if (cfg.termVelocityThreshold) this.termVelocityThreshold = cfg.termVelocityThreshold as number;
    if (cfg.noLeaderAlertMs) this.noLeaderAlertMs = cfg.noLeaderAlertMs as number;

    this.tools = new Map([
      ['cluster_health', {
        description: 'Get cluster health report including leader stability, term velocity, node status, and recent alerts',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
        handler: async () => this.getHealthReport(),
      }],
    ]);
  }

  async start(): Promise<void> {
    if (!this.ctx) return;

    // Record initial term
    this.recordTerm(this.ctx.raft.getCurrentTerm());

    // Listen for term changes (every stateChange includes the term)
    this.ctx.raft.on('stateChange', (_state: string, term: number) => {
      if (term) this.recordTerm(term);
    });

    // Periodic health check — runs on ALL nodes but only alerts on leader
    this.checkInterval = setInterval(() => this.runHealthCheck(), this.intervalMs);

    this.ctx.logger.info('Cluster health monitor started', {
      intervalMs: this.intervalMs,
      termVelocityThreshold: this.termVelocityThreshold,
    });
  }

  async stop(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.tools = new Map();
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  private recordTerm(term: number): void {
    const now = Date.now();
    this.termHistory.push({ term, timestamp: now });
    // Prune old samples
    const cutoff = now - this.termWindowMs;
    this.termHistory = this.termHistory.filter(s => s.timestamp >= cutoff);
  }

  private getTermVelocity(): { elections: number; windowMs: number; termsPerMin: number } {
    const now = Date.now();
    const cutoff = now - this.termWindowMs;
    const recent = this.termHistory.filter(s => s.timestamp >= cutoff);

    // Count unique terms (each new term = one election)
    const uniqueTerms = new Set(recent.map(s => s.term));
    const elections = Math.max(0, uniqueTerms.size - 1); // -1 because first sample isn't an election
    const windowMin = this.termWindowMs / 60000;
    return {
      elections,
      windowMs: this.termWindowMs,
      termsPerMin: elections / windowMin,
    };
  }

  private async runHealthCheck(): Promise<void> {
    if (!this.ctx) return;

    const isLeader = this.ctx.raft.isLeader();
    const now = Date.now();

    // Always track term regardless of role
    this.recordTerm(this.ctx.raft.getCurrentTerm());

    // Only the leader sends alerts (avoids duplicate alerts from all nodes)
    if (!isLeader) {
      this.noLeaderSince = 0;
      this.becameLeaderAt = 0;
      return;
    }

    // Track when we became leader — don't alert during grace period (rolling restarts)
    if (this.becameLeaderAt === 0) {
      this.becameLeaderAt = now;
    }
    if (now - this.becameLeaderAt < this.leaderGracePeriodMs) {
      return; // Grace period — peers still catching up
    }

    const alerts: HealthAlert[] = [];

    // 1. Term velocity check
    const velocity = this.getTermVelocity();
    if (velocity.elections >= this.termVelocityThreshold) {
      alerts.push({
        level: 'critical',
        message: `Election storm: ${velocity.elections} elections in ${Math.round(velocity.windowMs / 60000)}min (${velocity.termsPerMin.toFixed(1)}/min). Cluster may be unstable.`,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Peer liveness check (uses Raft matchIndex — more reliable than membership lastSeen)
    const peers = this.ctx.raft.getPeers();
    const commitIndex = this.ctx.raft.getCommitIndex();
    const votingPeers = peers.filter(p => p.votingMember);

    // A peer is "alive" if matchIndex > 0 (has successfully replicated at least once)
    // A peer is "unresponsive" if matchIndex is 0 AND commitIndex > 0 (never caught up)
    const unresponsivePeers = peers.filter(p => p.matchIndex === 0 && commitIndex > 0);
    if (unresponsivePeers.length > 0) {
      const names = unresponsivePeers.map(p => p.nodeId.split('-')[0]).join(', ');
      alerts.push({
        level: 'warning',
        message: `Unresponsive peers: ${names} (${unresponsivePeers.length}/${peers.length} not replicating)`,
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Quorum check (based on Raft peers that have replicated)
    const alivePeers = peers.filter(p => p.matchIndex > 0);
    const totalVoting = votingPeers.length + 1; // +1 for self (leader)
    const aliveVoting = alivePeers.filter(p => p.votingMember).length + 1; // +1 for self
    const quorumSize = Math.floor(totalVoting / 2) + 1;
    if (aliveVoting < quorumSize) {
      alerts.push({
        level: 'critical',
        message: `Quorum at risk: ${aliveVoting} alive voting nodes, need ${quorumSize} for quorum (${totalVoting} total)`,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Replication lag check (leader only)
    for (const peer of peers) {
      if (peer.matchIndex > 0 && peer.matchIndex < commitIndex - 10) {
        alerts.push({
          level: 'warning',
          message: `Replication lag: ${peer.nodeId} is ${commitIndex - peer.matchIndex} entries behind (matchIndex=${peer.matchIndex}, commitIndex=${commitIndex})`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Send alerts via Telegram (deduped with cooldown)
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }
  }

  private async sendAlert(alert: HealthAlert): Promise<void> {
    if (!this.ctx) return;

    // Cooldown: don't repeat the same alert key within cooldownMs
    const alertKey = `${alert.level}:${alert.message.slice(0, 50)}`;
    const now = Date.now();
    const lastSent = this.lastAlerts.get(alertKey) ?? 0;
    if (now - lastSent < this.alertCooldownMs) return;
    this.lastAlerts.set(alertKey, now);

    // Prune old cooldown entries
    for (const [key, ts] of this.lastAlerts) {
      if (now - ts > this.alertCooldownMs * 2) this.lastAlerts.delete(key);
    }

    const prefix = alert.level === 'critical' ? '🔴 CRITICAL' : '⚠️ WARNING';
    const msg = `${prefix}\n${alert.message}`;

    this.ctx.logger.warn('Cluster health alert', { level: alert.level, message: alert.message });

    // Send via Telegram using messaging_notify tool
    try {
      const tools = this.ctx.getTools?.();
      const notifyTool = tools?.get('messaging_notify');
      if (notifyTool) {
        await notifyTool.handler({ message: msg });
      }
    } catch (err) {
      this.ctx.logger.error('Failed to send health alert via Telegram', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async getHealthReport(): Promise<Record<string, unknown>> {
    if (!this.ctx) return { error: 'Plugin not initialized' };

    const raft = this.ctx.raft;
    const membership = this.ctx.membership;
    const velocity = this.getTermVelocity();
    const peers = raft.getPeers();
    const commitIndex = raft.getCommitIndex();

    // Raft-based liveness: matchIndex > 0 means peer has replicated
    const alivePeers = peers.filter(p => p.matchIndex > 0);
    const unresponsivePeers = peers.filter(p => p.matchIndex === 0 && commitIndex > 0);
    const votingPeers = peers.filter(p => p.votingMember);
    const totalVoting = votingPeers.length + 1; // +1 for self
    const aliveVoting = alivePeers.filter(p => p.votingMember).length + 1;
    const quorumNeeded = Math.floor(totalVoting / 2) + 1;

    // Replication status
    const replication = peers.map(p => ({
      nodeId: p.nodeId,
      matchIndex: p.matchIndex,
      lag: commitIndex - p.matchIndex,
      voting: p.votingMember,
      alive: p.matchIndex > 0 || commitIndex === 0,
    }));

    return {
      timestamp: new Date().toISOString(),
      leader: {
        nodeId: raft.getLeaderId(),
        isLeader: raft.isLeader(),
        term: raft.getCurrentTerm(),
        state: raft.getState(),
      },
      termVelocity: {
        elections: velocity.elections,
        windowMinutes: Math.round(velocity.windowMs / 60000),
        electionsPerMinute: parseFloat(velocity.termsPerMin.toFixed(2)),
        threshold: this.termVelocityThreshold,
        status: velocity.elections >= this.termVelocityThreshold ? 'UNSTABLE' : 'STABLE',
      },
      peers: {
        total: peers.length,
        alive: alivePeers.length,
        unresponsive: unresponsivePeers.length,
        unresponsiveNames: unresponsivePeers.map(p => p.nodeId),
      },
      replication,
      quorum: {
        votingMembers: totalVoting,
        aliveVoting,
        needed: quorumNeeded,
        healthy: aliveVoting >= quorumNeeded,
      },
      overallStatus: this.computeOverallStatus(velocity, unresponsivePeers.length, aliveVoting, quorumNeeded),
    };
  }

  private computeOverallStatus(
    velocity: { elections: number },
    unresponsiveCount: number,
    aliveVoting: number,
    quorumNeeded: number,
  ): 'HEALTHY' | 'DEGRADED' | 'CRITICAL' {
    if (aliveVoting < quorumNeeded) return 'CRITICAL';
    if (velocity.elections >= this.termVelocityThreshold) return 'CRITICAL';
    if (unresponsiveCount > 0) return 'DEGRADED';
    return 'HEALTHY';
  }
}
