import { describe, it, expect } from 'vitest';
import { draftTee, oversizeTee } from '../src/engine/pattern/draftTee';
import { pointInPolygon, sanitizeDraft } from '../src/engine/pattern/Draft';
import { countMaskIslands } from '../src/engine/cloth/ClothMesh';
import type { BodyMeasure } from '../src/engine/body/measure';

const level = (halfW: number, circ: number, y: number) => ({ y, halfW, halfD: halfW * 0.9, circ });
const mkMeasure = (chestCirc: number, shoulderHalfW = 0.26): BodyMeasure => ({
  height: 1.755,
  neckY: 1.549,
  shoulderY: 1.396,
  shoulderHalfW,
  chest: level(0.15, chestCirc, 1.27),
  waist: level(0.14, 0.763, 1.098),
  hip: level(0.19, 1.061, 0.892),
  thigh: level(0.1, 0.39, 0.7),
});

describe('draftTee (measurement-drafted t-shirt)', () => {
  const ref = mkMeasure(0.78);

  it('front neckline is deeper than the back (a real tee, worn the right way)', () => {
    const doc = draftTee(mkMeasure(0.78), ref);
    // Point 0 = neck-centre scoop bottom; bigger v = lower = deeper scoop.
    expect(doc.piece.outline[0]![1]).toBeGreaterThan(doc.back!.outline[0]![1]);
    expect(doc.manual).toBe(true);
    expect(doc.seams!.length).toBe(4); // shoulders (R/L) + sides (R/L), front↔back
  });

  it('the side width follows the chest measurement (not a fixed scale)', () => {
    const narrow = draftTee(mkMeasure(0.62), ref);
    const wide = draftTee(mkMeasure(1.0), ref);
    // Point 5 = right underarm; a bigger chest pushes it further from the centre.
    expect(wide.piece.outline[5]![0]).toBeGreaterThan(narrow.piece.outline[5]![0]);
  });

  it('each face rasterises to one connected piece (no fragment falls off)', () => {
    const doc = draftTee(mkMeasure(0.78), ref);
    const n = 48;
    for (const piece of [doc.piece, doc.back!]) {
      const kept: boolean[] = [];
      for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept.push(pointInPolygon([u / (n - 1), v / (n - 1)], piece.outline));
      expect(countMaskIslands(kept, n)).toBe(1);
    }
  });
});

describe('oversizeTee (le patron K.Kose 4 pièces, gradé)', () => {
  const ref = mkMeasure(0.78);

  it('4 pièces : devant + dos + 2 manches wrap (G et D)', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    expect(doc.back).toBeTruthy();
    expect(doc.pieces!.length).toBe(2);
    expect(doc.pieces!.map((p) => p.wrap).sort()).toEqual(['armL', 'armR']);
    expect(doc.seams!.length).toBe(4); // épaules ×2 + côtés pleine hauteur ×2
  });

  it('col devant creusé, dos haut (comme le patron de référence)', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    expect(doc.piece.outline[8]![1]).toBeGreaterThan(doc.back!.outline[8]![1]);
  });

  it('gradé sur la poitrine : plus large ET manche au biceps plus grande sur un plus grand tour', () => {
    const s = oversizeTee(mkMeasure(0.62), ref);
    const l = oversizeTee(mkMeasure(1.0), ref);
    expect(l.piece.width).toBeGreaterThan(s.piece.width);
    expect(l.pieces![0]!.width).toBeGreaterThan(s.pieces![0]!.width);
  });

  it('chaque face rasterise en une seule pièce connexe', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    const n = 48;
    for (const piece of [doc.piece, doc.back!]) {
      const kept: boolean[] = [];
      for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept.push(pointInPolygon([u / (n - 1), v / (n - 1)], piece.outline));
      expect(countMaskIslands(kept, n)).toBe(1);
    }
  });

  it('survit au round-trip sanitizeDraft (export → import) avec ses manches wrap', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    const round = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    expect(round.pieces!.length).toBe(2);
    expect(round.pieces![0]!.wrap).toBe('armR');
    expect(round.pieces![0]!.width).toBeCloseTo(doc.pieces![0]!.width, 4);
    expect(round.seams!.length).toBe(4);
  });
});
