import OpenAI from 'openai';
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './types.js';

export interface OpenAIProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private apiKey: string | undefined;
  private defaultModel: string;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.defaultModel = config.model ?? 'gpt-4o';
    if (this.apiKey) {
      this.client = new OpenAI({ apiKey: this.apiKey, baseURL: config.baseUrl });
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.client) throw new Error('OpenAI API key not configured');

    const response = await this.client.chat.completions.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content ?? '',
      model: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason: choice?.finish_reason ?? undefined,
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    if (!this.client) throw new Error('OpenAI API key not configured');

    const stream = await this.client.chat.completions.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { content: delta, done: false };
      }
    }
    yield { content: '', done: true };
  }

  async models(): Promise<string[]> {
    if (!this.client) return [];
    const list = await this.client.models.list();
    return list.data.map(m => m.id);
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
