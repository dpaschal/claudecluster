import { Plugin, PluginContext, ToolHandler } from '../types.js';
import { TelegramAdapter } from '../../messaging/channels/telegram.js';
import { MessagingGateway } from '../../messaging/gateway.js';
import { ConversationHandler } from '../../messaging/conversation.js';

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

    this.telegramAdapter = new TelegramAdapter({ token: telegramToken });

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

    const allTools = this.ctx.getTools?.() ?? new Map();
    this.conversationHandler = new ConversationHandler({
      provider: this.ctx.provider,
      tools: allTools,
      logger: this.ctx.logger,
      agentName,
    });

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
   * Send a reply, splitting long messages to respect Telegram's 4096-char limit.
   */
  private async sendReply(adapter: TelegramAdapter, channelId: string, text: string): Promise<void> {
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await adapter.sendMessage(channelId, text);
      return;
    }
    // Split on paragraph boundaries, falling back to line boundaries, then hard split
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n\n', MAX_LENGTH);
      if (splitAt < MAX_LENGTH / 2) splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (splitAt < MAX_LENGTH / 2) splitAt = MAX_LENGTH;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    for (const chunk of chunks) {
      await adapter.sendMessage(channelId, chunk);
    }
  }
}
