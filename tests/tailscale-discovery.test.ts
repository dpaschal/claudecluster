import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TailscaleDiscovery, TailscaleNode, TailscaleStatus } from '../src/discovery/tailscale';
import { Logger } from 'winston';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'child_process';

// Helper to create mock exec implementation
function mockExecResponse(response: string | Error) {
  const mockExec = exec as unknown as ReturnType<typeof vi.fn>;
  mockExec.mockImplementation((_cmd: string, callback: (error: Error | null, result: { stdout: string }) => void) => {
    if (response instanceof Error) {
      callback(response, { stdout: '' });
    } else {
      callback(null, { stdout: response });
    }
  });
}

// Create a mock logger
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

// Sample tailscale status JSON for testing
function createTailscaleStatus(options: {
  selfId?: string;
  selfHostname?: string;
  selfIp?: string;
  selfOnline?: boolean;
  selfTags?: string[];
  peers?: Array<{
    id: string;
    hostname: string;
    ip: string;
    online: boolean;
    tags?: string[];
    lastSeen?: string;
    os?: string;
  }>;
}): string {
  const {
    selfId = 'self-id',
    selfHostname = 'my-host',
    selfIp = '100.0.0.1',
    selfOnline = true,
    selfTags = ['tag:claudecluster'],
    peers = [],
  } = options;

  const peerMap: Record<string, object> = {};
  for (const peer of peers) {
    peerMap[peer.id] = {
      ID: peer.id,
      HostName: peer.hostname,
      TailscaleIPs: [peer.ip],
      Online: peer.online,
      OS: peer.os ?? 'linux',
      Tags: peer.tags ?? ['tag:claudecluster'],
      LastSeen: peer.lastSeen ?? '2024-01-01T00:00:00Z',
    };
  }

  return JSON.stringify({
    Self: {
      ID: selfId,
      HostName: selfHostname,
      TailscaleIPs: [selfIp],
      Online: selfOnline,
      OS: 'linux',
      Tags: selfTags,
    },
    Peer: peerMap,
    CurrentTailnet: { Name: 'mynet' },
    MagicDNSSuffix: 'mynet.ts.net',
  });
}

