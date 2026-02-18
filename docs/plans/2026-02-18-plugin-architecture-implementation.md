# Plugin Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor claudecluster into a lean fixed core with pluggable modules, enabling per-node enable/disable via YAML config.

**Architecture:** Fixed core (Raft, Membership, gRPC, Security, Scheduler, State) stays untouched. New `src/plugins/` directory holds types, loader, registry, and 7 plugin directories. Each plugin wraps existing code with the Plugin interface (`init/start/stop/getTools`). The monolithic `src/mcp/tools.ts` (886 LOC) is split across plugins. `src/mcp/server.ts` slims to an MCP SDK shell that receives tools from the plugin loader.

**Tech Stack:** TypeScript, MCP SDK, pg (PostgreSQL), vitest

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
    // Interfaces don't exist at runtime, but we verify the module loads
    // and exports the ToolHandler re-export
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
import { EventEmitter } from 'events';

// Re-export ToolHandler so plugins don't import from tools.ts
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createMockContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    raft: {} as any,
    membership: {} as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    logger: createMockLogger(),
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: {},
    events: new EventEmitter(),
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
    name,
    version: '1.0.0',
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
      const registry = {
        alpha: async () => pluginA,
      };
      const pluginsConfig = { alpha: { enabled: true } };
      const ctx = createMockContext();

      await loader.loadAll(pluginsConfig, ctx, registry);

      expect(pluginA.init).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'test-node', config: { enabled: true } })
      );
    });

    it('should skip disabled plugins', async () => {
      const pluginA = createMockPlugin('alpha');
      const registry = {
        alpha: async () => pluginA,
      };
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
        expect.stringContaining('unknown'),
        expect.any(Object)
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
      const registry = {
        alpha: async () => pluginA,
        beta: async () => pluginB,
      };
      const pluginsConfig = {
        alpha: { enabled: true },
        beta: { enabled: true },
      };
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
        uri: 'cluster://test',
        name: 'Test',
        description: 'Test resource',
        mimeType: 'application/json',
        handler: async () => ({}),
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

      const registry = {
        alpha: async () => pluginA,
        beta: async () => pluginB,
      };
      const pluginsConfig = {
        alpha: { enabled: true },
        beta: { enabled: true },
      };
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
        'timeline',
        'network',
        'context',
        'kubernetes',
        'resource-monitor',
        'cluster-tools',
        'updater',
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
  'timeline':         () => import('./timeline/index.js').then(m => new m.TimelinePlugin()),
  'network':          () => import('./network/index.js').then(m => new m.NetworkPlugin()),
  'context':          () => import('./context/index.js').then(m => new m.ContextPlugin()),
  'kubernetes':       () => import('./kubernetes/index.js').then(m => new m.KubernetesPlugin()),
  'resource-monitor': () => import('./resource-monitor/index.js').then(m => new m.ResourceMonitorPlugin()),
  'cluster-tools':    () => import('./cluster-tools/index.js').then(m => new m.ClusterToolsPlugin()),
  'updater':          () => import('./updater/index.js').then(m => new m.UpdaterPlugin()),
};
```

> **Note:** This test will initially fail at the factory invocation level since plugin modules don't exist yet. The registry test only checks structure (keys and types), not dynamic imports. The `arrayContaining` test and the `typeof` check will both pass once the file is created — no dynamic import is called in the test.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/registry.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/plugins/registry.ts tests/plugins/registry.test.ts
git commit -m "feat(plugins): add built-in plugin registry with lazy dynamic imports"
```

---

### Task 4: Timeline Plugin

**Files:**
- Create: `src/plugins/timeline/index.ts`
- Test: `tests/plugins/timeline.test.ts`
- Reference (no changes): `src/mcp/timeline-db.ts`, `src/mcp/timeline-tools.ts`

**Step 1: Write the failing test**

Create `tests/plugins/timeline.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimelinePlugin } from '../src/plugins/timeline/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

// Mock the timeline modules to avoid real DB connections
vi.mock('../src/mcp/timeline-tools.js', () => ({
  createTimelineTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['timeline_create_thread', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any,
    membership: {} as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: { enabled: true, ...config },
    events: new EventEmitter(),
  };
}

describe('TimelinePlugin', () => {
  let plugin: TimelinePlugin;

  beforeEach(() => {
    plugin = new TimelinePlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('timeline');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose tools', async () => {
    const ctx = createMockContext();
    await plugin.init(ctx);

    const tools = plugin.getTools!();
    expect(tools).toBeDefined();
    expect(tools.size).toBeGreaterThan(0);
  });

  it('should pass connectionString from config', async () => {
    const { createTimelineTools } = await import('../src/mcp/timeline-tools.js');
    const ctx = createMockContext({ db_host: '192.168.1.138', db_name: 'cerebrus' });
    await plugin.init(ctx);

    expect(createTimelineTools).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: expect.stringContaining('192.168.1.138'),
      })
    );
  });

  it('should close DB on stop', async () => {
    const ctx = createMockContext();
    await plugin.init(ctx);
    await plugin.start();
    await plugin.stop();
    // No throw = success
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/timeline.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/plugins/timeline/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createTimelineTools } from '../../mcp/timeline-tools.js';
import { TimelineDB } from '../../mcp/timeline-db.js';

export class TimelinePlugin implements Plugin {
  name = 'timeline';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private db: TimelineDB | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const config = ctx.config;
    let connectionString: string | undefined;
    if (config.db_host) {
      const host = config.db_host as string;
      const dbName = (config.db_name as string) ?? 'cerebrus';
      const user = (config.db_user as string) ?? 'cerebrus';
      const password = (config.db_password as string) ?? 'cerebrus2025';
      const port = (config.db_port as number) ?? 5432;
      connectionString = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
    }

    const { tools, db } = createTimelineTools({
      logger: ctx.logger,
      connectionString,
    });
    this.tools = tools;
    this.db = db;
  }

  async start(): Promise<void> {
    // Timeline plugin has no background work
  }

  async stop(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/timeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/timeline/index.ts tests/plugins/timeline.test.ts
git commit -m "feat(plugins): add TimelinePlugin wrapping timeline-db and timeline-tools"
```

---

### Task 5: Network Plugin

**Files:**
- Create: `src/plugins/network/index.ts`
- Test: `tests/plugins/network.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/network.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkPlugin } from '../src/plugins/network/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/mcp/network-tools.js', () => ({
  createNetworkTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['network_lookup', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, ...config }, events: new EventEmitter(),
  };
}

describe('NetworkPlugin', () => {
  let plugin: NetworkPlugin;

  beforeEach(() => {
    plugin = new NetworkPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('network');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBeGreaterThan(0);
  });

  it('should close DB on stop', async () => {
    await plugin.init(createMockContext());
    await plugin.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/network.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/network/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createNetworkTools } from '../../mcp/network-tools.js';
import { NetworkDB } from '../../mcp/network-db.js';

export class NetworkPlugin implements Plugin {
  name = 'network';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private db: NetworkDB | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const config = ctx.config;
    let connectionString: string | undefined;
    if (config.db_host) {
      const host = config.db_host as string;
      const dbName = (config.db_name as string) ?? 'cerebrus';
      const user = (config.db_user as string) ?? 'cerebrus';
      const password = (config.db_password as string) ?? 'cerebrus2025';
      const port = (config.db_port as number) ?? 5432;
      connectionString = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
    }

    const { tools, db } = createNetworkTools({
      logger: ctx.logger,
      connectionString,
    });
    this.tools = tools;
    this.db = db;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/network.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/network/index.ts tests/plugins/network.test.ts
git commit -m "feat(plugins): add NetworkPlugin wrapping network-db and network-tools"
```

---

### Task 6: Context Plugin

**Files:**
- Create: `src/plugins/context/index.ts`
- Test: `tests/plugins/context.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextPlugin } from '../src/plugins/context/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/mcp/context-tools.js', () => ({
  createContextTools: vi.fn().mockReturnValue({
    tools: new Map([
      ['context_set', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }],
    ]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, ...config }, events: new EventEmitter(),
  };
}

describe('ContextPlugin', () => {
  let plugin: ContextPlugin;

  beforeEach(() => {
    plugin = new ContextPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('context');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should initialize and expose tools', async () => {
    await plugin.init(createMockContext());
    expect(plugin.getTools!().size).toBeGreaterThan(0);
  });

  it('should close DB on stop', async () => {
    await plugin.init(createMockContext());
    await plugin.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/context.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/context/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { createContextTools } from '../../mcp/context-tools.js';
import { ContextDB } from '../../mcp/context-db.js';

export class ContextPlugin implements Plugin {
  name = 'context';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private db: ContextDB | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const config = ctx.config;
    let connectionString: string | undefined;
    if (config.db_host) {
      const host = config.db_host as string;
      const dbName = (config.db_name as string) ?? 'cerebrus';
      const user = (config.db_user as string) ?? 'cerebrus';
      const password = (config.db_password as string) ?? 'cerebrus2025';
      const port = (config.db_port as number) ?? 5432;
      connectionString = `postgresql://${user}:${password}@${host}:${port}/${dbName}`;
    }

    const { tools, db } = createContextTools({
      logger: ctx.logger,
      connectionString,
    });
    this.tools = tools;
    this.db = db;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/context/index.ts tests/plugins/context.test.ts
