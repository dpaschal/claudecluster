# Task Executor Testing Design

## Goal

Add comprehensive unit tests for `TaskExecutor` class with mocked child_process and Docker.

## Scope

**In scope:**
- Unit tests for shell command execution
- Unit tests for container execution (mocked Docker)
- Timeout and cancellation handling
- Output streaming and event emission
- Concurrent task limits
- Error handling

**Out of scope:**
- Integration tests with real Docker (requires Docker daemon)
- Subagent execution (not implemented yet)
- K8s job execution (not implemented)

## Test Structure

**File:** `tests/task-executor.test.ts`

```
describe('TaskExecutor')
  describe('Initialization')           - 2 tests
  describe('Shell Execution')          - 8 tests
  describe('Container Execution')      - 7 tests
  describe('Cancellation')             - 4 tests
  describe('Output Streaming')         - 3 tests
  describe('Concurrency')              - 2 tests
```

**Total: 26 tests**

## Mock Strategy

### child_process.spawn Mock
```typescript
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const createMockProcess = (exitCode = 0, stdout = '', stderr = '') => {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  proc.stdout = new EventEmitter() as any;
  proc.stderr = new EventEmitter() as any;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });

  // Emit output and close after tick
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode, null);
  });

  return proc;
};
```

### Docker Mock
```typescript
const createMockDocker = () => ({
  getImage: vi.fn().mockReturnValue({
    inspect: vi.fn().mockResolvedValue({}),
  }),
  pull: vi.fn(),
  createContainer: vi.fn().mockResolvedValue({
    id: 'container-123',
    attach: vi.fn().mockResolvedValue(new EventEmitter()),
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  getContainer: vi.fn().mockReturnValue({
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  modem: {
    followProgress: vi.fn((stream, cb) => cb(null)),
  },
});
```

## Test Cases

### Initialization (2 tests)
1. Should initialize with default max concurrent tasks of 10
2. Should initialize Docker client when socket provided

### Shell Execution (8 tests)
1. Should execute simple shell command successfully
2. Should capture stdout output
3. Should capture stderr output
4. Should return exit code from process
5. Should pass environment variables to process
6. Should use working directory when specified
7. Should use sandbox command when sandboxed is true
8. Should handle process spawn error

### Container Execution (7 tests)
1. Should execute container successfully
2. Should pull image if not present
3. Should skip pull if image exists
4. Should pass environment variables to container
5. Should configure volume mounts
6. Should return container exit code
7. Should return error when Docker not available

### Cancellation (4 tests)
1. Should cancel running shell task with SIGTERM
2. Should force kill with SIGKILL after timeout
3. Should cancel running container task
4. Should return false for unknown task ID

### Output Streaming (3 tests)
1. Should emit output events for stdout
2. Should emit output events for stderr
3. Should include timestamp in output events

### Concurrency (2 tests)
1. Should track running task IDs
2. Should reject when max concurrent tasks reached

## Success Criteria

- All 26 tests pass
- No regressions in existing tests
- Full coverage of TaskExecutor public API (excluding subagent stub)
