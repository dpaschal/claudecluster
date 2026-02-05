import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

const execAsync = promisify(exec);

export interface TailscaleNode {
  id: string;
  hostname: string;
  ip: string;
  online: boolean;
  os: string;
  tags: string[];
  lastSeen: Date;
  self: boolean;
}

export interface TailscaleStatus {
  selfIP: string;
  selfHostname: string;
  tailnetName: string;
  magicDNSSuffix: string;
  nodes: TailscaleNode[];
}

export interface TailscaleDiscoveryConfig {
  logger: Logger;
  clusterTag?: string;
  pollIntervalMs?: number;
}

export class TailscaleDiscovery extends EventEmitter {
  private config: TailscaleDiscoveryConfig;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastStatus: TailscaleStatus | null = null;
  private knownNodes: Map<string, TailscaleNode> = new Map();
  private clusterTag: string;

  constructor(config: TailscaleDiscoveryConfig) {
    super();
    this.config = config;
    this.clusterTag = config.clusterTag ?? 'claudecluster';
  }

  async start(): Promise<void> {
    // Initial poll
    await this.poll();

    // Start polling
    const interval = this.config.pollIntervalMs ?? 30000;
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.config.logger.info('Tailscale discovery started', { pollIntervalMs: interval });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.config.logger.info('Tailscale discovery stopped');
    }
  }

  getStatus(): TailscaleStatus | null {
    return this.lastStatus;
  }

  getSelfIP(): string | null {
    return this.lastStatus?.selfIP ?? null;
  }

  getSelfHostname(): string | null {
    return this.lastStatus?.selfHostname ?? null;
  }

  getClusterNodes(): TailscaleNode[] {
    if (!this.lastStatus) return [];
    return this.lastStatus.nodes.filter(n =>
      n.tags.includes(`tag:${this.clusterTag}`) && n.online && !n.self
    );
  }

  async poll(): Promise<void> {
    try {
      const status = await this.fetchStatus();
      this.lastStatus = status;

      // Detect new and removed nodes
      const currentNodeIds = new Set(status.nodes.map(n => n.id));
      const clusterNodes = status.nodes.filter(n =>
        n.tags.includes(`tag:${this.clusterTag}`) && !n.self
      );

      for (const node of clusterNodes) {
        const existing = this.knownNodes.get(node.id);

        if (!existing) {
          // New node discovered
          this.knownNodes.set(node.id, node);
          if (node.online) {
            this.config.logger.info('Discovered new cluster node', {
              hostname: node.hostname,
              ip: node.ip,
            });
            this.emit('nodeDiscovered', node);
          }
        } else if (!existing.online && node.online) {
          // Node came online
          this.knownNodes.set(node.id, node);
          this.config.logger.info('Cluster node came online', {
            hostname: node.hostname,
            ip: node.ip,
          });
          this.emit('nodeOnline', node);
        } else if (existing.online && !node.online) {
          // Node went offline
          this.knownNodes.set(node.id, node);
          this.config.logger.info('Cluster node went offline', {
            hostname: node.hostname,
            ip: node.ip,
          });
          this.emit('nodeOffline', node);
        }
      }

      // Check for removed nodes
      for (const [id, node] of this.knownNodes) {
        if (!currentNodeIds.has(id)) {
          this.knownNodes.delete(id);
          this.config.logger.info('Cluster node removed', {
            hostname: node.hostname,
            ip: node.ip,
          });
          this.emit('nodeRemoved', node);
        }
      }
    } catch (error) {
      this.config.logger.error('Tailscale discovery poll failed', { error });
      this.emit('error', error);
    }
  }

  private async fetchStatus(): Promise<TailscaleStatus> {
    const { stdout } = await execAsync('tailscale status --json');
    const data = JSON.parse(stdout);

    const nodes: TailscaleNode[] = [];

    // Self node
    if (data.Self) {
      nodes.push(this.parseNode(data.Self, true));
    }

    // Peer nodes
    if (data.Peer) {
      for (const peer of Object.values(data.Peer) as Array<Record<string, unknown>>) {
        nodes.push(this.parseNode(peer, false));
      }
    }

    return {
      selfIP: data.Self?.TailscaleIPs?.[0] ?? '',
      selfHostname: data.Self?.HostName ?? '',
      tailnetName: data.CurrentTailnet?.Name ?? '',
      magicDNSSuffix: data.MagicDNSSuffix ?? '',
      nodes,
    };
  }

  private parseNode(data: Record<string, unknown>, self: boolean): TailscaleNode {
    const ips = data.TailscaleIPs as string[] | undefined;

    return {
      id: data.ID as string ?? '',
      hostname: data.HostName as string ?? '',
      ip: ips?.[0] ?? '',
      online: data.Online as boolean ?? false,
      os: data.OS as string ?? '',
      tags: (data.Tags as string[] ?? []).map(t => t.toLowerCase()),
      lastSeen: data.LastSeen ? new Date(data.LastSeen as string) : new Date(),
      self,
    };
  }

  // Check if Tailscale is available and connected
  static async isAvailable(): Promise<boolean> {
    try {
      await execAsync('tailscale status --json');
      return true;
    } catch {
      return false;
    }
  }

  // Get the Tailscale IP for the current machine
  static async getSelfIP(): Promise<string | null> {
    try {
      const { stdout } = await execAsync('tailscale ip -4');
      return stdout.trim();
    } catch {
      return null;
    }
  }

  // Resolve a hostname to Tailscale IP
  async resolveHostname(hostname: string): Promise<string | null> {
    if (!this.lastStatus) {
      await this.poll();
    }

    const node = this.lastStatus?.nodes.find(
      n => n.hostname.toLowerCase() === hostname.toLowerCase()
    );

    return node?.ip ?? null;
  }
}
