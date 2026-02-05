import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { RaftNode, LogEntryType } from './raft.js';
import { ClusterClient, GrpcClientPool } from '../grpc/client.js';

export interface NodeInfo {
  nodeId: string;
  hostname: string;
  tailscaleIp: string;
  grpcPort: number;
  role: NodeRole;
  status: NodeStatus;
  resources: NodeResources | null;
  tags: string[];
  joinedAt: number;
  lastSeen: number;
}

export type NodeRole = 'leader' | 'follower' | 'candidate' | 'worker';
export type NodeStatus = 'pending_approval' | 'active' | 'draining' | 'offline';

export interface NodeResources {
  cpuCores: number;
  memoryBytes: number;
  memoryAvailableBytes: number;
  gpus: GpuInfo[];
  diskBytes: number;
  diskAvailableBytes: number;
  cpuUsagePercent: number;
  gamingDetected: boolean;
}

export interface GpuInfo {
  name: string;
  memoryBytes: number;
  memoryAvailableBytes: number;
  utilizationPercent: number;
  inUseForGaming: boolean;
}

export interface MembershipConfig {
  nodeId: string;
  hostname: string;
  tailscaleIp: string;
  grpcPort: number;
  logger: Logger;
  raft: RaftNode;
  clientPool: GrpcClientPool;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  autoApprove?: boolean;
}

export class MembershipManager extends EventEmitter {
  private config: MembershipConfig;
  private nodes: Map<string, NodeInfo> = new Map();
  private pendingApprovals: Map<string, NodeInfo> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private failureDetectionInterval: NodeJS.Timeout | null = null;
  private leaderAddress: string | null = null;

  private heartbeatMs: number;
  private heartbeatTimeoutMs: number;

  constructor(config: MembershipConfig) {
    super();
    this.config = config;
    this.heartbeatMs = config.heartbeatIntervalMs ?? 5000;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 15000;

    // Register self
    this.nodes.set(config.nodeId, {
      nodeId: config.nodeId,
      hostname: config.hostname,
      tailscaleIp: config.tailscaleIp,
      grpcPort: config.grpcPort,
      role: 'follower',
      status: 'active',
      resources: null,
      tags: [],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });

    // Listen for Raft state changes
    config.raft.on('stateChange', (state: string) => {
      this.updateNodeRole(config.nodeId, state as NodeRole);
    });

    config.raft.on('entryCommitted', (entry: { type: LogEntryType; data: Buffer }) => {
      this.handleCommittedEntry(entry);
    });
  }

