# Raft Consensus Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add comprehensive unit tests for the `RaftNode` class covering state transitions, leader election, log replication, and RPC handlers.

**Architecture:** Unit tests with mocked gRPC dependencies using vitest. Use fake timers for deterministic election/heartbeat testing. Each test creates fresh RaftNode instances with controlled peer configurations.

**Tech Stack:** vitest, vi.fn() mocks, vi.useFakeTimers()

---

### Task 1: Test Setup and Initialization Tests

**Files:**
- Create: `tests/raft.test.ts`

**Step 1: Write test file with setup and initialization tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RaftNode, RaftConfig, RaftState, LogEntryType } from '../src/cluster/raft.js';
import { GrpcClientPool } from '../src/grpc/client.js';
import { Logger } from 'winston';

// Mock the gRPC client module
vi.mock('../src/grpc/client.js', () => ({
  RaftClient: vi.fn().mockImplementation(() => ({
    requestVote: vi.fn(),
    appendEntries: vi.fn(),
  })),
  GrpcClientPool: vi.fn(),
}));

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Mock client pool
const createMockClientPool = (): GrpcClientPool => ({
  getConnection: vi.fn(),
} as unknown as GrpcClientPool);

// Helper to create test node
function createTestNode(overrides?: Partial<RaftConfig>): RaftNode {
  return new RaftNode({
    nodeId: 'node-1',
    logger: createMockLogger(),
    clientPool: createMockClientPool(),
    electionTimeoutMinMs: 150,
    electionTimeoutMaxMs: 300,
    heartbeatIntervalMs: 50,
    ...overrides,
  });
}

