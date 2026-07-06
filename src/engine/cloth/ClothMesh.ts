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
import {
  colorConstraints,
  colorQuads,
  ConstraintKind,
  type BendQuad,
  type Edge,
} from '../solver/ConstraintGraph';

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
  /** Packed dihedral bending hinges sorted by color: {e0,e1,w0,w1:u32, restAngle:f32, 3 pads}. */
  readonly quadData: ArrayBuffer;
  readonly quadCount: number;
  readonly quadColorOffsets: number[];
  readonly quadColorCounts: number[];
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
const QUAD_STRIDE = 32; // bytes: 4×u32 + f32 + 3 pads

/**
 * Dihedral bending hinges (brief §3.3, the "true" Phase-1 bending): one hinge
 * across every interior grid edge, joining the two adjacent triangles. Rest
 * angle measured on the rest pose (π when flat). Returns the hinges packed and
 * color-sorted for race-free GPU dispatches.
 */
function buildBendQuads(
  positions: Float32Array,
  panelCount: number,
  n: number,
  keptLocal: (u: number, v: number) => boolean,
): Pick<ClothMeshData, 'quadData' | 'quadCount' | 'quadColorOffsets' | 'quadColorCounts'> {
  const panelSize = n * n;
  const quads: BendQuad[] = [];

  const restAngle = (e0: number, e1: number, w0: number, w1: number): number | null => {
    const P = (i: number, k: number): number => positions[i * 4 + k]!;
    const p2 = [P(e1, 0) - P(e0, 0), P(e1, 1) - P(e0, 1), P(e1, 2) - P(e0, 2)];
    const p3 = [P(w0, 0) - P(e0, 0), P(w0, 1) - P(e0, 1), P(w0, 2) - P(e0, 2)];
    const p4 = [P(w1, 0) - P(e0, 0), P(w1, 1) - P(e0, 1), P(w1, 2) - P(e0, 2)];
    const cross = (a: number[], b: number[]): number[] => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!,
    ];
    const c23 = cross(p2, p3);
    const c24 = cross(p2, p4);
    const l23 = Math.hypot(c23[0]!, c23[1]!, c23[2]!);
    const l24 = Math.hypot(c24[0]!, c24[1]!, c24[2]!);
    if (l23 < 1e-9 || l24 < 1e-9) return null; // degenerate hinge
    const d =
      (c23[0]! * c24[0]! + c23[1]! * c24[1]! + c23[2]! * c24[2]!) / (l23 * l24);
    return Math.acos(Math.min(1, Math.max(-1, d)));
  };

  for (let p = 0; p < panelCount; p++) {
    const idx = (u: number, v: number): number => p * panelSize + v * n + u;
    const push = (e0: number, e1: number, w0: number, w1: number): void => {
      const angle = restAngle(e0, e1, w0, w1);
      if (angle !== null) quads.push({ e0, e1, w0, w1, restAngle: angle });
    };
    for (let v = 0; v < n - 1; v++) {
      for (let u = 0; u < n - 1; u++) {
        // Hinge across the vertical grid edge shared with the next cell right.
        if (
          u + 2 < n &&
          keptLocal(u, v + 1) &&
          keptLocal(u + 1, v) &&
          keptLocal(u + 1, v + 1) &&
          keptLocal(u + 2, v)
        ) {
          push(idx(u + 1, v), idx(u + 1, v + 1), idx(u, v + 1), idx(u + 2, v));
        }
        // Hinge across the horizontal grid edge shared with the cell below.
        if (
          v + 2 < n &&
          keptLocal(u + 1, v) &&
          keptLocal(u, v + 1) &&
          keptLocal(u + 1, v + 1) &&
          keptLocal(u, v + 2)
        ) {
          push(idx(u, v + 1), idx(u + 1, v + 1), idx(u + 1, v), idx(u, v + 2));
        }
      }
    }
  }

  const { ordered, colorOffsets, colorCounts } = colorQuads(
    quads,
    panelCount * panelSize,
  );
  const quadData = new ArrayBuffer(ordered.length * QUAD_STRIDE);
  const dv = new DataView(quadData);
  for (let k = 0; k < ordered.length; k++) {
    const q = ordered[k]!;
    const base = k * QUAD_STRIDE;
    dv.setUint32(base + 0, q.e0, true);
    dv.setUint32(base + 4, q.e1, true);
    dv.setUint32(base + 8, q.w0, true);
    dv.setUint32(base + 12, q.w1, true);
    dv.setFloat32(base + 16, q.restAngle, true);
  }
  return {
    quadData,
    quadCount: ordered.length,
    quadColorOffsets: colorOffsets,
    quadColorCounts: colorCounts,
  };
}

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
      // Bending is handled by true dihedral hinges (buildBendQuads), phase 1.
    }
  }

  const all = structural.concat(shear, bending);
  const { ordered, colorOffsets, colorCounts } = colorConstraints(all, count);
  const quads = buildBendQuads(positions, 1, n, () => true);

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
    ...quads,
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
   * leaves two shoulder straps. 'tshirt' cuts a kimono tee: body and short
   * sleeves in one T-shaped piece, with a neck scoop. 'skirt' cuts a flared
   * skirt piece: snug waist, open top and hem. 'setin' cuts a cutting-layout of
   * THREE pieces — body plus two separate sleeves beside it — whose armhole
   * edges are stitched together at assembly time (set-in sleeves).
   */
  shape?: 'rect' | 'aline' | 'tshirt' | 'skirt' | 'setin' | 'pants';
  /** Pattern measurements (grading): shape-specific, all in normalized [0,1] pattern units. */
  shapeParams?: { hem?: number; scoop?: number; sleeve?: number; profile?: number[] };
}