  start(): void {
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
    this.failureDetectionInterval = setInterval(() => this.detectFailures(), this.heartbeatMs);
    this.config.logger.info('Membership manager started');
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.failureDetectionInterval) {
      clearInterval(this.failureDetectionInterval);
      this.failureDetectionInterval = null;
    }
    this.config.logger.info('Membership manager stopped');
  }

  // Node management
  getNode(nodeId: string): NodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): NodeInfo[] {
    return Array.from(this.nodes.values());
  }

  getActiveNodes(): NodeInfo[] {
    return this.getAllNodes().filter(n => n.status === 'active');
  }

  getPendingApprovals(): NodeInfo[] {
    return Array.from(this.pendingApprovals.values());
  }

  getSelfNode(): NodeInfo {
    return this.nodes.get(this.config.nodeId)!;
  }

  getLeaderAddress(): string | null {
    return this.leaderAddress;
  }

  // Join cluster
  async joinCluster(seedAddress: string): Promise<boolean> {
    return this.joinClusterWithRedirect(seedAddress, 3);
  }

  // Join cluster with redirect handling
  private async joinClusterWithRedirect(seedAddress: string, maxRedirects: number): Promise<boolean> {
    if (maxRedirects <= 0) {
      this.config.logger.warn('Too many redirects during cluster join');
      return false;
    }

    try {
      const client = new ClusterClient(this.config.clientPool, seedAddress);

      const selfNode = this.getSelfNode();
      const response = await client.registerNode({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node: this.nodeToProto(selfNode) as any,
      });

      if (response.pending_approval) {
        this.config.logger.info('Node registration pending approval');
        selfNode.status = 'pending_approval';
        this.emit('pendingApproval');
        return true;
      }

      if (response.approved) {
        this.leaderAddress = response.leader_address;
        selfNode.status = 'active';

        // Add peers from response
        for (const peer of response.peers) {
          const nodeInfo = this.protoToNode(peer);
          this.nodes.set(nodeInfo.nodeId, nodeInfo);
          this.config.raft.addPeer(
            nodeInfo.nodeId,
            `${nodeInfo.tailscaleIp}:${nodeInfo.grpcPort}`,
            nodeInfo.role !== 'worker'
          );
        }

        this.config.logger.info('Joined cluster', {
          clusterId: response.cluster_id,
          leader: response.leader_address,
          peerCount: response.peers.length,
        });

        this.emit('joined', response.cluster_id);
        return true;
      }

      // Not approved and not pending - check for redirect to leader
      if (response.leader_address && response.leader_address !== seedAddress) {
        this.config.logger.info('Redirecting to leader', {
          from: seedAddress,
          to: response.leader_address,
        });
        return this.joinClusterWithRedirect(response.leader_address, maxRedirects - 1);
      }

      return false;
    } catch (error) {
      this.config.logger.error('Failed to join cluster', { error, seedAddress });
      return false;
    }
  }

  // Handle join request (leader only)
  async handleJoinRequest(node: NodeInfo): Promise<{
    approved: boolean;
    pendingApproval: boolean;
    clusterId: string;
    leaderAddress: string;
    peers: NodeInfo[];
  }> {
    if (!this.config.raft.isLeader()) {
      // Redirect to leader - try to get fresh leader address
      let leaderAddr = '';

      // Try to get leader info from Raft state
      const leaderId = this.config.raft.getLeaderId();
      if (leaderId && leaderId !== this.config.nodeId) {
        const leaderNode = this.nodes.get(leaderId);
        // Only redirect to leader if it's online (not offline or draining)
        if (leaderNode && leaderNode.status === 'active') {
          leaderAddr = `${leaderNode.tailscaleIp}:${leaderNode.grpcPort}`;
        }
      }

      // Fallback to cached leader address only if we couldn't get a fresh one
      // and verify it's not the requesting node's address
      if (!leaderAddr && this.leaderAddress) {
        const requestingAddr = `${node.tailscaleIp}:${node.grpcPort}`;
        if (this.leaderAddress !== requestingAddr) {
          leaderAddr = this.leaderAddress;
        }
      }

      this.config.logger.debug('Redirecting join request to leader', {
        leaderId,
        leaderAddress: leaderAddr,
        requestingNode: node.nodeId,
      });

      return {
        approved: false,
        pendingApproval: false,
        clusterId: '',
        leaderAddress: leaderAddr,
        peers: [],
      };
    }

    // Check if auto-approve is enabled
    if (this.config.autoApprove) {
      await this.approveNode(node);
      return {
        approved: true,
        pendingApproval: false,
        clusterId: this.config.nodeId, // Use leader's node ID as cluster ID for now
        leaderAddress: `${this.config.tailscaleIp}:${this.config.grpcPort}`,
        peers: this.getAllNodes(),
      };
    }

    // Add to pending approvals
    this.pendingApprovals.set(node.nodeId, node);
    this.emit('nodeJoinRequest', node);

    return {
      approved: false,
      pendingApproval: true,
      clusterId: '',
      leaderAddress: `${this.config.tailscaleIp}:${this.config.grpcPort}`,
      peers: [],
    };
  }

  // Approve pending node
  async approveNode(node: NodeInfo): Promise<boolean> {
    if (!this.config.raft.isLeader()) {
      return false;
    }

    // Replicate via Raft
    const data = Buffer.from(JSON.stringify({
      nodeId: node.nodeId,
      hostname: node.hostname,
      tailscaleIp: node.tailscaleIp,
      grpcPort: node.grpcPort,
      tags: node.tags,
    }));

    const { success } = await this.config.raft.appendEntry('node_join', data);

    if (success) {
      this.pendingApprovals.delete(node.nodeId);
      this.config.logger.info('Node approved', { nodeId: node.nodeId });
    }

    return success;
  }

  // Remove node from cluster
  async removeNode(nodeId: string, graceful: boolean = true): Promise<boolean> {
    if (!this.config.raft.isLeader()) {
      return false;
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }

    if (graceful) {
      node.status = 'draining';
      this.emit('nodeDraining', node);
      // Wait for tasks to complete before removing
    }

    const data = Buffer.from(JSON.stringify({ nodeId }));
    const { success } = await this.config.raft.appendEntry('node_leave', data);

    return success;
  }

  // Update node resources
  updateNodeResources(nodeId: string, resources: NodeResources): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.resources = resources;
      node.lastSeen = Date.now();
    }
  }

  // Heartbeat
  private async sendHeartbeat(): Promise<void> {
    if (!this.leaderAddress || this.config.raft.isLeader()) {
      return;
    }

    const selfNode = this.getSelfNode();

    try {
      const client = new ClusterClient(this.config.clientPool, this.leaderAddress);
      const response = await client.heartbeat({
        node_id: this.config.nodeId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resources: selfNode.resources ? this.resourcesToProto(selfNode.resources) as any : undefined,
        active_tasks: [], // TODO: Get from task executor
      });

      if (response.acknowledged) {
        selfNode.lastSeen = Date.now();
        this.leaderAddress = response.leader_address || this.leaderAddress;
      }
    } catch (error) {
      this.config.logger.debug('Heartbeat failed', { error });
    }
  }

  // Failure detection
  private detectFailures(): void {
    const now = Date.now();

    for (const node of this.nodes.values()) {
      if (node.nodeId === this.config.nodeId) continue;

      if (node.status === 'active' && now - node.lastSeen > this.heartbeatTimeoutMs) {
        node.status = 'offline';
        this.config.logger.warn('Node appears offline', { nodeId: node.nodeId });
        this.emit('nodeOffline', node);
      }
    }
  }

  // Handle committed Raft entries
  private handleCommittedEntry(entry: { type: LogEntryType; data: Buffer }): void {
    // Skip noop entries - they're used for leader election confirmation
    if (entry.type === 'noop') {
      return;
    }

    try {
      const data = JSON.parse(entry.data.toString());

      switch (entry.type) {
        case 'node_join':
          this.handleNodeJoinCommitted(data);
          break;
        case 'node_leave':
          this.handleNodeLeaveCommitted(data);
          break;
        default:
          // Ignore other entry types we don't handle
          break;
      }
    } catch (error) {
      this.config.logger.error('Failed to handle committed entry', { error, type: entry.type });
    }
  }

  private handleNodeJoinCommitted(data: {
    nodeId: string;
    hostname: string;
    tailscaleIp: string;
    grpcPort: number;
    tags: string[];
  }): void {
    const node: NodeInfo = {
      nodeId: data.nodeId,
      hostname: data.hostname,
      tailscaleIp: data.tailscaleIp,
      grpcPort: data.grpcPort,
      role: 'follower',
      status: 'active',
      resources: null,
      tags: data.tags,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    this.nodes.set(data.nodeId, node);
    this.config.raft.addPeer(data.nodeId, `${data.tailscaleIp}:${data.grpcPort}`, true);

    this.config.logger.info('Node joined cluster', { nodeId: data.nodeId });
    this.emit('nodeJoined', node);
  }

  private handleNodeLeaveCommitted(data: { nodeId: string }): void {
    const node = this.nodes.get(data.nodeId);
    if (node) {
      this.nodes.delete(data.nodeId);
      this.config.raft.removePeer(data.nodeId);

      this.config.logger.info('Node left cluster', { nodeId: data.nodeId });
      this.emit('nodeLeft', node);
    }
  }

  private updateNodeRole(nodeId: string, role: NodeRole): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.role = role;
      if (role === 'leader') {
        this.leaderAddress = `${node.tailscaleIp}:${node.grpcPort}`;
      }
    }
  }

  // Proto conversion helpers
  private nodeToProto(node: NodeInfo): {
    node_id: string;
    hostname: string;
    tailscale_ip: string;
    grpc_port: number;
    role: string;
    status: string;
    resources?: {
      cpu_cores: number;
      memory_bytes: string;
      memory_available_bytes: string;
      gpus: Array<{
        name: string;
        memory_bytes: string;
        memory_available_bytes: string;
        utilization_percent: number;
        in_use_for_gaming: boolean;
      }>;
      disk_bytes: string;
      disk_available_bytes: string;
      cpu_usage_percent: number;
      gaming_detected: boolean;
    };
    tags: string[];
    joined_at: string;
    last_seen: string;
  } {
    return {
      node_id: node.nodeId,
      hostname: node.hostname,
      tailscale_ip: node.tailscaleIp,
      grpc_port: node.grpcPort,
      role: `NODE_ROLE_${node.role.toUpperCase()}`,
      status: `NODE_STATUS_${node.status.toUpperCase()}`,
      resources: node.resources ? this.resourcesToProto(node.resources) : undefined,
      tags: node.tags,
      joined_at: node.joinedAt.toString(),
      last_seen: node.lastSeen.toString(),
    };
  }

  private protoToNode(proto: {
    node_id: string;
    hostname: string;
    tailscale_ip: string;
    grpc_port: number;
    role: string;
    status: string;
    tags: string[];
    joined_at: string;
    last_seen: string;
  }): NodeInfo {
    return {
      nodeId: proto.node_id,
      hostname: proto.hostname,
      tailscaleIp: proto.tailscale_ip,
      grpcPort: proto.grpc_port,
      role: proto.role.replace('NODE_ROLE_', '').toLowerCase() as NodeRole,
      status: proto.status.replace('NODE_STATUS_', '').toLowerCase() as NodeStatus,
      resources: null,
      tags: proto.tags,
      joinedAt: parseInt(proto.joined_at),
      lastSeen: parseInt(proto.last_seen),
    };
  }

  private resourcesToProto(resources: NodeResources): {
    cpu_cores: number;
    memory_bytes: string;
    memory_available_bytes: string;
    gpus: Array<{
      name: string;
      memory_bytes: string;
      memory_available_bytes: string;
      utilization_percent: number;
      in_use_for_gaming: boolean;
    }>;
    disk_bytes: string;
    disk_available_bytes: string;
    cpu_usage_percent: number;
    gaming_detected: boolean;
  } {
    return {
      cpu_cores: resources.cpuCores,
      memory_bytes: resources.memoryBytes.toString(),
      memory_available_bytes: resources.memoryAvailableBytes.toString(),
      gpus: resources.gpus.map(gpu => ({
        name: gpu.name,
        memory_bytes: gpu.memoryBytes.toString(),
        memory_available_bytes: gpu.memoryAvailableBytes.toString(),
        utilization_percent: gpu.utilizationPercent,
        in_use_for_gaming: gpu.inUseForGaming,
      })),
      disk_bytes: resources.diskBytes.toString(),
      disk_available_bytes: resources.diskAvailableBytes.toString(),
      cpu_usage_percent: resources.cpuUsagePercent,
      gaming_detected: resources.gamingDetected,
    };
  }
}
