import { describe, expect, it } from 'vitest';
import { handleLayoutPos, handleValueFromLayout, curveNeighbors, bendSamples, type PatternHandleSpec } from '../src/app/PatternView';
import { oversizeTee } from '../src/engine/pattern/draftTee';
import { insertOutlineVertex, reboxPiece, runCoversEdge, type DraftPiece, type UV } from '../src/engine/pattern/Draft';

const grid = { width: 0.95, topY: 1.6, height: 1.3 };

const flare: PatternHandleSpec = {
  id: 'dressFlare',
  label: 'évasement',
  grid,
  anchor: [1.0, 1],
  axis: 'u',
  value: 0.5,
  min: 0.25,
  max: 0.5,
};

const length: PatternHandleSpec = {
  id: 'dressLength',
  label: 'longueur',
  grid,
  anchor: [0.5, 1],
  axis: 'y',
  value: 1.3,
  min: 0.9,
  max: 1.55,
  unit: ' m',
};

describe('pattern handles', () => {
  it('places a half-width (u) handle on its cut edge', () => {
    const [x, y] = handleLayoutPos(flare, 0.5);
    expect(x).toBeCloseTo(0.475); // 0.5 × width — the hem corner
    expect(y).toBeCloseTo(1.6 - 1.3); // anchored to the hem row
  });

  it('places a length (y) handle below topY by the value', () => {
    const [x, y] = handleLayoutPos(length, 1.1);
    expect(x).toBeCloseTo(0); // hem center: anchor u = 0.5
    expect(y).toBeCloseTo(0.5); // 1.6 − 1.1
  });

  it('inverts a u-drag back to a half-width value', () => {
    // Round-trip: position of value 0.4 maps back to 0.4.
    const [x, y] = handleLayoutPos(flare, 0.4);
    expect(handleValueFromLayout(flare, x, y)).toBeCloseTo(0.4);
  });

  it('inverts a y-drag back to meters from the top', () => {
    const [x, y] = handleLayoutPos(length, 1.42);
    expect(handleValueFromLayout(length, x, y)).toBeCloseTo(1.42);
  });

  it('clamps to the slider bounds', () => {
    expect(handleValueFromLayout(flare, 10, 0)).toBe(0.5);
    expect(handleValueFromLayout(flare, -10, 0)).toBe(0.25);
    expect(handleValueFromLayout(length, 0, -10)).toBe(1.55);
    expect(handleValueFromLayout(length, 0, 10)).toBe(0.9);
  });
});

const mesureRef = () => {
  const level = (halfW: number, circ: number, y: number) => ({ y, halfW, halfD: halfW * 0.9, circ });
  return {
    height: 1.755, neckY: 1.549, shoulderY: 1.396, shoulderHalfW: 0.26,
    chest: level(0.15, 0.78, 1.27), waist: level(0.14, 0.763, 1.098),
    hip: level(0.19, 1.061, 0.892), thigh: level(0.1, 0.39, 0.7),
  };
};

describe('curveNeighbors (glisser-courbe)', () => {
  it('un point d arc entraîne ses voisins avec amorti (±1 fort, ±2 doux)', () => {
    const doc = oversizeTee(mesureRef(), mesureRef());
    // Le creux du col (index 12, milieu de l'arc d'encolure à 5 points).
    const nb = curveNeighbors(doc.piece.outline, 12);
    const byIdx = Object.fromEntries(nb.map((c) => [c.idx, c.w]));
    expect(byIdx[11]).toBeCloseTo(0.55);
    expect(byIdx[13]).toBeCloseTo(0.55);
    expect(byIdx[10]).toBeCloseTo(0.22);
    expect(byIdx[14]).toBeCloseTo(0.22);
  });

  it('un coin isolé (ourlet) bouge seul — la chaîne s arrête aux longues arêtes', () => {
    const doc = oversizeTee(mesureRef(), mesureRef());
    // Coin d'ourlet gauche (index 4) : arête vers l'ourlet droit très longue,
    // arête vers le bas d'emmanchure longue aussi → aucun entraînement.
    expect(curveNeighbors(doc.piece.outline, 4)).toEqual([]);
  });

  it('ne repasse jamais deux fois sur le même sommet (petit polygone)', () => {
    const tri: [number, number][] = [[0.4, 0.4], [0.6, 0.4], [0.5, 0.55]];
    const nb = curveNeighbors(tri, 0);
    const seen = nb.map((c) => c.idx);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(0);
  });
});

