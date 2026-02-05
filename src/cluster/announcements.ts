import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { MembershipManager, NodeInfo, NodeResources } from './membership.js';
import { ClusterClient, GrpcClientPool } from '../grpc/client.js';

export interface AnnouncementConfig {
  nodeId: string;
  hostname: string;
  logger: Logger;
  membership: MembershipManager;
  clientPool: GrpcClientPool;
  invisible?: boolean; // Node can see cluster but isn't announced
  silent?: boolean;    // Suppress all console output (for MCP mode)
}

export interface ClusterAnnouncement {
  type: 'join' | 'leave' | 'status' | 'message';
  fromNode: string;
  fromHostname: string;
  message: string;
  timestamp: number;
  resources?: ResourceSummary;
}

export interface ResourceSummary {
  cpuCores: number;
  memoryGB: number;
  gpus: string[];
  gamingActive: boolean;
}

export class ClusterAnnouncer extends EventEmitter {
  private config: AnnouncementConfig;
  private announcementLog: ClusterAnnouncement[] = [];
  private maxLogSize = 100;

  constructor(config: AnnouncementConfig) {
    super();
    this.config = config;

    // Listen for membership events
    config.membership.on('nodeJoined', (node: NodeInfo) => this.onNodeJoined(node));
    config.membership.on('nodeLeft', (node: NodeInfo) => this.onNodeLeft(node));
    config.membership.on('nodeOffline', (node: NodeInfo) => this.onNodeOffline(node));
    config.membership.on('joined', () => this.onSelfJoined());
  }

  // Called when we successfully join the cluster
  private onSelfJoined(): void {
    const nodes = this.config.membership.getAllNodes();
    const selfNode = this.config.membership.getSelfNode();

    // Show cluster status to user
    this.showClusterStatus(nodes, selfNode);

    // Announce ourselves (unless invisible)
    if (!this.config.invisible) {
      this.broadcastJoin(selfNode);
    }
  }

  // Show cluster status on connection
  private showClusterStatus(nodes: NodeInfo[], selfNode: NodeInfo): void {
    // Skip console output in silent mode (MCP mode)
    if (this.config.silent) {
      return;
    }

    const otherNodes = nodes.filter(n => n.nodeId !== selfNode.nodeId);
    const activeNodes = otherNodes.filter(n => n.status === 'active');

    const mode = this.config.invisible ? ' (invisible mode)' : '';

    console.log('\n' + '='.repeat(60));
    console.log(`  Connected to Claude Cluster${mode}`);
    console.log('='.repeat(60));
    console.log(`  This node: ${selfNode.hostname} (${selfNode.nodeId.slice(0, 8)}...)`);
    console.log(`  Visible nodes: ${activeNodes.length}`);
    console.log('');

    if (activeNodes.length > 0) {
      console.log('  Cluster Members:');
      console.log('  ' + '-'.repeat(56));

      for (const node of activeNodes) {
        const resources = this.formatResourceBrief(node.resources);
        const role = node.role === 'leader' ? ' [LEADER]' : '';
        const gaming = node.resources?.gamingDetected ? ' [GAMING]' : '';

        console.log(`  ${node.hostname}${role}${gaming}`);
        console.log(`    ${node.tailscaleIp}:${node.grpcPort} | ${resources}`);
      }

      console.log('  ' + '-'.repeat(56));
    } else {
      console.log('  No other nodes in cluster yet.');
    }

    console.log('='.repeat(60) + '\n');

    this.config.logger.info('Connected to cluster', {
      mode: this.config.invisible ? 'invisible' : 'normal',
      nodeCount: activeNodes.length,
    });
  }

  // When another node joins
  private onNodeJoined(node: NodeInfo): void {
    const announcement = this.createJoinAnnouncement(node);
    this.logAnnouncement(announcement);
    this.emit('announcement', announcement);

    // Display to console
    this.displayAnnouncement(announcement);
  }

  // Broadcast our join to all nodes
  private async broadcastJoin(selfNode: NodeInfo): Promise<void> {
    const announcement = this.createJoinAnnouncement(selfNode);
    const otherNodes = this.config.membership.getAllNodes()
      .filter(n => n.nodeId !== selfNode.nodeId && n.status === 'active');

    for (const node of otherNodes) {
      try {
        const address = `${node.tailscaleIp}:${node.grpcPort}`;
        const client = new ClusterClient(this.config.clientPool, address);

        // Use the context publish mechanism to broadcast
        await client.publishContext({
          entry: {
            entry_id: `announcement-${Date.now()}`,
            session_id: '',
            node_id: this.config.nodeId,
            project: '_cluster',
            type: 'announcement',
            key: 'node_join',
            value: JSON.stringify(announcement),
            timestamp: Date.now().toString(),
            vector_clock: '{}',
            visibility: 'cluster',
          },
        });
      } catch (error) {
        this.config.logger.debug('Failed to broadcast to node', {
          nodeId: node.nodeId,
          error,
        });
      }
    }
  }

  // When a node leaves gracefully
  private onNodeLeft(node: NodeInfo): void {
    const announcement: ClusterAnnouncement = {
      type: 'leave',
      fromNode: node.nodeId,
      fromHostname: node.hostname,
      message: `Node ${node.hostname} has left the cluster gracefully. Goodbye!`,
      timestamp: Date.now(),
    };

    this.logAnnouncement(announcement);
    this.emit('announcement', announcement);
    this.displayAnnouncement(announcement);
  }

