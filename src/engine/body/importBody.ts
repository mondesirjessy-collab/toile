/**
 * importBody — turn a user-supplied OBJ into a TOILE mannequin (v185, chantier
 * ④ « avatar »). The renderer needs a mesh; the cloth needs a signed-distance
 * grid. An OBJ carries only the mesh, so we voxelise it here with the existing
 * exact triangle proximity BVH (MeshProximity.signedDistance) — the runtime
 * equivalent of what tools/bake.py does offline for the shipped scans.
 *
 * The imported body is normalised STANDING and 1.70 m tall (feet at y=0,
 * centred on x/z); the user then dials the exact stature and tours with the
 * measurement panel (v182-184), which morph the imported scan like any other.
 */
import { computeNormals } from '../../app/gltfExport';
import { MeshProximity } from '../geometry/MeshProximity';
import type { V3 } from './BodySdf';
import type { ScanAvatar } from './ScanAvatar';

export interface ObjMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Minimal but robust Wavefront OBJ reader: vertices (`v`), faces (`f`) with
 * `i`, `i/t`, `i//n` or `i/t/n` tokens, fan-triangulated polygons, and OBJ's
 * 1-based / negative-relative indices. Everything else (vt, vn, groups…) is
 * ignored — we rebuild normals ourselves.
 */
export function parseObj(text: string): ObjMesh {
  const verts: number[] = [];
  const tris: number[] = [];
  const resolve = (token: string): number => {
    const slash = token.indexOf('/');
    const idxStr = slash === -1 ? token : token.slice(0, slash);
    const n = Number.parseInt(idxStr, 10);
    if (!Number.isFinite(n) || n === 0) return -1;
    // OBJ indices are 1-based; negatives count back from the current vertex end.
    const vertexCount = verts.length / 3;
    return n > 0 ? n - 1 : vertexCount + n;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      const x = Number.parseFloat(p[1]!);
      const y = Number.parseFloat(p[2]!);
      const z = Number.parseFloat(p[3]!);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push(x, y, z);
      continue;
    }
    if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1);
      const face: number[] = [];
      for (const tok of p) {
        const vi = resolve(tok);
        if (vi >= 0) face.push(vi);
      }
      // Fan-triangulate any polygon (triangle, quad, n-gon).
      for (let k = 2; k < face.length; k++) {
        tris.push(face[0]!, face[k - 1]!, face[k]!);
      }
    }
  }
  const vertexCount = verts.length / 3;
  const valid = tris.every((i) => i >= 0 && i < vertexCount);
  if (vertexCount < 3 || tris.length < 3 || !valid) {
    throw new Error('OBJ illisible : il faut des sommets (v) et des faces (f) valides.');
  }
  return { positions: new Float32Array(verts), indices: new Uint32Array(tris) };
}

export interface ImportBodyOptions {
  /** Standing height the body is scaled to (m). The user re-dials it after. */
  targetHeight?: number;
  /** Approximate voxel size for the collision grid (m). */
  voxel?: number;
  /** Hard cap per grid axis (keeps the voxelisation responsive). */
  maxDim?: [number, number, number];
  /** Rotate a MakeHuman/Anny A-pose (arms hanging ~50°) to a clean horizontal
   *  T-pose, so the generative body matches the elegant shipped scans instead of
   *  reading as an eerie half-realistic mannequin. */
  tPoseArms?: boolean;
}

/**
 * Swing hanging A-pose arms up to a horizontal T-pose, in place, on a body
 * already normalised Y-up (feet at 0, height `H`, centred on x/z). Each vertex
 * rotates about the shoulder joint (in the frontal x-y plane) by `w · φ`, where
 * φ is the angle that makes the shoulder→hand axis horizontal and `w` is a
 * CONTINUOUS field: it ramps in with how far the vertex sits beyond the shoulder
 * (`smoothstep` in x) and is gated to the shoulder/arm height band so legs, feet
 * and head stay put. A continuous weight (rather than a hard tube mask) means
 * neighbouring vertices share almost the same weight, so no triangle gets
 * stretched into a spike at the armpit. Pivot and angle are measured from THIS
 * mesh, so it adapts to whatever phenotype/stature the body was built with.
 * Tuned offline against the Anny mesh (hand lands horizontal at shoulder height,
 * waist untouched, no spikes).
 */
function tPoseArmsInPlace(positions: Float32Array, H: number): void {
  const smoothstep = (a: number, b: number, x: number): number => {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  };
  for (const sign of [1, -1] as const) {
    // Hand = furthest-out vertex on this side; shoulder edge = furthest-out
    // vertex in the 78–87 % height band; pivot sits a little inboard of it.
    let hx = 0, hy = 0, hbest = -Infinity;
    let ex = 0, ey = 0, ebest = -Infinity;
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v]!;
      const y = positions[v + 1]!;
      if (sign * x > hbest) { hbest = sign * x; hx = x; hy = y; }
      if (y >= 0.78 * H && y <= 0.87 * H && sign * x > ebest) { ebest = sign * x; ex = x; ey = y; }
    }
    const px = 0.7 * ex, py = ey; // pivot z = 0 (shoulder near body centre depth)
    const cur = Math.atan2(hy - py, hx - px);
    const tgt = sign > 0 ? 0 : Math.PI; // arm should point straight out to the side
    const phi = Math.atan2(Math.sin(tgt - cur), Math.cos(tgt - cur));
    const x0 = Math.abs(px) + 0.02, x1 = Math.abs(px) + 0.16; // ramp beyond the shoulder
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v]!;
      if (sign * x <= 0) continue;
      const y = positions[v + 1]!;
      // Only the shoulder/arm height band turns — legs/feet below, head above.
      const gate = smoothstep(0.42 * H, 0.52 * H, y) * (1 - smoothstep(0.9 * H, 0.98 * H, y));
      const w = smoothstep(x0, x1, sign * x) * gate;
      if (w <= 0) continue;
      const a = w * phi, c = Math.cos(a), s = Math.sin(a);
      const lx = x - px, ly = y - py;
      positions[v] = px + c * lx - s * ly;
      positions[v + 1] = py + s * lx + c * ly;
    }
  }
}