git commit -m "feat(plugins): add ContextPlugin wrapping context-db and context-tools"
```

---

### Task 7: Cluster Tools Plugin

This is the most complex plugin — it wraps the 12 core tools from `src/mcp/tools.ts` (all except the 4 k8s tools which go to the kubernetes plugin).

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
  const nodes = [
    {
      nodeId: 'node-1', hostname: 'rog2', tailscaleIp: '100.104.78.123',
      grpcPort: 50051, role: 'leader', status: 'active',
      resources: {
        cpuCores: 16, memoryBytes: 32e9, memoryAvailableBytes: 16e9,
        gpus: [], diskBytes: 1e12, diskAvailableBytes: 500e9,
        cpuUsagePercent: 25, gamingDetected: false,
      },
      tags: [], joinedAt: Date.now(), lastSeen: Date.now(),
    },
  ];
  return {
    raft: { isLeader: vi.fn().mockReturnValue(true), getPeers: vi.fn().mockReturnValue([]) } as any,
    membership: {
      getAllNodes: vi.fn().mockReturnValue(nodes),
      getActiveNodes: vi.fn().mockReturnValue(nodes),
      getLeaderAddress: vi.fn().mockReturnValue('100.94.211.117:50051'),
      getSelfNode: vi.fn().mockReturnValue(nodes[0]),
      removeNode: vi.fn().mockResolvedValue(true),
    } as any,
    scheduler: {
      submit: vi.fn().mockResolvedValue({ accepted: true, assignedNode: 'node-1' }),
      getStatus: vi.fn().mockReturnValue({
        taskId: 'task-1', state: 'completed', assignedNode: 'node-1',
        startedAt: Date.now(), completedAt: Date.now(), exitCode: 0,
        result: { stdout: Buffer.from('ok'), stderr: Buffer.from('') },
      }),
    } as any,
    stateManager: {
      getState: vi.fn().mockReturnValue({ clusterId: 'test', nodes: [] }),
      getSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
      publishContext: vi.fn(),
      queryContext: vi.fn().mockReturnValue([]),
    } as any,
    clientPool: { closeConnection: vi.fn() } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'node-1',
    sessionId: 'session-1',
    config: { enabled: true },
    events: new EventEmitter(),
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

  it('should initialize and expose 12 cluster tools (no k8s)', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(12);

    // Core tools
    expect(tools.has('cluster_status')).toBe(true);
    expect(tools.has('list_nodes')).toBe(true);
    expect(tools.has('submit_task')).toBe(true);
    expect(tools.has('get_task_result')).toBe(true);
    expect(tools.has('run_distributed')).toBe(true);
    expect(tools.has('dispatch_subagents')).toBe(true);
    expect(tools.has('scale_cluster')).toBe(true);
    expect(tools.has('list_sessions')).toBe(true);
    expect(tools.has('relay_to_session')).toBe(true);
    expect(tools.has('publish_context')).toBe(true);
    expect(tools.has('query_context')).toBe(true);
    expect(tools.has('initiate_rolling_update')).toBe(true);

    // Should NOT have k8s tools
    expect(tools.has('k8s_list_clusters')).toBe(false);
    expect(tools.has('k8s_submit_job')).toBe(false);
    expect(tools.has('k8s_get_resources')).toBe(false);
    expect(tools.has('k8s_scale')).toBe(false);
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
    // createTools() returns all 16 tools including k8s — we need a
    // KubernetesAdapter stub since the real one lives in the kubernetes plugin.
    // For cluster-tools, we create tools with a no-op k8s adapter and remove
    // k8s tools from the result.
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

    // Remove k8s tools — those belong to the kubernetes plugin
    const k8sToolNames = ['k8s_list_clusters', 'k8s_submit_job', 'k8s_get_resources', 'k8s_scale'];
    for (const [name, handler] of allTools) {
      if (!k8sToolNames.includes(name)) {
        this.tools.set(name, handler);
      }
    }

    // Register cluster resources
    this.resources.set('cluster://state', {
      uri: 'cluster://state',
      name: 'Cluster State',
      description: 'Current state of the Claude Cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getState(),
    });

    this.resources.set('cluster://nodes', {
      uri: 'cluster://nodes',
      name: 'Cluster Nodes',
      description: 'List of all nodes in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.membership.getAllNodes(),
    });

    this.resources.set('cluster://sessions', {
      uri: 'cluster://sessions',
      name: 'Claude Sessions',
      description: 'Active Claude sessions in the cluster',
      mimeType: 'application/json',
      handler: async () => ctx.stateManager.getSessions(),
    });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  getResources(): Map<string, ResourceHandler> {
    return this.resources;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/cluster-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/cluster-tools/index.ts tests/plugins/cluster-tools.test.ts
git commit -m "feat(plugins): add ClusterToolsPlugin wrapping 12 core MCP tools + resources"
```

