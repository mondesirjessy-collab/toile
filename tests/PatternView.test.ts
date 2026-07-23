import { describe, expect, it } from 'vitest';
import {
  beginLogicalCurveLengthEdit,
  beginSegmentLengthEdit,
  bendSamples,
  curveNeighbors,
  draftPieceBounds,
  expandPieceForOutline,
  findSegmentSnapSuggestion,
  handleLayoutPos,
  handleValueFromLayout,
  linkedSegmentMovingVertex,
  logicalCurveHandle,
  logicalCurveInteriorIndices,
  logicalCurveLengthM,
  logicalCurveRuns,
  makeZipperSeam,
  nextPatternLayoutShift,
  nextPieceSelection,
  outlineEdgeGeometry,
  outlineEdgeLengthCm,
  patternPanCenter,
  patternScreenToLayout,
  patternViewportTransform,
  patternZoomCenterAt,
  pieceResizeCornerPoint,
  pieceResizeScale,
  pointInPatternPolygon,
  resizeDraftPieceGlobally,
  resizeDraftPiecesTogether,
  resizeLogicalCurveLengthFromPointer,
  reshapeLogicalCurve,
  resizeLinkedSegmentByDelta,
  resizeSegmentFromPointer,
  segmentRelation,
  segmentSnapLengthToleranceM,
  snapSegmentOutline,
  type PatternHandleSpec,
  PatternView,
} from '../src/app/PatternView';
import { oversizeTee } from '../src/engine/pattern/draftTee';
import {
  insertOutlineVertex,
  reboxPiece,
  runCoversEdge,
  syncPieceFrames,
  type AssemblySeam,
  type DraftPiece,
  type UV,
} from '../src/engine/pattern/Draft';

describe('outil fermeture éclair', () => {
  it('crée une association ZIP fermée sans muter les runs fournis', () => {
    const a = { face: 'front' as const, from: 2, to: 3 };
    const b = { pieceId: 2, from: 5, to: 7 };
    const zipper = makeZipperSeam(a, b);

    expect(zipper).toEqual({
      a,
      b,
      kind: 'zipper',
      closed: true,
    });
    expect(zipper.a).not.toBe(a);
    expect(zipper.b).not.toBe(b);
  });

  it('sélectionne deux bords, émet le ZIP, puis referme le mode exclusif', () => {
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    const fakeCanvas = {
      width: 480,
      height: 320,
      getContext: () => null,
      setAttribute: () => {},
      dispatchEvent: () => true,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 480,
        bottom: 320,
        width: 480,
        height: 320,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { style: { cursor: '' } },
        createElement: () => ({ ...fakeCanvas }),
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { addEventListener: () => {} },
    });

    try {
      const emitted: AssemblySeam[] = [];
      const view = new PatternView(
        fakeCanvas as unknown as HTMLCanvasElement,
        () => {},
        () => {},
        (seam) => emitted.push(seam),
      );
      expect(view.toggleZipper()).toBe(true);
      expect(view.zippering).toBe(true);
      view.pickEdgeForZipper(0, 1);
      expect(view.zipperPick).toEqual({ pieceId: 0, edge: 1 });
      view.pickEdgeForZipper(1, 3);
      expect(emitted).toEqual([{
        a: { face: 'front', from: 0, to: 0 },
        b: { face: 'back', from: 0, to: 0 },
        kind: 'zipper',
        closed: true,
      }]);
      expect(view.zippering).toBe(false);
      expect(view.zipperPick).toBeNull();

      expect(view.toggleZipper()).toBe(true);
      expect(view.toggleSew()).toBe(true);
      expect(view.zippering).toBe(false);
    } finally {
      if (oldDocument === undefined) delete (globalThis as { document?: Document }).document;
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument });
      if (oldWindow === undefined) delete (globalThis as { window?: Window }).window;
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow });
    }
  });
});

