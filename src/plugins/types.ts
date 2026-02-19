import { Logger } from 'winston';
import { RaftNode } from '../cluster/raft.js';
import { MembershipManager } from '../cluster/membership.js';
import { TaskScheduler } from '../cluster/scheduler.js';
import { ClusterStateManager } from '../cluster/state.js';
import { GrpcClientPool } from '../grpc/client.js';
import { SharedMemoryDB } from '../memory/shared-memory-db.js';
import { MemoryReplicator } from '../memory/replication.js';
import { EventEmitter } from 'events';

export interface ToolHandler {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ResourceHandler {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: () => Promise<unknown>;
}

export interface PluginContext {
  raft: RaftNode;
  membership: MembershipManager;
  scheduler: TaskScheduler;
  stateManager: ClusterStateManager;
  clientPool: GrpcClientPool;
  sharedMemoryDb: SharedMemoryDB;
  memoryReplicator: MemoryReplicator;
  logger: Logger;
  nodeId: string;
  sessionId: string;
  config: Record<string, unknown>;
  events: EventEmitter;
}

export interface Plugin {
  name: string;
  version: string;

  init(ctx: PluginContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  getTools?(): Map<string, ToolHandler>;
  getResources?(): Map<string, ResourceHandler>;
}

export interface PluginEntry {
  enabled: boolean;
  [key: string]: unknown;
}

export type PluginsConfig = Record<string, PluginEntry>;
