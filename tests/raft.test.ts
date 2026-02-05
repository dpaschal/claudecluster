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

      // Advance less than minimum election timeout (150ms) - should not trigger election
      vi.advanceTimersByTime(140);

      expect(node.getState()).toBe('follower');

      node.stop();
    });
  });

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
});
