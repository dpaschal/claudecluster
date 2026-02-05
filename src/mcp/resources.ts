import { Logger } from 'winston';
import { ClusterStateManager, ClusterState } from '../cluster/state.js';
import { MembershipManager, NodeInfo } from '../cluster/membership.js';
import { KubernetesAdapter, K8sCluster } from '../kubernetes/adapter.js';

export interface ResourcesConfig {
  logger: Logger;
  stateManager: ClusterStateManager;
  membership: MembershipManager;
  k8sAdapter: KubernetesAdapter;
}

export interface ClusterResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  getData: () => Promise<unknown>;
}

export function createResources(config: ResourcesConfig): Map<string, ClusterResource> {
  const resources = new Map<string, ClusterResource>();

  // Cluster state resource
  resources.set('cluster://state', {
    uri: 'cluster://state',
    name: 'Cluster State',
    description: 'Current state of the Claude Cluster including leader, term, and resource totals',
    mimeType: 'application/json',
    getData: async () => {
      const state = config.stateManager.getState();
      return formatClusterState(state);
    },
  });

  // Nodes resource
  resources.set('cluster://nodes', {
    uri: 'cluster://nodes',
    name: 'Cluster Nodes',
    description: 'All nodes in the cluster with their status, resources, and roles',
    mimeType: 'application/json',
    getData: async () => {
      const nodes = config.membership.getAllNodes();
      return formatNodes(nodes);
    },
  });

  // Active nodes only
  resources.set('cluster://nodes/active', {
    uri: 'cluster://nodes/active',
    name: 'Active Nodes',
    description: 'Only active (online, ready) nodes in the cluster',
    mimeType: 'application/json',
    getData: async () => {
      const nodes = config.membership.getActiveNodes();
      return formatNodes(nodes);
    },
  });

  // Sessions resource
  resources.set('cluster://sessions', {
    uri: 'cluster://sessions',
    name: 'Claude Sessions',
    description: 'Active Claude Code sessions in the cluster',
    mimeType: 'application/json',
    getData: async () => {
      const sessions = config.stateManager.getSessions({ excludeInvisible: true });
      return sessions.map(s => ({
        sessionId: s.sessionId,
        nodeId: s.nodeId,
        project: s.project,
        workingDirectory: s.workingDirectory,
        mode: s.mode,
        startedAt: new Date(s.startedAt).toISOString(),
        lastActive: new Date(s.lastActive).toISOString(),
        idleMinutes: Math.round((Date.now() - s.lastActive) / 60000),
        hasContextSummary: !!s.contextSummary,
      }));
    },
  });

  // Kubernetes clusters resource
  resources.set('cluster://k8s', {
    uri: 'cluster://k8s',
    name: 'Kubernetes Clusters',
    description: 'Available Kubernetes clusters (GKE, K8s, K3s) discovered from kubeconfig',
    mimeType: 'application/json',
    getData: async () => {
      const clusters = config.k8sAdapter.listClusters();
      return formatK8sClusters(clusters);
    },
  });

  // Individual K8s cluster template (will be expanded dynamically)
  resources.set('cluster://k8s/{context}', {
    uri: 'cluster://k8s/{context}',
    name: 'Kubernetes Cluster Details',
    description: 'Detailed information about a specific Kubernetes cluster',
    mimeType: 'application/json',
    getData: async () => {
      // This is a template, actual implementation would parse the context from URI
      return { error: 'Use specific cluster context' };
    },
  });

  // Context store resource
  resources.set('cluster://context', {
    uri: 'cluster://context',
    name: 'Shared Context',
    description: 'Shared context entries from all Claude sessions',
    mimeType: 'application/json',
    getData: async () => {
      const entries = config.stateManager.queryContext({ limit: 100 });
      return entries.map(e => ({
        entryId: e.entryId,
        type: e.type,
        key: e.key,
        value: e.value.length > 200 ? e.value.substring(0, 200) + '...' : e.value,
        project: e.project,
        sessionId: e.sessionId,
        visibility: e.visibility,
        timestamp: new Date(e.timestamp).toISOString(),
      }));
    },
  });

  // Pending approvals resource
  resources.set('cluster://approvals', {
    uri: 'cluster://approvals',
    name: 'Pending Approvals',
    description: 'Nodes waiting for approval to join the cluster',
    mimeType: 'application/json',
    getData: async () => {
      const pending = config.membership.getPendingApprovals();
      return pending.map(n => ({
        nodeId: n.nodeId,
        hostname: n.hostname,
        ip: n.tailscaleIp,
        tags: n.tags,
        resources: n.resources ? {
          cpuCores: n.resources.cpuCores,
          memoryGb: (n.resources.memoryBytes / (1024 ** 3)).toFixed(1),
          gpus: n.resources.gpus.map(g => g.name),
        } : null,
      }));
    },
  });

  return resources;
}

