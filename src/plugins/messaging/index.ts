import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { TelegramAdapter, type TelegramCommand } from '../../messaging/channels/telegram.js';
import { MessagingGateway } from '../../messaging/gateway.js';
import { ConversationHandler } from '../../messaging/conversation.js';
import { ConversationStore } from '../../messaging/persistence.js';
import { markdownToTelegramHtml, smartChunk } from '../../messaging/format.js';

const COMMANDS: TelegramCommand[] = [
  { command: 'status', description: 'Cluster status overview' },
  { command: 'health', description: 'Detailed health report' },
  { command: 'nodes', description: 'List cluster nodes' },
  { command: 'tasks', description: 'List running tasks' },
  { command: 'sessions', description: 'Active Claude sessions' },
  { command: 'new', description: 'Clear conversation history' },
  { command: 'help', description: 'List available commands' },
  { command: 'squelch', description: 'Suppress alerts (minutes)' },
  { command: 'whereami', description: 'Show timeline state' },
];

const COMMAND_TOOL_MAP: Record<string, string> = {
  status: 'cluster_status',
  health: 'cluster_health',
  nodes: 'list_nodes',
  tasks: 'list_tasks',
  sessions: 'list_sessions',
  squelch: 'squelch_alerts',
  whereami: 'memory_whereami',
};

/**
 * Format a tool result object into human-readable markdown for Telegram.
 * Output is markdown — sendReply converts to Telegram HTML and escapes entities.
 */
