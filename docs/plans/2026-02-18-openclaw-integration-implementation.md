# OpenClaw Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Absorb all OpenClaw features (messaging gateway, multi-provider LLM, SKILL.md, inbox) into claudecluster and remove the OpenClaw dependency.

**Architecture:** Fork-and-absorb strategy. OpenClaw's channel adapters, inbox ops, skill loader, and provider routing are integrated as new modules in claudecluster. The messaging gateway runs on the Raft leader with automatic failover. The agent-mcp bridge's 4 MCP tools become native claudecluster tools.

**Tech Stack:** TypeScript (NodeNext), discord.js, node-telegram-bot-api, @anthropic-ai/sdk, openai, zod, vitest

**Design Doc:** `docs/plans/2026-02-18-openclaw-integration-design.md`

---

## Task 1: Fix SSH Access to Terminus

**Files:**
- Modify: `~/.ssh/authorized_keys` on terminus (remote)

**Step 1: Copy gauntlet's public key to terminus**

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub paschal@100.120.202.76
```

If that fails (because SSH itself is blocked), the user will need to manually add the key on terminus.

**Step 2: Verify SSH works**

Run: `ssh -o ConnectTimeout=5 paschal@100.120.202.76 "hostname && whoami"`
Expected: `terminus` and `paschal`

**Step 3: Commit (nothing to commit — remote change only)**

---

## Task 2: Copy OpenClaw Source & Check License

**Files:**
- Create: `src/openclaw/` directory tree (copied from terminus)

**Step 1: Copy OpenClaw source from terminus**

```bash
cd ~/claudecluster
mkdir -p src/openclaw
scp -r paschal@100.120.202.76:/home/paschal/openclaw/src/* src/openclaw/ 2>/dev/null || true
scp -r paschal@100.120.202.76:/home/paschal/openclaw/package.json src/openclaw/
scp -r paschal@100.120.202.76:/home/paschal/openclaw/LICENSE* src/openclaw/ 2>/dev/null || true
scp -r paschal@100.120.202.76:/home/paschal/openclaw/README* src/openclaw/ 2>/dev/null || true
```

**Step 2: Check the license**

```bash
cat src/openclaw/LICENSE*
```

If MIT/Apache/ISC → proceed. If restrictive → STOP and pivot to Approach A (rewrite).

**Step 3: Extract bot tokens from OpenClaw config**

```bash
ssh paschal@100.120.202.76 "cat ~/.openclaw/openclaw.json" > /tmp/openclaw-config.json
cat /tmp/openclaw-config.json
```

Save the Discord and Telegram bot tokens into KeePass vault:
```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "/APIs/" -s'
```

Check if entries exist, create them if not.

**Step 4: Copy existing SKILL.md files and inbox data**

```bash
scp -r paschal@100.120.202.76:~/.openclaw/skills/ src/openclaw/skills-data/ 2>/dev/null || true
scp -r paschal@100.120.202.76:~/.openclaw/inbox/ /tmp/openclaw-inbox-backup/ 2>/dev/null || true
```

**Step 5: Commit**

```bash
git add src/openclaw/
git commit -m "feat: import OpenClaw source for fork-and-absorb integration"
```

---

## Task 3: LLM Provider Interface & Types

**Files:**
- Create: `src/providers/types.ts`
- Test: `src/providers/__tests__/types.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import type { LLMProvider, ChatMessage, ChatResponse, StreamChunk } from '../types.js';

describe('LLMProvider types', () => {
  it('should define a valid provider interface shape', () => {
    // Type-level test: ensure the interface is importable and structurally sound
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
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/types.test.ts`
Expected: FAIL — module `../types.js` does not exist

**Step 3: Write the types**

```typescript
// src/providers/types.ts

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/claudecluster
git add src/providers/
git commit -m "feat: add LLM provider interface and types"
```

---

## Task 4: Anthropic Provider (Refactor Existing)

**Files:**
- Create: `src/providers/anthropic.ts`
- Test: `src/providers/__tests__/anthropic.test.ts`
- Modify: `src/agent/subagent-executor.ts` (later, after all providers ready)

**Step 1: Write the failing test**

```typescript
// src/providers/__tests__/anthropic.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';

// Mock the Anthropic SDK
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
    const noKeyProvider = new AnthropicProvider({});
    expect(await noKeyProvider.isAvailable()).toBe(false);
  });

  it('should return supported models', async () => {
    const models = await provider.models();
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('claude-opus-4-6');
    expect(models).toContain('claude-haiku-4-5');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/anthropic.test.ts`
Expected: FAIL — module `../anthropic.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/providers/anthropic.ts
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
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/anthropic.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/claudecluster
git add src/providers/anthropic.ts src/providers/__tests__/anthropic.test.ts
git commit -m "feat: add Anthropic LLM provider implementation"
```

---

## Task 5: OpenAI Provider

**Files:**
- Create: `src/providers/openai.ts`
- Test: `src/providers/__tests__/openai.test.ts`

**Step 1: Install the OpenAI SDK**

```bash
cd ~/claudecluster && npm install openai
```

**Step 2: Write the failing test**

```typescript
// src/providers/__tests__/openai.test.ts
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
```

**Step 3: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/openai.test.ts`
Expected: FAIL — module `../openai.js` does not exist

**Step 4: Write the implementation**

```typescript
// src/providers/openai.ts
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
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/openai.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/providers/openai.ts src/providers/__tests__/openai.test.ts
git commit -m "feat: add OpenAI LLM provider implementation"
```

---

## Task 6: Ollama Provider (Local Models)

**Files:**
- Create: `src/providers/ollama.ts`
- Test: `src/providers/__tests__/ollama.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/__tests__/ollama.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../ollama.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('ollama');
  });

  it('should call the Ollama API for chat', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'Hello from Llama' },
        model: 'llama3',
        eval_count: 20,
        prompt_eval_count: 10,
      }),
    });

    const response = await provider.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from Llama');
    expect(response.model).toBe('llama3');
  });

  it('should list available models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }),
    });

    const models = await provider.models();
    expect(models).toEqual(['llama3', 'mistral']);
  });

  it('should check availability by pinging the API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    expect(await provider.isAvailable()).toBe(true);
  });

  it('should report unavailable when API is down', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    expect(await provider.isAvailable()).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/ollama.test.ts`
Expected: FAIL — module `../ollama.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/providers/ollama.ts
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './types.js';

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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
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
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/ollama.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/claudecluster
git add src/providers/ollama.ts src/providers/__tests__/ollama.test.ts
git commit -m "feat: add Ollama LLM provider for local models"
```

---

## Task 7: Provider Router with Fallback Chain

**Files:**
- Create: `src/providers/router.ts`
- Create: `src/providers/index.ts`
- Test: `src/providers/__tests__/router.test.ts`

**Step 1: Write the failing test**

```typescript
// src/providers/__tests__/router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderRouter } from '../router.js';
import type { LLMProvider, ChatResponse } from '../types.js';

function createMockProvider(name: string, available: boolean, response?: string): LLMProvider {
  return {
    name,
    chat: available
      ? vi.fn().mockResolvedValue({
          content: response ?? `Hello from ${name}`,
          model: `${name}-model`,
          usage: { inputTokens: 10, outputTokens: 5 },
        } satisfies ChatResponse)
      : vi.fn().mockRejectedValue(new Error(`${name} unavailable`)),
    stream: vi.fn() as any,
    models: vi.fn().mockResolvedValue([`${name}-model`]),
    isAvailable: vi.fn().mockResolvedValue(available),
  };
}

describe('ProviderRouter', () => {
  it('should use the primary provider when available', async () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from anthropic');
    expect(primary.chat).toHaveBeenCalled();
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('should fall back when primary fails', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from openai');
    expect(primary.chat).toHaveBeenCalled();
    expect(fallback.chat).toHaveBeenCalled();
  });

  it('should cascade through multiple fallbacks', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback1 = createMockProvider('openai', false);
    const fallback2 = createMockProvider('ollama', true);
    const router = new ProviderRouter({ primary, fallback: [fallback1, fallback2] });

    const response = await router.chat([{ role: 'user', content: 'Hello' }]);
    expect(response.content).toBe('Hello from ollama');
  });

  it('should throw when all providers fail', async () => {
    const primary = createMockProvider('anthropic', false);
    const fallback = createMockProvider('openai', false);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    await expect(router.chat([{ role: 'user', content: 'Hello' }])).rejects.toThrow('All providers failed');
  });

  it('should list all available providers', () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    expect(router.listProviders()).toEqual(['anthropic', 'openai']);
  });

  it('should get a specific provider by name', () => {
    const primary = createMockProvider('anthropic', true);
    const fallback = createMockProvider('openai', true);
    const router = new ProviderRouter({ primary, fallback: [fallback] });

    expect(router.getProvider('openai')?.name).toBe('openai');
    expect(router.getProvider('nonexistent')).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/router.test.ts`
Expected: FAIL — module `../router.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/providers/router.ts
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './types.js';

export interface ProviderRouterConfig {
  primary: LLMProvider;
  fallback: LLMProvider[];
}

export class ProviderRouter implements LLMProvider {
  readonly name = 'router';
  private primary: LLMProvider;
  private fallback: LLMProvider[];

  constructor(config: ProviderRouterConfig) {
    this.primary = config.primary;
    this.fallback = config.fallback;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const providers = [this.primary, ...this.fallback];
    const errors: Error[] = [];

    for (const provider of providers) {
      try {
        return await provider.chat(messages, options);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`);
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const providers = [this.primary, ...this.fallback];
    const errors: Error[] = [];

    for (const provider of providers) {
      try {
        yield* provider.stream(messages, options);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw new Error(`All providers failed: ${errors.map(e => e.message).join('; ')}`);
  }

  async models(): Promise<string[]> {
    const allModels: string[] = [];
    for (const provider of [this.primary, ...this.fallback]) {
      try {
        const models = await provider.models();
        allModels.push(...models);
      } catch {
        // Skip unavailable providers
      }
    }
    return allModels;
  }

  async isAvailable(): Promise<boolean> {
    for (const provider of [this.primary, ...this.fallback]) {
      if (await provider.isAvailable()) return true;
    }
    return false;
  }

  listProviders(): string[] {
    return [this.primary.name, ...this.fallback.map(p => p.name)];
  }

  getProvider(name: string): LLMProvider | undefined {
    if (this.primary.name === name) return this.primary;
    return this.fallback.find(p => p.name === name);
  }
}
```

**Step 4: Write the barrel export**

```typescript
// src/providers/index.ts
export type { LLMProvider, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ToolDefinition, ToolCall, TokenUsage } from './types.js';
export { AnthropicProvider } from './anthropic.js';
export type { AnthropicProviderConfig } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export type { OpenAIProviderConfig } from './openai.js';
export { OllamaProvider } from './ollama.js';
export type { OllamaProviderConfig } from './ollama.js';
export { ProviderRouter } from './router.js';
export type { ProviderRouterConfig } from './router.js';
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/router.test.ts`
Expected: PASS

**Step 6: Run all provider tests**

Run: `cd ~/claudecluster && npx vitest run src/providers/__tests__/`
Expected: All PASS

**Step 7: Commit**

```bash
cd ~/claudecluster
git add src/providers/
git commit -m "feat: add provider router with fallback chain support"
```

---

## Task 8: Inbox & Message Operations

**Files:**
- Create: `src/messaging/inbox.ts`
- Create: `src/messaging/types.ts`
- Test: `src/messaging/__tests__/inbox.test.ts`

**Step 1: Write the failing test**

```typescript
// src/messaging/__tests__/inbox.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Inbox } from '../inbox.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Inbox', () => {
  let tmpDir: string;
  let inbox: Inbox;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-test-'));
    inbox = new Inbox(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write and read a message', async () => {
    const id = await inbox.writeMessage({
      from: 'claudecode',
      to: 'cipher',
      content: 'Hello Cipher',
      type: 'info',
    });

    const msg = await inbox.readMessage(id);
    expect(msg.from).toBe('claudecode');
    expect(msg.to).toBe('cipher');
    expect(msg.content).toBe('Hello Cipher');
    expect(msg.status).toBe('new');
    expect(msg.timestamp).toBeDefined();
  });

  it('should list all messages', async () => {
    await inbox.writeMessage({ from: 'a', to: 'b', content: '1', type: 'info' });
    await inbox.writeMessage({ from: 'a', to: 'b', content: '2', type: 'info' });

    const ids = await inbox.listMessages();
    expect(ids).toHaveLength(2);
  });

  it('should return empty list for nonexistent directory', async () => {
    const noDir = new Inbox('/nonexistent/path');
    const ids = await noDir.listMessages();
    expect(ids).toEqual([]);
  });

  it('should filter new messages', async () => {
    const id1 = await inbox.writeMessage({ from: 'a', to: 'b', content: '1', type: 'info' });
    const id2 = await inbox.writeMessage({ from: 'a', to: 'b', content: '2', type: 'info' });

    // Mark one as read
    await inbox.markRead(id1);

    const newMessages = await inbox.getNewMessages();
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].content).toBe('2');
  });

  it('should archive old messages', async () => {
    await inbox.writeMessage({ from: 'a', to: 'b', content: 'old', type: 'info' });

    // Force the message to look old by rewriting with old timestamp
    const ids = await inbox.listMessages();
    const msg = await inbox.readMessage(ids[0]);
    msg.timestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(); // 31 days ago
    await fs.writeFile(path.join(tmpDir, `${ids[0]}.json`), JSON.stringify(msg));

    const archived = await inbox.archiveOlderThan(30);
    expect(archived).toBe(1);
    expect(await inbox.listMessages()).toHaveLength(0);
  });

  it('should throw for nonexistent message', async () => {
    await expect(inbox.readMessage('nonexistent')).rejects.toThrow('Message not found');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/messaging/__tests__/inbox.test.ts`
Expected: FAIL — module `../inbox.js` does not exist

**Step 3: Write the types**

```typescript
// src/messaging/types.ts
export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  type: 'info' | 'question' | 'task' | 'response' | 'error';
  status: 'new' | 'read' | 'archived';
  timestamp: string;
  threadId?: string;
  context?: {
    project?: string;
    priority?: 'normal' | 'high' | 'urgent';
  };
}

export interface WriteMessageInput {
  from: string;
  to: string;
  content: string;
  type: 'info' | 'question' | 'task' | 'response' | 'error';
  threadId?: string;
  context?: {
    project?: string;
    priority?: 'normal' | 'high' | 'urgent';
  };
}

export interface ChannelMessage {
  channelType: 'discord' | 'telegram';
  channelId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
  replyTo?: string;
}

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onMessage(handler: (message: ChannelMessage) => void): void;
  sendMessage(channelId: string, content: string, replyTo?: string): Promise<void>;
}
```

**Step 4: Write the inbox implementation**

```typescript
// src/messaging/inbox.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { InboxMessage, WriteMessageInput } from './types.js';

export class Inbox {
  private inboxPath: string;
  private archivePath: string;

  constructor(inboxPath: string) {
    this.inboxPath = inboxPath;
    this.archivePath = path.join(inboxPath, '..', 'archive');
  }

  async writeMessage(input: WriteMessageInput): Promise<string> {
    await fs.mkdir(this.inboxPath, { recursive: true });

    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const message: InboxMessage = {
      id,
      from: input.from,
      to: input.to,
      content: input.content,
      type: input.type,
      status: 'new',
      timestamp: new Date().toISOString(),
      threadId: input.threadId,
      context: input.context,
    };

    await fs.writeFile(
      path.join(this.inboxPath, `${id}.json`),
      JSON.stringify(message, null, 2),
    );

    return id;
  }

  async readMessage(messageId: string): Promise<InboxMessage> {
    const messagePath = path.join(this.inboxPath, `${messageId}.json`);
    try {
      const content = await fs.readFile(messagePath, 'utf-8');
      return JSON.parse(content) as InboxMessage;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Message not found: ${messageId}`);
      }
      throw err;
    }
  }

  async listMessages(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.inboxPath);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async getNewMessages(): Promise<InboxMessage[]> {
    const ids = await this.listMessages();
    const messages: InboxMessage[] = [];

    for (const id of ids) {
      try {
        const msg = await this.readMessage(id);
        if (msg.status === 'new') {
          messages.push(msg);
        }
      } catch {
        // Skip unreadable messages
      }
    }

    return messages;
  }

  async markRead(messageId: string): Promise<void> {
    const msg = await this.readMessage(messageId);
    msg.status = 'read';
    await fs.writeFile(
      path.join(this.inboxPath, `${messageId}.json`),
      JSON.stringify(msg, null, 2),
    );
  }

  async archiveOlderThan(days: number): Promise<number> {
    const ids = await this.listMessages();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let archived = 0;

    await fs.mkdir(this.archivePath, { recursive: true });

    for (const id of ids) {
      try {
        const msg = await this.readMessage(id);
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime < cutoff) {
          msg.status = 'archived';
          const src = path.join(this.inboxPath, `${id}.json`);
          const dest = path.join(this.archivePath, `${id}.json`);
          await fs.writeFile(dest, JSON.stringify(msg, null, 2));
          await fs.unlink(src);
          archived++;
        }
      } catch {
        // Skip unreadable messages
      }
    }

    return archived;
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/messaging/__tests__/inbox.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/messaging/
git commit -m "feat: add inbox message operations for messaging gateway"
```

---

## Task 9: Messaging MCP Tools

**Files:**
- Create: `src/mcp/messaging-tools.ts`
- Test: `src/mcp/__tests__/messaging-tools.test.ts`
- Modify: `src/mcp/server.ts` (wire in new tools)

**Step 1: Write the failing test**

```typescript
// src/mcp/__tests__/messaging-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMessagingTools } from '../messaging-tools.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ToolHandler } from '../tools.js';

describe('messaging MCP tools', () => {
  let tmpDir: string;
  let tools: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-msg-test-'));
    const result = createMessagingTools({ inboxPath: tmpDir });
    tools = result.tools;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register all expected tools', () => {
    expect(tools.has('messaging_send')).toBe(true);
    expect(tools.has('messaging_check')).toBe(true);
    expect(tools.has('messaging_list')).toBe(true);
    expect(tools.has('messaging_get')).toBe(true);
    expect(tools.has('messaging_gateway_status')).toBe(true);
  });

  it('messaging_send should write a message to the inbox', async () => {
    const handler = tools.get('messaging_send')!;
    const result = await handler.handler({
      from: 'claudecode',
      to: 'cipher',
      content: 'Test message',
      type: 'info',
    }) as { messageId: string };

    expect(result.messageId).toBeDefined();

    // Verify it's on disk
    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
  });

  it('messaging_check should return new messages', async () => {
    // Write a message directly
    await fs.writeFile(path.join(tmpDir, 'test-msg.json'), JSON.stringify({
      id: 'test-msg',
      from: 'cipher',
      to: 'claudecode',
      content: 'Hello',
      type: 'info',
      status: 'new',
      timestamp: new Date().toISOString(),
    }));

    const handler = tools.get('messaging_check')!;
    const result = await handler.handler({}) as { messages: unknown[] };
    expect(result.messages).toHaveLength(1);
  });

  it('messaging_list should return message IDs', async () => {
    await fs.writeFile(path.join(tmpDir, 'msg1.json'), '{}');
    await fs.writeFile(path.join(tmpDir, 'msg2.json'), '{}');

    const handler = tools.get('messaging_list')!;
    const result = await handler.handler({}) as { conversations: string[] };
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations).toContain('msg1');
    expect(result.conversations).toContain('msg2');
  });

  it('messaging_get should return a specific message', async () => {
    await fs.writeFile(path.join(tmpDir, 'test-id.json'), JSON.stringify({
      id: 'test-id',
      from: 'cipher',
      to: 'claudecode',
      content: 'Specific message',
      type: 'info',
      status: 'new',
      timestamp: new Date().toISOString(),
    }));

    const handler = tools.get('messaging_get')!;
    const result = await handler.handler({ messageId: 'test-id' }) as { message: { content: string } };
    expect(result.message.content).toBe('Specific message');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/mcp/__tests__/messaging-tools.test.ts`
Expected: FAIL — module `../messaging-tools.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/mcp/messaging-tools.ts
import type { ToolHandler } from './tools.js';
import { Inbox } from '../messaging/inbox.js';

export interface MessagingToolsConfig {
  inboxPath: string;
}

export function createMessagingTools(config: MessagingToolsConfig): { tools: Map<string, ToolHandler>; inbox: Inbox } {
  const inbox = new Inbox(config.inboxPath);
  const tools = new Map<string, ToolHandler>();

  tools.set('messaging_send', {
    description: 'Send a message to the messaging inbox (Discord, Telegram, or inter-agent)',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender identifier (e.g., claudecode, cipher)' },
        to: { type: 'string', description: 'Recipient identifier' },
        content: { type: 'string', description: 'Message content' },
        type: { type: 'string', description: 'Message type', enum: ['info', 'question', 'task', 'response', 'error'] },
        threadId: { type: 'string', description: 'Optional thread/conversation ID' },
      },
      required: ['from', 'to', 'content', 'type'],
    },
    handler: async (args) => {
      const messageId = await inbox.writeMessage({
        from: args.from as string,
        to: args.to as string,
        content: args.content as string,
        type: args.type as 'info' | 'question' | 'task' | 'response' | 'error',
        threadId: args.threadId as string | undefined,
      });
      return { messageId, status: 'sent' };
    },
  });

  tools.set('messaging_check', {
    description: 'Check for new unread messages in the inbox',
    inputSchema: {
      type: 'object',
      properties: {
        staleThresholdMinutes: { type: 'number', description: 'Minutes after which a message is stale (default: 30)' },
      },
    },
    handler: async (args) => {
      const threshold = (args.staleThresholdMinutes as number) ?? 30;
      const messages = await inbox.getNewMessages();
      const now = Date.now();

      return {
        count: messages.length,
        messages: messages.map(msg => ({
          ...msg,
          stale: (now - new Date(msg.timestamp).getTime()) > threshold * 60 * 1000,
        })),
      };
    },
  });

  tools.set('messaging_list', {
    description: 'List all message/conversation IDs in the inbox',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const conversations = await inbox.listMessages();
      return { conversations, count: conversations.length };
    },
  });

  tools.set('messaging_get', {
    description: 'Retrieve a specific message by ID',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The message ID to retrieve' },
      },
      required: ['messageId'],
    },
    handler: async (args) => {
      const message = await inbox.readMessage(args.messageId as string);
      return { message };
    },
  });

  tools.set('messaging_gateway_status', {
    description: 'Get the status of the messaging gateway (connected channels, leader node)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      // This will be wired to the actual gateway in Task 12
      return {
        status: 'not_initialized',
        channels: [],
        leaderNode: null,
      };
    },
  });

  return { tools, inbox };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/mcp/__tests__/messaging-tools.test.ts`
Expected: PASS

**Step 5: Wire into MCP server**

Modify `src/mcp/server.ts` — add to imports:
```typescript
import { createMessagingTools } from './messaging-tools.js';
```

Add to `McpServerConfig`:
```typescript
inboxPath?: string;
```

Add to `createToolHandlers()` method, after context tools:
```typescript
const inboxPath = this.config.inboxPath ?? path.join(os.homedir(), '.claudecluster', 'inbox');
const { tools: messagingTools, inbox } = createMessagingTools({ inboxPath });
this.inbox = inbox;
for (const [name, handler] of messagingTools) {
  clusterTools.set(name, handler);
}
```

**Step 6: Run all MCP tests**

Run: `cd ~/claudecluster && npx vitest run src/mcp/__tests__/`
Expected: PASS

**Step 7: Commit**

```bash
cd ~/claudecluster
git add src/mcp/messaging-tools.ts src/mcp/__tests__/messaging-tools.test.ts src/mcp/server.ts
git commit -m "feat: add messaging MCP tools (send, check, list, get, status)"
```

---

## Task 10: Discord Channel Adapter

**Files:**
- Create: `src/messaging/channels/discord.ts`
- Test: `src/messaging/channels/__tests__/discord.test.ts`

**Step 1: Install discord.js**

```bash
cd ~/claudecluster && npm install discord.js
```

**Step 2: Write the failing test**

```typescript
// src/messaging/channels/__tests__/discord.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '../discord.js';

// Mock discord.js
vi.mock('discord.js', () => {
  const mockOn = vi.fn();
  const mockLogin = vi.fn().mockResolvedValue('token');
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const mockSend = vi.fn().mockResolvedValue({ id: 'msg-123' });

  return {
    Client: vi.fn().mockImplementation(() => ({
      on: mockOn,
      login: mockLogin,
      destroy: mockDestroy,
      isReady: vi.fn().mockReturnValue(true),
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send: mockSend,
        }),
      },
      user: { tag: 'TestBot#1234' },
    })),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
    },
    Partials: {
      Channel: 0,
    },
    Events: {
      MessageCreate: 'messageCreate',
      ClientReady: 'ready',
    },
  };
});

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    adapter = new DiscordAdapter({ token: 'test-token', guildId: 'test-guild' });
  });

  it('should have the correct name', () => {
    expect(adapter.name).toBe('discord');
  });

  it('should connect and login', async () => {
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
  });

  it('should disconnect gracefully', async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('should register message handlers', () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler registration is tested — actual invocation requires the mock event system
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/messaging/channels/__tests__/discord.test.ts`
Expected: FAIL — module `../discord.js` does not exist

**Step 4: Write the implementation**

```typescript
// src/messaging/channels/discord.ts
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

export interface DiscordAdapterConfig {
  token: string;
  guildId?: string;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';
  private client: Client;
  private token: string;
  private guildId: string | undefined;
  private connected = false;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];

  constructor(config: DiscordAdapterConfig) {
    this.token = config.token;
    this.guildId = config.guildId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, (message) => {
      // Ignore bot's own messages
      if (message.author.bot) return;

      const channelMessage: ChannelMessage = {
        channelType: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        timestamp: message.createdAt.toISOString(),
        replyTo: message.reference?.messageId ?? undefined,
      };

      for (const handler of this.messageHandlers) {
        handler(channelMessage);
      }
    });
  }

  async connect(): Promise<void> {
    await this.client.login(this.token);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    const options: { content: string; reply?: { messageReference: string } } = { content };
    if (replyTo) {
      options.reply = { messageReference: replyTo };
    }

    await (channel as { send: (opts: typeof options) => Promise<unknown> }).send(options);
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/messaging/channels/__tests__/discord.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/messaging/channels/
git commit -m "feat: add Discord channel adapter for messaging gateway"
```

---

## Task 11: Telegram Channel Adapter

**Files:**
- Create: `src/messaging/channels/telegram.ts`
- Test: `src/messaging/channels/__tests__/telegram.test.ts`

**Step 1: Install node-telegram-bot-api**

```bash
cd ~/claudecluster && npm install node-telegram-bot-api && npm install -D @types/node-telegram-bot-api
```

**Step 2: Write the failing test**

```typescript
// src/messaging/channels/__tests__/telegram.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../telegram.js';

vi.mock('node-telegram-bot-api', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      startPolling: vi.fn(),
      stopPolling: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
      isPolling: vi.fn().mockReturnValue(true),
    })),
  };
});

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter({ token: 'test-token' });
  });

  it('should have the correct name', () => {
    expect(adapter.name).toBe('telegram');
  });

  it('should connect and start polling', async () => {
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
  });

  it('should disconnect and stop polling', async () => {
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/messaging/channels/__tests__/telegram.test.ts`
Expected: FAIL — module `../telegram.js` does not exist

**Step 4: Write the implementation**

```typescript
// src/messaging/channels/telegram.ts
import TelegramBot from 'node-telegram-bot-api';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

export interface TelegramAdapterConfig {
  token: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: TelegramBot;
  private connected = false;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];

  constructor(config: TelegramAdapterConfig) {
    this.bot = new TelegramBot(config.token, { polling: false });

    this.bot.on('message', (msg) => {
      if (!msg.text) return;

      const channelMessage: ChannelMessage = {
        channelType: 'telegram',
        channelId: String(msg.chat.id),
        userId: String(msg.from?.id ?? 'unknown'),
        username: msg.from?.username ?? msg.from?.first_name ?? 'unknown',
        content: msg.text,
        timestamp: new Date(msg.date * 1000).toISOString(),
        replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      };

      for (const handler of this.messageHandlers) {
        handler(channelMessage);
      }
    });
  }

  async connect(): Promise<void> {
    this.bot.startPolling();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.bot.stopPolling();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string, replyTo?: string): Promise<void> {
    const options: TelegramBot.SendMessageOptions = {};
    if (replyTo) {
      options.reply_to_message_id = parseInt(replyTo, 10);
    }
    await this.bot.sendMessage(channelId, content, options);
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/messaging/channels/__tests__/telegram.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/messaging/channels/telegram.ts src/messaging/channels/__tests__/telegram.test.ts
git commit -m "feat: add Telegram channel adapter for messaging gateway"
```

---

## Task 12: SKILL.md Loader

**Files:**
- Create: `src/skills/loader.ts`
- Create: `src/skills/types.ts`
- Test: `src/skills/__tests__/loader.test.ts`

**Step 1: Write the failing test**

```typescript
// src/skills/__tests__/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillLoader } from '../loader.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('SkillLoader', () => {
  let tmpDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
    loader = new SkillLoader([tmpDir]);
  });

  afterEach(async () => {
    loader.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should load a SKILL.md file', async () => {
    await fs.writeFile(path.join(tmpDir, 'greeting.md'), `---
name: greeting
description: Greet the user warmly
triggers:
  - hello
  - hi
  - hey
---

# Greeting Skill

When triggered, respond with a warm, friendly greeting. Include the user's name if known.
`);

    await loader.loadAll();
    const skills = loader.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('greeting');
    expect(skills[0].description).toBe('Greet the user warmly');
    expect(skills[0].triggers).toContain('hello');
  });

  it('should load multiple skills from a directory', async () => {
    await fs.writeFile(path.join(tmpDir, 'skill1.md'), `---
name: skill1
description: First skill
---
Content 1`);

    await fs.writeFile(path.join(tmpDir, 'skill2.md'), `---
name: skill2
description: Second skill
---
Content 2`);

    await loader.loadAll();
    expect(loader.listSkills()).toHaveLength(2);
  });

  it('should get a skill by name', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.md'), `---
name: test-skill
description: A test skill
---
Test content here.`);

    await loader.loadAll();
    const skill = loader.getSkill('test-skill');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('Test content here.');
  });

  it('should return undefined for unknown skill', async () => {
    await loader.loadAll();
    expect(loader.getSkill('nonexistent')).toBeUndefined();
  });

  it('should skip files without valid frontmatter', async () => {
    await fs.writeFile(path.join(tmpDir, 'bad.md'), 'No frontmatter here');
    await loader.loadAll();
    expect(loader.listSkills()).toHaveLength(0);
  });

  it('should load from multiple directories', async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test2-'));
    const multiLoader = new SkillLoader([tmpDir, tmpDir2]);

    await fs.writeFile(path.join(tmpDir, 's1.md'), `---\nname: s1\ndescription: d1\n---\nc1`);
    await fs.writeFile(path.join(tmpDir2, 's2.md'), `---\nname: s2\ndescription: d2\n---\nc2`);

    await multiLoader.loadAll();
    expect(multiLoader.listSkills()).toHaveLength(2);

    await fs.rm(tmpDir2, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/skills/__tests__/loader.test.ts`
Expected: FAIL — module `../loader.js` does not exist

**Step 3: Write the types**

```typescript
// src/skills/types.ts
export interface Skill {
  name: string;
  description: string;
  content: string;
  triggers?: string[];
  filePath: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string[];
}
```

**Step 4: Write the implementation**

```typescript
// src/skills/loader.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Skill, SkillFrontmatter } from './types.js';

export class SkillLoader {
  private directories: string[];
  private skills: Map<string, Skill> = new Map();
  private watchers: Array<{ close(): void }> = [];

  constructor(directories: string[]) {
    this.directories = directories;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();

    for (const dir of this.directories) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(dir, file);
          await this.loadSkillFile(filePath);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }

  private async loadSkillFile(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = this.parseFrontmatter(raw);
    if (!parsed) return;

    const { frontmatter, content } = parsed;
    if (!frontmatter.name || !frontmatter.description) return;

    this.skills.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      content: content.trim(),
      triggers: frontmatter.triggers,
      filePath,
    });
  }

  private parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;

    const yamlBlock = match[1];
    const content = match[2];

    // Simple YAML parser for frontmatter (name, description, triggers)
    const frontmatter: Record<string, unknown> = {};
    let currentKey = '';
    let inArray = false;
    const arrayItems: string[] = [];

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (inArray && trimmed.startsWith('- ')) {
        arrayItems.push(trimmed.slice(2).trim());
        continue;
      }

      if (inArray) {
        frontmatter[currentKey] = [...arrayItems];
        arrayItems.length = 0;
        inArray = false;
      }

      const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        if (value === '') {
          currentKey = key;
          inArray = true;
        } else {
          frontmatter[key] = value;
        }
      }
    }

    if (inArray) {
      frontmatter[currentKey] = [...arrayItems];
    }

    return {
      frontmatter: frontmatter as unknown as SkillFrontmatter,
      content,
    };
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/skills/__tests__/loader.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/skills/
git commit -m "feat: add SKILL.md loader with frontmatter parsing"
```

---

## Task 13: Skill MCP Tools

**Files:**
- Create: `src/mcp/skill-tools.ts`
- Test: `src/mcp/__tests__/skill-tools.test.ts`
- Modify: `src/mcp/server.ts` (wire in)

**Step 1: Write the failing test**

```typescript
// src/mcp/__tests__/skill-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSkillTools } from '../skill-tools.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ToolHandler } from '../tools.js';

describe('skill MCP tools', () => {
  let tmpDir: string;
  let tools: Map<string, ToolHandler>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tools-test-'));

    await fs.writeFile(path.join(tmpDir, 'greet.md'), `---
name: greet
description: Greet the user
triggers:
  - hello
  - hi
---
Respond with a friendly greeting.`);

    const result = await createSkillTools({ directories: [tmpDir] });
    tools = result.tools;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register list_skills and get_skill tools', () => {
    expect(tools.has('list_skills')).toBe(true);
    expect(tools.has('get_skill')).toBe(true);
  });

  it('list_skills should return loaded skills', async () => {
    const handler = tools.get('list_skills')!;
    const result = await handler.handler({}) as { skills: Array<{ name: string }> };
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('greet');
  });

  it('get_skill should return skill content', async () => {
    const handler = tools.get('get_skill')!;
    const result = await handler.handler({ name: 'greet' }) as { skill: { content: string } };
    expect(result.skill.content).toContain('friendly greeting');
  });

  it('get_skill should return error for unknown skill', async () => {
    const handler = tools.get('get_skill')!;
    const result = await handler.handler({ name: 'nonexistent' }) as { error: string };
    expect(result.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/mcp/__tests__/skill-tools.test.ts`
Expected: FAIL — module `../skill-tools.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/mcp/skill-tools.ts
import type { ToolHandler } from './tools.js';
import { SkillLoader } from '../skills/loader.js';

export interface SkillToolsConfig {
  directories: string[];
}

export async function createSkillTools(config: SkillToolsConfig): Promise<{ tools: Map<string, ToolHandler>; loader: SkillLoader }> {
  const loader = new SkillLoader(config.directories);
  await loader.loadAll();

  const tools = new Map<string, ToolHandler>();

  tools.set('list_skills', {
    description: 'List all loaded SKILL.md skills',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const skills = loader.listSkills();
      return {
        skills: skills.map(s => ({
          name: s.name,
          description: s.description,
          triggers: s.triggers,
          filePath: s.filePath,
        })),
        count: skills.length,
      };
    },
  });

  tools.set('get_skill', {
    description: 'Get a specific SKILL.md skill by name, including its full content',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name' },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const name = args.name as string;
      const skill = loader.getSkill(name);
      if (!skill) {
        return { error: `Skill not found: ${name}`, available: loader.listSkills().map(s => s.name) };
      }
      return { skill };
    },
  });

  return { tools, loader };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/mcp/__tests__/skill-tools.test.ts`
Expected: PASS

**Step 5: Wire into MCP server**

Modify `src/mcp/server.ts` — add import:
```typescript
import { createSkillTools } from './skill-tools.js';
```

Add to `createToolHandlers()`:
```typescript
const skillDirs = [
  path.join(os.homedir(), '.openclaw', 'skills'),
  path.join(os.homedir(), 'claudecluster', 'skills'),
].filter(d => fs.existsSync(d));  // Note: use fs.existsSync from 'fs' (not promises)
const { tools: skillTools, loader } = await createSkillTools({ directories: skillDirs });
this.skillLoader = loader;
for (const [name, handler] of skillTools) {
  clusterTools.set(name, handler);
}
```

Note: `createToolHandlers` will need to become `async` if it isn't already. Check and adjust.

**Step 6: Commit**

```bash
cd ~/claudecluster
git add src/mcp/skill-tools.ts src/mcp/__tests__/skill-tools.test.ts src/mcp/server.ts
git commit -m "feat: add SKILL.md MCP tools (list_skills, get_skill)"
```

---

## Task 14: Messaging Gateway (Raft-Aware)

**Files:**
- Create: `src/messaging/gateway.ts`
- Test: `src/messaging/__tests__/gateway.test.ts`

**Step 1: Write the failing test**

```typescript
// src/messaging/__tests__/gateway.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagingGateway } from '../gateway.js';
import { EventEmitter } from 'events';
import type { ChannelAdapter, ChannelMessage } from '../types.js';

function createMockAdapter(name: string): ChannelAdapter {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRaft(): EventEmitter & { isLeader: () => boolean } {
  const emitter = new EventEmitter() as EventEmitter & { isLeader: () => boolean };
  emitter.isLeader = vi.fn().mockReturnValue(false);
  return emitter;
}

describe('MessagingGateway', () => {
  let gateway: MessagingGateway;
  let discord: ChannelAdapter;
  let telegram: ChannelAdapter;
  let raft: ReturnType<typeof createMockRaft>;

  beforeEach(() => {
    discord = createMockAdapter('discord');
    telegram = createMockAdapter('telegram');
    raft = createMockRaft();

    gateway = new MessagingGateway({
      adapters: [discord, telegram],
      raft,
      agentName: 'Cipher',
      onMessage: vi.fn(),
    });
  });

  it('should start adapters when becoming leader', async () => {
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(true);
    raft.emit('stateChange', 'leader', 1);

    // Give async handler time to run
    await new Promise(r => setTimeout(r, 50));

    expect(discord.connect).toHaveBeenCalled();
    expect(telegram.connect).toHaveBeenCalled();
  });

  it('should stop adapters when losing leadership', async () => {
    // First become leader
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (discord.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (telegram.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    raft.emit('stateChange', 'leader', 1);
    await new Promise(r => setTimeout(r, 50));

    // Then lose leadership
    (raft.isLeader as ReturnType<typeof vi.fn>).mockReturnValue(false);
    raft.emit('stateChange', 'follower', 2);
    await new Promise(r => setTimeout(r, 50));

    expect(discord.disconnect).toHaveBeenCalled();
    expect(telegram.disconnect).toHaveBeenCalled();
  });

  it('should not start adapters when not leader', () => {
    raft.emit('stateChange', 'follower', 1);
    expect(discord.connect).not.toHaveBeenCalled();
    expect(telegram.connect).not.toHaveBeenCalled();
  });

  it('should report gateway status', () => {
    const status = gateway.getStatus();
    expect(status.agentName).toBe('Cipher');
    expect(status.isActive).toBe(false);
    expect(status.channels).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/claudecluster && npx vitest run src/messaging/__tests__/gateway.test.ts`
Expected: FAIL — module `../gateway.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/messaging/gateway.ts
import { EventEmitter } from 'events';
import type { ChannelAdapter, ChannelMessage } from './types.js';

export interface MessagingGatewayConfig {
  adapters: ChannelAdapter[];
  raft: EventEmitter & { isLeader(): boolean };
  agentName: string;
  onMessage: (message: ChannelMessage) => void;
}

export interface GatewayStatus {
  agentName: string;
  isActive: boolean;
  channels: Array<{
    name: string;
    connected: boolean;
  }>;
}

export class MessagingGateway {
  private adapters: ChannelAdapter[];
  private raft: EventEmitter & { isLeader(): boolean };
  private agentName: string;
  private onMessage: (message: ChannelMessage) => void;
  private active = false;

  constructor(config: MessagingGatewayConfig) {
    this.adapters = config.adapters;
    this.raft = config.raft;
    this.agentName = config.agentName;
    this.onMessage = config.onMessage;

    // Register message handlers on all adapters
    for (const adapter of this.adapters) {
      adapter.onMessage((message) => {
        this.onMessage(message);
      });
    }

    // Listen for Raft state changes
    this.raft.on('stateChange', (state: string) => {
      if (state === 'leader') {
        this.activate().catch(() => {});
      } else if (this.active) {
        this.deactivate().catch(() => {});
      }
    });
  }

  private async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;

    const results = await Promise.allSettled(
      this.adapters.map(a => a.connect()),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        // Log but don't fail — some channels might be misconfigured
        console.error(`Failed to connect ${this.adapters[i].name}:`, reason);
      }
    }
  }

  private async deactivate(): Promise<void> {
    if (!this.active) return;
    this.active = false;

    await Promise.allSettled(
      this.adapters.filter(a => a.isConnected()).map(a => a.disconnect()),
    );
  }

  getStatus(): GatewayStatus {
    return {
      agentName: this.agentName,
      isActive: this.active,
      channels: this.adapters.map(a => ({
        name: a.name,
        connected: a.isConnected(),
      })),
    };
  }

  async stop(): Promise<void> {
    await this.deactivate();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ~/claudecluster && npx vitest run src/messaging/__tests__/gateway.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/claudecluster
git add src/messaging/gateway.ts src/messaging/__tests__/gateway.test.ts
git commit -m "feat: add Raft-aware messaging gateway with automatic failover"
```

---

## Task 15: Wire Everything into ClaudeCluster Main Class

**Files:**
- Modify: `src/index.ts`
- Modify: `config/default.yaml`

**Step 1: Add messaging and provider config to `default.yaml`**

Append to `config/default.yaml`:
```yaml
messaging:
  enabled: false
  agent: "Cipher"
  inboxPath: "~/.claudecluster/inbox"
  channels:
    discord:
      enabled: false
      token: ${DISCORD_BOT_TOKEN}
      guildId: ""
    telegram:
      enabled: false
      token: ${TELEGRAM_BOT_TOKEN}

providers:
  primary: anthropic
  fallback:
    - ollama
  anthropic:
    model: claude-sonnet-4-6
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    model: gpt-4o
    apiKey: ${OPENAI_API_KEY}
  ollama:
    model: llama3
    baseUrl: http://localhost:11434

skills:
  enabled: false
  directories:
    - ~/.openclaw/skills
    - ~/claudecluster/skills
  hotReload: false
```

**Step 2: Add imports to `src/index.ts`**

```typescript
import { MessagingGateway } from './messaging/gateway.js';
import { Inbox } from './messaging/inbox.js';
import { DiscordAdapter } from './messaging/channels/discord.js';
import { TelegramAdapter } from './messaging/channels/telegram.js';
import { ProviderRouter } from './providers/router.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { SkillLoader } from './skills/loader.js';
```

**Step 3: Add component fields to ClaudeCluster class**

```typescript
private messagingGateway: MessagingGateway | null = null;
private inbox: Inbox | null = null;
private providerRouter: ProviderRouter | null = null;
private skillLoader: SkillLoader | null = null;
```

**Step 4: Add initialization methods**

After `initializeKubernetes()` in `start()`, add:
```typescript
await this.initializeProviders();
await this.initializeMessaging();
await this.initializeSkills();
```

Add the methods:
```typescript
private async initializeProviders(): Promise<void> {
  const provConfig = this.config.providers;
  if (!provConfig) return;

  const providers: Record<string, LLMProvider> = {};
  if (provConfig.anthropic) {
    providers.anthropic = new AnthropicProvider({
      apiKey: provConfig.anthropic.apiKey,
      model: provConfig.anthropic.model,
    });
  }
  if (provConfig.openai) {
    providers.openai = new OpenAIProvider({
      apiKey: provConfig.openai.apiKey,
      model: provConfig.openai.model,
    });
  }
  if (provConfig.ollama) {
    providers.ollama = new OllamaProvider({
      baseUrl: provConfig.ollama.baseUrl,
      model: provConfig.ollama.model,
    });
  }

  const primary = providers[provConfig.primary];
  if (!primary) return;

  const fallback = (provConfig.fallback ?? [])
    .map(name => providers[name])
    .filter(Boolean);

  this.providerRouter = new ProviderRouter({ primary, fallback });
  this.logger.info('Provider router initialized', {
    primary: provConfig.primary,
    fallback: provConfig.fallback,
  });
}

private async initializeMessaging(): Promise<void> {
  const msgConfig = this.config.messaging;
  if (!msgConfig?.enabled) return;

  const adapters: ChannelAdapter[] = [];

  if (msgConfig.channels?.discord?.enabled && msgConfig.channels.discord.token) {
    adapters.push(new DiscordAdapter({
      token: msgConfig.channels.discord.token,
      guildId: msgConfig.channels.discord.guildId,
    }));
  }

  if (msgConfig.channels?.telegram?.enabled && msgConfig.channels.telegram.token) {
    adapters.push(new TelegramAdapter({
      token: msgConfig.channels.telegram.token,
    }));
  }

  if (adapters.length === 0) {
    this.logger.warn('Messaging enabled but no channels configured');
    return;
  }

  const inboxPath = msgConfig.inboxPath?.replace('~', os.homedir()) ?? path.join(os.homedir(), '.claudecluster', 'inbox');
  this.inbox = new Inbox(inboxPath);

  this.messagingGateway = new MessagingGateway({
    adapters,
    raft: this.raft!,
    agentName: msgConfig.agent ?? 'Cipher',
    onMessage: async (message) => {
      // Log incoming messages to inbox
      await this.inbox!.writeMessage({
        from: `${message.channelType}:${message.username}`,
        to: msgConfig.agent ?? 'Cipher',
        content: message.content,
        type: 'info',
      });
      this.logger.info('Incoming message', { channel: message.channelType, from: message.username });
    },
  });

  this.logger.info('Messaging gateway initialized', {
    agent: msgConfig.agent,
    channels: adapters.map(a => a.name),
  });
}

private async initializeSkills(): Promise<void> {
  const skillConfig = this.config.skills;
  if (!skillConfig?.enabled) return;

  const dirs = (skillConfig.directories ?? []).map(d => d.replace('~', os.homedir()));
  this.skillLoader = new SkillLoader(dirs);
  await this.skillLoader.loadAll();
  this.logger.info('Skills loaded', { count: this.skillLoader.listSkills().length });
}
```

**Step 5: Add to `stop()` method**

```typescript
await this.messagingGateway?.stop();
this.skillLoader?.stop();
```

**Step 6: Build and verify compilation**

Run: `cd ~/claudecluster && npm run build`
Expected: Compiles without errors

**Step 7: Commit**

```bash
cd ~/claudecluster
git add src/index.ts config/default.yaml
git commit -m "feat: wire messaging gateway, providers, and skills into ClaudeCluster"
```

---

## Task 16: Update ClusterConfig Type

**Files:**
- Modify: `src/index.ts` (or wherever `ClusterConfig` is defined)

**Step 1: Find and update the ClusterConfig interface**

Search for where `ClusterConfig` is defined. Add:

```typescript
messaging?: {
  enabled: boolean;
  agent?: string;
  inboxPath?: string;
  channels?: {
    discord?: { enabled: boolean; token?: string; guildId?: string };
    telegram?: { enabled: boolean; token?: string };
  };
};

providers?: {
  primary: string;
  fallback?: string[];
  anthropic?: { model?: string; apiKey?: string };
  openai?: { model?: string; apiKey?: string; baseUrl?: string };
  ollama?: { model?: string; baseUrl?: string };
};

skills?: {
  enabled: boolean;
  directories?: string[];
  hotReload?: boolean;
};
```

**Step 2: Build and verify**

Run: `cd ~/claudecluster && npm run build`
Expected: Compiles without errors

**Step 3: Commit**

```bash
cd ~/claudecluster
git add src/
git commit -m "feat: add messaging, providers, and skills to ClusterConfig type"
```

---

## Task 17: Integration Test — Full Stack

**Files:**
- Create: `src/__tests__/integration/messaging-integration.test.ts`

**Step 1: Write the integration test**

```typescript
// src/__tests__/integration/messaging-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Inbox } from '../../messaging/inbox.js';
import { createMessagingTools } from '../../mcp/messaging-tools.js';
import { ProviderRouter } from '../../providers/router.js';
import { SkillLoader } from '../../skills/loader.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('messaging integration', () => {
  let tmpDir: string;
  let inboxDir: string;
  let skillsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-'));
    inboxDir = path.join(tmpDir, 'inbox');
    skillsDir = path.join(tmpDir, 'skills');
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should send and receive messages through MCP tools', async () => {
    const { tools } = createMessagingTools({ inboxPath: inboxDir });

    // Send a message
    const sendResult = await tools.get('messaging_send')!.handler({
      from: 'claudecode',
      to: 'cipher',
      content: 'Integration test message',
      type: 'info',
    }) as { messageId: string };

    expect(sendResult.messageId).toBeDefined();

    // Check for new messages
    const checkResult = await tools.get('messaging_check')!.handler({}) as { count: number; messages: unknown[] };
    expect(checkResult.count).toBe(1);

    // List conversations
    const listResult = await tools.get('messaging_list')!.handler({}) as { count: number };
    expect(listResult.count).toBe(1);

    // Get specific message
    const getResult = await tools.get('messaging_get')!.handler({
      messageId: sendResult.messageId,
    }) as { message: { content: string } };
    expect(getResult.message.content).toBe('Integration test message');
  });

  it('should load skills and expose them via MCP tools', async () => {
    await fs.writeFile(path.join(skillsDir, 'test.md'), `---
name: integration-test
description: Integration test skill
---
This is the skill content.`);

    const loader = new SkillLoader([skillsDir]);
    await loader.loadAll();

    expect(loader.listSkills()).toHaveLength(1);
    expect(loader.getSkill('integration-test')?.content).toContain('skill content');
  });

  it('should create a provider router and list providers', () => {
    const mockProvider = {
      name: 'mock',
      chat: async () => ({ content: '', model: 'mock', usage: { inputTokens: 0, outputTokens: 0 } }),
      stream: async function* () { yield { content: '', done: true }; },
      models: async () => ['mock-1'],
      isAvailable: async () => true,
    };

    const router = new ProviderRouter({ primary: mockProvider, fallback: [] });
    expect(router.listProviders()).toEqual(['mock']);
  });
});
```

**Step 2: Run integration test**

Run: `cd ~/claudecluster && npx vitest run src/__tests__/integration/messaging-integration.test.ts`
Expected: PASS

**Step 3: Run all tests**

Run: `cd ~/claudecluster && npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
cd ~/claudecluster
git add src/__tests__/
git commit -m "test: add messaging integration tests"
```

---

## Task 18: Deploy & Live Test

This task requires manual verification and is NOT automated.

**Step 1: Get bot tokens from KeePass**

```bash
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "/APIs/Discord Bot Token" -s'
ssh paschal@192.168.1.138 'printf "anvil2026\n" | keepassxc-cli show /home/paschal/Passwords/Passwords.kdbx "/APIs/Telegram Bot Token" -s'
```

If tokens are not in KeePass yet, extract from OpenClaw config on terminus first.

**Step 2: Update config with real tokens**

Edit `config/default.yaml` — set `messaging.enabled: true` and fill in real tokens (or use env vars).

**Step 3: Build and start**

```bash
cd ~/claudecluster && npm run build && npm start
```

**Step 4: Test Discord bot**

Send a message to @DALEK in the configured Discord guild. Verify:
- Bot receives the message (check logs)
- Message appears in inbox directory

**Step 5: Test Telegram bot**

Send a message to @Cipher1112222Bot. Verify same.

**Step 6: Test Raft failover**

If forge is running claudecluster:
1. Stop the leader node
2. Verify the other node takes over as leader
3. Verify bots reconnect on the new leader

---

## Task 19: Uninstall OpenClaw & Clean Up

**Prerequisite:** All tests in Task 18 pass.

**Step 1: Stop OpenClaw on terminus**

```bash
ssh paschal@100.120.202.76 "systemctl --user stop openclaw-gateway && systemctl --user disable openclaw-gateway"
```

**Step 2: Remove OpenClaw binaries and config**

```bash
ssh paschal@100.120.202.76 "rm -rf ~/.local/bin/openclaw ~/openclaw ~/.openclaw"
```

**Step 3: Remove agent-mcp from forge**

```bash
ssh paschal@192.168.1.200 "rm -rf /work/ai/agent-mcp"
```

**Step 4: Update MCP config**

Remove agent-mcp entries from `~/.claude/mcp.json` on all machines.

**Step 5: Update cerebrus context**

```bash
ssh paschal@192.168.1.138 "psql -U cerebrus -d cerebrus -c \"UPDATE timeline.context SET value = '{\"status\": \"migrated_to_claudecluster\", \"date\": \"2026-02-18\"}' WHERE key = 'infra:openclaw'\""
```

**Step 6: Commit final state**

```bash
cd ~/claudecluster
git add -A
git commit -m "feat: complete OpenClaw integration — messaging, providers, skills all live"
```

---

## Summary

| Task | Component | New Files | Tests |
|------|-----------|-----------|-------|
| 1 | SSH access | 0 | 0 |
| 2 | Source copy + license | ~N (copied) | 0 |
| 3 | LLM Provider types | 2 | 1 |
| 4 | Anthropic provider | 2 | 1 |
| 5 | OpenAI provider | 2 | 1 |
| 6 | Ollama provider | 2 | 1 |
| 7 | Provider router | 3 | 1 |
| 8 | Inbox operations | 3 | 1 |
| 9 | Messaging MCP tools | 2 | 1 |
| 10 | Discord adapter | 2 | 1 |
| 11 | Telegram adapter | 2 | 1 |
| 12 | SKILL.md loader | 3 | 1 |
| 13 | Skill MCP tools | 2 | 1 |
| 14 | Messaging gateway | 2 | 1 |
| 15 | Wire into main class | 2 (modified) | 0 |
| 16 | ClusterConfig type | 1 (modified) | 0 |
| 17 | Integration tests | 1 | 1 |
| 18 | Live deploy + test | 0 | manual |
| 19 | Uninstall + cleanup | 0 | 0 |

**Total: ~30 new files, 12 test files, 19 tasks**
