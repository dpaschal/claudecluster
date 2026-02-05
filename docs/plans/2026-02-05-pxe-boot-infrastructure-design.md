# PXE Boot Infrastructure Design

## Goal

Enable ephemeral compute nodes to PXE boot directly into the cluster, auto-join, execute tasks, and cleanly shut down.

## Architecture

```
                                   ┌─────────────────────┐
                                   │   netboot.xyz       │
                                   │   (External)        │
                                   └──────────┬──────────┘
                                              │ iPXE Chain
                                              ▼
┌─────────────────┐              ┌─────────────────────┐
│  PXE Client     │◄────────────►│  Boot Server        │
│  (Ephemeral)    │   HTTP/TFTP  │  (Cluster Node)     │
└────────┬────────┘              └──────────┬──────────┘
         │                                  │
         │ Boot & Auto-Join                 │
         ▼                                  │
┌─────────────────┐              ┌──────────▼──────────┐
│  Claudecluster  │◄────────────►│  Cluster Leader     │
│  Agent          │   gRPC       │                     │
└─────────────────┘              └─────────────────────┘
```

## Components

### 1. Boot Image Builder (`src/boot/image-builder.ts`)

Generates bootable images containing the claudecluster agent.

```typescript
interface BootImageConfig {
  outputDir: string;
  nodeRuntime: 'bundled' | 'system';
  seedNodes: string[];
  clusterTag: string;
  autoShutdown: boolean;
}

interface BootImage {
  kernel: string;      // vmlinuz path
  initrd: string;      // initramfs path
  squashfs: string;    // root filesystem
  cmdline: string;     // boot parameters
}

class BootImageBuilder {
  // Generate minimal Linux image with Node.js + agent
  async buildImage(config: BootImageConfig): Promise<BootImage>;

  // Generate cloud-init configuration
  generateCloudInit(config: BootImageConfig): string;

  // Package agent binary
  bundleAgent(): Promise<Buffer>;
}
```

**Boot Parameters:**
```
root=live:CDLABEL=CLAUDECLUSTER rd.live.image rd.live.overlay.overlayfs
claudecluster.seeds=100.0.0.1:50051,100.0.0.2:50051
claudecluster.tag=claudecluster
claudecluster.mode=ephemeral
claudecluster.auto_shutdown=true
```

### 2. Boot Server (`src/boot/server.ts`)

HTTP server for serving boot images and iPXE configuration.

```typescript
interface BootServerConfig {
  port: number;
  imageDir: string;
  clusterTag: string;
  seedNodes: string[];
}

class BootServer {
  // Start HTTP server
  start(): Promise<void>;

  // Stop server
  stop(): Promise<void>;

  // Generate dynamic iPXE script
  generateIPXE(clientIP: string): string;

  // Serve boot images
  // GET /ipxe - iPXE boot script
  // GET /kernel - Linux kernel
  // GET /initrd - Initial ramdisk
  // GET /rootfs - Root filesystem
}
```

**iPXE Script Template:**
```
#!ipxe
set boot-url http://${SERVER_IP}:${PORT}

kernel ${boot-url}/kernel
initrd ${boot-url}/initrd
imgargs kernel root=live:CDLABEL=CLAUDECLUSTER claudecluster.seeds=${SEEDS} claudecluster.tag=${TAG} claudecluster.mode=ephemeral
boot
```

### 3. netboot.xyz Integration (`src/boot/netboot-manager.ts`)

Manages custom menu entries for netboot.xyz.

```typescript
interface NetbootConfig {
  menuName: string;
  description: string;
  bootServerUrl: string;
}

class NetbootManager {
  // Generate menu entry for netboot.xyz
  generateMenuEntry(config: NetbootConfig): string;

  // Generate custom.ipxe file
  generateCustomIPXE(): string;
}
```

**Menu Entry:**
```
:claudecluster
set boot-url http://your-boot-server:8080
chain ${boot-url}/ipxe
```

### 4. Boot Agent (`src/boot/agent.ts`)

Runs on boot to auto-join the cluster.

```typescript
interface BootAgentConfig {
  seeds: string[];
  clusterTag: string;
  autoShutdown: boolean;
  shutdownOnIdle: number; // ms
}

class BootAgent {
  // Parse boot parameters from /proc/cmdline
  static parseBootParams(): BootAgentConfig;

  // Initialize and join cluster
  async start(): Promise<void>;

  // Monitor for idle and shutdown
  startIdleMonitor(): void;

  // Graceful shutdown
  async shutdown(): Promise<void>;
}
```

### 5. Ephemeral Lifecycle Manager (`src/cluster/ephemeral-manager.ts`)

Manages ephemeral node lifecycle including cleanup.

```typescript
interface EphemeralConfig {
  offlineTimeoutMs: number;  // Time before removing offline ephemeral
  cleanupIntervalMs: number; // How often to check for cleanup
}

class EphemeralManager {
  // Start cleanup monitor
  start(): void;

  // Stop cleanup monitor
  stop(): void;

  // Force cleanup of specific node
  cleanupNode(nodeId: string): Promise<void>;

  // Get ephemeral nodes
  getEphemeralNodes(): NodeInfo[];
}
```

## Configuration

Add to `config/default.yaml`:

```yaml
boot:
  enabled: false
  server:
    port: 8080
    host: "0.0.0.0"
  imageDir: ~/.claudecluster/boot
  autoGenerateImage: true

ephemeral:
  offlineTimeoutMs: 3600000      # 1 hour
  cleanupIntervalMs: 300000     # 5 minutes
  autoShutdownIdleMs: 1800000   # 30 minutes idle
```

## Implementation Phases

### Phase 6.1: Boot Server (Foundation)
1. Create BootServer class
2. Implement iPXE script generation
3. Add HTTP endpoints for boot files
4. Test with manual iPXE boot

### Phase 6.2: Image Builder
1. Create minimal Linux builder (Alpine-based)
2. Bundle Node.js runtime
3. Package claudecluster agent
4. Generate cloud-init config

### Phase 6.3: netboot.xyz Integration
1. Generate custom menu entries
2. Document netboot.xyz setup
3. Test chain loading

### Phase 6.4: Boot Agent
1. Parse /proc/cmdline for boot params
2. Auto-join cluster on boot
3. Implement idle shutdown
4. Handle graceful termination

### Phase 6.5: Lifecycle Management
1. Ephemeral node TTL
2. Automatic cleanup
3. Task reassignment on shutdown

## File Structure

```
src/
├── boot/
│   ├── server.ts           # HTTP boot server
│   ├── image-builder.ts    # Boot image generation
│   ├── netboot-manager.ts  # netboot.xyz integration
│   └── agent.ts            # Boot-time agent
├── cluster/
│   └── ephemeral-manager.ts # Ephemeral lifecycle
```

## Testing Strategy

1. **Unit Tests:** Mock HTTP server, test iPXE generation
2. **Integration Tests:** Test full boot sequence with QEMU/KVM
3. **Manual Tests:** Real PXE boot on test hardware

## Dependencies

```json
{
  "express": "^4.18.0",       // HTTP server
  "archiver": "^6.0.0",       // Image packaging
  "node-pty": "^1.0.0"        // Terminal emulation for testing
}
```

## Success Criteria

- Ephemeral node boots via PXE in < 60 seconds
- Auto-joins cluster without manual intervention
- Executes assigned tasks
- Shuts down gracefully when idle
- Cluster cleans up node state after shutdown
