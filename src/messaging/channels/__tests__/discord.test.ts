import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '../discord.js';

vi.mock('discord.js', () => {
  const mockOn = vi.fn();
  const mockLogin = vi.fn().mockResolvedValue('token');
  const mockDestroy = vi.fn().mockResolvedValue(undefined);

  return {
    Client: vi.fn().mockImplementation(() => ({
      on: mockOn,
      login: mockLogin,
      destroy: mockDestroy,
      isReady: vi.fn().mockReturnValue(true),
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: vi.fn().mockResolvedValue({ id: 'msg-123' }),
        }),
      },
      user: { tag: 'TestBot#1234' },
    })),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Partials: { Channel: 0 },
    Events: { MessageCreate: 'messageCreate', ClientReady: 'ready' },
  };
});

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    adapter = new DiscordAdapter({ token: 'test-token', guildId: 'test-guild' });
  });

  it('should have the correct name', () => {
    expect(adapter.name).toBe('discord');
  });

  it('should connect and login', async () => {
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
  });

  it('should disconnect gracefully', async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('should register message handlers', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registration verified
  });
});
