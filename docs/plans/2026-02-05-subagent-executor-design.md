# Claude Subagent Executor Design

## Goal

Implement the Claude subagent executor to enable distributed Claude API calls across the cluster.

## Architecture

The subagent executor integrates with the Anthropic SDK to:
1. Execute prompts on remote nodes
2. Stream responses back to the coordinator
3. Handle tool calls within the subagent context
4. Respect token limits and turn constraints

```
Coordinator                           Worker Node
    │                                      │
    ├─── SubmitTask(subagent) ───────────►│
    │                                      │
    │    ┌────────────────────────────────┐│
    │    │ SubagentExecutor               ││
    │    │  ├─ Create Anthropic client    ││
    │    │  ├─ Build messages array       ││
    │    │  ├─ Stream API response        ││
    │    │  ├─ Handle tool_use blocks     ││
    │    │  └─ Collect final response     ││
    │    └────────────────────────────────┘│
    │                                      │
    │◄─── StreamOutput(chunks) ───────────┤
    │◄─── TaskResult(response) ───────────┤
```

## Implementation

### New File: `src/agent/subagent-executor.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter } from 'events';
import { Logger } from 'winston';

export interface SubagentConfig {
  logger: Logger;
  apiKey?: string;  // Falls back to ANTHROPIC_API_KEY env
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
```

### Core Implementation

```typescript
export class SubagentExecutor extends EventEmitter {
  private client: Anthropic;
  private config: SubagentConfig;
  private allowedTools: Set<string>;

  constructor(config: SubagentConfig) {
    super();
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    // Define allowed tools for sandboxed execution
    this.allowedTools = new Set([
      'read_file',
      'write_file',
      'execute_command',
      'search_code',
    ]);
  }

  async execute(spec: SubagentTaskSpec): Promise<SubagentResult> {
    const model = spec.model ?? this.config.defaultModel ?? 'claude-sonnet-4-20250514';
    const maxTurns = spec.maxTurns ?? 10;

    let messages: Anthropic.MessageParam[] = [];
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

        // Stream text content
        for (const block of response.content) {
          if (block.type === 'text') {
            this.emit('text', block.text);
          }
        }

        // Check for tool use
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          // Done - extract final response
          const textBlocks = response.content.filter(b => b.type === 'text');
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
          if (toolUse.type !== 'tool_use') continue;

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
    // Return tool definitions for allowed tools
    // This would be populated based on the cluster's available tools
    return [];
  }

  private async executeToolCall(
    toolName: string,
    input: unknown,
    allowedTools?: string[]
  ): Promise<unknown> {
    // Validate tool is allowed
    if (allowedTools && !allowedTools.includes(toolName)) {
      return { error: `Tool ${toolName} not allowed` };
    }

    // Execute the tool (would dispatch to appropriate handler)
    this.emit('tool_call', { tool: toolName, input });

    // Placeholder - real implementation routes to tool handlers
    return { error: 'Tool execution not yet implemented' };
  }
}
```

### Integration with TaskExecutor

Update `task-executor.ts` to use SubagentExecutor:

```typescript
private async executeSubagent(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
  const subagentSpec = spec.subagent!;

  const executor = new SubagentExecutor({
    logger: this.config.logger,
  });

  // Stream text output
  executor.on('text', (text: string) => {
    this.emitOutput(spec.taskId, 'stdout', Buffer.from(text));
  });

  const result = await executor.execute(subagentSpec);

  return {
    taskId: spec.taskId,
    success: result.success,
    exitCode: result.success ? 0 : 1,
    stdout: Buffer.from(result.response),
    stderr: Buffer.from(result.error ?? ''),
    startedAt: running.startedAt,
    completedAt: Date.now(),
  };
}
```

## Testing Strategy

Mock the Anthropic SDK:

```typescript
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn(),
    },
  })),
}));
```

### Test Cases (15 tests)

1. Should execute simple prompt and return response
2. Should stream text content via events
3. Should use specified model
4. Should use default model when not specified
5. Should include context summary in prompt
6. Should respect max turns limit
7. Should handle tool use blocks
8. Should validate allowed tools
9. Should return token usage statistics
10. Should handle API errors gracefully
11. Should track turn count
12. Should emit tool_call events
13. Should stop on end_turn
14. Should accumulate multiple tool calls
15. Should use system prompt when provided

## Dependencies

Add to package.json:
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0"
  }
}
```

## Success Criteria

- SubagentExecutor class fully implemented
- Integration with TaskExecutor complete
- 15 unit tests passing with mocked SDK
- Can execute simple prompts via cluster task submission
