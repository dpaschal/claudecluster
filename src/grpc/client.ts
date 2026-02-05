import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EventEmitter } from 'events';
import path from 'path';
import { Logger } from 'winston';

const PROTO_PATH = path.join(__dirname, '../../proto/cluster.proto');

export interface GrpcClientConfig {
  logger: Logger;
  tlsCredentials?: grpc.ChannelCredentials;
  defaultTimeoutMs?: number;
}

export interface ClientConnection {
  address: string;
  clusterClient: grpc.Client;
  raftClient: grpc.Client;
  agentClient: grpc.Client;
  connected: boolean;
  lastError?: Error;
}

export class GrpcClientPool extends EventEmitter {
  private config: GrpcClientConfig;
  private packageDefinition: protoLoader.PackageDefinition | null = null;
  private protoDescriptor: grpc.GrpcObject | null = null;
  private connections: Map<string, ClientConnection> = new Map();
  private defaultCredentials: grpc.ChannelCredentials;

  constructor(config: GrpcClientConfig) {
    super();
    this.config = config;
    this.defaultCredentials = config.tlsCredentials || grpc.credentials.createInsecure();
  }

  async loadProto(): Promise<void> {
    this.packageDefinition = await protoLoader.load(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    this.protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition);
  }

  private ensureProtoLoaded(): grpc.GrpcObject {
    if (!this.protoDescriptor) {
      throw new Error('Proto not loaded. Call loadProto() first.');
    }
    return this.protoDescriptor;
  }

  getConnection(address: string): ClientConnection {
    let connection = this.connections.get(address);
    if (connection) {
      return connection;
    }

    const proto = this.ensureProtoLoaded();
    const claudecluster = proto.claudecluster as grpc.GrpcObject;

    const channelOptions: grpc.ChannelOptions = {
      'grpc.max_receive_message_length': 50 * 1024 * 1024,
      'grpc.max_send_message_length': 50 * 1024 * 1024,
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
    };

    const ClusterService = claudecluster.ClusterService as grpc.ServiceClientConstructor;
    const RaftService = claudecluster.RaftService as grpc.ServiceClientConstructor;
    const AgentService = claudecluster.AgentService as grpc.ServiceClientConstructor;

    connection = {
      address,
      clusterClient: new ClusterService(address, this.defaultCredentials, channelOptions),
      raftClient: new RaftService(address, this.defaultCredentials, channelOptions),
      agentClient: new AgentService(address, this.defaultCredentials, channelOptions),
      connected: false,
    };

    this.connections.set(address, connection);
    this.config.logger.debug(`Created connection to ${address}`);

    return connection;
  }

