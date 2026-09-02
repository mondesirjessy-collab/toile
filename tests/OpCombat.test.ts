import { describe, expect, it } from 'vitest';
import { opCombatShirt, opCombatChestCm, OP_COMBAT_SIZES } from '../src/engine/pattern/openPattern';
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

describe('British 95 Combat Shirt openpattern (v298)', () => {
  const doc = opCombatShirt('M', BODY, BODY);

  it('montage 2 faces + 2 manches + col, 4 coutures — sur les 6 tailles', () => {
    for (const size of OP_COMBAT_SIZES) {
      const d = opCombatShirt(size, BODY, BODY);
      expect(d.manual).toBe(true);
      expect(d.seams).toHaveLength(4);
      expect((d.pieces ?? []).map((p) => p.wrap).sort()).toEqual(['armL', 'armR', 'neck']);
      for (const piece of [d.piece, d.back!, ...(d.pieces ?? [])]) {
        expect(piece.outline.length).toBeGreaterThan(3);
        expect(piece.outline.every(([u, v]) => u >= -0.02 && u <= 1.02 && v >= -0.02 && v <= 1.02)).toBe(true);
      }
    }
  });

  it('les cotes du DXF fusionné : devant 81,9 cm (patte coupée), dos à queue plus long', () => {
    expect(doc.piece.width).toBeCloseTo(0.819, 2);
    expect(doc.piece.height).toBeCloseTo(0.789, 2);
    expect(doc.back!.width).toBeCloseTo(0.601, 2);
    expect(doc.back!.height).toBeCloseTo(0.861, 2); // queue de chemise
    expect(opCombatChestCm('M')).toBe(142);
  });

  it('coutures montables : chaque couture apparie des runs de longueurs voisines', () => {
    const runLen = (piece: typeof doc.piece, from: number, to: number): number => {
      const n = piece.outline.length;
      let len = 0;
      for (let i = from; i !== to; i = (i + 1) % n) {
        const a = piece.outline[i]!;
        const b = piece.outline[(i + 1) % n]!;
        len += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
      }
      return len;
    };
    const report: string[] = [];
    for (const seam of doc.seams!) {
      const la = runLen(doc.piece, seam.a.from, seam.a.to);
      const lb = runLen(doc.back!, seam.b.from, seam.b.to);
      report.push(`devant ${(la * 100).toFixed(1)} cm ↔ dos ${(lb * 100).toFixed(1)} cm`);
      // Embu de chemise toléré (le dos est plus long/galbé), mais jamais
      // un mésappariement franc (épaule cousue sur un côté, etc.).
      expect(Math.abs(la - lb), report.join(' | ')).toBeLessThan(Math.max(la, lb) * 0.25);
    }
    console.log('coutures :', report.join(' | '));
  });

  it('manche longue ré-émise : bouche ≈ emmanchure (le solveur a convergé)', () => {
    const sleeve = (doc.pieces ?? []).find((p) => p.wrap === 'armR')!;
    expect(sleeve.height).toBeCloseTo(0.714, 2);
    const cap = sleeve.outline[0]![1];
    expect(cap).toBeGreaterThanOrEqual(0.03);
    expect(cap).toBeLessThanOrEqual(0.35);
    expect(sleeve.width).toBeGreaterThan(0.1);
    expect(sleeve.width).toBeLessThanOrEqual(0.364); // jamais plus large que le patron (72,6/2)
  });
});