type PatternShape = NonNullable<SeamedPanelsOptions['shape']>;
type ShapeParams = NonNullable<SeamedPanelsOptions['shapeParams']>;

/** True when (u,v) ∈ [0,1]² lies inside the kimono-tee pattern piece: body
 * column plus sleeve bands angled downward to follow the mannequin's A-pose
 * arms, with a neck scoop at the top. */
function tshirtShape(u: number, v: number): boolean {
  const x = Math.abs(u - 0.5);
  const bodyHalf = 0.24;
  if (x <= bodyHalf) {
    // Neck scoop.
    if (v < 0.09) {
      const scoop = 0.11 * Math.sqrt(1 - (v / 0.09) ** 2);
      if (x < scoop) return false;
    }
    return true;
  }
  // Sleeve: a band sloping down as it leaves the body, matching the arm pose.
  const drop = 0.75 * (x - bodyHalf);
  return v >= drop && v <= drop + 0.34;
}

/** True when (u,v) ∈ [0,1]² lies inside the flared-skirt pattern piece.
 * Parametric: `hem` = half-width at the hem (flare). */
function skirtShape(u: number, v: number, p: ShapeParams = {}): boolean {
  const x = Math.abs(u - 0.5);
  // Drafted silhouette when present; otherwise snug waist → flared hem.
  if (p.profile && p.profile.length >= 2) return x <= sideHalfWidth(v, p);
  const hem = p.hem ?? 0.46;
  return x <= 0.22 + (hem - 0.22) * v;
}

/**
 * Set-in tee cutting layout: three islands on one pattern sheet — the body in
 * the middle (neck scoop), and two separate sleeve pieces beside it. The
 * armhole edges get stitched island-to-island at assembly.
 */
function setinShape(u: number, v: number, p: ShapeParams = {}): boolean {
  const sleeveEnd = p.sleeve ?? 0.47; // outer sleeve bound = sleeve length
  const x = Math.abs(u - 0.5);
  // The armhole zone (v ≤ 0.36) keeps its 0.22 edge — the island-to-island
  // seams and opening bands are anchored there. Below it, the body side seam
  // is a drafted curve (profile anchors span v ∈ [0.36, 1]).
  const bodyEdge =
    p.profile && p.profile.length >= 2 && v > 0.36
      ? sideHalfWidth((v - 0.36) / 0.64, { profile: p.profile })
      : 0.22;
  if (x <= bodyEdge) {
    // Body, with a neck scoop.
    if (v < 0.09) {
      const scoop = 0.1 * Math.sqrt(1 - (v / 0.09) ** 2);
      if (x < scoop) return false;
    }
    return true;
  }
  // Sleeves: separate pieces across a cutting gap, shoulder-height band only.
  return x > 0.27 && x <= sleeveEnd && v >= 0.02 && v <= 0.34;
}

/**
 * Openings of a shaped garment — boundary regions that must NOT be seamed
 * (where the body enters/exits: neckline, waist, hem, sleeve ends).
 */
/**
 * Trouser front/back piece: one yoke from waist to crotch, then two legs.
 * The mirror seams derive everything a real pair needs from the boundary:
 * outseams (outer edges), INSEAMS (the cut between the legs) and the crotch
 * curve — while the waist and the two leg hems stay open.
 */
