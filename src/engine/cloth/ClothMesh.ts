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
  type ConstraintPhaseColorRanges,
  type Edge,
} from '../solver/ConstraintGraph';
import { pointInPolygon, pointInTriangle, type UV } from '../pattern/Draft';

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
  /** Rest distance between HORIZONTAL grid neighbours (world units). */
  readonly spacing: number;
  /**
   * Rest distance between VERTICAL grid neighbours. Garment grids are
   * anisotropic (width ≠ height over the same n×n) — strain, prints and
   * exported UVs each need the axis-correct rest length, not one for both.
   */
  readonly spacingV: number;
  /**
   * The SECOND garment's rest spacing in a combined outfit (garment ≥ 1) — the
   * two pieces usually differ (a tee is coarser than the skirt it's worn with),
   * so prints and exported UVs pick per-garment to keep a check square on both.
   * Absent = single garment (garment 0 spacing applies throughout).
   */
  readonly spacing2?: number;
  readonly spacingV2?: number;
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
  /** Ordered color phases; regular seams can be replayed without pockets. */
  readonly constraintColorPhases: ConstraintPhaseColorRanges;
  /** Packed hinges: {e0,e1,w0,w1:u32, restAngle, softness, warpWeight, baseRestAngle:f32}. */
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
  /**
   * Per-particle garment layer (0 = against the body, 1 = worn over layer 0…).
   * The solver pushes layer L out to thickness + L × gap, so stacked garments
   * settle in dressing order instead of fighting for the same surface.
   * Absent = all zero (single garment).
   */
  readonly layers?: Float32Array;
  /**
   * Per-particle fabric material. 0 inherits the live global fabric; 1…7 map
   * to the stable preset order in FabricMaterial. Optional keeps legacy meshes
   * and non-atelier scenes on the global material without extra authoring data.
   */
  readonly materialIds?: Uint32Array;
  /**
   * Pocket/appliqué contact membership. Low 16 bits mark support regions;
   * high 16 bits mark their matching overlays. Only opposite roles sharing a
   * bit receive the thin surface-contact distance in self-collision.
   */
  readonly surfaceMasks?: Uint32Array;
  /**
   * Packed one-sided pocket contacts:
   * {support, tangentA, tangentB, overlay:u32, weights.xyz, active:f32}. The
   * live triangle and barycentric weights rebuild the exact authored support
   * point on the GPU. An open pocket activates a sparse physical manifold:
   * one interior sample per support triangle plus its open boundary. Contact
   * stays unilateral and never tethers or changes tangential motion.
   */
  readonly surfaceContactData?: ArrayBuffer;
  readonly surfaceContactCount?: number;
  /**
   * Particles stitched across garments (cross-seams) plus their first ring:
   * self-collision must not repel them — the seam legitimately holds them
   * closer than min_dist, and fighting it every substep shakes the garment
   * loose (the gathered bodice slid off exactly this way). 1 = exempt.
   */
  readonly seamFree?: Uint8Array;
  /**
   * Grid-hop distance from the nearest sewn boundary cell, per particle,
   * clamped to 3 (0 = on a seam, 3 = far). Self-collision's cross-panel mirror
   * exclusion applies only where BOTH particles are ≤ 2 hops from a seam — so a
   * sewn edge can still close, but an interior front↔back mirror contact (a
   * body-free tube collapsing flat) is repelled instead of tunnelling (M3).
   */
  readonly seamDist?: Uint8Array;
  /**
   * Per-particle waistband anchor: target world-Y the solver softly pulls the
   * particle toward (x/z free). Sentinel ≤ -1e8 = not anchored. Absent = none.
   */
  readonly anchorY?: Float32Array;
  /**
   * Optional dressing-only anchor lifetime. When present, the waistband hold
   * stays active for this many simulated seconds, then fades out; absent means
   * the historical permanent hold used by strapless garments.
   */
  readonly anchorReleaseSeconds?: number;
  /**
   * Optional soft-start duration for regular assembly seams. During this
   * dressing interval the solver tightens stitches progressively, preventing
   * a multi-piece garment from converting that residual placement distance
   * into a first-frame impact. Surface top-stitches are unaffected.
   */
  readonly seamDressingSeconds?: number;
  /**
   * v198 — le document porte une fermeture éclair OUVERTE : l'habillage se
   * fait toujours FERMÉ (stable), puis le solveur débraye les coutures
   * ZipperSeam une fois le montage posé (~3 s simulées) et les rubans
   * s'écartent depuis l'état porté.
   */
  readonly zipperInitiallyOpen?: boolean;
}

const CONSTRAINT_STRIDE = 16; // bytes: 2×u32 + 2×f32
const QUAD_STRIDE = 32; // bytes: 4×u32 + restAngle + softness + warpWeight + baseRestAngle
const SURFACE_CONTACT_STRIDE = 32;

/**
 * Put an independently generated piece on the same particle-mass scale as its
 * reference garment.
 *
 * Every editable piece uses the same n×n grid. Without an area correction, a
 * 19×24 cm pocket therefore contains almost as much solver mass as a full
 * shirt panel. Inverse mass must grow when the physical cell area shrinks.
 * Material density is applied later by ParticleSystem, so both factors compose.
 *
 * Returns the applied factor for diagnostics/tests. Cut particles remain zero.
 */
