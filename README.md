# Cortex

<p align="center">
  <b>Distributed AI Mesh for Personal Infrastructure</b>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://img.shields.io/badge/❤️🎆_THANKS!_🎆❤️-Support_This_Project-ff0000?style=for-the-badge" alt="Thanks!" height="40">
  </a>
</p>

<p align="center">
  <i>Every donation keeps the code flowing — these tools are built with your support.</i>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" height="50">
  </a>
</p>

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Cortex connects your machines into a single intelligent platform — P2P compute mesh with a pluggable architecture, Raft-replicated shared memory, distributed task execution, and Claude Code integration via MCP.

## Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                            C O R T E X                               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  forge   │  │ gauntlet │  │ terminus │  │ htnas02  │            │
│  │ (server) │  │(desktop) │  │  (work)  │  │  (NAS)   │            │
│  │  Leader  │  │ Follower │  │ Eligible │  │  Worker  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │              │              │              │                  │
│       └──────────────┴──────┬───────┴──────────────┘                 │
│                             │                                        │
│                   ┌─────────┴─────────┐                              │
│                   │  Tailscale Mesh   │                              │
│                   └─────────┬─────────┘                              │
│                             │                                        │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │                      FIXED CORE                               │   │
│  │  Raft · gRPC · Membership · Shared Memory · Scheduler        │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                        │
│  ┌──────────────────────────┴───────────────────────────────────┐   │
│  │                      PLUGINS (per-node YAML)                  │   │
│  ├──────────┬──────────┬──────────┬──────────┬────────────────┤   │
│  │ Memory   │ Cluster  │ Resource │ Updater  │  Kubernetes    │   │
│  │ 12 tools │ 12 tools │ Monitor  │ ISSU     │  4 tools       │   │
│  ├──────────┼──────────┼──────────┴──────────┴────────────────┤   │
│  │ Skills   │Messaging │    MCP Server (24 tools, 3 resources) │   │
│  │ SKILL.md │ Discord  │    Collects tools from all plugins    │   │
│  │ Hot-load │ Telegram │    Stdio mode for Claude Code         │   │
│  └──────────┴──────────┴──────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Features

### Fixed Core (always-on)
- **Raft Consensus** — Fault-tolerant leader election across nodes
- **gRPC Transport** — Protocol Buffers for fast inter-node communication
- **Tailscale Discovery** — Automatic mesh discovery and node approval
- **Shared Memory (csm)** — Raft-replicated SQLite database across all nodes
- **Membership** — Heartbeats, failure detection, resource-aware placement
- **Security** — mTLS, auth/authz, secrets management

### Plugin Architecture
Cortex uses a **core + plugins** architecture. Each node enables/disables plugins via per-node YAML config. Plugins are isolated — a failed plugin never affects core services.

| Plugin | Tools | Description |
|--------|-------|-------------|
| **memory** | 12 | Timeline threads, thoughts, context — Raft-replicated across nodes |
| **cluster-tools** | 12 | Cluster status, task submission, distributed execution, context sharing |
| **resource-monitor** | — | CPU/GPU/memory/disk monitoring, health reporting (no MCP tools) |
| **updater** | 1 | ISSU rolling updates with backup and rollback |
| **kubernetes** | 4 | K8s/K3s cluster discovery, job submission, scaling |
| **skills** | 2 | SKILL.md loader with YAML-frontmatter and hot-reload |
| **messaging** | 5 | Discord (@DALEK), Telegram bots, inbox with read/unread tracking |

### Claude Code Integration (MCP)
- **24 MCP Tools** — Collected from all enabled plugins into a single MCP server
- **3 Resources** — `cluster://state`, `cluster://nodes`, `cluster://sessions`
- **Stdio Mode** — Run as MCP server for seamless Claude Code integration

## Quick Start

### Prerequisites

- Node.js 20+
- Tailscale connected to your network
- (Optional) Docker for container tasks
- (Optional) kubectl for Kubernetes integration

### Installation

```bash
git clone https://github.com/dpaschal/cortex.git
cd cortex
npm install
npm run build
```

### Running a Node

```bash
# Start as a new cluster (first node becomes leader)
npm start

# Join existing cluster
npm start -- --seed 100.94.211.117:50051
```

### Systemd Service

```bash
sudo cp cortex.service /etc/systemd/system/
sudo systemctl enable --now cortex
```

### Claude Code Integration

