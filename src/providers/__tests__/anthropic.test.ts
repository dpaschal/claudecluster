import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Hello from Claude' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        }),
        stream: vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk1' } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk2' } };
          },
        }),
      },
    })),
  };
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({ apiKey: 'test-key' });
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('anthropic');
  });

  it('should call the Anthropic API for chat', async () => {
    const response = await provider.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from Claude');
    expect(response.model).toBe('claude-sonnet-4-6');
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
  });

  it('should report availability when API key is set', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('should report unavailable when no API key', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const noKeyProvider = new AnthropicProvider({});
      expect(await noKeyProvider.isAvailable()).toBe(false);
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it('should return supported models', async () => {
    const models = await provider.models();
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('claude-opus-4-6');
    expect(models).toContain('claude-haiku-4-5');
  });
});
