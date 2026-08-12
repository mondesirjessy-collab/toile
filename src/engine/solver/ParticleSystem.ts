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
import collisionAuditWGSL from './shaders/collisionAudit.wgsl?raw';
import selfCollideWGSL from './shaders/selfCollide.wgsl?raw';
import surfaceContactWGSL from './shaders/surfaceContact.wgsl?raw';
import surfaceReactionWGSL from './shaders/surfaceReaction.wgsl?raw';
import updateVelocityWGSL from './shaders/updateVelocity.wgsl?raw';
import type { ClothMeshData } from '../cloth/ClothMesh';
import { SceneResourceRegistry } from '../gpu/SceneResourceRegistry';
import { measureSurfaceContacts } from './SurfaceContact';
import {
  clampFabricGsm,
  fabricMaterialTable,
  packFabricMaterialTable,
  scaleInverseMassesByMaterial,
  type FabricCompliance,
  type FabricDynamics,
  type FabricPhysics,
} from './FabricMaterial';

const GPU_READBACK_TIMEOUT_MS = 5_000;
const GPU_DRAIN_TIMEOUT_MS = 12_000;

class GpuOperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} n'a pas répondu sous ${timeoutMs} ms`);
    this.name = 'GpuOperationTimeoutError';
  }
}

/** Bound browser/GPU promises: some WebGPU implementations never reject a
 * pending map/error-scope/drain after a scene switch or device hiccup. */
function withGpuTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new GpuOperationTimeoutError(label, timeoutMs)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Optional GPU-timestamp span attached to a phase's first/last pass. */
export interface TimestampSpan {
  querySet: GPUQuerySet;
  beginIndex: number;
  endIndex: number;
}

/**
 * Atomic DEV snapshot produced by the collision-audit compute pass.
 *
 * - `positions` is xyz world space (metres), three floats per particle.
 * - `distances` is the raw signed distance to the exact body field used by the
 *   collision shader (metres): negative means inside. `NaN` marks a particle
 *   whose current inverse mass is zero (cut or pinned); `Infinity` marks an
 *   active particle outside the collider/SDF domain.
 * - `contactOffsets` is the effective per-particle collision offset (metres),
 *   including its material thickness and garment layer.
 */
export interface CollisionDistanceSnapshot {
  positions: Float32Array<ArrayBuffer>;
  distances: Float32Array<ArrayBuffer>;
  contactOffsets: Float32Array<ArrayBuffer>;
}

/**
 * Analytic round-cone collider: segment a→b, radius at a, radius2 at b.
 * A capsule when radius2 is omitted, a sphere when b is omitted too.
 * `scale` squashes per axis about the midpoint (components ≤ 1): ellipses.
 */
export interface Collider {
  a: [number, number, number];
  b?: [number, number, number];
  radius: number;
  radius2?: number;
  scale?: [number, number, number];
}

export interface SolverOptions {
  gravity?: number;
  groundY?: number;
  /** Round-cone colliders (a mannequin is a handful of these). */
  colliders?: Collider[];
  /** Smooth-min blend between colliders (m); 0 = hard union of shapes. */
  colliderBlend?: number;
  /**
   * Baked SDF grid collider (scanned avatar): signed distance in meters,
   * x fastest then y then z. Replaces the analytic prims when present.
   */
  sdfGrid?: {
    dims: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
    data: Float32Array;
  };
  /** Legacy single coefficient; used for both static/dynamic when split values are absent. */
  friction?: number;
  frictionStatic?: number;
  frictionDynamic?: number;
  clothThickness?: number;
  arealDensity?: number;
  complianceStretch?: number;
  /** Grain-line (vertical/warp) stretch compliance; defaults to weft's. */
  complianceStretchWarp?: number;
  complianceShear?: number;
  complianceBend?: number;
  complianceBendWarp?: number;
  stretchLimit?: number;
  shearLimit?: number;
  mouseStrength?: number;
  mouseRadius?: number;
  damping?: number;
  /** Relative aerodynamic coupling (1 = reference cloth). */
  airDrag?: number;
  creaseYieldDeg?: number;
  creaseMemory?: number;
  creaseRecovery?: number;
  maxSpeed?: number;
  /** How hard the grabbed particle follows the cursor each substep [0,1]. */
  dragStiffness?: number;
  /** Cloth self-collision (spatial hash), on by default. */
  selfCollision?: boolean;
  /**
   * Material 0 is the live global fabric; following entries are explicit
   * per-piece presets. When omitted, the built-in seven-preset table is used.
   */
  materials?: readonly FabricPhysics[];
  /** Custom-density materials whose other properties inherit material 0. */
  globalMaterialVariantIds?: readonly number[];
}

// SimParams uniform layout, 208 bytes. Offsets (bytes):
//  0 dt, 4 gravity, 8 ground_y, 12 friction,
//  16 ray_origin.xyz, 28 mouse_force, 32 ray_dir.xyz, 44 mouse_radius,
//  48 collider_count (u32), 52 wind_strength, 56 wind_time, 60 cloth_spacing,
//  64 drag_target.xyz, 76 drag_stiffness,
//  80 compliance_stretch, 84 compliance_shear, 88 compliance_bend, 92 cloth_thickness,
//  96 particle_count, 100 damping, 104 max_speed, 108 drag_index,
//  112 body_min.xyz, 124 blend_k, 128 body_max.xyz, 140 use_grid,
//  144 spin_cos, 148 spin_sin, 152 spin_dtheta (per substep), 156 compliance_stretch_warp,
//  160 layer_gap (couches), 164 anchor_stiffness (ceinture : rappel Y/substep), 168 max_layer,
//  172 compliance_bend_warp, 176 friction_dynamic, 180 air_drag,
//  184 stretch_limit, 188 shear_limit, 192 crease_yield, 196 crease_memory,
//  200 crease_recovery, 204 seam_dressing_progress,
//  208 zip_open (v198 — seul distance.wgsl déclare la struct longue ; le
//  buffer élargi reste liable aux structs 208 octets des autres passes),
//  212-220 réservés.
const UNIFORM_SIZE = 224;
const BATCH_SIZE = 16;
const WORKGROUP = 256;
const DRAG_NONE = 0xffffffff;
/**
 * Two terminal Gauss-Seidel sweeps are enough to converge the small seam
 * junction graphs (shoulder↔sleeve↔collar) while keeping the adaptive substep
 * governor from shedding physics quality because of excessive dispatches.
 * The ordinary full solve already performs the first regular-seam sweep.
 */
const REGULAR_SEAM_REPLAY_PASSES = 2;

/**
 * Compute pipelines are pure functions of their (constant) WGSL — nothing
 * per-instance — yet every scene switch / slider release builds a new
 * ParticleSystem. Compiling all nine shaders each time cost ~half the ~1 s
 * rebuild freeze. Compile once per device and reuse; bind groups stay
 * per-instance (they reference this system's buffers). Pipelines have no
 * destroy(), so sharing them across rebuilds is safe.
 */
interface SolverPipelines {
  integrate: GPUComputePipeline;
  distance: GPUComputePipeline;
  drag: GPUComputePipeline;
  collide: GPUComputePipeline;
  velocity: GPUComputePipeline;
  hashClear: GPUComputePipeline;
  hashInsert: GPUComputePipeline;
  selfCollide: GPUComputePipeline;
  surfaceContact: GPUComputePipeline;
  surfaceReaction: GPUComputePipeline;
  dihedral: GPUComputePipeline;
}
const solverPipelineCache = new WeakMap<GPUDevice, SolverPipelines>();
const collisionAuditPipelineCache = new WeakMap<GPUDevice, GPUComputePipeline>();

