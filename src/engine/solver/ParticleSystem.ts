/**
 * ParticleSystem — milestone 3 XPBD cloth solver.
 * Owns the GPU buffers (positions, prev positions, velocities, inverse masses,
 * color-sorted distance constraints) and orchestrates the per-substep passes:
 *   integrate (predict) → distance solve, one dispatch per graph color → velocity.
 * Everything stays on the GPU; the renderer reads the position buffer directly,
 * there is no CPU round-trip per frame (brief §3.5).
 *
 * The mesh topology (grid + structural/shear constraints + coloring) is built on
 * the CPU by ClothMesh/ConstraintGraph and handed in as ClothMeshData, keeping
 * engine/ free of any renderer dependency.
 *
 * Bending + sphere/ground collision (brief weeks 5-6) slot in as extra passes.
 */
import integrateWGSL from './shaders/integrate.wgsl?raw';
import distanceWGSL from './shaders/distance.wgsl?raw';
import updateVelocityWGSL from './shaders/updateVelocity.wgsl?raw';
import type { ClothMeshData } from '../cloth/ClothMesh';

export interface SolverOptions {
  gravity?: number; // m/s^2, default -9.81
  groundY?: number;
  /** XPBD compliance α for distance constraints; ~0 = quasi-inextensible. */
  compliance?: number;
  /** Peak radial acceleration of the mouse force (m/s^2). */
  mouseStrength?: number;
  /** Falloff radius of the mouse force (world units). */
  mouseRadius?: number;
  /** Linear velocity drag rate (1/s) — bleeds energy for stability. */
  damping?: number;
  /** Hard cap on particle speed (m/s) to keep the sim from exploding. */
  maxSpeed?: number;
}

// SimParams std140-style layout, 64 bytes. Offsets (bytes):
//  0 dt, 4 gravity, 8 ground_y, 12 compliance,
//  16 ray_origin.xyz, 28 mouse_force,
//  32 ray_dir.xyz, 44 mouse_radius,
//  48 particle_count, 52 damping, 56 max_speed, 60 pad.
const UNIFORM_SIZE = 64;
const BATCH_SIZE = 16; // Batch uniform: offset,count + 2 pad (u32)
const WORKGROUP = 256;

export class ParticleSystem {
  readonly count: number;
  readonly constraintCount: number;
  readonly structuralCount: number;
  readonly positionBuffer: GPUBuffer;

  private readonly device: GPUDevice;
  private readonly prevPositionBuffer: GPUBuffer;
  private readonly velocityBuffer: GPUBuffer;
  private readonly invMassBuffer: GPUBuffer;
  private readonly constraintBuffer: GPUBuffer;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData: ArrayBuffer;

  private readonly integratePipeline: GPUComputePipeline;
  private readonly solvePipeline: GPUComputePipeline;
  private readonly velocityPipeline: GPUComputePipeline;

  private readonly integrateBindGroup: GPUBindGroup;
  private readonly velocityBindGroup: GPUBindGroup;
  private readonly solveBindGroups: GPUBindGroup[];

  private readonly colorCounts: number[];

  private readonly gravity: number;
  private readonly groundY: number;
  private readonly compliance: number;
  private readonly mouseStrength: number;
  private readonly mouseRadius: number;
  private readonly damping: number;
  private readonly maxSpeed: number;

  // Per-frame mouse state (world-space ray + signed strength).
  private mouseOrigin: [number, number, number] = [0, 0, 0];
  private mouseDir: [number, number, number] = [0, 0, 1];
  private mouseForce = 0; // signed: >0 attract, <0 repel, 0 idle

