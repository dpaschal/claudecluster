# Network Device MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP tools so Claude can answer "what's the IP of terminus?" by querying the `network_clients` and `networks` tables on anvil.

**Architecture:** New `network-db.ts` module wraps `pg` pool queries against the existing `public.network_clients` and `public.networks` tables in the cerebrus DB on anvil (same connection string as timeline-db). New `network-tools.ts` exports `createNetworkTools()` returning `Map<string, ToolHandler>` — follows the exact pattern of `timeline-tools.ts`. Server merges them in `server.ts`.

**Tech Stack:** TypeScript, pg, vitest, MCP SDK (existing patterns)

---

### Task 1: Create network-db.ts — database access layer

**Files:**
- Create: `src/mcp/network-db.ts`

**Step 1: Write the failing test**

Create `tests/network-db.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkDB } from '../src/mcp/network-db.js';

// Mock pg module
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return {
    default: {
      Pool: vi.fn(() => ({
        query: mockQuery,
        end: mockEnd,
      })),
    },
    __mockQuery: mockQuery,
    __mockEnd: mockEnd,
  };
});

// Access mocks
async function getMocks() {
  const pgModule = await import('pg') as any;
  return {
    mockQuery: pgModule.__mockQuery as ReturnType<typeof vi.fn>,
    mockEnd: pgModule.__mockEnd as ReturnType<typeof vi.fn>,
  };
}

describe('NetworkDB', () => {
  let db: NetworkDB;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mocks = await getMocks();
    mockQuery = mocks.mockQuery;
    mockQuery.mockReset();
    mocks.mockEnd.mockReset();
    db = new NetworkDB();
  });

  describe('lookupDevice', () => {
    it('finds a device by hostname (case-insensitive)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 4, hostname: 'terminus', ip_address: '192.168.1.16',
          mac_address: '00:00:00:00:00:03', device_type: 'workstation',
          connection_type: null, network: 'Main LAN', vlan_id: 1,
          status: 'active', last_seen: new Date('2026-02-06'),
        }],
      });

      const result = await db.lookupDevice('Terminus');
      expect(result).toHaveLength(1);
      expect(result[0].hostname).toBe('terminus');
      expect(result[0].ip_address).toBe('192.168.1.16');
      expect(mockQuery.mock.calls[0][1]).toEqual(['%terminus%']);
    });

    it('returns empty array when no match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await db.lookupDevice('nonexistent');
      expect(result).toHaveLength(0);
    });
  });

  describe('listDevices', () => {
    it('returns all devices when no filter', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, hostname: 'anvil', ip_address: '192.168.1.138', network: 'Main LAN' },
          { id: 2, hostname: 'forge', ip_address: '10.0.10.11', network: '10GbE Infrastructure' },
        ],
      });

      const result = await db.listDevices();
      expect(result).toHaveLength(2);
    });

    it('filters by network', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, hostname: 'anvil', ip_address: '192.168.1.138', network: 'Main LAN' }],
      });

      const result = await db.listDevices({ network: 'Main LAN' });
      expect(result).toHaveLength(1);
      expect(mockQuery.mock.calls[0][1]).toEqual(['Main LAN']);
    });

    it('filters by device_type', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, hostname: 'anvil', device_type: 'server' }],
      });

      const result = await db.listDevices({ device_type: 'server' });
      expect(result).toHaveLength(1);
    });
  });

  describe('listNetworks', () => {
    it('returns all networks', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, network_id: 'vlan1', name: 'Main LAN', subnet: '192.168.1.0/24', vlan_id: 1 },
          { id: 2, network_id: 'vlan2', name: 'Home WiFi', subnet: '192.168.2.0/24', vlan_id: 2 },
        ],
      });

      const result = await db.listNetworks();
      expect(result).toHaveLength(2);
    });
  });

  describe('addDevice', () => {
    it('inserts a new device and returns it', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 10, hostname: 'newbox', ip_address: '192.168.1.50',
          mac_address: 'aa:bb:cc:dd:ee:ff', device_type: 'server',
          network: 'Main LAN', vlan_id: 1, status: 'online',
        }],
      });

      const result = await db.addDevice({
        hostname: 'newbox',
        ip_address: '192.168.1.50',
        mac_address: 'aa:bb:cc:dd:ee:ff',
        device_type: 'server',
        network: 'Main LAN',
        vlan_id: 1,
      });

      expect(result.hostname).toBe('newbox');
      expect(result.ip_address).toBe('192.168.1.50');
    });
  });

  describe('updateDevice', () => {
    it('updates fields on an existing device', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 4, hostname: 'terminus', ip_address: '192.168.1.20',
          mac_address: 'aa:bb:cc:dd:ee:ff', status: 'online',
        }],
      });

      const result = await db.updateDevice(4, {
        ip_address: '192.168.1.20',
        mac_address: 'aa:bb:cc:dd:ee:ff',
      });

      expect(result).not.toBeNull();
      expect(result!.ip_address).toBe('192.168.1.20');
    });

    it('returns null when no updates provided', async () => {
      const result = await db.updateDevice(4, {});
      expect(result).toBeNull();
    });
  });

  describe('close', () => {
    it('closes the pool', async () => {
      const mocks = await getMocks();
      await db.close();
      expect(mocks.mockEnd).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/paschal/claudecluster && npx vitest run tests/network-db.test.ts`
