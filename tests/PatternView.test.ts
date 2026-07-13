import { describe, expect, it } from 'vitest';
import { handleLayoutPos, handleValueFromLayout, curveNeighbors, type PatternHandleSpec } from '../src/app/PatternView';
import { oversizeTee } from '../src/engine/pattern/draftTee';

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
