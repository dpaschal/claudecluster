// tests/context-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createContextTools } from '../src/mcp/context-tools.js';
import { ContextDB } from '../src/mcp/context-db.js';
import { createLogger } from 'winston';

// Mock ContextDB
vi.mock('../src/mcp/context-db.js', () => {
  return {
    ContextDB: vi.fn().mockImplementation(() => ({
      set: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      close: vi.fn(),
    })),
  };
});

describe('Context Tools', () => {
  let tools: Map<string, any>;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const result = createContextTools({
      logger: createLogger({ silent: true }),
    });
    tools = result.tools;
    mockDb = result.db;
  });

  it('registers all four tools', () => {
    expect(tools.has('context_set')).toBe(true);
    expect(tools.has('context_get')).toBe(true);
    expect(tools.has('context_list')).toBe(true);
    expect(tools.has('context_delete')).toBe(true);
  });

  describe('context_set', () => {
    it('calls db.set with correct params', async () => {
      mockDb.set.mockResolvedValueOnce({
        key: 'test:key',
        value: { foo: 'bar' },
        category: 'fact',
      });

      const handler = tools.get('context_set');
      const result = await handler.handler({
        key: 'test:key',
        value: { foo: 'bar' },
        category: 'fact',
        label: 'Test',
      });

      expect(mockDb.set).toHaveBeenCalledWith({
        key: 'test:key',
        value: { foo: 'bar' },
        category: 'fact',
        label: 'Test',
        thread_id: undefined,
        source: undefined,
        pinned: undefined,
        expires_at: undefined,
      });
      expect(result.key).toBe('test:key');
    });

    it('validates category', async () => {
      const handler = tools.get('context_set');
      expect(handler.inputSchema.properties.category.enum).toEqual([
        'project', 'pr', 'machine', 'waiting', 'fact'
      ]);
    });
  });

  describe('context_get', () => {
    it('returns entry when found', async () => {
      mockDb.get.mockResolvedValueOnce({
        key: 'machine:chisel',
        value: { ip: '192.168.1.100' },
      });

      const handler = tools.get('context_get');
      const result = await handler.handler({ key: 'machine:chisel' });

      expect(result.key).toBe('machine:chisel');
    });

    it('throws when key not found', async () => {
      mockDb.get.mockResolvedValueOnce(null);

      const handler = tools.get('context_get');
      await expect(handler.handler({ key: 'missing' }))
        .rejects.toThrow('Context key not found: missing');
    });
  });

  describe('context_list', () => {
    it('returns filtered list', async () => {
      mockDb.list.mockResolvedValueOnce([
        { key: 'pr:1', category: 'pr' },
        { key: 'pr:2', category: 'pr' },
      ]);

      const handler = tools.get('context_list');
      const result = await handler.handler({ category: 'pr' });

      expect(result).toHaveLength(2);
      expect(mockDb.list).toHaveBeenCalledWith({
        category: 'pr',
        thread_id: undefined,
        pinned_only: undefined,
        since_days: undefined,
        limit: undefined,
      });
    });
  });

  describe('context_delete', () => {
    it('returns success when deleted', async () => {
      mockDb.delete.mockResolvedValueOnce(true);

      const handler = tools.get('context_delete');
      const result = await handler.handler({ key: 'old:entry' });

      expect(result.deleted).toBe(true);
    });

    it('throws when key not found', async () => {
      mockDb.delete.mockResolvedValueOnce(false);

      const handler = tools.get('context_delete');
      await expect(handler.handler({ key: 'missing' }))
        .rejects.toThrow('Context key not found: missing');
    });
  });
});
