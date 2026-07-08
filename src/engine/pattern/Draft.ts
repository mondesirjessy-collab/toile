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
}

export interface DraftDoc {
  format: 'toile-draft';
  version: 1;
  gridN: 32 | 64 | 128; // authoring/sim resolution
  piece: DraftPiece; // v1 = exactly one freeform piece
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
  return { extraSeams, openCells };
}


/** A centered rectangular piece — the atelier's blank canvas (wearable tube:
 * sides auto-sewn, the top edge seeded OPEN so it isn't a sealed pillow). */
export function defaultDraft(gridN: 32 | 64 | 128 = 64): DraftDoc {
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: {
      // A simple sleeveless A-line dress (v grows downward): two shoulders with
      // a scooped neckline between them, sides flaring gently to the hem. The
      // shoulders (edges 0→1, 3→4) and the two sides (4→5, 6→0) auto-sew
      // front↔back so it hangs from the shoulders on the dress form; the
      // neckline (1→2→3) and the hem (5→6) stay open. The user reshapes it.
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
      width: 0.95,
      height: 1.1,
      topY: 1.6,
      gap: 1.0,
    },
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
  const p = d.piece;
  if (!p || !Array.isArray(p.outline) || p.outline.length < 3) return fallback;

  const uv = (a: unknown): UV => {
    const t = a as [number, number];
    return [clamp01(Array.isArray(t) ? t[0] : 0.5), clamp01(Array.isArray(t) ? t[1] : 0.5)];
  };
  const outline = p.outline.slice(0, 128).map(uv);
  if (isSelfIntersecting(outline)) return fallback;

  const nV = outline.length;
  const run = (r: unknown): EdgeRun => {
    const e = r as EdgeRun;
    const idx = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(nV - 1, Math.max(0, Math.round(v))) : 0;
    return { from: idx(e?.from), to: idx(e?.to) };
  };
  const num = (v: unknown, min: number, max: number, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;

  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: {
      outline,
      darts: (Array.isArray(p.darts) ? p.darts : []).slice(0, 16).map((x) => {
        const dd = x as Dart;
        return { apex: uv(dd?.apex), legA: uv(dd?.legA), legB: uv(dd?.legB) };
      }),
      seams: (Array.isArray(p.seams) ? p.seams : []).slice(0, 16).map((x) => {
        const hs = x as HandSeam;
        return { a: run(hs?.a), b: run(hs?.b) };
      }),
      openEdges: (Array.isArray(p.openEdges) ? p.openEdges : []).slice(0, 16).map(run),
      width: num(p.width, 0.3, 2.0, 0.95),
      height: num(p.height, 0.3, 2.0, 1.15),
      topY: num(p.topY, 0.5, 2.2, 1.55),
      gap: num(p.gap, 0.3, 1.6, 0.9),
    },
  };
}