function pantsShape(u: number, v: number): boolean {
  const x = Math.abs(u - 0.5);
  if (v <= 0.3) return x <= 0.27 + (0.42 - 0.27) * (v / 0.3); // yoke: waist → hip
  const t = (v - 0.3) / 0.7;
  const outer = 0.42 + (0.22 - 0.42) * t; // outseam taper to the ankle
  const inner = 0.06 + (0.08 - 0.06) * t; // inseam: the slot between the legs
  return x >= inner && x <= outer;
}

function isOpening(shape: PatternShape, uu: number, vv: number, p: ShapeParams = {}): boolean {
  const x = Math.abs(uu - 0.5);
  if (vv > 0.97) return true; // hem
  if (shape === 'aline') return vv < 0.13 && x < (p.scoop ?? 0.1) + 0.02; // neckline
  if (shape === 'tshirt') {
    if (vv < 0.1 && x < 0.12) return true; // neckline
    if (x > 0.48) return true; // sleeve ends (the arm comes out here)
  }
  if (shape === 'skirt') return vv < 0.04; // waist
  if (shape === 'pants') return vv < 0.04; // waist (leg hems via the vv > 0.97 rule)
  if (shape === 'setin') {
    if (vv < 0.1 && x < 0.11) return true; // neckline
    if (x > (p.sleeve ?? 0.47) - 0.02) return true; // sleeve cuffs
    // Armhole edges (body side + sleeve inner end) are sewn island-to-island,
    // not front-to-back — keep them out of the mirror seams.
    if (vv < 0.36 && ((x >= 0.2 && x <= 0.24) || (x >= 0.255 && x <= 0.3))) return true;
  }
  return false;
}

/** True when grid cell (u,v) ∈ [0,1]² lies inside the A-line pattern piece.
 * Parametric (grading): `hem` = half-width at the hem, `scoop` = neckline
 * half-width — the seed of pattern editing. */
/**
 * Side-seam half-width at height v. Default: straight grade from the fitted
 * top to the hem. With `profile`, the SILHOUETTE IS FREE-FORM: the array
 * holds the half-width at evenly spaced v-stations (pattern drafting: the
 * user sculpts the side seam point by point; linear between stations).
 */
export function sideHalfWidth(v: number, p: ShapeParams): number {
  const prof = p.profile;
  if (prof && prof.length >= 2) {
    // Smooth curve THROUGH the stations — the drafter's French curve. Monotone
    // cubic (Fritsch–Carlson): C¹ smooth, passes exactly through every drawn
    // point, and NEVER overshoots between two stations (a Bézier/Catmull-Rom
    // would ring past a pinched waist and cut fabric the user never drew).
    const n = prof.length;
    const t = Math.min(1, Math.max(0, v)) * (n - 1);
    const k = Math.min(n - 2, Math.floor(t));
    const u = t - k;
    const d = (i: number): number => prof[i + 1]! - prof[i]!; // uniform h = 1
    const slope = (i: number): number => {
      if (i <= 0) return d(0);
      if (i >= n - 1) return d(n - 2);
      const a = d(i - 1);
      const b = d(i);
      return a * b > 0 ? (2 * a * b) / (a + b) : 0; // harmonic mean, 0 at extrema
    };
    const y0 = prof[k]!;
    const y1 = prof[k + 1]!;
    const m0 = slope(k);
    const m1 = slope(k + 1);
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1
    );
  }
  const hem = p.hem ?? 0.5;
  return 0.21 + (hem - 0.21) * v;
}

