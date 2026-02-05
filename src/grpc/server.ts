import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EventEmitter } from 'events';
import path from 'path';
import net from 'net';
import { execSync } from 'child_process';
import { Logger } from 'winston';

const PROTO_PATH = path.join(__dirname, '../../proto/cluster.proto');

export interface GrpcServerConfig {
  host: string;
  port: number;
  logger: Logger;
  tlsCredentials?: grpc.ServerCredentials;
}

export interface ServiceImplementation {
  clusterService?: grpc.UntypedServiceImplementation;
  raftService?: grpc.UntypedServiceImplementation;
  agentService?: grpc.UntypedServiceImplementation;
}

export class GrpcServer extends EventEmitter {
  private server: grpc.Server;
  private config: GrpcServerConfig;
  private packageDefinition: protoLoader.PackageDefinition | null = null;
  private protoDescriptor: grpc.GrpcObject | null = null;
  private started = false;

  constructor(config: GrpcServerConfig) {
    super();
    this.config = config;
    this.server = new grpc.Server({
      'grpc.max_receive_message_length': 50 * 1024 * 1024, // 50MB
      'grpc.max_send_message_length': 50 * 1024 * 1024,
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
    });
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

  getProtoDescriptor(): grpc.GrpcObject {
    if (!this.protoDescriptor) {
      throw new Error('Proto not loaded. Call loadProto() first.');
    }
    return this.protoDescriptor;
  }

  registerServices(implementations: ServiceImplementation): void {
    if (!this.protoDescriptor) {
      throw new Error('Proto not loaded. Call loadProto() first.');
    }

    const claudecluster = this.protoDescriptor.claudecluster as grpc.GrpcObject;

    if (implementations.clusterService) {
      const ClusterService = claudecluster.ClusterService as grpc.ServiceClientConstructor;
      this.server.addService(ClusterService.service, implementations.clusterService);
      this.config.logger.info('Registered ClusterService');
    }

    if (implementations.raftService) {
      const RaftService = claudecluster.RaftService as grpc.ServiceClientConstructor;
      this.server.addService(RaftService.service, implementations.raftService);
      this.config.logger.info('Registered RaftService');
    }

    if (implementations.agentService) {
      const AgentService = claudecluster.AgentService as grpc.ServiceClientConstructor;
      this.server.addService(AgentService.service, implementations.agentService);
      this.config.logger.info('Registered AgentService');
    }
  }

  async start(): Promise<void> {
    // Check if port is already in use before attempting to bind
    const portCheck = await this.checkPortInUse(this.config.port);
    if (portCheck.inUse) {
      const errorMessage = this.formatPortInUseError(this.config.port, portCheck);
      this.config.logger.error('Port already in use', {
        port: this.config.port,
        pid: portCheck.pid,
        process: portCheck.processName
      });
      throw new Error(errorMessage);
    }

    return new Promise((resolve, reject) => {
      const address = `${this.config.host}:${this.config.port}`;
      const credentials = this.config.tlsCredentials || grpc.ServerCredentials.createInsecure();

      this.server.bindAsync(address, credentials, (error, port) => {
        if (error) {
          this.config.logger.error('Failed to bind gRPC server', { error: error.message });
          reject(error);
          return;
        }

        this.started = true;
        this.config.logger.info(`gRPC server listening on ${address}`, { port });
        this.emit('started', { host: this.config.host, port });
        resolve();
      });
    });
  }

  private async checkPortInUse(port: number): Promise<{ inUse: boolean; pid?: number; processName?: string }> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port is in use, try to find what's using it
          const processInfo = this.getProcessUsingPort(port);
          resolve({ inUse: true, ...processInfo });
        } else {
          resolve({ inUse: false });
        }
      });

      server.once('listening', () => {
        server.close();
        resolve({ inUse: false });
      });

      server.listen(port, '0.0.0.0');
    });
  }

  private getProcessUsingPort(port: number): { pid?: number; processName?: string } {
    try {
      // Try ss first (Linux)
      const ssOutput = execSync(`ss -tlnp 2>/dev/null | grep ':${port} '`, { encoding: 'utf-8' });
      const pidMatch = ssOutput.match(/pid=(\d+)/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        try {
          const psOutput = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf-8' }).trim();
          return { pid, processName: psOutput };
        } catch {
          return { pid };
        }
      }
    } catch {
      // ss failed, try lsof (macOS/Linux)
      try {
        const lsofOutput = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8' });
        const pid = parseInt(lsofOutput.trim().split('\n')[0], 10);
        if (!isNaN(pid)) {
          try {
            const psOutput = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf-8' }).trim();
            return { pid, processName: psOutput };
          } catch {
            return { pid };
          }
        }
      } catch {
        // Could not determine what's using the port
      }
    }
    return {};
  }

  private formatPortInUseError(port: number, info: { pid?: number; processName?: string }): string {
    let message = `Port ${port} is already in use`;

    if (info.pid) {
      message += ` by PID ${info.pid}`;
      if (info.processName) {
        message += ` (${info.processName})`;
      }
      message += `.\n\nTo fix this:\n`;
      message += `  1. Stop the existing process: kill ${info.pid}\n`;
      message += `  2. Or use a different port: --port ${port + 1}\n`;

      if (info.processName?.includes('node') || info.processName?.includes('claudecluster')) {
        message += `\nThis appears to be another claudecluster instance. `;
        message += `Stop it first or connect to the existing cluster.`;
      }
    } else {
      message += `.\n\nUse a different port with: --port ${port + 1}`;
    }

    return message;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.started) {
        resolve();
        return;
      }

      this.server.tryShutdown(() => {
        this.started = false;
        this.config.logger.info('gRPC server stopped');
        this.emit('stopped');
        resolve();
      });
    });
  }

  forceStop(): void {
    this.server.forceShutdown();
    this.started = false;
    this.config.logger.info('gRPC server force stopped');
    this.emit('stopped');
  }

  isRunning(): boolean {
    return this.started;
  }
}

export function createTlsCredentials(
  rootCert: Buffer,
  serverCert: Buffer,
  serverKey: Buffer,
  clientAuth: boolean = true
): grpc.ServerCredentials {
  return grpc.ServerCredentials.createSsl(
    rootCert,
    [{
      cert_chain: serverCert,
      private_key: serverKey,
    }],
    clientAuth
  );
}
