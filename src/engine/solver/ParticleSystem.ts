/**
 * ParticleSystem — milestone 5-6 XPBD cloth solver.
 * Owns the GPU buffers (positions, prev positions, velocities, inverse masses,
 * color-sorted constraints) and orchestrates the per-substep passes (brief §3.2):
 *   integrate (predict) → distance/bending solve, one dispatch per graph color
 *   → collide (sphere + ground, friction) → velocity.
 * Everything stays on the GPU; the renderer reads the position buffer directly,
 * there is no CPU round-trip per frame (brief §3.5).
 *
 * The mesh topology (grid + structural/shear/bending constraints + coloring) is
 * built on the CPU by ClothMesh/ConstraintGraph and handed in as ClothMeshData,
 * keeping engine/ free of any renderer dependency.
 */
import integrateWGSL from './shaders/integrate.wgsl?raw';
import distanceWGSL from './shaders/distance.wgsl?raw';
import collideWGSL from './shaders/collide.wgsl?raw';
import updateVelocityWGSL from './shaders/updateVelocity.wgsl?raw';
import type { ClothMeshData } from '../cloth/ClothMesh';

export interface SolverOptions {
  gravity?: number; // m/s^2, default -9.81
  groundY?: number;
  sphereCenter?: [number, number, number];
  sphereRadius?: number;
  /** Coulomb friction coefficient [0,1] for sphere + ground contacts. */
  friction?: number;
  /** Cloth half-thickness kept off collider surfaces (world units). */
  clothThickness?: number;
  /** Peak radial acceleration of the mouse force (m/s^2). */
  mouseStrength?: number;
  /** Falloff radius of the mouse force (world units). */
  mouseRadius?: number;
  /** Linear velocity drag rate (1/s) — bleeds energy for stability. */
  damping?: number;
  /** Hard cap on particle speed (m/s) to keep the sim from exploding. */
  maxSpeed?: number;
}

// SimParams std140-style layout, 80 bytes. Offsets (bytes):
//  0 dt, 4 gravity, 8 ground_y, 12 friction,
//  16 ray_origin.xyz, 28 mouse_force,
//  32 ray_dir.xyz, 44 mouse_radius,
//  48 sphere_center.xyz, 60 sphere_radius,
//  64 particle_count, 68 damping, 72 max_speed, 76 cloth_thickness.
const UNIFORM_SIZE = 80;
const BATCH_SIZE = 16; // Batch uniform: offset,count + 2 pad (u32)
const WORKGROUP = 256;

export class ParticleSystem {
  readonly count: number;
  readonly constraintCount: number;
  readonly structuralCount: number;
  readonly shearCount: number;
  readonly bendingCount: number;
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
  private readonly collidePipeline: GPUComputePipeline;
  private readonly velocityPipeline: GPUComputePipeline;

  private readonly integrateBindGroup: GPUBindGroup;
  private readonly collideBindGroup: GPUBindGroup;
  private readonly velocityBindGroup: GPUBindGroup;
  private readonly solveBindGroups: GPUBindGroup[];

  private readonly colorCounts: number[];

  // Rest state kept for reset() and pin toggling.
  private readonly initialPositions: Float32Array<ArrayBuffer>;
  private readonly baseInvMasses: Float32Array<ArrayBuffer>;
  private readonly cornerIndices: [number, number];
  private pinned = false;

  private readonly gravity: number;
  private readonly groundY: number;
  private readonly sphereCenter: [number, number, number];
  private readonly sphereRadius: number;
  private readonly friction: number;
  private readonly clothThickness: number;
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
    this.shearCount = mesh.shearCount;
    this.bendingCount = mesh.bendingCount;
    this.colorCounts = mesh.colorCounts;
    this.initialPositions = new Float32Array(mesh.positions);
    this.baseInvMasses = new Float32Array(mesh.invMasses);
    this.cornerIndices = mesh.cornerIndices;

