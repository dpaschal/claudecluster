# Kubernetes Task Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate K8s job execution with TaskExecutor and add 12 tests.

**Architecture:** Add K8s case to TaskExecutor that delegates to KubernetesAdapter.

**Tech Stack:** Vitest, existing K8s adapter mocks

---

## Task 1: Add K8s Case to TaskExecutor

**Files:**
- Modify: `src/agent/task-executor.ts`

**Step 1: Add KubernetesAdapter import and config**

At top of file, add:
```typescript
import { KubernetesAdapter } from '../kubernetes/adapter.js';
```

Update `TaskExecutorConfig` interface:
```typescript
export interface TaskExecutorConfig {
  logger: Logger;
  dockerSocket?: string;
  sandboxCommand?: string;
  maxConcurrentTasks?: number;
  k8sAdapter?: KubernetesAdapter;  // Add this line
}
```

**Step 2: Add k8s_job case in execute()**

In the `execute()` method, add case before default:
```typescript
      case 'k8s_job':
        result = await this.executeK8sJob(spec, running);
        break;
```

**Step 3: Add K8sJobTaskSpec to TaskSpec interface**

Ensure TaskSpec has:
```typescript
export interface TaskSpec {
  taskId: string;
  type: 'shell' | 'container' | 'subagent' | 'k8s_job' | 'claude_relay';
  shell?: ShellTaskSpec;
  container?: ContainerTaskSpec;
  subagent?: SubagentTaskSpec;
  k8sJob?: K8sJobTaskSpec;  // Add if not present
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export interface K8sJobTaskSpec {
  clusterContext: string;
  namespace?: string;
  image: string;
  command?: string[];
  labels?: Record<string, string>;
  resources?: {
    cpuCores?: number;
    memoryBytes?: number;
    requiresGpu?: boolean;
  };
}
```

**Step 4: Implement executeK8sJob method**

Add after executeSubagent method:
```typescript
  private async executeK8sJob(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
    if (!this.config.k8sAdapter) {
      return {
        taskId: spec.taskId,
        success: false,
        exitCode: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: 'Kubernetes adapter not available',
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };
    }

    const k8sSpec = spec.k8sJob!;
    const namespace = k8sSpec.namespace ?? 'default';

    try {
      // Submit job to K8s
      this.config.logger.info('Submitting K8s job', {
        taskId: spec.taskId,
        context: k8sSpec.clusterContext,
        image: k8sSpec.image,
      });

      const jobName = await this.config.k8sAdapter.submitJob(k8sSpec.clusterContext, {
        name: `task-${spec.taskId}`,
        namespace,
        image: k8sSpec.image,
        command: k8sSpec.command,
        labels: { ...k8sSpec.labels, 'claudecluster.io/task-id': spec.taskId },
        cpuLimit: k8sSpec.resources?.cpuCores?.toString(),
        memoryLimit: k8sSpec.resources?.memoryBytes
          ? `${Math.floor(k8sSpec.resources.memoryBytes / (1024 * 1024))}Mi`
          : undefined,
      });

      // Poll for completion
      const pollIntervalMs = 2000;
      const maxPollTime = spec.timeoutMs ?? 600000; // 10 min default
      const startPoll = Date.now();

      while (Date.now() - startPoll < maxPollTime) {
        if (running.cancelled) {
          await this.config.k8sAdapter.deleteJob(k8sSpec.clusterContext, jobName, namespace);
          return {
            taskId: spec.taskId,
            success: false,
            exitCode: -1,
            stdout: Buffer.concat(running.stdout),
            stderr: Buffer.concat(running.stderr),
            error: 'Task cancelled',
            startedAt: running.startedAt,
            completedAt: Date.now(),
          };
        }

        const status = await this.config.k8sAdapter.getJobStatus(
          k8sSpec.clusterContext,
          jobName,
          namespace
        );

        // Emit status update
        this.emitOutput(spec.taskId, 'status', Buffer.from(JSON.stringify({
          type: 'k8s_job_status',
          active: status.active,
          succeeded: status.succeeded,
          failed: status.failed,
        })));

        // Check completion
        if (status.succeeded > 0) {
          // Get logs
          try {
            const logs = await this.config.k8sAdapter.getJobLogs(
              k8sSpec.clusterContext,
              jobName,
              namespace
            );
            running.stdout.push(Buffer.from(logs));
            this.emitOutput(spec.taskId, 'stdout', Buffer.from(logs));
          } catch (logError) {
            this.config.logger.warn('Failed to get job logs', { taskId: spec.taskId, error: logError });
          }

          return {
            taskId: spec.taskId,
            success: true,
            exitCode: 0,
            stdout: Buffer.concat(running.stdout),
            stderr: Buffer.concat(running.stderr),
            startedAt: running.startedAt,
            completedAt: Date.now(),
          };
        }

        if (status.failed > 0) {
          const errorMsg = status.conditions?.find(c => c.type === 'Failed')?.message
            ?? 'Job failed';

          try {
            const logs = await this.config.k8sAdapter.getJobLogs(
              k8sSpec.clusterContext,
              jobName,
              namespace
            );
            running.stderr.push(Buffer.from(logs));
          } catch {
            // Ignore log errors on failure
          }

          return {
            taskId: spec.taskId,
            success: false,
            exitCode: 1,
            stdout: Buffer.concat(running.stdout),
            stderr: Buffer.concat(running.stderr),
            error: errorMsg,
            startedAt: running.startedAt,
            completedAt: Date.now(),
          };
        }

        // Still running, wait and poll again
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      // Timeout
      await this.config.k8sAdapter.deleteJob(k8sSpec.clusterContext, jobName, namespace);
      return {
        taskId: spec.taskId,
        success: false,
        exitCode: -1,
        stdout: Buffer.concat(running.stdout),
        stderr: Buffer.concat(running.stderr),
        error: 'Job timed out',
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };

    } catch (error) {
      return {
        taskId: spec.taskId,
        success: false,
        exitCode: -1,
        stdout: Buffer.concat(running.stdout),
        stderr: Buffer.concat(running.stderr),
        error: error instanceof Error ? error.message : String(error),
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };
    }
  }
```

