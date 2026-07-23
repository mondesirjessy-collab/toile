/**
 * Draft — the freeform pattern document (the "atelier" 2D→3D editor).
 *
 * A draft is a first-class, UV-native description of a hand-drawn pattern
 * piece: an outline polygon, interior darts (wedges sewn shut to shape the
 * flat piece into 3D), hand-defined seams (two boundary runs sewn together),
 * and open edges (boundary left unsewn so the garment is wearable). It is the
 * single source of truth for freeform work, kept ENTIRELY separate from the
 * parametric archetypes — it compiles down to the same cloth mesh via the
 * existing generateSeamedPanels machinery (a polygon → a kept mask; a dart →
 * a mask notch + leg seams; a seam → cross-seam pairs).
 *
 * All coordinates are in pattern UV [0,1]², the same space generateSeamedPanels
 * samples, with v growing DOWNWARD (world y = topY − v·height), like the
 * archetypes. This module is pure (no engine/GPU imports) and unit-testable.
 */

import { clampFabricGsm } from '../solver/FabricMaterial';

export type UV = [number, number];

/** An interior wedge, sewn shut to cup the flat piece into 3D (bust/waist dart). */
export interface Dart {
  apex: UV; // strictly inside the outline
  legA: UV; // mouth corner, on/near the boundary
  legB: UV; // mouth corner, on/near the boundary
}

/** A contiguous slice of the outline, by vertex index (inclusive), walked CCW. */
export interface EdgeRun {
  from: number;
  to: number;
}

/** Sew two boundary runs of the piece together (dart-independent join). */
export interface HandSeam {
  a: EdgeRun;
  b: EdgeRun;
}

/** An outline edge on a named piece. A run identifies its piece either by the
 * legacy `face` ('front'=piece 0, 'back'=piece 1) OR by an explicit `pieceId`
 * (0=front, 1=back, ≥2=free pieces). `pieceIdOf` normalises the two; `face` is
 * kept so pre-N-piece drafts/tests keep round-tripping byte-identically. */
export interface FaceRun {
  face?: 'front' | 'back';
  pieceId?: number;
  from: number;
  to: number;
}

/** Normalised piece index of a run (pieceId wins; else face → 0/1). */
export function pieceIdOf(r: FaceRun): number {
  return r.pieceId ?? (r.face === 'back' ? 1 : 0);
}

/** A user-defined ASSEMBLY seam: sew a run of one face to a run of another
 * (or the same) face. This is the manual "click edge A, click edge B" join —
 * front↔back shoulders/sides, or within one face. */
export interface AssemblySeam {
  a: FaceRun;
  b: FaceRun;
  /**
   * A missing kind is the historical, ordinary stitch. `zipper` keeps the
   * same two-run topology while letting the editor and future garment controls
   * present it as a removable closure rather than a permanent seam.
   */
  kind?: 'seam' | 'zipper';
  /** Zippers are assembled only while closed. Irrelevant to ordinary seams. */
  closed?: boolean;
}

/** Whether an assembly link currently contributes physical seam constraints. */
export function assemblySeamIsClosed(seam: AssemblySeam): boolean {
  return seam.kind !== 'zipper' || seam.closed !== false;
}

export type PiecePlacementRole =
  | 'auto'
  | 'front'
  | 'back'
  | 'armL'
  | 'armR'
  | 'neck'
  | 'waist'
  | 'legL'
  | 'legR'
  | 'pocket'
  | 'free';

export interface PiecePlacement {
  /** Human/body role used by the guided pre-placement assistant. */
  role: PiecePlacementRole;
  /** Align the piece rigidly to its sewn edges before physics starts. */
  autoAlign?: boolean;
  /** Reverse the entering edge order when the preview shows a half-twist. */
  reverseSeam?: boolean;
  /**
   * Patch/pocket placement on the surface of another pattern piece. The
   * overlay keeps its own physical dimensions; `anchor` is the exact point on
   * the support under the overlay's centre. Each entry in `stitchedEdges`
   * represents one independently removable top-stitch.
   */
  surface?: SurfaceAttachment;
}

export interface SurfaceAttachment {
  supportPieceId: number;
  anchor: UV;
  rotationRad?: number;
  stitchedEdges: number[];
}

export interface DraftPiece {
  outline: UV[]; // closed polygon, ≥3 pts, in [0,1]²
  darts: Dart[];
  seams: HandSeam[];
  openEdges: EdgeRun[]; // boundary runs left OPEN (not mirror-sewn) — e.g. the neckline
  /** Human cutting-room metadata. It stays attached while the piece is edited,
   * exported and re-imported, but does not change its geometry. */
  name?: string;
  cut?: number;
  onFold?: boolean;
  /** A construction piece shown/editable in the 2D atelier but intentionally
   * excluded from cloth simulation (pocket bags, fly pieces, waistband…). */
  patternOnly?: boolean;
  /**
   * Optional fabric assigned to this cutting piece. Absent means that the
   * piece follows the live global fabric selected in the material panel.
   */
  fabricPreset?: import('../solver/FabricMaterial').FabricPresetName;
  /** Piece-specific fabric mass in g/m². Absent means preset/global default. */
  arealDensityGsm?: number;
  // Physical placement in meters — mirrors generateSeamedPanels.
  width: number;
  height: number;
  topY: number;
  gap: number;
  // WRAP MODE (free pieces only): spawn the piece wrapped around a body part —
  // its two panels straddle it in z — instead of flat in front of the body.
  // With its rim mirror-stitched along both long edges (the default), the
  // piece closes into a TUBE ; its top run cross-sewn makes a real sleeve
  // ('armL'/'armR', tilted to the arm's A-pose) or a NECKBAND ('neck', the
  // ring that cinches the neckline — cut shorter than the neck hole, it pulls
  // the collar in and lets a deep front drop hold). Absent → flat spawn.
  wrap?: 'armL' | 'armR' | 'neck';
  /** Simulation placement metadata. Independent from the movable 2D layout. */
  placement?: PiecePlacement;
  /**
   * Translation used only to arrange the frozen pieces in the 3D preparation
   * view. It never changes the pattern geometry and is deliberately ignored
   * by the final assembly/simulation spawn.
   */
  stagingOffset?: [number, number, number];
  /**
   * Preparation translations for repeated physical instances of the same
   * cutting piece (for example the left and right trouser fronts). Each copy
   * can be arranged independently in 3D while sharing one editable 2D pattern.
   */
  stagingOffsets?: Array<[number, number, number] | null>;
}

export interface DraftDoc {
  format: 'toile-draft';
  version: 1;
  gridN: 32 | 64 | 128; // authoring/sim resolution
  piece: DraftPiece; // the FRONT face
  back?: DraftPiece; // optional INDEPENDENT back face (côte-à-côte). Absent/blank → the back mirrors the front.
  // MANUAL assembly (CLO-style): when true, NOTHING is auto-sewn — the garment
  // holds only where the user defined `seams`. Absent/false → the old automatic
  // perimeter sew (back-compat with pre-manual saved drafts).
  manual?: boolean;
  seams?: AssemblySeam[]; // user-defined assembly seams (edge A ↔ edge B, cross-face)
  // Editing-only constraints: two outline edges whose length changes stay
  // synchronised. Same endpoint shape as AssemblySeam, but no physical stitch
  // is generated from these links.
  segmentLinks?: AssemblySeam[];
  // FREE pieces (multi-piece editor): extra hand-drawn pieces beyond front/back.
  // Index 0 here is pieceId 2, index 1 is pieceId 3, … Each becomes its own mesh
  // combined onto the base via combineClothMeshes (see compileCrossSeams). Absent
  // ⇒ the garment is exactly the front/back base (byte-identical to pre-N-piece).
  pieces?: DraftPiece[];
  /** Optional built-in pattern identity, preserved through export/import so the
   * matching size controls and any specialised assembly can be restored. */
  preset?: 'boxy-tee' | 'loose-pants' | 'lucas-hoodie';
  presetSize?: string;
}

/** All pieces of a doc indexed by pieceId: [front, back, ...free]. Slots may be
 * null (no back drawn yet). Free pieces start at index 2. */
export function docPieces(doc: DraftDoc): (DraftPiece | null)[] {
  return [doc.piece, doc.back ?? null, ...(doc.pieces ?? [])];
}

/** One stable human label everywhere the same pieceId is displayed or exported. */
export function draftPieceLabel(
  piece: DraftPiece | null | undefined,
  pieceId: number,
): string {
  const named = piece?.name?.trim();
  if (named) return named;
  if (pieceId === 0) return 'Devant';
  if (pieceId === 1) return 'Dos';
  if (piece?.wrap === 'armR') return 'Manche droite';
  if (piece?.wrap === 'armL') return 'Manche gauche';
  if (piece?.wrap === 'neck') return 'Col';
  return `Pièce ${pieceId + 1}`;
}

/** Every outline segment starts sewn for an appliqué; the user can open any
 * segment afterwards (for example the top of a patch pocket). */
export function defaultSurfaceStitches(piece: DraftPiece): number[] {
  return piece.outline.map((_point, edge) => edge);
}

/** Exact support UV under one overlay UV, preserving metric size and allowing
 * a future rotation without baking placement into the cutting geometry. */
export function surfaceAttachmentUV(
  overlay: DraftPiece,
  support: DraftPiece,
  surface: SurfaceAttachment,
  overlayUV: readonly [number, number],
): UV {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [u, v] of overlay.outline) {
    const x = (u - 0.5) * overlay.width;
    const y = overlay.topY - v * overlay.height;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const cy = Number.isFinite(minY) ? (minY + maxY) / 2 : overlay.topY - overlay.height / 2;
  const x = (overlayUV[0] - 0.5) * overlay.width - cx;
  const y = overlay.topY - overlayUV[1] * overlay.height - cy;
  const angle = surface.rotationRad ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const anchorX = (surface.anchor[0] - 0.5) * support.width;
  const anchorY = support.topY - surface.anchor[1] * support.height;
  const targetX = anchorX + x * cos - y * sin;
  const targetY = anchorY + x * sin + y * cos;
  return [
    targetX / support.width + 0.5,
    (support.topY - targetY) / support.height,
  ];
}

