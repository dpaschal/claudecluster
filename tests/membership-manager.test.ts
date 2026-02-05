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
});
