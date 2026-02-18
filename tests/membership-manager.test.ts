import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MembershipManager, MembershipConfig, NodeInfo, NodeResources } from '../src/cluster/membership.js';
import { RaftNode } from '../src/cluster/raft.js';
import { GrpcClientPool, ClusterClient } from '../src/grpc/client.js';
import { Logger } from 'winston';

// Mock the gRPC client module
vi.mock('../src/grpc/client.js', () => ({
  ClusterClient: vi.fn(),
  GrpcClientPool: vi.fn(),
}));

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Mock RaftNode with event capture
const createMockRaft = () => {
  const handlers = new Map<string, Function>();
  return {
    isLeader: vi.fn().mockReturnValue(false),
    appendEntry: vi.fn().mockResolvedValue({ success: true, index: 1 }),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
    delayNextElection: vi.fn(),
    getLeaderId: vi.fn().mockReturnValue(null),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    _emit: (event: string, ...args: unknown[]) => {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    },
    _handlers: handlers,
  } as unknown as RaftNode & { _emit: Function; _handlers: Map<string, Function> };
};

// Mock client pool
const createMockClientPool = (): GrpcClientPool => ({
  getConnection: vi.fn(),
} as unknown as GrpcClientPool);

// Helper to create test manager
function createTestManager(overrides?: Partial<MembershipConfig>) {
  const mockRaft = createMockRaft();
  const config: MembershipConfig = {
    nodeId: 'node-1',
    hostname: 'test-host',
    tailscaleIp: '100.0.0.1',
    grpcPort: 50051,
    logger: createMockLogger(),
    raft: mockRaft,
    clientPool: createMockClientPool(),
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 15000,
    ...overrides,
  };
  return { manager: new MembershipManager(config), mockRaft, config };
}

