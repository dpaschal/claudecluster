import * as k8s from '@kubernetes/client-node';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

export interface K8sCluster {
  name: string;
  type: 'gke' | 'k8s' | 'k3s' | 'unknown';
  context: string;
  server: string;
  nodes: K8sNode[];
  totalCpu: number;
  totalMemory: number;
  gpuNodes: number;
}

export interface K8sNode {
  name: string;
  ready: boolean;
  cpuCapacity: number;
  memoryCapacity: number;
  cpuAllocatable: number;
  memoryAllocatable: number;
  hasGpu: boolean;
  gpuCount?: number;
  labels: Record<string, string>;
}

export interface K8sResources {
  totalCpu: number;
  totalMemory: number;
  allocatableCpu: number;
  allocatableMemory: number;
  gpuCount: number;
  runningPods: number;
}

export interface K8sJobSpec {
  name: string;
  namespace?: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  gpuLimit?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ttlSecondsAfterFinished?: number;
  backoffLimit?: number;
}

export interface K8sJobStatus {
  name: string;
  namespace: string;
  active: number;
  succeeded: number;
  failed: number;
  startTime?: Date;
  completionTime?: Date;
  conditions: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;
}

export interface KubernetesAdapterConfig {
  logger: Logger;
  kubeconfigPath?: string;
}

export class KubernetesAdapter extends EventEmitter {
  private config: KubernetesAdapterConfig;
  private kubeconfigs: Map<string, k8s.KubeConfig> = new Map();
  private discoveredClusters: Map<string, K8sCluster> = new Map();

  constructor(config: KubernetesAdapterConfig) {
    super();
    this.config = config;
  }

  // Discover all available Kubernetes clusters from kubeconfig
  async discoverClusters(): Promise<K8sCluster[]> {
    const kc = new k8s.KubeConfig();

    try {
      if (this.config.kubeconfigPath) {
        kc.loadFromFile(this.config.kubeconfigPath);
      } else {
        kc.loadFromDefault();
      }
    } catch (error) {
      this.config.logger.warn('Failed to load kubeconfig', { error });
      return [];
    }

    const clusters: K8sCluster[] = [];
    const contexts = kc.getContexts();

    for (const context of contexts) {
      try {
        const cluster = await this.probeCluster(kc, context.name);
        if (cluster) {
          clusters.push(cluster);
          this.discoveredClusters.set(context.name, cluster);
          this.kubeconfigs.set(context.name, this.createContextConfig(kc, context.name));
        }
      } catch (error) {
        this.config.logger.debug('Failed to probe cluster', {
          context: context.name,
          error,
        });
      }
    }

    this.config.logger.info('Discovered Kubernetes clusters', {
      count: clusters.length,
      contexts: clusters.map(c => c.context),
    });

    return clusters;
  }