Add to your MCP configuration (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/index.js", "--mcp", "--seed", "100.94.211.117:50051"]
    }
  }
}
```

The `--mcp` flag runs Cortex as an MCP server. Logs go to `/tmp/cortex-mcp.log` to keep stdio clean.

## MCP Tools (24)

### Memory Plugin (12 tools)
| Tool | Description |
|------|-------------|
| `memory_query` | Query the shared memory database |
| `memory_write` | Write to shared memory (Raft-replicated) |
| `memory_schema` | View database schema |
| `memory_stats` | Database statistics |
| `memory_log_thought` | Log a thought to a timeline thread |
| `memory_whereami` | Active threads, positions, pinned context |
| `memory_handoff` | End-of-session structured summary |
| `memory_set_context` | Set/update pinned context entries |
| `memory_get_context` | Retrieve context by category or key |
| `memory_search` | Full-text search across thoughts |
| `memory_network_lookup` | Query network device inventory |
| `memory_list_threads` | List timeline threads with details |

### Cluster Tools Plugin (12 tools)
| Tool | Description |
|------|-------------|
| `cluster_status` | Get cluster state, leader, and node resources |
| `list_nodes` | List all nodes with status and capabilities |
| `submit_task` | Submit a distributed task to the scheduler |
| `get_task_result` | Retrieve task execution results |
| `run_distributed` | Run a command across multiple nodes |
| `dispatch_subagents` | Launch parallel Claude agents on cluster |
| `scale_cluster` | Scale cluster membership |
| `list_sessions` | List active MCP sessions |
| `relay_to_session` | Relay a message to another session |
| `publish_context` | Publish context to the cluster |
| `query_context` | Query shared context |
| `initiate_rolling_update` | Zero-downtime ISSU upgrade across nodes |

### Kubernetes Plugin (4 tools)
| Tool | Description |
|------|-------------|
| `k8s_list_clusters` | List discovered Kubernetes clusters |
| `k8s_submit_job` | Submit a job to K8s/K3s |
| `k8s_get_resources` | Get cluster resource usage |
| `k8s_scale` | Scale a deployment |

### Skills Plugin (2 tools)
| Tool | Description |
|------|-------------|
| `list_skills` | List all loaded SKILL.md skills |
| `get_skill` | Get a skill's full content by name |

### Messaging Plugin (5 tools)
| Tool | Description |
|------|-------------|
| `messaging_send` | Send a message to the inbox |
| `messaging_check` | Check for new unread messages |
| `messaging_list` | List all conversations |
| `messaging_get` | Retrieve a specific message |
| `messaging_gateway_status` | Check bot connection status |

## Configuration

Edit `config/default.yaml` for cluster settings. For local overrides with secrets (bot tokens, API keys), create `config/local.yaml` (gitignored).

### Plugin Configuration

Each node enables/disables plugins independently. Restart required to apply changes.

```yaml
plugins:
  memory:
    enabled: true          # Raft-replicated shared memory (12 tools)
  cluster-tools:
    enabled: true          # Cluster operations (12 tools)
  resource-monitor:
    enabled: true          # CPU/GPU/memory/disk monitoring
  updater:
    enabled: true          # ISSU rolling updates
  kubernetes:
    enabled: false         # K8s adapter (enable on nodes with kubeconfig)
  skills:
    enabled: false         # SKILL.md loader
    directories:
      - ~/.cortex/skills
  messaging:
    enabled: false         # Discord/Telegram bots (enable on leader)
    agent: "Cipher"
    inboxPath: ~/.cortex/inbox
```

### Messaging & Provider Config

```yaml
messaging:
  channels:
    discord:
      enabled: true
      token: ${DISCORD_BOT_TOKEN}
      guildId: "your-guild-id"
    telegram:
      enabled: true
      token: ${TELEGRAM_BOT_TOKEN}

providers:
  primary: anthropic
  fallback:
    - ollama
  anthropic:
    model: claude-sonnet-4-6
    apiKey: ${ANTHROPIC_API_KEY}
```

## Architecture

```
src/
  index.ts        # Core startup: security → tailscale → gRPC → raft → plugins → MCP
  cluster/        # Raft consensus, membership, state, scheduling, ISSU
  grpc/           # gRPC server, client pool, service handlers
  discovery/      # Tailscale mesh discovery, node approval
  memory/         # SharedMemoryDB (csm), Raft replication, memory MCP tools
  agent/          # Resource monitor, task executor, health reporter
  messaging/      # Gateway, Discord/Telegram adapters, inbox
  providers/      # LLM routing — Anthropic, OpenAI, Ollama
  skills/         # SKILL.md loader with frontmatter parsing
  mcp/            # MCP server, tool/resource factories
  kubernetes/     # K8s/K3s job submission
  security/       # mTLS, auth, secrets
  plugins/        # Plugin architecture
    types.ts      # Plugin, PluginContext, ToolHandler interfaces
    loader.ts     # PluginLoader — init, start, stop lifecycle
    registry.ts   # Built-in plugin registry (7 plugins)
    memory/       # Memory plugin — wraps csm tools
    cluster-tools/ # Cluster tools plugin — cluster ops + resources
    kubernetes/   # Kubernetes plugin — K8s adapter + tools
    resource-monitor/ # Resource monitor plugin — CPU/GPU/disk events
    updater/      # Updater plugin — ISSU rolling updates
    skills/       # Skills plugin — SKILL.md hot-reload
    messaging/    # Messaging plugin — Discord/Telegram bots
```

### Plugin Lifecycle

```
1. Core init   → Security, Tailscale, gRPC, Raft, SharedMemoryDB
2. Plugin init → pluginLoader.loadAll() — validate config, set up state
3. Cluster join → joinOrCreateCluster()
4. Plugin start → pluginLoader.startAll() — background work, event listeners
5. MCP start   → Merged tools/resources from all plugins
6. Shutdown    → pluginLoader.stopAll() (reverse order) → core stop
```

## Contributing

Issues and PRs welcome.

- **Bugs**: [Create a bug report](https://github.com/dpaschal/cortex/issues/new?labels=bug)
- **Features**: [Request a feature](https://github.com/dpaschal/cortex/issues/new?labels=enhancement)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [superpowers](https://github.com/anthropics/superpowers) workflow
- Uses [MCP SDK](https://github.com/anthropics/mcp) for Claude Code integration
- Messaging gateway absorbed from [OpenClaw](https://openclaw.ai) (MIT licensed)
