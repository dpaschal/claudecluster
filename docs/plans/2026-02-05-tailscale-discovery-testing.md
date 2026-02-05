# Tailscale Discovery Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add comprehensive unit tests for `TailscaleDiscovery` class with mocked shell commands.

**Architecture:** Unit tests with mocked `child_process.exec` using vitest. Mock returns fake Tailscale JSON to test discovery logic in isolation. Use fake timers for polling tests.

**Tech Stack:** vitest, vi.fn() mocks, vi.useFakeTimers()

---

### Task 1: Test Setup, Initialization, and Status Fetching Tests

**Files:**
- Create: `tests/tailscale-discovery.test.ts`

**Step 1: Write test file with setup and first 5 tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { exec } from 'child_process';
import { TailscaleDiscovery, TailscaleDiscoveryConfig, TailscaleNode } from '../src/discovery/tailscale.js';
import { Logger } from 'winston';

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Mock util.promisify to work with our mocked exec
vi.mock('util', async () => {
  const actual = await vi.importActual('util');
  return {
    ...actual,
    promisify: (fn: Function) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          fn(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    },
  };
});

// Mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger);

// Helper to create fake Tailscale response
const createFakeTailscaleResponse = (overrides?: {
  Self?: Partial<{ ID: string; HostName: string; TailscaleIPs: string[]; Online: boolean; OS: string; Tags: string[] }>;
  Peer?: Record<string, { ID: string; HostName: string; TailscaleIPs: string[]; Online: boolean; OS: string; Tags: string[] }>;
}) => ({
  Self: {
    ID: 'self-id',
    HostName: 'my-host',
    TailscaleIPs: ['100.0.0.1'],
    Online: true,
    OS: 'linux',
    Tags: [],
    ...overrides?.Self,
  },
  Peer: overrides?.Peer ?? {
    'peer-1': {
      ID: 'peer-1',
      HostName: 'peer-host',
      TailscaleIPs: ['100.0.0.2'],
      Online: true,
      OS: 'linux',
      Tags: ['tag:claudecluster'],
    },
  },
  CurrentTailnet: { Name: 'mynet' },
  MagicDNSSuffix: 'tail123.ts.net',
});

// Helper to mock tailscale command
const mockTailscaleCommand = (response: object | Error) => {
  const mockExec = exec as unknown as Mock;
  if (response instanceof Error) {
    mockExec.mockImplementation((_cmd: string, callback: Function) => {
      callback(response, null);
    });
  } else {
    mockExec.mockImplementation((_cmd: string, callback: Function) => {
      callback(null, { stdout: JSON.stringify(response) });
    });
  }
};

// Helper to create test discovery
function createTestDiscovery(overrides?: Partial<TailscaleDiscoveryConfig>) {
  return new TailscaleDiscovery({
    logger: createMockLogger(),
    pollIntervalMs: 1000,
    ...overrides,
  });
}

describe('TailscaleDiscovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should use default cluster tag "claudecluster"', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'peer-host',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
    });

    it('should use custom cluster tag when provided', async () => {
      const discovery = createTestDiscovery({ clusterTag: 'myproject' });
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'peer-host',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:myproject'],
          },
        },
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
    });
  });

  describe('Status Fetching', () => {
    it('should parse tailscale status JSON correctly', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse());

      await discovery.poll();

      const status = discovery.getStatus();
      expect(status).not.toBeNull();
      expect(status?.tailnetName).toBe('mynet');
      expect(status?.magicDNSSuffix).toBe('tail123.ts.net');
      expect(status?.nodes).toHaveLength(2); // self + 1 peer
    });

    it('should extract self IP and hostname', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Self: {
          ID: 'self-id',
          HostName: 'my-custom-host',
          TailscaleIPs: ['100.0.0.99'],
          Online: true,
          OS: 'linux',
          Tags: [],
        },
      }));

      await discovery.poll();

      expect(discovery.getSelfIP()).toBe('100.0.0.99');
      expect(discovery.getSelfHostname()).toBe('my-custom-host');
    });

    it('should handle tailscale command failure', async () => {
      const discovery = createTestDiscovery();
      const errorEvents: Error[] = [];
      discovery.on('error', (err: Error) => errorEvents.push(err));

      mockTailscaleCommand(new Error('tailscale not found'));

      await discovery.poll();

      expect(errorEvents).toHaveLength(1);
    });
  });
});
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add tests/tailscale-discovery.test.ts
git commit -m "test(tailscale): add initialization and status fetching tests"
```

---

### Task 2: Node Filtering Tests

**Files:**
- Modify: `tests/tailscale-discovery.test.ts`

**Step 1: Add Node Filtering tests**

Add after Status Fetching describe block:

```typescript
  describe('Node Filtering', () => {
    it('should filter nodes by cluster tag', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'cluster-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
          'peer-2': {
            ID: 'peer-2',
            HostName: 'other-node',
            TailscaleIPs: ['100.0.0.3'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:other'],
          },
        },
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('cluster-node');
    });

    it('should exclude offline nodes from cluster nodes', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'online-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
          'peer-2': {
            ID: 'peer-2',
            HostName: 'offline-node',
            TailscaleIPs: ['100.0.0.3'],
            Online: false,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('online-node');
    });

    it('should exclude self from cluster nodes', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Self: {
          ID: 'self-id',
          HostName: 'my-host',
          TailscaleIPs: ['100.0.0.1'],
          Online: true,
          OS: 'linux',
          Tags: ['tag:claudecluster'], // Self has cluster tag
        },
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'peer-host',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));

      await discovery.poll();

      const clusterNodes = discovery.getClusterNodes();
      expect(clusterNodes).toHaveLength(1);
      expect(clusterNodes[0].hostname).toBe('peer-host');
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 8 tests PASS

