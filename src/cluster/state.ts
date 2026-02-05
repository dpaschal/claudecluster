import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { MembershipManager, NodeInfo, NodeResources } from './membership.js';
import { RaftNode } from './raft.js';

export interface ClusterState {
  clusterId: string;
  leaderId: string | null;
  term: number;
  nodes: NodeInfo[];
  totalResources: ClusterResources;
  availableResources: ClusterResources;
  activeTasks: number;
  queuedTasks: number;
}

export interface ClusterResources {
  cpuCores: number;
  memoryBytes: number;
  gpuCount: number;
  gpuMemoryBytes: number;
}

export interface ClaudeSession {
  sessionId: string;
  nodeId: string;
  project: string;
  workingDirectory: string;
  mode: 'normal' | 'invisible' | 'isolated';
  startedAt: number;
  lastActive: number;
  contextSummary?: string;
}

export interface ContextEntry {
  entryId: string;
  sessionId: string;
  nodeId: string;
  project: string;
  type: ContextType;
  key: string;
  value: string;
  timestamp: number;
  vectorClock: number;
  visibility: ContextVisibility;
}

export type ContextType =
  | 'project_summary'
  | 'decision'
  | 'error_solution'
  | 'file_change'
  | 'learning';

export type ContextVisibility = 'cluster' | 'project' | 'session';

export interface ClusterStateConfig {
  clusterId: string;
  logger: Logger;
  membership: MembershipManager;
  raft: RaftNode;
}

export class ClusterStateManager extends EventEmitter {
  private config: ClusterStateConfig;
  private sessions: Map<string, ClaudeSession> = new Map();
  private contextStore: Map<string, ContextEntry> = new Map();
  private activeTasks = 0;
  private queuedTasks = 0;

  constructor(config: ClusterStateConfig) {
    super();
    this.config = config;

    // Listen for membership changes
    config.membership.on('nodeJoined', () => this.emit('stateChanged'));
    config.membership.on('nodeLeft', () => this.emit('stateChanged'));
    config.membership.on('nodeOffline', () => this.emit('stateChanged'));
  }

  // Cluster state
  getState(): ClusterState {
    const nodes = this.config.membership.getAllNodes();
    const leaderId = this.config.raft.getLeaderId();

    return {
      clusterId: this.config.clusterId,
      leaderId,
      term: this.config.raft.getCurrentTerm(),
      nodes,
      totalResources: this.calculateTotalResources(nodes),
      availableResources: this.calculateAvailableResources(nodes),
      activeTasks: this.activeTasks,
      queuedTasks: this.queuedTasks,
    };
  }

  updateTaskCounts(active: number, queued: number): void {
    this.activeTasks = active;
    this.queuedTasks = queued;
    this.emit('stateChanged');
  }

