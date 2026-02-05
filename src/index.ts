#!/usr/bin/env node

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import winston from 'winston';

import { GrpcServer, GrpcServerConfig } from './grpc/server.js';
import { GrpcClientPool } from './grpc/client.js';
import { ResourceMonitor } from './agent/resource-monitor.js';
import { TaskExecutor } from './agent/task-executor.js';
import { HealthReporter } from './agent/health-reporter.js';
import { RaftNode } from './cluster/raft.js';
import { MembershipManager } from './cluster/membership.js';
import { ClusterStateManager } from './cluster/state.js';
import { TaskScheduler } from './cluster/scheduler.js';
import { TailscaleDiscovery } from './discovery/tailscale.js';
import { ApprovalWorkflow } from './discovery/approval.js';
import { KubernetesAdapter } from './kubernetes/adapter.js';
import { ClusterMcpServer } from './mcp/server.js';
import { AuthManager, AuthzManager } from './security/auth.js';
import { SecretsManager } from './security/secrets.js';
import { randomUUID } from 'crypto';

export interface ClusterConfig {
  cluster: {
    id: string;
    autoApproveTags?: string[];
    autoApproveEphemeral?: boolean;
  };
  node: {
    grpcPort: number;
    role: 'leader-eligible' | 'worker';
    tags?: string[];
  };
  network: {
    tailscaleTag: string;
    discoveryIntervalMs?: number;
  };
  raft: {
    electionTimeoutMinMs?: number;
    electionTimeoutMaxMs?: number;
    heartbeatIntervalMs?: number;
    maxLogEntriesPerAppend?: number;
  };
  scheduler: {
    maxQueueSize?: number;
    maxRetries?: number;
    schedulingIntervalMs?: number;
  };
  resources: {
    pollIntervalMs?: number;
    gaming?: {
      processes?: string[];
      gpuThreshold?: number;
      cooldownMs?: number;
    };
  };
  health: {
    checkIntervalMs?: number;
    thresholds?: {
      memoryPercent?: number;
      cpuPercent?: number;
      diskPercent?: number;
    };
  };
  kubernetes: {
    kubeconfigPath?: string;
    defaultNamespace?: string;
    jobTtlSeconds?: number;
  };
  security: {
    certsDir: string;
    secretsDir: string;
    enableMtls?: boolean;
    approvalTimeoutMs?: number;
  };
  logging: {
    level: string;
    format: 'json' | 'simple';
    file?: string;
  };
  mcp: {
    serverName: string;
    serverVersion: string;
  };
  seeds?: Array<{ address: string }>;
}

export class ClaudeCluster extends EventEmitter {
  private config: ClusterConfig;
  private logger: winston.Logger;
  private nodeId: string;
  private sessionId: string;

  // Components
  private grpcServer: GrpcServer | null = null;
  private clientPool: GrpcClientPool | null = null;
  private resourceMonitor: ResourceMonitor | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private healthReporter: HealthReporter | null = null;
  private raft: RaftNode | null = null;
  private membership: MembershipManager | null = null;
  private stateManager: ClusterStateManager | null = null;
  private scheduler: TaskScheduler | null = null;
  private tailscale: TailscaleDiscovery | null = null;
  private approval: ApprovalWorkflow | null = null;
  private k8sAdapter: KubernetesAdapter | null = null;
  private mcpServer: ClusterMcpServer | null = null;
  private authManager: AuthManager | null = null;
  private authzManager: AuthzManager | null = null;
  private secretsManager: SecretsManager | null = null;

  private running = false;

  constructor(config: ClusterConfig) {
    super();
    this.config = config;
    this.nodeId = `node-${randomUUID().slice(0, 8)}`;
    this.sessionId = randomUUID();
    this.logger = this.createLogger();
  }