describe('RaftNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should start in follower state', () => {
      const node = createTestNode();
      node.start();

      expect(node.getState()).toBe('follower');

      node.stop();
    });

    it('should start with term 0', () => {
      const node = createTestNode();
      node.start();

      expect(node.getCurrentTerm()).toBe(0);

      node.stop();
    });

    it('should have no leader initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.getLeaderId()).toBeNull();

      node.stop();
    });

    it('should not be leader initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.isLeader()).toBe(false);

      node.stop();
    });

    it('should have empty log initially', () => {
      const node = createTestNode();
      node.start();

      expect(node.getLastLogIndex()).toBe(0);
      expect(node.getLastLogTerm()).toBe(0);

      node.stop();
    });
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All 5 initialization tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add initialization tests for RaftNode"
```

---

### Task 2: State Transition Tests

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add state transition tests**

Add after the Initialization describe block:

```typescript
  describe('State Transitions', () => {
    it('should become candidate after election timeout', () => {
      const node = createTestNode();
      node.start();

      expect(node.getState()).toBe('follower');

      // Advance past max election timeout
      vi.advanceTimersByTime(301);

      expect(node.getState()).toBe('candidate');

      node.stop();
    });

    it('should increment term when becoming candidate', () => {
      const node = createTestNode();
      node.start();

      const initialTerm = node.getCurrentTerm();

      vi.advanceTimersByTime(301);

      expect(node.getCurrentTerm()).toBe(initialTerm + 1);

      node.stop();
    });

    it('should emit stateChange event on transition', () => {
      const node = createTestNode();
      const stateChanges: Array<{ state: RaftState; term: number }> = [];

      node.on('stateChange', (state: RaftState, term: number) => {
        stateChanges.push({ state, term });
      });

      node.start();

      // First transition: become follower on start
      expect(stateChanges).toContainEqual({ state: 'follower', term: 0 });

      vi.advanceTimersByTime(301);

      // Second transition: become candidate
      expect(stateChanges).toContainEqual({ state: 'candidate', term: 1 });

      node.stop();
    });

    it('should become follower on higher term', () => {
      const node = createTestNode();
      node.start();

      // Force to candidate
      vi.advanceTimersByTime(301);
      expect(node.getState()).toBe('candidate');

      // Receive AppendEntries with higher term
      node.handleAppendEntries({
        term: 5,
        leaderId: 'node-2',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      expect(node.getState()).toBe('follower');
      expect(node.getCurrentTerm()).toBe(5);

      node.stop();
    });

    it('should reset election timeout on valid AppendEntries', () => {
      const node = createTestNode();
      node.start();

      // Advance part way to election timeout
      vi.advanceTimersByTime(100);

      // Receive heartbeat from leader
      node.handleAppendEntries({
        term: 0,
        leaderId: 'node-2',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      // Advance more - should not trigger election yet
      vi.advanceTimersByTime(200);

      expect(node.getState()).toBe('follower');

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All state transition tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add state transition tests"
```

---

### Task 3: RequestVote RPC Tests

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add RequestVote tests**

Add after State Transitions describe block:

```typescript
  describe('RequestVote RPC', () => {
    it('should grant vote to candidate with current term and up-to-date log', () => {
      const node = createTestNode();
      node.start();

      const response = node.handleRequestVote({
        term: 1,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(true);
      expect(response.term).toBe(1);

      node.stop();
    });

    it('should reject vote if already voted for another candidate', () => {
      const node = createTestNode();
      node.start();

      // First vote
      node.handleRequestVote({
        term: 1,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      // Second vote request in same term
      const response = node.handleRequestVote({
        term: 1,
        candidateId: 'node-3',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(false);

      node.stop();
    });

    it('should grant vote to same candidate again', () => {
      const node = createTestNode();
      node.start();

      // First vote
      node.handleRequestVote({
        term: 1,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      // Same candidate asks again
      const response = node.handleRequestVote({
        term: 1,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(true);

      node.stop();
    });

    it('should reject vote for older term', () => {
      const node = createTestNode();
      node.start();

      // Advance to term 2 by receiving higher term
      node.handleAppendEntries({
        term: 2,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      // Request vote with older term
      const response = node.handleRequestVote({
        term: 1,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(false);
      expect(response.term).toBe(2);

      node.stop();
    });

    it('should update term when receiving higher term vote request', () => {
      const node = createTestNode();
      node.start();

      expect(node.getCurrentTerm()).toBe(0);

      node.handleRequestVote({
        term: 5,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(node.getCurrentTerm()).toBe(5);
      expect(node.getState()).toBe('follower');

      node.stop();
    });

    it('should reject vote for candidate with outdated log', () => {
      const node = createTestNode();
      node.start();

      // Simulate having a log entry by receiving AppendEntries
      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [{ term: 1, index: 1, type: 'noop', data: Buffer.alloc(0) }],
        leaderCommit: 0,
      });

      // Candidate with older log
      const response = node.handleRequestVote({
        term: 2,
        candidateId: 'node-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(false);

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All RequestVote tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add RequestVote RPC tests"
```

---

### Task 4: AppendEntries RPC Tests

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add AppendEntries tests**

Add after RequestVote describe block:

```typescript
  describe('AppendEntries RPC', () => {
    it('should accept empty AppendEntries (heartbeat) from leader', () => {
      const node = createTestNode();
      node.start();

      const response = node.handleAppendEntries({
        term: 0,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      expect(response.success).toBe(true);
      expect(response.term).toBe(0);

      node.stop();
    });

    it('should reject AppendEntries from older term', () => {
      const node = createTestNode();
      node.start();

      // Move to term 2
      node.handleAppendEntries({
        term: 2,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      // Receive from old leader
      const response = node.handleAppendEntries({
        term: 1,
        leaderId: 'old-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      expect(response.success).toBe(false);
      expect(response.term).toBe(2);

      node.stop();
    });

    it('should accept and append new entries', () => {
      const node = createTestNode();
      node.start();

      const response = node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [
          { term: 1, index: 1, type: 'noop', data: Buffer.alloc(0) },
        ],
        leaderCommit: 0,
      });

      expect(response.success).toBe(true);
      expect(node.getLastLogIndex()).toBe(1);
      expect(node.getLastLogTerm()).toBe(1);

      node.stop();
    });

    it('should reject AppendEntries with log gap', () => {
      const node = createTestNode();
      node.start();

      // Try to append entry at index 5 when log is empty
      const response = node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 4,
        prevLogTerm: 1,
        entries: [
          { term: 1, index: 5, type: 'noop', data: Buffer.alloc(0) },
        ],
        leaderCommit: 0,
      });

      expect(response.success).toBe(false);

      node.stop();
    });

    it('should update commit index from leader', () => {
      const node = createTestNode();
      node.start();

      // Add entry
      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [
          { term: 1, index: 1, type: 'noop', data: Buffer.alloc(0) },
        ],
        leaderCommit: 0,
      });

      // Leader commits
      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 1,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 1,
      });

      expect(node.getCommitIndex()).toBe(1);

      node.stop();
    });

    it('should emit entryCommitted when applying entries', () => {
      const node = createTestNode();
      const committed: Array<{ type: LogEntryType }> = [];

      node.on('entryCommitted', (entry: { type: LogEntryType }) => {
        committed.push(entry);
      });

      node.start();

      // Add and commit entry
      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [
          { term: 1, index: 1, type: 'task_submit', data: Buffer.from('{}') },
        ],
        leaderCommit: 1,
      });

      expect(committed).toHaveLength(1);
      expect(committed[0].type).toBe('task_submit');

      node.stop();
    });

    it('should set leaderId on valid AppendEntries', () => {
      const node = createTestNode();
      node.start();

      expect(node.getLeaderId()).toBeNull();

      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      expect(node.getLeaderId()).toBe('node-leader');

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All AppendEntries tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add AppendEntries RPC tests"
```

---

### Task 5: Peer Management Tests

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add peer management tests**

Add after AppendEntries describe block:

```typescript
  describe('Peer Management', () => {
    it('should add peer', () => {
      const node = createTestNode();
      node.start();

      node.addPeer('node-2', '100.0.0.2:50051', true);

      const peers = node.getPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].nodeId).toBe('node-2');
      expect(peers[0].address).toBe('100.0.0.2:50051');
      expect(peers[0].votingMember).toBe(true);

      node.stop();
    });

    it('should not add self as peer', () => {
      const node = createTestNode({ nodeId: 'node-1' });
      node.start();

      node.addPeer('node-1', '100.0.0.1:50051', true);

      const peers = node.getPeers();
      expect(peers).toHaveLength(0);

      node.stop();
    });

    it('should remove peer', () => {
      const node = createTestNode();
      node.start();

      node.addPeer('node-2', '100.0.0.2:50051', true);
      node.addPeer('node-3', '100.0.0.3:50051', true);

      expect(node.getPeers()).toHaveLength(2);

      node.removePeer('node-2');

      const peers = node.getPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].nodeId).toBe('node-3');

      node.stop();
    });

    it('should support non-voting members', () => {
      const node = createTestNode();
      node.start();

      node.addPeer('node-2', '100.0.0.2:50051', false);

      const peers = node.getPeers();
      expect(peers[0].votingMember).toBe(false);

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All peer management tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add peer management tests"
```

---

### Task 6: Leader Election Integration Tests

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add leader election tests with mocked RPC**

Add after Peer Management describe block:

```typescript
  describe('Leader Election', () => {
    it('should become leader with no peers (single node cluster)', () => {
      const node = createTestNode();
      node.start();

      // Trigger election
      vi.advanceTimersByTime(301);

      // With no peers, node needs only its own vote (1 of 1)
      expect(node.getState()).toBe('leader');
      expect(node.isLeader()).toBe(true);
      expect(node.getLeaderId()).toBe('node-1');

      node.stop();
    });

    it('should emit leaderElected when becoming leader', () => {
      const node = createTestNode();
      let electedLeaderId: string | null = null;

      node.on('leaderElected', (leaderId: string) => {
        electedLeaderId = leaderId;
      });

      node.start();
      vi.advanceTimersByTime(301);

      expect(electedLeaderId).toBe('node-1');

      node.stop();
    });

    it('should clear leaderId when becoming candidate', () => {
      const node = createTestNode();
      node.start();

      // Set leader via AppendEntries
      node.handleAppendEntries({
        term: 1,
        leaderId: 'node-leader',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      });

      expect(node.getLeaderId()).toBe('node-leader');

      // Trigger election (move to higher term first to allow new election)
      vi.advanceTimersByTime(301);

      // As candidate, leader is unknown
      expect(node.getLeaderId()).toBeNull();

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All leader election tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add leader election tests"
```

---

### Task 7: Log Replication Tests (Leader Side)

**Files:**
- Modify: `tests/raft.test.ts`

**Step 1: Add log replication tests**

Add after Leader Election describe block:

```typescript
  describe('Log Replication (Leader)', () => {
    it('should append entry to local log when leader', async () => {
      const node = createTestNode();
      node.start();

      // Become leader
      vi.advanceTimersByTime(301);
      expect(node.isLeader()).toBe(true);

      const result = await node.appendEntry('task_submit', Buffer.from('{"task": "test"}'));

      expect(result.success).toBe(true);
      expect(result.index).toBeGreaterThan(0);
      expect(node.getLastLogIndex()).toBe(result.index);

      node.stop();
    });

    it('should reject appendEntry when not leader', async () => {
      const node = createTestNode();
      node.start();

      // Still follower
      expect(node.isLeader()).toBe(false);

      const result = await node.appendEntry('task_submit', Buffer.from('{}'));

      expect(result.success).toBe(false);
      expect(result.index).toBe(-1);

      node.stop();
    });

    it('should append noop entry when becoming leader', () => {
      const node = createTestNode();
      const committed: Array<{ type: LogEntryType }> = [];

      node.on('entryCommitted', (entry: { type: LogEntryType }) => {
        committed.push(entry);
      });

      node.start();

      // Become leader (single node, immediate commit)
      vi.advanceTimersByTime(301);

      // Noop is appended and immediately committed in single-node cluster
      expect(node.getLastLogIndex()).toBeGreaterThan(0);

      node.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts`
Expected: All log replication tests PASS

**Step 3: Commit**

```bash
git add tests/raft.test.ts
git commit -m "test(raft): add log replication tests"
```

---

### Task 8: Run Full Test Suite and Verify Coverage

**Step 1: Run all Raft tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/raft.test.ts --coverage`
Expected: All tests PASS, coverage report generated

**Step 2: Run full test suite to ensure no regressions**

Run: `cd /home/paschal/claudecluster && npm test`
Expected: All tests PASS (raft.test.ts, membership.test.ts, scheduler.test.ts)

**Step 3: Final commit**

```bash
git add -A
git commit -m "test(raft): complete Raft consensus test suite

Adds comprehensive tests for:
- Initialization and state
- State transitions (follower/candidate/leader)
- RequestVote RPC handling
- AppendEntries RPC handling
- Peer management
- Leader election
- Log replication

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Description | Tests Added |
|------|-------------|-------------|
| 1 | Setup + Initialization | 5 |
| 2 | State Transitions | 5 |
| 3 | RequestVote RPC | 6 |
| 4 | AppendEntries RPC | 7 |
| 5 | Peer Management | 4 |
| 6 | Leader Election | 3 |
| 7 | Log Replication | 3 |
| 8 | Verification | - |

**Total: ~33 tests**
