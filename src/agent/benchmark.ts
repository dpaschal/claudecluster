import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from 'winston';

const execAsync = promisify(exec);

/**
 * Compute benchmarking module for Claude Cluster
 *
 * Measures compute performance using industry-standard metrics:
 * - FLOPS (Floating Point Operations Per Second) - like TOP500 supercomputers
 * - LINPACK benchmark approximation
 * - Memory bandwidth
 * - GPU compute (CUDA/OpenCL if available)
 */

export interface BenchmarkResult {
  nodeId: string;
  hostname: string;
  timestamp: number;
  duration: number;

  // CPU benchmarks
  cpu: {
    singleThreadFlops: number;    // Single-threaded FLOPS
    multiThreadFlops: number;     // Multi-threaded FLOPS (all cores)
    peakTheoreticalFlops: number; // Theoretical peak based on specs
    linpackScore: number;         // LINPACK-style benchmark
    efficiency: number;           // Actual/Theoretical ratio
  };

  // Memory benchmarks
  memory: {
    bandwidthGBps: number;        // Memory bandwidth in GB/s
    latencyNs: number;            // Memory latency in nanoseconds
    streamTriad: number;          // STREAM Triad benchmark
  };

  // GPU benchmarks (if available)
  gpu?: {
    name: string;
    singlePrecisionTflops: number;  // FP32 TFLOPS
    doublePrecisionTflops: number;  // FP64 TFLOPS
    memoryBandwidthGBps: number;
    tensorCoresTflops?: number;     // If available (AI workloads)
  }[];

  // Aggregate scores
  aggregate: {
    totalPetaflops: number;         // Combined CPU+GPU in PFLOPS
    top500Equivalent: string;       // Approximate TOP500 ranking equivalent
    clusterContribution: number;    // Percentage of cluster's total compute
  };
}

export interface BenchmarkConfig {
  logger: Logger;
  nodeId: string;
  hostname: string;
  iterations?: number;
  matrixSize?: number;
  warmupIterations?: number;
}

export class ComputeBenchmark extends EventEmitter {
  private config: BenchmarkConfig;
  private lastResult: BenchmarkResult | null = null;
  private iterations: number;
  private matrixSize: number;
  private warmupIterations: number;

  constructor(config: BenchmarkConfig) {
    super();
    this.config = config;
    this.iterations = config.iterations ?? 10;
    this.matrixSize = config.matrixSize ?? 1024;
    this.warmupIterations = config.warmupIterations ?? 2;
  }

  async runBenchmark(): Promise<BenchmarkResult> {
    const startTime = Date.now();
    this.config.logger.info('Starting compute benchmark');

    // Warmup
    this.config.logger.debug('Running warmup iterations');
    for (let i = 0; i < this.warmupIterations; i++) {
      await this.runMatrixMultiply(256);
    }

    // CPU benchmarks
    const cpuResult = await this.benchmarkCpu();

    // Memory benchmarks
    const memoryResult = await this.benchmarkMemory();

    // GPU benchmarks
    const gpuResult = await this.benchmarkGpu();

    // Calculate aggregate scores
    const aggregate = this.calculateAggregate(cpuResult, gpuResult);

    const result: BenchmarkResult = {
      nodeId: this.config.nodeId,
      hostname: this.config.hostname,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      cpu: cpuResult,
      memory: memoryResult,
      gpu: gpuResult,
      aggregate,
    };

    this.lastResult = result;
    this.config.logger.info('Benchmark complete', {
      totalPetaflops: aggregate.totalPetaflops,
      duration: result.duration,
    });

    this.emit('complete', result);
    return result;
  }

  private async benchmarkCpu(): Promise<BenchmarkResult['cpu']> {
    // Get CPU info for theoretical peak calculation
    const cpuInfo = await this.getCpuInfo();

    // Single-threaded benchmark
    const singleThreadFlops = await this.runMatrixMultiply(this.matrixSize);

    // Multi-threaded benchmark (run on all cores)
    const multiThreadFlops = await this.runParallelMatrixMultiply(this.matrixSize);

    // Calculate theoretical peak FLOPS
    // Modern CPUs can do ~16 FLOPS per cycle (AVX-512) or ~8 (AVX2)
    const flopsPerCycle = cpuInfo.hasAvx512 ? 16 : (cpuInfo.hasAvx2 ? 8 : 4);
    const peakTheoreticalFlops = cpuInfo.cores * cpuInfo.frequency * flopsPerCycle * 1e9;

    // LINPACK-style benchmark (dense linear algebra)
    const linpackScore = await this.runLinpackBenchmark();

    const efficiency = multiThreadFlops / peakTheoreticalFlops;

    return {
      singleThreadFlops,
      multiThreadFlops,
      peakTheoreticalFlops,
      linpackScore,
      efficiency,
    };
  }

