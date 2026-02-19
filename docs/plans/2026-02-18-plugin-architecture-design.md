# Plugin Architecture Design

## Goal

Refactor Cortex into a lean fixed core with pluggable modules. Each node enables/disables plugins via per-node YAML config. New capabilities (Sentinel, future integrations) are added as plugins without touching core code.

## Architecture

### Fixed Core (always-on, not pluggable)

- **Security** — AuthManager, SecretsManager
- **TailscaleDiscovery** — node IP/hostname resolution
- **gRPC** — GrpcServer, GrpcClientPool, proto definitions
- **Raft** — RaftNode, consensus, log replication
- **Membership** — MembershipManager, heartbeats, failure detection
- **State** — ClusterStateManager
- **Scheduler** — TaskScheduler, task placement and execution
- **SharedMemoryDB** — csm (cortex.shared.memory) — embedded SQLite, always initialized in core
- **MemoryReplicator** — Raft-based replication of csm writes
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
  sharedMemoryDb: SharedMemoryDB;       // csm — local SQLite
  memoryReplicator: MemoryReplicator;   // csm — Raft replication
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

1. Core calls `init()` on all enabled plugins (validates config, sets up state)
2. Core calls `start()` on all plugins (starts intervals, event listeners)
3. On shutdown, `stop()` called in reverse order

Plugin init/start failures are logged and skipped — core services are never affected. A node with a failed plugin still runs as a cluster member, just without that plugin's tools.

### Config

Per-node YAML with a `plugins` section. Restart required to apply changes.

```yaml
# config/default.yaml
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

### Plugin Loader

```typescript
// src/plugins/loader.ts
class PluginLoader {
  private plugins: Plugin[] = [];

  async loadAll(config: PluginsConfig, ctx: PluginContext, registry: PluginRegistry): Promise<void>;
  getAllTools(): Map<string, ToolHandler>;     // merged from all plugins
  getAllResources(): Map<string, ResourceHandler>;
  async startAll(): Promise<void>;
  async stopAll(): Promise<void>;            // reverse order
}
```

### Built-in Registry

Plugins resolved by name from a static map. Dynamic imports so disabled plugins don't load code.

```typescript
// src/plugins/registry.ts
const BUILTIN_PLUGINS: Record<string, () => Promise<Plugin>> = {
  'memory':           () => import('./memory/index.js').then(m => new m.MemoryPlugin()),
  'cluster-tools':    () => import('./cluster-tools/index.js').then(m => new m.ClusterToolsPlugin()),
  'kubernetes':       () => import('./kubernetes/index.js').then(m => new m.KubernetesPlugin()),
  'resource-monitor': () => import('./resource-monitor/index.js').then(m => new m.ResourceMonitorPlugin()),
  'updater':          () => import('./updater/index.js').then(m => new m.UpdaterPlugin()),
  'skills':           () => import('./skills/index.js').then(m => new m.SkillsPlugin()),
  'messaging':        () => import('./messaging/index.js').then(m => new m.MessagingPlugin()),
};
```

## Plugins (7)

### 1. Memory Plugin
Wraps `createMemoryTools()` from `src/mcp/memory-tools.ts`. Provides all 12 csm MCP tools (memory_query, memory_write, memory_schema, memory_stats, memory_log_thought, memory_whereami, memory_handoff, memory_set_context, memory_get_context, memory_search, memory_network_lookup, memory_list_threads).

- `init()`: calls `createMemoryTools({ sharedMemoryDb, memoryReplicator, raft, nodeId, logger })`
- `getTools()`: returns the 12 memory tools
- No background work, no DB connections to manage (csm is core)

### 2. Cluster Tools Plugin
Wraps `createTools()` from `src/mcp/tools.ts`, excluding the 4 k8s tools (those belong to the kubernetes plugin). Provides cluster management, task submission, session relay, context sharing.

- `init()`: calls `createTools(...)`, removes k8s tool entries
- `getTools()`: returns ~12 cluster tools
- `getResources()`: cluster://state, cluster://nodes, cluster://sessions

### 3. Kubernetes Plugin
Wraps `KubernetesAdapter` from `src/kubernetes/adapter.ts`. Provides 4 k8s tools.

- `init()`: creates KubernetesAdapter, discovers clusters
- `getTools()`: k8s_list_clusters, k8s_submit_job, k8s_get_resources, k8s_scale
- `getResources()`: cluster://k8s

### 4. Resource Monitor Plugin
Wraps `ResourceMonitor`, `HealthReporter`, `TaskExecutor` from `src/agent/`. No MCP tools — emits `resource:snapshot` events for membership updates.

- `init()`: creates ResourceMonitor, HealthReporter, TaskExecutor
- `start()`: starts monitoring, wires snapshot events to membership
- `stop()`: stops monitoring

### 5. Updater Plugin
Wraps `RollingUpdater` from `src/cluster/updater.ts`. Provides the `initiate_rolling_update` tool.

- `init()`: registers the tool (lazy-imports RollingUpdater on invocation)
- `getTools()`: initiate_rolling_update

### 6. Skills Plugin (NEW — wires orphaned code)
Wraps `SkillLoader` from `src/skills/loader.ts` and `createSkillTools()` from `src/mcp/skill-tools.ts`. Currently these exist but are NOT registered in the MCP server.

- `init()`: creates SkillLoader, calls `createSkillTools()`
- `getTools()`: list_skills, get_skill
- `stop()`: calls `skillLoader.stop()`

### 7. Messaging Plugin (NEW — wires orphaned code)
Wraps `MessagingGateway` from `src/messaging/gateway.ts`, `Inbox` from `src/messaging/inbox.ts`, and `createMessagingTools()` from `src/mcp/messaging-tools.ts`. Currently these exist but tools are NOT registered in the MCP server.

- `init()`: creates Inbox, calls `createMessagingTools()`
- `start()`: creates MessagingGateway (leader-only activation), starts inbox
- `getTools()`: messaging_send, messaging_check, messaging_list, messaging_get, messaging_gateway_status
- `stop()`: stops gateway and inbox

## Directory Structure

```
src/plugins/
  types.ts              # Plugin, PluginContext, PluginConfig interfaces
  loader.ts             # PluginLoader class
  registry.ts           # Built-in plugin name → import map

  memory/
    index.ts            # MemoryPlugin — wraps createMemoryTools()

  cluster-tools/
    index.ts            # ClusterToolsPlugin — wraps createTools() minus k8s

  kubernetes/
    index.ts            # KubernetesPlugin — wraps KubernetesAdapter + 4 k8s tools

  resource-monitor/
    index.ts            # ResourceMonitorPlugin — wraps ResourceMonitor + HealthReporter

  updater/
    index.ts            # UpdaterPlugin — wraps RollingUpdater tool

  skills/
    index.ts            # SkillsPlugin — wraps SkillLoader + createSkillTools()

  messaging/
    index.ts            # MessagingPlugin — wraps MessagingGateway + Inbox + createMessagingTools()
