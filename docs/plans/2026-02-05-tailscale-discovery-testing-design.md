# Tailscale Discovery Testing Design

## Goal

Add comprehensive unit tests for `TailscaleDiscovery` class with mocked shell commands.

## Scope

**In scope:**
- Unit tests with mocked `child_process.exec`
- Status fetching and parsing
- Node filtering by cluster tag
- Event emission (discovered, online, offline, removed)
- Polling lifecycle
- Static helpers
- Hostname resolution

**Out of scope:**
- Integration tests with real Tailscale (requires network)
- End-to-end cluster formation tests

## Test Structure

**File:** `tests/tailscale-discovery.test.ts`

```
describe('TailscaleDiscovery')
  describe('Initialization')           - 2 tests
  describe('Status Fetching')          - 3 tests
  describe('Node Filtering')           - 3 tests
  describe('Event Emission')           - 5 tests
  describe('Polling Lifecycle')        - 3 tests
  describe('Static Helpers')           - 2 tests
  describe('Hostname Resolution')      - 2 tests
```

**Total: 20 tests**

## Mock Strategy

Mock `child_process.exec` to return fake Tailscale JSON responses:

```typescript
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

const mockTailscaleStatus = (response: object) => {
  (exec as unknown as Mock).mockImplementation((cmd, callback) => {
    callback(null, { stdout: JSON.stringify(response) });
  });
};
```

## Fake Tailscale Response

```typescript
const createFakeTailscaleResponse = (overrides?: Partial<FakeResponse>) => ({
  Self: {
    ID: 'self-id',
    HostName: 'my-host',
    TailscaleIPs: ['100.0.0.1'],
    Online: true,
    OS: 'linux',
    Tags: []
  },
  Peer: {
    'peer-1': {
      ID: 'peer-1',
      HostName: 'peer-host',
      TailscaleIPs: ['100.0.0.2'],
      Online: true,
      OS: 'linux',
      Tags: ['tag:claudecluster']
    }
  },
  CurrentTailnet: { Name: 'mynet' },
  MagicDNSSuffix: 'tail123.ts.net',
  ...overrides
});
```

## Test Cases

### Initialization (2 tests)
1. Should use default cluster tag "claudecluster"
2. Should use custom cluster tag when provided

### Status Fetching (3 tests)
1. Should parse tailscale status JSON correctly
2. Should extract self IP and hostname
3. Should handle tailscale command failure

### Node Filtering (3 tests)
1. Should filter nodes by cluster tag
2. Should exclude offline nodes from cluster nodes
3. Should exclude self from cluster nodes

### Event Emission (5 tests)
1. Should emit nodeDiscovered for new online nodes
2. Should emit nodeOnline when node comes online
3. Should emit nodeOffline when node goes offline
4. Should emit nodeRemoved when node disappears
5. Should emit error on poll failure

### Polling Lifecycle (3 tests)
1. Should start polling at configured interval
2. Should stop polling when stop() called
3. Should poll immediately on start

### Static Helpers (2 tests)
1. Should return true from isAvailable when tailscale works
2. Should return self IP from getSelfIP

### Hostname Resolution (2 tests)
1. Should resolve hostname to IP
2. Should return null for unknown hostname

## Success Criteria

- All 20 tests pass
- No regressions in existing tests
- Full coverage of TailscaleDiscovery public API
