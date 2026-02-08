// tests/context-db.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextDB, ContextEntry, ContextCategory } from '../src/mcp/context-db.js';

// Mock pg module
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return {
    default: {
      Pool: vi.fn(() => ({
        query: mockQuery,
        end: mockEnd,
      })),
    },
    __mockQuery: mockQuery,
    __mockEnd: mockEnd,
  };
});

async function getMocks() {
  const pgModule = await import('pg') as any;
  return {
    mockQuery: pgModule.__mockQuery as ReturnType<typeof vi.fn>,
    mockEnd: pgModule.__mockEnd as ReturnType<typeof vi.fn>,
  };
}

describe('ContextDB', () => {
  let db: ContextDB;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mocks = await getMocks();
    mockQuery = mocks.mockQuery;
    mockQuery.mockReset();
    mocks.mockEnd.mockReset();
    db = new ContextDB();
  });

  describe('set', () => {
    it('inserts a new context entry', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          key: 'project:meshcore-monitor',
          value: { repo: 'dpaschal/meshcore-monitor' },
          category: 'project',
          label: 'MeshCore Monitor',
          source: 'chisel',
          pinned: false,
          thread_id: null,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

      const result = await db.set({
        key: 'project:meshcore-monitor',
        value: { repo: 'dpaschal/meshcore-monitor' },
        category: 'project',
        label: 'MeshCore Monitor',
        source: 'chisel',
      });

      expect(result.key).toBe('project:meshcore-monitor');
      expect(result.category).toBe('project');
    });

    it('updates existing entry on conflict', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          key: 'pr:Yeraze/meshmonitor:1777',
          value: { status: 'merged' },
          category: 'pr',
          label: 'MeshCore PR',
          source: 'terminus',
          pinned: true,
          updated_at: new Date(),
        }],
      });

      const result = await db.set({
        key: 'pr:Yeraze/meshmonitor:1777',
        value: { status: 'merged' },
        category: 'pr',
        source: 'terminus',
      });

      expect(result.value).toEqual({ status: 'merged' });
    });
  });

  describe('get', () => {
    it('returns entry by key', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          key: 'machine:chisel',
          value: { ssh_fingerprint: 'SHA256:abc' },
          category: 'machine',
          label: 'chisel',
          source: 'chisel',
        }],
      });

      const result = await db.get('machine:chisel');
      expect(result).not.toBeNull();
      expect(result!.key).toBe('machine:chisel');
    });

    it('returns null for non-existent key', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await db.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all entries within default time window', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'project:a', category: 'project', pinned: false },
          { key: 'pr:b', category: 'pr', pinned: true },
        ],
      });

      const result = await db.list({});
      expect(result).toHaveLength(2);
    });

    it('filters by category', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ key: 'pr:test', category: 'pr' }],
      });

      const result = await db.list({ category: 'pr' });
      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('pr');
    });

    it('filters by pinned_only', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ key: 'important', pinned: true }],
      });

      const result = await db.list({ pinned_only: true });
      expect(result).toHaveLength(1);
    });

    it('filters by thread_id', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ key: 'fact:x', thread_id: 5 }],
      });

      const result = await db.list({ thread_id: 5 });
      expect(result).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('deletes entry by key and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      const result = await db.delete('old:key');
      expect(result).toBe(true);
    });

    it('returns false if key not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      const result = await db.delete('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('deleteExpired', () => {
    it('deletes entries past expires_at', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });
      const count = await db.deleteExpired();
      expect(count).toBe(3);
    });
  });

  describe('close', () => {
    it('closes the pool', async () => {
      const mocks = await getMocks();
      await db.close();
      expect(mocks.mockEnd).toHaveBeenCalled();
    });
  });
});