```

## Core Integration (index.ts changes)

```
1. Initialize core (security, tailscale, grpc, raft, membership, sharedMemoryDb, memoryReplicator, state, scheduler)
2. Build PluginContext from core refs (includes sharedMemoryDb, memoryReplicator)
3. pluginLoader.loadAll(config.plugins, ctx)   // init all enabled plugins
4. Collect tools: pluginLoader.getAllTools()     // merged into MCP server
5. joinOrCreateCluster()
6. pluginLoader.startAll()                      // start background work
7. mcpServer.start(collectedTools)
```

Removes from index.ts: `initializeAgent()`, `initializeKubernetes()`, `initializeMessaging()`, `initializeSkills()`. These become plugins.

## Event Bus

The `PluginContext.events` emitter replaces ad-hoc wiring in index.ts:

- `resource:snapshot` — resource-monitor emits, core subscribes to update membership
- `node:joined` / `node:offline` — core emits from membership, plugins can listen
- `leader:changed` — core emits from raft, plugins can react (messaging activates on leader only)

## Migration Strategy

Move existing code, don't rewrite. Each plugin's `index.ts` is a thin wrapper:
- `init()` calls existing `createXxxTools()` functions
- `start()` / `stop()` manage intervals and adapters

### What gets deleted from index.ts
- `initializeAgent()` — becomes resource-monitor plugin
- `initializeKubernetes()` — becomes kubernetes plugin
- `initializeMessaging()` — becomes messaging plugin
- `initializeSkills()` — becomes skills plugin
- Direct tool creation in `initializeMcp()` — replaced by plugin loader

### What stays in index.ts (core)
- `initializeSecurity()`, `initializeTailscale()`, `initializeGrpc()`
- `initializeCluster()` — including SharedMemoryDB + MemoryReplicator (core, not plugin)
- `initializeAnnouncements()`
- `initializeMcp()` — slimmed to receive tools from plugin loader

### What stays untouched
- `src/cluster/` — Raft, Membership, State, Scheduler
- `src/grpc/` — server, client, handlers
- `src/discovery/` — TailscaleDiscovery, ApprovalWorkflow
- `src/security/` — AuthManager, SecretsManager
- `src/memory/` — SharedMemoryDB, replication (core)
- `src/mcp/tools.ts`, `src/mcp/memory-tools.ts`, `src/mcp/skill-tools.ts`, `src/mcp/messaging-tools.ts` — existing factories, called by plugins

## Error Handling & Isolation

- Plugin `init()` throws → logged, skipped, node starts without it
- Plugin `start()` throws → logged, skipped, tools not registered
- Plugin runtime errors → caught at MCP tool level, error returned to caller
- No inter-plugin dependencies in v1 (each must be enabled independently)

## What This Enables

1. **Sentinel Plugin** — `src/plugins/sentinel/` wrapping Go service client. Tools: `sentinel_alerts`, `sentinel_devices`. Enabled on forge only.
2. **Takeover/Giveback** — `src/plugins/takeover/` listening to `node:offline` events, re-queuing tasks.
3. **Per-node profiles** — htnas02 skips MCP tools, laptops skip k8s, gaming PCs enable gaming-detection.
4. **Skills + Messaging wired in** — currently orphaned code with tests but no MCP registration. Plugin architecture connects them.
5. **Future integrations** — new plugin = directory + registry entry + YAML toggle.
