/**
 * ClothMesh — CPU generation of a regular cloth grid and its constraint topology
 * (brief §2 engine/cloth, §3.3 constraints). The engine never imports Three.js:
 * this produces raw typed arrays + a color-sorted constraint buffer that the GPU
 * solver uploads directly.
 *
 * Grid is laid out flat in the horizontal XZ plane at height `topY`. Left
 * unpinned it falls under gravity and drapes over the scene sphere (weeks 5-6);
 * pinning corners of the v = 0 edge instead holds it as a hanging cloth.
 * Constraints:
 *   - structural: horizontal + vertical grid edges (stretch, α ≈ 0 → rigid)
 *   - shear:      both diagonals of every cell (stretch compliance)
 *   - bending:    "skip-2" distance edges i↔i+2 (brief §3.3 Phase-0 alternative
 *                 to true dihedral bending), soft α_bend so the sheet folds
 */
import { colorConstraints, ConstraintKind, type Edge } from '../solver/ConstraintGraph';

export interface ClothMeshOptions {
  /** Particles per side; total = resolution². 64 → 4 096 (brief S1). */
  resolution: number;
  /** Physical side length in meters (brief §4: 1 m × 1 m). */
  size?: number;
  /** World Y of the rest plane. */
  topY?: number;
  /**
   * Pin mode for immovable particles (inverse mass 0). Anchors sit on the
   * v = 0 edge: 'corners' pins its two ends, 'edge' the whole edge, 'none'
   * leaves the sheet free to fall.
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
  /** Packed constraints sorted by color: {i:u32, j:u32, rest:f32, kind:u32}. */
  readonly constraintData: ArrayBuffer;
  readonly constraintCount: number;
  readonly colorOffsets: number[];
  readonly colorCounts: number[];
  /** Edge counts by kind (for the HUD and tests). */
  readonly structuralCount: number;
  readonly shearCount: number;
  readonly bendingCount: number;
  /** Indices of the two v=0 corners, for runtime pin/release. */
  readonly cornerIndices: [number, number];
  /** Triangle indices (2 per grid cell) for surface rendering. */
  readonly triangleIndices: Uint32Array;
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

  // --- Build constraints ---
  const dist = (a: number, b: number): number => {
    const dx = positions[a * 4 + 0]! - positions[b * 4 + 0]!;
    const dy = positions[a * 4 + 1]! - positions[b * 4 + 1]!;
    const dz = positions[a * 4 + 2]! - positions[b * 4 + 2]!;
    return Math.hypot(dx, dy, dz);
  };
  const edge = (a: number, b: number, kind: ConstraintKind): Edge => ({
    i: a,
    j: b,
    rest: dist(a, b),
    kind,
  });

  const structural: Edge[] = [];
  const shear: Edge[] = [];
  const bending: Edge[] = [];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (u + 1 < n) structural.push(edge(index(u, v), index(u + 1, v), ConstraintKind.Structural));
      if (v + 1 < n) structural.push(edge(index(u, v), index(u, v + 1), ConstraintKind.Structural));
      if (u + 1 < n && v + 1 < n) {
        shear.push(edge(index(u, v), index(u + 1, v + 1), ConstraintKind.Shear)); // ╲
        shear.push(edge(index(u + 1, v), index(u, v + 1), ConstraintKind.Shear)); // ╱
      }
      // Bending: skip-2 distance edges (brief §3.3 Phase-0 alternative).
      if (u + 2 < n) bending.push(edge(index(u, v), index(u + 2, v), ConstraintKind.Bending));
      if (v + 2 < n) bending.push(edge(index(u, v), index(u, v + 2), ConstraintKind.Bending));
    }
  }

  const all = structural.concat(shear, bending);
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
    dv.setUint32(base + 12, c.kind, true);
  }

  // Triangle indices for surface rendering: two triangles per grid cell.
  const triangleIndices = new Uint32Array((n - 1) * (n - 1) * 6);
  let ti = 0;
  for (let v = 0; v < n - 1; v++) {
    for (let u = 0; u < n - 1; u++) {
      const i00 = index(u, v);
      const i10 = index(u + 1, v);
      const i01 = index(u, v + 1);
      const i11 = index(u + 1, v + 1);
      triangleIndices[ti++] = i00;
      triangleIndices[ti++] = i01;
      triangleIndices[ti++] = i10;
      triangleIndices[ti++] = i10;
      triangleIndices[ti++] = i01;
      triangleIndices[ti++] = i11;
    }
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
    shearCount: shear.length,
    bendingCount: bending.length,
    cornerIndices: [index(0, 0), index(n - 1, 0)],
    triangleIndices,
  };
}
