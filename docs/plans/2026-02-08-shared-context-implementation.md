# Shared Context Store Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a shared context store to claudecluster that persists project facts, PR status, and machine info across Claude sessions on different machines.

**Architecture:** New `timeline.context` table in cerebrus DB, accessed via `ContextDB` class, exposed through 4 MCP tools (`context_set`, `context_get`, `context_list`, `context_delete`). Integrates with existing timeline system.

**Tech Stack:** TypeScript, PostgreSQL (cerebrus DB), MCP SDK, Vitest for testing

---

## Task 1: Create Database Migration

**Files:**
- Create: `scripts/migrations/003_add_context_table.sql`

**Step 1: Write the migration SQL**

```sql
-- scripts/migrations/003_add_context_table.sql
-- Shared context store for cross-machine Claude session memory

CREATE TABLE IF NOT EXISTS timeline.context (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    thread_id INT REFERENCES timeline.threads(id) ON DELETE SET NULL,
    category TEXT NOT NULL CHECK (category IN ('project', 'pr', 'machine', 'waiting', 'fact')),
    label TEXT,
    source TEXT,
    pinned BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_category ON timeline.context(category);
CREATE INDEX IF NOT EXISTS idx_context_thread ON timeline.context(thread_id);
CREATE INDEX IF NOT EXISTS idx_context_pinned ON timeline.context(pinned) WHERE pinned = TRUE;
CREATE INDEX IF NOT EXISTS idx_context_expires ON timeline.context(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_updated ON timeline.context(updated_at DESC);

COMMENT ON TABLE timeline.context IS 'Shared context store for cross-machine Claude session memory';
COMMENT ON COLUMN timeline.context.key IS 'Namespaced key, e.g., project:meshcore-monitor, pr:Yeraze/meshmonitor:1777';
COMMENT ON COLUMN timeline.context.category IS 'Category for filtering: project, pr, machine, waiting, fact';
COMMENT ON COLUMN timeline.context.source IS 'Machine hostname that wrote this entry';
COMMENT ON COLUMN timeline.context.pinned IS 'If true, always show in /whereami';
COMMENT ON COLUMN timeline.context.expires_at IS 'Auto-delete after this time (for temp clipboard items)';
```

**Step 2: Run migration on anvil**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus" < scripts/migrations/003_add_context_table.sql
```

Expected: Tables and indexes created successfully.

**Step 3: Verify table exists**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus -c \"\\d timeline.context\""
```

Expected: Table schema displayed with all columns.

**Step 4: Commit**

```bash
git add scripts/migrations/003_add_context_table.sql
git commit -m "feat(db): add timeline.context table for shared context store"
```

---

## Task 2: Create ContextDB Class

**Files:**
- Create: `src/mcp/context-db.ts`
- Test: `tests/context-db.test.ts`

**Step 1: Write the failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/context-db.test.ts`

Expected: FAIL - Cannot find module '../src/mcp/context-db.js'

**Step 3: Write the ContextDB implementation**

```typescript
// src/mcp/context-db.ts
import pg from 'pg';

const { Pool } = pg;

export type ContextCategory = 'project' | 'pr' | 'machine' | 'waiting' | 'fact';

export interface ContextEntry {
  key: string;
  value: Record<string, unknown>;
  thread_id: number | null;
  category: ContextCategory;
  label: string | null;
  source: string | null;
  pinned: boolean;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SetContextParams {
  key: string;
  value: Record<string, unknown>;
  category: ContextCategory;
  label?: string;
  thread_id?: number;
  source?: string;
  pinned?: boolean;
  expires_at?: Date;
}

export interface ListContextParams {
  category?: ContextCategory;
  thread_id?: number;
  pinned_only?: boolean;
  since_days?: number;
  limit?: number;
}

export class ContextDB {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus',
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async set(params: SetContextParams): Promise<ContextEntry> {
    const result = await this.pool.query<ContextEntry>(
      `INSERT INTO timeline.context (key, value, category, label, thread_id, source, pinned, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         category = EXCLUDED.category,
         label = COALESCE(EXCLUDED.label, timeline.context.label),
         thread_id = COALESCE(EXCLUDED.thread_id, timeline.context.thread_id),
         source = EXCLUDED.source,
         pinned = COALESCE(EXCLUDED.pinned, timeline.context.pinned),
         expires_at = COALESCE(EXCLUDED.expires_at, timeline.context.expires_at),
         updated_at = NOW()
       RETURNING *`,
      [
        params.key,
        JSON.stringify(params.value),
        params.category,
        params.label ?? null,
        params.thread_id ?? null,
        params.source ?? null,
        params.pinned ?? false,
        params.expires_at ?? null,
      ]
    );
    return result.rows[0];
  }

  async get(key: string): Promise<ContextEntry | null> {
    const result = await this.pool.query<ContextEntry>(
      'SELECT * FROM timeline.context WHERE key = $1',
      [key]
    );
    return result.rows[0] ?? null;
  }