Expected: FAIL — `Cannot find module '../src/mcp/network-db.js'`

**Step 3: Write the implementation**

Create `src/mcp/network-db.ts`:

```typescript
import pg from 'pg';

const { Pool } = pg;

export interface NetworkClient {
  id: number;
  hostname: string | null;
  ip_address: string;
  mac_address: string;
  device_type: string | null;
  connection_type: string | null;
  network: string | null;
  vlan_id: number | null;
  status: string | null;
  uptime_seconds: number | null;
  signal_strength: number | null;
  ssid: string | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  discovered_at: Date | null;
  last_seen: Date | null;
}

export interface Network {
  id: number;
  network_id: string;
  name: string;
  subnet: string | null;
  vlan_id: number | null;
  dhcp_enabled: boolean | null;
  purpose: string | null;
  discovered_at: Date | null;
  last_seen: Date | null;
}

export interface AddDeviceInput {
  hostname: string;
  ip_address: string;
  mac_address: string;
  device_type?: string;
  connection_type?: string;
  network?: string;
  vlan_id?: number;
}

export class NetworkDB {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus',
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async lookupDevice(query: string): Promise<NetworkClient[]> {
    const result = await this.pool.query<NetworkClient>(
      `SELECT * FROM network_clients
       WHERE hostname ILIKE $1 OR ip_address::text LIKE $1 OR mac_address::text ILIKE $1
       ORDER BY hostname`,
      [`%${query.toLowerCase()}%`]
    );
    return result.rows;
  }

  async listDevices(filter?: { network?: string; device_type?: string }): Promise<NetworkClient[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter?.network) {
      conditions.push(`network = $${idx++}`);
      params.push(filter.network);
    }
    if (filter?.device_type) {
      conditions.push(`device_type = $${idx++}`);
      params.push(filter.device_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query<NetworkClient>(
      `SELECT * FROM network_clients ${where} ORDER BY hostname`,
      params
    );
    return result.rows;
  }

  async listNetworks(): Promise<Network[]> {
    const result = await this.pool.query<Network>(
      'SELECT * FROM networks ORDER BY name'
    );
    return result.rows;
  }

  async addDevice(input: AddDeviceInput): Promise<NetworkClient> {
    const result = await this.pool.query<NetworkClient>(
      `INSERT INTO network_clients (hostname, ip_address, mac_address, device_type, connection_type, network, vlan_id, status)
       VALUES ($1, $2::inet, $3::macaddr, $4, $5, $6, $7, 'online')
       RETURNING *`,
      [input.hostname, input.ip_address, input.mac_address, input.device_type ?? null,
       input.connection_type ?? null, input.network ?? null, input.vlan_id ?? null]
    );
    return result.rows[0];
  }

  async updateDevice(id: number, updates: Partial<Pick<NetworkClient, 'hostname' | 'ip_address' | 'mac_address' | 'device_type' | 'connection_type' | 'network' | 'vlan_id' | 'status'>>): Promise<NetworkClient | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (key === 'ip_address') {
          setClauses.push(`${key} = $${idx++}::inet`);
        } else if (key === 'mac_address') {
          setClauses.push(`${key} = $${idx++}::macaddr`);
        } else {
          setClauses.push(`${key} = $${idx++}`);
        }
        params.push(value);
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push(`last_seen = now()`);
    params.push(id);

    const result = await this.pool.query<NetworkClient>(
      `UPDATE network_clients SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] ?? null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/paschal/claudecluster && npx vitest run tests/network-db.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/network-db.ts tests/network-db.test.ts
