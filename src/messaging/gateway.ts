// src/messaging/gateway.ts
import { EventEmitter } from 'events';
import type { ChannelAdapter, ChannelMessage } from './types.js';

export interface MessagingGatewayConfig {
  adapters: ChannelAdapter[];
  raft: EventEmitter & { isLeader(): boolean };
  agentName: string;
  onMessage: (message: ChannelMessage) => void;
}

export interface GatewayStatus {
  agentName: string;
  isActive: boolean;
  channels: Array<{ name: string; connected: boolean }>;
}

export class MessagingGateway {
  private adapters: ChannelAdapter[];
  private raft: EventEmitter & { isLeader(): boolean };
  private agentName: string;
  private onMessage: (message: ChannelMessage) => void;
  private active = false;

  constructor(config: MessagingGatewayConfig) {
    this.adapters = config.adapters;
    this.raft = config.raft;
    this.agentName = config.agentName;
    this.onMessage = config.onMessage;

    for (const adapter of this.adapters) {
      adapter.onMessage((message) => { this.onMessage(message); });
    }

    this.raft.on('stateChange', (state: string) => {
      if (state === 'leader') {
        this.activate().catch(() => {});
      } else if (this.active) {
        this.deactivate().catch(() => {});
      }
    });
  }

  private async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await Promise.allSettled(this.adapters.map(a => a.connect()));
  }

  private async deactivate(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await Promise.allSettled(this.adapters.filter(a => a.isConnected()).map(a => a.disconnect()));
  }

  getStatus(): GatewayStatus {
    return {
      agentName: this.agentName,
      isActive: this.active,
      channels: this.adapters.map(a => ({ name: a.name, connected: a.isConnected() })),
    };
  }

  async stop(): Promise<void> {
    await this.deactivate();
  }
}
