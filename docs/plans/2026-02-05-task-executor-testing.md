# Task Executor Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 26 unit tests for TaskExecutor covering shell, container, cancellation, and output streaming.

**Architecture:** Mock child_process.spawn and dockerode to test executor logic without real processes/containers.

**Tech Stack:** Vitest, vi.mock, EventEmitter mocks

---

## Task 1: Setup and Initialization Tests

**Files:**
- Create: `tests/task-executor.test.ts`

**Step 1: Create test file with mocks**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import { TaskExecutor, TaskSpec, TaskResult } from '../src/agent/task-executor';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock dockerode
vi.mock('dockerode', () => {
  return {
    default: vi.fn(),
  };
});

import { spawn } from 'child_process';
import Docker from 'dockerode';

// Helper to create mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// Helper to create mock process
const createMockProcess = (exitCode = 0, stdout = '', stderr = '') => {
  const proc = new EventEmitter() as ChildProcess & EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: Mock;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    return true;
  });

  setImmediate(() => {
    if (stdout) (proc.stdout as EventEmitter).emit('data', Buffer.from(stdout));
    if (stderr) (proc.stderr as EventEmitter).emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode, null);
  });

  return proc;
};

// Helper to create mock Docker
const createMockDocker = (containerExitCode = 0) => {
  const mockContainer = {
    id: 'container-123',
    attach: vi.fn().mockResolvedValue(new EventEmitter()),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: containerExitCode }),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  return {
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    }),
    pull: vi.fn((image: string, cb: Function) => {
      cb(null, new EventEmitter());
    }),
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue({
      stop: vi.fn().mockResolvedValue(undefined),
    }),
    modem: {
      followProgress: vi.fn((stream: EventEmitter, cb: Function) => cb(null)),
    },
    _mockContainer: mockContainer,
  };
};

describe('TaskExecutor', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  describe('Initialization', () => {
    it('should initialize with default max concurrent tasks of 10', () => {
      const executor = new TaskExecutor({ logger: logger as any });
      // Verify by trying to get running tasks (should be empty initially)
      expect(executor.getRunningTaskIds()).toEqual([]);
    });

    it('should initialize Docker client when socket provided', () => {
      const mockDocker = createMockDocker();
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({
        logger: logger as any,
        dockerSocket: '/var/run/docker.sock',
      });

      expect(Docker).toHaveBeenCalledWith({ socketPath: '/var/run/docker.sock' });
    });
  });
});
```

**Step 2: Run test to verify setup works**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 2 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add task executor initialization tests"
```

---

## Task 2: Shell Execution Tests (Part 1)

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add shell execution tests**

```typescript
  describe('Shell Execution', () => {
    it('should execute simple shell command successfully', async () => {
      const mockProc = createMockProcess(0, 'hello', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-1',
        type: 'shell',
        shell: { command: 'echo hello' },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hello'], expect.any(Object));
    });

    it('should capture stdout output', async () => {
      const mockProc = createMockProcess(0, 'output line 1\noutput line 2', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-2',
        type: 'shell',
        shell: { command: 'cat file.txt' },
      };

      const result = await executor.execute(spec);

      expect(result.stdout.toString()).toBe('output line 1\noutput line 2');
    });

    it('should capture stderr output', async () => {
      const mockProc = createMockProcess(1, '', 'error: file not found');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-3',
        type: 'shell',
        shell: { command: 'cat missing.txt' },
      };

      const result = await executor.execute(spec);

      expect(result.stderr.toString()).toBe('error: file not found');
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should return exit code from process', async () => {
      const mockProc = createMockProcess(42, '', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-4',
        type: 'shell',
        shell: { command: 'exit 42' },
      };

      const result = await executor.execute(spec);

      expect(result.exitCode).toBe(42);
      expect(result.success).toBe(false);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 6 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add shell execution basic tests"
```

---

## Task 3: Shell Execution Tests (Part 2)

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add remaining shell tests**

```typescript
    it('should pass environment variables to process', async () => {
      const mockProc = createMockProcess(0, '', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-5',
        type: 'shell',
        shell: { command: 'echo $MY_VAR' },
        environment: { MY_VAR: 'test-value' },
      };

      await executor.execute(spec);

      expect(spawn).toHaveBeenCalledWith(
        '/bin/sh',
        ['-c', 'echo $MY_VAR'],
        expect.objectContaining({
          env: expect.objectContaining({ MY_VAR: 'test-value' }),
        })
      );
    });

    it('should use working directory when specified', async () => {
      const mockProc = createMockProcess(0, '', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-6',
        type: 'shell',
        shell: {
          command: 'pwd',
          workingDirectory: '/tmp/workdir',
        },
      };

      await executor.execute(spec);

      expect(spawn).toHaveBeenCalledWith(
        '/bin/sh',
        ['-c', 'pwd'],
        expect.objectContaining({
          cwd: '/tmp/workdir',
        })
      );
    });

    it('should use sandbox command when sandboxed is true', async () => {
      const mockProc = createMockProcess(0, '', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({
        logger: logger as any,
        sandboxCommand: '/usr/bin/firejail',
      });
      const spec: TaskSpec = {
        taskId: 'task-7',
        type: 'shell',
        shell: {
          command: 'echo hello',
          sandboxed: true,
        },
      };

      await executor.execute(spec);

      expect(spawn).toHaveBeenCalledWith(
        '/usr/bin/firejail',
        ['echo hello'],
        expect.any(Object)
      );
    });

    it('should handle process spawn error', async () => {
      const mockProc = new EventEmitter() as ChildProcess & EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: Mock;
      };
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.killed = false;
      mockProc.kill = vi.fn();

      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-8',
        type: 'shell',
        shell: { command: '/nonexistent' },
      };

      const resultPromise = executor.execute(spec);

      setImmediate(() => {
        mockProc.emit('error', new Error('spawn ENOENT'));
      });

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn ENOENT');
    });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 10 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add shell execution advanced tests"
```