git commit -m "feat: add network-db module for querying network_clients and networks tables"
```

---

### Task 2: Create network-tools.ts — MCP tool definitions

**Files:**
- Create: `src/mcp/network-tools.ts`

**Step 1: Write the failing test**

Create `tests/network-tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNetworkTools } from '../src/mcp/network-tools.js';
import { NetworkDB } from '../src/mcp/network-db.js';
import { Logger } from 'winston';

vi.mock('../src/mcp/network-db.js');

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe('createNetworkTools', () => {
  let tools: ReturnType<typeof createNetworkTools>['tools'];
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      lookupDevice: vi.fn(),
      listDevices: vi.fn(),
      listNetworks: vi.fn(),
      addDevice: vi.fn(),
      updateDevice: vi.fn(),
      close: vi.fn(),
    };
    vi.mocked(NetworkDB).mockImplementation(() => mockDb);
    const result = createNetworkTools({ logger: mockLogger });
    tools = result.tools;
  });

  it('registers 5 tools', () => {
    expect(tools.size).toBe(5);
    expect(tools.has('network_lookup')).toBe(true);
    expect(tools.has('network_list_devices')).toBe(true);
    expect(tools.has('network_list_networks')).toBe(true);
    expect(tools.has('network_add_device')).toBe(true);
    expect(tools.has('network_update_device')).toBe(true);
  });

  describe('network_lookup', () => {
    it('looks up device by query string', async () => {
      mockDb.lookupDevice.mockResolvedValueOnce([{
        hostname: 'terminus', ip_address: '192.168.1.16', network: 'Main LAN',
      }]);

      const handler = tools.get('network_lookup')!;
      const result = await handler.handler({ query: 'terminus' });
      expect(mockDb.lookupDevice).toHaveBeenCalledWith('terminus');
      expect(result).toHaveLength(1);
    });

    it('requires query parameter', async () => {
      const handler = tools.get('network_lookup')!;
      expect(handler.inputSchema.required).toContain('query');
    });
  });

  describe('network_list_devices', () => {
    it('lists all devices with no filter', async () => {
      mockDb.listDevices.mockResolvedValueOnce([
        { hostname: 'anvil' }, { hostname: 'terminus' },
      ]);

      const handler = tools.get('network_list_devices')!;
      const result = await handler.handler({});
      expect(mockDb.listDevices).toHaveBeenCalledWith({});
    });

    it('passes network filter', async () => {
      mockDb.listDevices.mockResolvedValueOnce([{ hostname: 'anvil' }]);

      const handler = tools.get('network_list_devices')!;
      await handler.handler({ network: 'Main LAN' });
      expect(mockDb.listDevices).toHaveBeenCalledWith({ network: 'Main LAN' });
    });
  });

  describe('network_list_networks', () => {
    it('lists all networks', async () => {
      mockDb.listNetworks.mockResolvedValueOnce([
        { name: 'Main LAN', subnet: '192.168.1.0/24' },
      ]);

      const handler = tools.get('network_list_networks')!;
      const result = await handler.handler({});
      expect(mockDb.listNetworks).toHaveBeenCalled();
    });
  });

  describe('network_add_device', () => {
    it('adds a new device', async () => {
      mockDb.addDevice.mockResolvedValueOnce({
        id: 10, hostname: 'newbox', ip_address: '192.168.1.50',
      });

      const handler = tools.get('network_add_device')!;
      const result = await handler.handler({
        hostname: 'newbox',
        ip_address: '192.168.1.50',
        mac_address: 'aa:bb:cc:dd:ee:ff',
      });

      expect(mockDb.addDevice).toHaveBeenCalledWith({
        hostname: 'newbox',
        ip_address: '192.168.1.50',
        mac_address: 'aa:bb:cc:dd:ee:ff',
        device_type: undefined,
        connection_type: undefined,
        network: undefined,
        vlan_id: undefined,
      });
    });

    it('requires hostname, ip_address, mac_address', () => {
      const handler = tools.get('network_add_device')!;
      expect(handler.inputSchema.required).toEqual(['hostname', 'ip_address', 'mac_address']);
    });
  });

  describe('network_update_device', () => {
    it('updates a device by id', async () => {
      mockDb.updateDevice.mockResolvedValueOnce({
        id: 4, hostname: 'terminus', ip_address: '192.168.1.20',
      });

      const handler = tools.get('network_update_device')!;
      const result = await handler.handler({ id: 4, ip_address: '192.168.1.20' });
      expect(mockDb.updateDevice).toHaveBeenCalledWith(4, { ip_address: '192.168.1.20' });
    });

    it('throws when device not found', async () => {
      mockDb.updateDevice.mockResolvedValueOnce(null);

      const handler = tools.get('network_update_device')!;
      await expect(handler.handler({ id: 999 })).rejects.toThrow('not found');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/paschal/claudecluster && npx vitest run tests/network-tools.test.ts`
Expected: FAIL — `Cannot find module '../src/mcp/network-tools.js'`

**Step 3: Write the implementation**

Create `src/mcp/network-tools.ts`:

```typescript
import { Logger } from 'winston';
import { NetworkDB } from './network-db.js';
import { ToolHandler } from './tools.js';

export interface NetworkToolsConfig {
  logger: Logger;
  connectionString?: string;
}

export function createNetworkTools(config: NetworkToolsConfig): { tools: Map<string, ToolHandler>; db: NetworkDB } {
  const db = new NetworkDB(config.connectionString);
  const tools = new Map<string, ToolHandler>();

  tools.set('network_lookup', {
    description: 'Look up a network device by hostname, IP address, or MAC address. Use this to answer questions like "what\'s the IP of terminus?" or "what device is at 192.168.1.16?".',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Hostname, IP address, or MAC address to search for (partial match, case-insensitive)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const devices = await db.lookupDevice(args.query as string);
      config.logger.info('Network lookup', { query: args.query, results: devices.length });
      return devices;
    },
  });

  tools.set('network_list_devices', {
    description: 'List all known network devices, optionally filtered by network name or device type.',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          description: 'Filter by network name (e.g., "Main LAN", "10GbE Infrastructure")',
        },
        device_type: {
          type: 'string',
          description: 'Filter by device type (e.g., "server", "workstation", "storage")',
        },
      },
    },
    handler: async (args) => {
      const filter: { network?: string; device_type?: string } = {};
      if (args.network) filter.network = args.network as string;
      if (args.device_type) filter.device_type = args.device_type as string;
      const devices = await db.listDevices(filter);
      config.logger.info('Network list devices', { filter, count: devices.length });
      return devices;
    },
  });

  tools.set('network_list_networks', {
    description: 'List all known networks (VLANs) with their subnets.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const networks = await db.listNetworks();
      config.logger.info('Network list networks', { count: networks.length });
      return networks;
    },
  });

  tools.set('network_add_device', {
    description: 'Add a new device to the network inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'Device hostname' },
        ip_address: { type: 'string', description: 'IP address (e.g., "192.168.1.50")' },
        mac_address: { type: 'string', description: 'MAC address (e.g., "aa:bb:cc:dd:ee:ff")' },
        device_type: { type: 'string', description: 'Device type (server, workstation, storage, bmc, etc.)' },
        connection_type: { type: 'string', description: 'Connection type (wired, wifi)' },
        network: { type: 'string', description: 'Network name (e.g., "Main LAN")' },
        vlan_id: { type: 'number', description: 'VLAN ID' },
      },
      required: ['hostname', 'ip_address', 'mac_address'],
    },
    handler: async (args) => {
      const device = await db.addDevice({
        hostname: args.hostname as string,
        ip_address: args.ip_address as string,
        mac_address: args.mac_address as string,
        device_type: args.device_type as string | undefined,
        connection_type: args.connection_type as string | undefined,
        network: args.network as string | undefined,
        vlan_id: args.vlan_id as number | undefined,
      });
      config.logger.info('Network device added', { id: device.id, hostname: device.hostname });
      return device;
    },
  });

  tools.set('network_update_device', {
    description: 'Update an existing network device by its ID. Use network_lookup first to find the device ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID (from network_lookup or network_list_devices)' },
        hostname: { type: 'string', description: 'New hostname' },
        ip_address: { type: 'string', description: 'New IP address' },
        mac_address: { type: 'string', description: 'New MAC address' },
        device_type: { type: 'string', description: 'New device type' },
        connection_type: { type: 'string', description: 'New connection type' },
        network: { type: 'string', description: 'New network name' },
        vlan_id: { type: 'number', description: 'New VLAN ID' },
        status: { type: 'string', description: 'New status (online, offline, active)' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = args.id as number;
      const { id: _id, ...updates } = args;
      // Strip undefined values
      const cleanUpdates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) cleanUpdates[k] = v;
      }

      const device = await db.updateDevice(id, cleanUpdates);
      if (!device) {
        throw new Error(`Device ${id} not found or no updates provided`);
      }
      config.logger.info('Network device updated', { id: device.id, hostname: device.hostname });
      return device;
    },
  });

  return { tools, db };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/paschal/claudecluster && npx vitest run tests/network-tools.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/network-tools.ts tests/network-tools.test.ts