describe('TailscaleDiscovery', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ====================================
  // Initialization Tests (3 tests)
  // ====================================
  describe('Initialization', () => {
    it('should create with default config', () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      // Verify instance is created
      expect(discovery).toBeInstanceOf(TailscaleDiscovery);
      expect(discovery.getStatus()).toBeNull();
      expect(discovery.getClusterNodes()).toEqual([]);
    });

    it('should use custom cluster tag', async () => {
      const customTag = 'my-custom-cluster';
      const discovery = new TailscaleDiscovery({
        logger: mockLogger,
        clusterTag: customTag,
      });

      // Setup mock with peer having custom tag
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'peer1', ip: '100.0.0.2', online: true, tags: [`tag:${customTag}`] },
          { id: 'peer-2', hostname: 'peer2', ip: '100.0.0.3', online: true, tags: ['tag:other'] },
        ],
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('peer1');
    });

    it('should use custom poll interval', async () => {
      vi.useFakeTimers();
      const customInterval = 5000;

      mockExecResponse(createTailscaleStatus({}));

      const discovery = new TailscaleDiscovery({
        logger: mockLogger,
        pollIntervalMs: customInterval,
      });

      await discovery.start();

      // Verify initial poll
      expect(exec).toHaveBeenCalledTimes(1);

      // Fast-forward by custom interval
      await vi.advanceTimersByTimeAsync(customInterval);

      expect(exec).toHaveBeenCalledTimes(2);

      discovery.stop();
    });
  });

  // ====================================
  // Status Retrieval Tests (4 tests)
  // ====================================
  describe('Status Retrieval', () => {
    it('should return null status before start', () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      expect(discovery.getStatus()).toBeNull();
      expect(discovery.getSelfIP()).toBeNull();
      expect(discovery.getSelfHostname()).toBeNull();
    });

    it('should parse tailscale status correctly', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        selfHostname: 'my-machine',
        selfIp: '100.50.25.10',
        peers: [
          { id: 'peer-1', hostname: 'peer1', ip: '100.0.0.2', online: true },
          { id: 'peer-2', hostname: 'peer2', ip: '100.0.0.3', online: false },
        ],
      }));

      await discovery.poll();

      const status = discovery.getStatus();
      expect(status).not.toBeNull();
      expect(status!.selfIP).toBe('100.50.25.10');
      expect(status!.selfHostname).toBe('my-machine');
      expect(status!.tailnetName).toBe('mynet');
      expect(status!.magicDNSSuffix).toBe('mynet.ts.net');
      expect(status!.nodes).toHaveLength(3); // self + 2 peers
    });

    it('should get self IP from status', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        selfIp: '100.123.45.67',
      }));

      await discovery.poll();

      expect(discovery.getSelfIP()).toBe('100.123.45.67');
    });

    it('should get self hostname from status', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        selfHostname: 'rog2',
      }));

      await discovery.poll();

      expect(discovery.getSelfHostname()).toBe('rog2');
    });
  });

  // ====================================
  // Cluster Node Filtering Tests (4 tests)
  // ====================================
  describe('Cluster Node Filtering', () => {
    it('should filter nodes by cluster tag', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'cluster-node', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
          { id: 'peer-2', hostname: 'non-cluster-node', ip: '100.0.0.3', online: true, tags: ['tag:other'] },
          { id: 'peer-3', hostname: 'untagged-node', ip: '100.0.0.4', online: true, tags: [] },
        ],
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('cluster-node');
    });

    it('should exclude offline nodes from cluster nodes', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'online-node', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
          { id: 'peer-2', hostname: 'offline-node', ip: '100.0.0.3', online: false, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('online-node');
    });

    it('should exclude self from cluster nodes', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        selfHostname: 'my-host',
        selfTags: ['tag:claudecluster'],
        peers: [
          { id: 'peer-1', hostname: 'other-node', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('other-node');
      // Verify self is not included
      expect(clusterNodes.find(n => n.self)).toBeUndefined();
    });

    it('should return empty array when no cluster nodes', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        selfTags: ['tag:other'],
        peers: [
          { id: 'peer-1', hostname: 'non-cluster', ip: '100.0.0.2', online: true, tags: ['tag:other'] },
        ],
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toEqual([]);
    });
  });

  // ====================================
  // Node Discovery Events Tests (5 tests)
  // ====================================
  describe('Node Discovery Events', () => {
    it('should emit nodeDiscovered for new online nodes', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });
      const discoveredNodes: TailscaleNode[] = [];

      discovery.on('nodeDiscovered', (node: TailscaleNode) => {
        discoveredNodes.push(node);
      });

      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'new-node', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      expect(discoveredNodes).toHaveLength(1);
      expect(discoveredNodes[0].hostname).toBe('new-node');
      expect(discoveredNodes[0].ip).toBe('100.0.0.2');
    });

    it('should emit nodeOnline when node comes online', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });
      const onlineNodes: TailscaleNode[] = [];

      discovery.on('nodeOnline', (node: TailscaleNode) => {
        onlineNodes.push(node);
      });

      // First poll - node is offline
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'node1', ip: '100.0.0.2', online: false, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();
      expect(onlineNodes).toHaveLength(0);

      // Second poll - node comes online
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'node1', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      expect(onlineNodes).toHaveLength(1);
      expect(onlineNodes[0].hostname).toBe('node1');
    });

    it('should emit nodeOffline when node goes offline', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });
      const offlineNodes: TailscaleNode[] = [];

      discovery.on('nodeOffline', (node: TailscaleNode) => {
        offlineNodes.push(node);
      });

      // First poll - node is online (and will be discovered)
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'node1', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      // Second poll - node goes offline
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'node1', ip: '100.0.0.2', online: false, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      expect(offlineNodes).toHaveLength(1);
      expect(offlineNodes[0].hostname).toBe('node1');
    });

    it('should emit nodeRemoved when node disappears', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });
      const removedNodes: TailscaleNode[] = [];

      discovery.on('nodeRemoved', (node: TailscaleNode) => {
        removedNodes.push(node);
      });

      // First poll - node exists
      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'disappearing-node', ip: '100.0.0.2', online: true, tags: ['tag:claudecluster'] },
        ],
      }));

      await discovery.poll();

      // Second poll - node is gone
      mockExecResponse(createTailscaleStatus({
        peers: [],
      }));

      await discovery.poll();

      expect(removedNodes).toHaveLength(1);
      expect(removedNodes[0].hostname).toBe('disappearing-node');
    });

    it('should emit error on poll failure', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });
      const errors: Error[] = [];

      discovery.on('error', (error: Error) => {
        errors.push(error);
      });

      mockExecResponse(new Error('tailscale not running'));

      await discovery.poll();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('tailscale not running');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ====================================
  // Polling Tests (2 tests)
  // ====================================
  describe('Polling', () => {
    it('should poll on start', async () => {
      vi.useFakeTimers();

      mockExecResponse(createTailscaleStatus({}));

      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      await discovery.start();

      expect(exec).toHaveBeenCalledTimes(1);
      expect(discovery.getStatus()).not.toBeNull();

      discovery.stop();
    });

    it('should poll at configured interval', async () => {
      vi.useFakeTimers();
      const pollInterval = 10000;

      mockExecResponse(createTailscaleStatus({}));

      const discovery = new TailscaleDiscovery({
        logger: mockLogger,
        pollIntervalMs: pollInterval,
      });

      await discovery.start();

      // Initial poll
      expect(exec).toHaveBeenCalledTimes(1);

      // Fast forward by one interval
      await vi.advanceTimersByTimeAsync(pollInterval);
      expect(exec).toHaveBeenCalledTimes(2);

      // Fast forward by two more intervals
      await vi.advanceTimersByTimeAsync(pollInterval * 2);
      expect(exec).toHaveBeenCalledTimes(4);

      discovery.stop();

      // After stop, no more polling
      await vi.advanceTimersByTimeAsync(pollInterval);
      expect(exec).toHaveBeenCalledTimes(4);
    });
  });

  // ====================================
  // Utility Methods Tests (2 tests)
  // ====================================
  describe('Utility Methods', () => {
    it('should resolve hostname to IP', async () => {
      const discovery = new TailscaleDiscovery({ logger: mockLogger });

      mockExecResponse(createTailscaleStatus({
        peers: [
          { id: 'peer-1', hostname: 'terminus', ip: '100.85.203.53', online: true },
          { id: 'peer-2', hostname: 'rog2', ip: '100.104.78.123', online: true },
        ],
      }));

      await discovery.poll();

      // Test exact match
      const terminusIp = await discovery.resolveHostname('terminus');
      expect(terminusIp).toBe('100.85.203.53');

      // Test case-insensitive match
      const rog2Ip = await discovery.resolveHostname('ROG2');
      expect(rog2Ip).toBe('100.104.78.123');

      // Test non-existent hostname
      const unknownIp = await discovery.resolveHostname('unknown-host');
      expect(unknownIp).toBeNull();
    });

    it('static isAvailable should check tailscale', async () => {
      // Mock success
      mockExecResponse(createTailscaleStatus({}));

      const available = await TailscaleDiscovery.isAvailable();
      expect(available).toBe(true);

      // Mock failure
      mockExecResponse(new Error('tailscale not installed'));

      const notAvailable = await TailscaleDiscovery.isAvailable();
      expect(notAvailable).toBe(false);
    });
  });
});
