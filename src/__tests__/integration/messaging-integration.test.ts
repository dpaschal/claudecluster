// src/__tests__/integration/messaging-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Inbox } from '../../messaging/inbox.js';
import { createMessagingTools } from '../../mcp/messaging-tools.js';
import { ProviderRouter } from '../../providers/router.js';
import { SkillLoader } from '../../skills/loader.js';
import type { LLMProvider, ChatResponse, StreamChunk } from '../../providers/types.js';
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

    // List conversations — returns { conversations: string[], count: number }
    const listResult = await tools.get('messaging_list')!.handler({}) as { conversations: string[]; count: number };
    expect(listResult.count).toBe(1);

    // Get specific message
    const getResult = await tools.get('messaging_get')!.handler({
      messageId: sendResult.messageId,
    }) as { message: { content: string } };
    expect(getResult.message.content).toBe('Integration test message');
  });

  it('should load skills and expose them via loader', async () => {
    await fs.writeFile(
      path.join(skillsDir, 'test.md'),
      `---
name: integration-test
description: Integration test skill
---
This is the skill content.`,
    );

    const loader = new SkillLoader([skillsDir]);
    await loader.loadAll();

    expect(loader.listSkills()).toHaveLength(1);
    expect(loader.getSkill('integration-test')?.content).toContain('skill content');

    loader.stop();
  });

  it('should create a provider router and route through primary', async () => {
    const mockProvider: LLMProvider = {
      name: 'mock',
      chat: async () => ({
        content: 'hello from mock',
        model: 'mock-1',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      stream: async function* (): AsyncGenerator<StreamChunk> {
        yield { content: 'hello', done: true };
      },
      models: async () => ['mock-1'],
      isAvailable: async () => true,
    };

    const router = new ProviderRouter({ primary: mockProvider, fallback: [] });
    expect(router.listProviders()).toEqual(['mock']);

    const result = await router.chat([{ role: 'user', content: 'test' }]);
    expect(result.content).toBe('hello from mock');
  });

  it('should fall back to secondary provider when primary fails', async () => {
    const failProvider: LLMProvider = {
      name: 'fail',
      chat: async () => {
        throw new Error('Provider down');
      },
      stream: async function* (): AsyncGenerator<StreamChunk> {
        throw new Error('Provider down');
      },
      models: async () => [],
      isAvailable: async () => false,
    };

    const backupProvider: LLMProvider = {
      name: 'backup',
      chat: async () => ({
        content: 'from backup',
        model: 'backup-1',
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
      stream: async function* (): AsyncGenerator<StreamChunk> {
        yield { content: 'backup', done: true };
      },
      models: async () => ['backup-1'],
      isAvailable: async () => true,
    };

    const router = new ProviderRouter({ primary: failProvider, fallback: [backupProvider] });
    const result = await router.chat([{ role: 'user', content: 'test' }]);
    expect(result.content).toBe('from backup');
  });

  it('should handle inbox message lifecycle', async () => {
    const inbox = new Inbox(inboxDir);

    // Write multiple messages
    const id1 = await inbox.writeMessage({ from: 'alice', to: 'cipher', content: 'hello', type: 'info' });
    const id2 = await inbox.writeMessage({ from: 'bob', to: 'cipher', content: 'world', type: 'task' });

    // Read back
    const msg1 = await inbox.readMessage(id1);
    expect(msg1.from).toBe('alice');
    expect(msg1.content).toBe('hello');

    // List all — returns string[] of IDs
    const all = await inbox.listMessages();
    expect(all).toHaveLength(2);

    // Get new (unread) messages
    const newMsgs = await inbox.getNewMessages();
    expect(newMsgs).toHaveLength(2);

    // Mark read
    await inbox.markRead(id1);
    const unread = await inbox.getNewMessages();
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(id2);
  });
});
