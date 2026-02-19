#!/usr/bin/env tsx
// scripts/migrate-to-shared-memory.ts
//
// Migrates data from:
// 1. cerebrus PostgreSQL (anvil) — timeline, network, infra, task schemas
// 2. meshdb.db (terminus) — mesh_ prefix
// 3. meshmonitor.db (terminus) — meshmonitor_ prefix
//
// Into: ~/.cortex/shared-memory.db
//
// Usage:
//   npx tsx scripts/migrate-to-shared-memory.ts [--cerebrus-only] [--dry-run]

import pg from 'pg';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import winston from 'winston';
import { SharedMemoryDB } from '../src/memory/shared-memory-db.js';

const { Pool } = pg;

const CEREBRUS_CONN = process.env.CEREBRUS_CONN
  ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus';
const DATA_DIR = path.join(os.homedir(), '.cortex');
const DB_PATH = path.join(DATA_DIR, 'shared-memory.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cerebrusOnly = args.includes('--cerebrus-only');

async function main() {
  console.log('=== Shared Memory Migration ===');
  console.log(`Target: ${DB_PATH}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Use SharedMemoryDB to create/open the DB with proper schema
  const logger = winston.createLogger({ silent: true });
  const sharedDb = new SharedMemoryDB({ dataDir: DATA_DIR, logger });

  // Get the underlying better-sqlite3 handle for migration
  const db = sharedDb.getDatabase();
  db.pragma('foreign_keys = OFF'); // During migration

  // --- Cerebrus PostgreSQL ---
  console.log('Connecting to cerebrus PostgreSQL...');
  const pool = new Pool({ connectionString: CEREBRUS_CONN, max: 3 });

  try {
    // 1. Timeline schema
    console.log('\n--- Migrating timeline schema ---');
    await migrateTable(pool, db, 'timeline.projects', 'timeline_projects', [
      'id', 'name', 'description', 'employer', 'language', 'location', 'status', 'tags',
      'created_at', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.threads', 'timeline_threads', [
      'id', 'name', 'description', 'parent_thought_id', 'project_id', 'status',
      'created_at', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.thoughts', 'timeline_thoughts', [
      'id', 'thread_id', 'parent_thought_id', 'content', 'thought_type', 'status',
      'metadata', 'created_at',
    ]);

    await migrateTable(pool, db, 'timeline.thread_position', 'timeline_thread_position', [
      'thread_id', 'current_thought_id', 'updated_at',
    ]);

    await migrateTable(pool, db, 'timeline.context', 'timeline_context', [
      'key', 'value', 'thread_id', 'category', 'label', 'source', 'pinned',
      'expires_at', 'created_at', 'updated_at',
    ]);

    // 2. Network tables
    console.log('\n--- Migrating network tables ---');
    await migrateTable(pool, db, 'public.network_clients', 'network_clients', [
      'id', 'hostname', 'ip_address', 'mac_address', 'device_type', 'connection_type',
      'network', 'vlan_id', 'status', 'uptime_seconds', 'signal_strength', 'ssid',
      'rx_bytes', 'tx_bytes', 'discovered_at', 'last_seen',
    ]);

    await migrateTable(pool, db, 'public.networks', 'network_networks', [
      'id', 'network_id', 'name', 'subnet', 'vlan_id', 'dhcp_enabled', 'purpose',
      'discovered_at', 'last_seen',
    ]);

    // 3. Infra tables
    console.log('\n--- Migrating infra tables ---');
    const infraTables = ['builds', 'configs', 'events', 'sessions'];
    for (const table of infraTables) {
      try {
        const cols = await getColumns(pool, 'public', table);
        await migrateTable(pool, db, `public.${table}`, `infra_${table}`, cols);
      } catch (e) {
        console.log(`  Skipped infra_${table}: ${(e as Error).message}`);
      }
    }

    // secrets table
    try {
      const secretCols = await getColumns(pool, 'public', 'secrets');
      await migrateTable(pool, db, 'public.secrets', 'infra_secrets', secretCols);
    } catch (e) {
      console.log(`  Skipped infra_secrets: ${(e as Error).message}`);
    }

    // 4. Task tables
    console.log('\n--- Migrating task tables ---');
    try {
      const taskCols = await getColumns(pool, 'public', 'agent_tasks');
      await migrateTable(pool, db, 'public.agent_tasks', 'task_agent_tasks', taskCols);
    } catch (e) {
      console.log(`  Skipped task_agent_tasks: ${(e as Error).message}`);
    }

  } finally {
    await pool.end();
  }

  // --- Local SQLite databases (skip if cerebrus-only) ---
  if (!cerebrusOnly) {
    // meshdb.db
    const meshdbPath = path.join(os.homedir(), 'meshdb.db');
    if (fs.existsSync(meshdbPath)) {
      console.log('\n--- Migrating meshdb.db ---');
      migrateSqliteDb(meshdbPath, db, 'mesh_');
    } else {
      console.log('\nmeshdb.db not found, skipping');
    }

    // meshmonitor.db
    const meshmonitorPath = path.join(os.homedir(), 'meshmonitor.db');
    if (fs.existsSync(meshmonitorPath)) {
      console.log('\n--- Migrating meshmonitor.db ---');
      migrateSqliteDb(meshmonitorPath, db, 'meshmonitor_');
    } else {
      console.log('\nmeshmonitor.db not found, skipping');
    }
  }

  db.pragma('foreign_keys = ON');
  sharedDb.close();

  console.log('\n=== Migration complete ===');
  const stat = fs.statSync(DB_PATH);
  console.log(`Database size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
}

async function getColumns(pool: pg.Pool, schema: string, table: string): Promise<string[]> {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, [schema, table]);
  return result.rows.map(r => r.column_name);
}

async function migrateTable(
  pool: pg.Pool,
  db: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: string[],
): Promise<void> {
  // Check if source table exists
  const [schema, table] = sourceTable.includes('.') ? sourceTable.split('.') : ['public', sourceTable];

  const exists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2
  `, [schema, table]);

  if (exists.rows.length === 0) {
    console.log(`  ${sourceTable} does not exist, skipping`);
    return;
  }

  // Fetch all rows
  const result = await pool.query(`SELECT ${columns.join(', ')} FROM ${sourceTable}`);
  console.log(`  ${sourceTable} -> ${targetTable}: ${result.rows.length} rows`);

  if (dryRun || result.rows.length === 0) return;

  // Check if target table exists in SQLite
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(targetTable);

  if (!tableExists) {
    console.log(`  WARNING: Target table ${targetTable} does not exist in SQLite, skipping`);
    return;
  }

  // Clear existing data
  db.prepare(`DELETE FROM "${targetTable}"`).run();

  // Insert rows
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${targetTable}" (${columns.join(', ')}) VALUES (${placeholders})`);

  const insertAll = db.transaction(() => {
    for (const row of result.rows) {
      const values = columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return null;
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'object') return JSON.stringify(val);
        if (typeof val === 'boolean') return val ? 1 : 0;
        return val;
      });
      try {
        insert.run(...values);
      } catch (e) {
        console.log(`  WARNING: Failed to insert row in ${targetTable}: ${(e as Error).message}`);
      }
    }
  });

  insertAll();
}