/** Ray-cast point-in-polygon (odd crossings = inside). Winding-agnostic. */
export function pointInPolygon(p: UV, poly: readonly UV[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    // Edge straddles the horizontal ray from p going +x?
    if ((yi > p[1]) !== (yj > p[1])) {
      const xCross = xi + ((p[1] - yi) / (yj - yi)) * (xj - xi);
      if (p[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Barycentric point-in-triangle (inclusive of the edges). */
export function pointInTriangle(p: UV, a: UV, b: UV, c: UV): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos); // all same sign (or on an edge) ⇒ inside
}

function sign(p: UV, a: UV, b: UV): number {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}

/** True if the closed polygon has any non-adjacent edge crossing (self-intersecting). */
export function isSelfIntersecting(poly: readonly UV[]): boolean {
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip shared-vertex neighbours (adjacent edges always "touch").
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % n]!;
      if (segsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function segsCross(p1: UV, p2: UV, p3: UV, p4: UV): boolean {
  const d1 = sign(p3, p4, p1);
  const d2 = sign(p3, p4, p2);
  const d3 = sign(p1, p2, p3);
  const d4 = sign(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** Squared distance from point p to segment a-b. */
function segDist2(p: UV, a: UV, b: UV): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const len2 = abx * abx + aby * aby || 1e-12;
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2));
  const dx = a[0] + t * abx - p[0];
  const dy = a[1] + t * aby - p[1];
  return dx * dx + dy * dy;
}

/** Index of the outline edge (k = vertex k → vertex (k+1)%N) nearest to p. */
export function nearestOutlineEdge(p: UV, outline: readonly UV[]): number {
  const N = outline.length;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < N; k++) {
    const d = segDist2(p, outline[k]!, outline[(k + 1) % N]!);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Does the edge-run (vertices from..to, CCW) contain outline edge `edge`? */
export function runCoversEdge(run: EdgeRun, edge: number, nV: number): boolean {
  const steps = (run.to - run.from + nV) % nV; // number of edges spanned
  for (let k = 0; k < steps; k++) if ((run.from + k) % nV === edge) return true;
  return false;
}

/** Shift an edge-run's indices when a vertex is inserted at position `at`. */
function shiftRunInsert(r: EdgeRun, at: number): EdgeRun {
  return { from: r.from >= at ? r.from + 1 : r.from, to: r.to >= at ? r.to + 1 : r.to };
}

/** Shift/clamp an edge-run when the vertex at `at` is removed (nV = new length). */
function shiftRunDelete(r: EdgeRun, at: number, nV: number): EdgeRun {
  const adj = (i: number): number => Math.min(nV - 1, Math.max(0, i > at ? i - 1 : i === at ? Math.max(0, at - 1) : i));
  return { from: adj(r.from), to: adj(r.to) };
}

function surfaceAfterInsert(
  placement: PiecePlacement | undefined,
  edge: number,
): PiecePlacement | undefined {
  const surface = placement?.surface;
  if (!surface) return placement;
  const shifted = new Set<number>();
  for (const sewn of surface.stitchedEdges) {
    if (sewn < edge) shifted.add(sewn);
    else if (sewn === edge) {
      shifted.add(edge);
      shifted.add(edge + 1);
    } else shifted.add(sewn + 1);
  }
  return {
    ...placement,
    surface: { ...surface, stitchedEdges: [...shifted].sort((a, b) => a - b) },
  };
}

function surfaceAfterDelete(
  placement: PiecePlacement | undefined,
  at: number,
  oldLength: number,
): PiecePlacement | undefined {
  const surface = placement?.surface;
  if (!surface) return placement;
  const previous = (at + oldLength - 1) % oldLength;
  const nextLength = Math.max(1, oldLength - 1);
  const merged = at === 0 ? nextLength - 1 : at - 1;
  const shifted = new Set<number>();
  for (const sewn of surface.stitchedEdges) {
    if (sewn === previous || sewn === at) shifted.add(merged);
    else if (sewn > at) shifted.add(sewn - 1);
    else shifted.add(Math.min(sewn, nextLength - 1));
  }
  return {
    ...placement,
    surface: { ...surface, stitchedEdges: [...shifted].sort((a, b) => a - b) },
  };
}

/**
 * Insert a new outline vertex right after edge `edge` (i.e. between vertices
 * `edge` and `edge+1`), at UV `uv`. Returns a NEW piece with openEdges/seam
 * runs re-indexed so they still point at the same boundary. Pure.
 */
export function insertOutlineVertex(piece: DraftPiece, edge: number, uv: UV): DraftPiece {
  const at = edge + 1; // new vertex index
  const outline = [...piece.outline.slice(0, at), [uv[0], uv[1]] as UV, ...piece.outline.slice(at)];
  return {
    ...piece,
    outline,
    openEdges: piece.openEdges.map((r) => shiftRunInsert(r, at)),
    seams: piece.seams.map((s) => ({ a: shiftRunInsert(s.a, at), b: shiftRunInsert(s.b, at) })),
    placement: surfaceAfterInsert(piece.placement, edge),
  };
}

/**
 * Comme nearestOutlineEdge, mais rend AUSSI la distance — le pont « clic 3D →
 * bord à coudre » : une particule (sa cellule → UV) choisit le bord de patron
 * qu'elle longe, et un clic trop loin de tout bord est rejeté. Pure.
 */
export function nearestOutlineEdgeInfo(p: UV, outline: readonly UV[]): { edge: number; dist: number } {
  const N = outline.length;
  let edge = 0;
  let d2 = Infinity;
  for (let k = 0; k < N; k++) {
    const d = segDist2(p, outline[k]!, outline[(k + 1) % N]!);
    if (d < d2) {
      d2 = d;
      edge = k;
    }
  }
  return { edge, dist: Math.sqrt(d2) };
}

/**
 * Décaler le contour d'une pièce DANS sa boîte (déplacement 3D → glissement du
 * masque), pinces comprises, borné pour que l'emprise reste dans [0,1]².
 * Renvoie une NOUVELLE pièce ; les index de bords ne bougent pas (coutures et
 * bords ouverts restent valides). Pure.
 */
export function shiftOutlineUV(piece: DraftPiece, du: number, dv: number): DraftPiece {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [u, v] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const cu = Math.max(-uMin, Math.min(1 - uMax, du));
  const cv = Math.max(-vMin, Math.min(1 - vMax, dv));
  const sh = ([u, v]: UV): UV => [u + cu, v + cv];
  return {
    ...piece,
    outline: piece.outline.map(sh),
    darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
  };
}

/**
 * Déplacer une pièce LIBRE sans limite (patronner en 3D). Vertical : la boîte
 * suit (topY += dy, le contour ne bouge pas dedans). Horizontal : le contour
 * glisse dans sa boîte ; s'il déborde, la boîte S'ÉLARGIT symétriquement —
 * x = (u−0.5)·width est centré sur 0, donc poser une pièce loin du centre
 * demande une boîte qui couvre jusque-là — puis le contour est re-mappé à
 * géométrie monde constante. Pinces suivies, index de bords intacts. Pure.
 */
export function movePieceWorld(piece: DraftPiece, dx: number, dy: number): DraftPiece {
  const moved: DraftPiece = { ...piece, topY: piece.topY + dy };
  if (Math.abs(dx) < 1e-9) return moved;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const [u] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  const du = dx / piece.width;
  if (uMin + du >= 0 && uMax + du <= 1) {
    const sh = ([u, v]: UV): UV => [u + du, v];
    return {
      ...moved,
      outline: piece.outline.map(sh),
      darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
    };
  }
  // Débordement : élargir la boîte pour couvrir le contour décalé (en monde).
  const xMinW = (uMin - 0.5) * piece.width + dx;
  const xMaxW = (uMax - 0.5) * piece.width + dx;
  const w2 = 2 * (Math.max(Math.abs(xMinW), Math.abs(xMaxW)) + 0.02);
  const sh = ([u, v]: UV): UV => [((u - 0.5) * piece.width + dx) / w2 + 0.5, v];
  return {
    ...moved,
    width: w2,
    outline: piece.outline.map(sh),
    darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
  };
}

/**
 * Put two base faces into one shared physical frame without moving either
 * outline. `generateSeamedPanels` rasterises front and back on the front face's
 * frame, so an automatic frame expansion on one face must be mirrored onto the
 * other face or the untouched side would be stretched accidentally.
 */
export function syncPieceFrames(front: DraftPiece, back: DraftPiece): { front: DraftPiece; back: DraftPiece } {
  const physical = (piece: DraftPiece): { outline: [number, number][]; darts: [number, number][][] } => {
    const world = ([u, v]: UV): [number, number] => [(u - 0.5) * piece.width, piece.topY - v * piece.height];
    return {
      outline: piece.outline.map(world),
      darts: piece.darts.map((d) => [world(d.apex), world(d.legA), world(d.legB)]),
    };
  };
  const f = physical(front);
  const b = physical(back);
  let halfWidth = Math.max(front.width, back.width) / 2;
  let topY = Math.max(front.topY, back.topY);
  let bottomY = Math.min(front.topY - front.height, back.topY - back.height);
  for (const [x, y] of [...f.outline, ...b.outline, ...f.darts.flat(), ...b.darts.flat()]) {
    halfWidth = Math.max(halfWidth, Math.abs(x));
    topY = Math.max(topY, y);
    bottomY = Math.min(bottomY, y);
  }
  const width = Math.max(1e-4, halfWidth * 2);
  const height = Math.max(1e-4, topY - bottomY);
  const uv = ([x, y]: [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  const remap = (piece: DraftPiece, data: { outline: [number, number][]; darts: [number, number][][] }): DraftPiece => ({
    ...piece,
    width,
    height,
    topY,
    outline: data.outline.map(uv),
    darts: data.darts.map((d) => ({ apex: uv(d[0]!), legA: uv(d[1]!), legB: uv(d[2]!) })),
  });
  return { front: remap(front, f), back: remap(back, b) };
}

/**
 * Déplacer une FACE du torse (devant 0 / dos 1) sans limite. Les deux faces
 * partagent LA boîte de base (le mesh est généré sur la boîte du devant) : la
 * face visée est décalée en MONDE, puis la boîte est re-taillée pour couvrir
 * les deux faces (+ marge), et les deux contours sont re-mappés à géométrie
 * monde constante. Les champs de boîte des deux pièces restent synchrones.
 * Rend { front, back } neufs. Pure.
 */
export function moveFaceWorld(
  front: DraftPiece,
  back: DraftPiece,
  which: 0 | 1,
  dx: number,
  dy: number,
): { front: DraftPiece; back: DraftPiece } {
  const box = front; // la boîte de référence du mesh de base
  const world = (piece: DraftPiece, mdx: number, mdy: number): { pts: [number, number][]; darts: [number, number][][] } => ({
    pts: piece.outline.map(([u, v]) => [(u - 0.5) * box.width + mdx, box.topY - v * box.height + mdy]),
    darts: piece.darts.map((d) => [d.apex, d.legA, d.legB].map(([u, v]) => [(u - 0.5) * box.width + mdx, box.topY - v * box.height + mdy])),
  });
  const wF = world(front, which === 0 ? dx : 0, which === 0 ? dy : 0);
  const wB = world(back, which === 1 ? dx : 0, which === 1 ? dy : 0);
  const PAD = 0.02;
  let xAbs = 0;
  let yTop = -Infinity;
  let yBot = Infinity;
  for (const [x, y] of [...wF.pts, ...wB.pts]) {
    xAbs = Math.max(xAbs, Math.abs(x));
    yTop = Math.max(yTop, y);
    yBot = Math.min(yBot, y);
  }
  const width = 2 * (xAbs + PAD);
  const topY = yTop + PAD;
  const height = Math.max(0.05, topY - yBot + PAD);
  const uv = ([x, y]: [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  const rebox = (piece: DraftPiece, w: { pts: [number, number][]; darts: [number, number][][] }): DraftPiece => ({
    ...piece,
    width,
    height,
    topY,
    outline: w.pts.map(uv),
    darts: w.darts.map((t) => ({ apex: uv(t[0]!), legA: uv(t[1]!), legB: uv(t[2]!) })),
  });
  return { front: rebox(front, wF), back: rebox(back, wB) };
}

/**
 * Re-boîter une pièce sur l'EMPRISE de son tracé : la boîte (width/height/topY)
 * devient le rectangle englobant du contour dessiné, contour et pinces re-mappés
 * en UV pour que la GÉOMÉTRIE MONDE reste identique. C'est le pont « zone de
 * confection libre » → placement : une pièce dessinée sur la silhouette
 * grandeur nature se re-boîte serrée (contour plein bord = la famille de
 * contours éprouvée pour les tubes v112) avant de s'enrouler autour d'un bras
 * ou du cou. `gap` est remplacé par celui du placement. Pure.
 */
export function reboxPiece(piece: DraftPiece, gap: number): DraftPiece {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [u, v] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const w = (uMax - uMin) * piece.width;
  const h = (vMax - vMin) * piece.height;
  if (!(w > 1e-4) || !(h > 1e-4)) return piece; // tracé dégénéré : ne rien casser
  // Monde : x = (u − 0.5)·W (centre colonne 0), y = topY − v·H.
  const topY = piece.topY - vMin * piece.height;
  const cxWorld = ((uMin + uMax) / 2 - 0.5) * piece.width;
  const mapUV = ([u, v]: UV): UV => [
    ((u - 0.5) * piece.width - cxWorld) / w + 0.5,
    (topY - (piece.topY - v * piece.height)) / h,
  ];
  return {
    ...piece,
    width: w,
    height: h,
    topY,
    gap,
    outline: piece.outline.map(mapUV),
    darts: piece.darts.map((d) => ({ apex: mapUV(d.apex), legA: mapUV(d.legA), legB: mapUV(d.legB) })),
  };
}

/**
 * Remove the outline vertex at `index` (no-op if that would leave < 3 vertices).
 * Returns a NEW piece with openEdges/seam runs re-indexed. Pure.
 */
export function deleteOutlineVertex(piece: DraftPiece, index: number): DraftPiece {
  if (piece.outline.length <= 3) return piece;
  const oldLength = piece.outline.length;
  const outline = piece.outline.filter((_, i) => i !== index);
  const nV = outline.length;
  return {
    ...piece,
    outline,
    openEdges: piece.openEdges.map((r) => shiftRunDelete(r, index, nV)),
    seams: piece.seams.map((s) => ({ a: shiftRunDelete(s.a, index, nV), b: shiftRunDelete(s.b, index, nV) })),
    placement: surfaceAfterDelete(piece.placement, index, oldLength),
  };
}

/**
 * Compile a piece's openEdges into the UV predicate generateSeamedPanels wants:
 * a boundary cell is "open" (not mirror-sewn) when its nearest outline edge
 * falls inside any open run.
 */
export function draftOpenings(piece: DraftPiece): (uu: number, vv: number) => boolean {
  const { outline, openEdges } = piece;
  const nV = outline.length;
  if (!openEdges.length) return () => false;
  return (uu: number, vv: number): boolean => {
    const e = nearestOutlineEdge([uu, vv], outline);
    return openEdges.some((run) => runCoversEdge(run, e, nV));
  };
}

/** Fractional projection of p onto segment a→b (0 at a, 1 at b), clamped. */
function projFrac(p: UV, a: UV, b: UV): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1e-9;
  return Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
}

/**
 * Compile a freeform piece to the sim inputs at grid resolution n: which
 * boundary cells are OPEN (openEdges + dart legs — not mirror-sewn) and the
 * front-panel LOCAL cell pairs to sew (each dart's two legs, paired by
 * arc-length from the apex, so the wedge closes and cups the flat piece into
 * 3D). Mirrors generateSeamedPanels' own rasterization (same pointInPolygon +
 * dart subtraction), so the cell indices line up.
 */
export function compileDraft(piece: DraftPiece, n: number): { extraSeams: { i: number; j: number }[]; openCells: Set<number> } {
  const { outline, darts, openEdges } = piece;
  const nV = outline.length;
  const uvOf = (u: number, v: number): UV => [u / (n - 1), v / (n - 1)];

  // 1. Rasterize the kept mask (polygon minus dart wedges).
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p = uvOf(u, v);
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const isBoundary = (u: number, v: number): boolean => {
    if (!kept[v * n + u]) return false;
    return (
      u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
      !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
    );
  };

  const openCells = new Set<number>();
  // 2. openEdges → open boundary cells (nearest outline edge in an open run).
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      if (!isBoundary(u, v)) continue;
      const e = nearestOutlineEdge(uvOf(u, v), outline);
      if (openEdges.some((r) => runCoversEdge(r, e, nV))) openCells.add(v * n + u);
    }

  // 3. Each dart: partition the wedge's boundary cells into the two legs (by
  // whichever leg they sit closer to), open them, and pair by arc-length.
  const extraSeams: { i: number; j: number }[] = [];
  const thresh2 = (1.6 / (n - 1)) ** 2;
  for (const d of darts) {
    const A: { cell: number; t: number }[] = [];
    const B: { cell: number; t: number }[] = [];
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        if (!isBoundary(u, v)) continue;
        const p = uvOf(u, v);
        const dA = segDist2(p, d.apex, d.legA);
        const dB = segDist2(p, d.apex, d.legB);
        if (Math.min(dA, dB) > thresh2) continue;
        const cell = v * n + u;
        if (dA <= dB) A.push({ cell, t: projFrac(p, d.apex, d.legA) });
        else B.push({ cell, t: projFrac(p, d.apex, d.legB) });
      }
    A.sort((x, y) => x.t - y.t);
    B.sort((x, y) => x.t - y.t);
    for (const c of A) openCells.add(c.cell);
    for (const c of B) openCells.add(c.cell);
    // Pair by normalized position along each leg (pro-rata, like the gathered
    // waist), resampling to the shorter list.
    const m = Math.min(A.length, B.length);
    for (let k = 0; k < m; k++) {
      const a = A[Math.floor((k * A.length) / m)]!;
      const b = B[Math.floor((k * B.length) / m)]!;
      if (a.cell !== b.cell) extraSeams.push({ i: a.cell, j: b.cell });
    }
  }

  // 4. Hand-defined seams: sew two boundary runs of the piece together. Resolve
  // each run to its ordered boundary cells, pick the direction that zips them
  // together (not twisted), open them, and pair by arc-length.
  const runCells = (run: EdgeRun): { cell: number; t: number }[] =>
    boundaryRunCells(piece, run, n);
  for (const hs of piece.seams) {
    const A = runCells(hs.a);
    const B = runCells(hs.b);
    if (!A.length || !B.length) continue;
    for (const c of A) openCells.add(c.cell);
    for (const c of B) openCells.add(c.cell);
    const m = Math.min(A.length, B.length);
    const cellUV = (cell: number): UV => [(cell % n) / (n - 1), Math.floor(cell / n) / (n - 1)];
    const bAt = (k: number, reversed: boolean): { cell: number } => B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
    // Direction check: forward vs reversed B — keep whichever zips closer.
    const cost = (reversed: boolean): number => {
      let s = 0;
      for (let k = 0; k < m; k++) {
        const pa = cellUV(A[Math.floor((k * A.length) / m)]!.cell);
        const pb = cellUV(bAt(k, reversed).cell);
        s += (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2;
      }
      return s;
    };
    const reversed = cost(true) < cost(false);
    for (let k = 0; k < m; k++) {
      const a = A[Math.floor((k * A.length) / m)]!;
      const b = bAt(k, reversed);
      if (a.cell !== b.cell) extraSeams.push({ i: a.cell, j: b.cell });
    }
  }
  return { extraSeams, openCells };
}

/** Ordered boundary cells (by arc-length along the run) that a run of a piece's
 * outline resolves to at grid resolution n. Shared by hand-seams and manual
 * assembly seams to pair two edges cell-by-cell. */
function boundaryRunCells(
  piece: Pick<DraftPiece, 'outline' | 'darts' | 'width' | 'height'>,
  run: { from: number; to: number },
  n: number,
): { cell: number; t: number }[] {
  const { outline, darts } = piece;
  const nV = outline.length;
  const uvOf = (u: number, v: number): UV => [u / (n - 1), v / (n - 1)];
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p = uvOf(u, v);
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const isBoundary = (u: number, v: number): boolean => {
    if (!kept[v * n + u]) return false;
    return (
      u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
      !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
    );
  };
  const from = ((Math.round(run.from) % nV) + nV) % nV;
  const to = ((Math.round(run.to) % nV) + nV) % nV;
  const edgeIndices: number[] = [];
  for (let edge = from; edge !== to && edgeIndices.length < nV; edge = (edge + 1) % nV) {
    edgeIndices.push(edge);
  }
  if (!edgeIndices.length) return [];

  // A run may follow a deep armhole, hood curve or sleeve cap. Ordering its
  // raster cells by projection on the single from→to chord folds that curve
  // back onto itself and cross-zips distant points. Parameterise the authored
  // polyline by its real metric arc length instead.
  const physical = (point: UV): UV => [
    point[0] * piece.width,
    point[1] * piece.height,
  ];
  const edgeSet = new Set(edgeIndices);
  const before = new Map<number, number>();
  const lengths = new Map<number, number>();
  let totalLength = 0;
  for (const edge of edgeIndices) {
    const a = physical(outline[edge]!);
    const b = physical(outline[(edge + 1) % nV]!);
    before.set(edge, totalLength);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.set(edge, length);
    totalLength += length;
  }
  totalLength = Math.max(totalLength, 1e-9);

  const boundary: Array<{ cell: number; point: UV }> = [];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (isBoundary(u, v)) {
        boundary.push({ cell: v * n + u, point: uvOf(u, v) });
      }
    }
  }

  const nearestEdgePhysical = (point: UV): number => {
    const p = physical(point);
    let bestEdge = 0;
    let bestDistance = Infinity;
    for (let edge = 0; edge < nV; edge++) {
      const distance = segDist2(
        p,
        physical(outline[edge]!),
        physical(outline[(edge + 1) % nV]!),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestEdge = edge;
      }
    }
    return bestEdge;
  };
  const parameterOnEdge = (point: UV, edge: number): number => {
    const p = physical(point);
    const a = physical(outline[edge]!);
    const b = physical(outline[(edge + 1) % nV]!);
    const fraction = projFrac(p, a, b);
    return (
      (before.get(edge) ?? 0) + fraction * (lengths.get(edge) ?? 0)
    ) / totalLength;
  };

  const byCell = new Map<number, number>();
  const boundaryOwner = new Map<number, number>();
  for (const candidate of boundary) {
    const edge = nearestEdgePhysical(candidate.point);
    boundaryOwner.set(candidate.cell, edge);
    if (!edgeSet.has(edge)) continue;
    byCell.set(candidate.cell, parameterOnEdge(candidate.point, edge));
  }

  // Adjacent sewn runs must meet on the same particle. Raster ownership alone
  // assigns a corner to only one of its two incident edges, leaving a visible
  // one-cell eyelet at shoulders, underarms and band junctions. Deliberately
  // include the nearest live boundary particle at both authored endpoints.
  const nearestBoundaryCell = (
    vertex: UV,
    outgoingEdge: number,
  ): number | null => {
    const target = physical(vertex);
    // Use the first raster cell owned by the edge leaving this vertex. Both
    // adjacent runs therefore choose the same junction cell. Picking the
    // globally nearest cell can land two or three columns past the ownership
    // transition on a sharp neckline corner, creating an unstitched raster
    // gap immediately before the nominal endpoint.
    const owned = boundary.filter(
      (candidate) => boundaryOwner.get(candidate.cell) === outgoingEdge,
    );
    if (owned.length) {
      const edgeA = physical(outline[outgoingEdge]!);
      const edgeB = physical(outline[(outgoingEdge + 1) % nV]!);
      let best = owned[0]!.cell;
      let bestFraction = projFrac(physical(owned[0]!.point), edgeA, edgeB);
      for (const candidate of owned.slice(1)) {
        const fraction = projFrac(physical(candidate.point), edgeA, edgeB);
        if (fraction < bestFraction) {
          bestFraction = fraction;
          best = candidate.cell;
        }
      }
      return best;
    }
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const candidate of boundary) {
      const point = physical(candidate.point);
      const distance =
        (point[0] - target[0]) ** 2 + (point[1] - target[1]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.cell;
      }
    }
    return best;
  };
  const startCell = nearestBoundaryCell(outline[from]!, from);
  const endCell = nearestBoundaryCell(outline[to]!, to);
  if (startCell !== null) byCell.set(startCell, 0);
  if (endCell !== null && endCell !== startCell) byCell.set(endCell, 1);

  return [...byCell]
    .map(([cell, t]) => ({ cell, t }))
    .sort((a, b) => a.t - b.t || a.cell - b.cell);
}

/**
 * Resolve the explicitly-open armhole on one side of a body piece.
 *
 * A pattern can have several open runs (neckline, hem, armholes). The left and
 * right armholes are the runs whose raster cells sit furthest from the centre
 * line. Requiring them to stay in the outer third deliberately avoids turning
 * a neckline or hem into a sleeve opening on an arbitrary hand-drawn body.
 *
 * Returned cells are LOCAL grid indices, ordered top→bottom independently of
 * polygon winding, so a right run drawn bottom→top cannot twist the sleeve.
 */
export function sideOpeningCells(piece: DraftPiece, side: 'L' | 'R', n: number): number[] {
  const candidates = piece.openEdges
    .map((run) => {
      const cells = boundaryRunCells(piece, run, n).map((x) => x.cell);
      const meanU = cells.length ? cells.reduce((sum, cell) => sum + (cell % n) / (n - 1), 0) / cells.length : 0.5;
      return { cells, meanU };
    })
    .filter((x) => x.cells.length > 1);
  if (!candidates.length) return [];
  const chosen = candidates.reduce((best, x) =>
    side === 'L' ? (x.meanU < best.meanU ? x : best) : x.meanU > best.meanU ? x : best,
  );
  if ((side === 'L' && chosen.meanU >= 1 / 3) || (side === 'R' && chosen.meanU <= 2 / 3)) return [];
  return chosen.cells.sort((a, b) => Math.floor(a / n) - Math.floor(b / n) || (a % n) - (b % n));
}

/**
 * Resolve the explicitly-open neckline of a body piece.
 *
 * A bodice usually exposes several open runs (neckline, two armholes and hem).
 * The neckline is the open run centred on the fold line and living in the
 * upper half of the pattern. Keeping this selection on the authored runs is
 * important: scanning a hard-coded horizontal interval also catches shoulder
 * cells whenever the real neck is narrower than that interval.
 *
 * Returned cells follow the neckline from pattern-left to pattern-right on
 * both front and back, independently of polygon winding. That common direction
 * lets a two-panel neck band meet its side seams without twisting.
 */
export function neckOpeningCells(piece: DraftPiece, n: number): number[] {
  const candidates = piece.openEdges
    .map((run) => {
      const cells = boundaryRunCells(piece, run, n).map((entry) => entry.cell);
      if (cells.length < 2) return null;
      const meanU =
        cells.reduce((sum, cell) => sum + (cell % n) / (n - 1), 0) /
        cells.length;
      const meanV =
        cells.reduce(
          (sum, cell) => sum + Math.floor(cell / n) / (n - 1),
          0,
        ) / cells.length;
      return { cells, meanU, meanV };
    })
    .filter(
      (
        candidate,
      ): candidate is { cells: number[]; meanU: number; meanV: number } =>
        candidate !== null &&
        candidate.meanU > 1 / 3 &&
        candidate.meanU < 2 / 3 &&
        candidate.meanV < 0.55,
    );
  if (!candidates.length) return [];

  const chosen = candidates.reduce((best, candidate) => {
    const score = candidate.meanV + Math.abs(candidate.meanU - 0.5);
    const bestScore = best.meanV + Math.abs(best.meanU - 0.5);
    return score < bestScore ? candidate : best;
  });
  const cells = chosen.cells.slice();
  if ((cells[0]! % n) > (cells[cells.length - 1]! % n)) cells.reverse();
  return cells;
}

/** Boundary-cell set of a piece's raster mask at resolution n: kept cells on the
 * grid edge or with a cut 4-neighbour (same rule as boundaryRunCells). Used to
 * guard both-faces seams: the mirrored endpoint must land on an EDGE of its own
 * panel's mask — an independent back outline can leave the same (u,v) alive but
 * interior, and a seam into mid-fabric pinches a permanent tuft there. */
function boundaryCellSet(outline: readonly UV[], darts: readonly Dart[], n: number): Set<number> {
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p: UV = [u / (n - 1), v / (n - 1)];
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const out = new Set<number>();
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      if (!kept[v * n + u]) continue;
      if (
        u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
        !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
      )
        out.add(v * n + u);
    }
  return out;
}

/**
 * Boundary cells of piece `pid`'s CROSS-SEWN runs (its edges sewn to another
 * piece via assembly seams). A sewn edge is no longer a free rim: the caller
 * must exclude these cells from the piece's own front↔back rim stitching
 * (extraOpenings), otherwise a both-faces assembly seam would transitively
 * weld the body's open edge shut THROUGH the body (front rim → piece front →
 * piece back → back rim: a few mm of quasi-rigid seam across the anatomy).
 */
export function crossSewnOpenCells(doc: DraftDoc, pid: number, n: number): number[] {
  const pieces = docPieces(doc);
  const piece = pieces[pid];
  if (!piece || piece.outline.length < 3) return [];
  const cells = new Set<number>();
  for (const s of doc.seams ?? []) {
    if (!assemblySeamIsClosed(s)) continue;
    const run = pieceIdOf(s.a) === pid ? s.a : pieceIdOf(s.b) === pid ? s.b : null;
    if (!run) continue;
    for (const c of boundaryRunCells(piece, { from: run.from, to: run.to }, n)) cells.add(c.cell);
  }
  return [...cells];
}

/** Pair two boundary runs cell-by-cell by arc-length, choosing the zip direction
 * (forward vs reversed B) that minimises total offset — anti-twist. Returns the
 * two aligned LOCAL cell lists (equal length), or null if either run is empty.
 * Shared by compileAssembly (base panels) and compileCrossSeams (extra meshes). */
function pairRunCells(
  pa: DraftPiece,
  pb: DraftPiece,
  runA: { from: number; to: number },
  runB: { from: number; to: number },
  n: number,
  reverseBOverride?: boolean,
): { a: number[]; b: number[] } | null {
  const A = boundaryRunCells(pa, runA, n);
  const B = boundaryRunCells(pb, runB, n);
  if (!A.length || !B.length) return null;
  const cellMetric = (piece: DraftPiece, cell: number): UV => [
    ((cell % n) / (n - 1) - 0.5) * piece.width,
    -(Math.floor(cell / n) / (n - 1)) * piece.height,
  ];
  // Zip over the LONGER run: every cell of both edges gets sewn (the shorter
  // run's cells repeat). Equal-length edges pair 1:1 as before; a long edge on
  // a short one GATHERS onto it — the tailor's embu — instead of leaving the
  // extra cells hanging (a sleeve cap held by a handful of pins slides off).
  const m = Math.max(A.length, B.length);
  const bAt = (k: number, reversed: boolean): { cell: number } => B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
  const cost = (reversed: boolean): number => {
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const paUV = cellMetric(pa, A[Math.floor((k * A.length) / m)]!.cell);
      const pbUV = cellMetric(pb, bAt(k, reversed).cell);
      sum += (paUV[0] - pbUV[0]) ** 2 + (paUV[1] - pbUV[1]) ** 2;
    }
    return sum;
  };
  const reversed = reverseBOverride ?? cost(true) < cost(false);
  const a: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < m; k++) {
    a.push(A[Math.floor((k * A.length) / m)]!.cell);
    b.push(bAt(k, reversed).cell);
  }
  return { a, b };
}

