import * as grpc from '@grpc/grpc-js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from 'winston';
import { MembershipManager, NodeInfo } from '../cluster/membership.js';
import { RaftNode } from '../cluster/raft.js';
import { TaskScheduler } from '../cluster/scheduler.js';
import { ClusterStateManager } from '../cluster/state.js';
import { TaskExecutor } from '../agent/task-executor.js';
import { ResourceMonitor } from '../agent/resource-monitor.js';

export interface ServiceHandlersConfig {
  logger: Logger;
  nodeId: string;
  membership: MembershipManager;
  raft: RaftNode;
  /** @deprecated Optional when task-engine plugin is enabled. */
  scheduler?: TaskScheduler;
  stateManager: ClusterStateManager;
  taskExecutor: TaskExecutor;
  resourceMonitor: ResourceMonitor;
}

export function createClusterServiceHandlers(config: ServiceHandlersConfig): grpc.UntypedServiceImplementation {
  const { logger, membership, raft, scheduler, stateManager } = config;

  return {
    // Node registration
    RegisterNode: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const request = call.request;
        logger.info('Received RegisterNode request', {
          nodeId: request.node?.node_id,
          hostname: request.node?.hostname
        });

        const nodeInfo: NodeInfo = {
          nodeId: request.node.node_id,
          hostname: request.node.hostname,
          tailscaleIp: request.node.tailscale_ip,
          grpcPort: request.node.grpc_port,
          role: 'follower',
          status: 'pending_approval',
          resources: null,
          tags: request.node.tags || [],
          joinedAt: Date.now(),
          lastSeen: Date.now(),
        };

        const result = await membership.handleJoinRequest(nodeInfo);

        callback(null, {
          approved: result.approved,
          pending_approval: result.pendingApproval,
          cluster_id: result.clusterId,
          leader_address: result.leaderAddress,
          peers: result.peers.map(p => ({
            node_id: p.nodeId,
            hostname: p.hostname,
            tailscale_ip: p.tailscaleIp,
            grpc_port: p.grpcPort,
            role: `NODE_ROLE_${p.role.toUpperCase()}`,
            status: `NODE_STATUS_${p.status.toUpperCase()}`,
            tags: p.tags,
            joined_at: p.joinedAt.toString(),
            last_seen: p.lastSeen.toString(),
          })),
        });
      } catch (error) {
        logger.error('RegisterNode failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Deregister node
    DeregisterNode: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const { node_id, graceful } = call.request;
        logger.info('Received DeregisterNode request', { nodeId: node_id });

        const success = await membership.removeNode(node_id, graceful ?? true);
        callback(null, { success });
      } catch (error) {
        logger.error('DeregisterNode failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Heartbeat
    Heartbeat: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const { node_id, resources } = call.request;

        // Always update lastSeen on heartbeat, even without resources
        const node = membership.getNode(node_id);
        if (node) {
          node.lastSeen = Date.now();
          if (node.status === 'offline') {
            node.status = 'active';
            logger.info('Node recovered via heartbeat', { nodeId: node_id });
          }
        }

        if (resources) {
          membership.updateNodeResources(node_id, {
            cpuCores: resources.cpu_cores,
            memoryBytes: parseInt(resources.memory_bytes),
            memoryAvailableBytes: parseInt(resources.memory_available_bytes),
            gpus: (resources.gpus || []).map((g: any) => ({
              name: g.name,
              memoryBytes: parseInt(g.memory_bytes),
              memoryAvailableBytes: parseInt(g.memory_available_bytes),
              utilizationPercent: g.utilization_percent,
              inUseForGaming: g.in_use_for_gaming,
            })),
            diskBytes: parseInt(resources.disk_bytes),
            diskAvailableBytes: parseInt(resources.disk_available_bytes),
            cpuUsagePercent: resources.cpu_usage_percent,
            gamingDetected: resources.gaming_detected,
          });
        }

        const leaderAddress = membership.getLeaderAddress();

        callback(null, {
          acknowledged: true,
          leader_address: leaderAddress || '',
          pending_tasks: [],
          leader_id: raft.getLeaderId() || '',
        });
      } catch (error) {
        logger.error('Heartbeat failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Get cluster state
    GetClusterState: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const state = stateManager.getState();
        const s = (v: any) => (v ?? 0).toString();

        // Build a set of Raft-alive peers (matchIndex > 0 = has replicated)
        const raftAlive = new Set<string>();
        if (raft.isLeader()) {
          const commitIndex = raft.getCommitIndex();
          for (const peer of raft.getPeers()) {
            if (peer.matchIndex > 0 || commitIndex === 0) {
              raftAlive.add(peer.nodeId);
            }
          }
        }

        callback(null, {
          cluster_id: state.clusterId ?? '',
          leader_id: state.leaderId ?? '',
          term: s(state.term),
          nodes: (state.nodes ?? []).map(n => {
            // Override stale membership status with Raft liveness data
            let status = n.status ?? 'unknown';
            if (raftAlive.size > 0 && raftAlive.has(n.nodeId)) {
              status = 'active';
            }
            return {
            node_id: n.nodeId ?? '',
            hostname: n.hostname ?? '',
            tailscale_ip: n.tailscaleIp ?? '',
            grpc_port: n.grpcPort ?? 50051,
            role: `NODE_ROLE_${(n.role ?? 'unknown').toUpperCase()}`,
            status: `NODE_STATUS_${status.toUpperCase()}`,
            resources: n.resources ? {
              cpu_cores: n.resources.cpuCores ?? 0,
              memory_bytes: s(n.resources.memoryBytes),
              memory_available_bytes: s(n.resources.memoryAvailableBytes),
              gpus: (n.resources.gpus ?? []).map((g: any) => ({
                name: g.name ?? '',
                memory_bytes: s(g.memoryBytes),
                memory_available_bytes: s(g.memoryAvailableBytes),
                utilization_percent: g.utilizationPercent ?? 0,
                in_use_for_gaming: g.inUseForGaming ?? false,
              })),
              disk_bytes: s(n.resources.diskBytes),
              disk_available_bytes: s(n.resources.diskAvailableBytes),
              cpu_usage_percent: n.resources.cpuUsagePercent ?? 0,
              gaming_detected: n.resources.gamingDetected ?? false,
            } : undefined,
            tags: n.tags ?? [],
            joined_at: s(n.joinedAt),
            last_seen: s(n.lastSeen),
          };}),
          total_resources: state.totalResources ? {
            cpu_cores: state.totalResources.cpuCores ?? 0,
            memory_bytes: s(state.totalResources.memoryBytes),
            gpu_count: state.totalResources.gpuCount ?? 0,
            gpu_memory_bytes: s(state.totalResources.gpuMemoryBytes),
          } : { cpu_cores: 0, memory_bytes: '0', gpu_count: 0, gpu_memory_bytes: '0' },
          available_resources: state.availableResources ? {
            cpu_cores: state.availableResources.cpuCores ?? 0,
            memory_bytes: s(state.availableResources.memoryBytes),
            gpu_count: state.availableResources.gpuCount ?? 0,
            gpu_memory_bytes: s(state.availableResources.gpuMemoryBytes),
          } : { cpu_cores: 0, memory_bytes: '0', gpu_count: 0, gpu_memory_bytes: '0' },
          active_tasks: state.activeTasks ?? 0,
          queued_tasks: state.queuedTasks ?? 0,
        });
      } catch (error) {
        logger.error('GetClusterState failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Transfer leadership (step down)
    TransferLeadership: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        if (!raft.isLeader()) {
          callback(null, {
            success: false,
            message: `This node is not the leader. Current leader: ${raft.getLeaderId() ?? 'unknown'}`,
          });
          return;
        }
        const term = raft.getCurrentTerm();
        const stepped = raft.stepDown();
        if (stepped) {
          logger.info('Leadership transfer: stepped down', { term });
          callback(null, {
            success: true,
            message: `Stepped down from term ${term}. New election in progress.`,
          });
        } else {
          callback(null, { success: false, message: 'stepDown failed' });
        }
      } catch (error) {
        logger.error('TransferLeadership failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Submit task
    SubmitTask: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        if (!scheduler) {
          callback({
            code: grpc.status.UNAVAILABLE,
            message: 'Legacy TaskScheduler disabled — use the task-engine plugin instead',
          });
          return;
        }
        const { spec } = call.request;
        logger.info('Received SubmitTask', { taskId: spec?.task_id, type: spec?.type });

        const result = await scheduler.submit({
          taskId: spec.task_id,
          type: spec.type.replace('TASK_TYPE_', '').toLowerCase(),
          submitterNode: spec.submitter_node,
          submitterSession: spec.submitter_session,
          shell: spec.shell ? {
            command: spec.shell.command,
            workingDirectory: spec.shell.working_directory,
            sandboxed: spec.shell.sandboxed,
          } : undefined,
          container: spec.container ? {
            image: spec.container.image,
            command: spec.container.command,
            args: spec.container.args,
          } : undefined,
          constraints: spec.constraints ? {
            allowedNodes: spec.constraints.allowed_nodes,
            excludedNodes: spec.constraints.excluded_nodes,
            preferLocal: spec.constraints.prefer_local,
            avoidGamingNodes: spec.constraints.avoid_gaming_nodes,
          } : undefined,
          priority: spec.priority,
          timeoutMs: spec.timeout_ms ? parseInt(spec.timeout_ms) : undefined,
        });

        callback(null, {
          task_id: result.taskId,
          accepted: result.accepted,
          assigned_node: result.assignedNode || '',
          rejection_reason: result.reason || '',
        });
      } catch (error) {
        logger.error('SubmitTask failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Get task status
    GetTaskStatus: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        if (!scheduler) {
          callback({
            code: grpc.status.UNAVAILABLE,
            message: 'Legacy TaskScheduler disabled — use the task-engine plugin instead',
          });
          return;
        }
        const { task_id } = call.request;
        const status = scheduler.getStatus(task_id);

        if (!status) {
          callback({
            code: grpc.status.NOT_FOUND,
            message: `Task not found: ${task_id}`,
          });
          return;
        }

        callback(null, {
          task_id: status.taskId,
          state: `TASK_STATE_${status.state.toUpperCase()}`,
          assigned_node: status.assignedNode || '',
          started_at: status.startedAt?.toString() || '',
          completed_at: status.completedAt?.toString() || '',
          exit_code: status.exitCode ?? 0,
          error: status.error || '',
        });
      } catch (error) {
        logger.error('GetTaskStatus failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Cancel task
    CancelTask: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        if (!scheduler) {
          callback({
            code: grpc.status.UNAVAILABLE,
            message: 'Legacy TaskScheduler disabled — use the task-engine plugin instead',
          });
          return;
        }
        const { task_id } = call.request;
        const cancelled = await scheduler.cancel(task_id);
        callback(null, { cancelled });
      } catch (error) {
        logger.error('CancelTask failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    // Stream task output (placeholder)
    StreamTaskOutput: (call: grpc.ServerWritableStream<any, any>) => {
      logger.warn('StreamTaskOutput not fully implemented');
      call.end();
    },

    // Session and context methods (placeholders for now)
    RegisterSession: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      callback(null, { registered: true, other_sessions: [] });
    },

    QuerySessions: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      callback(null, { sessions: [] });
    },

    RelayToSession: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      callback(null, { delivered: false, response: '' });
    },

    PublishContext: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      callback(null, { published: true });
    },

    QueryContext: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      callback(null, { entries: [] });
    },

    ForwardMemoryWrite: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const request = call.request;

        // Only the leader should handle forwarded writes
        if (raft.getState() !== 'leader') {
          callback(null, {
            success: false,
            error: 'Not the leader',
          });
          return;
        }

        const sql = request.sql as string;
        const params = JSON.parse(request.params || '[]');
        const checksum = request.checksum as string;
        const classification = request.classification || undefined;
        const table = request.table || undefined;

        // Verify checksum
        const crypto = require('crypto');
        const expectedChecksum = crypto
          .createHash('sha256')
          .update(sql + JSON.stringify(params))
          .digest('hex');

        if (checksum !== expectedChecksum) {
          callback(null, {
            success: false,
            error: 'Checksum verification failed',
          });
          return;
        }

        // Append to Raft log
        const entry = { sql, params, checksum, classification, table };
        const data = Buffer.from(JSON.stringify(entry));
        const result = await raft.appendEntry('memory_write', data);

        callback(null, {
          success: result.success,
          error: result.success ? '' : 'Failed to append to Raft log',
        });
      } catch (error) {
        logger.error('ForwardMemoryWrite failed', { error });
        callback(null, {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    RequestMemorySnapshot: async (
      call: grpc.ServerWritableStream<any, any>
    ) => {
      try {
        const requestingNode = call.request.requesting_node_id;
        logger.info('Memory snapshot requested', { by: requestingNode });

        const dbPath = path.join(
          process.env.HOME || os.homedir(),
          '.cortex',
          'shared-memory.db'
        );

        if (!fs.existsSync(dbPath)) {
          call.end();
          return;
        }

        const fileBuffer = fs.readFileSync(dbPath);
        const totalSize = fileBuffer.length;
        const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const CHUNK_SIZE = 64 * 1024; // 64KB chunks

        for (let offset = 0; offset < totalSize; offset += CHUNK_SIZE) {
          const chunk = fileBuffer.subarray(offset, Math.min(offset + CHUNK_SIZE, totalSize));
          const isDone = offset + CHUNK_SIZE >= totalSize;

          call.write({
            data: chunk,
            offset: offset.toString(),
            total_size: totalSize.toString(),
            done: isDone,
            checksum: isDone ? checksum : '',
          });
        }

        call.end();
        logger.info('Memory snapshot sent', { to: requestingNode, size: totalSize });
      } catch (error) {
        logger.error('RequestMemorySnapshot failed', { error });
        call.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export function createRaftServiceHandlers(config: ServiceHandlersConfig): grpc.UntypedServiceImplementation {
  const { logger, raft } = config;

  return {
    RequestVote: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const request = call.request;
        const result = raft.handleRequestVote({
          term: parseInt(request.term),
          candidateId: request.candidate_id,
          lastLogIndex: parseInt(request.last_log_index),
          lastLogTerm: parseInt(request.last_log_term),
        });

        callback(null, {
          term: result.term.toString(),
          vote_granted: result.voteGranted,
        });
      } catch (error) {
        logger.error('RequestVote failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    AppendEntries: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const request = call.request;
        const result = raft.handleAppendEntries({
          term: parseInt(request.term),
          leaderId: request.leader_id,
          prevLogIndex: parseInt(request.prev_log_index),
          prevLogTerm: parseInt(request.prev_log_term),
          entries: (request.entries || []).map((e: any) => ({
            term: parseInt(e.term),
            index: parseInt(e.index),
            type: e.type.replace('LOG_ENTRY_TYPE_', '').toLowerCase(),
            data: e.data,
          })),
          leaderCommit: parseInt(request.leader_commit),
        });

        callback(null, {
          term: result.term.toString(),
          success: result.success,
          match_index: result.matchIndex.toString(),
        });
      } catch (error) {
        logger.error('AppendEntries failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    InstallSnapshot: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      logger.warn('InstallSnapshot not implemented');
      callback(null, { term: '0' });
    },
  };
}

export function createAgentServiceHandlers(config: ServiceHandlersConfig): grpc.UntypedServiceImplementation {
  const { logger, taskExecutor, resourceMonitor } = config;

  return {
    ExecuteTask: (call: grpc.ServerWritableStream<any, any>) => {
      const spec = call.request.spec;
      logger.info('Received ExecuteTask', { taskId: spec?.task_id });

      // Execute the task and stream output
      taskExecutor.execute({
        taskId: spec.task_id,
        type: spec.type.replace('TASK_TYPE_', '').toLowerCase() as any,
        shell: spec.shell ? {
          command: spec.shell.command,
          workingDirectory: spec.shell.working_directory,
          sandboxed: spec.shell.sandboxed,
        } : undefined,
      }).then(result => {
        call.write({
          status: {
            task_id: spec.task_id,
            state: result.success ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
            exit_code: result.exitCode,
            error: result.error || '',
          },
        });
        call.end();
      }).catch(error => {
        call.write({
          status: {
            task_id: spec.task_id,
            state: 'TASK_STATE_FAILED',
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        call.end();
      });
    },

    GetResources: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const resources = resourceMonitor.toProtoResources();
        callback(null, resources || {});
      } catch (error) {
        logger.error('GetResources failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    HealthCheck: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const resources = resourceMonitor.toProtoResources();
        callback(null, {
          healthy: true,
          message: 'OK',
          resources: resources || {},
        });
      } catch (error) {
        logger.error('HealthCheck failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },

    CancelExecution: async (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>
    ) => {
      try {
        const { task_id } = call.request;
        const cancelled = taskExecutor.cancel(task_id);
        callback(null, { cancelled });
      } catch (error) {
        logger.error('CancelExecution failed', { error });
        callback({
          code: grpc.status.INTERNAL,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  };
}
