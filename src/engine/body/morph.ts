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
  poitrine: number;
  taille: number;
  hanches: number;
}

export interface MorphMarks {
  chestY: number;
  waistY: number;
  hipY: number;
}

export const NO_MORPH: Morphs = { poitrine: 1, taille: 1, hanches: 1 };

export function isNeutral(m: Morphs): boolean {
  return m.poitrine === 1 && m.taille === 1 && m.hanches === 1;
}

const bell = (dy: number, width: number): number => Math.exp(-((dy / width) ** 2));

/** Radial (x,z) scale at height y for the given measurements. */
export function morphScale(y: number, m: Morphs, marks: MorphMarks): number {
  return (
    1 +
    (m.poitrine - 1) * bell(y - marks.chestY, 0.14) +
    (m.taille - 1) * bell(y - marks.waistY, 0.1) +
    (m.hanches - 1) * bell(y - marks.hipY, 0.13)
  );
}

/** Sculpted body: scale each primitive's lateral position and radii. */
export function morphPrims(prims: SdfPrim[], m: Morphs, marks: MorphMarks): SdfPrim[] {
  return prims.map((p) => {
    const sa = morphScale(p.a[1], m, marks);
    const sb = morphScale(p.b[1], m, marks);
    return {
      a: [p.a[0] * sa, p.a[1], p.a[2] * sa] as V3,
      b: [p.b[0] * sb, p.b[1], p.b[2] * sb] as V3,
      ra: p.ra * sa,
      rb: p.rb * sb,
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
  const sMax = Math.max(m.poitrine, m.taille, m.hanches, 1);
  const min: [number, number, number] = [grid.min[0] * sMax, grid.min[1], grid.min[2] * sMax];
  const max: [number, number, number] = [grid.max[0] * sMax, grid.max[1], grid.max[2] * sMax];
  const [nx, ny, nz] = grid.dims;
  const src = gridSd(grid);
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = min[2] + (k / (nz - 1)) * (max[2] - min[2]);
    for (let j = 0; j < ny; j++) {
      const y = min[1] + (j / (ny - 1)) * (max[1] - min[1]);
      const s = morphScale(y, m, marks);
      for (let i = 0; i < nx; i++) {
        const x = min[0] + (i / (nx - 1)) * (max[0] - min[0]);
        // Conservative distance estimate under the warp: never overestimates,
        // so contacts trigger a hair early rather than late.
        data[(k * ny + j) * nx + i] = src(x / s, y, z / s) * Math.min(1, s);
      }
    }
  }
  return { dims: [nx, ny, nz], min, max, data };
}

/** Scanned body: stretch the render mesh through the same warp. */
export function morphMesh(
  mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array },
  m: Morphs,
  marks: MorphMarks,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  for (let v = 0; v < mesh.positions.length; v += 3) {
    const y = mesh.positions[v + 1]!;
    const s = morphScale(y, m, marks);
    positions[v] = mesh.positions[v]! * s;
    positions[v + 1] = y;
    positions[v + 2] = mesh.positions[v + 2]! * s;
    // Normal of an (x,z)-scaled surface: divide lateral components by s.
    const nx = mesh.normals[v]! / s;
    const ny = mesh.normals[v + 1]!;
    const nz = mesh.normals[v + 2]! / s;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[v] = nx / l;
    normals[v + 1] = ny / l;
    normals[v + 2] = nz / l;
  }
  return { positions, normals, indices: mesh.indices };
}
