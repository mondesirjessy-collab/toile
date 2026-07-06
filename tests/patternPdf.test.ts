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
