/**
 * CLI Smoke Tests
 *
 * Validates the CLI startup paths don't regress:
 * - Daemon mode (no args) does NOT print Commander help and exit 1
 * - --help shows all subcommands and exits 0
 * - CLI subcommands route correctly
 *
 * These tests run against the compiled dist/index.js.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';

const ENTRY = resolve(__dirname, '../dist/index.js');

// Helper: run the CLI and capture output + exit code
function runCli(args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [ENTRY, ...args], {
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });

    proc.on('error', () => {
      resolve({ stdout, stderr, code: -1 });
    });
  });
}

describe('CLI Startup — Daemon Mode', () => {
  it('no args does NOT print Commander help and exit 1', async () => {
    // THE critical regression test: if CLI subcommands are registered before
    // the daemon path, Commander prints help and exits 1. The daemon should
    // either stay alive or fail for a legitimate reason (port conflict, etc.)
    // but NEVER exit because Commander thinks no subcommand was given.
    const result = await runCli([], 3000);
    const output = result.stdout + result.stderr;
    const isCommanderHelp = output.includes('Usage: cortex') && output.includes('Commands:');
    expect(isCommanderHelp).toBe(false);
  }, 10000);

  it('--isolated does not print Commander help', async () => {
    const result = await runCli(['--isolated'], 3000);
    const output = result.stdout + result.stderr;
    // --isolated prints banner and exits 0 (that's fine)
    // It should NOT show Commander's "Commands:" listing
    expect(output).not.toContain('Commands:');
  }, 10000);

  it('daemon options are parsed without triggering subcommand routing', async () => {
    // Using --isolated as a safe daemon flag that exits cleanly
    const result = await runCli(['--isolated'], 3000);
    expect(result.stdout).toContain('ISOLATED MODE');
    expect(result.code).toBe(0);
  }, 10000);
});

describe('CLI Help', () => {
  it('--help exits 0 and shows usage', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: cortex');
  });

  it('--help lists all registered subcommands', async () => {
    const result = await runCli(['--help']);
    const output = result.stdout;

    const expectedCommands = [
      'status', 'squelch', 'switch-leader', 'test',
      'events', 'top', 'run', 'ssh', 'logs',
      'drain', 'cordon', 'uncordon',
      'tasks', 'snapshot', 'diag', 'config', 'deploy',
    ];

    for (const cmd of expectedCommands) {
      expect(output, `missing command: ${cmd}`).toContain(cmd);
    }
  });

  it('--help shows daemon options', async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('--mcp');
    expect(result.stdout).toContain('--config');
    expect(result.stdout).toContain('--invisible');
    expect(result.stdout).toContain('--isolated');
  });

  it('-V prints version', async () => {
    const result = await runCli(['-V']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('CLI Subcommand Routing', () => {
  it('status --help exits 0 and shows status options', async () => {
    const result = await runCli(['status', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--address');
  });

  it('test --help exits 0 and shows test options', async () => {
    const result = await runCli(['test', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--failover');
    expect(result.stdout).toContain('--bot');
  });

  it('events --help exits 0', async () => {
    const result = await runCli(['events', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--since');
  });

  it('top --help exits 0', async () => {
    const result = await runCli(['top', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--once');
  });

  it('tasks --help exits 0', async () => {
    const result = await runCli(['tasks', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('list');
  });

  it('snapshot --help exits 0', async () => {
    const result = await runCli(['snapshot', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('create');
  });

  it('config --help exits 0', async () => {
    const result = await runCli(['config', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('show');
  });

  it('deploy --help exits 0', async () => {
    const result = await runCli(['deploy', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--no-build');
  });

  it('diag --help exits 0', async () => {
    const result = await runCli(['diag', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('diagnostic');
  });

  it('run --help exits 0', async () => {
    const result = await runCli(['run', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--nodes');
  });

  it('logs --help exits 0', async () => {
    const result = await runCli(['logs', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--follow');
  });
});

describe('CLI Edge Cases', () => {
  it('unknown flag errors gracefully, not with full help dump', async () => {
    const result = await runCli(['--nonexistent-flag'], 3000);
    if (result.code !== null && result.code !== 0) {
      // Should mention "unknown option", not dump full subcommand listing
      const output = result.stdout + result.stderr;
      expect(output).toContain('unknown option');
    }
  });

  it('help subcommand exits 0', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: cortex');
  });
});
