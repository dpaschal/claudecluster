# Kubernetes Task Integration Design

## Goal

Integrate K8s job execution with the task system so K8s jobs flow through the scheduler like other task types.

## Architecture

```
TaskScheduler.submit(k8s_job)
    ↓
Validate & Queue
    ↓
scheduleNext() detects k8s_job
    ↓
dispatchK8sJob() [new method]
    ↓
KubernetesAdapter.submitJob()
    ↓
Poll status & stream logs
    ↓
handleTaskCompletion()
```

## Implementation

### 1. TaskExecutor K8s Case

Add to `src/agent/task-executor.ts`:

```typescript
// Add import
import { KubernetesAdapter } from '../kubernetes/adapter';

// Add to constructor config
k8sAdapter?: KubernetesAdapter;

// Add case in execute()
case 'k8s_job':
  result = await this.executeK8sJob(spec, running);
  break;

// New method
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

  try {
    // Submit job
    const jobName = await this.config.k8sAdapter.submitJob(k8sSpec.clusterContext, {
      name: spec.taskId,
      namespace: k8sSpec.namespace ?? 'default',
      image: k8sSpec.image,
      command: k8sSpec.command,
      labels: k8sSpec.labels,
      cpuLimit: k8sSpec.resources?.cpuCores?.toString(),
      memoryLimit: k8sSpec.resources?.memoryBytes ?
        `${Math.floor(k8sSpec.resources.memoryBytes / 1e6)}Mi` : undefined,
    });

    // Poll for completion
    let status = await this.config.k8sAdapter.getJobStatus(k8sSpec.clusterContext, jobName);

    while (status.active > 0) {
      await new Promise(r => setTimeout(r, 2000));

      if (running.cancelled) {
        await this.config.k8sAdapter.deleteJob(k8sSpec.clusterContext, jobName);
        break;
      }

      status = await this.config.k8sAdapter.getJobStatus(k8sSpec.clusterContext, jobName);
    }

    // Get logs
    const logs = await this.config.k8sAdapter.getJobLogs(k8sSpec.clusterContext, jobName);
    running.stdout.push(Buffer.from(logs));
    this.emitOutput(spec.taskId, 'stdout', Buffer.from(logs));

    const success = status.succeeded > 0 && !running.cancelled;

    return {
      taskId: spec.taskId,
      success,
      exitCode: success ? 0 : 1,
      stdout: Buffer.concat(running.stdout),
      stderr: Buffer.concat(running.stderr),
      error: running.cancelled ? 'Task cancelled' :
             status.failed > 0 ? `Job failed: ${status.conditions?.[0]?.message}` : undefined,
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

### 2. Scheduler K8s Dispatch (Optional Enhancement)

For direct K8s dispatch without going through an agent:

```typescript
// In scheduler.ts, modify scheduleTask()
private scheduleTask(spec: TaskSpec): string | null {
  if (spec.type === 'k8s_job') {
    return this.scheduleK8sTask(spec);
  }
  // ... existing logic for other task types
}

private scheduleK8sTask(spec: TaskSpec): string | null {
  const k8sSpec = spec.k8sJob!;

  // Find a node that has access to the target K8s cluster
  // Or handle directly if scheduler has K8s adapter

  // For now, dispatch to any available node with K8s access
  const candidates = this.getCandidateNodes(spec);
  if (candidates.length === 0) return null;

  // Prefer nodes with K8s adapter configured
  this.dispatchTask(spec, candidates[0].nodeId);
  return candidates[0].nodeId;
}
```

## Testing Strategy

### TaskExecutor K8s Tests (8 tests)

```typescript
describe('K8s Job Execution', () => {
  it('should submit K8s job via adapter');
  it('should poll job status until completion');
  it('should stream job logs as output');
  it('should handle job success');
  it('should handle job failure');
  it('should cancel running K8s job');
  it('should return error when adapter not available');
  it('should use correct namespace and resources');
});
```

### Integration Tests (4 tests)

```typescript
describe('Scheduler K8s Integration', () => {
  it('should accept K8s job submission');
  it('should dispatch K8s job to capable node');
  it('should track K8s job status');
  it('should complete K8s job through task lifecycle');
});
```

## Success Criteria

- K8s jobs execute through standard task system
- Job logs stream back to submitter
- Job status tracked in scheduler
- Cancellation works for K8s jobs
- 12 new tests passing