---

### Task 8: Kubernetes Plugin

**Files:**
- Create: `src/plugins/kubernetes/index.ts`
- Test: `tests/plugins/kubernetes.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/kubernetes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubernetesPlugin } from '../src/plugins/kubernetes/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/kubernetes/adapter.js', () => ({
  KubernetesAdapter: vi.fn().mockImplementation(() => ({
    discoverClusters: vi.fn().mockResolvedValue([]),
    listClusters: vi.fn().mockReturnValue([{
      name: 'test', type: 'k3s', context: 'default', nodes: [],
      totalCpu: 4, totalMemory: 8e9, gpuNodes: 0,
    }]),
    submitJob: vi.fn().mockResolvedValue('job-1'),
    getClusterResources: vi.fn().mockResolvedValue({
      totalCpu: 4, totalMemory: 8e9, allocatableCpu: 3,
      allocatableMemory: 6e9, gpuCount: 0, runningPods: 5,
    }),
    scaleDeployment: vi.fn().mockResolvedValue(true),
  })),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any, membership: {} as any, scheduler: {} as any,
    stateManager: {} as any, clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, ...config }, events: new EventEmitter(),
  };
}

describe('KubernetesPlugin', () => {
  let plugin: KubernetesPlugin;

  beforeEach(() => {
    plugin = new KubernetesPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('kubernetes');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should expose 4 k8s tools', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(4);
    expect(tools.has('k8s_list_clusters')).toBe(true);
    expect(tools.has('k8s_submit_job')).toBe(true);
    expect(tools.has('k8s_get_resources')).toBe(true);
    expect(tools.has('k8s_scale')).toBe(true);
  });

  it('should expose k8s resource', async () => {
    await plugin.init(createMockContext());
    const resources = plugin.getResources!();
    expect(resources.has('cluster://k8s')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/kubernetes.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/kubernetes/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler, ResourceHandler } from '../types.js';
import { KubernetesAdapter, K8sJobSpec } from '../../kubernetes/adapter.js';

export class KubernetesPlugin implements Plugin {
  name = 'kubernetes';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();
  private resources: Map<string, ResourceHandler> = new Map();
  private adapter: KubernetesAdapter | null = null;

  async init(ctx: PluginContext): Promise<void> {
    const kubeconfigPath = (ctx.config.kubeconfig_path as string) ?? undefined;

    this.adapter = new KubernetesAdapter({
      logger: ctx.logger,
      kubeconfigPath,
    });

    try {
      await this.adapter.discoverClusters();
    } catch (error) {
      ctx.logger.warn('Failed to discover Kubernetes clusters', { error });
    }

    const adapter = this.adapter;

    this.tools.set('k8s_list_clusters', {
      description: 'List all available Kubernetes clusters (GKE, K8s, K3s)',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return adapter.listClusters().map(c => ({
          name: c.name, type: c.type, context: c.context,
          nodes: c.nodes.length, totalCpu: c.totalCpu,
          totalMemoryGb: (c.totalMemory / (1024 ** 3)).toFixed(1),
          gpuNodes: c.gpuNodes,
        }));
      },
    });

    this.tools.set('k8s_submit_job', {
      description: 'Submit a job to a Kubernetes cluster',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
          image: { type: 'string', description: 'Container image to run' },
          command: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
          namespace: { type: 'string', description: 'Kubernetes namespace (default: default)' },
          cpuLimit: { type: 'string', description: 'CPU limit (e.g., "2", "500m")' },
          memoryLimit: { type: 'string', description: 'Memory limit (e.g., "4Gi")' },
          gpuLimit: { type: 'number', description: 'Number of GPUs to request' },
        },
        required: ['cluster', 'image'],
      },
      handler: async (args) => {
        const jobName = `claudecluster-${Date.now()}`;
        const spec: K8sJobSpec = {
          name: jobName,
          namespace: args.namespace as string,
          image: args.image as string,
          command: args.command as string[],
          cpuLimit: args.cpuLimit as string,
          memoryLimit: args.memoryLimit as string,
          gpuLimit: args.gpuLimit as number,
        };
        const name = await adapter.submitJob(args.cluster as string, spec);
        return { jobName: name, cluster: args.cluster, namespace: args.namespace ?? 'default' };
      },
    });

    this.tools.set('k8s_get_resources', {
      description: 'Get resource information for a Kubernetes cluster',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
        },
        required: ['cluster'],
      },
      handler: async (args) => {
        const resources = await adapter.getClusterResources(args.cluster as string);
        if (!resources) return { error: 'Cluster not found or inaccessible' };
        return {
          totalCpu: resources.totalCpu,
          totalMemoryGb: (resources.totalMemory / (1024 ** 3)).toFixed(1),
          allocatableCpu: resources.allocatableCpu,
          allocatableMemoryGb: (resources.allocatableMemory / (1024 ** 3)).toFixed(1),
          gpuCount: resources.gpuCount,
          runningPods: resources.runningPods,
        };
      },
    });

    this.tools.set('k8s_scale', {
      description: 'Scale a Kubernetes deployment',
      inputSchema: {
        type: 'object',
        properties: {
          cluster: { type: 'string', description: 'Kubernetes cluster context name' },
          deployment: { type: 'string', description: 'Deployment name' },
          replicas: { type: 'number', description: 'Desired number of replicas' },
          namespace: { type: 'string', description: 'Kubernetes namespace (default: default)' },
        },
        required: ['cluster', 'deployment', 'replicas'],
      },
      handler: async (args) => {
        const success = await adapter.scaleDeployment(
          args.cluster as string, args.deployment as string,
          args.replicas as number, args.namespace as string,
        );
        return { success, deployment: args.deployment, replicas: args.replicas };
      },
    });

    this.resources.set('cluster://k8s', {
      uri: 'cluster://k8s',
      name: 'Kubernetes Clusters',
      description: 'Available Kubernetes clusters',
      mimeType: 'application/json',
      handler: async () => adapter.listClusters(),
    });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  getResources(): Map<string, ResourceHandler> {
    return this.resources;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/kubernetes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/kubernetes/index.ts tests/plugins/kubernetes.test.ts
git commit -m "feat(plugins): add KubernetesPlugin wrapping k8s adapter and 4 k8s tools"
```

