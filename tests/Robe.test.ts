import { describe, expect, it } from 'vitest';
import { compileAssembly, compileDraft } from '../src/engine/pattern/Draft';
import { ROBE_SIZES, draftRobe, robeBodyCm, robeCm } from '../src/engine/pattern/robe';
import type { BodyMeasure } from '../src/engine/body/measure';

/** Mannequin de test — le même corps femme plausible que les tests de la jupe. */
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

const REF = BODY;

// Demi-largeur (m) d'un point d'outline autour du milieu de pièce.
const halfAt = (piece: { outline: [number, number][]; width: number }, index: number): number =>
  Math.abs((piece.outline[index]![0] - 0.5) * piece.width);

describe('la robe cintrée (v194)', () => {
  it('la table des tailles grade de 4 en 4, écarts poitrine/taille/hanches constants', () => {
    let previous = 0;
    for (const size of ROBE_SIZES) {
      const { poitrineCm, tailleCm, hanchesCm } = robeCm(size);
      expect(poitrineCm - tailleCm).toBe(20);
      expect(hanchesCm - tailleCm).toBe(24); // les colonnes de la jupe, à l'identique
      expect(poitrineCm).toBeGreaterThan(previous);
      previous = poitrineCm;
    }
  });

  it('« avatar » coupe aux mensurations mesurées du corps courant', () => {
    const body = robeBodyCm('avatar', BODY);
    expect(body.poitrineCm).toBeCloseTo(85, 1);
    expect(body.tailleCm).toBeCloseTo(68, 1);
    expect(body.hanchesCm).toBeCloseTo(92, 1);
  });

  it('la silhouette est cintrée puis évasée : taille < poitrine, taille < hanche < ourlet', () => {
    for (const size of [...ROBE_SIZES, 'avatar'] as const) {
      const doc = draftRobe(size, BODY, REF);
      for (const piece of [doc.piece, doc.back!]) {
        const bust = halfAt(piece, 5);
        const waist = halfAt(piece, 6);
        const hip = halfAt(piece, 7);
        const hem = halfAt(piece, 8);
        expect(waist).toBeLessThan(bust); // le cintrage vit dans le côté
        expect(waist).toBeLessThan(hip);
        expect(hem).toBeGreaterThan(hip); // la ligne A sous la hanche
      }
    }
  });

  it('la robe TIENT par les épaules : encolure posée en dedans des points d’épaule', () => {
    const doc = draftRobe('38', BODY, REF);
    for (const piece of [doc.piece, doc.back!]) {
      const neck = halfAt(piece, 1);
      const shoulder = halfAt(piece, 2);
      expect(neck).toBeLessThan(shoulder * 0.5); // large appui d'épaule de chaque côté
      expect(piece.outline[1]![1]).toBe(0); // la ligne d'épaule EST le haut de pièce
    }
  });

  it('les verticales viennent du corps : taille, hanche et genou mesurés', () => {
    const doc = draftRobe('38', BODY, REF);
    const p = doc.piece;
    const yAt = (index: number): number => p.topY - p.outline[index]![1] * p.height;
    // v = 0 se pose à l'épaule après l'habillage ; les profondeurs sont donc
    // shoulderY − cote. On vérifie en re-projetant depuis topY gradé.
    const drop = p.topY - (1.52 + (BODY.shoulderY - REF.shoulderY)); // = 0 ici
    expect(drop).toBeCloseTo(0, 9);
    expect(BODY.shoulderY - (1.52 - yAt(6))).toBeCloseTo(BODY.waist.y, 6); // taille
    expect(BODY.shoulderY - (1.52 - yAt(7))).toBeCloseTo(BODY.hip.y, 6); // hanche
    expect(BODY.shoulderY - (1.52 - yAt(8))).toBeCloseTo(0.3 * BODY.height, 6); // genou
  });

  it('DEVANT et DOS partagent côtés et ourlet ; encolure et emmanchures diffèrent', () => {
    const doc = draftRobe('40', BODY, REF);
    const front = doc.piece;
    const back = doc.back!;
    // Symétrie miroir de chaque face.
    for (const piece of [front, back]) {
      for (const [right, left] of [[5, 12], [6, 11], [7, 10], [8, 9]] as const) {
        expect(halfAt(piece, right)).toBeCloseTo(halfAt(piece, left), 9);
      }
    }
    // Les coutures de côté apparient les MÊMES index → mêmes géométries devant/dos.
    for (const index of [5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(front.outline[index]![0]).toBeCloseTo(back.outline[index]![0], 9);
      expect(front.outline[index]![1]).toBeCloseTo(back.outline[index]![1], 9);
    }
    // Devant creusé, dos sobre — comme sur un vrai bloc.
    expect(front.outline[0]![1]).toBeGreaterThan(back.outline[0]![1]); // encolure
    expect(halfAt(front, 4)).toBeLessThan(halfAt(back, 4)); // emmanchure plus creuse devant
  });

  it('quatre coutures et quatre ouvertures : épaules, côtés ; encolure, emmanchures, ourlet', () => {
    const doc = draftRobe('38', BODY, REF);
    expect(doc.seams?.length).toBe(4);
    for (const piece of [doc.piece, doc.back!]) {
      expect(piece.openEdges.length).toBe(4);
      expect(piece.darts.length).toBe(0); // le cintrage vit dans les côtés, pas en pinces
    }
  });

  it('compile sans accroc : pièces rasterisées, quatre coutures épinglées', () => {
    const doc = draftRobe('38', BODY, REF);
    for (const piece of [doc.piece, doc.back!]) {
      const compiled = compileDraft(piece, doc.gridN);
      expect(compiled.openCells.size).toBeGreaterThan(0);
    }
    const pins = compileAssembly(doc, doc.gridN);
    expect(pins.length).toBeGreaterThan(40); // épaules + longs côtés réels
    expect(doc.preset).toBe('robe');
  });
});
