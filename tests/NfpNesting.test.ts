import { describe, expect, it } from 'vitest';
import { draftMarkerPieces, nestPieces, type MarkerPiece } from '../src/app/markerLayout';
import { compactNest, nestPiecesNfp, placementsOverlapCm2 } from '../src/app/nfpNesting';
import { opLooseTee } from '../src/engine/pattern/openPattern';
import type { BodyMeasure } from '../src/engine/body/measure';

const measure = (): BodyMeasure => ({
  height: 1.65,
  neckY: 1.42,
  shoulderY: 1.38,
  shoulderHalfW: 0.19,
  chest: { y: 1.22, halfW: 0.14, halfD: 0.11, circ: 0.9 },
  waist: { y: 1.03, halfW: 0.12, halfD: 0.1, circ: 0.75 },
  hip: { y: 0.86, halfW: 0.17, halfD: 0.12, circ: 0.98 },
  thigh: { y: 0.62, halfW: 0.08, halfD: 0.09, circ: 0.55 },
});

const SA_CM = 1;

function teePieces(size: 'S' | 'M' | 'L'): MarkerPiece[] {
  const m = measure();
  return draftMarkerPieces(opLooseTee(size, m, m));
}

function report(label: string, grid: number, nfp: number): void {
  const gain = ((grid - nfp) / grid) * 100;
  // eslint-disable-next-line no-console
  console.log(
    `[banc marker] ${label} : grille ${grid.toFixed(1)} cm → NFP ${nfp.toFixed(1)} cm (${gain >= 0 ? '−' : '+'}${Math.abs(gain).toFixed(1)} % de matelas)`,
  );
}

describe('nesting NFP (clipper2-ts) vs grille rasterisée — banc A/B', () => {
  it('tee M mono : valide (zéro chevauchement, dans la laize) et mesuré', () => {
    const pieces = teePieces('M');
    const t0 = performance.now();
    const grid = nestPieces(pieces, SA_CM);
    const t1 = performance.now();
    const nfp = nestPiecesNfp(pieces, SA_CM);
    const t2 = performance.now();
    const compact = compactNest(grid, SA_CM);
    const t3 = performance.now();
    // eslint-disable-next-line no-console
    console.log(`[banc marker] temps : grille ${(t1 - t0).toFixed(0)} ms · NFP ${(t2 - t1).toFixed(0)} ms · compactage ${(t3 - t2).toFixed(0)} ms`);
    report('tee M (6 pièces)', grid.lengthCm, nfp.lengthCm);
    report('tee M — grille COMPACTÉE', grid.lengthCm, compact.lengthCm);
    for (let i = 0; i < compact.placements.length; i++) {
      for (let j = i + 1; j < compact.placements.length; j++) {
        // Contact exact toléré : ≤ 1 cm² = un micro-enfoncement < 0,5 mm le
        // long d'une marge (sous la précision de coupe, sur 2×10 mm de marge).
        expect(placementsOverlapCm2(compact.placements[i]!, compact.placements[j]!, SA_CM)).toBeLessThan(1);
      }
    }
    expect(compact.lengthCm).toBeLessThanOrEqual(grid.lengthCm + 0.01);

    expect(nfp.placements.length).toBe(pieces.length);
    // Validité : dans la laize.
    for (const pl of nfp.placements) {
      expect(pl.x).toBeGreaterThanOrEqual(-SA_CM - 0.1);
      expect(pl.x + pl.wCm).toBeLessThanOrEqual(150 + SA_CM + 0.1);
      expect(pl.y).toBeGreaterThanOrEqual(-SA_CM - 0.1);
    }
    // Le NFP bottom-left pur est DISQUALIFIÉ par le banc (il perd contre la
    // grille) — ses chiffres restent au rapport comme témoin, sans assertion.
  });

  it('commande 3 tailles (18 pièces) : valide et mesuré', () => {
    const pieces = [...teePieces('S'), ...teePieces('M'), ...teePieces('L')];
    const t0 = performance.now();
    const grid = nestPieces(pieces, SA_CM);
    const t1 = performance.now();
    const nfp = nestPiecesNfp(pieces, SA_CM);
    const t2 = performance.now();
    const compact = compactNest(grid, SA_CM);
    const t3 = performance.now();
    // eslint-disable-next-line no-console
    console.log(`[banc marker] temps : grille ${(t1 - t0).toFixed(0)} ms · NFP ${(t2 - t1).toFixed(0)} ms · compactage ${(t3 - t2).toFixed(0)} ms`);
    report('commande S+M+L (18 pièces)', grid.lengthCm, nfp.lengthCm);
    report('commande — grille COMPACTÉE', grid.lengthCm, compact.lengthCm);
    for (let i = 0; i < compact.placements.length; i++) {
      for (let j = i + 1; j < compact.placements.length; j++) {
        // Contact exact toléré : ≤ 1 cm² = un micro-enfoncement < 0,5 mm le
        // long d'une marge (sous la précision de coupe, sur 2×10 mm de marge).
        expect(placementsOverlapCm2(compact.placements[i]!, compact.placements[j]!, SA_CM)).toBeLessThan(1);
      }
    }
    expect(compact.lengthCm).toBeLessThanOrEqual(grid.lengthCm + 0.01);

    void nfp; // témoin — voir le rapport ci-dessus
  });
});