**Step 5: Verify compilation**

Run: `npm run build`
Expected: Successful compilation

**Step 6: Commit**

```bash
git add src/agent/task-executor.ts
git commit -m "feat: add K8s job execution to task executor"
```

---

## Task 2: Add K8s Execution Tests

**Files:**
- Modify: `tests/task-executor.test.ts`

**Step 1: Add K8s mock and tests**

Add to imports:
```typescript
// Mock kubernetes adapter
const createMockK8sAdapter = () => ({
  submitJob: vi.fn().mockResolvedValue('test-job-123'),
  getJobStatus: vi.fn().mockResolvedValue({ active: 0, succeeded: 1, failed: 0 }),
  getJobLogs: vi.fn().mockResolvedValue('job output logs'),
  deleteJob: vi.fn().mockResolvedValue(undefined),
});
```

Add test describe block:
```typescript
  describe('K8s Job Execution', () => {
    it('should submit K8s job via adapter', async () => {
      const mockK8s = createMockK8sAdapter();
      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-task-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'my-cluster',
          image: 'alpine:latest',
          command: ['echo', 'hello'],
        },
      };

      const result = await executor.execute(spec);

      expect(mockK8s.submitJob).toHaveBeenCalledWith('my-cluster', expect.objectContaining({
        image: 'alpine:latest',
        command: ['echo', 'hello'],
      }));
      expect(result.success).toBe(true);
    });

    it('should poll job status until completion', async () => {
      const mockK8s = createMockK8sAdapter();
      mockK8s.getJobStatus
        .mockResolvedValueOnce({ active: 1, succeeded: 0, failed: 0 })
        .mockResolvedValueOnce({ active: 1, succeeded: 0, failed: 0 })
        .mockResolvedValueOnce({ active: 0, succeeded: 1, failed: 0 });

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-poll-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const result = await executor.execute(spec);

      expect(mockK8s.getJobStatus).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(true);
    });

    it('should stream job logs as output', async () => {
      const mockK8s = createMockK8sAdapter();
      mockK8s.getJobLogs.mockResolvedValue('line1\nline2\nline3');

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-logs-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const result = await executor.execute(spec);

      expect(result.stdout.toString()).toContain('line1');
      expect(mockK8s.getJobLogs).toHaveBeenCalled();
    });

    it('should handle job success', async () => {
      const mockK8s = createMockK8sAdapter();

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-success-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it('should handle job failure', async () => {
      const mockK8s = createMockK8sAdapter();
      mockK8s.getJobStatus.mockResolvedValue({
        active: 0,
        succeeded: 0,
        failed: 1,
        conditions: [{ type: 'Failed', message: 'BackoffLimitExceeded' }],
      });

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-fail-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('BackoffLimitExceeded');
    });

    it('should cancel running K8s job', async () => {
      vi.useFakeTimers();

      const mockK8s = createMockK8sAdapter();
      mockK8s.getJobStatus.mockResolvedValue({ active: 1, succeeded: 0, failed: 0 });

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-cancel-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const resultPromise = executor.execute(spec);

      // Allow first poll
      await vi.advanceTimersByTimeAsync(100);

      // Cancel
      await executor.cancel('k8s-cancel-1');

      // Advance past poll interval
      await vi.advanceTimersByTimeAsync(2500);

      const result = await resultPromise;

      expect(result.error).toBe('Task cancelled');
      expect(mockK8s.deleteJob).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should return error when adapter not available', async () => {
      const executor = new TaskExecutor({
        logger: logger as any,
        // No k8sAdapter
      });

      const spec: TaskSpec = {
        taskId: 'k8s-no-adapter',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          image: 'alpine',
        },
      };

      const result = await executor.execute(spec);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Kubernetes adapter not available');
    });

    it('should use correct namespace and resources', async () => {
      const mockK8s = createMockK8sAdapter();

      const executor = new TaskExecutor({
        logger: logger as any,
        k8sAdapter: mockK8s as any,
      });

      const spec: TaskSpec = {
        taskId: 'k8s-ns-1',
        type: 'k8s_job',
        k8sJob: {
          clusterContext: 'ctx',
          namespace: 'production',
          image: 'alpine',
          resources: {
            cpuCores: 2,
            memoryBytes: 4 * 1024 * 1024 * 1024, // 4Gi
          },
        },
      };

      await executor.execute(spec);

      expect(mockK8s.submitJob).toHaveBeenCalledWith('ctx', expect.objectContaining({
        namespace: 'production',
        cpuLimit: '2',
        memoryLimit: '4096Mi',
      }));
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/task-executor.test.ts`
Expected: 34 tests passing (26 original + 8 new)