describe('navigation du plan de coupe', () => {
  it('centre la vue ajustée à 100 %', () => {
    const tf = patternViewportTransform(0, 0, 100, 1, [2, 1], 400, 200);
    expect(tf.scale).toBe(100);
    expect(patternScreenToLayout(tf, 200, 100)).toEqual([2, 1]);
  });

  it('garde exactement le détail sous la souris pendant le zoom', () => {
    const width = 600;
    const height = 400;
    const before = patternViewportTransform(-1, -2, 120, 1, [1.5, 0.5], width, height);
    const pointer: [number, number] = [470, 90];
    const detail = patternScreenToLayout(before, pointer[0], pointer[1]);
    const nextScale = before.scale * 4;
    const nextCenter = patternZoomCenterAt(
      detail,
      pointer,
      nextScale,
      width,
      height,
    );
    const after = patternViewportTransform(
      before.minA,
      before.minB,
      before.scale,
      4,
      nextCenter,
      width,
      height,
    );
    const stillUnderPointer = patternScreenToLayout(
      after,
      pointer[0],
      pointer[1],
    );
    expect(stillUnderPointer[0]).toBeCloseTo(detail[0], 10);
    expect(stillUnderPointer[1]).toBeCloseTo(detail[1], 10);
  });

  it('déplace le plan dans le même sens que la main, même à 100 %', () => {
    const center: [number, number] = [1.5, 0.5];
    const moved = patternPanCenter(center, 80, -40, 200);

    expect(moved).toEqual([1.1, 0.3]);
    const tf = patternViewportTransform(0, 0, 200, 1, moved, 600, 400);
    expect(patternScreenToLayout(tf, 300, 200)).toEqual(moved);
  });

  it('calcule le déplacement de mise en page sans modifier la géométrie du patron', () => {
    const draft: DraftPiece = {
      outline: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]],
      darts: [],
      seams: [],
      openEdges: [],
      width: 0.8,
      height: 1.1,
      topY: 1.6,
      gap: 0.8,
    };
    const geometryBefore = structuredClone(draft);
    const shift = nextPatternLayoutShift([0.1, -0.2], [1.4, 0.8], [2.05, -0.15]);
    expect(shift[0]).toBeCloseTo(0.75, 10);
    expect(shift[1]).toBeCloseTo(-1.15, 10);
    expect(draft).toEqual(geometryBefore);
  });
});

