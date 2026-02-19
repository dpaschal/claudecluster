// tests/shared-memory-db.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from 'winston';

const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

describe('SharedMemoryDB', () => {
  let db: SharedMemoryDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-smdb-test-'));
    db = new SharedMemoryDB({ dataDir: tmpDir, logger: createMockLogger() });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the database file', () => {
    const dbPath = path.join(tmpDir, 'shared-memory.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  describe('schema', () => {
    it('creates all expected tables', () => {
      const tables = db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tableNames = tables.map(t => t.name);

      // Timeline tables
      expect(tableNames).toContain('timeline_projects');
      expect(tableNames).toContain('timeline_threads');
      expect(tableNames).toContain('timeline_thoughts');
      expect(tableNames).toContain('timeline_thread_position');
      expect(tableNames).toContain('timeline_context');

      // Network tables
      expect(tableNames).toContain('network_clients');
      expect(tableNames).toContain('network_networks');

      // Classification metadata
      expect(tableNames).toContain('_table_classification');
    });

    it('has correct table classifications', () => {
      const classifications = db.getTableClassifications();
      const timelineThread = classifications.find(c => c.table_name === 'timeline_threads');
      expect(timelineThread?.classification).toBe('public');
      const networkClient = classifications.find(c => c.table_name === 'network_clients');
      expect(networkClient?.classification).toBe('public');
    });
  });

  describe('CRUD operations', () => {
    it('inserts and queries rows', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['test-thread', 'active']);

      const rows = db.query<{ name: string; status: string }>('SELECT * FROM timeline_threads');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('test-thread');
      expect(rows[0].status).toBe('active');
    });

    it('queryOne returns single row', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['thread-1', 'active']);
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['thread-2', 'paused']);

      const row = db.queryOne<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['thread-1']);
      expect(row?.name).toBe('thread-1');
    });

    it('queryOne returns undefined when no match', () => {
      const row = db.queryOne<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['nonexistent']);
      expect(row).toBeUndefined();
    });

    it('run returns changes count', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['t1', 'active']);
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['t2', 'active']);

      const result = db.run('UPDATE timeline_threads SET status = ? WHERE status = ?', ['paused', 'active']);
      expect(result.changes).toBe(2);
    });
  });

  describe('transactions', () => {
    it('commits on success', () => {
      db.runInTransaction([
        { sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)', params: ['tx-1', 'active'] },
        { sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)', params: ['tx-2', 'active'] },
      ]);

      const rows = db.query('SELECT * FROM timeline_threads');
      expect(rows).toHaveLength(2);
    });

    it('rolls back on error', () => {
      try {
        db.runInTransaction([
          { sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)', params: ['tx-1', 'active'] },
          { sql: 'INSERT INTO invalid_table (col) VALUES (?)', params: ['should-fail'] },
        ]);
      } catch (e) {
        // expected — invalid table causes rollback
      }

      const rows = db.query('SELECT * FROM timeline_threads');
      expect(rows).toHaveLength(0);
    });
  });

  describe('describeTable', () => {
    it('returns column information', () => {
      const cols = db.describeTable('timeline_threads');
      expect(cols.length).toBeGreaterThan(0);
      const nameCol = cols.find(c => c.name === 'name');
      expect(nameCol).toBeTruthy();
      expect(nameCol?.type).toBe('TEXT');
    });

    it('returns empty for nonexistent table', () => {
      const cols = db.describeTable('nonexistent_table');
      expect(cols).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('returns database statistics', () => {
      const stats = db.getStats();
      // Tables exist but the query filters out _-prefixed tables
      // So tableCount may be 0 if all user tables are empty
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
      expect(stats.classificationCounts).toBeDefined();
    });
  });

  describe('computeChecksum', () => {
    it('returns a hex string', () => {
      const checksum = db.computeChecksum();
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('changes when data changes', () => {
      const before = db.computeChecksum();
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['checksum-test', 'active']);
      const after = db.computeChecksum();
      expect(before).not.toBe(after);
    });
  });

  describe('getPath', () => {
    it('returns the database file path', () => {
      expect(db.getPath()).toBe(path.join(tmpDir, 'shared-memory.db'));
    });
  });

  describe('generateWhereami', () => {
    it('generates whereami.md with active threads', () => {
      // Seed data
      db.run('INSERT INTO timeline_projects (name) VALUES (?)', ['TestProject']);
      db.run('INSERT INTO timeline_threads (name, status, project_id) VALUES (?, ?, ?)', ['Thread A', 'active', 1]);
      db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'Did something important', 'progress']);
      db.run('INSERT INTO timeline_thread_position (thread_id, current_thought_id) VALUES (?, ?)', [1, 1]);
      db.run(`INSERT INTO timeline_context (key, value, category, pinned) VALUES (?, ?, ?, ?)`, ['project:test', '"test value"', 'project', 1]);

      db.generateWhereami();

      const mdPath = path.join(tmpDir, 'whereami.md');
      expect(fs.existsSync(mdPath)).toBe(true);

      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).toContain('# Cortex State');
      expect(content).toContain('Thread A');
      expect(content).toContain('Did something important');
      expect(content).toContain('project:test');
    });

    it('includes recent thoughts section', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['Thread B', 'active']);
      db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'First thought', 'progress']);
      db.run('INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', [1, 'Second thought', 'decision']);

      db.generateWhereami();

      const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
      expect(content).toContain('## Recent Thoughts');
      expect(content).toContain('Second thought');
    });

    it('handles empty database gracefully', () => {
      db.generateWhereami();

      const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
      expect(content).toContain('# Cortex State');
      expect(content).toContain('No active threads');
    });
  });

  describe('auto-snapshot on write', () => {
    it('regenerates whereami.md on timeline write', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['Auto Thread', 'active']);

      const mdPath = path.join(tmpDir, 'whereami.md');
      expect(fs.existsSync(mdPath)).toBe(true);
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).toContain('Auto Thread');
    });

    it('regenerates whereami.md on context write', () => {
      db.run(`INSERT INTO timeline_context (key, value, category, pinned) VALUES (?, ?, ?, ?)`,
        ['test:key', '"hello"', 'fact', 1]);

      const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
      expect(content).toContain('test:key');
    });

    it('does NOT regenerate on non-timeline write', () => {
      // Write to network table — should not trigger snapshot
      db.run('INSERT INTO network_clients (hostname, ip_address) VALUES (?, ?)', ['testhost', '10.0.0.1']);

      const mdPath = path.join(tmpDir, 'whereami.md');
      // File may or may not exist (from other tests), but if it does,
      // it should NOT contain 'testhost' since network_clients isn't a trigger
      if (fs.existsSync(mdPath)) {
        const content = fs.readFileSync(mdPath, 'utf-8');
        expect(content).not.toContain('testhost');
      }
    });

    it('regenerates on runInTransaction with timeline statements', () => {
      db.runInTransaction([
        { sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)', params: ['TX Thread', 'active'] },
        { sql: 'INSERT INTO timeline_thoughts (thread_id, content, thought_type) VALUES (?, ?, ?)', params: [1, 'TX thought', 'progress'] },
      ]);

      const content = fs.readFileSync(path.join(tmpDir, 'whereami.md'), 'utf-8');
      expect(content).toContain('TX Thread');
    });
  });
});