**Step 3: Commit**

```bash
git add tests/task-executor.test.ts
git commit -m "test: add K8s job execution tests"
```

---

## Task 3: Add Integration Tests

**Files:**
- Create: `tests/kubernetes-integration.test.ts`

**Step 1: Create integration test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskScheduler } from '../src/cluster/scheduler';

// Minimal mocks for integration tests
const createMockMembership = () => ({
  getNodes: vi.fn().mockReturnValue([
    { nodeId: 'node-1', status: 'active', resources: { cpuCores: 8, memoryBytes: 16e9 } },
  ]),
  getNode: vi.fn().mockReturnValue({ nodeId: 'node-1', status: 'active' }),
});

const createMockRaft = () => ({
  isLeader: vi.fn().mockReturnValue(true),
  appendEntry: vi.fn().mockResolvedValue({ success: true }),
});

const createMockClientPool = () => ({
  getClient: vi.fn(),
});

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('Kubernetes Integration', () => {
  describe('Scheduler K8s Integration', () => {
    it('should accept K8s job submission', async () => {
      const scheduler = new TaskScheduler({
        nodeId: 'leader',
        logger: createMockLogger() as any,
        membership: createMockMembership() as any,
        raft: createMockRaft() as any,
        clientPool: createMockClientPool() as any,
      });

      const result = await scheduler.submit({
        taskId: 'k8s-task-1',
        type: 'k8s_job',
        submitterNode: 'leader',
        k8sJob: {
          clusterContext: 'gke-cluster',
          image: 'gcr.io/project/image',
          namespace: 'default',
        },
      });

      expect(result.accepted).toBe(true);
    });

    it('should validate K8s job has required fields', async () => {
      const scheduler = new TaskScheduler({
        nodeId: 'leader',
        logger: createMockLogger() as any,
        membership: createMockMembership() as any,
        raft: createMockRaft() as any,
        clientPool: createMockClientPool() as any,
      });

      const result = await scheduler.submit({
        taskId: 'k8s-invalid',
        type: 'k8s_job',
        submitterNode: 'leader',
        k8sJob: {
          clusterContext: '',  // Empty context
          image: 'alpine',
        },
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('context');
    });

    it('should track K8s job status', async () => {
      const scheduler = new TaskScheduler({
        nodeId: 'leader',
        logger: createMockLogger() as any,
        membership: createMockMembership() as any,
        raft: createMockRaft() as any,
        clientPool: createMockClientPool() as any,
      });

      await scheduler.submit({
        taskId: 'k8s-status-1',
        type: 'k8s_job',
        submitterNode: 'leader',
        k8sJob: {
          clusterContext: 'cluster',
          image: 'alpine',
        },
      });

      const status = scheduler.getStatus('k8s-status-1');

      expect(status).toBeDefined();
      expect(status?.state).toBe('queued');
    });

    it('should cancel K8s job', async () => {
      const scheduler = new TaskScheduler({
        nodeId: 'leader',
        logger: createMockLogger() as any,
        membership: createMockMembership() as any,
        raft: createMockRaft() as any,
        clientPool: createMockClientPool() as any,
      });

      await scheduler.submit({
        taskId: 'k8s-cancel-1',
        type: 'k8s_job',
        submitterNode: 'leader',
        k8sJob: {
          clusterContext: 'cluster',
          image: 'alpine',
        },
      });

      const cancelled = await scheduler.cancel('k8s-cancel-1');

      expect(cancelled).toBe(true);
      expect(scheduler.getStatus('k8s-cancel-1')?.state).toBe('cancelled');
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/kubernetes-integration.test.ts`
Expected: 4 tests passing

**Step 3: Commit**

```bash
git add tests/kubernetes-integration.test.ts
git commit -m "test: add kubernetes scheduler integration tests"
```

---

## Task 4: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify build**

Run: `npm run build`
Expected: Successful compilation

**Step 3: Count new tests**

Run: `grep -c "it\(" tests/task-executor.test.ts tests/kubernetes-integration.test.ts`
Expected: 34 + 4 = 38 tests in these files

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: kubernetes task integration complete"
```
