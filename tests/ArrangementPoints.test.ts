import { describe, expect, it } from 'vitest';
import { arrangementPoints, type BodyMeasure } from '../src/engine/body/measure';

const measure = (over: Partial<BodyMeasure> = {}): BodyMeasure => ({
  height: 1.65,
  neckY: 1.42,
  shoulderY: 1.38,
  shoulderHalfW: 0.19,
  chest: { y: 1.22, halfW: 0.14, halfD: 0.11, circ: 0.9 },
  waist: { y: 1.03, halfW: 0.12, halfD: 0.1, circ: 0.75 },
  hip: { y: 0.86, halfW: 0.17, halfD: 0.12, circ: 0.98 },
  thigh: { y: 0.62, halfW: 0.08, halfD: 0.09, circ: 0.55 },
  arm: { y: 1.33, z: -0.02, rootX: 0.2 },
  ...over,
});

describe("points d'arrangement (concept Clo, mensurations réelles)", () => {
  it('place chaque ancre HORS du corps, à hauteur plausible', () => {
    const m = measure();
    const pts = arrangementPoints(m);
    expect(pts.length).toBe(10); // 8 corps + 2 bras (T-pose)

    const byId = Object.fromEntries(pts.map((p) => [p.id, p.pos]));
    // Devant/dos : dégagés au-delà de la demi-profondeur mesurée.
    expect(byId['torso-front']![2]).toBeGreaterThan(m.chest.halfD);
    expect(byId['torso-back']![2]).toBeLessThan(-m.chest.halfD);
    // Côtés : au-delà des épaules (deltoïdes compris).
    expect(byId['side-right']![0]).toBeGreaterThan(m.shoulderHalfW);
    expect(byId['side-left']![0]).toBeLessThan(-m.shoulderHalfW);
    // Bras : au-dessus de l'axe mesuré, au-delà de la racine.
    expect(byId['arm-right']![1]).toBeGreaterThan(m.arm!.y);
    expect(byId['arm-right']![0]).toBeGreaterThan(m.arm!.rootX);
    // Hauteurs dans le corps [0, height + marge].
    for (const p of pts) {
      expect(p.pos[1]).toBeGreaterThan(0);
      expect(p.pos[1]).toBeLessThan(m.height + 0.3);
      expect(p.labelFr.length).toBeGreaterThan(2);
    }
  });

  it('paires symétriques : miroir exact en x', () => {
    const pts = arrangementPoints(measure());
    const byId = Object.fromEntries(pts.map((p) => [p.id, p.pos]));
    for (const [r, l] of [
      ['side-right', 'side-left'],
      ['leg-right', 'leg-left'],
      ['arm-right', 'arm-left'],
    ] as const) {
      expect(byId[r]![0]).toBeCloseTo(-byId[l]![0], 9);
      expect(byId[r]![1]).toBeCloseTo(byId[l]![1], 9);
      expect(byId[r]![2]).toBeCloseTo(byId[l]![2], 9);
    }
  });

  it('sans axe de bras mesuré (bras baissés) : pas de pastilles bras', () => {
    const pts = arrangementPoints(measure({ arm: undefined }));
    expect(pts.length).toBe(8);
    expect(pts.every((p) => !p.id.startsWith('arm-'))).toBe(true);
  });

  it('suit la stature : un corps plus grand remonte les ancres', () => {
    const small = arrangementPoints(measure());
    const tall = arrangementPoints(
      measure({
        chest: { y: 1.4, halfW: 0.15, halfD: 0.12, circ: 0.95 },
        waist: { y: 1.2, halfW: 0.13, halfD: 0.11, circ: 0.8 },
      }),
    );
    const yOf = (pts: ReturnType<typeof arrangementPoints>, id: string): number =>
      pts.find((p) => p.id === id)!.pos[1];
    expect(yOf(tall, 'torso-front')).toBeGreaterThan(yOf(small, 'torso-front'));
  });
});
