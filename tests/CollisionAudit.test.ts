import { describe, expect, it } from 'vitest';
import {
  summarizeCollisionAudit,
  summarizeVisualCollisionAudit,
} from '../src/engine/solver/CollisionAudit';

describe('résumé de l’audit collision', () => {
  it('respecte la profondeur signée, les seuils et les sentinelles GPU', () => {
    const report = summarizeCollisionAudit({
      positions: new Float32Array([
        1, 2, 3,
        4, 5, 6,
        7, 8, 9,
        10, 11, 12,
        13, 14, 15,
      ]),
      distances: new Float32Array([
        -0.0055,
        -0.0021,
        -0.0006,
        Number.POSITIVE_INFINITY,
        Number.NaN,
      ]),
      contactOffsets: new Float32Array([0.005, 0.005, 0.0025, 0.005, Number.NaN]),
    });

    expect(report.totalParticles).toBe(4);
    expect(report.sampledParticles).toBe(3);
    expect(report.outsideDomain).toBe(1);
    expect(report.penetrating).toEqual({
      over0_5mm: 3,
      over1mm: 2,
      over2mm: 2,
      over5mm: 1,
    });
    expect(report.penetratingPct.over2mm).toBe(50);
    expect(report.maxDepthMm).toBeCloseTo(5.5);
    expect(report.worstZones[0]).toMatchObject({ x: 1, y: 2, z: 3 });
  });

  it('calcule la moyenne sur la bande de contact sans polluer avec le drapé libre', () => {
    const report = summarizeCollisionAudit({
      positions: new Float32Array(9),
      distances: new Float32Array([0.005, 0.04, -0.001]),
      contactOffsets: new Float32Array([0.005, 0.005, 0.005]),
    });

    expect(report.contactParticles).toBe(2);
    expect(report.meanDepthMm).toBeCloseTo(-2);
    expect(report.meanClearanceMm).toBeCloseTo(-3);
    expect(report.maxDepthMm).toBeCloseTo(1);
  });

  it('v2 mesure tous les sommets rendus, épingles comprises, sans inclure les cellules coupées', () => {
    const report = summarizeVisualCollisionAudit({
      positions: new Float32Array([
        0.04, 0, 0,
        0.05, 0, 0,
        0.06, 0, 0,
        -99, -99, -99,
      ]),
      // NaN emulates a held pin in the legacy solver snapshot. V2 must still
      // measure it because the render triangle references it.
      distances: new Float32Array([0.005, Number.NaN, 0.005, Number.NaN]),
      contactOffsets: new Float32Array([0.005, 0.005, 0.005, Number.NaN]),
    }, {
      triangleIndices: new Uint32Array([0, 1, 2]),
      signedDistance: (x) => x,
    });

    expect(report.version).toBe(2);
    expect(report.metric).toBe('visual-body-mesh');
    expect(report.totalParticles).toBe(3);
    expect(report.sampledParticles).toBe(3);
    expect(report.meanDepthMm).toBeCloseTo(-50);
    expect(report.meanSignedDistanceMm).toBeCloseTo(50);
    expect(report.surfaceSamples.sampled).toBe(4);
  });

  it('v2 échantillonne l’intérieur des triangles en plus de leurs sommets', () => {
    const report = summarizeVisualCollisionAudit({
      positions: new Float32Array([
        -1, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      distances: new Float32Array(3),
      contactOffsets: new Float32Array(3).fill(0.005),
    }, {
      triangleIndices: new Uint32Array([0, 1, 2]),
      // Synthetic curved-body crossing: vertices are outside, while the middle
      // of the cloth triangle is inside by 2 mm.
      signedDistance: (x, y) => Math.hypot(x, y - 0.25) < 0.35 ? -0.002 : 0.02,
    });

    expect(report.penetrating.over0_5mm).toBe(0);
    expect(report.surfaceSamples.penetrating).toBeGreaterThan(0);
    expect(report.surfaceSamples.maxDepthMm).toBeCloseTo(2);
  });
});
