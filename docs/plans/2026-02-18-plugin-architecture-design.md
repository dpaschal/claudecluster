# Plugin Architecture Design

## Goal

Refactor claudecluster into a lean fixed core with pluggable modules. Each node enables/disables plugins via per-node YAML config. New capabilities (Sentinel, future integrations) are added as plugins without touching core code.

## Architecture

### Fixed Core (always-on, not pluggable)

- **Security** — AuthManager, SecretsManager
- **TailscaleDiscovery** — node IP/hostname resolution
- **gRPC** — GrpcServer, GrpcClientPool, proto definitions
- **Raft** — RaftNode, consensus, log replication
- **Membership** — MembershipManager, heartbeats, failure detection
- **State** — ClusterStateManager
- **Scheduler** — TaskScheduler, task placement and execution
- **MCP Shell** — MCP SDK server that collects tools from plugins

### Plugin Interface

```typescript
// src/plugins/types.ts

interface PluginContext {
  raft: RaftNode;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  stateManager: ClusterStateManager;
  clientPool: GrpcClientPool;
  logger: Logger;
  nodeId: string;
  config: Record<string, unknown>;  // plugin-specific config from YAML
  events: EventEmitter;             // cross-plugin event bus
}

interface Plugin {
  name: string;
  version: string;

  init(ctx: PluginContext): Promise<void>;   // validate config, set up connections
  start(): Promise<void>;                    // begin background work
  stop(): Promise<void>;                     // clean shutdown

  getTools?(): Map<string, ToolHandler>;         // MCP tools to register
  getResources?(): Map<string, ResourceHandler>; // MCP resources
}
```

### Lifecycle

1. Core calls `init()` on all enabled plugins (validates config, creates DB connections)
2. Core calls `start()` on all plugins (starts intervals, event listeners)
3. On shutdown, `stop()` called in reverse order

Plugin init/start failures are logged and skipped — core services are never affected. A node with a dead DB still runs as a cluster member, just without timeline/network/context tools.

### Config

Per-node YAML with a `plugins` section. Restart required to apply changes.

```yaml
# config/default.yaml
plugins:
  timeline:
    enabled: true
    db_host: 192.168.1.138
    db_name: cerebrus
  network:
    enabled: true
    db_host: 192.168.1.138
  context:
    enabled: true
  kubernetes:
    enabled: false
  resource-monitor:
    enabled: true
  cluster-tools:
    enabled: true
  updater:
    enabled: true
  gaming-detection:
    enabled: false
```

### Plugin Loader

```typescript
// src/plugins/loader.ts
class PluginLoader {
  private plugins: Map<string, Plugin> = new Map();

  async loadAll(config: PluginConfig[], ctx: PluginContext): Promise<void>;
  getAllTools(): Map<string, ToolHandler>;  // merged from all plugins
  async startAll(): Promise<void>;
  async stopAll(): Promise<void>;          // reverse order
}
```

### Built-in Registry

Plugins resolved by name from a static map. Dynamic imports so disabled plugins don't load code.

```typescript
// src/plugins/registry.ts
const BUILTIN_PLUGINS: Record<string, () => Promise<Plugin>> = {
  'timeline':          () => import('./timeline/index.js').then(m => new m.TimelinePlugin()),
  'network':           () => import('./network/index.js').then(m => new m.NetworkPlugin()),
  'context':           () => import('./context/index.js').then(m => new m.ContextPlugin()),
  'kubernetes':        () => import('./kubernetes/index.js').then(m => new m.KubernetesPlugin()),
  'resource-monitor':  () => import('./resource-monitor/index.js').then(m => new m.ResourceMonitorPlugin()),
  'cluster-tools':     () => import('./cluster-tools/index.js').then(m => new m.ClusterToolsPlugin()),
  'updater':           () => import('./updater/index.js').then(m => new m.UpdaterPlugin()),
};
```

## Directory Structure

```
src/plugins/
  types.ts              # Plugin, PluginContext, PluginConfig interfaces
  loader.ts             # PluginLoader class
  registry.ts           # Built-in plugin name → import map

  timeline/
    index.ts            # TimelinePlugin implements Plugin
    (moves: src/mcp/timeline-db.ts, src/mcp/timeline-tools.ts)

  network/
    index.ts            # NetworkPlugin implements Plugin
    (moves: src/mcp/network-db.ts, src/mcp/network-tools.ts)

  context/
    index.ts            # ContextPlugin implements Plugin
    (moves: src/mcp/context-db.ts, src/mcp/context-tools.ts)

  kubernetes/
    index.ts            # KubernetesPlugin implements Plugin
    (moves: src/kubernetes/adapter.ts + k8s tools from tools.ts)

  resource-monitor/
    index.ts            # ResourceMonitorPlugin implements Plugin
    (moves: src/agent/resource-monitor.ts, src/agent/health-reporter.ts)

  cluster-tools/
    index.ts            # ClusterToolsPlugin implements Plugin
    (moves: core 8 MCP tools from src/mcp/tools.ts)

  updater/
    index.ts            # UpdaterPlugin implements Plugin
    (moves: src/cluster/updater.ts + initiate_rolling_update tool)
```

## Core Integration (index.ts changes)

```
1. Initialize core (security, tailscale, grpc, raft, membership, state, scheduler)
2. Build PluginContext from core refs
3. pluginLoader.loadAll(config.plugins, ctx)   // init all enabled plugins
4. Collect tools: pluginLoader.getAllTools()     // merged into MCP server
5. joinOrCreateCluster()
6. pluginLoader.startAll()                      // start background work
7. mcpServer.start(collectedTools)
```

## Event Bus

The `PluginContext.events` emitter replaces ad-hoc wiring in index.ts:

- `resource:snapshot` — resource-monitor emits, core subscribes to update membership
- `node:joined` / `node:offline` — core emits from membership, plugins can listen
- `leader:changed` — core emits from raft, plugins can react

## Migration Strategy

Move existing code, don't rewrite. Each plugin's `index.ts` is a thin wrapper:
- `init()` creates the DB pool / adapter
- `getTools()` calls existing `createXxxTools()` functions
- `start()` / `stop()` manage intervals

### What gets deleted
- `src/mcp/tools.ts` (886 LOC monolith) — split across cluster-tools and other plugins
- `src/mcp/server.ts` slims down to MCP SDK shell that receives tools from loader

### What stays untouched
- `src/cluster/` — Raft, Membership, State, Scheduler (core code doesn't move)
- `src/grpc/` — server, client, handlers
- `src/discovery/` — TailscaleDiscovery, ApprovalWorkflow
- `src/security/` — AuthManager, SecretsManager

## Error Handling & Isolation

- Plugin `init()` throws → logged, skipped, node starts without it
- Plugin `start()` throws → logged, skipped, tools not registered
- Plugin runtime errors → caught at MCP tool level, error returned to caller
- No inter-plugin dependencies in v1 (both must be enabled independently)

## What This Enables

1. **Sentinel Plugin** — `src/plugins/sentinel/` wrapping Go service client. Tools: `sentinel_alerts`, `sentinel_devices`. Enabled on forge only.
2. **Takeover/Giveback** — `src/plugins/takeover/` listening to `node:offline` events, re-queuing tasks.
3. **Per-node profiles** — htnas02 skips MCP tools, laptops skip k8s, gaming PCs enable gaming-detection.
4. **Future integrations** — new plugin = directory + registry entry + YAML toggle.
