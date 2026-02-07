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
