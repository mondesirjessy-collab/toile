/**
 * SceneGeometry — static collider meshes (sphere + ground) for the milestone 5-6
 * scene. Purely visual: the solver has its own analytic sphere/ground in the
 * collide pass; this just lets the viewer SEE what the cloth drapes onto.
 *
 * One interleaved vertex buffer, 9 floats/vertex: position(3), normal(3),
 * color(3), consumed by the lit pass in PointsRenderer. Baked in world space
 * (the colliders don't move), so no per-object model matrix is needed.
 */
import { bodyBounds, bodyNormal, sdBody, type SdfPrim } from '../engine/body/BodySdf';
import type { ScanAppearance, ScanMesh, ScanVisualMesh } from '../engine/body/ScanAvatar';
import { surfaceNets } from './SurfaceNets';

export const SCENE_VERTEX_FLOATS = 9;
export const MAX_SCENE_JOINTS = 64;
export const SCENE_JOINT_INFLUENCES = 4;
export const SCENE_JOINT_PALETTE_FLOATS = MAX_SCENE_JOINTS * 16;
export const SCENE_JOINT_PALETTE_BYTES = SCENE_JOINT_PALETTE_FLOATS * 4;

/** GPU-ready skin streams. Joint ids are palette ordinals, not glTF nodes. */
export interface SceneSkin {
  /** Four uint16 palette ordinals per scene vertex. */
  jointIndices: Uint16Array;
  /** Four float weights per scene vertex, parallel to `jointIndices`. */
  weights: Float32Array;
  /** Optional initial column-major mat4 palette (one to 64 matrices). */
  jointMatrices?: Float32Array;
}

export interface SceneMesh {
  vertices: Float32Array; // interleaved pos3, normal3, color3
  /** Parallel UV stream; (-8,-8) marks non-textured scene geometry. */
  uvs: Float32Array;
  /** Parallel glTF tangent stream; w=0 requests derivative fallback. */
  tangents: Float32Array;
  indices: Uint32Array;
  /** Indices [0, bodyIndexCount) are the mannequin (podium-rotated at draw). */
  bodyIndexCount: number;
  /** Closed low-detail surface reserved for picking/proximity audits. */
  proximityBody?: ScanMesh;
  /** PBR maps belonging to the high-detail body block. */
  appearance?: ScanAppearance;
  /** Optional skin streams, expanded to cover every scene vertex. */
  skin?: SceneSkin;
}

export interface SceneParams {
  /** Capsule/sphere colliders to visualize (a mannequin is a handful of them). */
  colliders: { a: [number, number, number]; b?: [number, number, number]; radius: number }[];
  /** Smooth-blended SDF body: meshed by surface nets instead of capsule shells. */
  body?: { prims: SdfPrim[]; blend: number };
  /** Pre-built body mesh (scanned avatar) — used verbatim. */
  rawBody?: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    colors?: Float32Array;
  };
  /** UV-preserving display/export surface, independent from rawBody/SDF. */
  visualBody?: ScanVisualMesh;
  appearance?: ScanAppearance;
  proximityBody?: ScanMesh;
  /** Skin streams for the selected body mesh (four influences per vertex). */
  skin?: SceneSkin;
  groundY: number;
  groundHalfSize?: number;
}

/**
 * Validate the fixed-width GPU skin layout before it reaches WebGPU.
 *
 * The explicit vertex count also lets ClothRenderer defend against SceneMesh
 * instances built outside buildSceneMesh().
 */
