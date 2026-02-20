import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ContentBlock } from './types.js';

function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
}

export interface OllamaProviderConfig {
  baseUrl?: string;
  model?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.defaultModel = config.model ?? 'llama3';
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.defaultModel,
        messages: messages.map(m => ({ role: m.role, content: contentToString(m.content) })),
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      message: { role: string; content: string };
      model: string;
      eval_count?: number;
      prompt_eval_count?: number;
    };

    return {
      content: data.message.content,
      model: data.model,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.defaultModel,
        messages: messages.map(m => ({ role: m.role, content: contentToString(m.content) })),
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
      for (const line of lines) {
        const data = JSON.parse(line) as { message?: { content: string }; done: boolean };
        if (data.message?.content) {
          yield { content: data.message.content, done: data.done };
        }
        if (data.done) {
          yield { content: '', done: true };
          return;
        }
      }
    }
  }

  async models(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as { models: Array<{ name: string }> };
    return data.models.map(m => m.name);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