  async waitForReady(address: string, timeoutMs: number = 5000): Promise<boolean> {
    const connection = this.getConnection(address);
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      (connection.clusterClient as grpc.Client).waitForReady(deadline, (error) => {
        if (error) {
          connection.connected = false;
          connection.lastError = error;
          this.config.logger.warn(`Failed to connect to ${address}`, { error: error.message });
          resolve(false);
        } else {
          connection.connected = true;
          connection.lastError = undefined;
          this.config.logger.debug(`Connected to ${address}`);
          resolve(true);
        }
      });
    });
  }

  closeConnection(address: string): void {
    const connection = this.connections.get(address);
    if (connection) {
      (connection.clusterClient as grpc.Client).close();
      (connection.raftClient as grpc.Client).close();
      (connection.agentClient as grpc.Client).close();
      this.connections.delete(address);
      this.config.logger.debug(`Closed connection to ${address}`);
    }
  }

  closeAll(): void {
    for (const address of this.connections.keys()) {
      this.closeConnection(address);
    }
  }

  // Type-safe RPC call wrapper with timeout
  async call<TReq, TRes>(
    client: grpc.Client,
    method: string,
    request: TReq,
    timeoutMs?: number
  ): Promise<TRes> {
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs ?? 30000;
    const deadline = new Date(Date.now() + timeout);

    return new Promise((resolve, reject) => {
      const clientAny = client as Record<string, (
        request: TReq,
        metadata: grpc.Metadata,
        options: { deadline: Date },
        callback: (error: grpc.ServiceError | null, response: TRes) => void
      ) => void>;

      const rpcMethod = clientAny[method];
      if (!rpcMethod) {
        reject(new Error(`Unknown method: ${method}`));
        return;
      }

      rpcMethod.call(client, request, new grpc.Metadata(), { deadline }, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  // Stream call wrapper
  callStream<TReq, TRes>(
    client: grpc.Client,
    method: string,
    request: TReq
  ): grpc.ClientReadableStream<TRes> {
    const clientAny = client as Record<string, (
      request: TReq,
      metadata: grpc.Metadata
    ) => grpc.ClientReadableStream<TRes>>;

    const rpcMethod = clientAny[method];
    if (!rpcMethod) {
      throw new Error(`Unknown method: ${method}`);
    }

    return rpcMethod.call(client, request, new grpc.Metadata());
  }
}

// Convenience functions for common operations
export class ClusterClient {
  private pool: GrpcClientPool;
  private address: string;

  constructor(pool: GrpcClientPool, address: string) {
    this.pool = pool;
    this.address = address;
  }

  private get client(): grpc.Client {
    return this.pool.getConnection(this.address).clusterClient;
  }

  async registerNode(request: RegisterNodeRequest): Promise<RegisterNodeResponse> {
    return this.pool.call(this.client, 'RegisterNode', request);
  }

  async deregisterNode(request: DeregisterNodeRequest): Promise<DeregisterNodeResponse> {
    return this.pool.call(this.client, 'DeregisterNode', request);
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.pool.call(this.client, 'Heartbeat', request, 5000);
  }

  async getClusterState(): Promise<ClusterState> {
    return this.pool.call(this.client, 'GetClusterState', {});
  }

  async submitTask(request: SubmitTaskRequest): Promise<SubmitTaskResponse> {
    return this.pool.call(this.client, 'SubmitTask', request);
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    return this.pool.call(this.client, 'GetTaskStatus', { task_id: taskId });
  }

  async cancelTask(taskId: string): Promise<CancelTaskResponse> {
    return this.pool.call(this.client, 'CancelTask', { task_id: taskId });
  }

  streamTaskOutput(taskId: string): grpc.ClientReadableStream<TaskOutput> {
    return this.pool.callStream(this.client, 'StreamTaskOutput', { task_id: taskId });
  }

  async registerSession(request: RegisterSessionRequest): Promise<RegisterSessionResponse> {
    return this.pool.call(this.client, 'RegisterSession', request);
  }

  async querySessions(request: QuerySessionsRequest): Promise<QuerySessionsResponse> {
    return this.pool.call(this.client, 'QuerySessions', request);
  }

  async relayToSession(request: RelayRequest): Promise<RelayResponse> {
    return this.pool.call(this.client, 'RelayToSession', request);
  }

  async publishContext(request: PublishContextRequest): Promise<PublishContextResponse> {
    return this.pool.call(this.client, 'PublishContext', request);
  }

  async queryContext(request: QueryContextRequest): Promise<QueryContextResponse> {
    return this.pool.call(this.client, 'QueryContext', request);
  }
}

export class RaftClient {
  private pool: GrpcClientPool;
  private address: string;

  constructor(pool: GrpcClientPool, address: string) {
    this.pool = pool;
    this.address = address;
  }

  private get client(): grpc.Client {
    return this.pool.getConnection(this.address).raftClient;
  }

  async requestVote(request: RequestVoteRequest): Promise<RequestVoteResponse> {
    return this.pool.call(this.client, 'RequestVote', request, 1000);
  }

  async appendEntries(request: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    return this.pool.call(this.client, 'AppendEntries', request, 2000);
  }

  async installSnapshot(request: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    return this.pool.call(this.client, 'InstallSnapshot', request, 60000);
  }
}

export class AgentClient {
  private pool: GrpcClientPool;
  private address: string;

  constructor(pool: GrpcClientPool, address: string) {
    this.pool = pool;
    this.address = address;
  }

  private get client(): grpc.Client {
    return this.pool.getConnection(this.address).agentClient;
  }

  executeTask(request: ExecuteTaskRequest): grpc.ClientReadableStream<ExecuteTaskResponse> {
    return this.pool.callStream(this.client, 'ExecuteTask', request);
  }

  async getResources(): Promise<NodeResources> {
    return this.pool.call(this.client, 'GetResources', {});
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    return this.pool.call(this.client, 'HealthCheck', {}, 5000);
  }

  async cancelExecution(taskId: string): Promise<CancelExecutionResponse> {
    return this.pool.call(this.client, 'CancelExecution', { task_id: taskId });
  }
}

// Type definitions (matching proto)
interface RegisterNodeRequest {
  node: NodeInfo;
  auth_token?: string;
}

interface RegisterNodeResponse {
  approved: boolean;
  pending_approval: boolean;
  cluster_id: string;
  leader_address: string;
  peers: NodeInfo[];
}

interface DeregisterNodeRequest {
  node_id: string;
  graceful?: boolean;
}

interface DeregisterNodeResponse {
  success: boolean;
}

interface HeartbeatRequest {
  node_id: string;
  resources: NodeResources;
  active_tasks: string[];
}

interface HeartbeatResponse {
  acknowledged: boolean;
  leader_address: string;
  pending_tasks: PendingTask[];
}

interface PendingTask {
  task_id: string;
  spec: TaskSpec;
}

interface ClusterState {
  cluster_id: string;
  leader_id: string;
  term: string;
  nodes: NodeInfo[];
  total_resources: ClusterResources;
  available_resources: ClusterResources;
  active_tasks: number;
  queued_tasks: number;
}

interface ClusterResources {
  cpu_cores: number;
  memory_bytes: string;
  gpu_count: number;
  gpu_memory_bytes: string;
}

interface NodeInfo {
  node_id: string;
  hostname: string;
  tailscale_ip: string;
  grpc_port: number;
  role: string;
  status: string;
  resources: NodeResources;
  tags: string[];
  joined_at: string;
  last_seen: string;
}

interface NodeResources {
  cpu_cores: number;
  memory_bytes: string;
  memory_available_bytes: string;
  gpus: GpuInfo[];
  disk_bytes: string;
  disk_available_bytes: string;
  cpu_usage_percent: number;
  gaming_detected: boolean;
}

interface GpuInfo {
  name: string;
  memory_bytes: string;
  memory_available_bytes: string;
  utilization_percent: number;
  in_use_for_gaming: boolean;
}

interface SubmitTaskRequest {
  spec: TaskSpec;
}

interface SubmitTaskResponse {
  task_id: string;
  accepted: boolean;
  assigned_node: string;
  rejection_reason: string;
}

interface TaskSpec {
  task_id: string;
  type: string;
  submitter_node: string;
  submitter_session?: string;
  shell?: ShellTask;
  container?: ContainerTask;
  subagent?: SubagentTask;
  k8s_job?: K8sJobTask;
  claude_relay?: ClaudeRelayTask;
  requirements?: ResourceRequirements;
  constraints?: TaskConstraints;
  priority?: number;
  timeout_ms?: string;
  environment?: Record<string, string>;
  target_nodes?: string[];
}

interface ShellTask {
  command: string;
  working_directory?: string;
  sandboxed?: boolean;
}

interface ContainerTask {
  image: string;
  command?: string[];
  args?: string[];
  labels?: Record<string, string>;
  mounts?: VolumeMount[];
}

interface VolumeMount {
  host_path: string;
  container_path: string;
  read_only?: boolean;
}

interface SubagentTask {
  prompt: string;
  model?: string;
  tools?: string[];
  context_summary?: string;
  max_turns?: number;
}

interface K8sJobTask {
  cluster_context: string;
  namespace?: string;
  image: string;
  command?: string[];
  labels?: Record<string, string>;
  resources?: ResourceRequirements;
}

interface ClaudeRelayTask {
  target_session_id: string;
  prompt: string;
  full_context?: string;
  await_response?: boolean;
}

interface ResourceRequirements {
  cpu_cores?: number;
  memory_bytes?: string;
  requires_gpu?: boolean;
  gpu_memory_bytes?: string;
}

interface TaskConstraints {
  allowed_nodes?: string[];
  excluded_nodes?: string[];
  prefer_local?: boolean;
  avoid_gaming_nodes?: boolean;
}

interface TaskStatus {
  task_id: string;
  state: string;
  assigned_node: string;
  started_at: string;
  completed_at: string;
  exit_code: number;
  error: string;
  result: TaskResult;
}

interface TaskResult {
  stdout: Buffer;
  stderr: Buffer;
  exit_code: number;
  artifacts: Record<string, Buffer>;
}

interface CancelTaskResponse {
  cancelled: boolean;
}

interface TaskOutput {
  type: string;
  data: Buffer;
  timestamp: string;
}

interface RegisterSessionRequest {
  session: ClaudeSession;
}

interface RegisterSessionResponse {
  registered: boolean;
  other_sessions: ClaudeSession[];
}

interface QuerySessionsRequest {
  project_filter?: string;
  node_filter?: string;
}

interface QuerySessionsResponse {
  sessions: ClaudeSession[];
}

interface ClaudeSession {
  session_id: string;
  node_id: string;
  project: string;
  working_directory: string;
  mode: string;
  started_at: string;
  last_active: string;
  context_summary?: string;
}

interface RelayRequest {
  target_session_id: string;
  from_session_id: string;
  message: string;
  full_context?: string;
}

interface RelayResponse {
  delivered: boolean;
  response: string;
}

interface PublishContextRequest {
  entry: ContextEntry;
}

interface PublishContextResponse {
  published: boolean;
}

interface QueryContextRequest {
  project_filter?: string;
  type_filter?: string[];
  since_timestamp?: string;
  limit?: number;
}

interface QueryContextResponse {
  entries: ContextEntry[];
}

interface ContextEntry {
  entry_id: string;
  session_id: string;
  node_id: string;
  project: string;
  type: string;
  key: string;
  value: string;
  timestamp: string;
  vector_clock: string;
  visibility: string;
}

interface RequestVoteRequest {
  term: string;
  candidate_id: string;
  last_log_index: string;
  last_log_term: string;
}

interface RequestVoteResponse {
  term: string;
  vote_granted: boolean;
}

interface AppendEntriesRequest {
  term: string;
  leader_id: string;
  prev_log_index: string;
  prev_log_term: string;
  entries: LogEntry[];
  leader_commit: string;
}

interface LogEntry {
  term: string;
  index: string;
  type: string;
  data: Buffer;
}

interface AppendEntriesResponse {
  term: string;
  success: boolean;
  match_index: string;
}

interface InstallSnapshotRequest {
  term: string;
  leader_id: string;
  last_included_index: string;
  last_included_term: string;
  offset: string;
  data: Buffer;
  done: boolean;
}

interface InstallSnapshotResponse {
  term: string;
}

interface ExecuteTaskRequest {
  spec: TaskSpec;
}

interface ExecuteTaskResponse {
  output?: TaskOutput;
  status?: TaskStatus;
}

interface HealthCheckResponse {
  healthy: boolean;
  message: string;
  resources: NodeResources;
}

interface CancelExecutionResponse {
  cancelled: boolean;
}

export function createTlsCredentials(
  rootCert: Buffer,
  clientCert: Buffer,
  clientKey: Buffer
): grpc.ChannelCredentials {
  return grpc.credentials.createSsl(rootCert, clientKey, clientCert);
}
