import { describe, expect, it } from 'vitest';
import { fitProofLines } from '../src/app/brief/FitProof';

const report = (zones: Array<Record<string, unknown>>, seamMax?: number): unknown => ({
  zones,
  ...(seamMax !== undefined ? { coutures: { surTensionMaxMm: seamMax, surTensionMoyMm: 0 } } : {}),
});

describe('fitProofLines — la preuve par les mesures (v294)', () => {
  it('compare zone à zone avec delta signé, virgule française', () => {
    const avant = report(
      [
        { zone: 'poitrine', aisanceMm: { min: 1.2, moy: 9 }, etirementPct: { moy: 2.1, p95: 4.8 } },
        { zone: 'bas/ourlet', aisanceMm: { min: 36, moy: 41 }, etirementPct: { moy: 0.4, p95: 1.1 } },
      ],
      0.4,
    );
    const apres = report(
      [
        { zone: 'poitrine', aisanceMm: { min: 24, moy: 30 }, etirementPct: { moy: 0.9, p95: 1.9 } },
        { zone: 'bas/ourlet', aisanceMm: { min: 36.5, moy: 42 }, etirementPct: { moy: 0.4, p95: 1.1 } },
      ],
      0.1,
    );
    const lines = fitProofLines(avant, apres);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('poitrine — aisance min 1,2 → 24 mm (+22,8) · étirement p95 4,8 → 1,9 % (-2,9)');
    expect(lines[1]).toContain('bas/ourlet — aisance min 36 → 36,5 mm (+0,5)');
    expect(lines[1]).toContain('étirement p95 1,1 → 1,1 % (=)');
    expect(lines[2]).toBe('coutures — sur-tension max 0,4 → 0,1 mm (-0,3)');
  });

  it('n’invente pas : zones absentes d’un côté ignorées, rapports invalides = vide', () => {
    const avant = report([
      { zone: 'manches', aisanceMm: { min: 3, moy: 8 }, etirementPct: { moy: 1, p95: 2 } },
      { zone: 'poitrine', aisanceMm: { min: 5, moy: 9 }, etirementPct: { moy: 1, p95: 2 } },
    ]);
    // Les manches ont disparu (suggestion « sans manches ») : la zone n'est pas comparable.
    const apres = report([{ zone: 'poitrine', aisanceMm: { min: 7, moy: 11 }, etirementPct: { moy: 1, p95: 1.5 } }]);
    const lines = fitProofLines(avant, apres);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('poitrine');
    expect(fitProofLines(null, apres)).toEqual([]);
    expect(fitProofLines({ zones: 'pas un tableau' }, apres)).toEqual([]);
  });
});
