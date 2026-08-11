import { describe, expect, it } from 'vitest';
import {
  compileAssembly,
  compileCrossSeams,
  compileDraft,
  compileQuiltSeams,
  compileSurfaceSeams,
  docPieces,
  sanitizeDraft,
} from '../src/engine/pattern/Draft';
import {
  DOUDOUNE_AVATAR_EASE_CM,
  DOUDOUNE_CHANNELS,
  DOUDOUNE_PUFF,
  DOUDOUNE_SIZES,
  doudouneCm,
  doudouneFiniCm,
  draftDoudoune,
} from '../src/engine/pattern/doudoune';
import type { BodyMeasure } from '../src/engine/body/measure';

/** Le même corps femme plausible que les tests de la jupe, robe et veste. */
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

describe('la doudoune matelassée (v199)', () => {
  it('la table grade de 6 en 6, plus ample que la veste ; « avatar » = poitrine + aisance doudoune', () => {
    let previous = 0;
    for (const size of DOUDOUNE_SIZES) {
      expect(doudouneCm(size) - previous).toBe(previous === 0 ? doudouneCm(size) : 6);
      previous = doudouneCm(size);
    }
    expect(doudouneFiniCm('avatar', BODY)).toBe(Math.round(85 + DOUDOUNE_AVATAR_EASE_CM));
    expect(doudouneFiniCm('M', BODY)).toBe(122);
  });

  it('le tissu extérieur est coupé PLUS LONG : l’excès du matelassage vit dans le patron', () => {
    const doc = draftDoudoune('M', BODY, REF);
    // La hauteur du cadre extérieur dépasse la longueur portée (0,66 m) de
    // l'excès sous l'aisselle — c'est lui qui boudinera entre les canaux.
    expect(doc.piece.height).toBeGreaterThan(0.66 + 0.05);
    // Les doublures restent à l'échelle du vêtement PORTÉ (plus courtes).
    for (const l of doc.pieces!.slice(1)) {
      expect(l.height).toBeLessThan(0.66);
    }
  });

  it('chaque couche porte ses canaux : N lignes internes ouvertes, homologues et de même sens', () => {
    const doc = draftDoudoune('L', BODY, REF);
    const pieces = docPieces(doc);
    for (const pid of [0, 1, 2, 3, 4, 5]) {
      const lines = pieces[pid]!.internalLines ?? [];
      expect(lines.length).toBe(DOUDOUNE_CHANNELS);
      for (const line of lines) {
        expect(line.closed).toBeUndefined();
        expect(line.hole).toBeUndefined();
        expect(line.points.length).toBe(2);
        // Tracées gauche → droite (l'appariement suit l'ordre des points).
        expect(line.points[0]![0]).toBeLessThan(line.points[1]![0]);
      }
    }
    // L'espacement des canaux du TISSU EXTÉRIEUR excède celui de la doublure
    // du taux d'excès — l'écart EST le gonflant.
    const spacing = (piece: (typeof pieces)[number], heightM: number): number => {
      const vs = piece!.internalLines!.map((l) => l.points[0]![1]);
      return (vs[1]! - vs[0]!) * heightM;
    };
    const shellSpacing = spacing(pieces[1], pieces[1]!.height);
    const liningSpacing = spacing(pieces[5], pieces[5]!.height);
    expect(shellSpacing / liningSpacing).toBeCloseTo(1 + DOUDOUNE_PUFF, 2);
  });

  it('compileQuiltSeams épingle canal à canal, en plus du pourtour', () => {
    const doc = draftDoudoune('M', BODY, REF);
    const n = doc.gridN;
    for (const pid of [3, 4, 5]) {
      const quilt = compileQuiltSeams(doc, n, [], pid);
      // Chaque canal épingle une rangée de cellules (≥ N canaux × ~10 cellules).
      expect(quilt.length).toBeGreaterThan(DOUDOUNE_CHANNELS * 8);
      // Le pourtour reste une couture de surface, indépendante des canaux.
      expect(compileSurfaceSeams(doc, n, [], pid).length).toBeGreaterThan(20);
    }
    // Une pièce sans attachement de surface n'a pas de matelassage.
    expect(compileQuiltSeams(doc, n, [], 2)).toHaveLength(0);
  });

  it('le châssis veste est hérité : zip fermé, six pièces, compilation vivante', () => {
    const doc = draftDoudoune('M', BODY, REF);
    expect(docPieces(doc)).toHaveLength(6);
    expect(doc.preset).toBe('doudoune');
    const zips = doc.seams!.filter((s) => s.kind === 'zipper');
    expect(zips).toHaveLength(1);
    expect(zips[0]!.closed).toBe(true);
    const n = doc.gridN;
    for (const pid of [0, 1, 2]) {
      expect(compileDraft(docPieces(doc)[pid]!, n).openCells.size).toBeGreaterThan(0);
    }
    expect(compileAssembly(doc, n).length).toBeGreaterThan(30);
    expect(compileCrossSeams(doc, n, [], 2).length).toBeGreaterThan(50);
    expect(docPieces(doc)[2]!.singlePanel).toBe(true);
  });

  it('les canaux survivent à sanitizeDraft (autosave et restauration)', () => {
    const doc = draftDoudoune('M', BODY, REF);
    const round = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    for (const pid of [0, 1, 5]) {
      expect(docPieces(round)[pid]!.internalLines?.length).toBe(DOUDOUNE_CHANNELS);
    }
    expect(compileQuiltSeams(round, round.gridN, [], 5).length).toBeGreaterThan(
      DOUDOUNE_CHANNELS * 8,
    );
  });
});