export function validateSceneSkin(skin: SceneSkin, vertexCount: number): void {
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    throw new RangeError('scene skin vertex count must be a non-negative integer');
  }
  const expected = vertexCount * SCENE_JOINT_INFLUENCES;
  if (!(skin.jointIndices instanceof Uint16Array) || !(skin.weights instanceof Float32Array)) {
    throw new TypeError('scene skin streams must use Uint16Array indices and Float32Array weights');
  }
  if (skin.jointIndices.length !== expected || skin.weights.length !== expected) {
    throw new RangeError(
      `scene skin streams must contain four influences per vertex (${expected} values)`,
    );
  }
  for (let i = 0; i < expected; i++) {
    const joint = skin.jointIndices[i]!;
    const weight = skin.weights[i]!;
    if (joint >= MAX_SCENE_JOINTS) {
      throw new RangeError(`scene skin joint ${joint} exceeds the ${MAX_SCENE_JOINTS}-joint palette`);
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError('scene skin weights must be finite and non-negative');
    }
  }
  if (skin.jointMatrices) validateSceneJointMatrices(skin.jointMatrices);
}

/** Validate a compact matrix palette (the renderer pads it with identities). */
export function validateSceneJointMatrices(matrices: ArrayLike<number>): void {
  if (
    matrices.length === 0 ||
    matrices.length % 16 !== 0 ||
    matrices.length > SCENE_JOINT_PALETTE_FLOATS
  ) {
    throw new RangeError(
      `scene joint palette must contain 1-${MAX_SCENE_JOINTS} complete mat4 matrices`,
    );
  }
  for (let i = 0; i < matrices.length; i++) {
    if (!Number.isFinite(matrices[i])) {
      throw new RangeError('scene joint palette values must be finite');
    }
  }
}

/** A fully populated, 256-byte aligned uniform palette with identity padding. */
export function sceneJointPalette(matrices?: ArrayLike<number>): Float32Array {
  const result = new Float32Array(SCENE_JOINT_PALETTE_FLOATS);
  for (let joint = 0; joint < MAX_SCENE_JOINTS; joint++) {
    const offset = joint * 16;
    result[offset] = 1;
    result[offset + 5] = 1;
    result[offset + 10] = 1;
    result[offset + 15] = 1;
  }
  if (matrices) {
    validateSceneJointMatrices(matrices);
    for (let i = 0; i < matrices.length; i++) result[i] = matrices[i]!;
  }
  return result;
}

// The sculpted body is static per collider set: mesh it once, then reuse.
// Callers memoize their prim arrays (same morph values → same identity), so
// this hits for every revisited setting; the cap keeps a slider session from
// hoarding one ~1 s surface-nets mesh per setting ever tried.
const bodyMeshCache = new Map<SdfPrim[], ReturnType<typeof surfaceNets>>();
const BODY_MESH_CACHE_MAX = 8;

function bodyMesh(prims: SdfPrim[], blend: number): ReturnType<typeof surfaceNets> {
  let mesh = bodyMeshCache.get(prims);
  if (!mesh) {
    const { min, max } = bodyBounds(prims, blend + 0.02);
    mesh = surfaceNets(
      (x, y, z) => sdBody(x, y, z, prims, blend),
      (x, y, z) => bodyNormal(x, y, z, prims, blend),
      min,
      max,
      0.008,
    );
    if (bodyMeshCache.size >= BODY_MESH_CACHE_MAX) {
      // Evict the oldest entry (Map preserves insertion order).
      bodyMeshCache.delete(bodyMeshCache.keys().next().value!);
    }
    bodyMeshCache.set(prims, mesh);
  }
  return mesh;
}

/**
 * Rest-pose interleaved vertices (pos3, normal3, skin color3) of the sculpted
 * body — the exact data buildSceneMesh() pushes first, exposed for skinning.
 */
