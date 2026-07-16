import { describe, it, expect } from 'vitest';
import { draftTee, oversizeTee, boxyTee, boxyChestCm, BOXY_SIZES, type BoxySize } from '../src/engine/pattern/draftTee';
import { BOXY_IDX } from '../src/engine/pattern/boxyData';
import { pointInPolygon, sanitizeDraft } from '../src/engine/pattern/Draft';
import { countMaskIslands } from '../src/engine/cloth/ClothMesh';
import type { BodyMeasure } from '../src/engine/body/measure';

const level = (halfW: number, circ: number, y: number) => ({ y, halfW, halfD: halfW * 0.9, circ });
const mkMeasure = (chestCirc: number, shoulderHalfW = 0.26): BodyMeasure => ({
  height: 1.755,
  neckY: 1.549,
  shoulderY: 1.396,
  shoulderHalfW,
  chest: level(0.15, chestCirc, 1.27),
  waist: level(0.14, 0.763, 1.098),
  hip: level(0.19, 1.061, 0.892),
  thigh: level(0.1, 0.39, 0.7),
});

describe('draftTee (measurement-drafted t-shirt)', () => {
  const ref = mkMeasure(0.78);

  it('front neckline is deeper than the back (a real tee, worn the right way)', () => {
    const doc = draftTee(mkMeasure(0.78), ref);
    // Point 0 = neck-centre scoop bottom; bigger v = lower = deeper scoop.
    expect(doc.piece.outline[0]![1]).toBeGreaterThan(doc.back!.outline[0]![1]);
    expect(doc.manual).toBe(true);
    expect(doc.seams!.length).toBe(4); // shoulders (R/L) + sides (R/L), front↔back
  });

  it('the side width follows the chest measurement (not a fixed scale)', () => {
    const narrow = draftTee(mkMeasure(0.62), ref);
    const wide = draftTee(mkMeasure(1.0), ref);
    // Point 5 = right underarm; a bigger chest pushes it further from the centre.
    expect(wide.piece.outline[5]![0]).toBeGreaterThan(narrow.piece.outline[5]![0]);
  });

  it('each face rasterises to one connected piece (no fragment falls off)', () => {
    const doc = draftTee(mkMeasure(0.78), ref);
    const n = 48;
    for (const piece of [doc.piece, doc.back!]) {
      const kept: boolean[] = [];
      for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept.push(pointInPolygon([u / (n - 1), v / (n - 1)], piece.outline));
      expect(countMaskIslands(kept, n)).toBe(1);
    }
  });
});

describe('oversizeTee (le patron K.Kose 4 pièces, gradé)', () => {
  const ref = mkMeasure(0.78);

  it('5 pièces : devant + dos + 2 manches wrap + bande d encolure', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    expect(doc.back).toBeTruthy();
    expect(doc.pieces!.length).toBe(3);
    expect(doc.pieces!.map((p) => p.wrap).sort()).toEqual(['armL', 'armR', 'neck']);
    expect(doc.seams!.length).toBe(4); // épaules ×2 + côtés pleine hauteur ×2
    // La bande resserre : plus courte que l'encolure (aisance négative).
    const bandPiece = doc.pieces!.find((p) => p.wrap === 'neck')!;
    expect(bandPiece.width).toBeLessThan(0.2);
    expect(bandPiece.height).toBeLessThan(0.06);
    // Le col retrouve la cote du papier (creux ≈ 10.5 cm gradé).
    expect(doc.piece.outline[12]![1] * doc.piece.height).toBeGreaterThan(0.08);
  });

  it('col devant creusé, dos haut (comme le patron de référence)', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    // Le creux = le milieu de l'arc d'encolure (index 12 sur 15 points).
    expect(doc.piece.outline[12]![1]).toBeGreaterThan(doc.back!.outline[12]![1]);
    expect(doc.piece.outline.length).toBe(15); // un tracé COURBE, pas un carré
    expect(doc.pieces![0]!.outline.length).toBe(9); // manche à tête arrondie
  });

  it('la manche est FUSELÉE : poignet ≈ 80 % du biceps (la table de tailles)', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    const sl = doc.pieces![0]!.outline;
    const bicepSpan = sl[6]![0] - sl[0]![0]; // coins hauts (dessous de bras)
    const cuffSpan = sl[7]![0] - sl[8]![0]; // coins bas (poignet)
    expect(Math.abs(cuffSpan) / bicepSpan).toBeCloseTo(0.8, 1);
    expect(Math.min(sl[7]![0], sl[8]![0])).toBeGreaterThan(sl[0]![0]);
    expect(Math.max(sl[7]![0], sl[8]![0])).toBeLessThan(sl[6]![0]);
  });

  it('gradé sur la poitrine : plus large ET manche au biceps plus grande sur un plus grand tour', () => {
    const s = oversizeTee(mkMeasure(0.62), ref);
    const l = oversizeTee(mkMeasure(1.0), ref);
    expect(l.piece.width).toBeGreaterThan(s.piece.width);
    expect(l.pieces![0]!.width).toBeGreaterThan(s.pieces![0]!.width);
  });

  it('chaque face rasterise en une seule pièce connexe', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    const n = 48;
    for (const piece of [doc.piece, doc.back!]) {
      const kept: boolean[] = [];
      for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) kept.push(pointInPolygon([u / (n - 1), v / (n - 1)], piece.outline));
      expect(countMaskIslands(kept, n)).toBe(1);
    }
  });

  it('survit au round-trip sanitizeDraft (export → import) avec ses manches wrap', () => {
    const doc = oversizeTee(mkMeasure(0.78), ref);
    const round = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    expect(round.pieces!.length).toBe(3);
    expect(round.pieces![0]!.wrap).toBe('armR');
    expect(round.pieces![2]!.wrap).toBe('neck');
    expect(round.pieces![0]!.width).toBeCloseTo(doc.pieces![0]!.width, 4);
    expect(round.seams!.length).toBe(4);
  });
});

