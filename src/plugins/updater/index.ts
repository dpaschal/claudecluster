import { Plugin, PluginContext, ToolHandler } from '../types.js';

export class UpdaterPlugin implements Plugin {
  name = 'updater';
  version = '1.0.0';

  private tools: Map<string, ToolHandler> = new Map();

  async init(ctx: PluginContext): Promise<void> {
    this.tools.set('initiate_rolling_update', {
      description: 'Initiate a rolling update across all cluster nodes. Leader coordinates: transfers dist/ to each follower, restarts them one at a time, then restarts self last. Requires leader role.',
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

        const updater = new RollingUpdater({
          membership: ctx.membership,
          raft: ctx.raft,
          clientPool: ctx.clientPool,
          logger: ctx.logger,
          selfNodeId: ctx.nodeId,
          distDir,
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