---

### Task 9: Resource Monitor Plugin

**Files:**
- Create: `src/plugins/resource-monitor/index.ts`
- Test: `tests/plugins/resource-monitor.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/resource-monitor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceMonitorPlugin } from '../src/plugins/resource-monitor/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

vi.mock('../src/agent/resource-monitor.js', () => ({
  ResourceMonitor: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    on: vi.fn(),
    toProtoResources: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../src/agent/health-reporter.js', () => ({
  HealthReporter: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../src/agent/task-executor.js', () => ({
  TaskExecutor: vi.fn().mockImplementation(() => ({})),
}));

function createMockContext(config: Record<string, unknown> = {}): PluginContext {
  return {
    raft: {} as any,
    membership: { updateNodeResources: vi.fn() } as any,
    scheduler: {} as any, stateManager: {} as any, clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node', sessionId: 'test-session',
    config: { enabled: true, ...config }, events: new EventEmitter(),
  };
}

describe('ResourceMonitorPlugin', () => {
  let plugin: ResourceMonitorPlugin;

  beforeEach(() => {
    plugin = new ResourceMonitorPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('resource-monitor');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should init without error', async () => {
    await plugin.init(createMockContext());
  });

  it('should start and stop monitoring', async () => {
    await plugin.init(createMockContext());
    await plugin.start();
    await plugin.stop();
  });

  it('should have no tools', async () => {
    await plugin.init(createMockContext());
    expect(plugin.getTools).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/resource-monitor.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/resource-monitor/index.ts`:

