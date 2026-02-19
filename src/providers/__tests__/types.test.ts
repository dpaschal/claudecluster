import { describe, it, expect } from 'vitest';
import type { LLMProvider, ChatMessage, ChatResponse, StreamChunk } from '../types.js';

describe('LLMProvider types', () => {
  it('should define a valid provider interface shape', () => {
    const mockProvider: LLMProvider = {
      name: 'test',
      chat: async () => ({ content: 'hello', model: 'test', usage: { inputTokens: 0, outputTokens: 0 } }),
      stream: async function* () { yield { content: 'chunk', done: false }; },
      models: async () => ['model-1'],
      isAvailable: async () => true,
    };

    expect(mockProvider.name).toBe('test');
    expect(typeof mockProvider.chat).toBe('function');
    expect(typeof mockProvider.stream).toBe('function');
    expect(typeof mockProvider.models).toBe('function');
    expect(typeof mockProvider.isAvailable).toBe('function');
  });

  it('should enforce ChatMessage shape', () => {
    const msg: ChatMessage = { role: 'user', content: 'hello' };
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
  });

  it('should enforce ChatResponse shape', () => {
    const resp: ChatResponse = {
      content: 'response text',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 10, outputTokens: 20 },
      stopReason: 'end_turn',
    };
    expect(resp.content).toBe('response text');
    expect(resp.usage.inputTokens).toBe(10);
  });
});
