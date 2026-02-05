import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import Docker from 'dockerode';
import { Logger } from 'winston';

export interface TaskSpec {
  taskId: string;
  type: 'shell' | 'container' | 'subagent' | 'k8s_job' | 'claude_relay';
  shell?: ShellTaskSpec;
  container?: ContainerTaskSpec;
  subagent?: SubagentTaskSpec;
  environment?: Record<string, string>;
  timeoutMs?: number;
}

export interface ShellTaskSpec {
  command: string;
  workingDirectory?: string;
  sandboxed?: boolean;
}

export interface ContainerTaskSpec {
  image: string;
  command?: string[];
  args?: string[];
  labels?: Record<string, string>;
  mounts?: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
  environment?: Record<string, string>;
}

export interface SubagentTaskSpec {
  prompt: string;
  model?: string;
  tools?: string[];
  contextSummary?: string;
  maxTurns?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  error?: string;
  artifacts?: Map<string, Buffer>;
  startedAt: number;
  completedAt: number;
}

export interface TaskOutput {
  type: 'stdout' | 'stderr' | 'status';
  data: Buffer;
  timestamp: number;
}

export interface TaskExecutorConfig {
  logger: Logger;
  dockerSocket?: string;
  sandboxCommand?: string;
  maxConcurrentTasks?: number;
}

interface RunningTask {
  spec: TaskSpec;
  process?: ChildProcess;
  containerId?: string;
  startedAt: number;
  stdout: Buffer[];
  stderr: Buffer[];
  cancelled: boolean;
}

export class TaskExecutor extends EventEmitter {
  private config: TaskExecutorConfig;
  private docker: Docker | null = null;
  private runningTasks: Map<string, RunningTask> = new Map();
  private maxConcurrent: number;

  constructor(config: TaskExecutorConfig) {
    super();
    this.config = config;
    this.maxConcurrent = config.maxConcurrentTasks ?? 10;

    if (config.dockerSocket) {
      this.docker = new Docker({ socketPath: config.dockerSocket });
    } else {
      // Try default Docker socket
      try {
        this.docker = new Docker();
      } catch {
        this.config.logger.warn('Docker not available, container tasks will fail');
      }
    }
  }

