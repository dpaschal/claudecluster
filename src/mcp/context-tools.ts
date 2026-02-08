// src/mcp/context-tools.ts
import { Logger } from 'winston';
import { ContextDB, ContextCategory, SetContextParams, ListContextParams } from './context-db.js';
import { ToolHandler } from './tools.js';

export interface ContextToolsConfig {
  logger: Logger;
  connectionString?: string;
}

export function createContextTools(config: ContextToolsConfig): { tools: Map<string, ToolHandler>; db: ContextDB } {
  const db = new ContextDB(config.connectionString);
  const tools = new Map<string, ToolHandler>();

  // context_set
  tools.set('context_set', {
    description: 'Create or update a context entry. Use this to remember project facts, PR status, machine info, or anything that should persist across Claude sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Namespaced key, e.g., "project:meshcore-monitor", "pr:Yeraze/meshmonitor:1777", "machine:chisel"',
        },
        value: {
          type: 'object',
          description: 'Structured data to store (JSON object)',
        },
        category: {
          type: 'string',
          description: 'Category for filtering',
          enum: ['project', 'pr', 'machine', 'waiting', 'fact'],
        },
        label: {
          type: 'string',
          description: 'Human-readable label for display',
        },
        thread_id: {
          type: 'number',
          description: 'Optional link to a timeline thread',
        },
        source: {
          type: 'string',
          description: 'Machine hostname writing this entry',
        },
        pinned: {
          type: 'boolean',
          description: 'If true, always show in /whereami',
        },
        expires_at: {
          type: 'string',
          description: 'ISO timestamp for auto-deletion (for temp items)',
        },
      },
      required: ['key', 'value', 'category'],
    },
    handler: async (args) => {
      const params: SetContextParams = {
        key: args.key as string,
        value: args.value as Record<string, unknown>,
        category: args.category as ContextCategory,
        label: args.label as string | undefined,
        thread_id: args.thread_id as number | undefined,
        source: args.source as string | undefined,
        pinned: args.pinned as boolean | undefined,
        expires_at: args.expires_at ? new Date(args.expires_at as string) : undefined,
      };

      const entry = await db.set(params);
      config.logger.info('Context entry set', { key: entry.key, category: entry.category });
      return entry;
    },
  });

  // context_get
  tools.set('context_get', {
    description: 'Get a context entry by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The context key to retrieve',
        },
      },
      required: ['key'],
    },
    handler: async (args) => {
      const entry = await db.get(args.key as string);
      if (!entry) {
        throw new Error(`Context key not found: ${args.key}`);
      }
      return entry;
    },
  });

  // context_list
  tools.set('context_list', {
    description: 'List context entries with optional filters. By default returns pinned items and those updated in the last 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category',
          enum: ['project', 'pr', 'machine', 'waiting', 'fact'],
        },
        thread_id: {
          type: 'number',
          description: 'Filter by linked thread',
        },
        pinned_only: {
          type: 'boolean',
          description: 'Only return pinned entries',
        },
        since_days: {
          type: 'number',
          description: 'Return entries updated within N days (default: 7)',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to return (default: 50)',
        },
      },
    },
    handler: async (args) => {
      const params: ListContextParams = {
        category: args.category as ContextCategory | undefined,
        thread_id: args.thread_id as number | undefined,
        pinned_only: args.pinned_only as boolean | undefined,
        since_days: args.since_days as number | undefined,
        limit: args.limit as number | undefined,
      };

      return await db.list(params);
    },
  });

  // context_delete
  tools.set('context_delete', {
    description: 'Delete a context entry by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The context key to delete',
        },
      },
      required: ['key'],
    },
    handler: async (args) => {
      const deleted = await db.delete(args.key as string);
      if (!deleted) {
        throw new Error(`Context key not found: ${args.key}`);
      }
      config.logger.info('Context entry deleted', { key: args.key });
      return { deleted: true, key: args.key };
    },
  });

  return { tools, db };
}