  // Session management
  registerSession(session: ClaudeSession): void {
    if (session.mode === 'isolated') {
      // Isolated sessions don't register with cluster
      return;
    }

    this.sessions.set(session.sessionId, session);
    this.config.logger.info('Session registered', {
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      project: session.project,
      mode: session.mode,
    });

    this.emit('sessionRegistered', session);
  }

  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.config.logger.info('Session unregistered', { sessionId });
      this.emit('sessionUnregistered', session);
    }
  }

  getSession(sessionId: string): ClaudeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessions(options?: {
    projectFilter?: string;
    nodeFilter?: string;
    excludeInvisible?: boolean;
  }): ClaudeSession[] {
    let sessions = Array.from(this.sessions.values());

    if (options?.excludeInvisible) {
      sessions = sessions.filter(s => s.mode !== 'invisible');
    }

    if (options?.projectFilter) {
      sessions = sessions.filter(s => s.project === options.projectFilter);
    }

    if (options?.nodeFilter) {
      sessions = sessions.filter(s => s.nodeId === options.nodeFilter);
    }

    return sessions;
  }

  updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
  }

  updateSessionContext(sessionId: string, contextSummary: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.contextSummary = contextSummary;
      this.emit('sessionContextUpdated', session);
    }
  }

  // Context store
  publishContext(entry: ContextEntry): void {
    this.contextStore.set(entry.entryId, entry);
    this.config.logger.debug('Context published', {
      entryId: entry.entryId,
      type: entry.type,
      key: entry.key,
    });

    this.emit('contextPublished', entry);
  }

  queryContext(options: {
    projectFilter?: string;
    typeFilter?: ContextType[];
    sinceTimestamp?: number;
    limit?: number;
    sessionId?: string; // For visibility filtering
  }): ContextEntry[] {
    let entries = Array.from(this.contextStore.values());

    // Filter by visibility
    if (options.sessionId) {
      const session = this.sessions.get(options.sessionId);
      entries = entries.filter(e => {
        if (e.visibility === 'cluster') return true;
        if (e.visibility === 'project' && session && e.project === session.project) return true;
        if (e.visibility === 'session' && e.sessionId === options.sessionId) return true;
        return false;
      });
    } else {
      // No session context, only return cluster-visible entries
      entries = entries.filter(e => e.visibility === 'cluster');
    }

    if (options.projectFilter) {
      entries = entries.filter(e => e.project === options.projectFilter);
    }

    if (options.typeFilter && options.typeFilter.length > 0) {
      entries = entries.filter(e => options.typeFilter!.includes(e.type));
    }

    if (options.sinceTimestamp) {
      entries = entries.filter(e => e.timestamp > options.sinceTimestamp!);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp - a.timestamp);

    if (options.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  // Helper methods
  private calculateTotalResources(nodes: NodeInfo[]): ClusterResources {
    const resources: ClusterResources = {
      cpuCores: 0,
      memoryBytes: 0,
      gpuCount: 0,
      gpuMemoryBytes: 0,
    };

    for (const node of nodes) {
      if (node.status !== 'active' || !node.resources) continue;

      resources.cpuCores += node.resources.cpuCores;
      resources.memoryBytes += node.resources.memoryBytes;
      resources.gpuCount += node.resources.gpus.length;
      resources.gpuMemoryBytes += node.resources.gpus.reduce(
        (sum, gpu) => sum + gpu.memoryBytes,
        0
      );
    }

    return resources;
  }

  private calculateAvailableResources(nodes: NodeInfo[]): ClusterResources {
    const resources: ClusterResources = {
      cpuCores: 0,
      memoryBytes: 0,
      gpuCount: 0,
      gpuMemoryBytes: 0,
    };

    for (const node of nodes) {
      if (node.status !== 'active' || !node.resources) continue;

      // Estimate available CPU based on usage
      const availableCpuCores = Math.max(
        0,
        node.resources.cpuCores * (1 - node.resources.cpuUsagePercent / 100)
      );
      resources.cpuCores += availableCpuCores;
      resources.memoryBytes += node.resources.memoryAvailableBytes;

      // Only count GPUs not in use for gaming
      for (const gpu of node.resources.gpus) {
        if (!gpu.inUseForGaming) {
          resources.gpuCount++;
          resources.gpuMemoryBytes += gpu.memoryAvailableBytes;
        }
      }
    }

    return resources;
  }

  // Proto conversion
  toProtoState(): {
    cluster_id: string;
    leader_id: string;
    term: string;
    nodes: Array<{
      node_id: string;
      hostname: string;
      tailscale_ip: string;
      grpc_port: number;
      role: string;
      status: string;
      tags: string[];
      joined_at: string;
      last_seen: string;
    }>;
    total_resources: {
      cpu_cores: number;
      memory_bytes: string;
      gpu_count: number;
      gpu_memory_bytes: string;
    };
    available_resources: {
      cpu_cores: number;
      memory_bytes: string;
      gpu_count: number;
      gpu_memory_bytes: string;
    };
    active_tasks: number;
    queued_tasks: number;
  } {
    const state = this.getState();

    return {
      cluster_id: state.clusterId,
      leader_id: state.leaderId || '',
      term: state.term.toString(),
      nodes: state.nodes.map(n => ({
        node_id: n.nodeId,
        hostname: n.hostname,
        tailscale_ip: n.tailscaleIp,
        grpc_port: n.grpcPort,
        role: `NODE_ROLE_${n.role.toUpperCase()}`,
        status: `NODE_STATUS_${n.status.toUpperCase()}`,
        tags: n.tags,
        joined_at: n.joinedAt.toString(),
        last_seen: n.lastSeen.toString(),
      })),
      total_resources: {
        cpu_cores: state.totalResources.cpuCores,
        memory_bytes: state.totalResources.memoryBytes.toString(),
        gpu_count: state.totalResources.gpuCount,
        gpu_memory_bytes: state.totalResources.gpuMemoryBytes.toString(),
      },
      available_resources: {
        cpu_cores: state.availableResources.cpuCores,
        memory_bytes: state.availableResources.memoryBytes.toString(),
        gpu_count: state.availableResources.gpuCount,
        gpu_memory_bytes: state.availableResources.gpuMemoryBytes.toString(),
      },
      active_tasks: state.activeTasks,
      queued_tasks: state.queuedTasks,
    };
  }
}
