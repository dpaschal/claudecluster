// src/messaging/conversation.ts
import type { Logger } from 'winston';
import type {
  LLMProvider,
  ChatMessage,
  ChatResponse,
  ContentBlock,
  ToolDefinition,
} from '../providers/types.js';
import type { ToolHandler } from '../plugins/types.js';
import type { ChannelMessage } from './types.js';

const MAX_TOOL_RESULT_LENGTH = 4000;
const DEFAULT_MAX_HISTORY = 20;
const DEFAULT_MAX_TOOL_ITERATIONS = 5;

export interface ConversationHandlerConfig {
  provider: LLMProvider;
  tools: Map<string, ToolHandler>;
  logger: Logger;
  agentName?: string;
  systemPrompt?: string;
  maxHistory?: number;
  maxToolIterations?: number;
  store?: {
    load(chatId: string): ChatMessage[];
    save(chatId: string, history: ChatMessage[]): void;
    clear(chatId: string): void;
  };
  onTyping?: (chatId: string) => void | Promise<void>;
}

export class ConversationHandler {
  private histories: Map<string, ChatMessage[]>;
  private provider: LLMProvider;
  private tools: Map<string, ToolHandler>;
  private logger: Logger;
  private systemPrompt: string;
  private maxHistory: number;
  private maxToolIterations: number;
  private store?: ConversationHandlerConfig['store'];
  private onTyping?: ConversationHandlerConfig['onTyping'];

  constructor(config: ConversationHandlerConfig) {
    this.provider = config.provider;
    this.tools = config.tools;
    this.logger = config.logger;
    this.maxHistory = config.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxToolIterations = config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.histories = new Map();
    this.store = config.store;
    this.onTyping = config.onTyping;

    const name = config.agentName ?? 'Cortex';
    this.systemPrompt = config.systemPrompt ??
      `You are ${name}, an AI assistant. You have access to tools for managing a compute cluster. Be concise and helpful. When using tools, explain what you're doing briefly.`;
  }

  async handleMessage(message: ChannelMessage): Promise<string> {
    const chatId = message.channelId;

    // Work on a local copy to avoid concurrent mutation of the stored array
    const history: ChatMessage[] = this.store
      ? [...this.store.load(chatId)]
      : [...this.getHistory(chatId)];

    // Append user message
    history.push({ role: 'user', content: message.content });

    // Convert tools map to ToolDefinition[]
    const toolDefs = this.buildToolDefinitions();

    this.logger.info('Handling message', {
      chatId,
      user: message.username,
      content: message.content.slice(0, 100),
      toolCount: toolDefs.length,
      historyLength: history.length,
    });

    // Call LLM with tool loop
    let response: ChatResponse;
    let iterations = 0;

    const chatOptions = {
      systemPrompt: this.systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
    };

    await this.onTyping?.(chatId);

    // Refresh typing indicator every 4 seconds while processing
    const typingInterval = this.onTyping
      ? setInterval(() => { this.onTyping!(chatId); }, 4000)
      : undefined;

    try {
    response = await this.provider.chat([...history], chatOptions);

    this.logger.info('LLM response', {
      chatId,
      contentLength: response.content?.length ?? 0,
      toolCalls: response.toolCalls?.map(tc => tc.name) ?? [],
      model: response.model,
    });

    while (response.toolCalls && response.toolCalls.length > 0 && iterations < this.maxToolIterations) {
      iterations++;
      this.logger.info(`Tool iteration ${iterations}`, {
        chatId,
        tools: response.toolCalls.map(tc => tc.name),
      });

      // Build assistant message with tool_use content blocks
      const assistantBlocks: ContentBlock[] = [];
      if (response.content) {
        assistantBlocks.push({ type: 'text', text: response.content });
      }
      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }
      history.push({ role: 'assistant', content: assistantBlocks });

      // Execute each tool call and build tool_result blocks
      const resultBlocks: ContentBlock[] = [];
      for (const tc of response.toolCalls) {
        this.logger.info('Executing tool', { chatId, tool: tc.name, input: tc.input });
        const result = await this.executeTool(tc.name, tc.input);
        this.logger.info('Tool result', { chatId, tool: tc.name, resultLength: result.length });
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: this.truncateResult(result),
        });
      }
      history.push({ role: 'user', content: resultBlocks });

      // Re-call the LLM with updated history
      response = await this.provider.chat([...history], chatOptions);
      this.logger.info('LLM follow-up response', {
        chatId,
        iteration: iterations,
        contentLength: response.content?.length ?? 0,
        toolCalls: response.toolCalls?.map(tc => tc.name) ?? [],
      });
    }

    if (iterations >= this.maxToolIterations && response.toolCalls && response.toolCalls.length > 0) {
      this.logger.warn(`Max tool iterations (${this.maxToolIterations}) reached for chat ${chatId}`);
    }

    // Append final assistant response to history
    history.push({ role: 'assistant', content: response.content });

    // Trim history if over limit
    this.trimHistoryArray(history);

    // Persist
    if (this.store) {
      this.store.save(chatId, history);
    } else {
      this.histories.set(chatId, history);
    }

    return response.content;

    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  }

  clearHistory(chatId: string): void {
    this.histories.delete(chatId);
    this.store?.clear(chatId);
  }

  private getHistory(chatId: string): ChatMessage[] {
    let h = this.histories.get(chatId);
    if (!h) {
      h = [];
      this.histories.set(chatId, h);
    }
    return h;
  }

  private buildToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [name, handler] of this.tools) {
      defs.push({
        name,
        description: handler.description,
        inputSchema: handler.inputSchema,
      });
    }
    return defs;
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const handler = this.tools.get(name);
    if (!handler) {
      const msg = `Unknown tool: ${name}`;
      this.logger.error(msg);
      return JSON.stringify({ error: msg });
    }

    try {
      const result = await handler.handler(input);
      return JSON.stringify(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${name} failed: ${errorMessage}`);
      return JSON.stringify({ error: `Tool execution failed: ${errorMessage}` });
    }
  }

  private truncateResult(result: string): string {
    if (result.length > MAX_TOOL_RESULT_LENGTH) {
      return result.slice(0, MAX_TOOL_RESULT_LENGTH) + '... [truncated]';
    }
    return result;
  }

  private trimHistoryArray(history: ChatMessage[]): void {
    if (history.length <= this.maxHistory) return;

    const excess = history.length - this.maxHistory;
    history.splice(0, excess);

    while (history.length > 0) {
      const first = history[0];
      const isToolResult =
        Array.isArray(first.content) &&
        first.content.some((b) => b.type === 'tool_result');
      if (first.role !== 'user' || isToolResult) {
        history.splice(0, 1);
      } else {
        break;
      }
    }
  }
}
