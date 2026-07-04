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
  /** Rest distance between grid neighbours (world units) — used by rendering. */
  readonly spacing: number;
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
  readonly seamCount: number;
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
    spacing: size / (n - 1),
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
    seamCount: 0,
    cornerIndices: [index(0, 0), index(n - 1, 0)],
    triangleIndices,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — seamed panels (the "sew" primitive).
// ---------------------------------------------------------------------------

export interface SeamedPanelsOptions {
  /** Particles per side of EACH panel; total = 2 × resolution². */
  resolution: number;
  /** Panel width in meters (tube circumference = 2 × width). */
  width?: number;
  /** Panel height in meters. */
  height?: number;
  /** Initial distance between the two panels (they start apart, seams pull them shut). */
  gap?: number;
  /** World Y of the top edge. */
  topY?: number;
  /**
   * Pattern outline. 'rect' keeps the full grid. 'aline' cuts an A-line dress
   * piece: fitted at the top, flared at the hem, with a scooped neckline that
   * leaves two shoulder straps.
   */
  shape?: 'rect' | 'aline';
}

/** True when grid cell (u,v) ∈ [0,1]² lies inside the A-line pattern piece. */
function alineShape(u: number, v: number): boolean {
  const x = Math.abs(u - 0.5);
  const halfWidth = 0.26 + (0.5 - 0.26) * v; // fitted top → full hem
  if (x > halfWidth) return false;
  // Elliptical neckline scoop, leaving straps on both sides.
  if (v < 0.14) {
    const scoop = 0.13 * Math.sqrt(1 - (v / 0.14) ** 2);
    if (x < scoop) return false;
  }
  return true;
}

/**
 * Two flat rectangular pattern pieces (front/back), vertical, facing each
 * other across `gap`, stitched along both side edges with near-zero rest
 * length "seam" constraints. When the sim starts, the seams pull the pieces
 * shut around whatever stands between them (the scene sphere): the CLO-style
 * garment-assembly moment. The tube then drapes as one garment.
 */