function formatToolResult(toolName: string, result: unknown): string {
  if (result === null || result === undefined) return 'No data returned.';
  if (typeof result === 'string') return result;

  const obj = result as Record<string, unknown>;

  // Handle error responses
  if (obj.error) return `Error: ${obj.error}`;

  try {
    const lines: string[] = [];

    const formatValue = (key: string, value: unknown, indent = ''): void => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${indent}**${key}:** (none)`);
          return;
        }
        lines.push(`${indent}**${key}:**`);
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            const itemObj = item as Record<string, unknown>;
            const parts = Object.entries(itemObj)
              .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            lines.push(`${indent}  - ${parts}`);
          } else {
            lines.push(`${indent}  - ${item}`);
          }
        }
      } else if (typeof value === 'object') {
        lines.push(`${indent}**${key}:**`);
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          formatValue(k, v, indent + '  ');
        }
      } else {
        lines.push(`${indent}**${key}:** ${value}`);
      }
    };

    for (const [key, value] of Object.entries(obj)) {
      formatValue(key, value);
    }

    return lines.length > 0 ? lines.join('\n') : 'OK';
  } catch {
    // Fallback: return JSON with code formatting
    return '```json\n' + JSON.stringify(result, null, 2).slice(0, 3800) + '\n```';
  }
}

export class MessagingPlugin implements Plugin {
  name = 'messaging';
  version = '1.0.0';

  private ctx: PluginContext | null = null;
  private tools: Map<string, ToolHandler> = new Map();
  private inbox: any = null;
  private gateway: MessagingGateway | null = null;
  private conversationHandler: ConversationHandler | null = null;
  private telegramAdapter: TelegramAdapter | null = null;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    // Still create inbox tools (these work on all nodes)
    const { createMessagingTools } = await import('../../mcp/messaging-tools.js');
    const inboxPath = (ctx.config.inboxPath as string) ?? '~/.cortex/inbox';
    const result = createMessagingTools({ inboxPath });
    this.tools = result.tools;
    this.inbox = result.inbox;
  }

  async start(): Promise<void> {
    const config = this.ctx?.config ?? {};
    const channels = config.channels as Record<string, any> | undefined;
    const telegramConfig = channels?.telegram;
    const telegramToken = telegramConfig?.token || process.env.TELEGRAM_BOT_TOKEN;

    if (!telegramConfig?.enabled || !telegramToken) return;

    this.telegramAdapter = new TelegramAdapter({
      token: telegramToken,
      commands: COMMANDS,
      logger: this.ctx?.logger,
    });

    // Expose messaging_notify tool — lets other plugins (e.g. cluster-health) send alerts
    const alertChatId = (config.alertChatId as string) || process.env.CORTEX_ALERT_CHAT_ID || '';
    if (alertChatId) {
      const adapter = this.telegramAdapter;
      this.tools.set('messaging_notify', {
        description: 'Send a notification message to the configured Telegram alert channel',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: { type: 'string', description: 'The notification text to send' },
          },
          required: ['message'],
        },
        handler: async (args) => {
          if (!adapter.isConnected()) return { sent: false, reason: 'Telegram not connected' };
          await adapter.sendMessage(alertChatId, args.message as string);
          return { sent: true };
        },
      });
    }

    if (!this.ctx?.provider) return; // No LLM provider, can't converse

    const agentName = (config.agent as string) ?? 'Cipher';

    // Create CSM-backed conversation store if shared memory is available
    const store = this.ctx.sharedMemoryDb
      ? new ConversationStore(this.ctx.sharedMemoryDb.getDatabase())
      : undefined;

    const allTools = this.ctx.getTools?.() ?? new Map();
    this.conversationHandler = new ConversationHandler({
      provider: this.ctx.provider,
      tools: allTools,
      logger: this.ctx.logger,
      agentName,
      store,
      onTyping: (chatId) => this.telegramAdapter?.sendTyping(chatId),
    });

    // Register slash command handlers
    this.registerCommands(this.telegramAdapter, allTools);

    this.gateway = new MessagingGateway({
      adapters: [this.telegramAdapter],
      raft: this.ctx.raft,
      agentName,
      onMessage: async (message) => {
        try {
          const reply = await this.conversationHandler!.handleMessage(message);
          await this.sendReply(this.telegramAdapter!, message.channelId, reply);
        } catch (error) {
          this.ctx!.logger.error('Conversation error', { error });
          await this.telegramAdapter!.sendMessage(
            message.channelId,
            'Sorry, I encountered an error processing your message.',
          ).catch(() => {}); // Don't fail on error message send failure
        }
      },
    });

    // If already leader, activate immediately via gateway to keep active flag in sync
    // (MessagingGateway only listens for stateChange events, not initial state)
    if (this.ctx.raft.isLeader()) {
      await this.gateway.activate();
    }

    this.ctx.logger.info('Messaging gateway configured', {
      adapter: 'telegram',
      agent: agentName,
      commands: COMMANDS.map(c => c.command),
      persistence: store ? 'csm' : 'memory',
    });
  }

  async stop(): Promise<void> {
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    this.conversationHandler = null;
    this.telegramAdapter = null;
    this.inbox = null;
    this.tools = new Map();
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  /**
   * Register slash command handlers on the Telegram adapter.
   */
  private registerCommands(adapter: TelegramAdapter, allTools: Map<string, ToolHandler>): void {
    // Tool-backed commands
    for (const [command, toolName] of Object.entries(COMMAND_TOOL_MAP)) {
      if (command === 'squelch') continue; // squelch needs special arg handling

      adapter.onCommand(command, async (chatId, _args) => {
        const tool = allTools.get(toolName);
        if (!tool) {
          await this.sendReply(adapter, chatId, `Tool \`${toolName}\` not available.`);
          return;
        }
        try {
          await adapter.sendTyping(chatId);
          const result = await tool.handler({});
          const formatted = formatToolResult(toolName, result);
          await this.sendReply(adapter, chatId, formatted);
        } catch (error) {
          this.ctx?.logger.error(`Command /${command} failed`, { error });
          await this.sendReply(adapter, chatId, `/${command} failed. Please try again later.`);
        }
      });
    }

    // /squelch — needs to parse minutes arg
    adapter.onCommand('squelch', async (chatId, args) => {
      const tool = allTools.get('squelch_alerts');
      if (!tool) {
        await this.sendReply(adapter, chatId, 'Squelch tool not available.');
        return;
      }
      try {
        const minutes = args ? parseInt(args, 10) : 30;
        if (isNaN(minutes) || minutes < 0) {
          await this.sendReply(adapter, chatId, 'Usage: /squelch [minutes] (default: 30, 0 to clear)');
          return;
        }
        await adapter.sendTyping(chatId);
        const result = await tool.handler({ minutes });
        if (minutes === 0) {
          await this.sendReply(adapter, chatId, 'Alerts re-enabled.');
        } else {
          await this.sendReply(adapter, chatId, `Alerts squelched for ${minutes} minutes.`);
        }
        this.ctx?.logger.info('Squelch command executed', { minutes, result });
      } catch (error) {
        this.ctx?.logger.error('Command /squelch failed', { error });
        await this.sendReply(adapter, chatId, '/squelch failed. Please try again later.');
      }
    });

    // /new — clear conversation history
    adapter.onCommand('new', async (chatId) => {
      this.conversationHandler?.clearHistory(chatId);
      await this.sendReply(adapter, chatId, 'Conversation cleared.');
    });

    // /help — list all commands
    adapter.onCommand('help', async (chatId) => {
      const lines = COMMANDS.map(c => `/${c.command} — ${c.description}`);
      const helpText = `**Available commands:**\n\n${lines.join('\n')}`;
      await this.sendReply(adapter, chatId, helpText);
    });
  }

  /**
   * Send a reply, converting markdown to Telegram HTML and splitting long messages.
   */
  private async sendReply(adapter: TelegramAdapter, channelId: string, text: string): Promise<void> {
    const html = markdownToTelegramHtml(text);
    const chunks = smartChunk(html, 4096);
    for (const chunk of chunks) {
      await adapter.sendMessage(channelId, chunk);
    }
  }
}
