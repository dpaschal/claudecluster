# Plugin Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor Cortex into a lean fixed core with pluggable modules, enabling per-node enable/disable via YAML config. Wire in orphaned skills and messaging subsystems.

**Architecture:** Fixed core (Raft, Membership, gRPC, Security, Scheduler, State, SharedMemoryDB, MemoryReplicator) stays untouched. New `src/plugins/` directory holds types, loader, registry, and 7 plugin directories. Each plugin wraps existing code with the Plugin interface (`init/start/stop/getTools`). The monolithic `src/mcp/tools.ts` is split across plugins. `src/mcp/server.ts` slims to an MCP SDK shell that receives tools from the plugin loader. Skills and messaging (currently orphaned — have factories+tests but aren't wired into MCP) get connected.

**Tech Stack:** TypeScript, MCP SDK, better-sqlite3, vitest

**Design doc:** `docs/plans/2026-02-18-plugin-architecture-design.md`

---

### Task 1: Plugin Type Definitions

**Files:**
- Create: `src/plugins/types.ts`
- Test: `tests/plugins/types.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Plugin Types', () => {
  it('should export Plugin and PluginContext interfaces', async () => {
    const types = await import('../src/plugins/types.js');
    expect(types).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/types.ts`:

```typescript
import { Logger } from 'winston';
import { RaftNode } from '../cluster/raft.js';
import { MembershipManager } from '../cluster/membership.js';
import { TaskScheduler } from '../cluster/scheduler.js';
import { ClusterStateManager } from '../cluster/state.js';
import { GrpcClientPool } from '../grpc/client.js';
import { SharedMemoryDB } from '../memory/shared-memory-db.js';
import { MemoryReplicator } from '../memory/replication.js';
import { EventEmitter } from 'events';

export interface ToolHandler {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ResourceHandler {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: () => Promise<unknown>;
}

export interface PluginContext {
  raft: RaftNode;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  stateManager: ClusterStateManager;
  clientPool: GrpcClientPool;
  sharedMemoryDb: SharedMemoryDB;
  memoryReplicator: MemoryReplicator;
  logger: Logger;
  nodeId: string;
  sessionId: string;
  config: Record<string, unknown>;
  events: EventEmitter;
}

export interface Plugin {
  name: string;
  version: string;

  init(ctx: PluginContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  getTools?(): Map<string, ToolHandler>;
  getResources?(): Map<string, ResourceHandler>;
}

export interface PluginEntry {
  enabled: boolean;
  [key: string]: unknown;
}

export type PluginsConfig = Record<string, PluginEntry>;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/types.ts tests/plugins/types.test.ts
git commit -m "feat(plugins): add Plugin, PluginContext, and ToolHandler type definitions"
```

---

### Task 2: Plugin Loader

**Files:**
- Create: `src/plugins/loader.ts`
- Test: `tests/plugins/loader.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/loader.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginLoader } from '../src/plugins/loader.js';
import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../src/plugins/types.js';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

function createMockLogger(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;
}

function createMockContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: createMockLogger(), nodeId: 'test-node', sessionId: 'test-session',
    config: {}, events: new EventEmitter(),
    ...overrides,
  };
}

function createMockPlugin(name: string, overrides: Partial<Plugin> = {}): Plugin {
  const tools = new Map<string, ToolHandler>();
  tools.set(`${name}_tool`, {
    description: `Tool from ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true }),
  });
  return {
    name, version: '1.0.0',
    init: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getTools: () => tools,
    ...overrides,
  };
}