---

## Task 4: Container Execution Tests

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add container execution tests**

```typescript
  describe('Container Execution', () => {
    it('should execute container successfully', async () => {
      const mockDocker = createMockDocker(0);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c1',
        type: 'container',
        container: { image: 'alpine:latest' },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(mockDocker.createContainer).toHaveBeenCalled();
    });

    it('should pull image if not present', async () => {
      const mockDocker = createMockDocker(0);
      mockDocker.getImage = vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('Image not found')),
      });
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c2',
        type: 'container',
        container: { image: 'nginx:latest' },
      };

      await executor.execute(spec);

      expect(mockDocker.pull).toHaveBeenCalledWith('nginx:latest', expect.any(Function));
    });

    it('should skip pull if image exists', async () => {
      const mockDocker = createMockDocker(0);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c3',
        type: 'container',
        container: { image: 'alpine:latest' },
      };

      await executor.execute(spec);

      expect(mockDocker.pull).not.toHaveBeenCalled();
    });

    it('should pass environment variables to container', async () => {
      const mockDocker = createMockDocker(0);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c4',
        type: 'container',
        container: { image: 'alpine:latest' },
        environment: { FOO: 'bar', BAZ: 'qux' },
      };

      await executor.execute(spec);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: ['FOO=bar', 'BAZ=qux'],
        })
      );
    });

    it('should configure volume mounts', async () => {
      const mockDocker = createMockDocker(0);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c5',
        type: 'container',
        container: {
          image: 'alpine:latest',
          mounts: [
            { hostPath: '/data', containerPath: '/mnt/data', readOnly: true },
          ],
        },
      };

      await executor.execute(spec);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Binds: ['/data:/mnt/data:ro'],
          }),
        })
      );
    });

    it('should return container exit code', async () => {
      const mockDocker = createMockDocker(137);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c6',
        type: 'container',
        container: { image: 'alpine:latest' },
      };

      const result = await executor.execute(spec);

      expect(result.exitCode).toBe(137);
      expect(result.success).toBe(false);
    });

    it('should return error when Docker not available', async () => {
      (Docker as unknown as Mock).mockImplementation(() => {
        throw new Error('Docker not available');
      });

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-c7',
        type: 'container',
        container: { image: 'alpine:latest' },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Docker not available');
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 17 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add container execution tests"
```

---

## Task 5: Cancellation Tests

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add cancellation tests**

```typescript
  describe('Cancellation', () => {
    it('should cancel running shell task with SIGTERM', async () => {
      const mockProc = new EventEmitter() as ChildProcess & EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: Mock;
      };
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.killed = false;
      mockProc.kill = vi.fn((signal?: string) => {
        mockProc.killed = true;
        mockProc.emit('close', 143, 'SIGTERM');
        return true;
      });

      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-cancel-1',
        type: 'shell',
        shell: { command: 'sleep 100' },
      };

      const resultPromise = executor.execute(spec);

      // Wait for task to start
      await new Promise(r => setImmediate(r));

      const cancelled = await executor.cancel('task-cancel-1');

      expect(cancelled).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      const result = await resultPromise;
      expect(result.error).toBe('Task cancelled');
    });

    it('should force kill with SIGKILL after timeout', async () => {
      vi.useFakeTimers();

      const mockProc = new EventEmitter() as ChildProcess & EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: Mock;
      };
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.killed = false;
      mockProc.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGKILL') {
          mockProc.killed = true;
          mockProc.emit('close', 137, 'SIGKILL');
        }
        return true;
      });

      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-cancel-2',
        type: 'shell',
        shell: { command: 'sleep 100' },
      };

      const resultPromise = executor.execute(spec);

      await vi.advanceTimersByTimeAsync(1);

      executor.cancel('task-cancel-2');

      // First call is SIGTERM
      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past force kill timeout
      await vi.advanceTimersByTimeAsync(5001);

      // Should have called SIGKILL
      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });

    it('should cancel running container task', async () => {
      const mockDocker = createMockDocker(0);
      const neverResolve = new Promise(() => {});
      mockDocker._mockContainer.wait = vi.fn().mockReturnValue(neverResolve);
      (Docker as unknown as Mock).mockImplementation(() => mockDocker);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-cancel-3',
        type: 'container',
        container: { image: 'alpine:latest' },
      };

      const resultPromise = executor.execute(spec);

      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      const cancelled = await executor.cancel('task-cancel-3');

      expect(cancelled).toBe(true);
      expect(mockDocker.getContainer).toHaveBeenCalledWith('container-123');
    });

    it('should return false for unknown task ID', async () => {
      const executor = new TaskExecutor({ logger: logger as any });

      const cancelled = await executor.cancel('nonexistent-task');

      expect(cancelled).toBe(false);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 21 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add task cancellation tests"
```