/** Resolve two outline runs to equally sampled local grid-cell sequences.
 * Public for specialised assemblies (for example the two mirrored crotch
 * seams of trousers); generic DraftDoc assembly continues through
 * `compileAssembly` below. */
export function pairOutlineRuns(
  pieceA: DraftPiece,
  pieceB: DraftPiece,
  runA: EdgeRun,
  runB: EdgeRun,
  n: number,
  reverseB?: boolean,
): { a: number[]; b: number[] } | null {
  return pairRunCells(pieceA, pieceB, runA, runB, n, reverseB);
}

/**
 * Resolve a draft's BASE assembly seams (front↔back, pieceId 0/1) into GLOBAL
 * cell-index pairs to sew (panel 0 = front, panel 1 = back). Cross-mesh seams
 * that touch a FREE piece (pieceId ≥ 2) are skipped here — they're compiled by
 * compileCrossSeams into the combined-mesh index space instead.
 */
export function compileAssembly(doc: DraftDoc, n: number): { i: number; j: number }[] {
  const panelSize = n * n;
  const pieces = docPieces(doc);
  const openCells = new Map<number, Set<number>>();
  const explicitlyOpen = (pieceId: number, piece: DraftPiece): Set<number> => {
    const cached = openCells.get(pieceId);
    if (cached) return cached;
    const cells = new Set<number>();
    for (const run of piece.openEdges) {
      for (const candidate of boundaryRunCells(piece, run, n)) {
        cells.add(candidate.cell);
      }
    }
    openCells.set(pieceId, cells);
    return cells;
  };
  const out: { i: number; j: number }[] = [];
  for (const s of doc.seams ?? []) {
    if (!assemblySeamIsClosed(s)) continue;
    const pidA = pieceIdOf(s.a);
    const pidB = pieceIdOf(s.b);
    if (pidA > 1 || pidB > 1) continue; // a free piece is involved → compileCrossSeams
    const pa = pieces[pidA];
    const pb = pieces[pidB];
    if (!pa || !pb || pa.outline.length < 3 || pb.outline.length < 3) continue;
    const paired = pairRunCells(pa, pb, { from: s.a.from, to: s.a.to }, { from: s.b.from, to: s.b.to }, n);
    if (!paired) continue;
    const offA = pidA * panelSize;
    const offB = pidB * panelSize;
    const openA = explicitlyOpen(pidA, pa);
    const openB = explicitlyOpen(pidB, pb);
    for (let k = 0; k < paired.a.length; k++) {
      // A shared raster corner belongs to both adjacent authored runs. If one
      // of them is explicitly open (armhole, neckline, etc.), the generic
      // front↔back assembler must not reuse that particle for the side seam or
      // it closes the opening transitively. Specialised garment assemblers can
      // still opt into a true three-way junction through pairOutlineRuns.
      if (openA.has(paired.a[k]!) || openB.has(paired.b[k]!)) continue;
      const gi = offA + paired.a[k]!;
      const gj = offB + paired.b[k]!;
      if (gi !== gj) out.push({ i: gi, j: gj });
    }
  }
  return out;
}

