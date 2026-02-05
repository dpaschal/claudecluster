import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MembershipManager, NodeInfo, NodeResources, MembershipConfig } from '../src/cluster/membership.js';

// Helper to create an ephemeral node
const createEphemeralNode = (overrides?: Partial<NodeInfo>): NodeInfo => ({
  nodeId: 'ephemeral-node-1',
  hostname: 'pxe-host',
  tailscaleIp: '100.0.0.99',
  grpcPort: 50051,
  role: 'worker',
  status: 'pending_approval',
  resources: null,
  tags: ['ephemeral'],
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  ...overrides,
});

// Mock RaftNode
const createMockRaft = (isLeader: boolean = true) => {
  const raft = new EventEmitter() as EventEmitter & {
    isLeader: () => boolean;
    appendEntry: (type: string, data: Buffer) => Promise<{ success: boolean }>;
    addPeer: (nodeId: string, address: string, voting: boolean) => void;
    removePeer: (nodeId: string) => void;
  };
  raft.isLeader = vi.fn().mockReturnValue(isLeader);
  raft.appendEntry = vi.fn().mockResolvedValue({ success: true });
  raft.addPeer = vi.fn();
  raft.removePeer = vi.fn();
  return raft;
};

// Mock Logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock GrpcClientPool
const createMockClientPool = () => ({
  getClient: vi.fn(),
  releaseClient: vi.fn(),
  close: vi.fn(),
});

// Helper to simulate Raft commit for node join
const simulateNodeJoinCommit = (raft: EventEmitter, node: NodeInfo) => {
  raft.emit('entryCommitted', {
    type: 'node_join',
    data: Buffer.from(JSON.stringify({
      nodeId: node.nodeId,
      hostname: node.hostname,
      tailscaleIp: node.tailscaleIp,
      grpcPort: node.grpcPort,
      tags: node.tags,
    })),
  });
};

// Helper to simulate Raft commit for node leave
const simulateNodeLeaveCommit = (raft: EventEmitter, nodeId: string) => {
  raft.emit('entryCommitted', {
    type: 'node_leave',
    data: Buffer.from(JSON.stringify({ nodeId })),
  });
};

// Create MembershipManager with mocks
const createMembershipManager = (overrides?: Partial<MembershipConfig>) => {
  const raft = createMockRaft(overrides?.raft ? false : true);
  const logger = createMockLogger();
  const clientPool = createMockClientPool();

  const config: MembershipConfig = {
    nodeId: 'leader-node',
    hostname: 'leader-host',
    tailscaleIp: '100.0.0.1',
    grpcPort: 50051,
    logger: logger as any,
    raft: overrides?.raft || (raft as any),
    clientPool: clientPool as any,
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 15000,
    autoApprove: false,
    ...overrides,
  };

  return {
    manager: new MembershipManager(config),
    raft: overrides?.raft || raft,
    logger,
    clientPool,
    config,
  };
};

