import si from 'systeminformation';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from 'winston';

const execAsync = promisify(exec);

export interface ResourceSnapshot {
  timestamp: number;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpus: GpuInfo[];
  disk: DiskInfo;
  gamingDetected: boolean;
}

export interface CpuInfo {
  cores: number;
  usagePercent: number;
  loadAverage: number[];
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  utilizationPercent: number;
  inUseForGaming: boolean;
}

export interface DiskInfo {
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface ResourceMonitorConfig {
  logger: Logger;
  pollIntervalMs?: number;
  gamingProcesses?: string[];
  gamingGpuThreshold?: number;
  gamingCooldownMs?: number;
}

const DEFAULT_GAMING_PROCESSES = [
  'steam', 'steamwebhelper',
  'wine', 'wine64', 'wineserver',
  'proton', 'pressure-vessel',
  'gamescope', 'gamemode',
  'lutris', 'heroic',
  'mangohud',
  // Common game engines
  'UE4', 'UnrealEngine', 'Unity',
];

export class ResourceMonitor extends EventEmitter {
  private config: ResourceMonitorConfig;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastSnapshot: ResourceSnapshot | null = null;
  private gamingStartedAt: number | null = null;
  private gamingEndedAt: number | null = null;
  private gamingProcesses: Set<string>;
  private gpuThreshold: number;
  private cooldownMs: number;

  constructor(config: ResourceMonitorConfig) {
    super();
    this.config = config;
    this.gamingProcesses = new Set([
      ...(config.gamingProcesses ?? DEFAULT_GAMING_PROCESSES).map(p => p.toLowerCase()),
    ]);
    this.gpuThreshold = config.gamingGpuThreshold ?? 70; // GPU usage above 70% suggests gaming
    this.cooldownMs = config.gamingCooldownMs ?? 30000; // 30s cooldown after gaming stops
  }

  async start(): Promise<void> {
    const interval = this.config.pollIntervalMs ?? 5000;
    await this.poll();
    this.pollInterval = setInterval(() => this.poll(), interval);
    this.config.logger.info('Resource monitor started', { pollIntervalMs: interval });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.config.logger.info('Resource monitor stopped');
    }
  }

  getLastSnapshot(): ResourceSnapshot | null {
    return this.lastSnapshot;
  }

  isGamingActive(): boolean {
    if (!this.lastSnapshot) return false;
    return this.lastSnapshot.gamingDetected;
  }

  isInGamingCooldown(): boolean {
    if (!this.gamingEndedAt) return false;
    return Date.now() - this.gamingEndedAt < this.cooldownMs;
  }

  private async poll(): Promise<void> {
    try {
      const [cpu, memory, gpus, disk, processes] = await Promise.all([
        this.getCpuInfo(),
        this.getMemoryInfo(),
        this.getGpuInfo(),
        this.getDiskInfo(),
        this.getRunningProcesses(),
      ]);

      const gamingByProcess = this.detectGamingByProcesses(processes);
      const gamingByGpu = this.detectGamingByGpu(gpus);
      const gamingDetected = gamingByProcess || gamingByGpu;

      // Update gaming state for cooldown tracking
      const wasGaming = this.lastSnapshot?.gamingDetected ?? false;
      if (gamingDetected && !wasGaming) {
        this.gamingStartedAt = Date.now();
        this.gamingEndedAt = null;
        this.emit('gaming_started');
        this.config.logger.info('Gaming activity detected');
      } else if (!gamingDetected && wasGaming) {
        this.gamingEndedAt = Date.now();
        this.emit('gaming_ended');
        this.config.logger.info('Gaming activity ended, cooldown started');
      }

      // Mark GPUs as in-use for gaming
      const gpusWithGaming = gpus.map(gpu => ({
        ...gpu,
        inUseForGaming: gamingDetected && gpu.utilizationPercent > this.gpuThreshold,
      }));

      this.lastSnapshot = {
        timestamp: Date.now(),
        cpu,
        memory,
        gpus: gpusWithGaming,
        disk,
        gamingDetected,
      };

      this.emit('snapshot', this.lastSnapshot);
    } catch (error) {
      this.config.logger.error('Failed to poll resources', { error });
      this.emit('error', error);
    }
  }

  private async getCpuInfo(): Promise<CpuInfo> {
    const [cpuData, loadData] = await Promise.all([
      si.cpu(),
      si.currentLoad(),
    ]);

    return {
      cores: cpuData.cores,
      usagePercent: loadData.currentLoad,
      loadAverage: loadData.avgLoad ? [loadData.avgLoad, 0, 0] : [0, 0, 0],
    };
  }

