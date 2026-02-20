export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  stopReason?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk>;
  models(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}
