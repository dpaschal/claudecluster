# Subagent Executor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Claude subagent executor and add 15 unit tests with mocked Anthropic SDK.

**Architecture:** SubagentExecutor class that wraps Anthropic SDK, handles tool use loops, streams output.

**Tech Stack:** @anthropic-ai/sdk, Vitest mocks, EventEmitter

---

## Task 1: Install SDK and Create SubagentExecutor

**Files:**
- Modify: `package.json`
- Create: `src/agent/subagent-executor.ts`

**Step 1: Install Anthropic SDK**

Run: `npm install @anthropic-ai/sdk`

**Step 2: Create subagent executor file**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

export interface SubagentConfig {
  logger: Logger;
  apiKey?: string;
  defaultModel?: string;
  maxTokens?: number;
}

export interface SubagentTaskSpec {
  prompt: string;
  model?: string;
  tools?: string[];
  contextSummary?: string;
  maxTurns?: number;
  systemPrompt?: string;
}

export interface SubagentResult {
  success: boolean;
  response: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  turns: number;
  toolCalls: Array<{
    tool: string;
    input: unknown;
    output: unknown;
  }>;
  error?: string;
}

export class SubagentExecutor extends EventEmitter {
  private client: Anthropic;
  private config: SubagentConfig;

  constructor(config: SubagentConfig) {
    super();
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  async execute(spec: SubagentTaskSpec): Promise<SubagentResult> {
    const model = spec.model ?? this.config.defaultModel ?? 'claude-sonnet-4-20250514';
    const maxTurns = spec.maxTurns ?? 10;

    const messages: Anthropic.MessageParam[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turns = 0;
    const toolCalls: SubagentResult['toolCalls'] = [];

    // Build initial message
    if (spec.contextSummary) {
      messages.push({
        role: 'user',
        content: `Context:\n${spec.contextSummary}\n\nTask:\n${spec.prompt}`,
      });
    } else {
      messages.push({
        role: 'user',
        content: spec.prompt,
      });
    }

    try {
      while (turns < maxTurns) {
        turns++;

        const response = await this.client.messages.create({
          model,
          max_tokens: this.config.maxTokens ?? 4096,
          system: spec.systemPrompt,
          messages,
          tools: this.buildToolDefinitions(spec.tools),
        });

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;

        // Emit text content
        for (const block of response.content) {
          if (block.type === 'text') {
            this.emit('text', block.text);
          }
        }

        // Check for tool use
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        );

        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          // Done - extract final response
          const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === 'text'
          );
          const finalResponse = textBlocks.map(b => b.text).join('\n');

          return {
            success: true,
            response: finalResponse,
            tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
            turns,
            toolCalls,
          };
        }

        // Handle tool calls
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await this.executeToolCall(toolUse.name, toolUse.input, spec.tools);
          toolCalls.push({
            tool: toolUse.name,
            input: toolUse.input,
            output: result,
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      // Max turns reached
      return {
        success: false,
        response: '',
        tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        turns,
        toolCalls,
        error: `Max turns (${maxTurns}) reached`,
      };

    } catch (error) {
      return {
        success: false,
        response: '',
        tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
        turns,
        toolCalls,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildToolDefinitions(allowedTools?: string[]): Anthropic.Tool[] {
    // Return empty for now - tool definitions would be populated from cluster config
    if (!allowedTools || allowedTools.length === 0) {
      return [];
    }

    // Placeholder tool definitions - real implementation would have actual schemas
    return allowedTools.map(name => ({
      name,
      description: `Tool: ${name}`,
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    }));
  }

  private async executeToolCall(
    toolName: string,
    input: unknown,
    allowedTools?: string[]
  ): Promise<unknown> {
    // Validate tool is allowed
    if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      return { error: `Tool ${toolName} not allowed` };
    }

    // Emit tool call event
    this.emit('tool_call', { tool: toolName, input });

    // Placeholder - real implementation routes to tool handlers
    return { error: 'Tool execution not yet implemented' };
  }

  // Expose for testing
  getClient(): Anthropic {
    return this.client;
  }
}
```

**Step 3: Verify compilation**

Run: `npm run build`
Expected: Successful compilation

**Step 4: Commit**

```bash
git add package.json package-lock.json src/agent/subagent-executor.ts
git commit -m "feat: add subagent executor with Anthropic SDK"
```

---

## Task 2: Integrate with TaskExecutor

**Files:**
- Modify: `src/agent/task-executor.ts`

**Step 1: Import SubagentExecutor**

Add at top of file:
```typescript
import { SubagentExecutor } from './subagent-executor';
```

**Step 2: Update executeSubagent method**

Replace the existing `executeSubagent` method:

```typescript
  private async executeSubagent(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
    const subagentSpec = spec.subagent!;

    const executor = new SubagentExecutor({
      logger: this.config.logger,
    });

    // Stream text output
    executor.on('text', (text: string) => {
      running.stdout.push(Buffer.from(text));
      this.emitOutput(spec.taskId, 'stdout', Buffer.from(text));
    });

    // Emit tool call events
    executor.on('tool_call', (call: { tool: string; input: unknown }) => {
      this.emitOutput(spec.taskId, 'status', Buffer.from(JSON.stringify({
        type: 'tool_call',
        tool: call.tool,
        input: call.input,
      })));
    });

    const result = await executor.execute({
      prompt: subagentSpec.prompt,
      model: subagentSpec.model,
      tools: subagentSpec.tools,
      contextSummary: subagentSpec.contextSummary,
      maxTurns: subagentSpec.maxTurns,
    });

    return {
      taskId: spec.taskId,
      success: result.success,
      exitCode: result.success ? 0 : 1,
      stdout: Buffer.concat(running.stdout),
      stderr: Buffer.from(result.error ?? ''),
      startedAt: running.startedAt,
      completedAt: Date.now(),
    };
  }
```

**Step 3: Verify compilation**

Run: `npm run build`
Expected: Successful compilation

**Step 4: Commit**

```bash
git add src/agent/task-executor.ts
git commit -m "feat: integrate subagent executor with task executor"
```

---

## Task 3: Create Subagent Tests (Part 1)

**Files:**
- Create: `tests/subagent-executor.test.ts`

**Step 1: Create test file with mocks**

```typescript
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { SubagentExecutor, SubagentTaskSpec } from '../src/agent/subagent-executor';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}));

import Anthropic from '@anthropic-ai/sdk';

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createMockResponse = (text: string, inputTokens = 100, outputTokens = 50) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

const createMockToolResponse = (
  text: string,
  toolUse: { id: string; name: string; input: unknown }
) => ({
  content: [
    { type: 'text', text },
    { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50 },
});

describe('SubagentExecutor', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let mockCreate: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    mockCreate = vi.fn();
    (Anthropic as unknown as Mock).mockImplementation(() => ({
      messages: { create: mockCreate },
    }));
  });