function alineShape(u: number, v: number, p: ShapeParams = {}): boolean {
  const scoopW = p.scoop ?? 0.1;
  const x = Math.abs(u - 0.5);
  // Fitted top → hem (or a free-form drafted silhouette). The top stays
  // narrow so the neck opening ring is smaller than the shoulder span —
  // otherwise the dress slips off over time (a genuine pattern-fitting bug
  // found by the sim itself).
  if (x > sideHalfWidth(v, p)) return false;
  // Elliptical neckline scoop, leaving straps close to the neck.
  if (v < 0.12) {
    const scoop = scoopW * Math.sqrt(1 - (v / 0.12) ** 2);
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
  const shapeParams = opts.shapeParams ?? {};
  const panelSize = n * n;
  const count = 2 * panelSize;

  // Pattern mask: particles outside the outline are cut from the garment —
  // pinned (inverse mass 0), parked far below, referenced by no constraint or
  // triangle. Keeping the grid regular keeps the GPU normals pass trivial.
  const insideUV = (uu: number, vv: number): boolean => {
    if (shape === 'aline') return alineShape(uu, vv, shapeParams);
    if (shape === 'tshirt') return tshirtShape(uu, vv);
    if (shape === 'skirt') return skirtShape(uu, vv, shapeParams);
    if (shape === 'setin') return setinShape(uu, vv, shapeParams);
    if (shape === 'pants') return pantsShape(uu, vv);
    return true;
  };
  const inside = (u: number, v: number): boolean => insideUV(u / (n - 1), v / (n - 1));
  const kept = new Array<boolean>(panelSize);
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept[v * n + u] = inside(u, v);

  // Smooth cut edges: boundary particles slide onto the exact pattern curve
  // (bisecting inside/outside toward each cut neighbour), so the outline is a
  // clean line instead of a grid staircase. Rest lengths are derived from the
  // adjusted positions, keeping the weave consistent.
  const uAdj = new Float32Array(panelSize);
  const vAdj = new Float32Array(panelSize);
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      uAdj[v * n + u] = u / (n - 1);
      vAdj[v * n + u] = v / (n - 1);
    }
  }
  if (shape !== 'rect') {
    const crossing = (u0: number, v0: number, u1: number, v1: number): [number, number] => {
      let a = 0;
      let b = 1;
      for (let it = 0; it < 10; it++) {
        const m = (a + b) / 2;
        if (insideUV(u0 + (u1 - u0) * m, v0 + (v1 - v0) * m)) a = m;
        else b = m;
      }
      const t = (a + b) / 2;
      return [u0 + (u1 - u0) * t, v0 + (v1 - v0) * t];
    };
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        if (!kept[v * n + u]) continue;
        const u0 = u / (n - 1);
        const v0 = v / (n - 1);
        let sumU = 0;
        let sumV = 0;
        let cuts = 0;
        for (const [du, dv2] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const u1 = u + du;
          const v1 = v + dv2;
          if (u1 < 0 || u1 >= n || v1 < 0 || v1 >= n) continue;
          if (kept[v1 * n + u1]) continue;
          const [cu, cv] = crossing(u0, v0, u1 / (n - 1), v1 / (n - 1));
          sumU += cu;
          sumV += cv;
          cuts++;
        }
        if (cuts > 0) {
          uAdj[v * n + u] = sumU / cuts;
          vAdj[v * n + u] = sumV / cuts;
        }
      }
    }
  }

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
        const local = v * n + u;
        if (kept[local]) {
          positions[i * 4 + 0] = (uAdj[local]! - 0.5) * width;
          positions[i * 4 + 1] = topY - vAdj[local]! * height;
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
        // In-panel bending is handled by true dihedral hinges (buildBendQuads).
      }
    }
  }

  // Seams stitch the two panels along their edges, the way a garment is sewn.
  // Rest length well under the fabric spacing: a sewn seam has no play — the
  // two pieces touch (self-collision excludes mirror pairs so it can close).
  const gridSpacing = width / (n - 1);
  const seamRest = gridSpacing * 0.15;
  if (shape === 'rect') {
    // Plain tube: side seams only (leftmost/rightmost of each row), top open.
    for (let v = 0; v < n; v++) {
      let uMin = -1;
      let uMax = -1;
      for (let u = 0; u < n; u++) {
        if (kept[v * n + u]) {
          if (uMin < 0) uMin = u;
          uMax = u;
        }
      }
      if (uMin < 0) continue;
      seams.push({ i: index(0, uMin, v), j: index(1, uMin, v), rest: seamRest, kind: ConstraintKind.Seam });
      if (uMax !== uMin)
        seams.push({ i: index(0, uMax, v), j: index(1, uMax, v), rest: seamRest, kind: ConstraintKind.Seam });
    }
  } else {
    // Shaped garment: stitch the ENTIRE cut boundary of the pattern — except
    // the openings (neckline, hem, sleeve ends) where the body passes through.
    // A particle is on the boundary when a 4-neighbour is missing or cut.
    const onBoundary = (u: number, v: number): boolean =>
      u === 0 ||
      u === n - 1 ||
      v === 0 ||
      v === n - 1 ||
      !kept[v * n + (u - 1)] ||
      !kept[v * n + (u + 1)] ||
      !kept[(v - 1) * n + u] ||
      !kept[(v + 1) * n + u];
    // Cross-seam flattening: for cells one ring inside a stitched edge, a soft
    // bending constraint ties front↔back at the flat-continuation distance
    // (2 × spacing), so the fabric behaves as if continuous through the seam —
    // a smooth ridge instead of a pinched, gaping fold.
    const flattened = new Set<number>();
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        if (!kept[v * n + u]) continue;
        if (!onBoundary(u, v)) continue;
        if (isOpening(shape, u / (n - 1), v / (n - 1), shapeParams)) continue;
        seams.push({ i: index(0, u, v), j: index(1, u, v), rest: seamRest, kind: ConstraintKind.Seam });
        for (const [du, dv2] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const u2 = u + du;
          const v2 = v + dv2;
          if (u2 < 0 || u2 >= n || v2 < 0 || v2 >= n) continue;
          const local = v2 * n + u2;
          if (!kept[local] || flattened.has(local)) continue;
          flattened.add(local);
          bending.push({
            i: index(0, u2, v2),
            j: index(1, u2, v2),
            rest: 2 * gridSpacing,
            kind: ConstraintKind.Bending,
          });
        }
      }
    }

    // Island-to-island armhole seams (set-in sleeves): on each row, stitch the
    // body's side edge to the facing sleeve's inner edge, on both panels.
    if (shape === 'setin') {
      for (let v = 0; v < n; v++) {
        // Collect the row's kept runs [start, end].
        const runs: Array<[number, number]> = [];
        let start = -1;
        for (let u = 0; u <= n; u++) {
          const k = u < n && kept[v * n + u];
          if (k && start < 0) start = u;
          else if (!k && start >= 0) {
            runs.push([start, u - 1]);
            start = -1;
          }
        }
        if (runs.length < 3) continue; // no sleeves on this row
        const sleeveL = runs[0]!;
        const sleeveR = runs[runs.length - 1]!;
        const bodyLeftEdge = runs[1]![0];
        const bodyRightEdge = runs[runs.length - 2]![1];
        for (let p = 0; p < 2; p++) {
          seams.push({
            i: index(p, sleeveL[1], v), // left sleeve inner end
            j: index(p, bodyLeftEdge, v),
            rest: seamRest,
            kind: ConstraintKind.Seam,
          });
          seams.push({
            i: index(p, bodyRightEdge, v),
            j: index(p, sleeveR[0], v), // right sleeve inner end
            rest: seamRest,
            kind: ConstraintKind.Seam,
          });
        }
      }
    }
  }

  const all = structural.concat(shear, bending, seams);
  const { ordered, colorOffsets, colorCounts } = colorConstraints(all, count);
  const quads = buildBendQuads(positions, 2, n, (u, v) => kept[v * n + u]!);

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

  // Triangles for both panels: full cells render two triangles, and boundary
  // cells with exactly three kept corners render one — otherwise the cut edge
  // shows a sawtooth of missing half-cells.
  const tris: number[] = [];
  for (let p = 0; p < 2; p++) {
    for (let v = 0; v < n - 1; v++) {
      for (let u = 0; u < n - 1; u++) {
        const k00 = isKept(p, u, v);
        const k10 = isKept(p, u + 1, v);
        const k01 = isKept(p, u, v + 1);
        const k11 = isKept(p, u + 1, v + 1);
        const i00 = index(p, u, v);
        const i10 = index(p, u + 1, v);
        const i01 = index(p, u, v + 1);
        const i11 = index(p, u + 1, v + 1);
        const keptCount = Number(k00) + Number(k10) + Number(k01) + Number(k11);
        if (keptCount === 4) {
          tris.push(i00, i01, i10, i10, i01, i11);
        } else if (keptCount === 3) {
          if (!k11) tris.push(i00, i01, i10);
          else if (!k10) tris.push(i00, i01, i11);
          else if (!k01) tris.push(i00, i11, i10);
          else tris.push(i10, i01, i11);
        }
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
    ...quads,
    structuralCount: structural.length,
    shearCount: shear.length,
    bendingCount: bending.length,
    seamCount: seams.length,
    cornerIndices: [cornerA, cornerB],
    triangleIndices,
  };
}

// ---------------------------------------------------------------------------
// Outfits — several garments in ONE simulation.
// ---------------------------------------------------------------------------

/**
 * Merge two garments into a single ClothMeshData (an outfit). Particle indices
 * of `b` are offset past `a`, and the constraints of both are re-colored
 * TOGETHER so the GPU solve stays race-free across the whole outfit.
 * Both garments must share the same per-panel resolution (the renderer's
 * normals pass assumes uniform n×n panels).
 */
export function combineClothMeshes(a: ClothMeshData, b: ClothMeshData): ClothMeshData {
  if (a.resolution !== b.resolution) {
    throw new Error('combineClothMeshes: garments must share the same resolution');
  }
  const count = a.count + b.count;

  const positions = new Float32Array(count * 4);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.count * 4);
  const invMasses = new Float32Array(count);
  invMasses.set(a.invMasses, 0);
  invMasses.set(b.invMasses, a.count);

  // Decode both constraint buffers, offset b, re-color the union.
  const decode = (mesh: ClothMeshData, offset: number): Edge[] => {
    const dv = new DataView(mesh.constraintData);
    const edges: Edge[] = [];
    for (let k = 0; k < mesh.constraintCount; k++) {
      edges.push({
        i: dv.getUint32(k * 16, true) + offset,
        j: dv.getUint32(k * 16 + 4, true) + offset,
        rest: dv.getFloat32(k * 16 + 8, true),
        kind: dv.getUint32(k * 16 + 12, true) as ConstraintKind,
      });
    }
    return edges;
  };
  const all = decode(a, 0).concat(decode(b, a.count));
  const { ordered, colorOffsets, colorCounts } = colorConstraints(all, count);

  const constraintData = new ArrayBuffer(ordered.length * CONSTRAINT_STRIDE);
  const dv = new DataView(constraintData);
  for (let k = 0; k < ordered.length; k++) {
    const c = ordered[k]!;
    dv.setUint32(k * 16, c.i, true);
    dv.setUint32(k * 16 + 4, c.j, true);
    dv.setFloat32(k * 16 + 8, c.rest, true);
    dv.setUint32(k * 16 + 12, c.kind, true);
  }

  // Dihedral hinges: decode both, offset b, re-color the union.
  const decodeQuads = (mesh: ClothMeshData, offset: number): BendQuad[] => {
    const dv2 = new DataView(mesh.quadData);
    const out: BendQuad[] = [];
    for (let k = 0; k < mesh.quadCount; k++) {
      const base = k * QUAD_STRIDE;
      out.push({
        e0: dv2.getUint32(base, true) + offset,
        e1: dv2.getUint32(base + 4, true) + offset,
        w0: dv2.getUint32(base + 8, true) + offset,
        w1: dv2.getUint32(base + 12, true) + offset,
        restAngle: dv2.getFloat32(base + 16, true),
      });
    }
    return out;
  };
  const allQuads = decodeQuads(a, 0).concat(decodeQuads(b, a.count));
  const quadColoring = colorQuads(allQuads, count);
  const quadData = new ArrayBuffer(quadColoring.ordered.length * QUAD_STRIDE);
  const qdv = new DataView(quadData);
  for (let k = 0; k < quadColoring.ordered.length; k++) {
    const q = quadColoring.ordered[k]!;
    const base = k * QUAD_STRIDE;
    qdv.setUint32(base, q.e0, true);
    qdv.setUint32(base + 4, q.e1, true);
    qdv.setUint32(base + 8, q.w0, true);
    qdv.setUint32(base + 12, q.w1, true);
    qdv.setFloat32(base + 16, q.restAngle, true);
  }

  const triangleIndices = new Uint32Array(a.triangleIndices.length + b.triangleIndices.length);
  triangleIndices.set(a.triangleIndices, 0);
  for (let t = 0; t < b.triangleIndices.length; t++) {
    triangleIndices[a.triangleIndices.length + t] = b.triangleIndices[t]! + a.count;
  }

  return {
    resolution: a.resolution,
    spacing: Math.max(a.spacing, b.spacing),
    count,
    positions,
    invMasses,
    constraintData,
    constraintCount: ordered.length,
    colorOffsets,
    colorCounts,
    quadData,
    quadCount: quadColoring.ordered.length,
    quadColorOffsets: quadColoring.colorOffsets,
    quadColorCounts: quadColoring.colorCounts,
    structuralCount: a.structuralCount + b.structuralCount,
    shearCount: a.shearCount + b.shearCount,
    bendingCount: a.bendingCount + b.bendingCount,
    seamCount: a.seamCount + b.seamCount,
    cornerIndices: a.cornerIndices,
    triangleIndices,
  };
}
