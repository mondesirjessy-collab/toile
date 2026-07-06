/**
 * ParticleSystem — XPBD cloth solver (milestones 3 → 7-8).
 * Owns the GPU buffers and orchestrates the per-substep passes (brief §3.2):
 *   integrate → distance/bending solve (one dispatch per graph color)
 *   → drag → collide (sphere + ground, friction) → velocity.
 * Everything stays on the GPU; the renderer reads the position buffer directly
 * (brief §3.5). Compliance (stretch/shear/bend) and friction are live uniforms
 * so the control panel retunes them without a rebuild; resolution changes
 * rebuild the whole system (see dispose()).
 */
import integrateWGSL from './shaders/integrate.wgsl?raw';
import distanceWGSL from './shaders/distance.wgsl?raw';
import dihedralWGSL from './shaders/dihedral.wgsl?raw';
import dragWGSL from './shaders/drag.wgsl?raw';
import collideWGSL from './shaders/collide.wgsl?raw';
import selfCollideWGSL from './shaders/selfCollide.wgsl?raw';
import updateVelocityWGSL from './shaders/updateVelocity.wgsl?raw';
import type { ClothMeshData } from '../cloth/ClothMesh';

/** Optional GPU-timestamp span attached to a phase's first/last pass. */
export interface TimestampSpan {
  querySet: GPUQuerySet;
  beginIndex: number;
  endIndex: number;
}

/**
 * Analytic round-cone collider: segment a→b, radius at a, radius2 at b.
 * A capsule when radius2 is omitted, a sphere when b is omitted too.
 */
export interface Collider {
  a: [number, number, number];
  b?: [number, number, number];
  radius: number;
  radius2?: number;
}

export interface SolverOptions {
  gravity?: number;
  groundY?: number;
  /** Round-cone colliders (a mannequin is a handful of these). */
  colliders?: Collider[];
  /** Smooth-min blend between colliders (m); 0 = hard union of shapes. */
  colliderBlend?: number;
  friction?: number;
  clothThickness?: number;
  complianceStretch?: number;
  complianceShear?: number;
  complianceBend?: number;
  mouseStrength?: number;
  mouseRadius?: number;
  damping?: number;
  maxSpeed?: number;
  /** How hard the grabbed particle follows the cursor each substep [0,1]. */
  dragStiffness?: number;
  /** Cloth self-collision (spatial hash), on by default. */
  selfCollision?: boolean;
}

