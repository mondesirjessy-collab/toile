import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointInTriangle,
  isSelfIntersecting,
  sanitizeDraft,
  defaultDraft,
  insertOutlineVertex,
  deleteOutlineVertex,
  compileDraft,
  type UV,
} from '../src/engine/pattern/Draft';
import { generateSeamedPanels, countMaskIslands, type ClothMeshData } from '../src/engine/cloth/ClothMesh';

describe('Draft geometry', () => {
  const square: UV[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  it('pointInPolygon: inside vs outside a square', () => {
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], square)).toBe(false);
    expect(pointInPolygon([-0.1, 0.5], square)).toBe(false);
  });

  it('pointInPolygon: an L-shape excludes the notch', () => {
    const L: UV[] = [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0.5, 0.5],
      [0.5, 1],
      [0, 1],
    ];
    expect(pointInPolygon([0.25, 0.75], L)).toBe(true); // in the leg
    expect(pointInPolygon([0.75, 0.75], L)).toBe(false); // in the cut corner
  });

  it('pointInTriangle', () => {
    expect(pointInTriangle([0.25, 0.25], [0, 0], [1, 0], [0, 1])).toBe(true);
    expect(pointInTriangle([0.8, 0.8], [0, 0], [1, 0], [0, 1])).toBe(false);
  });

  it('isSelfIntersecting: simple square no, bowtie yes', () => {
    expect(isSelfIntersecting(square)).toBe(false);
    const bowtie: UV[] = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ];
    expect(isSelfIntersecting(bowtie)).toBe(true);
  });

  it('sanitizeDraft clamps coords and rejects a self-intersecting outline', () => {
    const bad = {
      format: 'toile-draft',
      version: 1,
      gridN: 64,
      piece: { outline: [[0, 0], [1, 1], [1, 0], [0, 1]], darts: [], seams: [], openEdges: [], width: 0.9, height: 1, topY: 1.5, gap: 0.9 },
    };
    const s = sanitizeDraft(bad); // bowtie (self-intersecting) → falls back to default
    expect(s.piece.outline).toEqual(defaultDraft(64).piece.outline);

    const ok = sanitizeDraft({
      format: 'toile-draft',
      version: 1,
      gridN: 999,
      piece: { outline: [[5, -3], [2, 0], [0.5, 2]], darts: [], seams: [], openEdges: [], width: 9, height: 1, topY: 1.5, gap: 0.9 },
    });
    expect(ok.gridN).toBe(64); // 999 rejected
    for (const [x, y] of ok.piece.outline) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    expect(ok.piece.width).toBeLessThanOrEqual(2); // 9 clamped
  });

  it('rejects a non-draft object', () => {
    expect(sanitizeDraft(null).format).toBe('toile-draft');
    expect(sanitizeDraft({ format: 'nope' }).piece.outline.length).toBeGreaterThanOrEqual(3);
  });

  it('insert/delete outline vertices and re-index the open runs', () => {
    const base = defaultDraft(64).piece; // 7 vertices, openEdges [{1,3},{5,6}]
    // Insert on edge 2 (between v2 and v3) → new vertex at index 3; runs ≥3 shift +1.
    const ins = insertOutlineVertex(base, 2, [0.55, 0.06]);
    expect(ins.outline.length).toBe(8);
    expect(ins.outline[3]).toEqual([0.55, 0.06]);
    expect(ins.openEdges[0]).toEqual({ from: 1, to: 4 }); // to 3 → 4 (was ≥3)
    expect(ins.openEdges[1]).toEqual({ from: 6, to: 7 }); // {5,6} → {6,7}
    // Delete brings it back toward the original count and re-indexes.
    const del = deleteOutlineVertex(ins, 3);
    expect(del.outline.length).toBe(7);
    expect(del.outline).toEqual(base.outline);
    // Never drop below a triangle.
    let tri = { ...base, outline: base.outline.slice(0, 3) };
    tri = deleteOutlineVertex(tri, 0);
    expect(tri.outline.length).toBe(3);
  });

  it('compileDraft: openEdges without darts, and darts pair their legs', () => {
    const base = defaultDraft(64).piece;
    const plain = compileDraft(base, 64);
    expect(plain.extraSeams.length).toBe(0); // no darts
    expect(plain.openCells.size).toBeGreaterThan(0); // neckline + hem cells open

    const withDart = compileDraft(
      { ...base, darts: [{ apex: [0.5, 0.45], legA: [0.45, 0.92], legB: [0.55, 0.92] }] },
      64,
    );
    expect(withDart.extraSeams.length).toBeGreaterThan(0); // legs sewn together
    for (const s of withDart.extraSeams) expect(s.i).not.toBe(s.j);
    // The dart opened MORE boundary cells (its two legs) than the plain piece.
    expect(withDart.openCells.size).toBeGreaterThan(plain.openCells.size);
  });
});

describe('freeform mesh (shape: freeform)', () => {
  const n = 32;
  const keptCount = (m: ClothMeshData): number => [...m.invMasses].filter((w) => w > 0).length;
  // Outline covering more than [0,1]² → every grid cell is inside → full mask.
  const fullOutline: UV[] = [
    [-0.05, -0.05],
    [1.05, -0.05],
    [1.05, 1.05],
    [-0.05, 1.05],
  ];

  it('a full-cover outline keeps the same mask as a plain rect', () => {
    const rect = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5 });
    const free = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    expect(free.count).toBe(rect.count);
    expect(keptCount(free)).toBe(keptCount(rect)); // all cells kept in both
    expect(keptCount(free)).toBe(2 * n * n);
    // Same fabric topology (mask identical) — structural/shear match.
    expect(free.structuralCount).toBe(rect.structuralCount);
    expect(free.shearCount).toBe(rect.shearCount);
  });

  it('a smaller polygon cuts cells and stays one island', () => {
    const tri: UV[] = [
      [0.5, 0.02],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
    const free = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: tri, darts: [] } });
    expect(keptCount(free)).toBeLessThan(2 * n * n); // triangle cuts corners
    expect(keptCount(free)).toBeGreaterThan(0);
    // Reconstruct the single-panel mask to check island count.
    const mask: boolean[] = [];
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) mask[v * n + u] = free.invMasses[v * n + u]! > 0;
    expect(countMaskIslands(mask, n)).toBe(1);
  });

  it('a dart cuts a wedge (fewer kept cells) and its legs can be sewn via extraSeams', () => {
    const noDart = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    const withDart = generateSeamedPanels({
      resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform',
      mask: { outline: fullOutline, darts: [{ apex: [0.5, 0.5], legA: [0.4, 0.98], legB: [0.6, 0.98] }] },
    });
    expect(keptCount(withDart)).toBeLessThan(keptCount(noDart)); // the wedge is removed

    // extraSeams add Seam constraints (front + back).
    const withSeam = generateSeamedPanels({
      resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform',
      mask: { outline: fullOutline, darts: [] },
      extraSeams: [{ i: 5 * n + 5, j: 5 * n + 10 }],
    });
    expect(withSeam.seamCount).toBe(noDart.seamCount + 2); // one pair × 2 panels
  });

  it('extraOpenings leave a boundary run unsewn', () => {
    // Sew nothing (whole boundary open) → far fewer seams than the sealed pillow.
    const sealed = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] } });
    const allOpen = generateSeamedPanels({ resolution: n, width: 1, height: 1, gap: 1, topY: 1.5, shape: 'freeform', mask: { outline: fullOutline, darts: [] }, extraOpenings: () => true });
    expect(allOpen.seamCount).toBeLessThan(sealed.seamCount);
  });
});
