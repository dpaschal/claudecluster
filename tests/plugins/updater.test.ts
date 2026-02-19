import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdaterPlugin } from '../../src/plugins/updater/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../../src/cluster/updater.js', () => ({
  RollingUpdater: vi.fn().mockImplementation(() => ({
    preflight: vi.fn().mockResolvedValue({
      ok: true,
      nodes: [{ nodeId: 'node-1', hostname: 'test' }],
      followers: [{ nodeId: 'node-2', hostname: 'follower' }],
      quorumSize: 2,
      votingCount: 3,
    }),
    execute: vi.fn().mockResolvedValue({
      success: true,
      nodesUpdated: ['node-2'],
      nodesRolledBack: [],
    }),
  })),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true) } as any,
    membership: { getAllNodes: vi.fn().mockReturnValue([]) } as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: {} as any,
    memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: { enabled: true, ...config },
    events: new EventEmitter(),
  };
}

describe('UpdaterPlugin', () => {
  let plugin: UpdaterPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new UpdaterPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('updater');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should expose initiate_rolling_update tool', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools();
    expect(tools.size).toBe(1);
    expect(tools.has('initiate_rolling_update')).toBe(true);
  });

  it('should return preflight result on dryRun', async () => {
    await plugin.init(createMockContext());
    const tool = plugin.getTools().get('initiate_rolling_update')!;
    const result = await tool.handler({ dryRun: true });
    expect(result).toEqual(expect.objectContaining({
      success: true,
      dryRun: true,
      phase: 'preflight',
      quorumSize: 2,
      votingCount: 3,
    }));
  });

  it('should execute update when not dryRun', async () => {
    await plugin.init(createMockContext());
    const tool = plugin.getTools().get('initiate_rolling_update')!;
    const result = await tool.handler({});
    expect(result).toEqual(expect.objectContaining({
      success: true,
      nodesUpdated: ['node-2'],
      nodesRolledBack: [],
    }));
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