  async list(params: ListContextParams): Promise<ContextEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Default: entries updated within last 7 days OR pinned
    const sinceDays = params.since_days ?? 7;
    conditions.push(`(updated_at > NOW() - INTERVAL '${sinceDays} days' OR pinned = TRUE)`);

    if (params.category) {
      conditions.push(`category = $${paramIdx++}`);
      values.push(params.category);
    }

    if (params.thread_id !== undefined) {
      conditions.push(`thread_id = $${paramIdx++}`);
      values.push(params.thread_id);
    }

    if (params.pinned_only) {
      conditions.push('pinned = TRUE');
    }

    const limit = params.limit ?? 50;

    const query = `
      SELECT * FROM timeline.context
      WHERE ${conditions.join(' AND ')}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ${limit}
    `;

    const result = await this.pool.query<ContextEntry>(query, values);
    return result.rows;
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM timeline.context WHERE key = $1',
      [key]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM timeline.context WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );
    return result.rowCount ?? 0;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/context-db.test.ts`

Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/context-db.ts tests/context-db.test.ts
git commit -m "feat(mcp): add ContextDB class for shared context store"
```

---

## Task 3: Create Context MCP Tools

**Files:**
- Create: `src/mcp/context-tools.ts`
- Test: `tests/context-tools.test.ts`

**Step 1: Write the failing tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/context-tools.test.ts`

Expected: FAIL - Cannot find module '../src/mcp/context-tools.js'

**Step 3: Write the context tools implementation**

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/context-tools.test.ts`

Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/context-tools.ts tests/context-tools.test.ts
git commit -m "feat(mcp): add context MCP tools (set, get, list, delete)"
```

---

## Task 4: Register Context Tools in MCP Server

**Files:**
- Modify: `src/mcp/server.ts:16-18` (add import)
- Modify: `src/mcp/server.ts:34-35` (add contextDb field)
- Modify: `src/mcp/server.ts:77-86` (add context tools registration)
- Modify: `src/mcp/server.ts:215-218` (add close for contextDb)

**Step 1: Add import**

Add after line 18 in `src/mcp/server.ts`:
```typescript
import { createContextTools } from './context-tools.js';
import { ContextDB } from './context-db.js';
```

**Step 2: Add contextDb field**

Add after line 35:
```typescript
  private contextDb: ContextDB | null = null;
```

**Step 3: Register context tools in createToolHandlers**

Add after line 86 (after network tools registration):
```typescript
    // Add context tools
    const { tools: contextTools, db: ctxDb } = createContextTools({
      logger: this.config.logger,
    });
    this.contextDb = ctxDb;

    for (const [name, handler] of contextTools) {
      clusterTools.set(name, handler);
    }
```

**Step 4: Close contextDb in stop method**

Add after line 218:
```typescript
    if (this.contextDb) {
      await this.contextDb.close();
    }
```

**Step 5: Build to verify compilation**

Run: `npm run build`

Expected: Compiles successfully with no errors.

**Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): register context tools in MCP server"
```

---

## Task 5: Run Database Migration

**Step 1: Ensure migration file exists**

Run: `cat scripts/migrations/003_add_context_table.sql`

Expected: SQL content displayed.

**Step 2: Run migration on anvil**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus" < scripts/migrations/003_add_context_table.sql
```

Expected: CREATE TABLE, CREATE INDEX messages.

**Step 3: Verify table**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus -c \"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'timeline' AND table_name = 'context'\""
```

Expected: All columns listed (key, value, thread_id, category, label, source, pinned, expires_at, created_at, updated_at).

**Step 4: Test insert**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus -c \"INSERT INTO timeline.context (key, value, category, label, source) VALUES ('test:migration', '{\\\"status\\\": \\\"works\\\"}', 'fact', 'Migration Test', 'chisel') RETURNING key, category\""
```

Expected: Row inserted successfully.

**Step 5: Clean up test row**

Run:
```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus -c \"DELETE FROM timeline.context WHERE key = 'test:migration'\""
```

Expected: DELETE 1

---

## Task 6: Integration Test

**Step 1: Run all tests**

Run: `npm test`

Expected: All tests pass (including new context-db and context-tools tests).

**Step 2: Manual MCP test (optional)**

Start the MCP server and verify tools are listed:
```bash
npm start -- --mcp-only 2>&1 | head -50
```

Expected: Server starts, context tools appear in tool list.

**Step 3: Commit and push**

```bash
git push origin main
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Database migration | `scripts/migrations/003_add_context_table.sql` |
| 2 | ContextDB class | `src/mcp/context-db.ts`, `tests/context-db.test.ts` |
| 3 | Context MCP tools | `src/mcp/context-tools.ts`, `tests/context-tools.test.ts` |
| 4 | Register in server | `src/mcp/server.ts` |
| 5 | Run migration | (on anvil) |
| 6 | Integration test | (verification) |

**Total new tests:** ~18 tests across 2 test files

**Next steps after this plan:**
- Update `/whereami` and `/wherewasi` skills to query context
- Create `/remember` skill for quick context entry
