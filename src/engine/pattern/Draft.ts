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

/** A centered rectangular piece — the atelier's blank canvas (wearable tube:
 * sides auto-sewn, the top edge seeded OPEN so it isn't a sealed pillow). */
export function defaultDraft(gridN: 32 | 64 | 128 = 64): DraftDoc {
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: {
      // top-left, top-right, bottom-right, bottom-left (v grows downward)
      outline: [
        [0.08, 0.03],
        [0.92, 0.03],
        [0.92, 0.97],
        [0.08, 0.97],
      ],
      darts: [],
      seams: [],
      // Top (0→1, neckline) and bottom (2→3, hem) stay open → a wearable tube;
      // the two sides auto-sew front↔back.
      openEdges: [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
      ],
      width: 0.95,
      height: 1.15,
      topY: 1.55,
      gap: 0.9,
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