/** Rotate positions in place so the tallest bounding axis becomes +Y (up),
 *  using a PROPER rotation (det +1) so triangle winding — hence normals and
 *  inside/outside — is preserved. Returns the up axis it corrected from. */
function standUpright(positions: Float32Array): 0 | 1 | 2 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
  const up = ex > ey && ex > ez ? 0 : ez > ey ? 2 : 1;
  if (up === 1) return 1; // already Y-up
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
    if (up === 2) {
      // Z-up → Y-up : Rx(-90°) (x, y, z) → (x, z, -y)
      positions[v] = x; positions[v + 1] = z; positions[v + 2] = -y;
    } else {
      // X-up → Y-up : Rz(+90°) (x, y, z) → (-y, x, z)
      positions[v] = -y; positions[v + 1] = x; positions[v + 2] = z;
    }
  }
  return up;
}

/**
 * Build a ScanAvatar (render mesh + collision SDF grid) from a parsed OBJ.
 * Pure and synchronous so it is unit-testable; the caller shows a "computing"
 * message because the voxelisation is the heavy step.
 */
export function buildImportedBody(raw: ObjMesh, opts: ImportBodyOptions = {}): ScanAvatar {
  const targetHeight = opts.targetHeight ?? 1.7;
  const voxel = opts.voxel ?? 0.022;
  const cap = opts.maxDim ?? [64, 96, 64];

  const positions = new Float32Array(raw.positions); // copy — we normalise in place
  standUpright(positions);

  // Bounding box after standing upright.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const height = Math.max(1e-4, maxY - minY);
  const scale = targetHeight / height;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  // Feet at y=0, centred on x/z, scaled to the target height.
  for (let v = 0; v < positions.length; v += 3) {
    positions[v] = (positions[v]! - cx) * scale;
    positions[v + 1] = (positions[v + 1]! - minY) * scale;
    positions[v + 2] = (positions[v + 2]! - cz) * scale;
  }

  // Optional: straighten a MakeHuman A-pose into a T-pose BEFORE meshing so both
  // the render mesh and the collision grid share the horizontal-arm stance.
  if (opts.tPoseArms) tPoseArmsInPlace(positions, targetHeight);

  // Winding varies wildly between exporters, and MeshProximity trusts face
  // orientation for its cheap "outside" path — an inward-facing mesh reads as
  // hollow (positive SDF everywhere inside). The signed volume is +ve only when
  // faces point OUT of a closed mesh; if it's negative, flip every triangle so
  // normals face outward and the collision sign is correct.
  const indices = new Uint32Array(raw.indices);
  let v6 = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx2 = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    // a · (b × c)
    v6 += ax * (by * cz - bz * cy) + ay * (bz * cx2 - bx * cz) + az * (bx * cy - by * cx2);
  }
  if (v6 < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = tmp;
    }
  }

  const normals = computeNormals(positions, indices);
  const prox = new MeshProximity({ positions, indices });

  // Collision grid bounds: the normalised body plus a little air so the SDF is
  // positive all around (the solver needs an exterior band to push against).
  const pad = 0.05;
  const bx0 = (minX - cx) * scale - pad, bx1 = (maxX - cx) * scale + pad;
  const by0 = -pad, by1 = targetHeight + pad;
  const bz0 = (minZ - cz) * scale - pad, bz1 = (maxZ - cz) * scale + pad;
  const dim = (lo: number, hi: number, capN: number): number =>
    Math.max(8, Math.min(capN, Math.ceil((hi - lo) / voxel) + 1));
  const nx = dim(bx0, bx1, cap[0]);
  const ny = dim(by0, by1, cap[1]);
  const nz = dim(bz0, bz1, cap[2]);

  const min: V3 = [bx0, by0, bz0];
  const max: V3 = [bx1, by1, bz1];
  const data = new Float32Array(nx * ny * nz);
  const stepX = (bx1 - bx0) / (nx - 1);
  const stepY = (by1 - by0) / (ny - 1);
  const stepZ = (bz1 - bz0) / (nz - 1);
  // Same axis order gridSd() reads: x fastest, then y, then z.
  for (let k = 0; k < nz; k++) {
    const z = bz0 + k * stepZ;
    for (let j = 0; j < ny; j++) {
      const y = by0 + j * stepY;
      for (let i = 0; i < nx; i++) {
        const x = bx0 + i * stepX;
        data[(k * ny + j) * nx + i] = prox.signedDistance([x, y, z]);
      }
    }
  }

  return {
    mesh: { positions, normals, indices },
    grid: { dims: [nx, ny, nz], min, max, data },
  };
}
