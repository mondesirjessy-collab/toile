/**
 * morph — body measurements as a space warp.
 *
 * Three sliders (poitrine / taille / hanches) become radial scale factors
 * applied around the tailor-measured feature heights, blended by gaussian
 * bells so the chest fades into the neck and the hips into the thighs.
 * The SAME warp reshapes every kind of mannequin:
 *   - sculpted prims: positions and radii scaled per height;
 *   - scanned avatars: the SDF grid is resampled through the inverse warp
 *     and the render mesh vertices are stretched directly.
 * The tailor then measures the MORPHED body, so garments come out re-graded
 * for the new figure automatically.
 */
import type { SdfPrim, V3 } from './BodySdf';
import { gridSd } from './measure';

export interface Morphs {
  stature: number; // uniform scale
  carrure: number; // shoulder breadth
  poitrine: number;
  taille: number;
  hanches: number;
  cuisse: number;
  jambe: number; // leg length (vertical warp, stature preserved)
  buste: number; // torso length (vertical warp, stature preserved)
  cou: number; // neck length (vertical warp, stature preserved)
  bras: number; // arm length (lateral warp beyond the shoulder root, T-pose)
}

export interface MorphMarks {
  shoulderY: number;
  chestY: number;
  waistY: number;
  hipY: number;
  thighY: number;
  neckY: number; // neck top (base of the head) — the head stays fixed above it
  armRootX: number; // |x| of the shoulder root; arms extend beyond it in T-pose (0 = no arm)
  armY: number; // height of the arm axis (where arms extend sideways)
}

export const NO_MORPH: Morphs = {
  stature: 1,
  carrure: 1,
  poitrine: 1,
  taille: 1,
  hanches: 1,
  cuisse: 1,
  jambe: 1,
  buste: 1,
  cou: 1,
  bras: 1,
};

export function isNeutral(m: Morphs): boolean {
  return (
    m.stature === 1 &&
    m.carrure === 1 &&
    m.poitrine === 1 &&
    m.taille === 1 &&
    m.hanches === 1 &&
    m.cuisse === 1 &&
    m.jambe === 1 &&
    m.buste === 1 &&
    m.cou === 1 &&
    m.bras === 1
  );
}

const bell = (dy: number, width: number): number => Math.exp(-((dy / width) ** 2));

/**
 * Vertical warp = body proportions at CONSTANT stature. The body up to the neck
 * TOP is split into three segments — LEGS (`jambe`, 0 → hip), TORSO (`buste`,
 * hip → shoulder) and NECK (`cou`, shoulder → neck top) — and redistributed so
 * their total stays put; the head (above the neck top) never moves, so overall
 * height is unchanged. A factor > 1 lengthens its segment and the others shorten
 * to compensate. Heights are in the stature-scaled space (feature marks already
 * multiplied by m.stature).
 */
function verticalWarp(
  m: Morphs,
  marks: MorphMarks,
  st: number,
): { s1: number; s2: number; s3: number; t1: number; t2: number; kLeg: number; kTorso: number; kNeck: number } {
  const s1 = marks.hipY * st; // hip line
  const s2 = marks.shoulderY * st; // shoulder line
  const s3 = Math.max(s2 + 1e-3, marks.neckY * st); // neck top — head fixed above
  const jambe = Math.min(1.3, Math.max(0.8, m.jambe));
  const buste = Math.min(1.3, Math.max(0.8, m.buste));
  const cou = Math.min(1.3, Math.max(0.8, m.cou));
  // Keep the neck top: rescale the three lower segments so they still sum to s3.
  const scale = s3 / Math.max(1e-6, s1 * jambe + (s2 - s1) * buste + (s3 - s2) * cou);
  const t1 = s1 * jambe * scale; // new hip height
  const t2 = t1 + (s2 - s1) * buste * scale; // new shoulder height
  return {
    s1, s2, s3, t1, t2,
    kLeg: jambe * scale, // stretch of [0, s1]
    kTorso: buste * scale, // stretch of [s1, s2]
    kNeck: cou * scale, // stretch of [s2, s3]
  };
}

/** Remap a stature-scaled height through the vertical warp. */
export function warpY(y: number, m: Morphs, marks: MorphMarks, st: number): number {
  if (m.jambe === 1 && m.buste === 1 && m.cou === 1) return y;
  const { s1, s2, s3, t1, t2, kLeg, kTorso, kNeck } = verticalWarp(m, marks, st);
  if (y <= s1) return y * kLeg;
  if (y <= s2) return t1 + (y - s1) * kTorso;
  if (y <= s3) return t2 + (y - s2) * kNeck;
  return y; // head and above: unchanged (neck top preserved)
}

/** d(warpY)/dy — the vertical stretch factor, piecewise constant. */
function warpYDeriv(y: number, m: Morphs, marks: MorphMarks, st: number): number {
  if (m.jambe === 1 && m.buste === 1 && m.cou === 1) return 1;
  const { s1, s2, s3, kLeg, kTorso, kNeck } = verticalWarp(m, marks, st);
  if (y <= s1) return kLeg;
  if (y <= s2) return kTorso;
  if (y <= s3) return kNeck;
  return 1;
}

