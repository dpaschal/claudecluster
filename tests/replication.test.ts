// tests/replication.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryReplicator } from '../src/memory/replication.js';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';
import { EventEmitter } from 'events';
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

describe('MemoryReplicator', () => {
  let db: SharedMemoryDB;
  let replicator: MemoryReplicator;
  let tmpDir: string;
  let mockRaft: EventEmitter & { getState: any; getLeaderId: any; appendEntry: any };
  let mockMembership: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-repl-test-'));
    db = new SharedMemoryDB({ dataDir: tmpDir, logger: createMockLogger() });

    const emitter = new EventEmitter();
    mockRaft = Object.assign(emitter, {
      getState: vi.fn().mockReturnValue('leader'),
      getLeaderId: vi.fn().mockReturnValue('forge-1234'),
      appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
    }) as any;

    mockMembership = {
      getLeaderAddress: vi.fn().mockReturnValue('100.94.211.117:50051'),
      getNode: vi.fn().mockReturnValue(null),
      getSelfNodeId: vi.fn().mockReturnValue('test-node'),
    };

    replicator = new MemoryReplicator({
      db,
      raft: mockRaft as any,
      membership: mockMembership,
      clientPool: {} as any,
      logger: createMockLogger(),
      nodeId: 'test-node',
    });
  });

  afterEach(() => {
    replicator.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('read path', () => {
    it('reads directly from local SQLite', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['test', 'active']);
      const rows = replicator.read<{ name: string }>('SELECT * FROM timeline_threads');
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('test');
    });

    it('readOne returns single row', () => {
      db.run('INSERT INTO timeline_threads (name, status) VALUES (?, ?)', ['test', 'active']);
      const row = replicator.readOne<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['test']);
      expect(row?.name).toBe('test');
    });
  });

  describe('write path (leader)', () => {
    it('appends to Raft log on write', async () => {
      const result = await replicator.write(
        'INSERT INTO timeline_threads (name, status) VALUES (?, ?)',
        ['test', 'active'],
        { table: 'timeline_threads' }
      );

      expect(result.success).toBe(true);
      expect(mockRaft.appendEntry).toHaveBeenCalledWith('memory_write', expect.any(Buffer));
    });

    it('includes checksum in Raft entry', async () => {
      await replicator.write(
        'INSERT INTO timeline_threads (name, status) VALUES (?, ?)',
        ['test', 'active'],
        { table: 'timeline_threads' }
      );

      const call = mockRaft.appendEntry.mock.calls[0];
      const payload = JSON.parse(call[1].toString());
      expect(payload.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.sql).toContain('INSERT');
    });
  });

  describe('write path (follower)', () => {
    it('returns error when no leader available', async () => {
      mockRaft.getState.mockReturnValue('follower');
      mockRaft.getLeaderId.mockReturnValue(null);
      mockMembership.getLeaderAddress.mockReturnValue(null);

      const result = await replicator.write(
        'INSERT INTO timeline_threads (name, status) VALUES (?, ?)',
        ['test', 'active'],
        { table: 'timeline_threads' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No leader');
    });
  });

  describe('local writes', () => {
    it('bypasses Raft for local classification', async () => {
      const result = await replicator.write(
        'INSERT INTO timeline_threads (name, status) VALUES (?, ?)',
        ['local-only', 'active'],
        { classification: 'local' }
      );

      expect(result.success).toBe(true);
      expect(mockRaft.appendEntry).not.toHaveBeenCalled();

      // Verify data was written locally
      const rows = db.query<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['local-only']);
      expect(rows).toHaveLength(1);
    });
  });

  describe('entry application', () => {
    it('applies committed entries to local SQLite', () => {
      const crypto = require('crypto');
      const sql = 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)';
      const params = ['committed-entry', 'active'];
      const checksum = crypto.createHash('sha256').update(sql + JSON.stringify(params)).digest('hex');

      // Simulate a committed entry from Raft
      mockRaft.emit('entryCommitted', {
        type: 'memory_write',
        index: 1,
        term: 1,
        data: Buffer.from(JSON.stringify({ sql, params, checksum })),
      });

      const rows = db.query<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['committed-entry']);
      expect(rows).toHaveLength(1);
    });

    it('rejects entries with mismatched checksums', () => {
      mockRaft.emit('entryCommitted', {
        type: 'memory_write',
        index: 1,
        term: 1,
        data: Buffer.from(JSON.stringify({
          sql: 'INSERT INTO timeline_threads (name, status) VALUES (?, ?)',
          params: ['bad-checksum', 'active'],
          checksum: 'deadbeef',
        })),
      });

      const rows = db.query<{ name: string }>('SELECT * FROM timeline_threads WHERE name = ?', ['bad-checksum']);
      expect(rows).toHaveLength(0);
    });

    it('ignores non-memory_write entries', () => {
      mockRaft.emit('entryCommitted', {
        type: 'config_change',
        index: 1,
        term: 1,
        data: Buffer.from('{}'),
      });
      // Should not throw
    });
  });

  describe('integrity checks', () => {
    it('starts and stops integrity interval', () => {
      replicator.startIntegrityChecks(1000);
      replicator.stopIntegrityChecks();
      // Should not throw
    });
  });
});
