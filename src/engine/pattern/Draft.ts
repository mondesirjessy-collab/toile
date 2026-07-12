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
}

export interface DraftPiece {
  outline: UV[]; // closed polygon, ≥3 pts, in [0,1]²
  darts: Dart[];
  seams: HandSeam[];
  openEdges: EdgeRun[]; // boundary runs left OPEN (not mirror-sewn) — e.g. the neckline
  // Physical placement in meters — mirrors generateSeamedPanels.
  width: number;
  height: number;
  topY: number;
  gap: number;
  // SLEEVE MODE (free pieces only): spawn the piece wrapped around an arm — its
  // two panels straddle the arm in z, pivoted at the piece's own top edge and
  // tilted to the arm's A-pose — instead of flat in front of the body. With its
  // rim mirror-stitched along both long edges (the default), the piece closes
  // into a TUBE around the arm; its cap run cross-sewn to the armhole makes a
  // real sleeve. Absent → flat spawn (unchanged).
  wrap?: 'armL' | 'armR';
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
  // FREE pieces (multi-piece editor): extra hand-drawn pieces beyond front/back.
  // Index 0 here is pieceId 2, index 1 is pieceId 3, … Each becomes its own mesh
  // combined onto the base via combineClothMeshes (see compileCrossSeams). Absent
  // ⇒ the garment is exactly the front/back base (byte-identical to pre-N-piece).
  pieces?: DraftPiece[];
}

/** All pieces of a doc indexed by pieceId: [front, back, ...free]. Slots may be
 * null (no back drawn yet). Free pieces start at index 2. */
export function docPieces(doc: DraftDoc): (DraftPiece | null)[] {
  return [doc.piece, doc.back ?? null, ...(doc.pieces ?? [])];
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
  };
}

/**
 * Remove the outline vertex at `index` (no-op if that would leave < 3 vertices).
 * Returns a NEW piece with openEdges/seam runs re-indexed. Pure.
 */