/**
 * Resolve the CROSS-MESH assembly seams — those touching a FREE piece (pieceId
 * ≥ 2) — for the piece being combined into the garment (`enteringPid`, the
 * higher-indexed endpoint). Returns {i,j} in the COMBINED-mesh index space:
 * `i` is the endpoint already in the garment, `j` the entering piece (offset by
 * garment.count, as combineClothMeshes requires). `offsets[pid]` is the global
 * base index of piece `pid` (0 and 1 = the base panels at 0 and n²; ≥2 = the
 * garment.count captured just before that piece was combined).
 *
 * Each seam is sewn on BOTH FACES: the drawn pair (front panels) plus its
 * back-panel twin, so a piece hugs the body all around instead of flapping.
 */
export function compileCrossSeams(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): { i: number; j: number }[] {
  const panelSize = n * n;
  const pieces = docPieces(doc);
  const globalOf = (pid: number, local: number): number => (offsets[pid] ?? pid * panelSize) + local;
  // The BACK-FACE twin of a cell: every mesh is a doubled panel (front at
  // +gap/2, back at −gap/2). For the base, the twin lives on the OTHER panel
  // (front 0 ↔ back 1); a free piece's twin is its own panel 1 (same outline
  // on both panels, panelSize cells further).
  const mirrorOf = (pid: number, local: number): number =>
    pid <= 1 ? (offsets[1 - pid] ?? (1 - pid) * panelSize) + local : globalOf(pid, local) + panelSize;
  // Mirror guard (base side): the twin must be a BOUNDARY cell of the OTHER
  // base panel's own mask. With an independent back outline the same (u,v)
  // can be alive but INTERIOR there — a quasi-rigid seam into mid-fabric
  // pinches a permanent tuft instead of joining an edge. Free pieces use one
  // outline for both panels, so their twins are boundary by construction.
  // Lazy: only drafts that reach the emission pay the n² rasterisation.
  const baseBoundary: (Set<number> | null)[] = [null, null];
  const twinOnEdge = (pid: number, local: number): boolean => {
    if (pid > 1) return true;
    const other = 1 - pid;
    baseBoundary[other] ??= (() => {
      const p = pieces[other] && pieces[other]!.outline.length >= 3 ? pieces[other]! : pieces[pid]!;
      return boundaryCellSet(p.outline, p.darts, n);
    })();
    return baseBoundary[other]!.has(local);
  };
  // The twin always stays panel-to-panel (front↔front + back↔back). Sending a
  // piece's back panel to the body's FRONT cell pulls the tube through the body
  // instead of joining corresponding fabric faces.
  const out: { i: number; j: number }[] = [];
  for (const s of doc.seams ?? []) {
    if (!assemblySeamIsClosed(s)) continue;
    const pidA = pieceIdOf(s.a);
    const pidB = pieceIdOf(s.b);
    const hi = Math.max(pidA, pidB);
    if (hi < 2 || hi !== enteringPid) continue; // only cross-mesh seams entering with THIS piece
    // The entering piece endpoint (pid === hi) is the j side (in b's space); the
    // other endpoint is the i side (already in the garment).
    const aEnters = pidA === hi;
    const pidJ = hi;
    const pidI = aEnters ? pidB : pidA;
    const runJ = aEnters ? s.a : s.b;
    const runI = aEnters ? s.b : s.a;
    const pJ = pieces[pidJ];
    const pI = pieces[pidI];
    if (!pJ || !pI || pJ.outline.length < 3 || pI.outline.length < 3) continue;
    const paired = pairRunCells(pI, pJ, { from: runI.from, to: runI.to }, { from: runJ.from, to: runJ.to }, n);
    if (!paired) continue;
    const enteringCells = pJ.placement?.reverseSeam ? [...paired.b].reverse() : paired.b;
    for (let k = 0; k < paired.a.length; k++) {
      const li = paired.a[k]!;
      const lj = enteringCells[k]!;
      const gi = globalOf(pidI, li);
      const gj = globalOf(pidJ, lj);
      if (gi !== gj) out.push({ i: gi, j: gj });
      // Sew BOTH faces: the same seam repeated on the back panels, so the
      // piece HUGS the body instead of flapping (before, only the front rim
      // was sewn — the root cause of « pièces ouvertes »). Guards: the twin
      // must land on a BOUNDARY cell of its own panel's mask (twinOnEdge),
      // and combineClothMeshes drops endpoints that are CUT. The caller also
      // un-stitches the piece's rim along the sewn run (crossSewnOpenCells)
      // so a twin can't weld the body's open edge shut through the body.
      const mi = mirrorOf(pidI, li);
      const mj = mirrorOf(pidJ, lj);
      if (mi !== mj && twinOnEdge(pidI, li) && twinOnEdge(pidJ, lj)) out.push({ i: mi, j: mj });
    }
  }
  return out;
}