export function bodyRestVertices(
  prims: SdfPrim[],
  blend: number,
): { interleaved: Float32Array; positions: Float32Array } {
  const mesh = bodyMesh(prims, blend);
  const vcount = mesh.positions.length / 3;
  const interleaved = new Float32Array(vcount * SCENE_VERTEX_FLOATS);
  for (let v = 0; v < vcount; v++) {
    const o = v * SCENE_VERTEX_FLOATS;
    interleaved[o] = mesh.positions[v * 3]!;
    interleaved[o + 1] = mesh.positions[v * 3 + 1]!;
    interleaved[o + 2] = mesh.positions[v * 3 + 2]!;
    interleaved[o + 3] = mesh.normals[v * 3]!;
    interleaved[o + 4] = mesh.normals[v * 3 + 1]!;
    interleaved[o + 5] = mesh.normals[v * 3 + 2]!;
    interleaved[o + 6] = 0.62;
    interleaved[o + 7] = 0.53;
    interleaved[o + 8] = 0.47;
  }
  return { interleaved, positions: mesh.positions };
}

export function buildSceneMesh(p: SceneParams): SceneMesh {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const tangents: number[] = [];
  const indices: number[] = [];
  if (p.skin && !p.body && !p.rawBody && !p.visualBody) {
    throw new RangeError('scene skin requires a body mesh');
  }

  const push = (
    pos: [number, number, number],
    nrm: [number, number, number],
    col: [number, number, number],
    uv: [number, number] = [-8, -8],
    tangent: [number, number, number, number] = [1, 0, 0, 0],
  ): number => {
    const idx = vertices.length / SCENE_VERTEX_FLOATS;
    vertices.push(pos[0], pos[1], pos[2], nrm[0], nrm[1], nrm[2], col[0], col[1], col[2]);
    uvs.push(uv[0], uv[1]);
    tangents.push(tangent[0], tangent[1], tangent[2], tangent[3]);
    return idx;
  };

  const bodyColor: [number, number, number] = [0.45, 0.49, 0.58];

  // --- Sculpted body (surface nets) or scanned avatar (verbatim mesh) ---
  if (p.body || p.rawBody || p.visualBody) {
    // Warm matte fallback for historical scans. New scans may carry compact
    // source-derived vertex RGB, which keeps face/body identity without a
    // texture upload in every renderer rebuild.
    const skin: [number, number, number] = [0.62, 0.53, 0.47];
    const mesh = p.visualBody ?? p.rawBody ?? bodyMesh(p.body!.prims, p.body!.blend);
    const colors = p.visualBody ? undefined : p.rawBody?.colors;
    const bodyVertexCount = mesh.positions.length / 3;
    if (p.skin) validateSceneSkin(p.skin, bodyVertexCount);
    const base = vertices.length / SCENE_VERTEX_FLOATS;
    for (let v = 0; v < bodyVertexCount; v++) {
      push(
        [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!],
        [mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!],
        colors
          ? [colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!]
          : p.visualBody
            ? [
                p.appearance?.baseColorFactor[0] ?? 1,
                p.appearance?.baseColorFactor[1] ?? 1,
                p.appearance?.baseColorFactor[2] ?? 1,
              ]
            : skin,
        p.visualBody
          ? [p.visualBody.uvs[v * 2]!, p.visualBody.uvs[v * 2 + 1]!]
          : [-8, -8],
        p.visualBody?.tangents
          ? [
              p.visualBody.tangents[v * 4]!,
              p.visualBody.tangents[v * 4 + 1]!,
              p.visualBody.tangents[v * 4 + 2]!,
              p.visualBody.tangents[v * 4 + 3]!,
            ]
          : [1, 0, 0, 0],
      );
    }
    for (const idx of mesh.indices) indices.push(base + idx);
  }

  // --- Capsules (split-sphere technique: the unit sphere's upper hemisphere
  // anchors to endpoint b, the lower one to a, normals unchanged). A sphere is
  // just the degenerate case a = b. Local frame: "up" = the capsule axis.
  const rings = 32;
  const sectors = 48;
  for (const col of p.colliders) {
    const a = col.a;
    const b = col.b ?? col.a;
    const r = col.radius;
    // Orthonormal frame with `up` along the capsule axis (fallback +Y).
    let up: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(up[0], up[1], up[2]);
    up = len > 1e-6 ? [up[0] / len, up[1] / len, up[2] / len] : [0, 1, 0];
    const ref: [number, number, number] = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let side: [number, number, number] = [
      up[1] * ref[2] - up[2] * ref[1],
      up[2] * ref[0] - up[0] * ref[2],
      up[0] * ref[1] - up[1] * ref[0],
    ];
    const sl = Math.hypot(side[0], side[1], side[2]);
    side = [side[0] / sl, side[1] / sl, side[2] / sl];
    const fwd: [number, number, number] = [
      up[1] * side[2] - up[2] * side[1],
      up[2] * side[0] - up[0] * side[2],
      up[0] * side[1] - up[1] * side[0],
    ];

    const base = vertices.length / SCENE_VERTEX_FLOATS;
    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI; // 0..π (pole to pole)
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      for (let sec = 0; sec <= sectors; sec++) {
        const theta = (sec / sectors) * Math.PI * 2;
        const lx = sinP * Math.cos(theta);
        const ly = cosP;
        const lz = sinP * Math.sin(theta);
        // Local normal → world via the frame.
        const n: [number, number, number] = [
          side[0] * lx + up[0] * ly + fwd[0] * lz,
          side[1] * lx + up[1] * ly + fwd[1] * lz,
          side[2] * lx + up[2] * ly + fwd[2] * lz,
        ];
        const c = ly >= 0 ? b : a; // upper half on b, lower half on a
        push([c[0] + r * n[0], c[1] + r * n[1], c[2] + r * n[2]], n, bodyColor);
      }
    }
    const stride = sectors + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let sec = 0; sec < sectors; sec++) {
        const i0 = base + ring * stride + sec;
        const i1 = i0 + stride;
        indices.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
      }
    }
  }

  const bodyIndexCount = indices.length; // everything so far rotates on the podium

  // --- Ground quad (y = groundY, facing up) ---
  const h = p.groundHalfSize ?? 4.0;
  const g = p.groundY;
  const up: [number, number, number] = [0, 1, 0];
  const groundColor: [number, number, number] = [0.18, 0.19, 0.22];
  const g0 = push([-h, g, -h], up, groundColor);
  const g1 = push([h, g, -h], up, groundColor);
  const g2 = push([h, g, h], up, groundColor);
  const g3 = push([-h, g, h], up, groundColor);
  indices.push(g0, g2, g1, g0, g3, g2);

  // The body is emitted first. Copy its already-packed streams once into
  // typed arrays sized for the complete scene; zero-initialised trailing
  // values make ground/colliders rigid without large temporary JS arrays for
  // detailed scan meshes.
  const sceneVertexCount = vertices.length / SCENE_VERTEX_FLOATS;
  const sceneJointIndices = p.skin
    ? new Uint16Array(sceneVertexCount * SCENE_JOINT_INFLUENCES)
    : null;
  const sceneJointWeights = p.skin
    ? new Float32Array(sceneVertexCount * SCENE_JOINT_INFLUENCES)
    : null;
  if (p.skin && sceneJointIndices && sceneJointWeights) {
    sceneJointIndices.set(p.skin.jointIndices);
    sceneJointWeights.set(p.skin.weights);
  }

  return {
    vertices: new Float32Array(vertices),
    uvs: new Float32Array(uvs),
    tangents: new Float32Array(tangents),
    indices: new Uint32Array(indices),
    bodyIndexCount,
    ...(p.proximityBody ? { proximityBody: p.proximityBody } : {}),
    ...(p.appearance ? { appearance: p.appearance } : {}),
    ...(p.skin
      ? {
          skin: {
            jointIndices: sceneJointIndices!,
            weights: sceneJointWeights!,
            ...(p.skin.jointMatrices
              ? { jointMatrices: new Float32Array(p.skin.jointMatrices) }
              : {}),
          },
        }
      : {}),
  };
}
