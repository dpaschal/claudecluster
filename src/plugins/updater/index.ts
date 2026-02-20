import { Plugin, PluginContext, ToolHandler } from '../types.js';

export class UpdaterPlugin implements Plugin {
  name = 'updater';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.tools.set('initiate_rolling_update', {
      description: 'Initiate a rolling update across all cluster nodes. Leader coordinates: transfers dist/ to each follower, restarts them one at a time, then restarts self last. Sends Telegram + wall notifications before each restart (Tap on Shoulder). Requires leader role.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'If true, run preflight checks only without executing the update' },
        },
      },
      handler: async (args) => {
        // Lazy import — RollingUpdater only loaded when tool is actually called
        const { RollingUpdater } = await import('../../cluster/updater.js');
        const distDir = (ctx.config.distDir as string) ?? `${process.cwd()}/dist`;

        // Build notifyFn: sends Telegram via messaging_notify tool
        const notifyFn = async (_nodeId: string, message: string) => {
          const tools = ctx.getTools?.();
          const notifyTool = tools?.get('messaging_notify');
          if (notifyTool) {
            await notifyTool.handler({ message });
          }
        };

        // Build squelchFn: squelch/unsquelch health alerts
        const squelchFn = async (minutes: number) => {
          const tools = ctx.getTools?.();
          const squelchTool = tools?.get('squelch_alerts');
          if (squelchTool) {
            await squelchTool.handler({ minutes });
          }
        };

        const updater = new RollingUpdater({
          membership: ctx.membership,
          raft: ctx.raft,
          clientPool: ctx.clientPool,
          logger: ctx.logger,
          selfNodeId: ctx.nodeId,
          distDir,
          notifyFn,
          squelchFn,
        });

        // Preflight first
        const preflight = await updater.preflight();
        if (!preflight.ok) {
          return { success: false, phase: 'preflight', reason: preflight.reason, nodes: preflight.nodes };
        }

        if (args.dryRun) {
          return {
            success: true,
            phase: 'preflight',
            dryRun: true,
            nodes: preflight.nodes,
            followers: preflight.followers,
            quorumSize: preflight.quorumSize,
            votingCount: preflight.votingCount,
          };
        }

        // Execute rolling update
        const result = await updater.execute();
        return result;
      },
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): Map<string, ToolHandler> { return this.tools; }
}