/** Lazily compiled: ordinary simulation and production step() pay no audit cost. */
function collisionAuditPipeline(device: GPUDevice): GPUComputePipeline {
  const cached = collisionAuditPipelineCache.get(device);
  if (cached) return cached;
  const pipeline = device.createComputePipeline({
    label: 'collision-audit',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: collisionAuditWGSL, label: 'collision-audit' }),
      entryPoint: 'main',
    },
  });
  collisionAuditPipelineCache.set(device, pipeline);
  return pipeline;
}

function solverPipelines(device: GPUDevice): SolverPipelines {
  const cached = solverPipelineCache.get(device);
  if (cached) return cached;
  const compute = (code: string, label: string): GPUComputePipeline =>
    device.createComputePipeline({
      label,
      layout: 'auto',
      compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' },
    });
  const selfModule = device.createShaderModule({ code: selfCollideWGSL, label: 'selfCollide' });
  const selfPipe = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ label: `self-${entryPoint}`, layout: 'auto', compute: { module: selfModule, entryPoint } });
  const pipelines: SolverPipelines = {
    integrate: compute(integrateWGSL, 'integrate'),
    distance: compute(distanceWGSL, 'distance'),
    drag: compute(dragWGSL, 'drag'),
    collide: compute(collideWGSL, 'collide'),
    velocity: compute(updateVelocityWGSL, 'updateVelocity'),
    hashClear: selfPipe('clear_hash'),
    hashInsert: selfPipe('insert'),
    selfCollide: selfPipe('collide'),
    surfaceContact: compute(surfaceContactWGSL, 'surfaceContact'),
    surfaceReaction: compute(surfaceReactionWGSL, 'surfaceReaction'),
    dihedral: compute(dihedralWGSL, 'dihedral'),
  };
  solverPipelineCache.set(device, pipelines);
  return pipelines;
}

export class ParticleSystem {
  readonly count: number;
  readonly constraintCount: number;
  readonly structuralCount: number;
  readonly shearCount: number;
  readonly bendingCount: number;
  readonly positionBuffer: GPUBuffer;

  private readonly device: GPUDevice;
  private readonly resources = new SceneResourceRegistry();
  private readonly prevPositionBuffer: GPUBuffer;
  private readonly velocityBuffer: GPUBuffer;
  private readonly invMassBuffer: GPUBuffer;
  private readonly materialIdBuffer: GPUBuffer;
  private readonly materialBuffer: GPUBuffer;
  private readonly layerBuffer: GPUBuffer;
  private readonly maxLayer: number; // deepest garment layer, for the sd_body reject margin (M4)
  private readonly seamFreeBuffer: GPUBuffer;
  private readonly seamDistBuffer: GPUBuffer;
  private readonly surfaceMaskBuffer: GPUBuffer;
  private readonly surfaceContactBuffer: GPUBuffer;
  private readonly surfaceReactionBuffer: GPUBuffer;
  private readonly surfaceParamsBuffer: GPUBuffer;
  private readonly surfaceContactCount: number;
  private readonly anchorBuffer: GPUBuffer;
  private readonly anchorReleaseSeconds: number;
  private readonly seamDressingSeconds: number;
  /** v198 — état vivant de la fermeture (true = ZipperSeam débrayées). */
  private zipperOpen = false;
  /** Débrayage automatique après montage quand le doc porte un zip ouvert. */
  private zipperAutoOpenSeconds = Infinity;
  private simulatedSeconds = 0;
  private readonly constraintBuffer: GPUBuffer;
  private readonly quadBuffer: GPUBuffer | null;
  private readonly initialQuadData: ArrayBuffer;
  private readonly colliderBuffer: GPUBuffer;
  private readonly uniformBuffer: GPUBuffer;
  private readonly selfParamsBuffer: GPUBuffer;
  private readonly headsBuffer: GPUBuffer;
  private readonly nextsBuffer: GPUBuffer;
  private readonly batchBuffers: GPUBuffer[];
  private readonly uniformData: ArrayBuffer;

  private readonly integratePipeline: GPUComputePipeline;
  private readonly solvePipeline: GPUComputePipeline;
  private readonly dragPipeline: GPUComputePipeline;
  private readonly collidePipeline: GPUComputePipeline;
  private readonly velocityPipeline: GPUComputePipeline;
  private readonly hashClearPipeline: GPUComputePipeline;
  private readonly hashInsertPipeline: GPUComputePipeline;
  private readonly selfCollidePipeline: GPUComputePipeline;
  private readonly surfaceContactPipeline: GPUComputePipeline;
  private readonly surfaceReactionPipeline: GPUComputePipeline;

  private readonly integrateBindGroup: GPUBindGroup;
  private readonly dragBindGroup: GPUBindGroup;
  private readonly collideBindGroup: GPUBindGroup;
  private readonly velocityBindGroup: GPUBindGroup;
  private readonly solveBindGroups: GPUBindGroup[];
  private readonly hashClearBindGroup: GPUBindGroup;
  private readonly hashInsertBindGroup: GPUBindGroup;
  private readonly selfCollideBindGroup: GPUBindGroup;
  private readonly surfaceContactBindGroup: GPUBindGroup;
  private readonly surfaceReactionBindGroup: GPUBindGroup;
  private readonly dihedralPipeline: GPUComputePipeline;
  private readonly dihedralBindGroups: GPUBindGroup[];
  private readonly quadColorCounts: number[];

  private readonly tableSize: number;
  private readonly spacing: number;
  private readonly gridN: number;
  private selfEnabled: boolean;

  private readonly colorCounts: number[];
  private readonly regularSeamColorFirst: number;
  private readonly regularSeamColorCount: number;

  private readonly initialPositions: Float32Array<ArrayBuffer>;
  private readonly baseInvMasses: Float32Array<ArrayBuffer>;
  private readonly materialIds: Uint32Array<ArrayBuffer>;
  private readonly materials: FabricPhysics[];
  private readonly globalMaterialVariantIds: number[];
  private readonly cornerIndices: [number, number];
  private pinned = false;
  private readbackBusy = false;
  private collisionAuditPromise: Promise<CollisionDistanceSnapshot | null> | null = null;
  private collisionAuditDisabled = false;
  private readonly pendingReadbacks = new Set<Promise<void>>();
  private retired = false;
  private disposed = false;
  private pickingDisabled = false;
  private prepareDisposePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  private readonly gravity: number;
  private readonly groundY: number;
  private readonly colliderCount: number;
  private readonly colliderBlend: number;
  private readonly useGrid: boolean;
  private readonly extraPins = new Set<number>();
  private spinAngle = 0;
  private spinRate = 0; // rad/s

  private readonly sdfTexture: GPUTexture;
  private readonly bodyMin = [Infinity, Infinity, Infinity];
  private readonly bodyMax = [-Infinity, -Infinity, -Infinity];
  private clothThickness: number;
  private readonly mouseStrength: number;
  private readonly mouseRadius: number;
  private damping: number;
  private airDrag: number;
  private creaseYield: number;
  private creaseMemory: number;
  private creaseRecovery: number;
  private readonly maxSpeed: number;
  private readonly dragStiffness: number;

  // Live-tunable parameters.
  private friction: number;
  private frictionDynamic: number;
  private arealDensity: number;
  private complianceStretch: number;
  private complianceStretchWarp: number;
  private complianceShear: number;
  private complianceBend: number;
  private complianceBendWarp: number;
  private stretchLimit: number;
  private shearLimit: number;
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
    this.regularSeamColorFirst = mesh.constraintColorPhases.seam.first;
    this.regularSeamColorCount = mesh.constraintColorPhases.seam.count;
    this.initialPositions = new Float32Array(mesh.positions);
    this.baseInvMasses = new Float32Array(mesh.invMasses);
    this.cornerIndices = mesh.cornerIndices;

