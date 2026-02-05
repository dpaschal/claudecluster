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

      // Advance more - should not trigger election yet
      vi.advanceTimersByTime(200);

      expect(node.getState()).toBe('follower');

      node.stop();
    });
  });
});
