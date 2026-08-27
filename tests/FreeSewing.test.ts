import { describe, expect, it } from 'vitest';
import { Aaron } from '@freesewing/aaron';
import { Brian } from '@freesewing/brian';
import * as models from '@freesewing/models';
import { freeSewingPieces } from '../src/engine/pattern/freeSewing';
import { isSelfIntersecting } from '../src/engine/pattern/Draft';

const measure = models.cisFemaleAdult38 as Record<string, number>;

function draft(Design: new (opts: object) => { draft(): void; parts: unknown }): unknown {
  const pattern = new Design({ measurements: measure });
  pattern.draft();
  return pattern;
}

describe('pont FreeSewing → TOILE', () => {
  it('Aaron (débardeur) : devant/dos dépliés + bandes, contours valides', () => {
    const pieces = freeSewingPieces(draft(Aaron) as never);
    const byName = new Map(pieces.map((p) => [p.name, p.piece]));
    // Aaron expose front, back (sur pliure) et les bandes emmanchure/encolure.
    expect(byName.has('front')).toBe(true);
    expect(byName.has('back')).toBe(true);

    for (const { name, piece } of pieces) {
      // Contour fermé valide, dans [0,1]², non auto-sécant.
      expect(piece.outline.length).toBeGreaterThanOrEqual(3);
      for (const [u, v] of piece.outline) {
        expect(u).toBeGreaterThanOrEqual(-0.001);
        expect(u).toBeLessThanOrEqual(1.001);
        expect(v).toBeGreaterThanOrEqual(-0.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
      expect(isSelfIntersecting(piece.outline), `${name} auto-sécant`).toBe(false);
      // Dimensions physiques plausibles (cm).
      expect(piece.width).toBeGreaterThan(0.02);
      expect(piece.width).toBeLessThan(1.5);
      expect(piece.height).toBeGreaterThan(0.02);
      expect(piece.height).toBeLessThan(1.5);
    }
  });

  it('le dépliage double la largeur du devant et le rend symétrique', () => {
    const pieces = freeSewingPieces(draft(Aaron) as never);
    const front = pieces.find((p) => p.name === 'front')!.piece;
    // Le demi-devant Aaron fait ~26,5 cm ; déplié il approche le tour de
    // poitrine/2 — nettement plus large que le demi-patron brut.
    expect(front.width).toBeGreaterThan(0.4);
    // Symétrie : pour chaque sommet il existe un miroir u→1−u à même v (±).
    const pts = front.outline;
    let symMatches = 0;
    for (const [u, v] of pts) {
      if (pts.some(([u2, v2]) => Math.abs(u2 - (1 - u)) < 0.04 && Math.abs(v2 - v) < 0.04)) symMatches += 1;
    }
    expect(symMatches / pts.length).toBeGreaterThan(0.8);
  });

  it('Brian (bloc de base) : produit au moins une pièce exploitable', () => {
    const pieces = freeSewingPieces(draft(Brian) as never);
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    for (const { piece } of pieces) {
      expect(piece.outline.length).toBeGreaterThanOrEqual(3);
      expect(isSelfIntersecting(piece.outline)).toBe(false);
    }
  });
});
