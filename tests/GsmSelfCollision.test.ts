import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(
  new URL('../src/engine/solver/shaders/selfCollide.wgsl', import.meta.url),
  'utf8',
);

describe('auto-collision et grammages différents', () => {
  it('pondère la séparation par les masses inverses tout en conservant le cas historique', () => {
    expect(shader).toContain('let wi = inv_masses[i];');
    expect(shader).toContain('let wj = inv_masses[j];');
    expect(shader).toContain(
      'let pair_weight = 0.6 * wi / max(wi + wj, 1e-9);',
    );

    const weight = (wi: number, wj: number): number => (0.6 * wi) / (wi + wj);
    expect(weight(1, 1)).toBeCloseTo(0.3); // comportement précédent

    // À aire identique : 80 g/m² => wi=2,5 ; 400 g/m² => wi=0,5.
    const light = weight(2.5, 0.5);
    const heavy = weight(0.5, 2.5);
    expect(light / heavy).toBeCloseTo(5);
    // La correction opposée ne déplace pas le centre de masse du couple.
    expect(light / 2.5 - heavy / 0.5).toBeCloseTo(0);
  });
});