export function generateSeamedPanels(opts: SeamedPanelsOptions): ClothMeshData {
  const n = opts.resolution;
  const width = opts.width ?? 1.2;
  const height = opts.height ?? 1.2;
  const gap = opts.gap ?? 1.3;
  const topY = opts.topY ?? 1.9;
  const shape = opts.shape ?? 'rect';
  const panelSize = n * n;
  const count = 2 * panelSize;

  // Pattern mask: particles outside the outline are cut from the garment —
  // pinned (inverse mass 0), parked far below, referenced by no constraint or
  // triangle. Keeping the grid regular keeps the GPU normals pass trivial.
  const inside = (u: number, v: number): boolean =>
    shape === 'aline' ? alineShape(u / (n - 1), v / (n - 1)) : true;
  const kept = new Array<boolean>(panelSize);
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept[v * n + u] = inside(u, v);

  const positions = new Float32Array(count * 4);
  const invMasses = new Float32Array(count).fill(1.0);

  const index = (p: number, u: number, v: number): number => p * panelSize + v * n + u;
  // Same outline on both panels, so the panel index is irrelevant to the mask.
  const isKept = (_p: number, u: number, v: number): boolean => kept[v * n + u]!;

  for (let p = 0; p < 2; p++) {
    const z = (p === 0 ? 1 : -1) * (gap / 2);
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        const i = index(p, u, v);
        if (kept[v * n + u]) {
          positions[i * 4 + 0] = (u / (n - 1) - 0.5) * width;
          positions[i * 4 + 1] = topY - (v / (n - 1)) * height;
          positions[i * 4 + 2] = z;
        } else {
          // Cut from the pattern: parked out of the scene, immovable.
          positions[i * 4 + 0] = 0;
          positions[i * 4 + 1] = -10;
          positions[i * 4 + 2] = 0;
          invMasses[i] = 0;
        }
      }
    }
  }

  const dist = (a: number, b: number): number => {
    const dx = positions[a * 4 + 0]! - positions[b * 4 + 0]!;
    const dy = positions[a * 4 + 1]! - positions[b * 4 + 1]!;
    const dz = positions[a * 4 + 2]! - positions[b * 4 + 2]!;
    return Math.hypot(dx, dy, dz);
  };

  const structural: Edge[] = [];
  const shear: Edge[] = [];
  const bending: Edge[] = [];
  const seams: Edge[] = [];
  const edge = (a: number, b: number, kind: ConstraintKind): Edge => ({
    i: a,
    j: b,
    rest: dist(a, b),
    kind,
  });

  // In-panel constraints, identical topology to the single sheet, restricted
  // to particles inside the pattern (bending also requires the middle particle
  // so it never bridges across a cut).
  for (let p = 0; p < 2; p++) {
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        if (!isKept(p, u, v)) continue;
        if (u + 1 < n && isKept(p, u + 1, v))
          structural.push(edge(index(p, u, v), index(p, u + 1, v), ConstraintKind.Structural));
        if (v + 1 < n && isKept(p, u, v + 1))
          structural.push(edge(index(p, u, v), index(p, u, v + 1), ConstraintKind.Structural));
        if (u + 1 < n && v + 1 < n) {
          if (isKept(p, u + 1, v + 1))
            shear.push(edge(index(p, u, v), index(p, u + 1, v + 1), ConstraintKind.Shear));
          if (isKept(p, u + 1, v) && isKept(p, u, v + 1))
            shear.push(edge(index(p, u + 1, v), index(p, u, v + 1), ConstraintKind.Shear));
        }
        if (u + 2 < n && isKept(p, u + 1, v) && isKept(p, u + 2, v))
          bending.push(edge(index(p, u, v), index(p, u + 2, v), ConstraintKind.Bending));
        if (v + 2 < n && isKept(p, u, v + 1) && isKept(p, u, v + 2))
          bending.push(edge(index(p, u, v), index(p, u, v + 2), ConstraintKind.Bending));
      }
    }
  }

  // Side seams: stitch matching rows of both panels along the pattern's own
  // shaped edges (leftmost/rightmost kept particle per row).
  // Rest length ≈ the fabric spacing so the closed seam reads as one weave.
  const seamRest = width / (n - 1);
  for (let v = 0; v < n; v++) {
    let uMin = -1;
    let uMax = -1;
    for (let u = 0; u < n; u++) {
      if (kept[v * n + u]) {
        if (uMin < 0) uMin = u;
        uMax = u;
      }
    }
    if (uMin < 0) continue; // fully cut row
    seams.push({ i: index(0, uMin, v), j: index(1, uMin, v), rest: seamRest, kind: ConstraintKind.Seam });
    if (uMax !== uMin)
      seams.push({ i: index(0, uMax, v), j: index(1, uMax, v), rest: seamRest, kind: ConstraintKind.Seam });
  }

  // Shoulder seams (shaped pieces only): stitch the top edge of both panels so
  // the straps close over the shoulders and the garment hangs from them.
  if (shape !== 'rect') {
    for (let u = 0; u < n; u++) {
      if (kept[u]) // row v = 0
        seams.push({ i: index(0, u, 0), j: index(1, u, 0), rest: seamRest, kind: ConstraintKind.Seam });
    }
  }

  const all = structural.concat(shear, bending, seams);
  const { ordered, colorOffsets, colorCounts } = colorConstraints(all, count);

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

  // Triangles for both panels — a cell renders only if its 4 corners exist.
  const tris: number[] = [];
  for (let p = 0; p < 2; p++) {
    for (let v = 0; v < n - 1; v++) {
      for (let u = 0; u < n - 1; u++) {
        if (!isKept(p, u, v) || !isKept(p, u + 1, v) || !isKept(p, u, v + 1) || !isKept(p, u + 1, v + 1))
          continue;
        const i00 = index(p, u, v);
        const i10 = index(p, u + 1, v);
        const i01 = index(p, u, v + 1);
        const i11 = index(p, u + 1, v + 1);
        tris.push(i00, i01, i10, i10, i01, i11);
      }
    }
  }
  const triangleIndices = new Uint32Array(tris);

  // Anchor corners for the P-pin toggle: outermost kept particles of the
  // first non-empty row of the front panel.
  let cornerA = 0;
  let cornerB = 0;
  outer: for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (kept[v * n + u]) {
        cornerA = index(0, u, v);
        for (let u2 = n - 1; u2 >= 0; u2--) {
          if (kept[v * n + u2]) {
            cornerB = index(0, u2, v);
            break;
          }
        }
        break outer;
      }
    }
  }

  return {
    resolution: n,
    spacing: width / (n - 1),
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
    seamCount: seams.length,
    cornerIndices: [cornerA, cornerB],
    triangleIndices,
  };
}