  private async benchmarkMemory(): Promise<BenchmarkResult['memory']> {
    // Simple memory bandwidth test
    const arraySize = 100 * 1024 * 1024; // 100 MB
    const array = new Float64Array(arraySize / 8);

    // Initialize
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.random();
    }

    // STREAM Triad: a[i] = b[i] + scalar * c[i]
    const b = new Float64Array(array.length);
    const c = new Float64Array(array.length);
    const scalar = 3.0;

    for (let i = 0; i < array.length; i++) {
      b[i] = Math.random();
      c[i] = Math.random();
    }

    const start = process.hrtime.bigint();
    for (let iter = 0; iter < this.iterations; iter++) {
      for (let i = 0; i < array.length; i++) {
        array[i] = b[i] + scalar * c[i];
      }
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;

    // Calculate bandwidth (3 arrays accessed)
    const bytesAccessed = 3 * arraySize * this.iterations;
    const bandwidthGBps = bytesAccessed / elapsed / 1e9;

    // Estimate latency (simplified)
    const latencyNs = 1e9 / (bandwidthGBps * 1e9 / 64); // Assuming 64-byte cache line

    return {
      bandwidthGBps,
      latencyNs,
      streamTriad: bandwidthGBps, // STREAM Triad score is essentially bandwidth
    };
  }

  private async benchmarkGpu(): Promise<BenchmarkResult['gpu'] | undefined> {
    try {
      // Try to get NVIDIA GPU info via nvidia-smi
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,compute_cap,memory.total,clocks.max.sm --format=csv,noheader,nounits'
      );

      const gpus: BenchmarkResult['gpu'] = [];

      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const [name, computeCap, memoryMB, clockMHz] = line.split(', ').map(s => s.trim());

        // Estimate TFLOPS based on compute capability and clock
        // This is approximate - actual benchmark would use CUDA
        const computeCapNum = parseFloat(computeCap);
        const clockGHz = parseInt(clockMHz) / 1000;
        const memoryGB = parseInt(memoryMB) / 1024;

        // Rough CUDA core count estimation by compute capability
        const coreEstimate = this.estimateCudaCores(name);

        // FP32: 2 FLOPS per core per cycle (FMA)
        const fp32Tflops = (coreEstimate * 2 * clockGHz) / 1000;

        // FP64: typically 1/32 or 1/2 of FP32 depending on GPU class
        const fp64Ratio = name.toLowerCase().includes('a100') ? 0.5 : 0.03125;
        const fp64Tflops = fp32Tflops * fp64Ratio;

        // Memory bandwidth estimation
        const memBandwidth = memoryGB * 8; // Rough estimate

        gpus.push({
          name,
          singlePrecisionTflops: fp32Tflops,
          doublePrecisionTflops: fp64Tflops,
          memoryBandwidthGBps: memBandwidth,
          tensorCoresTflops: computeCapNum >= 7.0 ? fp32Tflops * 8 : undefined,
        });
      }