/** Inverse of warpY: from a warped height back to the source height. */
function warpYInverse(y: number, m: Morphs, marks: MorphMarks, st: number): number {
  if (m.jambe === 1 && m.buste === 1 && m.cou === 1) return y;
  const { s1, s2, s3, t1, t2, kLeg, kTorso, kNeck } = verticalWarp(m, marks, st);
  if (y <= t1) return y / Math.max(1e-6, kLeg);
  if (y <= t2) return s1 + (y - t1) / Math.max(1e-6, kTorso);
  if (y <= s3) return s2 + (y - t2) / Math.max(1e-6, kNeck);
  return y;
}

/**
 * Arm length. In the native T-pose the arms reach sideways beyond the shoulder
 * root. Past |x| = armRootX (measured at the arm height, laterally warped by
 * `s`) we stretch x away from the root by `bras`, leaving the torso untouched.
 * `px` is the already-laterally-warped x. `apply` picks forward or inverse.
 */
function armStretchAt(m: Morphs, marks: MorphMarks, y: number, st: number): number {
  if (m.bras === 1 || marks.armRootX <= 0) return 0;
  if (Math.abs(y - marks.armY * st) > 0.25) return 0; // only near the arm height
  return Math.min(1.3, Math.max(0.8, m.bras));
}

/** Forward arm-length warp of an already-laterally-warped x. `s` = lateral scale. */
function warpArmX(px: number, m: Morphs, marks: MorphMarks, y: number, s: number, st: number): number {
  const bras = armStretchAt(m, marks, y, st);
  if (bras === 0) return px;
  const rootXw = marks.armRootX * s;
  const apx = Math.abs(px);
  return apx <= rootXw ? px : Math.sign(px) * (rootXw + (apx - rootXw) * bras);
}

/** Inverse arm-length warp (for resampling the collision grid). */
function warpArmXInverse(px: number, m: Morphs, marks: MorphMarks, y: number, s: number, st: number): number {
  const bras = armStretchAt(m, marks, y, st);
  if (bras === 0) return px;
  const rootXw = marks.armRootX * s;
  const apx = Math.abs(px);
  return apx <= rootXw ? px : Math.sign(px) * (rootXw + (apx - rootXw) / bras);
}

/**
 * Radial (x,z) scale at height y for the given measurements. `y` is in the
 * STATURE-SCALED space, so the feature marks are scaled by m.stature first.
 */
export function morphScale(y: number, m: Morphs, marks: MorphMarks): number {
  const st = m.stature;
  return (
    1 +
    (m.carrure - 1) * bell(y - marks.shoulderY * st, 0.09) +
    (m.poitrine - 1) * bell(y - marks.chestY * st, 0.14) +
    (m.taille - 1) * bell(y - marks.waistY * st, 0.1) +
    (m.hanches - 1) * bell(y - marks.hipY * st, 0.13) +
    (m.cuisse - 1) * bell(y - marks.thighY * st, 0.12)
  );
}

/** Sculpted body: uniform stature scale, then per-height lateral warp. */
export function morphPrims(prims: SdfPrim[], m: Morphs, marks: MorphMarks): SdfPrim[] {
  const st = m.stature;
  return prims.map((p) => {
    const ay = p.a[1] * st;
    const by = p.b[1] * st;
    const sa = morphScale(ay, m, marks);
    const sb = morphScale(by, m, marks);
    return {
      a: [warpArmX(p.a[0] * st * sa, m, marks, ay, st * sa, st), warpY(ay, m, marks, st), p.a[2] * st * sa] as V3,
      b: [warpArmX(p.b[0] * st * sb, m, marks, by, st * sb, st), warpY(by, m, marks, st), p.b[2] * st * sb] as V3,
      ra: p.ra * st * sa,
      rb: p.rb * st * sb,
      s: p.s,
    };
  });
}

export interface Grid {
  dims: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  data: Float32Array;
}

/** Scanned body: resample the SDF grid through the inverse warp. */
export function morphGrid(grid: Grid, m: Morphs, marks: MorphMarks): Grid {
  const st = m.stature;
  const sMax = Math.max(m.carrure, m.poitrine, m.taille, m.hanches, m.cuisse, m.bras, 1) * st;
  const min: [number, number, number] = [grid.min[0] * sMax, grid.min[1] * st, grid.min[2] * sMax];
  const max: [number, number, number] = [grid.max[0] * sMax, grid.max[1] * st, grid.max[2] * sMax];
  const [nx, ny, nz] = grid.dims;
  const src = gridSd(grid);
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + (k / (nz - 1)) * (max[2] - min[2]);
    for (let j = 0; j < ny; j++) {
      const y = min[1] + (j / (ny - 1)) * (max[1] - min[1]);
      // Undo the vertical (rise) warp to find the SOURCE height, then apply the
      // lateral warp measured at that source height (as morphMesh does).
      const y0 = warpYInverse(y, m, marks, st);
      const s = morphScale(y0, m, marks) * st;
      const dY = warpYDeriv(y0, m, marks, st) * st;
      const armBras = armStretchAt(m, marks, y0, st);
      for (let i = 0; i < nx; i++) {
        const x = min[0] + (i / (nx - 1)) * (max[0] - min[0]);
        const xSrc = warpArmXInverse(x, m, marks, y0, s, st);
        const xF = armBras !== 0 && Math.abs(x) > marks.armRootX * s ? armBras : 1;
        // Conservative distance estimate under the warp: never overestimates,
        // so contacts trigger a hair early rather than late.
        data[(k * ny + j) * nx + i] = src(xSrc / s, y0 / st, z / s) * Math.min(1, s, dY, s * xF);
      }
    }
  }
  return { dims: [nx, ny, nz], min, max, data };
}

