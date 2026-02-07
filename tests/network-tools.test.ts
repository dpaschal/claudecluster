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
