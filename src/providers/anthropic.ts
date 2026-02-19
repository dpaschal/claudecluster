import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './types.js';

export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private apiKey: string | undefined;
  private defaultModel: string;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.defaultModel = config.model ?? 'claude-sonnet-4-6';
    if (this.apiKey) {
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    if (!this.client) throw new Error('Anthropic API key not configured');

    const systemPrompt = options?.systemPrompt ?? messages.find(m => m.role === 'system')?.content;
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const sdkTools = options?.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const response = await this.client.messages.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      system: systemPrompt,
      messages: chatMessages,
      tools: sdkTools && sdkTools.length > 0 ? sdkTools : undefined,
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    const toolCalls = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, input: block.input as Record<string, unknown> }));

    return {
      content: textContent,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    if (!this.client) throw new Error('Anthropic API key not configured');

    const systemPrompt = options?.systemPrompt ?? messages.find(m => m.role === 'system')?.content;
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const stream = this.client.messages.stream({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      system: systemPrompt,
      messages: chatMessages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { content: event.delta.text, done: false };
      }
    }
    yield { content: '', done: true };
  }

  async models(): Promise<string[]> {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