/** Scanned body: stretch the render mesh through the same warp. */
export function morphMesh<
  T extends {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    colors?: Float32Array;
    uvs?: Float32Array;
    tangents?: Float32Array;
  },
>(
  mesh: T,
  m: Morphs,
  marks: MorphMarks,
): Omit<T, 'positions' | 'normals'> & {
  positions: Float32Array;
  normals: Float32Array;
} {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const tangents = mesh.tangents ? new Float32Array(mesh.tangents.length) : undefined;
  const st = m.stature;
  for (let v = 0; v < mesh.positions.length; v += 3) {
    const sourceX = mesh.positions[v]!;
    const sourceY = mesh.positions[v + 1]!;
    const sourceZ = mesh.positions[v + 2]!;
    const y = sourceY * st;
    const s = morphScale(y, m, marks) * st;
    const pxLat = sourceX * s;
    positions[v] = warpArmX(pxLat, m, marks, y, s, st);
    positions[v + 1] = warpY(y, m, marks, st);
    positions[v + 2] = sourceZ * s;

    // Exact inverse-transpose of F(x,y,z)=(s(y)x, warpY(stature*y), s(y)z).
    // Transforming source normals (instead of re-smoothing triangles) keeps
    // coincident vertices on opposite sides of a UV seam bit-identical.
    const epsilon = 1e-4;
    const scaleBefore = morphScale((sourceY - epsilon) * st, m, marks) * st;
    const scaleAfter = morphScale((sourceY + epsilon) * st, m, marks) * st;
    const derivative = (scaleAfter - scaleBefore) / (2 * epsilon);
    const safeScale = Math.max(1e-6, Math.abs(s));
    // Vertical stretch d(output_y)/d(source_y) = warpY'(y)*stature (was stature).
    const dY = warpYDeriv(y, m, marks, st) * st;
    const safeStature = Math.max(1e-6, Math.abs(dY));
    // On the stretched arm the x-scale is s*bras; the torso and z stay at s.
    const armBras = armStretchAt(m, marks, y, st);
    const xStretch = armBras !== 0 && Math.abs(pxLat) > marks.armRootX * s ? armBras : 1;
    const nx = mesh.normals[v]! / Math.max(1e-6, safeScale * xStretch);
    const nz = mesh.normals[v + 2]! / safeScale;
    const ny = (
      mesh.normals[v + 1]! - sourceX * derivative * nx - sourceZ * derivative * nz
    ) / safeStature;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[v] = nx / length;
    normals[v + 1] = ny / length;
    normals[v + 2] = nz / length;
    if (tangents && mesh.tangents) {
      const tangent = (v / 3) * 4;
      let tx = s * mesh.tangents[tangent]! + sourceX * derivative * mesh.tangents[tangent + 1]!;
      let ty = dY * mesh.tangents[tangent + 1]!;
      let tz = s * mesh.tangents[tangent + 2]! + sourceZ * derivative * mesh.tangents[tangent + 1]!;
      // Mikk tangents must stay perpendicular to the transformed normal.
      const projection = tx * normals[v]! + ty * normals[v + 1]! + tz * normals[v + 2]!;
      tx -= projection * normals[v]!;
      ty -= projection * normals[v + 1]!;
      tz -= projection * normals[v + 2]!;
      let tangentLength = Math.hypot(tx, ty, tz);
      if (tangentLength < 1e-8) {
        // Degenerate source tangent (one vertex in Blender's decimated GLB):
        // construct a stable perpendicular instead of exporting vec3(0).
        if (Math.abs(normals[v + 1]!) < 0.9) {
          tx = normals[v + 2]!;
          ty = 0;
          tz = -normals[v]!;
        } else {
          tx = 0;
          ty = -normals[v + 2]!;
          tz = normals[v + 1]!;
        }
        tangentLength = Math.hypot(tx, ty, tz) || 1;
      }
      tangents[tangent] = tx / tangentLength;
      tangents[tangent + 1] = ty / tangentLength;
      tangents[tangent + 2] = tz / tangentLength;
      tangents[tangent + 3] = mesh.tangents[tangent + 3]!;
    }
  }
  return {
    ...mesh,
    positions,
    normals,
    ...(tangents ? { tangents } : {}),
  };
}