  async execute(spec: TaskSpec): Promise<TaskResult> {
    if (this.runningTasks.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent tasks (${this.maxConcurrent}) reached`);
    }

    const startedAt = Date.now();
    const running: RunningTask = {
      spec,
      startedAt,
      stdout: [],
      stderr: [],
      cancelled: false,
    };
    this.runningTasks.set(spec.taskId, running);

    this.config.logger.info('Executing task', { taskId: spec.taskId, type: spec.type });

    try {
      let result: TaskResult;

      switch (spec.type) {
        case 'shell':
          result = await this.executeShell(spec, running);
          break;
        case 'container':
          result = await this.executeContainer(spec, running);
          break;
        case 'subagent':
          result = await this.executeSubagent(spec, running);
          break;
        default:
          throw new Error(`Unsupported task type: ${spec.type}`);
      }

      this.config.logger.info('Task completed', {
        taskId: spec.taskId,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.completedAt - result.startedAt,
      });

      return result;
    } finally {
      this.runningTasks.delete(spec.taskId);
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const running = this.runningTasks.get(taskId);
    if (!running) {
      return false;
    }

    running.cancelled = true;

    if (running.process) {
      running.process.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (running.process && !running.process.killed) {
          running.process.kill('SIGKILL');
        }
      }, 5000);
    }

    if (running.containerId && this.docker) {
      try {
        const container = this.docker.getContainer(running.containerId);
        await container.stop({ t: 5 });
      } catch {
        // Container might already be stopped
      }
    }

    this.config.logger.info('Task cancelled', { taskId });
    return true;
  }

  getRunningTaskIds(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  private async executeShell(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
    const shellSpec = spec.shell!;

    return new Promise((resolve) => {
      const env = {
        ...process.env,
        ...spec.environment,
      };

      // Use sandbox if requested
      let command: string;
      let args: string[];
      if (shellSpec.sandboxed && this.config.sandboxCommand) {
        command = this.config.sandboxCommand;
        args = [shellSpec.command];
      } else {
        command = '/bin/sh';
        args = ['-c', shellSpec.command];
      }

      const proc = spawn(command, args, {
        cwd: shellSpec.workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      running.process = proc;

      proc.stdout?.on('data', (data: Buffer) => {
        running.stdout.push(data);
        this.emitOutput(spec.taskId, 'stdout', data);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        running.stderr.push(data);
        this.emitOutput(spec.taskId, 'stderr', data);
      });

      const timeoutHandle = spec.timeoutMs
        ? setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGTERM');
              setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL');
              }, 5000);
            }
          }, spec.timeoutMs)
        : null;

      proc.on('close', (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const exitCode = code ?? (signal ? 128 : -1);
        resolve({
          taskId: spec.taskId,
          success: exitCode === 0 && !running.cancelled,
          exitCode,
          stdout: Buffer.concat(running.stdout),
          stderr: Buffer.concat(running.stderr),
          error: running.cancelled ? 'Task cancelled' : undefined,
          startedAt: running.startedAt,
          completedAt: Date.now(),
        });
      });

      proc.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);

        resolve({
          taskId: spec.taskId,
          success: false,
          exitCode: -1,
          stdout: Buffer.concat(running.stdout),
          stderr: Buffer.concat(running.stderr),
          error: error.message,
          startedAt: running.startedAt,
          completedAt: Date.now(),
        });
      });
    });
  }

  private async executeContainer(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
    if (!this.docker) {
      return {
        taskId: spec.taskId,
        success: false,
        exitCode: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: 'Docker not available',
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };
    }

    const containerSpec = spec.container!;

    try {
      // Pull image if not present
      try {
        await this.docker.getImage(containerSpec.image).inspect();
      } catch {
        this.config.logger.info('Pulling image', { image: containerSpec.image });
        await new Promise<void>((resolve, reject) => {
          this.docker!.pull(containerSpec.image, (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) {
              reject(err);
              return;
            }
            this.docker!.modem.followProgress(stream, (pullErr: Error | null) => {
              if (pullErr) reject(pullErr);
              else resolve();
            });
          });
        });
      }

      // Create container
      const container = await this.docker.createContainer({
        Image: containerSpec.image,
        Cmd: containerSpec.command,
        Entrypoint: containerSpec.args,
        Labels: containerSpec.labels,
        Env: Object.entries(spec.environment ?? {}).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          Binds: containerSpec.mounts?.map(m =>
            `${m.hostPath}:${m.containerPath}:${m.readOnly ? 'ro' : 'rw'}`
          ),
          AutoRemove: true,
        },
      });

      running.containerId = container.id;

      // Attach to get output
      const attachStream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      const demux = (data: Buffer) => {
        // Docker multiplexes stdout/stderr with 8-byte header
        let offset = 0;
        while (offset < data.length) {
          const streamType = data[offset];
          const size = data.readUInt32BE(offset + 4);
          const payload = data.subarray(offset + 8, offset + 8 + size);

          if (streamType === 1) {
            running.stdout.push(payload);
            this.emitOutput(spec.taskId, 'stdout', payload);
          } else if (streamType === 2) {
            running.stderr.push(payload);
            this.emitOutput(spec.taskId, 'stderr', payload);
          }

          offset += 8 + size;
        }
      };

      attachStream.on('data', demux);

      // Start container
      await container.start();

      // Wait for completion
      const { StatusCode } = await container.wait();

      return {
        taskId: spec.taskId,
        success: StatusCode === 0 && !running.cancelled,
        exitCode: StatusCode,
        stdout: Buffer.concat(running.stdout),
        stderr: Buffer.concat(running.stderr),
        error: running.cancelled ? 'Task cancelled' : undefined,
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };
    } catch (error) {
      return {
        taskId: spec.taskId,
        success: false,
        exitCode: -1,
        stdout: Buffer.concat(running.stdout),
        stderr: Buffer.concat(running.stderr),
        error: error instanceof Error ? error.message : String(error),
        startedAt: running.startedAt,
        completedAt: Date.now(),
      };
    }
  }

  private async executeSubagent(spec: TaskSpec, running: RunningTask): Promise<TaskResult> {
    const subagentSpec = spec.subagent!;

    // Subagent execution would integrate with Claude Code SDK
    // For now, return a placeholder that indicates this needs external handling
    this.config.logger.info('Subagent task requires external handling', {
      taskId: spec.taskId,
      prompt: subagentSpec.prompt.substring(0, 100),
    });

    // Emit a status update indicating subagent task needs routing
    this.emitOutput(spec.taskId, 'status', Buffer.from(JSON.stringify({
      type: 'subagent_pending',
      spec: subagentSpec,
    })));

    // In a real implementation, this would:
    // 1. Call Claude API with the prompt
    // 2. Handle tool calls within the subagent
    // 3. Return the final response

    return {
      taskId: spec.taskId,
      success: false,
      exitCode: -1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: 'Subagent execution requires Claude API integration',
      startedAt: running.startedAt,
      completedAt: Date.now(),
    };
  }

  private emitOutput(taskId: string, type: 'stdout' | 'stderr' | 'status', data: Buffer): void {
    const output: TaskOutput = {
      type,
      data,
      timestamp: Date.now(),
    };
    this.emit('output', taskId, output);
  }
}