describe('MembershipManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should register self node on creation', () => {
      const { manager } = createTestManager();

      const selfNode = manager.getSelfNode();

      expect(selfNode.nodeId).toBe('node-1');
      expect(selfNode.hostname).toBe('test-host');
      expect(selfNode.tailscaleIp).toBe('100.0.0.1');
      expect(selfNode.status).toBe('active');
    });

    it('should set up Raft event listeners', () => {
      const { mockRaft } = createTestManager();

      expect(mockRaft.on).toHaveBeenCalledWith('stateChange', expect.any(Function));
      expect(mockRaft.on).toHaveBeenCalledWith('entryCommitted', expect.any(Function));
    });

    it('should default to follower role', () => {
      const { manager } = createTestManager();

      expect(manager.getSelfNode().role).toBe('follower');
    });
  });

  describe('Join Cluster', () => {
    it('should call registerNode on seed address', async () => {
      const { manager } = createTestManager();
      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
      }));

      await manager.joinCluster('100.0.0.2:50051');

      expect(ClusterClient).toHaveBeenCalledWith(expect.anything(), '100.0.0.2:50051');
      expect(mockRegisterNode).toHaveBeenCalled();
    });

    it('should set status to pending_approval when response.pending_approval', async () => {
      const { manager } = createTestManager();
      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: false,
        pending_approval: true,
        cluster_id: '',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
      }));

      const result = await manager.joinCluster('100.0.0.2:50051');

      expect(result).toBe(true);
      expect(manager.getSelfNode().status).toBe('pending_approval');
    });

    it('should set status to active and store leader address when approved', async () => {
      const { manager } = createTestManager();
      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
      }));

      const result = await manager.joinCluster('100.0.0.2:50051');

      expect(result).toBe(true);
      expect(manager.getSelfNode().status).toBe('active');
      expect(manager.getLeaderAddress()).toBe('100.0.0.2:50051');
    });

    it('should add Raft peers for each returned peer', async () => {
      const { manager, mockRaft } = createTestManager();
      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [
          {
            node_id: 'node-2',
            hostname: 'peer-host',
            tailscale_ip: '100.0.0.2',
            grpc_port: 50051,
            role: 'NODE_ROLE_LEADER',
            status: 'NODE_STATUS_ACTIVE',
            tags: [],
            joined_at: '1000',
            last_seen: '1000',
          },
        ],
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
      }));

      await manager.joinCluster('100.0.0.2:50051');

      expect(mockRaft.addPeer).toHaveBeenCalledWith('node-2', '100.0.0.2:50051', true);
      expect(manager.getNode('node-2')).toBeDefined();
    });

    it('should return false on network error', async () => {
      const { manager } = createTestManager();

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: vi.fn().mockRejectedValue(new Error('Connection refused')),
      }));

      const result = await manager.joinCluster('100.0.0.2:50051');

      expect(result).toBe(false);
    });
  });

  describe('Handle Join Request', () => {
    const createPendingNode = (): NodeInfo => ({
      nodeId: 'new-node',
      hostname: 'new-host',
      tailscaleIp: '100.0.0.3',
      grpcPort: 50051,
      role: 'follower',
      status: 'pending_approval',
      resources: null,
      tags: [],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });

    it('should redirect to leader when not leader', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      const result = await manager.handleJoinRequest(createPendingNode());

      expect(result.approved).toBe(false);
      expect(result.pendingApproval).toBe(false);
    });

    it('should auto-approve when autoApprove config is true', async () => {
      const { manager, mockRaft } = createTestManager({ autoApprove: true });
      mockRaft.isLeader.mockReturnValue(true);

      const result = await manager.handleJoinRequest(createPendingNode());

      expect(result.approved).toBe(true);
      expect(result.pendingApproval).toBe(false);
    });

    it('should add to pendingApprovals when manual approval required', async () => {
      const { manager, mockRaft } = createTestManager({ autoApprove: false });
      mockRaft.isLeader.mockReturnValue(true);

      const pendingNode = createPendingNode();
      await manager.handleJoinRequest(pendingNode);

      const pending = manager.getPendingApprovals();
      expect(pending).toHaveLength(1);
      expect(pending[0].nodeId).toBe('new-node');
    });

    it('should emit nodeJoinRequest event for pending nodes', async () => {
      const { manager, mockRaft } = createTestManager({ autoApprove: false });
      mockRaft.isLeader.mockReturnValue(true);

      const events: NodeInfo[] = [];
      manager.on('nodeJoinRequest', (node: NodeInfo) => events.push(node));

      await manager.handleJoinRequest(createPendingNode());

      expect(events).toHaveLength(1);
      expect(events[0].nodeId).toBe('new-node');
    });
  });

  describe('Approve Node', () => {
    const createPendingNode = (): NodeInfo => ({
      nodeId: 'new-node',
      hostname: 'new-host',
      tailscaleIp: '100.0.0.3',
      grpcPort: 50051,
      role: 'follower',
      status: 'pending_approval',
      resources: null,
      tags: ['test'],
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });

    it('should return false when not leader', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      const result = await manager.approveNode(createPendingNode());

      expect(result).toBe(false);
      expect(mockRaft.appendEntry).not.toHaveBeenCalled();
    });

    it('should call raft.appendEntry with node_join type and node data', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(true);

      const node = createPendingNode();
      await manager.approveNode(node);

      expect(mockRaft.appendEntry).toHaveBeenCalledWith(
        'node_join',
        expect.any(Buffer)
      );

      const callData = JSON.parse(mockRaft.appendEntry.mock.calls[0][1].toString());
      expect(callData.nodeId).toBe('new-node');
      expect(callData.hostname).toBe('new-host');
    });

    it('should remove from pendingApprovals on success', async () => {
      const { manager, mockRaft } = createTestManager({ autoApprove: false });
      mockRaft.isLeader.mockReturnValue(true);

      const node = createPendingNode();
      await manager.handleJoinRequest(node);
      expect(manager.getPendingApprovals()).toHaveLength(1);

      await manager.approveNode(node);

      expect(manager.getPendingApprovals()).toHaveLength(0);
    });
  });

  describe('Heartbeat', () => {
    it('should not send heartbeat when node is leader', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(true);

      const mockHeartbeat = vi.fn().mockResolvedValue({ acknowledged: true });
      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        heartbeat: mockHeartbeat,
      }));

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it('should not send heartbeat when no leader address known', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);
      // No leader address set

      const mockHeartbeat = vi.fn().mockResolvedValue({ acknowledged: true });
      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        heartbeat: mockHeartbeat,
      }));

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it('should call client.heartbeat with node_id', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      // Simulate having joined a cluster
      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });
      const mockHeartbeat = vi.fn().mockResolvedValue({
        acknowledged: true,
        leader_address: '100.0.0.2:50051',
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
        heartbeat: mockHeartbeat,
      }));

      await manager.joinCluster('100.0.0.2:50051');
      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(mockHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ node_id: 'node-1' })
      );
    });

    it('should update lastSeen on acknowledged heartbeat', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });
      const mockHeartbeat = vi.fn().mockResolvedValue({
        acknowledged: true,
        leader_address: '100.0.0.2:50051',
      });

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
        heartbeat: mockHeartbeat,
      }));

      await manager.joinCluster('100.0.0.2:50051');

      const beforeHeartbeat = manager.getSelfNode().lastSeen;

      manager.start();
      // Advance time to trigger heartbeat and allow async callback to complete
      await vi.advanceTimersByTimeAsync(5000);
      manager.stop();

      expect(manager.getSelfNode().lastSeen).toBeGreaterThan(beforeHeartbeat);
    });

    it('should handle heartbeat failure gracefully', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      const mockRegisterNode = vi.fn().mockResolvedValue({
        approved: true,
        pending_approval: false,
        cluster_id: 'cluster-1',
        leader_address: '100.0.0.2:50051',
        peers: [],
      });
      const mockHeartbeat = vi.fn().mockRejectedValue(new Error('Network error'));

      (ClusterClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        registerNode: mockRegisterNode,
        heartbeat: mockHeartbeat,
      }));

      await manager.joinCluster('100.0.0.2:50051');
      manager.start();

      // Should not throw
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();

      manager.stop();
    });
  });

  describe('Failure Detection', () => {
    it('should not mark self as offline', () => {
      const { manager } = createTestManager({ heartbeatTimeoutMs: 100 });

      // Set self lastSeen to old time
      const selfNode = manager.getSelfNode();
      selfNode.lastSeen = Date.now() - 200;

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(manager.getSelfNode().status).toBe('active');
    });

    it('should mark node as offline when lastSeen exceeds timeout', () => {
      const { manager, mockRaft } = createTestManager({ heartbeatTimeoutMs: 15000 });
      mockRaft.isLeader.mockReturnValue(true);

      // Simulate a committed node_join to add a peer
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      const peerNode = manager.getNode('node-2');
      expect(peerNode).toBeDefined();
      peerNode!.lastSeen = Date.now() - 20000; // 20s ago

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(manager.getNode('node-2')?.status).toBe('offline');
    });

    it('should emit nodeOffline event for timed-out nodes', () => {
      const { manager, mockRaft } = createTestManager({ heartbeatTimeoutMs: 15000 });
      mockRaft.isLeader.mockReturnValue(true);

      // Add a peer via Raft commit
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      const offlineEvents: NodeInfo[] = [];
      manager.on('nodeOffline', (node: NodeInfo) => offlineEvents.push(node));

      const peerNode = manager.getNode('node-2');
      peerNode!.lastSeen = Date.now() - 20000;

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(offlineEvents).toHaveLength(1);
      expect(offlineEvents[0].nodeId).toBe('node-2');
    });

    it('should not mark recently-seen nodes as offline', () => {
      const { manager, mockRaft } = createTestManager({ heartbeatTimeoutMs: 15000 });

      // Add a peer via Raft commit
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      const peerNode = manager.getNode('node-2');
      peerNode!.lastSeen = Date.now() - 5000; // 5s ago, within timeout

      manager.start();
      vi.advanceTimersByTime(5000);
      manager.stop();

      expect(manager.getNode('node-2')?.status).toBe('active');
    });
  });

  describe('Node Removal', () => {
    it('should return false when not leader', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(false);

      // Add a node first
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      const result = await manager.removeNode('node-2');

      expect(result).toBe(false);
    });

    it('should set status to draining for graceful removal', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(true);

      // Add a node first
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      await manager.removeNode('node-2', true);

      expect(manager.getNode('node-2')?.status).toBe('draining');
    });

    it('should call raft.appendEntry with node_leave type', async () => {
      const { manager, mockRaft } = createTestManager();
      mockRaft.isLeader.mockReturnValue(true);

      // Add a node first
      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      await manager.removeNode('node-2');

      expect(mockRaft.appendEntry).toHaveBeenCalledWith(
        'node_leave',
        expect.any(Buffer)
      );

      const callData = JSON.parse(mockRaft.appendEntry.mock.calls[0][1].toString());
      expect(callData.nodeId).toBe('node-2');
    });
  });

  describe('Raft Entry Handling', () => {
    it('should add node to membership on node_join commit', () => {
      const { manager, mockRaft } = createTestManager();

      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: ['gpu'],
        })),
      });

      const node = manager.getNode('node-2');
      expect(node).toBeDefined();
      expect(node?.hostname).toBe('peer-host');
      expect(node?.status).toBe('active');
    });

    it('should call raft.addPeer when node_join commits', () => {
      const { manager, mockRaft } = createTestManager();

      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      expect(mockRaft.addPeer).toHaveBeenCalledWith('node-2', '100.0.0.2:50051', true);
    });

    it('should emit nodeJoined event on node_join commit', () => {
      const { manager, mockRaft } = createTestManager();

      const joinedEvents: NodeInfo[] = [];
      manager.on('nodeJoined', (node: NodeInfo) => joinedEvents.push(node));

      const entryHandler = mockRaft._handlers.get('entryCommitted');
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      expect(joinedEvents).toHaveLength(1);
      expect(joinedEvents[0].nodeId).toBe('node-2');
    });

    it('should remove node from membership on node_leave commit', () => {
      const { manager, mockRaft } = createTestManager();

      const entryHandler = mockRaft._handlers.get('entryCommitted');

      // First add a node
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      expect(manager.getNode('node-2')).toBeDefined();

      // Then remove it
      entryHandler?.({
        type: 'node_leave',
        data: Buffer.from(JSON.stringify({ nodeId: 'node-2' })),
      });

      expect(manager.getNode('node-2')).toBeUndefined();
    });

    it('should call raft.removePeer when node_leave commits', () => {
      const { manager, mockRaft } = createTestManager();

      const entryHandler = mockRaft._handlers.get('entryCommitted');

      // Add then remove
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      entryHandler?.({
        type: 'node_leave',
        data: Buffer.from(JSON.stringify({ nodeId: 'node-2' })),
      });

      expect(mockRaft.removePeer).toHaveBeenCalledWith('node-2');
    });

    it('should emit nodeLeft event on node_leave commit', () => {
      const { manager, mockRaft } = createTestManager();

      const leftEvents: NodeInfo[] = [];
      manager.on('nodeLeft', (node: NodeInfo) => leftEvents.push(node));

      const entryHandler = mockRaft._handlers.get('entryCommitted');

      // Add then remove
      entryHandler?.({
        type: 'node_join',
        data: Buffer.from(JSON.stringify({
          nodeId: 'node-2',
          hostname: 'peer-host',
          tailscaleIp: '100.0.0.2',
          grpcPort: 50051,
          tags: [],
        })),
      });

      entryHandler?.({
        type: 'node_leave',
        data: Buffer.from(JSON.stringify({ nodeId: 'node-2' })),
      });

      expect(leftEvents).toHaveLength(1);
      expect(leftEvents[0].nodeId).toBe('node-2');
    });

    it('should ignore noop entries', () => {
      const { manager, mockRaft } = createTestManager();

      const entryHandler = mockRaft._handlers.get('entryCommitted');

      // Should not throw or cause issues
      expect(() => {
        entryHandler?.({
          type: 'noop',
          data: Buffer.alloc(0),
        });
      }).not.toThrow();

      // No nodes added
      expect(manager.getAllNodes()).toHaveLength(1); // Only self
    });
  });
});
