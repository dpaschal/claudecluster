# Claude Cluster

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://img.shields.io/badge/❤️🎆_THANKS!_🎆❤️-Buy_Me_A_Coffee-ff0000?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white" alt="Buy Me A Coffee" height="50">
  </a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/dpaschal">
    <img src="https://img.buymeacoffee.com/button-api/?text=Support this project&emoji=❤️&slug=dpaschal&button_colour=FF0000&font_colour=ffffff&font_family=Cookie&outline_colour=ffffff&coffee_colour=FFDD00" alt="Support Drew">
  </a>
</p>

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A **peer-to-peer compute mesh** enabling distributed Claude sessions across machines with shared context, coordinated task execution, and GPU sharing.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Claude Cluster                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │    rog2      │  │   terminus   │  │    forge     │  │   htnas02   │  │
│  │  (laptop)    │  │   (laptop)   │  │   (server)   │  │    (NAS)    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
│         │                 │                 │                 │         │
│         └─────────────────┴────────┬────────┴─────────────────┘         │
│                                    │                                     │
│                        ┌───────────┴───────────┐                        │
│                        │   Tailscale Network   │                        │
│                        └───────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Intra-Claude Communication** - Claude sessions aware of each other across machines
- **Shared Context/Memory** - Sessions share learnings, coordinate work, avoid duplication
- **Distributed Task Execution** - Delegate builds, tests, compute across nodes
- **GPU Sharing with Gaming Priority** - Auto-detect games, yield GPU automatically
- **Kubernetes Hybrid Mesh** - K8s pods as first-class cluster members
- **Raft Consensus** - Fault-tolerant leader election
- **MCP Integration** - 15+ tools for Claude Code

## Quick Start

### Prerequisites

- Node.js 20+
- Tailscale connected to your network
- (Optional) Docker for container tasks
- (Optional) kubectl for Kubernetes integration

### Installation

```bash
git clone https://github.com/dpaschal/claudecluster.git
cd claudecluster
npm install
npm run build
```

### Running a Node

```bash
# Start as a new cluster (first node)
npm start

# Join existing cluster
npm start -- --seeds 100.104.78.123:50051
```

### Claude Code Integration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "claudecluster": {
      "command": "node",
      "args": ["/path/to/claudecluster/dist/index.js", "--mcp"]
    }
  }
}
```

## Documentation

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [MCP Tools Reference](docs/mcp-tools.md)
- [Kubernetes Integration](docs/kubernetes.md)
- [Security](docs/security.md)

## MCP Tools

| Tool | Description |
|------|-------------|
| `cluster_status` | Get cluster state and resources |
| `list_nodes` | List all nodes with status |
| `submit_task` | Submit distributed task |
| `run_distributed` | Run command on multiple nodes |
| `dispatch_subagents` | Launch parallel Claude agents |
| `k8s_list_clusters` | List Kubernetes clusters |
| `k8s_submit_job` | Submit K8s job |
| `run_benchmark` | Measure compute performance (FLOPS) |

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features and phases.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Reporting Issues

- **Bugs**: [Create a bug report](https://github.com/dpaschal/claudecluster/issues/new?labels=bug)
- **Features**: [Request a feature](https://github.com/dpaschal/claudecluster/issues/new?labels=enhancement)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [superpowers](https://github.com/obra/superpowers) workflow
- Uses [MCP SDK](https://github.com/anthropics/mcp) for Claude Code integration
