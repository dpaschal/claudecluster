import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { ResourceMonitor, ResourceSnapshot } from './resource-monitor.js';
import { TaskExecutor } from './task-executor.js';

export interface HealthStatus {
  healthy: boolean;
  message: string;
  lastCheck: number;
  uptime: number;
  resources: ResourceSnapshot | null;
  activeTasks: string[];
  issues: HealthIssue[];
}

export interface HealthIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  timestamp: number;
}

export interface HealthReporterConfig {
  logger: Logger;
  resourceMonitor: ResourceMonitor;
  taskExecutor: TaskExecutor;
  checkIntervalMs?: number;
  memoryThresholdPercent?: number;
  cpuThresholdPercent?: number;
  diskThresholdPercent?: number;
}

export class HealthReporter extends EventEmitter {
  private config: HealthReporterConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private startTime: number;
  private lastStatus: HealthStatus | null = null;
  private issues: HealthIssue[] = [];

  private memoryThreshold: number;
  private cpuThreshold: number;
  private diskThreshold: number;

  constructor(config: HealthReporterConfig) {
    super();
    this.config = config;
    this.startTime = Date.now();

    this.memoryThreshold = config.memoryThresholdPercent ?? 90;
    this.cpuThreshold = config.cpuThresholdPercent ?? 95;
    this.diskThreshold = config.diskThresholdPercent ?? 95;
  }

  start(): void {
    const interval = this.config.checkIntervalMs ?? 10000;
    this.check();
    this.checkInterval = setInterval(() => this.check(), interval);
    this.config.logger.info('Health reporter started', { checkIntervalMs: interval });
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.config.logger.info('Health reporter stopped');
    }
  }

  getStatus(): HealthStatus {
    if (!this.lastStatus) {
      this.check();
    }
    return this.lastStatus!;
  }

  isHealthy(): boolean {
    return this.lastStatus?.healthy ?? false;
  }

  private check(): void {
    const now = Date.now();
    const resources = this.config.resourceMonitor.getLastSnapshot();
    const activeTasks = this.config.taskExecutor.getRunningTaskIds();

    // Clear old issues
    this.issues = [];

    // Check resource thresholds
    if (resources) {
      if (resources.memory.usedPercent > this.memoryThreshold) {
        this.addIssue({
          severity: resources.memory.usedPercent > 95 ? 'error' : 'warning',
          code: 'HIGH_MEMORY',
          message: `Memory usage at ${resources.memory.usedPercent.toFixed(1)}%`,
          timestamp: now,
        });
      }

      if (resources.cpu.usagePercent > this.cpuThreshold) {
        this.addIssue({
          severity: resources.cpu.usagePercent > 98 ? 'error' : 'warning',
          code: 'HIGH_CPU',
          message: `CPU usage at ${resources.cpu.usagePercent.toFixed(1)}%`,
          timestamp: now,
        });
      }

      if (resources.disk.usedPercent > this.diskThreshold) {
        this.addIssue({
          severity: resources.disk.usedPercent > 98 ? 'error' : 'warning',
          code: 'HIGH_DISK',
          message: `Disk usage at ${resources.disk.usedPercent.toFixed(1)}%`,
          timestamp: now,
        });
      }

      // Check for gaming activity
      if (resources.gamingDetected) {
        this.addIssue({
          severity: 'warning',
          code: 'GAMING_ACTIVE',
          message: 'Gaming activity detected, GPU tasks may be migrated',
          timestamp: now,
        });
      }
    } else {
      this.addIssue({
        severity: 'warning',
        code: 'NO_RESOURCES',
        message: 'Resource monitoring data unavailable',
        timestamp: now,
      });
    }

    // Determine overall health
    const hasErrors = this.issues.some(i => i.severity === 'error');
    const healthy = !hasErrors && resources !== null;

    let message = 'Node healthy';
    if (hasErrors) {
      message = `Node unhealthy: ${this.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ')}`;
    } else if (this.issues.length > 0) {
      message = `Node operational with warnings: ${this.issues.map(i => i.code).join(', ')}`;
    }

    this.lastStatus = {
      healthy,
      message,
      lastCheck: now,
      uptime: now - this.startTime,
      resources,
      activeTasks,
      issues: [...this.issues],
    };

    this.emit('status', this.lastStatus);

    if (!healthy) {
      this.config.logger.warn('Node health check failed', {
        message,
        issues: this.issues,
      });
    }
  }

  private addIssue(issue: HealthIssue): void {
    this.issues.push(issue);
    this.emit('issue', issue);
  }

  // Convert to proto-compatible format
  toProtoHealth(): {
    healthy: boolean;
    message: string;
    resources: ReturnType<ResourceMonitor['toProtoResources']>;
  } {
    const status = this.getStatus();
    return {
      healthy: status.healthy,
      message: status.message,
      resources: this.config.resourceMonitor.toProtoResources(),
    };
  }
}