describe('sélection et taille globale d’une pièce', () => {
  const piece = (): DraftPiece => ({
    outline: [[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]] as UV[],
    width: 1,
    height: 1.2,
    topY: 1.6,
    gap: 0.9,
    darts: [{ apex: [0.5, 0.45], legA: [0.42, 0.55], legB: [0.58, 0.55] }],
    openEdges: [{ from: 2, to: 3 }],
    seams: [{ a: { from: 0, to: 1 }, b: { from: 1, to: 2 } }],
  });
  const world = (p: DraftPiece, [u, v]: UV): [number, number] => [
    (u - 0.5) * p.width,
    p.topY - v * p.height,
  ];

  it('calcule les quatre extrémités sur l’emprise physique du contour', () => {
    const bounds = draftPieceBounds(piece());
    expect(bounds).toEqual({ minX: -0.3, maxX: 0.30000000000000004, minY: 0.52, maxY: 1.48 });
    expect(pieceResizeCornerPoint(bounds, 'nw')).toEqual([bounds.minX, bounds.maxY]);
    expect(pieceResizeCornerPoint(bounds, 'se')).toEqual([bounds.maxX, bounds.minY]);
  });

  it('redimensionne tout proportionnellement et garde le coin opposé fixe', () => {
    const p = piece();
    const before = draftPieceBounds(p);
    const anchor = pieceResizeCornerPoint(before, 'sw');
    const next = resizeDraftPieceGlobally(p, anchor, 1.5);
    const after = draftPieceBounds(next);

    expect(after.minX).toBeCloseTo(anchor[0], 8);
    expect(after.minY).toBeCloseTo(anchor[1], 8);
    expect(after.maxX - after.minX).toBeCloseTo((before.maxX - before.minX) * 1.5, 8);
    expect(after.maxY - after.minY).toBeCloseTo((before.maxY - before.minY) * 1.5, 8);
    expect(next.openEdges).toEqual(p.openEdges);
    expect(next.seams).toEqual(p.seams);

    const dartBefore = world(p, p.darts[0]!.apex);
    const dartAfter = world(next, next.darts[0]!.apex);
    expect(dartAfter[0] - anchor[0]).toBeCloseTo((dartBefore[0] - anchor[0]) * 1.5, 8);
    expect(dartAfter[1] - anchor[1]).toBeCloseTo((dartBefore[1] - anchor[1]) * 1.5, 8);
  });

  it('construit une sélection multiple avec Commande/Ctrl et permet de retirer une pièce', () => {
    expect(nextPieceSelection([], 0, false)).toEqual({ selected: [0], primary: 0 });
    expect(nextPieceSelection([0], 1, true)).toEqual({ selected: [0, 1], primary: 1 });
    expect(nextPieceSelection([0, 1], 0, true)).toEqual({ selected: [1], primary: 1 });
    expect(nextPieceSelection([1], null, true)).toEqual({ selected: [1], primary: 1 });
    expect(nextPieceSelection([1], null, false)).toEqual({ selected: [], primary: null });
  });

  it('applique exactement la même échelle à toutes les pièces sélectionnées', () => {
    const a = piece();
    const b = { ...piece(), width: 0.65, height: 0.8, topY: 1.35 };
    const beforeA = draftPieceBounds(a);
    const beforeB = draftPieceBounds(b);
    const [afterA, afterB] = resizeDraftPiecesTogether([a, b], 'ne', 1.75);
    const boundsA = draftPieceBounds(afterA!);
    const boundsB = draftPieceBounds(afterB!);

    expect((boundsA.maxX - boundsA.minX) / (beforeA.maxX - beforeA.minX)).toBeCloseTo(1.75, 8);
    expect((boundsA.maxY - boundsA.minY) / (beforeA.maxY - beforeA.minY)).toBeCloseTo(1.75, 8);
    expect((boundsB.maxX - boundsB.minX) / (beforeB.maxX - beforeB.minX)).toBeCloseTo(1.75, 8);
    expect((boundsB.maxY - boundsB.minY) / (beforeB.maxY - beforeB.minY)).toBeCloseTo(1.75, 8);
    // Le coin opposé (sud-ouest) reste fixe pour chaque pièce.
    expect(pieceResizeCornerPoint(boundsA, 'sw')[0]).toBeCloseTo(pieceResizeCornerPoint(beforeA, 'sw')[0], 8);
    expect(pieceResizeCornerPoint(boundsA, 'sw')[1]).toBeCloseTo(pieceResizeCornerPoint(beforeA, 'sw')[1], 8);
    expect(pieceResizeCornerPoint(boundsB, 'sw')[0]).toBeCloseTo(pieceResizeCornerPoint(beforeB, 'sw')[0], 8);
    expect(pieceResizeCornerPoint(boundsB, 'sw')[1]).toBeCloseTo(pieceResizeCornerPoint(beforeB, 'sw')[1], 8);
  });

  it('autorise la réduction et ne fixe aucune taille maximale', () => {
    const p = piece();
    const b = draftPieceBounds(p);
    const anchor = pieceResizeCornerPoint(b, 'se');
    const handle = pieceResizeCornerPoint(b, 'nw');
    const smallPointer: [number, number] = [
      anchor[0] + (handle[0] - anchor[0]) * 0.25,
      anchor[1] + (handle[1] - anchor[1]) * 0.25,
    ];
    const hugePointer: [number, number] = [
      anchor[0] + (handle[0] - anchor[0]) * 40,
      anchor[1] + (handle[1] - anchor[1]) * 40,
    ];
    expect(pieceResizeScale(anchor, handle, smallPointer)).toBeCloseTo(0.25, 8);
    expect(pieceResizeScale(anchor, handle, hugePointer)).toBeCloseTo(40, 8);
  });

  it('détecte un clic dans la pièce mais pas dans sa boîte vide', () => {
    const lShape: Array<[number, number]> = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]];
    expect(pointInPatternPolygon([15, 70], lShape)).toBe(true);
    expect(pointInPatternPolygon([70, 70], lShape)).toBe(false);
  });

});

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