// SimParams std140-style layout, 144 bytes. Offsets (bytes):
//  0 dt, 4 gravity, 8 ground_y, 12 friction,
//  16 ray_origin.xyz, 28 mouse_force, 32 ray_dir.xyz, 44 mouse_radius,
//  48 collider_count (u32), 52 wind_strength, 56 wind_time, 60 cloth_spacing,
//  64 drag_target.xyz, 76 drag_stiffness,
//  80 compliance_stretch, 84 compliance_shear, 88 compliance_bend, 92 cloth_thickness,
//  96 particle_count, 100 damping, 104 max_speed, 108 drag_index,
//  112 body_min.xyz, 124 blend_k, 128 body_max.xyz, 140 pad.
const UNIFORM_SIZE = 144;
const BATCH_SIZE = 16;
const WORKGROUP = 256;
const DRAG_NONE = 0xffffffff;

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
  private readonly quadBuffer: GPUBuffer | null;
  private readonly colliderBuffer: GPUBuffer;
  private readonly uniformBuffer: GPUBuffer;
  private readonly selfParamsBuffer: GPUBuffer;
  private readonly headsBuffer: GPUBuffer;
  private readonly nextsBuffer: GPUBuffer;
  private readonly batchBuffers: GPUBuffer[];
  private readonly readbackBuffer: GPUBuffer;
  private readonly uniformData: ArrayBuffer;

  private readonly integratePipeline: GPUComputePipeline;
  private readonly solvePipeline: GPUComputePipeline;
  private readonly dragPipeline: GPUComputePipeline;
  private readonly collidePipeline: GPUComputePipeline;
  private readonly velocityPipeline: GPUComputePipeline;
  private readonly hashClearPipeline: GPUComputePipeline;
  private readonly hashInsertPipeline: GPUComputePipeline;
  private readonly selfCollidePipeline: GPUComputePipeline;

  private readonly integrateBindGroup: GPUBindGroup;
  private readonly dragBindGroup: GPUBindGroup;
  private readonly collideBindGroup: GPUBindGroup;
  private readonly velocityBindGroup: GPUBindGroup;
  private readonly solveBindGroups: GPUBindGroup[];
  private readonly hashClearBindGroup: GPUBindGroup;
  private readonly hashInsertBindGroup: GPUBindGroup;
  private readonly selfCollideBindGroup: GPUBindGroup;
  private readonly dihedralPipeline: GPUComputePipeline;
  private readonly dihedralBindGroups: GPUBindGroup[];
  private readonly quadColorCounts: number[];

  private readonly tableSize: number;
  private readonly spacing: number;
  private readonly gridN: number;
  private selfEnabled: boolean;

  private readonly colorCounts: number[];

  private readonly initialPositions: Float32Array<ArrayBuffer>;
  private readonly baseInvMasses: Float32Array<ArrayBuffer>;
  private readonly cornerIndices: [number, number];
  private pinned = false;
  private readbackBusy = false;

  private readonly gravity: number;
  private readonly groundY: number;
  private readonly colliderCount: number;
  private readonly colliderBlend: number;
  private readonly bodyMin = [Infinity, Infinity, Infinity];
  private readonly bodyMax = [-Infinity, -Infinity, -Infinity];
  private readonly clothThickness: number;
  private readonly mouseStrength: number;
  private readonly mouseRadius: number;
  private readonly damping: number;
  private readonly maxSpeed: number;
  private readonly dragStiffness: number;

  // Live-tunable parameters.
  private friction: number;
  private complianceStretch: number;
  private complianceShear: number;
  private complianceBend: number;
  private windStrength = 0;
  private windTime = 0;

  private mouseOrigin: [number, number, number] = [0, 0, 0];
  private mouseDir: [number, number, number] = [0, 0, 1];
  private mouseForce = 0;
  private dragTarget: [number, number, number] = [0, 0, 0];
  private dragIndex = DRAG_NONE;

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
    const colliders = opts.colliders ?? [{ a: [0, 0.8, 0] as [number, number, number], radius: 0.55 }];
    this.colliderCount = colliders.length;
    this.friction = opts.friction ?? 0.5;
    this.clothThickness = opts.clothThickness ?? 0.01;
    this.complianceStretch = opts.complianceStretch ?? 0.0;
    this.complianceShear = opts.complianceShear ?? 0.0;
    this.complianceBend = opts.complianceBend ?? 2.0e-6;
    this.mouseStrength = opts.mouseStrength ?? 45.0;
    this.mouseRadius = opts.mouseRadius ?? 1.5;
    this.damping = opts.damping ?? 0.8;
    this.maxSpeed = opts.maxSpeed ?? 12.0;
    this.dragStiffness = opts.dragStiffness ?? 0.4;
    this.selfEnabled = opts.selfCollision ?? true;
    this.spacing = mesh.spacing;
    this.gridN = mesh.resolution;
    this.tableSize = 1 << Math.ceil(Math.log2(Math.max(1024, this.count * 2)));

    // --- Buffers ---
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.positionBuffer = this.createBuffer(
      mesh.positions,
      storage | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
    );
    this.prevPositionBuffer = this.createBuffer(mesh.positions, storage);
    this.velocityBuffer = this.createBuffer(new Float32Array(this.count * 4), storage);
    this.invMassBuffer = this.createBuffer(mesh.invMasses, storage);
    this.constraintBuffer = this.createBufferRaw(mesh.constraintData, storage);
    this.quadColorCounts = mesh.quadColorCounts;
    this.quadBuffer = mesh.quadCount > 0 ? this.createBufferRaw(mesh.quadData, storage) : null;
    // Round-cone packing: {a.xyz, ra, b.xyz, rb} — 32 bytes per collider.
    const colliderData = new Float32Array(this.colliderCount * 8);
    colliders.forEach((c, k) => {
      const b = c.b ?? c.a; // sphere: degenerate cone
      colliderData.set([...c.a, c.radius, ...b, c.radius2 ?? c.radius], k * 8);
    });
    this.colliderBuffer = this.createBuffer(colliderData, storage);
    // Collider AABB (early out in the collide pass) + smooth-min blend.
    this.colliderBlend = opts.colliderBlend ?? 0;
    const pad = this.colliderBlend + 0.05;
    for (const c of colliders) {
      const b = c.b ?? c.a;
      const r = Math.max(c.radius, c.radius2 ?? c.radius);
      for (let i = 0; i < 3; i++) {
        this.bodyMin[i] = Math.min(this.bodyMin[i]!, Math.min(c.a[i]!, b[i]!) - r - pad);
        this.bodyMax[i] = Math.max(this.bodyMax[i]!, Math.max(c.a[i]!, b[i]!) + r + pad);
      }
    }

    // Self-collision spatial hash: cell heads + per-particle next links.
    this.headsBuffer = device.createBuffer({
      size: this.tableSize * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.nextsBuffer = device.createBuffer({
      size: this.count * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    this.selfParamsBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.writeSelfParams();
    this.readbackBuffer = device.createBuffer({
      size: this.count * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this.uniformData = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.batchBuffers = mesh.colorOffsets.map((offset, c) => {
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
    this.dragPipeline = pipeline(dragWGSL, 'drag');
    this.collidePipeline = pipeline(collideWGSL, 'collide');
    this.velocityPipeline = pipeline(updateVelocityWGSL, 'updateVelocity');

    const selfModule = device.createShaderModule({ code: selfCollideWGSL, label: 'selfCollide' });
    const selfPipeline = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `self-${entryPoint}`,
        layout: 'auto',
        compute: { module: selfModule, entryPoint },
      });
    this.hashClearPipeline = selfPipeline('clear_hash');
    this.hashInsertPipeline = selfPipeline('insert');
    this.selfCollidePipeline = selfPipeline('collide');

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
    this.dragBindGroup = bg(this.dragPipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.invMassBuffer,
    ]);
    this.collideBindGroup = bg(this.collidePipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.invMassBuffer,
      this.colliderBuffer,
    ]);
    this.velocityBindGroup = bg(this.velocityPipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.velocityBuffer,
      this.invMassBuffer,
    ]);

    const solveLayout = this.solvePipeline.getBindGroupLayout(0);
    this.solveBindGroups = this.batchBuffers.map((batch) =>
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

    // Dihedral bending hinges: one dispatch per hinge color, like distance.
    this.dihedralPipeline = pipeline(dihedralWGSL, 'dihedral');
    this.dihedralBindGroups =
      this.quadBuffer === null
        ? []
        : mesh.quadColorOffsets.map((offset, c) => {
            const buf = device.createBuffer({
              size: BATCH_SIZE,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(buf, 0, new Uint32Array([offset, mesh.quadColorCounts[c]!, 0, 0]));
            this.batchBuffers.push(buf); // shares the dispose path
            return device.createBindGroup({
              layout: this.dihedralPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: this.positionBuffer } },
                { binding: 2, resource: { buffer: this.invMassBuffer } },
                { binding: 3, resource: { buffer: this.quadBuffer! } },
                { binding: 4, resource: { buffer: buf } },
              ],
            });
          });

    // Self-collision bind groups ('auto' layouts only contain the bindings each
    // entry point actually uses, so they are built per pipeline).
    this.hashClearBindGroup = device.createBindGroup({
      layout: this.hashClearPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.selfParamsBuffer } },
        { binding: 3, resource: { buffer: this.headsBuffer } },
      ],
    });
    const selfAll: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.selfParamsBuffer } },
      { binding: 1, resource: { buffer: this.positionBuffer } },
      { binding: 2, resource: { buffer: this.invMassBuffer } },
      { binding: 3, resource: { buffer: this.headsBuffer } },
      { binding: 4, resource: { buffer: this.nextsBuffer } },
    ];
    this.hashInsertBindGroup = device.createBindGroup({
      layout: this.hashInsertPipeline.getBindGroupLayout(0),
      entries: selfAll,
    });
    this.selfCollideBindGroup = device.createBindGroup({
      layout: this.selfCollidePipeline.getBindGroupLayout(0),
      entries: selfAll,
    });
  }

  get colorCount(): number {
    return this.colorCounts.length;
  }
  get pinsHeld(): boolean {
    return this.pinned;
  }
  get isDragging(): boolean {
    return this.dragIndex !== DRAG_NONE;
  }

  setMouse(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    mode: number,
  ): void {
    this.mouseOrigin = [origin[0], origin[1], origin[2]];
    this.mouseDir = [dir[0], dir[1], dir[2]];
    this.mouseForce = mode * this.mouseStrength;
  }

  /** Set/clear the drag constraint. index === null releases the grab. */
  setDrag(index: number | null, target: readonly [number, number, number]): void {
    this.dragIndex = index ?? DRAG_NONE;
    this.dragTarget = [target[0], target[1], target[2]];
  }

  setFriction(v: number): void {
    this.friction = v;
  }

  /** Set the wind strength (m/s², 0 = calm) live. */
  setWind(strength: number): void {
    this.windStrength = strength;
  }

  /** Toggle cloth self-collision live. */
  setSelfCollision(enabled: boolean): void {
    this.selfEnabled = enabled;
    this.writeSelfParams();
  }

  private writeSelfParams(): void {
    const data = new ArrayBuffer(32);
    const dv = new DataView(data);
    dv.setFloat32(0, this.spacing, true); // cell_size
    dv.setFloat32(4, this.spacing * 0.6, true); // min_dist, under the weave spacing
    dv.setUint32(8, this.tableSize, true);
    dv.setUint32(12, this.count, true);
    dv.setUint32(16, this.gridN, true);
    dv.setUint32(20, this.gridN * this.gridN, true);
    dv.setUint32(24, this.selfEnabled ? 1 : 0, true);
    this.device.queue.writeBuffer(this.selfParamsBuffer, 0, data);
  }
  setCompliance(c: { stretch?: number; shear?: number; bend?: number }): void {
    if (c.stretch !== undefined) this.complianceStretch = c.stretch;
    if (c.shear !== undefined) this.complianceShear = c.shear;
    if (c.bend !== undefined) this.complianceBend = c.bend;
  }

  /** Re-drop the cloth: restore the rest pose, zero velocities, release pins. */
  reset(): void {
    this.pinned = false;
    this.dragIndex = DRAG_NONE;
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

  /**
   * Read the current positions back to the CPU (for cursor picking). Returns
   * null if a read is already in flight. One-shot copy, not per-frame.
   */
  async readPositions(): Promise<Float32Array | null> {
    if (this.readbackBusy) return null;
    this.readbackBusy = true;
    try {
      const encoder = this.device.createCommandEncoder({ label: 'pick-readback' });
      encoder.copyBufferToBuffer(this.positionBuffer, 0, this.readbackBuffer, 0, this.count * 16);
      this.device.queue.submit([encoder.finish()]);
      await this.readbackBuffer.mapAsync(GPUMapMode.READ);
      const copy = new Float32Array(this.readbackBuffer.getMappedRange().slice(0));
      this.readbackBuffer.unmap();
      return copy;
    } finally {
      this.readbackBusy = false;
    }
  }

  /**
   * Advance the simulation by one frame, split into `substeps` substeps.
   * All dispatches share ONE compute pass: WebGPU guarantees that storage
   * writes from a dispatch are visible to the following dispatches of the same
   * pass, and collapsing ~16×substeps passes into one removes the per-pass
   * encoder overhead that dominated the frame at high substep counts
   * (milestone 9-10 optimization for the S1 integrated-GPU target).
   */
  step(frameDt: number, substeps: number, ts?: TimestampSpan): void {
    const dt = frameDt / substeps;
    this.windTime += frameDt; // drives the gust pattern
    this.writeUniforms(dt);

    const encoder = this.device.createCommandEncoder({ label: 'sim-frame' });
    const particleGroups = Math.ceil(this.count / WORKGROUP);

    const pass = encoder.beginComputePass(
      ts
        ? {
            timestampWrites: {
              querySet: ts.querySet,
              beginningOfPassWriteIndex: ts.beginIndex,
              endOfPassWriteIndex: ts.endIndex,
            },
          }
        : undefined,
    );
    const dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, groups: number): void => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups);
    };

    for (let s = 0; s < substeps; s++) {
      dispatch(this.integratePipeline, this.integrateBindGroup, particleGroups);

      for (let c = 0; c < this.colorCounts.length; c++) {
        const groups = Math.ceil(this.colorCounts[c]! / WORKGROUP);
        if (groups > 0) dispatch(this.solvePipeline, this.solveBindGroups[c]!, groups);
      }

      // True dihedral bending, one dispatch per hinge color.
      for (let c = 0; c < this.quadColorCounts.length; c++) {
        const groups = Math.ceil(this.quadColorCounts[c]! / WORKGROUP);
        if (groups > 0) dispatch(this.dihedralPipeline, this.dihedralBindGroups[c]!, groups);
      }

      // The drag constraint costs a dispatch only while a particle is grabbed.
      if (this.dragIndex !== DRAG_NONE) dispatch(this.dragPipeline, this.dragBindGroup, 1);

      // Self-collision: rebuild the spatial hash, then separate close pairs.
      if (this.selfEnabled) {
        dispatch(this.hashClearPipeline, this.hashClearBindGroup, Math.ceil(this.tableSize / WORKGROUP));
        dispatch(this.hashInsertPipeline, this.hashInsertBindGroup, particleGroups);
        dispatch(this.selfCollidePipeline, this.selfCollideBindGroup, particleGroups);
      }

      dispatch(this.collidePipeline, this.collideBindGroup, particleGroups);
      dispatch(this.velocityPipeline, this.velocityBindGroup, particleGroups);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.positionBuffer.destroy();
    this.prevPositionBuffer.destroy();
    this.velocityBuffer.destroy();
    this.invMassBuffer.destroy();
    this.constraintBuffer.destroy();
    this.quadBuffer?.destroy();
    this.colliderBuffer.destroy();
    this.uniformBuffer.destroy();
    this.selfParamsBuffer.destroy();
    this.headsBuffer.destroy();
    this.nextsBuffer.destroy();
    this.readbackBuffer.destroy();
    for (const b of this.batchBuffers) b.destroy();
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
    dv.setUint32(48, this.colliderCount, LE);
    dv.setFloat32(52, this.windStrength, LE);
    dv.setFloat32(56, this.windTime, LE);
    dv.setFloat32(60, this.spacing, LE); // cloth_spacing (dihedral compliance scale)
    dv.setFloat32(64, this.dragTarget[0], LE);
    dv.setFloat32(68, this.dragTarget[1], LE);
    dv.setFloat32(72, this.dragTarget[2], LE);
    dv.setFloat32(76, this.dragStiffness, LE);
    dv.setFloat32(80, this.complianceStretch, LE);
    dv.setFloat32(84, this.complianceShear, LE);
    dv.setFloat32(88, this.complianceBend, LE);
    dv.setFloat32(92, this.clothThickness, LE);
    dv.setUint32(96, this.count, LE);
    dv.setFloat32(100, this.damping, LE);
    dv.setFloat32(104, this.maxSpeed, LE);
    dv.setUint32(108, this.dragIndex, LE);
    dv.setFloat32(112, this.bodyMin[0]!, LE);
    dv.setFloat32(116, this.bodyMin[1]!, LE);
    dv.setFloat32(120, this.bodyMin[2]!, LE);
    dv.setFloat32(124, this.colliderBlend, LE);
    dv.setFloat32(128, this.bodyMax[0]!, LE);
    dv.setFloat32(132, this.bodyMax[1]!, LE);
    dv.setFloat32(136, this.bodyMax[2]!, LE);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  private createBuffer(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  private createBufferRaw(data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
  }
}
