import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

export interface DiscordAdapterConfig {
  token: string;
  guildId?: string;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';
  private client: Client;
  private token: string;
  private guildId: string | undefined;
  private connected = false;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildId = config.guildId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, (message: any) => {
      if (message.author?.bot) return;

      const channelMessage: ChannelMessage = {
        channelType: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        timestamp: message.createdAt.toISOString(),
        replyTo: message.reference?.messageId ?? undefined,
      };

      for (const handler of this.messageHandlers) {
        handler(channelMessage);
      }
    });
  }

  async connect(): Promise<void> {
    await this.client.login(this.token);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    const options: any = { content };
    if (replyTo) {
      options.reply = { messageReference: replyTo };
    }

    await (channel as any).send(options);
  }
}