**Step 3: Commit**

```bash
git add tests/tailscale-discovery.test.ts
git commit -m "test(tailscale): add node filtering tests"
```

---

### Task 3: Event Emission Tests

**Files:**
- Modify: `tests/tailscale-discovery.test.ts`

**Step 1: Add Event Emission tests**

Add after Node Filtering describe block:

```typescript
  describe('Event Emission', () => {
    it('should emit nodeDiscovered for new online nodes', async () => {
      const discovery = createTestDiscovery();
      const discoveredNodes: TailscaleNode[] = [];
      discovery.on('nodeDiscovered', (node: TailscaleNode) => discoveredNodes.push(node));

      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'new-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));

      await discovery.poll();

      expect(discoveredNodes).toHaveLength(1);
      expect(discoveredNodes[0].hostname).toBe('new-node');
    });

    it('should emit nodeOnline when node comes online', async () => {
      const discovery = createTestDiscovery();
      const onlineNodes: TailscaleNode[] = [];
      discovery.on('nodeOnline', (node: TailscaleNode) => onlineNodes.push(node));

      // First poll - node is offline
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'flaky-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: false,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));
      await discovery.poll();

      // Second poll - node comes online
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'flaky-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));
      await discovery.poll();

      expect(onlineNodes).toHaveLength(1);
      expect(onlineNodes[0].hostname).toBe('flaky-node');
    });

    it('should emit nodeOffline when node goes offline', async () => {
      const discovery = createTestDiscovery();
      const offlineNodes: TailscaleNode[] = [];
      discovery.on('nodeOffline', (node: TailscaleNode) => offlineNodes.push(node));

      // First poll - node is online
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'flaky-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));
      await discovery.poll();

      // Second poll - node goes offline
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'flaky-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: false,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));
      await discovery.poll();

      expect(offlineNodes).toHaveLength(1);
      expect(offlineNodes[0].hostname).toBe('flaky-node');
    });

    it('should emit nodeRemoved when node disappears', async () => {
      const discovery = createTestDiscovery();
      const removedNodes: TailscaleNode[] = [];
      discovery.on('nodeRemoved', (node: TailscaleNode) => removedNodes.push(node));

      // First poll - node exists
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'temp-node',
            TailscaleIPs: ['100.0.0.2'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));
      await discovery.poll();

      // Second poll - node is gone
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {},
      }));
      await discovery.poll();

      expect(removedNodes).toHaveLength(1);
      expect(removedNodes[0].hostname).toBe('temp-node');
    });

    it('should emit error on poll failure', async () => {
      const discovery = createTestDiscovery();
      const errors: Error[] = [];
      discovery.on('error', (err: Error) => errors.push(err));

      mockTailscaleCommand(new Error('command failed'));
      await discovery.poll();

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('command failed');
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 13 tests PASS

**Step 3: Commit**

```bash
git add tests/tailscale-discovery.test.ts
git commit -m "test(tailscale): add event emission tests"
```

---

### Task 4: Polling Lifecycle Tests

**Files:**
- Modify: `tests/tailscale-discovery.test.ts`

**Step 1: Add Polling Lifecycle tests**

Add after Event Emission describe block:

```typescript
  describe('Polling Lifecycle', () => {
    it('should start polling at configured interval', async () => {
      const discovery = createTestDiscovery({ pollIntervalMs: 5000 });
      let pollCount = 0;

      mockTailscaleCommand(createFakeTailscaleResponse());

      // Spy on poll by counting status changes
      const originalPoll = discovery.poll.bind(discovery);
      discovery.poll = async () => {
        pollCount++;
        return originalPoll();
      };

      await discovery.start();
      expect(pollCount).toBe(1); // Initial poll

      await vi.advanceTimersByTimeAsync(5000);
      expect(pollCount).toBe(2); // Second poll

      await vi.advanceTimersByTimeAsync(5000);
      expect(pollCount).toBe(3); // Third poll

      discovery.stop();
    });

    it('should stop polling when stop() called', async () => {
      const discovery = createTestDiscovery({ pollIntervalMs: 1000 });
      let pollCount = 0;

      mockTailscaleCommand(createFakeTailscaleResponse());

      const originalPoll = discovery.poll.bind(discovery);
      discovery.poll = async () => {
        pollCount++;
        return originalPoll();
      };

      await discovery.start();
      expect(pollCount).toBe(1);

      discovery.stop();

      await vi.advanceTimersByTimeAsync(5000);
      expect(pollCount).toBe(1); // No more polls
    });

    it('should poll immediately on start', async () => {
      const discovery = createTestDiscovery({ pollIntervalMs: 60000 });
      mockTailscaleCommand(createFakeTailscaleResponse());

      await discovery.start();

      // Status should be available immediately
      expect(discovery.getStatus()).not.toBeNull();

      discovery.stop();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 16 tests PASS

**Step 3: Commit**

```bash
git add tests/tailscale-discovery.test.ts
git commit -m "test(tailscale): add polling lifecycle tests"
```

---

### Task 5: Static Helpers and Hostname Resolution Tests

**Files:**
- Modify: `tests/tailscale-discovery.test.ts`

**Step 1: Add Static Helpers and Hostname Resolution tests**

Add after Polling Lifecycle describe block:

```typescript
  describe('Static Helpers', () => {
    it('should return true from isAvailable when tailscale works', async () => {
      mockTailscaleCommand(createFakeTailscaleResponse());

      const available = await TailscaleDiscovery.isAvailable();

      expect(available).toBe(true);
    });

    it('should return false from isAvailable when tailscale fails', async () => {
      mockTailscaleCommand(new Error('tailscale not installed'));

      const available = await TailscaleDiscovery.isAvailable();

      expect(available).toBe(false);
    });
  });

  describe('Hostname Resolution', () => {
    it('should resolve hostname to IP', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse({
        Peer: {
          'peer-1': {
            ID: 'peer-1',
            HostName: 'target-host',
            TailscaleIPs: ['100.0.0.99'],
            Online: true,
            OS: 'linux',
            Tags: ['tag:claudecluster'],
          },
        },
      }));

      const ip = await discovery.resolveHostname('target-host');

      expect(ip).toBe('100.0.0.99');
    });

    it('should return null for unknown hostname', async () => {
      const discovery = createTestDiscovery();
      mockTailscaleCommand(createFakeTailscaleResponse());

      const ip = await discovery.resolveHostname('nonexistent-host');

      expect(ip).toBeNull();
    });
  });
```

**Step 2: Run tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 20 tests PASS

**Step 3: Commit**

```bash
git add tests/tailscale-discovery.test.ts
git commit -m "test(tailscale): add static helpers and hostname resolution tests"
```

---

### Task 6: Run Full Test Suite and Verify

**Step 1: Run all tailscale tests**

Run: `cd /home/paschal/claudecluster && npm test -- tests/tailscale-discovery.test.ts`
Expected: All 20 tests PASS

**Step 2: Run full test suite to ensure no regressions**

Run: `cd /home/paschal/claudecluster && npm test`
Expected: All tests PASS

**Step 3: Final commit**

```bash
git add -A
git commit -m "test(tailscale): complete TailscaleDiscovery test suite

Adds comprehensive tests for:
- Initialization and cluster tag configuration
- Status fetching and JSON parsing
- Node filtering by tag, online status, self exclusion
- Event emission (discovered, online, offline, removed, error)
- Polling lifecycle (start, stop, interval)
- Static helpers (isAvailable)
- Hostname resolution

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

| Task | Description | Tests Added |
|------|-------------|-------------|
| 1 | Setup + Initialization + Status Fetching | 5 |
| 2 | Node Filtering | 3 |
| 3 | Event Emission | 5 |
| 4 | Polling Lifecycle | 3 |
| 5 | Static Helpers + Hostname Resolution | 4 |
| 6 | Verification | - |

**Total: 20 tests**
