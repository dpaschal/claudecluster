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
import { RaftNode } from './cluster/raft.js';
import { MembershipManager } from './cluster/membership.js';
import { ClusterStateManager } from './cluster/state.js';
import { TaskScheduler } from './cluster/scheduler.js';
import { TailscaleDiscovery } from './discovery/tailscale.js';
import { ApprovalWorkflow } from './discovery/approval.js';
import { ClusterMcpServer } from './mcp/server.js';
import { AuthManager, AuthzManager } from './security/auth.js';
import { SecretsManager } from './security/secrets.js';
import { ClusterAnnouncer } from './cluster/announcements.js';
import { createClusterServiceHandlers, createRaftServiceHandlers, createAgentServiceHandlers } from './grpc/handlers.js';
import { Command } from 'commander';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import * as os from 'os';
import { SharedMemoryDB } from './memory/shared-memory-db.js';
import { MemoryReplicator } from './memory/replication.js';
import { ProviderRouter } from './providers/router.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { PluginLoader } from './plugins/loader.js';
import { BUILTIN_PLUGINS } from './plugins/registry.js';
import type { PluginContext } from './plugins/types.js';
import type { LLMProvider } from './providers/types.js';

export interface ClusterModeOptions {
  invisible?: boolean;  // Can see cluster but isn't announced
  isolated?: boolean;   // No cluster connection at all
}

export interface ClusterConfig {
  cluster: {
    id: string;
    autoApprove?: boolean;
    autoApproveTags?: string[];
    autoApproveEphemeral?: boolean;
  };
  mode?: ClusterModeOptions;
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
  messaging?: {
    enabled: boolean;
    agent?: string;
    inboxPath?: string;
    channels?: {
      discord?: { enabled: boolean; token?: string; guildId?: string };
      telegram?: { enabled: boolean; token?: string };
    };
  };
  providers?: {
    primary: string;
    fallback?: string[];
    anthropic?: { model?: string; apiKey?: string };
    openai?: { model?: string; apiKey?: string; baseUrl?: string };
    ollama?: { model?: string; baseUrl?: string };
  };
  skills?: {
    enabled: boolean;
    directories?: string[];
    hotReload?: boolean;
  };
  plugins?: Record<string, { enabled: boolean; [key: string]: unknown }>;
  seeds?: Array<{ address: string }>;
}

export class Cortex extends EventEmitter {
  private config: ClusterConfig;
  private logger: winston.Logger;
  private nodeId: string;
  private sessionId: string;

  // Components
  private grpcServer: GrpcServer | null = null;
  private clientPool: GrpcClientPool | null = null;
  private resourceMonitor: ResourceMonitor | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private raft: RaftNode | null = null;
  private membership: MembershipManager | null = null;
  private stateManager: ClusterStateManager | null = null;
  private scheduler: TaskScheduler | null = null;
  private tailscale: TailscaleDiscovery | null = null;
  private approval: ApprovalWorkflow | null = null;
  private mcpServer: ClusterMcpServer | null = null;
  private sharedMemoryDb: SharedMemoryDB | null = null;
  private memoryReplicator: MemoryReplicator | null = null;
  private authManager: AuthManager | null = null;
  private authzManager: AuthzManager | null = null;
  private secretsManager: SecretsManager | null = null;
  private announcer: ClusterAnnouncer | null = null;
  private providerRouter: ProviderRouter | null = null;
  private pluginLoader: PluginLoader | null = null;

  private running = false;
  private mcpMode = false;

  constructor(config: ClusterConfig, options?: { mcpMode?: boolean }) {
    super();
    this.config = config;
    this.mcpMode = options?.mcpMode ?? false;
    this.nodeId = this.getOrCreateNodeId();
    this.sessionId = randomUUID();
    this.logger = this.createLogger();
  }