export function deleteOutlineVertex(piece: DraftPiece, index: number): DraftPiece {
  if (piece.outline.length <= 3) return piece;
  const outline = piece.outline.filter((_, i) => i !== index);
  const nV = outline.length;
  return {
    ...piece,
    outline,
    openEdges: piece.openEdges.map((r) => shiftRunDelete(r, index, nV)),
    seams: piece.seams.map((s) => ({ a: shiftRunDelete(s.a, index, nV), b: shiftRunDelete(s.b, index, nV) })),
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
  const runCells = (run: EdgeRun): { cell: number; t: number }[] => {
    const a = outline[run.from]!;
    const b = outline[run.to % nV]!;
    const res: { cell: number; t: number }[] = [];
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        if (!isBoundary(u, v)) continue;
        const p = uvOf(u, v);
        if (runCoversEdge(run, nearestOutlineEdge(p, outline), nV)) res.push({ cell: v * n + u, t: projFrac(p, a, b) });
      }
    return res.sort((x, y) => x.t - y.t);
  };
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
  outline: readonly UV[],
  darts: readonly Dart[],
  run: { from: number; to: number },
  n: number,
): { cell: number; t: number }[] {
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
  const a = outline[run.from % nV]!;
  const b = outline[run.to % nV]!;
  const res: { cell: number; t: number }[] = [];
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      if (!isBoundary(u, v)) continue;
      const p = uvOf(u, v);
      if (runCoversEdge(run, nearestOutlineEdge(p, outline), nV)) res.push({ cell: v * n + u, t: projFrac(p, a, b) });
    }
  return res.sort((x, y) => x.t - y.t);
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
    const run = pieceIdOf(s.a) === pid ? s.a : pieceIdOf(s.b) === pid ? s.b : null;
    if (!run) continue;
    for (const c of boundaryRunCells(piece.outline, piece.darts, { from: run.from, to: run.to }, n)) cells.add(c.cell);
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
): { a: number[]; b: number[] } | null {
  const A = boundaryRunCells(pa.outline, pa.darts, runA, n);
  const B = boundaryRunCells(pb.outline, pb.darts, runB, n);
  if (!A.length || !B.length) return null;
  const cellUV = (cell: number): UV => [(cell % n) / (n - 1), Math.floor(cell / n) / (n - 1)];
  // Zip over the LONGER run: every cell of both edges gets sewn (the shorter
  // run's cells repeat). Equal-length edges pair 1:1 as before; a long edge on
  // a short one GATHERS onto it — the tailor's embu — instead of leaving the
  // extra cells hanging (a sleeve cap held by a handful of pins slides off).
  const m = Math.max(A.length, B.length);
  const bAt = (k: number, reversed: boolean): { cell: number } => B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
  const cost = (reversed: boolean): number => {
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const paUV = cellUV(A[Math.floor((k * A.length) / m)]!.cell);
      const pbUV = cellUV(bAt(k, reversed).cell);
      sum += (paUV[0] - pbUV[0]) ** 2 + (paUV[1] - pbUV[1]) ** 2;
    }
    return sum;
  };
  const reversed = cost(true) < cost(false);
  const a: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < m; k++) {
    a.push(A[Math.floor((k * A.length) / m)]!.cell);
    b.push(bAt(k, reversed).cell);
  }
  return { a, b };
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
  const out: { i: number; j: number }[] = [];
  for (const s of doc.seams ?? []) {
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
    for (let k = 0; k < paired.a.length; k++) {
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
  // NOTE (leçon v104, chèrement acquise) : les jumelles vont TOUJOURS au
  // panneau opposé (avant↔avant + dos↔dos) — c'est ce que faisait le
  // armholeCrossSeams éprouvé (i = p·n² + bodyLocal : panneau p des DEUX
  // côtés). Quand le bord du corps est lui-même soudé devant↔dos (côté,
  // emmanchure sur ligne soudée), les quatre bords convergent TRANSITIVEMENT
  // via cette couture du corps — la pince qui verrouille le tube autour du
  // bras vient de là. Une variante « jumelle → même cellule AVANT du corps »
  // a été essayée et ARRACHE le tube par-dessus l'épaule (le panneau dos de
  // la manche se fait tirer vers le devant du corps) : ne pas y revenir.
  const out: { i: number; j: number }[] = [];
  for (const s of doc.seams ?? []) {
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
    for (let k = 0; k < paired.a.length; k++) {
      const li = paired.a[k]!;
      const lj = paired.b[k]!;
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
  return seams.map((s) => ({ a: shift(s.a), b: shift(s.b) }));
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
  const outPieces = pieces.filter((_, i) => i !== k);
  const shift = (r: FaceRun): FaceRun => (pieceIdOf(r) > pieceId ? { ...r, pieceId: pieceIdOf(r) - 1 } : { ...r });
  const outSeams = seams
    .filter((s) => pieceIdOf(s.a) !== pieceId && pieceIdOf(s.b) !== pieceId)
    .map((s) => ({ a: shift(s.a), b: shift(s.b) }));
  return { pieces: outPieces, seams: outSeams };
}


/** Physical placement of the blank canvas (meters). Single source of truth so
 * defaultDraft and the sanitizeDraft fallbacks can't drift apart. */
const DEFAULT_PIECE_DIMS = { width: 0.95, height: 1.1, topY: 1.6, gap: 1.0 };

/** The atelier's starting pieces: a sleeveless A-line dress FRONT and an
 * identical BACK, laid out côte-à-côte and UNSEWN (manual assembly). The user
 * sews shoulders (edges 0→1, 3→4) and sides (4→5, 6→0) front↔back, and leaves
 * the neckline (1→2→3) and hem (5→6) open. Nothing is auto-sewn. */
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
  return { format: 'toile-draft', version: 1, gridN, piece: face(), back: face(), manual: true, seams: [] };
}

/**
 * A basic T-SHIRT BODY preset: front + back IDENTICAL torso outlines (shoulders,
 * a neck scoop, near-straight sides to the hem), with the shoulder + side seams
 * PRE-SEWN front↔back and the neckline + hem left open — a closed torso tube.
 * The ARMS go into SEPARATE placed sleeves (the atelier "+ Manches" tubes that
 * straddle each arm) added by the caller, so the arms are truly IN the sleeves —
 * a flat kimono sleeve just hangs. Front=back ⇒ the hand seams pair cell-for-cell
 * like an automatic mirror seam, so it drapes as a clean closed shell but stays
 * editable. Sized to the avatar by the caller (width ≈ 0.7·topScale, height 0.62,
 * gap 0.9, topY 1.52 + dyShoulder). The sleeves attach to the top of the sides. */
export function tshirtDraft(width: number, height: number, gap: number, topY: number, gridN: 32 | 64 | 128 = 64): DraftDoc {
  const body = (): DraftPiece => ({
    outline: [
      [0.42, 0.0], // 0 neck top left
      [0.14, 0.02], // 1 left shoulder outer (the armhole/sleeve attaches at the top of the side)
      [0.16, 0.98], // 2 left hem (a hair of waist taper)
      [0.84, 0.98], // 3 right hem
      [0.86, 0.02], // 4 right shoulder outer
      [0.58, 0.0], // 5 neck top right
      [0.5, 0.12], // 6 neck bottom (scoop dip)
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 2, to: 3 }, // hem
      { from: 5, to: 0 }, // neckline (edges 5 + 6, the head hole)
    ],
    width,
    height,
    topY,
    gap,
  });
  // One contiguous seam per side: shoulder + side, sewn front↔back.
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: body(),
    back: body(),
    manual: true,
    seams: [seam(0, 2), seam(3, 5)],
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
      // Sleeve mode survives the round-trip; anything but the two arms is dropped.
      ...(pp.wrap === 'armL' || pp.wrap === 'armR' ? { wrap: pp.wrap } : {}),
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
  const seams = (Array.isArray(d.seams) ? d.seams : [])
    .slice(0, 128)
    .map((x) => {
      const s = x as AssemblySeam;
      return { a: faceRun(s?.a), b: faceRun(s?.b) };
    })
    .filter((s) => pieceExists(s.a) && pieceExists(s.b));
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: front,
    ...(back ? { back } : {}),
    ...(freePieces.length ? { pieces: freePieces } : {}),
    manual: d.manual === true,
    seams,
  };
}