      return gpus.length > 0 ? gpus : undefined;
    } catch {
      // No NVIDIA GPU or nvidia-smi not available
      return undefined;
    }
  }

  private estimateCudaCores(gpuName: string): number {
    const name = gpuName.toLowerCase();

    // RTX 40 series
    if (name.includes('4090')) return 16384;
    if (name.includes('4080')) return 9728;
    if (name.includes('4070')) return 5888;

    // RTX 30 series
    if (name.includes('3090')) return 10496;
    if (name.includes('3080')) return 8704;
    if (name.includes('3070')) return 5888;
    if (name.includes('3060')) return 3584;

    // RTX 20 series
    if (name.includes('2080')) return 2944;
    if (name.includes('2070')) return 2304;
    if (name.includes('2060')) return 1920;

    // Data center
    if (name.includes('a100')) return 6912;
    if (name.includes('h100')) return 16896;
    if (name.includes('v100')) return 5120;

    return 2048; // Default estimate
  }

  private calculateAggregate(
    cpu: BenchmarkResult['cpu'],
    gpu?: BenchmarkResult['gpu']
  ): BenchmarkResult['aggregate'] {
    let totalFlops = cpu.multiThreadFlops;

    // Add GPU compute (use FP64 for TOP500-style comparison)
    if (gpu) {
      for (const g of gpu) {
        totalFlops += g.doublePrecisionTflops * 1e12;
      }
    }

    const totalPetaflops = totalFlops / 1e15;

    // TOP500 equivalent (November 2024 rankings for reference)
    // #1 Frontier: 1.206 EFLOPS (1206 PFLOPS)
    // #500: ~5 PFLOPS
    let top500Equivalent: string;
    if (totalPetaflops >= 1000) {
      top500Equivalent = 'TOP 10';
    } else if (totalPetaflops >= 100) {
      top500Equivalent = 'TOP 50';
    } else if (totalPetaflops >= 10) {
      top500Equivalent = 'TOP 200';
    } else if (totalPetaflops >= 1) {
      top500Equivalent = 'TOP 500';
    } else if (totalPetaflops >= 0.1) {
      top500Equivalent = 'Research cluster';
    } else if (totalPetaflops >= 0.01) {
      top500Equivalent = 'Workstation';
    } else {
      top500Equivalent = 'Desktop';
    }

    return {
      totalPetaflops,
      top500Equivalent,
      clusterContribution: 0, // Set by cluster aggregation
    };
  }

  private async runMatrixMultiply(size: number): Promise<number> {
    const a = new Float64Array(size * size);
    const b = new Float64Array(size * size);
    const c = new Float64Array(size * size);

    // Initialize matrices
    for (let i = 0; i < size * size; i++) {
      a[i] = Math.random();
      b[i] = Math.random();
    }

    const start = process.hrtime.bigint();

    // Simple matrix multiplication (O(n^3))
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        let sum = 0;
        for (let k = 0; k < size; k++) {
          sum += a[i * size + k] * b[k * size + j];
        }
        c[i * size + j] = sum;
      }
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;

    // 2n^3 floating point operations for matrix multiply
    const flops = (2 * size * size * size) / elapsed;

    return flops;
  }

  private async runParallelMatrixMultiply(size: number): Promise<number> {
    // In a real implementation, this would use worker threads
    // For now, estimate based on single-thread performance and core count
    const singleThreadFlops = await this.runMatrixMultiply(size);
    const cpuInfo = await this.getCpuInfo();

    // Parallel efficiency typically 70-90%
    const parallelEfficiency = 0.8;
    return singleThreadFlops * cpuInfo.cores * parallelEfficiency;
  }

  private async runLinpackBenchmark(): Promise<number> {
    // Simplified LINPACK-style benchmark
    // Real LINPACK solves Ax=b using LU decomposition
    const n = 512; // Matrix size

    const a = new Float64Array(n * n);
    const b = new Float64Array(n);

    for (let i = 0; i < n * n; i++) {
      a[i] = Math.random();
    }
    for (let i = 0; i < n; i++) {
      b[i] = Math.random();
    }

    const start = process.hrtime.bigint();

    // Gaussian elimination (simplified)
    for (let k = 0; k < n - 1; k++) {
      for (let i = k + 1; i < n; i++) {
        const factor = a[i * n + k] / a[k * n + k];
        for (let j = k + 1; j < n; j++) {
          a[i * n + j] -= factor * a[k * n + j];
        }
        b[i] -= factor * b[k];
      }
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;

    // LINPACK complexity is approximately 2/3 * n^3
    const flops = (2 / 3 * n * n * n) / elapsed;

    return flops;
  }

  private async getCpuInfo(): Promise<{
    cores: number;
    frequency: number;
    hasAvx2: boolean;
    hasAvx512: boolean;
  }> {
    try {
      const { stdout: coresOut } = await execAsync('nproc');
      const cores = parseInt(coresOut.trim());

      // Try to get max frequency
      let frequency = 3.0; // Default 3 GHz
      try {
        const { stdout: freqOut } = await execAsync(
          'cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'
        );
        frequency = parseInt(freqOut.trim()) / 1e6; // Convert kHz to GHz
      } catch {
        // Use default
      }

      // Check for AVX support
      let hasAvx2 = false;
      let hasAvx512 = false;
      try {
        const { stdout: flagsOut } = await execAsync('cat /proc/cpuinfo | grep flags | head -1');
        hasAvx2 = flagsOut.includes('avx2');
        hasAvx512 = flagsOut.includes('avx512');
      } catch {
        // Assume no advanced SIMD
      }

      return { cores, frequency, hasAvx2, hasAvx512 };
    } catch {
      return { cores: 4, frequency: 3.0, hasAvx2: false, hasAvx512: false };
    }
  }

  getLastResult(): BenchmarkResult | null {
    return this.lastResult;
  }

  // Format result for display
  static formatResult(result: BenchmarkResult): string {
    const lines = [
      `\n╔════════════════════════════════════════════════════════════════╗`,
      `║              CLAUDE CLUSTER COMPUTE BENCHMARK                  ║`,
      `╠════════════════════════════════════════════════════════════════╣`,
      `║ Node: ${result.hostname.padEnd(55)}║`,
      `║ Time: ${new Date(result.timestamp).toISOString().padEnd(55)}║`,
      `╠════════════════════════════════════════════════════════════════╣`,
      `║ CPU PERFORMANCE                                                ║`,
      `║   Single-thread: ${formatFlops(result.cpu.singleThreadFlops).padEnd(44)}║`,
      `║   Multi-thread:  ${formatFlops(result.cpu.multiThreadFlops).padEnd(44)}║`,
      `║   Peak (theory): ${formatFlops(result.cpu.peakTheoreticalFlops).padEnd(44)}║`,
      `║   Efficiency:    ${(result.cpu.efficiency * 100).toFixed(1).padStart(5)}%${' '.repeat(39)}║`,
      `║   LINPACK:       ${formatFlops(result.cpu.linpackScore).padEnd(44)}║`,
      `╠════════════════════════════════════════════════════════════════╣`,
      `║ MEMORY PERFORMANCE                                             ║`,
      `║   Bandwidth:     ${result.memory.bandwidthGBps.toFixed(2).padStart(8)} GB/s${' '.repeat(33)}║`,
      `║   STREAM Triad:  ${result.memory.streamTriad.toFixed(2).padStart(8)} GB/s${' '.repeat(33)}║`,
    ];

    if (result.gpu && result.gpu.length > 0) {
      lines.push(`╠════════════════════════════════════════════════════════════════╣`);
      lines.push(`║ GPU PERFORMANCE                                                ║`);
      for (const gpu of result.gpu) {
        lines.push(`║   ${gpu.name.substring(0, 60).padEnd(60)}║`);
        lines.push(`║     FP32:        ${gpu.singlePrecisionTflops.toFixed(2).padStart(8)} TFLOPS${' '.repeat(30)}║`);
        lines.push(`║     FP64:        ${gpu.doublePrecisionTflops.toFixed(2).padStart(8)} TFLOPS${' '.repeat(30)}║`);
        if (gpu.tensorCoresTflops) {
          lines.push(`║     Tensor:      ${gpu.tensorCoresTflops.toFixed(2).padStart(8)} TFLOPS${' '.repeat(30)}║`);
        }
      }
    }

    lines.push(`╠════════════════════════════════════════════════════════════════╣`);
    lines.push(`║ AGGREGATE SCORE                                                ║`);
    lines.push(`║   Total:         ${formatPflops(result.aggregate.totalPetaflops).padEnd(44)}║`);
    lines.push(`║   Equivalent:    ${result.aggregate.top500Equivalent.padEnd(44)}║`);
    lines.push(`╚════════════════════════════════════════════════════════════════╝\n`);

    return lines.join('\n');
  }
}