  /**
   * Get persistent node ID from file, or create a new one.
   * Node IDs are stored in ~/.cortex/node-id to survive restarts.
   * Falls back to ~/.claudecluster/node-id for migration.
   * Format: hostname-shortid (e.g., "rog2-8e800054")
   */
  private getOrCreateNodeId(): string {
    const os = require('os');
    const fs = require('fs');
    const nodePath = require('path');

    const homeDir = process.env.HOME || os.homedir();
    const newConfigDir = nodePath.join(homeDir, '.cortex');
    const oldConfigDir = nodePath.join(homeDir, '.claudecluster');

    // Check new path first, then fall back to old path for migration
    for (const configDir of [newConfigDir, oldConfigDir]) {
      const nodeIdFile = nodePath.join(configDir, 'node-id');
      try {
        const existingId = fs.readFileSync(nodeIdFile, 'utf-8').trim();
        if (existingId) {
          // If found in old dir, copy to new dir
          if (configDir === oldConfigDir) {
            try {
              fs.mkdirSync(newConfigDir, { recursive: true });
              fs.writeFileSync(nodePath.join(newConfigDir, 'node-id'), existingId);
            } catch { /* best effort migration */ }
          }
          const hostname = os.hostname().split('.')[0];
          const suffix = this.mcpMode ? '-mcp' : '';
          return `${hostname}-${existingId}${suffix}`;
        }
      } catch { /* try next */ }
    }

    // Generate new short ID, write to new path
    const shortId = randomUUID().slice(0, 8);
    try {
      fs.mkdirSync(newConfigDir, { recursive: true });
      fs.writeFileSync(nodePath.join(newConfigDir, 'node-id'), shortId);
    } catch (error) {
      console.warn('Could not persist node ID:', error);
    }

    const hostname = os.hostname().split('.')[0];
    const suffix = this.mcpMode ? '-mcp' : '';
    return `${hostname}-${shortId}${suffix}`;
  }