    this.gravity = opts.gravity ?? -9.81;
    this.groundY = opts.groundY ?? 0.0;
    const colliders = opts.colliders ?? [{ a: [0, 0.8, 0] as [number, number, number], radius: 0.55 }];
    this.colliderCount = colliders.length;
    this.friction = opts.frictionStatic ?? opts.friction ?? 0.5;
    this.frictionDynamic = opts.frictionDynamic ?? opts.friction ?? this.friction * 0.75;
    this.arealDensity = opts.arealDensity ?? 0.2;
    this.clothThickness = opts.clothThickness ?? 0.01;
    this.complianceStretch = opts.complianceStretch ?? 0.0;
    this.complianceStretchWarp = opts.complianceStretchWarp ?? opts.complianceStretch ?? 0.0;
    this.complianceShear = opts.complianceShear ?? 0.0;
    this.complianceBend = opts.complianceBend ?? 2.0e-6;
    this.complianceBendWarp = opts.complianceBendWarp ?? opts.complianceBend ?? 2.0e-6;
    this.stretchLimit = opts.stretchLimit ?? 0.2;
    this.shearLimit = opts.shearLimit ?? 0.3;
    this.mouseStrength = opts.mouseStrength ?? 45.0;
    this.mouseRadius = opts.mouseRadius ?? 1.5;
    this.damping = opts.damping ?? 0.5; // less velocity bleed → more flutter/liveliness (audit)
    this.airDrag = opts.airDrag ?? 1.0;
    this.creaseYield = ((opts.creaseYieldDeg ?? 45) * Math.PI) / 180;
    this.creaseMemory = opts.creaseMemory ?? 0.2;
    this.creaseRecovery = opts.creaseRecovery ?? 0.3;
    this.maxSpeed = opts.maxSpeed ?? 12.0;
    this.dragStiffness = opts.dragStiffness ?? 0.4;
    this.selfEnabled = opts.selfCollision ?? true;
    const globalMaterial: FabricPhysics = {
      stretch: this.complianceStretch,
      stretchWarp: this.complianceStretchWarp,
      shear: this.complianceShear,
      bend: this.complianceBend,
      bendWarp: this.complianceBendWarp,
      stretchLimit: this.stretchLimit,
      shearLimit: this.shearLimit,
      arealDensity: this.arealDensity,
      collisionThickness: this.clothThickness,
      damping: this.damping,
      airDrag: this.airDrag,
      frictionStatic: this.friction,
      frictionDynamic: this.frictionDynamic,
      creaseYieldDeg: (this.creaseYield * 180) / Math.PI,
      creaseMemory: this.creaseMemory,
      creaseRecovery: this.creaseRecovery,
    };
    this.materials = (opts.materials?.length ? opts.materials : fabricMaterialTable(globalMaterial)).map((m) => ({ ...m }));
    this.materials[0] = globalMaterial;
    this.globalMaterialVariantIds = [
      ...new Set(
        (opts.globalMaterialVariantIds ?? [])
          .map((id) => Math.round(id))
          .filter((id) => id > 0 && id < this.materials.length),
      ),
    ];
    this.materialIds = new Uint32Array(this.count);
    if (mesh.materialIds) {
      for (let i = 0; i < this.count; i++) {
        this.materialIds[i] = Math.min(this.materials.length - 1, mesh.materialIds[i] ?? 0);
      }
    }
    // Mesh-wide spacing for the CFL cap and dihedral scale: the coarser of the
    // two garments in a combined outfit (spacing is now per-garment for prints).
    // Matches the old combined value (max of the two horizontal spacings).
    this.spacing = Math.max(mesh.spacing, mesh.spacing2 ?? mesh.spacing);
    this.gridN = mesh.resolution;
    this.tableSize = 1 << Math.ceil(Math.log2(Math.max(1024, this.count * 2)));

