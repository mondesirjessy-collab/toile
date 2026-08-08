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
}

export interface MorphMarks {
  shoulderY: number;
  chestY: number;
  waistY: number;
  hipY: number;
  thighY: number;
}

export const NO_MORPH: Morphs = { stature: 1, carrure: 1, poitrine: 1, taille: 1, hanches: 1, cuisse: 1 };

export function isNeutral(m: Morphs): boolean {
  return (
    m.stature === 1 && m.carrure === 1 && m.poitrine === 1 && m.taille === 1 && m.hanches === 1 && m.cuisse === 1
  );
}

const bell = (dy: number, width: number): number => Math.exp(-((dy / width) ** 2));

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
      a: [p.a[0] * st * sa, ay, p.a[2] * st * sa] as V3,
      b: [p.b[0] * st * sb, by, p.b[2] * st * sb] as V3,
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
  const sMax = Math.max(m.carrure, m.poitrine, m.taille, m.hanches, m.cuisse, 1) * st;
  const min: [number, number, number] = [grid.min[0] * sMax, grid.min[1] * st, grid.min[2] * sMax];
  const max: [number, number, number] = [grid.max[0] * sMax, grid.max[1] * st, grid.max[2] * sMax];
  const [nx, ny, nz] = grid.dims;
  const src = gridSd(grid);
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + (k / (nz - 1)) * (max[2] - min[2]);
    for (let j = 0; j < ny; j++) {
      const y = min[1] + (j / (ny - 1)) * (max[1] - min[1]);
      const s = morphScale(y, m, marks) * st;
      for (let i = 0; i < nx; i++) {
        const x = min[0] + (i / (nx - 1)) * (max[0] - min[0]);
        // Conservative distance estimate under the warp: never overestimates,
        // so contacts trigger a hair early rather than late.
        data[(k * ny + j) * nx + i] = src(x / s, y / st, z / s) * Math.min(1, s, st);
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
    positions[v] = sourceX * s;
    positions[v + 1] = y;
    positions[v + 2] = sourceZ * s;

    // Exact inverse-transpose of F(x,y,z)=(s(y)x, stature*y, s(y)z).
    // Transforming source normals (instead of re-smoothing triangles) keeps
    // coincident vertices on opposite sides of a UV seam bit-identical.
    const epsilon = 1e-4;
    const scaleBefore = morphScale((sourceY - epsilon) * st, m, marks) * st;
    const scaleAfter = morphScale((sourceY + epsilon) * st, m, marks) * st;
    const derivative = (scaleAfter - scaleBefore) / (2 * epsilon);
    const safeScale = Math.max(1e-6, Math.abs(s));
    const safeStature = Math.max(1e-6, Math.abs(st));
    const nx = mesh.normals[v]! / safeScale;
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
      let ty = st * mesh.tangents[tangent + 1]!;
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
