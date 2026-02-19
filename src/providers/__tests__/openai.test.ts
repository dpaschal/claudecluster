import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../openai.js';

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'Hello from GPT', role: 'assistant' }, finish_reason: 'stop' }],
            model: 'gpt-4o',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        },
      },
      models: {
        list: vi.fn().mockResolvedValue({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
      },
    })),
  };
});

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider({ apiKey: 'test-key' });
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('openai');
  });

  it('should call the OpenAI API for chat', async () => {
    const response = await provider.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from GPT');
    expect(response.model).toBe('gpt-4o');
    expect(response.usage.inputTokens).toBe(10);
  });

  it('should report availability when API key is set', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('should report unavailable when no API key', async () => {
    const noKeyProvider = new OpenAIProvider({});
    expect(await noKeyProvider.isAvailable()).toBe(false);
  });
});
