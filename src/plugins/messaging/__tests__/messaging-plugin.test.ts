// src/plugins/messaging/__tests__/messaging-plugin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { PluginContext, ToolHandler } from '../../types.js';
import type { ChannelMessage } from '../../../messaging/types.js';
import type { LLMProvider, StreamChunk } from '../../../providers/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before import of the module under test
// ---------------------------------------------------------------------------

// Mock TelegramAdapter
vi.mock('../../../messaging/channels/telegram.js', () => {
  return {
    TelegramAdapter: vi.fn().mockImplementation(() => ({
      name: 'telegram',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(false),
      onMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock MessagingGateway
vi.mock('../../../messaging/gateway.js', () => {
  return {
    MessagingGateway: vi.fn().mockImplementation(() => ({
      activate: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ agentName: 'Cipher', isActive: false, channels: [] }),
    })),
  };
});

// Mock ConversationHandler
vi.mock('../../../messaging/conversation.js', () => {
  return {
    ConversationHandler: vi.fn().mockImplementation(() => ({
      handleMessage: vi.fn().mockResolvedValue('test reply'),
    })),
  };
});

// Mock createMessagingTools
vi.mock('../../../mcp/messaging-tools.js', () => {
  const mockTools = new Map<string, ToolHandler>([
    ['messaging_send', {
      description: 'Send a message',
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn().mockResolvedValue({ messageId: 'test' }),
    }],
  ]);
  return {
    createMessagingTools: vi.fn().mockReturnValue({
      tools: mockTools,
      inbox: { someMethod: vi.fn() },
    }),
  };
});

// Now import the module under test and the mocked modules
import { MessagingPlugin } from '../index.js';
import { TelegramAdapter } from '../../../messaging/channels/telegram.js';
import { MessagingGateway } from '../../../messaging/gateway.js';
import { ConversationHandler } from '../../../messaging/conversation.js';
import { createMessagingTools } from '../../../mcp/messaging-tools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRaft(): EventEmitter & { isLeader: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as EventEmitter & { isLeader: ReturnType<typeof vi.fn> };
  emitter.isLeader = vi.fn().mockReturnValue(false);
  return emitter;
}

function createMockProvider(): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'mock response',
      model: 'mock-1',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      yield { content: '', done: true };
    },
    models: async () => ['mock-1'],
    isAvailable: async () => true,
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('winston').Logger;
}

function createPluginContext(overrides?: Partial<PluginContext>): PluginContext {
  return {
    raft: createMockRaft() as any,
    membership: {} as any,
    stateManager: {} as any,
    clientPool: {} as any,
    sharedMemoryDb: {} as any,
    memoryReplicator: {} as any,
    logger: createMockLogger(),
    nodeId: 'test-node',
    sessionId: 'test-session',
    config: {},
    events: new EventEmitter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessagingPlugin', () => {
  let plugin: MessagingPlugin;
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new MessagingPlugin();
    savedEnv = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.TELEGRAM_BOT_TOKEN = savedEnv;
    } else {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------
  describe('init()', () => {
    it('should create inbox tools on init', async () => {
      const ctx = createPluginContext();
      await plugin.init(ctx);

      expect(createMessagingTools).toHaveBeenCalledWith({ inboxPath: '~/.cortex/inbox' });
      const tools = plugin.getTools();
      expect(tools.size).toBeGreaterThan(0);
      expect(tools.has('messaging_send')).toBe(true);
    });

    it('should use custom inbox path from config', async () => {
      const ctx = createPluginContext({ config: { inboxPath: '/custom/inbox' } });
      await plugin.init(ctx);

      expect(createMessagingTools).toHaveBeenCalledWith({ inboxPath: '/custom/inbox' });
    });

    it('should store the context for later use', async () => {
      const ctx = createPluginContext();
      await plugin.init(ctx);

      // Verify by calling start() which uses ctx — it shouldn't throw
      await plugin.start();
    });
  });

  // -------------------------------------------------------------------------
  // start() — no provider
  // -------------------------------------------------------------------------
  describe('start() without provider', () => {
    it('should do nothing when no provider is available', async () => {
      const ctx = createPluginContext({ provider: undefined });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).not.toHaveBeenCalled();
      expect(MessagingGateway).not.toHaveBeenCalled();
      expect(ConversationHandler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // start() — no telegram config
  // -------------------------------------------------------------------------
  describe('start() without telegram config', () => {
    it('should do nothing when channels.telegram is not configured', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {},
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).not.toHaveBeenCalled();
      expect(MessagingGateway).not.toHaveBeenCalled();
    });

    it('should do nothing when telegram is not enabled', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: false, token: 'some-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).not.toHaveBeenCalled();
    });

    it('should do nothing when telegram is enabled but no token (and no env var)', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // start() — valid config
  // -------------------------------------------------------------------------
  describe('start() with valid config', () => {
    it('should create adapter, handler, and gateway', async () => {
      const raft = createMockRaft();
      const ctx = createPluginContext({
        raft: raft as any,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
          agent: 'TestBot',
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).toHaveBeenCalledWith({ token: 'test-token' });
      expect(ConversationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'TestBot',
        }),
      );
      expect(MessagingGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'TestBot',
        }),
      );
    });

    it('should use default agent name "Cipher" when not configured', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(ConversationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'Cipher' }),
      );
      expect(MessagingGateway).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: 'Cipher' }),
      );
    });

    it('should pass getTools() result to ConversationHandler', async () => {
      const allTools = new Map<string, ToolHandler>([
        ['tool_a', {
          description: 'Tool A',
          inputSchema: { type: 'object' as const, properties: {} },
          handler: vi.fn(),
        }],
      ]);
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
        getTools: () => allTools,
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(ConversationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ tools: allTools }),
      );
    });

    it('should use empty map when getTools is not available', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
        getTools: undefined,
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(ConversationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ tools: new Map() }),
      );
    });

    it('should activate gateway immediately when already leader', async () => {
      const raft = createMockRaft();
      raft.isLeader.mockReturnValue(true);

      const ctx = createPluginContext({
        raft: raft as any,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      // gateway.activate() must be called so the internal active flag is set correctly
      const gatewayInstance = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(gatewayInstance.activate).toHaveBeenCalled();
    });

    it('should NOT connect adapter when not leader', async () => {
      const raft = createMockRaft();
      raft.isLeader.mockReturnValue(false);

      const ctx = createPluginContext({
        raft: raft as any,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(adapterInstance.connect).not.toHaveBeenCalled();
    });

    it('should log info about gateway configuration', async () => {
      const logger = createMockLogger();
      const ctx = createPluginContext({
        logger,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
          agent: 'Cipher',
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(logger.info).toHaveBeenCalledWith('Messaging gateway configured', {
        adapter: 'telegram',
        agent: 'Cipher',
      });
    });
  });

  // -------------------------------------------------------------------------
  // TELEGRAM_BOT_TOKEN env var fallback
  // -------------------------------------------------------------------------
  describe('TELEGRAM_BOT_TOKEN env var fallback', () => {
    it('should use env var when config token is empty', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token-123';

      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).toHaveBeenCalledWith({ token: 'env-token-123' });
    });

    it('should prefer config token over env var', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'env-token';

      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'config-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).toHaveBeenCalledWith({ token: 'config-token' });
    });

    it('should do nothing when neither config token nor env var exists', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;

      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: '' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      expect(TelegramAdapter).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('should stop gateway and clean up all references', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gatewayInstance = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await plugin.stop();

      expect(gatewayInstance.stop).toHaveBeenCalled();
    });

    it('should handle stop() when gateway was never created', async () => {
      const ctx = createPluginContext({ provider: undefined });
      await plugin.init(ctx);
      await plugin.start();

      // Should not throw
      await plugin.stop();
    });

    it('should handle stop() called multiple times', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      await plugin.stop();
      await plugin.stop(); // Second stop should not throw
    });
  });

  // -------------------------------------------------------------------------
  // onMessage callback
  // -------------------------------------------------------------------------
  describe('onMessage callback', () => {
    it('should call conversation handler and send reply', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      // Extract the onMessage callback that was passed to MessagingGateway
      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      // Get the mock instances
      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      const testMessage: ChannelMessage = {
        channelType: 'telegram',
        channelId: 'chat-123',
        userId: 'user-1',
        username: 'alice',
        content: 'hello',
        timestamp: new Date().toISOString(),
      };

      await onMessage(testMessage);

      expect(handlerInstance.handleMessage).toHaveBeenCalledWith(testMessage);
      expect(adapterInstance.sendMessage).toHaveBeenCalledWith('chat-123', 'test reply');
    });

    it('should send error message when conversation handler throws', async () => {
      const logger = createMockLogger();
      const ctx = createPluginContext({
        logger,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      handlerInstance.handleMessage.mockRejectedValueOnce(new Error('LLM failure'));

      const testMessage: ChannelMessage = {
        channelType: 'telegram',
        channelId: 'chat-123',
        userId: 'user-1',
        username: 'alice',
        content: 'hello',
        timestamp: new Date().toISOString(),
      };

      await onMessage(testMessage);

      expect(logger.error).toHaveBeenCalledWith('Conversation error', expect.any(Object));
      expect(adapterInstance.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        'Sorry, I encountered an error processing your message.',
      );
    });

    it('should not throw when error message send also fails', async () => {
      const logger = createMockLogger();
      const ctx = createPluginContext({
        logger,
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      handlerInstance.handleMessage.mockRejectedValueOnce(new Error('LLM failure'));
      adapterInstance.sendMessage.mockRejectedValueOnce(new Error('Send failed too'));

      const testMessage: ChannelMessage = {
        channelType: 'telegram',
        channelId: 'chat-123',
        userId: 'user-1',
        username: 'alice',
        content: 'hello',
        timestamp: new Date().toISOString(),
      };

      // Should not throw even though both handler and error message send fail
      await onMessage(testMessage);
    });
  });

  // -------------------------------------------------------------------------
  // Message reply splitting for long responses
  // -------------------------------------------------------------------------
  describe('sendReply (message splitting)', () => {
    it('should send short messages as-is', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      handlerInstance.handleMessage.mockResolvedValueOnce('Short reply');

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await onMessage({
        channelType: 'telegram',
        channelId: 'chat-1',
        userId: 'u1',
        username: 'alice',
        content: 'hi',
        timestamp: new Date().toISOString(),
      });

      expect(adapterInstance.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapterInstance.sendMessage).toHaveBeenCalledWith('chat-1', 'Short reply');
    });

    it('should split messages longer than 4096 characters on paragraph boundaries', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      // Create a long message with paragraph breaks
      const paragraph1 = 'A'.repeat(3000);
      const paragraph2 = 'B'.repeat(3000);
      const longMessage = paragraph1 + '\n\n' + paragraph2;
      handlerInstance.handleMessage.mockResolvedValueOnce(longMessage);

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await onMessage({
        channelType: 'telegram',
        channelId: 'chat-1',
        userId: 'u1',
        username: 'alice',
        content: 'tell me everything',
        timestamp: new Date().toISOString(),
      });

      // Should be split into 2 chunks
      expect(adapterInstance.sendMessage).toHaveBeenCalledTimes(2);
      // First chunk should be the first paragraph
      expect(adapterInstance.sendMessage.mock.calls[0][1]).toBe(paragraph1);
      // Second chunk should be the second paragraph
      expect(adapterInstance.sendMessage.mock.calls[1][1]).toBe(paragraph2);
    });

    it('should split on line boundaries when no paragraph break is available', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      // Create a long message with only line breaks (no paragraph breaks)
      const line1 = 'C'.repeat(3000);
      const line2 = 'D'.repeat(3000);
      const longMessage = line1 + '\n' + line2;
      handlerInstance.handleMessage.mockResolvedValueOnce(longMessage);

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await onMessage({
        channelType: 'telegram',
        channelId: 'chat-1',
        userId: 'u1',
        username: 'alice',
        content: 'go',
        timestamp: new Date().toISOString(),
      });

      expect(adapterInstance.sendMessage).toHaveBeenCalledTimes(2);
      expect(adapterInstance.sendMessage.mock.calls[0][1]).toBe(line1);
      expect(adapterInstance.sendMessage.mock.calls[1][1]).toBe(line2);
    });

    it('should hard-split when no line break is available', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      // Create a long message with no line breaks at all
      const longMessage = 'E'.repeat(5000);
      handlerInstance.handleMessage.mockResolvedValueOnce(longMessage);

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await onMessage({
        channelType: 'telegram',
        channelId: 'chat-1',
        userId: 'u1',
        username: 'alice',
        content: 'go',
        timestamp: new Date().toISOString(),
      });

      expect(adapterInstance.sendMessage).toHaveBeenCalledTimes(2);
      expect(adapterInstance.sendMessage.mock.calls[0][1]).toBe('E'.repeat(4096));
      expect(adapterInstance.sendMessage.mock.calls[1][1]).toBe('E'.repeat(904));
    });

    it('should send exactly at 4096 characters without splitting', async () => {
      const ctx = createPluginContext({
        provider: createMockProvider(),
        config: {
          channels: { telegram: { enabled: true, token: 'test-token' } },
        },
      });
      await plugin.init(ctx);
      await plugin.start();

      const gwCall = (MessagingGateway as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const onMessage = gwCall.onMessage;

      const handlerInstance = (ConversationHandler as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
      const exactMessage = 'F'.repeat(4096);
      handlerInstance.handleMessage.mockResolvedValueOnce(exactMessage);

      const adapterInstance = (TelegramAdapter as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

      await onMessage({
        channelType: 'telegram',
        channelId: 'chat-1',
        userId: 'u1',
        username: 'alice',
        content: 'go',
        timestamp: new Date().toISOString(),
      });

      expect(adapterInstance.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapterInstance.sendMessage.mock.calls[0][1]).toBe(exactMessage);
    });
  });

  // -------------------------------------------------------------------------
  // getTools() — still returns inbox tools
  // -------------------------------------------------------------------------
  describe('getTools()', () => {
    it('should return inbox tools regardless of gateway state', async () => {
      const ctx = createPluginContext({ provider: undefined });
      await plugin.init(ctx);

      const tools = plugin.getTools();
      expect(tools.has('messaging_send')).toBe(true);
    });
  });
});
