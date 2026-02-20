// src/messaging/__tests__/gateway.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagingGateway } from '../gateway.js';
import { EventEmitter } from 'events';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

function createMockAdapter(name: string): ChannelAdapter {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRaft(): EventEmitter & { isLeader: () => boolean } {
  const emitter = new EventEmitter() as EventEmitter & { isLeader: () => boolean };
  emitter.isLeader = vi.fn().mockReturnValue(false);
  return emitter;
}

describe('MessagingGateway', () => {
  let gateway: MessagingGateway;
  let discord: ChannelAdapter;
  let telegram: ChannelAdapter;
  let raft: ReturnType<typeof createMockRaft>;

  beforeEach(() => {
    discord = createMockAdapter('discord');
    telegram = createMockAdapter('telegram');
    raft = createMockRaft();

    gateway = new MessagingGateway({
      adapters: [discord, telegram],
      raft,
      agentName: 'Cipher',
      onMessage: vi.fn(),
    });
  });

  it('should start adapters when becoming leader', async () => {
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(true);
    raft.emit('stateChange', 'leader', 1);
    await new Promise(r => setTimeout(r, 50));

    expect(discord.connect).toHaveBeenCalled();
    expect(telegram.connect).toHaveBeenCalled();
  });

  it('should stop adapters when losing leadership', async () => {
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (discord.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (telegram.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    raft.emit('stateChange', 'leader', 1);
    await new Promise(r => setTimeout(r, 50));

    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(false);
    raft.emit('stateChange', 'follower', 2);
    await new Promise(r => setTimeout(r, 50));

    expect(discord.disconnect).toHaveBeenCalled();
    expect(telegram.disconnect).toHaveBeenCalled();
  });

  it('should not start adapters when not leader', () => {
    raft.emit('stateChange', 'follower', 1);
    expect(discord.connect).not.toHaveBeenCalled();
  });

  it('should report gateway status', () => {
    const status = gateway.getStatus();
    expect(status.agentName).toBe('Cipher');
    expect(status.isActive).toBe(false);
    expect(status.channels).toHaveLength(2);
  });

  it('should connect on stateChange to leader and disconnect on demotion to follower', async () => {
    // Step 1: non-leader node — nothing connected yet
    expect(discord.connect).not.toHaveBeenCalled();
    expect(telegram.connect).not.toHaveBeenCalled();

    // Step 2: become leader via stateChange
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(true);
    raft.emit('stateChange', 'leader', 1);
    await new Promise(r => setTimeout(r, 50));

    expect(discord.connect).toHaveBeenCalledTimes(1);
    expect(telegram.connect).toHaveBeenCalledTimes(1);

    // Step 3: mark adapters as connected so deactivate will disconnect them
    (discord.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (telegram.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Step 4: demote to follower via stateChange
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(false);
    raft.emit('stateChange', 'follower', 2);
    await new Promise(r => setTimeout(r, 50));

    expect(discord.disconnect).toHaveBeenCalledTimes(1);
    expect(telegram.disconnect).toHaveBeenCalledTimes(1);
  });
});
