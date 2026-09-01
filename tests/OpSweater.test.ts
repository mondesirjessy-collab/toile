import { describe, expect, it } from 'vitest';
import { opNavySweater } from '../src/engine/pattern/openPattern';
import type { BodyMeasure } from '../src/engine/body/measure';

const BODY: BodyMeasure = {
  height: 1.7,
  neckY: 1.45,
  shoulderY: 1.42,
  shoulderHalfW: 0.19,
  chest: { y: 1.24, halfW: 0.155, halfD: 0.11, circ: 0.85 },
  waist: { y: 1.08, halfW: 0.125, halfD: 0.09, circ: 0.68 },
  hip: { y: 0.92, halfW: 0.17, halfD: 0.115, circ: 0.92 },
  thigh: { y: 0.72, halfW: 0.09, halfD: 0.09, circ: 0.56 },
};

describe('Navy Sweater openpattern (v297)', () => {
  const doc = opNavySweater(BODY, BODY);

  it('montage 2 faces + 2 manches + bande de col, 4 coutures', () => {
    expect(doc.manual).toBe(true);
    expect(doc.seams).toHaveLength(4);
    expect(doc.pieces).toHaveLength(3); // 2 manches + col
    const wraps = (doc.pieces ?? []).map((p) => p.wrap).sort();
    expect(wraps).toEqual(['armL', 'armR', 'neck']);
  });

  it('les cotes du DXF : devant/dos 62 cm, manches LONGUES ~54 cm fuselées', () => {
    expect(doc.piece.width).toBeCloseTo(0.62, 2);
    expect(doc.back!.width).toBeCloseTo(0.62, 2);
    expect(doc.piece.height).toBeCloseTo(0.675, 2);
    const sleeve = (doc.pieces ?? []).find((p) => p.wrap === 'armR')!;
    expect(sleeve.height).toBeCloseTo(0.5385, 3); // manche longue (vs 0,28 au tee)
    // Tête à plat du patron (30 cm en demi-panneau) PLUS LARGE que
    // l'emmanchure de ce corps : la largeur est résolue À LA BAISSE pour que
    // la bouche épouse l'emmanchure (leçon v267) — jamais au-delà du patron.
    expect(sleeve.width).toBeGreaterThan(0.2);
    expect(sleeve.width).toBeLessThan(0.301);
    // Fuselage réel du patron (~0,51) : le bas du panneau est nettement
    // plus étroit que la tête — au tee loose (0,9) il est quasi droit.
    const bottom = sleeve.outline.filter(([, v]) => v > 0.9).map(([u]) => u);
    expect(Math.max(...bottom) - Math.min(...bottom)).toBeLessThan(0.6);
  });

  it('contours sains et bouche de manche ≈ emmanchure (couture montable)', () => {
    for (const piece of [doc.piece, doc.back!, ...(doc.pieces ?? [])]) {
      expect(piece.outline.length).toBeGreaterThan(3);
      expect(piece.outline.every(([u, v]) => u >= -0.02 && u <= 1.02 && v >= -0.02 && v <= 1.02)).toBe(true);
    }
    // La flèche de tête est RÉSOLUE pour que la bouche du demi-panneau colle à
    // l'emmanchure : cap dans les bornes du solveur = la sécante a convergé.
    const sleeve = (doc.pieces ?? []).find((p) => p.wrap === 'armR')!;
    const cap = sleeve.outline[0]![1];
    expect(cap).toBeGreaterThan(0.03);
    expect(cap).toBeLessThan(0.35);
  });
});
