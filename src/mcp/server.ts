import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'winston';
import { ClusterStateManager, ClaudeSession, ContextEntry } from '../cluster/state.js';
import { MembershipManager } from '../cluster/membership.js';
import { TaskScheduler, TaskSpec, TaskStatus } from '../cluster/scheduler.js';
import { KubernetesAdapter, K8sJobSpec } from '../kubernetes/adapter.js';
import { GrpcClientPool } from '../grpc/client.js';
import { RaftNode } from '../cluster/raft.js';
import { createTools, ToolHandler } from './tools.js';
import { createTimelineTools } from './timeline-tools.js';
import { TimelineDB } from './timeline-db.js';
import { createNetworkTools } from './network-tools.js';
import { NetworkDB } from './network-db.js';
import { createContextTools } from './context-tools.js';
import { ContextDB } from './context-db.js';

export interface McpServerConfig {
  logger: Logger;
  stateManager: ClusterStateManager;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  k8sAdapter: KubernetesAdapter;
  clientPool: GrpcClientPool;
  raft: RaftNode;
  sessionId: string;
  nodeId: string;
}

export class ClusterMcpServer {
  private config: McpServerConfig;
  private server: Server;
  private toolHandlers: Map<string, ToolHandler>;
  private timelineDb: TimelineDB | null = null;
  private networkDb: NetworkDB | null = null;
  private contextDb: ContextDB | null = null;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: 'claudecluster',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.toolHandlers = this.createToolHandlers();
    this.setupHandlers();
  }

  private createToolHandlers(): Map<string, ToolHandler> {
    const clusterTools = createTools({
      stateManager: this.config.stateManager,
      membership: this.config.membership,
      scheduler: this.config.scheduler,
      k8sAdapter: this.config.k8sAdapter,
      clientPool: this.config.clientPool,
      raft: this.config.raft,
      sessionId: this.config.sessionId,
      nodeId: this.config.nodeId,
      logger: this.config.logger,
    });

    // Add timeline tools
    const { tools: timelineTools, db } = createTimelineTools({
      logger: this.config.logger,
    });
    this.timelineDb = db;

    for (const [name, handler] of timelineTools) {
      clusterTools.set(name, handler);
    }

    // Add network tools
    const { tools: networkTools, db: netDb } = createNetworkTools({
      logger: this.config.logger,
    });
    this.networkDb = netDb;

    for (const [name, handler] of networkTools) {
      clusterTools.set(name, handler);
    }

    // Add context tools
    const { tools: contextTools, db: ctxDb } = createContextTools({
      logger: this.config.logger,
    });
    this.contextDb = ctxDb;

    for (const [name, handler] of contextTools) {
      clusterTools.set(name, handler);
    }

    return clusterTools;
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.toolHandlers.entries()).map(([name, handler]) => ({
        name,
        description: handler.description,
        inputSchema: handler.inputSchema,
      }));

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.toolHandlers.get(name);

      if (!handler) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      try {
        this.config.logger.debug('Executing MCP tool', { name, args });
        const result = await handler.handler(args ?? {});

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        this.config.logger.error('Tool execution failed', { name, error });
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    });

    // List resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [
        {
          uri: 'cluster://state',
          name: 'Cluster State',
          description: 'Current state of the Claude Cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://nodes',
          name: 'Cluster Nodes',
          description: 'List of all nodes in the cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://sessions',
          name: 'Claude Sessions',
          description: 'Active Claude sessions in the cluster',
          mimeType: 'application/json',
        },
        {
          uri: 'cluster://k8s',
          name: 'Kubernetes Clusters',
          description: 'Available Kubernetes clusters',
          mimeType: 'application/json',
        },
      ];

      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      let content: unknown;

      switch (uri) {
        case 'cluster://state':
          content = this.config.stateManager.getState();
          break;

        case 'cluster://nodes':
          content = this.config.membership.getAllNodes();
          break;

        case 'cluster://sessions':
          content = this.config.stateManager.getSessions();
          break;

        case 'cluster://k8s':
          content = this.config.k8sAdapter.listClusters();
          break;

        default:
          return {
            contents: [{
              uri,
              mimeType: 'text/plain',
              text: `Unknown resource: ${uri}`,
            }],
          };
      }

      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(content, null, 2),
        }],
      };
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.config.logger.info('MCP server started');
  }

  async stop(): Promise<void> {
    if (this.timelineDb) {
      await this.timelineDb.close();
    }
    if (this.networkDb) {
      await this.networkDb.close();
    }
    if (this.contextDb) {
      await this.contextDb.close();
    }
    await this.server.close();
    this.config.logger.info('MCP server stopped');
  }
}