function migrateSqliteDb(sourcePath: string, targetDb: Database.Database, prefix: string): void {
  const sourceDb = new Database(sourcePath, { readonly: true });

  try {
    // Get all tables
    const tables = sourceDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[];

    for (const { name } of tables) {
      const targetName = `${prefix}${name}`;

      // Get columns
      const cols = sourceDb.prepare(`PRAGMA table_info('${name}')`).all() as { name: string; type: string; notnull: number; pk: number }[];

      // Create table in target if it doesn't exist
      const colDefs = cols.map(c => {
        let def = `"${c.name}" ${c.type || 'TEXT'}`;
        if (c.pk) def += ' PRIMARY KEY';
        if (c.notnull && !c.pk) def += ' NOT NULL';
        return def;
      }).join(', ');

      targetDb.exec(`CREATE TABLE IF NOT EXISTS "${targetName}" (${colDefs})`);

      // Register classification
      targetDb.prepare(
        `INSERT OR IGNORE INTO _table_classification (table_name, classification, domain)
         VALUES (?, 'public', ?)`
      ).run(targetName, prefix.replace(/_$/, ''));

      // Copy data
      const rows = sourceDb.prepare(`SELECT * FROM "${name}"`).all();
      console.log(`  ${name} -> ${targetName}: ${rows.length} rows`);

      if (rows.length === 0) continue;

      const colNames = cols.map(c => `"${c.name}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const insert = targetDb.prepare(
        `INSERT OR IGNORE INTO "${targetName}" (${colNames}) VALUES (${placeholders})`
      );

      const insertAll = targetDb.transaction(() => {
        for (const row of rows) {
          const values = cols.map(c => {
            const val = (row as Record<string, unknown>)[c.name];
            if (val === null || val === undefined) return null;
            if (typeof val === 'object') return JSON.stringify(val);
            return val;
          });
          try {
            insert.run(...values);
          } catch (e) {
            // Skip duplicates
          }
        }
      });

      insertAll();
    }
  } finally {
    sourceDb.close();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