describe('PluginLoader', () => {
  let loader: PluginLoader;
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
    loader = new PluginLoader(logger);
  });

  describe('loadAll', () => {
    it('should load enabled plugins from registry', async () => {
      const pluginA = createMockPlugin('alpha');
      const registry = { alpha: async () => pluginA };
      const pluginsConfig = { alpha: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);

      expect(pluginA.init).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'test-node', config: { enabled: true } })
      );
    });

    it('should skip disabled plugins', async () => {
      const pluginA = createMockPlugin('alpha');
      const registry = { alpha: async () => pluginA };
      const pluginsConfig = { alpha: { enabled: false } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(pluginA.init).not.toHaveBeenCalled();
    });

    it('should skip plugins not in registry', async () => {
      const registry = {};
      const pluginsConfig = { unknown: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('unknown'), expect.any(Object)
      );
    });

    it('should catch and log init failures without crashing', async () => {
      const badPlugin = createMockPlugin('bad');
      badPlugin.init = vi.fn().mockRejectedValue(new Error('init boom'));
      const registry = { bad: async () => badPlugin };
      const pluginsConfig = { bad: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(logger.error).toHaveBeenCalled();
      expect(loader.getAllTools().size).toBe(0);
    });
  });

  describe('getAllTools', () => {
    it('should merge tools from all loaded plugins', async () => {
      const pluginA = createMockPlugin('alpha');
      const pluginB = createMockPlugin('beta');
      const registry = { alpha: async () => pluginA, beta: async () => pluginB };
      const pluginsConfig = { alpha: { enabled: true }, beta: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      const tools = loader.getAllTools();
      expect(tools.has('alpha_tool')).toBe(true);
      expect(tools.has('beta_tool')).toBe(true);
      expect(tools.size).toBe(2);
    });
  });

  describe('getAllResources', () => {
    it('should merge resources from all loaded plugins', async () => {
      const resources = new Map<string, ResourceHandler>();
      resources.set('cluster://test', {
        uri: 'cluster://test', name: 'Test', description: 'Test resource',
        mimeType: 'application/json', handler: async () => ({}),
      });
      const plugin = createMockPlugin('res');
      plugin.getResources = () => resources;
      const registry = { res: async () => plugin };
      const pluginsConfig = { res: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      expect(loader.getAllResources().has('cluster://test')).toBe(true);
    });
  });

  describe('startAll / stopAll', () => {
    it('should start all loaded plugins', async () => {
      const plugin = createMockPlugin('alpha');
      const registry = { alpha: async () => plugin };
      const pluginsConfig = { alpha: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.startAll();
      expect(plugin.start).toHaveBeenCalled();
    });

    it('should stop plugins in reverse order', async () => {
      const order: string[] = [];
      const pluginA = createMockPlugin('alpha');
      pluginA.stop = vi.fn().mockImplementation(async () => { order.push('alpha'); });
      const pluginB = createMockPlugin('beta');
      pluginB.stop = vi.fn().mockImplementation(async () => { order.push('beta'); });

      const registry = { alpha: async () => pluginA, beta: async () => pluginB };
      const pluginsConfig = { alpha: { enabled: true }, beta: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.stopAll();
      expect(order).toEqual(['beta', 'alpha']);
    });

    it('should catch and log start failures without crashing', async () => {
      const plugin = createMockPlugin('bad');
      plugin.start = vi.fn().mockRejectedValue(new Error('start boom'));
      const registry = { bad: async () => plugin };
      const pluginsConfig = { bad: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);
      await loader.startAll();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/loader.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/loader.ts`:

```typescript
import { Logger } from 'winston';
import { Plugin, PluginContext, PluginsConfig, ToolHandler, ResourceHandler } from './types.js';

export type PluginFactory = () => Promise<Plugin>;
export type PluginRegistry = Record<string, PluginFactory>;

export class PluginLoader {
  private plugins: Plugin[] = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async loadAll(
    pluginsConfig: PluginsConfig,
    baseCtx: PluginContext,
    registry: PluginRegistry,
  ): Promise<void> {
    for (const [name, entry] of Object.entries(pluginsConfig)) {
      if (!entry.enabled) {
        this.logger.debug('Plugin disabled, skipping', { plugin: name });
        continue;
      }

      const factory = registry[name];
      if (!factory) {
        this.logger.warn('Plugin not found in registry, skipping', { plugin: name });
        continue;
      }

      try {
        const plugin = await factory();
        const ctx: PluginContext = { ...baseCtx, config: entry };
        await plugin.init(ctx);
        this.plugins.push(plugin);
        this.logger.info('Plugin loaded', { plugin: name, version: plugin.version });
      } catch (error) {
        this.logger.error('Plugin init failed, skipping', {
          plugin: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  getAllTools(): Map<string, ToolHandler> {
    const merged = new Map<string, ToolHandler>();
    for (const plugin of this.plugins) {
      if (plugin.getTools) {
        for (const [name, handler] of plugin.getTools()) {
          merged.set(name, handler);
        }
      }
    }
    return merged;
  }

  getAllResources(): Map<string, ResourceHandler> {
    const merged = new Map<string, ResourceHandler>();
    for (const plugin of this.plugins) {
      if (plugin.getResources) {
        for (const [name, handler] of plugin.getResources()) {
          merged.set(name, handler);
        }
      }
    }
    return merged;
  }

  async startAll(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.start();
        this.logger.info('Plugin started', { plugin: plugin.name });
      } catch (error) {
        this.logger.error('Plugin start failed', {
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async stopAll(): Promise<void> {
    const reversed = [...this.plugins].reverse();
    for (const plugin of reversed) {
      try {
        await plugin.stop();
        this.logger.info('Plugin stopped', { plugin: plugin.name });
      } catch (error) {
        this.logger.error('Plugin stop failed', {
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/loader.test.ts`
Expected: PASS (all 9 tests)

**Step 5: Commit**

```bash
git add src/plugins/loader.ts tests/plugins/loader.test.ts
git commit -m "feat(plugins): add PluginLoader with init/start/stop lifecycle and tool merging"
```

---

### Task 3: Plugin Registry

**Files:**
- Create: `src/plugins/registry.ts`
- Test: `tests/plugins/registry.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/plugins/registry.js';

describe('Plugin Registry', () => {
  it('should export BUILTIN_PLUGINS with all 7 plugin names', () => {
    expect(Object.keys(BUILTIN_PLUGINS)).toEqual(
      expect.arrayContaining([
        'memory',
        'cluster-tools',
        'kubernetes',
        'resource-monitor',
        'updater',
        'skills',
        'messaging',
      ])
    );
    expect(Object.keys(BUILTIN_PLUGINS).length).toBe(7);
  });

  it('each entry should be a factory function', () => {
    for (const [name, factory] of Object.entries(BUILTIN_PLUGINS)) {
      expect(typeof factory).toBe('function');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/registry.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/registry.ts`:

```typescript
import { Plugin } from './types.js';

export type PluginFactory = () => Promise<Plugin>;

export const BUILTIN_PLUGINS: Record<string, PluginFactory> = {
  'memory':           () => import('./memory/index.js').then(m => new m.MemoryPlugin()),
  'cluster-tools':    () => import('./cluster-tools/index.js').then(m => new m.ClusterToolsPlugin()),
  'kubernetes':       () => import('./kubernetes/index.js').then(m => new m.KubernetesPlugin()),
  'resource-monitor': () => import('./resource-monitor/index.js').then(m => new m.ResourceMonitorPlugin()),
  'updater':          () => import('./updater/index.js').then(m => new m.UpdaterPlugin()),
  'skills':           () => import('./skills/index.js').then(m => new m.SkillsPlugin()),
  'messaging':        () => import('./messaging/index.js').then(m => new m.MessagingPlugin()),
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/registry.test.ts`
Expected: PASS (2 tests — tests only check keys and types, no dynamic imports called)

**Step 5: Commit**

```bash
git add src/plugins/registry.ts tests/plugins/registry.test.ts
git commit -m "feat(plugins): add built-in plugin registry with 7 lazy-loaded plugins"
```

---

### Task 4: Memory Plugin

Wraps `createMemoryTools()` from `src/mcp/memory-tools.ts`. This replaces the old timeline/network/context plugins that wrapped deleted PostgreSQL code.

**Files:**
- Create: `src/plugins/memory/index.ts`
- Test: `tests/plugins/memory.test.ts`
- Reference (no changes): `src/mcp/memory-tools.ts`

**Step 1: Write the failing test**

Create `tests/plugins/memory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryPlugin } from '../src/plugins/memory/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/mcp/memory-tools.js', () => ({
  createMemoryTools: vi.fn().mockReturnValue(new Map([
    ['memory_query', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_write', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_log_thought', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ['memory_whereami', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
  ])),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true) } as any,
    membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: { query: vi.fn(), run: vi.fn() } as any,
    memoryReplicator: { replicateWrite: vi.fn() } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, ...config }, events: new EventEmitter(),
  };
}

describe('MemoryPlugin', () => {
  let plugin: MemoryPlugin;

  beforeEach(() => {
    plugin = new MemoryPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('memory');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose memory tools', async () => {
    const ctx = createMockContext();
    await plugin.init(ctx);

    const tools = plugin.getTools!();
    expect(tools).toBeDefined();
    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has('memory_query')).toBe(true);
    expect(tools.has('memory_whereami')).toBe(true);
  });

  it('should pass sharedMemoryDb and memoryReplicator to createMemoryTools', async () => {
    const { createMemoryTools } = await import('../src/mcp/memory-tools.js');
    const ctx = createMockContext();
    await plugin.init(ctx);

    expect(createMemoryTools).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedMemoryDb: ctx.sharedMemoryDb,
        memoryReplicator: ctx.memoryReplicator,
      })
    );
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/memory.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/memory/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createMemoryTools } from '../../mcp/memory-tools.js';

export class MemoryPlugin implements Plugin {
  name = 'memory';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.tools = createMemoryTools({
      sharedMemoryDb: ctx.sharedMemoryDb,
      memoryReplicator: ctx.memoryReplicator,
      raft: ctx.raft,
      nodeId: ctx.nodeId,
      logger: ctx.logger,
    });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/memory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/memory/index.ts tests/plugins/memory.test.ts
git commit -m "feat(plugins): add MemoryPlugin wrapping csm memory-tools (12 MCP tools)"
```

---

### Task 5: Cluster Tools Plugin

**Files:**
- Create: `src/plugins/cluster-tools/index.ts`
- Test: `tests/plugins/cluster-tools.test.ts`
- Reference: `src/mcp/tools.ts` (the existing `createTools()` function)

**Step 1: Write the failing test**

Create `tests/plugins/cluster-tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClusterToolsPlugin } from '../src/plugins/cluster-tools/index.js';
import { PluginContext, ResourceHandler } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

function createMockContext(): PluginContext {
  const nodes = [{
    nodeId: 'node-1', hostname: 'test', tailscaleIp: '100.0.0.1',
    grpcPort: 50051, role: 'leader', status: 'active',
    resources: {
      cpuCores: 16, memoryBytes: 32e9, memoryAvailableBytes: 16e9,
      gpus: [], diskBytes: 1e12, diskAvailableBytes: 500e9,
      cpuUsagePercent: 25, gamingDetected: false,
    },
    tags: [], joinedAt: Date.now(), lastSeen: Date.now(),
  }];
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true), getPeers: vi.fn().mockReturnValue([]) } as any,
    membership: {
      getAllNodes: vi.fn().mockReturnValue(nodes),
      getActiveNodes: vi.fn().mockReturnValue(nodes),
      getLeaderAddress: vi.fn().mockReturnValue('100.0.0.1:50051'),
      getSelfNode: vi.fn().mockReturnValue(nodes[0]),
      removeNode: vi.fn().mockResolvedValue(true),
    } as any,
    scheduler: {
      submit: vi.fn().mockResolvedValue({ accepted: true, assignedNode: 'node-1' }),
      getStatus: vi.fn().mockReturnValue(null),
    } as any,
    stateManager: {
      getState: vi.fn().mockReturnValue({ clusterId: 'test', nodes: [] }),
      getSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
      publishContext: vi.fn(),
      queryContext: vi.fn().mockReturnValue([]),
    } as any,
    clientPool: { closeConnection: vi.fn() } as any,
    sharedMemoryDb: {} as any,
    memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'node-1', sessionId: 'session-1',
    config: { enabled: true }, events: new EventEmitter(),
  };
}

describe('ClusterToolsPlugin', () => {
  let plugin: ClusterToolsPlugin;

  beforeEach(() => {
    plugin = new ClusterToolsPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('cluster-tools');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose cluster tools (no k8s)', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();

    expect(tools.has('cluster_status')).toBe(true);
    expect(tools.has('list_nodes')).toBe(true);
    expect(tools.has('submit_task')).toBe(true);

    // Should NOT have k8s tools
    expect(tools.has('k8s_list_clusters')).toBe(false);
    expect(tools.has('k8s_submit_job')).toBe(false);

    // Should NOT have initiate_rolling_update (that's in updater plugin)
    expect(tools.has('initiate_rolling_update')).toBe(false);
  });

  it('should expose cluster resources', async () => {
    await plugin.init(createMockContext());
    const resources = plugin.getResources!();
    expect(resources.has('cluster://state')).toBe(true);
    expect(resources.has('cluster://nodes')).toBe(true);
    expect(resources.has('cluster://sessions')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/cluster-tools.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/cluster-tools/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../types.js';
import { createTools } from '../../mcp/tools.js';

export class ClusterToolsPlugin implements Plugin {
  name = 'cluster-tools';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private resources: Map<string, ResourceHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    // createTools() returns all tools including k8s and updater.
    // We strip k8s tools (kubernetes plugin) and updater (updater plugin).
    const noopK8s = {
      listClusters: () => [],
      submitJob: async () => '',
      getClusterResources: async () => null,
      scaleDeployment: async () => false,
      discoverClusters: async () => [],
    } as any;

    const allTools = createTools({
      stateManager: ctx.stateManager,
      membership: ctx.membership,
      scheduler: ctx.scheduler,
      k8sAdapter: noopK8s,
      clientPool: ctx.clientPool,
      raft: ctx.raft,
      sessionId: ctx.sessionId,
      nodeId: ctx.nodeId,
      logger: ctx.logger,
    });

    const excludeTools = [
      'k8s_list_clusters', 'k8s_submit_job', 'k8s_get_resources', 'k8s_scale',
      'initiate_rolling_update',
    ];
    for (const [name, handler] of allTools) {
      if (!excludeTools.includes(name)) {
        this.tools.set(name, handler);
      }
    }

    this.resources.set('cluster://state', {
      uri: 'cluster://state', name: 'Cluster State',
      description: 'Current state of the Cortex cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getState(),
    });
    this.resources.set('cluster://nodes', {
      uri: 'cluster://nodes', name: 'Cluster Nodes',
      description: 'List of all nodes in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.membership.getAllNodes(),
    });
    this.resources.set('cluster://sessions', {
      uri: 'cluster://sessions', name: 'Claude Sessions',
      description: 'Active Claude sessions in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getSessions(),
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> { return this.tools; }
  getResources(): Map<string, ResourceHandler> { return this.resources; }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/cluster-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/cluster-tools/index.ts tests/plugins/cluster-tools.test.ts
git commit -m "feat(plugins): add ClusterToolsPlugin wrapping core MCP tools + resources"
```

---

### Task 6: Kubernetes Plugin

**Files:**
- Create: `src/plugins/kubernetes/index.ts`
- Test: `tests/plugins/kubernetes.test.ts`

Same as original Task 8 (unchanged — KubernetesAdapter hasn't changed). See original plan for full test and implementation code. The plugin wraps `KubernetesAdapter`, exposes 4 k8s tools and a `cluster://k8s` resource.

**Commit message:** `feat(plugins): add KubernetesPlugin wrapping k8s adapter and 4 k8s tools`

---

### Task 7: Resource Monitor Plugin

**Files:**
- Create: `src/plugins/resource-monitor/index.ts`
- Test: `tests/plugins/resource-monitor.test.ts`

Same as original Task 9 (unchanged). Wraps `ResourceMonitor`, `HealthReporter`, `TaskExecutor`. No MCP tools — emits `resource:snapshot` events. The test mock context needs `sharedMemoryDb` and `memoryReplicator` fields now.

**Commit message:** `feat(plugins): add ResourceMonitorPlugin wrapping resource-monitor and health-reporter`

---

### Task 8: Updater Plugin

**Files:**
- Create: `src/plugins/updater/index.ts`
- Test: `tests/plugins/updater.test.ts`

Same as original Task 10 (unchanged). Wraps `RollingUpdater` via lazy import. Exposes `initiate_rolling_update` tool.

**Commit message:** `feat(plugins): add UpdaterPlugin wrapping ISSU rolling update tool`

---

### Task 9: Skills Plugin (NEW — wires orphaned code)

**Files:**
- Create: `src/plugins/skills/index.ts`
- Test: `tests/plugins/skills.test.ts`
- Reference (no changes): `src/skills/loader.ts`, `src/mcp/skill-tools.ts`

**Step 1: Write the failing test**

Create `tests/plugins/skills.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsPlugin } from '../src/plugins/skills/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/mcp/skill-tools.js', () => ({
  createSkillTools: vi.fn().mockResolvedValue({
    tools: new Map([
      ['list_skills', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['get_skill', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    loader: { stop: vi.fn() },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, directories: ['~/.cortex/skills'], ...config },
    events: new EventEmitter(),
  };
}

describe('SkillsPlugin', () => {
  let plugin: SkillsPlugin;

  beforeEach(() => {
    plugin = new SkillsPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('skills');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose skill tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(2);
    expect(tools.has('list_skills')).toBe(true);
    expect(tools.has('get_skill')).toBe(true);
  });

  it('should stop skill loader on stop', async () => {
    const { createSkillTools } = await import('../src/mcp/skill-tools.js');
    await plugin.init(createMockContext());
    await plugin.stop();
    // Verify loader.stop() was called
    const mockResult = await (createSkillTools as any).mock.results[0].value;
    expect(mockResult.loader.stop).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/skills.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/skills/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createSkillTools } from '../../mcp/skill-tools.js';
import { SkillLoader } from '../../skills/loader.js';

export class SkillsPlugin implements Plugin {
  name = 'skills';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private loader: SkillLoader | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const directories = (ctx.config.directories as string[]) ?? ['~/.cortex/skills'];

    const result = await createSkillTools({
      logger: ctx.logger,
      directories,
    });

    this.tools = result.tools;
    this.loader = result.loader;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.loader) {
      this.loader.stop();
      this.loader = null;
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/skills.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/skills/index.ts tests/plugins/skills.test.ts
git commit -m "feat(plugins): add SkillsPlugin wiring orphaned skill-tools into MCP"
```

---

### Task 10: Messaging Plugin (NEW — wires orphaned code)

**Files:**
- Create: `src/plugins/messaging/index.ts`
- Test: `tests/plugins/messaging.test.ts`
- Reference (no changes): `src/messaging/gateway.ts`, `src/messaging/inbox.ts`, `src/mcp/messaging-tools.ts`

**Step 1: Write the failing test**

Create `tests/plugins/messaging.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagingPlugin } from '../src/plugins/messaging/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/mcp/messaging-tools.js', () => ({
  createMessagingTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['messaging_send', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_check', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
      ['messaging_list', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    inbox: { stop: vi.fn() },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true) } as any,
    membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    sharedMemoryDb: {} as any, memoryReplicator: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, inboxPath: '/tmp/test-inbox', ...config },
    events: new EventEmitter(),
  };
}

describe('MessagingPlugin', () => {
  let plugin: MessagingPlugin;

  beforeEach(() => {
    plugin = new MessagingPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('messaging');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose messaging tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBeGreaterThan(0);
    expect(tools.has('messaging_send')).toBe(true);
  });

  it('should start and stop without error', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/messaging.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/messaging/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createMessagingTools } from '../../mcp/messaging-tools.js';
import { Inbox } from '../../messaging/inbox.js';

export class MessagingPlugin implements Plugin {
  name = 'messaging';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private inbox: Inbox | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const inboxPath = (ctx.config.inboxPath as string) ?? '~/.cortex/inbox';

    const result = createMessagingTools({
      logger: ctx.logger,
      inboxPath,
      raft: ctx.raft,
      nodeId: ctx.nodeId,
    });

    this.tools = result.tools;
    this.inbox = result.inbox;
  }

  async start(): Promise<void> {
    // MessagingGateway (Discord/Telegram) activation is leader-only
    // and requires channel config — deferred to a future enhancement.
    // For now, the inbox-based tools (send/check/list/get) work on all nodes.
  }

  async stop(): Promise<void> {
    // Inbox cleanup if needed
    this.inbox = null;
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

> **Note:** The `createMessagingTools` function signature in `src/mcp/messaging-tools.ts` may need to be checked — the implementation should match its actual parameters. Adjust the init() call to match the real `MessagingToolsConfig` interface.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/messaging.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/messaging/index.ts tests/plugins/messaging.test.ts
git commit -m "feat(plugins): add MessagingPlugin wiring orphaned messaging-tools into MCP"
```

---

### Task 11: Add Plugins Config to YAML and ClusterConfig

**Files:**
- Modify: `config/default.yaml`
- Modify: `src/index.ts` (add `plugins` to `ClusterConfig` interface)
- Test: `tests/plugins/config.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';

describe('Plugin Config', () => {
  it('default.yaml should have a plugins section with all 7 plugins', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);

    expect(config.plugins).toBeDefined();
    expect(config.plugins.memory).toBeDefined();
    expect(config.plugins.memory.enabled).toBe(true);
    expect(config.plugins['cluster-tools']).toBeDefined();
    expect(config.plugins['resource-monitor']).toBeDefined();
    expect(config.plugins.updater).toBeDefined();
    expect(config.plugins.skills).toBeDefined();
    expect(config.plugins.messaging).toBeDefined();
    expect(config.plugins.kubernetes).toBeDefined();
  });

  it('kubernetes, skills, and messaging should be disabled by default', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);
    expect(config.plugins.kubernetes.enabled).toBe(false);
    expect(config.plugins.skills.enabled).toBe(false);
    expect(config.plugins.messaging.enabled).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/config.test.ts`
Expected: FAIL — `config.plugins` is undefined

**Step 3: Add plugins section to config/default.yaml**

Append before the `seeds` section:

```yaml
# Plugin configuration — per-node enable/disable. Restart required.
plugins:
  memory:
    enabled: true
  cluster-tools:
    enabled: true
  resource-monitor:
    enabled: true
  updater:
    enabled: true
  skills:
    enabled: false
    directories:
      - ~/.cortex/skills
  messaging:
    enabled: false
    agent: "Cipher"
    inboxPath: ~/.cortex/inbox
  kubernetes:
    enabled: false
```

**Step 4: Add `plugins` field to `ClusterConfig` in `src/index.ts`**

Add to the `ClusterConfig` interface:

```typescript
  plugins?: Record<string, { enabled: boolean; [key: string]: unknown }>;
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/plugins/config.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add config/default.yaml src/index.ts tests/plugins/config.test.ts
git commit -m "feat(plugins): add plugins section to config/default.yaml and ClusterConfig"
```

---

### Task 12: Refactor `src/mcp/server.ts` to Use Plugin Loader

Slim `server.ts` to receive tools/resources from the plugin loader instead of directly calling `createTools()` and `createMemoryTools()`.

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `tests/plugins/server-integration.test.ts`

The new `McpServerConfig` takes `tools: Map<string, ToolHandler>` and `resources: Map<string, ResourceHandler>` — no more direct imports of tool factories. See design doc for the full slimmed `ClusterMcpServer` implementation.

**Commit message:** `refactor(mcp): slim server.ts to receive tools/resources from plugin loader`

---

### Task 13: Refactor `src/index.ts` to Use Plugin Loader

Replace direct component initialization with plugin loader flow. Remove `initializeAgent()`, `initializeKubernetes()`, `initializeMessaging()`, `initializeSkills()`. Add `initializePlugins()`. Change `initializeMcp()` to receive tools from plugin loader. Change `stop()` to call `pluginLoader.stopAll()`.

**Files:**
- Modify: `src/index.ts`

**New initialization order:**
```
1. initializeSecurity()
2. initializeTailscale()
3. initializeGrpc()
4. initializeCluster()        // includes SharedMemoryDB + MemoryReplicator (core)
5. initializeAnnouncements()
6. initializePlugins()        // NEW — replaces agent/k8s/messaging/skills
7. joinOrCreateCluster() / initializeMcp()
8. pluginLoader.startAll()    // NEW — after cluster join
```

**Commit message:** `refactor(core): wire plugin loader into Cortex startup/shutdown lifecycle`

---

### Task 14: Update Existing Tests

Update `tests/mcp-tools.test.ts` imports — `ToolHandler` comes from `plugins/types.ts` now.

**Commit message:** `test: update mcp-tools test imports to use ToolHandler from plugins/types`

---

### Task 15: Clean Up — Canonicalize ToolHandler Export

Change `src/mcp/tools.ts` to re-export `ToolHandler` from `plugins/types.ts`. Update `src/mcp/memory-tools.ts`, `src/mcp/skill-tools.ts`, `src/mcp/messaging-tools.ts` to import from the canonical location.

**Commit message:** `refactor: canonicalize ToolHandler export from plugins/types.ts`

---

### Task 16: Integration Smoke Test

Full integration test that loads all 7 plugins via the real registry, merges tools, starts/stops the lifecycle.

**Commit message:** `test: add plugin integration smoke test verifying all 7 plugins load and merge`

---

### Task 17: Build, Test, Deploy

```bash
npm run build           # Clean compile
npm run test:run        # All tests pass
git push
# Deploy to all 6 nodes
```

**Commit message:** Tag with `plugin-architecture-v1`

---

## Verification

After all tasks:

```bash
npm run build                    # Clean compile
npm run test:run                 # All tests pass
grep -r 'createTimelineTools\|createNetworkTools\|createContextTools' src/mcp/server.ts  # Should return 0
grep -r 'initializeAgent\|initializeKubernetes' src/index.ts  # Should return 0 (moved to plugins)
```

Acceptable remaining references:
- `src/mcp/tools.ts` — `createTools()` still exported, called by ClusterToolsPlugin
- `src/mcp/memory-tools.ts` — `createMemoryTools()` still exported, called by MemoryPlugin
- `src/mcp/skill-tools.ts` — `createSkillTools()` still exported, called by SkillsPlugin
- `src/mcp/messaging-tools.ts` — `createMessagingTools()` still exported, called by MessagingPlugin
- `docs/plans/*.md` — historical design documents
