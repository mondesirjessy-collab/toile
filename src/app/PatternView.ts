/**
 * PatternView — the 2D cutting-layout inset (CLO-style dual view).
 * Draws the garment's FRONT pattern pieces flat, from their rest positions:
 * fabric fill, cut outline, stitch marks along mirror seams, and orange links
 * for island-to-island seams (armholes) — i.e. exactly what gets sewn to what.
 *
 * v32: the layout is editable. Each parametric measurement exposes a round
 * handle pinned to its cut edge (hem corner, hem bottom, neckline, sleeve
 * cuff). Dragging a handle previews the new measurement live and, on release,
 * re-cuts and re-sews the garment — the pattern-editor loop.
 *
 * Input model: the canvas keeps pointer-events:none so the inset stays
 * transparent to 3D navigation (orbit/pan work "through" it). Instead we
 * listen on window in the CAPTURE phase and claim a gesture only when it
 * actually lands on a handle; everything else falls through untouched.
 */
import type { ClothMeshData } from '../engine/cloth/ClothMesh';
import { PAL, SEAM_COLORS } from './patternPalette';
import {
  insertOutlineVertex,
  deleteOutlineVertex,
  mirrorClosedOutline,
  reindexAssemblySeams,
  pieceIdOf,
  assemblySeamIsClosed,
  runCoversEdge,
  defaultSurfaceStitches,
  draftPieceLabel,
  surfaceAttachmentUV,
  pointInPolygon,
  type UV,
  type DraftPiece,
  type AssemblySeam,
  type FaceRun,
  type PieceGraphic,
  type InternalLine,
  catmullRomSubdivide,
} from '../engine/pattern/Draft';

/** Build the persisted assembly record emitted by the two-click ZIP tool. */
export function makeZipperSeam(a: FaceRun, b: FaceRun): AssemblySeam {
  return {
    a: { ...a },
    b: { ...b },
    kind: 'zipper',
    closed: true,
  };
}

/** One draggable measurement, defined against its garment's cutting grid. */
export interface PatternHandleSpec {
  id: string; // matches the ControlPanel setting key
  label: string;
  /** Rest-layout geometry of the garment this handle belongs to. */
  grid: { width: number; topY: number; height: number };
  /** Anchor in grid UV. For 'u' handles, anchor[0] tracks the value. */
  anchor: [number, number];
  /** 'u': horizontal, value = u − 0.5 (half-width). 'y': vertical, in meters from topY. */
  axis: 'u' | 'y';
  value: number;
  min: number;
  max: number;
  unit?: string;
}

/** Where a handle sits in rest-layout coordinates (meters), given a value. */
export function handleLayoutPos(h: PatternHandleSpec, value: number): [number, number] {
  const x = h.axis === 'u' ? value * h.grid.width : (h.anchor[0] - 0.5) * h.grid.width;
  const y = h.axis === 'u' ? h.grid.topY - h.anchor[1] * h.grid.height : h.grid.topY - value;
  return [x, y];
}

/** Inverse: a drag position in rest-layout coordinates → clamped value. */
export function handleValueFromLayout(h: PatternHandleSpec, x: number, y: number): number {
  const raw = h.axis === 'u' ? x / h.grid.width : h.grid.topY - y;
  return Math.min(h.max, Math.max(h.min, raw));
}

export interface PatternLayoutTransform {
  minA: number;
  minB: number;
  scale: number;
  ox: number;
  oy: number;
  H: number;
}

/** Build a layout→screen transform around an explicit layout-space centre. */
export function patternViewportTransform(
  minA: number,
  minB: number,
  fitScale: number,
  zoom: number,
  center: readonly [number, number],
  widthPx: number,
  heightPx: number,
): PatternLayoutTransform {
  const scale = fitScale * zoom;
  return {
    minA,
    minB,
    scale,
    ox: widthPx / 2 - (center[0] - minA) * scale,
    oy: heightPx / 2 - (center[1] - minB) * scale,
    H: heightPx,
  };
}

/** Layout point below a canvas pixel, used to keep wheel zoom cursor-centred. */
export function patternScreenToLayout(
  transform: PatternLayoutTransform,
  px: number,
  py: number,
): [number, number] {
  return [
    transform.minA + (px - transform.ox) / transform.scale,
    transform.minB + (transform.H - py - transform.oy) / transform.scale,
  ];
}

/** New layout-space centre after dragging the cutting table in screen pixels. */
export function patternPanCenter(
  center: readonly [number, number],
  dxPx: number,
  dyPx: number,
  scale: number,
): [number, number] {
  const safeScale = Math.max(1e-8, scale);
  return [
    center[0] - dxPx / safeScale,
    center[1] + dyPx / safeScale,
  ];
}

/** New layout-space view centre that leaves `layoutPoint` under `screenPoint`. */
export function patternZoomCenterAt(
  layoutPoint: readonly [number, number],
  screenPoint: readonly [number, number],
  newScale: number,
  widthPx: number,
  heightPx: number,
): [number, number] {
  return [
    layoutPoint[0] - (screenPoint[0] - widthPx / 2) / newScale,
    layoutPoint[1] + (screenPoint[1] - heightPx / 2) / newScale,
  ];
}

/** Pure visual translation for the cutting table; it never touches DraftPiece geometry. */
export function nextPatternLayoutShift(
  startShift: readonly [number, number],
  startPointer: readonly [number, number],
  currentPointer: readonly [number, number],
): [number, number] {
  return [
    startShift[0] + currentPointer[0] - startPointer[0],
    startShift[1] + currentPointer[1] - startPointer[1],
  ];
}

/**
 * Glisser-COURBE : les voisins d'arc du sommet saisi. On suit la chaîne des
 * ±2 voisins de v tant que CHAQUE pas est court (≤ step en UV) — vrai le long
 * d'un arc échantillonné (encolure, tête de manche), faux entre deux coins
 * éloignés (épaule↔col, coins d'ourlet). Chaque voisin reçoit un poids
 * d'amorti : tirer un point d'une courbe la déforme en douceur, un coin isolé
 * bouge seul. Pure — testable sans DOM.
 */
export function curveNeighbors(
  outline: readonly UV[],
  v: number,
  step = 0.2,
  weights: readonly number[] = [0.55, 0.22],
): { idx: number; w: number }[] {
  const N = outline.length;
  const out: { idx: number; w: number }[] = [];
  for (const dir of [-1, 1]) {
    let prev = v;
    for (let k = 0; k < weights.length; k++) {
      const idx = (v + dir * (k + 1) + N * 4) % N;
      if (idx === v || out.some((c) => c.idx === idx)) break; // petit polygone : ne pas repasser
      const a = outline[prev]!;
      const b = outline[idx]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > step) break; // un coin : la chaîne s'arrête
      out.push({ idx, w: weights[k]! });
      prev = idx;
    }
  }
  return out;
}

export interface LogicalCurveRun {
  /** First and last visible endpoints, in outline order. */
  from: number;
  to: number;
  /** Endpoint + hidden samples + endpoint, including cyclic runs. */
  indices: number[];
  /** Accumulated physical direction change, useful for diagnostics/tests. */
  turnDeg: number;
}

/**
 * Recover smooth sampled arcs as single editor segments. The source patterns
 * deliberately keep their dense points for rasterisation and sewing accuracy;
 * this view groups consecutive small physical turns, stopping at construction
 * corners and long straight stations.
 */
export function logicalCurveRuns(
  piece: DraftPiece,
  outline: readonly UV[] = piece.outline,
  minTurnDeg = 0.6,
  maxCornerDeg = 75,
  maxStepM = 0.3,
): LogicalCurveRun[] {
  const n = outline.length;
  if (n < 3) return [];
  const turn = new Array<number>(n).fill(0);
  const curved = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const a = metricUV(piece, outline[(i + n - 1) % n]!);
    const b = metricUV(piece, outline[i]!);
    const c = metricUV(piece, outline[(i + 1) % n]!);
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const bcx = c[0] - b[0];
    const bcy = c[1] - b[1];
    const l0 = Math.hypot(abx, aby);
    const l1 = Math.hypot(bcx, bcy);
    if (l0 < 1e-8 || l1 < 1e-8) continue;
    const dot = Math.min(1, Math.max(-1, (abx * bcx + aby * bcy) / (l0 * l1)));
    const deg = (Math.acos(dot) * 180) / Math.PI;
    turn[i] = deg;
    curved[i] = deg >= minTurnDeg && deg <= maxCornerDeg && Math.max(l0, l1) <= maxStepM;
  }
  // Construction metadata already describes some multi-edge cut lines
  // (necklines, armholes, trouser rise). When that run actually bends, it is
  // the most reliable definition of one logical curve.
  const explicit: LogicalCurveRun[] = [];
  const occupied = new Set<number>();
  for (const run of piece.openEdges) {
    const from = ((run.from % n) + n) % n;
    const steps = ((run.to - run.from) % n + n) % n;
    if (steps < 2) continue;
    const indices = Array.from({ length: steps + 1 }, (_v, k) => (from + k) % n);
    const totalTurn = indices.slice(1, -1).reduce((sum, idx) => sum + turn[idx]!, 0);
    if (totalTurn < 2) continue;
    explicit.push({ from, to: indices[indices.length - 1]!, indices, turnDeg: totalTurn });
    for (const idx of indices.slice(1, -1)) occupied.add(idx);
  }
  if (!curved.some(Boolean) || curved.every(Boolean)) return explicit;

  // Start after a known break so cyclic curves are emitted once.
  const breakAt = curved.findIndex((v) => !v);
  const runs: LogicalCurveRun[] = [];
  let step = 1;
  while (step <= n) {
    const i = (breakAt + step) % n;
    if (!curved[i]) {
      step++;
      continue;
    }
    const interior: number[] = [];
    while (step <= n && curved[(breakAt + step) % n]) {
      interior.push((breakAt + step) % n);
      step++;
    }
    const from = (interior[0]! + n - 1) % n;
    const to = (interior[interior.length - 1]! + 1) % n;
    const indices = [from, ...interior, to];
    const totalTurn = interior.reduce((sum, idx) => sum + turn[idx]!, 0);
    // Reject barely-wavy numerical noise while retaining one-point armholes.
    if (
      indices.length >= 3 &&
      totalTurn >= 2 &&
      !indices.slice(1, -1).some((idx) => occupied.has(idx))
    ) {
      runs.push({ from, to, indices, turnDeg: totalTurn });
    }
  }
  return [...explicit, ...runs];
}

export function logicalCurveHandle(run: LogicalCurveRun): { index: number; t: number } {
  const position = Math.max(1, Math.min(run.indices.length - 2, Math.floor((run.indices.length - 1) / 2)));
  return {
    index: run.indices[position]!,
    t: position / (run.indices.length - 1),
  };
}

/** Hidden sample indices; only the two endpoints and one curve handle are shown. */
export function logicalCurveInteriorIndices(runs: readonly LogicalCurveRun[]): Set<number> {
  const hidden = new Set<number>();
  for (const run of runs) for (const idx of run.indices.slice(1, -1)) hidden.add(idx);
  return hidden;
}

/**
 * Rebuild one logical curve as a physical quadratic passing through the dragged
 * handle. The number/order of hidden samples never changes, so every sewing
 * run and segment index remains valid.
 */
export function reshapeLogicalCurve(
  piece: DraftPiece,
  outline: readonly UV[],
  run: LogicalCurveRun,
  target: UV,
): UV[] {
  const out = outline.map((p) => [p[0], p[1]] as UV);
  if (run.indices.length < 3) return out;
  const handle = logicalCurveHandle(run);
  const t0 = handle.t;
  const w = 2 * t0 * (1 - t0);
  if (w < 1e-8) return out;
  const a = metricUV(piece, outline[run.from]!);
  const b = metricUV(piece, outline[run.to]!);
  const m = metricUV(piece, target);
  const cx = (m[0] - (1 - t0) ** 2 * a[0] - t0 ** 2 * b[0]) / w;
  const cy = (m[1] - (1 - t0) ** 2 * a[1] - t0 ** 2 * b[1]) / w;
  const edges = run.indices.length - 1;
  for (let position = 1; position < edges; position++) {
    const t = position / edges;
    const q0 = (1 - t) ** 2;
    const q1 = 2 * t * (1 - t);
    const q2 = t ** 2;
    out[run.indices[position]!] = [
      (q0 * a[0] + q1 * cx + q2 * b[0]) / piece.width,
      (q0 * a[1] + q1 * cy + q2 * b[1]) / piece.height,
    ];
  }
  return out;
}

export interface LogicalCurveLengthEdit {
  run: LogicalCurveRun;
  moving: number;
  fixed: number;
  unit: [number, number];
  /** Exact point grabbed on the curve, used only to explain off-axis drags. */
  grab: UV;
  grabAlong: number;
  startChordM: number;
  startLengthM: number;
  minLengthM: number;
}

/** Physical arc length of the complete logical curve. */
export function logicalCurveLengthM(
  piece: DraftPiece,
  outline: readonly UV[],
  run: LogicalCurveRun,
): number {
  let length = 0;
  for (let i = 0; i < run.indices.length - 1; i++) {
    const a = metricUV(piece, outline[run.indices[i]!]!);
    const b = metricUV(piece, outline[run.indices[i + 1]!]!);
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return length;
}

/**
 * Start a whole-curve length edit. The endpoint nearest the grabbed point
 * moves; the other endpoint anchors the curve.
 */
export function beginLogicalCurveLengthEdit(
  piece: DraftPiece,
  outline: readonly UV[],
  run: LogicalCurveRun,
  grab: UV,
  minLengthM = 0.005,
): LogicalCurveLengthEdit | null {
  if (run.indices.length < 3) return null;
  const from = metricUV(piece, outline[run.from]!);
  const to = metricUV(piece, outline[run.to]!);
  const g = metricUV(piece, grab);
  const moving = Math.hypot(g[0] - from[0], g[1] - from[1]) <= Math.hypot(g[0] - to[0], g[1] - to[1])
    ? run.from
    : run.to;
  const fixed = moving === run.from ? run.to : run.from;
  const m = metricUV(piece, outline[moving]!);
  const f = metricUV(piece, outline[fixed]!);
  const startChordM = Math.hypot(m[0] - f[0], m[1] - f[1]);
  if (startChordM < 1e-8) return null;
  const unit: [number, number] = [(m[0] - f[0]) / startChordM, (m[1] - f[1]) / startChordM];
  return {
    run,
    moving,
    fixed,
    unit,
    grab: [grab[0], grab[1]],
    grabAlong: (m[0] - g[0]) * unit[0] + (m[1] - g[1]) * unit[1],
    startChordM,
    startLengthM: logicalCurveLengthM(piece, outline, run),
    minLengthM,
  };
}

/**
 * Resize the full arc from one endpoint. Uniform physical scaling preserves
 * the curve's proportions and changes its arc length by the same ratio.
 */
export function resizeLogicalCurveLengthFromPointer(
  piece: DraftPiece,
  outline: readonly UV[],
  edit: LogicalCurveLengthEdit,
  pointer: UV,
): UV[] {
  const out = outline.map((p) => [p[0], p[1]] as UV);
  const f = metricUV(piece, outline[edit.fixed]!);
  const p = metricUV(piece, pointer);
  const projected = (p[0] - f[0]) * edit.unit[0] + (p[1] - f[1]) * edit.unit[1] + edit.grabAlong;
  const minChord = edit.startChordM * (edit.minLengthM / Math.max(edit.startLengthM, edit.minLengthM));
  const chord = Math.max(minChord, projected);
  const scale = chord / edit.startChordM;
  for (const idx of edit.run.indices) {
    if (idx === edit.fixed) continue;
    const q = metricUV(piece, outline[idx]!);
    out[idx] = [
      (f[0] + (q[0] - f[0]) * scale) / piece.width,
      (f[1] + (q[1] - f[1]) * scale) / piece.height,
    ];
  }
  return out;
}

/**
 * Glisser-BOMBER : l'arc qu'un segment devient quand on le tire par un point.
 * Bézier quadratique de a à b dont le contrôle est résolu pour que la courbe
 * PASSE par la souris `m` au paramètre du point saisi (`grab`, projeté sur ab
 * et borné loin des bouts pour rester stable). Renvoie les points INTÉRIEURS
 * de l'arc (sans a ni b), prêts à insérer dans le contour — ou [] si la souris
 * reste trop près de la ligne (l'arc serait plat : rien à courber).
 * Pure — testable sans DOM.
 */
export function bendSamples(a: UV, b: UV, grab: UV, m: UV, minDepth = 0.006): UV[] {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return [];
  const len = Math.sqrt(len2);
  const depth = Math.abs((m[0] - a[0]) * (-aby / len) + (m[1] - a[1]) * (abx / len));
  if (depth < minDepth) return [];
  const t0 = Math.min(0.85, Math.max(0.15, ((grab[0] - a[0]) * abx + (grab[1] - a[1]) * aby) / len2));
  const w = 2 * t0 * (1 - t0);
  const cx = (m[0] - (1 - t0) * (1 - t0) * a[0] - t0 * t0 * b[0]) / w;
  const cy = (m[1] - (1 - t0) * (1 - t0) * a[1] - t0 * t0 * b[1]) / w;
  // Assez de points pour un arc lisse, proportionné à la longueur du segment
  // (les arcs du patron sont déjà échantillonnés à cette densité-là).
  const k = Math.max(3, Math.min(9, Math.round(len * 24)));
  const pts: UV[] = [];
  for (let j = 1; j <= k; j++) {
    const t = j / (k + 1);
    const q0 = (1 - t) * (1 - t);
    const q1 = 2 * t * (1 - t);
    const q2 = t * t;
    pts.push([q0 * a[0] + q1 * cx + q2 * b[0], q0 * a[1] + q1 * cy + q2 * b[1]]);
  }
  return pts;
}

/** State fixed at pointer-down for an axis-constrained segment length edit. */
export interface SegmentLengthEdit {
  edge: number;
  moving: number;
  fixed: number;
  unit: [number, number]; // fixed → moving, in physical pattern metres
  /** Exact point grabbed on the edge, used only to explain off-axis drags. */
  grab: UV;
  grabAlong: number; // moving endpoint → grabbed point offset, along the axis
  minLength: number;
  startLength: number;
}

export interface DraftPieceUpdate {
  pieceId: number;
  piece: DraftPiece;
}

export interface PatternCancelResult {
  cancelledTool: boolean;
  cancelledGesture: boolean;
}

const metricUV = (
  piece: Pick<DraftPiece, 'width' | 'height'>,
  p: UV,
): [number, number] => [p[0] * piece.width, p[1] * piece.height];
const worldUV = (piece: DraftPiece, p: UV): [number, number] => [
  (p[0] - 0.5) * piece.width,
  piece.topY - p[1] * piece.height,
];

/** Read-only interpretation of a pointer drag against one effective length axis. */
export interface AxisDragIntent {
  /** Signed useful travel along the constrained axis, in physical metres. */
  alongM: number;
  /** Signed travel ignored by the length edit, perpendicular to the axis. */
  acrossM: number;
  /** True once a deliberate drag is dominated by the ignored direction. */
  mostlyPerpendicular: boolean;
}

/**
 * Explain an axis-constrained drag without changing its geometry.
 *
 * The production resize functions below remain the sole source of truth. This
 * helper only preserves the user's raw intent so the canvas can show a ghost
 * and point toward the direction that actually changes the length.
 */
export function axisDragIntent(
  piece: Pick<DraftPiece, 'width' | 'height'>,
  grab: UV,
  pointer: UV,
  unit: readonly [number, number],
  thresholdM = 0.005,
): AxisDragIntent {
  const g = metricUV(piece, grab);
  const p = metricUV(piece, pointer);
  const dx = p[0] - g[0];
  const dy = p[1] - g[1];
  const norm = Math.hypot(unit[0], unit[1]) || 1;
  const ux = unit[0] / norm;
  const uy = unit[1] / norm;
  const alongM = dx * ux + dy * uy;
  const acrossM = dx * -uy + dy * ux;
  const deliberate = Math.hypot(dx, dy) >= Math.max(0, thresholdM);
  return {
    alongM,
    acrossM,
    mostlyPerpendicular:
      deliberate && Math.abs(acrossM) > Math.abs(alongM),
  };
}

/** True physical length of one outline segment, in centimetres. */
export function outlineEdgeLengthCm(piece: DraftPiece, outline: readonly UV[], edge: number): number {
  if (outline.length < 2) return 0;
  const e = ((edge % outline.length) + outline.length) % outline.length;
  const a = metricUV(piece, outline[e]!);
  const b = metricUV(piece, outline[(e + 1) % outline.length]!);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) * 100;
}

/** Physical direction/length of one cut edge, independent of UV box aspect. */
export interface OutlineEdgeGeometry {
  vector: [number, number];
  lengthM: number;
  /** Unoriented angle against the horizontal grain line: [0°, 180°). */
  angleDeg: number;
}

export function outlineEdgeGeometry(piece: DraftPiece, outline: readonly UV[], edge: number): OutlineEdgeGeometry | null {
  if (outline.length < 2) return null;
  const e = ((edge % outline.length) + outline.length) % outline.length;
  const a = worldUV(piece, outline[e]!);
  const b = worldUV(piece, outline[(e + 1) % outline.length]!);
  const vector: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const lengthM = Math.hypot(vector[0], vector[1]);
  if (lengthM < 1e-9) return null;
  let angleDeg = (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;
  angleDeg = ((angleDeg % 180) + 180) % 180;
  return { vector, lengthM, angleDeg };
}

/** CAD-style relation between two physical cut edges. */
export interface SegmentRelation {
  /** Smallest line-to-line angle, from 0° (parallel) to 90° (perpendicular). */
  angleDeltaDeg: number;
  parallel: boolean;
  perpendicular: boolean;
  equalLength: boolean;
}

export function segmentRelation(
  a: OutlineEdgeGeometry,
  b: OutlineEdgeGeometry,
  angleToleranceDeg = 0.5,
  lengthToleranceM = 0.001,
): SegmentRelation {
  let angleDeltaDeg = Math.abs(a.angleDeg - b.angleDeg) % 180;
  if (angleDeltaDeg > 90) angleDeltaDeg = 180 - angleDeltaDeg;
  return {
    angleDeltaDeg,
    parallel: angleDeltaDeg <= angleToleranceDeg,
    perpendicular: Math.abs(90 - angleDeltaDeg) <= angleToleranceDeg,
    equalLength: Math.abs(a.lengthM - b.lengthM) <= lengthToleranceM,
  };
}

/** Public-friendly snap range: close enough to be intentional, never a large correction. */
export const SEGMENT_SNAP_ANGLE_DEG = 3;

/** Length snap range: 2% of the reference, bounded between 5 and 15 mm. */
export function segmentSnapLengthToleranceM(referenceLengthM: number): number {
  return Math.min(0.015, Math.max(0.005, referenceLengthM * 0.02));
}

export interface SegmentSnapSuggestion {
  angle?: {
    kind: 'parallel' | 'perpendicular';
    pieceId: number;
    edge: number;
    /** Exact unoriented line angle to apply, in physical pattern space. */
    angleDeg: number;
    /** Correction that will be made, in degrees. */
    deltaDeg: number;
  };
  length?: {
    kind: 'sewn' | 'parallel';
    pieceId: number;
    edge: number;
    /** Exact physical target length for the edited segment. */
    lengthM: number;
    /** Signed correction that will be made. */
    deltaM: number;
  };
}

const runLengthM = (piece: DraftPiece, outline: readonly UV[], run: Pick<FaceRun, 'from' | 'to'>): number => {
  let lengthM = 0;
  for (let edge = 0; edge < outline.length; edge++) {
    if (runCoversEdge(run, edge, outline.length)) {
      lengthM += outlineEdgeGeometry(piece, outline, edge)?.lengthM ?? 0;
    }
  }
  return lengthM;
};

/**
 * Find the safest useful CAD correction for one segment.
 *
 * Priority for length:
 * 1. the run sewn to this edge (assembly must meet);
 * 2. a nearly parallel edge on the same piece (width/height true-up).
 *
 * Angle is independent, so a sewn length may also become exactly parallel or
 * perpendicular in the same gesture. Adjacent edges are considered only for a
 * right angle; parallel candidates must be non-adjacent to avoid curve samples.
 */
export function findSegmentSnapSuggestion(
  pieces: readonly (DraftPiece | null)[],
  assembly: readonly AssemblySeam[],
  targetPieceId: number,
  targetEdge: number,
  activeOutline?: readonly UV[],
  moving?: number,
  angleToleranceDeg = SEGMENT_SNAP_ANGLE_DEG,
): SegmentSnapSuggestion | null {
  const piece = pieces[targetPieceId];
  if (!piece) return null;
  const outline = activeOutline ?? piece.outline;
  const n = outline.length;
  if (n < 3) return null;
  const edge = ((targetEdge % n) + n) % n;
  const target = outlineEdgeGeometry(piece, outline, edge);
  if (!target || target.lengthM < 0.005) return null;
  const EPS_ANGLE = 1e-6;
  const EPS_LENGTH = 1e-7;

  type AngleCandidate = NonNullable<SegmentSnapSuggestion['angle']> & { score: number };
  type LengthCandidate = NonNullable<SegmentSnapSuggestion['length']> & { score: number };
  const angleCandidates: AngleCandidate[] = [];
  const parallelLengths: LengthCandidate[] = [];
  const prev = (edge + n - 1) % n;
  const next = (edge + 1) % n;
  // A perpendicular reference must stay still while the grabbed endpoint
  // moves. If the end moves, the previous edge (at the fixed start) is safe;
  // if the start moves, the next edge (at the fixed end) is safe.
  const fixedAdjacent = moving === undefined ? null : moving === edge ? next : moving === next ? prev : null;

  for (let candidateEdge = 0; candidateEdge < n; candidateEdge++) {
    if (candidateEdge === edge) continue;
    const candidate = outlineEdgeGeometry(piece, outline, candidateEdge);
    if (!candidate || candidate.lengthM < 0.03) continue;
    const relation = segmentRelation(target, candidate, angleToleranceDeg, Number.POSITIVE_INFINITY);

    if (candidateEdge !== prev && candidateEdge !== next && relation.angleDeltaDeg <= angleToleranceDeg) {
      if (relation.angleDeltaDeg > EPS_ANGLE) {
        angleCandidates.push({
          kind: 'parallel',
          pieceId: targetPieceId,
          edge: candidateEdge,
          angleDeg: candidate.angleDeg,
          deltaDeg: relation.angleDeltaDeg,
          score: relation.angleDeltaDeg / angleToleranceDeg,
        });
      }
      const deltaM = candidate.lengthM - target.lengthM;
      const toleranceM = segmentSnapLengthToleranceM(candidate.lengthM);
      if (Math.abs(deltaM) > EPS_LENGTH && Math.abs(deltaM) <= toleranceM) {
        parallelLengths.push({
          kind: 'parallel',
          pieceId: targetPieceId,
          edge: candidateEdge,
          lengthM: candidate.lengthM,
          deltaM,
          score: Math.abs(deltaM) / toleranceM + relation.angleDeltaDeg / angleToleranceDeg,
        });
      }
    }

    if ((candidateEdge === prev || candidateEdge === next) && (fixedAdjacent === null || candidateEdge === fixedAdjacent)) {
      const correction = Math.abs(90 - relation.angleDeltaDeg);
      if (correction > EPS_ANGLE && correction <= angleToleranceDeg) {
        angleCandidates.push({
          kind: 'perpendicular',
          pieceId: targetPieceId,
          edge: candidateEdge,
          angleDeg: (candidate.angleDeg + 90) % 180,
          deltaDeg: correction,
          score: correction / angleToleranceDeg,
        });
      }
    }
  }

  // A sewn run can span several outline edges. Correct only the edited edge by
  // the run-length difference, so the WHOLE pair becomes 1:1 without moving
  // the other vertices of that run.
  const sewnLengths: LengthCandidate[] = [];
  for (const seam of assembly) {
    const endpoints: Array<[FaceRun, FaceRun]> = [
      [seam.a, seam.b],
      [seam.b, seam.a],
    ];
    for (const [ownRun, otherRun] of endpoints) {
      if (pieceIdOf(ownRun) !== targetPieceId || !runCoversEdge(ownRun, edge, n)) continue;
      const otherPieceId = pieceIdOf(otherRun);
      const otherPiece = pieces[otherPieceId];
      if (!otherPiece) continue;
      const otherOutline = otherPieceId === targetPieceId ? outline : otherPiece.outline;
      const ownRunLengthM = runLengthM(piece, outline, ownRun);
      const otherRunLengthM = runLengthM(otherPiece, otherOutline, otherRun);
      if (ownRunLengthM <= 0 || otherRunLengthM <= 0) continue;
      const deltaM = otherRunLengthM - ownRunLengthM;
      const desiredLengthM = target.lengthM + deltaM;
      const toleranceM = segmentSnapLengthToleranceM(otherRunLengthM);
      if (desiredLengthM >= 0.005 && Math.abs(deltaM) > EPS_LENGTH && Math.abs(deltaM) <= toleranceM) {
        sewnLengths.push({
          kind: 'sewn',
          pieceId: otherPieceId,
          edge: otherRun.from,
          lengthM: desiredLengthM,
          deltaM,
          score: Math.abs(deltaM) / toleranceM,
        });
      }
    }
  }

  angleCandidates.sort((a, b) => a.score - b.score);
  parallelLengths.sort((a, b) => a.score - b.score);
  sewnLengths.sort((a, b) => a.score - b.score);
  const angle = angleCandidates[0];
  const length = sewnLengths[0] ?? parallelLengths[0];
  if (!angle && !length) return null;
  return {
    angle: angle
      ? {
          kind: angle.kind,
          pieceId: angle.pieceId,
          edge: angle.edge,
          angleDeg: angle.angleDeg,
          deltaDeg: angle.deltaDeg,
        }
      : undefined,
    length: length
      ? {
          kind: length.kind,
          pieceId: length.pieceId,
          edge: length.edge,
          lengthM: length.lengthM,
          deltaM: length.deltaM,
        }
      : undefined,
  };
}

/** Apply an exact suggested angle/length by moving only the grabbed endpoint. */
export function snapSegmentOutline(
  piece: DraftPiece,
  outline: readonly UV[],
  edge: number,
  moving: number,
  suggestion: SegmentSnapSuggestion,
): UV[] {
  const out = outline.map((p) => [p[0], p[1]] as UV);
  const n = out.length;
  if (n < 2) return out;
  const e = ((edge % n) + n) % n;
  const start = e;
  const end = (e + 1) % n;
  if (moving !== start && moving !== end) return out;
  const fixed = moving === start ? end : start;
  const f = worldUV(piece, out[fixed]!);
  const m = worldUV(piece, out[moving]!);
  const dx = m[0] - f[0];
  const dy = m[1] - f[1];
  const currentLengthM = Math.hypot(dx, dy);
  if (currentLengthM < 1e-9) return out;
  const lengthM = Math.max(0.005, suggestion.length?.lengthM ?? currentLengthM);
  let ux = dx / currentLengthM;
  let uy = dy / currentLengthM;
  if (suggestion.angle) {
    const radians = (suggestion.angle.angleDeg * Math.PI) / 180;
    ux = Math.cos(radians);
    uy = Math.sin(radians);
    // A line angle is unoriented. Keep the endpoint on its current side of the
    // anchor instead of unexpectedly flipping the segment by 180°.
    if (ux * dx + uy * dy < 0) {
      ux = -ux;
      uy = -uy;
    }
  }
  const movedWorld: [number, number] = [f[0] + ux * lengthM, f[1] + uy * lengthM];
  out[moving] = [movedWorld[0] / piece.width + 0.5, (piece.topY - movedWorld[1]) / piece.height];
  return out;
}

/** Resize a second, married segment by the same signed physical delta. */
export function resizeLinkedSegmentByDelta(
  piece: DraftPiece,
  outline: readonly UV[],
  edge: number,
  moving: number,
  deltaM: number,
): UV[] {
  const geometry = outlineEdgeGeometry(piece, outline, edge);
  if (!geometry) return outline.map((p) => [p[0], p[1]] as UV);
  const lengthM = Math.max(0.005, geometry.lengthM + deltaM);
  return snapSegmentOutline(piece, outline, edge, moving, {
    length: { kind: 'parallel', pieceId: 0, edge, lengthM, deltaM },
  });
}

/**
 * Pick the endpoint of a married segment that visually corresponds to the
 * endpoint grabbed on the source segment.
 *
 * Polygon contours reverse direction from one side of a piece to the other:
 * a left side may be stored top→bottom while the right side is bottom→top.
 * Comparing the physical edge vectors prevents a linked endpoint from moving
 * upward when its counterpart is being pulled downward (and vice versa).
 */
export function linkedSegmentMovingVertex(
  sourcePiece: DraftPiece,
  sourceOutline: readonly UV[],
  sourceEdge: number,
  sourceMoving: number,
  linkedPiece: DraftPiece,
  linkedOutline: readonly UV[],
  linkedEdge: number,
): number {
  const sourceN = sourceOutline.length;
  const linkedN = linkedOutline.length;
  if (sourceN < 2 || linkedN < 2) return 0;
  const se = ((sourceEdge % sourceN) + sourceN) % sourceN;
  const le = ((linkedEdge % linkedN) + linkedN) % linkedN;
  const sourceEnd = (se + 1) % sourceN;
  const linkedEnd = (le + 1) % linkedN;
  const sourceMovesEnd = sourceMoving === sourceEnd;
  const sourceGeometry = outlineEdgeGeometry(sourcePiece, sourceOutline, se);
  const linkedGeometry = outlineEdgeGeometry(linkedPiece, linkedOutline, le);
  if (!sourceGeometry || !linkedGeometry) return sourceMovesEnd ? linkedEnd : le;

  const orientationDot =
    sourceGeometry.vector[0] * linkedGeometry.vector[0] +
    sourceGeometry.vector[1] * linkedGeometry.vector[1];
  const sameDirection = orientationDot >= 0;
  if (sameDirection) return sourceMovesEnd ? linkedEnd : le;
  return sourceMovesEnd ? le : linkedEnd;
}

/**
 * Start a direct segment-length gesture. The endpoint nearest to `grab` moves;
 * its opposite endpoint stays fixed. Calculations use physical metres, so a
 * non-square piece does not distort diagonal edits.
 */
export function beginSegmentLengthEdit(piece: DraftPiece, edge: number, grab: UV, minLength = 0.005): SegmentLengthEdit | null {
  const n = piece.outline.length;
  if (n < 2 || piece.width <= 0 || piece.height <= 0) return null;
  const e = ((edge % n) + n) % n;
  const start = e;
  const end = (e + 1) % n;
  const a = metricUV(piece, piece.outline[start]!);
  const b = metricUV(piece, piece.outline[end]!);
  const g = metricUV(piece, grab);
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-10) return null;
  const t = Math.min(1, Math.max(0, ((g[0] - a[0]) * abx + (g[1] - a[1]) * aby) / len2));
  const moving = t < 0.5 ? start : end;
  const fixed = moving === start ? end : start;
  const m = metricUV(piece, piece.outline[moving]!);
  const f = metricUV(piece, piece.outline[fixed]!);
  const length = Math.hypot(m[0] - f[0], m[1] - f[1]);
  const unit: [number, number] = [(m[0] - f[0]) / length, (m[1] - f[1]) / length];
  const grabAlong = (m[0] - g[0]) * unit[0] + (m[1] - g[1]) * unit[1];
  return {
    edge: e,
    moving,
    fixed,
    unit,
    grab: [grab[0], grab[1]],
    grabAlong,
    minLength,
    startLength: length,
  };
}

/**
 * Live outline produced by an axis-constrained segment-length gesture.
 * Coordinates may temporarily leave [0,1]²: this is deliberate. On release,
 * `expandPieceForOutline` grows the physical piece frame around the new point
 * instead of imposing an arbitrary maximum length.
 */
export function resizeSegmentFromPointer(
  piece: DraftPiece,
  original: readonly UV[],
  edit: SegmentLengthEdit,
  pointer: UV,
): UV[] {
  const out = original.map((p) => [p[0], p[1]] as UV);
  const f = metricUV(piece, original[edit.fixed]!);
  const p = metricUV(piece, pointer);
  const projected = (p[0] - f[0]) * edit.unit[0] + (p[1] - f[1]) * edit.unit[1] + edit.grabAlong;
  const length = Math.max(edit.minLength, projected);
  const moved: UV = [
    (f[0] + edit.unit[0] * length) / piece.width,
    (f[1] + edit.unit[1] * length) / piece.height,
  ];
  out[edit.moving] = moved;
  return out;
}

/**
 * Grow a piece's physical frame just enough to contain `outline`, without ever
 * shrinking the existing frame. All outline and dart points are converted
 * through physical world coordinates, so every untouched point stays exactly
 * where it was; only their normalised UV representation changes.
 */
