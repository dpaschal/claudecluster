import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../telegram.js';

vi.mock('node-telegram-bot-api', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      startPolling: vi.fn(),
      stopPolling: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
      isPolling: vi.fn().mockReturnValue(true),
    })),
  };
});

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter({ token: 'test-token' });
  });

  it('should have the correct name', () => {
    expect(adapter.name).toBe('telegram');
  });

  it('should connect and start polling', async () => {
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
  });

  it('should disconnect and stop polling', async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});