  constructor(device: GPUDevice, mesh: ClothMeshData, opts: SolverOptions = {}) {
    this.device = device;
    this.count = mesh.count;
    this.constraintCount = mesh.constraintCount;
    this.structuralCount = mesh.structuralCount;
    this.colorCounts = mesh.colorCounts;

    this.gravity = opts.gravity ?? -9.81;
    this.groundY = opts.groundY ?? 0.0;
    this.compliance = opts.compliance ?? 0.0; // rigid: quasi-inextensible
    this.mouseStrength = opts.mouseStrength ?? 45.0;
    this.mouseRadius = opts.mouseRadius ?? 1.5;
    this.damping = opts.damping ?? 0.8;
    this.maxSpeed = opts.maxSpeed ?? 12.0;

    // --- Buffers ---
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.positionBuffer = this.createBuffer(mesh.positions, storage | GPUBufferUsage.VERTEX);
    this.prevPositionBuffer = this.createBuffer(mesh.positions, storage);
    this.velocityBuffer = this.createBuffer(new Float32Array(this.count * 4), storage);
    this.invMassBuffer = this.createBuffer(mesh.invMasses, storage);
    this.constraintBuffer = this.createBufferRaw(mesh.constraintData, storage);

    this.uniformData = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Per-color batch uniforms (offset + count), written once.
    const batchBuffers = mesh.colorOffsets.map((offset, c) => {
      const buf = device.createBuffer({
        size: BATCH_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const data = new Uint32Array([offset, mesh.colorCounts[c]!, 0, 0]);
      device.queue.writeBuffer(buf, 0, data);
      return buf;
    });

    // --- Pipelines ---
    const integrateModule = device.createShaderModule({ code: integrateWGSL, label: 'integrate' });
    this.integratePipeline = device.createComputePipeline({
      label: 'integrate-pipeline',
      layout: 'auto',
      compute: { module: integrateModule, entryPoint: 'main' },
    });

    const distanceModule = device.createShaderModule({ code: distanceWGSL, label: 'distance' });
    this.solvePipeline = device.createComputePipeline({
      label: 'distance-pipeline',
      layout: 'auto',
      compute: { module: distanceModule, entryPoint: 'main' },
    });

    const velocityModule = device.createShaderModule({
      code: updateVelocityWGSL,
      label: 'updateVelocity',
    });
    this.velocityPipeline = device.createComputePipeline({
      label: 'velocity-pipeline',
      layout: 'auto',
      compute: { module: velocityModule, entryPoint: 'main' },
    });

    // --- Bind groups ---
    this.integrateBindGroup = device.createBindGroup({
      layout: this.integratePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.velocityBuffer } },
        { binding: 4, resource: { buffer: this.invMassBuffer } },
      ],
    });

    const solveLayout = this.solvePipeline.getBindGroupLayout(0);
    this.solveBindGroups = batchBuffers.map((batch) =>
      device.createBindGroup({
        layout: solveLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.positionBuffer } },
          { binding: 2, resource: { buffer: this.invMassBuffer } },
          { binding: 3, resource: { buffer: this.constraintBuffer } },
          { binding: 4, resource: { buffer: batch } },
        ],
      }),
    );

    this.velocityBindGroup = device.createBindGroup({
      layout: this.velocityPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.velocityBuffer } },
        { binding: 4, resource: { buffer: this.invMassBuffer } },
      ],
    });
  }

  /** Number of graph colors (one solve dispatch each per substep). */
  get colorCount(): number {
    return this.colorCounts.length;
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
    const particleGroups = Math.ceil(this.count / WORKGROUP);

    for (let s = 0; s < substeps; s++) {
      // 1. Predict positions under gravity + mouse force.
      let pass = encoder.beginComputePass();
      pass.setPipeline(this.integratePipeline);
      pass.setBindGroup(0, this.integrateBindGroup);
      pass.dispatchWorkgroups(particleGroups);
      pass.end();

      // 2. Solve distance constraints, one dispatch per color (vertex-disjoint).
      for (let c = 0; c < this.colorCounts.length; c++) {
        const groups = Math.ceil(this.colorCounts[c]! / WORKGROUP);
        if (groups === 0) continue;
        pass = encoder.beginComputePass();
        pass.setPipeline(this.solvePipeline);
        pass.setBindGroup(0, this.solveBindGroups[c]!);
        pass.dispatchWorkgroups(groups);
        pass.end();
      }

      // 3. Derive velocities from the net displacement.
      pass = encoder.beginComputePass();
      pass.setPipeline(this.velocityPipeline);
      pass.setBindGroup(0, this.velocityBindGroup);
      pass.dispatchWorkgroups(particleGroups);
      pass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  private writeUniforms(dt: number): void {
    const dv = new DataView(this.uniformData);
    const LE = true;
    dv.setFloat32(0, dt, LE);
    dv.setFloat32(4, this.gravity, LE);
    dv.setFloat32(8, this.groundY, LE);
    dv.setFloat32(12, this.compliance, LE);
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

  private createBufferRaw(data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage,
      mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
  }
}
