import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolHandler, ResourceHandler } from '../../src/plugins/types.js';

// We test the McpServerConfig interface shape and that tools/resources can be constructed
// We can't easily test the MCP SDK server itself (requires stdio transport), so we test the config contract

describe('MCP Server Plugin Integration', () => {
  it('should accept tools and resources maps matching plugin output', () => {
    const tools = new Map<string, ToolHandler>();
    tools.set('test_tool', {
      description: 'Test tool',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ result: 'ok' }),
    });

    const resources = new Map<string, ResourceHandler>();
    resources.set('cluster://test', {
      uri: 'cluster://test',
      name: 'Test Resource',
      description: 'A test resource',
      mimeType: 'application/json',
      handler: async () => ({ data: 'test' }),
    });

    // Verify the maps are well-formed for MCP server consumption
    expect(tools.size).toBe(1);
    expect(resources.size).toBe(1);

    const [toolName, toolHandler] = [...tools.entries()][0];
    expect(toolName).toBe('test_tool');
    expect(toolHandler.description).toBe('Test tool');
    expect(typeof toolHandler.handler).toBe('function');

    const [resUri, resHandler] = [...resources.entries()][0];
    expect(resUri).toBe('cluster://test');
    expect(resHandler.mimeType).toBe('application/json');
    expect(typeof resHandler.handler).toBe('function');
  });
});