export function expandPieceForOutline(piece: DraftPiece, outline: readonly UV[]): DraftPiece {
  const worldOutline = outline.map((p) => worldUV(piece, p));
  const worldDarts = piece.darts.map((d) => [worldUV(piece, d.apex), worldUV(piece, d.legA), worldUV(piece, d.legB)] as const);

  let halfWidth = piece.width / 2;
  let topY = piece.topY;
  let bottomY = piece.topY - piece.height;
  for (const [x, y] of [...worldOutline, ...worldDarts.flat()]) {
    halfWidth = Math.max(halfWidth, Math.abs(x));
    topY = Math.max(topY, y);
    bottomY = Math.min(bottomY, y);
  }

  const width = Math.max(1e-4, halfWidth * 2);
  const height = Math.max(1e-4, topY - bottomY);
  const toUV = ([x, y]: readonly [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  return {
    ...piece,
    width,
    height,
    topY,
    outline: worldOutline.map(toUV),
    darts: worldDarts.map((d) => ({ apex: toUV(d[0]), legA: toUV(d[1]), legB: toUV(d[2]) })),
  };
}

export type PieceResizeCorner = 'nw' | 'ne' | 'se' | 'sw';

export interface DraftPieceBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Physical outline bounds in pattern metres. */
export function draftPieceBounds(piece: DraftPiece, outline: readonly UV[] = piece.outline): DraftPieceBounds {
  if (!outline.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const uv of outline) {
    const [x, y] = worldUV(piece, uv);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/** World position of a CAD bounding-box corner. */
export function pieceResizeCornerPoint(
  bounds: DraftPieceBounds,
  corner: PieceResizeCorner,
): [number, number] {
  return [
    corner === 'nw' || corner === 'sw' ? bounds.minX : bounds.maxX,
    corner === 'nw' || corner === 'ne' ? bounds.maxY : bounds.minY,
  ];
}

export function oppositePieceResizeCorner(corner: PieceResizeCorner): PieceResizeCorner {
  if (corner === 'nw') return 'se';
  if (corner === 'ne') return 'sw';
  if (corner === 'se') return 'nw';
  return 'ne';
}

/**
 * Proportional scale read from a dragged corner. Projection on the original
 * diagonal ignores sideways mouse wobble; only a tiny positive minimum is
 * imposed, never a maximum.
 */
export function pieceResizeScale(
  anchor: readonly [number, number],
  handle: readonly [number, number],
  pointer: readonly [number, number],
  minScale = 0.02,
): number {
  const dx = handle[0] - anchor[0];
  const dy = handle[1] - anchor[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 1;
  const raw = ((pointer[0] - anchor[0]) * dx + (pointer[1] - anchor[1]) * dy) / len2;
  return Number.isFinite(raw) ? Math.max(minScale, raw) : 1;
}

/**
 * Scale the complete pattern piece around a fixed physical point. Outline,
 * darts and all edge indices are preserved. The cutting frame is rebuilt
 * around the transformed world geometry, so shrinking works as well as growing
 * and the fixed corner does not drift.
 */
export function resizeDraftPieceGlobally(
  piece: DraftPiece,
  anchor: readonly [number, number],
  scale: number,
): DraftPiece {
  const s = Math.max(0.02, Number.isFinite(scale) ? scale : 1);
  const transform = (uv: UV): [number, number] => {
    const [x, y] = worldUV(piece, uv);
    return [anchor[0] + (x - anchor[0]) * s, anchor[1] + (y - anchor[1]) * s];
  };
  const worldOutline = piece.outline.map(transform);
  const worldDarts = piece.darts.map((d) => [transform(d.apex), transform(d.legA), transform(d.legB)] as const);
  const all = [...worldOutline, ...worldDarts.flat()];
  if (!all.length) return { ...piece };

  let maxAbsX = 0;
  let topY = -Infinity;
  let bottomY = Infinity;
  for (const [x, y] of all) {
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    topY = Math.max(topY, y);
    bottomY = Math.min(bottomY, y);
  }
  const width = Math.max(1e-4, maxAbsX * 2);
  const height = Math.max(1e-4, topY - bottomY);
  const toUV = ([x, y]: readonly [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  return {
    ...piece,
    width,
    height,
    topY,
    outline: worldOutline.map(toUV),
    darts: worldDarts.map((d) => ({ apex: toUV(d[0]), legA: toUV(d[1]), legB: toUV(d[2]) })),
  };
}

/** Apply one proportional scale to several pieces, each around its own corner. */
export function resizeDraftPiecesTogether(
  pieces: readonly DraftPiece[],
  corner: PieceResizeCorner,
  scale: number,
): DraftPiece[] {
  const opposite = oppositePieceResizeCorner(corner);
  return pieces.map((piece) =>
    resizeDraftPieceGlobally(
      piece,
      pieceResizeCornerPoint(draftPieceBounds(piece), opposite),
      scale,
    ),
  );
}

export interface PieceSelectionState {
  selected: number[];
  primary: number | null;
}

/**
 * CAD selection rule: ordinary right-click replaces/toggles the selection;
 * Command/Ctrl + right-click adds or removes one piece without losing others.
 */
export function nextPieceSelection(
  current: readonly number[],
  hit: number | null,
  additive: boolean,
): PieceSelectionState {
  const selected = new Set(current);
  if (!additive) {
    if (hit === null || (selected.size === 1 && selected.has(hit))) {
      return { selected: [], primary: null };
    }
    return { selected: [hit], primary: hit };
  }
  if (hit === null) {
    const kept = [...selected];
    return { selected: kept, primary: kept.at(-1) ?? null };
  }
  if (selected.has(hit)) selected.delete(hit);
  else selected.add(hit);
  const result = [...selected];
  return { selected: result, primary: selected.has(hit) ? hit : result.at(-1) ?? null };
}

/** Simple screen-space polygon hit test for right-click piece selection. */
export function pointInPatternPolygon(
  point: readonly [number, number],
  polygon: readonly (readonly [number, number])[],
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses =
      (a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * UNE COULEUR PAR COUTURE : les deux bords cousus ensemble portent la même
 * couleur (dans le plan 2D ET sur l'avatar en 3D) — le lien se lit d'un coup
 * d'œil. Palette lisible sur fond sombre, cyclée par index de couture.
 */
export { SEAM_COLORS };

/** Un lien SYSTÈME : les cellules réellement épinglées d'une pièce wrap
 * (bouche de manche, bas de col) et du corps (emmanchure, encolure) —
 * converties en (u,v) par pièce pour être surlignées comme une couture. */
export interface SystemLink {
  pid: number; // la pièce wrap (manche / col)
  body0: UV[]; // cellules épinglées du corps, panneau DEVANT
  body1: UV[]; // panneau DOS
  piece: UV[]; // cellules de la bouche de la pièce
}

/** Rectangle écran dans lequel la plume peut réellement ajouter des points. */
export interface PatternDrawingZone {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Les bords de la zone font partie de la surface de dessin autorisée. */
export function pointInPatternDrawingZone(
  point: readonly [number, number],
  zone: PatternDrawingZone,
): boolean {
  return (
    point[0] >= zone.left &&
    point[0] <= zone.right &&
    point[1] >= zone.top &&
    point[1] <= zone.bottom
  );
}

/** Message public stable, partagé par le rendu visible et l'annonce accessible. */
export function patternDrawingZonePrompt(pieceId: number): string {
  return `Dessinez dans la zone PIÈCE ${pieceId + 1}`;
}

// TOILE-20 : tolérances de saisie élargies (trackpad-friendly). Les cibles
// denses restent sûres : pickVertex prend désormais le plus PROCHE dans le
// rayon, et nearestEdge était déjà un plus-proche.
const HIT_RADIUS = 14;
const EDGE_HIT = 10; // click within this many px of an outline edge → add point / bend
const PIECE_CLICK_PX = 5; // clic sec vs glisser (v177) : au-delà, le geste est un pan
const DART_DRAG = 7; // drag farther than this from an edge → it's a bend (Alt: dart), not an add
const PEN_FEEDBACK_MS = 2200;

interface DragState {
  index: number;
  value: number;
  pointerId: number;
  // Grab offset keeps the drag relative: no value jump when the press lands
  // off-center inside the hit radius.
  grabDX: number;
  grabDY: number;
}

interface PieceResizeDrag {
  pieceId: number;
  corner: PieceResizeCorner;
  pointerId: number;
  members: Array<{ pieceId: number; original: DraftPiece; anchor: [number, number] }>;
  anchor: [number, number];
  handle: [number, number];
  grabDX: number;
  grabDY: number;
  scale: number;
}

interface PieceMoveDrag {
  pieceId: number;
  pointerId: number;
  startLayout: [number, number];
  members: Array<{ pieceId: number; startShift: [number, number] }>;
  delta: [number, number];
}

interface PieceResizeTarget {
  pieceId: number;
  corner: PieceResizeCorner;
}

export class PatternView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly onChange: (id: string, value: number) => void;

  // The pattern pieces are redrawn into an offscreen layer once per build;
  // hover/drag frames just blit it and repaint the handles.
  private readonly staticLayer: HTMLCanvasElement;
  private staticDirty = true;

  private mesh: ClothMeshData | null = null;
  private handles: PatternHandleSpec[] = [];
  // Rest-layout → canvas transform, captured when the static layer renders.
  private tf: PatternLayoutTransform | null = null;
  // Public-friendly CAD navigation. 100% is the automatic "fit all" view;
  // wheel zoom stays under the pointer and a background drag pans when zoomed.
  private viewZoom = 1;
  private viewCenter: [number, number] | null = null;
  private panDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
  /** Clic sec candidat sur une pièce (v177 « pas dépaysé » ②) : noté au
   *  pointerdown, invalidé au premier écart > PIECE_CLICK_PX, décidé au
   *  pointerup — le glisser reste un pan intact. */
  private pieceClickPending: { pieceId: number; pointerId: number; cx: number; cy: number } | null = null;
  /** Le bord MESURÉ au clic sec (v180 « pas dépaysé » ⑤) : surligné et coté en
   *  place tant qu'il est sélectionné — Échap, un autre clic ou toute édition
   *  du patron l'effacent (les indices de bord bougent avec le contour). */
  private measuredEdge: { pieceId: number; edge: number } | null = null;
  // Side-by-side layout of a combined outfit's pieces: a per-garment x-offset
  // (layout meters) so overlapping fronts separate, plus each garment's y-range
  // for matching a handle back to its piece. Null for a single garment.
  private gLayout: { offsetX: number[]; gY: [number, number][] } | null = null;

  private hover: number | null = null;
  private drag: DragState | null = null;

  // Freeform "atelier" editing: when a draft piece is set, the outline vertices
  // become draggable handles (a separate path from the parametric handles).
  private readonly onDraftChange: (
    piece: DraftPiece,
    pieceId: number,
    seams?: AssemblySeam[],
    segmentLinks?: AssemblySeam[],
    linkedPieces?: DraftPieceUpdate[],
  ) => void;
  // Manual-assembly callbacks: add a seam (edge A ↔ edge B), or delete seam #i.
  private readonly onAssemblySeam: (seam: AssemblySeam) => void;
  private readonly onAssemblyDelete: (index: number) => void;
  // Remove a FREE piece (its column + its seams) by pieceId (≥ 2).
  private readonly onDeletePiece: (pieceId: number) => void;
  // Le mode plume s'allume/s'éteint : la barre d'outils montre « Terminer »
  // seulement pendant un tracé (outil contextuel, façon CLO).
  private readonly onPenState: (drawing: boolean) => void;
  private readonly onSegmentLinksChange: (links: AssemblySeam[]) => void;
  // Multi-piece columns (CLO-style): pieces[0]=FRONT, [1]=BACK (may be null,
  // drawn from scratch), [≥2]=FREE pieces (collar, yoke…). Gestures edit
  // whichever column the pointer went down in (`activePiece`); `draftPiece` is
  // that active piece.
  private pieces: (DraftPiece | null)[] = [];
  private activePiece = 0;
  private emitActivePiece(): void {
    this.canvas.dispatchEvent(
      new CustomEvent('patternpiecechange', { detail: { pieceId: this.activePiece } }),
    );
  }
  // World-x offset of each column (offsets[0]=0); columns lay out left→right,
  // one per piece, each AS WIDE AS ITS PIECE (body columns span the avatar
  // silhouette; free pieces take just their own width — plan de coupe épuré).
  // colEdges = the boundary x between adjacent columns (mid-gutter), so
  // pickColumn can route a gesture by interval even with unequal widths.
  private offsets: number[] = [];
  private colEdges: number[] = [];
  // Pure 2D cutting-table placement. It is deliberately separate from
  // DraftPiece.width/topY/outline: arranging pieces in the plan must never
  // change their physical spawn position or the result of ▶ Simuler.
  private layoutShifts: Array<[number, number]> = [];
  private layoutKeys: string[] = [];
  private get nCols(): number {
    return Math.max(2, this.pieces.length); // front + back always shown, then extras
  }
  private get inDraft(): boolean {
    return this.pieces.some((p) => !!p);
  }
  private pieceAt(pid: number): DraftPiece | null {
    return this.pieces[pid] ?? null;
  }
  private get draftPiece(): DraftPiece | null {
    return this.pieceAt(this.activePiece);
  }
  private setActive(piece: DraftPiece | null): void {
    this.pieces[this.activePiece] = piece;
  }
  private layoutKey(piece: DraftPiece | null, pid: number): string {
    return piece
      ? `${pid}|${piece.name ?? ''}|${piece.wrap ?? ''}|${piece.patternOnly ? 'construction' : 'cloth'}`
      : `${pid}|empty`;
  }
  private pieceLayoutShift(pid: number): [number, number] {
    return this.layoutShifts[pid] ?? [0, 0];
  }
  private pieceOffset(pid: number): number {
    return (this.offsets[pid] ?? 0) + this.pieceLayoutShift(pid)[0];
  }
  private pieceYOffset(pid: number): number {
    return this.pieceLayoutShift(pid)[1];
  }
  private activeOffset(): number {
    return this.pieceOffset(this.activePiece);
  }
  private activeYOffset(): number {
    return this.pieceYOffset(this.activePiece);
  }
  /** Human label for a column: DEVANT / DOS / MANCHE D/G / COL / PIÈCE n. */
  private pieceLabel(pid: number): string {
    return draftPieceLabel(this.pieceAt(pid), pid);
  }
  private pieceFabricFill(piece: DraftPiece, alpha: number): string {
    // Couleur d'empiècement posée : elle gagne sur la teinte du tissu, un peu
    // plus affirmée pour que le colorblock se lise aussi dans le plan 2D.
    if (piece.color && /^#[0-9a-f]{6}$/i.test(piece.color)) {
      const v = parseInt(piece.color.slice(1), 16);
      const a = Math.min(0.5, alpha + 0.18);
      return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
    }
    const rgb: Record<string, [number, number, number]> = {
      Jersey: [222, 209, 184],
      Maille: [184, 115, 107],
      Popeline: [237, 237, 230],
      Denim: [59, 74, 115],
      Lin: [217, 204, 173],
      Laine: [133, 128, 133],
      Soie: [237, 222, 199],
    };
    const c = piece.fabricPreset ? rgb[piece.fabricPreset] : undefined;
    return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : `rgba(${PAL.tissuDefautRVB}, ${alpha})`;
  }
  private updateCanvasLabel(): void {
    const labels = this.pieces
      .map((piece, pid) => (piece ? this.pieceLabel(pid) : null))
      .filter((label): label is string => !!label);
    const selected = [...this.selectedPieces]
      .filter((pid) => !!this.pieceAt(pid))
      .map((pid) => this.pieceLabel(pid));
    this.canvas.setAttribute(
      'aria-label',
      [
        labels.length ? `Plan de coupe éditable : ${labels.join(', ')}` : 'Plan de coupe',
        ...(this.penMode
          ? [`Zone de tracé active : PIÈCE ${this.activePiece + 1}`]
          : []),
        ...(this.penFeedback ? [this.penFeedback] : []),
        ...(selected.length
          ? [`${selected.length} pièce${selected.length > 1 ? 's' : ''} sélectionnée${selected.length > 1 ? 's' : ''} : ${selected.join(', ')}`]
          : []),
      ].join(' · '),
    );
  }

  /** Rectangle écran exact de la boîte UV [0,1]² de la pièce armée. */
  private penDrawingZone(): PatternDrawingZone | null {
    const piece = this.draftPiece;
    if (!this.penMode || !this.tf || !piece) return null;
    const a = this.layoutToScreen(
      this.activeOffset() - piece.width / 2,
      piece.topY + this.activeYOffset(),
    );
    const b = this.layoutToScreen(
      this.activeOffset() + piece.width / 2,
      piece.topY - piece.height + this.activeYOffset(),
    );
    return {
      left: Math.min(a[0], b[0]),
      right: Math.max(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      bottom: Math.max(a[1], b[1]),
    };
  }

  private pointInPenDrawingZone(point: readonly [number, number]): boolean {
    const zone = this.penDrawingZone();
    return !!zone && pointInPatternDrawingZone(point, zone);
  }

  /** DEV/tests: surface effectivement acceptée par l'outil Nouvelle pièce. */
  debugPenDrawingZone(): PatternDrawingZone | null {
    const zone = this.penDrawingZone();
    return zone ? { ...zone } : null;
  }

  private clearPenFeedback(render = false): void {
    if (this.penFeedbackTimer !== null) {
      clearTimeout(this.penFeedbackTimer);
      this.penFeedbackTimer = null;
    }
    if (this.penFeedback === null) return;
    this.penFeedback = null;
    this.canvas.removeAttribute?.('data-pattern-feedback');
    this.updateCanvasLabel();
    if (render) this.render();
  }

  private showPenDrawingFeedback(): void {
    if (this.penFeedbackTimer !== null) clearTimeout(this.penFeedbackTimer);
    this.penFeedback = patternDrawingZonePrompt(this.activePiece);
    this.canvas.setAttribute('data-pattern-feedback', this.penFeedback);
    this.updateCanvasLabel();
    this.canvas.dispatchEvent(
      new CustomEvent('patterndrawingfeedback', {
        detail: { message: this.penFeedback, pieceId: this.activePiece },
      }),
    );
    this.render();
    this.penFeedbackTimer = setTimeout(() => {
      this.penFeedbackTimer = null;
      this.clearPenFeedback(true);
    }, PEN_FEEDBACK_MS);
  }
  private draftPreview: UV[] | null = null; // live copy while dragging a vertex
  // Clic droit : sélection globale d'une pièce. Commande/Ctrl + clic droit
  // construit un groupe; tirer n'importe quel coin applique la même échelle à
  // toutes ses pièces en une seule opération.
  private selectedPiece: number | null = null;
  private selectedPieces = new Set<number>();
  private pieceResizeHover: PieceResizeTarget | null = null;
  private pieceResizeDrag: PieceResizeDrag | null = null;
  private pieceMoveDrag: PieceMoveDrag | null = null;
  // Glisser-COURBE : les voisins d'arc (reliés au point saisi par des arêtes
  // COURTES = l'échantillonnage d'une courbe) suivent le déplacement avec un
  // amorti — tirer un point d'encolure déforme l'arc en douceur au lieu de
  // faire un pic. Un coin isolé (arêtes longues) bouge seul, comme avant.
  private draftDrag: {
    vertex: number;
    pointerId: number;
    grabDX: number;
    grabDY: number;
    orig: UV[]; // contour figé au début du geste
    curve: { idx: number; w: number }[]; // voisins d'arc + poids d'amorti
  } | null = null;
  private draftHover: number | null = null;
  // A sampled arc is presented as ONE curve segment: endpoints + one diamond
  // handle. Dragging it reshapes every hidden sample without reindexing seams.
  private curveHover: number | null = null;
  private curveDrag:
    | {
        run: LogicalCurveRun;
        pointerId: number;
        grabDX: number;
        grabDY: number;
        orig: UV[];
        handleIndex: number;
      }
    | null = null;
  private curveLengthDrag:
    | (LogicalCurveLengthEdit & {
        pointerId: number;
        orig: UV[];
        rawPointerScreen: [number, number];
        pointerToMovingScreen: [number, number];
        intent: AxisDragIntent;
      })
    | null = null;
  // Mode LONGUEUR : le bord survolé affiche sa cote ; au glisser, l'extrémité
  // la plus proche suit l'axe du segment tandis que l'autre reste fixe.
  private lengthMode = false;
  private lengthHover: { pieceId: number; edge: number } | null = null;
  private lengthDrag:
    | (SegmentLengthEdit & {
        pointerId: number;
        orig: UV[];
        rawPointerScreen: [number, number];
        pointerToMovingScreen: [number, number];
        intent: AxisDragIntent;
        linked?: {
          pieceId: number;
          edge: number;
          moving: number;
          orig: UV[];
          startLength: number;
        };
      })
    | null = null;
  private linkedPreview: { pieceId: number; outline: UV[] } | null = null;
  // Option 🧲 : pendant le glisser longueur, une relation déjà proche devient
  // exacte. `lengthSnap` garde la correction active pour l'expliquer à l'écran.
  private lengthSnapEnabled = false;
  private lengthSnap: SegmentSnapSuggestion | null = null;
  // A press on an outline edge: a click adds a point; dragging inward pulls a dart.
  private draftEdge: {
    edge: number;
    downUV: UV;
    downSX: number;
    downSY: number;
    pointerId: number;
    apex: UV | null; // pince (Alt+glisser) : pointe de la pince en aperçu
    dart: boolean; // Alt enfoncé à la prise → le glisser tire une pince, pas un arc
    bend: UV[] | null; // bomber (glisser simple) : points intérieurs de l'arc en aperçu
  } | null = null;
  // Manual assembly: user-defined seams (front/back edge ↔ edge), plus the first
  // edge picked while awaiting the second (Shift+click), which may be on either face.
  private assembly: AssemblySeam[] = [];
  private segmentLinks: AssemblySeam[] = [];
  private systemLinks: SystemLink[] = [];
  private seamPickA: { pieceId: number; edge: number } | null = null;
  // A pocket/appliqué is positioned by clicking an exact point inside an
  // existing support piece. Its coloured overlay stitches remain individually
  // clickable afterwards.
  private surfacePlacementPieceId: number | null = null;
  private surfacePlacementHover: { supportPieceId: number; anchor: UV } | null = null;
  /** Côté choisi pour la pose en cours : par-dessus (défaut) ou par-dessous. */
  private surfacePlacementSide: 'over' | 'under' = 'over';
  private linkMode = false;
  private linkPickA: { pieceId: number; edge: number } | null = null;
  private linkHover: { pieceId: number; edge: number } | null = null;
  private linkNotice: string | null = null;
  // Mode FERMETURE : two outline runs selected exactly like sewing, but kept
  // as a distinct zipper association so the closure can later be opened.
  private zipperMode = false;
  private zipperPickA: { pieceId: number; edge: number } | null = null;
  private zipperHover: { pieceId: number; edge: number } | null = null;
  // Mode COUDRE guidé (bouton 🪡) : les clics SIMPLES près d'un bord font les
  // deux choix de couture (plus besoin de connaître Maj+clic) ; le mode se
  // referme après la couture. Maj+clic reste disponible en raccourci expert.
  private sewMode = false;
  // Mode COUDRE EN SÉRIE (atelier pro) : 1er clic = le bord RECEVEUR (long),
  // clics suivants = les bords partenaires ; validation → le receveur est
  // scindé par largeur et cousu à chacun (sewEdgeToMany). Entrée valide,
  // re-clic sur le receveur annule.
  private serialMode = false;
  private serialReceiver: { pieceId: number; edge: number } | null = null;
  private serialPartners: { pieceId: number; edge: number }[] = [];
  // Mode COUPER & COUDRE (bouton ✂) : deux clics sur le contour d'une pièce,
  // la corde la scinde et la couture se pose seule (géométrie dans Draft.ts).
  private cutMode = false;
  private cutPick: { pieceId: number; edge: number; t: number } | null = null;
  private cutHover: [number, number] | null = null;
  /** ▱ Ligne interne : outil armé, tracé en cours, survol du curseur. */
  private internalMode = false;
  private internalTrace: UV[] | null = null;
  private internalHover: [number, number] | null = null;
  /** ▱ Ligne interne sélectionnée (index) + drag de point en cours. */
  private selectedInternal: number | null = null;
  private internalPtDrag: { lineIdx: number; ptIdx: number; orig: UV } | null = null;
  /** ⌵ Crans : outil armé. */
  private notchMode = false;
  private mergeMode = false;
  private holeMode = false;
  private precisionMode = false;
  /** ⧢ Évasement : outil armé + pivot retenu + survol. */
  private fullnessMode = false;
  private fullnessPick: { pieceId: number; edge: number; t: number } | null = null;
  private fullnessHover: [number, number] | null = null;
  /** ∿ Point courbe : outil armé + drag de rayon en cours. */
  private curvePointMode = false;
  private curvePointDrag: { vertex: number; radiusM: number; pointerId: number } | null = null;
  /** ◆ Pince losange : outil armé, pointes posées, survol. */
  private dartMode = false;
  private dartTop: UV | null = null;
  private dartBottom: UV | null = null;
  private dartHover: [number, number] | null = null; // curseur, pour l'aperçu de corde
  // Mode FRONCES (bouton 〰) : cliquer un lien de couture ouvre le choix du
  // côté à froncer et du ratio — l'application vit dans main (gatherSeamSide).
  private gatherMode = false;
  // Mode COUTURE LIBRE (bouton 🧵, façon Clo « Free Sewing ») : un clic pose le
  // DÉPART d'un tracé sur un contour, le tracé SUIT le curseur le long du bord
  // (abscisse curviligne déroulée : coins passés, deux sens possibles), un clic
  // pose la fin — puis même geste pour le 2e tracé, et la couture se pose.
  private freeSewMode = false;
  /** Tracé EN COURS (1er ou 2e selon freeSewRunA) : départ figé + abscisse
   * curviligne déroulée du curseur (curS peut sortir de [0,L) — le signe de
   * curS−startS est la direction du tracé). */
  private freeSewTrace: {
    pieceId: number;
    start: { edge: number; t: number };
    startS: number;
    curS: number;
  } | null = null;
  /** 1er tracé commité (en attente du 2e) ; startS/endS = abscisses déroulées
   * pour repeindre l'arc exact, lenM = longueur affichée. */
  private freeSewRunA:
    | {
        pieceId: number;
        start: { edge: number; t: number };
        end: { edge: number; t: number };
        dir: 1 | -1;
        lenM: number;
        startS: number;
        endS: number;
      }
    | null = null;
  // ⧎ MIROIR COUSU (un clic) : cliquer le bord-AXE d'une pièce la duplique en
  // symétrie et coud la paire le long de cet axe (mirrorDuplicatePiece).
  private mirrorMode = false;
  onMirrorPiece: (pieceId: number, axisEdge: number) => void = () => {};
  /** 🪡⁺ Couture en série validée : un bord receveur + les bords partenaires,
   * en runs résolus. main.ts appelle sewEdgeToMany puis reconstruit. */
  onSerialSeam: (receiver: FaceRun, partners: FaceRun[]) => void = () => {};
  /** ▱ Ligne interne terminée (polyligne ou polygone fermé) sur une pièce. */
  onInternalLine: (pieceId: number, line: InternalLine) => void = () => {};
  /** ▱ Suppression d'une ligne interne existante (clic dessus, outil armé). */
  onInternalLineDelete: (pieceId: number, index: number) => void = () => {};
  /** ▱ Édition d'une ligne interne : points déplacés. */
  onInternalLineEdit: (pieceId: number, index: number, line: InternalLine) => void = () => {};
  /** ◆ Pince losange terminée : pointes haute/basse (UV) + demi-largeur (m). */
  onFisheyeDart: (pieceId: number, top: UV, bottom: UV, halfWidthM: number) => void = () => {};
  /** ∿ Un sommet à arrondir : index + rayon métrique choisi au drag. */
  onRoundCorner: (pieceId: number, vertex: number, radiusM: number) => void = () => {};
  /** ✂ sur une ligne interne : scinder la pièce le long de ce tracé. */
  onCutAlongInternalLine: (pieceId: number, lineIndex: number) => void = () => {};
  /** ⌵ Cran : poser/retirer au point cliqué (l'atelier projette sur le bord). */
  onNotchToggle: (pieceId: number, at: UV) => void = () => {};
  /** ⌵ Crans d'accord : générer les repères appariés d'une couture. */
  onNotchSeam: (seamIndex: number) => void = () => {};
  /** ⧉ Fusion : fondre les deux pièces d'une couture en une seule. */
  onMergeSeam: (seamIndex: number) => void = () => {};
  /** ⌾ Évider : basculer une ligne interne fermée en trou (et retour). */
  onHoleToggle: (pieceId: number, lineIndex: number) => void = () => {};
  /** ⌖ Précision : un SOMMET cliqué — l'atelier choisit (équerre/alignement). */
  onPrecisionVertex: (pieceId: number, vertex: number) => void = () => {};
  /** ⌖ Précision : un BORD du contour cliqué (division en N parts égales). */
  onDivideEdge: (pieceId: number, edge: number) => void = () => {};
  /** ⌖ Précision : un BOUT de ligne interne ouverte (prolonger au contour). */
  onExtendInternal: (pieceId: number, lineIndex: number, end: 0 | 1) => void = () => {};
  /** ⌖ Précision : un MILIEU de ligne interne ouverte (scinder en deux). */
  onDivideInternal: (pieceId: number, lineIndex: number, at: UV) => void = () => {};
  /** ⧢ Pivot et ouverture choisis : l'atelier demande les cm puis évase. */
  onFullnessPicked: (
    pieceId: number,
    pivot: { edge: number; t: number },
    opening: { edge: number; t: number },
  ) => void = () => {};
  // 🖼 GRAPHIQUE de pièce : édition directe sur le plan — glisser = déplacer,
  // poignée du coin = taille, poignée haute = rotation. Aperçu vivant pendant
  // le geste ; le commit (relâché) remonte à l'atelier qui pousse l'historique.
  private graphicImages = new Map<string, HTMLImageElement>();
  private graphicDrag: {
    pid: number;
    mode: 'move' | 'scale' | 'rotate';
    pointerId: number;
    start: PieceGraphic;
    preview: PieceGraphic;
    grabDU: number;
    grabDV: number;
  } | null = null;
  onGraphicChange: (pieceId: number, graphic: PieceGraphic) => void = () => {};
  /** Câblés par l'atelier (main.ts), après construction. */
  onCutPiece: (
    pieceId: number,
    a: { edge: number; t: number },
    b: { edge: number; t: number },
    withSeam: boolean,
  ) => void = () => {};
  onGatherSeam: (seamIndex: number) => void = () => {};
  onFreeSeam: (
    a: { pieceId: number; start: { edge: number; t: number }; end: { edge: number; t: number }; dir: 1 | -1 },
    b: { pieceId: number; start: { edge: number; t: number }; end: { edge: number; t: number }; dir: 1 | -1 },
  ) => void = () => {};
  // Pen tool: drawing a new piece from scratch (click to place points, close it).
  private penMode = false;
  /** Écrit penMode ET prévient la barre d'outils quand l'état change. */
  private setPen(on: boolean): void {
    const changed = this.penMode !== on;
    this.penMode = on;
    if (changed) this.onPenState(on);
    if (!on) this.clearPenFeedback();
    this.updateCanvasLabel();
  }
  private penPoints: UV[] = [];
  /** ⋈ Création miroir : le 1er point pose l'axe vertical, la moitié dessinée
   * s'échoit en direct et la fermeture produit la pièce symétrique entière.
   * Préférence COLLANTE : survit à la fermeture d'un tracé. */
  private penMirror = false;
  // La plume ne doit plus sembler « cassée » quand un clic tombe dans une
  // autre colonne : état de survol + message bref, tous deux peints sur le
  // canvas (et reflétés dans son aria-label).
  private penPointerInside: boolean | null = null;
  private penFeedback: string | null = null;
  private penFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  // Filet de sécurité de la plume : la pièce remplacée pendant le tracé, pour
  // la restaurer si le tracé est abandonné (✎ ne détruit jamais un patron).
  private penBackup: DraftPiece | null = null;
  private penBackupPid: number | null = null;
  // Exact avatar silhouette (world-space filled rects + bounds), drawn behind
  // the atelier grid as a size reference, or null to hide it.
  private bodySil: { minX: number; maxX: number; minY: number; maxY: number; rects: Array<[number, number, number, number]> } | null =
    null;
  // During the physical fitting the 2D pane remains visible as a reference,
  // but it must not silently edit the draft. The workspace explicitly
  // re-enables interaction when the user returns to pattern design.
  private interactionEnabled = true;
  // PAGE BLANCHE (boot de l'atelier) : le plan ne montre que la grille et la
  // silhouette — aucune pièce, aucun geste d'édition, seul le panoramique vit.
  private pristine = false;

  setPristine(on: boolean): void {
    if (this.pristine === on) return;
    this.pristine = on;
    this.staticDirty = true; // les intitulés de colonnes vivent dans la couche statique
    this.render();
  }

  constructor(
    canvas: HTMLCanvasElement,
    onChange: (id: string, value: number) => void = () => {},
    onDraftChange: (
      piece: DraftPiece,
      pieceId: number,
      seams?: AssemblySeam[],
      segmentLinks?: AssemblySeam[],
      linkedPieces?: DraftPieceUpdate[],
    ) => void = () => {},
    onAssemblySeam: (seam: AssemblySeam) => void = () => {},
    onAssemblyDelete: (index: number) => void = () => {},
    onDeletePiece: (pieceId: number) => void = () => {},
    onPenState: (drawing: boolean) => void = () => {},
    onSegmentLinksChange: (links: AssemblySeam[]) => void = () => {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onDraftChange = onDraftChange;
    this.onAssemblySeam = onAssemblySeam;
    this.onAssemblyDelete = onAssemblyDelete;
    this.onDeletePiece = onDeletePiece;
    this.onPenState = onPenState;
    this.onSegmentLinksChange = onSegmentLinksChange;
    this.canvas.setAttribute('aria-live', 'polite');
    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = canvas.width;
    this.staticLayer.height = canvas.height;
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('dblclick', this.onDblClick, true);
    window.addEventListener('contextmenu', this.onContextMenu, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    if (import.meta.env.DEV) (window as unknown as { __toilePattern?: PatternView }).__toilePattern = this;
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__toileDebugPieces = () => {
      const summary = this.pieces.map((p, i) => {
        if (!p) return `[${i}] null`;
        const flags = [p.blank && 'BLANK', p.placement?.role].filter(Boolean).join(' ');
        return `[${i}] ${p.outline?.length ?? 0} pts ${flags} name=${p.name ?? '-'}`;
      });
      console.table(summary);
      const seen = new Map<string, number>();
      for (let i = 0; i < this.pieces.length; i++) {
        const p = this.pieces[i];
        if (!p || p.blank || (p.outline?.length ?? 0) < 3) continue;
        const key = p.outline.map(([u, v]) => `${u.toFixed(4)},${v.toFixed(4)}`).join('|');
        if (seen.has(key)) console.warn(`⚠ DOUBLON : [${seen.get(key)}] et [${i}]`);
        seen.set(key, i);
      }
      return `${this.pieces.length} pièces, activePiece=${this.activePiece}`;
    };
  }

  get zoomPercent(): number {
    return Math.round(this.viewZoom * 100);
  }

  setInteractionEnabled(enabled: boolean): void {
    this.interactionEnabled = enabled;
    if (!enabled) {
      this.lengthHover = null;
      this.linkHover = null;
      this.zipperHover = null;
      this.surfacePlacementHover = null;
      this.pieceResizeHover = null;
      this.penPointerInside = null;
      document.body.style.cursor = '';
      this.render();
    }
  }

  /** Zoom from the centre (toolbar buttons). */
  zoomBy(factor: number): void {
    const next = Math.min(16, Math.max(1, this.viewZoom * factor));
    if (Math.abs(next - this.viewZoom) < 1e-6) return;
    this.viewZoom = next;
    if (next === 1) this.viewCenter = null;
    this.viewChanged();
  }

  /** Return to the automatic full-pattern framing. */
  resetView(): void {
    if (this.viewZoom === 1 && this.viewCenter === null) return;
    this.viewZoom = 1;
    this.viewCenter = null;
    this.viewChanged();
  }

  private viewChanged(): void {
    this.staticDirty = true;
    this.canvas.dispatchEvent(
      new CustomEvent('patternzoom', { detail: { percent: this.zoomPercent } }),
    );
    this.render();
  }

  /** Double-click an outline vertex to remove it (freeform drawing). */
  private readonly onDblClick = (e: MouseEvent): void => {
    if (!this.inDraft || this.selectedPiece !== null) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    this.routePieceGesture(p[0], p[1]);
    if (!this.draftPiece) return;
    const v = this.pickVertex(p[0], p[1]);
    if (v === null) return; // not on a vertex → let the 3D canvas handle it
    const next = deleteOutlineVertex(this.draftPiece, v);
    if (next.outline.length === this.draftPiece.outline.length) return; // ≤3 guard
    e.preventDefault();
    e.stopPropagation();
    // Removing a point shifts edge indices → re-index the assembly seams (on this
    // column's pieceId) so they keep pointing at the same physical edges.
    this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'delete', v, next.outline.length);
    this.segmentLinks = reindexAssemblySeams(this.segmentLinks, this.activePiece, 'delete', v, next.outline.length);
    this.applyActive(next);
    this.render();
    this.onDraftChange(next, this.activePiece, this.assembly, this.segmentLinks);
  };

  /** DEV: current outline vertices in canvas-local pixels (for input tests). */
  debugVertexScreens(): [number, number][] {
    if (!this.draftPiece) return [];
    return this.draftPiece.outline
      .map((uv) => this.vertexScreen(uv))
      .filter((s): s is [number, number] => s !== null);
  }

  /** DEV: current physical edge lengths of the active piece. */
  debugEdgeLengthsCm(): number[] {
    if (!this.draftPiece) return [];
    const out = this.draftPreview ?? this.draftPiece.outline;
    return out.map((_p, edge) => outlineEdgeLengthCm(this.draftPiece!, out, edge));
  }

  draw(mesh: ClothMeshData, handles: PatternHandleSpec[] = []): void {
    this.mesh = mesh;
    this.handles = handles;
    this.staticDirty = true;
    this.drag = null;
    this.hover = null;
    this.draftPreview = null; // the rebuild committed the drag
    this.draftDrag = null;
    this.curveDrag = null;
    this.curveLengthDrag = null;
    this.pieceMoveDrag = null;
    this.lengthDrag = null;
    this.lengthHover = null;
    this.lengthSnap = null;
    this.linkedPreview = null;
    document.body.style.cursor = '';
    this.render();
  }

  private clonePiece(piece: DraftPiece | null): DraftPiece | null {
    return piece
      ? {
          ...piece,
          outline: piece.outline.map((p) => [p[0], p[1]] as UV),
          openEdges: piece.openEdges.map((r) => ({ ...r })),
          seams: piece.seams.map((s) => ({ a: { ...s.a }, b: { ...s.b } })),
          darts: piece.darts.map((d) => ({ apex: [...d.apex] as UV, legA: [...d.legA] as UV, legB: [...d.legB] as UV })),
          placement: piece.placement
            ? {
                ...piece.placement,
                surface: piece.placement.surface
                  ? {
                      ...piece.placement.surface,
                      anchor: [...piece.placement.surface.anchor] as UV,
                      stitchedEdges: [...piece.placement.surface.stitchedEdges],
                    }
                  : undefined,
              }
            : undefined,
        }
      : null;
  }
  private resetDraftTransient(): void {
    this.draftPreview = null;
    this.draftDrag = null;
    this.draftHover = null;
    this.curveHover = null;
    this.curveDrag = null;
    this.curveLengthDrag = null;
    this.pieceResizeHover = null;
    this.pieceResizeDrag = null;
    this.pieceMoveDrag = null;
    this.lengthHover = null;
    this.lengthDrag = null;
    this.lengthSnap = null;
    this.linkedPreview = null;
    this.draftEdge = null;
    this.seamPickA = null;
    this.linkPickA = null;
    this.linkHover = null;
    this.zipperPickA = null;
    this.zipperHover = null;
  }

  /**
   * Cancel every 2D editing tool and in-flight gesture without committing it.
   *
   * Escape calls this single transaction from the workspace. Live whole-piece
   * edits are restored from their pointer-down snapshots before transient state
   * is cleared; outline previews never reach `onDraftChange`.
   */
  cancelInteractions(): PatternCancelResult {
    const cancelledTool =
      this.penMode ||
      this.lengthMode ||
      this.lengthSnapEnabled ||
      this.linkMode ||
      this.sewMode ||
      this.zipperMode ||
      this.cutMode ||
      this.internalMode ||
      this.dartMode ||
      this.curvePointMode ||
      this.notchMode ||
      this.mergeMode ||
      this.holeMode ||
      this.precisionMode ||
      this.fullnessMode ||
      this.gatherMode ||
      this.mirrorMode ||
      this.freeSewMode ||
      this.surfacePlacementPieceId !== null ||
      this.seamPickA !== null ||
      this.linkPickA !== null ||
      this.zipperPickA !== null ||
      this.cutPick !== null ||
      this.internalTrace !== null ||
      this.dartTop !== null ||
      this.curvePointDrag !== null ||
      this.fullnessPick !== null ||
      this.freeSewTrace !== null ||
      this.freeSewRunA !== null ||
      this.selectedPiece !== null ||
      this.selectedPieces.size > 0;
    const cancelledGesture =
      this.panDrag !== null ||
      this.graphicDrag !== null ||
      this.drag !== null ||
      this.draftPreview !== null ||
      this.draftDrag !== null ||
      this.curveDrag !== null ||
      this.curveLengthDrag !== null ||
      this.pieceResizeDrag !== null ||
      this.pieceMoveDrag !== null ||
      this.lengthDrag !== null ||
      this.linkedPreview !== null ||
      this.draftEdge !== null ||
      this.penPoints.length > 0;

    // These two gestures mutate their live display state while the pointer is
    // down. Restore their immutable pointer-down snapshots before nulling them.
    if (this.pieceMoveDrag) {
      for (const member of this.pieceMoveDrag.members) {
        this.layoutShifts[member.pieceId] = [...member.startShift];
      }
    }
    if (this.pieceResizeDrag) {
      for (const member of this.pieceResizeDrag.members) {
        this.pieces[member.pieceId] = this.clonePiece(member.original);
      }
    }

    // A half-drawn piece has its own backup contract. Aborting it restores the
    // former piece (or removes the newly opened empty column) without callbacks.
    if (this.penMode) this.abortPen(false);
    else this.resetDraftTransient();

    this.panDrag = null;
    this.pieceClickPending = null;
    this.measuredEdge = null;
    this.drag = null;
    this.hover = null;
    this.graphicDrag = null;
    this.lengthMode = false;
    this.lengthSnapEnabled = false;
    this.linkMode = false;
    this.linkNotice = null;
    this.sewMode = false;
    this.zipperMode = false;
    this.cutMode = false;
    this.cutPick = null;
    this.cutHover = null;
    this.internalMode = false;
    this.internalTrace = null;
    this.internalHover = null;
    this.selectedInternal = null;
    this.internalPtDrag = null;
    this.dartMode = false;
    this.dartTop = null;
    this.dartBottom = null;
    this.dartHover = null;
    this.curvePointMode = false;
    this.curvePointDrag = null;
    this.notchMode = false;
    this.mergeMode = false;
    this.holeMode = false;
    this.precisionMode = false;
    this.fullnessMode = false;
    this.fullnessPick = null;
    this.fullnessHover = null;
    this.gatherMode = false;
    this.mirrorMode = false;
    this.clearFreeSew();
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.selectedPiece = null;
    this.selectedPieces.clear();
    this.penPoints = [];
    this.penPointerInside = null;
    this.clearPenFeedback();
    this.resetDraftTransient();
    document.body.style.cursor = '';
    this.updateCanvasLabel();
    this.render();
    return { cancelledTool, cancelledGesture };
  }

  /** Update the manual-assembly seams to render (front/back edge ↔ edge). */
  setAssembly(seams: AssemblySeam[]): void {
    this.assembly = seams.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
    this.render();
  }

  /** Update the persisted editing marriages (no physical stitches). */
  setSegmentLinks(links: AssemblySeam[]): void {
    this.segmentLinks = links.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } }));
    this.render();
  }

  /** Liens SYSTÈME (manche↔emmanchure, col↔encolure) : les épingles réelles
   * compilées au build, converties en cellules (u,v) par pièce — surlignées
   * dans les couleurs qui suivent celles des coutures manuelles. */
  setSystemLinks(links: SystemLink[]): void {
    this.systemLinks = links;
    this.render();
  }

  /**
   * Réinitialiser l'ARRANGEMENT 2D (le « Reset 2D Arrangement » de Clo) :
   * toutes les pièces déplacées dans le plan retrouvent leur colonne. État de
   * vue pur — le patron, les coutures et l'essayage ne changent jamais.
   * Rend le nombre de pièces effectivement rangées.
   */
  resetLayoutArrangement(): number {
    let moved = 0;
    for (const shift of this.layoutShifts) {
      if (shift && (Math.abs(shift[0]) > 1e-9 || Math.abs(shift[1]) > 1e-9)) moved++;
    }
    if (!moved) return 0;
    this.layoutShifts = this.layoutShifts.map(() => [0, 0] as [number, number]);
    this.pieceMoveDrag = null;
    this.staticDirty = true;
    this.render();
    return moved;
  }

  /**
   * Enter freeform draft editing (atelier) with the FRONT `piece` and an optional
   * independent BACK face, or leave draft mode (both null).
   */
  setDraft(piece: DraftPiece | null, back: DraftPiece | null = null, extra: DraftPiece[] = []): void {
    const nextPieces = [this.clonePiece(piece), this.clonePiece(back), ...extra.map((e) => this.clonePiece(e))];
    const nextKeys = nextPieces.map((next, pid) => this.layoutKey(next, pid));
    this.layoutShifts = nextKeys.map((key, pid) =>
      key === this.layoutKeys[pid] ? [...this.pieceLayoutShift(pid)] as [number, number] : [0, 0],
    );
    this.layoutKeys = nextKeys;
    this.pieces = nextPieces;
    this.measuredEdge = null; // les indices de bord ne survivent pas au nouveau document
    // Keep the active column if it still holds a piece; else fall back to front.
    if (!this.pieceAt(this.activePiece)) this.activePiece = 0;
    this.emitActivePiece();
    if (
      this.surfacePlacementPieceId !== null &&
      this.pieceAt(this.surfacePlacementPieceId)?.placement?.role !== 'pocket'
    ) {
      this.surfacePlacementPieceId = null;
      this.surfacePlacementHover = null;
    }
    this.selectedPieces = new Set([...this.selectedPieces].filter((pid) => !!this.pieceAt(pid)));
    if (this.selectedPiece !== null && !this.selectedPieces.has(this.selectedPiece)) {
      this.selectedPiece = [...this.selectedPieces].at(-1) ?? null;
    }
    this.updateCanvasLabel();
    this.setPen(false);
    this.penPoints = [];
    this.penPointerInside = null;
    this.resetDraftTransient();
    this.staticDirty = true;
    this.render();
  }

  /** Replace the ACTIVE face after an edit (keeps the other face + which column). */
  private applyActive(next: DraftPiece): void {
    this.setActive(this.clonePiece(next));
    this.resetDraftTransient();
  }

  /** Show the avatar silhouette behind the atelier grid (or null to hide). */
  setBodySilhouette(
    sil: { minX: number; maxX: number; minY: number; maxY: number; rects: Array<[number, number, number, number]> } | null,
  ): void {
    this.bodySil = sil && sil.rects.length ? sil : null;
    this.staticDirty = true;
    this.render();
  }

  /** Resize the 2D panel canvas (small inset ↔ large CAD panel). */
  resize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.staticLayer.width = w;
    this.staticLayer.height = h;
    this.staticDirty = true;
    this.render();
  }

  /** Start drawing a NEW piece from a blank canvas (pen tool), on the front or
   * back column. Only the target face is reset — the other column is kept. */
  startPen(width: number, height: number, topY: number, gap: number, pieceId = 0): void {
    if (this.penMode) this.abortPen(); // un tracé en cours ? on le range d'abord (sans rien perdre)
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.zipperMode = false;
    this.zipperPickA = null;
    this.zipperHover = null;
    // A new free column changes the full layout bounds. Re-fit immediately so
    // the empty drawing column is visible instead of opening off-screen beyond
    // the previous two-column centre.
    this.viewZoom = 1;
    this.viewCenter = null;
    this.activePiece = pieceId;
    // Ensure the column slot exists (a new free piece extends the array; back is
    // slot 1). Fill any gap with nulls so indices stay aligned with pieceId.
    while (this.pieces.length <= pieceId) this.pieces.push(null);
    this.selectedPiece = null;
    this.selectedPieces.clear();
    this.updateCanvasLabel();
    // FILET DE SÉCURITÉ : la pièce existante est mise de côté pendant le tracé.
    // Un tracé abandonné (Terminer sans 3 points, changement d'outil) la
    // RESTAURE — un clic sur ✎ ne peut plus effacer un patron par accident.
    const existing = this.pieceAt(pieceId);
    this.penBackup = existing ? structuredClone(existing) : null;
    this.penBackupPid = pieceId;
    this.setActive({ outline: [], darts: [], seams: [], openEdges: [], width, height, topY, gap });
    this.resetDraftTransient();
    this.setPen(true);
    this.penPoints = [];
    this.penPointerInside = null;
    this.staticDirty = true; // nouvelle colonne + silhouette de référence à (re)poser
    this.render();
  }

  /** Abandonner le tracé en cours : restaure la pièce mise de côté (ou retire
   * la colonne vide d'une pièce toute neuve). Rien n'est perdu. */
  private abortPen(render = true): void {
    if (!this.penMode) return;
    this.setPen(false);
    this.penPoints = [];
    this.penPointerInside = null;
    if (this.penBackup) {
      this.applyActive(this.penBackup);
    } else if (
      this.penBackupPid !== null &&
      this.penBackupPid >= 2 &&
      this.penBackupPid === this.pieces.length - 1 &&
      (this.pieceAt(this.penBackupPid)?.outline.length ?? 0) === 0
    ) {
      this.pieces.pop(); // la colonne vide d'une pièce jamais dessinée disparaît
      if (this.activePiece === this.penBackupPid) {
        this.activePiece = 0;
        this.emitActivePiece();
      }
    }
    this.penBackup = null;
    this.penBackupPid = null;
    this.staticDirty = true; // la colonne abandonnée disparaît, la silhouette de tracé aussi
    if (render) this.render();
  }

  get penMirroring(): boolean {
    return this.penMirror;
  }

  togglePenMirror(): boolean {
    this.penMirror = !this.penMirror;
    this.render();
    return this.penMirror;
  }

  get drawing(): boolean {
    return this.penMode;
  }

  /** Basculer le mode COUDRE guidé (bouton 🪡). Rend l'état courant. */
  toggleSew(): boolean {
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.sewMode = !this.sewMode;
    if (this.sewMode) {
      this.zipperMode = false;
      this.zipperPickA = null;
      this.zipperHover = null;
      this.linkMode = false;
      this.linkPickA = null;
      this.linkHover = null;
      this.lengthMode = false;
      this.lengthHover = null;
      this.lengthDrag = null;
      this.lengthSnapEnabled = false;
      this.lengthSnap = null;
      this.draftPreview = null;
      this.cutMode = false;
      this.cutPick = null;
      this.gatherMode = false;
      this.serialMode = false;
      this.serialReceiver = null;
      this.serialPartners = [];
      this.clearFreeSew();
      this.selectedPiece = null;
      this.selectedPieces.clear();
    }
    this.seamPickA = null;
    document.body.style.cursor = '';
    this.render();
    return this.sewMode;
  }

  /** Éteindre la couture libre (mode + tracés en cours), sans callback. */
  private clearFreeSew(): void {
    this.freeSewMode = false;
    this.freeSewTrace = null;
    this.freeSewRunA = null;
  }

  /** Un seul outil actif à la fois — coupe les autres modes avant d'armer. */
  private disarmToolsForExclusive(): void {
    this.internalMode = false;
    this.internalTrace = null;
    this.internalHover = null;
    this.selectedInternal = null;
    this.internalPtDrag = null;
    this.dartMode = false;
    this.dartTop = null;
    this.dartBottom = null;
    this.dartHover = null;
    this.curvePointMode = false;
    this.curvePointDrag = null;
    this.notchMode = false;
    this.mergeMode = false;
    this.holeMode = false;
    this.precisionMode = false;
    this.fullnessMode = false;
    this.fullnessPick = null;
    this.fullnessHover = null;
    this.sewMode = false;
    this.seamPickA = null;
    this.clearFreeSew();
    this.zipperMode = false;
    this.zipperPickA = null;
    this.zipperHover = null;
    this.linkMode = false;
    this.linkPickA = null;
    this.linkHover = null;
    this.lengthMode = false;
    this.lengthHover = null;
    this.lengthDrag = null;
    this.lengthSnapEnabled = false;
    this.lengthSnap = null;
    this.draftPreview = null;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.setPen(false);
    this.penPoints = [];
    // Le mode sélection de pièce intercepte les clics gauches (déplacement) :
    // armer un outil doit donc TOUJOURS en sortir, sinon l'outil ne reçoit rien.
    this.selectedPiece = null;
    this.selectedPieces.clear();
  }

  toggleCut(): boolean {
    const next = !this.cutMode;
    if (next) this.disarmToolsForExclusive();
    this.cutMode = next;
    this.cutPick = null;
    this.cutHover = null;
    if (!next) this.gatherMode = false;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.cutMode;
  }

  get cutting(): boolean {
    return this.cutMode;
  }

  toggleInternalLine(): boolean {
    const next = !this.internalMode;
    if (next) this.disarmToolsForExclusive();
    this.internalMode = next;
    this.internalTrace = null;
    this.internalHover = null;
    this.selectedInternal = null;
    this.internalPtDrag = null;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.internalMode;
  }

  get internalDrawing(): boolean {
    return this.internalMode;
  }

  get selectedInternalLine(): number | null {
    return this.selectedInternal;
  }

  get activePieceId(): number {
    return this.activePiece;
  }

  deselectInternalLine(): void {
    this.selectedInternal = null;
    this.internalPtDrag = null;
    this.render();
  }

  toggleFisheyeDart(): boolean {
    const next = !this.dartMode;
    if (next) this.disarmToolsForExclusive();
    this.dartMode = next;
    this.dartTop = null;
    this.dartBottom = null;
    this.dartHover = null;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.dartMode;
  }

  get fisheyeDrawing(): boolean {
    return this.dartMode;
  }

  toggleFullness(): boolean {
    const next = !this.fullnessMode;
    if (next) this.disarmToolsForExclusive();
    this.fullnessMode = next;
    this.fullnessPick = null;
    this.fullnessHover = null;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.fullnessMode;
  }

  get fullnessing(): boolean {
    return this.fullnessMode;
  }

  get fullnessArmed(): boolean {
    return this.fullnessPick !== null;
  }

  toggleNotch(): boolean {
    const next = !this.notchMode;
    if (next) this.disarmToolsForExclusive();
    this.notchMode = next;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.notchMode;
  }

  get notching(): boolean {
    return this.notchMode;
  }

  toggleMerge(): boolean {
    const next = !this.mergeMode;
    if (next) this.disarmToolsForExclusive();
    this.mergeMode = next;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.mergeMode;
  }

  get merging(): boolean {
    return this.mergeMode;
  }

  toggleHole(): boolean {
    const next = !this.holeMode;
    if (next) this.disarmToolsForExclusive();
    this.holeMode = next;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.holeMode;
  }

  get holing(): boolean {
    return this.holeMode;
  }

  togglePrecision(): boolean {
    const next = !this.precisionMode;
    if (next) this.disarmToolsForExclusive();
    this.precisionMode = next;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.precisionMode;
  }

  get precisioning(): boolean {
    return this.precisionMode;
  }

  toggleCurvePoint(): boolean {
    const next = !this.curvePointMode;
    if (next) this.disarmToolsForExclusive();
    this.curvePointMode = next;
    this.curvePointDrag = null;
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.curvePointMode;
  }

  get curvePointing(): boolean {
    return this.curvePointMode;
  }

  get fisheyeArmed(): boolean {
    return this.dartTop !== null;
  }

  get internalTraceArmed(): boolean {
    return this.internalTrace !== null;
  }

  get cutPickArmed(): boolean {
    return this.cutPick !== null;
  }

  toggleGather(): boolean {
    const next = !this.gatherMode;
    if (next) this.disarmToolsForExclusive();
    this.gatherMode = next;
    if (next) {
      this.cutMode = false;
      this.cutPick = null;
    }
    document.body.style.cursor = next ? 'pointer' : '';
    this.render();
    return this.gatherMode;
  }

  get gathering(): boolean {
    return this.gatherMode;
  }

  /** Basculer la COUTURE LIBRE (bouton 🧵). Rend l'état courant. */
  toggleFreeSew(): boolean {
    const next = !this.freeSewMode;
    if (next) this.disarmToolsForExclusive(); // éteint aussi un ancien tracé libre
    this.freeSewMode = next;
    this.freeSewTrace = null;
    this.freeSewRunA = null;
    if (next) {
      this.cutMode = false;
      this.cutPick = null;
      this.cutHover = null;
      this.gatherMode = false;
    }
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.freeSewMode;
  }

  get freeSewing(): boolean {
    return this.freeSewMode;
  }

  /** Un tracé libre est-il en cours sous le curseur ? (pour les hints) */
  get freeSewTracing(): boolean {
    return this.freeSewTrace !== null;
  }

  /** Le 1er tracé libre est-il commité, en attente du second ? */
  get freeSewHasRunA(): boolean {
    return this.freeSewRunA !== null;
  }

  /** Basculer le MIROIR COUSU (bouton ⧎). Rend l'état courant. */
  toggleMirror(): boolean {
    const next = !this.mirrorMode;
    if (next) this.disarmToolsForExclusive();
    this.mirrorMode = next;
    if (next) {
      this.cutMode = false;
      this.cutPick = null;
      this.cutHover = null;
      this.gatherMode = false;
    }
    document.body.style.cursor = next ? 'crosshair' : '';
    this.render();
    return this.mirrorMode;
  }

  get mirroring(): boolean {
    return this.mirrorMode;
  }

  /**
   * Basculer le mode FERMETURE ÉCLAIR. Deux clics choisissent les deux rubans
   * et émettent une AssemblySeam `kind: 'zipper'`, fermée par défaut.
   */
  toggleZipper(): boolean {
    if (this.penMode) return this.zipperMode;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.zipperMode = !this.zipperMode;
    this.zipperPickA = null;
    this.zipperHover = null;
    if (this.zipperMode) {
      this.sewMode = false;
      this.seamPickA = null;
      this.linkMode = false;
      this.linkPickA = null;
      this.linkHover = null;
      this.lengthMode = false;
      this.lengthSnapEnabled = false;
      this.lengthHover = null;
      this.lengthDrag = null;
      this.lengthSnap = null;
      this.linkedPreview = null;
      this.draftPreview = null;
      this.clearFreeSew();
    }
    document.body.style.cursor = '';
    this.render();
    return this.zipperMode;
  }

  get zippering(): boolean {
    return this.zipperMode;
  }

  get zipperPick(): { pieceId: number; edge: number } | null {
    return this.zipperPickA;
  }

  /** Basculer le mode de modification directe de longueur des segments. */
  toggleLength(): boolean {
    if (this.penMode) return this.lengthMode;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.lengthMode = !this.lengthMode;
    if (this.lengthMode) {
      this.selectedPiece = null;
      this.selectedPieces.clear();
      this.updateCanvasLabel();
    }
    this.lengthHover = null;
    this.lengthDrag = null;
    this.curveLengthDrag = null;
    this.curveHover = null;
    this.lengthSnap = null;
    this.draftPreview = null;
    if (!this.lengthMode) this.lengthSnapEnabled = false;
    if (this.lengthMode) {
      this.zipperMode = false;
      this.zipperPickA = null;
      this.zipperHover = null;
      this.linkMode = false;
      this.linkPickA = null;
      this.linkHover = null;
      this.sewMode = false;
      this.seamPickA = null;
      this.clearFreeSew();
    }
    document.body.style.cursor = '';
    this.render();
    return this.lengthMode;
  }

  get lengthEditing(): boolean {
    return this.lengthMode;
  }

  /** Basculer le magnétisme ; l'activer ouvre aussi l'outil Longueur. */
  toggleLengthSnap(): boolean {
    if (this.penMode) return this.lengthSnapEnabled;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.lengthSnapEnabled = !this.lengthSnapEnabled;
    this.lengthSnap = null;
    if (this.lengthSnapEnabled) {
      this.zipperMode = false;
      this.zipperPickA = null;
      this.zipperHover = null;
      this.linkMode = false;
      this.linkPickA = null;
      this.linkHover = null;
      this.lengthMode = true;
      this.sewMode = false;
      this.seamPickA = null;
      this.clearFreeSew();
    }
    document.body.style.cursor = '';
    this.render();
    return this.lengthSnapEnabled;
  }

  get lengthSnapping(): boolean {
    return this.lengthSnapEnabled;
  }

  /** Basculer le mode « deux bords évoluent ensemble ». */
  toggleSegmentLink(): boolean {
    if (this.penMode) return this.linkMode;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    this.linkMode = !this.linkMode;
    this.linkPickA = null;
    this.linkHover = null;
    this.linkNotice = null;
    if (this.linkMode) {
      this.zipperMode = false;
      this.zipperPickA = null;
      this.zipperHover = null;
      this.lengthMode = false;
      this.lengthSnapEnabled = false;
      this.lengthHover = null;
      this.lengthDrag = null;
      this.lengthSnap = null;
      this.linkedPreview = null;
      this.sewMode = false;
      this.seamPickA = null;
      this.draftPreview = null;
      this.clearFreeSew();
    }
    document.body.style.cursor = '';
    this.render();
    return this.linkMode;
  }

  get linkingSegments(): boolean {
    return this.linkMode;
  }

  get segmentLinkPick(): { pieceId: number; edge: number } | null {
    return this.linkPickA;
  }

  private logicalCurveForEdge(pid: number, edge: number): LogicalCurveRun | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const n = piece.outline.length;
    const e = ((edge % n) + n) % n;
    return logicalCurveRuns(piece).find((run) => run.indices.slice(0, -1).includes(e)) ?? null;
  }

  private logicalEdgeRepresentative(pid: number, edge: number): number {
    return this.logicalCurveForEdge(pid, edge)?.from ?? edge;
  }

  private runForEdge(pid: number, edge: number): FaceRun {
    const n = this.pieceAt(pid)?.outline.length ?? 1;
    const e = ((edge % n) + n) % n;
    const curve = this.logicalCurveForEdge(pid, e);
    const from = curve?.from ?? e;
    const to = curve?.to ?? (e + 1) % n;
    return pid <= 1
      ? { face: pid === 1 ? 'back' : 'front', from, to }
      : { pieceId: pid, from, to };
  }

  private segmentLinkAt(pid: number, edge: number): { index: number; other: FaceRun } | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    for (let index = 0; index < this.segmentLinks.length; index++) {
      const link = this.segmentLinks[index]!;
      if (pieceIdOf(link.a) === pid && runCoversEdge(link.a, edge, piece.outline.length)) return { index, other: link.b };
      if (pieceIdOf(link.b) === pid && runCoversEdge(link.b, edge, piece.outline.length)) return { index, other: link.a };
    }
    return null;
  }

  /** Select two edges, or click an already linked edge once to dissociate it. */
  private pickEdgeForSegmentLink(pid: number, edge: number): void {
    edge = this.logicalEdgeRepresentative(pid, edge);
    const existing = this.segmentLinkAt(pid, edge);
    if (!this.linkPickA && existing) {
      this.segmentLinks = this.segmentLinks.filter((_, index) => index !== existing.index);
      this.linkNotice = 'Mariage supprimé';
      this.linkMode = false;
      this.render();
      this.onSegmentLinksChange(
        this.segmentLinks.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } })),
      );
      return;
    }
    if (!this.linkPickA) {
      this.linkPickA = { pieceId: pid, edge };
      this.linkNotice = null;
      this.render();
      return;
    }
    const first = this.linkPickA;
    if (first.pieceId === pid && first.edge === edge) {
      this.linkPickA = null;
      this.linkNotice = 'Sélection annulée';
      this.render();
      return;
    }
    if (first.pieceId === pid) {
      const n = this.pieceAt(pid)?.outline.length ?? 0;
      const adjacent =
        n > 0 &&
        (edge === (first.edge + 1) % n ||
          first.edge === (edge + 1) % n);
      if (adjacent) {
        this.linkPickA = null;
        this.linkNotice = 'Choisissez deux bords non adjacents';
        this.render();
        return;
      }
    }
    // One edge belongs to at most one marriage. Selecting it again remarries it
    // cleanly instead of creating competing constraints.
    const touches = (link: AssemblySeam, q: number, e: number): boolean => {
      const piece = this.pieceAt(q);
      if (!piece) return false;
      return (
        (pieceIdOf(link.a) === q && runCoversEdge(link.a, e, piece.outline.length)) ||
        (pieceIdOf(link.b) === q && runCoversEdge(link.b, e, piece.outline.length))
      );
    };
    this.segmentLinks = this.segmentLinks.filter(
      (link) => !touches(link, first.pieceId, first.edge) && !touches(link, pid, edge),
    );
    this.segmentLinks.push({
      a: this.runForEdge(first.pieceId, first.edge),
      b: this.runForEdge(pid, edge),
    });
    this.linkPickA = null;
    this.linkMode = false;
    this.linkNotice = 'Segments mariés';
    this.render();
    this.onSegmentLinksChange(
      this.segmentLinks.map((s) => ({ ...s, a: { ...s.a }, b: { ...s.b } })),
    );
  }

  /** Sélection venue de la 3D : la colonne active suit la pièce saisie sur
   * l'avatar (le pied de plan affiche son nom et sa taille). */
  selectPiece(pid: number): void {
    if (pid === this.activePiece) return;
    this.activePiece = Math.max(0, Math.min(this.nCols - 1, pid));
    this.emitActivePiece();
    this.render();
  }

  get activeDraftPieceId(): number {
    return this.activePiece;
  }

  get selectedDraftPieceIds(): number[] {
    return [...this.selectedPieces];
  }

  /** Arm the exact surface-placement gesture for a pocket/appliqué. */
  startSurfacePlacement(pieceId: number, side: 'over' | 'under' = 'over'): boolean {
    const piece = this.pieceAt(pieceId);
    if (pieceId < 2 || piece?.placement?.role !== 'pocket') return false;
    this.surfacePlacementPieceId = pieceId;
    this.surfacePlacementSide = side;
    this.surfacePlacementHover = null;
    this.activePiece = pieceId;
    this.selectedPiece = null;
    this.selectedPieces.clear();
    this.sewMode = false;
    this.seamPickA = null;
    this.zipperMode = false;
    this.zipperPickA = null;
    this.zipperHover = null;
    this.lengthMode = false;
    this.linkMode = false;
    this.resetDraftTransient();
    this.updateCanvasLabel();
    document.body.style.cursor = 'crosshair';
    this.render();
    return true;
  }

  get placingSurfacePiece(): boolean {
    return this.surfacePlacementPieceId !== null;
  }

  private commitSurfacePlacement(supportPieceId: number, anchor: UV): void {
    const pieceId = this.surfacePlacementPieceId;
    const piece = pieceId === null ? null : this.pieceAt(pieceId);
    const support = this.pieceAt(supportPieceId);
    if (
      pieceId === null ||
      !piece ||
      !support ||
      supportPieceId >= pieceId ||
      support.patternOnly ||
      support.placement?.role === 'pocket'
    ) {
      return;
    }
    const next = this.clonePiece(piece)!;
    next.placement = {
      ...next.placement!,
      role: 'pocket',
      autoAlign: true,
      surface: {
        supportPieceId,
        anchor: [anchor[0], anchor[1]],
        stitchedEdges: defaultSurfaceStitches(next),
        ...(this.surfacePlacementSide === 'under' ? { side: 'under' as const } : {}),
      },
    };
    this.pieces[pieceId] = next;
    this.activePiece = pieceId;
    this.surfacePlacementPieceId = null;
    this.surfacePlacementHover = null;
    document.body.style.cursor = '';
    this.render();
    this.onDraftChange(next, pieceId);
  }

  private toggleSurfaceStitch(pieceId: number, edge: number, stitched: boolean): void {
    const piece = this.pieceAt(pieceId);
    const surface = piece?.placement?.surface;
    if (!piece || !surface) return;
    const next = this.clonePiece(piece)!;
    const nextSurface = next.placement!.surface!;
    const set = new Set(nextSurface.stitchedEdges);
    if (stitched) set.delete(edge);
    else set.add(edge);
    nextSurface.stitchedEdges = [...set].sort((a, b) => a - b);
    this.pieces[pieceId] = next;
    this.activePiece = pieceId;
    this.seamPickA = null;
    this.sewMode = false;
    this.render();
    this.onDraftChange(next, pieceId);
  }

  /** Un choix de bord pour la couture — la MÊME machine à états que le clic 2D
   * (1er bord retenu, re-clic = annuler, 2e bord = couture), utilisable depuis
   * la 3D : cliquer deux bords sur les pièces autour de l'avatar les coud. */
  pickEdgeForSeam(pid: number, edge: number): void {
    edge = this.logicalEdgeRepresentative(pid, edge);
    if (this.seamPickA === null) {
      this.seamPickA = { pieceId: pid, edge }; // first edge picked
      this.render();
    } else if (this.seamPickA.pieceId === pid && this.seamPickA.edge === edge) {
      this.seamPickA = null; // clicked the same edge → cancel the pick
      this.render();
    } else {
      const a = this.seamPickA;
      const seam: AssemblySeam = { a: this.runForEdge(a.pieceId, a.edge), b: this.runForEdge(pid, edge) };
      this.seamPickA = null;
      this.sewMode = false; // couture faite : le mode guidé se referme
      this.render();
      this.onAssemblySeam(seam);
    }
  }

  /** Arme/désarme la couture en série. Renvoie l'état. */
  toggleSerialSew(): boolean {
    this.serialMode = !this.serialMode;
    this.serialReceiver = null;
    this.serialPartners = [];
    if (this.serialMode) {
      this.sewMode = false;
      this.zipperMode = false;
      this.cutMode = false;
      this.selectedPiece = null;
      this.selectedPieces.clear();
    }
    this.render();
    return this.serialMode;
  }

  get serialSewing(): boolean {
    return this.serialMode;
  }

  /** Bords sélectionnés en série (pour le surlignage 3D et l'aide). */
  get serialPick(): { receiver: { pieceId: number; edge: number } | null; partners: { pieceId: number; edge: number }[] } {
    return { receiver: this.serialReceiver, partners: this.serialPartners };
  }

  /** Un clic edge en mode série : 1er = receveur, suivants = partenaires
   * (re-clic d'un partenaire le retire ; re-clic du receveur ANNULE tout). */
  pickEdgeForSerial(pid: number, edge: number): void {
    edge = this.logicalEdgeRepresentative(pid, edge);
    if (this.serialReceiver === null) {
      this.serialReceiver = { pieceId: pid, edge };
      this.render();
      return;
    }
    if (this.serialReceiver.pieceId === pid && this.serialReceiver.edge === edge) {
      // Re-clic du receveur = tout annuler.
      this.serialReceiver = null;
      this.serialPartners = [];
      this.render();
      return;
    }
    const at = this.serialPartners.findIndex((p) => p.pieceId === pid && p.edge === edge);
    if (at >= 0) this.serialPartners.splice(at, 1); // re-clic partenaire → retire
    else this.serialPartners.push({ pieceId: pid, edge });
    this.render();
  }

  /** Valide la couture en série (Entrée ou bouton ✓). Émet les runs résolus. */
  commitSerial(): boolean {
    if (!this.serialMode || !this.serialReceiver || this.serialPartners.length === 0) return false;
    const receiver = this.runForEdge(this.serialReceiver.pieceId, this.serialReceiver.edge);
    const partners = this.serialPartners.map((p) => this.runForEdge(p.pieceId, p.edge));
    this.serialMode = false;
    this.serialReceiver = null;
    this.serialPartners = [];
    this.render();
    this.onSerialSeam(receiver, partners);
    return true;
  }

  /** Same two-click state machine as sewing, emitting a closed zipper link. */
  pickEdgeForZipper(pid: number, edge: number): void {
    edge = this.logicalEdgeRepresentative(pid, edge);
    if (this.zipperPickA === null) {
      this.zipperPickA = { pieceId: pid, edge };
      this.render();
    } else if (
      this.zipperPickA.pieceId === pid &&
      this.zipperPickA.edge === edge
    ) {
      this.zipperPickA = null;
      this.render();
    } else {
      const a = this.zipperPickA;
      const zipper = makeZipperSeam(
        this.runForEdge(a.pieceId, a.edge),
        this.runForEdge(pid, edge),
      );
      this.zipperPickA = null;
      this.zipperHover = null;
      this.zipperMode = false;
      this.render();
      this.onAssemblySeam(zipper);
    }
  }

  get sewing(): boolean {
    return this.sewMode;
  }

  /** Le 1er bord retenu par la machine à coudre (pour le surlignage 3D). */
  get seamPick(): { pieceId: number; edge: number } | null {
    return this.seamPickA;
  }

  /** Close the drawn outline into a piece (≥3 points), seeding a top opening.
   * Sans 3 points, le tracé est ABANDONNÉ et la pièce d'origine restaurée. */
  finishPen(): void {
    if (!this.penMode) return;
    const minPoints = this.penMirror ? 2 : 3;
    if (this.penPoints.length < minPoints || !this.draftPiece) {
      this.abortPen();
      return;
    }
    this.penBackup = null; // tracé réussi : l'ancienne pièce est volontairement remplacée
    this.penBackupPid = null;
    const outline = this.penMirror
      ? mirrorClosedOutline(this.penPoints)
      : this.penPoints.map((p) => [p[0], p[1]] as UV);
    if (outline.length < 3) {
      this.abortPen();
      return;
    }
    // Seed the topmost edge as an opening so a body can enter (a fully-sewn
    // piece would inflate like a sealed pillow).
    let topEdge = 0;
    let topV = Infinity;
    for (let k = 0; k < outline.length; k++) {
      const v = (outline[k]![1] + outline[(k + 1) % outline.length]![1]) / 2;
      if (v < topV) {
        topV = v;
        topEdge = k;
      }
    }
    const next = { ...this.draftPiece, outline, openEdges: [{ from: topEdge, to: (topEdge + 1) % outline.length }] };
    this.setPen(false);
    this.penPoints = [];
    this.penPointerInside = null;
    this.applyActive(next);
    this.staticDirty = true; // la silhouette de tracé s'éteint avec la plume
    this.render();
    this.onDraftChange(next, this.activePiece);
  }

  /** True when a FREE piece (a drawn column, pieceId ≥ 2) is the active one —
   * i.e. deleting is meaningful. The base front/back can't be removed. */
  get canDeleteActive(): boolean {
    return this.activePiece >= 2 && !!this.pieceAt(this.activePiece);
  }

  /** Remove the active FREE piece (its column + the seams touching it). No-op on
   * the base front/back. The rebuild re-lays the remaining columns. */
  deleteActiveFreePiece(): void {
    if (!this.canDeleteActive) return;
    const pid = this.activePiece;
    this.selectedPiece = null;
    this.selectedPieces.clear();
    this.updateCanvasLabel();
    this.activePiece = 0; // fall back to the front before the columns re-index
    this.setPen(false);
    this.penPoints = [];
    this.penPointerInside = null;
    this.resetDraftTransient();
    this.onDeletePiece(pid);
  }

  /** Screen position of an outline vertex: UV → world layout (+ the face's column
   * offset) → screen. Defaults to the active face; pass (piece, offset) to draw
   * the other column. */
  private vertexScreen(
    uv: UV,
    piece: DraftPiece | null = this.draftPiece,
    offset: number = this.activeOffset(),
    yOffset: number = this.activeYOffset(),
  ): [number, number] | null {
    if (!this.tf || !piece) return null;
    const x = (uv[0] - 0.5) * piece.width + offset;
    const y = piece.topY - uv[1] * piece.height + yOffset;
    return this.layoutToScreen(x, y);
  }

  /**
   * A screen point → the ACTIVE face's outline UV. Ordinary outline gestures
   * stay inside the piece box; ↔ Longueur passes `clamp=false` so one continuous
   * drag can grow beyond the old frame before it is expanded on release.
   */
  private screenToUV(px: number, py: number, clamp = true): UV {
    const [x, y] = this.screenToLayout(px, py);
    const p = this.draftPiece!;
    const uv: UV = [
      (x - this.activeOffset()) / p.width + 0.5,
      (p.topY + this.activeYOffset() - y) / p.height,
    ];
    return clamp ? [Math.min(1, Math.max(0, uv[0])), Math.min(1, Math.max(0, uv[1]))] : uv;
  }

  private screenToPieceUV(pid: number, px: number, py: number, clamp = true): UV | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const [x, y] = this.screenToLayout(px, py);
    const uv: UV = [
      (x - this.pieceOffset(pid)) / piece.width + 0.5,
      (piece.topY + this.pieceYOffset(pid) - y) / piece.height,
    ];
    return clamp
      ? [Math.min(1, Math.max(0, uv[0])), Math.min(1, Math.max(0, uv[1]))]
      : uv;
  }

  /** Route a gesture to the column it fell in. Columns have UNEQUAL widths
   * (each spans its own piece), so the split points are the mid-gutter
   * boundaries captured at layout time (colEdges). */
  private pickColumn(px: number): void {
    if (!this.tf || !this.offsets.length) {
      this.activePiece = 0;
      return;
    }
    const [lx] = this.screenToLayout(px, 0);
    let c = 0;
    while (c < this.colEdges.length && lx > this.colEdges[c]!) c++;
    this.activePiece = Math.min(this.nCols - 1, c);
  }

  /** Screen midpoint of an outline edge on a piece (with its column offset). */
  private edgeMidScreen(pid: number, edge: number): [number, number] | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const o = piece.outline;
    const off = this.pieceOffset(pid);
    const yOff = this.pieceYOffset(pid);
    const a = this.vertexScreen(o[edge % o.length]!, piece, off, yOff);
    const b = this.vertexScreen(o[(edge + 1) % o.length]!, piece, off, yOff);
    return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
  }

  private surfaceScreenPoints(
    pieceId: number,
    surface = this.pieceAt(pieceId)?.placement?.surface,
  ): [number, number][] | null {
    const overlay = this.pieceAt(pieceId);
    const support = surface ? this.pieceAt(surface.supportPieceId) : null;
    if (!overlay || !support || !surface) return null;
    const points = overlay.outline
      .map((uv) =>
        this.vertexScreen(
          surfaceAttachmentUV(overlay, support, surface, uv),
          support,
          this.pieceOffset(surface.supportPieceId),
          this.pieceYOffset(surface.supportPieceId),
        ),
      )
      .filter((point): point is [number, number] => !!point);
    return points.length === overlay.outline.length ? points : null;
  }

  private pickSurfaceEdge(
    px: number,
    py: number,
  ): { pieceId: number; edge: number; stitched: boolean } | null {
    let best: { pieceId: number; edge: number; stitched: boolean; distance: number } | null = null;
    for (let pieceId = 2; pieceId < this.pieces.length; pieceId++) {
      const piece = this.pieceAt(pieceId);
      const surface = piece?.placement?.surface;
      const points = surface ? this.surfaceScreenPoints(pieceId, surface) : null;
      if (!piece || !surface || !points) continue;
      const stitched = new Set(surface.stitchedEdges);
      for (let edge = 0; edge < points.length; edge++) {
        const a = points[edge]!;
        const b = points[(edge + 1) % points.length]!;
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const len2 = abx * abx + aby * aby || 1e-6;
        const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
        const distance = Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
        if (distance <= EDGE_HIT * 1.4 && (!best || distance < best.distance)) {
          best = { pieceId, edge, stitched: stitched.has(edge), distance };
        }
      }
    }
    return best ? { pieceId: best.pieceId, edge: best.edge, stitched: best.stitched } : null;
  }

  /** Index of the assembly seam whose link (between the two edge midpoints) is
   * clicked, or null — used to delete a seam. */
  private pickSeam(px: number, py: number): number | null {
    let best: number | null = null;
    let bestD = (HIT_RADIUS * 1.4) ** 2;
    for (let i = 0; i < this.assembly.length; i++) {
      const s = this.assembly[i]!;
      const ma = this.edgeMidScreen(pieceIdOf(s.a), s.a.from);
      const mb = this.edgeMidScreen(pieceIdOf(s.b), s.b.from);
      if (!ma || !mb) continue;
      const dx = mb[0] - ma[0];
      const dy = mb[1] - ma[1];
      const lenSq = dx * dx + dy * dy;
      let d2: number;
      if (lenSq < 1) {
        d2 = (px - ma[0]) ** 2 + (py - ma[1]) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ma[0]) * dx + (py - ma[1]) * dy) / lenSq));
        const cx = ma[0] + t * dx;
        const cy = ma[1] + t * dy;
        d2 = (px - cx) ** 2 + (py - cy) ** 2;
      }
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }

  /** Real length (cm) of an outline edge on a piece — for the walk/true-up
   * feedback (matching two edges' lengths, showing a seam's gather ratio). */
  private edgeLenCm(pid: number, edge: number, outline?: readonly UV[]): number {
    const piece = this.pieceAt(pid);
    if (!piece) return 0;
    return outlineEdgeLengthCm(piece, outline ?? piece.outline, edge);
  }

  private pickVertex(px: number, py: number): number | null {
    const out = this.draftPreview ?? this.draftPiece?.outline;
    const piece = this.draftPiece;
    if (!out || !piece) return null;
    const hidden = logicalCurveInteriorIndices(logicalCurveRuns(piece, out));
    // Le plus PROCHE dans le rayon — pas le premier trouvé : sur un contour
    // dense, « premier trouvé » pouvait saisir le voisin du point visé, et un
    // rayon élargi (TOILE-20) aggraverait ce biais sans ce tri.
    let best: number | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (let i = 0; i < out.length; i++) {
      if (hidden.has(i)) continue;
      const s = this.vertexScreen(out[i]!);
      if (!s) continue;
      const d = (px - s[0]) ** 2 + (py - s[1]) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private pickCurveHandle(px: number, py: number): number | null {
    const piece = this.draftPiece;
    const out = this.draftPreview ?? piece?.outline;
    if (!piece || !out || this.penMode) return null;
    const runs = logicalCurveRuns(piece, out);
    for (let i = 0; i < runs.length; i++) {
      const handle = logicalCurveHandle(runs[i]!);
      const s = this.vertexScreen(out[handle.index]!);
      if (s && (px - s[0]) ** 2 + (py - s[1]) ** 2 <= (HIT_RADIUS * 1.15) ** 2) return i;
    }
    return null;
  }

  private curveIndexForEdge(edge: number): number | null {
    const piece = this.draftPiece;
    const out = this.draftPreview ?? piece?.outline;
    if (!piece || !out) return null;
    const index = logicalCurveRuns(piece, out).findIndex((run) => run.indices.slice(0, -1).includes(edge));
    return index < 0 ? null : index;
  }

  private beginCurveDrag(
    e: PointerEvent,
    p: readonly [number, number],
    curveIndex: number,
  ): void {
    const piece = this.draftPiece;
    if (!piece) return;
    const orig = piece.outline.map((q) => [q[0], q[1]] as UV);
    const run = logicalCurveRuns(piece, orig)[curveIndex];
    if (!run) return;
    const handleIndex = logicalCurveHandle(run).index;
    const s = this.vertexScreen(orig[handleIndex]!);
    if (!s) return;
    this.draftPreview = orig.map((q) => [q[0], q[1]] as UV);
    this.curveDrag = {
      run,
      pointerId: e.pointerId,
      grabDX: p[0] - s[0],
      grabDY: p[1] - s[1],
      orig,
      handleIndex,
    };
    this.curveHover = curveIndex;
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  }

  private beginCurveLengthDrag(
    e: PointerEvent,
    p: readonly [number, number],
    curveIndex: number,
    grabPoint?: readonly [number, number],
  ): void {
    const piece = this.draftPiece;
    if (!piece) return;
    const orig = piece.outline.map((q) => [q[0], q[1]] as UV);
    const run = logicalCurveRuns(piece, orig)[curveIndex];
    if (!run) return;
    const grab = this.screenToUV(grabPoint?.[0] ?? p[0], grabPoint?.[1] ?? p[1], false);
    const edit = beginLogicalCurveLengthEdit(piece, orig, run, grab);
    if (!edit) return;
    const rawPointer = this.screenToUV(p[0], p[1], false);
    const movingScreen = this.vertexScreen(orig[edit.moving]!);
    if (!movingScreen) return;
    this.draftPreview = orig.map((q) => [q[0], q[1]] as UV);
    this.curveLengthDrag = {
      ...edit,
      pointerId: e.pointerId,
      orig,
      rawPointerScreen: [p[0], p[1]],
      pointerToMovingScreen: [
        movingScreen[0] - p[0],
        movingScreen[1] - p[1],
      ],
      intent: axisDragIntent(piece, edit.grab, rawPointer, edit.unit),
    };
    this.curveHover = curveIndex;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  }

  /** Piece below a screen point, using the visible cut outline rather than the column. */
  private pickPiece(px: number, py: number): number | null {
    const order = [
      ...(this.activePiece >= 0 ? [this.activePiece] : []),
      ...Array.from({ length: this.nCols }, (_v, pid) => pid).filter((pid) => pid !== this.activePiece).reverse(),
    ];
    for (const pid of order) {
      const piece = this.pieceAt(pid);
      if (!piece) continue;
      const pts = piece.outline
        .map((uv) => this.vertexScreen(uv, piece, this.pieceOffset(pid), this.pieceYOffset(pid)))
        .filter((p): p is [number, number] => p !== null);
      if (pts.length === piece.outline.length && pointInPatternPolygon([px, py], pts)) return pid;
    }
    return null;
  }

  /** Route edge/vertex gestures to a visually moved piece, even outside its original column. */
  private pickPieceNearOutline(px: number, py: number, maxDist = EDGE_HIT * 1.5): number | null {
    let bestPiece: number | null = null;
    let bestDist = maxDist;
    const order = [
      ...(this.activePiece >= 0 ? [this.activePiece] : []),
      ...Array.from({ length: this.nCols }, (_v, pid) => pid).filter((pid) => pid !== this.activePiece).reverse(),
    ];
    for (const pid of order) {
      const piece = this.pieceAt(pid);
      if (!piece) continue;
      const pts = piece.outline
        .map((uv) => this.vertexScreen(uv, piece, this.pieceOffset(pid), this.pieceYOffset(pid)))
        .filter((point): point is [number, number] => point !== null);
      if (pts.length !== piece.outline.length) continue;
      for (let edge = 0; edge < pts.length; edge++) {
        const a = pts[edge]!;
        const b = pts[(edge + 1) % pts.length]!;
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const len2 = abx * abx + aby * aby || 1e-6;
        const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
        const dist = Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
        if (dist < bestDist) {
          bestDist = dist;
          bestPiece = pid;
        }
      }
    }
    return bestPiece;
  }

  private routePieceGesture(px: number, py: number): void {
    const pid = this.pickPiece(px, py) ?? this.pickPieceNearOutline(px, py);
    if (pid !== null) this.activePiece = pid;
    else this.pickColumn(px);
    this.emitActivePiece();
  }

  private pieceResizeHandles(
    pid: number = this.selectedPiece ?? -1,
  ): Array<{ corner: PieceResizeCorner; screen: [number, number]; world: [number, number] }> {
    const piece = this.pieceAt(pid);
    if (!this.tf || !piece) return [];
    const bounds = draftPieceBounds(piece);
    const offset = this.pieceOffset(pid);
    const yOffset = this.pieceYOffset(pid);
    return (['nw', 'ne', 'se', 'sw'] as const).map((corner) => {
      const world = pieceResizeCornerPoint(bounds, corner);
      return { corner, world, screen: this.layoutToScreen(world[0] + offset, world[1] + yOffset) };
    });
  }

  private pickPieceResizeHandle(px: number, py: number): PieceResizeTarget | null {
    if (this.selectedPiece === null || this.penMode) return null;
    const order = [
      this.selectedPiece,
      ...[...this.selectedPieces].filter((pid) => pid !== this.selectedPiece),
    ];
    for (const pieceId of order) {
      for (const h of this.pieceResizeHandles(pieceId)) {
        if ((px - h.screen[0]) ** 2 + (py - h.screen[1]) ** 2 <= (HIT_RADIUS * 1.25) ** 2) {
          return { pieceId, corner: h.corner };
        }
      }
    }
    return null;
  }

  private beginPieceResize(
    e: PointerEvent,
    p: readonly [number, number],
    target: PieceResizeTarget,
  ): void {
    const { pieceId: pid, corner } = target;
    const piece = this.pieceAt(pid);
    if (!piece) return;
    const bounds = draftPieceBounds(piece);
    const handle = pieceResizeCornerPoint(bounds, corner);
    const anchor = pieceResizeCornerPoint(bounds, oppositePieceResizeCorner(corner));
    const [lx, ly] = this.screenToLayout(p[0], p[1]);
    const pointer: [number, number] = [lx - this.pieceOffset(pid), ly - this.pieceYOffset(pid)];
    this.activePiece = pid;
    this.selectedPiece = pid;
    this.selectedPieces.add(pid);
    const members = [...this.selectedPieces]
      .map((pieceId) => {
        const member = this.pieceAt(pieceId);
        if (!member) return null;
        const original = this.clonePiece(member)!;
        return {
          pieceId,
          original,
          anchor: pieceResizeCornerPoint(
            draftPieceBounds(original),
            oppositePieceResizeCorner(corner),
          ),
        };
      })
      .filter((member): member is { pieceId: number; original: DraftPiece; anchor: [number, number] } => !!member);
    this.pieceResizeDrag = {
      pieceId: pid,
      corner,
      pointerId: e.pointerId,
      members,
      anchor,
      handle,
      grabDX: pointer[0] - handle[0],
      grabDY: pointer[1] - handle[1],
      scale: 1,
    };
    this.pieceResizeHover = target;
    this.updateCanvasLabel();
    document.body.style.cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  }

  private beginPieceMove(e: PointerEvent, p: readonly [number, number]): void {
    const hit = this.pickPiece(p[0], p[1]);
    const pid = hit !== null && this.selectedPieces.has(hit) ? hit : this.selectedPiece;
    if (pid === null || !this.pieceAt(pid)) return;
    this.activePiece = pid;
    this.selectedPiece = pid;
    const members = [...this.selectedPieces]
      .filter((pieceId) => !!this.pieceAt(pieceId))
      .map((pieceId) => ({ pieceId, startShift: [...this.pieceLayoutShift(pieceId)] as [number, number] }));
    this.pieceMoveDrag = {
      pieceId: pid,
      pointerId: e.pointerId,
      startLayout: this.screenToLayout(p[0], p[1]),
      members,
      delta: [0, 0],
    };
    this.pieceResizeHover = null;
    document.body.style.cursor = 'move';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  }

  /** Pointer position in canvas pixels, or null when outside the inset. */
  private canvasPoint(e: MouseEvent): [number, number] | null {
    if (!this.interactionEnabled) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return x >= 0 && y >= 0 && x <= r.width && y <= r.height ? [x, y] : null;
  }

  /** Nearest outline edge to a screen point + the closest point on it. */
  private nearestEdge(
    px: number,
    py: number,
  ): { edge: number; sx: number; sy: number; dist: number; t: number } | null {
    const out = this.draftPreview ?? this.draftPiece?.outline;
    if (!out || !this.tf) return null;
    let best = { edge: -1, sx: 0, sy: 0, dist: Infinity, t: 0 };
    for (let k = 0; k < out.length; k++) {
      const a = this.vertexScreen(out[k]!);
      const b = this.vertexScreen(out[(k + 1) % out.length]!);
      if (!a || !b) continue;
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1e-6;
      // La transformation vue est affine : le t écran est aussi le t UV.
      const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
      const sx = a[0] + t * abx;
      const sy = a[1] + t * aby;
      const d = Math.hypot(px - sx, py - sy);
      if (d < best.dist) best = { edge: k, sx, sy, dist: d, t };
    }
    return best.edge >= 0 ? best : null;
  }

  /** Sommes préfixes MÉTRIQUES (m) du contour : le sommet k est à l'abscisse
   * prefix[k], le périmètre est prefix[N]. Recalculé à la demande (N ≤ 128). */
  private outlinePrefix(piece: DraftPiece): number[] {
    const N = piece.outline.length;
    const prefix = [0];
    for (let k = 0; k < N; k++) {
      const a = piece.outline[k]!;
      const b = piece.outline[(k + 1) % N]!;
      prefix.push(prefix[k]! + Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height));
    }
    return prefix;
  }

  /** Abscisse curviligne (m) du point (edge, t) du contour. */
  private outlineS(prefix: number[], edge: number, t: number): number {
    return prefix[edge]! + t * (prefix[edge + 1]! - prefix[edge]!);
  }

  /** Point écran à l'abscisse s (enroulée modulo périmètre) du contour. */
  private outlinePointAtS(
    pieceId: number,
    prefix: number[],
    s: number,
  ): [number, number] | null {
    const piece = this.pieceAt(pieceId);
    if (!piece) return null;
    const N = piece.outline.length;
    const L = prefix[N]! || 1e-9;
    const sw = ((s % L) + L) % L;
    let e = 0;
    while (e < N - 1 && prefix[e + 1]! < sw - 1e-12) e++;
    const edgeLen = prefix[e + 1]! - prefix[e]! || 1e-9;
    const t = Math.min(1, Math.max(0, (sw - prefix[e]!) / edgeLen));
    const a = piece.outline[e]!;
    const b = piece.outline[(e + 1) % N]!;
    const uv: UV = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return this.vertexScreen(uv, piece, this.pieceOffset(pieceId), this.pieceYOffset(pieceId));
  }

  /** Polyligne écran de l'arc [startS..endS] (abscisses DÉROULÉES, dans un ordre
   * quelconque), sommets traversés compris — l'aperçu du tracé libre. */
  private freeSewArcScreen(pieceId: number, startS: number, endS: number): [number, number][] {
    const piece = this.pieceAt(pieceId);
    if (!piece) return [];
    const prefix = this.outlinePrefix(piece);
    const N = piece.outline.length;
    const L = prefix[N]!;
    if (L < 1e-9) return [];
    const lo = Math.min(startS, endS);
    const hi = Math.max(startS, endS);
    const pts: [number, number][] = [];
    const push = (s: number): void => {
      const sp = this.outlinePointAtS(pieceId, prefix, s);
      if (sp) pts.push(sp);
    };
    push(lo);
    // Chaque sommet i vit aux abscisses prefix[i] + m·L : émettre ceux dans (lo, hi).
    for (let m = Math.floor(lo / L); m <= Math.floor(hi / L) + 1; m++) {
      for (let i = 0; i < N; i++) {
        const sv = prefix[i]! + m * L;
        if (sv > lo + 1e-9 && sv < hi - 1e-9) push(sv);
      }
    }
    push(hi);
    return pts;
  }

  /** Suivre le curseur le long du contour pendant un tracé libre : l'abscisse
   * du point le plus proche est DÉROULÉE (représentation la plus proche de la
   * position précédente) — les coins passent, dans les deux sens ; loin du
   * contour, le tracé gèle. */
  private updateFreeSewTrace(px: number, py: number): boolean {
    const st = this.freeSewTrace;
    if (!st || st.pieceId !== this.activePiece) return false;
    const piece = this.pieceAt(st.pieceId);
    if (!piece) return false;
    const ne = this.nearestEdge(px, py);
    if (!ne || ne.dist > EDGE_HIT * 3) return false;
    const prefix = this.outlinePrefix(piece);
    const L = prefix[piece.outline.length]!;
    if (L < 1e-9) return false;
    const sRaw = this.outlineS(prefix, ne.edge, ne.t);
    const k = Math.round((st.curS - sRaw) / L);
    let sNew = sRaw + k * L;
    // Jamais plus d'un tour de contour (le tracé ne se recouvre pas lui-même).
    sNew = Math.min(st.startS + L * 0.999, Math.max(st.startS - L * 0.999, sNew));
    if (Math.abs(sNew - st.curS) < 1e-9) return false;
    st.curS = sNew;
    return true;
  }

  /** Image décodée d'un graphique (cache par data URL) ; null tant qu'elle charge. */
  private graphicImage(dataUrl: string): HTMLImageElement | null {
    let img = this.graphicImages.get(dataUrl);
    if (!img) {
      img = new Image();
      img.onload = () => this.render();
      img.src = dataUrl;
      this.graphicImages.set(dataUrl, img);
      if (this.graphicImages.size > 12) {
        const oldest = this.graphicImages.keys().next().value;
        if (oldest && oldest !== dataUrl) this.graphicImages.delete(oldest);
      }
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Cadre ÉCRAN du graphique d'une pièce : centre, tailles px, rotation.
   * (u,v) patron et (x,y) écran partagent la même orientation — la rotation
   * passe telle quelle. */
  private graphicScreenFrame(
    pid: number,
    graphic: PieceGraphic,
  ): { cx: number; cy: number; w: number; h: number; rot: number } | null {
    const piece = this.pieceAt(pid);
    if (!piece || !this.tf) return null;
    const c = this.vertexScreen(graphic.anchor, piece, this.pieceOffset(pid), this.pieceYOffset(pid));
    if (!c) return null;
    const scale = this.tf.scale;
    return {
      cx: c[0],
      cy: c[1],
      w: Math.max(4, graphic.widthM * scale),
      h: Math.max(4, graphic.widthM * graphic.aspect * scale),
      rot: graphic.rotationRad,
    };
  }

  /** Qu'attrape ce point : l'image, sa poignée de taille, celle de rotation ? */
  private graphicHit(
    pid: number,
    graphic: PieceGraphic,
    px: number,
    py: number,
  ): 'inside' | 'scale' | 'rotate' | null {
    const f = this.graphicScreenFrame(pid, graphic);
    if (!f) return null;
    const dx = px - f.cx;
    const dy = py - f.cy;
    const c = Math.cos(-f.rot);
    const sn = Math.sin(-f.rot);
    const lx = dx * c - dy * sn;
    const ly = dx * sn + dy * c;
    const hw = f.w / 2;
    const hh = f.h / 2;
    if (Math.hypot(lx - hw, ly - hh) <= HIT_RADIUS) return 'scale';
    if (Math.hypot(lx, ly + hh + 20) <= HIT_RADIUS) return 'rotate';
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return 'inside';
    return null;
  }

  private beginGraphicDrag(
    e: PointerEvent,
    p: [number, number],
    mode: 'inside' | 'scale' | 'rotate',
    graphic: PieceGraphic,
  ): void {
    const pointerUV = this.screenToUV(p[0], p[1], false);
    this.graphicDrag = {
      pid: this.activePiece,
      mode: mode === 'inside' ? 'move' : mode,
      pointerId: e.pointerId,
      start: graphic,
      preview: { ...graphic, anchor: [graphic.anchor[0], graphic.anchor[1]] },
      grabDU: graphic.anchor[0] - pointerUV[0],
      grabDV: graphic.anchor[1] - pointerUV[1],
    };
    document.body.style.cursor = mode === 'inside' ? 'grabbing' : mode === 'scale' ? 'nwse-resize' : 'grab';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  }

  private updateGraphicDrag(px: number, py: number): void {
    const d = this.graphicDrag;
    if (!d) return;
    const piece = this.pieceAt(d.pid);
    const f = this.graphicScreenFrame(d.pid, d.preview);
    if (!piece || !f || !this.tf) return;
    if (d.mode === 'move') {
      const uv = this.screenToUV(px, py, false);
      d.preview.anchor = [
        Math.min(0.98, Math.max(0.02, uv[0] + d.grabDU)),
        Math.min(0.98, Math.max(0.02, uv[1] + d.grabDV)),
      ];
    } else if (d.mode === 'scale') {
      const dx = px - f.cx;
      const dy = py - f.cy;
      const c = Math.cos(-f.rot);
      const sn = Math.sin(-f.rot);
      const lx = dx * c - dy * sn;
      const ly = dx * sn + dy * c;
      // Le coin suit le curseur : la plus grande des deux directions gagne.
      const wFromX = (2 * Math.max(8, lx)) / this.tf.scale;
      const wFromY = (2 * Math.max(8, ly)) / this.tf.scale / Math.max(1e-6, d.preview.aspect);
      d.preview.widthM = Math.min(2, Math.max(0.02, Math.max(wFromX, wFromY)));
    } else {
      const phi = Math.atan2(py - f.cy, px - f.cx);
      let rot = phi + Math.PI / 2; // poignée au-dessus du centre au repos
      while (rot > Math.PI) rot -= Math.PI * 2;
      while (rot < -Math.PI) rot += Math.PI * 2;
      if (Math.abs(rot) < 0.05) rot = 0; // accroche au droit-fil
      d.preview.rotationRad = rot;
    }
    this.render();
  }

  private layoutToScreen(x: number, y: number): [number, number] {
    const t = this.tf!;
    return [t.ox + (x - t.minA) * t.scale, t.H - (t.oy + (y - t.minB) * t.scale)];
  }

  private screenToLayout(px: number, py: number): [number, number] {
    const t = this.tf!;
    return [t.minA + (px - t.ox) / t.scale, t.minB + (t.H - py - t.oy) / t.scale];
  }

  /** Layout-space x-offset for the garment this handle belongs to (0 alone). */
  private handleOffset(h: PatternHandleSpec): number {
    const gl = this.gLayout;
    if (!gl) return 0;
    // Match the handle to its garment by the y-range its grid describes.
    const top = h.grid.topY;
    const bot = h.grid.topY - h.grid.height;
    let best = 0;
    let bestErr = Infinity;
    for (let g = 0; g < gl.gY.length; g++) {
      const err = Math.abs(gl.gY[g]![1] - top) + Math.abs(gl.gY[g]![0] - bot);
      if (err < bestErr) {
        bestErr = err;
        best = g;
      }
    }
    return gl.offsetX[best] ?? 0;
  }

  private handleScreenPos(h: PatternHandleSpec, value: number): [number, number] {
    const [x, y] = handleLayoutPos(h, value);
    return this.layoutToScreen(x + this.handleOffset(h), y);
  }

  private pickHandle(px: number, py: number): number | null {
    if (!this.tf) return null;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i]!;
      const [hx, hy] = this.handleScreenPos(h, h.value);
      if ((px - hx) ** 2 + (py - hy) ** 2 <= HIT_RADIUS * HIT_RADIUS) return i;
    }
    return null;
  }

  private beginPan(e: PointerEvent): void {
    this.panDrag = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation();
  }

  /** Suppress the browser menu only over the editable 2D pattern. */
  /** Bord le plus proche d'un point écran SUR une pièce donnée (v180) —
   *  contrairement à nearestEdge, qui ne connaît que la pièce active. */
  private nearestEdgeOfPiece(
    pid: number,
    px: number,
    py: number,
  ): { edge: number; dist: number } | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const off = this.pieceOffset(pid);
    const yOff = this.pieceYOffset(pid);
    let best: { edge: number; dist: number } | null = null;
    const n = piece.outline.length;
    for (let e = 0; e < n; e++) {
      const a = this.vertexScreen(piece.outline[e]!, piece, off, yOff);
      const b = this.vertexScreen(piece.outline[(e + 1) % n]!, piece, off, yOff);
      if (!a || !b) continue;
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1;
      const t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
      const d = Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
      if (!best || d < best.dist) best = { edge: e, dist: d };
    }
    return best;
  }

  /** Index de la couture (fermée) qui porte ce bord, ou null (v180) — la même
   *  arithmétique de run que les liserés du plan. */
  private seamIndexOfEdge(pid: number, edge: number): number | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const nV = piece.outline.length;
    for (let i = 0; i < this.assembly.length; i++) {
      const s = this.assembly[i]!;
      if (!assemblySeamIsClosed(s)) continue;
      for (const fr of [s.a, s.b]) {
        if (pieceIdOf(fr) !== pid) continue;
        let steps = ((fr.to - fr.from) + nV) % nV;
        if (steps === 0) steps = 1;
        for (let k = 0; k < steps; k++) {
          if ((fr.from + k) % nV === edge) return i;
        }
      }
    }
    return null;
  }

  /** Sélection de pièce — le circuit UNIQUE du clic droit et du clic sec
   *  gauche (v177) : même logique de groupe, mêmes effets de bord. */
  private applyPieceSelection(pid: number | null, additive: boolean): void {
    const next = nextPieceSelection([...this.selectedPieces], pid, additive);
    this.selectedPieces = new Set(next.selected);
    this.selectedPiece = next.primary;
    if (this.selectedPiece !== null) this.activePiece = this.selectedPiece;
    this.emitActivePiece();
    this.resetDraftTransient();
    this.updateCanvasLabel();
    document.body.style.cursor = this.selectedPiece === null ? '' : 'move';
    this.render();
  }

  /** Vrai quand aucun outil exclusif ne détourne le clic — le geste neutre. */
  private neutralPieceGesture(): boolean {
    return (
      !this.drawing &&
      !this.cutting &&
      !this.merging &&
      !this.holing &&
      !this.precisioning &&
      !this.internalDrawing &&
      !this.fisheyeDrawing &&
      !this.curvePointing &&
      !this.notching &&
      !this.fullnessing &&
      !this.gathering &&
      !this.mirroring &&
      !this.sewing &&
      !this.freeSewing &&
      !this.zippering &&
      !this.lengthEditing &&
      !this.linkingSegments &&
      !this.serialMode &&
      this.seamPick === null &&
      this.zipperPick === null
    );
  }

  /** Bascule de thème (v179) : la couche statique (grille + silhouette) se
   *  réinvalide, tout se repeint dans la palette courante. */
  refreshTheme(): void {
    this.staticDirty = true;
    this.render();
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (!this.inDraft || !this.canvasPoint(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** Wheel/pinch zoom, centred on the detail beneath the pointer. */
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.tf || this.panDrag || this.draftDrag || this.curveDrag || this.curveLengthDrag || this.pieceResizeDrag || this.pieceMoveDrag || this.lengthDrag || this.drag) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    const before = patternScreenToLayout(this.tf, p[0], p[1]);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(16, Math.max(1, this.viewZoom * factor));
    if (Math.abs(next - this.viewZoom) < 1e-6) return;
    if (next === 1) {
      this.viewZoom = 1;
      this.viewCenter = null;
      this.viewChanged();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const fitScale = this.tf.scale / this.viewZoom;
    this.viewCenter = patternZoomCenterAt(
      before,
      p,
      fitScale * next,
      this.canvas.width,
      this.canvas.height,
    );
    this.viewZoom = next;
    this.viewChanged();
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onDown = (e: PointerEvent): void => {
    const navPoint = this.canvasPoint(e);
    // Middle-button drag always pans, even at 100% and while an editing tool is
    // selected. This is the unambiguous CAD navigation gesture.
    if (navPoint && e.button === 1) {
      this.beginPan(e);
      return;
    }
    if (this.inDraft && navPoint && this.surfacePlacementPieceId !== null) {
      if (e.button === 2) {
        this.surfacePlacementPieceId = null;
        this.surfacePlacementHover = null;
        document.body.style.cursor = '';
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (e.button === 0) {
        const supportPieceId = this.pickPiece(navPoint[0], navPoint[1]);
        const anchor =
          supportPieceId === null
            ? null
            : this.screenToPieceUV(supportPieceId, navPoint[0], navPoint[1]);
        if (
          supportPieceId !== null &&
          supportPieceId < this.surfacePlacementPieceId &&
          this.pieceAt(supportPieceId)?.placement?.role !== 'pocket' &&
          anchor
        ) {
          this.commitSurfacePlacement(supportPieceId, anchor);
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // Clic droit : sélection globale. Commande/Ctrl + clic droit ajoute/retire
    // la pièce au groupe sans effacer les autres.
    if (this.inDraft && navPoint && e.button === 2 && !this.penMode) {
      const pid = this.pickPiece(navPoint[0], navPoint[1]);
      this.applyPieceSelection(pid, e.metaKey || e.ctrlKey);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Freeform draft: grab an outline vertex; empty inset space falls through.
    if (this.inDraft) {
      if (this.draftDrag || this.curveDrag || this.curveLengthDrag || this.pieceResizeDrag || this.pieceMoveDrag || e.button !== 0) return;
      const p = navPoint;
      if (!p) return;
      if (this.pristine) {
        this.beginPan(e); // page blanche : rien à saisir, le fond se déplace
        return;
      }
      if (this.draftPiece?.blank && !this.penMode) {
        this.beginPan(e); // socle vide actif : rien à éditer là
        return;
      }
      const surfaceEdge = this.pickSurfaceEdge(p[0], p[1]);
      if (
        surfaceEdge &&
        (surfaceEdge.stitched || this.sewMode) &&
        !this.lengthMode &&
        !this.linkMode &&
        !this.zipperMode
      ) {
        this.toggleSurfaceStitch(
          surfaceEdge.pieceId,
          surfaceEdge.edge,
          surfaceEdge.stitched,
        );
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A global resize handle sits slightly outside the piece/column, so it
      // must win before ordinary column routing.
      const resizeTarget = this.pickPieceResizeHandle(p[0], p[1]);
      if (resizeTarget) {
        this.beginPieceResize(e, p, resizeTarget);
        return;
      }
      // 🧵 COUTURE LIBRE : départ/fin du 1er tracé, puis départ/fin du 2e — le
      // tracé suit le contour entre deux clics (onMove). AVANT le mode
      // sélection, qui intercepterait le clic pour déplacer la pièce.
      if (this.freeSewMode) {
        this.routePieceGesture(p[0], p[1]); // la colonne cliquée devient active
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 2) {
          e.preventDefault();
          e.stopPropagation();
          const piece = this.pieceAt(this.activePiece);
          if (!piece) return;
          const prefix = this.outlinePrefix(piece);
          const L = prefix[piece.outline.length]!;
          const st = this.freeSewTrace;
          if (!st || st.pieceId !== this.activePiece || L < 1e-9) {
            // Départ d'un tracé (1er ou 2e) — un clic sur une AUTRE pièce en
            // cours de tracé repart de celle-ci (même règle que ✂).
            const s0 = this.outlineS(prefix, ne.edge, ne.t);
            this.freeSewTrace = {
              pieceId: this.activePiece,
              start: { edge: ne.edge, t: ne.t },
              startS: s0,
              curS: s0,
            };
            this.render();
            return;
          }
          // Fin du tracé courant, à l'abscisse DÉROULÉE (même déroulé que le
          // survol : le clic ne peut pas sauter de l'autre côté du contour).
          const sRaw = this.outlineS(prefix, ne.edge, ne.t);
          const k = Math.round((st.curS - sRaw) / L);
          const sEnd = Math.min(
            st.startS + L * 0.999,
            Math.max(st.startS - L * 0.999, sRaw + k * L),
          );
          if (Math.abs(sEnd - st.startS) < L * 1e-4) {
            this.freeSewTrace = null; // re-clic au départ = annuler ce tracé
            this.render();
            return;
          }
          const dir: 1 | -1 = sEnd >= st.startS ? 1 : -1;
          const runSpec = {
            pieceId: st.pieceId,
            start: st.start,
            end: { edge: ne.edge, t: ne.t },
            dir,
          };
          if (!this.freeSewRunA) {
            this.freeSewRunA = {
              ...runSpec,
              lenM: Math.abs(sEnd - st.startS),
              startS: st.startS,
              endS: sEnd,
            };
            this.freeSewTrace = null;
            this.render();
            return;
          }
          const a = this.freeSewRunA;
          this.freeSewMode = false; // couture posée : le mode guidé se referme
          this.freeSewTrace = null;
          this.freeSewRunA = null;
          document.body.style.cursor = '';
          this.render();
          this.onFreeSeam(
            { pieceId: a.pieceId, start: a.start, end: a.end, dir: a.dir },
            runSpec,
          );
        }
        return;
      }
      // ⧎ MIROIR COUSU : UN clic sur le bord-axe — la pièce se duplique en
      // symétrie, cousue le long de cet axe. AVANT le mode sélection.
      if (this.mirrorMode) {
        this.routePieceGesture(p[0], p[1]);
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 2) {
          e.preventDefault();
          e.stopPropagation();
          const pid = this.activePiece;
          this.mirrorMode = false; // geste fait : le mode guidé se referme
          document.body.style.cursor = '';
          this.render();
          this.onMirrorPiece(pid, ne.edge);
        }
        return;
      }
      // ✂ COUPER & COUDRE : deux clics sur le contour de la MÊME pièce. AVANT
      // le mode sélection, qui intercepterait le clic pour déplacer la pièce.
      // ⧢ ÉVASEMENT : 1er clic = le PIVOT (le bord qui reste fermé), 2e clic
      // = l'OUVERTURE (le bord qui gagne l'ampleur) — puis le choix des cm.
      if (this.fullnessMode) {
        this.routePieceGesture(p[0], p[1]);
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 2) {
          e.preventDefault();
          e.stopPropagation();
          if (this.fullnessPick && this.fullnessPick.pieceId === this.activePiece) {
            const pivot = { edge: this.fullnessPick.edge, t: this.fullnessPick.t };
            const pid = this.fullnessPick.pieceId;
            this.fullnessMode = false;
            this.fullnessPick = null;
            this.fullnessHover = null;
            document.body.style.cursor = '';
            this.render();
            this.onFullnessPicked(pid, pivot, { edge: ne.edge, t: ne.t });
          } else {
            this.fullnessPick = { pieceId: this.activePiece, edge: ne.edge, t: ne.t };
            this.fullnessHover = [p[0], p[1]];
            this.render();
          }
        }
        return;
      }
      // ⌖ PRÉCISION : le geste dépend de CE qu'on clique — un sommet (équerre
      // ou alignement, l'atelier propose), un bord du contour (division en N),
      // un bout de ligne interne (prolonger au contour), un milieu (scinder).
      if (this.precisionMode) {
        this.routePieceGesture(p[0], p[1]);
        e.preventDefault();
        e.stopPropagation();
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        const v = this.pickVertex(p[0], p[1]);
        if (v !== null) {
          this.onPrecisionVertex(this.activePiece, v);
          return;
        }
        if (piece.internalLines?.length) {
          for (let i = 0; i < piece.internalLines.length; i++) {
            const line = piece.internalLines[i]!;
            if (line.closed || line.points.length < 2) continue;
            const s0 = this.vertexScreen(line.points[0]!);
            const s1 = this.vertexScreen(line.points[line.points.length - 1]!);
            if (s0 && Math.hypot(p[0] - s0[0], p[1] - s0[1]) <= HIT_RADIUS * 1.4) {
              this.onExtendInternal(this.activePiece, i, 0);
              return;
            }
            if (s1 && Math.hypot(p[0] - s1[0], p[1] - s1[1]) <= HIT_RADIUS * 1.4) {
              this.onExtendInternal(this.activePiece, i, 1);
              return;
            }
          }
          const li = this.internalLineAt(p[0], p[1]);
          if (li !== null) {
            this.onDivideInternal(this.activePiece, li, this.screenToUV(p[0], p[1]));
            return;
          }
        }
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 1.6) {
          this.onDivideEdge(this.activePiece, ne.edge);
        }
        return;
      }
      // ⌾ ÉVIDER : cliquer une ligne interne FERMÉE (bord ou intérieur) la
      // bascule en trou — le moteur vérifie et refuse en mots sinon.
      if (this.holeMode) {
        this.routePieceGesture(p[0], p[1]);
        e.preventDefault();
        e.stopPropagation();
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        let idx = this.internalLineAt(p[0], p[1]);
        if (idx === null && piece.internalLines?.length) {
          const uv = this.screenToUV(p[0], p[1]);
          for (let i = 0; i < piece.internalLines.length; i++) {
            const line = piece.internalLines[i]!;
            if (line.closed && line.points.length >= 3 && pointInPolygon(uv, line.points)) {
              idx = i;
              break;
            }
          }
        }
        if (idx !== null) this.onHoleToggle(this.activePiece, idx);
        return;
      }
      // ⧉ FUSION : clic sur le LIEN d'une couture = fondre ses deux pièces
      // en une seule (le moteur vérifie la congruence, refuse en mots sinon).
      if (this.mergeMode) {
        e.preventDefault();
        e.stopPropagation();
        const seamIdx = this.pickSeam(p[0], p[1]);
        if (seamIdx !== null) this.onMergeSeam(seamIdx);
        return;
      }
      // ⌵ CRANS : clic sur le LIEN d'une couture = crans d'accord des deux
      // côtés ; clic près d'un bord = poser (ou retirer) un cran à cet endroit.
      if (this.notchMode) {
        this.routePieceGesture(p[0], p[1]);
        e.preventDefault();
        e.stopPropagation();
        const seamIdx = this.pickSeam(p[0], p[1]);
        if (seamIdx !== null) {
          this.onNotchSeam(seamIdx);
          return;
        }
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 2) {
          this.onNotchToggle(this.activePiece, this.screenToUV(p[0], p[1]));
        }
        return;
      }
      // ∿ POINT COURBE : saisir un SOMMET du contour ; glisser = le rayon de
      // l'arrondi suit le curseur (cm en direct), relâcher = le coin s'arrondit.
      if (this.curvePointMode) {
        this.routePieceGesture(p[0], p[1]);
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        e.preventDefault();
        e.stopPropagation();
        let best: number | null = null;
        let bestD = (HIT_RADIUS * 1.3) ** 2;
        for (let i = 0; i < piece.outline.length; i++) {
          const s = this.vertexScreen(piece.outline[i]!);
          if (!s) continue;
          const d2 = (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2;
          if (d2 < bestD) {
            bestD = d2;
            best = i;
          }
        }
        if (best === null) return;
        this.curvePointDrag = { vertex: best, radiusM: 0, pointerId: e.pointerId };
        this.render();
        return;
      }
      // ◆ PINCE LOSANGE : trois clics DANS la pièce — pointe haute, pointe
      // basse, puis un clic à côté de l'axe = la demi-largeur de la taille.
      if (this.dartMode) {
        this.routePieceGesture(p[0], p[1]);
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        e.preventDefault();
        e.stopPropagation();
        // Pince de bord : glisser un bord lance une pince sans touche Alt.
        if (!this.dartTop) {
          const ne = this.nearestEdge(p[0], p[1]);
          if (ne && ne.dist <= EDGE_HIT) {
            this.draftEdge = {
              edge: ne.edge,
              downUV: this.screenToUV(ne.sx, ne.sy),
              downSX: ne.sx,
              downSY: ne.sy,
              pointerId: e.pointerId,
              apex: null,
              dart: true,
              bend: null,
            };
            return;
          }
        }
        const uvPt = this.screenToUV(p[0], p[1]);
        if (!pointInPolygon(uvPt, piece.outline)) return;
        if (!this.dartTop) {
          this.dartTop = uvPt;
          this.dartHover = [p[0], p[1]];
          this.render();
          return;
        }
        if (!this.dartBottom) {
          this.dartBottom = uvPt;
          this.render();
          return;
        }
        const half = this.fisheyeHalfWidthM(uvPt);
        const pid = this.activePiece;
        const top = this.dartTop;
        const bottom = this.dartBottom;
        this.dartTop = null;
        this.dartBottom = null;
        this.dartHover = null;
        this.render();
        if (half !== null) this.onFisheyeDart(pid, top, bottom, half);
        return;
      }
      // ▱ LIGNE INTERNE : poser des points DANS la pièce active ; re-clic sur
      // le 1er point (≥ 3) = polygone fermé, re-clic sur le DERNIER (≥ 2) =
      // polyligne ouverte. Sans tracé en cours, cliquer une ligne = sélectionner
      // (Suppr/Retour arrière efface la sélection).
      if (this.internalMode) {
        this.routePieceGesture(p[0], p[1]);
        const piece = this.pieceAt(this.activePiece);
        if (!piece || piece.blank) return;
        e.preventDefault();
        e.stopPropagation();
        const uvPt = this.screenToUV(p[0], p[1]);
        if (!this.internalTrace) {
          // Point drag or insert on selected line?
          if (this.selectedInternal !== null) {
            const line = piece.internalLines?.[this.selectedInternal];
            if (line) {
              for (let pi = 0; pi < line.points.length; pi++) {
                const sp = this.vertexScreen(line.points[pi]!);
                if (sp && (p[0] - sp[0]) ** 2 + (p[1] - sp[1]) ** 2 <= (HIT_RADIUS * 1.4) ** 2) {
                  this.internalPtDrag = { lineIdx: this.selectedInternal, ptIdx: pi, orig: [...line.points[pi]!] as UV };
                  this.render();
                  return;
                }
              }
              // Click on the line body (not a point) → insert a new point and start dragging it
              const sp = line.points
                .map((uv) => this.vertexScreen(uv))
                .filter((s): s is [number, number] => s !== null);
              const nSeg = line.closed ? sp.length : sp.length - 1;
              let bestSeg = -1;
              let bestD = (HIT_RADIUS * 1.4) ** 2;
              for (let k = 0; k < nSeg; k++) {
                const a = sp[k]!;
                const b = sp[(k + 1) % sp.length]!;
                const vx = b[0] - a[0];
                const vy = b[1] - a[1];
                const len2 = vx * vx + vy * vy || 1e-6;
                const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
                const d2 = (p[0] - (a[0] + t * vx)) ** 2 + (p[1] - (a[1] + t * vy)) ** 2;
                if (d2 < bestD) { bestD = d2; bestSeg = k; }
              }
              if (bestSeg >= 0) {
                const insertIdx = bestSeg + 1;
                line.points.splice(insertIdx, 0, uvPt);
                this.internalPtDrag = { lineIdx: this.selectedInternal, ptIdx: insertIdx, orig: [...uvPt] as UV };
                this.staticDirty = true;
                this.render();
                return;
              }
            }
          }
          const hit = this.internalLineAt(p[0], p[1]);
          if (hit !== null) {
            this.selectedInternal = hit;
            this.internalPtDrag = null;
            this.render();
            return;
          }
          this.selectedInternal = null;
          this.internalPtDrag = null;
          if (!pointInPolygon(uvPt, piece.outline)) { this.render(); return; }
          this.internalTrace = [uvPt];
          this.internalHover = [p[0], p[1]];
          this.render();
          return;
        }
        const trace = this.internalTrace;
        const near = (sp: [number, number] | null): boolean =>
          !!sp && (p[0] - sp[0]) ** 2 + (p[1] - sp[1]) ** 2 <= (HIT_RADIUS * 1.6) ** 2;
        if (trace.length >= 3 && near(this.vertexScreen(trace[0]!))) {
          this.commitInternalTrace(true);
          return;
        }
        if (trace.length >= 2 && near(this.vertexScreen(trace[trace.length - 1]!))) {
          this.commitInternalTrace(false);
          return;
        }
        if (!pointInPolygon(uvPt, piece.outline)) return;
        trace.push(uvPt);
        this.render();
        return;
      }
      if (this.cutMode) {
        this.routePieceGesture(p[0], p[1]); // la colonne cliquée devient active
        // Scission sur LIGNE INTERNE : sans 1er point de corde armé, cliquer
        // une ligne dessinée au ▱ scinde la pièce le long de son tracé.
        if (!this.cutPick) {
          const lineHit = this.internalLineAt(p[0], p[1]);
          if (lineHit !== null) {
            e.preventDefault();
            e.stopPropagation();
            const pid = this.activePiece;
            this.cutMode = false;
            this.cutHover = null;
            document.body.style.cursor = '';
            this.render();
            this.onCutAlongInternalLine(pid, lineHit);
            return;
          }
        }
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 2) {
          e.preventDefault();
          e.stopPropagation();
          if (this.cutPick && this.cutPick.pieceId === this.activePiece) {
            const a = { edge: this.cutPick.edge, t: this.cutPick.t };
            const b = { edge: ne.edge, t: ne.t };
            const pid = this.cutPick.pieceId;
            this.cutMode = false;
            this.cutPick = null;
            this.cutHover = null;
            document.body.style.cursor = '';
            this.render();
            this.onCutPiece(pid, a, b, e.shiftKey);
          } else {
            // 1er point (ou changement de pièce : on repart de celle-ci).
            this.cutPick = { pieceId: this.activePiece, edge: ne.edge, t: ne.t };
            this.cutHover = [p[0], p[1]];
            this.render();
          }
        }
        return;
      }
      // 〰 FRONCES : cliquer le lien d'une couture ouvre le choix côté/ratio.
      if (this.gatherMode) {
        const idx = this.pickSeam(p[0], p[1]);
        if (idx !== null) {
          e.preventDefault();
          e.stopPropagation();
          this.onGatherSeam(idx);
        }
        return;
      }
      // Whole-piece mode: a left drag inside translates the complete pattern;
      // the four handles above keep their dedicated proportional resize gesture.
      // A background drag still pans an enlarged plan.
      if (this.selectedPiece !== null && !this.penMode) {
        const hit = this.pickPiece(p[0], p[1]);
        // v177 : candidat clic-sec — un clic sec sur une pièce (membre du
        // groupe ou non, contour compris) la sélectionne au pointerup, ⌘/Ctrl
        // la bascule dans le groupe ; le glisser garde son sens (déplacer la
        // sélection / pan). Le POSER du candidat goûte aussi le contour
        // (pickPieceNearOutline) ; la décision déplacer-vs-pan reste stricte.
        const tapHit = hit ?? this.pickPieceNearOutline(p[0], p[1]);
        if (e.button === 0 && tapHit !== null && this.neutralPieceGesture()) {
          this.pieceClickPending = { pieceId: tapHit, pointerId: e.pointerId, cx: e.clientX, cy: e.clientY };
        } else {
          this.pieceClickPending = null;
        }
        if (hit !== null && this.selectedPieces.has(hit)) this.beginPieceMove(e, p);
        else this.beginPan(e);
        return;
      }
      if (!this.penMode) this.routePieceGesture(p[0], p[1]); // moved pieces remain editable outside their original column
      // v177 : candidat clic-sec posé UNE fois pour toute la zone draft — la
      // décision se prend au pointerup, quelle que soit la branche (pan, bord,
      // sommet, graphique) qui réclame le geste ensuite.
      if (e.button === 0 && !this.penMode && this.neutralPieceGesture()) {
        const tapPid = this.pickPiece(p[0], p[1]) ?? this.pickPieceNearOutline(p[0], p[1]);
        this.pieceClickPending =
          tapPid === null
            ? null
            : { pieceId: tapPid, pointerId: e.pointerId, cx: e.clientX, cy: e.clientY };
      } else {
        this.pieceClickPending = null;
      }
      if (!this.draftPiece) {
        this.beginPan(e);
        return;
      }
      // Pen: place points to trace a new piece; clicking near the first point
      // (with ≥3 points) closes it.
      if (this.penMode) {
        // The tool owns one explicit UV box. A click in another column is
        // acknowledged, but can no longer be silently clamped onto an edge.
        if (!this.pointInPenDrawingZone(p)) {
          this.penPointerInside = false;
          this.showPenDrawingFeedback();
          document.body.style.cursor = 'not-allowed';
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        this.penPointerInside = true;
        this.clearPenFeedback();
        if (this.penPoints.length >= (this.penMirror ? 2 : 3)) {
          const s0 = this.vertexScreen(this.penPoints[0]!);
          if (s0 && (p[0] - s0[0]) ** 2 + (p[1] - s0[1]) ** 2 <= (HIT_RADIUS * 1.6) ** 2) {
            this.finishPen();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        this.penPoints.push(this.screenToUV(p[0], p[1]));
        this.render();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (this.linkMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 1.5) {
          this.pickEdgeForSegmentLink(this.activePiece, ne.edge);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (this.zipperMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 1.5) {
          this.pickEdgeForZipper(this.activePiece, ne.edge);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // Shift+click two edges → sew them together (MANUAL assembly). The two
      // edges can be on different columns (front shoulder ↔ back shoulder, or a
      // free piece ↔ the body) — the column the pointer went down in (pickColumn,
      // above) sets the piece.
      if (this.serialMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          this.pickEdgeForSerial(this.activePiece, ne.edge);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (e.shiftKey || this.sewMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          this.pickEdgeForSeam(this.activePiece, ne.edge);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // Mode ↔ LONGUEUR : saisir n'importe où sur le segment. L'extrémité la
      // plus proche devient la poignée mobile ; l'autre reste fixe.
      if (this.lengthMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT * 1.5) {
          const logicalCurve = this.curveIndexForEdge(ne.edge);
          if (logicalCurve !== null) {
            this.beginCurveLengthDrag(e, p, logicalCurve, [ne.sx, ne.sy]);
            return;
          }
          const grab = this.screenToUV(ne.sx, ne.sy);
          const edit = beginSegmentLengthEdit(this.draftPiece, ne.edge, grab);
          if (edit) {
            const orig = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
            const marriage = this.segmentLinkAt(this.activePiece, ne.edge);
            let linked: NonNullable<NonNullable<typeof this.lengthDrag>['linked']> | undefined;
            if (marriage) {
              const otherPieceId = pieceIdOf(marriage.other);
              const otherPiece = this.pieceAt(otherPieceId);
              const otherEdge = marriage.other.from;
              const otherGeometry = otherPiece
                ? outlineEdgeGeometry(otherPiece, otherPiece.outline, otherEdge)
                : null;
              if (otherPiece && otherGeometry) {
                linked = {
                  pieceId: otherPieceId,
                  edge: otherEdge,
                  moving: linkedSegmentMovingVertex(
                    this.draftPiece,
                    orig,
                    ne.edge,
                    edit.moving,
                    otherPiece,
                    otherPiece.outline,
                    otherEdge,
                  ),
                  orig: otherPiece.outline.map((q) => [q[0], q[1]] as UV),
                  startLength: otherGeometry.lengthM,
                };
              }
            }
            this.draftPreview = orig.map((q) => [q[0], q[1]] as UV);
            this.lengthHover = { pieceId: this.activePiece, edge: ne.edge };
            const rawPointer = this.screenToUV(p[0], p[1], false);
            const movingScreen = this.vertexScreen(orig[edit.moving]!);
            if (!movingScreen) return;
            this.lengthDrag = {
              ...edit,
              pointerId: e.pointerId,
              orig,
              rawPointerScreen: [p[0], p[1]],
              pointerToMovingScreen: [
                movingScreen[0] - p[0],
                movingScreen[1] - p[1],
              ],
              intent: axisDragIntent(this.draftPiece, edit.grab, rawPointer, edit.unit),
              linked,
            };
            this.lengthSnap = null;
            this.linkedPreview = null;
            document.body.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
            this.render();
          }
        }
        return;
      }
      // A smooth sampled run behaves as one curve segment. Its sole diamond
      // handle reshapes all internal samples while both endpoints stay fixed.
      const curveIndex = this.pickCurveHandle(p[0], p[1]);
      if (curveIndex !== null) {
        this.beginCurveDrag(e, p, curveIndex);
        return;
      }
      const v = this.pickVertex(p[0], p[1]);
      if (v === null) {
        // Not on a vertex: a seam link? delete it (a vertex grab wins over this,
        // so it can't steal a click meant for editing the outline). Otherwise,
        // near an outline edge? hold the gesture — a click adds a point, a drag
        // inward pulls out a dart. Empty inset space falls through to 3D orbit.
        const si = this.pickSeam(p[0], p[1]);
        if (si !== null) {
          this.seamPickA = null;
          this.onAssemblyDelete(si);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // 🖼 GRAPHIQUE : l'image de la pièce active se saisit (corps + poignées)
        // avant les gestes de bord — un print au milieu de la pièce se déplace
        // sans risquer de tirer un sommet.
        const activeGraphic = this.draftPiece?.graphic;
        if (activeGraphic && !this.graphicDrag) {
          const hit = this.graphicHit(this.activePiece, activeGraphic, p[0], p[1]);
          if (hit) {
            this.beginGraphicDrag(e, p, hit, activeGraphic);
            return;
          }
        }
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          const logicalCurve = this.curveIndexForEdge(ne.edge);
          if (logicalCurve !== null) {
            this.beginCurveDrag(e, p, logicalCurve);
            return;
          }
          this.draftEdge = {
            edge: ne.edge,
            downUV: this.screenToUV(ne.sx, ne.sy),
            downSX: ne.sx,
            downSY: ne.sy,
            pointerId: e.pointerId,
            apex: null,
            dart: e.altKey || this.fisheyeDrawing,
            bend: null,
          };
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // A plain left drag on the empty cutting table moves the plan, including
        // at 100%. Vertices, curves and selected pieces keep priority above.
        this.beginPan(e); // le candidat clic-sec est déjà posé plus haut (v177)
        return;
      }
      const s = this.vertexScreen(this.draftPiece.outline[v]!)!;
      this.draftPreview = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
      const orig = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
      this.draftDrag = { vertex: v, pointerId: e.pointerId, grabDX: p[0] - s[0], grabDY: p[1] - s[1], orig, curve: curveNeighbors(orig, v) };
      document.body.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    // One gesture at a time; secondary buttons stay with the 3D view.
    if (this.drag || e.button !== 0) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    const i = this.pickHandle(p[0], p[1]);
    if (i === null) {
      if (this.viewZoom > 1) this.beginPan(e);
      return;
    }
    const h = this.handles[i]!;
    const [hx, hy] = this.handleScreenPos(h, h.value);
    this.drag = { index: i, value: h.value, pointerId: e.pointerId, grabDX: p[0] - hx, grabDY: p[1] - hy };
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (
      this.pieceClickPending &&
      this.pieceClickPending.pointerId === e.pointerId &&
      Math.hypot(
        e.clientX - this.pieceClickPending.cx,
        e.clientY - this.pieceClickPending.cy,
      ) > PIECE_CLICK_PX
    ) {
      this.pieceClickPending = null; // le geste est un vrai glisser (v177)
    }
    if (this.freeSewMode && this.freeSewTrace) {
      const p = this.canvasPoint(e);
      if (p && this.updateFreeSewTrace(p[0], p[1])) {
        this.render(); // l'arc du tracé libre suit le curseur le long du bord
      }
      return;
    }
    if (this.graphicDrag && e.pointerId === this.graphicDrag.pointerId) {
      const p = this.canvasPoint(e);
      if (p) this.updateGraphicDrag(p[0], p[1]);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.cutMode && this.cutPick) {
      const p = this.canvasPoint(e);
      if (p) {
        this.cutHover = [p[0], p[1]];
        this.render(); // aperçu de la corde de découpe qui suit le curseur
      }
      return;
    }
    if (this.fullnessMode && this.fullnessPick) {
      const p = this.canvasPoint(e);
      if (p) {
        this.fullnessHover = [p[0], p[1]];
        this.render(); // l'entaille fantôme suit le curseur
      }
      return;
    }
    if (this.internalPtDrag) {
      const p = this.canvasPoint(e);
      if (p) {
        const piece = this.pieceAt(this.activePiece);
        const line = piece?.internalLines?.[this.internalPtDrag.lineIdx];
        if (line) {
          const uv = this.screenToUV(p[0], p[1]);
          line.points[this.internalPtDrag.ptIdx] = uv;
          this.staticDirty = true;
          this.render();
        }
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.internalMode && this.internalTrace) {
      const p = this.canvasPoint(e);
      if (p) {
        this.internalHover = [p[0], p[1]];
        this.render(); // le fil de la ligne interne suit le curseur
      }
      return;
    }
    if (this.dartMode && this.dartTop) {
      const p = this.canvasPoint(e);
      if (p) {
        this.dartHover = [p[0], p[1]];
        this.render(); // l'axe puis le losange fantôme suivent le curseur
      }
      return;
    }
    if (this.curvePointDrag) {
      const p = this.canvasPoint(e);
      const piece = this.pieceAt(this.activePiece);
      if (p && piece) {
        const corner = piece.outline[this.curvePointDrag.vertex]!;
        const uvPt = this.screenToUV(p[0], p[1]);
        this.curvePointDrag.radiusM = Math.hypot(
          (uvPt[0] - corner[0]) * piece.width,
          (uvPt[1] - corner[1]) * piece.height,
        );
        this.render(); // l'arc fantôme suit le rayon
      }
      return;
    }
    if (this.surfacePlacementPieceId !== null && !this.penMode) {
      const p = this.canvasPoint(e);
      const supportPieceId = p ? this.pickPiece(p[0], p[1]) : null;
      const anchor =
        p && supportPieceId !== null
          ? this.screenToPieceUV(supportPieceId, p[0], p[1])
          : null;
      const valid =
        supportPieceId !== null &&
        supportPieceId < this.surfacePlacementPieceId &&
        this.pieceAt(supportPieceId)?.placement?.role !== 'pocket' &&
        !!anchor;
      const next = valid
        ? { supportPieceId, anchor: anchor! }
        : null;
      const changed =
        next?.supportPieceId !== this.surfacePlacementHover?.supportPieceId ||
        Math.abs((next?.anchor[0] ?? 0) - (this.surfacePlacementHover?.anchor[0] ?? 0)) > 1e-5 ||
        Math.abs((next?.anchor[1] ?? 0) - (this.surfacePlacementHover?.anchor[1] ?? 0)) > 1e-5;
      this.surfacePlacementHover = next;
      document.body.style.cursor = valid ? 'crosshair' : 'not-allowed';
      if (changed) this.render();
      return;
    }
    if (this.panDrag && e.pointerId === this.panDrag.pointerId && this.tf) {
      const dx = e.clientX - this.panDrag.lastX;
      const dy = e.clientY - this.panDrag.lastY;
      this.panDrag.lastX = e.clientX;
      this.panDrag.lastY = e.clientY;
      if (!this.viewCenter) {
        this.viewCenter = patternScreenToLayout(
          this.tf,
          this.canvas.width / 2,
          this.canvas.height / 2,
        );
      }
      this.viewCenter = patternPanCenter(
        this.viewCenter,
        dx,
        dy,
        this.tf.scale,
      );
      this.staticDirty = true;
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    if (this.penMode) {
      const p = this.canvasPoint(e);
      const inside = p ? this.pointInPenDrawingZone(p) : null;
      const changed = inside !== this.penPointerInside;
      this.penPointerInside = inside;
      document.body.style.cursor =
        inside === null ? '' : inside ? 'crosshair' : 'not-allowed';
      if (changed) this.render();
      return;
    }
    if (this.pieceMoveDrag && e.pointerId === this.pieceMoveDrag.pointerId && this.tf) {
      const d = this.pieceMoveDrag;
      const r = this.canvas.getBoundingClientRect();
      const current = this.screenToLayout(e.clientX - r.left, e.clientY - r.top);
      d.delta = [current[0] - d.startLayout[0], current[1] - d.startLayout[1]];
      for (const member of d.members) {
        this.layoutShifts[member.pieceId] = [
          member.startShift[0] + d.delta[0],
          member.startShift[1] + d.delta[1],
        ];
      }
      this.activePiece = d.pieceId;
      document.body.style.cursor = 'move';
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    if (this.pieceResizeDrag && e.pointerId === this.pieceResizeDrag.pointerId && this.tf) {
      const d = this.pieceResizeDrag;
      const r = this.canvas.getBoundingClientRect();
      const [lx, ly] = this.screenToLayout(e.clientX - r.left, e.clientY - r.top);
      const pointer: [number, number] = [
        lx - this.pieceOffset(d.pieceId) - d.grabDX,
        ly - this.pieceYOffset(d.pieceId) - d.grabDY,
      ];
      d.scale = pieceResizeScale(d.anchor, d.handle, pointer);
      this.activePiece = d.pieceId;
      const resized = resizeDraftPiecesTogether(
        d.members.map((member) => member.original),
        d.corner,
        d.scale,
      );
      d.members.forEach((member, index) => {
        this.pieces[member.pieceId] = resized[index]!;
      });
      document.body.style.cursor = d.corner === 'nw' || d.corner === 'se' ? 'nwse-resize' : 'nesw-resize';
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    if (this.draftPiece) {
      if (this.curveLengthDrag && e.pointerId === this.curveLengthDrag.pointerId) {
        const r = this.canvas.getBoundingClientRect();
        const rawPointerScreen: [number, number] = [
          e.clientX - r.left,
          e.clientY - r.top,
        ];
        const pointer = this.screenToUV(
          rawPointerScreen[0],
          rawPointerScreen[1],
          false,
        );
        this.curveLengthDrag.rawPointerScreen = rawPointerScreen;
        this.curveLengthDrag.intent = axisDragIntent(
          this.draftPiece,
          this.curveLengthDrag.grab,
          pointer,
          this.curveLengthDrag.unit,
        );
        this.draftPreview = resizeLogicalCurveLengthFromPointer(
          this.draftPiece,
          this.curveLengthDrag.orig,
          this.curveLengthDrag,
          pointer,
        );
        document.body.style.cursor = 'ew-resize';
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.curveDrag && e.pointerId === this.curveDrag.pointerId) {
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left - this.curveDrag.grabDX;
        const py = e.clientY - r.top - this.curveDrag.grabDY;
        const target = this.screenToUV(px, py, false);
        this.draftPreview = reshapeLogicalCurve(
          this.draftPiece,
          this.curveDrag.orig,
          this.curveDrag.run,
          target,
        );
        document.body.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.lengthDrag && e.pointerId === this.lengthDrag.pointerId) {
        const r = this.canvas.getBoundingClientRect();
        const rawPointerScreen: [number, number] = [
          e.clientX - r.left,
          e.clientY - r.top,
        ];
        const pointer = this.screenToUV(
          rawPointerScreen[0],
          rawPointerScreen[1],
          false,
        );
        this.lengthDrag.rawPointerScreen = rawPointerScreen;
        this.lengthDrag.intent = axisDragIntent(
          this.draftPiece,
          this.lengthDrag.grab,
          pointer,
          this.lengthDrag.unit,
        );
        let preview = resizeSegmentFromPointer(this.draftPiece, this.lengthDrag.orig, this.lengthDrag, pointer);
        this.lengthSnap = null;
        if (this.lengthSnapEnabled) {
          const suggestion = findSegmentSnapSuggestion(
            this.pieces,
            this.assembly,
            this.activePiece,
            this.lengthDrag.edge,
            preview,
            this.lengthDrag.moving,
          );
          if (suggestion) {
            preview = snapSegmentOutline(this.draftPiece, preview, this.lengthDrag.edge, this.lengthDrag.moving, suggestion);
            this.lengthSnap = suggestion;
          }
        }
        this.linkedPreview = null;
        const linked = this.lengthDrag.linked;
        const sourceGeometry = outlineEdgeGeometry(this.draftPiece, preview, this.lengthDrag.edge);
        if (linked && sourceGeometry) {
          const deltaM = sourceGeometry.lengthM - this.lengthDrag.startLength;
          if (linked.pieceId === this.activePiece) {
            preview = resizeLinkedSegmentByDelta(
              this.draftPiece,
              preview,
              linked.edge,
              linked.moving,
              deltaM,
            );
          } else {
            const linkedPiece = this.pieceAt(linked.pieceId);
            if (linkedPiece) {
              this.linkedPreview = {
                pieceId: linked.pieceId,
                outline: resizeLinkedSegmentByDelta(
                  linkedPiece,
                  linked.orig,
                  linked.edge,
                  linked.moving,
                  deltaM,
                ),
              };
            }
          }
        }
        this.draftPreview = preview;
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const dist = Math.hypot(px - this.draftEdge.downSX, py - this.draftEdge.downSY);
        const dragged = dist > DART_DRAG;
        if (this.draftEdge.dart) {
          // Alt+glisser : le point de la souris est la pointe de la pince (aperçu).
          this.draftEdge.apex = dragged ? this.screenToUV(px, py) : null;
        } else {
          // Glisser simple : le segment se BOMBE — l'arc suit la souris (aperçu).
          const out = this.draftPiece!.outline;
          const a = out[this.draftEdge.edge]!;
          const b = out[(this.draftEdge.edge + 1) % out.length]!;
          const arc = dragged ? bendSamples(a, b, this.draftEdge.downUV, this.screenToUV(px, py)) : [];
          this.draftEdge.bend = arc.length ? arc : null;
        }
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.draftDrag) {
        if (e.pointerId !== this.draftDrag.pointerId) return;
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left - this.draftDrag.grabDX;
        const py = e.clientY - r.top - this.draftDrag.grabDY;
        const d = this.draftDrag;
        const target = this.screenToUV(px, py);
        const o = d.orig[d.vertex]!;
        const dx = target[0] - o[0];
        const dy = target[1] - o[1];
        this.draftPreview![d.vertex] = target;
        // Les voisins d'arc suivent avec leur amorti (glisser-courbe).
        for (const { idx, w } of d.curve) {
          const q = d.orig[idx]!;
          this.draftPreview![idx] = [q[0] + dx * w, q[1] + dy * w];
        }
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.lengthMode) {
        const p = this.canvasPoint(e);
        const previousPiece = this.activePiece;
        if (p) {
          this.routePieceGesture(p[0], p[1]);
          // An empty back/free column must not trap hover routing.
          if (!this.draftPiece) this.activePiece = previousPiece;
        }
        const ne = p && this.draftPiece ? this.nearestEdge(p[0], p[1]) : null;
        const curve = ne && ne.dist <= EDGE_HIT * 1.5 ? this.curveIndexForEdge(ne.edge) : null;
        if (curve !== null) {
          const changed = this.curveHover !== curve || this.lengthHover !== null;
          this.curveHover = curve;
          this.lengthHover = null;
          document.body.style.cursor = 'grab';
          if (changed) this.render();
          return;
        }
        this.curveHover = null;
        const next = ne && ne.dist <= EDGE_HIT * 1.5 ? { pieceId: this.activePiece, edge: ne.edge } : null;
        if (next?.pieceId !== this.lengthHover?.pieceId || next?.edge !== this.lengthHover?.edge) {
          this.lengthHover = next;
          document.body.style.cursor = next ? 'grab' : '';
          this.render();
        }
        return;
      }
      if (this.linkMode) {
        const p = this.canvasPoint(e);
        const previousPiece = this.activePiece;
        if (p) {
          this.routePieceGesture(p[0], p[1]);
          if (!this.draftPiece) this.activePiece = previousPiece;
        }
        const ne = p && this.draftPiece ? this.nearestEdge(p[0], p[1]) : null;
        const next = ne && ne.dist <= EDGE_HIT * 1.5
          ? { pieceId: this.activePiece, edge: this.logicalEdgeRepresentative(this.activePiece, ne.edge) }
          : null;
        if (next?.pieceId !== this.linkHover?.pieceId || next?.edge !== this.linkHover?.edge) {
          this.linkHover = next;
          document.body.style.cursor = next ? 'crosshair' : '';
          this.render();
        }
        return;
      }
      if (this.zipperMode) {
        const p = this.canvasPoint(e);
        const previousPiece = this.activePiece;
        if (p) {
          this.routePieceGesture(p[0], p[1]);
          if (!this.draftPiece) this.activePiece = previousPiece;
        }
        const ne = p && this.draftPiece ? this.nearestEdge(p[0], p[1]) : null;
        const next = ne && ne.dist <= EDGE_HIT * 1.5
          ? {
              pieceId: this.activePiece,
              edge: this.logicalEdgeRepresentative(this.activePiece, ne.edge),
            }
          : null;
        if (
          next?.pieceId !== this.zipperHover?.pieceId ||
          next?.edge !== this.zipperHover?.edge
        ) {
          this.zipperHover = next;
          document.body.style.cursor = next ? 'crosshair' : '';
          this.render();
        }
        return;
      }
      const p = this.canvasPoint(e);
      const surfaceEdge = p === null ? null : this.pickSurfaceEdge(p[0], p[1]);
      if (
        surfaceEdge &&
        (surfaceEdge.stitched || this.sewMode) &&
        !this.zipperMode
      ) {
        document.body.style.cursor = 'pointer';
        return;
      }
      const resizeTarget = p === null ? null : this.pickPieceResizeHandle(p[0], p[1]);
      const sameResizeTarget =
        resizeTarget?.pieceId === this.pieceResizeHover?.pieceId &&
        resizeTarget?.corner === this.pieceResizeHover?.corner;
      if (!sameResizeTarget) {
        this.pieceResizeHover = resizeTarget;
        if (resizeTarget) {
          this.draftHover = null;
          document.body.style.cursor =
            resizeTarget.corner === 'nw' || resizeTarget.corner === 'se' ? 'nwse-resize' : 'nesw-resize';
        }
        this.render();
      }
      if (resizeTarget) return;
      if (this.selectedPiece !== null) {
        const hit = p === null ? null : this.pickPiece(p[0], p[1]);
        document.body.style.cursor =
          hit !== null && this.selectedPieces.has(hit) ? 'move' : p ? 'grab' : '';
        return;
      }
      const curve = p === null ? null : this.pickCurveHandle(p[0], p[1]);
      if (curve !== this.curveHover) {
        this.curveHover = curve;
        if (curve !== null) this.draftHover = null;
        document.body.style.cursor = curve === null ? '' : 'grab';
        this.render();
      }
      if (curve !== null) return;
      const v = p === null ? null : this.pickVertex(p[0], p[1]);
      if (v !== this.draftHover) {
        this.draftHover = v;
        document.body.style.cursor = v === null ? (p ? 'grab' : '') : 'grab';
        this.render();
      } else if (v === null) {
        document.body.style.cursor = p ? 'grab' : '';
      }
      return;
    }
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left - this.drag.grabDX;
      const py = e.clientY - r.top - this.drag.grabDY;
      const h = this.handles[this.drag.index]!;
      const [lx, ly] = this.screenToLayout(px, py);
      // Undo the garment's side-by-side offset before reading the value.
      this.drag.value = handleValueFromLayout(h, lx - this.handleOffset(h), ly);
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    const p = this.canvasPoint(e);
    const i = p === null ? null : this.pickHandle(p[0], p[1]);
    if (i !== this.hover) {
      this.hover = i;
      document.body.style.cursor = i === null ? (p ? 'grab' : '') : 'grab';
      this.render();
    } else if (i === null) {
      document.body.style.cursor = p ? 'grab' : '';
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    // v177 : LA décision du clic-sec — un seul endroit, toutes branches. La
    // sélection part en microtâche pour laisser la branche du geste terminer
    // son nettoyage (curve/pan/move sans mouvement = no-op) avant de commuter.
    if (this.pieceClickPending && this.pieceClickPending.pointerId === e.pointerId) {
      const pending = this.pieceClickPending;
      this.pieceClickPending = null;
      if (
        Math.hypot(e.clientX - pending.cx, e.clientY - pending.cy) <= PIECE_CLICK_PX &&
        this.neutralPieceGesture()
      ) {
        const additive = e.metaKey || e.ctrlKey;
        // v180 : un clic sec près d'un BORD sélectionne la pièce ET cote le
        // bord — la mesure au repos de Clo. Loin des bords : mesure effacée.
        const local = this.canvasPoint(e);
        const edgeHit = local
          ? this.nearestEdgeOfPiece(pending.pieceId, local[0], local[1])
          : null;
        const measured =
          edgeHit && edgeHit.dist <= EDGE_HIT * 1.4
            ? { pieceId: pending.pieceId, edge: edgeHit.edge }
            : null;
        queueMicrotask(() => {
          if (this.pieceAt(pending.pieceId)) {
            this.applyPieceSelection(pending.pieceId, additive);
            this.measuredEdge = measured; // après la sélection (reset transitoire)
            this.render();
          }
        });
      }
    }
    if (this.curvePointDrag && e.pointerId === this.curvePointDrag.pointerId) {
      const d = this.curvePointDrag;
      this.curvePointDrag = null;
      e.preventDefault();
      e.stopPropagation();
      const piece = this.pieceAt(this.activePiece);
      if (piece) {
        // Clic sans glisser : rayon par défaut = 40 % du plus court bord voisin.
        const N = piece.outline.length;
        const M = ([u, v]: UV): [number, number] => [u * piece.width, v * piece.height];
        const P = M(piece.outline[d.vertex]!);
        const A = M(piece.outline[(d.vertex - 1 + N) % N]!);
        const B = M(piece.outline[(d.vertex + 1) % N]!);
        const shortest = Math.min(Math.hypot(P[0] - A[0], P[1] - A[1]), Math.hypot(P[0] - B[0], P[1] - B[1]));
        const radius = d.radiusM > 0.004 ? d.radiusM : 0.4 * shortest;
        this.onRoundCorner(this.activePiece, d.vertex, radius);
      }
      this.render();
      return;
    }
    if (this.internalPtDrag) {
      const d = this.internalPtDrag;
      this.internalPtDrag = null;
      e.preventDefault();
      e.stopPropagation();
      const piece = this.pieceAt(this.activePiece);
      const line = piece?.internalLines?.[d.lineIdx];
      if (line) {
        const moved = Math.hypot(
          line.points[d.ptIdx]![0] - d.orig[0],
          line.points[d.ptIdx]![1] - d.orig[1],
        ) > 1e-5;
        if (moved) {
          this.onInternalLineEdit(this.activePiece, d.lineIdx, {
            points: line.points.map((pt) => [...pt] as UV),
            ...(line.closed ? { closed: true } : {}),
            ...(line.hole ? { hole: true } : {}),
            ...(line.smooth ? { smooth: true } : {}),
          });
        }
      }
      this.render();
      return;
    }
    if (this.graphicDrag && e.pointerId === this.graphicDrag.pointerId) {
      const d = this.graphicDrag;
      this.graphicDrag = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      const changed =
        Math.hypot(
          d.preview.anchor[0] - d.start.anchor[0],
          d.preview.anchor[1] - d.start.anchor[1],
        ) > 1e-4 ||
        Math.abs(d.preview.widthM - d.start.widthM) > 1e-4 ||
        Math.abs(d.preview.rotationRad - d.start.rotationRad) > 1e-3;
      if (changed) {
        // La copie locale montre l'état final tout de suite (pas de retour en
        // arrière visuel pendant le rebuild) ; l'atelier pousse l'historique.
        const piece = this.pieceAt(d.pid);
        if (piece) this.pieces[d.pid] = { ...piece, graphic: { ...d.preview, anchor: [...d.preview.anchor] as UV } };
        this.onGraphicChange(d.pid, d.preview);
      }
      this.render();
      return;
    }
    if (this.panDrag && e.pointerId === this.panDrag.pointerId) {
      this.panDrag = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.pieceMoveDrag && e.pointerId === this.pieceMoveDrag.pointerId) {
      const d = this.pieceMoveDrag;
      const moved = Math.hypot(d.delta[0], d.delta[1]) > 1e-4;
      this.pieceMoveDrag = null;
      document.body.style.cursor = 'move';
      e.preventDefault();
      e.stopPropagation();
      if (!moved) {
        for (const member of d.members) {
          this.layoutShifts[member.pieceId] = [...member.startShift];
        }
      }
      this.render();
      return;
    }
    if (this.pieceResizeDrag && e.pointerId === this.pieceResizeDrag.pointerId) {
      const d = this.pieceResizeDrag;
      const changed = Math.abs(d.scale - 1) > 1e-4;
      this.pieceResizeDrag = null;
      this.pieceResizeHover = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      if (!changed) {
        for (const member of d.members) {
          this.pieces[member.pieceId] = this.clonePiece(member.original);
        }
        this.render();
        return;
      }
      const committed = d.members
        .map((member) => {
          const piece = this.pieceAt(member.pieceId);
          return piece ? { pieceId: member.pieceId, piece: this.clonePiece(piece)! } : null;
        })
        .filter((update): update is DraftPieceUpdate => !!update);
      const primary = committed.find((update) => update.pieceId === d.pieceId);
      if (!primary) {
        for (const member of d.members) {
          this.pieces[member.pieceId] = this.clonePiece(member.original);
        }
        this.render();
        return;
      }
      this.render();
      this.onDraftChange(
        primary.piece,
        primary.pieceId,
        undefined,
        undefined,
        committed.filter((update) => update.pieceId !== primary.pieceId),
      );
      return;
    }
    if (this.draftPiece) {
      if (this.curveLengthDrag && e.pointerId === this.curveLengthDrag.pointerId) {
        const d = this.curveLengthDrag;
        const preview = this.draftPreview;
        this.curveLengthDrag = null;
        document.body.style.cursor = '';
        e.preventDefault();
        e.stopPropagation();
        const piece = this.draftPiece;
        if (!preview || !piece) {
          this.draftPreview = null;
          this.render();
          return;
        }
        const before = d.orig[d.moving]!;
        const after = preview[d.moving]!;
        const moved = Math.abs(after[0] - before[0]) > 1e-4 || Math.abs(after[1] - before[1]) > 1e-4;
        if (!moved) {
          this.draftPreview = null;
          this.render();
          return;
        }
        const next = expandPieceForOutline(piece, preview);
        this.applyActive(next);
        this.render();
        this.onDraftChange(next, this.activePiece);
        return;
      }
      if (this.curveDrag && e.pointerId === this.curveDrag.pointerId) {
        const d = this.curveDrag;
        const preview = this.draftPreview;
        this.curveDrag = null;
        document.body.style.cursor = '';
        e.preventDefault();
        e.stopPropagation();
        const piece = this.draftPiece;
        if (!preview || !piece) {
          this.draftPreview = null;
          this.render();
          return;
        }
        const before = d.orig[d.handleIndex]!;
        const after = preview[d.handleIndex]!;
        const moved = Math.abs(after[0] - before[0]) > 1e-4 || Math.abs(after[1] - before[1]) > 1e-4;
        if (!moved) {
          this.draftPreview = null;
          this.render();
          return;
        }
        piece.outline = preview.map((q) => [q[0], q[1]] as UV);
        this.draftPreview = null;
        this.render();
        this.onDraftChange(piece, this.activePiece);
        return;
      }
      if (this.lengthDrag && e.pointerId === this.lengthDrag.pointerId) {
        const drag = this.lengthDrag;
        const preview = this.draftPreview;
        const linkedPreview = this.linkedPreview;
        this.lengthDrag = null;
        this.lengthSnap = null;
        this.linkedPreview = null;
        document.body.style.cursor = this.lengthMode ? 'grab' : '';
        e.preventDefault();
        e.stopPropagation();
        const piece = this.draftPiece;
        if (preview && piece) {
          const old = drag.orig[drag.moving]!;
          const moved = Math.abs(preview[drag.moving]![0] - old[0]) > 1e-4 || Math.abs(preview[drag.moving]![1] - old[1]) > 1e-4;
          if (moved) {
            const next = expandPieceForOutline(piece, preview);
            const linkedPieces: DraftPieceUpdate[] = [];
            if (linkedPreview && linkedPreview.pieceId !== this.activePiece) {
              const linkedPiece = this.pieceAt(linkedPreview.pieceId);
              if (linkedPiece) {
                const linkedNext = expandPieceForOutline(linkedPiece, linkedPreview.outline);
                this.pieces[linkedPreview.pieceId] = this.clonePiece(linkedNext);
                linkedPieces.push({ pieceId: linkedPreview.pieceId, piece: linkedNext });
              }
            }
            this.applyActive(next);
            this.render();
            this.onDraftChange(next, this.activePiece, undefined, undefined, linkedPieces);
          } else {
            this.draftPreview = null;
            this.render();
          }
        } else {
          this.render();
        }
        return;
      }
      // An edge press resolved: no drag → add a point; dragged inward → a dart.
      if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
        const g = this.draftEdge;
        this.draftEdge = null;
        e.preventDefault();
        e.stopPropagation();
        let next: DraftPiece;
        let reidx: AssemblySeam[] | undefined;
        let reidxLinks: AssemblySeam[] | undefined;
        if (g.apex) {
          // Dart: legs a small span either side of the mouth along the edge,
          // apex at the drag end. The wedge is cut and its legs sewn shut.
          const out = this.draftPiece.outline;
          const a = out[g.edge]!;
          const b = out[(g.edge + 1) % out.length]!;
          let dx = b[0] - a[0];
          let dy = b[1] - a[1];
          const len = Math.hypot(dx, dy) || 1e-6;
          dx /= len;
          dy /= len;
          const d = 0.045;
          const legA: UV = [g.downUV[0] - dx * d, g.downUV[1] - dy * d];
          const legB: UV = [g.downUV[0] + dx * d, g.downUV[1] + dy * d];
          next = { ...this.draftPiece, darts: [...this.draftPiece.darts, { apex: g.apex, legA, legB }] };
        } else if (g.bend && g.bend.length) {
          // Bomber : l'arc remplace le segment — ses points s'insèrent un à un
          // dans le contour (chaque insertion ré-indexe openEdges/coutures de la
          // pièce, et les coutures d'assemblage suivent pareil). Un bord cousu
          // ou ouvert qui se courbe reste donc cousu/ouvert sur tout l'arc.
          next = this.draftPiece;
          for (let j = 0; j < g.bend.length; j++) {
            next = insertOutlineVertex(next, g.edge + j, g.bend[j]!);
            this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'insert', g.edge + j + 1, next.outline.length);
            this.segmentLinks = reindexAssemblySeams(
              this.segmentLinks,
              this.activePiece,
              'insert',
              g.edge + j + 1,
              next.outline.length,
            );
          }
          reidx = this.assembly;
          reidxLinks = this.segmentLinks;
        } else {
          next = insertOutlineVertex(this.draftPiece, g.edge, g.downUV);
          // A new vertex shifts edge indices → re-index the assembly seams (on
          // this column's pieceId).
          this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'insert', g.edge + 1, next.outline.length);
          this.segmentLinks = reindexAssemblySeams(
            this.segmentLinks,
            this.activePiece,
            'insert',
            g.edge + 1,
            next.outline.length,
          );
          reidx = this.assembly;
          reidxLinks = this.segmentLinks;
        }
        this.applyActive(next);
        this.render();
        this.onDraftChange(next, this.activePiece, reidx, reidxLinks);
        return;
      }
      if (!this.draftDrag || e.pointerId !== this.draftDrag.pointerId) return;
      const preview = this.draftPreview;
      const v = this.draftDrag.vertex;
      this.draftDrag = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      const piece = this.draftPiece;
      if (preview && piece) {
        const old = piece.outline[v]!;
        const moved = Math.abs(preview[v]![0] - old[0]) > 1e-4 || Math.abs(preview[v]![1] - old[1]) > 1e-4;
        piece.outline = preview.map((q) => [q[0], q[1]] as UV);
        this.render();
        if (moved) this.onDraftChange(piece, this.activePiece); // re-cut only on a real move
      } else {
        this.render();
      }
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const h = this.handles[this.drag.index]!;
    const value = this.drag.value;
    this.drag = null;
    document.body.style.cursor = '';
    e.preventDefault();
    e.stopPropagation();
    if (Math.abs(value - h.value) > 1e-4) {
      h.value = value; // keep the preview in place while the rebuild runs
      this.render();
      this.onChange(h.id, value);
    } else {
      this.render();
    }
  };

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.panDrag && e.pointerId === this.panDrag.pointerId) {
      this.panDrag = null;
      document.body.style.cursor = '';
      return;
    }
    if (this.pieceMoveDrag && e.pointerId === this.pieceMoveDrag.pointerId) {
      const d = this.pieceMoveDrag;
      for (const member of d.members) {
        this.layoutShifts[member.pieceId] = [...member.startShift];
      }
      this.pieceMoveDrag = null;
      document.body.style.cursor = 'move';
      this.render();
      return;
    }
    if (this.pieceResizeDrag && e.pointerId === this.pieceResizeDrag.pointerId) {
      const d = this.pieceResizeDrag;
      for (const member of d.members) {
        this.pieces[member.pieceId] = this.clonePiece(member.original);
      }
      this.pieceResizeDrag = null;
      this.pieceResizeHover = null;
      document.body.style.cursor = '';
      this.render();
      return;
    }
    if (this.curveDrag && e.pointerId === this.curveDrag.pointerId) {
      this.curveDrag = null;
      this.draftPreview = null;
      document.body.style.cursor = '';
      this.render();
      return;
    }
    if (this.curveLengthDrag && e.pointerId === this.curveLengthDrag.pointerId) {
      this.curveLengthDrag = null;
      this.draftPreview = null;
      document.body.style.cursor = '';
      this.render();
      return;
    }
    if (this.lengthDrag && e.pointerId === this.lengthDrag.pointerId) {
      this.lengthDrag = null;
      this.draftPreview = null;
      this.lengthSnap = null;
      this.linkedPreview = null;
      document.body.style.cursor = '';
      this.render();
      return;
    }
    if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
      this.draftEdge = null;
      this.render();
      return;
    }
    if (this.draftDrag && e.pointerId === this.draftDrag.pointerId) {
      this.draftDrag = null;
      this.draftPreview = null; // discard the half-drag, keep the committed outline
      document.body.style.cursor = '';
      this.render();
      return;
    }
    // An interrupted gesture (OS gesture, palm rejection) must not re-cut the
    // garment with a half-dragged value: revert to the pre-drag state.
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    document.body.style.cursor = '';
    this.render();
  };

  private render(): void {
    const ctx = this.ctx;
    // Draw when there's a mesh OR a freeform draft (drawing from scratch has no
    // mesh until the outline closes).
    if (!ctx || (!this.mesh && !this.inDraft)) return;
    if (this.staticDirty) {
      this.renderStatic();
      this.staticDirty = false;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (PAL.fond !== 'transparent') {
      ctx.fillStyle = PAL.fond; // thème papier : le canvas porte son propre jour
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.drawImage(this.staticLayer, 0, 0);
    if (this.inDraft && this.pristine) return; // page blanche : grille + silhouette
    this.renderHandles();
    if (this.inDraft) this.renderDraft();
  }

  /** Draw a face's outline + vertices with no live/transient decoration — used
   * for the INACTIVE column (dimmed) so both faces are always visible. */
  /** Index de la ligne interne de la pièce ACTIVE sous (x, y) px, ou null. */
  private internalLineAt(x: number, y: number): number | null {
    const piece = this.pieceAt(this.activePiece);
    if (!piece?.internalLines?.length) return null;
    const TOL = 6;
    for (let i = 0; i < piece.internalLines.length; i++) {
      const line = piece.internalLines[i]!;
      const sp = line.points
        .map((uv) => this.vertexScreen(uv))
        .filter((s): s is [number, number] => s !== null);
      if (sp.length < 2) continue;
      const nSeg = line.closed ? sp.length : sp.length - 1;
      for (let k = 0; k < nSeg; k++) {
        const a = sp[k]!;
        const b = sp[(k + 1) % sp.length]!;
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const len2 = vx * vx + vy * vy || 1e-6;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len2));
        const d = Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
        if (d <= TOL) return i;
      }
    }
    return null;
  }

  /** ◆ Demi-largeur métrique du losange : distance PERPENDICULAIRE du point
   * (UV) à l'axe pointe-à-pointe, mesurée en espace métrique de la pièce. */
  private fisheyeHalfWidthM(uvPt: UV): number | null {
    const piece = this.pieceAt(this.activePiece);
    if (!piece || !this.dartTop || !this.dartBottom) return null;
    const W = piece.width;
    const H = piece.height;
    const ax = this.dartTop[0] * W;
    const ay = this.dartTop[1] * H;
    const bx = this.dartBottom[0] * W;
    const by = this.dartBottom[1] * H;
    const px = uvPt[0] * W;
    const py = uvPt[1] * H;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) return null;
    return Math.abs(((px - ax) * -(by - ay)) / len + ((py - ay) * (bx - ax)) / len);
  }

  /** Terminer le tracé de ligne interne (fermé ou ouvert) et le publier. */
  private commitInternalTrace(closed: boolean): void {
    const trace = this.internalTrace;
    if (!trace) return;
    const pid = this.activePiece;
    this.internalTrace = null;
    this.internalHover = null;
    this.render();
    this.onInternalLine(pid, {
      points: trace.map((pt) => [pt[0], pt[1]] as UV),
      ...(closed ? { closed: true } : {}),
    });
  }

  private drawFaceStatic(
    ctx: CanvasRenderingContext2D,
    piece: DraftPiece,
    offset: number,
    yOffset: number,
    outline: readonly UV[] = piece.outline,
    showVertices = true,
  ): void {
    if (piece.blank) return; // socle vide : rien à montrer
    const pts = outline
      .map((uv) => this.vertexScreen(uv, piece, offset, yOffset))
      .filter((s): s is [number, number] => s !== null);
    if (pts.length >= 3) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
      ctx.closePath();
      ctx.fillStyle = this.pieceFabricFill(piece, 0.13);
      ctx.fill();
      ctx.strokeStyle = PAL.contourPieceFaible;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    // ⌵ Crans de montage : trait perpendiculaire au bord, vers l'extérieur.
    if (piece.notches?.length && pts.length >= 3) {
      ctx.strokeStyle = PAL.a01;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([]);
      const W = piece.width;
      const H = piece.height;
      const N = outline.length;
      for (const notch of piece.notches) {
        // bord le plus proche (métrique) + projection
        let bestE = 0;
        let bestT = 0;
        let bestD = Infinity;
        for (let e = 0; e < N; e++) {
          const a = outline[e]!;
          const b = outline[(e + 1) % N]!;
          const ex = (b[0] - a[0]) * W;
          const ey = (b[1] - a[1]) * H;
          const px = (notch.at[0] - a[0]) * W;
          const py = (notch.at[1] - a[1]) * H;
          const len2 = ex * ex + ey * ey || 1e-12;
          const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
          const d = Math.hypot(px - t * ex, py - t * ey);
          if (d < bestD) {
            bestD = d;
            bestE = e;
            bestT = t;
          }
        }
        const a = outline[bestE]!;
        const b = outline[(bestE + 1) % N]!;
        const baseUV: UV = [a[0] + (b[0] - a[0]) * bestT, a[1] + (b[1] - a[1]) * bestT];
        const exM = (b[0] - a[0]) * W;
        const eyM = (b[1] - a[1]) * H;
        const el = Math.hypot(exM, eyM) || 1e-9;
        let nx = -eyM / el;
        let ny = exM / el;
        // vers l'EXTÉRIEUR : un pas vers n qui reste dedans → retourner
        const TICK = 0.007;
        const probe: UV = [baseUV[0] + (nx * 0.002) / W, baseUV[1] + (ny * 0.002) / H];
        if (pointInPolygon(probe, outline)) {
          nx = -nx;
          ny = -ny;
        }
        const tipUV: UV = [baseUV[0] + (nx * TICK) / W, baseUV[1] + (ny * TICK) / H];
        const s0 = this.vertexScreen(baseUV, piece, offset, yOffset);
        const s1 = this.vertexScreen(tipUV, piece, offset, yOffset);
        if (s0 && s1) {
          // Plancher d'affichage : 7 mm réels mais JAMAIS moins de 7 px à
          // l'écran — le cran reste lisible dézoomé (l'export garde ses mm).
          let dx = s1[0] - s0[0];
          let dy = s1[1] - s0[1];
          const dl = Math.hypot(dx, dy);
          if (dl > 1e-6 && dl < 7) {
            dx = (dx / dl) * 7;
            dy = (dy / dl) * 7;
          }
          ctx.beginPath();
          ctx.moveTo(s0[0], s0[1]);
          ctx.lineTo(s0[0] + dx, s0[1] + dy);
          ctx.stroke();
        }
      }
    }
    // ▱ Lignes internes : style, pliures, repères — en pointillé fin.
    if (piece.internalLines?.length) {
      ctx.strokeStyle = PAL.ligneInterne;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      for (const line of piece.internalLines) {
        const renderPts = line.smooth && line.points.length >= 3
          ? catmullRomSubdivide(line.points, !!line.closed)
          : line.points;
        const lp = renderPts
          .map((uv) => this.vertexScreen(uv, piece, offset, yOffset))
          .filter((s): s is [number, number] => s !== null);
        if (lp.length < 2) continue;
        ctx.beginPath();
        lp.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        if (line.closed) ctx.closePath();
        if (line.hole && line.closed) {
          ctx.save();
          ctx.fillStyle = PAL.a02;
          ctx.fill();
          ctx.setLineDash([]);
          ctx.strokeStyle = PAL.ligneInterneForte;
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.restore();
          ctx.strokeStyle = PAL.ligneInterne;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([6, 4]);
        } else {
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }
    if (!showVertices) return;
    const hidden = logicalCurveInteriorIndices(logicalCurveRuns(piece, outline));
    for (let i = 0; i < pts.length; i++) {
      if (hidden.has(i)) continue;
      const s = pts[i]!;
      ctx.beginPath();
      ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = PAL.hachureTrou;
      ctx.fill();
    }
  }

  private drawSurfaceAttachments(ctx: CanvasRenderingContext2D): void {
    const draw = (
      pieceId: number,
      surface: NonNullable<NonNullable<DraftPiece['placement']>['surface']>,
      preview: boolean,
    ): void => {
      const piece = this.pieceAt(pieceId);
      const support = this.pieceAt(surface.supportPieceId);
      const points = this.surfaceScreenPoints(pieceId, surface);
      if (!piece || !support || !points || points.length < 3) return;
      const stitched = new Set(surface.stitchedEdges);
      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) =>
        index === 0 ? ctx.moveTo(point[0], point[1]) : ctx.lineTo(point[0], point[1]),
      );
      ctx.closePath();
      const under = surface.side === 'under';
      ctx.fillStyle = preview
        ? PAL.a03
        : under
          ? PAL.a04
          : PAL.a05;
      ctx.fill();
      if (under && !preview) ctx.setLineDash([4, 4]); // sous le support : en creux

      for (let edge = 0; edge < points.length; edge++) {
        const a = points[edge]!;
        const b = points[(edge + 1) % points.length]!;
        const sewn = preview || stitched.has(edge);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.strokeStyle = preview
          ? PAL.a06
          : sewn
            ? PAL.a07
            : PAL.crochetNeutre;
        ctx.lineWidth = sewn ? 3 : 1.5;
        ctx.setLineDash(sewn ? [2, 3] : [7, 4]);
        ctx.stroke();
        if (!preview && sewn) {
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          ctx.setLineDash([]);
          ctx.fillStyle = PAL.a08;
          ctx.strokeStyle = PAL.a09;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(mx, my, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(mx - 2.2, my - 2.2);
          ctx.lineTo(mx + 2.2, my + 2.2);
          ctx.moveTo(mx + 2.2, my - 2.2);
          ctx.lineTo(mx - 2.2, my + 2.2);
          ctx.stroke();
        }
      }

      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const label = preview
        ? `PLACER ${this.pieceLabel(pieceId)} SUR ${this.pieceLabel(surface.supportPieceId)}`
        : `${this.pieceLabel(pieceId)} · ${stitched.size}/${points.length} coutures · cliquer × = retirer`;
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const y = Math.min(...ys) - 5;
      const width = ctx.measureText(label).width + 10;
      ctx.setLineDash([]);
      ctx.fillStyle = PAL.a10;
      ctx.fillRect(x - width / 2, y - 12, width, 14);
      ctx.fillStyle = preview ? PAL.a11 : PAL.a12;
      ctx.fillText(label, x, y - 1);
      ctx.restore();
    };

    for (let pieceId = 2; pieceId < this.pieces.length; pieceId++) {
      const surface = this.pieceAt(pieceId)?.placement?.surface;
      if (
        surface &&
        !(pieceId === this.surfacePlacementPieceId && this.surfacePlacementHover)
      ) {
        draw(pieceId, surface, false);
      }
    }
    const pieceId = this.surfacePlacementPieceId;
    const hover = this.surfacePlacementHover;
    const piece = pieceId === null ? null : this.pieceAt(pieceId);
    if (pieceId !== null && piece && hover) {
      draw(
        pieceId,
        {
          supportPieceId: hover.supportPieceId,
          anchor: hover.anchor,
          stitchedEdges: defaultSurfaceStitches(piece),
        },
        true,
      );
    }
  }

  private drawPieceSelection(
    ctx: CanvasRenderingContext2D,
    pid: number,
    primary: boolean,
  ): void {
    const piece = this.pieceAt(pid);
    if (!piece) return;
    const pts = piece.outline
      .map((uv) => this.vertexScreen(uv, piece, this.pieceOffset(pid), this.pieceYOffset(pid)))
      .filter((point): point is [number, number] => point !== null);
    if (pts.length !== piece.outline.length || pts.length < 3) return;
    const xs = pts.map((point) => point[0]);
    const ys = pts.map((point) => point[1]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    ctx.save();
    ctx.beginPath();
    pts.forEach((point, index) =>
      index === 0 ? ctx.moveTo(point[0], point[1]) : ctx.lineTo(point[0], point[1]),
    );
    ctx.closePath();
    ctx.fillStyle = primary ? PAL.a13 : PAL.a14;
    ctx.fill();
    ctx.strokeStyle = primary ? PAL.a15 : PAL.a16;
    ctx.lineWidth = primary ? 2.4 : 2;
    ctx.setLineDash([]);
    ctx.stroke();

    ctx.strokeStyle = primary ? PAL.a17 : PAL.a18;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.setLineDash([]);
    for (const handle of this.pieceResizeHandles(pid)) {
      const active =
        this.pieceResizeDrag?.pieceId === pid &&
        this.pieceResizeDrag.corner === handle.corner;
      const hovered =
        this.pieceResizeHover?.pieceId === pid &&
        this.pieceResizeHover.corner === handle.corner;
      const size = active || hovered ? 11 : 9;
      ctx.fillStyle = active ? PAL.a19 : PAL.sommetNeutre;
      ctx.strokeStyle = active
        ? PAL.a20
        : primary
          ? PAL.a21
          : PAL.a22;
      ctx.lineWidth = 2;
      ctx.fillRect(handle.screen[0] - size / 2, handle.screen[1] - size / 2, size, size);
      ctx.strokeRect(handle.screen[0] - size / 2, handle.screen[1] - size / 2, size, size);
    }

    if (primary) {
      const count = this.selectedPieces.size;
      const label = this.pieceResizeDrag
        ? count > 1
          ? `${count} pièces · échelle ×${this.pieceResizeDrag.scale.toFixed(2)}`
          : 'taille globale'
        : this.pieceMoveDrag
          ? count > 1
            ? `${count} pièces · mise en page groupée`
            : `mise en page Δ ${Math.round(this.pieceMoveDrag.delta[0] * 100)} / ${Math.round(this.pieceMoveDrag.delta[1] * 100)} cm`
          : count > 1
            ? `${count} pièces sélectionnées · coins = taille commune`
            : 'mise en page 2D · glisser = déplacer · coins = taille';
      ctx.font = '600 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labelW = ctx.measureText(label).width + 12;
      const labelX = (left + right) / 2;
      const labelY = Math.max(15, top - 7);
      ctx.fillStyle = PAL.a23;
      ctx.fillRect(labelX - labelW / 2, labelY - 14, labelW, 15);
      ctx.fillStyle = PAL.a24;
      ctx.fillText(label, labelX, labelY - 2);
    }
    ctx.restore();
  }

  /** Active pen workspace: unmistakable slot, instruction and invalid-click feedback. */
  private drawPenDrawingZone(ctx: CanvasRenderingContext2D): void {
    const zone = this.penDrawingZone();
    if (!zone) return;
    const left = Math.max(1, zone.left);
    const right = Math.min(this.canvas.width - 1, zone.right);
    const top = Math.max(1, zone.top);
    const bottom = Math.min(this.canvas.height - 1, zone.bottom);
    if (right <= left || bottom <= top) return;

    const alert = this.penFeedback !== null;
    const active = this.penPointerInside === true;
    ctx.save();
    ctx.fillStyle = active
      ? PAL.a25
      : PAL.a26;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = alert
      ? PAL.a19
      : active
        ? PAL.a27
        : PAL.a28;
    ctx.lineWidth = alert ? 3 : 2.4;
    ctx.setLineDash([9, 5]);
    ctx.strokeRect(left + 1, top + 1, right - left - 2, bottom - top - 2);
    ctx.setLineDash([]);

    const title = `✎ ZONE ACTIVE · PIÈCE ${this.activePiece + 1}`;
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const titleWidth = Math.min(right - left - 12, ctx.measureText(title).width + 18);
    const titleX = (left + right) / 2;
    const titleY = top + 17;
    ctx.fillStyle = alert ? PAL.a29 : PAL.a30;
    ctx.fillRect(titleX - titleWidth / 2, top + 5, titleWidth, 24);
    ctx.fillStyle = alert ? PAL.a31 : PAL.a32;
    ctx.fillText(title, titleX, titleY);

    if (bottom - top > 85 && right - left > 170) {
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.fillStyle = PAL.a33;
      ctx.fillText('Cliquez pour placer les points', titleX, top + 43);
    }

    if (this.penFeedback) {
      const message = `⚠ ${this.penFeedback}`;
      ctx.font = '700 11px ui-monospace, monospace';
      const feedbackWidth = Math.min(
        this.canvas.width - 20,
        Math.max(190, ctx.measureText(message).width + 24),
      );
      const feedbackX = Math.min(
        this.canvas.width - feedbackWidth / 2 - 10,
        Math.max(feedbackWidth / 2 + 10, titleX),
      );
      const feedbackY = Math.min(bottom - 24, Math.max(top + 72, this.canvas.height - 42));
      ctx.fillStyle = PAL.a34;
      ctx.fillRect(feedbackX - feedbackWidth / 2, feedbackY - 17, feedbackWidth, 34);
      ctx.strokeStyle = PAL.a19;
      ctx.lineWidth = 2;
      ctx.strokeRect(feedbackX - feedbackWidth / 2, feedbackY - 17, feedbackWidth, 34);
      ctx.fillStyle = PAL.a35;
      ctx.fillText(message, feedbackX, feedbackY);
    }
    ctx.restore();
  }

  /**
   * Raw pointer ghost for ↔ Longueur.
   *
   * The solid outline remains the exact axis-projected production preview. The
   * neutral dashed outline follows the unconstrained pointer, while the cyan
   * arrows expose the direction that actually changes the length. Smart guides
   * and snapping remain completely independent from this explanatory overlay.
   */
  private drawAxisLengthGesture(
    ctx: CanvasRenderingContext2D,
    pts: readonly [number, number][],
  ): void {
    const gesture = this.lengthDrag ?? this.curveLengthDrag;
    if (!gesture || !this.tf) return;
    const fixed = pts[gesture.fixed];
    const projected = pts[gesture.moving];
    const originalFixed = this.vertexScreen(gesture.orig[gesture.fixed]!);
    const originalMoving = this.vertexScreen(gesture.orig[gesture.moving]!);
    if (!fixed || !projected || !originalFixed || !originalMoving) return;

    const dx = originalMoving[0] - originalFixed[0];
    const dy = originalMoving[1] - originalFixed[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-3) return;
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const raw = gesture.rawPointerScreen;
    // Preserve the complete pointer-to-endpoint offset, including the normal
    // component of a bowed curve or a slightly off-edge press. The ghost now
    // starts exactly on the endpoint and follows the raw hand without jumping.
    const ghost: [number, number] = [
      raw[0] + gesture.pointerToMovingScreen[0],
      raw[1] + gesture.pointerToMovingScreen[1],
    ];
    const axisStart: [number, number] = [
      originalFixed[0] - ux * 30,
      originalFixed[1] - uy * 30,
    ];
    const axisEnd: [number, number] = [
      originalMoving[0] + ux * 30,
      originalMoving[1] + uy * 30,
    ];

    ctx.save();
    // Effective axis: deliberately cyan, distinct from the yellow/violet/green
    // construction relations already used by the smart guides.
    ctx.strokeStyle = PAL.a36;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(axisStart[0], axisStart[1]);
    ctx.lineTo(axisEnd[0], axisEnd[1]);
    ctx.stroke();
    ctx.setLineDash([]);

    const arrow = (
      tip: readonly [number, number],
      direction: readonly [number, number],
    ): void => {
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(
        tip[0] - direction[0] * 8 + nx * 4,
        tip[1] - direction[1] * 8 + ny * 4,
      );
      ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(
        tip[0] - direction[0] * 8 - nx * 4,
        tip[1] - direction[1] * 8 - ny * 4,
      );
      ctx.stroke();
    };
    arrow(axisStart, [-ux, -uy]);
    arrow(axisEnd, [ux, uy]);

    // Unconstrained ghost requested by the hand, then its rejected normal
    // component back to the effective projected endpoint.
    ctx.strokeStyle = PAL.pinceTrait;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(fixed[0], fixed[1]);
    ctx.lineTo(ghost[0], ghost[1]);
    ctx.moveTo(ghost[0], ghost[1]);
    ctx.lineTo(projected[0], projected[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ghost[0], ghost[1], 5.5, 0, Math.PI * 2);
    ctx.fillStyle = PAL.pinceFond;
    ctx.fill();
    ctx.strokeStyle = PAL.pinceTraitFort;
    ctx.stroke();

    if (gesture.intent.mostlyPerpendicular) {
      const fullLabel =
        '↔ Glissez dans le sens du bord pour changer sa longueur';
      ctx.font = '700 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const availableW = Math.max(40, this.canvas.width - 12);
      const lines =
        ctx.measureText(fullLabel).width + 14 <= availableW
          ? [fullLabel]
          : ['↔ Glissez le long du bord', 'pour changer sa longueur'];
      const labelW = Math.min(
        availableW,
        Math.max(...lines.map((line) => ctx.measureText(line).width)) + 14,
      );
      const lineHeight = 12;
      const labelH = lines.length * lineHeight + 6;
      const labelX = Math.min(
        this.canvas.width - labelW / 2 - 6,
        Math.max(labelW / 2 + 6, raw[0]),
      );
      const preferredY =
        raw[1] + labelH + 10 < this.canvas.height
          ? raw[1] + labelH / 2 + 10
          : raw[1] - labelH / 2 - 10;
      const labelY = Math.min(
        this.canvas.height - labelH / 2 - 4,
        Math.max(labelH / 2 + 4, preferredY),
      );
      ctx.fillStyle = PAL.a37;
      ctx.fillRect(
        labelX - labelW / 2,
        labelY - labelH / 2,
        labelW,
        labelH,
      );
      ctx.fillStyle = PAL.a38;
      lines.forEach((line, index) => {
        ctx.fillText(
          line,
          labelX,
          labelY + (index - (lines.length - 1) / 2) * lineHeight,
        );
      });
    }
    ctx.restore();
  }

  /** Freeform outline: the live preview polygon (while dragging) + vertex handles. */
  private renderDraft(): void {
    const ctx = this.ctx;
    if (!ctx || !this.tf) return;
    if (this.penMode) this.drawPenDrawingZone(ctx);
    // Every INACTIVE column first (dimmed, underneath the active one).
    for (let pid = 0; pid < this.nCols; pid++) {
      if (pid === this.activePiece) continue;
      const p = this.pieceAt(pid);
      if (p) {
        const preview = this.linkedPreview?.pieceId === pid ? this.linkedPreview.outline : p.outline;
        const selected = this.selectedPieces.has(pid);
        this.drawFaceStatic(
          ctx,
          p,
          this.pieceOffset(pid),
          this.pieceYOffset(pid),
          preview,
          !selected,
        );
        if (selected) this.drawPieceSelection(ctx, pid, pid === this.selectedPiece);
      }
    }
    if (!this.draftPiece) return;

    // Pen: draw the growing polyline + points; the first point glows once the
    // shape can be closed.
    if (this.penMode) {
      const sp = this.penPoints.map((uv) => this.vertexScreen(uv)).filter((s): s is [number, number] => s !== null);
      // ⋈ Miroir au tracé : l'axe vertical du 1er point + l'écho de la moitié
      // dessinée, en direct — ce qui se fermera est exactement ce qui s'affiche.
      if (this.penMirror && this.penPoints.length >= 1 && sp.length === this.penPoints.length) {
        const axisU = this.penPoints[0]![0];
        const a0 = this.vertexScreen([axisU, 0] as UV);
        const a1 = this.vertexScreen([axisU, 1] as UV);
        if (a0 && a1) {
          ctx.strokeStyle = PAL.a39;
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 5]);
          ctx.beginPath();
          ctx.moveTo(a0[0], a0[1]);
          ctx.lineTo(a1[0], a1[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (this.penPoints.length >= 2) {
          const echo = this.penPoints
            .slice(1)
            .map(([u, v]) => this.vertexScreen([2 * axisU - u, v] as UV))
            .filter((s): s is [number, number] => s !== null)
            .reverse();
          if (echo.length) {
            ctx.strokeStyle = PAL.a40;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            // dernier point dessiné → son écho → … → écho du 2e → 1er point (axe)
            ctx.moveTo(sp[sp.length - 1]![0], sp[sp.length - 1]![1]);
            for (const s of echo) ctx.lineTo(s[0], s[1]);
            ctx.lineTo(sp[0]![0], sp[0]![1]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
      if (sp.length) {
        ctx.strokeStyle = PAL.a41;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        sp.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        ctx.stroke();
        for (let i = 0; i < sp.length; i++) {
          const closable = i === 0 && sp.length >= (this.penMirror ? 2 : 3);
          ctx.beginPath();
          ctx.arc(sp[i]![0], sp[i]![1], closable ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = closable ? PAL.a42 : PAL.pointNeutre;
          ctx.fill();
        }
      }
      return;
    }

    const out = this.draftPreview ?? this.draftPiece.outline;
    const pts = out.map((uv) => this.vertexScreen(uv)).filter((s): s is [number, number] => s !== null);
    if (pts.length !== out.length) return;
    const wholeSelected = this.selectedPieces.has(this.activePiece);

    // ⧢ Aperçu de l'évasement : le pivot retenu + l'entaille vers le curseur.
    if (this.fullnessMode && this.fullnessPick && this.fullnessPick.pieceId === this.activePiece) {
      const piece = this.pieceAt(this.activePiece);
      if (piece) {
        const N = piece.outline.length;
        const a = piece.outline[this.fullnessPick.edge % N]!;
        const b = piece.outline[(this.fullnessPick.edge + 1) % N]!;
        const pivotUV: UV = [
          a[0] + (b[0] - a[0]) * this.fullnessPick.t,
          a[1] + (b[1] - a[1]) * this.fullnessPick.t,
        ];
        const sp = this.vertexScreen(pivotUV);
        if (sp) {
          ctx.fillStyle = PAL.a43;
          ctx.beginPath();
          ctx.arc(sp[0], sp[1], 5, 0, Math.PI * 2);
          ctx.fill();
          if (this.fullnessHover) {
            ctx.strokeStyle = PAL.a44;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([7, 5]);
            ctx.beginPath();
            ctx.moveTo(sp[0], sp[1]);
            ctx.lineTo(this.fullnessHover[0], this.fullnessHover[1]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
    }
    // ∿ Aperçu du point courbe : l'arc fantôme au rayon du drag, cm affichés.
    if (this.curvePointDrag) {
      const piece = this.pieceAt(this.activePiece);
      if (piece) {
        const N = piece.outline.length;
        const i = this.curvePointDrag.vertex;
        const W = piece.width;
        const H = piece.height;
        const M = ([u, v]: UV): [number, number] => [u * W, v * H];
        const P = M(piece.outline[i]!);
        const A = M(piece.outline[(i - 1 + N) % N]!);
        const B = M(piece.outline[(i + 1) % N]!);
        const lenIn = Math.hypot(P[0] - A[0], P[1] - A[1]);
        const lenOut = Math.hypot(P[0] - B[0], P[1] - B[1]);
        if (lenIn > 1e-6 && lenOut > 1e-6) {
          const rRaw = this.curvePointDrag.radiusM > 0.004
            ? this.curvePointDrag.radiusM
            : 0.4 * Math.min(lenIn, lenOut);
          const r = Math.min(Math.max(rRaw, 0.003), 0.45 * Math.min(lenIn, lenOut));
          const start = [P[0] + ((A[0] - P[0]) * r) / lenIn, P[1] + ((A[1] - P[1]) * r) / lenIn];
          const end = [P[0] + ((B[0] - P[0]) * r) / lenOut, P[1] + ((B[1] - P[1]) * r) / lenOut];
          ctx.strokeStyle = PAL.a42;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          let started = false;
          for (let j = 0; j <= 12; j++) {
            const t = j / 12;
            const x = (1 - t) * (1 - t) * start[0]! + 2 * (1 - t) * t * P[0] + t * t * end[0]!;
            const y = (1 - t) * (1 - t) * start[1]! + 2 * (1 - t) * t * P[1] + t * t * end[1]!;
            const sp = this.vertexScreen([x / W, y / H]);
            if (!sp) continue;
            if (started) ctx.lineTo(sp[0], sp[1]);
            else {
              ctx.moveTo(sp[0], sp[1]);
              started = true;
            }
          }
          ctx.stroke();
          const sc = this.vertexScreen(piece.outline[i]!);
          if (sc) {
            const label = `r ${(r * 100).toFixed(1).replace('.', ',')} cm`;
            ctx.font = '600 11px Inter, ui-sans-serif, sans-serif';
            ctx.textAlign = 'center';
            const w = ctx.measureText(label).width;
            ctx.fillStyle = PAL.a45;
            ctx.fillRect(sc[0] - w / 2 - 5, sc[1] - 26, w + 10, 16);
            ctx.fillStyle = PAL.a46;
            ctx.fillText(label, sc[0], sc[1] - 14);
            ctx.textAlign = 'start';
          }
        }
      }
    }
    // ◆ Aperçu de la pince losange : axe pointe-à-pointe, puis losange
    // fantôme dont la taille suit le curseur, largeur en cm affichée.
    if (this.dartMode && this.dartTop) {
      const sTop = this.vertexScreen(this.dartTop);
      if (sTop) {
        ctx.fillStyle = PAL.a42;
        ctx.beginPath();
        ctx.arc(sTop[0], sTop[1], 4.5, 0, Math.PI * 2);
        ctx.fill();
        const sBottom = this.dartBottom ? this.vertexScreen(this.dartBottom) : null;
        if (!this.dartBottom && this.dartHover) {
          ctx.strokeStyle = PAL.a47;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(sTop[0], sTop[1]);
          ctx.lineTo(this.dartHover[0], this.dartHover[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (sBottom) {
          ctx.fillStyle = PAL.a42;
          ctx.beginPath();
          ctx.arc(sBottom[0], sBottom[1], 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = PAL.a48;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(sTop[0], sTop[1]);
          ctx.lineTo(sBottom[0], sBottom[1]);
          ctx.stroke();
          ctx.setLineDash([]);
          if (this.dartHover) {
            const hoverUV = this.screenToUV(this.dartHover[0], this.dartHover[1]);
            const half = this.fisheyeHalfWidthM(hoverUV);
            const piece = this.pieceAt(this.activePiece);
            if (half !== null && piece) {
              // Taille du losange : perpendiculaire MÉTRIQUE au milieu de l'axe.
              const W = piece.width;
              const H = piece.height;
              const ax = this.dartTop[0] * W;
              const ay = this.dartTop[1] * H;
              const bx = this.dartBottom![0] * W;
              const by = this.dartBottom![1] * H;
              const len = Math.hypot(bx - ax, by - ay) || 1e-9;
              const nx = -(by - ay) / len;
              const ny = (bx - ax) / len;
              const mx = (ax + bx) / 2;
              const my = (ay + by) / 2;
              const wl: UV = [(mx - nx * half) / W, (my - ny * half) / H];
              const wr: UV = [(mx + nx * half) / W, (my + ny * half) / H];
              const sl = this.vertexScreen(wl);
              const sr = this.vertexScreen(wr);
              if (sl && sr) {
                ctx.strokeStyle = PAL.a42;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(sTop[0], sTop[1]);
                ctx.lineTo(sl[0], sl[1]);
                ctx.lineTo(sBottom[0], sBottom[1]);
                ctx.lineTo(sr[0], sr[1]);
                ctx.closePath();
                ctx.stroke();
                const label = `${(2 * half * 100).toFixed(1).replace('.', ',')} cm`;
                ctx.font = '600 11px Inter, ui-sans-serif, sans-serif';
                ctx.textAlign = 'center';
                const mid = this.vertexScreen([(wl[0] + wr[0]) / 2, (wl[1] + wr[1]) / 2]);
                if (mid) {
                  const w = ctx.measureText(label).width;
                  ctx.fillStyle = PAL.a45;
                  ctx.fillRect(mid[0] - w / 2 - 5, mid[1] - 22, w + 10, 16);
                  ctx.fillStyle = PAL.a46;
                  ctx.fillText(label, mid[0], mid[1] - 10);
                }
                ctx.textAlign = 'start';
              }
            }
          }
        }
      }
    }
    // ▱ Tracé de ligne interne en cours : points posés + fil vers le curseur ;
    // le 1er point s'allume quand le polygone peut se fermer, le dernier quand
    // la polyligne peut se terminer.
    if (this.internalMode && this.internalTrace) {
      const sp = this.internalTrace
        .map((uv) => this.vertexScreen(uv))
        .filter((s): s is [number, number] => s !== null);
      if (sp.length) {
        ctx.strokeStyle = PAL.ligneInterneVive;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        sp.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        ctx.stroke();
        if (this.internalHover) {
          ctx.strokeStyle = PAL.ligneInterneDouce;
          ctx.beginPath();
          ctx.moveTo(sp[sp.length - 1]![0], sp[sp.length - 1]![1]);
          ctx.lineTo(this.internalHover[0], this.internalHover[1]);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        for (let i = 0; i < sp.length; i++) {
          const closable = i === 0 && sp.length >= 3;
          const endable = i === sp.length - 1 && sp.length >= 2 && i !== 0;
          ctx.beginPath();
          ctx.arc(sp[i]![0], sp[i]![1], closable || endable ? 6 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = closable
            ? PAL.a42
            : endable
              ? PAL.a43
              : PAL.pointNeutre;
          ctx.fill();
        }
      }
    }
    // ✂ Aperçu de la corde de découpe : du 1er point posé au curseur.
    if (this.cutMode && this.cutPick && this.cutPick.pieceId === this.activePiece) {
      const a = pts[this.cutPick.edge % pts.length]!;
      const b = pts[(this.cutPick.edge + 1) % pts.length]!;
      const px = a[0] + (b[0] - a[0]) * this.cutPick.t;
      const py = a[1] + (b[1] - a[1]) * this.cutPick.t;
      if (this.cutHover) {
        ctx.strokeStyle = PAL.a42;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([7, 5]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(this.cutHover[0], this.cutHover[1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = PAL.a42;
      ctx.fill();
    }

    // The piece outline: a filled shape with its cut edges (vector, CAD-style).
    if (pts.length >= 3) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
      ctx.closePath();
      ctx.fillStyle = wholeSelected
        ? PAL.a13
        : this.pieceFabricFill(this.draftPiece, 0.2);
      ctx.fill();
      ctx.strokeStyle = wholeSelected ? PAL.a15 : PAL.contourPiece;
      ctx.lineWidth = wholeSelected ? 2.4 : 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    if (wholeSelected) {
      this.drawPieceSelection(ctx, this.activePiece, this.activePiece === this.selectedPiece);
    }

    // One smooth run = one editor segment. Its dense source samples disappear;
    // only its endpoints (ordinary round handles) and one diamond curvature
    // handle remain. The simulation still receives every source point.
    const curves = logicalCurveRuns(this.draftPiece, out);
    const curveInterior = logicalCurveInteriorIndices(curves);
    for (let i = 0; i < pts.length && !wholeSelected; i++) {
      const s = pts[i]!;
      const active = this.draftDrag?.vertex === i;
      const hovered = this.draftHover === i;
      if (curveInterior.has(i)) continue;
      const r = active || hovered ? 6.5 : 4.5;
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = PAL.pointNeutre;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? PAL.a42 : PAL.a49;
      ctx.stroke();
    }
    if (!wholeSelected) {
      for (let curveIndex = 0; curveIndex < curves.length; curveIndex++) {
        const handle = logicalCurveHandle(curves[curveIndex]!);
        const s = pts[handle.index]!;
        const activeRun = this.curveDrag?.run ?? this.curveLengthDrag?.run;
        const active = activeRun?.from === curves[curveIndex]!.from && activeRun?.to === curves[curveIndex]!.to;
        const hovered = this.curveHover === curveIndex;
        const radius = active || hovered ? 7 : 5.5;
        ctx.save();
        ctx.translate(s[0], s[1]);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = active ? PAL.a19 : PAL.a50;
        ctx.strokeStyle = PAL.a51;
        ctx.lineWidth = 2;
        ctx.fillRect(-radius / 1.45, -radius / 1.45, (radius * 2) / 1.45, (radius * 2) / 1.45);
        ctx.strokeRect(-radius / 1.45, -radius / 1.45, (radius * 2) / 1.45, (radius * 2) / 1.45);
        ctx.restore();
        if (hovered || active) {
          ctx.font = '600 10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = active ? 'courbe unique' : 'tirer la courbe';
          const w = ctx.measureText(label).width + 10;
          ctx.fillStyle = PAL.a23;
          ctx.fillRect(s[0] - w / 2, s[1] - 24, w, 15);
          ctx.fillStyle = PAL.a52;
          ctx.fillText(label, s[0], s[1] - 11);
        }
      }
    }

    // ↔ LONGUEUR on a curve: the whole arc lights up, both endpoints are
    // explicit, and the live label reports the complete arc rather than one
    // hidden sampling edge.
    const lengthCurve =
      this.curveLengthDrag?.run ??
      (this.lengthMode && this.curveHover !== null ? curves[this.curveHover] ?? null : null);
    if (!wholeSelected && lengthCurve) {
      ctx.save();
      ctx.strokeStyle = PAL.a53;
      ctx.lineWidth = 3.2;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < lengthCurve.indices.length; i++) {
        const s = pts[lengthCurve.indices[i]!]!;
        if (i === 0) ctx.moveTo(s[0], s[1]);
        else ctx.lineTo(s[0], s[1]);
      }
      ctx.stroke();
      for (const idx of [lengthCurve.from, lengthCurve.to]) {
        const s = pts[idx]!;
        const moving = this.curveLengthDrag?.moving === idx;
        ctx.beginPath();
        ctx.arc(s[0], s[1], moving ? 7 : 5.5, 0, Math.PI * 2);
        ctx.fillStyle = moving ? PAL.a19 : PAL.a54;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = PAL.a55;
        ctx.stroke();
      }
      const handle = logicalCurveHandle(lengthCurve);
      const hs = pts[handle.index]!;
      const lengthCm = logicalCurveLengthM(this.draftPiece, out, lengthCurve) * 100;
      const label = `courbe · ${lengthCm.toFixed(1).replace('.', ',')} cm · tirer une extrémité`;
      ctx.font = '700 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const w = ctx.measureText(label).width + 12;
      const y = Math.max(16, hs[1] - 16);
      ctx.fillStyle = PAL.a56;
      ctx.fillRect(hs[0] - w / 2, y - 14, w, 15);
      ctx.fillStyle = PAL.a57;
      ctx.fillText(label, hs[0], y - 2);
      ctx.restore();
    }

    this.drawAxisLengthGesture(ctx, pts);

    // ↔ LONGUEUR : le segment actif devient une cote de patron lisible. La
    // ligne de mesure est placée à l'extérieur de la pièce, avec prolongements,
    // flèches et valeur en centimètres mise à jour pendant le glisser.
    const lengthTarget = this.lengthDrag
      ? { pieceId: this.activePiece, edge: this.lengthDrag.edge }
      : this.lengthMode
        ? this.lengthHover
        : null;
    let lengthGuides:
      | {
          angleDeg: number;
          parallelCount: number;
          nearParallelCount: number;
          equalCount: number;
          nearEqualCount: number;
          rightStart: boolean;
          rightEnd: boolean;
          snap: SegmentSnapSuggestion | null;
          matches: Array<{
            pieceId: number;
            edge: number;
            parallel: boolean;
            nearParallel: boolean;
            equal: boolean;
            nearEqual: boolean;
            angleDelta: number;
            lengthDelta: number;
            lengthM: number;
          }>;
        }
      | null = null;
    if (lengthTarget?.pieceId === this.activePiece && pts.length >= 2) {
      const targetEdge = ((lengthTarget.edge % out.length) + out.length) % out.length;
      const targetGeometry = outlineEdgeGeometry(this.draftPiece, out, targetEdge);
      if (targetGeometry) {
        const allMatches: Array<{
          pieceId: number;
          edge: number;
          parallel: boolean;
          nearParallel: boolean;
          equal: boolean;
          nearEqual: boolean;
          angleDelta: number;
          lengthDelta: number;
          lengthM: number;
        }> = [];
        const MIN_GUIDE_LENGTH_M = 0.03; // ignore tiny curve samples: visual noise, not construction lines
        for (let pid = 0; pid < this.nCols; pid++) {
          const piece = this.pieceAt(pid);
          if (!piece) continue;
          const candidateOutline = pid === this.activePiece ? out : piece.outline;
          for (let edge = 0; edge < candidateOutline.length; edge++) {
            if (pid === this.activePiece && edge === targetEdge) continue;
            const geometry = outlineEdgeGeometry(piece, candidateOutline, edge);
            if (!geometry || geometry.lengthM < MIN_GUIDE_LENGTH_M) continue;
            // Exact construction relation (≤0.50°, ≤1 mm) versus a nearby
            // suggestion (≤1.50°, ≤5 mm). A near match is NEVER labelled exact.
            const exact = segmentRelation(targetGeometry, geometry);
            const nearby = segmentRelation(targetGeometry, geometry, 1.5, 0.005);
            const parallel = exact.parallel;
            const nearParallel = !parallel && nearby.parallel;
            const equal = targetGeometry.lengthM >= MIN_GUIDE_LENGTH_M && exact.equalLength;
            const nearEqual = targetGeometry.lengthM >= MIN_GUIDE_LENGTH_M && !equal && nearby.equalLength;
            if (!parallel && !nearParallel && !equal && !nearEqual) continue;
            allMatches.push({
              pieceId: pid,
              edge,
              parallel,
              nearParallel,
              equal,
              nearEqual,
              angleDelta: exact.angleDeltaDeg,
              lengthDelta: Math.abs(targetGeometry.lengthM - geometry.lengthM),
              lengthM: geometry.lengthM,
            });
          }
        }
        // The most useful matches stay visible first: exact/equal, then closest
        // angular and length relations. A cap keeps sampled curves from flooding
        // a dense imported pattern.
        allMatches.sort(
          (a, b) =>
            Number(b.equal) - Number(a.equal) ||
            Number(b.parallel) - Number(a.parallel) ||
            Number(b.nearEqual) - Number(a.nearEqual) ||
            Number(b.nearParallel) - Number(a.nearParallel) ||
            a.angleDelta - b.angleDelta ||
            a.lengthDelta - b.lengthDelta,
        );
        const prevEdge = (targetEdge + out.length - 1) % out.length;
        const nextEdge = (targetEdge + 1) % out.length;
        const prevGeometry = outlineEdgeGeometry(this.draftPiece, out, prevEdge);
        const nextGeometry = outlineEdgeGeometry(this.draftPiece, out, nextEdge);
        const snap =
          this.lengthSnap ??
          (this.lengthSnapEnabled
            ? findSegmentSnapSuggestion(this.pieces, this.assembly, this.activePiece, targetEdge, out)
            : null);
        lengthGuides = {
          angleDeg: targetGeometry.angleDeg,
          parallelCount: allMatches.filter((m) => m.parallel).length,
          nearParallelCount: allMatches.filter((m) => m.nearParallel).length,
          equalCount: allMatches.filter((m) => m.equal).length,
          nearEqualCount: allMatches.filter((m) => m.nearEqual).length,
          rightStart: !!prevGeometry && segmentRelation(targetGeometry, prevGeometry).perpendicular,
          rightEnd: !!nextGeometry && segmentRelation(targetGeometry, nextGeometry).perpendicular,
          snap,
          matches: allMatches.slice(0, 6).map((m) => ({
            pieceId: m.pieceId,
            edge: m.edge,
            parallel: m.parallel,
            nearParallel: m.nearParallel,
            equal: m.equal,
            nearEqual: m.nearEqual,
            angleDelta: m.angleDelta,
            lengthDelta: m.lengthDelta,
            lengthM: m.lengthM,
          })),
        };

        const equalityColor = PAL.a58;
        const parallelColor = PAL.a59;
        const drawEqualityTicks = (a: [number, number], b: [number, number]): void => {
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len = Math.hypot(dx, dy);
          if (len < 10) return;
          const tx = dx / len;
          const ty = dy / len;
          const nx = -ty;
          const ny = tx;
          ctx.strokeStyle = equalityColor;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);
          for (const d of [-3, 3]) {
            const x = (a[0] + b[0]) / 2 + tx * d;
            const y = (a[1] + b[1]) / 2 + ty * d;
            ctx.beginPath();
            ctx.moveTo(x - nx * 4, y - ny * 4);
            ctx.lineTo(x + nx * 4, y + ny * 4);
            ctx.stroke();
          }
        };
        const drawBadge = (x: number, y: number, label: string, color: string, strong = false): void => {
          ctx.font = `${strong ? 700 : 600} 10px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const w = ctx.measureText(label).width + 10;
          ctx.fillStyle = PAL.a60;
          ctx.fillRect(x - w / 2, y - 8, w, 16);
          ctx.fillStyle = color;
          ctx.fillText(label, x, y);
        };

        for (let matchIndex = 0; matchIndex < lengthGuides.matches.length; matchIndex++) {
          const match = lengthGuides.matches[matchIndex]!;
          const piece = this.pieceAt(match.pieceId);
          if (!piece) continue;
          const candidateOutline = match.pieceId === this.activePiece ? out : piece.outline;
          const off = this.pieceOffset(match.pieceId);
          const yOff = this.pieceYOffset(match.pieceId);
          const a = this.vertexScreen(candidateOutline[match.edge]!, piece, off, yOff);
          const b = this.vertexScreen(candidateOutline[(match.edge + 1) % candidateOutline.length]!, piece, off, yOff);
          if (!a || !b) continue;
          if (match.parallel || match.nearParallel) {
            ctx.strokeStyle = match.parallel ? parallelColor : PAL.a61;
            ctx.lineWidth = match.parallel ? 2.4 : 1.5;
            ctx.setLineDash(match.parallel ? [6, 3] : [2, 5]);
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
            ctx.setLineDash([]);
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len = Math.hypot(dx, dy) || 1;
            const badge =
              matchIndex === 0
                ? [
                    match.parallel ? 'parallèle' : 'presque parallèle',
                    match.equal ? 'même longueur' : match.nearEqual ? 'longueur proche' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : match.parallel
                  ? '∥'
                  : '≈';
            drawBadge(
              (a[0] + b[0]) / 2 + (-dy / len) * 9,
              (a[1] + b[1]) / 2 + (dx / len) * 9,
              badge,
              match.parallel ? parallelColor : PAL.a62,
              matchIndex === 0,
            );
          }
          if (match.equal) drawEqualityTicks(a, b);
          else if (match.nearEqual && !match.parallel && !match.nearParallel) {
            ctx.strokeStyle = PAL.a63;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 5]);
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
            ctx.setLineDash([]);
            drawBadge((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 9, 'longueur proche', PAL.a64);
          }
        }
        if (lengthGuides.equalCount > 0) {
          const a = pts[targetEdge]!;
          const b = pts[(targetEdge + 1) % pts.length]!;
          drawEqualityTicks(a, b);
        }

        // Plain-language card for non-experts. It appears only in the large
        // workspace; the compact inset keeps the short footer instead.
        if (this.canvas.width >= 420) {
          const best = lengthGuides.matches[0] ?? null;
          const snap = lengthGuides.snap;
          const married = !!this.segmentLinkAt(this.activePiece, targetEdge);
          const cardX = 10;
          const cardY = 10;
          const cardW = Math.min(520, this.canvas.width - 20);
          const cardH = best ? (snap ? 94 : 78) : snap ? 64 : 44;
          ctx.fillStyle = PAL.a65;
          ctx.fillRect(cardX, cardY, cardW, cardH);
          ctx.strokeStyle = PAL.a66;
          ctx.lineWidth = 1;
          ctx.strokeRect(cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1);

          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.font = '700 11px ui-monospace, monospace';
          ctx.fillStyle = PAL.a67;
          ctx.fillText(
            `AIDE AU TRACÉ — SEGMENT ${targetEdge + 1} · ${(targetGeometry.lengthM * 100).toFixed(1).replace('.', ',')} cm${married ? ' · LIÉ' : ''}${this.lengthSnapEnabled ? ' · AUTO' : ''}`,
            cardX + 10,
            cardY + 8,
          );
          if (best) {
            const relationText = [
              best.parallel
                ? `parallèle exact · écart ${best.angleDelta.toFixed(2).replace('.', ',')}°`
                : best.nearParallel
                  ? `presque parallèle · écart ${best.angleDelta.toFixed(2).replace('.', ',')}°`
                  : '',
              best.equal
                ? `même longueur · écart ${(best.lengthDelta * 1000).toFixed(1).replace('.', ',')} mm`
                : best.nearEqual
                  ? `longueur proche · écart ${(best.lengthDelta * 1000).toFixed(1).replace('.', ',')} mm`
                  : '',
            ]
              .filter(Boolean)
              .join(' · ');
            ctx.font = '10px ui-monospace, monospace';
            ctx.fillStyle = PAL.a68;
            ctx.fillText(
              `Meilleur repère : ${this.pieceLabel(best.pieceId).toUpperCase()} · bord ${best.edge + 1}`,
              cardX + 10,
              cardY + 25,
            );
            ctx.fillText(relationText, cardX + 10, cardY + 39);
          }
          if (snap) {
            const sameParallelReference =
              snap.angle?.kind === 'parallel' &&
              snap.length?.kind === 'parallel' &&
              snap.angle.pieceId === snap.length.pieceId &&
              snap.angle.edge === snap.length.edge;
            const snapParts = sameParallelReference
              ? [
                  `${this.pieceLabel(snap.angle!.pieceId).toUpperCase()} bord ${snap.angle!.edge + 1}`,
                  'parallèle + même longueur',
                ]
              : [
                  snap.length?.kind === 'sewn'
                    ? `couture ${this.pieceLabel(snap.length.pieceId).toUpperCase()} = ${(snap.length.lengthM * 100).toFixed(1).replace('.', ',')} cm`
                    : snap.length
                      ? `même longueur : ${this.pieceLabel(snap.length.pieceId).toUpperCase()} bord ${snap.length.edge + 1}`
                      : '',
                  snap.angle?.kind === 'parallel'
                    ? `parallèle : ${this.pieceLabel(snap.angle.pieceId).toUpperCase()} bord ${snap.angle.edge + 1}`
                    : snap.angle
                      ? `angle droit : bord ${snap.angle.edge + 1}`
                      : '',
                ].filter(Boolean);
            ctx.font = '700 10px ui-monospace, monospace';
            ctx.fillStyle = PAL.a69;
            ctx.fillText(
              `${this.lengthDrag && this.lengthSnap ? 'AJUSTÉ' : 'PRÊT À AJUSTER'} · ${snapParts.join(' · ')}`,
              cardX + 10,
              cardY + (best ? 54 : 25),
            );
          }
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillStyle = parallelColor;
          ctx.fillText('JAUNE  parallèle', cardX + 10, cardY + cardH - 17);
          ctx.fillStyle = equalityColor;
          ctx.fillText('VIOLET  même longueur', cardX + 140, cardY + cardH - 17);
          ctx.fillStyle = PAL.a69;
          ctx.fillText('VERT  angle droit', cardX + 315, cardY + cardH - 17);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }
    if (lengthTarget?.pieceId === this.activePiece && pts.length >= 2) {
      const edge = ((lengthTarget.edge % pts.length) + pts.length) % pts.length;
      const a = pts[edge]!;
      const b = pts[(edge + 1) % pts.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-3) {
        const tx = dx / len;
        const ty = dy / len;
        let nx = -ty;
        let ny = tx;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
        if (nx * (mx - cx) + ny * (my - cy) < 0) {
          nx = -nx;
          ny = -ny;
        }
        const offset = 16;
        const da: [number, number] = [a[0] + nx * offset, a[1] + ny * offset];
        const db: [number, number] = [b[0] + nx * offset, b[1] + ny * offset];
        const color = PAL.a06;

        ctx.setLineDash([]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();

        // Conventional square corner marks on adjacent edges that are truly
        // perpendicular in physical pattern space (not merely on-screen).
        const drawRightAngle = (v: [number, number], r1: [number, number], r2: [number, number]): void => {
          let x1 = r1[0] - v[0];
          let y1 = r1[1] - v[1];
          let x2 = r2[0] - v[0];
          let y2 = r2[1] - v[1];
          const l1 = Math.hypot(x1, y1) || 1;
          const l2 = Math.hypot(x2, y2) || 1;
          x1 /= l1;
          y1 /= l1;
          x2 /= l2;
          y2 /= l2;
          const s = Math.min(9, l1 * 0.28, l2 * 0.28);
          ctx.strokeStyle = PAL.a69;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(v[0] + x1 * s, v[1] + y1 * s);
          ctx.lineTo(v[0] + (x1 + x2) * s, v[1] + (y1 + y2) * s);
          ctx.lineTo(v[0] + x2 * s, v[1] + y2 * s);
          ctx.stroke();
        };
        if (lengthGuides?.rightStart) drawRightAngle(a, b, pts[(edge + pts.length - 1) % pts.length]!);
        if (lengthGuides?.rightEnd) drawRightAngle(b, a, pts[(edge + 2) % pts.length]!);

        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(da[0], da[1]);
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(db[0], db[1]);
        ctx.moveTo(da[0], da[1]);
        ctx.lineTo(db[0], db[1]);
        ctx.stroke();
        // Arrow heads point inward along the dimension line.
        const arrow = 5;
        ctx.beginPath();
        ctx.moveTo(da[0], da[1]);
        ctx.lineTo(da[0] + tx * arrow + nx * 2.5, da[1] + ty * arrow + ny * 2.5);
        ctx.moveTo(da[0], da[1]);
        ctx.lineTo(da[0] + tx * arrow - nx * 2.5, da[1] + ty * arrow - ny * 2.5);
        ctx.moveTo(db[0], db[1]);
        ctx.lineTo(db[0] - tx * arrow + nx * 2.5, db[1] - ty * arrow + ny * 2.5);
        ctx.moveTo(db[0], db[1]);
        ctx.lineTo(db[0] - tx * arrow - nx * 2.5, db[1] - ty * arrow - ny * 2.5);
        ctx.stroke();
        ctx.globalAlpha = 1;

        const cm = this.edgeLenCm(this.activePiece, edge, out);
        const deltaCm = this.lengthDrag ? cm - this.lengthDrag.startLength * 100 : 0;
        const deltaLabel =
          this.lengthDrag && Math.abs(deltaCm) >= 0.05
            ? `  ${deltaCm > 0 ? '+' : '−'}${Math.abs(deltaCm).toFixed(1).replace('.', ',')} cm`
            : '';
        const label = `${cm.toFixed(1).replace('.', ',')} cm${deltaLabel}${this.lengthDrag?.linked ? ' · LIÉ' : ''}`;
        const labelX = (da[0] + db[0]) / 2 + nx * 2;
        const labelY = (da[1] + db[1]) / 2 + ny * 2;
        ctx.font = '700 11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelW = ctx.measureText(label).width + 12;
        ctx.fillStyle = PAL.a37;
        ctx.fillRect(labelX - labelW / 2, labelY - 9, labelW, 18);
        ctx.fillStyle = color;
        ctx.fillText(label, labelX, labelY);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }

    // Darts: draw each as its two legs meeting at the apex (orange), plus the
    // live preview wedge while pulling one out.
    ctx.strokeStyle = PAL.a70;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    const drawDart = (apex: UV, legA: UV, legB: UV): void => {
      const a = this.vertexScreen(apex);
      const la = this.vertexScreen(legA);
      const lb = this.vertexScreen(legB);
      if (!a || !la || !lb) return;
      ctx.beginPath();
      ctx.moveTo(la[0], la[1]);
      ctx.lineTo(a[0], a[1]);
      ctx.lineTo(lb[0], lb[1]);
      ctx.stroke();
    };
    for (const d of this.draftPiece.darts) drawDart(d.apex, d.legA, d.legB);
    if (this.draftEdge?.apex) {
      const out = this.draftPiece.outline;
      const a = out[this.draftEdge.edge]!;
      const b = out[(this.draftEdge.edge + 1) % out.length]!;
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1e-6;
      dx /= len;
      dy /= len;
      const m = this.draftEdge.downUV;
      drawDart(this.draftEdge.apex, [m[0] - dx * 0.045, m[1] - dy * 0.045], [m[0] + dx * 0.045, m[1] + dy * 0.045]);
    }
    ctx.setLineDash([]);
    // ▱ Lignes internes de la pièce ACTIVE (style, pliures, repères).
    if (this.draftPiece.internalLines?.length) {
      const lines = this.draftPiece.internalLines;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        const selected = this.selectedInternal === li;
        const renderPts = line.smooth && line.points.length >= 3
          ? catmullRomSubdivide(line.points, !!line.closed)
          : line.points;
        const lp = renderPts
          .map((uv) => this.vertexScreen(uv))
          .filter((s): s is [number, number] => s !== null);
        if (lp.length < 2) continue;
        ctx.strokeStyle = selected ? PAL.a42 : PAL.ligneInterne;
        ctx.lineWidth = selected ? 2.2 : 1.2;
        ctx.beginPath();
        lp.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        if (line.closed) ctx.closePath();
        if (line.hole && line.closed) {
          ctx.save();
          ctx.fillStyle = PAL.a02;
          ctx.fill();
          ctx.setLineDash([]);
          ctx.strokeStyle = selected ? PAL.a42 : PAL.ligneInterneForte;
          ctx.lineWidth = selected ? 2.4 : 1.6;
          ctx.stroke();
          ctx.restore();
          ctx.lineWidth = 1.2;
          ctx.setLineDash([6, 4]);
        } else {
          ctx.stroke();
        }
        if (selected) {
          ctx.setLineDash([]);
          const ctrlPts = line.points
            .map((uv) => this.vertexScreen(uv))
            .filter((s): s is [number, number] => s !== null);
          for (let pi = 0; pi < ctrlPts.length; pi++) {
            const s = ctrlPts[pi]!;
            const dragging = this.internalPtDrag?.lineIdx === li && this.internalPtDrag?.ptIdx === pi;
            const r = dragging ? 6.5 : 4.5;
            ctx.beginPath();
            ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
            ctx.fillStyle = dragging ? PAL.a19 : PAL.pointNeutre;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = dragging ? PAL.a42 : PAL.a49;
            ctx.stroke();
          }
          ctx.setLineDash([6, 4]);
        }
      }
      ctx.setLineDash([]);
    }
    // Aperçu du BOMBER : l'arc que le segment deviendra au relâchement (bleu,
    // par-dessus le contour encore droit).
    if (this.draftEdge?.bend) {
      const o = this.draftPiece.outline;
      const a = this.vertexScreen(o[this.draftEdge.edge]!);
      const b = this.vertexScreen(o[(this.draftEdge.edge + 1) % o.length]!);
      const arc = this.draftEdge.bend.map((uv) => this.vertexScreen(uv));
      if (a && b && arc.every((s) => s !== null)) {
        ctx.strokeStyle = PAL.a49;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        for (const s of arc) ctx.lineTo(s![0], s![1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }

    // A pocket/appliqué remains visible over its chosen support while its
    // cutting piece stays in its own column. This is also the live placement
    // preview under the crosshair.
    this.drawSurfaceAttachments(ctx);

    // Skip the assembly overlay while a vertex is being dragged: it reads the
    // committed outline, so it would lag the live preview until the drag commits.
    if (!this.draftDrag) {
    // MANUAL ASSEMBLY overlay: free edges (still to sew) in red, the sewn seams
    // as blue links across the two columns, and the first-picked edge in orange.
    ctx.setLineDash([]);
    const edgePts = (pid: number, edge: number): [[number, number], [number, number]] | null => {
      const piece = this.pieceAt(pid);
      if (!piece) return null;
      const o =
        pid === this.activePiece
          ? out
          : this.linkedPreview?.pieceId === pid
            ? this.linkedPreview.outline
            : piece.outline;
      const off = this.pieceOffset(pid);
      const yOff = this.pieceYOffset(pid);
      const a = this.vertexScreen(o[edge % o.length]!, piece, off, yOff);
      const b = this.vertexScreen(o[(edge + 1) % o.length]!, piece, off, yOff);
      return a && b ? [a, b] : null;
    };
    const runSet = (piece: DraftPiece, runs: readonly { from: number; to: number }[]): Set<number> => {
      const set = new Set<number>();
      const nV = piece.outline.length;
      for (const r of runs) {
        let steps = ((r.to - r.from) + nV) % nV;
        if (steps === 0) steps = 1;
        for (let k = 0; k < steps; k++) set.add((r.from + k) % nV);
      }
      return set;
    };
    const strokeRun = (pid: number, r: { from: number; to: number }): void => {
      const piece = this.pieceAt(pid);
      if (!piece) return;
      runSet(piece, [r]).forEach((e) => {
        const pts = edgePts(pid, e);
        if (!pts) return;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.stroke();
      });
    };
    // Segment marriages are editing constraints, not stitches. A cyan double
    // stroke marks both members and a discreet dashed bridge makes the pair
    // readable across pieces.
    this.segmentLinks.forEach((link, index) => {
      const pidA = pieceIdOf(link.a);
      const pidB = pieceIdOf(link.b);
      const pa = edgePts(pidA, link.a.from);
      const pb = edgePts(pidB, link.b.from);
      if (!pa || !pb) return;
      const ma: [number, number] = [(pa[0][0] + pa[1][0]) / 2, (pa[0][1] + pa[1][1]) / 2];
      const mb: [number, number] = [(pb[0][0] + pb[1][0]) / 2, (pb[0][1] + pb[1][1]) / 2];
      ctx.strokeStyle = PAL.a71;
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 3]);
      strokeRun(pidA, { from: link.a.from, to: link.a.to });
      strokeRun(pidB, { from: link.b.from, to: link.b.to });
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(ma[0], ma[1]);
      ctx.lineTo(mb[0], mb[1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      if (this.canvas.width >= 420) {
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = PAL.a72;
        ctx.fillText(`LIEN ${index + 1}`, (ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2 - 7);
      }
    });
    const selectedLinkEdge = this.linkPickA ?? this.linkHover;
    if (selectedLinkEdge) {
      const selected = this.runForEdge(selectedLinkEdge.pieceId, selectedLinkEdge.edge);
      ctx.strokeStyle = this.linkPickA ? PAL.a53 : PAL.a73;
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      strokeRun(selectedLinkEdge.pieceId, selected);
    }
    // Which edges are already sewn (touched by an assembly seam run), per piece.
    const sewn = new Map<number, Set<number>>();
    const sewnOf = (pid: number): Set<number> => {
      let s = sewn.get(pid);
      if (!s) sewn.set(pid, (s = new Set<number>()));
      return s;
    };
    for (const s of this.assembly) {
      if (!assemblySeamIsClosed(s)) continue;
      for (const fr of [s.a, s.b]) {
        const pid = pieceIdOf(fr);
        const piece = this.pieceAt(pid);
        if (!piece) continue;
        runSet(piece, [{ from: fr.from, to: fr.to }]).forEach((e) => sewnOf(pid).add(e));
      }
    }
    // Free edges (still to sew) = neither sewn nor an intentional opening. Only the
    // BASE shell (front=0 / back=1) reports them — a free piece auto-closes its own
    // perimeter and just attaches at one seam, so its edges aren't "to sew".
    // ÉPURE (façon CLO « Show 2D Sewing ») : le rouge ne s'affiche QUE pendant
    // le mode 🪡 Coudre, là où il est actionnable (« les bords rouges
    // attendent ») — le reste du temps le compteur du pied de plan suffit.
    const drawFree = (pid: number): void => {
      const piece = this.pieceAt(pid);
      if (!piece) return;
      const s = sewn.get(pid) ?? new Set<number>();
      const open = runSet(piece, piece.openEdges);
      ctx.strokeStyle = PAL.a74;
      ctx.lineWidth = 2.5;
      for (let k = 0; k < piece.outline.length; k++) {
        if (s.has(k) || open.has(k)) continue;
        const pts = edgePts(pid, k);
        if (pts) {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[1][0], pts[1][1]);
          ctx.stroke();
        }
      }
    };
    if (
      this.sewMode ||
      this.seamPickA ||
      this.zipperMode ||
      this.zipperPickA
    ) {
      drawFree(0);
      drawFree(1);
    }
    // La marge de couture ne se dessine PLUS dans l'éditeur (un seul contour
    // par pièce = plan calme) — elle reste sur le patron imprimé (PDF/SVG).
    // Sewn seams, épuré : the sewn EDGES themselves colour in on the pieces
    // (blue = flat, orange = gathered), a THIN link joins the two runs (still
    // the unsew click target), and the ratio label only appears when the seam
    // actually gathers (a plan full of « 1:1 » said nothing).
    const runLenCm = (pid: number, r: { from: number; to: number }): number => {
      const piece = this.pieceAt(pid);
      if (!piece) return 0;
      let cm = 0;
      runSet(piece, [r]).forEach((e) => (cm += this.edgeLenCm(pid, e)));
      return cm;
    };
    this.assembly.forEach((s, k) => {
      const pidA = pieceIdOf(s.a);
      const pidB = pieceIdOf(s.b);
      const pa = edgePts(pidA, s.a.from);
      const pb = edgePts(pidB, s.b.from);
      if (!pa || !pb) return;
      const ma: [number, number] = [(pa[0][0] + pa[1][0]) / 2, (pa[0][1] + pa[1][1]) / 2];
      const mb: [number, number] = [(pb[0][0] + pb[1][0]) / 2, (pb[0][1] + pb[1][1]) / 2];
      const la = runLenCm(pidA, { from: s.a.from, to: s.a.to });
      const lb = runLenCm(pidB, { from: s.b.from, to: s.b.to });
      const ratio = Math.max(la, lb) / (Math.min(la, lb) || 1);
      const gathered = ratio >= 1.12;
      // v181 ⑥ : pastilles d'extrémités — les BOUTS de chaque run se voient,
      // côté A et côté B (façon Clo, en discret).
      if (s.kind !== 'zipper' && assemblySeamIsClosed(s)) {
        const dotColor = SEAM_COLORS[k % SEAM_COLORS.length]!;
        const dotRun = (pid: number, fr: { from: number; to: number }): void => {
          const piece = this.pieceAt(pid);
          if (!piece) return;
          const nV = piece.outline.length;
          let steps = ((fr.to - fr.from) + nV) % nV;
          if (steps === 0) steps = 1;
          const first = edgePts(pid, fr.from % nV);
          const last = edgePts(pid, (fr.from + steps - 1) % nV);
          ctx.fillStyle = dotColor;
          for (const q of [first?.[0], last?.[1]]) {
            if (!q) continue;
            ctx.beginPath();
            ctx.arc(q[0], q[1], 2.6, 0, Math.PI * 2);
            ctx.fill();
          }
        };
        dotRun(pidA, s.a);
        dotRun(pidB, s.b);
      }
      if (s.kind === 'zipper') {
        const closed = assemblySeamIsClosed(s);
        const zipColor = closed
          ? PAL.a75
          : PAL.a76;
        ctx.save();
        // Dark tape underneath + short bright dashes above = readable zipper
        // teeth even when the pattern is substantially zoomed out.
        ctx.strokeStyle = PAL.a77;
        ctx.lineWidth = 7;
        ctx.setLineDash([]);
        strokeRun(pidA, { from: s.a.from, to: s.a.to });
        strokeRun(pidB, { from: s.b.from, to: s.b.to });
        ctx.strokeStyle = zipColor;
        ctx.lineWidth = 3;
        ctx.setLineDash([2, 2]);
        strokeRun(pidA, { from: s.a.from, to: s.a.to });
        strokeRun(pidB, { from: s.b.from, to: s.b.to });
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = closed ? 0.72 : 0.4;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(ma[0], ma[1]);
        ctx.lineTo(mb[0], mb[1]);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.font = '800 9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = zipColor;
        ctx.fillText(
          closed ? 'ZIP' : 'ZIP OUVERT',
          (ma[0] + mb[0]) / 2,
          (ma[1] + mb[1]) / 2 - 7,
        );
        ctx.restore();
        return;
      }
      const color = SEAM_COLORS[k % SEAM_COLORS.length]!;
      // Les DEUX bords de la couture k dans SA couleur : le lien se voit sans
      // suivre le trait de liaison (qui reste, discret, pour le clic-défaire).
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.5;
      strokeRun(pidA, { from: s.a.from, to: s.a.to });
      strokeRun(pidB, { from: s.b.from, to: s.b.to });
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ma[0], ma[1]);
      ctx.lineTo(mb[0], mb[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Étiquette de couture : le NUMÉRO s'affiche sur chaque bord pour que
      // l'utilisateur voie immédiatement quel bord est cousu avec quel autre.
      const seamLabel = `${k + 1}`;
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(seamLabel, ma[0], ma[1] - 7);
      ctx.fillText(seamLabel, mb[0], mb[1] - 7);
      if (gathered) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(`${ratio.toFixed(1).replace('.', ',')}:1 fronce`, (ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2 - 6);
      }
    });
    // Liens SYSTÈME (manche↔emmanchure, col↔encolure) : les cellules
    // réellement épinglées, tracées comme des coutures — chaque lien dans la
    // couleur qui SUIT celles des coutures manuelles, sur les deux bords
    // (corps devant/dos + bouche de la pièce) avec le trait fin de liaison.
    this.systemLinks.forEach((sl, k) => {
      const color = SEAM_COLORS[(this.assembly.length + k) % SEAM_COLORS.length]!;
      const poly = (pid: number, cells: UV[]): [number, number] | null => {
        const piece = this.pieceAt(pid);
        if (!piece || cells.length < 2) return null;
        const off = this.pieceOffset(pid);
        const yOff = this.pieceYOffset(pid);
        let mid: [number, number] | null = null;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < cells.length; i++) {
          const s = this.vertexScreen(cells[i]!, piece, off, yOff);
          if (!s) continue;
          if (started) ctx.lineTo(s[0], s[1]);
          else ctx.moveTo(s[0], s[1]);
          started = true;
          if (i === Math.floor(cells.length / 2)) mid = s;
        }
        if (started) ctx.stroke();
        return mid;
      };
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.5;
      const m0 = poly(0, sl.body0);
      const m1 = poly(1, sl.body1);
      const mp = poly(sl.pid, sl.piece);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      for (const m of [m0, m1]) {
        if (!m || !mp) continue;
        ctx.beginPath();
        ctx.moveTo(m[0], m[1]);
        ctx.lineTo(mp[0], mp[1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    // First-picked edge, awaiting the second click.
    if (this.seamPickA) {
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = PAL.a78;
      strokeRun(this.seamPickA.pieceId, this.runForEdge(this.seamPickA.pieceId, this.seamPickA.edge));
    }
    // Couture en série : receveur en VERT épais (a69), partenaires en ORANGE.
    if (this.serialReceiver) {
      ctx.lineWidth = 5;
      ctx.strokeStyle = PAL.a69;
      ctx.setLineDash([]);
      strokeRun(this.serialReceiver.pieceId, this.runForEdge(this.serialReceiver.pieceId, this.serialReceiver.edge));
    }
    for (const pk of this.serialPartners) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = PAL.a78;
      ctx.setLineDash([]);
      strokeRun(pk.pieceId, this.runForEdge(pk.pieceId, pk.edge));
    }
    const zipperTarget = this.zipperPickA ?? this.zipperHover;
    if (zipperTarget) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = PAL.a79;
      ctx.setLineDash([]);
      strokeRun(
        zipperTarget.pieceId,
        this.runForEdge(zipperTarget.pieceId, zipperTarget.edge),
      );
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = PAL.a75;
      ctx.setLineDash([2, 2]);
      strokeRun(
        zipperTarget.pieceId,
        this.runForEdge(zipperTarget.pieceId, zipperTarget.edge),
      );
      ctx.setLineDash([]);
    }
    // 🖼 GRAPHIQUES : l'image de chaque pièce, bornée à son contour, aperçu de
    // glisser compris ; la pièce active porte le gizmo (cadre + 2 poignées).
    for (let pid = 0; pid < this.pieces.length; pid++) {
      const piece = this.pieceAt(pid);
      const dragHere = this.graphicDrag && this.graphicDrag.pid === pid ? this.graphicDrag.preview : null;
      const graphic = dragHere ?? piece?.graphic;
      if (!piece || !graphic) continue;
      const f = this.graphicScreenFrame(pid, graphic);
      if (!f) continue;
      const img = this.graphicImage(graphic.image);
      const off = this.pieceOffset(pid);
      const yOff = this.pieceYOffset(pid);
      const outlineScreen = piece.outline
        .map((q) => this.vertexScreen(q, piece, off, yOff))
        .filter((q): q is [number, number] => !!q);
      if (outlineScreen.length === piece.outline.length && img) {
        ctx.save();
        ctx.beginPath();
        outlineScreen.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
        ctx.closePath();
        ctx.clip();
        ctx.translate(f.cx, f.cy);
        ctx.rotate(f.rot);
        ctx.globalAlpha = 0.96;
        if (graphic.repeat) {
          // MOTIF : remplir toute la pièce avec l'image répétée — l'échelle
          // écran d'une répétition = f.w px pour l'image entière.
          const pattern = ctx.createPattern(img, 'repeat');
          if (pattern) {
            const m = new DOMMatrix();
            m.a = f.w / img.naturalWidth;
            m.d = f.h / img.naturalHeight;
            m.e = -f.w / 2;
            m.f = -f.h / 2;
            pattern.setTransform(m);
            ctx.fillStyle = pattern;
            // Grand rectangle en repère local tourné : couvre la pièce entière.
            const R = Math.max(this.canvas.width, this.canvas.height) * 1.6;
            ctx.fillRect(-R, -R, 2 * R, 2 * R);
          }
        } else {
          ctx.drawImage(img, -f.w / 2, -f.h / 2, f.w, f.h);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      if (pid === this.activePiece) {
        ctx.save();
        ctx.translate(f.cx, f.cy);
        ctx.rotate(f.rot);
        ctx.strokeStyle = PAL.a73;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
        ctx.setLineDash([]);
        // poignée de taille (coin bas-droit)
        ctx.fillStyle = PAL.a16;
        ctx.fillRect(f.w / 2 - 4, f.h / 2 - 4, 8, 8);
        // poignée de rotation (au-dessus, reliée)
        ctx.beginPath();
        ctx.moveTo(0, -f.h / 2);
        ctx.lineTo(0, -f.h / 2 - 20);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -f.h / 2 - 20, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    // 🧵 Aperçu de la couture libre : le 1er tracé retenu (plein) et le tracé
    // en cours (pointillé), chacun sur SA pièce — indépendant de la colonne
    // active, comme les coutures d'assemblage ci-dessus.
    if (this.freeSewMode || this.freeSewRunA || this.freeSewTrace) {
      const drawFreeSewArc = (
        pieceId: number,
        sA: number,
        sB: number,
        dash: number[],
        width: number,
      ): void => {
        const arc = this.freeSewArcScreen(pieceId, sA, sB);
        if (!arc.length) return;
        ctx.strokeStyle = PAL.a42;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        arc.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        ctx.stroke();
        ctx.setLineDash([]);
        for (const end of [arc[0]!, arc[arc.length - 1]!]) {
          ctx.beginPath();
          ctx.arc(end[0], end[1], 4.5, 0, Math.PI * 2);
          ctx.fillStyle = PAL.a42;
          ctx.fill();
        }
      };
      if (this.freeSewRunA) {
        drawFreeSewArc(this.freeSewRunA.pieceId, this.freeSewRunA.startS, this.freeSewRunA.endS, [], 3);
      }
      if (this.freeSewTrace) {
        drawFreeSewArc(this.freeSewTrace.pieceId, this.freeSewTrace.startS, this.freeSewTrace.curS, [6, 4], 2.2);
      }
    }
    // Status line (bottom-left): the picked edge's length while sewing, else how
    // many edges are still free to sew (0 = fully assembled).
    const freeOf = (pid: number): number => {
      const piece = this.pieceAt(pid);
      if (!piece) return 0;
      const s = sewn.get(pid) ?? new Set<number>();
      const open = runSet(piece, piece.openEdges);
      let c = 0;
      for (let k = 0; k < piece.outline.length; k++) if (!s.has(k) && !open.has(k)) c++;
      return c;
    };
    const freeCount = freeOf(0) + freeOf(1); // base shell only (free pieces auto-close)
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (this.surfacePlacementPieceId !== null) {
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.fillStyle = PAL.a06;
      ctx.fillText(
        this.surfacePlacementHover
          ? `Cliquez ici pour poser ${this.pieceLabel(this.surfacePlacementPieceId)} · clic droit = annuler`
          : 'Survolez la pièce support, puis cliquez à la position exacte de la poche',
        8,
        this.canvas.height - 20,
      );
    } else if (this.freeSewMode || this.freeSewTrace || this.freeSewRunA) {
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.fillStyle = PAL.a78;
      const st = this.freeSewTrace;
      const cmOf = (m: number): string => `${Math.round(m * 100)} cm`;
      ctx.fillText(
        st
          ? `🧵 ${this.freeSewRunA ? '2e' : '1er'} tracé : ${cmOf(Math.abs(st.curS - st.startS))} — suivez le bord (les coins passent), cliquez la fin · re-clic au départ = annuler`
          : this.freeSewRunA
            ? `🧵 1er tracé retenu : ${cmOf(this.freeSewRunA.lenM)} — cliquez le DÉPART du bord à assembler (autre pièce ou même contour)`
            : '🧵 couture libre : cliquez un point de DÉPART sur un contour — mi-bord et coins permis',
        8,
        this.canvas.height - 20,
      );
    } else if (this.linkMode) {
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.fillStyle = this.linkNotice ? PAL.a80 : PAL.a06;
      ctx.fillText(
        this.linkNotice
          ? this.linkNotice
          : this.linkPickA
            ? `1er bord retenu : ${this.pieceLabel(this.linkPickA.pieceId)} · segment ${this.linkPickA.edge + 1} — cliquez le 2e bord`
            : '🔗 Marier : cliquez le premier bord · un bord déjà lié se dissocie en un clic',
        8,
        this.canvas.height - 20,
      );
    } else if (this.lengthMode) {
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillStyle = PAL.a06;
      const cm =
        lengthTarget?.pieceId === this.activePiece
          ? this.edgeLenCm(this.activePiece, lengthTarget.edge, out)
          : null;
      const signedAngle = lengthGuides
        ? lengthGuides.angleDeg > 90
          ? lengthGuides.angleDeg - 180
          : lengthGuides.angleDeg
        : null;
      const orientation =
        signedAngle === null
          ? ''
          : Math.abs(signedAngle) <= 0.5
            ? `horizontal (${signedAngle.toFixed(2).replace('.', ',')}°)`
            : Math.abs(Math.abs(signedAngle) - 90) <= 0.5
              ? `vertical (${signedAngle.toFixed(2).replace('.', ',')}°)`
              : `inclinaison ${signedAngle.toFixed(2).replace('.', ',')}°`;
      const guideStatus =
        signedAngle === null || !lengthGuides
          ? ''
          : this.canvas.width >= 420
            ? ` · ${orientation} — détails et écarts dans la carte ci-dessus`
            : ` · ${orientation}`;
      ctx.fillText(
        cm === null
          ? this.lengthSnapEnabled
            ? '🧲 Ajustement auto actif — glissez un bord près de sa bonne valeur'
            : 'Survolez un bord — jaune : parallèle · violet : même longueur · vert : angle droit'
          : `Segment ${lengthTarget!.edge + 1} — ${cm.toFixed(1).replace('.', ',')} cm${guideStatus}`,
        8,
        this.canvas.height - 20,
      );
    } else if (this.serialMode) {
      ctx.fillStyle = PAL.a75;
      const msg = !this.serialReceiver
        ? 'COUTURE EN SÉRIE · cliquez le bord RECEVEUR (le long)'
        : this.serialPartners.length === 0
          ? 'Cliquez les bords à raccorder, dans l’ordre — puis Entrée pour coudre'
          : `${this.serialPartners.length} pièce${this.serialPartners.length > 1 ? 's' : ''} à raccorder — Entrée pour coudre, re-clic du bord vert pour annuler`;
      ctx.fillText(msg, 8, this.canvas.height - 20);
    } else if (this.zipperPickA) {
      ctx.fillStyle = PAL.a75;
      ctx.fillText(
        `ZIP · 1er ruban : ${Math.round(this.edgeLenCm(this.zipperPickA.pieceId, this.zipperPickA.edge))} cm — cliquez le bord opposé`,
        8,
        this.canvas.height - 20,
      );
    } else if (this.zipperMode) {
      ctx.fillStyle = PAL.a75;
      ctx.fillText(
        'ZIP · cliquez le premier bord, puis son bord opposé',
        8,
        this.canvas.height - 20,
      );
    } else if (this.seamPickA) {
      ctx.fillStyle = PAL.a78;
      ctx.fillText(
        `bord : ${Math.round(this.edgeLenCm(this.seamPickA.pieceId, this.seamPickA.edge))} cm — cliquez maintenant le 2e bord, celui à assembler`,
        8,
        this.canvas.height - 20,
      );
    } else if (this.sewMode) {
      ctx.fillStyle = PAL.a78;
      const openSurface = this.pieces.some((piece) => {
        const surface = piece?.placement?.surface;
        return !!piece && !!surface && surface.stitchedEdges.length < piece.outline.length;
      });
      ctx.fillText(
        openSurface
          ? '🪡 poche : cliquez un côté pointillé pour remettre sa couture · sinon choisissez le 1er bord rouge'
          : '🪡 couture : cliquez le 1er bord (les bords rouges attendent)',
        8,
        this.canvas.height - 20,
      );
    } else {
      ctx.fillStyle = freeCount === 0 ? PAL.a81 : PAL.a74;
      ctx.fillText(
        freeCount === 0
          ? `${this.assembly.length} coutures · tout est assemblé ✓`
          : `${this.assembly.length} couture(s) · ${freeCount} bord(s) à coudre`,
        8,
        this.canvas.height - 20,
      );
    }
    } // end assembly overlay (skipped during a vertex drag)

    // Live size readout of the ACTIVE piece, in real centimetres (its outline
    // extent × the piece's physical dimensions). Updates as the outline changes.
    const ap = this.draftPiece;
    if (ap && ap.outline.length >= 2) {
      const src = this.draftPreview ?? ap.outline;
      let uMin = 1;
      let uMax = 0;
      let vMin = 1;
      let vMax = 0;
      for (const [u, v] of src) {
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
      const wCm = Math.round((uMax - uMin) * ap.width * 100);
      const hCm = Math.round((vMax - vMin) * ap.height * 100);
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = PAL.a82;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      let dimsLine = `${this.pieceLabel(this.activePiece)} ≈ ${wCm} × ${hCm} cm`;
      const me = this.measuredEdge;
      const mePiece = me ? this.pieceAt(me.pieceId) : null;
      if (me && mePiece && me.edge < mePiece.outline.length) {
        const lenCm = this.edgeLenCm(me.pieceId, me.edge);
        const seam = this.seamIndexOfEdge(me.pieceId, me.edge);
        const married = this.segmentLinkAt(me.pieceId, me.edge) !== null;
        dimsLine += ` · bord ${lenCm.toFixed(1).replace('.', ',')} cm ${
          seam !== null ? `(cousu · couture ${seam + 1})` : '(libre)'
        }${married ? ' · marié' : ''}`;
      }
      ctx.fillText(dimsLine, 8, this.canvas.height - 6);
    }
    // v180 ⑤ « pas dépaysé » : le bord mesuré — surligné + coté EN PLACE,
    // persistant tant que sélectionné (Échap, clic ailleurs ou édition = fin).
    const me2 = this.measuredEdge;
    if (me2) {
      const piece = this.pieceAt(me2.pieceId);
      if (piece && me2.edge < piece.outline.length) {
        const off = this.pieceOffset(me2.pieceId);
        const yOff = this.pieceYOffset(me2.pieceId);
        const a = this.vertexScreen(piece.outline[me2.edge]!, piece, off, yOff);
        const b = this.vertexScreen(piece.outline[(me2.edge + 1) % piece.outline.length]!, piece, off, yOff);
        if (a && b) {
          ctx.save();
          ctx.strokeStyle = PAL.a42;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
          const label = `${this.edgeLenCm(me2.pieceId, me2.edge).toFixed(1).replace('.', ',')} cm`;
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2 - 12;
          ctx.font = '650 10px ui-monospace, monospace';
          const w = ctx.measureText(label).width + 12;
          ctx.fillStyle = PAL.a23;
          ctx.fillRect(mx - w / 2, my - 8, w, 16);
          ctx.fillStyle = PAL.a46;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, mx, my);
          ctx.restore();
        }
      }
    }
  }

  private renderStatic(): void {
    const ctx = this.staticLayer.getContext('2d');
    const mesh = this.mesh;
    this.tf = null;
    if (!ctx) return;
    const W = this.staticLayer.width;
    const H = this.staticLayer.height;
    ctx.clearRect(0, 0, W, H);
    if (PAL.fond !== 'transparent') {
      ctx.fillStyle = PAL.fond;
      ctx.fillRect(0, 0, W, H);
    }

    // Atelier (freeform) mode: a fixed, mesh-independent transform (the full
    // width×height cutting field fits the panel) so vertices don't jump as the
    // outline changes and drawing works even before there's a mesh. A grid
    // backdrop makes it read like a 2D CAD surface. The draft overlay
    // (renderDraft) draws the outline, points, darts and seams on top.
    if (this.inDraft) {
      const p = this.pieces.find((x): x is DraftPiece => !!x)!;
      // Vertical extent: every piece (a collar band above the hem line must not
      // clip) unioned with the silhouette.
      let minY = p.topY - p.height;
      let maxY = p.topY;
      for (const q of this.pieces) {
        if (!q) continue;
        minY = Math.min(minY, q.topY - q.height);
        maxY = Math.max(maxY, q.topY);
      }
      if (this.bodySil) {
        minY = Math.min(minY, this.bodySil.minY);
        maxY = Math.max(maxY, this.bodySil.maxY);
      }
      // N columns side by side (CLO-style): DEVANT, DOS, then one column per
      // free piece — each column AS WIDE AS ITS CONTENT (plan de coupe épuré).
      // Body columns (0/1) span piece ∪ silhouette (pieces are drawn against
      // the avatar); a free piece takes just its own width, so a narrow collar
      // band no longer claims a body-wide column and the whole plan zooms in.
      // An EMPTY free column (pen about to trace) keeps a generous front-width
      // slot to draw in.
      const nCols = this.nCols;
      const colRange = (k: number): [number, number] => {
        const q = this.pieceAt(k);
        if (q?.blank) return [0, 0]; // socle vide : colonne fantôme sans emprise
        const w = (q ? q.width : p.width) / 2;
        // Colonnes corps (0/1) ET colonne de tracé à la plume : la silhouette de
        // référence fait partie de l'emprise (elle sert de gabarit de dessin).
        const withSil = k <= 1 || (this.penMode && k === this.activePiece);
        if (withSil && this.bodySil) return [Math.min(-w, this.bodySil.minX), Math.max(w, this.bodySil.maxX)];
        const pad = k <= 1 ? 0 : 0.03;
        return [-w - pad, w + pad];
      };
      const GUTTER = 0.08;
      this.offsets = new Array<number>(nCols).fill(0);
      this.colEdges = [];
      const ranges: [number, number][] = [];
      let cursor = 0; // running right edge of the laid-out columns (layout x)
      for (let k = 0; k < nCols; k++) {
        const r = colRange(k);
        this.offsets[k] = k === 0 ? 0 : cursor + GUTTER - r[0];
        if (k > 0) this.colEdges.push(cursor + GUTTER / 2);
        cursor = this.offsets[k]! + r[1];
        ranges.push(r);
      }
      const minX = ranges[0]![0];
      const maxX = cursor;
      const margin = 22;
      const spanA = maxX - minX || p.width;
      const spanB = maxY - minY || p.height;
      const fitScale = Math.min((W - 2 * margin) / spanA, (H - 2 * margin) / spanB);
      if (!this.viewCenter) this.viewCenter = [(minX + maxX) / 2, (minY + maxY) / 2];
      this.tf = patternViewportTransform(
        minX,
        minY,
        fitScale,
        this.viewZoom,
        this.viewCenter,
        W,
        H,
      );
      // Avatar silhouette behind the BODY columns only (DEVANT/DOS are drawn
      // against the body; a sleeve or collar column stays clean) — the exact
      // body shape, filled as one padded path (closes hairlines; a single fill
      // keeps the alpha uniform).
      const drawSil = (offset: number): void => {
        if (!this.bodySil) return;
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of this.bodySil.rects) {
          const a = this.layoutToScreen(x0 + offset, y1);
          const b = this.layoutToScreen(x1 + offset, y0);
          ctx.rect(a[0], a[1], b[0] - a[0] + 0.7, b[1] - a[1] + 0.7);
        }
        ctx.fillStyle = PAL.silhouette;
        ctx.fill();
      };
      for (let k = 0; k < Math.min(nCols, 2); k++) {
        if (this.pieceAt(k)?.blank) continue; // socle vide : pas de gabarit fantôme
        drawSil(this.offsets[k]!);
      }
      // Pendant un tracé à la plume dans une colonne libre, la silhouette
      // s'affiche AUSSI derrière cette colonne : c'est le gabarit de référence
      // pour dessiner la pièce aux bonnes dimensions (elle s'éteint au commit).
      if (this.penMode && this.activePiece >= 2) drawSil(this.offsets[this.activePiece] ?? 0);
      // Grid, hiérarchisée pour rester calme : lignes fines tous les 10 cm,
      // à peine plus présentes tous les 50 cm.
      ctx.lineWidth = 1;
      for (const [step, alpha] of [
        [0.1, 0.035],
        [0.5, 0.08],
      ] as const) {
        ctx.strokeStyle = `rgba(${PAL.grilleRVB}, ${alpha})`;
        ctx.beginPath();
        for (let gx = Math.ceil(minX / step) * step; gx <= maxX + 1e-6; gx += step) {
          const a = this.layoutToScreen(gx, minY);
          const b = this.layoutToScreen(gx, maxY);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
        for (let gy = Math.ceil(minY / step) * step; gy <= maxY + 1e-6; gy += step) {
          const a = this.layoutToScreen(minX, gy);
          const b = this.layoutToScreen(maxX, gy);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
        ctx.stroke();
      }
      // Height ruler down the left edge, in real centimeters (0 = the floor) —
      // un chiffre tous les 20 cm suffit pour se repérer.
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = PAL.axeLabelFaible;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let gy = Math.ceil(minY / 0.2) * 0.2; gy <= maxY + 1e-6; gy += 0.2) {
        const cm = Math.round(gy * 100);
        const [sx, sy] = this.layoutToScreen(minX, gy);
        ctx.fillText(`${cm}`, sx + 2, sy);
      }
      // Column labels, centred over each column's own extent. A label wider
      // than its (narrow) column wraps onto two lines at the first space, so
      // MANCHE D · MANCHE G · COL never overlap each other.
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillStyle = PAL.axeLabelFort;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labY = this.layoutToScreen(0, maxY)[1] - 3;
      for (let k = 0; k < (this.pristine ? 0 : nCols); k++) {
        if (this.pieceAt(k)?.blank) continue; // socle vide : colonne muette
        const label = this.pieceLabel(k).toUpperCase();
        const sx = this.layoutToScreen(this.offsets[k]! + (ranges[k]![0] + ranges[k]![1]) / 2, maxY)[0];
        const colPx = (ranges[k]![1] - ranges[k]![0]) * this.tf.scale;
        const sp = label.indexOf(' ');
        if (ctx.measureText(label).width > colPx && sp > 0) {
          ctx.fillText(label.slice(0, sp), sx, labY - 11);
          ctx.fillText(label.slice(sp + 1), sx, labY);
        } else {
          ctx.fillText(label, sx, labY);
        }
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }
    if (!mesh) return;

    const panelSize = mesh.resolution * mesh.resolution;
    const kept = (i: number): boolean => mesh.invMasses[i]! > 0;
    const frontPanel = (i: number): boolean => Math.floor(i / panelSize) % 2 === 0;
    // Panels pair front/back into garments: front panels 0, 2, 4… → garments 0, 1, 2…
    const garmentOf = (i: number): number => Math.floor(Math.floor(i / panelSize) / 2);

    // The rest pose is flat: pick the two axes that actually vary.
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      if (!kept(i) || !frontPanel(i)) continue;
      const y = mesh.positions[i * 4 + 1]!;
      const z = mesh.positions[i * 4 + 2]!;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(maxY - minY)) return;
    // Horizontal sheet → (x,z); vertical panels → (x,y).
    const useXZ = maxZ - minZ > maxY - minY;

    // Side-by-side: lay each garment's front piece out left to right in layout
    // space (like the printed pattern), so a combined outfit's overlapping
    // fronts separate instead of stacking. Vertical (x,y) layouts only.
    const G = Math.max(1, Math.floor(mesh.count / panelSize / 2));
    const offsetX = new Array<number>(G).fill(0);
    const gY: [number, number][] = [];
    const sideBySide = !useXZ && G > 1;
    if (sideBySide) {
      const GUTTER = 0.05; // 5 cm between pieces in layout space
      let cursor = 0;
      for (let g = 0; g < G; g++) {
        let aMin = Infinity, aMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (let i = 0; i < mesh.count; i++) {
          if (!kept(i) || !frontPanel(i) || garmentOf(i) !== g) continue;
          const x = mesh.positions[i * 4]!;
          const y = mesh.positions[i * 4 + 1]!;
          aMin = Math.min(aMin, x); aMax = Math.max(aMax, x);
          yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        }
        if (!Number.isFinite(aMin)) { gY.push([0, 0]); continue; }
        offsetX[g] = cursor - aMin;
        cursor += aMax - aMin + GUTTER;
        gY.push([yMin, yMax]);
      }
    }
    this.gLayout = sideBySide ? { offsetX, gY } : null;
    const offOf = (i: number): number => (sideBySide ? offsetX[garmentOf(i)]! : 0);

    // Axis coordinates (x shifted by the garment offset) and their bounds.
    const aOf = (i: number): number => mesh.positions[i * 4]! + offOf(i);
    const bOf = (i: number): number => (useXZ ? mesh.positions[i * 4 + 2]! : mesh.positions[i * 4 + 1]!);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      if (!kept(i) || !frontPanel(i)) continue;
      const a = aOf(i), b = bOf(i);
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
      minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    }
    const spanA = maxA - minA || 1;
    const spanB = maxB - minB || 1;

    const margin = 16;
    const fitScale = Math.min((W - 2 * margin) / spanA, (H - 2 * margin) / spanB);
    if (!this.viewCenter) this.viewCenter = [(minA + maxA) / 2, (minB + maxB) / 2];
    const viewTf = patternViewportTransform(
      minA,
      minB,
      fitScale,
      this.viewZoom,
      this.viewCenter,
      W,
      H,
    );
    const { scale, ox, oy } = viewTf;
    // Handles only make sense on vertical (x,y) layouts.
    this.tf = useXZ ? null : viewTf;
    const toScreen = (i: number): [number, number] => [
      ox + (aOf(i) - minA) * scale,
      H - (oy + (bOf(i) - minB) * scale),
    ];

    // Fabric fill from front-panel triangles.
    ctx.fillStyle = PAL.silhouetteTrace;
    ctx.beginPath();
    for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
      const a = mesh.triangleIndices[t]!;
      if (!frontPanel(a)) continue;
      const [ax, ay] = toScreen(a);
      const [bx, by] = toScreen(mesh.triangleIndices[t + 1]!);
      const [cx2, cy2] = toScreen(mesh.triangleIndices[t + 2]!);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx2, cy2);
      ctx.closePath();
    }
    ctx.fill();

    // Cut outline: triangle edges that belong to a single triangle.
    const edgeCount = new Map<string, [number, number]>();
    const addEdge = (a: number, b: number): void => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edgeCount.has(key)) edgeCount.delete(key);
      else edgeCount.set(key, [a, b]);
    };
    for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
      const a = mesh.triangleIndices[t]!;
      if (!frontPanel(a)) continue;
      const b = mesh.triangleIndices[t + 1]!;
      const c = mesh.triangleIndices[t + 2]!;
      addEdge(a, b);
      addEdge(b, c);
      addEdge(a, c);
    }
    ctx.strokeStyle = PAL.contourPiece;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const [a, b] of edgeCount.values()) {
      const [ax, ay] = toScreen(a);
      const [bx, by] = toScreen(b);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // Seams: mirror seams (front↔back) become stitch dots on the outline;
    // island-to-island seams (armholes) become orange links between pieces.
    const dv = new DataView(mesh.constraintData);
    ctx.fillStyle = PAL.a41;
    ctx.strokeStyle = PAL.a70;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let k = 0; k < mesh.constraintCount; k++) {
      if (dv.getUint32(k * 16 + 12, true) !== 3) continue; // Seam kind
      const i = dv.getUint32(k * 16, true);
      const j = dv.getUint32(k * 16 + 4, true);
      const pi = Math.floor(i / panelSize);
      const pj = Math.floor(j / panelSize);
      if (pi === pj && frontPanel(i)) {
        // Same-panel seam (armhole): draw the link.
        const [ax, ay] = toScreen(i);
        const [bx, by] = toScreen(j);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      } else if (pi + 1 === pj && frontPanel(i)) {
        // Mirror seam: stitch dot on the front piece.
        const [ax, ay] = toScreen(i);
        ctx.fillRect(ax - 1, ay - 1, 2.4, 2.4);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private renderHandles(): void {
    const ctx = this.ctx;
    if (!ctx || !this.tf || this.handles.length === 0) return;

    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i]!;
      const active = this.drag?.index === i;
      const value = active ? this.drag!.value : h.value;
      const [hx, hy] = this.handleScreenPos(h, value);

      if (active) {
        // Axis guide through the dragged handle.
        ctx.strokeStyle = PAL.a40;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (h.axis === 'u') {
          ctx.moveTo(hx, 0);
          ctx.lineTo(hx, this.canvas.height);
        } else {
          ctx.moveTo(0, hy);
          ctx.lineTo(this.canvas.width, hy);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const r = active || this.hover === i ? 6.5 : 4.5;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.fillStyle = PAL.pointNeutre;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? PAL.a42 : PAL.a49;
      ctx.stroke();
    }

    // Status line: the hovered/dragged measurement and its live value.
    const shown = this.drag ? this.handles[this.drag.index] : this.hover !== null ? this.handles[this.hover] : null;
    if (shown) {
      const value = this.drag ? this.drag.value : shown.value;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = PAL.a83;
      ctx.fillText(`${shown.label} ${value.toFixed(shown.unit ? 2 : 3)}${shown.unit ?? ''}`, 8, 12);
    }
  }
}
