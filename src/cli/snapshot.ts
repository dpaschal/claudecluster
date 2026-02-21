/**
 * cortex snapshot — Shared memory backup/restore.
 * Manages local snapshots of the replicated SQLite database.
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CORTEX_DIR = path.join(os.homedir(), '.cortex');
const DB_PATH = path.join(CORTEX_DIR, 'shared-memory.db');
const SNAPSHOT_DIR = path.join(CORTEX_DIR, 'snapshots');

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export async function runSnapshotCreate(name?: string): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.error(chalk.red(`Database not found at ${DB_PATH}`));
    process.exit(1);
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const snapshotName = name ?? `snapshot_${timestamp}`;
  const destPath = path.join(SNAPSHOT_DIR, `${snapshotName}.db`);

  if (fs.existsSync(destPath)) {
    console.error(chalk.red(`Snapshot "${snapshotName}" already exists`));
    process.exit(1);
  }

  // Use SQLite backup API via better-sqlite3 for consistency
  try {
    const Database = (await import('better-sqlite3')).default;
    const source = new Database(DB_PATH, { readonly: true });
    await source.backup(destPath);
    source.close();

    const stat = fs.statSync(destPath);
    console.log(chalk.green(`Snapshot created: ${snapshotName} (${formatBytes(stat.size)})`));
    console.log(chalk.dim(`  Path: ${destPath}`));
  } catch (err: any) {
    console.error(chalk.red(`Snapshot failed: ${err.message}`));
    process.exit(1);
  }
}

export async function runSnapshotList(): Promise<void> {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    console.log(chalk.dim('No snapshots found.'));
    return;
  }

  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(chalk.dim('No snapshots found.'));
    return;
  }

  console.log(chalk.bold('\n  Shared Memory Snapshots\n'));

  const W = { name: 36, size: 12, date: 24 };
  console.log(chalk.dim(
    '  ' + 'NAME'.padEnd(W.name) + 'SIZE'.padEnd(W.size) + 'CREATED'
  ));
  console.log(chalk.dim('  ' + '─'.repeat(68)));

  for (const file of files) {
    const filePath = path.join(SNAPSHOT_DIR, file);
    const stat = fs.statSync(filePath);
    const name = file.replace('.db', '');
    const size = formatBytes(stat.size);
    const created = stat.mtime.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });

    console.log(`  ${name.padEnd(W.name)}${size.padEnd(W.size)}${created}`);
  }

  console.log(chalk.dim(`\n  ${files.length} snapshot(s) in ${SNAPSHOT_DIR}`));
  console.log();
}

export async function runSnapshotRestore(name: string): Promise<void> {
  const sourcePath = path.join(SNAPSHOT_DIR, `${name}.db`);

  if (!fs.existsSync(sourcePath)) {
    // Try exact path
    if (fs.existsSync(name)) {
      return doRestore(name);
    }
    console.error(chalk.red(`Snapshot "${name}" not found`));
    console.log(chalk.dim(`  Looked in: ${sourcePath}`));
    process.exit(1);
  }

  return doRestore(sourcePath);
}

async function doRestore(sourcePath: string): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    // No existing DB, just copy
    fs.copyFileSync(sourcePath, DB_PATH);
    console.log(chalk.green(`Restored from ${path.basename(sourcePath)}`));
    return;
  }

  // Back up current DB first
  const backupName = `pre_restore_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const backupPath = path.join(SNAPSHOT_DIR, `${backupName}.db`);
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.copyFileSync(DB_PATH, backupPath);

  // Restore
  fs.copyFileSync(sourcePath, DB_PATH);

  console.log(chalk.green(`Restored from ${path.basename(sourcePath)}`));
  console.log(chalk.dim(`  Previous DB backed up as: ${backupName}`));
  console.log(chalk.yellow(`  Restart cortex.service to load the restored database`));
}