/**
 * Compile the independently removable top-stitches of a pocket/appliqué.
 * Unlike an assembly seam, the support endpoint is allowed inside the chosen
 * panel: every boundary cell of the overlay edge is paired with the closest
 * alive support cell under its exact placed position.
 */
interface SurfaceProjection {
  overlay: DraftPiece;
  support: DraftPiece;
  surface: SurfaceAttachment;
  supportOffset: number;
  enteringOffset: number;
  closestSupportCell(target: UV): number | null;
  /**
   * Two support neighbours ordered so their live cross-product points toward
   * the outside of the support panel. The GPU can therefore rebuild a signed
   * contact plane after every deformation instead of assuming world +Z.
   */
  outwardFrame(cell: number): { tangentA: number; tangentB: number } | null;
  /**
   * Exact authored point on one live support triangle. Barycentric weights
   * preserve the placement while the support stretches and bends.
   */
  contactFrame(target: UV): {
    support: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
  } | null;
}

function surfaceProjection(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): SurfaceProjection | null {
  const pieces = docPieces(doc);
  const overlay = pieces[enteringPid];
  const surface = overlay?.placement?.surface;
  if (
    !overlay ||
    overlay.placement?.role !== 'pocket' ||
    !surface ||
    surface.supportPieceId < 0 ||
    surface.supportPieceId >= enteringPid
  ) {
    return null;
  }
  const support = pieces[surface.supportPieceId];
  if (!support || support.outline.length < 3 || overlay.outline.length < 3) return null;

  const panelSize = n * n;
  const supportAlive = new Set<number>();
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const uv: UV = [u / (n - 1), v / (n - 1)];
      let alive = pointInPolygon(uv, support.outline);
      if (alive) {
        for (const dart of support.darts) {
          if (pointInTriangle(uv, dart.apex, dart.legA, dart.legB)) {
            alive = false;
            break;
          }
        }
      }
      if (alive) supportAlive.add(v * n + u);
    }
  }
  if (!supportAlive.size) return null;

  const closestSupportCell = (target: UV): number | null => {
    const cu = Math.round(target[0] * (n - 1));
    const cv = Math.round(target[1] * (n - 1));
    for (let radius = 0; radius < n; radius++) {
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let dv = -radius; dv <= radius; dv++) {
        for (let du = -radius; du <= radius; du++) {
          if (Math.max(Math.abs(du), Math.abs(dv)) !== radius) continue;
          const u = cu + du;
          const v = cv + dv;
          if (u < 0 || u >= n || v < 0 || v >= n) continue;
          const cell = v * n + u;
          if (!supportAlive.has(cell)) continue;
          const dx = (u / (n - 1) - target[0]) * support.width;
          const dy = (v / (n - 1) - target[1]) * support.height;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            best = cell;
            bestDistance = distance;
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  };

  const supportOffset =
    offsets[surface.supportPieceId] ??
    (surface.supportPieceId <= 1 ? surface.supportPieceId * panelSize : 0);
  const enteringOffset = offsets[enteringPid] ?? enteringPid * panelSize;
  const outwardFrame = (cell: number): { tangentA: number; tangentB: number } | null => {
    const u = cell % n;
    const v = Math.floor(cell / n);
    const axisNeighbour = (
      du: number,
      dv: number,
    ): { cell: number; direction: 1 | -1 } | null => {
      for (let radius = 1; radius < n; radius++) {
        const positiveU = u + du * radius;
        const positiveV = v + dv * radius;
        if (
          positiveU >= 0 &&
          positiveU < n &&
          positiveV >= 0 &&
          positiveV < n
        ) {
          const positive = positiveV * n + positiveU;
          if (supportAlive.has(positive)) return { cell: positive, direction: 1 };
        }
        const negativeU = u - du * radius;
        const negativeV = v - dv * radius;
        if (
          negativeU >= 0 &&
          negativeU < n &&
          negativeV >= 0 &&
          negativeV < n
        ) {
          const negative = negativeV * n + negativeU;
          if (supportAlive.has(negative)) return { cell: negative, direction: -1 };
        }
      }
      return null;
    };
    const tangentU = axisNeighbour(1, 0);
    const tangentV = axisNeighbour(0, 1);
    if (!tangentU || !tangentV) return null;

    // In the generated flat frame, cross(+u,+v) points toward −Z. That is the
    // outside of the base back panel, while front/free panels face +Z.
    const desiredFromCanonical = surface.supportPieceId === 1 ? 1 : -1;
    const selectedFromCanonical = tangentU.direction * tangentV.direction;
    const ordered =
      selectedFromCanonical === desiredFromCanonical
        ? [tangentU.cell, tangentV.cell]
        : [tangentV.cell, tangentU.cell];
    return {
      tangentA: supportOffset + ordered[0]!,
      tangentB: supportOffset + ordered[1]!,
    };
  };
  const contactFrame = (
    target: UV,
  ): {
    support: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
  } | null => {
    const gu = Math.min(n - 1 - 1e-7, Math.max(0, target[0] * (n - 1)));
    const gv = Math.min(n - 1 - 1e-7, Math.max(0, target[1] * (n - 1)));
    const u0 = Math.min(n - 2, Math.floor(gu));
    const v0 = Math.min(n - 2, Math.floor(gv));
    const fu = gu - u0;
    const fv = gv - v0;
    const c00 = v0 * n + u0;
    const c10 = c00 + 1;
    const c01 = c00 + n;
    const c11 = c01 + 1;
    let cells: [number, number, number];
    let weights: [number, number, number];
    if (fu + fv <= 1) {
      cells = [c00, c10, c01];
      weights = [1 - fu - fv, fu, fv];
    } else {
      cells = [c11, c01, c10];
      weights = [fu + fv - 1, 1 - fu, 1 - fv];
    }
    if (cells.every((cell) => supportAlive.has(cell))) {
      // Canonical triangle winding cross(+u,+v) faces −Z. Reverse front/free
      // supports so the stored live cross-product always faces outside.
      if (surface.supportPieceId !== 1) {
        [cells[1], cells[2]] = [cells[2], cells[1]];
        [weights[1], weights[2]] = [weights[2], weights[1]];
      }
      return {
        support: supportOffset + cells[0],
        tangentA: supportOffset + cells[1],
        tangentB: supportOffset + cells[2],
        weight0: weights[0],
        weightA: weights[1],
        weightB: weights[2],
      };
    }

    // Boundary fallback: keep the nearest alive point and an outward live
    // frame. Weight 1 on the centre is conservative but still one-sided.
    const nearest = closestSupportCell(target);
    if (nearest === null) return null;
    const frame = outwardFrame(nearest);
    if (!frame) return null;
    return {
      support: supportOffset + nearest,
      tangentA: frame.tangentA,
      tangentB: frame.tangentB,
      weight0: 1,
      weightA: 0,
      weightB: 0,
    };
  };
  return {
    overlay,
    support,
    surface,
    supportOffset,
    enteringOffset,
    closestSupportCell,
    outwardFrame,
    contactFrame,
  };
}

export function compileSurfaceSeams(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): { i: number; j: number }[] {
  const projection = surfaceProjection(doc, n, offsets, enteringPid);
  if (!projection) return [];
  const {
    overlay,
    support,
    surface,
    supportOffset,
    enteringOffset,
    closestSupportCell,
  } = projection;
  const stitched = new Set(
    surface.stitchedEdges
      .filter(Number.isFinite)
      .map((edge) => ((Math.round(edge) % overlay.outline.length) + overlay.outline.length) % overlay.outline.length),
  );
  const emitted = new Set<string>();
  const out: { i: number; j: number }[] = [];
  for (const edge of stitched) {
    const cells = boundaryRunCells(
      overlay,
      { from: edge, to: (edge + 1) % overlay.outline.length },
      n,
    );
    for (const { cell } of cells) {
      const overlayUV: UV = [(cell % n) / (n - 1), Math.floor(cell / n) / (n - 1)];
      const targetUV = surfaceAttachmentUV(overlay, support, surface, overlayUV);
      const supportCell = closestSupportCell(targetUV);
      if (supportCell === null) continue;
      const key = `${supportCell}:${cell}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({ i: supportOffset + supportCell, j: enteringOffset + cell });
    }
  }
  return out;
}

/**
 * Contact map over the WHOLE pocket/appliqué, not only its stitched outline.
 * Every entry builds the thin pocket/support self-collision mask. The
 * unilateral triangle pass always activates one representative per support
 * triangle so a fully stitched appliqué cannot merge with its support; open
 * outline edges add denser anti-tunnelling samples. It never pulls a free edge
 * inward or constrains sliding.
 */
export function compileSurfaceContacts(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): {
  i: number;
  j: number;
  tangentA: number;
  tangentB: number;
  weight0: number;
  weightA: number;
  weightB: number;
  /**
   * True for the sparse physical manifold: one representative per support
   * triangle plus particles on deliberately unstitched boundary edges.
   */
  active: boolean;
}[] {
  const projection = surfaceProjection(doc, n, offsets, enteringPid);
  if (!projection) return [];
  const {
    overlay,
    support,
    surface,
    enteringOffset,
    contactFrame,
  } = projection;
  const emitted = new Set<string>();
  const out: {
    i: number;
    j: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
    active: boolean;
  }[] = [];
  const stitched = new Set(
    surface.stitchedEdges
      .filter(Number.isFinite)
      .map(
        (edge) =>
          ((Math.round(edge) % overlay.outline.length) +
            overlay.outline.length) %
          overlay.outline.length,
      ),
  );
  const openEdgeCells = new Set<number>();
  for (let edge = 0; edge < overlay.outline.length; edge++) {
    if (stitched.has(edge)) continue;
    for (const { cell } of boundaryRunCells(
      overlay,
      { from: edge, to: (edge + 1) % overlay.outline.length },
      n,
    )) {
      openEdgeCells.add(cell);
    }
  }
  const surfaceOpen = stitched.size < overlay.outline.length;
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const overlayUV: UV = [u / (n - 1), v / (n - 1)];
      if (!pointInPolygon(overlayUV, overlay.outline)) continue;
      if (overlay.darts.some((dart) => pointInTriangle(overlayUV, dart.apex, dart.legA, dart.legB))) continue;
      const targetUV = surfaceAttachmentUV(overlay, support, surface, overlayUV);
      const frame = contactFrame(targetUV);
      if (!frame) continue;
      const overlayCell = v * n + u;
      const key = `${frame.support}:${overlayCell}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({
        i: frame.support,
        j: enteringOffset + overlayCell,
        tangentA: frame.tangentA,
        tangentB: frame.tangentB,
        weight0: frame.weight0,
        weightA: frame.weightA,
        weightB: frame.weightB,
        active: false,
      });
    }
  }

  // A pocket grid always uses n×n particles, even when the physical patch is
  // much smaller than its support. Activating every overlay sample can create
  // hundreds of projections against the SAME coarse shirt triangle (961 in
  // the 19×24 cm regression), turning the pocket into a pressure plate that
  // drags the whole garment. Build an area-correct sparse manifold instead:
  // one interior representative nearest each support-triangle centroid for
  // every appliqué, plus every open-boundary sample for anti-tunnelling.
  const representative = new Map<
    string,
    { index: number; score: number }
  >();
  for (let index = 0; index < out.length; index++) {
    const contact = out[index]!;
    const key = `${contact.i}:${contact.tangentA}:${contact.tangentB}`;
    const score =
      (contact.weight0 - 1 / 3) ** 2 +
      (contact.weightA - 1 / 3) ** 2 +
      (contact.weightB - 1 / 3) ** 2;
    const current = representative.get(key);
    if (!current || score < current.score) {
      representative.set(key, { index, score });
    }
    if (
      surfaceOpen &&
      openEdgeCells.has(contact.j - enteringOffset)
    ) {
      contact.active = true;
    }
  }
  for (const { index } of representative.values()) out[index]!.active = true;
  return out;
}

/**
 * Re-index assembly seams after a vertex was inserted at / removed from `at` on
 * ONE face's outline, so each seam keeps pointing at the same physical edge
 * (the outline edge indices shift, exactly like openEdges/hand-seams do).
 */
export function reindexAssemblySeams(
  seams: readonly AssemblySeam[],
  target: 'front' | 'back' | number,
  kind: 'insert' | 'delete',
  at: number,
  nV: number,
): AssemblySeam[] {
  const targetPid = typeof target === 'number' ? target : target === 'back' ? 1 : 0;
  const shift = (r: FaceRun): FaceRun => {
    if (pieceIdOf(r) !== targetPid) return { ...r };
    const s = kind === 'insert' ? shiftRunInsert(r, at) : shiftRunDelete(r, at, nV);
    return { ...r, from: s.from, to: s.to }; // preserve face/pieceId identity
  };
  return seams.map((s) => ({ ...s, a: shift(s.a), b: shift(s.b) }));
}

/**
 * Remove a FREE piece (pieceId ≥ 2) from a draft's `pieces` list and fix up its
 * assembly seams: DROP any seam touching the removed piece, and DECREMENT the
 * pieceId of every run pointing at a piece ABOVE it (the survivors compact down
 * by one, exactly like sanitizeDraft's remap). Base runs (face front/back,
 * pieceId ≤ 1) are untouched. Pure — the caller commits the result and rebuilds.
 */
export function removeFreePiece(
  pieces: readonly DraftPiece[],
  seams: readonly AssemblySeam[],
  pieceId: number,
): { pieces: DraftPiece[]; seams: AssemblySeam[] } {
  const k = pieceId - 2;
  const outPieces = pieces
    .filter((_, i) => i !== k)
    .map((piece) => {
      const surface = piece.placement?.surface;
      if (!surface) return piece;
      if (surface.supportPieceId === pieceId) {
        const { surface: _removed, ...placement } = piece.placement!;
        return { ...piece, placement };
      }
      if (surface.supportPieceId > pieceId) {
        return {
          ...piece,
          placement: {
            ...piece.placement!,
            surface: { ...surface, supportPieceId: surface.supportPieceId - 1 },
          },
        };
      }
      return piece;
    });
  const shift = (r: FaceRun): FaceRun => (pieceIdOf(r) > pieceId ? { ...r, pieceId: pieceIdOf(r) - 1 } : { ...r });
  const outSeams = seams
    .filter((s) => pieceIdOf(s.a) !== pieceId && pieceIdOf(s.b) !== pieceId)
    .map((s) => ({ ...s, a: shift(s.a), b: shift(s.b) }));
  return { pieces: outPieces, seams: outSeams };
}


/** Physical placement of the blank canvas (meters). Single source of truth so
 * defaultDraft and the sanitizeDraft fallbacks can't drift apart. */
const DEFAULT_PIECE_DIMS = { width: 0.95, height: 1.1, topY: 1.6, gap: 1.0 };

/** The atelier's starting pieces: a sleeveless A-line dress FRONT and an
 * identical BACK, laid out côte-à-côte, PRE-SEWN at the shoulders (edges 0→1,
 * 3→4) and sides (4→5, 6→0) — the neckline (1→2→3) and hem (5→6) stay open.
 * Ergonomie (audit v119) : le premier « ▶ Simuler » d'un débutant doit draper
 * un débardeur, pas faire tomber deux panneaux par terre — les coutures se
 * DÉFONT d'un clic pour qui veut apprendre l'assemblage manuel. */
export function defaultDraft(gridN: 32 | 64 | 128 = 64): DraftDoc {
  const face = (): DraftPiece => ({
    outline: [
      [0.24, 0.03], // 0 left shoulder outer
      [0.42, 0.03], // 1 left shoulder inner (neckline start)
      [0.5, 0.12], // 2 neckline bottom
      [0.58, 0.03], // 3 right shoulder inner
      [0.76, 0.03], // 4 right shoulder outer
      [0.9, 0.97], // 5 hem right
      [0.1, 0.97], // 6 hem left
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 3 }, // neckline
      { from: 5, to: 6 }, // hem
    ],
    ...DEFAULT_PIECE_DIMS,
  });
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: face(),
    back: face(),
    manual: true,
    seams: [seam(0, 1), seam(3, 4), seam(4, 5), seam(6, 7)],
  };
}

