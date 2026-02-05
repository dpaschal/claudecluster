# Claude Cluster Roadmap

## Current Status: Phase 1 Complete

### Phase 1: Foundation ✅
- [x] Project structure and TypeScript setup
- [x] Protocol Buffers definitions
- [x] gRPC communication layer
- [x] Basic node agent with resource monitoring
- [x] Compute benchmarking (FLOPS metrics)

### Phase 2: Cluster Core 🚧
- [ ] Raft consensus implementation testing
- [ ] Membership management (join/leave)
- [ ] User approval workflow for new nodes
- [ ] Heartbeat and failure detection
- [ ] Tailscale discovery integration testing

### Phase 3: Task System
- [ ] Resource-aware task scheduler testing
- [ ] Shell command executor with sandbox
- [ ] Container workload support (Docker/Podman)
- [ ] Claude subagent task type
- [ ] Result aggregation and streaming

### Phase 4: Kubernetes Integration
- [ ] Auto-discover kubeconfig contexts
- [ ] GKE adapter testing
- [ ] K8s/K3s adapter testing
- [ ] K8s Job submission
- [ ] K8s resource monitoring

### Phase 5: MCP Server
- [ ] MCP server end-to-end testing
- [ ] Cluster resources implementation
- [ ] Claude Code integration guide
- [ ] Tool documentation

### Phase 6: PXE Boot (Future)
- [ ] Boot image with agent
- [ ] netboot.xyz integration
- [ ] Auto-join flow
- [ ] Ephemeral node lifecycle

### Phase 7: Security & Polish
- [ ] mTLS for gRPC
- [ ] Authorization policies
- [ ] Secrets management testing
- [ ] Comprehensive documentation
- [ ] Multi-node integration tests

---

## Feature Requests

Track feature requests via [GitHub Issues](https://github.com/dpaschal/claudecluster/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement).

## Milestones

### v0.1.0 - Foundation
- Basic cluster formation
- Single-node task execution
- Resource monitoring

### v0.2.0 - Multi-Node
- Raft consensus working
- Cross-node task distribution
- Node discovery via Tailscale

### v0.3.0 - MCP Integration
- Full MCP tool suite
- Claude Code integration
- Shared context store

### v0.4.0 - Kubernetes
- K8s cluster discovery
- Job submission
- Hybrid mesh (bare metal + K8s)

### v1.0.0 - Production Ready
- mTLS security
- Comprehensive tests
- Full documentation
- Gaming detection stable
