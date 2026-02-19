// src/memory/shared-memory-db.ts
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Logger } from 'winston';

export type Classification = 'public' | 'internal' | 'local';

export interface TableClassification {
  table_name: string;
  classification: Classification;
  domain: string;
}

export interface SharedMemoryDBConfig {
  dataDir: string;       // ~/.cortex
  logger: Logger;
  readOnly?: boolean;    // for filtered replica
}

export class SharedMemoryDB {
  private db: DatabaseType;
  private logger: Logger;
  private dbPath: string;

  constructor(config: SharedMemoryDBConfig) {
    this.logger = config.logger;
    this.dbPath = path.join(config.dataDir, 'shared-memory.db');

    // Ensure directory exists
    fs.mkdirSync(config.dataDir, { recursive: true });

    this.db = new Database(this.dbPath, {
      readonly: config.readOnly ?? false,
    });

    // Enable WAL mode for concurrent reads during writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize schema
    this.initializeSchema();

    this.logger.info('SharedMemoryDB opened', { path: this.dbPath });
  }

  private initializeSchema(): void {
    this.db.exec(`
      -- Table classification metadata
      CREATE TABLE IF NOT EXISTS _table_classification (
        table_name TEXT PRIMARY KEY,
        classification TEXT NOT NULL DEFAULT 'public'
          CHECK (classification IN ('public', 'internal', 'local')),
        domain TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Timeline domain (from cerebrus timeline schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS timeline_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        employer TEXT,
        language TEXT,
        location TEXT,
        status TEXT DEFAULT 'active',
        tags TEXT, -- JSON array
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        parent_thought_id INTEGER,
        project_id INTEGER REFERENCES timeline_projects(id),
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_thoughts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES timeline_threads(id),
        parent_thought_id INTEGER REFERENCES timeline_thoughts(id),
        content TEXT NOT NULL,
        thought_type TEXT DEFAULT 'progress',
        status TEXT DEFAULT 'active',
        metadata TEXT DEFAULT '{}', -- JSON
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_thread_position (
        thread_id INTEGER PRIMARY KEY REFERENCES timeline_threads(id),
        current_thought_id INTEGER REFERENCES timeline_thoughts(id),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_context (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL, -- JSON
        thread_id INTEGER REFERENCES timeline_threads(id),
        category TEXT CHECK (category IN ('project', 'pr', 'machine', 'waiting', 'fact', 'reminder')),
        label TEXT,
        source TEXT,
        pinned INTEGER DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Network domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS network_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT,
        ip_address TEXT,
        mac_address TEXT,
        device_type TEXT,
        connection_type TEXT,
        network TEXT,
        vlan_id INTEGER,
        status TEXT DEFAULT 'online',
        uptime_seconds INTEGER,
        signal_strength INTEGER,
        ssid TEXT,
        rx_bytes INTEGER,
        tx_bytes INTEGER,
        discovered_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS network_networks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network_id TEXT,
        name TEXT,
        subnet TEXT,
        vlan_id INTEGER,
        dhcp_enabled INTEGER DEFAULT 1,
        purpose TEXT,
        discovered_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Infra domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS infra_builds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT,
        branch TEXT,
        commit_hash TEXT,
        status TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS infra_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT,
        environment TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        occurred_at TEXT,
        build_id INTEGER,
        test_id INTEGER,
        details TEXT DEFAULT '{}',
        source TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        focus_area TEXT,
        summary TEXT,
        builds_created TEXT, -- JSON array
        documents_modified TEXT, -- JSON array
        commands_executed INTEGER,
        files_modified INTEGER,
        session_notes_content TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS infra_secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        service TEXT,
        value TEXT NOT NULL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Task domain (from cerebrus public schema)
      -- ============================================================

      CREATE TABLE IF NOT EXISTS task_agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        task_type TEXT,
        description TEXT,
        started_at TEXT,
        completed_at TEXT,
        status TEXT DEFAULT 'pending',
        parent_agent_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- ============================================================
      -- Indexes
      -- ============================================================

      CREATE INDEX IF NOT EXISTS idx_thoughts_thread ON timeline_thoughts(thread_id);
      CREATE INDEX IF NOT EXISTS idx_thoughts_type ON timeline_thoughts(thought_type);
      CREATE INDEX IF NOT EXISTS idx_threads_status ON timeline_threads(status);
      CREATE INDEX IF NOT EXISTS idx_threads_project ON timeline_threads(project_id);
      CREATE INDEX IF NOT EXISTS idx_context_category ON timeline_context(category);
      CREATE INDEX IF NOT EXISTS idx_context_pinned ON timeline_context(pinned);
      CREATE INDEX IF NOT EXISTS idx_network_hostname ON network_clients(hostname);
      CREATE INDEX IF NOT EXISTS idx_network_ip ON network_clients(ip_address);
    `);

    // Register default classifications
    const upsertClassification = this.db.prepare(`
      INSERT OR IGNORE INTO _table_classification (table_name, classification, domain)
      VALUES (?, ?, ?)
    `);

    const defaultClassifications: [string, Classification, string][] = [
      ['timeline_projects', 'public', 'timeline'],
      ['timeline_threads', 'public', 'timeline'],
      ['timeline_thoughts', 'public', 'timeline'],
      ['timeline_thread_position', 'public', 'timeline'],
      ['timeline_context', 'internal', 'timeline'], // may contain credentials
      ['network_clients', 'public', 'network'],
      ['network_networks', 'public', 'network'],
      ['infra_builds', 'public', 'infra'],
      ['infra_configs', 'public', 'infra'],
      ['infra_events', 'public', 'infra'],
      ['infra_sessions', 'public', 'infra'],
      ['infra_secrets', 'internal', 'infra'], // secrets are internal
      ['task_agent_tasks', 'public', 'task'],
    ];

    const insertAll = this.db.transaction(() => {
      for (const [table, classification, domain] of defaultClassifications) {
        upsertClassification.run(table, classification, domain);
      }
    });
    insertAll();
  }