describe('boxyTee (patron BOXY FIT reproduit — 6 tailles)', () => {
  const ref = mkMeasure(0.78);
  const m = mkMeasure(0.90);
  // Longueur d'un bord (run d'index) en MÈTRES sur une pièce.
  const edgeLen = (piece: { outline: [number, number][]; width: number; height: number }, from: number, to: number): number => {
    const o = piece.outline; const N = o.length; let steps = ((to - from) % N + N) % N; if (steps === 0) steps = 1;
    let L = 0;
    for (let k = 0; k < steps; k++) {
      const a = o[(from + k) % N]!, b = o[(from + k + 1) % N]!;
      L += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
    }
    return L;
  };

  it('les 6 tailles existent, tour de poitrine croissant +6 cm', () => {
    const chests = BOXY_SIZES.map(boxyChestCm);
    expect(chests).toEqual([100, 106, 112, 118, 124, 130]);
    for (let i = 1; i < chests.length; i++) expect(chests[i]! - chests[i - 1]!).toBe(6);
  });

  it('5 pièces : devant + dos + 2 manches wrap + col wrap', () => {
    const d = boxyTee('M', m, ref);
    expect(d.piece).toBeTruthy();
    expect(d.back).toBeTruthy();
    expect(d.pieces?.length).toBe(3);
    expect(d.pieces?.[0]?.wrap).toBe('armR');
    expect(d.pieces?.[1]?.wrap).toBe('armL');
    expect(d.pieces?.[2]?.wrap).toBe('neck');
    expect(d.manual).toBe(true);
  });

  it('contours EXACTS du patron : 45 points, creux devant M = 7,7 cm, J d emmanchure = 5,1 cm', () => {
    const d = boxyTee('M', m, ref);
    expect(d.piece.outline.length).toBe(BOXY_IDX.N);
    expect(d.back!.outline.length).toBe(BOXY_IDX.N);
    // creux d'encolure (le point de pliure, au centre de l'arc)
    const fDepth = d.piece.outline[BOXY_IDX.center]![1] * d.piece.height;
    const bDepth = d.back!.outline[BOXY_IDX.center]![1] * d.back!.height;
    expect(fDepth).toBeCloseTo(0.077, 2);
    expect(bDepth).toBeCloseTo(0.027, 2);
    expect(fDepth).toBeGreaterThan(bDepth);
    // l'emmanchure en J se creuse de ~5,1 cm vers l'intérieur (le vrai patron,
    // pas une approximation) : demi-larg − x minimal de la courbe gauche
    const W = d.piece.width;
    const halfW = 0.28;
    const armXs = d.piece.outline.slice(2, BOXY_IDX.uaL).map((p) => (0.5 - p[0]) * W);
    const hollow = halfW - Math.min(...armXs);
    expect(hollow).toBeGreaterThan(0.045);
    expect(hollow).toBeLessThan(0.058);
  });

  it('IMBRICATION : épaule devant = épaule dos (0 mm), côtés soudés quasi égaux', () => {
    const d = boxyTee('L', m, ref);
    const f = d.piece, b = d.back!;
    expect(edgeLen(f, 0, BOXY_IDX.tipL)).toBeCloseTo(edgeLen(b, 0, BOXY_IDX.tipL), 3);
    expect(edgeLen(f, BOXY_IDX.tipR, BOXY_IDX.neckR)).toBeCloseTo(edgeLen(b, BOXY_IDX.tipR, BOXY_IDX.neckR), 3);
    // côté pleine hauteur (emmanchure comprise) : les emmanchures F/B du patron
    // diffèrent de < 5 mm — le zip m=max absorbe.
    expect(Math.abs(edgeLen(f, BOXY_IDX.tipL, BOXY_IDX.hemL) - edgeLen(b, BOXY_IDX.tipL, BOXY_IDX.hemL))).toBeLessThan(0.005);
    expect(Math.abs(edgeLen(f, BOXY_IDX.hemR, BOXY_IDX.tipR) - edgeLen(b, BOXY_IDX.hemR, BOXY_IDX.tipR))).toBeLessThan(0.005);
  });

  it('IMBRICATION : tête de manche ≈ 98 % des deux emmanchures (l aisance du jersey)', () => {
    for (const sz of ['XS', 'M', 'XXL'] as BoxySize[]) {
      const d = boxyTee(sz, m, ref);
      // arc de bouche du panneau ≈ demi-tour de tête ; l'emmanchure d'une face
      const armhole = edgeLen(d.piece, BOXY_IDX.tipL, BOXY_IDX.uaL);
      const capHalf = d.pieces![0]!.width;
      const ratio = (2 * capHalf) / (2 * armhole);
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.05);
    }
  });

  it('bouche du tube de manche : vraie courbe de tête pliée SYMÉTRIQUE, profondeur bornée à 17 %', () => {
    // La version monotone (« moitié pliée », plus fidèle au pliage réel) SPLAYE
    // le tube en drapeaux — testé A/B : les épingles u=0→haut la vrillent. La
    // topologie éprouvée v96-128 = apex au CENTRE du panneau ; on y pose la
    // vraie courbe, profondeur bornée (limite v112 : contour rogné = instable).
    const d = boxyTee('M', m, ref);
    const sl = d.pieces![0]!;
    const mouth = sl.outline.filter((p) => p[1] < 0.9);
    // apex ≈ au centre (u≈0.5, v≈0), coins de dessous de bras des deux côtés
    const apex = mouth.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(apex[1]).toBeLessThan(0.02);
    expect(apex[0]).toBeGreaterThan(0.4);
    expect(apex[0]).toBeLessThan(0.6);
    const capH = Math.max(...mouth.map((p) => p[1]));
    expect(capH).toBeGreaterThan(0.14);
    expect(capH).toBeLessThanOrEqual(0.175);
    // symétrie : v(u) ≈ v(1−u)
    expect(mouth[0]![1]).toBeCloseTo(mouth[mouth.length - 1]![1], 3);
  });

  it('taille absolue : XS ≠ XXL (les cotes changent avec la taille, pas avec l’avatar)', () => {
    const xs = boxyTee('XS', m, ref).piece;
    const xxl = boxyTee('XXL', m, ref).piece;
    expect(xxl.width).toBeGreaterThan(xs.width);
    expect(xxl.height).toBeGreaterThan(xs.height);
    // même avatar, mais deux tailles différentes → dimensions différentes
    const xsB = boxyTee('XS', mkMeasure(1.1), ref).piece;
    expect(xsB.width).toBeCloseTo(xs.width, 6); // la largeur ne dépend PAS de l'avatar
  });

  it('round-trip sanitize (le patron est un draft valide)', () => {
    const d = boxyTee('S', m, ref);
    const s = sanitizeDraft(d);
    expect(s.piece.outline.length).toBe(d.piece.outline.length);
    expect(s.pieces?.length).toBe(3);
  });
});
