/**
 * ParticleSystem — milestone 1 core.
 * Owns the GPU buffers (positions, velocities, masses) and the integrate
 * compute pipeline. Everything stays on the GPU: the renderer reads the
 * position buffer directly, there is no CPU round-trip per frame.
 *
 * Milestone 3+ will add constraint buffers and solve passes here.
 */
import integrateWGSL from './shaders/integrate.wgsl?raw';

export interface ParticleSystemOptions {
  count: number;
  gravity?: number; // m/s^2, default -9.81
  groundY?: number;
  restitution?: number;
  /** Initial spawn: particles fill an axis-aligned box. */
  spawnMin?: [number, number, number];
  spawnMax?: [number, number, number];
}

const UNIFORM_SIZE = 32; // SimParams: 4 f32 + 4 u32 = 32 bytes

export class ParticleSystem {
  readonly count: number;
  readonly positionBuffer: GPUBuffer;

  private readonly device: GPUDevice;
  private readonly prevPositionBuffer: GPUBuffer;
  private readonly velocityBuffer: GPUBuffer;
  private readonly invMassBuffer: GPUBuffer;
  private readonly uniformBuffer: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly uniformData: ArrayBuffer;

  private gravity: number;
  private groundY: number;
  private restitution: number;

  constructor(device: GPUDevice, opts: ParticleSystemOptions) {
    this.device = device;
    this.count = opts.count;
    this.gravity = opts.gravity ?? -9.81;
    this.groundY = opts.groundY ?? 0.0;
    this.restitution = opts.restitution ?? 0.55;

    const min = opts.spawnMin ?? [-0.5, 1.5, -0.5];
    const max = opts.spawnMax ?? [0.5, 3.0, 0.5];

    // --- Initial CPU-side data (uploaded once, never read back) ---
    const positions = new Float32Array(this.count * 4);
    const velocities = new Float32Array(this.count * 4);
    const invMasses = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      positions[i * 4 + 0] = min[0] + Math.random() * (max[0] - min[0]);
      positions[i * 4 + 1] = min[1] + Math.random() * (max[1] - min[1]);
      positions[i * 4 + 2] = min[2] + Math.random() * (max[2] - min[2]);
      invMasses[i] = 1.0; // uniform unit mass for milestone 1
    }

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.positionBuffer = this.createBuffer(positions, storage | GPUBufferUsage.VERTEX);
    this.prevPositionBuffer = this.createBuffer(positions, storage);
    this.velocityBuffer = this.createBuffer(velocities, storage);
    this.invMassBuffer = this.createBuffer(invMasses, storage);

    this.uniformData = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- Pipeline ---
    const module = device.createShaderModule({ code: integrateWGSL, label: 'integrate' });
    this.pipeline = device.createComputePipeline({
      label: 'integrate-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.velocityBuffer } },
        { binding: 4, resource: { buffer: this.invMassBuffer } },
      ],
    });
  }

  /** Advance the simulation by one frame, split into `substeps` substeps. */
  step(frameDt: number, substeps: number): void {
    const dt = frameDt / substeps;
    this.writeUniforms(dt);

    const encoder = this.device.createCommandEncoder({ label: 'sim-frame' });
    const workgroups = Math.ceil(this.count / 256);
    for (let s = 0; s < substeps; s++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      // Milestone 3: constraint solve passes are inserted here, one per color.
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private writeUniforms(dt: number): void {
    const f = new Float32Array(this.uniformData);
    const u = new Uint32Array(this.uniformData);
    f[0] = dt;
    f[1] = this.gravity;
    f[2] = this.groundY;
    f[3] = this.restitution;
    u[4] = this.count;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  private createBuffer(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }
}