```typescript
import { Plugin, PluginContext } from '../types.js';
import { ResourceMonitor } from '../../agent/resource-monitor.js';
import { HealthReporter } from '../../agent/health-reporter.js';
import { TaskExecutor } from '../../agent/task-executor.js';

export class ResourceMonitorPlugin implements Plugin {
  name = 'resource-monitor';
  version = '1.0.0';

  private resourceMonitor: ResourceMonitor | null = null;
  private healthReporter: HealthReporter | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private ctx: PluginContext | null = null;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    const config = ctx.config;

    this.resourceMonitor = new ResourceMonitor({
      logger: ctx.logger,
      pollIntervalMs: config.poll_interval_ms as number | undefined,
      gamingProcesses: config.gaming_processes as string[] | undefined,
      gamingGpuThreshold: config.gaming_gpu_threshold as number | undefined,
      gamingCooldownMs: config.gaming_cooldown_ms as number | undefined,
    });

    this.taskExecutor = new TaskExecutor({ logger: ctx.logger });

    this.healthReporter = new HealthReporter({
      logger: ctx.logger,
      resourceMonitor: this.resourceMonitor,
      taskExecutor: this.taskExecutor,
      checkIntervalMs: config.health_check_interval_ms as number | undefined,
      memoryThresholdPercent: config.memory_threshold as number | undefined,
      cpuThresholdPercent: config.cpu_threshold as number | undefined,
      diskThresholdPercent: config.disk_threshold as number | undefined,
    });
  }

  async start(): Promise<void> {
    if (!this.resourceMonitor || !this.healthReporter || !this.ctx) return;

    await this.resourceMonitor.start();
    this.healthReporter.start();

    // Forward resource snapshots to membership via the event bus
    this.resourceMonitor.on('snapshot', () => {
      const protoResources = this.resourceMonitor!.toProtoResources();
      if (protoResources) {
        this.ctx!.membership.updateNodeResources(this.ctx!.nodeId, {
          cpuCores: protoResources.cpu_cores,
          memoryBytes: parseInt(protoResources.memory_bytes),
          memoryAvailableBytes: parseInt(protoResources.memory_available_bytes),
          gpus: protoResources.gpus.map((g: any) => ({
            name: g.name,
            memoryBytes: parseInt(g.memory_bytes),
            memoryAvailableBytes: parseInt(g.memory_available_bytes),
            utilizationPercent: g.utilization_percent,
            inUseForGaming: g.in_use_for_gaming,
          })),
          diskBytes: parseInt(protoResources.disk_bytes),
          diskAvailableBytes: parseInt(protoResources.disk_available_bytes),
          cpuUsagePercent: protoResources.cpu_usage_percent,
          gamingDetected: protoResources.gaming_detected,
        });
        // Emit on event bus for other plugins
        this.ctx!.events.emit('resource:snapshot', protoResources);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.healthReporter) this.healthReporter.stop();
    if (this.resourceMonitor) this.resourceMonitor.stop();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugins/resource-monitor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/resource-monitor/index.ts tests/plugins/resource-monitor.test.ts
git commit -m "feat(plugins): add ResourceMonitorPlugin wrapping resource-monitor and health-reporter"
```

---

### Task 10: Updater Plugin

**Files:**
- Create: `src/plugins/updater/index.ts`
- Test: `tests/plugins/updater.test.ts`

**Step 1: Write the failing test**

Create `tests/plugins/updater.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdaterPlugin } from '../src/plugins/updater/index.js';
import { PluginContext } from '../src/plugins/types.js';
import { EventEmitter } from 'events';

function createMockContext(): PluginContext {
  return {
    raft: {} as any,
    membership: {} as any,
    scheduler: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: { enabled: true },
    events: new EventEmitter(),
  };
}

describe('UpdaterPlugin', () => {
  let plugin: UpdaterPlugin;

  beforeEach(() => {
    plugin = new UpdaterPlugin();
  });

  it('should have correct name and version', () => {
    expect(plugin.name).toBe('updater');
    expect(plugin.version).toBe('1.0.0');
  });

  it('should expose initiate_rolling_update tool', async () => {
    await plugin.init(createMockContext());
    const tools = plugin.getTools!();
    expect(tools.size).toBe(1);
    expect(tools.has('initiate_rolling_update')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/updater.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

Create `src/plugins/updater/index.ts`:

```typescript
import { Plugin, PluginContext, ToolHandler } from '../types.js';
import * as path from 'path';

export class UpdaterPlugin implements Plugin {
  name = 'updater';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.tools.set('initiate_rolling_update', {
      description: 'Initiate an ISSU rolling update across all cluster nodes. Leader pushes new dist/ to followers one at a time, restarts each maintaining Raft quorum, with automatic rollback on failure. Leader restarts itself last.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: {
            type: 'boolean',
            description: 'If true, only run pre-flight checks without making changes (default: false)',
          },
        },
      },
      handler: async (args) => {
        const { RollingUpdater } = await import('../../cluster/updater.js');
        const { UpdateProgress } = await import('../../cluster/updater.js');

        const updater = new RollingUpdater({
          membership: ctx.membership,
          raft: ctx.raft,
          clientPool: ctx.clientPool,
          logger: ctx.logger,
          selfNodeId: ctx.nodeId,
          distDir: path.join(process.cwd(), 'dist'),
        });

        const progress: any[] = [];
        updater.on('progress', (event: any) => {
          progress.push(event);
        });

        const result = await updater.execute({ dryRun: args.dryRun as boolean });

        return { ...result, progress };
      },
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

Run: `npx vitest run tests/plugins/updater.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/plugins/updater/index.ts tests/plugins/updater.test.ts
git commit -m "feat(plugins): add UpdaterPlugin wrapping ISSU rolling update tool"
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
    expect(config.plugins.timeline).toBeDefined();
    expect(config.plugins.timeline.enabled).toBe(true);
    expect(config.plugins.network).toBeDefined();
    expect(config.plugins.context).toBeDefined();
    expect(config.plugins.kubernetes).toBeDefined();
    expect(config.plugins['resource-monitor']).toBeDefined();
    expect(config.plugins['cluster-tools']).toBeDefined();
    expect(config.plugins.updater).toBeDefined();
  });

  it('kubernetes should be disabled by default', () => {
    const configFile = fs.readFileSync('config/default.yaml', 'utf-8');
    const config = parseYaml(configFile);
    expect(config.plugins.kubernetes.enabled).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugins/config.test.ts`