  private createLogger(): winston.Logger {
    const transports: winston.transport[] = [];

    // In MCP mode, only log to file to keep stdio clean
    if (!this.mcpMode) {
      transports.push(
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
        })
      );
    }

    // Always add file transport if configured
    if (this.config.logging.file) {
      transports.push(
        new winston.transports.File({
          filename: this.config.logging.file,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    // Ensure at least one transport
    if (transports.length === 0) {
      transports.push(
        new winston.transports.File({
          filename: '/tmp/cortex.log',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
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

    // Check for isolated mode - no cluster connection
    if (this.config.mode?.isolated) {
      this.logger.info('Starting in isolated mode (no cluster connection)');
      if (!this.mcpMode) {
        console.log('\n' + '='.repeat(60));
        console.log('  Cortex - ISOLATED MODE');
        console.log('='.repeat(60));
        console.log('  Not connected to any cluster.');
        console.log('  Use --invisible or no flags to join the cluster.');
        console.log('='.repeat(60) + '\n');
      }
      this.running = true;
      return;
    }

    const modeStr = this.config.mode?.invisible ? ' (invisible mode)' : '';
    this.logger.info(`Starting Cortex${modeStr}`, {
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

      // Initialize announcements
      this.initializeAnnouncements();

      // Initialize core agent (resource monitor + task executor for gRPC handlers)
      await this.initializeAgent();

      // Initialize providers (not a plugin yet)
      await this.initializeProviders();

      // Initialize plugins (replaces k8s, messaging, skills)
      await this.initializePlugins();

      if (this.mcpMode) {
        // In MCP mode, start serving immediately — cluster joins in background
        await this.initializeMcp();
        this.running = true;
        this.logger.info('MCP server ready, joining cluster in background');
        this.emit('started');

        // Listen for rejoin requests from membership (sleep/wake recovery)
        this.membership!.on('rejoinNeeded', () => this.rejoinCluster());

        // Join cluster in background — don't block MCP
        this.joinOrCreateCluster().then(() => {
          // Start plugin background work after cluster join
          return this.pluginLoader!.startAll();
        }).catch((error) => {
          this.logger.error('Background cluster join failed', { error });
        });
      } else {
        // Normal mode: join cluster first, then init MCP
        await this.joinOrCreateCluster();

        // Start plugin background work
        await this.pluginLoader!.startAll();

        // Listen for rejoin requests from membership (sleep/wake recovery)
        this.membership!.on('rejoinNeeded', () => this.rejoinCluster());

        await this.initializeMcp();
        this.running = true;
        this.logger.info('Cortex started successfully');
        this.emit('started');
      }
    } catch (error) {
      this.logger.error('Failed to start cluster', { error });
      await this.stop();
      throw error;
    }
  }

  stepDown(): boolean {
    return this.raft?.stepDown() ?? false;
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping Cortex');

    // Stop MCP server
    if (this.mcpServer) {
      await this.mcpServer.stop();
    }

    // Stop all plugins (reverse order)
    if (this.pluginLoader) {
      await this.pluginLoader.stopAll();
    }

    // Stop memory replicator and close shared memory DB
    if (this.memoryReplicator) {
      this.memoryReplicator.stop();
    }
    if (this.sharedMemoryDb) {
      this.sharedMemoryDb.close();
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
    this.logger.info('Cortex stopped');
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

    // Raft consensus (MCP process is non-voting observer only)
    const os = require('os');
    const configDir = require('path').join(process.env.HOME || os.homedir(), '.cortex');
    this.raft = new RaftNode({
      nodeId: this.nodeId,
      logger: this.logger,
      clientPool: this.clientPool!,
      electionTimeoutMinMs: this.config.raft.electionTimeoutMinMs,
      electionTimeoutMaxMs: this.config.raft.electionTimeoutMaxMs,
      heartbeatIntervalMs: this.config.raft.heartbeatIntervalMs,
      maxLogEntriesPerAppend: this.config.raft.maxLogEntriesPerAppend,
      nonVoting: this.mcpMode,
      dataDir: configDir,
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
      autoApprove: this.config.cluster.autoApprove ?? this.config.cluster.autoApproveEphemeral,
    });

    // Shared memory database (Raft-replicated SQLite)
    this.sharedMemoryDb = new SharedMemoryDB({
      dataDir: configDir,
      logger: this.logger,
    });

    this.memoryReplicator = new MemoryReplicator({
      db: this.sharedMemoryDb,
      raft: this.raft,
      membership: this.membership,
      clientPool: this.clientPool!,
      logger: this.logger,
      nodeId: this.nodeId,
    });

    // Start periodic integrity checks (every 5 minutes)
    this.memoryReplicator.startIntegrityChecks(5 * 60 * 1000);

    // Cluster state manager
    this.stateManager = new ClusterStateManager({
      clusterId: this.config.cluster.id,
      logger: this.logger,
      membership: this.membership,
      raft: this.raft,
    });

    // Task scheduler (legacy — skipped when task-engine plugin is enabled)
    if (this.config.plugins?.['task-engine']?.enabled) {
      this.logger.info('Task engine plugin enabled — skipping legacy TaskScheduler');
      this.scheduler = null;
    } else {
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
    }

    // Approval workflow
    this.approval = new ApprovalWorkflow({
      logger: this.logger,
      autoApproveEphemeral: this.config.cluster.autoApproveEphemeral,
      autoApproveTags: this.config.cluster.autoApproveTags,
      requestTimeoutMs: this.config.security.approvalTimeoutMs,
    });

    this.logger.info('Cluster components initialized');
  }

  private initializeAnnouncements(): void {
    const hostname = this.tailscale?.getSelfHostname() ?? 'localhost';

    this.announcer = new ClusterAnnouncer({
      nodeId: this.nodeId,
      hostname,
      logger: this.logger,
      membership: this.membership!,
      clientPool: this.clientPool!,
      invisible: this.config.mode?.invisible,
      silent: this.mcpMode,
    });

    // Forward announcements to event emitter
    this.announcer.on('announcement', (announcement) => {
      this.emit('clusterAnnouncement', announcement);
    });

    this.logger.info('Announcements initialized', {
      invisible: this.config.mode?.invisible ?? false,
    });
  }

  /**
   * Initialize core agent components needed for gRPC handler registration.
   * Health reporting and event wiring are handled by the resource-monitor plugin.
   * TODO: Unify with resource-monitor plugin when gRPC handlers are refactored.
   */
  private async initializeAgent(): Promise<void> {
    this.resourceMonitor = new ResourceMonitor({
      logger: this.logger,
      pollIntervalMs: this.config.resources.pollIntervalMs,
      gamingProcesses: this.config.resources.gaming?.processes,
      gamingGpuThreshold: this.config.resources.gaming?.gpuThreshold,
      gamingCooldownMs: this.config.resources.gaming?.cooldownMs,
    });

    this.taskExecutor = new TaskExecutor({
      logger: this.logger,
    });

    await this.resourceMonitor.start();
    this.logger.info('Agent core initialized (resource monitor + task executor)');
  }

  private async initializePlugins(): Promise<void> {
    this.pluginLoader = new PluginLoader(this.logger);

    const pluginEvents = new EventEmitter();

    // Forward resource snapshots from plugins to membership
    pluginEvents.on('resource:snapshot', (snapshot) => {
      if (this.membership && snapshot) {
        this.membership.updateNodeResources(this.nodeId, {
          cpuCores: snapshot.cpuCores ?? snapshot.cpu?.cores ?? 0,
          memoryBytes: snapshot.memoryBytes ?? snapshot.memory?.total ?? 0,
          memoryAvailableBytes: snapshot.memoryAvailableBytes ?? snapshot.memory?.available ?? 0,
          gpus: snapshot.gpus ?? [],
          diskBytes: snapshot.diskBytes ?? snapshot.disk?.total ?? 0,
          diskAvailableBytes: snapshot.diskAvailableBytes ?? snapshot.disk?.available ?? 0,
          cpuUsagePercent: snapshot.cpuUsagePercent ?? snapshot.cpu?.usage ?? 0,
          gamingDetected: snapshot.gamingDetected ?? false,
        });
      }
    });

    const ctx: PluginContext = {
      raft: this.raft!,
      membership: this.membership!,
      scheduler: this.scheduler ?? undefined,
      stateManager: this.stateManager!,
      clientPool: this.clientPool!,
      sharedMemoryDb: this.sharedMemoryDb!,
      memoryReplicator: this.memoryReplicator!,
      logger: this.logger,
      nodeId: this.nodeId,
      sessionId: this.sessionId,
      config: {},
      events: pluginEvents,
      provider: this.providerRouter ?? undefined,
      getTools: () => this.pluginLoader!.getAllTools(),
    };

    const pluginsConfig = this.config.plugins ?? {
      'memory': { enabled: true },
      'cluster-tools': { enabled: true },
      'resource-monitor': { enabled: true },
      'updater': { enabled: true },
    };

    await this.pluginLoader.loadAll(pluginsConfig, ctx, BUILTIN_PLUGINS);
    this.logger.info('Plugins loaded', {
      count: this.pluginLoader.getAllTools().size,
      tools: [...this.pluginLoader.getAllTools().keys()],
    });
  }

  private async initializeProviders(): Promise<void> {
    const provConfig = this.config.providers;
    if (!provConfig) return;

    const providers: Record<string, LLMProvider> = {};
    if (provConfig.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY) {
      providers.anthropic = new AnthropicProvider({
        apiKey: provConfig.anthropic?.apiKey || undefined,
        model: provConfig.anthropic?.model,
      });
    }
    if (provConfig.openai?.apiKey) {
      providers.openai = new OpenAIProvider({
        apiKey: provConfig.openai.apiKey,
        model: provConfig.openai.model,
      });
    }
    if (provConfig.ollama) {
      providers.ollama = new OllamaProvider({
        baseUrl: provConfig.ollama.baseUrl,
        model: provConfig.ollama.model,
      });
    }

    const primary = providers[provConfig.primary];
    if (!primary) return;

    const fallback = (provConfig.fallback ?? [])
      .map(name => providers[name])
      .filter((p): p is LLMProvider => Boolean(p));

    this.providerRouter = new ProviderRouter({ primary, fallback });
    this.logger.info('Provider router initialized', {
      primary: provConfig.primary,
      fallback: provConfig.fallback,
    });
  }

  private async joinOrCreateCluster(): Promise<void> {
    // Register gRPC services with actual handlers
    const handlerConfig = {
      logger: this.logger,
      nodeId: this.nodeId,
      membership: this.membership!,
      raft: this.raft!,
      scheduler: this.scheduler ?? undefined,
      stateManager: this.stateManager!,
      taskExecutor: this.taskExecutor!,
      resourceMonitor: this.resourceMonitor!,
    };

    this.grpcServer!.registerServices({
      clusterService: createClusterServiceHandlers(handlerConfig),
      raftService: createRaftServiceHandlers(handlerConfig),
      agentService: createAgentServiceHandlers(handlerConfig),
    });

    await this.grpcServer!.start();

    // Start Raft with elections paused to prevent split-brain during join
    this.raft!.pauseElections();
    this.raft!.start();

    // Start membership
    this.membership!.start();

    // Start scheduler (skipped when task-engine plugin is enabled)
    this.scheduler?.start();

    // Start approval workflow
    this.approval!.start();

    // Wait for network to be ready before attempting cluster join
    await this.waitForNetworkReady();

    // Try to join existing cluster with retries
    const joined = await this.joinClusterWithRetry();

    // Resume elections now that join phase is complete
    // If we joined, leader heartbeats will keep resetting our election timer
    // If we didn't join, we can become leader of a new cluster
    this.raft!.resumeElections();

    if (joined) {
      this.logger.info('Successfully joined existing cluster');
      return;
    }

    // Start new cluster only after exhausting all join attempts
    this.logger.info('Starting new cluster as leader');
  }

  /**
   * Rejoin the cluster after connectivity loss (e.g., laptop sleep/wake).
   * Pauses elections to prevent split-brain, waits for network, re-joins, then resumes.
   */
  private async rejoinCluster(): Promise<void> {
    if (!this.membership || !this.raft) return;

    this.membership.setRejoinInProgress(true);
    this.logger.info('Attempting cluster rejoin after connectivity loss');

    try {
      this.raft.pauseElections();
      await this.waitForNetworkReady();
      const joined = await this.joinClusterWithRetry();
      this.raft.resumeElections();

      if (joined) {
        this.logger.info('Successfully rejoined cluster');
        this.membership.resetHeartbeatFailures();
      } else {
        this.logger.warn('Rejoin failed — will retry on next heartbeat failure cycle');
      }
    } catch (error) {
      this.logger.error('Rejoin attempt threw an error', { error });
      this.raft.resumeElections();
    } finally {
      this.membership.setRejoinInProgress(false);
    }
  }

  /**
   * Wait for Tailscale network to be ready before attempting cluster operations.
   * This prevents the race condition where we try to join before network is up.
   */
  private async waitForNetworkReady(): Promise<void> {
    const maxWaitMs = 30000; // 30 seconds max wait
    const checkIntervalMs = 1000;
    const startTime = Date.now();

    this.logger.info('Waiting for network to be ready...');

    while (Date.now() - startTime < maxWaitMs) {
      // Check if Tailscale has discovered any nodes (including ourselves)
      if (this.tailscale) {
        const nodes = this.tailscale.getClusterNodes();
        if (nodes.length > 0) {
          this.logger.info('Network ready', { discoveredNodes: nodes.length });
          return;
        }
      }

      // Also try a simple connectivity check to seeds
      if (this.config.seeds && this.config.seeds.length > 0) {
        for (const seed of this.config.seeds) {
          try {
            // Quick TCP connectivity check
            const [host, port] = seed.address.split(':');
            const isReachable = await this.checkPortReachable(host, parseInt(port), 2000);
            if (isReachable) {
              this.logger.info('Network ready - seed reachable', { seed: seed.address });
              return;
            }
          } catch {
            // Ignore errors, keep waiting
          }
        }
      }

      await this.sleep(checkIntervalMs);
    }

    this.logger.warn('Network readiness timeout - proceeding anyway', { waitedMs: maxWaitMs });
  }

  /**
   * Check if a TCP port is reachable with timeout.
   */
  private checkPortReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();

      socket.setTimeout(timeoutMs);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Try to join an existing cluster with exponential backoff retry.
   * This is the proper way to handle transient network failures during startup.
   */
  private async joinClusterWithRetry(): Promise<boolean> {
    const maxAttempts = 5;
    const initialDelayMs = 1000;
    const maxDelayMs = 10000;

    // Collect all possible addresses to try
    const addresses: Array<{ address: string; source: string }> = [];

    // Get our own IP and hostname to avoid self-registration
    const selfIp = this.tailscale?.getSelfIP() ?? '127.0.0.1';
    const selfHostname = require('os').hostname().split('.')[0];

    // Add configured seeds
    if (this.config.seeds) {
      for (const seed of this.config.seeds) {
        // Skip if seed is our own address (check localhost, 127.0.0.1, our IP, and hostname)
        const seedHost = seed.address.split(':')[0];
        const seedPort = seed.address.split(':')[1] || '50051';
        const selfPort = String(this.config.node.grpcPort);
        // Only skip if both host AND port match (MCP on :50052 should still seed off :50051)
        if (
          (seedHost === '127.0.0.1' || seedHost === 'localhost' || seedHost === selfIp || seedHost === selfHostname) &&
          seedPort === selfPort
        ) {
          this.logger.debug('Skipping self as seed', { seed: seed.address, selfIp, selfHostname });
          continue;
        }
        addresses.push({ address: seed.address, source: 'seed' });
      }
    }

    // Add Tailscale-discovered nodes
    if (this.tailscale) {
      const clusterNodes = this.tailscale.getClusterNodes();
      for (const node of clusterNodes) {
        // Use standard gRPC port (50051), not the local node's port
        // (MCP process runs on 50052 but cluster nodes listen on 50051)
        const address = `${node.ip}:50051`;
        // Skip if this is our own node
        if (node.hostname !== require('os').hostname()) {
          addresses.push({ address, source: `tailscale:${node.hostname}` });
        }
      }
    }

    if (addresses.length === 0) {
      this.logger.warn('No seed nodes or cluster peers found — all seeds point to self. This node will bootstrap as a new cluster.', {
        selfIp,
        selfHostname,
        configuredSeeds: this.config.seeds?.map(s => s.address) ?? [],
      });
      return false;
    }

    this.logger.info('Attempting to join cluster', {
      candidates: addresses.length,
      maxAttempts
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

      // Try each address
      for (const { address, source } of addresses) {
        try {
          this.logger.debug('Trying to join via', { address, source, attempt });
          const joined = await this.membership!.joinCluster(address);
          if (joined) {
            this.logger.info('Joined existing cluster', {
              address,
              source,
              attempt
            });
            return true;
          }
        } catch (error) {
          this.logger.debug('Join attempt failed', {
            address,
            source,
            attempt,
            error: (error as Error).message
          });
        }
      }

      // If not the last attempt, wait before retrying
      if (attempt < maxAttempts) {
        this.logger.info('Cluster join failed, retrying...', {
          attempt,
          nextAttemptIn: `${delayMs}ms`
        });
        await this.sleep(delayMs);

        // Refresh Tailscale-discovered nodes for next attempt
        if (this.tailscale) {
          const newNodes = this.tailscale.getClusterNodes();
          for (const node of newNodes) {
            const address = `${node.ip}:${this.config.node.grpcPort}`;
            if (node.hostname !== require('os').hostname()) {
              const exists = addresses.some(a => a.address === address);
              if (!exists) {
                addresses.push({ address, source: `tailscale:${node.hostname}` });
                this.logger.debug('Discovered new node', { hostname: node.hostname });
              }
            }
          }
        }
      }
    }

    this.logger.warn('Failed to join cluster after all attempts', {
      attempts: maxAttempts,
      triedAddresses: addresses.length
    });
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async initializeMcp(): Promise<void> {
    this.mcpServer = new ClusterMcpServer({
      logger: this.logger,
      tools: this.pluginLoader!.getAllTools(),
      resources: this.pluginLoader!.getAllResources(),
    });

    this.logger.info('MCP server initialized', {
      tools: this.pluginLoader!.getAllTools().size,
      resources: this.pluginLoader!.getAllResources().size,
    });

    if (this.mcpMode) {
      this.logger.info('Starting MCP server in stdio mode');
      await this.mcpServer.start();
    }
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

// MCP-only mode for Claude Code integration
// Starts a full cluster node but with logging redirected to file
// so stdio is clean for MCP communication
async function runMcpServer(config: ClusterConfig, options: { seed?: string; verbose?: boolean; port?: string }): Promise<void> {
  // Force logging to file only (MCP uses stdio)
  config.logging.file = '/tmp/cortex-mcp.log';

  // Apply CLI overrides
  if (options.port) {
    config.node.grpcPort = parseInt(options.port);
  } else {
    // Use a different port than the systemd service (50051) to avoid conflicts
    config.node.grpcPort = 50052;
  }
  if (options.seed) {
    config.seeds = [{ address: options.seed }];
  }
  if (options.verbose) {
    config.logging.level = 'debug';
  }

  // Mark as invisible so we don't spam announcements
  config.mode = {
    invisible: true,
    isolated: false,
  };

  // Create cluster with file-only logging
  const cluster = new Cortex(config, { mcpMode: true });

  // Handle shutdown
  process.on('SIGINT', async () => {
    await cluster.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cluster.stop();
    process.exit(0);
  });

  // Start cluster (will start MCP server with stdio)
  await cluster.start();
}

// CLI entry point
function showBanner(): void {
  const banner = `
${chalk.cyan(`   _____ ___  ____ _____ _______  __
  / ____/ __ \\|  _ \\_   _|  ____\\ \\/ /
 | |   | |  | | |_) || | | |__   \\  /
 | |   | |  | |  _ < | | |  __|  /  \\
 | |___| |__| | |_) || |_| |____/ /\\ \\
  \\_____\\____/|____/_____|______/_/  \\_\\`)}

        ${chalk.magenta('╔═══════════════════════════════════════╗')}
        ${chalk.magenta('║')}   ${chalk.white.bold('Distributed AI Mesh')} ${chalk.cyan('◈')} ${chalk.yellow('Raft + gRPC')}    ${chalk.magenta('║')}
        ${chalk.magenta('╚═══════════════════════════════════════╝')}
`;
  console.log(banner);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('cortex')
    .description('Distributed AI mesh with Raft consensus and MCP integration')
    .version('0.1.0')
    .option('-c, --config <path>', 'Path to configuration file', 'config/default.yaml')
    .option('--mcp', 'Run as MCP server only (for Claude Code integration)')
    .option('--invisible', 'Connect to cluster without announcing presence (can see others, they cannot see you)')
    .option('--isolated', 'Run without any cluster connection')
    .option('-p, --port <number>', 'gRPC port to listen on')
    .option('-s, --seed <address>', 'Seed node address to join cluster')
    .option('-v, --verbose', 'Enable verbose logging');

  // Register CLI subcommands (status, deploy, test, etc.)
  const { registerCliCommands } = await import('./commands.js');
  registerCliCommands(program);

  // If a subcommand was given, commander runs it and we're done.
  // Otherwise fall through to daemon startup.
  const CLI_COMMANDS = [
    'status', 'switch-leader', 'squelch', 'deploy', 'test',
    'events', 'top', 'run', 'ssh', 'logs',
    'drain', 'cordon', 'uncordon',
    'tasks', 'snapshot', 'diag', 'config',
    'help',
  ];
  const firstArg = process.argv[2];
  if (firstArg && CLI_COMMANDS.includes(firstArg)) {
    await program.parseAsync(process.argv);
    return;
  }

  program.parse(process.argv);

  const options = program.opts();

  // Show banner unless in MCP mode (MCP uses stdio for JSON)
  if (!options.mcp) {
    showBanner();
  }

  // Load configuration
  let config: ClusterConfig;
  try {
    const configFile = await fs.readFile(options.config, 'utf-8');
    config = parseYaml(configFile) as ClusterConfig;
  } catch {
    console.error(`Failed to load config from ${options.config}, using defaults`);
    // Load from package default
    const defaultConfigPath = path.join(__dirname, '../config/default.yaml');
    const configFile = await fs.readFile(defaultConfigPath, 'utf-8');
    config = parseYaml(configFile) as ClusterConfig;
  }

  // Apply CLI options to config
  config.mode = {
    invisible: options.invisible ?? false,
    isolated: options.isolated ?? false,
  };

  if (options.port) {
    config.node.grpcPort = parseInt(options.port);
  }

  if (options.seed) {
    config.seeds = [{ address: options.seed }];
  }

  if (options.verbose) {
    config.logging.level = 'debug';
  }

  // MCP-only mode for Claude Code integration
  if (options.mcp) {
    await runMcpServer(config, options);
    return;
  }

  const cluster = new Cortex(config);

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await cluster.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await cluster.stop();
    process.exit(0);
  });

  process.on('SIGUSR1', () => {
    if (cluster.stepDown()) {
      console.log('SIGUSR1: Leader stepped down. New election in progress.');
    } else {
      console.log('SIGUSR1: Not the leader, ignoring.');
    }
  });

  // Start the cluster
  await cluster.start();

  // If not isolated, show ready message
  if (!config.mode.isolated) {
    const modeStr = config.mode.invisible ? ' (invisible)' : '';
    console.log(`\nCortex node ready${modeStr}. Press Ctrl+C to exit.\n`);
  }
}

// Export for programmatic use
export { Cortex as default };

// Run if executed directly
import { realpathSync } from 'node:fs';
const resolvedMain = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return process.argv[1] ?? ''; } })();
const isMain = resolvedMain.endsWith('index.js') || resolvedMain.endsWith('index.ts');
if (isMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