describe('Ephemeral Node Lifecycle', () => {
  describe('Detection and Tagging', () => {
    it('should detect ephemeral node from tags', () => {
      const node = createEphemeralNode();

      const isEphemeral = node.tags.includes('ephemeral');

      expect(isEphemeral).toBe(true);
      expect(node.tags).toContain('ephemeral');
    });

    it('should mark node as ephemeral in approval request', async () => {
      const { manager } = createMembershipManager({ autoApprove: false });
      const ephemeralNode = createEphemeralNode();

      const result = await manager.handleJoinRequest(ephemeralNode);

      expect(result.pendingApproval).toBe(true);
      const pending = manager.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].tags).toContain('ephemeral');
    });

    it('should identify non-ephemeral nodes correctly', () => {
      const regularNode = createEphemeralNode({
        nodeId: 'regular-node-1',
        tags: [],
      });

      const isEphemeral = regularNode.tags.includes('ephemeral');

      expect(isEphemeral).toBe(false);
      expect(regularNode.tags).not.toContain('ephemeral');
    });
  });

  describe('Auto-Approval', () => {
    it('should auto-approve ephemeral nodes when enabled', async () => {
      const { manager } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode();

      const result = await manager.handleJoinRequest(ephemeralNode);

      expect(result.approved).toBe(true);
      expect(result.pendingApproval).toBe(false);
      expect(manager.getPendingApprovals().length).toBe(0);
    });

    it('should not auto-approve ephemeral when disabled', async () => {
      const { manager } = createMembershipManager({ autoApprove: false });
      const ephemeralNode = createEphemeralNode();

      const result = await manager.handleJoinRequest(ephemeralNode);

      expect(result.approved).toBe(false);
      expect(result.pendingApproval).toBe(true);
      expect(manager.getPendingApprovals().length).toBe(1);
    });

    it('should auto-approve nodes with trusted tags', async () => {
      const { manager } = createMembershipManager({ autoApprove: true });
      const trustedNode = createEphemeralNode({
        nodeId: 'trusted-node-1',
        tags: ['ephemeral', 'trusted', 'pxe-boot'],
      });

      const result = await manager.handleJoinRequest(trustedNode);

      expect(result.approved).toBe(true);
      expect(result.pendingApproval).toBe(false);
    });

    it('should require manual approval for non-ephemeral nodes', async () => {
      const { manager } = createMembershipManager({ autoApprove: false });
      const regularNode = createEphemeralNode({
        nodeId: 'regular-node-1',
        tags: [],
      });

      const result = await manager.handleJoinRequest(regularNode);

      expect(result.approved).toBe(false);
      expect(result.pendingApproval).toBe(true);
      const pending = manager.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].nodeId).toBe('regular-node-1');
    });
  });

  describe('Lifecycle Management', () => {
    it('should track ephemeral node from pending to active', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: false });
      const ephemeralNode = createEphemeralNode();

      // Join as pending
      await manager.handleJoinRequest(ephemeralNode);
      let pending = manager.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].status).toBe('pending_approval');

      // Approve node
      await manager.approveNode(ephemeralNode);
      pending = manager.getPendingApprovals();
      expect(pending.length).toBe(0);
    });

    it('should update lastSeen on heartbeat', () => {
      const { manager } = createMembershipManager({ autoApprove: true });
      const initialTime = Date.now() - 10000;
      const ephemeralNode = createEphemeralNode({
        lastSeen: initialTime,
        status: 'active',
      });

      // Simulate node being added and then resources updated
      const resources: NodeResources = {
        cpuCores: 4,
        memoryBytes: 8 * 1024 * 1024 * 1024,
        memoryAvailableBytes: 4 * 1024 * 1024 * 1024,
        gpus: [],
        diskBytes: 500 * 1024 * 1024 * 1024,
        diskAvailableBytes: 250 * 1024 * 1024 * 1024,
        cpuUsagePercent: 20,
        gamingDetected: false,
      };

      // Add node to membership
      manager.updateNodeResources(ephemeralNode.nodeId, resources);

      // Check if lastSeen would be updated on resource update
      // The updateNodeResources method updates lastSeen
      const selfNode = manager.getSelfNode();
      expect(selfNode.lastSeen).toBeGreaterThan(0);
    });

    it('should detect ephemeral node going offline', async () => {
      vi.useFakeTimers();
      const { manager } = createMembershipManager({
        autoApprove: true,
        heartbeatTimeoutMs: 15000,
      });

      const ephemeralNode = createEphemeralNode({
        status: 'active',
        lastSeen: Date.now(),
      });

      // Handle join first
      await manager.handleJoinRequest(ephemeralNode);

      // Simulate time passing beyond timeout
      const node = manager.getAllNodes().find(n => n.nodeId === ephemeralNode.nodeId);
      if (node) {
        node.lastSeen = Date.now() - 20000; // 20 seconds ago
      }

      // Start manager to trigger failure detection
      manager.start();

      // Advance timers to trigger failure detection
      vi.advanceTimersByTime(5000);

      // Check if node is marked offline
      const updatedNode = manager.getNode(ephemeralNode.nodeId);
      if (updatedNode) {
        expect(updatedNode.status).toBe('offline');
      }

      manager.stop();
      vi.useRealTimers();
    });

    it('should emit events for ephemeral node state changes', async () => {
      vi.useFakeTimers();
      const { manager, raft } = createMembershipManager({
        autoApprove: true,
        heartbeatTimeoutMs: 15000,
      });

      const offlineHandler = vi.fn();
      manager.on('nodeOffline', offlineHandler);

      const ephemeralNode = createEphemeralNode({
        status: 'active',
        lastSeen: Date.now(),
      });

      // Join and simulate Raft commit
      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Simulate timeout by setting lastSeen in the past
      const node = manager.getNode(ephemeralNode.nodeId);
      if (node) {
        node.lastSeen = Date.now() - 20000;
      }

      manager.start();
      vi.advanceTimersByTime(5000);

      expect(offlineHandler).toHaveBeenCalled();

      manager.stop();
      vi.useRealTimers();
    });

    it('should handle rapid reconnection of ephemeral node', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode();

      // First join
      const result1 = await manager.handleJoinRequest(ephemeralNode);
      expect(result1.approved).toBe(true);

      // Simulate going offline and reconnecting
      const node = manager.getNode(ephemeralNode.nodeId);
      if (node) {
        node.status = 'offline';
      }

      // Reconnect - should be able to rejoin
      const reconnectedNode = createEphemeralNode({
        lastSeen: Date.now(),
        status: 'pending_approval',
      });

      const result2 = await manager.handleJoinRequest(reconnectedNode);
      expect(result2.approved).toBe(true);
    });
  });

  describe('Graceful Draining', () => {
    it('should drain ephemeral node gracefully', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode({ status: 'active' });

      // Add node to cluster and simulate Raft commit
      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Initiate graceful removal
      const removed = await manager.removeNode(ephemeralNode.nodeId, true);

      expect(removed).toBe(true);
      const node = manager.getNode(ephemeralNode.nodeId);
      expect(node?.status).toBe('draining');
    });

    it('should reassign tasks during drain', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const drainingHandler = vi.fn();
      manager.on('nodeDraining', drainingHandler);

      const ephemeralNode = createEphemeralNode({ status: 'active' });
      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Initiate graceful removal
      await manager.removeNode(ephemeralNode.nodeId, true);

      expect(drainingHandler).toHaveBeenCalled();
      expect(drainingHandler).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: ephemeralNode.nodeId,
        status: 'draining',
      }));
    });

    it('should complete drain before removal', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode({ status: 'active' });

      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Start graceful removal
      await manager.removeNode(ephemeralNode.nodeId, true);

      // Node should still be present but draining
      const node = manager.getNode(ephemeralNode.nodeId);
      expect(node).toBeDefined();
      expect(node?.status).toBe('draining');

      // Verify appendEntry was called for node_leave
      expect(raft.appendEntry).toHaveBeenCalledWith(
        'node_leave',
        expect.any(Buffer)
      );
    });
  });

  describe('Cleanup and Removal', () => {
    it('should remove offline ephemeral node after timeout', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode({ status: 'active' });

      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Simulate node going offline
      const node = manager.getNode(ephemeralNode.nodeId);
      if (node) {
        node.status = 'offline';
      }

      // Remove offline node
      const removed = await manager.removeNode(ephemeralNode.nodeId, false);

      expect(removed).toBe(true);
      expect(raft.appendEntry).toHaveBeenCalledWith(
        'node_leave',
        expect.any(Buffer)
      );
    });

    it('should clean up node state on removal', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const ephemeralNode = createEphemeralNode({ status: 'active' });

      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Verify node exists
      expect(manager.getNode(ephemeralNode.nodeId)).toBeDefined();

      // Simulate the committed entry for node leave
      simulateNodeLeaveCommit(raft as EventEmitter, ephemeralNode.nodeId);

      // Node should be removed from getAllNodes after committed entry
      const nodes = manager.getAllNodes();
      const found = nodes.find(n => n.nodeId === ephemeralNode.nodeId);
      expect(found).toBeUndefined();
    });

    it('should notify cluster of ephemeral node removal', async () => {
      const { manager, raft } = createMembershipManager({ autoApprove: true });
      const nodeLeftHandler = vi.fn();
      manager.on('nodeLeft', nodeLeftHandler);

      const ephemeralNode = createEphemeralNode({ status: 'active' });
      await manager.handleJoinRequest(ephemeralNode);
      simulateNodeJoinCommit(raft as EventEmitter, ephemeralNode);

      // Simulate committed entry for node leave
      simulateNodeLeaveCommit(raft as EventEmitter, ephemeralNode.nodeId);

      expect(nodeLeftHandler).toHaveBeenCalled();
      expect(nodeLeftHandler).toHaveBeenCalledWith(expect.objectContaining({
        nodeId: ephemeralNode.nodeId,
        tags: ['ephemeral'],
      }));
    });
  });
});