    // Every allocation from here on is registered. If WebGPU rejects a later
    // buffer/bind-group/pipeline creation, retain the registry in this cleanup
    // closure until earlier queue writes are done instead of leaking a
    // half-constructed ParticleSystem that the caller can never dispose.
    try {
    // --- Buffers ---
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.positionBuffer = this.createBuffer(
      mesh.positions,
      storage | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
    );
    this.prevPositionBuffer = this.createBuffer(mesh.positions, storage);
    this.velocityBuffer = this.createBuffer(new Float32Array(this.count * 4), storage);
    this.invMassBuffer = this.createBuffer(this.materialMasses(), storage);
    this.materialIdBuffer = this.createBufferRaw(this.materialIds.buffer, storage);
    this.materialBuffer = this.createBuffer(packFabricMaterialTable(this.materials), storage);
    // Garment layer per particle: collide pushes layer L to thickness + L·gap,
    // so a dress worn over a tee rests ON the tee instead of inside it.
    this.layerBuffer = this.createBuffer(mesh.layers ?? new Float32Array(this.count), storage);
    this.maxLayer = mesh.layers ? mesh.layers.reduce((m, v) => Math.max(m, v), 0) : 0;
    // Cross-seam ring: these particles are held at seam distance on purpose —
    // self-collision must not repel them (u32 per particle for the shader).
    const seamFree = new Uint32Array(this.count);
    if (mesh.seamFree) for (let i = 0; i < this.count; i++) seamFree[i] = mesh.seamFree[i]!;
    this.seamFreeBuffer = this.createBufferRaw(seamFree.buffer, storage);
    // Seam-distance (M3): hops from the nearest seam, clamped to 3. Absent (a
    // single-sheet grid) → all 3 = "far", so the cross-panel exclusion never
    // fires for it, which is correct (a plain sheet has no front/back panels).
    const seamDist = new Uint32Array(this.count).fill(3);
    if (mesh.seamDist) for (let i = 0; i < this.count; i++) seamDist[i] = mesh.seamDist[i]!;
    this.seamDistBuffer = this.createBufferRaw(seamDist.buffer, storage);
    const surfaceMasks = new Uint32Array(this.count);
    if (mesh.surfaceMasks) surfaceMasks.set(mesh.surfaceMasks);
    this.surfaceMaskBuffer = this.createBufferRaw(surfaceMasks.buffer, storage);
    const rawSurfaceContacts = mesh.surfaceContactData;
    this.surfaceContactCount = Math.min(
      mesh.surfaceContactCount ?? 0,
      Math.floor((rawSurfaceContacts?.byteLength ?? 0) / 32),
    );
    const packedSurfaceContacts = new ArrayBuffer(
      Math.max(32, rawSurfaceContacts?.byteLength ?? 0),
    );
    if (rawSurfaceContacts) {
      new Uint8Array(packedSurfaceContacts).set(new Uint8Array(rawSurfaceContacts));
    }
    this.surfaceContactBuffer = this.createBufferRaw(packedSurfaceContacts, storage);
    // Four fixed-point i32 atomics per particle. xyz accumulates the
    // equal-and-opposite support reaction; w is alignment/padding.
    this.surfaceReactionBuffer = this.createBufferRaw(
      new Int32Array(this.count * 4).buffer,
      storage,
    );
    if (import.meta.env.DEV && this.surfaceContactCount > 0) {
      const initialContactStats = measureSurfaceContacts(
        mesh.positions,
        rawSurfaceContacts,
        this.surfaceContactCount,
      );
      if (initialContactStats.activeCount > 0) {
        console.info(
          `TOILE surface-contact initial ${JSON.stringify(initialContactStats)}`,
        );
      }
    }
    this.surfaceParamsBuffer = this.resources.trackBuffer(device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    const surfaceParams = new ArrayBuffer(32);
    const surfaceParamsView = new DataView(surfaceParams);
    surfaceParamsView.setUint32(0, this.surfaceContactCount, true);
    surfaceParamsView.setFloat32(4, 0.0002, true); // 0.2 mm chatter slop
    // v199 — barrière des couches ÉPAISSIE : à 1,5 mm de pas et 3 mm de
    // plafond, le sandwich doublure/tissu comprimé par le corps (veste) ou
    // pincé par le matelassage (doudoune) perçait par intermittence. Le
    // plafond monte au ras de la clearance de pose (4 mm), le pas suit.
    surfaceParamsView.setFloat32(8, 0.002, true); // bounded projection/substep
    surfaceParamsView.setFloat32(12, 0.0038, true); // just below authored 4 mm clearance
    surfaceParamsView.setUint32(16, this.count, true);
    device.queue.writeBuffer(this.surfaceParamsBuffer, 0, surfaceParams);
    // Waistband anchor: target world-Y per particle (sentinel = free).
    this.anchorBuffer = this.createBuffer(mesh.anchorY ?? new Float32Array(this.count).fill(-1e9), storage);
    this.anchorReleaseSeconds = mesh.anchorReleaseSeconds ?? Infinity;
    this.seamDressingSeconds = Math.max(0, mesh.seamDressingSeconds ?? 0);
    // v198 — un document au zip OUVERT s'habille quand même FERMÉ (stable),
    // puis la fermeture se débraye une fois le montage posé (~3 s simulées).
    this.zipperAutoOpenSeconds = mesh.zipperInitiallyOpen ? 3 : Infinity;
    this.constraintBuffer = this.createBufferRaw(mesh.constraintData, storage);
    this.quadColorCounts = mesh.quadColorCounts;
    this.initialQuadData = mesh.quadData.slice(0);
    this.quadBuffer = mesh.quadCount > 0 ? this.createBufferRaw(this.initialQuadData, storage) : null;
    // Round-cone packing: {a.xyz, ra, b.xyz, rb, s.xyz, bound} — 48 B/collider.
    // At least one (zeroed) slot: a zero-sized binding is invalid even when
    // collider_count is 0 (SDF-grid mode).
    const colliderData = new Float32Array(Math.max(1, this.colliderCount) * 12);
    colliders.forEach((c, k) => {
      const b = c.b ?? c.a; // sphere: degenerate cone
      const r2 = c.radius2 ?? c.radius;
      const s = c.scale ?? [1, 1, 1];
      const half = Math.hypot(b[0] - c.a[0], b[1] - c.a[1], b[2] - c.a[2]) / 2;
      // Reject sphere / AABB stay conservative for ANY squash (audit M18): the
      // world shape is scaled by 1/s inside the SDF, so an s>1 axis GROWS it.
      // sMax = max(1, s) over-covers (the safe direction); a no-op for current
      // bodies (every s ∈ (0,1] → sMax = 1) but removes a silent-tunnel trap.
      const sMax = Math.max(1, s[0]!, s[1]!, s[2]!);
      const bound = (half + Math.max(c.radius, r2)) * sMax; // world sphere about the midpoint
      colliderData.set([...c.a, c.radius, ...b, r2, ...s, bound], k * 12);
    });
    this.colliderBuffer = this.createBuffer(colliderData, storage);
    // Collider AABB (early out in the collide pass) + smooth-min blend.
    this.colliderBlend = opts.colliderBlend ?? 0;
    const pad = this.colliderBlend + 0.05;
    for (const c of colliders) {
      const b = c.b ?? c.a;
      const r = Math.max(c.radius, c.radius2 ?? c.radius);
      const sc = c.scale ?? [1, 1, 1];
      for (let i = 0; i < 3; i++) {
        const ri = r * Math.max(1, sc[i]!); // per-axis: squash is axis-aligned
        this.bodyMin[i] = Math.min(this.bodyMin[i]!, Math.min(c.a[i]!, b[i]!) - ri - pad);
        this.bodyMax[i] = Math.max(this.bodyMax[i]!, Math.max(c.a[i]!, b[i]!) + ri + pad);
      }
    }
    // Baked SDF grid (scanned avatar): its exact bbox IS the sampling domain.
    const grid = opts.sdfGrid;
    this.useGrid = !!grid;
    if (grid) {
      for (let i = 0; i < 3; i++) {
        this.bodyMin[i] = grid.min[i]!;
        this.bodyMax[i] = grid.max[i]!;
      }
    }
    this.sdfTexture = this.resources.trackTexture(device.createTexture({
      size: grid ? { width: grid.dims[0], height: grid.dims[1], depthOrArrayLayers: grid.dims[2] } : { width: 1, height: 1, depthOrArrayLayers: 1 },
      dimension: '3d',
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }));
    if (grid) {
      device.queue.writeTexture(
        { texture: this.sdfTexture },
        grid.data as unknown as BufferSource,
        { bytesPerRow: grid.dims[0] * 4, rowsPerImage: grid.dims[1] },
        { width: grid.dims[0], height: grid.dims[1], depthOrArrayLayers: grid.dims[2] },
      );
    }

    // Self-collision spatial hash: cell heads + per-particle next links.
    this.headsBuffer = this.resources.trackBuffer(device.createBuffer({
      size: this.tableSize * 4,
      usage: GPUBufferUsage.STORAGE,
    }));
    this.nextsBuffer = this.resources.trackBuffer(device.createBuffer({
      size: this.count * 4,
      usage: GPUBufferUsage.STORAGE,
    }));
    this.selfParamsBuffer = this.resources.trackBuffer(device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    this.writeSelfParams();

    this.uniformData = new ArrayBuffer(UNIFORM_SIZE);
    this.uniformBuffer = this.resources.trackBuffer(device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));

    this.batchBuffers = mesh.colorOffsets.map((offset, c) => {
      const buf = this.resources.trackBuffer(device.createBuffer({
        size: BATCH_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
      device.queue.writeBuffer(buf, 0, new Uint32Array([offset, mesh.colorCounts[c]!, 0, 0]));
      return buf;
    });

    // --- Pipelines (compiled once per device, then reused across rebuilds) ---
    const pipes = solverPipelines(device);
    this.integratePipeline = pipes.integrate;
    this.solvePipeline = pipes.distance;
    this.dragPipeline = pipes.drag;
    this.collidePipeline = pipes.collide;
    this.velocityPipeline = pipes.velocity;
    this.hashClearPipeline = pipes.hashClear;
    this.hashInsertPipeline = pipes.hashInsert;
    this.selfCollidePipeline = pipes.selfCollide;
    this.surfaceContactPipeline = pipes.surfaceContact;
    this.surfaceReactionPipeline = pipes.surfaceReaction;

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
      this.materialIdBuffer,
      this.materialBuffer,
    ]);
    this.dragBindGroup = bg(this.dragPipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.invMassBuffer,
    ]);
    // The collide pass also binds the SDF texture (dummy 1³ when unused).
    this.collideBindGroup = device.createBindGroup({
      layout: this.collidePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.invMassBuffer } },
        { binding: 4, resource: { buffer: this.colliderBuffer } },
        { binding: 5, resource: this.sdfTexture.createView() },
        { binding: 6, resource: { buffer: this.layerBuffer } },
        { binding: 7, resource: { buffer: this.anchorBuffer } },
        { binding: 8, resource: { buffer: this.materialIdBuffer } },
        { binding: 9, resource: { buffer: this.materialBuffer } },
      ],
    });
    this.velocityBindGroup = bg(this.velocityPipeline, [
      this.uniformBuffer,
      this.positionBuffer,
      this.prevPositionBuffer,
      this.velocityBuffer,
      this.invMassBuffer,
      this.materialIdBuffer,
      this.materialBuffer,
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
          { binding: 5, resource: { buffer: this.materialIdBuffer } },
          { binding: 6, resource: { buffer: this.materialBuffer } },
        ],
      }),
    );

    // Dihedral bending hinges: one dispatch per hinge color, like distance.
    this.dihedralPipeline = pipes.dihedral;
    this.dihedralBindGroups =
      this.quadBuffer === null
        ? []
        : mesh.quadColorOffsets.map((offset, c) => {
            const buf = this.resources.trackBuffer(device.createBuffer({
              size: BATCH_SIZE,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }));
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
                { binding: 5, resource: { buffer: this.materialIdBuffer } },
                { binding: 6, resource: { buffer: this.materialBuffer } },
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
      entries: [
        ...selfAll,
        { binding: 5, resource: { buffer: this.seamFreeBuffer } },
        { binding: 6, resource: { buffer: this.seamDistBuffer } },
        { binding: 7, resource: { buffer: this.surfaceMaskBuffer } },
      ],
    });
    this.surfaceContactBindGroup = device.createBindGroup({
      layout: this.surfaceContactPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.surfaceParamsBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.invMassBuffer } },
        { binding: 4, resource: { buffer: this.surfaceContactBuffer } },
        { binding: 5, resource: { buffer: this.materialIdBuffer } },
        { binding: 6, resource: { buffer: this.materialBuffer } },
        { binding: 7, resource: { buffer: this.surfaceReactionBuffer } },
      ],
    });
    this.surfaceReactionBindGroup = device.createBindGroup({
      layout: this.surfaceReactionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.surfaceParamsBuffer } },
        { binding: 1, resource: { buffer: this.positionBuffer } },
        { binding: 2, resource: { buffer: this.prevPositionBuffer } },
        { binding: 3, resource: { buffer: this.surfaceReactionBuffer } },
      ],
    });
    } catch (error) {
      this.retired = true;
      const disposePartial = (): void => {
        if (this.disposed) return;
        this.disposed = true;
        this.resources.dispose();
      };
      try {
        void device.queue.onSubmittedWorkDone().then(disposePartial, disposePartial);
      } catch {
        disposePartial();
      }
      throw error;
    }
  }

  get colorCount(): number {
    return this.colorCounts.length;
  }
  get pinsHeld(): boolean {
    return this.pinned;
  }
  /**
   * Can this particle be grabbed and dragged? False for the three immovable
   * kinds: pattern-cut particles (baseInvMass 0, parked off-scene), double-click
   * tacks (extraPins) and the held corner pins. Used so a press on an immovable
   * particle falls through to camera orbit instead of a dead click (audit M37).
   */
  isMovable(index: number): boolean {
    if (!this.gpuActive) return false;
    if (index < 0 || index >= this.count) return false;
    if (this.baseInvMasses[index] === 0) return false; // pattern-cut particle
    if (this.extraPins.has(index)) return false; // double-click tack
    if (this.pinned && (index === this.cornerIndices[0] || index === this.cornerIndices[1])) return false;
    return true;
  }
  get isDragging(): boolean {
    return this.dragIndex !== DRAG_NONE;
  }
  get lifecycleState(): 'active' | 'retired' | 'disposed' {
    return this.disposed ? 'disposed' : this.retired ? 'retired' : 'active';
  }
  /** False as soon as this scene generation stops accepting GPU work. */
  get pickingEnabled(): boolean {
    return !this.retired && !this.disposed && !this.pickingDisabled;
  }
  /** DEV/stress accounting: every owned buffer/texture, including pick staging. */
  get ownedResourceCount(): number {
    return this.resources.count;
  }

  private get gpuActive(): boolean {
    return !this.retired && !this.disposed;
  }

  setMouse(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
    mode: number,
  ): void {
    if (!this.gpuActive) return;
    this.mouseOrigin = [origin[0], origin[1], origin[2]];
    this.mouseDir = [dir[0], dir[1], dir[2]];
    this.mouseForce = mode * this.mouseStrength;
  }

  /** Set/clear the drag constraint. index === null releases the grab. */
  setDrag(index: number | null, target: readonly [number, number, number]): void {
    if (!this.gpuActive) return;
    this.dragIndex = index ?? DRAG_NONE;
    this.dragTarget = [target[0], target[1], target[2]];
  }

  private materialMasses(): Float32Array<ArrayBuffer> {
    const masses = scaleInverseMassesByMaterial(this.baseInvMasses, this.materialIds, this.materials);
    for (const index of this.extraPins) masses[index] = 0;
    if (this.pinned) {
      masses[this.cornerIndices[0]] = 0;
      masses[this.cornerIndices[1]] = 0;
    }
    return masses;
  }

  private writeMaterialMasses(): void {
    if (!this.gpuActive) return;
    this.device.queue.writeBuffer(this.invMassBuffer, 0, this.materialMasses());
  }

  private writeMaterialTable(): void {
    if (!this.gpuActive) return;
    this.device.queue.writeBuffer(
      this.materialBuffer,
      0,
      packFabricMaterialTable(this.materials) as unknown as BufferSource,
    );
  }

  private patchGlobalMaterialVariants(patch: Partial<FabricPhysics>): void {
    for (const id of this.globalMaterialVariantIds) {
      this.materials[id] = { ...this.materials[id]!, ...patch };
    }
  }

  setFriction(staticMu: number, dynamicMu = staticMu * 0.75): void {
    this.friction = Math.max(0, Math.min(1, staticMu));
    this.frictionDynamic = Math.max(0, Math.min(this.friction, dynamicMu));
    this.materials[0] = {
      ...this.materials[0]!,
      frictionStatic: this.friction,
      frictionDynamic: this.frictionDynamic,
    };
    this.patchGlobalMaterialVariants({
      frictionStatic: this.friction,
      frictionDynamic: this.frictionDynamic,
    });
    this.writeMaterialTable();
  }

  /** Apply mass/contact/motion properties live without rebuilding the mesh. */
  setDynamics(dynamics: FabricDynamics): void {
    this.arealDensity = clampFabricGsm(dynamics.arealDensity * 1000) / 1000;
    this.clothThickness = Math.max(0.002, Math.min(0.02, dynamics.collisionThickness));
    this.damping = Math.max(0, Math.min(4, dynamics.damping));
    this.airDrag = Math.max(0.05, Math.min(3, dynamics.airDrag));
    this.creaseYield = (Math.max(1, Math.min(89, dynamics.creaseYieldDeg)) * Math.PI) / 180;
    this.creaseMemory = Math.max(0, Math.min(4, dynamics.creaseMemory));
    this.creaseRecovery = Math.max(0, Math.min(4, dynamics.creaseRecovery));
    this.setFriction(dynamics.frictionStatic, dynamics.frictionDynamic);
    this.materials[0] = {
      ...this.materials[0]!,
      arealDensity: this.arealDensity,
      collisionThickness: this.clothThickness,
      damping: this.damping,
      airDrag: this.airDrag,
      creaseYieldDeg: (this.creaseYield * 180) / Math.PI,
      creaseMemory: this.creaseMemory,
      creaseRecovery: this.creaseRecovery,
    };
    // These variants override only mass. Every other property must continue
    // following the live global material without losing its custom density.
    this.patchGlobalMaterialVariants({
      collisionThickness: this.clothThickness,
      damping: this.damping,
      airDrag: this.airDrag,
      creaseYieldDeg: (this.creaseYield * 180) / Math.PI,
      creaseMemory: this.creaseMemory,
      creaseRecovery: this.creaseRecovery,
    });
    this.writeMaterialTable();
    this.writeMaterialMasses();
  }

  /** Set the wind strength (m/s², 0 = calm) live. */
  /** Live collider update (articulated pose). Same count as construction. */
  setColliders(colliders: Collider[]): void {
    if (!this.gpuActive) return;
    const data = new Float32Array(Math.max(1, colliders.length) * 12);
    const pad = this.colliderBlend + 0.05;
    for (let i = 0; i < 3; i++) {
      this.bodyMin[i] = Infinity;
      this.bodyMax[i] = -Infinity;
    }
    colliders.forEach((c, k) => {
      const b = c.b ?? c.a;
      const r2 = c.radius2 ?? c.radius;
      const s = c.scale ?? [1, 1, 1];
      const half = Math.hypot(b[0] - c.a[0], b[1] - c.a[1], b[2] - c.a[2]) / 2;
      const r = Math.max(c.radius, r2);
      const sMax = Math.max(1, s[0]!, s[1]!, s[2]!); // conservative for any squash (M18)
      data.set([...c.a, c.radius, ...b, r2, ...s, (half + r) * sMax], k * 12);
      for (let i = 0; i < 3; i++) {
        const ri = r * Math.max(1, s[i]!);
        this.bodyMin[i] = Math.min(this.bodyMin[i]!, Math.min(c.a[i]!, b[i]!) - ri - pad);
        this.bodyMax[i] = Math.max(this.bodyMax[i]!, Math.max(c.a[i]!, b[i]!) + ri + pad);
      }
    });
    this.device.queue.writeBuffer(this.colliderBuffer, 0, data);
  }

  /** Pin/unpin one particle in place (double-click tack). */
  togglePin(index: number): boolean {
    if (!this.gpuActive) return false;
    if (index < 0 || index >= this.count) return false;
    const pinned = this.extraPins.has(index);
    if (pinned) this.extraPins.delete(index);
    else this.extraPins.add(index);
    this.writeMaterialMasses();
    return !pinned;
  }

  /** Podium turn: current angle + angular speed (drives surface friction). */
  setSpin(angle: number, rate: number): void {
    this.spinAngle = angle;
    this.spinRate = rate;
  }

  setWind(strength: number): void {
    this.windStrength = strength;
  }

  /**
   * v198 — ouvrir/fermer la fermeture éclair À CHAUD : bascule l'uniform que
   * le pass distance consulte pour les coutures ZipperSeam. Aucun rebuild,
   * l'état porté est préservé ; refermer re-tend les mêmes épingles. Annule
   * aussi tout débrayage automatique programmé (le geste manuel décide).
   */
  setZipperOpen(open: boolean): void {
    this.zipperOpen = open;
    this.zipperAutoOpenSeconds = Infinity;
  }

  /** Toggle cloth self-collision live. */
  setSelfCollision(enabled: boolean): void {
    this.selfEnabled = enabled;
    this.writeSelfParams();
  }

  private writeSelfParams(): void {
    if (!this.gpuActive) return;
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
  setCompliance(c: Partial<FabricCompliance>): void {
    if (c.stretchWarp !== undefined) this.complianceStretchWarp = c.stretchWarp;
    else if (c.stretch !== undefined) this.complianceStretchWarp = c.stretch;
    if (c.stretch !== undefined) this.complianceStretch = c.stretch;
    if (c.shear !== undefined) this.complianceShear = c.shear;
    if (c.bend !== undefined) this.complianceBend = c.bend;
    if (c.bendWarp !== undefined) this.complianceBendWarp = c.bendWarp;
    else if (c.bend !== undefined) this.complianceBendWarp = c.bend;
    if (c.stretchLimit !== undefined) this.stretchLimit = Math.max(0.01, Math.min(0.7, c.stretchLimit));
    if (c.shearLimit !== undefined) this.shearLimit = Math.max(0.03, Math.min(0.7, c.shearLimit));
    this.materials[0] = {
      ...this.materials[0]!,
      stretch: this.complianceStretch,
      stretchWarp: this.complianceStretchWarp,
      shear: this.complianceShear,
      bend: this.complianceBend,
      bendWarp: this.complianceBendWarp,
      stretchLimit: this.stretchLimit,
      shearLimit: this.shearLimit,
    };
    this.patchGlobalMaterialVariants({
      stretch: this.complianceStretch,
      stretchWarp: this.complianceStretchWarp,
      shear: this.complianceShear,
      bend: this.complianceBend,
      bendWarp: this.complianceBendWarp,
      stretchLimit: this.stretchLimit,
      shearLimit: this.shearLimit,
    });
    this.writeMaterialTable();
  }

  /**
   * ATELIER — déplacer une PIÈCE gelée (mode conception) : translate rigidement
   * une plage de particules depuis ses positions de REPOS (pas d'accumulation
   * d'erreur pendant le drag). Écrit position ET prevPosition, comme reset() —
   * aucune vitesse fantôme si la simulation se réveille ensuite.
   */
  translateRange(first: number, count: number, d: readonly [number, number, number]): void {
    if (!this.gpuActive) return;
    const n = Math.max(0, Math.min(count, this.count - first));
    if (n === 0) return;
    const src = this.initialPositions.subarray(first * 4, (first + n) * 4);
    const out = new Float32Array(src.length);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = src[i]! + d[0];
      out[i + 1] = src[i + 1]! + d[1];
      out[i + 2] = src[i + 2]! + d[2];
      out[i + 3] = src[i + 3]!;
    }
    this.device.queue.writeBuffer(this.positionBuffer, first * 16, out);
    this.device.queue.writeBuffer(this.prevPositionBuffer, first * 16, out);
  }

  /** Re-drop the cloth: restore the rest pose, zero velocities, release pins. */
  reset(): void {
    if (!this.gpuActive) return;
    this.pinned = false;
    this.extraPins.clear();
    this.dragIndex = DRAG_NONE;
    this.simulatedSeconds = 0;
    this.device.queue.writeBuffer(this.positionBuffer, 0, this.initialPositions);
    this.device.queue.writeBuffer(this.prevPositionBuffer, 0, this.initialPositions);
    this.device.queue.writeBuffer(this.velocityBuffer, 0, new Float32Array(this.count * 4));
    if (this.quadBuffer) this.device.queue.writeBuffer(this.quadBuffer, 0, this.initialQuadData);
    this.writeMaterialMasses();
  }

  /** Pin/release the two anchor corners at runtime (brief §3.3 "release" toggle). */
  setCornerPins(pinned: boolean): void {
    if (!this.gpuActive) return;
    this.pinned = pinned;
    this.writeMaterialMasses();
  }

  /**
   * Read the current positions back to the CPU (for cursor picking). Returns
   * null if a read is already in flight or this scene has been retired.
   * One-shot copy, not per-frame. Validation is deliberately captured here:
   * a bad pick must disable picking, not escalate to the application's fatal
   * `uncapturederror` handler.
   */
  async readPositions(): Promise<Float32Array | null> {
    if (!this.pickingEnabled || this.readbackBusy) return null;
    this.readbackBusy = true;
    let finishReadback!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishReadback = resolve;
    });
    this.pendingReadbacks.add(pending);
    // Disposable staging buffer per read: a shared one gets permanently
    // poisoned when one mapAsync fails mid-flight (e.g. across a rebuild) —
    // every later map on it rejects and the pick cache silently dies.
    let staging: GPUBuffer | null = null;
    let validationScopeOpen = false;
    try {
      staging = this.resources.trackBuffer(
        this.device.createBuffer({
          label: 'pick-readback',
          size: this.count * 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
      // No await is allowed between the retirement guard above and submit. A
      // transition can therefore either retire us before this block, or wait
      // for the tracked readback below; it cannot interleave halfway through.
      this.device.pushErrorScope('validation');
      validationScopeOpen = true;
      const encoder = this.device.createCommandEncoder({ label: 'pick-readback' });
      encoder.copyBufferToBuffer(this.positionBuffer, 0, staging, 0, this.count * 16);
      this.device.queue.submit([encoder.finish()]);
      const validationResult = this.device.popErrorScope();
      validationScopeOpen = false;
      const validationError = await withGpuTimeout(
        validationResult,
        GPU_READBACK_TIMEOUT_MS,
        'validation du readback de positions',
      );
      if (validationError) {
        this.disablePicking(validationError);
        return null;
      }
      await withGpuTimeout(
        staging.mapAsync(GPUMapMode.READ),
        GPU_READBACK_TIMEOUT_MS,
        'lecture GPU des positions',
      );
      const copy = new Float32Array(staging.getMappedRange().slice(0));
      // The copy was allowed to finish so teardown can safely destroy it, but a
      // retired generation must never publish stale positions to the new scene.
      return this.pickingEnabled ? copy : null;
    } catch (error) {
      let scopedError: GPUError | null = null;
      if (validationScopeOpen) {
        try {
          scopedError = await withGpuTimeout(
            this.device.popErrorScope(),
            GPU_READBACK_TIMEOUT_MS,
            'fermeture de la validation du readback de positions',
          );
        } catch {
          // Device loss is reported by device.lost; picking still fails closed.
        }
      }
      this.disablePicking(scopedError ?? error);
      return null;
    } finally {
      this.resources.release(staging);
      this.readbackBusy = false;
      this.pendingReadbacks.delete(pending);
      finishReadback();
    }
  }

  /**
   * DEV-only, one-shot collision snapshot. The compute pass binds the current
   * position/collider/material buffers and SDF texture, evaluates the same
   * `body_distance(to_body(position))` as collide.wgsl, then copies one packed
   * 32-byte sample per particle to a temporary mapped buffer. It is deliberately
   * absent from step(): there is no dispatch, allocation or readback unless QA
   * explicitly calls this method.
   */
  async readCollisionDistances(): Promise<CollisionDistanceSnapshot | null> {
    if (!import.meta.env.DEV || !this.gpuActive || this.collisionAuditDisabled) return null;
    if (this.collisionAuditPromise) return this.collisionAuditPromise;

    const operation = this.performCollisionAudit();
    this.collisionAuditPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.collisionAuditPromise === operation) this.collisionAuditPromise = null;
    }
  }

  private async performCollisionAudit(): Promise<CollisionDistanceSnapshot | null> {
    let finishReadback!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishReadback = resolve;
    });
    this.pendingReadbacks.add(pending);

    const floatsPerSample = 8; // AuditSample = two vec4f = 32 bytes.
    const byteSize = this.count * floatsPerSample * Float32Array.BYTES_PER_ELEMENT;
    let output: GPUBuffer | null = null;
    let staging: GPUBuffer | null = null;
    let stagingMapped = false;
    let validationScopeOpen = false;
    try {
      // Keep spin/body bounds/layer gap coherent even when the cloth is asleep.
      // This only queues one uniform write when an audit was explicitly asked.
      this.writeUniforms(0);
      this.device.pushErrorScope('validation');
      validationScopeOpen = true;

      const pipeline = collisionAuditPipeline(this.device);
      output = this.resources.trackBuffer(
        this.device.createBuffer({
          label: 'collision-audit-output',
          size: byteSize,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
      );
      staging = this.resources.trackBuffer(
        this.device.createBuffer({
          label: 'collision-audit-readback',
          size: byteSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
      );
      const bindGroup = this.device.createBindGroup({
        label: 'collision-audit',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: { buffer: this.positionBuffer } },
          { binding: 2, resource: { buffer: this.colliderBuffer } },
          { binding: 3, resource: this.sdfTexture.createView() },
          { binding: 4, resource: { buffer: this.layerBuffer } },
          { binding: 5, resource: { buffer: this.materialIdBuffer } },
          { binding: 6, resource: { buffer: this.materialBuffer } },
          { binding: 7, resource: { buffer: this.invMassBuffer } },
          { binding: 8, resource: { buffer: output } },
        ],
      });
      const encoder = this.device.createCommandEncoder({ label: 'collision-audit' });
      const pass = encoder.beginComputePass({ label: 'collision-audit' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.count / WORKGROUP));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, byteSize);
      this.device.queue.submit([encoder.finish()]);

      const validationResult = this.device.popErrorScope();
      validationScopeOpen = false;
      const validationError = await withGpuTimeout(
        validationResult,
        GPU_READBACK_TIMEOUT_MS,
        'validation de l’audit collision',
      );
      if (validationError) {
        this.disableCollisionAudit(validationError);
        return null;
      }

      await withGpuTimeout(
        staging.mapAsync(GPUMapMode.READ),
        GPU_READBACK_TIMEOUT_MS,
        'lecture GPU de l’audit collision',
      );
      stagingMapped = true;
      const packed = new Float32Array(staging.getMappedRange().slice(0));
      if (!this.gpuActive) return null;

      const positions = new Float32Array(this.count * 3);
      const distances = new Float32Array(this.count);
      const contactOffsets = new Float32Array(this.count);
      for (let i = 0; i < this.count; i++) {
        const source = i * floatsPerSample;
        const target = i * 3;
        positions[target] = packed[source]!;
        positions[target + 1] = packed[source + 1]!;
        positions[target + 2] = packed[source + 2]!;
        if (packed[source + 5]! <= 0) {
          distances[i] = Number.NaN; // cut, held pin or other collision-inactive particle
          contactOffsets[i] = Number.NaN;
          continue;
        }
        const rawDistance = packed[source + 3]!;
        distances[i] = rawDistance >= 5e8 ? Number.POSITIVE_INFINITY : rawDistance;
        contactOffsets[i] = packed[source + 4]!;
      }
      return { positions, distances, contactOffsets };
    } catch (error) {
      let scopedError: GPUError | null = null;
      if (validationScopeOpen) {
        try {
          scopedError = await withGpuTimeout(
            this.device.popErrorScope(),
            GPU_READBACK_TIMEOUT_MS,
            'fermeture de la validation de l’audit collision',
          );
        } catch {
          // Device loss is handled by the application; this audit fails closed.
        }
      }
      this.disableCollisionAudit(scopedError ?? error);
      return null;
    } finally {
      if (stagingMapped && staging) {
        try {
          staging.unmap();
        } catch {
          // A lost device may already have invalidated the mapping.
        }
      }
      this.resources.release(staging);
      this.resources.release(output);
      this.pendingReadbacks.delete(pending);
      finishReadback();
    }
  }

  private disableCollisionAudit(reason: unknown): void {
    if (this.collisionAuditDisabled) return;
    this.collisionAuditDisabled = true;
    const message =
      typeof reason === 'object' && reason !== null && 'message' in reason
        ? String((reason as { message: unknown }).message)
        : String(reason);
    console.warn(`[toile] audit collision GPU désactivé pour cette scène : ${message}`);
  }

  private disablePicking(reason: unknown): void {
    if (this.pickingDisabled) return;
    this.pickingDisabled = true;
    const message =
      typeof reason === 'object' && reason !== null && 'message' in reason
        ? String((reason as { message: unknown }).message)
        : String(reason);
    console.warn(`[toile] picking GPU désactivé pour cette scène : ${message}`);
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
    if (!this.gpuActive) return;
    const dt = frameDt / substeps;
    this.windTime += frameDt; // drives the gust pattern
    this.simulatedSeconds += frameDt;
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

      // True dihedral bending first, one dispatch per hinge color. The distance
      // graph follows, with its separately-colored stitch suffix last. Body
      // contact must nevertheless remain the final positional authority: a
      // symmetric seam projected after it can put both endpoints inside the
      // avatar when flat panels started on opposite body faces. Canonical tubes
      // are pre-wrapped so both endpoints receive the same final projection.
      for (let c = 0; c < this.quadColorCounts.length; c++) {
        const groups = Math.ceil(this.quadColorCounts[c]! / WORKGROUP);
        if (groups > 0) dispatch(this.dihedralPipeline, this.dihedralBindGroups[c]!, groups);
      }

      for (let c = 0; c < this.colorCounts.length; c++) {
        const groups = Math.ceil(this.colorCounts[c]! / WORKGROUP);
        if (groups > 0) dispatch(this.solvePipeline, this.solveBindGroups[c]!, groups);
      }

      // The drag constraint costs a dispatch only while a particle is grabbed.
      if (this.dragIndex !== DRAG_NONE) dispatch(this.dragPipeline, this.dragBindGroup, 1);

      // Self-collision: rebuild the spatial hash, then separate close pairs.
      if (this.selfEnabled) {
        dispatch(this.hashClearPipeline, this.hashClearBindGroup, Math.ceil(this.tableSize / WORKGROUP));
        dispatch(this.hashInsertPipeline, this.hashInsertBindGroup, particleGroups);
        dispatch(this.selfCollidePipeline, this.selfCollideBindGroup, particleGroups);
        if (this.surfaceContactCount > 0) {
          dispatch(
            this.surfaceContactPipeline,
            this.surfaceContactBindGroup,
            Math.ceil(this.surfaceContactCount / WORKGROUP),
          );
          dispatch(
            this.surfaceReactionPipeline,
            this.surfaceReactionBindGroup,
            particleGroups,
          );
        }
      }

      // Self/surface contacts are intentionally authoritative over the weave,
      // but may move a boundary particle after its stitch was solved. Two
      // terminal Gauss-Seidel sweeps converge shared shoulder/sleeve/collar
      // junctions whose later seam colors otherwise reopen an earlier color.
      // Only regular Seam + AttachmentSeam colors live in this explicit range.
      // SurfaceSeam top-stitches are never replayed: strengthening their
      // asymmetric support reaction would make pockets tow the garment.
      for (let replay = 0; replay < REGULAR_SEAM_REPLAY_PASSES; replay++) {
        for (
          let c = this.regularSeamColorFirst;
          c < this.regularSeamColorFirst + this.regularSeamColorCount;
          c++
        ) {
          const groups = Math.ceil(this.colorCounts[c]! / WORKGROUP);
          if (groups > 0) {
            dispatch(this.solvePipeline, this.solveBindGroups[c]!, groups);
          }
        }
      }

      dispatch(this.collidePipeline, this.collideBindGroup, particleGroups);
      dispatch(this.velocityPipeline, this.velocityBindGroup, particleGroups);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Stop accepting work immediately; resources remain valid until disposal. */
  retire(): void {
    if (this.retired || this.disposed) return;
    this.retired = true;
    this.dragIndex = DRAG_NONE;
    this.mouseForce = 0;
  }

  /**
   * Drain this generation before any of its buffers/textures are destroyed.
   * Multiple callers share one promise, which makes rapid/coalesced transitions
   * safe and keeps teardown idempotent.
   */
  prepareDispose(): Promise<void> {
    this.retire();
    if (this.prepareDisposePromise) return this.prepareDisposePromise;
    this.prepareDisposePromise = (async () => {
      await Promise.allSettled([...this.pendingReadbacks]);
      try {
        await withGpuTimeout(
          this.device.queue.onSubmittedWorkDone(),
          GPU_DRAIN_TIMEOUT_MS,
          'vidage de la file GPU',
        );
      } catch (error) {
        // A lost device has no work left worth preserving. The app-level
        // device.lost handler owns the fatal UI; teardown must still complete.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[toile] attente GPU interrompue pendant le teardown : ${message}`);
      }
    })();
    return this.prepareDisposePromise;
  }

  /** Retire, drain, then destroy every tracked resource exactly once. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.prepareDispose();
      if (this.disposed) return;
      this.disposed = true;
      this.resources.dispose();
    })();
    return this.disposePromise;
  }

  private writeUniforms(dt: number): void {
    if (!this.gpuActive) return;
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
    dv.setFloat32(160, this.clothThickness, LE); // layer_gap: one thickness per layer
    // Permanent by default for legacy strapless garments. A trouser assembly
    // can instead request a dressing hold that releases after its seams close,
    // so gravity and body contact—not an invisible world anchor—carry it.
    const releaseFadeSeconds = 0.6;
    const anchorStrength = Number.isFinite(this.anchorReleaseSeconds)
      ? 0.12 *
        Math.max(
          0,
          Math.min(
            1,
            1 -
              (this.simulatedSeconds - this.anchorReleaseSeconds) /
                releaseFadeSeconds,
          ),
        )
      : 0.12;
    dv.setFloat32(164, anchorStrength, LE);
    dv.setFloat32(168, this.maxLayer, LE); // max_layer: sd_body reject margin covers the deepest stack (M4)
    dv.setUint32(96, this.count, LE);
    // Amortissement transitoire d'assemblage (params.damping) : fort au tout
    // début pour tuer l'énergie du rappel des pièces écartées par les coutures,
    // puis FONDU à 0 en ~4 s — avant que le tombé lent (manches) ne s'installe.
    // C'est un terme LINÉAIRE en vitesse qui s'annule à l'équilibre, et qui
    // repasse à 0 après 4 s : le drapé final et toute interaction ultérieure
    // (tirer le tissu) sont identiques à sans amortissement. Vérifié : la pose
    // se stabilise en ~13 s au lieu de ~30 s, tombé des manches inchangé.
    const SETTLE_MAX = 25;
    const SETTLE_SECONDS = 4;
    const settleDamp = SETTLE_MAX * Math.max(0, 1 - this.simulatedSeconds / SETTLE_SECONDS);
    dv.setFloat32(100, settleDamp, LE);
    dv.setFloat32(104, this.maxSpeed, LE);
    dv.setUint32(108, this.dragIndex, LE);
    dv.setFloat32(112, this.bodyMin[0]!, LE);
    dv.setFloat32(116, this.bodyMin[1]!, LE);
    dv.setFloat32(120, this.bodyMin[2]!, LE);
    dv.setFloat32(124, this.colliderBlend, LE);
    dv.setFloat32(128, this.bodyMax[0]!, LE);
    dv.setFloat32(132, this.bodyMax[1]!, LE);
    dv.setFloat32(136, this.bodyMax[2]!, LE);
    dv.setUint32(140, this.useGrid ? 1 : 0, LE);
    dv.setFloat32(144, Math.cos(this.spinAngle), LE);
    dv.setFloat32(148, Math.sin(this.spinAngle), LE);
    dv.setFloat32(152, this.spinRate * dt, LE);
    dv.setFloat32(156, this.complianceStretchWarp, LE);
    dv.setFloat32(172, this.complianceBendWarp, LE);
    dv.setFloat32(176, this.frictionDynamic, LE);
    dv.setFloat32(180, this.airDrag, LE);
    dv.setFloat32(184, this.stretchLimit, LE);
    dv.setFloat32(188, this.shearLimit, LE);
    dv.setFloat32(192, this.creaseYield, LE);
    dv.setFloat32(196, this.creaseMemory, LE);
    dv.setFloat32(200, this.creaseRecovery, LE);
    dv.setFloat32(
      204,
      this.seamDressingSeconds > 0
        ? Math.min(1, this.simulatedSeconds / this.seamDressingSeconds)
        : 1,
      LE,
    );
    // v198 — zip à chaud : un doc au zip ouvert s'habille fermé, puis la
    // fermeture se débraye une fois le montage posé. Le tir automatique ne
    // part qu'une fois (Infinity ensuite) pour ne pas rouvrir après un
    // « Fermer la fermeture » manuel.
    if (this.simulatedSeconds > this.zipperAutoOpenSeconds) {
      this.zipperOpen = true;
      this.zipperAutoOpenSeconds = Infinity;
    }
    dv.setFloat32(208, this.zipperOpen ? 1 : 0, LE);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  private createBuffer(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.resources.trackBuffer(
      this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true }),
    );
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  private createBufferRaw(data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.resources.trackBuffer(
      this.device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true }),
    );
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
  }
}