  private async getMemoryInfo(): Promise<MemoryInfo> {
    const memData = await si.mem();

    return {
      totalBytes: memData.total,
      availableBytes: memData.available,
      usedPercent: (memData.used / memData.total) * 100,
    };
  }

  private async getGpuInfo(): Promise<GpuInfo[]> {
    // Try nvidia-smi first for NVIDIA GPUs
    try {
      const nvidiaGpus = await this.getNvidiaGpuInfo();
      if (nvidiaGpus.length > 0) {
        return nvidiaGpus;
      }
    } catch {
      // nvidia-smi not available or failed
    }

    // Fall back to systeminformation
    try {
      const graphics = await si.graphics();
      return graphics.controllers.map((gpu, index) => ({
        index,
        name: gpu.model || 'Unknown GPU',
        memoryTotalBytes: (gpu.vram ?? 0) * 1024 * 1024,
        memoryAvailableBytes: (gpu.vram ?? 0) * 1024 * 1024, // Can't determine available
        utilizationPercent: gpu.utilizationGpu ?? 0,
        inUseForGaming: false,
      }));
    } catch {
      return [];
    }
  }

  private async getNvidiaGpuInfo(): Promise<GpuInfo[]> {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=index,name,memory.total,memory.free,utilization.gpu --format=csv,noheader,nounits'
    );

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [index, name, memTotal, memFree, utilization] = line.split(', ').map(s => s.trim());
      const memTotalBytes = parseInt(memTotal) * 1024 * 1024;
      const memFreeBytes = parseInt(memFree) * 1024 * 1024;

      return {
        index: parseInt(index),
        name,
        memoryTotalBytes: memTotalBytes,
        memoryAvailableBytes: memFreeBytes,
        utilizationPercent: parseInt(utilization),
        inUseForGaming: false,
      };
    });
  }

  private async getDiskInfo(): Promise<DiskInfo> {
    const fsSize = await si.fsSize();
    // Get the root filesystem or first significant mount
    const rootFs = fsSize.find(fs => fs.mount === '/') ?? fsSize[0];

    if (!rootFs) {
      return { totalBytes: 0, availableBytes: 0, usedPercent: 0 };
    }

    return {
      totalBytes: rootFs.size,
      availableBytes: rootFs.available,
      usedPercent: rootFs.use,
    };
  }

  private async getRunningProcesses(): Promise<string[]> {
    try {
      const processes = await si.processes();
      return processes.list.map(p => p.name.toLowerCase());
    } catch {
      return [];
    }
  }

  private detectGamingByProcesses(processes: string[]): boolean {
    return processes.some(proc =>
      this.gamingProcesses.has(proc) ||
      [...this.gamingProcesses].some(gaming => proc.includes(gaming))
    );
  }

  private detectGamingByGpu(gpus: GpuInfo[]): boolean {
    // If any GPU has high utilization and we can't attribute it to known workloads,
    // assume it might be gaming. This is a heuristic.
    return gpus.some(gpu => gpu.utilizationPercent > this.gpuThreshold);
  }

  // Convert to proto-compatible format
  toProtoResources(): {
    cpu_cores: number;
    memory_bytes: string;
    memory_available_bytes: string;
    gpus: Array<{
      name: string;
      memory_bytes: string;
      memory_available_bytes: string;
      utilization_percent: number;
      in_use_for_gaming: boolean;
    }>;
    disk_bytes: string;
    disk_available_bytes: string;
    cpu_usage_percent: number;
    gaming_detected: boolean;
  } | null {
    if (!this.lastSnapshot) return null;

    const { cpu, memory, gpus, disk, gamingDetected } = this.lastSnapshot;

    return {
      cpu_cores: cpu.cores,
      memory_bytes: memory.totalBytes.toString(),
      memory_available_bytes: memory.availableBytes.toString(),
      gpus: gpus.map(gpu => ({
        name: gpu.name,
        memory_bytes: gpu.memoryTotalBytes.toString(),
        memory_available_bytes: gpu.memoryAvailableBytes.toString(),
        utilization_percent: gpu.utilizationPercent,
        in_use_for_gaming: gpu.inUseForGaming,
      })),
      disk_bytes: disk.totalBytes.toString(),
      disk_available_bytes: disk.availableBytes.toString(),
      cpu_usage_percent: cpu.usagePercent,
      gaming_detected: gamingDetected,
    };
  }
}