git commit -m "feat: add network MCP tools (lookup, list, add, update)"
```

---

### Task 3: Wire network tools into the MCP server

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Add import and property**

At line 16 in `server.ts`, after the TimelineDB import:

```typescript
import { createNetworkTools } from './network-tools.js';
import { NetworkDB } from './network-db.js';
```

Add property at line 33, after `private timelineDb`:

```typescript
private networkDb: NetworkDB | null = null;
```

**Step 2: Register network tools in createToolHandlers()**

After the timeline tools block (line 72), add:

```typescript
// Add network tools
const { tools: networkTools, db: netDb } = createNetworkTools({
  logger: this.config.logger,
});
this.networkDb = netDb;

for (const [name, handler] of networkTools) {
  clusterTools.set(name, handler);
}
```

**Step 3: Close network DB in stop()**

In the `stop()` method, after the timelineDb close block:

```typescript
if (this.networkDb) {
  await this.networkDb.close();
}
```

**Step 4: Build to verify compilation**

Run: `cd /home/paschal/claudecluster && npm run build`
Expected: Compiles with no errors

**Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: wire network tools into MCP server"
```

---

### Task 4: Verify end-to-end with a manual query on anvil

**Step 1: Verify the tools are queryable**

Run a quick smoke test by querying the DB directly to confirm the SQL from `network-db.ts` works against the real schema:

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.138 "psql -U cerebrus -d cerebrus" <<'EOSQL'
-- Simulates network_lookup('terminus')
SELECT * FROM network_clients
WHERE hostname ILIKE '%terminus%' OR ip_address::text LIKE '%terminus%' OR mac_address::text ILIKE '%terminus%'
ORDER BY hostname;