Expected: FAIL — `config.plugins` is undefined

**Step 3: Add plugins section to config/default.yaml**

Append to `config/default.yaml` (before the `seeds` section):

```yaml
# Plugin configuration
# Each plugin can be enabled/disabled per-node. Restart required to apply changes.
plugins:
  timeline:
    enabled: true
    db_host: 192.168.1.138
    db_name: cerebrus
  network:
    enabled: true
    db_host: 192.168.1.138
    db_name: cerebrus
  context:
    enabled: true
    db_host: 192.168.1.138
    db_name: cerebrus
  kubernetes:
    enabled: false
  resource-monitor:
    enabled: true
  cluster-tools:
    enabled: true
  updater:
    enabled: true
```

**Step 4: Add `plugins` field to `ClusterConfig` in `src/index.ts`**

Add to the `ClusterConfig` interface (after the `mcp` field, around line 97):

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

This is the key integration task. The MCP server needs to receive tools from the plugin loader instead of directly importing and calling `createTools()`, `createTimelineTools()`, `createNetworkTools()`, and `createContextTools()`.

**Files:**
- Modify: `src/mcp/server.ts`
- Test: Verify existing tests still pass

**Step 1: Write the failing test**

Add a new test to verify the refactored server accepts pre-built tools. Create `tests/plugins/server-integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ToolHandler } from '../src/plugins/types.js';
import { ResourceHandler } from '../src/plugins/types.js';

describe('MCP Server Plugin Integration', () => {
  it('ToolHandler interface should be importable from plugins/types', async () => {
    const types = await import('../src/plugins/types.js');
    expect(types).toBeDefined();
  });

  it('server should accept externally provided tool and resource maps', async () => {
    // This test validates the new McpServerConfig shape
    // The actual server requires stdio transport, so we test the config type
    const { ClusterMcpServer } = await import('../src/mcp/server.js');
    expect(ClusterMcpServer).toBeDefined();
  });
});
```

**Step 2: Refactor `src/mcp/server.ts`**

Replace the contents of `src/mcp/server.ts` with:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'winston';
import { ToolHandler, ResourceHandler } from '../plugins/types.js';

export interface McpServerConfig {
  logger: Logger;
  tools: Map<string, ToolHandler>;
  resources: Map<string, ResourceHandler>;
}

