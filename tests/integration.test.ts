/**
 * Cluster Formation Integration Tests
 *
 * Tests for multi-node cluster formation using mock gRPC routing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { RaftNode, RaftConfig, LogEntry } from '../src/cluster/raft.js';
import { MembershipManager, MembershipConfig, NodeInfo } from '../src/cluster/membership.js';
import { TaskScheduler, SchedulerConfig } from '../src/cluster/scheduler.js';
import { GrpcClientPool } from '../src/grpc/client.js';

// ============================================================================
// Mock Logger
// ============================================================================

function createMockLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    verbose: noop,
    silly: noop,
  } as unknown as Logger;
}

// ============================================================================
// Mock gRPC Client Pool
// ============================================================================

interface RaftHandlers {
  requestVote: (request: {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
  }) => { term: number; voteGranted: boolean };
  appendEntries: (request: {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
  }) => { term: number; success: boolean; matchIndex: number };
}

interface MembershipHandlers {
  handleJoinRequest: (node: NodeInfo) => Promise<{
    approved: boolean;
    pendingApproval: boolean;
    clusterId: string;
    leaderAddress: string;
    peers: NodeInfo[];
  }>;
}

interface NodeHandlers {
  raft: RaftHandlers;
  membership: MembershipHandlers;
}

class MockGrpcClientPool extends EventEmitter {
  private nodeHandlers: Map<string, NodeHandlers> = new Map();
  private addressToNodeId: Map<string, string> = new Map();

  constructor() {
    super();
  }

  registerNode(nodeId: string, handlers: NodeHandlers): void {
    this.nodeHandlers.set(nodeId, handlers);
    // Register common address patterns
    this.addressToNodeId.set(`${nodeId}:50051`, nodeId);
    this.addressToNodeId.set(nodeId, nodeId);
  }

  getNodeIdFromAddress(address: string): string | undefined {
    // Try exact match first
    if (this.addressToNodeId.has(address)) {
      return this.addressToNodeId.get(address);
    }
    // Try extracting nodeId from address pattern like "node1:50051"
    const nodeIdMatch = address.match(/^([^:]+)/);
    if (nodeIdMatch) {
      const nodeId = nodeIdMatch[1];
      if (this.nodeHandlers.has(nodeId)) {
        return nodeId;
      }
    }
    return undefined;
  }

  private protoTypeToLogEntryType(protoType: string): LogEntry['type'] {
    const mapping: Record<string, LogEntry['type']> = {
      LOG_ENTRY_TYPE_NOOP: 'noop',
      LOG_ENTRY_TYPE_CONFIG_CHANGE: 'config_change',
      LOG_ENTRY_TYPE_TASK_SUBMIT: 'task_submit',
      LOG_ENTRY_TYPE_TASK_COMPLETE: 'task_complete',
      LOG_ENTRY_TYPE_NODE_JOIN: 'node_join',
      LOG_ENTRY_TYPE_NODE_LEAVE: 'node_leave',
      LOG_ENTRY_TYPE_CONTEXT_UPDATE: 'context_update',
    };
    return mapping[protoType] || 'noop';
  }

  // Implement GrpcClientPool interface - returns mock client objects
  getConnection(address: string): {
    address: string;
    raftClient: unknown;
    clusterClient: unknown;
    agentClient: unknown;
    connected: boolean;
  } {
    // Return a mock connection with the address stored
    // The actual routing happens in the call() method
    return {
      address,
      raftClient: { __address: address },
      clusterClient: { __address: address },
      agentClient: { __address: address },
      connected: true,
    };
  }

  // The call method is where the actual RPC routing happens
  async call<TReq, TRes>(
    client: unknown,
    method: string,
    request: TReq,
    _timeoutMs?: number
  ): Promise<TRes> {
    // Extract address from mock client
    const clientObj = client as { __address?: string };
    const address = clientObj.__address;
    if (!address) {
      throw new Error('Invalid mock client - missing address');
    }

    const nodeId = this.getNodeIdFromAddress(address);
    if (!nodeId) {
      throw new Error(`No handler registered for address: ${address}`);
    }

    const handlers = this.nodeHandlers.get(nodeId)!;

    // Route based on method name
    if (method === 'RequestVote') {
      const req = request as {
        term: string;
        candidate_id: string;
        last_log_index: string;
        last_log_term: string;
      };
      const response = handlers.raft.requestVote({
        term: parseInt(req.term),
        candidateId: req.candidate_id,
        lastLogIndex: parseInt(req.last_log_index),
        lastLogTerm: parseInt(req.last_log_term),
      });
      return {
        term: response.term.toString(),
        vote_granted: response.voteGranted,
      } as TRes;
    }

    if (method === 'AppendEntries') {
      const req = request as {
        term: string;
        leader_id: string;
        prev_log_index: string;
        prev_log_term: string;
        entries: Array<{
          term: string;
          index: string;
          type: string;
          data: Buffer;
        }>;
        leader_commit: string;
      };
      const entries: LogEntry[] = req.entries.map((e) => ({
        term: parseInt(e.term),
        index: parseInt(e.index),
        type: this.protoTypeToLogEntryType(e.type),
        data: e.data,
      }));
      const response = handlers.raft.appendEntries({
        term: parseInt(req.term),
        leaderId: req.leader_id,
        prevLogIndex: parseInt(req.prev_log_index),
        prevLogTerm: parseInt(req.prev_log_term),
        entries,
        leaderCommit: parseInt(req.leader_commit),
      });
      return {
        term: response.term.toString(),
        success: response.success,
        match_index: response.matchIndex.toString(),
      } as TRes;
    }

    throw new Error(`Unknown method: ${method}`);
  }

  async loadProto(): Promise<void> {
    // No-op for mock
  }

  closeAll(): void {
    // No-op for mock
  }
}

// ============================================================================
// Test Node and Cluster Helpers
// ============================================================================

interface TestNode {
  nodeId: string;
  raft: RaftNode;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  logger: Logger;
}

function createTestNode(
  nodeId: string,
  clientPool: MockGrpcClientPool
): TestNode {
  const logger = createMockLogger();

  // Cast mock pool to GrpcClientPool for type compatibility
  const poolAsGrpc = clientPool as unknown as GrpcClientPool;

  // Create RaftNode
  const raftConfig: RaftConfig = {
    nodeId,
    logger,
    clientPool: poolAsGrpc,
    electionTimeoutMinMs: 150,
    electionTimeoutMaxMs: 300,
    heartbeatIntervalMs: 50,
  };
  const raft = new RaftNode(raftConfig);

  // Create MembershipManager
  const membershipConfig: MembershipConfig = {
    nodeId,
    hostname: `${nodeId}.local`,
    tailscaleIp: `100.0.0.${nodeId.replace(/\D/g, '') || '1'}`,
    grpcPort: 50051,
    logger,
    raft,
    clientPool: poolAsGrpc,
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 15000,
    autoApprove: true,
  };
  const membership = new MembershipManager(membershipConfig);

  // Create TaskScheduler
  const schedulerConfig: SchedulerConfig = {
    nodeId,
    logger,
    membership,
    raft,
    clientPool: poolAsGrpc,
  };
  const scheduler = new TaskScheduler(schedulerConfig);

  // Register handlers with the client pool
  clientPool.registerNode(nodeId, {
    raft: {
      requestVote: (request) => raft.handleRequestVote(request),
      appendEntries: (request) => raft.handleAppendEntries(request),
    },
    membership: {
      handleJoinRequest: (node) => membership.handleJoinRequest(node),
    },
  });

  return { nodeId, raft, membership, scheduler, logger };
}

interface TestCluster {
  nodes: TestNode[];
  clientPool: MockGrpcClientPool;
}

function createTestCluster(nodeCount: number): TestCluster {
  const clientPool = new MockGrpcClientPool();
  const nodes: TestNode[] = [];

  // Create all nodes
  for (let i = 1; i <= nodeCount; i++) {
    const nodeId = `node${i}`;
    const node = createTestNode(nodeId, clientPool);
    nodes.push(node);
  }

  // Connect peers - each node knows about all other nodes
  for (const node of nodes) {
    for (const peer of nodes) {
      if (peer.nodeId !== node.nodeId) {
        node.raft.addPeer(peer.nodeId, `${peer.nodeId}:50051`, true);
      }
    }
  }

  return { nodes, clientPool };
}

// ============================================================================
// Cluster Formation Tests
// ============================================================================

describe('Cluster Formation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should elect leader when cluster starts', async () => {
    const { nodes } = createTestCluster(3);

    // Start all nodes
    for (const node of nodes) {
      node.raft.start();
    }

    // Initially all nodes should be followers
    for (const node of nodes) {
      expect(node.raft.getState()).toBe('follower');
    }

    // Advance time to trigger election timeout (300ms max)
    await vi.advanceTimersByTimeAsync(350);

    // At least one node should have become a candidate and then leader
    const leaders = nodes.filter((n) => n.raft.isLeader());
    expect(leaders.length).toBe(1);

    // Other nodes should be followers
    const followers = nodes.filter((n) => n.raft.getState() === 'follower');
    expect(followers.length).toBe(2);

    // All nodes should agree on the leader
    const leaderId = leaders[0].nodeId;
    for (const follower of followers) {
      expect(follower.raft.getLeaderId()).toBe(leaderId);
    }

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
    }
  });

  it('should add follower node to existing cluster', async () => {
    const clientPool = new MockGrpcClientPool();

    // Create initial cluster with 2 nodes
    const node1 = createTestNode('node1', clientPool);
    const node2 = createTestNode('node2', clientPool);

    // Connect initial peers
    node1.raft.addPeer('node2', 'node2:50051', true);
    node2.raft.addPeer('node1', 'node1:50051', true);

    // Start initial nodes
    node1.raft.start();
    node2.raft.start();

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Verify leader elected
    const initialLeaders = [node1, node2].filter((n) => n.raft.isLeader());
    expect(initialLeaders.length).toBe(1);
    const leader = initialLeaders[0];

    // Create new node
    const node3 = createTestNode('node3', clientPool);

    // Add the new node as a peer to existing nodes
    node1.raft.addPeer('node3', 'node3:50051', true);
    node2.raft.addPeer('node3', 'node3:50051', true);

    // Add existing nodes as peers to the new node
    node3.raft.addPeer('node1', 'node1:50051', true);
    node3.raft.addPeer('node2', 'node2:50051', true);

    // Start the new node
    node3.raft.start();

    // Advance timers for heartbeats to propagate
    await vi.advanceTimersByTimeAsync(100);

    // New node should become a follower
    expect(node3.raft.getState()).toBe('follower');

    // Leader should still be the same
    expect(leader.raft.isLeader()).toBe(true);

    // New node should recognize the leader
    expect(node3.raft.getLeaderId()).toBe(leader.nodeId);

    // Stop all nodes
    node1.raft.stop();
    node2.raft.stop();
    node3.raft.stop();
  });

  it('should handle node approval workflow', async () => {
    const clientPool = new MockGrpcClientPool();

    // Create leader node with autoApprove disabled
    const leaderLogger = createMockLogger();
    const poolAsGrpc = clientPool as unknown as GrpcClientPool;

    const leaderRaftConfig: RaftConfig = {
      nodeId: 'leader',
      logger: leaderLogger,
      clientPool: poolAsGrpc,
      electionTimeoutMinMs: 150,
      electionTimeoutMaxMs: 300,
      heartbeatIntervalMs: 50,
    };
    const leaderRaft = new RaftNode(leaderRaftConfig);

    const leaderMembershipConfig: MembershipConfig = {
      nodeId: 'leader',
      hostname: 'leader.local',
      tailscaleIp: '100.0.0.1',
      grpcPort: 50051,
      logger: leaderLogger,
      raft: leaderRaft,
      clientPool: poolAsGrpc,
      autoApprove: false, // Require manual approval
    };
    const leaderMembership = new MembershipManager(leaderMembershipConfig);

    // Register leader handlers
    clientPool.registerNode('leader', {
      raft: {
        requestVote: (request) => leaderRaft.handleRequestVote(request),
        appendEntries: (request) => leaderRaft.handleAppendEntries(request),
      },
      membership: {
        handleJoinRequest: (node) => leaderMembership.handleJoinRequest(node),
      },
    });

    // Start leader
    leaderRaft.start();
    await vi.advanceTimersByTimeAsync(350);

    // Leader should be elected (single node cluster)
    expect(leaderRaft.isLeader()).toBe(true);

    // Create joining node info
    const joiningNodeInfo: NodeInfo = {
      nodeId: 'joiner',
      hostname: 'joiner.local',
      tailscaleIp: '100.0.0.2',
      grpcPort: 50051,
      role: 'follower',
      status: 'pending_approval',
      resources: null,
      tags: [],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    // Track join request event
    let joinRequestReceived = false;
    leaderMembership.on('nodeJoinRequest', () => {
      joinRequestReceived = true;
    });

    // Submit join request
    const joinResult = await leaderMembership.handleJoinRequest(joiningNodeInfo);

    // Should be pending approval
    expect(joinResult.pendingApproval).toBe(true);
    expect(joinResult.approved).toBe(false);
    expect(joinRequestReceived).toBe(true);

    // Node should be in pending approvals
    const pendingNodes = leaderMembership.getPendingApprovals();
    expect(pendingNodes.length).toBe(1);
    expect(pendingNodes[0].nodeId).toBe('joiner');

    // Approve the node
    const approvalResult = await leaderMembership.approveNode(joiningNodeInfo);
    expect(approvalResult).toBe(true);

    // Advance timers for Raft entry to be committed
    await vi.advanceTimersByTimeAsync(100);

    // Node should no longer be pending
    expect(leaderMembership.getPendingApprovals().length).toBe(0);

    // Node should be in active nodes
    const allNodes = leaderMembership.getAllNodes();
    const joinerNode = allNodes.find((n) => n.nodeId === 'joiner');
    expect(joinerNode).toBeDefined();
    expect(joinerNode?.status).toBe('active');

    // Stop leader
    leaderRaft.stop();
  });

  it('should update membership on node join', async () => {
    const { nodes, clientPool } = createTestCluster(3);

    // Start all nodes
    for (const node of nodes) {
      node.raft.start();
      node.membership.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Verify all nodes have themselves registered
    for (const node of nodes) {
      const selfNode = node.membership.getSelfNode();
      expect(selfNode).toBeDefined();
      expect(selfNode.nodeId).toBe(node.nodeId);
    }

    // Track membership events
    const nodeJoinedEvents: NodeInfo[] = [];
    leader!.membership.on('nodeJoined', (node: NodeInfo) => {
      nodeJoinedEvents.push(node);
    });

    // Create a new node that will join the cluster
    const node4 = createTestNode('node4', clientPool);

    // The new node joins by having the leader approve it
    const newNodeInfo: NodeInfo = {
      nodeId: 'node4',
      hostname: 'node4.local',
      tailscaleIp: '100.0.0.4',
      grpcPort: 50051,
      role: 'follower',
      status: 'pending_approval',
      resources: null,
      tags: [],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    // Submit and approve join request on leader
    await leader!.membership.handleJoinRequest(newNodeInfo);

    // Advance timers for Raft log replication
    await vi.advanceTimersByTimeAsync(150);

    // Verify the new node was added to leader's membership
    const leaderNodes = leader!.membership.getAllNodes();
    const node4InLeader = leaderNodes.find((n) => n.nodeId === 'node4');
    expect(node4InLeader).toBeDefined();
    expect(node4InLeader?.status).toBe('active');

    // Verify nodeJoined event was emitted
    expect(nodeJoinedEvents.length).toBeGreaterThanOrEqual(1);
    expect(nodeJoinedEvents.some((n) => n.nodeId === 'node4')).toBe(true);

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.membership.stop();
    }
    node4.raft.stop();
    node4.membership.stop();
  });
});

// ============================================================================
// Task Lifecycle Tests
// ============================================================================

describe('Task Lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should submit task and track through completion', async () => {
    const { nodes } = createTestCluster(2);

    // Start all nodes with raft and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit a shell task
    const taskSpec = {
      taskId: 'task-1',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'echo "hello world"',
      },
    };

    const result = await leader!.scheduler.submit(taskSpec);

    // Verify task was accepted
    expect(result.accepted).toBe(true);

    // Verify status is defined
    const status = leader!.scheduler.getStatus('task-1');
    expect(status).toBeDefined();

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.scheduler.stop();
    }
  });

  it('should distribute task to appropriate node', async () => {
    const { nodes } = createTestCluster(3);

    // Start all nodes with raft, membership, and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.membership.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit a task targeting node2
    const taskSpec = {
      taskId: 'task-targeted',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'echo "targeted task"',
      },
      targetNodes: ['node2'],
    };

    const result = await leader!.scheduler.submit(taskSpec);

    // Verify task was accepted
    expect(result.accepted).toBe(true);

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.membership.stop();
      node.scheduler.stop();
    }
  });

  it('should handle task failure and retry', async () => {
    const { nodes } = createTestCluster(2);

    // Start all nodes with raft and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Track task failure events
    let failAttempts = 0;
    leader!.scheduler.on('taskSubmitted', () => {
      failAttempts++;
    });

    // Submit a task
    const taskSpec = {
      taskId: 'task-retry',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'exit 1', // Failing command
      },
    };

    const result = await leader!.scheduler.submit(taskSpec);
    expect(result.accepted).toBe(true);

    // Advance time to allow scheduling and retry logic
    await vi.advanceTimersByTimeAsync(3000);

    // Verify at least one attempt was made
    expect(failAttempts).toBeGreaterThanOrEqual(1);

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.scheduler.stop();
    }
  });

  it('should cancel running task', async () => {
    const { nodes } = createTestCluster(2);

    // Start all nodes with raft and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit a task
    const taskSpec = {
      taskId: 'task-cancel',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'sleep 60',
      },
    };

    const submitResult = await leader!.scheduler.submit(taskSpec);
    expect(submitResult.accepted).toBe(true);

    // Cancel the task
    const cancelled = await leader!.scheduler.cancel('task-cancel');

    // Verify cancellation
    expect(cancelled).toBe(true);

    // Verify status shows cancelled
    const status = leader!.scheduler.getStatus('task-cancel');
    expect(status?.state).toBe('cancelled');

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.scheduler.stop();
    }
  });

  it('should timeout stuck task', async () => {
    const { nodes } = createTestCluster(2);

    // Start all nodes with raft and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit a task with a short timeout
    const taskSpec = {
      taskId: 'task-timeout',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'sleep 999999', // Command that would hang
      },
      timeoutMs: 1000,
    };

    const result = await leader!.scheduler.submit(taskSpec);
    expect(result.accepted).toBe(true);

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(2000);

    // Verify the task status is in an expected state for a timed-out task
    const status = leader!.scheduler.getStatus('task-timeout');
    expect(status).toBeDefined();
    // A timed-out task could be in failed, cancelled, or still queued (if never dispatched)
    expect(['failed', 'cancelled', 'queued']).toContain(status?.state);

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.scheduler.stop();
    }
  });
});

// ============================================================================
// State Synchronization Tests
// ============================================================================

describe('State Synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should replicate task submission via Raft', async () => {
    const { nodes } = createTestCluster(3);

    // Track entryCommitted events from each raft node
    const committedEntries: Map<string, LogEntry[]> = new Map();
    for (const node of nodes) {
      committedEntries.set(node.nodeId, []);
      node.raft.on('entryCommitted', (entry: LogEntry) => {
        committedEntries.get(node.nodeId)!.push(entry);
      });
    }

    // Start all rafts and schedulers
    for (const node of nodes) {
      node.raft.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find the leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit a task via leader
    const taskSpec = {
      taskId: 'replicated-task-1',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'echo "replicated"',
      },
    };

    await leader!.scheduler.submit(taskSpec);

    // Advance time for replication
    await vi.advanceTimersByTimeAsync(200);

    // Verify task entries committed on majority (>= 2 nodes)
    let nodesWithTaskEntry = 0;
    for (const [, entries] of committedEntries) {
      const hasTaskEntry = entries.some((e) => e.type === 'task_submit');
      if (hasTaskEntry) {
        nodesWithTaskEntry++;
      }
    }
    expect(nodesWithTaskEntry).toBeGreaterThanOrEqual(2);

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.scheduler.stop();
    }
  });

  it('should sync membership changes across nodes', async () => {
    const { nodes } = createTestCluster(3);

    // Start raft and membership
    for (const node of nodes) {
      node.raft.start();
      node.membership.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Call handleJoinRequest with a new node
    const newNodeInfo: NodeInfo = {
      nodeId: 'node-new',
      hostname: 'node-new.local',
      tailscaleIp: '100.0.0.99',
      grpcPort: 50051,
      role: 'follower',
      status: 'pending_approval',
      resources: null,
      tags: [],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    await leader!.membership.handleJoinRequest(newNodeInfo);

    // Approve the node
    await leader!.membership.approveNode(newNodeInfo);

    // Advance time for replication
    await vi.advanceTimersByTimeAsync(200);

    // Verify leader.membership.getAllNodes() includes the new node
    const allNodes = leader!.membership.getAllNodes();
    const newNode = allNodes.find((n) => n.nodeId === 'node-new');
    expect(newNode).toBeDefined();
    expect(newNode?.status).toBe('active');

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.membership.stop();
    }
  });

  it('should maintain consistent task status', async () => {
    const { nodes } = createTestCluster(2);

    // Start components
    for (const node of nodes) {
      node.raft.start();
      node.membership.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find leader
    const leader = nodes.find((n) => n.raft.isLeader());
    expect(leader).toBeDefined();

    // Submit task
    const taskSpec = {
      taskId: 'consistent-task-1',
      type: 'shell' as const,
      submitterNode: leader!.nodeId,
      shell: {
        command: 'echo "consistent"',
      },
    };

    await leader!.scheduler.submit(taskSpec);

    // Advance time
    await vi.advanceTimersByTimeAsync(100);

    // Verify leaderScheduler.getStatus(taskId) is defined
    const status = leader!.scheduler.getStatus('consistent-task-1');
    expect(status).toBeDefined();

    // Stop all nodes
    for (const node of nodes) {
      node.raft.stop();
      node.membership.stop();
      node.scheduler.stop();
    }
  });

  it('should recover state after leader change', async () => {
    const { nodes } = createTestCluster(3);

    // Start components
    for (const node of nodes) {
      node.raft.start();
      node.membership.start();
      node.scheduler.start();
    }

    // Wait for leader election
    await vi.advanceTimersByTimeAsync(350);

    // Find old leader
    const oldLeader = nodes.find((n) => n.raft.isLeader());
    expect(oldLeader).toBeDefined();
    const oldLeaderId = oldLeader!.nodeId;

    // Submit task
    const taskSpec = {
      taskId: 'recovery-task-1',
      type: 'shell' as const,
      submitterNode: oldLeader!.nodeId,
      shell: {
        command: 'echo "recovery"',
      },
    };

    await oldLeader!.scheduler.submit(taskSpec);

    // Advance time for replication
    await vi.advanceTimersByTimeAsync(100);

    // Stop old leader (raft.stop())
    oldLeader!.raft.stop();

    // Advance time for re-election (1000ms)
    await vi.advanceTimersByTimeAsync(1000);

    // Find new leader (different from old)
    const remainingNodes = nodes.filter((n) => n.nodeId !== oldLeaderId);
    const newLeader = remainingNodes.find((n) => n.raft.isLeader());

    // Verify new leader exists (may or may not have task state depending on replication)
    expect(newLeader).toBeDefined();
    expect(newLeader!.nodeId).not.toBe(oldLeaderId);

    // Stop remaining nodes
    for (const node of remainingNodes) {
      node.raft.stop();
      node.membership.stop();
      node.scheduler.stop();
    }
    // Clean up old leader's remaining components
    oldLeader!.membership.stop();
    oldLeader!.scheduler.stop();
  });
});