describe('courbes logiques uniques', () => {
  it('regroupe les échantillons de l’encolure et des emmanchures en segments uniques', () => {
    const doc = oversizeTee(mesureRef(), mesureRef());
    const runs = logicalCurveRuns(doc.piece);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.some((run) => run.from === 9 && run.to === 0)).toBe(true);
    const hidden = logicalCurveInteriorIndices(runs);
    expect(hidden.size).toBeGreaterThanOrEqual(7);
  });

  it('une seule poignée remodèle toute la courbe sans changer ses extrémités ni ses indices', () => {
    const piece: DraftPiece = {
      outline: [
        [0.1, 0.5],
        [0.3, 0.38],
        [0.5, 0.34],
        [0.7, 0.38],
        [0.9, 0.5],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
      width: 1,
      height: 1,
      topY: 1.5,
      gap: 0.9,
      darts: [],
      openEdges: [{ from: 0, to: 4 }],
      seams: [],
    };
    const run = logicalCurveRuns(piece)[0]!;
    expect(run.indices).toEqual([0, 1, 2, 3, 4]);
    const handle = logicalCurveHandle(run);
    const target: UV = [0.5, 0.2];
    const reshaped = reshapeLogicalCurve(piece, piece.outline, run, target);
    expect(reshaped).toHaveLength(piece.outline.length);
    expect(reshaped[run.from]).toEqual(piece.outline[run.from]);
    expect(reshaped[run.to]).toEqual(piece.outline[run.to]);
    expect(reshaped[handle.index]![0]).toBeCloseTo(target[0], 8);
    expect(reshaped[handle.index]![1]).toBeCloseTo(target[1], 8);
    expect(piece.openEdges).toEqual([{ from: 0, to: 4 }]);
  });

  it('modifie la longueur totale en tirant l’extrémité proche, l’autre restant fixe', () => {
    const piece: DraftPiece = {
      outline: [[0.1, 0.5], [0.3, 0.38], [0.5, 0.34], [0.7, 0.38], [0.9, 0.5], [0.9, 0.9], [0.1, 0.9]],
      width: 1,
      height: 1,
      topY: 1.5,
      gap: 0.9,
      darts: [],
      openEdges: [{ from: 0, to: 4 }],
      seams: [],
    };
    const run = logicalCurveRuns(piece)[0]!;
    const edit = beginLogicalCurveLengthEdit(piece, piece.outline, run, piece.outline[run.from]!)!;
    expect(edit.moving).toBe(run.from);
    expect(edit.fixed).toBe(run.to);
    const fixedBefore = piece.outline[edit.fixed]!;
    const startLength = logicalCurveLengthM(piece, piece.outline, run);
    const moving = piece.outline[edit.moving]!;
    const pointer: UV = [
      moving[0] + (edit.unit[0] * 0.2) / piece.width,
      moving[1] + (edit.unit[1] * 0.2) / piece.height,
    ];
    const resized = resizeLogicalCurveLengthFromPointer(piece, piece.outline, edit, pointer);
    const nextLength = logicalCurveLengthM(piece, resized, run);
    expect(resized[edit.fixed]).toEqual(fixedBefore);
    expect(nextLength).toBeCloseTo(startLength * ((edit.startChordM + 0.2) / edit.startChordM), 8);
    expect(nextLength).toBeGreaterThan(startLength);
  });

  it('ne fixe aucune longueur maximale à une courbe', () => {
    const piece: DraftPiece = {
      outline: [[0.1, 0.5], [0.3, 0.38], [0.5, 0.34], [0.7, 0.38], [0.9, 0.5], [0.9, 0.9], [0.1, 0.9]],
      width: 1,
      height: 1,
      topY: 1.5,
      gap: 0.9,
      darts: [],
      openEdges: [{ from: 0, to: 4 }],
      seams: [],
    };
    const run = logicalCurveRuns(piece)[0]!;
    const edit = beginLogicalCurveLengthEdit(piece, piece.outline, run, piece.outline[run.to]!)!;
    const moving = piece.outline[edit.moving]!;
    const pointer: UV = [
      moving[0] + (edit.unit[0] * 10) / piece.width,
      moving[1] + (edit.unit[1] * 10) / piece.height,
    ];
    const resized = resizeLogicalCurveLengthFromPointer(piece, piece.outline, edit, pointer);
    expect(logicalCurveLengthM(piece, resized, run)).toBeGreaterThan(10);
  });
});

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