---

## Task 6: Output Streaming and Concurrency Tests

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add output streaming tests**

```typescript
  describe('Output Streaming', () => {
    it('should emit output events for stdout', async () => {
      const mockProc = createMockProcess(0, 'streaming output', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const outputs: Array<{ taskId: string; type: string; data: Buffer }> = [];
      executor.on('output', (taskId, output) => {
        outputs.push({ taskId, ...output });
      });

      const spec: TaskSpec = {
        taskId: 'task-stream-1',
        type: 'shell',
        shell: { command: 'echo streaming output' },
      };

      await executor.execute(spec);

      const stdoutOutput = outputs.find(o => o.type === 'stdout');
      expect(stdoutOutput).toBeDefined();
      expect(stdoutOutput!.data.toString()).toBe('streaming output');
    });

    it('should emit output events for stderr', async () => {
      const mockProc = createMockProcess(1, '', 'error output');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const outputs: Array<{ taskId: string; type: string; data: Buffer }> = [];
      executor.on('output', (taskId, output) => {
        outputs.push({ taskId, ...output });
      });

      const spec: TaskSpec = {
        taskId: 'task-stream-2',
        type: 'shell',
        shell: { command: 'cat /nonexistent' },
      };

      await executor.execute(spec);

      const stderrOutput = outputs.find(o => o.type === 'stderr');
      expect(stderrOutput).toBeDefined();
      expect(stderrOutput!.data.toString()).toBe('error output');
    });

    it('should include timestamp in output events', async () => {
      const mockProc = createMockProcess(0, 'test', '');
      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      let outputTimestamp: number | undefined;
      executor.on('output', (taskId, output) => {
        outputTimestamp = output.timestamp;
      });

      const beforeTime = Date.now();
      const spec: TaskSpec = {
        taskId: 'task-stream-3',
        type: 'shell',
        shell: { command: 'echo test' },
      };

      await executor.execute(spec);
      const afterTime = Date.now();

      expect(outputTimestamp).toBeDefined();
      expect(outputTimestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(outputTimestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('Concurrency', () => {
    it('should track running task IDs', async () => {
      const mockProc = new EventEmitter() as ChildProcess & EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: Mock;
      };
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.killed = false;
      mockProc.kill = vi.fn();

      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({ logger: logger as any });
      const spec: TaskSpec = {
        taskId: 'task-concurrent-1',
        type: 'shell',
        shell: { command: 'sleep 10' },
      };

      const resultPromise = executor.execute(spec);

      await new Promise(r => setImmediate(r));

      expect(executor.getRunningTaskIds()).toContain('task-concurrent-1');

      // Complete the task
      mockProc.emit('close', 0, null);
      await resultPromise;

      expect(executor.getRunningTaskIds()).not.toContain('task-concurrent-1');
    });

    it('should reject when max concurrent tasks reached', async () => {
      const mockProc = new EventEmitter() as ChildProcess & EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: Mock;
      };
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      mockProc.killed = false;
      mockProc.kill = vi.fn();

      (spawn as Mock).mockReturnValue(mockProc);

      const executor = new TaskExecutor({
        logger: logger as any,
        maxConcurrentTasks: 2,
      });

      // Start 2 tasks (max)
      const promises = [
        executor.execute({ taskId: 'task-1', type: 'shell', shell: { command: 'sleep 10' } }),
        executor.execute({ taskId: 'task-2', type: 'shell', shell: { command: 'sleep 10' } }),
      ];

      await new Promise(r => setImmediate(r));

      // Third task should be rejected
      await expect(
        executor.execute({ taskId: 'task-3', type: 'shell', shell: { command: 'echo hi' } })
      ).rejects.toThrow('Max concurrent tasks (2) reached');

      // Clean up
      mockProc.emit('close', 0, null);
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 26 tests passing

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add output streaming and concurrency tests"
```

---

## Task 7: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing (existing + new 26)

**Step 2: Verify test file structure**

Run: `grep -c "it\(" tests/task-executor.test.ts`
Expected: 26

**Step 3: Final commit if needed**

If any cleanup needed, commit with:
```bash
git commit -m "test: task executor tests complete"
```
