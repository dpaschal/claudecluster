# Raft Consensus Testing Design

## Overview

Add comprehensive unit tests for the `RaftNode` class in `src/cluster/raft.ts`.

## Test Scope

### 1. State Transitions
- Start as follower
- Become candidate on election timeout
- Become leader after winning election
- Step down to follower on higher term

### 2. Leader Election
- Vote for candidate with up-to-date log
- Reject vote if already voted for another
- Win election with majority votes
- Handle split votes / no majority

### 3. Log Replication
- Leader appends entries to local log
- Replicate entries to followers via AppendEntries
- Update commit index on majority replication
- Apply committed entries

### 4. RequestVote/AppendEntries RPCs
- Grant/reject votes based on log and term
- Accept/reject entries based on log consistency
- Update term when receiving higher term

## Test Structure

```
tests/raft.test.ts
├── RaftNode Initialization
│   └── starts as follower, term 0, no leader
├── State Transitions
│   ├── election timeout triggers candidate state
│   ├── winning election triggers leader state
│   └── higher term triggers follower state
├── Leader Election
│   ├── votes for self when becoming candidate
│   ├── requests votes from all peers
│   ├── becomes leader with majority
│   └── stays candidate without majority
├── RequestVote RPC
│   ├── grants vote for up-to-date candidate
│   ├── rejects vote if already voted
│   ├── rejects vote for outdated log
│   └── updates term on higher term request
├── AppendEntries RPC
│   ├── accepts entries from current leader
│   ├── rejects entries from old term
│   ├── rejects entries with log gap
│   └── updates commit index
└── Log Replication
    ├── leader appends entry to local log
    ├── replicates to followers
    └── commits on majority acknowledgment
```

## Mock Setup

### Dependencies to Mock
- `GrpcClientPool` and `RaftClient` - no actual network calls
- `Logger` - silent during tests
- Timers - use `vi.useFakeTimers()` for deterministic election/heartbeat

### Helper Functions
- `createTestNode(overrides?)` - create RaftNode with test defaults
- `createMockPeer(nodeId, voteResponse)` - create peer with canned responses

## Implementation Notes

- Use vitest with fake timers for deterministic timing
- Each test should be independent (fresh node instance)
- Test state via public getters: `getState()`, `getCurrentTerm()`, `isLeader()`
- Test events via `node.on('stateChange', ...)` and `node.on('entryCommitted', ...)`
