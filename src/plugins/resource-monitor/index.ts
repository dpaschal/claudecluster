import { Plugin, PluginContext } from '../types.js';
import { ResourceMonitor } from '../../agent/resource-monitor.js';
import { TaskExecutor } from '../../agent/task-executor.js';
import { HealthReporter } from '../../agent/health-reporter.js';

export class ResourceMonitorPlugin implements Plugin {
  name = 'resource-monitor';
  version = '1.0.0';

  private resourceMonitor: ResourceMonitor | null = null;
  private taskExecutor: TaskExecutor | null = null;
  private healthReporter: HealthReporter | null = null;
  private ctx: PluginContext | null = null;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    this.resourceMonitor = new ResourceMonitor({
      logger: ctx.logger,
      pollIntervalMs: ctx.config.pollIntervalMs as number | undefined,
    });

    this.taskExecutor = new TaskExecutor({
      logger: ctx.logger,
    });

    this.healthReporter = new HealthReporter({
      logger: ctx.logger,
      resourceMonitor: this.resourceMonitor,
      taskExecutor: this.taskExecutor,
    });
  }

  async start(): Promise<void> {
    if (!this.resourceMonitor || !this.healthReporter || !this.ctx) return;

    // Forward resource snapshots to the plugin event bus
    this.resourceMonitor.on('snapshot', (snapshot) => {
      this.ctx!.events.emit('resource:snapshot', snapshot);
    });

    // Forward health status events to the plugin event bus
    this.healthReporter.on('status', (status) => {
      this.ctx!.events.emit('health:status', status);
    });

    await this.resourceMonitor.start();
    this.healthReporter.start();
  }

  async stop(): Promise<void> {
    if (this.healthReporter) {
      this.healthReporter.stop();
      this.healthReporter = null;
    }
    if (this.resourceMonitor) {
      this.resourceMonitor.stop();
      this.resourceMonitor = null;
    }
    if (this.taskExecutor) {
      this.taskExecutor = null;
    }
  }
}