// Formatting helpers
function formatClusterState(state: ClusterState): Record<string, unknown> {
  return {
    clusterId: state.clusterId,
    leader: state.leaderId,
    term: state.term,
    nodeCount: state.nodes.length,
    activeNodes: state.nodes.filter(n => n.status === 'active').length,
    totalResources: {
      cpuCores: state.totalResources.cpuCores,
      memoryGb: (state.totalResources.memoryBytes / (1024 ** 3)).toFixed(1),
      gpuCount: state.totalResources.gpuCount,
      gpuMemoryGb: (state.totalResources.gpuMemoryBytes / (1024 ** 3)).toFixed(1),
    },
    availableResources: {
      cpuCores: state.availableResources.cpuCores.toFixed(1),
      memoryGb: (state.availableResources.memoryBytes / (1024 ** 3)).toFixed(1),
      gpuCount: state.availableResources.gpuCount,
      gpuMemoryGb: (state.availableResources.gpuMemoryBytes / (1024 ** 3)).toFixed(1),
    },
    tasks: {
      active: state.activeTasks,
      queued: state.queuedTasks,
    },
  };
}

function formatNodes(nodes: NodeInfo[]): Array<Record<string, unknown>> {
  return nodes.map(n => ({
    nodeId: n.nodeId,
    hostname: n.hostname,
    ip: n.tailscaleIp,
    port: n.grpcPort,
    role: n.role,
    status: n.status,
    tags: n.tags,
    joinedAt: new Date(n.joinedAt).toISOString(),
    lastSeen: new Date(n.lastSeen).toISOString(),
    resources: n.resources ? {
      cpu: {
        cores: n.resources.cpuCores,
        usagePercent: n.resources.cpuUsagePercent.toFixed(1),
      },
      memory: {
        totalGb: (n.resources.memoryBytes / (1024 ** 3)).toFixed(1),
        availableGb: (n.resources.memoryAvailableBytes / (1024 ** 3)).toFixed(1),
        usedPercent: ((1 - n.resources.memoryAvailableBytes / n.resources.memoryBytes) * 100).toFixed(1),
      },
      disk: {
        totalGb: (n.resources.diskBytes / (1024 ** 3)).toFixed(1),
        availableGb: (n.resources.diskAvailableBytes / (1024 ** 3)).toFixed(1),
      },
      gpus: n.resources.gpus.map(g => ({
        name: g.name,
        memoryTotalGb: (g.memoryBytes / (1024 ** 3)).toFixed(1),
        memoryAvailableGb: (g.memoryAvailableBytes / (1024 ** 3)).toFixed(1),
        utilization: g.utilizationPercent.toFixed(1),
        gamingActive: g.inUseForGaming,
      })),
      gamingDetected: n.resources.gamingDetected,
    } : null,
  }));
}

function formatK8sClusters(clusters: K8sCluster[]): Array<Record<string, unknown>> {
  return clusters.map(c => ({
    name: c.name,
    type: c.type,
    context: c.context,
    server: c.server,
    nodeCount: c.nodes.length,
    readyNodes: c.nodes.filter(n => n.ready).length,
    totalCpu: c.totalCpu,
    totalMemoryGb: (c.totalMemory / (1024 ** 3)).toFixed(1),
    gpuNodes: c.gpuNodes,
    nodes: c.nodes.map(n => ({
      name: n.name,
      ready: n.ready,
      cpuCapacity: n.cpuCapacity,
      memoryCapacityGb: (n.memoryCapacity / (1024 ** 3)).toFixed(1),
      hasGpu: n.hasGpu,
      gpuCount: n.gpuCount,
    })),
  }));
}