  private createLogger(): winston.Logger {
    const transports: winston.transport[] = [
      new winston.transports.Console({
        format: this.config.logging.format === 'json'
          ? winston.format.json()
          : winston.format.combine(
              winston.format.colorize(),
              winston.format.timestamp(),
              winston.format.printf(({ timestamp, level, message, ...meta }) => {
                const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                return `${timestamp} [${level}] ${message}${metaStr}`;
              })
            ),
      }),
    ];

    if (this.config.logging.file) {
      transports.push(new winston.transports.File({
        filename: this.config.logging.file,
        format: winston.format.json(),
      }));
    }

    return winston.createLogger({
      level: this.config.logging.level,
      transports,
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Cluster already running');
      return;
    }

    this.logger.info('Starting Claude Cluster', {
      nodeId: this.nodeId,
      clusterId: this.config.cluster.id,
    });

    try {
      // Initialize security
      await this.initializeSecurity();

      // Initialize Tailscale discovery
      await this.initializeTailscale();

      // Initialize gRPC
      await this.initializeGrpc();

      // Initialize cluster components
      await this.initializeCluster();

      // Initialize agent components
      await this.initializeAgent();

      // Initialize Kubernetes
      await this.initializeKubernetes();

      // Join or create cluster
      await this.joinOrCreateCluster();

      // Initialize MCP server
      await this.initializeMcp();

      this.running = true;
      this.logger.info('Claude Cluster started successfully');
      this.emit('started');
    } catch (error) {
      this.logger.error('Failed to start cluster', { error });
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Claude Cluster');

    // Stop MCP server
    if (this.mcpServer) {
      await this.mcpServer.stop();
    }

    // Stop scheduler
    if (this.scheduler) {
      this.scheduler.stop();
    }

    // Stop membership
    if (this.membership) {
      this.membership.stop();
    }

    // Stop Raft
    if (this.raft) {
      this.raft.stop();
    }

    // Stop health reporter
    if (this.healthReporter) {
      this.healthReporter.stop();
    }

    // Stop resource monitor
    if (this.resourceMonitor) {
      this.resourceMonitor.stop();
    }

    // Stop Tailscale discovery
    if (this.tailscale) {
      this.tailscale.stop();
    }

    // Stop approval workflow
    if (this.approval) {
      this.approval.stop();
    }

    // Stop gRPC server
    if (this.grpcServer) {
      await this.grpcServer.stop();
    }

    // Close client connections
    if (this.clientPool) {
      this.clientPool.closeAll();
    }

    this.running = false;
    this.logger.info('Claude Cluster stopped');
    this.emit('stopped');
  }

  private async initializeSecurity(): Promise<void> {
    const certsDir = this.resolvePath(this.config.security.certsDir);
    const secretsDir = this.resolvePath(this.config.security.secretsDir);

    this.authManager = new AuthManager({
      logger: this.logger,
      certsDir,
    });

    this.authzManager = new AuthzManager({ logger: this.logger });

    this.secretsManager = new SecretsManager({
      logger: this.logger,
      secretsDir,
    });

    await this.secretsManager.initialize();
    this.logger.info('Security initialized');
  }

  private async initializeTailscale(): Promise<void> {
    const available = await TailscaleDiscovery.isAvailable();
    if (!available) {
      this.logger.warn('Tailscale not available, using manual node discovery');
      return;
    }

    this.tailscale = new TailscaleDiscovery({
      logger: this.logger,
      clusterTag: this.config.network.tailscaleTag,
      pollIntervalMs: this.config.network.discoveryIntervalMs,
    });

    await this.tailscale.start();

    this.tailscale.on('nodeDiscovered', (node) => {
      this.logger.info('Discovered cluster node via Tailscale', { hostname: node.hostname });
      this.emit('nodeDiscovered', node);
    });

    this.logger.info('Tailscale discovery initialized');
  }

  private async initializeGrpc(): Promise<void> {
    const tailscaleIp = this.tailscale?.getSelfIP() ?? '0.0.0.0';

    this.clientPool = new GrpcClientPool({
      logger: this.logger,
      defaultTimeoutMs: 30000,
    });
    await this.clientPool.loadProto();

    this.grpcServer = new GrpcServer({
      host: '0.0.0.0',
      port: this.config.node.grpcPort,
      logger: this.logger,
    });
    await this.grpcServer.loadProto();

    this.logger.info('gRPC initialized', { port: this.config.node.grpcPort });
  }

  private async initializeCluster(): Promise<void> {
    const tailscaleIp = this.tailscale?.getSelfIP() ?? '127.0.0.1';
    const hostname = this.tailscale?.getSelfHostname() ?? 'localhost';

    // Raft consensus
    this.raft = new RaftNode({
      nodeId: this.nodeId,
      logger: this.logger,
      clientPool: this.clientPool!,
      electionTimeoutMinMs: this.config.raft.electionTimeoutMinMs,
      electionTimeoutMaxMs: this.config.raft.electionTimeoutMaxMs,
      heartbeatIntervalMs: this.config.raft.heartbeatIntervalMs,
      maxLogEntriesPerAppend: this.config.raft.maxLogEntriesPerAppend,
    });

    // Membership manager
    this.membership = new MembershipManager({
      nodeId: this.nodeId,
      hostname,
      tailscaleIp,
      grpcPort: this.config.node.grpcPort,
      logger: this.logger,
      raft: this.raft,
      clientPool: this.clientPool!,
      autoApprove: this.config.cluster.autoApproveEphemeral,
    });

    // Cluster state manager
    this.stateManager = new ClusterStateManager({
      clusterId: this.config.cluster.id,
      logger: this.logger,
      membership: this.membership,
      raft: this.raft,
    });

    // Task scheduler
    this.scheduler = new TaskScheduler({
      nodeId: this.nodeId,
      logger: this.logger,
      membership: this.membership,
      raft: this.raft,
      clientPool: this.clientPool!,
      maxQueueSize: this.config.scheduler.maxQueueSize,
      maxRetries: this.config.scheduler.maxRetries,
      schedulingIntervalMs: this.config.scheduler.schedulingIntervalMs,
    });

    // Approval workflow
    this.approval = new ApprovalWorkflow({
      logger: this.logger,
      autoApproveEphemeral: this.config.cluster.autoApproveEphemeral,
      autoApproveTags: this.config.cluster.autoApproveTags,
      requestTimeoutMs: this.config.security.approvalTimeoutMs,
    });

    this.logger.info('Cluster components initialized');
  }

  private async initializeAgent(): Promise<void> {
    // Resource monitor
    this.resourceMonitor = new ResourceMonitor({
      logger: this.logger,
      pollIntervalMs: this.config.resources.pollIntervalMs,
      gamingProcesses: this.config.resources.gaming?.processes,
      gamingGpuThreshold: this.config.resources.gaming?.gpuThreshold,
      gamingCooldownMs: this.config.resources.gaming?.cooldownMs,
    });

    // Task executor
    this.taskExecutor = new TaskExecutor({
      logger: this.logger,
    });

    // Health reporter
    this.healthReporter = new HealthReporter({
      logger: this.logger,
      resourceMonitor: this.resourceMonitor,
      taskExecutor: this.taskExecutor,
      checkIntervalMs: this.config.health.checkIntervalMs,
      memoryThresholdPercent: this.config.health.thresholds?.memoryPercent,
      cpuThresholdPercent: this.config.health.thresholds?.cpuPercent,
      diskThresholdPercent: this.config.health.thresholds?.diskPercent,
    });

    // Start monitoring
    await this.resourceMonitor.start();
    this.healthReporter.start();

    // Forward resource updates to membership
    this.resourceMonitor.on('snapshot', (snapshot) => {
      const protoResources = this.resourceMonitor!.toProtoResources();
      if (protoResources) {
        this.membership?.updateNodeResources(this.nodeId, {
          cpuCores: protoResources.cpu_cores,
          memoryBytes: parseInt(protoResources.memory_bytes),
          memoryAvailableBytes: parseInt(protoResources.memory_available_bytes),
          gpus: protoResources.gpus.map(g => ({
            name: g.name,
            memoryBytes: parseInt(g.memory_bytes),
            memoryAvailableBytes: parseInt(g.memory_available_bytes),
            utilizationPercent: g.utilization_percent,
            inUseForGaming: g.in_use_for_gaming,
          })),
          diskBytes: parseInt(protoResources.disk_bytes),
          diskAvailableBytes: parseInt(protoResources.disk_available_bytes),
          cpuUsagePercent: protoResources.cpu_usage_percent,
          gamingDetected: protoResources.gaming_detected,
        });
      }
    });

    this.logger.info('Agent components initialized');
  }

  private async initializeKubernetes(): Promise<void> {
    this.k8sAdapter = new KubernetesAdapter({
      logger: this.logger,
      kubeconfigPath: this.config.kubernetes.kubeconfigPath ?? undefined,
    });

    try {
      const clusters = await this.k8sAdapter.discoverClusters();
      this.logger.info('Kubernetes clusters discovered', { count: clusters.length });
    } catch (error) {
      this.logger.warn('Failed to discover Kubernetes clusters', { error });
    }
  }

  private async joinOrCreateCluster(): Promise<void> {
    // Register gRPC services
    this.grpcServer!.registerServices({
      // Services would be implemented here
      // For now, using placeholders
    });

    await this.grpcServer!.start();

    // Start Raft
    this.raft!.start();

    // Start membership
    this.membership!.start();

    // Start scheduler
    this.scheduler!.start();

    // Start approval workflow
    this.approval!.start();

    // Try to join existing cluster via seeds
    if (this.config.seeds && this.config.seeds.length > 0) {
      for (const seed of this.config.seeds) {
        try {
          const joined = await this.membership!.joinCluster(seed.address);
          if (joined) {
            this.logger.info('Joined existing cluster via seed', { seed: seed.address });
            return;
          }
        } catch (error) {
          this.logger.warn('Failed to join via seed', { seed: seed.address, error });
        }
      }
    }

    // Try to discover cluster via Tailscale
    if (this.tailscale) {
      const clusterNodes = this.tailscale.getClusterNodes();
      for (const node of clusterNodes) {
        try {
          const address = `${node.ip}:${this.config.node.grpcPort}`;
          const joined = await this.membership!.joinCluster(address);
          if (joined) {
            this.logger.info('Joined existing cluster via Tailscale', { hostname: node.hostname });
            return;
          }
        } catch (error) {
          this.logger.warn('Failed to join via Tailscale node', { hostname: node.hostname, error });
        }
      }
    }

    // Start new cluster
    this.logger.info('Starting new cluster as leader');
  }

  private async initializeMcp(): Promise<void> {
    this.mcpServer = new ClusterMcpServer({
      logger: this.logger,
      stateManager: this.stateManager!,
      membership: this.membership!,
      scheduler: this.scheduler!,
      k8sAdapter: this.k8sAdapter!,
      sessionId: this.sessionId,
      nodeId: this.nodeId,
    });

    // Note: MCP server uses stdio, so it starts when needed
    this.logger.info('MCP server initialized');
  }

  private resolvePath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(process.env.HOME ?? '', p.slice(1));
    }
    return path.resolve(p);
  }

  // Public API
  getNodeId(): string {
    return this.nodeId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.running;
  }

  isLeader(): boolean {
    return this.raft?.isLeader() ?? false;
  }

  getState() {
    return this.stateManager?.getState();
  }
}

// CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath = 'config/default.yaml';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
    }
  }

  // Load configuration
  let config: ClusterConfig;
  try {
    const configFile = await fs.readFile(configPath, 'utf-8');
    config = parseYaml(configFile) as ClusterConfig;
  } catch {
    console.error(`Failed to load config from ${configPath}, using defaults`);
    // Load from package default
    const defaultConfigPath = path.join(__dirname, '../config/default.yaml');
    const configFile = await fs.readFile(defaultConfigPath, 'utf-8');
    config = parseYaml(configFile) as ClusterConfig;
  }

  const cluster = new ClaudeCluster(config);

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down...');
    await cluster.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down...');
    await cluster.stop();
    process.exit(0);
  });

  // Start the cluster
  await cluster.start();
}

// Export for programmatic use
export { ClaudeCluster as default };

// Run if executed directly
const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
