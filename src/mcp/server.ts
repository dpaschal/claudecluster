import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'winston';
import { ToolHandler, ResourceHandler } from '../plugins/types.js';

export interface McpServerConfig {
  logger: Logger;
  tools: Map<string, ToolHandler>;
  resources: Map<string, ResourceHandler>;
}

export class ClusterMcpServer {
  private config: McpServerConfig;
  private server: Server;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: 'cortex',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.config.tools.entries()).map(([name, handler]) => ({
        name,
        description: handler.description,
        inputSchema: handler.inputSchema,
      }));
      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.config.tools.get(name);

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
      const resources = Array.from(this.config.resources.entries()).map(([_, handler]) => ({
        uri: handler.uri,
        name: handler.name,
        description: handler.description,
        mimeType: handler.mimeType,
      }));
      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const handler = this.config.resources.get(uri);

      if (!handler) {
        return {
          contents: [{
            uri,
            mimeType: 'text/plain',
            text: `Unknown resource: ${uri}`,
          }],
        };
      }

      const content = await handler.handler();
      return {
        contents: [{
          uri,
          mimeType: handler.mimeType,
          text: JSON.stringify(content, null, 2),
        }],
      };
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.config.logger.info('MCP server started', { tools: this.config.tools.size, resources: this.config.resources.size });
  }

  /**
   * Update tools and resources after lazy initialization.
   * Handlers read from the Maps by reference at call time, so newly added
   * entries are visible immediately without reconnecting the transport.
   */
  updateToolsAndResources(tools: Map<string, ToolHandler>, resources: Map<string, ResourceHandler>): void {
    for (const [name, handler] of tools) {
      this.config.tools.set(name, handler);
    }
    for (const [uri, handler] of resources) {
      this.config.resources.set(uri, handler);
    }
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.config.logger.info('MCP server stopped');
  }
}
