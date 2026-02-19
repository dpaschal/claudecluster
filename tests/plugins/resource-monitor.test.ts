import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceMonitorPlugin } from '../../src/plugins/resource-monitor/index.js';
import { PluginContext } from '../../src/plugins/types.js';
import { EventEmitter } from 'events';

// Mock all three agent modules
vi.mock('../../src/agent/resource-monitor.js', () => ({
  ResourceMonitor: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      getLastSnapshot: vi.fn().mockReturnValue(null),
    });
  }),
}));

vi.mock('../../src/agent/task-executor.js', () => ({
  TaskExecutor: vi.fn().mockImplementation(() => ({
    getRunningTaskIds: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/agent/health-reporter.js', () => ({
  HealthReporter: vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn(),
      stop: vi.fn(),
    });
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any,
    membership: {} as any,
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

describe('ResourceMonitorPlugin', () => {
  let plugin: ResourceMonitorPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new ResourceMonitorPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('resource-monitor');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should not expose any tools', async () => {
    await plugin.init(createMockContext());
    expect(plugin.getTools).toBeUndefined();
  });

  it('should initialize resource monitor, task executor, and health reporter', async () => {
    const { ResourceMonitor } = await import('../../src/agent/resource-monitor.js');
    const { TaskExecutor } = await import('../../src/agent/task-executor.js');
    const { HealthReporter } = await import('../../src/agent/health-reporter.js');

    await plugin.init(createMockContext());

    expect(ResourceMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ logger: expect.any(Object) })
    );
    expect(TaskExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ logger: expect.any(Object) })
    );
    expect(HealthReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.any(Object),
        resourceMonitor: expect.any(Object),
        taskExecutor: expect.any(Object),
      })
    );
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });

  it('should forward resource:snapshot events to context event bus', async () => {
    const ctx = createMockContext();
    await plugin.init(ctx);
    await plugin.start();

    const { ResourceMonitor } = await import('../../src/agent/resource-monitor.js');
    const monitorInstance = (ResourceMonitor as any).mock.results[0].value;

    const snapshotHandler = vi.fn();
    ctx.events.on('resource:snapshot', snapshotHandler);

    // Simulate a snapshot event from the resource monitor
    monitorInstance.emit('snapshot', { cpu: 50, memory: 80 });

    expect(snapshotHandler).toHaveBeenCalledWith({ cpu: 50, memory: 80 });
  });
});
