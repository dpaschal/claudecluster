/**
 * cortex drain / cordon / uncordon — Node lifecycle management.
 */

import chalk from 'chalk';
import { GrpcClientPool, ClusterClient } from '../grpc/client.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'error',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function shortName(nodeId: string): string {
  const parts = nodeId.split('-');
  if (parts.length <= 1) return nodeId;
  return parts.slice(0, -1).join('-');
}

async function connectOrDie(address: string): Promise<{ pool: GrpcClientPool; client: ClusterClient }> {
  const pool = new GrpcClientPool({ logger });
  await pool.loadProto();
  const ready = await pool.waitForReady(address, 5000);
  if (!ready) {
    console.error(chalk.red(`Cannot connect to ${address}`));
    process.exit(1);
  }
  return { pool, client: new ClusterClient(pool, address) };
}

function findNode(nodes: any[], name: string): any {
  return nodes.find((n: any) => {
    const sn = shortName(n.node_id).toLowerCase();
    const hn = (n.hostname ?? '').toLowerCase();
    return sn === name.toLowerCase() || hn === name.toLowerCase();
  });
}

export interface NodeOpOpts {
  address: string;
}

export async function runDrain(nodeName: string, opts: NodeOpOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const state = await client.getClusterState();
    const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
    const node = findNode(nodes, nodeName);

    if (!node) {
      console.error(chalk.red(`Node "${nodeName}" not found. Available: ${nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
      process.exit(1);
    }

    if (node.node_id === state.leader_id) {
      console.error(chalk.yellow(`Warning: draining the leader (${shortName(node.node_id)}). Consider switch-leader first.`));
    }

    const name = shortName(node.node_id);
    console.log(`Draining tasks from ${chalk.cyan(name)}...`);

    // Use the SubmitTask-based approach: submit a drain command via gRPC
    // The task engine's drain_node_tasks re-queues all tasks from the node.
    // We'll call this via the leader's ClusterService.
    const leaderNode = state.nodes.find((n: any) => n.node_id === state.leader_id);
    if (!leaderNode) {
      console.error(chalk.red('No leader found'));
      process.exit(1);
    }

    const leaderAddr = `${leaderNode.tailscale_ip}:${leaderNode.grpc_port || 50051}`;
    await pool.waitForReady(leaderAddr, 5000);
    const leaderConn = pool.getConnection(leaderAddr);

    // Call DeregisterNode with graceful=true to trigger drain
    const resp: any = await pool.call(leaderConn.clusterClient, 'DeregisterNode', {
      node_id: node.node_id,
      graceful: true,
    });

    if (resp.success) {
      console.log(chalk.green(`  ${name} drained — node set to draining status, tasks will be rescheduled`));
    } else {
      console.error(chalk.red(`  Drain failed`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}

export async function runCordon(nodeName: string, opts: NodeOpOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const state = await client.getClusterState();
    const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
    const node = findNode(nodes, nodeName);

    if (!node) {
      console.error(chalk.red(`Node "${nodeName}" not found. Available: ${nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
      process.exit(1);
    }

    const name = shortName(node.node_id);

    if (node.status?.includes('DRAINING')) {
      console.log(chalk.yellow(`${name} is already cordoned (draining)`));
      process.exit(0);
    }

    console.log(`Cordoning ${chalk.cyan(name)} — no new tasks will be scheduled...`);

    // Set node status to draining via graceful deregister
    const leaderNode = state.nodes.find((n: any) => n.node_id === state.leader_id);
    if (!leaderNode) {
      console.error(chalk.red('No leader found'));
      process.exit(1);
    }

    const leaderAddr = `${leaderNode.tailscale_ip}:${leaderNode.grpc_port || 50051}`;
    await pool.waitForReady(leaderAddr, 5000);
    const leaderConn = pool.getConnection(leaderAddr);

    const resp: any = await pool.call(leaderConn.clusterClient, 'DeregisterNode', {
      node_id: node.node_id,
      graceful: true,
    });

    if (resp.success) {
      console.log(chalk.green(`  ${name} cordoned — existing tasks continue, no new scheduling`));
    } else {
      console.error(chalk.red(`  Cordon failed`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}

export async function runUncordon(nodeName: string, opts: NodeOpOpts): Promise<void> {
  const { pool, client } = await connectOrDie(opts.address);

  try {
    const state = await client.getClusterState();
    const nodes = state.nodes.filter((n: any) => !n.node_id.endsWith('-mcp'));
    const node = findNode(nodes, nodeName);

    if (!node) {
      console.error(chalk.red(`Node "${nodeName}" not found. Available: ${nodes.map((n: any) => shortName(n.node_id)).join(', ')}`));
      process.exit(1);
    }

    const name = shortName(node.node_id);

    if (node.status?.includes('ACTIVE')) {
      console.log(chalk.yellow(`${name} is already active (not cordoned)`));
      process.exit(0);
    }

    console.log(`Uncordoning ${chalk.cyan(name)} — re-enabling for scheduling...`);

    // Re-register the node to set it back to active
    const leaderNode = state.nodes.find((n: any) => n.node_id === state.leader_id);
    if (!leaderNode) {
      console.error(chalk.red('No leader found'));
      process.exit(1);
    }

    const leaderAddr = `${leaderNode.tailscale_ip}:${leaderNode.grpc_port || 50051}`;
    await pool.waitForReady(leaderAddr, 5000);
    const leaderConn = pool.getConnection(leaderAddr);

    const resp: any = await pool.call(leaderConn.clusterClient, 'RegisterNode', {
      node: {
        node_id: node.node_id,
        hostname: node.hostname,
        tailscale_ip: node.tailscale_ip,
        grpc_port: node.grpc_port,
        role: node.role,
        status: 'NODE_STATUS_ACTIVE',
        tags: node.tags,
      },
    });

    if (resp.approved || resp.pending_approval) {
      console.log(chalk.green(`  ${name} uncordoned — active for scheduling`));
    } else {
      console.error(chalk.red(`  Uncordon failed`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  } finally {
    pool.closeAll();
  }
}