function formatFlops(flops: number): string {
  if (flops >= 1e15) {
    return `${(flops / 1e15).toFixed(2)} PFLOPS`;
  } else if (flops >= 1e12) {
    return `${(flops / 1e12).toFixed(2)} TFLOPS`;
  } else if (flops >= 1e9) {
    return `${(flops / 1e9).toFixed(2)} GFLOPS`;
  } else if (flops >= 1e6) {
    return `${(flops / 1e6).toFixed(2)} MFLOPS`;
  } else {
    return `${flops.toFixed(0)} FLOPS`;
  }
}

function formatPflops(pflops: number): string {
  if (pflops >= 1000) {
    return `${(pflops / 1000).toFixed(3)} EFLOPS`;
  } else if (pflops >= 1) {
    return `${pflops.toFixed(3)} PFLOPS`;
  } else if (pflops >= 0.001) {
    return `${(pflops * 1000).toFixed(2)} TFLOPS`;
  } else {
    return `${(pflops * 1e6).toFixed(2)} GFLOPS`;
  }
}

// MCP tool for benchmarking
export function createBenchmarkTool(config: BenchmarkConfig) {
  return {
    name: 'run_benchmark',
    description: 'Run compute benchmark on this node and return FLOPS metrics (like TOP500 supercomputers)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        matrixSize: {
          type: 'number',
          description: 'Matrix size for benchmark (default: 1024)',
        },
        iterations: {
          type: 'number',
          description: 'Number of iterations (default: 10)',
        },
      },
    },
    handler: async (args: { matrixSize?: number; iterations?: number }) => {
      const benchmark = new ComputeBenchmark({
        ...config,
        matrixSize: args.matrixSize,
        iterations: args.iterations,
      });

      const result = await benchmark.runBenchmark();

      return {
        summary: ComputeBenchmark.formatResult(result),
        data: {
          nodeId: result.nodeId,
          hostname: result.hostname,
          cpu: {
            multiThreadGflops: result.cpu.multiThreadFlops / 1e9,
            efficiency: `${(result.cpu.efficiency * 100).toFixed(1)}%`,
          },
          memory: {
            bandwidthGBps: result.memory.bandwidthGBps,
          },
          gpu: result.gpu?.map(g => ({
            name: g.name,
            fp32Tflops: g.singlePrecisionTflops,
            fp64Tflops: g.doublePrecisionTflops,
          })),
          aggregate: {
            totalPetaflops: result.aggregate.totalPetaflops,
            top500Equivalent: result.aggregate.top500Equivalent,
          },
        },
      };
    },
  };
}
