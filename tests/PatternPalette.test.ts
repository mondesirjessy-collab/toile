import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAL, setPatternTheme } from '../src/app/patternPalette';

const lum = (hex: string): number => {
  const v = parseInt(hex.slice(1), 16);
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
};

describe('palette du plan (v179)', () => {
  it('PAPIER éclaire le fond et passe le contour à l\'encre marine ; NUIT revient à l\'octet près', () => {
    setPatternTheme('nuit');
    expect(PAL.fond).toBe('transparent');
    const contourNuit = PAL.contourPiece;
    const grilleNuit = PAL.grilleRVB;
    setPatternTheme('papier');
    expect(lum(PAL.fond)).toBeGreaterThan(0.78); // un vrai papier, pas un gris
    expect(PAL.contourPiece).toMatch(/43, 63, 107/); // l'encre marine
    expect(PAL.grilleRVB).not.toBe(grilleNuit);
    setPatternTheme('nuit');
    expect(PAL.contourPiece).toBe(contourNuit);
    expect(PAL.grilleRVB).toBe(grilleNuit);
    expect(PAL.fond).toBe('transparent');
  });

  it('PatternView ne porte plus un seul littéral couleur — tout vient de la palette', () => {
    const src = readFileSync(new URL('../src/app/PatternView.ts', import.meta.url), 'utf8');
    const literals = src.match(/'(rgba\([0-9, .]*\)|#[0-9a-fA-F]{3,8})'/g) ?? [];
    expect(literals).toHaveLength(0);
  });

  it('les emplacements partagés restent identiques entre les deux thèmes', () => {
    setPatternTheme('nuit');
    const trouNuit = PAL.a02; // le fond du trou (rgba(8, 10, 14, 0.82)) reste sombre au jour
    setPatternTheme('papier');
    expect(PAL.a02).toBe(trouNuit);
    setPatternTheme('nuit');
  });
});
