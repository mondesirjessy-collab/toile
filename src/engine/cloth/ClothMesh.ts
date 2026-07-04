/**
 * ClothMesh — CPU generation of a regular cloth grid and its distance-constraint
 * topology (brief §2 engine/cloth, §3.3 constraints). The engine never imports
 * Three.js: this produces raw typed arrays + a color-sorted constraint buffer
 * that the GPU solver uploads directly.
 *
 * Grid is laid out flat in the horizontal XZ plane at height `topY`. Pinning two
 * corners of the v = 0 edge lets gravity (perpendicular to the sheet) drape the
 * rest downward into a curved hanging cloth — the weeks 3-4 validation. A fully
 * triangulated grid pinned in its own vertical plane would instead start already
 * at equilibrium and never move, so the horizontal rest pose is deliberate.
 * Constraints:
 *   - structural: horizontal + vertical grid edges (stretch)
 *   - shear:      both diagonals of every cell
 */
import { colorConstraints, type Edge } from '../solver/ConstraintGraph';

export interface ClothMeshOptions {
  /** Particles per side; total = resolution². 64 → 4 096 (brief S1). */
  resolution: number;
  /** Physical side length in meters (brief §4: 1 m × 1 m). */
  size?: number;
  /** World Y of the top row. */
  topY?: number;
  /**
   * Pin mode for immovable particles (inverse mass 0). Anchors sit on the
   * v = 0 edge: 'corners' pins its two ends (cloth held at two corners),
   * 'edge' pins the whole edge (curtain hung from a rod).
   */
  pin?: 'corners' | 'edge' | 'none';
}

export interface ClothMeshData {
  readonly resolution: number;
  readonly count: number;
  /** count × 4 floats (xyz + unused w), grid rest pose. */
  readonly positions: Float32Array;
  /** count floats; 0 for pinned particles. */
  readonly invMasses: Float32Array;
  /** Packed constraints sorted by color: {i:u32, j:u32, rest:f32, _pad:f32}. */
  readonly constraintData: ArrayBuffer;
  readonly constraintCount: number;
  readonly colorOffsets: number[];
  readonly colorCounts: number[];
  /** Structural edge count (for the HUD); shear is the remainder. */
  readonly structuralCount: number;
}

const CONSTRAINT_STRIDE = 16; // bytes: 2×u32 + 2×f32

export function generateClothGrid(opts: ClothMeshOptions): ClothMeshData {
  const n = opts.resolution;
  const size = opts.size ?? 1.0;
  const topY = opts.topY ?? 1.8;
  const pin = opts.pin ?? 'corners';
  const count = n * n;

  const positions = new Float32Array(count * 4);
  const invMasses = new Float32Array(count);

  const index = (u: number, v: number): number => v * n + u;

  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const i = index(u, v);
      positions[i * 4 + 0] = (u / (n - 1) - 0.5) * size; // x, centered
      positions[i * 4 + 1] = topY; // flat, horizontal rest pose
      positions[i * 4 + 2] = (v / (n - 1) - 0.5) * size; // z, centered
      invMasses[i] = 1.0;
    }
  }

  // Pin immovable particles (inverse mass 0).
  const pinIndex = (i: number): void => {
    invMasses[i] = 0.0;
  };
  if (pin === 'corners') {
    pinIndex(index(0, 0));
    pinIndex(index(n - 1, 0));
  } else if (pin === 'edge') {
    for (let u = 0; u < n; u++) pinIndex(index(u, 0));
  }

  // --- Build distance constraints ---
  const dist = (a: number, b: number): number => {
    const dx = positions[a * 4 + 0]! - positions[b * 4 + 0]!;
    const dy = positions[a * 4 + 1]! - positions[b * 4 + 1]!;
    const dz = positions[a * 4 + 2]! - positions[b * 4 + 2]!;
    return Math.hypot(dx, dy, dz);
  };
  const edge = (a: number, b: number): Edge => ({ i: a, j: b, rest: dist(a, b) });

  const structural: Edge[] = [];
  const shear: Edge[] = [];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (u + 1 < n) structural.push(edge(index(u, v), index(u + 1, v))); // horizontal
      if (v + 1 < n) structural.push(edge(index(u, v), index(u, v + 1))); // vertical
      if (u + 1 < n && v + 1 < n) {
        shear.push(edge(index(u, v), index(u + 1, v + 1))); // ╲ diagonal
        shear.push(edge(index(u + 1, v), index(u, v + 1))); // ╱ diagonal
      }
    }
  }

  const all = structural.concat(shear);
  const { ordered, colorOffsets, colorCounts } = colorConstraints(all, count);

  // Pack color-sorted constraints for the GPU.
  const constraintData = new ArrayBuffer(ordered.length * CONSTRAINT_STRIDE);
  const dv = new DataView(constraintData);
  for (let k = 0; k < ordered.length; k++) {
    const c = ordered[k]!;
    const base = k * CONSTRAINT_STRIDE;
    dv.setUint32(base + 0, c.i, true);
    dv.setUint32(base + 4, c.j, true);
    dv.setFloat32(base + 8, c.rest, true);
    dv.setFloat32(base + 12, 0.0, true);
  }

  return {
    resolution: n,
    count,
    positions,
    invMasses,
    constraintData,
    constraintCount: ordered.length,
    colorOffsets,
    colorCounts,
    structuralCount: structural.length,
  };
}
