import { describe, expect, it } from 'vitest';
import {
  summarizeClothOverlapAudit,
  summarizeDeclaredSeamAudit,
} from '../src/engine/solver/ClothOverlapAudit';

function parallelPlates(gapM: number): {
  positions: Float32Array;
  triangleIndices: Uint32Array;
} {
  return {
    positions: new Float32Array([
      -0.1, -0.1, 0,
      0.1, -0.1, 0,
      0.1, 0.1, 0,
      -0.1, 0.1, 0,
      -0.1, -0.1, gapM,
      0.1, -0.1, gapM,
      0.1, 0.1, gapM,
      -0.1, 0.1, gapM,
    ]),
    triangleIndices: new Uint32Array([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
    ]),
  };
}

const groups = {
  groupA: { label: 'front', ranges: [{ first: 0, count: 4 }] },
  groupB: { label: 'back', ranges: [{ first: 4, count: 4 }] },
} as const;

describe('audit visible tissu contre tissu', () => {
  it('mesure exactement chaque paire Seam, AttachmentSeam et SurfaceSeam déclarée', () => {
    const positions = new Float32Array([
      0, 0, 0,
      0, 0, 0.002,
      1, 0, 0,
      1, 0, 0.008,
      2, 0, 0,
      2, 0, 0.004,
      3, 0, 0,
      3, 0, 0.005,
    ]);
    const constraintData = new ArrayBuffer(4 * 16);
    const constraints = new DataView(constraintData);
    const write = (
      index: number,
      i: number,
      j: number,
      rest: number,
      kind: number,
    ): void => {
      const offset = index * 16;
      constraints.setUint32(offset, i, true);
      constraints.setUint32(offset + 4, j, true);
      constraints.setFloat32(offset + 8, rest, true);
      constraints.setUint32(offset + 12, kind, true);
    };
    write(0, 0, 1, 0.001, 3);
    write(1, 2, 3, 0.001, 3);
    write(2, 4, 5, 0.003, 5);
    write(3, 6, 7, 0.001, 6);

    const report = summarizeDeclaredSeamAudit({
      positions,
      constraintData,
      constraintCount: 4,
      effectiveThicknessM: 0.006,
    });

    expect(report.effectiveThicknessMm).toBeCloseTo(6);
    expect(report.all.count).toBe(4);
    expect(report.all.minDistanceMm).toBeCloseTo(2);
    expect(report.all.meanDistanceMm).toBeCloseTo(19 / 4);
    expect(report.all.maxDistanceMm).toBeCloseTo(8);
    expect(report.all.overEffectiveThickness).toBe(1);
    expect(report.regular.count).toBe(3);
    expect(report.regular.overEffectiveThickness).toBe(1);
    expect(report.regular.worstPair).toMatchObject({ i: 2, j: 3 });
    expect(report.surface.count).toBe(1);
    expect(report.surface.overEffectiveThickness).toBe(0);
    expect(report.surface.worstPair?.restDistanceMm).toBeCloseTo(3);
  });

  it('mesure deux plaques à 5 mm sans faux contact sous le seuil de 3 mm', () => {
    const report = summarizeClothOverlapAudit({
      ...parallelPlates(0.005),
      ...groups,
      thicknessM: 0.006,
    });

    expect(report.applicable).toBe(true);
    expect(report.minDistanceMm).toBeCloseTo(5, 4);
    expect(report.closeThresholdMm).toBeCloseTo(3);
    expect(report.closePairsRaw).toBe(0);
    expect(report.closePairsExcludingSewnBand).toBe(0);
    expect(report.intersectionsRaw).toBe(0);
  });

  it('signale dans les deux directions deux plaques à 2 mm', () => {
    const report = summarizeClothOverlapAudit({
      ...parallelPlates(0.002),
      ...groups,
      thicknessM: 0.006,
    });

    expect(report.minDistanceMm).toBeCloseTo(2, 4);
    expect(report.directions.aToB.sampledVertices).toBe(4);
    expect(report.directions.bToA.sampledVertices).toBe(4);
    expect(report.directions.aToB.closePairsRaw).toBe(4);
    expect(report.directions.bToA.closePairsRaw).toBe(4);
    expect(report.closePairsRaw).toBe(8);
    expect(report.closePairsExcludingSewnBand).toBe(8);
  });

  it('conserve le brut mais exclut une bande cousue du compteur actionnable', () => {
    const seamDist = new Uint8Array(8).fill(3);
    seamDist.fill(0, 0, 4);
    const report = summarizeClothOverlapAudit({
      ...parallelPlates(0.002),
      ...groups,
      thicknessM: 0.006,
      seamDist,
    });

    expect(report.closePairsRaw).toBe(8);
    expect(report.closePairsExcludingSewnBand).toBe(0);

    const seamFree = new Uint8Array(8);
    seamFree.fill(1, 0, 4);
    const explicitExemption = summarizeClothOverlapAudit({
      ...parallelPlates(0.002),
      ...groups,
      thicknessM: 0.006,
      seamFree,
    });
    expect(explicitExemption.closePairsRaw).toBe(8);
    expect(explicitExemption.closePairsExcludingSewnBand).toBe(0);
  });

  it('détecte une intersection intérieure même lorsque les sommets restent éloignés', () => {
    const report = summarizeClothOverlapAudit({
      positions: new Float32Array([
        -1, -1, 0,
        1, -1, 0,
        1, 1, 0,
        -1, 1, 0,
        0, -1, -1,
        0, -1, 1,
        0, 1, 1,
        0, 1, -1,
      ]),
      triangleIndices: new Uint32Array([
        0, 1, 2, 0, 2, 3,
        4, 5, 6, 4, 6, 7,
      ]),
      ...groups,
      thicknessM: 0.006,
    });

    expect(report.closePairsRaw).toBe(0);
    expect(report.intersectionsRaw).toBeGreaterThan(0);
    expect(report.intersectionsExcludingSewnBand).toBe(report.intersectionsRaw);
  });
});