/**
 * A basic T-SHIRT BODY preset: front + back IDENTICAL torso outlines (shoulders,
 * armholes, a neck scoop, near-straight sides to the hem), with the shoulders
 * and lower sides PRE-SEWN front↔back. Neckline, hem and both armholes stay open.
 * The ARMS go into SEPARATE placed sleeves (the atelier "+ Manches" tubes that
 * straddle each arm) added by the caller, so the arms are truly IN the sleeves —
 * a flat kimono sleeve just hangs. Front=back ⇒ the hand seams pair cell-for-cell
 * like an automatic mirror seam, so it drapes as a clean closed shell but stays
 * editable. Sized to the avatar by the caller (width ≈ 0.7·topScale, height 0.62,
 * gap 0.9, topY 1.52 + dyShoulder). */
export function tshirtDraft(width: number, height: number, gap: number, topY: number, gridN: 32 | 64 | 128 = 64): DraftDoc {
  const body = (): DraftPiece => ({
    outline: [
      [0.42, 0.0], // 0 neck top left
      [0.14, 0.02], // 1 left shoulder outer
      [0.14, 0.28], // 2 left underarm
      [0.16, 0.98], // 3 left hem (a hair of waist taper)
      [0.84, 0.98], // 4 right hem
      [0.86, 0.28], // 5 right underarm
      [0.86, 0.02], // 6 right shoulder outer
      [0.58, 0.0], // 7 neck top right
      [0.5, 0.12], // 8 neck bottom (scoop dip)
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 2 }, // left armhole
      { from: 3, to: 4 }, // hem
      { from: 5, to: 6 }, // right armhole
      { from: 7, to: 0 }, // neckline (edges 7 + 8, the head hole)
    ],
    width,
    height,
    topY,
    gap,
  });
  // Shoulders and sides are distinct: the armhole between them remains a real
  // two-rim opening, ready to receive the sleeve front and back separately.
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: body(),
    back: body(),
    manual: true,
    seams: [seam(0, 1), seam(2, 3), seam(4, 5), seam(6, 7)],
  };
}