  // ================================================================
  // Query Methods (local reads, no network)
  // ================================================================

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  // ================================================================
  // Write Methods (local only — use MemoryReplicator for replicated writes)
  // ================================================================

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  runInTransaction(statements: { sql: string; params: unknown[] }[]): void {
    const transaction = this.db.transaction(() => {
      for (const { sql, params } of statements) {
        this.db.prepare(sql).run(...params);
      }
    });
    transaction();
  }

  // ================================================================
  // Schema Inspection
  // ================================================================

  describeTable(tableName: string): { name: string; type: string; notnull: number; pk: number }[] {
    return this.db.prepare(`PRAGMA table_info('${tableName}')`).all() as any[];
  }

  getTableClassification(tableName: string): Classification | null {
    const row = this.db.prepare(
      'SELECT classification FROM _table_classification WHERE table_name = ?'
    ).get(tableName) as { classification: Classification } | undefined;
    return row?.classification ?? null;
  }

  getTableClassifications(): TableClassification[] {
    return this.db.prepare(
      'SELECT table_name, classification, domain FROM _table_classification ORDER BY domain, table_name'
    ).all() as TableClassification[];
  }

  // ================================================================
  // Stats
  // ================================================================

  getStats(): {
    dbSizeBytes: number;
    tableCount: number;
    rowCounts: Record<string, number>;
    classificationCounts: Record<Classification, number>;
  } {
    const stat = fs.statSync(this.dbPath);

    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_%'`
    ).all() as { name: string }[];

    const rowCounts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = this.db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number };
      rowCounts[name] = row.c;
    }

    const classificationCounts: Record<Classification, number> = { public: 0, internal: 0, local: 0 };
    const classifications = this.db.prepare(
      'SELECT classification, COUNT(*) as c FROM _table_classification GROUP BY classification'
    ).all() as { classification: Classification; c: number }[];
    for (const { classification, c } of classifications) {
      classificationCounts[classification] = c;
    }

    return {
      dbSizeBytes: stat.size,
      tableCount: tables.length,
      rowCounts,
      classificationCounts,
    };
  }

  // ================================================================
  // Integrity
  // ================================================================

  computeChecksum(): string {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as { name: string }[];

    const hash = crypto.createHash('sha256');
    for (const { name } of tables) {
      const rows = this.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      hash.update(name + JSON.stringify(rows));
    }
    return hash.digest('hex');
  }

  // ================================================================
  // Lifecycle
  // ================================================================

  getPath(): string {
    return this.dbPath;
  }

  getDatabase(): DatabaseType {
    return this.db;
  }

  close(): void {
    this.db.close();
    this.logger.info('SharedMemoryDB closed');
  }
}