describe('outil ↔ Longueur des segments', () => {
  const piece = (): DraftPiece => ({
    outline: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.9], [0.2, 0.9]] as UV[],
    width: 1,
    height: 0.5,
    topY: 1.5,
    gap: 0.9,
    darts: [],
    openEdges: [{ from: 0, to: 1 }],
    seams: [],
  });

  it('déplace l extrémité la plus proche et garde l autre fixe', () => {
    const p = piece();
    const edit = beginSegmentLengthEdit(p, 0, [0.75, 0.3])!;
    expect(edit.startLength).toBeCloseTo(0.6, 8);
    expect(edit.moving).toBe(1);
    expect(edit.fixed).toBe(0);
    const out = resizeSegmentFromPointer(p, p.outline, edit, [0.85, 0.3]);
    expect(out[0]).toEqual(p.outline[0]); // l'autre extrémité est l'ancre
    expect(out[1]![0]).toBeCloseTo(0.9, 6); // +10 cm de geste
    expect(out[1]![1]).toBeCloseTo(0.3, 6);
    expect(outlineEdgeLengthCm(p, out, 0)).toBeCloseTo(70, 6);
  });

  it('saisi près du début, déplace le début sans renuméroter le contour', () => {
    const p = piece();
    const edit = beginSegmentLengthEdit(p, 0, [0.25, 0.3])!;
    expect(edit.moving).toBe(0);
    expect(edit.fixed).toBe(1);
    const out = resizeSegmentFromPointer(p, p.outline, edit, [0.15, 0.3]);
    expect(out).toHaveLength(p.outline.length);
    expect(out[1]).toEqual(p.outline[1]);
    expect(p.outline[0]).toEqual([0.2, 0.3]); // la source reste immuable
    expect(p.openEdges[0]).toEqual({ from: 0, to: 1 }); // même numéro de bord
  });

  it('ignore le mouvement perpendiculaire, même sur une pièce non carrée', () => {
    const p = piece();
    p.height = 2;
    p.outline[1] = [0.8, 0.6]; // segment physique Δ=(0,6 m ; 0,6 m)
    const grab: UV = [0.68, 0.54];
    const edit = beginSegmentLengthEdit(p, 0, grab)!;
    // +10 cm en x et −10 cm en y physique = mouvement perpendiculaire à Δ.
    const pointer: UV = [grab[0] + 0.1, grab[1] - 0.05];
    const out = resizeSegmentFromPointer(p, p.outline, edit, pointer);
    expect(out[edit.moving]![0]).toBeCloseTo(p.outline[edit.moving]![0], 6);
    expect(out[edit.moving]![1]).toBeCloseTo(p.outline[edit.moving]![1], 6);
  });

  it('n impose aucun maximum et empêche seulement un segment nul', () => {
    const p = piece();
    const edit = beginSegmentLengthEdit(p, 0, [0.75, 0.3])!;
    const extended = resizeSegmentFromPointer(p, p.outline, edit, [2.75, 0.3]);
    expect(extended[1]![0]).toBeCloseTo(2.8, 6); // le point sort librement de l'ancienne boîte
    expect(outlineEdgeLengthCm(p, extended, 0)).toBeCloseTo(260, 6);
    const collapsed = resizeSegmentFromPointer(p, p.outline, edit, [0, 0.3]);
    expect(outlineEdgeLengthCm(p, collapsed, 0)).toBeCloseTo(0.5, 6); // minimum 5 mm
  });

  it('agrandit automatiquement la boîte sans déplacer les autres points physiques', () => {
    const p = piece();
    const edit = beginSegmentLengthEdit(p, 0, [0.75, 0.3])!;
    const extended = resizeSegmentFromPointer(p, p.outline, edit, [2.75, 0.3]);
    const next = expandPieceForOutline(p, extended);
    const world = (piece: DraftPiece, [u, v]: UV): [number, number] => [
      (u - 0.5) * piece.width,
      piece.topY - v * piece.height,
    ];

    expect(next.width).toBeCloseTo(4.6, 6);
    expect(next.outline.flat().every((v) => v >= -1e-9 && v <= 1 + 1e-9)).toBe(true);
    expect(outlineEdgeLengthCm(next, next.outline, 0)).toBeCloseTo(260, 6);
    for (const i of [0, 2, 3]) {
      expect(world(next, next.outline[i]!)[0]).toBeCloseTo(world(p, p.outline[i]!)[0], 6);
      expect(world(next, next.outline[i]!)[1]).toBeCloseTo(world(p, p.outline[i]!)[1], 6);
    }
  });

  it('synchronise les cadres devant et dos sans étirer la face intacte', () => {
    const front = piece();
    const back = piece();
    const edit = beginSegmentLengthEdit(front, 0, [0.75, 0.3])!;
    const extended = resizeSegmentFromPointer(front, front.outline, edit, [1.75, 0.3]);
    const grownFront = expandPieceForOutline(front, extended);
    const synced = syncPieceFrames(grownFront, back);
    const world = (piece: DraftPiece, [u, v]: UV): [number, number] => [
      (u - 0.5) * piece.width,
      piece.topY - v * piece.height,
    ];

    expect(synced.front.width).toBeCloseTo(synced.back.width, 8);
    for (let i = 0; i < back.outline.length; i++) {
      expect(world(synced.back, synced.back.outline[i]!)[0]).toBeCloseTo(world(back, back.outline[i]!)[0], 6);
      expect(world(synced.back, synced.back.outline[i]!)[1]).toBeCloseTo(world(back, back.outline[i]!)[1], 6);
    }
  });

  it('détecte les parallèles et les longueurs égales indépendamment du sens', () => {
    const p = piece();
    const top = outlineEdgeGeometry(p, p.outline, 0)!;
    const bottomReversed = outlineEdgeGeometry(p, p.outline, 2)!;
    const relation = segmentRelation(top, bottomReversed);
    expect(top.angleDeg).toBeCloseTo(0, 8);
    expect(bottomReversed.angleDeg).toBeCloseTo(0, 8);
    expect(relation.parallel).toBe(true);
    expect(relation.equalLength).toBe(true);
    expect(relation.perpendicular).toBe(false);
  });

  it('détecte un angle droit en métrique physique sur une pièce non carrée', () => {
    const p = piece();
    const horizontal = outlineEdgeGeometry(p, p.outline, 0)!;
    const vertical = outlineEdgeGeometry(p, p.outline, 1)!;
    const relation = segmentRelation(horizontal, vertical);
    expect(relation.angleDeltaDeg).toBeCloseTo(90, 8);
    expect(relation.perpendicular).toBe(true);
    expect(relation.parallel).toBe(false);
    expect(relation.equalLength).toBe(false); // 60 cm contre 30 cm
  });

  it('calcule l angle physique et réserve le mot parallèle à un écart de 0,5° maximum', () => {
    const p = piece();
    p.outline[1] = [0.8, 0.9]; // Δ monde = (0,6 m ; −0,3 m), pas un −45° UV
    const diagonal = outlineEdgeGeometry(p, p.outline, 0)!;
    expect(diagonal.angleDeg).toBeCloseTo(153.434949, 5);
    const exactParallel = { ...diagonal, angleDeg: diagonal.angleDeg + 0.49 };
    const onlyNearby = { ...diagonal, angleDeg: diagonal.angleDeg + 0.51 };
    expect(segmentRelation(diagonal, exactParallel).parallel).toBe(true);
    expect(segmentRelation(diagonal, onlyNearby).parallel).toBe(false);
    expect(segmentRelation(diagonal, onlyNearby, 1.5, 0.005).parallel).toBe(true);
  });

  it('réserve même longueur à 1 mm et distingue une longueur seulement proche', () => {
    const p = piece();
    const reference = outlineEdgeGeometry(p, p.outline, 0)!; // 60 cm
    const withinOneMm = { ...reference, lengthM: reference.lengthM + 0.0009 };
    const fourMmAway = { ...reference, lengthM: reference.lengthM + 0.004 };
    expect(segmentRelation(reference, withinOneMm).equalLength).toBe(true);
    expect(segmentRelation(reference, fourMmAway).equalLength).toBe(false);
    expect(segmentRelation(reference, fourMmAway, 1.5, 0.005).equalLength).toBe(true);
  });

  it('propose même longueur et parallélisme avec le bord opposé proche de la même pièce', () => {
    const p = piece();
    p.outline = [[0.2, 0.3], [0.8, 0.31], [0.79, 0.9], [0.2, 0.9]] as UV[];
    const suggestion = findSegmentSnapSuggestion([p], [], 0, 0)!;
    expect(suggestion.angle).toMatchObject({ kind: 'parallel', pieceId: 0, edge: 2 });
    expect(suggestion.length).toMatchObject({ kind: 'parallel', pieceId: 0, edge: 2 });
    expect(suggestion.angle!.deltaDeg).toBeLessThan(1);
    expect(suggestion.length!.deltaM).toBeCloseTo(-0.0100208, 6);

    const snapped = snapSegmentOutline(p, p.outline, 0, 1, suggestion);
    const target = outlineEdgeGeometry(p, snapped, 0)!;
    const reference = outlineEdgeGeometry(p, snapped, 2)!;
    expect(segmentRelation(target, reference, 1e-6, 1e-6).parallel).toBe(true);
    expect(segmentRelation(target, reference, 1e-6, 1e-6).equalLength).toBe(true);
  });

  it('donne priorité à la longueur du bord cousu quand les deux runs sont proches', () => {
    const front = piece();
    const back = piece();
    back.outline[1] = [0.795, 0.3]; // 59,5 cm contre 60,0 cm
    const seams: AssemblySeam[] = [
      {
        a: { face: 'front', from: 0, to: 1 },
        b: { face: 'back', from: 0, to: 1 },
      },
    ];
    const suggestion = findSegmentSnapSuggestion([front, back], seams, 1, 0)!;
    expect(suggestion.length).toMatchObject({ kind: 'sewn', pieceId: 0, edge: 0 });
    expect(suggestion.length!.lengthM).toBeCloseTo(0.6, 8);
    expect(suggestion.length!.deltaM).toBeCloseTo(0.005, 8);
  });

  it('ne magnétise pas une couture trop éloignée', () => {
    const front = piece();
    const back = piece();
    back.outline[1] = [0.75, 0.3]; // 55 cm contre 60 cm : correction trop grande
    const seams: AssemblySeam[] = [
      {
        a: { face: 'front', from: 0, to: 1 },
        b: { face: 'back', from: 0, to: 1 },
      },
    ];
    expect(findSegmentSnapSuggestion([front, back], seams, 1, 0)).toBeNull();
  });

  it('propose un angle droit exact avec un bord adjacent presque perpendiculaire', () => {
    const p = piece();
    p.height = 1;
    p.outline = [[0.2, 0.2], [0.8, 0.22], [0.2, 0.8]] as UV[];
    const suggestion = findSegmentSnapSuggestion([p], [], 0, 0, p.outline, 1)!;
    expect(suggestion.angle).toMatchObject({ kind: 'perpendicular', pieceId: 0, edge: 2 });
    const snapped = snapSegmentOutline(p, p.outline, 0, 1, suggestion);
    const target = outlineEdgeGeometry(p, snapped, 0)!;
    const adjacent = outlineEdgeGeometry(p, snapped, 2)!;
    expect(segmentRelation(target, adjacent, 1e-6, 1).perpendicular).toBe(true);
  });

  it('borne la proximité de longueur entre 5 et 15 mm', () => {
    expect(segmentSnapLengthToleranceM(0.1)).toBeCloseTo(0.005, 8);
    expect(segmentSnapLengthToleranceM(0.6)).toBeCloseTo(0.012, 8);
    expect(segmentSnapLengthToleranceM(2)).toBeCloseTo(0.015, 8);
  });

  it('applique le même delta à un segment marié sans changer son orientation', () => {
    const p = piece();
    const before = outlineEdgeGeometry(p, p.outline, 1)!; // vertical, 30 cm
    const linked = resizeLinkedSegmentByDelta(p, p.outline, 1, 2, 0.1);
    const after = outlineEdgeGeometry(p, linked, 1)!;
    expect(after.lengthM).toBeCloseTo(before.lengthM + 0.1, 8);
    expect(after.angleDeg).toBeCloseTo(before.angleDeg, 8);
    expect(linked[1]).toEqual(p.outline[1]); // l'ancre du partenaire reste fixe
  });

  it('associe les extrémités visuelles quand les contours vont en sens opposés', () => {
    const p = piece();
    // Bord 1 : haut → bas. Bord 3 : bas → haut dans le même contour fermé.
    const sourceMoving = 2; // bas du bord droit
    const linkedMoving = linkedSegmentMovingVertex(p, p.outline, 1, sourceMoving, p, p.outline, 3);
    expect(linkedMoving).toBe(3); // bas du bord gauche, malgré l'indexation inverse

    const beforeBottom = p.outline[3]![1];
    const linked = resizeLinkedSegmentByDelta(p, p.outline, 3, linkedMoving, 0.1);
    expect(linked[3]![1]).toBeGreaterThan(beforeBottom); // les deux bas descendent
    expect(linked[0]).toEqual(p.outline[0]); // le haut du partenaire reste fixe
  });

  it('conserve la correspondance début/fin quand les deux contours ont le même sens', () => {
    const p = piece();
    expect(linkedSegmentMovingVertex(p, p.outline, 1, 2, p, p.outline, 1)).toBe(2);
    expect(linkedSegmentMovingVertex(p, p.outline, 1, 1, p, p.outline, 1)).toBe(1);
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
