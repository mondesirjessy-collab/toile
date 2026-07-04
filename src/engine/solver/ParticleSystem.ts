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
  /** Peak radial acceleration of the mouse force (m/s^2). */
  mouseStrength?: number;
  /** Falloff radius of the mouse force (world units). */
  mouseRadius?: number;
  /** Linear velocity drag rate (1/s) — bleeds energy for stability. */
  damping?: number;
  /** Hard cap on particle speed (m/s) to keep the sim from exploding. */
  maxSpeed?: number;
  /** Initial spawn: particles fill an axis-aligned box. */
  spawnMin?: [number, number, number];
  spawnMax?: [number, number, number];
}

// SimParams std140-style layout, 64 bytes. Offsets (bytes):
//  0 dt, 4 gravity, 8 ground_y, 12 restitution,
//  16 ray_origin.xyz, 28 mouse_force,
//  32 ray_dir.xyz, 44 mouse_radius,
//  48 particle_count, 52 damping, 56 max_speed, 60 pad.
const UNIFORM_SIZE = 64;

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
  private readonly mouseStrength: number;
  private readonly mouseRadius: number;
  private readonly damping: number;
  private readonly maxSpeed: number;

  // Per-frame mouse state (world-space ray + signed strength).
  private mouseOrigin: [number, number, number] = [0, 0, 0];
  private mouseDir: [number, number, number] = [0, 0, 1];
  private mouseForce = 0; // signed: >0 attract, <0 repel, 0 idle

  constructor(device: GPUDevice, opts: ParticleSystemOptions) {
    this.device = device;
    this.count = opts.count;
    this.gravity = opts.gravity ?? -9.81;
    this.groundY = opts.groundY ?? 0.0;
    this.restitution = opts.restitution ?? 0.55;
    this.mouseStrength = opts.mouseStrength ?? 45.0;
    this.mouseRadius = opts.mouseRadius ?? 1.5;
    this.damping = opts.damping ?? 0.8;
    this.maxSpeed = opts.maxSpeed ?? 12.0;

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

  /**
   * Set the cursor interaction for the next `step`. `mode` is +1 (attract),
   * -1 (repel), or 0 (idle); the ray is the world-space pick ray from the
   * camera through the cursor.
   */
  setMouse(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    mode: number,
  ): void {
    this.mouseOrigin = [origin[0], origin[1], origin[2]];
    this.mouseDir = [dir[0], dir[1], dir[2]];
    this.mouseForce = mode * this.mouseStrength;
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
    const dv = new DataView(this.uniformData);
    const LE = true;
    dv.setFloat32(0, dt, LE);
    dv.setFloat32(4, this.gravity, LE);
    dv.setFloat32(8, this.groundY, LE);
    dv.setFloat32(12, this.restitution, LE);
    dv.setFloat32(16, this.mouseOrigin[0], LE);
    dv.setFloat32(20, this.mouseOrigin[1], LE);
    dv.setFloat32(24, this.mouseOrigin[2], LE);
    dv.setFloat32(28, this.mouseForce, LE);
    dv.setFloat32(32, this.mouseDir[0], LE);
    dv.setFloat32(36, this.mouseDir[1], LE);
    dv.setFloat32(40, this.mouseDir[2], LE);
    dv.setFloat32(44, this.mouseRadius, LE);
    dv.setUint32(48, this.count, LE);
    dv.setFloat32(52, this.damping, LE);
    dv.setFloat32(56, this.maxSpeed, LE);
    // 60: padding to 64-byte struct size.
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