export function scaleMeshInverseMassesToReferenceCellArea(
  mesh: ClothMeshData,
  referenceCellArea: number,
): number {
  const cellArea = mesh.spacing * mesh.spacingV;
  if (
    !Number.isFinite(referenceCellArea) ||
    referenceCellArea <= 0 ||
    !Number.isFinite(cellArea) ||
    cellArea <= 0
  ) {
    return 1;
  }
  const factor = Math.max(
    1 / 4096,
    Math.min(4096, referenceCellArea / cellArea),
  );
  for (let i = 0; i < mesh.invMasses.length; i++) {
    const inverseMass = mesh.invMasses[i]!;
    if (inverseMass > 0) mesh.invMasses[i] = inverseMass * factor;
  }
  return factor;
}

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
  keptLocal: (p: number, u: number, v: number) => boolean,
  extra: BendQuad[] = [],
): Pick<ClothMeshData, 'quadData' | 'quadCount' | 'quadColorOffsets' | 'quadColorCounts'> {
  const panelSize = n * n;
  const quads: BendQuad[] = [...extra];

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
    const push = (e0: number, e1: number, w0: number, w1: number, warpWeight: number): void => {
      const angle = restAngle(e0, e1, w0, w1);
      if (angle !== null) quads.push({ e0, e1, w0, w1, restAngle: angle, softness: 1, warpWeight });
    };
    for (let v = 0; v < n - 1; v++) {
      for (let u = 0; u < n - 1; u++) {
        // Hinge across the vertical grid edge shared with the next cell right.
        if (
          u + 2 < n &&
          keptLocal(p, u, v + 1) &&
          keptLocal(p, u + 1, v) &&
          keptLocal(p, u + 1, v + 1) &&
          keptLocal(p, u + 2, v)
        ) {
          // Shared edge is vertical: curvature crosses the weft.
          push(idx(u + 1, v), idx(u + 1, v + 1), idx(u, v + 1), idx(u + 2, v), 0);
        }
        // Hinge across the horizontal grid edge shared with the cell below.
        if (
          v + 2 < n &&
          keptLocal(p, u + 1, v) &&
          keptLocal(p, u, v + 1) &&
          keptLocal(p, u + 1, v + 1) &&
          keptLocal(p, u, v + 2)
        ) {
          // Shared edge is horizontal: curvature runs along the warp/grain.
          push(idx(u, v + 1), idx(u + 1, v + 1), idx(u + 1, v), idx(u, v + 2), 1);
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
    dv.setFloat32(base + 20, q.softness ?? 1, true);
    dv.setFloat32(base + 24, q.warpWeight ?? 0.5, true);
    dv.setFloat32(base + 28, q.baseRestAngle ?? q.restAngle, true);
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
      if (v + 1 < n) structural.push(edge(index(u, v), index(u, v + 1), ConstraintKind.StructuralWarp));
      if (u + 1 < n && v + 1 < n) {
        shear.push(edge(index(u, v), index(u + 1, v + 1), ConstraintKind.Shear)); // ╲
        shear.push(edge(index(u + 1, v), index(u, v + 1), ConstraintKind.Shear)); // ╱
      }
      // Bending is handled by true dihedral hinges (buildBendQuads), phase 1.
    }
  }

  const all = structural.concat(shear, bending);
  const { ordered, colorOffsets, colorCounts, phaseColorRanges } = colorConstraints(all, count);
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
    spacingV: size / (n - 1), // the plain sheet is square
    count,
    positions,
    invMasses,
    constraintData,
    constraintCount: ordered.length,
    colorOffsets,
    colorCounts,
    constraintColorPhases: phaseColorRanges,
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
  shape?: 'rect' | 'aline' | 'tshirt' | 'skirt' | 'setin' | 'pants' | 'freeform';
  /** Pattern measurements (grading): shape-specific, all in normalized [0,1] pattern units. */
  shapeParams?: {
    hem?: number;
    scoop?: number;
    sleeve?: number;
    profile?: number[];
    neck?: number;
    /** Sleeveless A-line armhole depth, as a fraction of pattern height. */
    armhole?: number;
  };
  /**
   * Flatten ring around mirror seams (default true): a Bending spring per
   * seamed cell holding the two panels ~2·spacing apart just INSIDE the seam,
   * so a sewn hem/side lies flat like a pressed edge. Pass false for a piece
   * meant to WRAP (a sleeve tube): the rings pin the tube's side seams flat
   * and the mouth can never open around the arm — the tube slides off instead
   * of swallowing it (isolated by a numeric mesh diff: rect vs freeform tubes
   * differed ONLY by these springs, and only the rect tube held the arm).
   */
  flattenSeams?: boolean;
  /**
   * FREEFORM piece (shape==='freeform', the "atelier" editor): an arbitrary
   * outline polygon in [0,1]² UV, minus dart wedges cut from it. Rasterized to
   * the same kept-mask every archetype produces, so all downstream machinery
   * (edge-snap, mirror seams, seamDist, triangulation) is reused unchanged.
   */
  mask?: {
    outline: UV[];
    darts: { apex: UV; legA: UV; legB: UV }[];
    /** ⌾ Trous : polygones fermés soustraits du masque (cellules évidées). */
    holes?: readonly (readonly UV[])[];
  };
  /**
   * Extra front↔back Seam edges beyond the automatic mirror seams: LOCAL
   * front-panel cell indices (v·n+u), mirrored to the back panel internally.
   * Dart legs and hand-defined seams are emitted here. Registered in the seam
   * cell set so seamDist/seamFree cover them (else self-collision fights them).
   */
  extraSeams?: readonly { i: number; j: number }[];
  /**
   * Freeform openings: a UV predicate marking boundary runs to EXCLUDE from the
   * automatic mirror seam (necklines, hems, hand-seam/dart runs the caller sews
   * itself). Only consulted when shape==='freeform'.
   */
  extraOpenings?: (uu: number, vv: number) => boolean;
  /**
   * INDEPENDENT BACK face (freeform côte-à-côte): panel 1 (−z) gets its own
   * drawn outline/darts, openings and dart/hand-seam pairs instead of mirroring
   * the front. All absent → the back mirrors the front (every archetype and
   * single-face freeform piece is byte-for-byte unchanged). Only consulted when
   * shape==='freeform'.
   */
  maskBack?: {
    outline: UV[];
    darts: { apex: UV; legA: UV; legB: UV }[];
    holes?: readonly (readonly UV[])[];
  };
  extraSeamsBack?: readonly { i: number; j: number }[];
  extraOpeningsBack?: (uu: number, vv: number) => boolean;
  /**
   * MANUAL assembly (freeform atelier): when true, the automatic perimeter
   * front↔back sew is SKIPPED — the garment holds only where `assemblySeams`
   * place a seam. `assemblySeams` are pairs of GLOBAL cell indices (panel-
   * offset: front = panel 0, back = panel 1), from compileAssembly().
   */
  manualAssembly?: boolean;
  assemblySeams?: readonly { i: number; j: number; zipper?: boolean }[];
  /**
   * Elastic band at the top edge: rest-length ratio (< 1) applied to the
   * horizontal weave in the top rows — the fabric gathers and GRIPS whatever
   * it sits on (elasticated waists, cuffs). 1 = no elastic.
   */
  elasticTop?: number;
  /**
   * Treat horizontal constraints in the top band as lockstitch-stiff. This
   * approximates an interfaced, closed waistband whose circumference must not
   * inherit the stretch of a jersey/soft fabric preset.
   */
  reinforceTop?: boolean;
  /**
   * Waistband anchor (the belt): hold the top rows at their rest HEIGHT with a
   * soft vertical spring while leaving x/z free, so the band still settles
   * around the body. Without it a strapless or elastic top slides down a body
   * that narrows below it (bust → waist), exactly like a beltless skirt. Off
   * by default.
   */
  anchorTop?: boolean;
}

type PatternShape = NonNullable<SeamedPanelsOptions['shape']>;
type ShapeParams = NonNullable<SeamedPanelsOptions['shapeParams']>;

/** True when (u,v) ∈ [0,1]² lies inside the kimono-tee pattern piece: body
 * column plus sleeve bands angled downward to follow the mannequin's A-pose
 * arms, with a neck scoop at the top. */
function tshirtShape(u: number, v: number, p: ShapeParams = {}): boolean {
  const x = Math.abs(u - 0.5);
  const bodyHalf = 0.24;
  if (x <= bodyHalf) {
    // Neck scoop. `neck` = the neckline half-width (fraction of piece width),
    // measurement-driven — an oversized body keeps a narrow crew neck that stays
    // on the shoulders instead of sliding off.
    const neckHalf = p.neck ?? 0.11;
    if (v < 0.09) {
      const scoop = neckHalf * Math.sqrt(1 - (v / 0.09) ** 2);
      if (x < scoop) return false;
    }
    return true;
  }
  // Sleeve: a band sloping down as it leaves the body, matching the arm pose.
  // Integral to the body (a kimono / drop-shoulder cut) — front+back sew into a
  // tube around the arm, so it drapes down instead of flapping like a set-in cap.
  // `sleeve` = outer x bound (cuff) — a shorter bound = a shorter sleeve.
  const sleeveEnd = p.sleeve ?? 0.5;
  if (x > sleeveEnd) return false;
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
 *
 * The sleeve's inner edge is the SLEEVE CAP (tête de manche): a convex curve
 * bulging toward the body. Its arc is a few percent LONGER than the straight
 * armhole edge it is sewn to — the tailor's EASE (embu). The armhole seam
 * stitches row by row, so the extra length between consecutive stitches gets
 * compressed and the cap rounds itself over the shoulder instead of lying
 * flat. Flat cap = boxy shoulder; eased cap = a set-in sleeve.
 */
// Gentle drafting: the band ends stay close to the body (the armhole seam
// swallows that gap at assembly — too far and the yank dislodges the whole
// shoulder), and the bulge is sized for ~3-4 % ease: rounds without gathers.
const CAP_BASE = 0.285; // inner sleeve bound at the band's ends (u units)
const CAP_DEPTH = 0.022; // bulge toward the body — sets the ease
const CAP_V0 = 0.02; // sleeve band: v ∈ [CAP_V0, CAP_V1]
const CAP_V1 = 0.34;

/** Inner sleeve bound at height v: the drafted cap curve. */
function capInnerX(v: number): number {
  const t = (v - CAP_V0) / (CAP_V1 - CAP_V0);
  if (t < 0 || t > 1) return CAP_BASE;
  return CAP_BASE - CAP_DEPTH * Math.sin(Math.PI * t);
}

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
    // Body, with a neck scoop. `neck` = the neckline half-width (fraction of the
    // piece width) — measurement-driven, so an OVERSIZED body can keep a NARROW
    // crew neck that stays on the shoulders instead of sliding off.
    const neckHalf = p.neck ?? 0.1;
    if (v < 0.09) {
      const scoop = neckHalf * Math.sqrt(1 - (v / 0.09) ** 2);
      if (x < scoop) return false;
    }
    return true;
  }
  // Sleeves: separate pieces across a cutting gap, shoulder-height band only,
  // bounded on the inside by the cap curve.
  return x >= capInnerX(v) && x <= sleeveEnd && v >= CAP_V0 && v <= CAP_V1;
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

function isOpening(shape: PatternShape, uu: number, vv: number, p: ShapeParams = {}, step = 0): boolean {
  if (shape === 'freeform') return false; // freeform openings are fully caller-controlled (extraOpenings)
  const x = Math.abs(uu - 0.5);
  // The exemption margins must cover at least ONE grid step beyond each
  // opening's cut: with fixed margins, the first kept particle past a scoop
  // can land outside the zone at coarse resolutions — and the mirror seam
  // then sews the neckline shut (head-sized garment, no head hole).
  if (vv > 0.97) return true; // hem
  if (shape === 'aline') {
    if (vv < 0.13 + step && x < (p.scoop ?? 0.1) + 0.02 + step) return true; // neckline
    // A sleeveless dress needs a real arm passage between the horizontal
    // shoulder seam and the vertical side seam. Previously the whole outer
    // boundary was mirror-sewn: the A-line was topologically a bag with only
    // a neck and hem opening, so the side stitch crossed the deltoid and made
    // adjacent cloth cells settle on opposite sides of the arm. Keep two short
    // top rows for the shoulder join, open the outer run around the arm, then
    // resume the side seam below the armpit. `sideHalfWidth` follows custom
    // profiles, so this remains correct after grading/editing.
    const armholeStart = 0.04;
    const armholeEnd = p.armhole ?? 0.28;
    const outerEdge = sideHalfWidth(vv, p);
    if (
      vv > armholeStart &&
      vv < armholeEnd + step &&
      x >= outerEdge - (0.025 + step)
    ) {
      return true;
    }
    return false;
  }
  if (shape === 'tshirt') {
    if (vv < 0.1 + step && x < (p.neck ?? 0.11) + 0.02 + step) return true; // neckline
    if (x > (p.sleeve ?? 0.5) - 0.02) return true; // sleeve cuff (the arm comes out here)
  }
  if (shape === 'skirt') return vv < 0.04; // waist
  if (shape === 'pants') return vv < 0.04; // waist (leg hems via the vv > 0.97 rule)
  if (shape === 'setin') {
    if (vv < 0.1 + step && x < (p.neck ?? 0.1) + 0.025 + step) return true; // neckline
    if (x > (p.sleeve ?? 0.47) - 0.02) return true; // sleeve cuffs
    // Armhole edges (body side + the whole sleeve-cap curve) are sewn
    // island-to-island, not front-to-back — keep them out of the mirror
    // seams. The zone must match the sleeve band EXACTLY (same bounds the
    // mask uses): a fixed 0.36 exempted body rows BELOW the band, which no
    // sleeve ever seams — an open hole under each arm at every resolution.
    if (vv >= CAP_V0 && vv <= CAP_V1 && x >= 0.2 && x <= CAP_BASE + 0.01) return true;
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
/**
 * Count the connected components of a kept-cell mask over an n×n grid
 * (4-neighbour). Used as a topology invariant on cut patterns (audit M14):
 * a garment panel should stay in one piece (or exactly 3 islands for a
 * set-in cutting sheet). Exported for the invariant tests.
 */
export function countMaskIslands(kept: readonly boolean[], n: number): number {
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  let comps = 0;
  for (let s = 0; s < n * n; s++) {
    if (!kept[s] || seen[s]) continue;
    comps++;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cu = c % n;
      const cv = (c / n) | 0;
      if (cu + 1 < n && kept[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (cu - 1 >= 0 && kept[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (cv + 1 < n && kept[c + n] && !seen[c + n]) { seen[c + n] = 1; stack.push(c + n); }
      if (cv - 1 >= 0 && kept[c - n] && !seen[c - n]) { seen[c - n] = 1; stack.push(c - n); }
    }
  }
  return comps;
}

/**
 * Close a user-authored seam run in the render mesh.
 *
 * Distance constraints join particles, but two independently drawn boundary
 * runs otherwise remain two open sheets. Between successive seam pins, each
 * side follows the shortest local path over genuine triangle-boundary edges.
 * A zipper triangulation then tolerates skipped vertices and gathering (a
 * repeated endpoint becomes a fan) without adding any physical constraint.
 * Interior stitches/darts are deliberately ignored: neither side is a render
 * boundary there, so this helper cannot invent a surface over a pocket or a
 * dart. The first index stays on side B, matching the automatic-cap convention
 * that keeps these 3D-only faces out of the front-panel pattern view.
 */
function appendBoundarySeamRibbons(
  triangles: number[],
  seamPairs: readonly { i: number; j: number }[],
  panelSize: number,
  maxBoundaryHops = Math.max(4, Math.ceil(Math.sqrt(panelSize) / 8)),
  onSewnVertex?: (index: number) => void,
): number {
  if (seamPairs.length < 2) return 0;
  interface BoundaryEdge {
    a: number;
    b: number;
    count: number;
  }
  const boundary = new Map<string, BoundaryEdge>();
  const keyOf = (a: number, b: number): string =>
    a < b ? `${a}:${b}` : `${b}:${a}`;
  const add = (a: number, b: number): void => {
    const key = keyOf(a, b);
    const prior = boundary.get(key);
    if (prior) prior.count++;
    else boundary.set(key, { a, b, count: 1 });
  };
  // Ribbons already present in an input mesh span two panels. Only ordinary
  // mono-panel triangles define cut boundaries for a new ribbon.
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]!;
    const b = triangles[t + 1]!;
    const c = triangles[t + 2]!;
    const panel = Math.floor(a / panelSize);
    if (
      Math.floor(b / panelSize) !== panel ||
      Math.floor(c / panelSize) !== panel
    ) {
      continue;
    }
    add(a, b);
    add(b, c);
    add(c, a);
  }

  const adjacency = new Map<number, number[]>();
  const connect = (a: number, b: number): void => {
    const neighbours = adjacency.get(a);
    if (neighbours) neighbours.push(b);
    else adjacency.set(a, [b]);
  };
  for (const edge of boundary.values()) {
    if (edge.count !== 1) continue;
    connect(edge.a, edge.b);
    connect(edge.b, edge.a);
  }

  const shortestBoundaryPath = (start: number, end: number): number[] | null => {
    if (
      Math.floor(start / panelSize) !== Math.floor(end / panelSize) ||
      !adjacency.has(start) ||
      !adjacency.has(end)
    ) {
      return null;
    }
    if (start === end) return [start];
    const previous = new Map<number, number>();
    const depth = new Map<number, number>([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      const currentDepth = depth.get(current)!;
      if (currentDepth >= maxBoundaryHops) continue;
      for (const next of adjacency.get(current) ?? []) {
        if (depth.has(next)) continue;
        previous.set(next, current);
        depth.set(next, currentDepth + 1);
        if (next === end) {
          const path = [end];
          let cursor = end;
          while (cursor !== start) {
            cursor = previous.get(cursor)!;
            path.push(cursor);
          }
          path.reverse();
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  };

  // Seed with existing mixed-panel faces so a repeated/reversed seam interval
  // cannot append the same cap twice, including across combined garments.
  // Mono-panel cloth faces cannot equal a ribbon and dominate this array, so
  // excluding them avoids retaining tens of thousands of unnecessary keys.
  const triangleKey = (a: number, b: number, c: number): string =>
    [a, b, c].sort((x, y) => x - y).join(':');
  const emitted = new Set<string>();
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]!;
    const b = triangles[t + 1]!;
    const c = triangles[t + 2]!;
    const panel = Math.floor(a / panelSize);
    if (
      Math.floor(b / panelSize) !== panel ||
      Math.floor(c / panelSize) !== panel
    ) {
      emitted.add(triangleKey(a, b, c));
    }
  }
  let ribbonTriangles = 0;
  const emit = (b0: number, x: number, y: number): void => {
    if (b0 === x || b0 === y || x === y) return;
    const key = triangleKey(b0, x, y);
    if (emitted.has(key)) return;
    emitted.add(key);
    triangles.push(b0, x, y);
    ribbonTriangles++;
  };
  for (let k = 1; k < seamPairs.length; k++) {
    const previous = seamPairs[k - 1]!;
    const current = seamPairs[k]!;
    if (
      Math.floor(previous.i / panelSize) !== Math.floor(current.i / panelSize) ||
      Math.floor(previous.j / panelSize) !== Math.floor(current.j / panelSize)
    ) {
      continue;
    }
    let pathA = shortestBoundaryPath(previous.i, current.i);
    let pathB = shortestBoundaryPath(previous.j, current.j);
    if (!pathA || !pathB || (pathA.length === 1 && pathB.length === 1)) {
      continue;
    }

    // The ribbon is the continuous topological seam, even when the physical
    // run uses sparse pins to avoid several lockstitches fighting over one
    // particle (notably a collar band sewn with negative ease). Keep the
    // self-collision/audit mask aligned with that exact boundary path: an
    // unmarked intermediate vertex would otherwise be repelled from the body
    // through the very strip that declares it sewn.
    if (onSewnVertex) {
      for (const index of pathA) onSewnVertex(index);
      for (const index of pathB) onSewnVertex(index);
    }

    // Follow side A's oriented boundary. When gathering keeps A fixed, follow
    // side B against its own boundary orientation: this is the corresponding
    // orientation of the missing A edge. Reverse both paths together so pin
    // correspondence is never changed merely to repair winding.
    if (pathA.length > 1) {
      const edgeA = boundary.get(keyOf(pathA[0]!, pathA[1]!));
      if (!edgeA || edgeA.a !== pathA[0] || edgeA.b !== pathA[1]) {
        pathA = [...pathA].reverse();
        pathB = [...pathB].reverse();
      }
    } else if (pathB.length > 1) {
      const edgeB = boundary.get(keyOf(pathB[0]!, pathB[1]!));
      if (edgeB && edgeB.a === pathB[0] && edgeB.b === pathB[1]) {
        pathA = [...pathA].reverse();
        pathB = [...pathB].reverse();
      }
    }

    // Zipper two boundary polylines by normalized edge progress. Advancing
    // only A emits an A fan triangle; advancing only B emits a B fan triangle;
    // equal progress emits the familiar two-triangle quad.
    const edgesA = pathA.length - 1;
    const edgesB = pathB.length - 1;
    let ia = 0;
    let ib = 0;
    while (ia < edgesA || ib < edgesB) {
      const advanceA = ia < edgesA;
      const advanceB = ib < edgesB;
      const nextA = advanceA ? (ia + 1) / edgesA : Number.POSITIVE_INFINITY;
      const nextB = advanceB ? (ib + 1) / edgesB : Number.POSITIVE_INFINITY;
      if (advanceA && advanceB && Math.abs(nextA - nextB) < 1e-9) {
        emit(pathB[ib]!, pathA[ia + 1]!, pathA[ia]!);
        emit(pathB[ib]!, pathB[ib + 1]!, pathA[ia + 1]!);
        ia++;
        ib++;
      } else if (nextA < nextB) {
        emit(pathB[ib]!, pathA[ia + 1]!, pathA[ia]!);
        ia++;
      } else {
        emit(pathB[ib]!, pathB[ib + 1]!, pathA[ia]!);
        ib++;
      }
    }
  }
  return ribbonTriangles;
}

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
    if (shape === 'tshirt') return tshirtShape(uu, vv, shapeParams);
    if (shape === 'skirt') return skirtShape(uu, vv, shapeParams);
    if (shape === 'setin') return setinShape(uu, vv, shapeParams);
    if (shape === 'pants') return pantsShape(uu, vv);
    if (shape === 'freeform' && opts.mask) {
      const p: UV = [uu, vv];
      if (!pointInPolygon(p, opts.mask.outline)) return false;
      // Subtract each dart wedge — a V-notch that closes when its legs are sewn.
      for (const d of opts.mask.darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) return false;
      // ⌾ Subtract each hole polygon — cells inside leave the garment.
      for (const h of opts.mask.holes ?? []) if (pointInPolygon(p, h)) return false;
      return true;
    }
    return true;
  };
  const inside = (u: number, v: number): boolean => insideUV(u / (n - 1), v / (n - 1));
  const kept = new Array<boolean>(panelSize);
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept[v * n + u] = inside(u, v);

  // Connectivity guard (audit M14): an over-scooped neckline or a pinched
  // silhouette station can sever the cut mask into free-falling fragments —
  // silently, the same way an under-drafted set-in gap would weld the islands
  // (M10). Expected islands: 3 for the set-in cutting sheet (body + 2 sleeves,
  // rejoined at assembly), 1 otherwise. Warning-only: changes no geometry,
  // rest length or constraint — it just surfaces the split so a future draft
  // change can't break the topology unnoticed. O(n²) 4-neighbour flood fill.
  const expectedIslands = shape === 'setin' ? 3 : 1;
  const islandCount = countMaskIslands(kept, n);
  // Un SOCLE VIDE (contour sentinelle « blank ») rasterise 0 cellule par
  // construction — ce n'est pas un patron déconnecté, ne pas alerter.
  const blankMask = islandCount === 0 && kept.every((keep) => !keep);
  if (!blankMask && islandCount !== expectedIslands) {
    console.warn(
      `ClothMesh: patron déconnecté — ${islandCount} îlot(s), attendu ${expectedIslands} (shape=${shape ?? 'rect'})`,
    );
  }

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

  // Independent BACK mask (freeform côte à côte): panel 1 (the −z face) gets its
  // OWN drawn outline instead of mirroring the front. Absent → keptB aliases the
  // front mask, so EVERY archetype and single-face freeform piece is byte-for-
  // byte unchanged (the whole delta below is gated on `hasBack`).
  const hasBack = shape === 'freeform' && !!opts.maskBack;
  const keptB = hasBack ? new Array<boolean>(panelSize) : kept;
  const uAdjB = hasBack ? new Float32Array(panelSize) : uAdj;
  const vAdjB = hasBack ? new Float32Array(panelSize) : vAdj;
  if (hasBack) {
    const mb = opts.maskBack!;
    const insideB = (uu: number, vv: number): boolean => {
      const p: UV = [uu, vv];
      if (!pointInPolygon(p, mb.outline)) return false;
      for (const d of mb.darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) return false;
      for (const h of mb.holes ?? []) if (pointInPolygon(p, h)) return false;
      return true;
    };
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) keptB[v * n + u] = insideB(u / (n - 1), v / (n - 1));
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        uAdjB[v * n + u] = u / (n - 1);
        vAdjB[v * n + u] = v / (n - 1);
      }
    // Same cut-edge snapping the front gets (bisect toward each cut neighbour).
    const crossingB = (u0: number, v0: number, u1: number, v1: number): [number, number] => {
      let a = 0;
      let b = 1;
      for (let it = 0; it < 10; it++) {
        const m = (a + b) / 2;
        if (insideB(u0 + (u1 - u0) * m, v0 + (v1 - v0) * m)) a = m;
        else b = m;
      }
      const t = (a + b) / 2;
      return [u0 + (u1 - u0) * t, v0 + (v1 - v0) * t];
    };
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        if (!keptB[v * n + u]) continue;
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
          if (keptB[v1 * n + u1]) continue;
          const [cu, cv] = crossingB(u0, v0, u1 / (n - 1), v1 / (n - 1));
          sumU += cu;
          sumV += cv;
          cuts++;
        }
        if (cuts > 0) {
          uAdjB[v * n + u] = sumU / cuts;
          vAdjB[v * n + u] = sumV / cuts;
        }
      }
    const backIslands = countMaskIslands(keptB, n);
    // An intentionally empty back mask is how a pocket/appliqué requests one
    // physical sheet. It is not a disconnected garment and should stay silent.
    if (mb.outline.length >= 3 && backIslands !== 1) {
      console.warn(`ClothMesh: dos déconnecté — ${backIslands} îlot(s)`);
    }
  }

  const positions = new Float32Array(count * 4);
  const invMasses = new Float32Array(count).fill(1.0);
  // Waistband anchor: hold the top band (same rows the elastic gathers) at
  // their rest height. Sentinel = not anchored.
  const ANCHOR_NONE = -1e9;
  const anchorTop = opts.anchorTop ?? false;
  const anchorY = anchorTop ? new Float32Array(count).fill(ANCHOR_NONE) : undefined;

  const index = (p: number, u: number, v: number): number => p * panelSize + v * n + u;
  // Panel 0 = front mask, panel 1 = back mask (identical arrays unless a
  // côte-à-côte back outline was drawn).
  const isKept = (p: number, u: number, v: number): boolean => (p === 0 ? kept : keptB)[v * n + u]!;

  for (let p = 0; p < 2; p++) {
    const kp = p === 0 ? kept : keptB;
    const ua = p === 0 ? uAdj : uAdjB;
    const va = p === 0 ? vAdj : vAdjB;
    const z = (p === 0 ? 1 : -1) * (gap / 2);
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        const i = index(p, u, v);
        const local = v * n + u;
        if (kp[local]) {
          positions[i * 4 + 0] = (ua[local]! - 0.5) * width;
          positions[i * 4 + 1] = topY - va[local]! * height;
          positions[i * 4 + 2] = z;
          // Anchor the top band to its own rest height (matches the elastic
          // grip zone v < 0.06), so the strapless top cannot slide down.
          if (anchorY && va[local]! < 0.06) anchorY[i] = positions[i * 4 + 1]!;
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

  const elasticTop = opts.elasticTop ?? 1;
  const reinforceTop = opts.reinforceTop ?? false;
  // Elastic band height in ROWS, floored at 2 (audit M15): `v/(n-1) < 0.06`
  // alone collapses to a single row at n ≤ 17, so grip strength jumps with
  // resolution. round(0.06·(n-1)) is identical at the selectable 32/64/128
  // (4/2/8 rows there); the max(2,…) only bites at the unreachable low n.
  const elasticRows = Math.max(2, Math.round(0.06 * (n - 1)));
  // In-panel constraints, identical topology to the single sheet, restricted
  // to particles inside the pattern (bending also requires the middle particle
  // so it never bridges across a cut).
  for (let p = 0; p < 2; p++) {
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        if (!isKept(p, u, v)) continue;
        if (u + 1 < n && isKept(p, u + 1, v)) {
          const e = edge(index(p, u, v), index(p, u + 1, v), ConstraintKind.Structural);
          // Elastic band: the top rows want to be SHORTER than they are cut —
          // the weave gathers and grips (elasticated waist).
          if (elasticTop < 1 && v < elasticRows) e.rest *= elasticTop;
          if (reinforceTop && v < elasticRows) {
            // An interfaced waistband is governed by its stitched length, not
            // the stretch compliance of the selected shell fabric.
            e.kind = ConstraintKind.Seam;
            seams.push(e);
          } else {
            structural.push(e);
          }
        }
        if (v + 1 < n && isKept(p, u, v + 1))
          structural.push(edge(index(p, u, v), index(p, u, v + 1), ConstraintKind.StructuralWarp));
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
  // Derive it from the LOCAL weave (the tighter axis), not just the horizontal
  // spacing, so an anisotropic panel (width ≠ height) doesn't get orientation-
  // dependent seam slack (audit M13). Sub-mm on near-zero rests; the separate
  // flattening heuristic (2·gridSpacing below) is left as a pressing distance.
  const gridSpacing = width / (n - 1);
  const seamRest = Math.min(gridSpacing, height / (n - 1)) * 0.15;
  const pressHinges: BendQuad[] = [];
  // Local cells that carry a front↔back seam — seeds for the seam-distance BFS
  // that gates the cross-panel self-collision exclusion (M3).
  const seamLocalCells = new Set<number>();
  // Auto-sewn mirror cells are also retained for the render topology below.
  // Constraints can pull two panel rims together physically, but without faces
  // between them the indexed surface stays topologically open and exposes a
  // hairline of avatar at shoulders/closed side seams.
  const seamedLocal = new Set<number>();
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
      seamLocalCells.add(v * n + uMin);
      if (uMax !== uMin) {
        seams.push({ i: index(0, uMax, v), j: index(1, uMax, v), rest: seamRest, kind: ConstraintKind.Seam });
        seamLocalCells.add(v * n + uMax);
      }
    }
  } else {
    // Shaped garment: stitch the ENTIRE cut boundary of the pattern — except
    // the openings (neckline, hem, sleeve ends) where the body passes through.
    // A particle is on the boundary when a 4-neighbour is missing or cut.
    // A cell is on a face's boundary when a 4-neighbour is missing/cut on THAT
    // face's own mask (front and back may differ in côte-à-côte mode).
    const onB = (kp: readonly boolean[], u: number, v: number): boolean =>
      !!kp[v * n + u] &&
      (u === 0 ||
        u === n - 1 ||
        v === 0 ||
        v === n - 1 ||
        !kp[v * n + (u - 1)] ||
        !kp[v * n + (u + 1)] ||
        !kp[(v - 1) * n + u] ||
        !kp[(v + 1) * n + u]);
    const onBoundary = (u: number, v: number): boolean => onB(kept, u, v); // front, for pressing
    const openFront = (u: number, v: number): boolean =>
      isOpening(shape, u / (n - 1), v / (n - 1), shapeParams, 1 / (n - 1)) ||
      (shape === 'freeform' && !!opts.extraOpenings?.(u / (n - 1), v / (n - 1)));
    const openBack = (u: number, v: number): boolean =>
      hasBack
        ? isOpening(shape, u / (n - 1), v / (n - 1), shapeParams, 1 / (n - 1)) ||
          !!opts.extraOpeningsBack?.(u / (n - 1), v / (n - 1))
        : openFront(u, v);
    // Cross-seam flattening: for cells one ring inside a stitched edge, a soft
    // bending constraint ties front↔back at the flat-continuation distance
    // (2 × spacing), so the fabric behaves as if continuous through the seam —
    // a smooth ridge instead of a pinched, gaping fold.
    const flattened = new Set<number>();
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        const cell = v * n + u;
        // Manual assembly (CLO-style): nothing auto-sews — the garment holds
        // only where the user placed a seam (injected below via assemblySeams).
        if (opts.manualAssembly) continue;
        // Stitch front↔back where BOTH faces keep the cell, it lies on a face
        // boundary, and neither face left it open (neckline/hem/dart/hand-seam).
        if (!kept[cell] || !keptB[cell]) continue;
        if (!onB(kept, u, v) && !onB(keptB, u, v)) continue;
        if (openFront(u, v) || openBack(u, v)) continue;
        seamedLocal.add(cell);
        seamLocalCells.add(cell);
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
          // Only flatten the ring INSIDE the seam. A boundary neighbour is
          // itself seamed (front↔back at 0.15·spacing); adding the flat
          // continuation (2·spacing) to that same pair pits two contradictory
          // distance constraints against each other every solve.
          // Skippable (flattenSeams:false) for WRAP pieces — see the option.
          if (opts.flattenSeams === false) continue;
          if (!kept[local] || !keptB[local] || flattened.has(local) || onB(kept, u2, v2) || onB(keptB, u2, v2)) continue;
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

    // PRESSING: true dihedral hinges ACROSS each seam at rest angle π — which
    // IS flat in this acos-of-normals convention (0 = fully folded). Once sewn,
    // the two panels are asked to continue FLAT through the seam line, like a
    // pressed seam under the iron. The hinge edge runs
    // along the seam on panel 0; one wing is panel 0's inward neighbour, the
    // other is panel 1's — geometrically a hinge over the closed seam ridge.
    const inward = (u: number, v: number): number => {
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
        if (kept[local] && !onBoundary(u2, v2)) return local;
      }
      return -1;
    };
    // Pressing only where seams are meant to lie flat (vertical side seams).
    // Sleeve underarm seams WRAP the arm — flattening them fights the very
    // curvature they exist to create (learned the hard way on the kimono tee).
    const pressable = shape === 'aline' || shape === 'skirt' || shape === 'pants';
    for (const local of pressable ? seamedLocal : []) {
      const u = local % n;
      const v = (local - u) / n;
      for (const [du, dv2] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const u2 = u + du;
        const v2 = v + dv2;
        if (u2 >= n || v2 >= n) continue;
        const local2 = v2 * n + u2;
        if (!seamedLocal.has(local2)) continue; // consecutive along the seam
        const w0 = inward(u, v);
        const w1 = inward(u2, v2);
        if (w0 < 0 || w1 < 0) continue;
        // Gentle iron: 8x softer than the fabric's own bending — presses the
        // ridge flat without fighting seams that must curve around the body.
        pressHinges.push({
          e0: 0 * panelSize + local,
          e1: 0 * panelSize + local2,
          w0: 0 * panelSize + w0,
          w1: 1 * panelSize + w1,
          restAngle: Math.PI, // π = pressed FLAT in this convention
          softness: 8,
        });
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

  // Freeform extra seams (dart legs + hand-defined seams): LOCAL front-panel
  // cell indices i,j to sew together, WITHIN each panel (front-to-front,
  // back-to-back — a dart/edge join is a single-layer operation), mirrored to
  // both panels. Register both cells in seamLocalCells so the seamDist BFS and
  // the self-collision exemption cover them — otherwise self-collision fights
  // the closure and the piece shakes loose (the gathered-bodice slide-off).
  const injectExtra = (pairs: readonly { i: number; j: number }[] | undefined, p: number): void => {
    if (!pairs) return;
    for (const s of pairs) {
      seams.push({ i: p * panelSize + s.i, j: p * panelSize + s.j, rest: seamRest, kind: ConstraintKind.Seam });
      seamLocalCells.add(s.i);
      seamLocalCells.add(s.j);
    }
  };
  injectExtra(opts.extraSeams, 0); // front darts / hand-seams
  injectExtra(hasBack ? opts.extraSeamsBack : opts.extraSeams, 1); // back's own (else mirror)

  // Manual assembly seams: user-defined pairs of GLOBAL cell indices (already
  // panel-offset, front = panel 0, back = panel 1). This is what holds a
  // manually-assembled garment together.
  if (opts.assemblySeams) {
    for (const s of opts.assemblySeams) {
      seams.push({
        i: s.i,
        j: s.j,
        rest: seamRest,
        // Une épingle de fermeture garde la rigidité d'une couture mais reste
        // débrayable à chaud par l'uniform zip_open du solveur (v198).
        kind: s.zipper ? ConstraintKind.ZipperSeam : ConstraintKind.Seam,
      });
      seamLocalCells.add(s.i % panelSize);
      seamLocalCells.add(s.j % panelSize);
    }
  }

  // Seam-distance field (M3): grid hops from the nearest sewn cell, over kept
  // cells, clamped to 3. Both panels share the local grid so the same value
  // applies to each. Self-collision uses it to keep the cross-panel mirror
  // exclusion only near seams (so the sewn edge closes) while letting an
  // interior front↔back mirror contact repel (a body-free tube no longer
  // tunnels flat). Absent for a single-sheet grid (no seams).
  const SEAM_FAR = 3;
  const seamDistLocal = new Uint8Array(panelSize).fill(SEAM_FAR);
  {
    const queue: number[] = [];
    for (const c of seamLocalCells) {
      seamDistLocal[c] = 0;
      queue.push(c);
    }
    for (let head = 0; head < queue.length; head++) {
      const c = queue[head]!;
      const d = seamDistLocal[c]!;
      if (d >= SEAM_FAR) continue;
      const cu = c % n;
      const cv = (c / n) | 0;
      for (const [du, dv2] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const u2 = cu + du;
        const v2 = cv + dv2;
        if (u2 < 0 || u2 >= n || v2 < 0 || v2 >= n) continue;
        const nb = v2 * n + u2;
        if (!kept[nb]) continue;
        if (seamDistLocal[nb]! > d + 1) {
          seamDistLocal[nb] = d + 1;
          queue.push(nb);
        }
      }
    }
  }
  const seamDist = new Uint8Array(count);
  for (let p = 0; p < 2; p++)
    for (let local = 0; local < panelSize; local++) seamDist[p * panelSize + local] = seamDistLocal[local]!;

  const all = structural.concat(shear, bending, seams);
  const { ordered, colorOffsets, colorCounts, phaseColorRanges } = colorConstraints(all, count);
  const quads = buildBendQuads(positions, 2, n, (p, u, v) => (p === 0 ? kept : keptB)[v * n + u]!, pressHinges);

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

  // Visual seam ribbon: bridge only matching topological boundary edges whose
  // TWO endpoints were auto-sewn front↔back above. This closes the rendered
  // shell at true closed seams without changing particles, constraints, rest
  // lengths, collision offsets or SDF contact. Necklines, hems, cuffs and other
  // authored openings never enter `seamedLocal`, so they remain genuinely open.
  // Manual assemblies deliberately receive no implicit faces either.
  if (seamedLocal.size > 0) {
    interface BoundaryEdge {
      a: number;
      b: number;
      count: number;
    }
    const boundaryByPanel = [new Map<string, BoundaryEdge>(), new Map<string, BoundaryEdge>()];
    const addBoundaryCandidate = (panel: number, a: number, b: number): void => {
      const localA = a - panel * panelSize;
      const localB = b - panel * panelSize;
      const key = localA < localB ? `${localA}:${localB}` : `${localB}:${localA}`;
      const previous = boundaryByPanel[panel]!.get(key);
      if (previous) previous.count++;
      else boundaryByPanel[panel]!.set(key, { a: localA, b: localB, count: 1 });
    };
    // Read the panel triangles before adding any ribbon faces. The oriented edge
    // kept from panel 0 gives the ribbon a consistent outward winding.
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!;
      const b = tris[t + 1]!;
      const c = tris[t + 2]!;
      const panel = Math.floor(a / panelSize);
      if (panel > 1 || Math.floor(b / panelSize) !== panel || Math.floor(c / panelSize) !== panel) continue;
      addBoundaryCandidate(panel, a, b);
      addBoundaryCandidate(panel, b, c);
      addBoundaryCandidate(panel, c, a);
    }
    for (const [key, front] of boundaryByPanel[0]!) {
      const back = boundaryByPanel[1]!.get(key);
      if (front.count !== 1 || back?.count !== 1) continue;
      if (!seamedLocal.has(front.a) || !seamedLocal.has(front.b)) continue;
      const a0 = front.a;
      const b0 = front.b;
      const a1 = panelSize + front.a;
      const b1 = panelSize + front.b;
      // Cyclic order keeps each first index on the back panel. Pattern/PDF views
      // intentionally filter on that index, so this 3D-only cap cannot erase a
      // legitimate 2D cut line while preserving the same triangle winding.
      tris.push(a1, b0, a0, a1, b1, b0);
    }
  }
  if (opts.manualAssembly && opts.assemblySeams?.length) {
    // compileAssembly flattens several authored seams into one list without a
    // run separator. Keep its historical one-edge locality so a gap between
    // shoulder/side runs cannot accidentally cap an armhole or neckline.
    appendBoundarySeamRibbons(tris, opts.assemblySeams, panelSize, 1);
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
    spacingV: height / (n - 1),
    count,
    positions,
    invMasses,
    constraintData,
    constraintCount: ordered.length,
    colorOffsets,
    colorCounts,
    constraintColorPhases: phaseColorRanges,
    ...quads,
    structuralCount: structural.length,
    shearCount: shear.length,
    bendingCount: bending.length,
    seamCount: seams.length,
    cornerIndices: [cornerA, cornerB],
    triangleIndices,
    seamDist,
    anchorY,
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
/**
 * Cross-garment seam: pairs of GLOBAL particle indices (i in the combined
 * space of a, j offset into b's space by the caller via a.count). Used for
 * gathering (embu): when the two sewn edges have different physical lengths,
 * the near-zero-rest seams compress the longer edge onto the shorter one and
 * the excess fabric folds into natural gathers — shirring by pure physics.
 */
export interface CrossSeam {
  i: number;
  j: number;
  /** Optional live grid neighbour one row inside endpoint i's sewn edge. */
  inwardI?: number;
  /** Optional live grid neighbour one row inside endpoint j's sewn edge. */
  inwardJ?: number;
  /**
   * Endpoint i is an anatomically placed support rim; endpoint j belongs to a
   * newly attached part and must absorb almost all of the dressing correction.
   */
  attachment?: true;
  /**
   * Épingle de FERMETURE ÉCLAIR (v198) : cousue comme une couture rigide mais
   * portée par ConstraintKind.ZipperSeam — débrayable à chaud par l'uniform
   * `zip_open` du solveur, sans reconstruire la simulation.
   */
  zipper?: boolean;
}

export interface AttachmentSeam extends CrossSeam {
  attachment: true;
}

export interface SurfaceContact extends CrossSeam {
  tangentA: number;
  tangentB: number;
  weight0: number;
  weightA: number;
  weightB: number;
  /** Apply one-sided projection; false entries still define contact masks. */
  active?: boolean;
  /** +1 = overlay par-dessus le support (défaut), -1 = par-dessous (doublure). */
  side?: 1 | -1;
}

export function combineClothMeshes(
  a: ClothMeshData,
  b: ClothMeshData,
  crossSeams: CrossSeam[] = [],
  layerB = 0,
  surfaceContacts: SurfaceContact[] = [],
  surfaceSeams: CrossSeam[] = [],
): ClothMeshData {
  if (a.resolution !== b.resolution) {
    throw new Error('combineClothMeshes: garments must share the same resolution');
  }
  const count = a.count + b.count;
  // Drop seams touching a CUT particle (inverse mass 0, parked far below):
  // with an independent back mask, a both-faces seam pair can target a cell
  // the back outline cut away — sewing live fabric to a parked particle
  // would yank the garment toward it. Out-of-range indices are dropped too.
  const alive = (g: number): boolean => (g < a.count ? a.invMasses[g]! > 0 : b.invMasses[g - a.count]! > 0);
  const seams = crossSeams.filter((cs) => cs.i >= 0 && cs.i < count && cs.j >= 0 && cs.j < count && alive(cs.i) && alive(cs.j));
  const validSurfaceSeams = surfaceSeams.filter(
    (cs) =>
      cs.i >= 0 &&
      cs.i < count &&
      cs.j >= 0 &&
      cs.j < count &&
      alive(cs.i) &&
      alive(cs.j),
  );
  const surfaceSeamKeys = new Set(
    validSurfaceSeams.map((cs) => `${cs.i}:${cs.j}`),
  );
  const contacts = surfaceContacts.filter(
    (cs) =>
      cs.i >= 0 &&
      cs.i < count &&
      cs.j >= 0 &&
      cs.j < count &&
      cs.tangentA >= 0 &&
      cs.tangentA < count &&
      cs.tangentB >= 0 &&
      cs.tangentB < count &&
      alive(cs.i) &&
      alive(cs.j) &&
      alive(cs.tangentA) &&
      alive(cs.tangentB),
  );

  const positions = new Float32Array(count * 4);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.count * 4);
  const invMasses = new Float32Array(count);
  invMasses.set(a.invMasses, 0);
  invMasses.set(b.invMasses, a.count);
  // Dressing order: garment b is worn OVER a when layerB > 0 (b's own layers,
  // if any, shift up). Sewn combinations (cross-seamed at an edge) pass 0 —
  // they share a boundary, not a surface.
  const layers = new Float32Array(count);
  if (a.layers) layers.set(a.layers, 0);
  for (let i = 0; i < b.count; i++) layers[a.count + i] = (b.layers ? b.layers[i]! : 0) + layerB;
  const materialIds = a.materialIds || b.materialIds ? new Uint32Array(count) : undefined;
  if (materialIds) {
    if (a.materialIds) materialIds.set(a.materialIds, 0);
    if (b.materialIds) materialIds.set(b.materialIds, a.count);
  }
  const surfaceMasks =
    a.surfaceMasks || b.surfaceMasks || contacts.length
      ? new Uint32Array(count)
      : undefined;
  if (surfaceMasks) {
    if (a.surfaceMasks) surfaceMasks.set(a.surfaceMasks, 0);
    if (b.surfaceMasks) surfaceMasks.set(b.surfaceMasks, a.count);
    if (contacts.length) {
      let used = 0;
      for (const mask of surfaceMasks) used |= (mask & 0xffff) | (mask >>> 16);
      let bit = 1;
      while ((used & bit) !== 0 && bit < 0x8000) bit <<= 1;
      // Sanitized drafts currently allow at most six free pieces, so sixteen
      // independent surface groups leave ample room. Reuse the final bit only
      // as a corruption-safe fallback instead of dropping contact protection.
      if ((used & bit) !== 0) bit = 0x8000;
      for (const contact of contacts) {
        surfaceMasks[contact.i] = (surfaceMasks[contact.i]! | bit) >>> 0;
        surfaceMasks[contact.tangentA] = (surfaceMasks[contact.tangentA]! | bit) >>> 0;
        surfaceMasks[contact.tangentB] = (surfaceMasks[contact.tangentB]! | bit) >>> 0;
        surfaceMasks[contact.j] = (surfaceMasks[contact.j]! | (bit << 16)) >>> 0;
      }
    }
  }
  const decodeSurfaceContacts = (
    mesh: ClothMeshData,
    offset: number,
  ): SurfaceContact[] => {
    const data = mesh.surfaceContactData;
    const contactCount = mesh.surfaceContactCount ?? 0;
    if (!data || contactCount <= 0) return [];
    const view = new DataView(data);
    const decoded: SurfaceContact[] = [];
    for (let k = 0; k < contactCount; k++) {
      const base = k * SURFACE_CONTACT_STRIDE;
      decoded.push({
        i: view.getUint32(base, true) + offset,
        tangentA: view.getUint32(base + 4, true) + offset,
        tangentB: view.getUint32(base + 8, true) + offset,
        j: view.getUint32(base + 12, true) + offset,
        weight0: view.getFloat32(base + 16, true),
        weightA: view.getFloat32(base + 20, true),
        weightB: view.getFloat32(base + 24, true),
        active: view.getFloat32(base + 28, true) > 0.5,
        ...(view.getFloat32(base + 28, true) > 1.5 ? { side: -1 as const } : {}),
      });
    }
    return decoded;
  };
  const allSurfaceContacts = [
    ...decodeSurfaceContacts(a, 0),
    ...decodeSurfaceContacts(b, a.count),
    ...contacts,
  ];
  const surfaceContactData =
    allSurfaceContacts.length > 0
      ? new ArrayBuffer(allSurfaceContacts.length * SURFACE_CONTACT_STRIDE)
      : undefined;
  if (surfaceContactData) {
    const view = new DataView(surfaceContactData);
    for (let k = 0; k < allSurfaceContacts.length; k++) {
      const contact = allSurfaceContacts[k]!;
      const base = k * SURFACE_CONTACT_STRIDE;
      view.setUint32(base, contact.i, true);
      view.setUint32(base + 4, contact.tangentA, true);
      view.setUint32(base + 8, contact.tangentB, true);
      view.setUint32(base + 12, contact.j, true);
      view.setFloat32(base + 16, contact.weight0, true);
      view.setFloat32(base + 20, contact.weightA, true);
      view.setFloat32(base + 24, contact.weightB, true);
      // Explicit false is a stitched/interior mask-only entry. Undefined stays
      // active for backwards-compatible programmatic SurfaceContact callers.
      // Le canal porte AUSSI le côté : 1 = par-dessus, 2 = par-dessous (le
      // shader lit w > 1.5 → contrainte vers l'intérieur du support).
      view.setFloat32(
        base + 28,
        contact.active === false ? 0 : contact.side === -1 ? 2 : 1,
        true,
      );
    }
  }
  // Cross-seamed particles (and one row inward on each side) are exempt from
  // self-collision: the seam holds them tighter than min_dist by design.
  const seamFree = new Uint8Array(count);
  if (a.seamFree) seamFree.set(a.seamFree, 0);
  if (b.seamFree) for (let i = 0; i < b.count; i++) seamFree[a.count + i] = b.seamFree[i]!;
  // Seam-distance field carries through the merge (each garment keeps its own
  // BFS; the cross-panel exclusion is per-garment so no cross term is needed).
  const seamDist = a.seamDist || b.seamDist ? new Uint8Array(count).fill(3) : undefined;
  if (seamDist) {
    if (a.seamDist) seamDist.set(a.seamDist, 0);
    if (b.seamDist) seamDist.set(b.seamDist, a.count);
  }
  // Waistband anchors carry through (the bodice's held top ring).
  const anchorY = a.anchorY || b.anchorY ? new Float32Array(count).fill(-1e9) : undefined;
  if (anchorY) {
    if (a.anchorY) anchorY.set(a.anchorY, 0);
    if (b.anchorY) anchorY.set(b.anchorY, a.count);
  }
  const na = a.resolution;
  for (const cs of seams) {
    // Waist joins historically arrive as bottom(a) -> top(b), hence the
    // i-n/j+n defaults. Curved or inverted runs (notably body neckline ->
    // neck-band bottom) provide their actual inward neighbours explicitly.
    for (const k of [
      cs.i,
      cs.inwardI ?? cs.i - na,
      cs.j,
      cs.inwardJ ?? cs.j + na,
    ]) {
      if (k >= 0 && k < count) seamFree[k] = 1;
    }
  }

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
  // Cross-garment seam rest: the tighter of the two pieces' weaves, not just
  // a's, so a waist seam between a narrow bodice and a 1.6× skirt isn't slack
  // toward the wider piece (audit M13).
  const seamRest = Math.min(a.spacing, b.spacing) * 0.15;
  const surfaceSeamRest = Math.max(
    0.0025,
    Math.min(0.005, Math.max(a.spacing, a.spacingV, b.spacing, b.spacingV) * 0.35),
  );
  for (const cs of seams) {
    const surfaceSeam = surfaceSeamKeys.has(`${cs.i}:${cs.j}`);
    all.push({
      i: cs.i,
      j: cs.j,
      rest: surfaceSeam ? surfaceSeamRest : seamRest,
      kind: surfaceSeam
        ? ConstraintKind.SurfaceSeam
        : cs.zipper
          ? ConstraintKind.ZipperSeam
          : cs.attachment
            ? ConstraintKind.AttachmentSeam
            : ConstraintKind.Seam,
    });
  }
  const { ordered, colorOffsets, colorCounts, phaseColorRanges } = colorConstraints(all, count);

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
        softness: dv2.getFloat32(base + 20, true),
        warpWeight: dv2.getFloat32(base + 24, true),
        baseRestAngle: dv2.getFloat32(base + 28, true),
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
    qdv.setFloat32(base + 20, q.softness ?? 1, true); // pressing survives the merge
    qdv.setFloat32(base + 24, q.warpWeight ?? 0.5, true);
    qdv.setFloat32(base + 28, q.baseRestAngle ?? q.restAngle, true);
  }

  const triangles = Array.from(a.triangleIndices);
  for (let t = 0; t < b.triangleIndices.length; t++) {
    triangles.push(b.triangleIndices[t]! + a.count);
  }
  // A cross-mesh seam closes two independently rendered cut boundaries just
  // like a manual seam inside one generated garment. Pocket/support stitches
  // are intentionally excluded: a SurfaceSeam attaches an overlay onto the
  // face of another panel and must never grow a side wall between both cloths.
  const renderSeams = seams.filter(
    (cs) => !surfaceSeamKeys.has(`${cs.i}:${cs.j}`),
  );
  appendBoundarySeamRibbons(
    triangles,
    renderSeams,
    na * na,
    undefined,
    (index) => { seamFree[index] = 1; },
  );
  // Bouchage des petits trous (v205) : apres les rubans de couture, il reste de
  // petites boucles de bord que le zip laisse entre deux epingles (echelle de
  // trous le long de la couture manche<->emmanchure, et aux pointes d epaule).
  // On les ferme au niveau TOPOLOGIQUE : toute boucle de bord courte (<= HOLE_MAX
  // aretes) est triangulee en eventail. Les grandes ouvertures legitimes
  // (encolure, ourlet, poignets ~ 88-132 aretes) restent ouvertes. Robuste pour
  // tous les vetements : seules les vraies petites fuites sont comblees.
  {
    const HOLE_MAX = 24; // aretes : au dela = ouverture legitime (encolure/ourlet/poignet)
    const ec = new Map<string, number>();
    const ek = (x: number, y: number) => (x < y ? x + '|' + y : y + '|' + x);
    for (let t = 0; t < triangles.length; t += 3) {
      const t0 = triangles[t]!, t1 = triangles[t + 1]!, t2 = triangles[t + 2]!;
      for (const [x, y] of [[t0, t1], [t1, t2], [t2, t0]] as [number, number][]) {
        const k = ek(x, y); ec.set(k, (ec.get(k) ?? 0) + 1);
      }
    }
    // Aretes de bord (utilisees 1x) + adjacence.
    const bedgeList: [number, number][] = [];
    const adj = new Map<number, number[]>();
    for (const [k, c] of ec) {
      if (c !== 1) continue;
      const bar = k.indexOf('|');
      const a2 = Number(k.slice(0, bar)), b2 = Number(k.slice(bar + 1));
      bedgeList.push([a2, b2]);
      (adj.get(a2) ?? adj.set(a2, []).get(a2)!).push(b2);
      (adj.get(b2) ?? adj.set(b2, []).get(b2)!).push(a2);
    }
    // Composantes connexes = boucles de contour ; id + nb d aretes + sommet mini.
    const compId = new Map<number, number>();
    const compApex: number[] = [];
    for (const s0 of adj.keys()) {
      if (compId.has(s0)) continue;
      const id = compApex.length; let apex = s0;
      const stack = [s0]; compId.set(s0, id);
      while (stack.length) {
        const cur = stack.pop()!; if (cur < apex) apex = cur;
        for (const nb of adj.get(cur)!) if (!compId.has(nb)) { compId.set(nb, id); stack.push(nb); }
      }
      compApex.push(apex);
    }
    const compEdges = new Array<number>(compApex.length).fill(0);
    for (const [a2] of bedgeList) compEdges[compId.get(a2)!]!++;
    // Bouchage en EVENTAIL par aretes : pour chaque petite composante, on relie
    // son sommet mini a toute arete de bord qui ne le touche pas. Robuste meme
    // aux jonctions (pas besoin d ordonner la boucle).
    for (const [a2, b2] of bedgeList) {
      const id = compId.get(a2)!;
      if (compEdges[id]! > HOLE_MAX || compEdges[id]! < 3) continue;
      const apex = compApex[id]!;
      if (a2 === apex || b2 === apex) continue;
      triangles.push(apex, a2, b2, apex, b2, a2); // double face : visible des deux cotes
    }
  }
  const triangleIndices = new Uint32Array(triangles);

  return {
    resolution: a.resolution,
    // Per-garment rest lengths: garment 0 = a, garment ≥1 = b (spacing2), so
    // prints stay square on each piece. The solver takes max(spacing, spacing2)
    // itself for its mesh-wide CFL/dihedral scale, so its behaviour is unchanged.
    spacing: a.spacing,
    spacingV: a.spacingV,
    spacing2: b.spacing,
    spacingV2: b.spacingV,
    count,
    positions,
    invMasses,
    constraintData,
    constraintCount: ordered.length,
    colorOffsets,
    colorCounts,
    constraintColorPhases: phaseColorRanges,
    quadData,
    quadCount: quadColoring.ordered.length,
    quadColorOffsets: quadColoring.colorOffsets,
    quadColorCounts: quadColoring.colorCounts,
    structuralCount: a.structuralCount + b.structuralCount,
    shearCount: a.shearCount + b.shearCount,
    bendingCount: a.bendingCount + b.bendingCount,
    // Cross-garment seams (embu / robe froncée waist) are real Seam edges in
    // `ordered`, so count them too — otherwise the per-kind totals no longer
    // sum to constraintCount for any sewn combination (audit M12).
    seamCount: a.seamCount + b.seamCount + seams.length,
    cornerIndices: a.cornerIndices,
    triangleIndices,
    layers,
    materialIds,
    surfaceMasks,
    surfaceContactData,
    surfaceContactCount: allSurfaceContacts.length,
    seamFree,
    seamDist,
    anchorY,
  };
}