/**
 * Validate an untrusted draft (import path): clamp every coord to [0,1], cap
 * element counts, and reject a self-intersecting outline (→ fall back to the
 * default) so a bad file can't produce a degenerate mesh or a GPU blowup.
 */
export function sanitizeDraft(raw: unknown): DraftDoc {
  const fallback = defaultDraft(64);
  if (!raw || typeof raw !== 'object') return fallback;
  const d = raw as Partial<DraftDoc>;
  if (d.format !== 'toile-draft') return fallback;
  const gridN = [32, 64, 128].includes(d.gridN as number) ? (d.gridN as 32 | 64 | 128) : 64;

  const uv = (a: unknown): UV => {
    const t = a as [number, number];
    return [clamp01(Array.isArray(t) ? t[0] : 0.5), clamp01(Array.isArray(t) ? t[1] : 0.5)];
  };
  const num = (v: unknown, min: number, max: number, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
  // Parse one face; null (→ dropped) if its outline is missing/degenerate/self-
  // intersecting, so a bad file can't produce a GPU blowup. `minGap` lets a thin
  // FREE piece (spawned with gap 0.12) survive the round-trip — the base clamp
  // floor (0.3) is tuned for the body and would inflate a small piece's panels.
  const parsePiece = (pp: Partial<DraftPiece> | undefined, minGap = 0.3, minDim = 0.3): DraftPiece | null => {
    if (!pp || !Array.isArray(pp.outline) || pp.outline.length < 3) return null;
    const outline = pp.outline.slice(0, 128).map(uv);
    if (isSelfIntersecting(outline)) return null;
    const nV = outline.length;
    const run = (r: unknown): EdgeRun => {
      const e = r as EdgeRun;
      const idx = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(nV - 1, Math.max(0, Math.round(v))) : 0;
      return { from: idx(e?.from), to: idx(e?.to) };
    };
    return {
      outline,
      darts: (Array.isArray(pp.darts) ? pp.darts : []).slice(0, 16).map((x) => {
        const dd = x as Dart;
        return { apex: uv(dd?.apex), legA: uv(dd?.legA), legB: uv(dd?.legB) };
      }),
      seams: (Array.isArray(pp.seams) ? pp.seams : []).slice(0, 16).map((x) => {
        const hs = x as HandSeam;
        return { a: run(hs?.a), b: run(hs?.b) };
      }),
      openEdges: (Array.isArray(pp.openEdges) ? pp.openEdges : []).slice(0, 16).map(run),
      width: num(pp.width, minDim, 2.0, DEFAULT_PIECE_DIMS.width),
      height: num(pp.height, minDim, 2.0, DEFAULT_PIECE_DIMS.height),
      topY: num(pp.topY, 0.5, 2.2, DEFAULT_PIECE_DIMS.topY),
      gap: num(pp.gap, minGap, 1.6, DEFAULT_PIECE_DIMS.gap),
      ...(typeof pp.name === 'string' && pp.name.trim()
        ? { name: pp.name.trim().slice(0, 64) }
        : {}),
      ...(typeof pp.cut === 'number' && Number.isFinite(pp.cut)
        ? { cut: Math.min(8, Math.max(1, Math.round(pp.cut))) }
        : {}),
      ...(pp.onFold === true ? { onFold: true } : {}),
      ...(pp.patternOnly === true ? { patternOnly: true } : {}),
      ...((): Pick<DraftPiece, 'fabricPreset'> => {
        const allowed = ['Jersey', 'Maille', 'Popeline', 'Denim', 'Lin', 'Laine', 'Soie'] as const;
        return allowed.includes(pp.fabricPreset as (typeof allowed)[number])
          ? { fabricPreset: pp.fabricPreset as (typeof allowed)[number] }
          : {};
      })(),
      ...((): Pick<DraftPiece, 'arealDensityGsm'> => {
        // Same stable apparel range as FabricMaterial. Keep the document in
        // the unit used on textile labels; conversion to kg/m² happens once
        // when the GPU material table is assembled.
        return typeof pp.arealDensityGsm === 'number' && Number.isFinite(pp.arealDensityGsm)
          ? { arealDensityGsm: clampFabricGsm(pp.arealDensityGsm) }
          : {};
      })(),
      // Proven wrap modes survive the round-trip.
      ...(pp.wrap === 'armL' || pp.wrap === 'armR' || pp.wrap === 'neck' ? { wrap: pp.wrap } : {}),
      ...((): { placement?: PiecePlacement } => {
        const raw = pp.placement as Partial<PiecePlacement> | undefined;
        const roles: PiecePlacementRole[] = ['auto', 'front', 'back', 'armL', 'armR', 'neck', 'waist', 'legL', 'legR', 'pocket', 'free'];
        return raw && roles.includes(raw.role as PiecePlacementRole)
          ? {
              placement: {
                role: raw.role as PiecePlacementRole,
                autoAlign: raw.autoAlign !== false,
                ...(raw.reverseSeam === true ? { reverseSeam: true } : {}),
                ...((): { surface?: SurfaceAttachment } => {
                  const surface = raw.surface as Partial<SurfaceAttachment> | undefined;
                  if (
                    raw.role !== 'pocket' ||
                    !surface ||
                    typeof surface.supportPieceId !== 'number' ||
                    !Number.isFinite(surface.supportPieceId)
                  ) {
                    return {};
                  }
                  const stitchedEdges = [
                    ...new Set(
                      (Array.isArray(surface.stitchedEdges) ? surface.stitchedEdges : [])
                        .slice(0, nV)
                        .filter((edge): edge is number => typeof edge === 'number' && Number.isFinite(edge))
                        .map((edge) => Math.min(nV - 1, Math.max(0, Math.round(edge)))),
                    ),
                  ].sort((a, b) => a - b);
                  return {
                    surface: {
                      supportPieceId: Math.min(64, Math.max(0, Math.round(surface.supportPieceId))),
                      anchor: uv(surface.anchor),
                      ...(typeof surface.rotationRad === 'number' && Number.isFinite(surface.rotationRad)
                        ? { rotationRad: Math.min(Math.PI * 2, Math.max(-Math.PI * 2, surface.rotationRad)) }
                        : {}),
                      stitchedEdges,
                    },
                  };
                })(),
              },
            }
          : {};
      })(),
      ...((): { stagingOffset?: [number, number, number] } => {
        const raw = pp.stagingOffset;
        if (
          !Array.isArray(raw) ||
          raw.length !== 3 ||
          !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
        ) {
          return {};
        }
        const offset: [number, number, number] = [raw[0] as number, raw[1] as number, raw[2] as number];
        return Math.hypot(...offset) > 1e-8 ? { stagingOffset: offset } : {};
      })(),
      ...((): { stagingOffsets?: Array<[number, number, number] | null> } => {
        if (!Array.isArray(pp.stagingOffsets)) return {};
        const offsets = pp.stagingOffsets.slice(0, 8).map((raw) => {
          if (
            !Array.isArray(raw) ||
            raw.length !== 3 ||
            !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
          ) {
            return null;
          }
          return [raw[0], raw[1], raw[2]] as [number, number, number];
        });
        return offsets.some((offset) => offset && Math.hypot(...offset) > 1e-8)
          ? { stagingOffsets: offsets }
          : {};
      })(),
    };
  };
  const front = parsePiece(d.piece);
  if (!front) return fallback;
  const back = parsePiece(d.back);
  // FREE pieces (pieceId ≥ 2, multi-piece editor): parse each slot; drop any that
  // is degenerate/self-intersecting (parsePiece → null). Dropping a middle piece
  // COMPACTS the survivors, shifting their pieceIds, so build an old→new remap
  // and re-point (or drop) each seam through it — otherwise a hand-edited/corrupt
  // file could bind a seam to the WRONG surviving piece. Capped so a bad file
  // can't spawn an unbounded number of meshes. Thin free pieces keep a lower gap
  // floor (0.1) so they round-trip byte-identically.
  const freePieces: DraftPiece[] = [];
  const remap = new Map<number, number>(); // old pieceId (2+k) → new pieceId
  (Array.isArray(d.pieces) ? d.pieces : []).slice(0, 6).forEach((x, k) => {
    const p = parsePiece(x as Partial<DraftPiece>, 0.1, 0.1); // thin/narrow free pieces (sleeves) keep their true size
    if (p) {
      remap.set(2 + k, 2 + freePieces.length);
      freePieces.push(p);
    }
  });
  const hasBack = !!back;
  freePieces.forEach((piece, k) => {
    const surface = piece.placement?.surface;
    if (!surface) return;
    const supportPieceId =
      surface.supportPieceId < 2
        ? surface.supportPieceId
        : remap.get(surface.supportPieceId);
    const ownPieceId = 2 + k;
    const supportExists =
      supportPieceId === 0 ||
      (supportPieceId === 1 ? hasBack : supportPieceId !== undefined && supportPieceId < ownPieceId);
    if (!supportExists || supportPieceId === ownPieceId) {
      const { surface: _discarded, ...placement } = piece.placement!;
      piece.placement = placement;
      return;
    }
    piece.placement = {
      ...piece.placement!,
      surface: { ...surface, supportPieceId: supportPieceId! },
    };
  });
  // Assembly seams (manual mode): validate face/pieceId + edge indices. Runs are
  // taken modulo the outline length at compile time, so a loose cap is enough.
  const faceRun = (r: unknown): FaceRun => {
    const e = r as FaceRun;
    const idx = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(256, Math.max(0, Math.round(v))) : 0);
    const run: FaceRun = { from: idx(e?.from), to: idx(e?.to) };
    if (typeof e?.pieceId === 'number' && Number.isFinite(e.pieceId)) {
      const old = Math.max(0, Math.round(e.pieceId));
      // Re-point free-piece references through the compaction remap; an unmapped
      // one (its piece was dropped) becomes -1 → filtered out by pieceExists.
      run.pieceId = old < 2 ? old : remap.get(old) ?? -1;
    } else run.face = e?.face === 'back' ? 'back' : 'front';
    return run;
  };
  // Drop "ghost" seams whose endpoint references a piece that doesn't exist: the
  // back when no back was drawn, or a free piece that was dropped/out of range.
  const pieceExists = (r: FaceRun): boolean => {
    const pid = pieceIdOf(r);
    if (pid < 0) return false; // a dropped free piece (remap miss)
    return pid === 0 || (pid === 1 ? hasBack : pid < 2 + freePieces.length);
  };
  const parseEdgePairs = (value: unknown): AssemblySeam[] =>
    (Array.isArray(value) ? value : [])
      .slice(0, 128)
      .map((x) => {
        const s = x as AssemblySeam;
        return {
          a: faceRun(s?.a),
          b: faceRun(s?.b),
          ...(s?.kind === 'seam' || s?.kind === 'zipper' ? { kind: s.kind } : {}),
          ...(typeof s?.closed === 'boolean' ? { closed: s.closed } : {}),
        };
      })
      .filter((s) => pieceExists(s.a) && pieceExists(s.b));
  const seams = parseEdgePairs(d.seams);
  const segmentLinks = parseEdgePairs(d.segmentLinks);
  const preset =
    d.preset === 'boxy-tee' ||
    d.preset === 'loose-pants' ||
    d.preset === 'lucas-hoodie'
      ? d.preset
      : undefined;
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: front,
    ...(back ? { back } : {}),
    ...(freePieces.length ? { pieces: freePieces } : {}),
    manual: d.manual === true,
    seams,
    ...(segmentLinks.length ? { segmentLinks } : {}),
    ...(preset ? { preset } : {}),
    ...(preset && typeof d.presetSize === 'string'
      ? { presetSize: d.presetSize.slice(0, 8) }
      : {}),
  };
}