export class ClusterMcpServer {
  private config: McpServerConfig;
  private server: Server;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.server = new Server(
      { name: 'claudecluster', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {} } },
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.config.tools.entries()).map(([name, handler]) => ({
        name,
        description: handler.description,
        inputSchema: handler.inputSchema,
      }));
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = this.config.tools.get(name);

      if (!handler) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      try {
        this.config.logger.debug('Executing MCP tool', { name, args });
        const result = await handler.handler(args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        this.config.logger.error('Tool execution failed', { name, error });
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = Array.from(this.config.resources.values()).map(r => ({
        uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
      }));
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const resource = this.config.resources.get(uri);

      if (!resource) {
        return { contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource: ${uri}` }] };
      }

      const content = await resource.handler();
      return { contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(content, null, 2) }] };
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.config.logger.info('MCP server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.config.logger.info('MCP server stopped');
  }
}
```

**Step 3: Run existing tests plus new test**

Run: `npx vitest run tests/plugins/server-integration.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/mcp/server.ts tests/plugins/server-integration.test.ts
git commit -m "refactor(mcp): slim server.ts to receive tools/resources from plugin loader"
```

---

### Task 13: Refactor `src/index.ts` to Use Plugin Loader

This is the core wiring task. Replace the direct component initialization with plugin loader flow.

**Files:**
- Modify: `src/index.ts`

**Step 1: Understand what changes**

The following code in `src/index.ts` needs to change:

1. **Import the plugin loader and registry** (add new imports)
2. **Remove direct imports** of `createTools`, `createTimelineTools`, etc. (server.ts already removed them)
3. **Add `initializePlugins()` method** between `initializeKubernetes()` and `initializeMcp()`
4. **Remove `initializeAgent()` and `initializeKubernetes()`** calls from `start()` — resource-monitor and kubernetes plugins handle this now
5. **Change `initializeMcp()`** to pass tools/resources from plugin loader
6. **Change `stop()`** to call `pluginLoader.stopAll()` instead of individual component stops

**Step 2: Make the changes to `src/index.ts`**

Add imports at the top:

```typescript
import { PluginLoader } from './plugins/loader.js';
import { BUILTIN_PLUGINS } from './plugins/registry.js';
import { PluginContext, PluginsConfig } from './plugins/types.js';
```

Add a new property to `ClaudeCluster`:

```typescript
private pluginLoader: PluginLoader | null = null;
```

Add a new method `initializePlugins()`:

```typescript
private async initializePlugins(): Promise<void> {
  this.pluginLoader = new PluginLoader(this.logger);

  const pluginsConfig: PluginsConfig = (this.config.plugins ?? {
    'cluster-tools': { enabled: true },
    'resource-monitor': { enabled: true },
    'timeline': { enabled: true },
    'network': { enabled: true },
    'context': { enabled: true },
    'updater': { enabled: true },
    'kubernetes': { enabled: false },
  }) as PluginsConfig;

  const ctx: PluginContext = {
    raft: this.raft!,
    membership: this.membership!,
    scheduler: this.scheduler!,
    stateManager: this.stateManager!,
    clientPool: this.clientPool!,
    logger: this.logger,
    nodeId: this.nodeId,
    sessionId: this.sessionId,
    config: {},
    events: new EventEmitter(),
  };

  await this.pluginLoader.loadAll(pluginsConfig, ctx, BUILTIN_PLUGINS);
  this.logger.info('Plugins initialized');
}
```

In `start()`, replace `initializeAgent()` and `initializeKubernetes()` with `initializePlugins()`. The call order becomes:

```
1. initializeSecurity()
2. initializeTailscale()
3. initializeGrpc()
4. initializeCluster()
5. initializeAnnouncements()
6. initializePlugins()           // NEW — replaces initializeAgent() + initializeKubernetes()
7. joinOrCreateCluster() / initializeMcp()
8. pluginLoader.startAll()       // NEW — after cluster join
```

In `initializeMcp()`, replace the old `new ClusterMcpServer(...)` call:

```typescript
private async initializeMcp(): Promise<void> {
  const tools = this.pluginLoader!.getAllTools();
  const resources = this.pluginLoader!.getAllResources();

  this.mcpServer = new ClusterMcpServer({
    logger: this.logger,
    tools,
    resources,
  });

  this.logger.info('MCP server initialized', { tools: tools.size, resources: resources.size });

  if (this.mcpMode) {
    this.logger.info('Starting MCP server in stdio mode');
    await this.mcpServer.start();
  }
}
```

In `stop()`, add `pluginLoader.stopAll()` before stopping core components:

```typescript
// Stop plugins first (reverse order)
if (this.pluginLoader) {
  await this.pluginLoader.stopAll();
}
```

Remove the manual resource monitor / health reporter / k8s shutdown from `stop()` since plugins handle their own cleanup.

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass. The `mcp-tools.test.ts` tests may need adjustments since they test the old `createTools()` function directly — those tests still work because `createTools()` is still exported from `tools.ts`, just no longer called by `server.ts` directly. The cluster-tools plugin wraps it.

**Step 4: Build and verify**

Run: `npm run build`
Expected: No TypeScript errors

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor(core): wire plugin loader into ClaudeCluster startup/shutdown lifecycle"
```

---

### Task 14: Update Existing Tests

**Files:**
- Modify: `tests/mcp-tools.test.ts` — remove the old `ToolHandler` import from `tools.ts`, import from `plugins/types.ts` instead
- Run: Full test suite

**Step 1: Update imports in `tests/mcp-tools.test.ts`**

Change line 2:

```typescript
// Before:
import { createTools, ToolHandler, ToolsConfig } from '../src/mcp/tools.js';

// After (createTools and ToolsConfig still come from tools.ts, ToolHandler from types):
import { createTools, ToolsConfig } from '../src/mcp/tools.js';
import { ToolHandler } from '../src/plugins/types.js';
```

> **Note:** The test file tests `createTools()` directly (the raw function), which still exists in `tools.ts` and is called by `ClusterToolsPlugin`. These tests remain valid as unit tests for the tool implementations.

**Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing 358 + new plugin tests)

**Step 3: Commit**

```bash
git add tests/mcp-tools.test.ts
git commit -m "test: update mcp-tools test imports to use ToolHandler from plugins/types"
```

---

### Task 15: Clean Up — Fix `ToolHandler` Duplicate and Export Path

**Files:**
- Modify: `src/mcp/tools.ts` — change `ToolHandler` to re-export from `plugins/types.ts`
- Modify: `src/mcp/timeline-tools.ts`, `src/mcp/network-tools.ts`, `src/mcp/context-tools.ts` — import `ToolHandler` from `plugins/types.ts` instead of `tools.ts`

**Step 1: Update `src/mcp/tools.ts`**

Remove the `ToolHandler` interface definition (lines 12-20) and replace with a re-export:

```typescript
// Re-export ToolHandler from the canonical location
export { ToolHandler } from '../plugins/types.js';
```

**Step 2: Update the three tool files**

In `src/mcp/timeline-tools.ts`, change:
```typescript
// Before:
import { ToolHandler } from './tools.js';
// After:
import { ToolHandler } from '../plugins/types.js';
```

Same change in `src/mcp/network-tools.ts` and `src/mcp/context-tools.ts`.

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Build**

Run: `npm run build`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/timeline-tools.ts src/mcp/network-tools.ts src/mcp/context-tools.ts
git commit -m "refactor: canonicalize ToolHandler export from plugins/types.ts"
```

---

### Task 16: Integration Smoke Test

**Files:**
- Create: `tests/plugins/integration.test.ts`

**Step 1: Write the integration test**

Create `tests/plugins/integration.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PluginLoader } from '../src/plugins/loader.js';
import { PluginContext, PluginsConfig } from '../src/plugins/types.js';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

// Mock DB-backed modules
vi.mock('../src/mcp/timeline-tools.js', () => ({
  createTimelineTools: vi.fn().mockReturnValue({
    tools: new Map([['timeline_create_thread', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }]]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock('../src/mcp/network-tools.js', () => ({
  createNetworkTools: vi.fn().mockReturnValue({
    tools: new Map([['network_lookup', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }]]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock('../src/mcp/context-tools.js', () => ({
  createContextTools: vi.fn().mockReturnValue({
    tools: new Map([['context_set', { description: 'mock', inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) }]]),
    db: { close: vi.fn().mockResolvedValue(undefined) },
  }),
}));
vi.mock('../src/kubernetes/adapter.js', () => ({
  KubernetesAdapter: vi.fn().mockImplementation(() => ({
    discoverClusters: vi.fn().mockResolvedValue([]),
    listClusters: vi.fn().mockReturnValue([]),
    submitJob: vi.fn().mockResolvedValue(''),
    getClusterResources: vi.fn().mockResolvedValue(null),
    scaleDeployment: vi.fn().mockResolvedValue(false),
  })),
}));
vi.mock('../src/agent/resource-monitor.js', () => ({
  ResourceMonitor: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    on: vi.fn(),
    toProtoResources: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock('../src/agent/health-reporter.js', () => ({
  HealthReporter: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));
vi.mock('../src/agent/task-executor.js', () => ({
  TaskExecutor: vi.fn().mockImplementation(() => ({})),
}));

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe('Plugin Integration', () => {
  it('should load all 7 plugins and merge tools correctly', async () => {
    const { BUILTIN_PLUGINS } = await import('../src/plugins/registry.js');
    const logger = createMockLogger();
    const loader = new PluginLoader(logger);

    const nodes = [{
      nodeId: 'node-1', hostname: 'test', tailscaleIp: '127.0.0.1',
      grpcPort: 50051, role: 'leader', status: 'active',
      resources: null, tags: [], joinedAt: Date.now(), lastSeen: Date.now(),
    }];

    const ctx: PluginContext = {
      raft: { isLeader: vi.fn().mockReturnValue(true), getPeers: vi.fn().mockReturnValue([]) } as any,
      membership: {
        getAllNodes: vi.fn().mockReturnValue(nodes),
        getActiveNodes: vi.fn().mockReturnValue(nodes),
        getLeaderAddress: vi.fn().mockReturnValue('127.0.0.1:50051'),
        getSelfNode: vi.fn().mockReturnValue(nodes[0]),
        removeNode: vi.fn().mockResolvedValue(true),
        updateNodeResources: vi.fn(),
      } as any,
      scheduler: {
        submit: vi.fn().mockResolvedValue({ accepted: true }),
        getStatus: vi.fn().mockReturnValue(null),
      } as any,
      stateManager: {
        getState: vi.fn().mockReturnValue({}),
        getSessions: vi.fn().mockReturnValue([]),
        getSession: vi.fn().mockReturnValue(null),
        publishContext: vi.fn(),
        queryContext: vi.fn().mockReturnValue([]),
      } as any,
      clientPool: { closeConnection: vi.fn() } as any,
      logger,
      nodeId: 'node-1',
      sessionId: 'session-1',
      config: {},
      events: new EventEmitter(),
    };

    const pluginsConfig: PluginsConfig = {
      'timeline': { enabled: true },
      'network': { enabled: true },
      'context': { enabled: true },
      'kubernetes': { enabled: true },
      'resource-monitor': { enabled: true },
      'cluster-tools': { enabled: true },
      'updater': { enabled: true },
    };

    await loader.loadAll(pluginsConfig, ctx, BUILTIN_PLUGINS);

    const tools = loader.getAllTools();
    const resources = loader.getAllResources();

    // Verify tool count: 1 timeline + 1 network + 1 context + 4 k8s + 12 cluster + 1 updater = 20
    // (mocked timeline/network/context each return 1 tool)
    expect(tools.size).toBeGreaterThanOrEqual(18);

    // Verify no duplicate tools
    const toolNames = Array.from(tools.keys());
    expect(new Set(toolNames).size).toBe(toolNames.length);

    // Verify resources from cluster-tools and kubernetes plugins
    expect(resources.has('cluster://state')).toBe(true);
    expect(resources.has('cluster://nodes')).toBe(true);
    expect(resources.has('cluster://sessions')).toBe(true);
    expect(resources.has('cluster://k8s')).toBe(true);

    // Start and stop should not throw
    await loader.startAll();
    await loader.stopAll();
  });

  it('should work with plugins disabled', async () => {
    const { BUILTIN_PLUGINS } = await import('../src/plugins/registry.js');
    const logger = createMockLogger();
    const loader = new PluginLoader(logger);

    const ctx: PluginContext = {
      raft: {} as any, membership: {} as any, scheduler: {} as any,
      stateManager: {} as any, clientPool: {} as any,
      logger, nodeId: 'node-1', sessionId: 'session-1',
      config: {}, events: new EventEmitter(),
    };

    const pluginsConfig: PluginsConfig = {
      'timeline': { enabled: false },
      'network': { enabled: false },
      'context': { enabled: false },
      'kubernetes': { enabled: false },
      'resource-monitor': { enabled: false },
      'cluster-tools': { enabled: false },
      'updater': { enabled: false },
    };

    await loader.loadAll(pluginsConfig, ctx, BUILTIN_PLUGINS);

    expect(loader.getAllTools().size).toBe(0);
    expect(loader.getAllResources().size).toBe(0);
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run tests/plugins/integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build, no errors

**Step 5: Commit**

```bash
git add tests/plugins/integration.test.ts
git commit -m "test: add plugin integration smoke test verifying all 7 plugins load and merge"
```

---

### Task 17: Deploy and Verify on Forge

**Step 1: Build**

Run: `npm run build`

**Step 2: Deploy to forge**

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "cd ~/claudecluster && git pull && npm run build && sudo systemctl restart claudecluster"
```

**Step 3: Check logs for plugin loading**

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "journalctl -u claudecluster --since '1 min ago' --no-pager | head -40"
```

Expected: Log lines showing "Plugin loaded" for each enabled plugin, "Plugin started" for each, and "MCP server initialized" with tool/resource counts.

**Step 4: Verify cluster stability**

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.200 "journalctl -u claudecluster --since '2 min ago' --no-pager | grep -i 'error\|warn'"
```

Expected: No new errors. Heartbeats flowing, tools responding.

**Step 5: Commit message for the entire feature (squash if needed)**

```bash
git tag plugin-architecture-v1
```
