import TelegramBot from 'node-telegram-bot-api';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

export interface TelegramAdapterConfig {
  token: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: TelegramBot;
  private connected = false;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];

  constructor(config: TelegramAdapterConfig) {
    this.bot = new TelegramBot(config.token, { polling: false });

    this.bot.on('message', (msg: TelegramBot.Message) => {
      if (!msg.text) return;

      const channelMessage: ChannelMessage = {
        channelType: 'telegram',
        channelId: String(msg.chat.id),
        userId: String(msg.from?.id ?? 'unknown'),
        username: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
        content: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
        replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      };

      for (const handler of this.messageHandlers) {
        handler(channelMessage);
      }
    });
  }

  async connect(): Promise<void> {
    this.bot.startPolling();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.bot.stopPolling();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
    const options: TelegramBot.SendMessageOptions = {};
    if (replyTo) {
      options.reply_to_message_id = parseInt(replyTo, 10);
    }
    await this.bot.sendMessage(channelId, content, options);
  }
}