describe('bendSamples (tirer un bord = le courber)', () => {
  const A: UV = [0.2, 0.5];
  const B: UV = [0.8, 0.5];

  it('l arc passe par la souris quand on saisit le milieu du segment', () => {
    const grab: UV = [0.5, 0.5];
    const m: UV = [0.5, 0.62]; // tiré de 0.12 vers le haut
    const arc = bendSamples(A, B, grab, m);
    // Segment de 0.6 UV → 9 points (plafond), symétriques autour du milieu.
    expect(arc.length).toBe(9);
    const mid = arc[4]!; // t = 5/10 = 0.5
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.62, 6);
    // Tous les points intérieurs bombent du même côté, sans dépasser la souris.
    for (const p of arc) {
      expect(p[1]).toBeGreaterThan(0.5);
      expect(p[1]).toBeLessThanOrEqual(0.62 + 1e-9);
    }
  });

  it('souris restée sur la ligne → arc plat → rien à insérer', () => {
    expect(bendSamples(A, B, [0.5, 0.5], [0.65, 0.5004])).toEqual([]);
  });

  it('le nombre de points suit la longueur du segment (plancher 3, plafond 9)', () => {
    const short = bendSamples([0.5, 0.5], [0.58, 0.5], [0.54, 0.5], [0.54, 0.55]);
    expect(short.length).toBe(3);
    const long = bendSamples([0.0, 0.5], [1.0, 0.5], [0.5, 0.5], [0.5, 0.6]);
    expect(long.length).toBe(9);
  });

  it('inséré dans le contour, l arc laisse coutures et bords ouverts sur le même bord physique', () => {
    // Rectangle : ourlet = bord {2,3} déclaré ouvert, côté {1,2} déclaré cousu.
    const piece: DraftPiece = {
      outline: [[0.2, 0.9], [0.8, 0.9], [0.8, 0.2], [0.2, 0.2]] as UV[],
      width: 0.6,
      height: 0.7,
      gap: 0.9,
      topY: 1.5,
      darts: [],
      openEdges: [{ from: 2, to: 3 }],
      seams: [{ a: { from: 1, to: 2 }, b: { from: 0, to: 1 } }],
    };
    // Bomber l'ourlet (bord 2, entre les sommets 2 et 3) vers le bas.
    const arc = bendSamples(piece.outline[2]!, piece.outline[3]!, [0.5, 0.2], [0.5, 0.12]);
    expect(arc.length).toBeGreaterThan(0);
    let next = piece;
    for (let j = 0; j < arc.length; j++) next = insertOutlineVertex(next, 2 + j, arc[j]!);
    const nV = next.outline.length;
    expect(nV).toBe(4 + arc.length);
    // L'ourlet ouvert couvre maintenant TOUT l'arc (chaque petit bord 2..2+k).
    for (let e = 2; e <= 2 + arc.length; e++) {
      expect(runCoversEdge(next.openEdges[0]!, e, nV)).toBe(true);
    }
    // La couture du côté {1,2} n'a pas bougé (insertion après elle).
    expect(next.seams[0]!.a).toEqual({ from: 1, to: 2 });
    // Et le contour passe bien par les points de l'arc, dans l'ordre.
    for (let j = 0; j < arc.length; j++) expect(next.outline[3 + j]).toEqual(arc[j]);
  });
});

describe('reboxPiece (placement zone libre → wrap)', () => {
  // Une « manche » tracée sur la boîte du corps (grandeur nature) : un petit
  // rectangle en haut à droite de la silhouette.
  const drawn: DraftPiece = {
    outline: [[0.7, 0.1], [0.9, 0.1], [0.9, 0.6], [0.7, 0.6]] as UV[],
    width: 0.76, // boîte du corps
    height: 1.03,
    topY: 1.56,
    gap: 0.9,
    darts: [{ apex: [0.8, 0.3] as UV, legA: [0.75, 0.35] as UV, legB: [0.85, 0.35] as UV }],
    openEdges: [{ from: 0, to: 1 }],
    seams: [],
  };

  it('la boîte devient l emprise du tracé, la géométrie monde est intacte', () => {
    const r = reboxPiece(drawn, 0.18);
    expect(r.width).toBeCloseTo(0.2 * 0.76, 6);
    expect(r.height).toBeCloseTo(0.5 * 1.03, 6);
    expect(r.topY).toBeCloseTo(1.56 - 0.1 * 1.03, 6);
    expect(r.gap).toBe(0.18);
    // Contour plein bord : l'emprise touche [0,1] dans la nouvelle boîte.
    const us = r.outline.map((p) => p[0]);
    const vs = r.outline.map((p) => p[1]);
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(1, 6);
    expect(Math.min(...vs)).toBeCloseTo(0, 6);
    expect(Math.max(...vs)).toBeCloseTo(1, 6);
    // Géométrie monde identique : re-projeter chaque point (y compris pince).
    const world = (p: DraftPiece, [u, v]: UV): [number, number] => [(u - 0.5) * p.width, p.topY - v * p.height];
    for (let i = 0; i < drawn.outline.length; i++) {
      const [x0, y0] = world(drawn, drawn.outline[i]!);
      const [x1, y1] = world(r, r.outline[i]!);
      // x est recentré sur l'emprise (la colonne bouge, la FORME non) : comparer les écarts.
      const [xr0, yr0] = world(drawn, drawn.outline[0]!);
      const [xr1, yr1] = world(r, r.outline[0]!);
      expect(x1 - xr1).toBeCloseTo(x0 - xr0, 6);
      expect(y1 - yr1).toBeCloseTo(y0 - yr0, 6);
      expect(y1).toBeCloseTo(y0, 6); // la hauteur monde est ABSOLUE (topY suit)
    }
    const [, ay0] = world(drawn, drawn.darts[0]!.apex);
    const [, ay1] = world(r, r.darts[0]!.apex);
    expect(ay1).toBeCloseTo(ay0, 6);
  });

  it('tracé dégénéré (ligne) → pièce inchangée', () => {
    const flat: DraftPiece = { ...drawn, outline: [[0.2, 0.3], [0.8, 0.3], [0.5, 0.3]] as UV[] };
    expect(reboxPiece(flat, 0.18)).toBe(flat);
  });
});
