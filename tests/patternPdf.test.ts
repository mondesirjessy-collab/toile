import { describe, expect, it } from 'vitest';
import { combineClothMeshes, generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { frontOutline } from '../src/app/patternPdf';

describe('frontOutline (cutting layout)', () => {
  const n = 16;
  const tee = generateSeamedPanels({ resolution: n, width: 1.15, height: 0.75, gap: 0.9, topY: 1.52, shape: 'tshirt' });
  const dress = generateSeamedPanels({ resolution: n, width: 0.95, height: 1.3, gap: 1.2, topY: 1.78, shape: 'aline' });

  it('a single garment yields one piece sized to its cut', () => {
    const { segs, w, h, pieces } = frontOutline(tee);
    expect(pieces).toBe(1);
    expect(segs.length).toBeGreaterThan(0);
    expect(w).toBeCloseTo(1150, 0); // full sleeve span in mm
    expect(h).toBeCloseTo(750, 0);
  });

  it('emits short balance notches, kept apart from the boundary cut lines', () => {
    const { segs, seam, notches } = frontOutline(dress);
    expect(seam.length).toBe(segs.length); // notches do NOT inflate the boundary sets
    expect(notches.length).toBeGreaterThan(0); // the dress is wide enough for side notches
    for (const s of notches) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      expect(len).toBeGreaterThan(3);
      expect(len).toBeLessThan(10); // a tick, not a seam
    }
  });

  it('draws a seam allowance that wraps the cut line ~10 mm outside it', () => {
    const { segs, seam } = frontOutline(dress);
    expect(seam.length).toBe(segs.length); // one offset per boundary edge
    const bbox = (list: { x1: number; y1: number; x2: number; y2: number }[]) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const s of list) {
        minX = Math.min(minX, s.x1, s.x2);
        maxX = Math.max(maxX, s.x1, s.x2);
        minY = Math.min(minY, s.y1, s.y2);
        maxY = Math.max(maxY, s.y1, s.y2);
      }
      return { minX, maxX, minY, maxY };
    };
    const cut = bbox(segs);
    const sa = bbox(seam);
    // The allowance encloses the cut line and pushes out ~10 mm each way.
    expect(sa.minX).toBeLessThan(cut.minX);
    expect(sa.maxX).toBeGreaterThan(cut.maxX);
    expect(sa.minY).toBeLessThan(cut.minY);
    expect(sa.maxY).toBeGreaterThan(cut.maxY);
    expect(cut.minX - sa.minX).toBeGreaterThan(5);
    expect(cut.minX - sa.minX).toBeLessThan(15);
  });

  it('an outfit lays its front pieces side by side instead of stacking them', () => {
    const outfit = combineClothMeshes(tee, dress, [], 1);
    const { segs, w, pieces } = frontOutline(outfit);
    expect(pieces).toBe(2);
    // Their rest poses overlap on the body axis; on paper they must not.
    // Piece 1 (tee) occupies x < its width; piece 2 starts past the gutter.
    const teeW = 1150;
    const gutter = 30;
    let maxLeft = -Infinity;
    let minRight = Infinity;
    for (const s of segs) {
      const lo = Math.min(s.x1, s.x2);
      const hi = Math.max(s.x1, s.x2);
      if (hi <= teeW + 1) maxLeft = Math.max(maxLeft, hi);
      else minRight = Math.min(minRight, lo);
    }
    expect(maxLeft).toBeLessThanOrEqual(teeW + 1);
    expect(minRight).toBeGreaterThanOrEqual(teeW + gutter - 1);
    expect(w).toBeCloseTo(teeW + gutter + 950, 0); // tee + gutter + dress width
  });
});