  // Get resources for a specific cluster
  async getClusterResources(context: string): Promise<K8sResources | null> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      return null;
    }

    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      // Get nodes
      const nodesResponse = await coreApi.listNode();
      const nodes = nodesResponse.body.items;

      let totalCpu = 0;
      let totalMemory = 0;
      let allocatableCpu = 0;
      let allocatableMemory = 0;
      let gpuCount = 0;

      for (const node of nodes) {
        const capacity = node.status?.capacity ?? {};
        const allocatable = node.status?.allocatable ?? {};

        totalCpu += this.parseCpu(capacity.cpu ?? '0');
        totalMemory += this.parseMemory(capacity.memory ?? '0');
        allocatableCpu += this.parseCpu(allocatable.cpu ?? '0');
        allocatableMemory += this.parseMemory(allocatable.memory ?? '0');

        const gpus = parseInt(capacity['nvidia.com/gpu'] ?? '0');
        gpuCount += gpus;
      }

      // Count running pods
      const podsResponse = await coreApi.listPodForAllNamespaces(
        undefined, undefined, 'status.phase=Running'
      );
      const runningPods = podsResponse.body.items.length;

      return {
        totalCpu,
        totalMemory,
        allocatableCpu,
        allocatableMemory,
        gpuCount,
        runningPods,
      };
    } catch (error) {
      this.config.logger.error('Failed to get cluster resources', { context, error });
      return null;
    }
  }

  // Submit a job to a Kubernetes cluster
  async submitJob(context: string, spec: K8sJobSpec): Promise<string> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      throw new Error(`Unknown cluster context: ${context}`);
    }

    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const namespace = spec.namespace ?? 'default';

    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: spec.name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'claudecluster',
          ...spec.labels,
        },
        annotations: spec.annotations,
      },
      spec: {
        ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished ?? 3600,
        backoffLimit: spec.backoffLimit ?? 3,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'task',
              image: spec.image,
              command: spec.command,
              args: spec.args,
              env: spec.env ? Object.entries(spec.env).map(([name, value]) => ({ name, value })) : undefined,
              resources: {
                requests: {
                  ...(spec.cpuRequest && { cpu: spec.cpuRequest }),
                  ...(spec.memoryRequest && { memory: spec.memoryRequest }),
                },
                limits: {
                  ...(spec.cpuLimit && { cpu: spec.cpuLimit }),
                  ...(spec.memoryLimit && { memory: spec.memoryLimit }),
                  ...(spec.gpuLimit && { 'nvidia.com/gpu': spec.gpuLimit.toString() }),
                },
              },
            }],
          },
        },
      },
    };

    try {
      const response = await batchApi.createNamespacedJob({ namespace, body: job });
      const jobName = response.body.metadata?.name ?? spec.name;

      this.config.logger.info('Submitted Kubernetes job', {
        context,
        namespace,
        name: jobName,
      });

      return jobName;
    } catch (error) {
      this.config.logger.error('Failed to submit Kubernetes job', { context, spec, error });
      throw error;
    }
  }

  // Get job status
  async getJobStatus(context: string, name: string, namespace: string = 'default'): Promise<K8sJobStatus | null> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      return null;
    }

    try {
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);
      const response = await batchApi.readNamespacedJob({ name, namespace });
      const job = response.body;

      return {
        name: job.metadata?.name ?? name,
        namespace: job.metadata?.namespace ?? namespace,
        active: job.status?.active ?? 0,
        succeeded: job.status?.succeeded ?? 0,
        failed: job.status?.failed ?? 0,
        startTime: job.status?.startTime ? new Date(job.status.startTime) : undefined,
        completionTime: job.status?.completionTime ? new Date(job.status.completionTime) : undefined,
        conditions: (job.status?.conditions ?? []).map(c => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      };
    } catch (error) {
      this.config.logger.error('Failed to get job status', { context, name, namespace, error });
      return null;
    }
  }

  // Get job logs
  async getJobLogs(context: string, name: string, namespace: string = 'default'): Promise<string | null> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      return null;
    }

    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      // Find pods for this job
      const podsResponse = await coreApi.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${name}`,
      });

      const pods = podsResponse.body.items;
      if (pods.length === 0) {
        return null;
      }

      // Get logs from first pod
      const podName = pods[0].metadata?.name;
      if (!podName) {
        return null;
      }

      const logsResponse = await coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
      });

      return logsResponse.body;
    } catch (error) {
      this.config.logger.error('Failed to get job logs', { context, name, namespace, error });
      return null;
    }
  }

  // Delete a job
  async deleteJob(context: string, name: string, namespace: string = 'default'): Promise<boolean> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      return false;
    }

    try {
      const batchApi = kc.makeApiClient(k8s.BatchV1Api);
      await batchApi.deleteNamespacedJob({
        name,
        namespace,
        propagationPolicy: 'Background',
      });

      this.config.logger.info('Deleted Kubernetes job', { context, name, namespace });
      return true;
    } catch (error) {
      this.config.logger.error('Failed to delete job', { context, name, namespace, error });
      return false;
    }
  }

  // Scale a deployment
  async scaleDeployment(
    context: string,
    name: string,
    replicas: number,
    namespace: string = 'default'
  ): Promise<boolean> {
    const kc = this.kubeconfigs.get(context);
    if (!kc) {
      return false;
    }

    try {
      const appsApi = kc.makeApiClient(k8s.AppsV1Api);

      await appsApi.patchNamespacedDeploymentScale({
        name,
        namespace,
        body: { spec: { replicas } },
      });

      this.config.logger.info('Scaled deployment', { context, name, namespace, replicas });
      return true;
    } catch (error) {
      this.config.logger.error('Failed to scale deployment', { context, name, namespace, error });
      return false;
    }
  }

  // Helper: Probe a cluster context
  private async probeCluster(kc: k8s.KubeConfig, contextName: string): Promise<K8sCluster | null> {
    const contextConfig = this.createContextConfig(kc, contextName);
    const coreApi = contextConfig.makeApiClient(k8s.CoreV1Api);

    // Try to list nodes to verify connectivity
    const nodesResponse = await coreApi.listNode();
    const nodes = nodesResponse.body.items;

    const k8sNodes: K8sNode[] = nodes.map(node => {
      const capacity = node.status?.capacity ?? {};
      const allocatable = node.status?.allocatable ?? {};
      const conditions = node.status?.conditions ?? [];
      const ready = conditions.some(c => c.type === 'Ready' && c.status === 'True');

      return {
        name: node.metadata?.name ?? 'unknown',
        ready,
        cpuCapacity: this.parseCpu(capacity.cpu ?? '0'),
        memoryCapacity: this.parseMemory(capacity.memory ?? '0'),
        cpuAllocatable: this.parseCpu(allocatable.cpu ?? '0'),
        memoryAllocatable: this.parseMemory(allocatable.memory ?? '0'),
        hasGpu: !!capacity['nvidia.com/gpu'],
        gpuCount: parseInt(capacity['nvidia.com/gpu'] ?? '0'),
        labels: node.metadata?.labels ?? {},
      };
    });

    const context = kc.getContextObject(contextName);
    const cluster = context?.cluster ? kc.getCluster(context.cluster) : null;
    const server = cluster?.server ?? '';

    return {
      name: contextName,
      type: this.detectClusterType(contextName, server, k8sNodes),
      context: contextName,
      server,
      nodes: k8sNodes,
      totalCpu: k8sNodes.reduce((sum, n) => sum + n.cpuCapacity, 0),
      totalMemory: k8sNodes.reduce((sum, n) => sum + n.memoryCapacity, 0),
      gpuNodes: k8sNodes.filter(n => n.hasGpu).length,
    };
  }

  // Helper: Create a KubeConfig for a specific context
  private createContextConfig(kc: k8s.KubeConfig, contextName: string): k8s.KubeConfig {
    const contextKc = new k8s.KubeConfig();

    const context = kc.getContextObject(contextName);
    if (!context) {
      throw new Error(`Context not found: ${contextName}`);
    }

    const cluster = kc.getCluster(context.cluster);
    const user = kc.getUser(context.user);

    if (!cluster) {
      throw new Error(`Cluster not found for context: ${contextName}`);
    }

    contextKc.loadFromClusterAndUser(cluster, user ?? {
      name: 'default',
    });
    contextKc.setCurrentContext(contextName);

    return contextKc;
  }

  // Helper: Detect cluster type
  private detectClusterType(context: string, server: string, nodes: K8sNode[]): 'gke' | 'k8s' | 'k3s' | 'unknown' {
    // GKE detection
    if (server.includes('.gke.') || server.includes('container.googleapis.com')) {
      return 'gke';
    }

    // K3s detection
    const hasK3sLabel = nodes.some(n =>
      n.labels['node.kubernetes.io/instance-type']?.includes('k3s') ||
      n.labels['k3s.io/hostname'] !== undefined
    );
    if (hasK3sLabel || context.toLowerCase().includes('k3s')) {
      return 'k3s';
    }

    // Generic K8s
    if (nodes.length > 0) {
      return 'k8s';
    }

    return 'unknown';
  }

  // Helper: Parse CPU string to cores (float)
  private parseCpu(cpu: string): number {
    if (cpu.endsWith('m')) {
      return parseInt(cpu.slice(0, -1)) / 1000;
    }
    return parseFloat(cpu) || 0;
  }

  // Helper: Parse memory string to bytes
  private parseMemory(memory: string): number {
    const units: Record<string, number> = {
      'Ki': 1024,
      'Mi': 1024 ** 2,
      'Gi': 1024 ** 3,
      'Ti': 1024 ** 4,
      'K': 1000,
      'M': 1000 ** 2,
      'G': 1000 ** 3,
      'T': 1000 ** 4,
    };

    for (const [suffix, multiplier] of Object.entries(units)) {
      if (memory.endsWith(suffix)) {
        return parseInt(memory.slice(0, -suffix.length)) * multiplier;
      }
    }

    return parseInt(memory) || 0;
  }

  // Get a discovered cluster
  getCluster(context: string): K8sCluster | undefined {
    return this.discoveredClusters.get(context);
  }

  // List all discovered clusters
  listClusters(): K8sCluster[] {
    return Array.from(this.discoveredClusters.values());
  }
}