  // When a node goes offline unexpectedly
  private onNodeOffline(node: NodeInfo): void {
    const announcement: ClusterAnnouncement = {
      type: 'leave',
      fromNode: node.nodeId,
      fromHostname: node.hostname,
      message: `Node ${node.hostname} has gone offline. Last seen: ${this.formatTimeAgo(node.lastSeen)}`,
      timestamp: Date.now(),
    };

    this.logAnnouncement(announcement);
    this.emit('announcement', announcement);
    this.displayAnnouncement(announcement);
  }

  // Create a join announcement
  private createJoinAnnouncement(node: NodeInfo): ClusterAnnouncement {
    const resources = this.summarizeResources(node.resources);
    const resourceStr = this.formatResourceSummary(resources);

    return {
      type: 'join',
      fromNode: node.nodeId,
      fromHostname: node.hostname,
      message: `Hey Claude! Node ${node.hostname} reporting in! ${resourceStr}`,
      timestamp: Date.now(),
      resources,
    };
  }

  // Summarize resources for announcements
  private summarizeResources(resources: NodeResources | null): ResourceSummary {
    if (!resources) {
      return {
        cpuCores: 0,
        memoryGB: 0,
        gpus: [],
        gamingActive: false,
      };
    }

    return {
      cpuCores: resources.cpuCores,
      memoryGB: Math.round(resources.memoryBytes / (1024 * 1024 * 1024)),
      gpus: resources.gpus.map(g => g.name),
      gamingActive: resources.gamingDetected,
    };
  }

  // Format resource summary as string
  private formatResourceSummary(resources: ResourceSummary): string {
    const parts: string[] = [];

    if (resources.cpuCores > 0) {
      parts.push(`${resources.cpuCores} cores`);
    }

    if (resources.memoryGB > 0) {
      parts.push(`${resources.memoryGB} GB RAM`);
    }

    if (resources.gpus.length > 0) {
      parts.push(resources.gpus.join(', '));
    }

    if (resources.gamingActive) {
      parts.push('(gaming in progress)');
    }

    return parts.length > 0 ? `[${parts.join(' | ')}]` : '[resources unknown]';
  }

  // Brief resource format for status display
  private formatResourceBrief(resources: NodeResources | null): string {
    if (!resources) return 'resources unknown';

    const parts: string[] = [];
    parts.push(`${resources.cpuCores} CPU`);
    parts.push(`${Math.round(resources.memoryBytes / (1024 * 1024 * 1024))} GB`);

    if (resources.gpus.length > 0) {
      const gpuNames = resources.gpus.map(g => g.name.replace(/NVIDIA |GeForce /gi, '')).join(', ');
      parts.push(gpuNames);
    }

    return parts.join(' | ');
  }

  // Format time ago
  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // Display announcement to console
  private displayAnnouncement(announcement: ClusterAnnouncement): void {
    // Skip console output in silent mode (MCP mode)
    if (this.config.silent) {
      return;
    }

    const icon = announcement.type === 'join' ? '++' : '--';
    const color = announcement.type === 'join' ? '\x1b[32m' : '\x1b[33m'; // Green or yellow
    const reset = '\x1b[0m';

    console.log(`${color}[${icon}] ${announcement.message}${reset}`);
  }

  // Log announcement
  private logAnnouncement(announcement: ClusterAnnouncement): void {
    this.announcementLog.push(announcement);

    // Trim log if too large
    if (this.announcementLog.length > this.maxLogSize) {
      this.announcementLog = this.announcementLog.slice(-this.maxLogSize);
    }
  }

  // Get recent announcements
  getRecentAnnouncements(count: number = 10): ClusterAnnouncement[] {
    return this.announcementLog.slice(-count);
  }

  // Send a custom message to the cluster
  async broadcast(message: string): Promise<void> {
    const announcement: ClusterAnnouncement = {
      type: 'message',
      fromNode: this.config.nodeId,
      fromHostname: this.config.hostname,
      message: `${this.config.hostname}: ${message}`,
      timestamp: Date.now(),
    };

    this.logAnnouncement(announcement);
    this.emit('announcement', announcement);

    // Broadcast to other nodes
    const otherNodes = this.config.membership.getAllNodes()
      .filter(n => n.nodeId !== this.config.nodeId && n.status === 'active');

    for (const node of otherNodes) {
      try {
        const address = `${node.tailscaleIp}:${node.grpcPort}`;
        const client = new ClusterClient(this.config.clientPool, address);

        await client.publishContext({
          entry: {
            entry_id: `message-${Date.now()}`,
            session_id: '',
            node_id: this.config.nodeId,
            project: '_cluster',
            type: 'announcement',
            key: 'message',
            value: JSON.stringify(announcement),
            timestamp: Date.now().toString(),
            vector_clock: '{}',
            visibility: 'cluster',
          },
        });
      } catch (error) {
        this.config.logger.debug('Failed to send message to node', {
          nodeId: node.nodeId,
          error,
        });
      }
    }
  }

  // Handle incoming announcement from another node
  handleIncomingAnnouncement(data: string): void {
    try {
      const announcement = JSON.parse(data) as ClusterAnnouncement;
      this.logAnnouncement(announcement);
      this.emit('announcement', announcement);
      this.displayAnnouncement(announcement);
    } catch (error) {
      this.config.logger.debug('Failed to parse incoming announcement', { error });
    }
  }
}