-- Simulates network_list_devices({network: 'Main LAN'})
SELECT * FROM network_clients WHERE network = 'Main LAN' ORDER BY hostname;

-- Simulates network_list_networks()
SELECT * FROM networks ORDER BY name;
EOSQL
```

Expected: All three queries return correct results.

**Step 2: Run the full test suite**

Run: `cd /home/paschal/claudecluster && npx vitest run`
Expected: All tests pass including the new network-db and network-tools tests.

**Step 3: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: adjust network queries for real schema compatibility"
```

---

### Task 5: Update timeline thread with progress

**Step 1: Log progress to the UDM Pro device tracking thread**

```bash
ssh -o StrictHostKeyChecking=no paschal@192.168.1.138 "psql -U cerebrus -d cerebrus" <<'EOSQL'
INSERT INTO timeline.thoughts (thread_id, parent_thought_id, content, thought_type, metadata)
VALUES (
  3,
  4,
  'MCP tools implemented: network_lookup, network_list_devices, network_list_networks, network_add_device, network_update_device. Wired into claudecluster MCP server. Tests passing. Next: fix fake MACs.',
  'progress',
  '{"files": ["src/mcp/network-db.ts", "src/mcp/network-tools.ts", "tests/network-db.test.ts", "tests/network-tools.test.ts"]}'
)
RETURNING id;

-- Update thread position
UPDATE timeline.thread_position SET current_thought_id = (SELECT MAX(id) FROM timeline.thoughts WHERE thread_id = 3), updated_at = now() WHERE thread_id = 3;
UPDATE timeline.threads SET updated_at = now() WHERE id = 3;
EOSQL
```