    this.gravity = opts.gravity ?? -9.81;
    this.groundY = opts.groundY ?? 0.0;
    this.sphereCenter = opts.sphereCenter ?? [0, 0.8, 0];
    this.sphereRadius = opts.sphereRadius ?? 0.55;
    this.friction = opts.friction ?? 0.5;
    this.clothThickness = opts.clothThickness ?? 0.01;
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
      device.queue.writeBuffer(buf, 0, new Uint32Array([offset, mesh.colorCounts[c]!, 0, 0]));
      return buf;
    });

    // --- Pipelines ---
    const pipeline = (code: string, label: string): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: 'auto',
        compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' },
      });
    this.integratePipeline = pipeline(integrateWGSL, 'integrate');
    this.solvePipeline = pipeline(distanceWGSL, 'distance');
    this.collidePipeline = pipeline(collideWGSL, 'collide');
    this.velocityPipeline = pipeline(updateVelocityWGSL, 'updateVelocity');

    // --- Bind groups ---
    const bg = (p: GPUComputePipeline, buffers: GPUBuffer[]): GPUBindGroup =>
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });

    this.integrateBindGroup = bg(this.integratePipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.velocityBuffer,
      this.invMassBuffer,
    ]);
    this.collideBindGroup = bg(this.collidePipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.invMassBuffer,
    ]);
    this.velocityBindGroup = bg(this.velocityPipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.velocityBuffer,
      this.invMassBuffer,
    ]);

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
  }

  /** Number of graph colors (one solve dispatch each per substep). */
  get colorCount(): number {
    return this.colorCounts.length;
  }

  get pinsHeld(): boolean {
    return this.pinned;
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

  /** Re-drop the cloth: restore the rest pose, zero velocities, release pins. */
  reset(): void {
    this.pinned = false;
    this.device.queue.writeBuffer(this.positionBuffer, 0, this.initialPositions);
    this.device.queue.writeBuffer(this.prevPositionBuffer, 0, this.initialPositions);
    this.device.queue.writeBuffer(this.velocityBuffer, 0, new Float32Array(this.count * 4));
    this.device.queue.writeBuffer(this.invMassBuffer, 0, this.baseInvMasses);
  }

  /** Pin/release the two anchor corners at runtime (brief §3.3 "release" toggle). */
  setCornerPins(pinned: boolean): void {
    this.pinned = pinned;
    const masses = new Float32Array(this.baseInvMasses);
    if (pinned) {
      masses[this.cornerIndices[0]] = 0;
      masses[this.cornerIndices[1]] = 0;
    }
    this.device.queue.writeBuffer(this.invMassBuffer, 0, masses);
  }

  /** Advance the simulation by one frame, split into `substeps` substeps. */
  step(frameDt: number, substeps: number): void {
    const dt = frameDt / substeps;
    this.writeUniforms(dt);

    const encoder = this.device.createCommandEncoder({ label: 'sim-frame' });
    const particleGroups = Math.ceil(this.count / WORKGROUP);
    const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, groups: number): void => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups);
      pass.end();
    };

    for (let s = 0; s < substeps; s++) {
      // 1. Predict under gravity + mouse force.
      dispatch(this.integratePipeline, this.integrateBindGroup, particleGroups);
      // 2. Distance + bending solve, one dispatch per vertex-disjoint color.
      for (let c = 0; c < this.colorCounts.length; c++) {
        const groups = Math.ceil(this.colorCounts[c]! / WORKGROUP);
        if (groups > 0) dispatch(this.solvePipeline, this.solveBindGroups[c]!, groups);
      }
      // 3. Resolve sphere + ground contacts (friction).
      dispatch(this.collidePipeline, this.collideBindGroup, particleGroups);
      // 4. Derive velocities from the net displacement.
      dispatch(this.velocityPipeline, this.velocityBindGroup, particleGroups);
    }

    this.device.queue.submit([encoder.finish()]);
  }

  private writeUniforms(dt: number): void {
    const dv = new DataView(this.uniformData);
    const LE = true;
    dv.setFloat32(0, dt, LE);
    dv.setFloat32(4, this.gravity, LE);
    dv.setFloat32(8, this.groundY, LE);
    dv.setFloat32(12, this.friction, LE);
    dv.setFloat32(16, this.mouseOrigin[0], LE);
    dv.setFloat32(20, this.mouseOrigin[1], LE);
    dv.setFloat32(24, this.mouseOrigin[2], LE);
    dv.setFloat32(28, this.mouseForce, LE);
    dv.setFloat32(32, this.mouseDir[0], LE);
    dv.setFloat32(36, this.mouseDir[1], LE);
    dv.setFloat32(40, this.mouseDir[2], LE);
    dv.setFloat32(44, this.mouseRadius, LE);
    dv.setFloat32(48, this.sphereCenter[0], LE);
    dv.setFloat32(52, this.sphereCenter[1], LE);
    dv.setFloat32(56, this.sphereCenter[2], LE);
    dv.setFloat32(60, this.sphereRadius, LE);
    dv.setUint32(64, this.count, LE);
    dv.setFloat32(68, this.damping, LE);
    dv.setFloat32(72, this.maxSpeed, LE);
    dv.setFloat32(76, this.clothThickness, LE);
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