  describe('Basic Execution', () => {
    it('should execute simple prompt and return response', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Hello, world!'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({ prompt: 'Say hello' });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Hello, world!');
    });

    it('should stream text content via events', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Streamed response'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const texts: string[] = [];
      executor.on('text', (text: string) => texts.push(text));

      await executor.execute({ prompt: 'Test streaming' });

      expect(texts).toContain('Streamed response');
    });

    it('should use specified model', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Response'));

      const executor = new SubagentExecutor({ logger: logger as any });
      await executor.execute({
        prompt: 'Test',
        model: 'claude-opus-4-20250514',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-20250514' })
      );
    });

    it('should use default model when not specified', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Response'));

      const executor = new SubagentExecutor({
        logger: logger as any,
        defaultModel: 'claude-3-haiku-20240307',
      });
      await executor.execute({ prompt: 'Test' });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-haiku-20240307' })
      );
    });

    it('should include context summary in prompt', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Response'));

      const executor = new SubagentExecutor({ logger: logger as any });
      await executor.execute({
        prompt: 'Do something',
        contextSummary: 'Project context here',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Context:\nProject context here'),
            }),
          ]),
        })
      );
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/subagent-executor.test.ts`
Expected: 5 tests passing

**Step 3: Commit**

```bash
git add tests/subagent-executor.test.ts
git commit -m "test: add basic subagent executor tests"
```

---

## Task 4: Subagent Tests (Part 2 - Turn Limits and Errors)

**Files:**
- Modify: `tests/subagent-executor.test.ts`

**Step 1: Add turn limit and error tests**

```typescript
  describe('Turn Limits', () => {
    it('should respect max turns limit', async () => {
      // Mock tool use that never ends
      mockCreate.mockResolvedValue(createMockToolResponse(
        'Thinking...',
        { id: 'tool-1', name: 'read_file', input: { path: '/test' } }
      ));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({
        prompt: 'Loop forever',
        maxTurns: 3,
        tools: ['read_file'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Max turns (3) reached');
      expect(result.turns).toBe(3);
    });

    it('should track turn count', async () => {
      // First call returns tool use, second returns final response
      mockCreate
        .mockResolvedValueOnce(createMockToolResponse(
          'Using tool...',
          { id: 'tool-1', name: 'search', input: {} }
        ))
        .mockResolvedValueOnce(createMockResponse('Done!'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({
        prompt: 'Search something',
        tools: ['search'],
      });

      expect(result.turns).toBe(2);
      expect(result.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({ prompt: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API rate limit exceeded');
    });

    it('should return token usage statistics', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Response', 150, 75));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({ prompt: 'Test' });

      expect(result.tokensUsed).toEqual({
        input: 150,
        output: 75,
      });
    });

    it('should accumulate tokens across turns', async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [
            { type: 'text', text: 'Step 1' },
            { type: 'tool_use', id: 't1', name: 'test', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 100 },
        });

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({
        prompt: 'Test',
        tools: ['test'],
      });

      expect(result.tokensUsed).toEqual({
        input: 300,
        output: 150,
      });
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/subagent-executor.test.ts`
Expected: 10 tests passing

**Step 3: Commit**

```bash
git add tests/subagent-executor.test.ts
git commit -m "test: add turn limit and error handling tests"
```

---

## Task 5: Subagent Tests (Part 3 - Tool Calls)

**Files:**
- Modify: `tests/subagent-executor.test.ts`

**Step 1: Add tool call tests**

```typescript
  describe('Tool Handling', () => {
    it('should handle tool use blocks', async () => {
      mockCreate
        .mockResolvedValueOnce(createMockToolResponse(
          'Let me check...',
          { id: 'tool-123', name: 'read_file', input: { path: '/test.txt' } }
        ))
        .mockResolvedValueOnce(createMockResponse('File contents processed'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({
        prompt: 'Read the file',
        tools: ['read_file'],
      });

      expect(result.success).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].tool).toBe('read_file');
      expect(result.toolCalls[0].input).toEqual({ path: '/test.txt' });
    });

    it('should validate allowed tools', async () => {
      mockCreate
        .mockResolvedValueOnce(createMockToolResponse(
          'Trying forbidden tool...',
          { id: 'tool-bad', name: 'delete_everything', input: {} }
        ))
        .mockResolvedValueOnce(createMockResponse('Blocked'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({
        prompt: 'Do bad things',
        tools: ['read_file', 'write_file'],
      });

      const blockedCall = result.toolCalls.find(c => c.tool === 'delete_everything');
      expect(blockedCall?.output).toEqual({ error: 'Tool delete_everything not allowed' });
    });

    it('should emit tool_call events', async () => {
      mockCreate
        .mockResolvedValueOnce(createMockToolResponse(
          'Searching...',
          { id: 'tool-1', name: 'search', input: { query: 'test' } }
        ))
        .mockResolvedValueOnce(createMockResponse('Found it'));

      const executor = new SubagentExecutor({ logger: logger as any });
      const toolEvents: Array<{ tool: string; input: unknown }> = [];
      executor.on('tool_call', (event) => toolEvents.push(event));

      await executor.execute({
        prompt: 'Search for test',
        tools: ['search'],
      });

      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].tool).toBe('search');
      expect(toolEvents[0].input).toEqual({ query: 'test' });
    });

    it('should stop on end_turn even with tool use in response', async () => {
      // Response has both text and tool_use, but stop_reason is end_turn
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Final answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const executor = new SubagentExecutor({ logger: logger as any });
      const result = await executor.execute({ prompt: 'Question' });

      expect(result.success).toBe(true);
      expect(result.response).toBe('Final answer');
      expect(result.turns).toBe(1);
    });

    it('should use system prompt when provided', async () => {
      mockCreate.mockResolvedValue(createMockResponse('Response'));

      const executor = new SubagentExecutor({ logger: logger as any });
      await executor.execute({
        prompt: 'Test',
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are a helpful assistant.',
        })
      );
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/subagent-executor.test.ts`
Expected: 15 tests passing

**Step 3: Commit**

```bash
git add tests/subagent-executor.test.ts
git commit -m "test: add tool handling tests for subagent executor"
```

---

## Task 6: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify test counts**

Run: `grep -c "it\(" tests/subagent-executor.test.ts`
Expected: 15

**Step 3: Verify build**

Run: `npm run build`
Expected: Successful compilation

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete subagent executor implementation and tests"
```
