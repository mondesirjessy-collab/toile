import { describe, expect, it } from 'vitest';
import { compileAssembly, compileDraft } from '../src/engine/pattern/Draft';
import { JUPE_SIZES, draftJupe, jupeBodyCm, jupeCm } from '../src/engine/pattern/jupe';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import type { BodyMeasure } from '../src/engine/body/measure';

/** Mannequin de test — cotes plausibles d'un corps femme mesuré. */
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

describe('la jupe trapèze (v193)', () => {
  it('la table des tailles grade de 4 en 4, hanches > taille partout', () => {
    let previous = 0;
    for (const size of JUPE_SIZES) {
      const { tailleCm, hanchesCm } = jupeCm(size);
      expect(hanchesCm - tailleCm).toBe(24); // la gradation classique conserve l'écart
      expect(tailleCm).toBeGreaterThan(previous);
      previous = tailleCm;
    }
  });

  it('« avatar » coupe aux mensurations mesurées du corps courant', () => {
    const body = jupeBodyCm('avatar', BODY);
    expect(body.tailleCm).toBeCloseTo(68, 1);
    expect(body.hanchesCm).toBeCloseTo(92, 1);
  });

  it('la jupe TIENT : taille cousue < ligne de hanche, sur toutes les tailles et sur mesure', () => {
    for (const size of [...JUPE_SIZES, 'avatar'] as const) {
      const doc = draftJupe(size, BODY, REF);
      for (const piece of [doc.piece, doc.back!]) {
        const waistCut = halfAt(piece, 0); // taille coupée (pinces incluses)
        const hip = halfAt(piece, 1);
        const hem = halfAt(piece, 2);
        // Cousue = coupée − bouche de pince ; toujours sous la hanche, sinon
        // rien ne porte la jupe.
        expect(waistCut).toBeLessThan(hip);
        expect(hem).toBeGreaterThan(hip); // le trapèze évase sous la hanche
      }
    }
  });

  it('DEVANT et DOS sont symétriques et leurs côtés se cousent bord à bord', () => {
    const doc = draftJupe('38', BODY, REF);
    for (const piece of [doc.piece, doc.back!]) {
      // Symétrie miroir du contour (côté D ↔ côté G).
      expect(halfAt(piece, 0)).toBeCloseTo(halfAt(piece, 5), 9);
      expect(halfAt(piece, 1)).toBeCloseTo(halfAt(piece, 4), 9);
      expect(halfAt(piece, 2)).toBeCloseTo(halfAt(piece, 3), 9);
    }
    // Les coutures de côté apparient les MÊMES index → mêmes longueurs
    // géométriques devant/dos (les pinces ne vivent que sur la taille).
    for (const index of [0, 1, 2, 3, 4, 5]) {
      expect(doc.piece.outline[index]![0]).toBeCloseTo(doc.back!.outline[index]![0], 9);
      expect(doc.piece.outline[index]![1]).toBeCloseTo(doc.back!.outline[index]![1], 9);
    }
  });

  it('les pinces : deux par pièce, bouches sur la taille, plus profondes au dos', () => {
    const doc = draftJupe('40', BODY, REF);
    const front = doc.piece;
    const back = doc.back!;
    expect(front.darts.length).toBe(2);
    expect(back.darts.length).toBe(2);
    for (const dart of [...front.darts, ...back.darts]) {
      expect(dart.legA[1]).toBe(0); // bouches posées sur la ligne de taille
      expect(dart.legB[1]).toBe(0);
      expect(dart.apex[1]).toBeGreaterThan(0); // pointe dans la pièce
    }
    const depth = (piece: typeof front): number => piece.darts[0]!.apex[1] * piece.height;
    expect(depth(back)).toBeGreaterThan(depth(front));
  });

  it('compile sans accroc : pièces rasterisées et coutures de côté épinglées', () => {
    const doc = draftJupe('38', BODY, REF);
    for (const piece of [doc.piece, doc.back!]) {
      const compiled = compileDraft(piece, doc.gridN);
      // La pièce vit (des cellules pleines) et les pinces n'ont rien crevé.
      expect(compiled.openCells.size).toBeGreaterThan(0);
      expect(compiled.extraSeams.length).toBeGreaterThan(0); // les lèvres de pince se cousent
    }
    const pins = compileAssembly(doc, doc.gridN);
    expect(pins.length).toBeGreaterThan(20); // deux coutures de côté réelles
  });

  it('la ceinture naît à la taille du corps mesuré', () => {
    const doc = draftJupe('38', BODY, REF);
    expect(doc.piece.topY).toBeCloseTo(BODY.waist.y + 0.01, 6);
    expect(doc.preset).toBe('jupe');
  });

  it('la ceinture est RETENUE pendant le montage (le bug de la jupe aux chevilles)', () => {
    // Reproduit le maillage que main.ts fabrique pour preset === 'jupe' :
    // sans anchorTop, RIEN ne tenait la taille pendant que pinces et côtés
    // se cousaient — la jupe glissait jusqu'aux chevilles (observé en v193).
    const doc = draftJupe('38', BODY, REF);
    const n = 32;
    const d = doc.piece;
    const back = doc.back!;
    const dc = compileDraft(d, n);
    const bc = compileDraft(back, n);
    const cellOpen =
      (set: Set<number>) =>
      (uu: number, vv: number): boolean =>
        set.has(Math.round(vv * (n - 1)) * n + Math.round(uu * (n - 1)));
    const build = (anchored: boolean) =>
      generateSeamedPanels({
        resolution: n,
        width: d.width,
        height: d.height,
        gap: d.gap,
        topY: d.topY,
        shape: 'freeform',
        mask: { outline: d.outline, darts: d.darts },
        extraSeams: dc.extraSeams,
        extraOpenings: cellOpen(dc.openCells),
        maskBack: { outline: back.outline, darts: back.darts },
        extraSeamsBack: bc.extraSeams,
        extraOpeningsBack: cellOpen(bc.openCells),
        manualAssembly: true,
        assemblySeams: compileAssembly(doc, n),
        ...(anchored ? { anchorTop: true, elasticTop: 0.97, reinforceTop: true } : {}),
      });

    const loose = build(false);
    expect(loose.anchorY).toBeUndefined(); // l'ancien maillage : aucune retenue

    const held = build(true);
    expect(held.anchorY).toHaveLength(held.count);
    const anchoredIdx: number[] = [];
    for (let i = 0; i < held.count; i++) {
      if (held.anchorY![i]! > -1e8) anchoredIdx.push(i);
    }
    // Les deux panneaux (devant 0, dos 1) ont chacun leur bande de taille tenue.
    const panelSize = n * n;
    expect(anchoredIdx.some((i) => i < panelSize)).toBe(true);
    expect(anchoredIdx.some((i) => i >= panelSize)).toBe(true);
    for (const i of anchoredIdx) {
      // La retenue vise la hauteur de repos de la CEINTURE seulement (bande
      // haute ~6 % de la pièce), jamais l'ourlet.
      expect(held.anchorY![i]!).toBeGreaterThan(d.topY - 0.07 * d.height);
      expect(held.anchorY![i]!).toBeCloseTo(held.positions[i * 4 + 1]!, 6);
    }
    // L'entoilage de ceinture existe : des coutures en plus des épingles
    // d'assemblage et des lèvres de pince (les rangs hauts deviennent raides).
    expect(held.seamCount).toBeGreaterThan(loose.seamCount);
  });
});
