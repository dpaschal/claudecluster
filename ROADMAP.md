# Cortex Roadmap

## Current Status: v0.5.0 — Plugin Architecture

### Phase 1: Foundation
- [x] Project structure and TypeScript setup
- [x] Protocol Buffers definitions
- [x] gRPC communication layer
- [x] Basic node agent with resource monitoring
- [x] Compute benchmarking (FLOPS metrics)

### Phase 2: Cluster Core
- [x] Raft consensus implementation
- [x] Membership management (join/leave)
- [x] User approval workflow for new nodes
- [x] Heartbeat and failure detection
- [x] Tailscale discovery integration

### Phase 3: Task System
- [x] Resource-aware task scheduler
- [x] Shell command executor with sandbox
- [x] Claude subagent task type
- [x] Result aggregation
- [ ] Container workload support (Docker/Podman)

### Phase 4: Kubernetes Integration
- [x] Auto-discover kubeconfig contexts
- [x] K8s/K3s adapter
- [x] K8s Job submission
- [x] K8s resource monitoring
- [ ] GKE adapter testing

### Phase 5: MCP Server
- [x] MCP server with stdio mode
- [x] 24 MCP tools across 7 plugins
- [x] 3 cluster resources
- [x] Claude Code integration

### Phase 6: Shared Memory (csm)
- [x] Raft-replicated SQLite across all nodes
- [x] Timeline threads, thoughts, context
- [x] 12 memory MCP tools
- [x] Auto-generated whereami.md snapshot
- [x] Litestream backup to GCS

### Phase 7: Plugin Architecture
- [x] Plugin interface (init/start/stop/getTools/getResources)
- [x] Plugin loader with error isolation
- [x] Per-node YAML plugin configuration
- [x] 7 built-in plugins (memory, cluster-tools, kubernetes, resource-monitor, updater, skills, messaging)
- [x] Event bus for cross-plugin communication
- [x] 474 tests passing

### Phase 8: ISSU Rolling Updates
- [x] Cisco/Brocade-style rolling updates
- [x] Pre-flight checks and backup
- [x] Automatic rollback on failure
- [x] Zero-downtime upgrades

### Phase 9: Sleep/Wake Auto-Rejoin
- [x] systemd resume service
- [x] Automatic cluster rejoin after laptop suspend

---

## Upcoming

### Sentinel Plugin
- [ ] Predictive analytics (inspired by HPE InfoSight)
- [ ] Node health scoring and trend analysis
- [ ] Proactive alerting via event bus
- [ ] Depends on: Plugin Architecture (complete)

### Takeover/Giveback
- [ ] NetApp CDOT-style HA model
- [ ] Automatic task re-queuing on node failure
- [ ] Graceful takeover with resource migration
- [ ] Giveback with state synchronization

### PXE Boot
- [ ] Boot image with Cortex agent
- [ ] netboot.xyz integration
- [ ] Auto-join flow
- [ ] Ephemeral node lifecycle

### Security Hardening
- [ ] mTLS for all gRPC connections
- [ ] Authorization policies per plugin
- [ ] Secrets rotation

---

## Feature Requests

Track feature requests via [GitHub Issues](https://github.com/dpaschal/cortex/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement).

## Milestones

### v0.1.0 - Foundation
- Basic cluster formation, single-node task execution, resource monitoring

### v0.2.0 - Multi-Node
- Raft consensus, cross-node task distribution, Tailscale discovery

### v0.3.0 - MCP Integration
- Full MCP tool suite, Claude Code integration, shared context

### v0.4.0 - Shared Memory
- Raft-replicated SQLite, timeline tracking, 12 memory tools

### v0.5.0 - Plugin Architecture (current)
- Core + plugins separation, 7 built-in plugins, 24 tools, 474 tests

### v1.0.0 - Production Ready
- mTLS security, Sentinel analytics, Takeover/Giveback, comprehensive docs
