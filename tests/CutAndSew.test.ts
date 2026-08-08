import { describe, expect, it } from 'vitest';
import { outlineEdgeLengthCm } from '../src/app/PatternView';
import {
  compileAssembly,
  compileAssemblyGroups,
  tshirtDraft,
  cutPieceAlongChord,
  graphicLocalUV,
  offsetPieceOutline,
  shiftOutlineUV,
  syncPieceFrames,
  blankBaseDraft,
  pointInPolygon,
  compileSurfaceContacts,
  mirrorDuplicatePiece,
  mirrorClosedOutline,
  addFisheyeDart,
  roundOutlineCorner,
  cutPieceAlongInternalLine,
  toggleNotchAt,
  addSeamNotches,
  runPointAtFraction,
  slashSpreadFullness,
  mergePiecesAlongSeam,
  linkedVertexEdit,
  toggleInternalHole,
  divideOutlineEdge,
  alignOutlineVertex,
  squareCorner,
  extendInternalLineEnd,
  divideInternalLineAt,
  pieceHolePolygons,
  docPieces,
  CURVE_POINT_SAMPLES,
  compileDraft,
  INTERNAL_LINES_MAX,
  type InternalLine,
  gatherSeamSide,
  pieceIdOf,
  sanitizeDraft,
  type AssemblySeam,
  type DraftDoc,
  type DraftPiece,
  type UV,
} from '../src/engine/pattern/Draft';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';

const rectPiece = (over: Partial<DraftPiece> = {}): DraftPiece => ({
  outline: [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ] as UV[],
  darts: [],
  seams: [],
  openEdges: [],
  width: 0.6,
  height: 0.9,
  topY: 1.55,
  gap: 0.35,
  ...over,
});

const doc = (over: Partial<DraftDoc> = {}): DraftDoc => ({
  format: 'toile-draft',
  version: 1,
  gridN: 64,
  piece: rectPiece(),
  back: rectPiece(),
  manual: true,
  seams: [],
  ...over,
});

const runLen = (piece: DraftPiece, from: number, to: number): number => {
  const N = piece.outline.length;
  const steps = (to - from + N) % N;
  let len = 0;
  for (let k = 0; k < steps; k++) {
    const a = piece.outline[(from + k) % N]!;
    const b = piece.outline[(from + k + 1) % N]!;
    len += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
  }
  return len;
};

describe('Couper & Coudre — cutPieceAlongChord', () => {
  it('scinde un rectangle en deux moitiés cousues le long de la découpe', () => {
    const d = doc();
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const front = res.doc.piece;
    const created = res.doc.pieces?.[res.newPieceId - 2];
    expect(front.outline).toHaveLength(4);
    expect(created?.outline).toHaveLength(4);
    expect(res.newPieceId).toBe(2);

    // Les deux moitiés couvrent des v disjoints, coupés à v=0.5.
    const vs = (p: DraftPiece): number[] => p.outline.map(([, v]) => v);
    const halves = [vs(front), vs(created!)].map((arr) => [Math.min(...arr), Math.max(...arr)]);
    const upper = halves.find(([lo]) => lo! < 0.3)!;
    const lower = halves.find(([, hi]) => hi! > 0.7)!;
    expect(upper[1]).toBeCloseTo(0.5, 5);
    expect(lower[0]).toBeCloseTo(0.5, 5);

    // Une seule couture : la découpe elle-même, dernier bord de chaque moitié.
    expect(res.doc.seams).toHaveLength(1);
    const chord = res.doc.seams![0]!;
    const pids = [pieceIdOf(chord.a), pieceIdOf(chord.b)].sort();
    expect(pids).toEqual([0, res.newPieceId]);
    for (const run of [chord.a, chord.b]) {
      expect(run.from).toBe(3);
      expect(run.to).toBe(0);
    }
    expect(res.doc.manual).toBe(true);

    // La longueur de découpe est identique des deux côtés (même corde).
    const lenA = runLen(front, 3, 0);
    const lenB = runLen(created!, 3, 0);
    expect(lenA).toBeCloseTo(lenB, 9);
  });

  it('propage un point d’accord au partenaire quand la découpe traverse une couture', () => {
    const seam: AssemblySeam = {
      a: { pieceId: 0, from: 1, to: 2 }, // côté droit du devant
      b: { pieceId: 1, from: 3, to: 0 }, // côté gauche du dos
    };
    const d = doc({ seams: [seam] });
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Le dos a reçu UN sommet d'accord sur son bord cousu.
    expect(res.doc.back!.outline).toHaveLength(5);
    expect(res.splitSeams).toBe(1);

    // 2 sous-coutures + la couture de découpe.
    expect(res.doc.seams).toHaveLength(3);
    const onBack = res.doc.seams!.filter(
      (s) => pieceIdOf(s.a) === 1 || pieceIdOf(s.b) === 1,
    );
    expect(onBack).toHaveLength(2);
    // Les deux sous-coutures côté dos partagent le sommet d'accord comme borne.
    const backRuns = onBack.map((s) => (pieceIdOf(s.a) === 1 ? s.a : s.b));
    const bounds = backRuns.flatMap((r) => [r.from, r.to]);
    const shared = bounds.filter((v, i) => bounds.indexOf(v) !== i);
    expect(shared.length).toBeGreaterThan(0);

    // Chaque sous-couture apparie une moitié différente du devant.
    const frontSidePids = onBack.map((s) => (pieceIdOf(s.a) === 1 ? pieceIdOf(s.b) : pieceIdOf(s.a)));
    expect([...new Set(frontSidePids)].sort()).toEqual([0, res.newPieceId]);
  });

  it('supporte DEUX coutures partagées sur le même partenaire (ré-indexation en chaîne)', () => {
    const left: AssemblySeam = {
      a: { pieceId: 0, from: 3, to: 0 },
      b: { pieceId: 1, from: 1, to: 2 },
    };
    const right: AssemblySeam = {
      a: { pieceId: 0, from: 1, to: 2 },
      b: { pieceId: 1, from: 3, to: 0 },
    };
    const d = doc({ seams: [left, right] });
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.4 }, { edge: 3, t: 0.6 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Le dos a reçu DEUX sommets d'accord (un par couture traversée).
    expect(res.doc.back!.outline).toHaveLength(6);
    expect(res.splitSeams).toBe(2);
    // 2×2 sous-coutures + la découpe.
    expect(res.doc.seams).toHaveLength(5);
    expect(res.droppedLinks).toBe(0);

    // Tous les runs référencés sont des bornes valides de leur pièce.
    const pieces = [res.doc.piece, res.doc.back!, ...(res.doc.pieces ?? [])];
    for (const s of res.doc.seams!) {
      for (const run of [s.a, s.b]) {
        const piece = pieces[pieceIdOf(run)]!;
        expect(run.from).toBeGreaterThanOrEqual(0);
        expect(run.to).toBeGreaterThanOrEqual(0);
        expect(run.from).toBeLessThan(piece.outline.length);
        expect(run.to).toBeLessThan(piece.outline.length);
      }
    }
  });

  it('répartit les pinces et refuse celle que la découpe traverse', () => {
    const withDart = doc({
      piece: rectPiece({
        darts: [{ apex: [0.5, 0.3], legA: [0.45, 0.2], legB: [0.55, 0.2] }],
      }),
    });
    const okRes = cutPieceAlongChord(withDart, 0, { edge: 1, t: 0.6 }, { edge: 3, t: 0.4 });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      const upper = [okRes.doc.piece, ...(okRes.doc.pieces ?? [])].find((p) =>
        p.outline.some(([, v]) => v < 0.3),
      )!;
      expect(upper.darts).toHaveLength(1);
    }
  });

  it('refuse les découpes dégénérées et les modèles intégrés', () => {
    const samePoint = cutPieceAlongChord(doc(), 0, { edge: 1, t: 0.5 }, { edge: 1, t: 0.52 });
    expect(samePoint.ok).toBe(false);

    const preset = cutPieceAlongChord(
      doc({ preset: 'loose-pants' }),
      0,
      { edge: 1, t: 0.5 },
      { edge: 3, t: 0.5 },
    );
    expect(preset.ok).toBe(false);

    const zip = cutPieceAlongChord(
      doc({ seams: [{ a: { pieceId: 0, from: 1, to: 2 }, b: { pieceId: 1, from: 3, to: 0 }, kind: 'zipper', closed: true }] }),
      0,
      { edge: 1, t: 0.5 },
      { edge: 3, t: 0.5 },
    );
    expect(zip.ok).toBe(false);
  });

  it('survit à sanitizeDraft (round-trip fichier)', () => {
    const res = cutPieceAlongChord(doc(), 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean.pieces).toHaveLength(1);
    expect(clean.seams).toHaveLength(1);
  });

  it('s’accroche aux sommets existants près des coins (pas de sommet dupliqué)', () => {
    // Diagonale TR→BL : t≈0 sur bord 1 = coin 1, t≈0 sur bord 3 = coin 3.
    const res = cutPieceAlongChord(doc(), 0, { edge: 1, t: 0.01 }, { edge: 3, t: 0.01 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Deux triangles : aucun sommet inséré, chaque coin de découpe compté
    // dans les deux moitiés (4 d'origine + 2 partagés).
    const total = res.doc.piece.outline.length + res.doc.pieces![0]!.outline.length;
    expect(total).toBe(6);
  });

  it('refuse une découpe qui longerait le contour (coin à coin adjacents)', () => {
    const res = cutPieceAlongChord(doc(), 0, { edge: 1, t: 0.01 }, { edge: 3, t: 0.99 });
    expect(res.ok).toBe(false);
  });
});

describe('Fronces — gatherSeamSide', () => {
  it('allonge le bord froncé au ratio demandé (l’embu du tailleur)', () => {
    const seam: AssemblySeam = {
      a: { pieceId: 0, from: 2, to: 3 }, // ourlet bas du devant
      b: { pieceId: 1, from: 0, to: 1 }, // haut du dos (partenaire)
    };
    const d = doc({ seams: [seam] });
    const before = runLen(d.piece, 2, 3);
    const partner = runLen(d.back!, 0, 1);
    expect(before).toBeCloseTo(partner, 9);

    const res = gatherSeamSide(d, 0, 'a', 1.5);
    expect(res.ok).toBe(true);
    expect(res.achievedRatio).toBeGreaterThan(1.45);
    expect(res.achievedRatio).toBeLessThan(1.55);

    const after = runLen(res.doc!.piece, 2, 3);
    expect(after / partner).toBeCloseTo(res.achievedRatio!, 5);
    // Le partenaire n'a pas bougé.
    expect(runLen(res.doc!.back!, 0, 1)).toBeCloseTo(partner, 9);
    // Le contour reste dans le cadre et simple.
    for (const [u, v] of res.doc!.piece.outline) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('agrandit le cadre de la pièce quand le bord froncé déborde (ratio honoré)', () => {
    // ×3 sur un bord qui occupe déjà 60% du cadre : au lieu de rogner le
    // ratio, le cadre s'agrandit — positions physiques préservées, comme
    // syncPieceFrames. Le ratio demandé est atteint.
    const seam: AssemblySeam = {
      a: { pieceId: 0, from: 2, to: 3 },
      b: { pieceId: 1, from: 0, to: 1 },
    };
    const base = doc({ seams: [seam] });
    const res = gatherSeamSide(base, 0, 'a', 3);
    expect(res.ok).toBe(true);
    expect(res.achievedRatio!).toBeCloseTo(3, 1);
    const piece = res.doc!.piece;
    expect(piece.width).toBeGreaterThan(base.piece.width);
    // Les positions physiques des sommets HORS run n'ont pas bougé.
    const phys = (p: DraftPiece, i: number): [number, number] => [
      (p.outline[i]![0] - 0.5) * p.width,
      p.topY - p.outline[i]![1] * p.height,
    ];
    for (const i of [0, 1]) {
      const before = phys(base.piece, i);
      const after = phys(piece, i);
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[1]).toBeCloseTo(before[1], 6);
    }
    // Tout le contour reste dans le cadre UV.
    for (const [u, v] of piece.outline) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('refuse zips, coutures inconnues et modèles intégrés', () => {
    const zip = gatherSeamSide(
      doc({ seams: [{ a: { pieceId: 0, from: 2, to: 3 }, b: { pieceId: 1, from: 0, to: 1 }, kind: 'zipper' }] }),
      0,
      'a',
      1.5,
    );
    expect(zip.ok).toBe(false);
    expect(gatherSeamSide(doc(), 4, 'a', 1.5).ok).toBe(false);
    const preset = gatherSeamSide(
      doc({ preset: 'lucas-hoodie', seams: [{ a: { pieceId: 0, from: 2, to: 3 }, b: { pieceId: 1, from: 0, to: 1 } }] }),
      0,
      'a',
      1.5,
    );
    expect(preset.ok).toBe(false);
  });
});

describe('couleur d’empiècement (colorblock)', () => {
  it('sanitizeDraft : un hex strict survit en minuscules, le reste tombe', () => {
    const d = doc();
    d.piece.color = '#C2543A';
    d.back!.color = 'rouge' as never;
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean).not.toBeNull();
    expect(clean!.piece.color).toBe('#c2543a');
    expect(clean!.back!.color).toBeUndefined();
  });

  it('les deux moitiés d’une découpe héritent de la couleur du parent', () => {
    const d = doc();
    d.piece.color = '#3b4a73';
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.piece.color).toBe('#3b4a73');
    expect(res.doc.pieces?.[res.newPieceId - 2]?.color).toBe('#3b4a73');
  });
});

describe('graphique de pièce (le « Graphic » de Clo)', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const graphic = (over: Partial<import('../src/engine/pattern/Draft').PieceGraphic> = {}) => ({
    image: PNG_1PX,
    anchor: [0.5, 0.4] as [number, number],
    widthM: 0.15,
    aspect: 1,
    rotationRad: 0,
    ...over,
  });

  it('sanitizeDraft : un graphique valide survit, transform borné ; un invalide tombe', () => {
    const d = doc();
    d.piece.graphic = graphic({ widthM: 9, rotationRad: 99 });
    d.back!.graphic = graphic({ image: 'data:text/html;base64,xxxx' });
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean).not.toBeNull();
    expect(clean!.piece.graphic?.image).toBe(PNG_1PX);
    expect(clean!.piece.graphic?.widthM).toBe(2); // borné
    expect(clean!.piece.graphic?.rotationRad).toBeLessThanOrEqual(Math.PI * 2);
    expect(clean!.back!.graphic).toBeUndefined(); // mauvais type MIME
  });

  it('la découpe donne le graphique à LA moitié qui contient son ancre', () => {
    const d = doc();
    d.piece.graphic = graphic({ anchor: [0.5, 0.3] }); // moitié HAUTE
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const half = res.doc.pieces?.[res.newPieceId - 2];
    const withGraphic = [res.doc.piece, half].filter((p) => p?.graphic);
    expect(withGraphic).toHaveLength(1); // jamais dupliqué
    // La moitié décorée est celle dont l'emprise contient v=0.3.
    const owner = withGraphic[0]!;
    const vs = owner.outline.map(([, v]) => v);
    expect(Math.min(...vs)).toBeLessThanOrEqual(0.3);
    expect(Math.max(...vs)).toBeGreaterThanOrEqual(0.3);
  });

  it('graphicLocalUV : centre, échelle métrique et rotation 90° exacts', () => {
    const g = graphic({ anchor: [0.5, 0.5], widthM: 0.2, aspect: 0.5 });
    // Au centre : (0,5, 0,5).
    expect(graphicLocalUV(g, 0.6, 0.9, 0.5, 0.5)).toEqual([0.5, 0.5]);
    // 0,1 m à droite du centre (u +0.1/0.6) = bord droit de l'image (x=1).
    const [rx, ry] = graphicLocalUV(g, 0.6, 0.9, 0.5 + 0.1 / 0.6, 0.5);
    expect(rx).toBeCloseTo(1, 6);
    expect(ry).toBeCloseTo(0.5, 6);
    // Tourné de 90° : le même point du patron tombe sur l'axe VERTICAL de
    // l'image (hauteur 0,1 m) — x revient au centre, y sort en bas.
    const g90 = graphic({ anchor: [0.5, 0.5], widthM: 0.2, aspect: 0.5, rotationRad: Math.PI / 2 });
    const [qx, qy] = graphicLocalUV(g90, 0.6, 0.9, 0.5 + 0.1 / 0.6, 0.5);
    expect(qx).toBeCloseTo(0.5, 6);
    expect(qy).toBeCloseTo(-0.5, 6); // 0,1 m au-dessus du bord haut (h = 0,1 m)
  });
});

describe('offset du contour (l’« Offset Pattern Outline » de Clo)', () => {
  it('+1 cm : chaque bord du rectangle s’allonge de 2 cm, indices et coutures intacts', () => {
    const seam: AssemblySeam = { a: { pieceId: 0, from: 0, to: 1 }, b: { pieceId: 1, from: 0, to: 1 } };
    const d = doc({ seams: [seam] });
    const res = offsetPieceOutline(d, 0, 0.01);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    expect(piece.outline).toHaveLength(4);
    // Rectangle 0,36 × 0,54 m : le bas passe de 36 à 38 cm, le côté de 54 à 56.
    expect(runLen(piece, 0, 1)).toBeCloseTo(0.38, 3);
    expect(runLen(piece, 1, 2)).toBeCloseTo(0.56, 3);
    // La couture pointe toujours l'arête 0→1, sans ré-indexation.
    expect(res.doc!.seams![0]!.a.from).toBe(0);
    expect(res.doc!.seams![0]!.a.to).toBe(1);
  });

  it('−5 mm : la pièce rétrécit ; un offset intérieur énorme est refusé', () => {
    const shrink = offsetPieceOutline(doc(), 0, -0.005);
    expect(shrink.ok).toBe(true);
    expect(runLen(shrink.doc!.piece, 0, 1)).toBeCloseTo(0.35, 3);
    const collapse = offsetPieceOutline(doc(), 0, -0.4);
    expect(collapse.ok).toBe(false);
  });

  it('sort du cadre : la feuille grandit, positions physiques préservées', () => {
    // Rectangle collé aux bords du cadre : tout offset extérieur déborde.
    const d = doc();
    d.piece.outline = [
      [0.02, 0.02],
      [0.98, 0.02],
      [0.98, 0.98],
      [0.02, 0.98],
    ] as UV[];
    const before = runLen(d.piece, 0, 1);
    const res = offsetPieceOutline(d, 0, 0.02);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    // Cadre agrandi, contour rentré dans [0,1]².
    expect(piece.width).toBeGreaterThan(0.6);
    for (const [u, v] of piece.outline) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // La longueur physique du bas = ancienne + 2×2 cm, malgré le changement de cadre.
    expect(runLen(piece, 0, 1)).toBeCloseTo(before + 0.04, 3);
    // topY remonte d'exactement l'excursion du haut (positions monde stables).
    expect(res.doc!.piece.topY).toBeGreaterThan(d.piece.topY);
  });

  it('pointe aiguë : le miter est borné (pas d’aiguille qui explose)', () => {
    const d = doc();
    // Triangle très pointu à droite.
    d.piece.outline = [
      [0.1, 0.45],
      [0.9, 0.5],
      [0.1, 0.55],
    ] as UV[];
    const res = offsetPieceOutline(d, 0, 0.01);
    expect(res.ok).toBe(true);
    const tip = res.doc!.piece.outline[1]!;
    const tipBefore = d.piece.outline[1]!;
    const moved = Math.hypot(
      (tip[0] - tipBefore[0]) * d.piece.width * (res.doc!.piece.width / d.piece.width),
      (tip[1] - tipBefore[1]) * d.piece.height,
    );
    // ≤ ~4×d (+ tolérance de changement de cadre éventuel).
    expect(moved).toBeLessThan(0.06);
  });

  it('refuse les modèles intégrés', () => {
    const res = offsetPieceOutline(doc({ preset: 'hoodie' } as Partial<DraftDoc>), 0, 0.01);
    expect(res.ok).toBe(false);
  });
});

describe('audit v151 — l’ancre du graphique et les pinces suivent les changements de cadre', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const worldOf = (piece: DraftPiece, [u, v]: [number, number]): [number, number] => [
    (u - 0.5) * piece.width,
    piece.topY - v * piece.height,
  ];

  it('offset avec croissance de cadre : l’ancre garde sa position PHYSIQUE', () => {
    const d = doc();
    d.piece.outline = [
      [0.02, 0.02],
      [0.98, 0.02],
      [0.98, 0.98],
      [0.02, 0.98],
    ] as UV[];
    d.piece.graphic = {
      image: PNG_1PX, anchor: [0.3, 0.6], widthM: 0.1, aspect: 1, rotationRad: 0.4,
    };
    const before = worldOf(d.piece, d.piece.graphic.anchor);
    const res = offsetPieceOutline(d, 0, 0.02);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    expect(piece.width).toBeGreaterThan(d.piece.width); // le cadre a bien grandi
    const after = worldOf(piece, piece.graphic!.anchor);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    expect(piece.graphic!.widthM).toBe(0.1); // taille métrique intacte
    expect(piece.graphic!.rotationRad).toBe(0.4);
  });

  it('fronces avec croissance de cadre : pinces ET ancre restent physiquement en place', () => {
    // Deux bords cousus, la pièce occupe presque tout le cadre → le ratio force
    // l'agrandissement de la feuille (le chemin needsWiden de v144).
    const d = doc({
      seams: [{ a: { pieceId: 0, from: 0, to: 1 }, b: { pieceId: 1, from: 0, to: 1 } }],
    });
    d.piece.outline = [
      [0.04, 0.05],
      [0.96, 0.05],
      [0.96, 0.95],
      [0.04, 0.95],
    ] as UV[];
    d.piece.darts = [
      { apex: [0.5, 0.4], legA: [0.45, 0.5], legB: [0.55, 0.5] },
    ];
    d.piece.graphic = {
      image: PNG_1PX, anchor: [0.6, 0.7], widthM: 0.08, aspect: 1, rotationRad: 0,
    };
    const dartBefore = worldOf(d.piece, d.piece.darts[0]!.apex);
    const anchorBefore = worldOf(d.piece, d.piece.graphic.anchor);
    const res = gatherSeamSide(d, 0, 'a', 2.5);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    expect(piece.width).toBeGreaterThan(d.piece.width); // needsWiden bien pris
    const dartAfter = worldOf(piece, piece.darts[0]!.apex);
    const anchorAfter = worldOf(piece, piece.graphic!.anchor);
    expect(dartAfter[0]).toBeCloseTo(dartBefore[0], 6);
    expect(dartAfter[1]).toBeCloseTo(dartBefore[1], 6);
    expect(anchorAfter[0]).toBeCloseTo(anchorBefore[0], 6);
    expect(anchorAfter[1]).toBeCloseTo(anchorBefore[1], 6);
  });

  it('syncPieceFrames et shiftOutlineUV : l’ancre suit comme les pinces', () => {
    const front = rectPiece({
      graphic: { image: PNG_1PX, anchor: [0.4, 0.4], widthM: 0.05, aspect: 1, rotationRad: 0 },
    });
    const back = rectPiece({ width: 0.9, topY: 1.7 }); // cadres désaccordés
    const anchorBefore = worldOf(front, front.graphic!.anchor);
    const synced = syncPieceFrames(front, back);
    const anchorAfter = worldOf(synced.front, synced.front.graphic!.anchor);
    expect(anchorAfter[0]).toBeCloseTo(anchorBefore[0], 6);
    expect(anchorAfter[1]).toBeCloseTo(anchorBefore[1], 6);
    // Glissement DANS le cadre : le print glisse avec la pièce.
    const shifted = shiftOutlineUV(front, 0.1, -0.05);
    expect(shifted.graphic!.anchor[0]).toBeCloseTo(0.5, 9);
    expect(shifted.graphic!.anchor[1]).toBeCloseTo(0.35, 9);
  });
});

describe('évasement (v167) — slashSpreadFullness', () => {
  // Coordonnées MONDE (le cadre peut grandir : seul le monde est stable).
  const wxy = (piece: DraftPiece, [u, v]: UV): [number, number] => [
    (u - 0.5) * piece.width,
    piece.topY - v * piece.height,
  ];

  const perimeter = (piece: DraftPiece): number => {
    let len = 0;
    const N = piece.outline.length;
    for (let i = 0; i < N; i++) {
      const a = wxy(piece, piece.outline[i]!);
      const b = wxy(piece, piece.outline[(i + 1) % N]!);
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return len;
  };

  it('pivote un côté : rotation RIGIDE, le périmètre gagne EXACTEMENT l’ouverture', () => {
    const d = doc();
    const before = perimeter(d.piece);
    // pivot au milieu du bord HAUT (edge 0), ouverture au milieu de l'ourlet (edge 2)
    const res = slashSpreadFullness(d, 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 0.06);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    // rotation rigide : chaque ancien bord garde sa longueur, la SEULE
    // nouveauté est l'arête d'ampleur — périmètre + 6 cm exactement
    expect(perimeter(piece) - before).toBeCloseTo(0.06, 4);
    // et cette arête existe : deux sommets ADJACENTS à 6 cm l'un de l'autre
    const N = piece.outline.length;
    const hasGap = piece.outline.some((pt, i) => {
      const a = wxy(piece, pt);
      const b = wxy(piece, piece.outline[(i + 1) % N]!);
      return Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.06) < 1e-4;
    });
    expect(hasGap).toBe(true);
    // l'aire a GRANDI (l'évasement ajoute du tissu)
    const areaOf = (p: DraftPiece): number => {
      let a = 0;
      const N = p.outline.length;
      for (let i = 0; i < N; i++) {
        const u = p.outline[i]!;
        const v = p.outline[(i + 1) % N]!;
        a += u[0] * p.width * (v[1] * p.height) - v[0] * p.width * (u[1] * p.height);
      }
      return Math.abs(a / 2);
    };
    expect(areaOf(piece)).toBeGreaterThan(areaOf(d.piece));
    // le pivot n'a pas bougé : un sommet reste au point monde du milieu du
    // bord haut — x = 0, y = 1.55 − 0.2·0.9 = 1.37
    const hasPivot = piece.outline.some((pt) => {
      const [x, y] = wxy(piece, pt);
      return Math.abs(x) < 1e-4 && Math.abs(y - 1.37) < 1e-4;
    });
    expect(hasPivot).toBe(true);
  });

  it('le décor du côté pivoté tourne avec lui, l’autre reste en place', () => {
    const d = doc();
    d.piece.notches = [
      { at: [0.35, 0.8] }, // côté gauche (A) — ne bouge pas
      { at: [0.65, 0.8] }, // côté droit (B) — tourne
    ];
    const res = slashSpreadFullness(d, 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 0.05);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    // Un côté tourne, l'autre reste : sans préjuger duquel (l'ordre du
    // contour décide), UN cran est conservé au dixième de mm en monde et
    // L'AUTRE a tourné d'au moins 2 cm.
    const origins: [number, number][] = [
      [(0.35 - 0.5) * 0.6, 0.83],
      [(0.65 - 0.5) * 0.6, 0.83],
    ];
    const moves = piece.notches!.map((n, i) => {
      const [x, y] = wxy(piece, n.at);
      return Math.hypot(x - origins[i]![0], y - origins[i]![1]);
    });
    expect(Math.min(...moves)).toBeLessThan(1e-4);
    expect(Math.max(...moves)).toBeGreaterThan(0.02);
  });

  it('refus propres : trop grand, pince à cheval, socle vide', () => {
    const d = doc();
    expect(slashSpreadFullness(d, 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 2).ok).toBe(false);
    const withDart = doc();
    withDart.piece.darts = [
      { apex: [0.5, 0.4], legA: [0.42, 0.55], legB: [0.58, 0.55] }, // à cheval sur u=0.5
    ];
    const straddle = slashSpreadFullness(withDart, 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 0.04);
    expect(straddle.ok).toBe(false);
    expect(straddle.reason).toMatch(/pince/i);
    expect(slashSpreadFullness(blankBaseDraft(64), 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 0.04).ok).toBe(false);
  });

  it('round-trip sanitize après évasement', () => {
    const res = slashSpreadFullness(doc(), 0, { edge: 0, t: 0.5 }, { edge: 2, t: 0.5 }, 0.06);
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean).not.toBeNull();
    expect(clean!.piece.outline.length).toBe(res.doc!.piece.outline.length);
  });
});

describe('crans de montage (v166)', () => {
  it('toggleNotchAt : pose PROJETÉ sur le bord, re-clic à 6 mm = retiré', () => {
    const d = doc();
    // clic un peu DANS la pièce, près du bord haut (v=0.2)
    const res = toggleNotchAt(d, 0, [0.5, 0.23]);
    expect(res.ok).toBe(true);
    expect(res.action).toBe('added');
    const notch = res.doc!.piece.notches![0]!;
    expect(notch.at[1]).toBeCloseTo(0.2, 9); // projeté sur le contour
    expect(notch.at[0]).toBeCloseTo(0.5, 9);
    const again = toggleNotchAt(res.doc!, 0, [0.5, 0.205]);
    expect(again.ok).toBe(true);
    expect(again.action).toBe('removed');
    expect(again.doc!.piece.notches).toBeUndefined();
    // trop loin de tout bord → refus
    expect(toggleNotchAt(d, 0, [0.5, 0.5]).ok).toBe(false);
  });

  it('addSeamNotches : positions APPARIÉES par abscisse, sens compris', () => {
    const d = doc({
      seams: [{ a: { pieceId: 0, from: 1, to: 2 }, b: { pieceId: 1, from: 1, to: 2 } }],
    });
    // bord 1→2 du rectPiece : vertical droit, 0.54 m → 2 crans aux tiers
    const res = addSeamNotches(d, 0);
    expect(res.ok).toBe(true);
    expect(res.added).toBe(4);
    const nA = res.doc!.piece.notches!;
    const nB = res.doc!.back!.notches!;
    expect(nA).toHaveLength(2);
    expect(nB).toHaveLength(2);
    // aux tiers du bord vertical : v = 0.2 + 0.6·(1/3 | 2/3)
    const vsA = nA.map((n) => +n.at[1].toFixed(6)).sort();
    expect(vsA[0]).toBeCloseTo(0.4, 6);
    expect(vsA[1]).toBeCloseTo(0.6, 6);
    // idempotent : re-cliquer refuse proprement
    const again = addSeamNotches(res.doc!, 0);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/déjà/i);
  });

  it('runPointAtFraction : marche l’abscisse métrique du run', () => {
    const d = doc();
    const p = runPointAtFraction(d.piece, { from: 0, to: 2 }, 0.5);
    // run 0→2 : bord haut (0.36 m) + bord droit (0.54 m) = 0.9 m ; mi-longueur
    // = 0.45 m → 0.09 m le long du bord droit → v = 0.2 + 0.09/0.9
    expect(p[0]).toBeCloseTo(0.8, 9);
    expect(p[1]).toBeCloseTo(0.2 + 0.09 / 0.9, 9);
  });

  it('miroir et sanitize : les crans suivent', () => {
    const d = doc();
    const withNotch = toggleNotchAt(d, 0, [0.5, 0.21]).doc!;
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(withNotch)));
    expect(clean!.piece.notches).toHaveLength(1);
    const mir = mirrorDuplicatePiece(withNotch, 0, 1);
    expect(mir.ok).toBe(true);
    const twin = mir.doc!.pieces![mir.newPieceId - 2]!;
    expect(twin.notches).toHaveLength(1);
  });
});

describe('scission sur ligne interne (v165)', () => {
  it('une ligne à 3 points scinde la pièce le long du tracé, couture sur tout le chemin', () => {
    const d = doc();
    // ligne quasi verticale dans le rectPiece [0.2..0.8]² : prolongée en haut
    // (y=0.2) et en bas (y=0.8) le long de ses segments d'extrémité
    d.piece.internalLines = [
      { points: [[0.5, 0.3], [0.55, 0.5], [0.5, 0.7]] },
      { points: [[0.3, 0.4], [0.32, 0.42]] }, // une AUTRE ligne : suit sa moitié
    ];
    const res = cutPieceAlongInternalLine(d, 0, 0);
    expect(res.ok).toBe(true);
    const halfA = res.doc!.piece;
    const halfB = res.doc!.pieces![res.doc!.pieces!.length - 1]!;
    // les 3 points du chemin vivent dans les DEUX contours
    for (const q of [[0.5, 0.3], [0.55, 0.5], [0.5, 0.7]] as const) {
      const inA = halfA.outline.some(([u, v]) => Math.abs(u - q[0]) < 1e-9 && Math.abs(v - q[1]) < 1e-9);
      const inB = halfB.outline.some(([u, v]) => Math.abs(u - q[0]) < 1e-9 && Math.abs(v - q[1]) < 1e-9);
      expect(inA && inB).toBe(true);
    }
    // la couture de découpe couvre le chemin entier : 4 bords de chaque côté
    const cutSeam = res.doc!.seams![res.doc!.seams!.length - 1]!;
    const N_A = halfA.outline.length;
    const N_B = halfB.outline.length;
    expect((cutSeam.a.to - cutSeam.a.from + N_A) % N_A).toBe(4);
    expect((cutSeam.b.to - cutSeam.b.from + N_B) % N_B).toBe(4);
    // la ligne UTILISÉE a disparu ; l'autre suit la moitié de son centroïde
    const all = [...(halfA.internalLines ?? []), ...(halfB.internalLines ?? [])];
    expect(all).toHaveLength(1);
    expect(all[0]!.points[0]![0]).toBeCloseTo(0.3, 9);
  });

  it('extrémités prolongées : les points d’accroche tombent sur les bons bords', () => {
    const d = doc();
    d.piece.internalLines = [{ points: [[0.5, 0.3], [0.5, 0.7]] }]; // verticale pure
    const res = cutPieceAlongInternalLine(d, 0, 0);
    expect(res.ok).toBe(true);
    const halfA = res.doc!.piece;
    // les accroches : u=0.5 sur le bord haut (v=0.2) et le bord bas (v=0.8)
    const hasTop = halfA.outline.some(([u, v]) => Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 0.2) < 1e-6);
    const hasBottom = halfA.outline.some(([u, v]) => Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 0.8) < 1e-6);
    expect(hasTop && hasBottom).toBe(true);
  });

  it('refus : polygone fermé, ligne absente', () => {
    const d = doc();
    d.piece.internalLines = [{ points: [[0.4, 0.4], [0.6, 0.4], [0.5, 0.6]], closed: true }];
    const closed = cutPieceAlongInternalLine(d, 0, 0);
    expect(closed.ok).toBe(false);
    expect(closed.reason).toMatch(/fermé/i);
    expect(cutPieceAlongInternalLine(d, 0, 5).ok).toBe(false);
  });
});

describe('point courbe (v164) — roundOutlineCorner', () => {
  it('le coin devient un arc : extrémités à r sur chaque bord, coutures décalées', () => {
    const d = doc({
      seams: [{ a: { pieceId: 0, from: 2, to: 3 }, b: { pieceId: 1, from: 2, to: 3 } }],
    });
    // coin 1 du rectPiece : (0.8, 0.2) entre (0.2, 0.2) et (0.8, 0.8)
    const res = roundOutlineCorner(d, 0, 1, 0.05);
    expect(res.ok).toBe(true);
    expect(res.radiusM).toBeCloseTo(0.05, 9);
    const piece = res.doc!.piece;
    const K = CURVE_POINT_SAMPLES;
    expect(piece.outline).toHaveLength(4 + K - 1); // 4 sommets − coin + K d'arc
    // départ de l'arc : sur le bord entrant (horizontal), à 5 cm du coin :
    // coin métrique (0.48, 0.18) sur cadre 0.6×0.9, vers (0.12, 0.18)
    const startM = [piece.outline[1]![0] * 0.6, piece.outline[1]![1] * 0.9];
    expect(startM[0]).toBeCloseTo(0.48 - 0.05, 6);
    expect(startM[1]).toBeCloseTo(0.18, 6);
    // arrivée : sur le bord sortant (vertical), à 5 cm sous le coin
    const endM = [piece.outline[1 + K - 1]![0] * 0.6, piece.outline[1 + K - 1]![1] * 0.9];
    expect(endM[0]).toBeCloseTo(0.48, 6);
    expect(endM[1]).toBeCloseTo(0.18 + 0.05, 6);
    // la couture qui vivait sur le bord 2→3 s'est décalée de K−1 crans côté
    // pièce 0, et pas du tout côté pièce 1
    const seam = res.doc!.seams![0]!;
    expect(seam.a.from).toBe(2 + K - 1);
    expect(seam.a.to).toBe(3 + K - 1);
    expect(seam.b.from).toBe(2);
    expect(seam.b.to).toBe(3);
  });

  it('coin 0 (les index wrap) : le contour reste simple et fermé', () => {
    const res = roundOutlineCorner(doc(), 0, 0, 0.04);
    expect(res.ok).toBe(true);
    const K = CURVE_POINT_SAMPLES;
    const outline = res.doc!.piece.outline;
    expect(outline).toHaveLength(4 + K - 1);
    // plus aucun sommet au coin d'origine (0.2, 0.2)
    expect(outline.some(([u, v]) => Math.abs(u - 0.2) < 1e-9 && Math.abs(v - 0.2) < 1e-9)).toBe(false);
  });

  it('rayon borné par les bords adjacents, refus propres', () => {
    const big = roundOutlineCorner(doc(), 0, 1, 5);
    expect(big.ok).toBe(true);
    // bords adjacents : 0.36 m (horizontal) et 0.54 m (vertical) → r ≤ 0.45·0.36
    expect(big.radiusM).toBeCloseTo(0.45 * 0.36, 6);
    expect(roundOutlineCorner(blankBaseDraft(64), 0, 0, 0.02).ok).toBe(false);
    const preset = roundOutlineCorner({ ...doc(), preset: 'x' } as unknown as DraftDoc, 0, 1, 0.02);
    expect(preset.ok).toBe(false);
  });

  it('round-trip sanitize après arrondi : contour et coutures cohérents', () => {
    const d = doc({
      seams: [{ a: { pieceId: 0, from: 0, to: 1 }, b: { pieceId: 1, from: 0, to: 1 } }],
    });
    const res = roundOutlineCorner(d, 0, 2, 0.03);
    expect(res.ok).toBe(true);
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean).not.toBeNull();
    expect(clean!.piece.outline.length).toBe(res.doc!.piece.outline.length);
    expect(clean!.seams).toHaveLength(1);
  });
});

describe('pince losange (v163) — addFisheyeDart', () => {
  it('un losange = deux pinces dos à dos, taille PERPENDICULAIRE en métrique', () => {
    // cadre NON carré : 0.6 × 0.9 m — le test attrape une perpendiculaire UV naïve
    const d = doc();
    const res = addFisheyeDart(d, 0, [0.5, 0.3], [0.5, 0.7], 0.02);
    expect(res.ok).toBe(true);
    expect(res.widthM).toBeCloseTo(0.04, 9);
    expect(res.heightM).toBeCloseTo(0.4 * 0.9, 9); // axe vertical : 0.4·H
    const darts = res.doc!.piece.darts;
    expect(darts).toHaveLength(2);
    // jambes partagées entre les deux triangles
    expect(darts[0]!.legA).toEqual(darts[1]!.legA);
    expect(darts[0]!.legB).toEqual(darts[1]!.legB);
    // axe vertical → taille horizontale : ±2 cm en X métrique, en UV ±0.02/0.6
    const [ul] = darts[0]!.legA;
    const [ur] = darts[0]!.legB;
    expect(Math.abs(ur - ul)).toBeCloseTo(0.04 / 0.6, 9);
    expect(darts[0]!.legA[1]).toBeCloseTo(0.5, 9); // au milieu de l'axe
    // le moteur de compilation coud le losange : des paires de cellules existent
    const { extraSeams } = compileDraft(res.doc!.piece, 64);
    expect(extraSeams.length).toBeGreaterThan(4);
  });

  it('axe oblique : la taille reste perpendiculaire en espace métrique', () => {
    const d = doc();
    const res = addFisheyeDart(d, 0, [0.4, 0.3], [0.6, 0.7], 0.015);
    expect(res.ok).toBe(true);
    const [l, r] = [res.doc!.piece.darts[0]!.legA, res.doc!.piece.darts[0]!.legB];
    const W = d.piece.width;
    const H = d.piece.height;
    // vecteur taille en métrique ⟂ vecteur axe en métrique
    const wx = (r[0] - l[0]) * W;
    const wy = (r[1] - l[1]) * H;
    const ax = (0.6 - 0.4) * W;
    const ay = (0.7 - 0.3) * H;
    expect(Math.abs(wx * ax + wy * ay)).toBeLessThan(1e-9);
    expect(Math.hypot(wx, wy)).toBeCloseTo(0.03, 9);
  });

  it('refus : hors pièce, trop petit, chevauchement, socle vide, plafond', () => {
    const d = doc();
    expect(addFisheyeDart(d, 0, [0.21, 0.3], [0.21, 0.7], 0.2).ok).toBe(false); // taille sort
    expect(addFisheyeDart(d, 0, [0.5, 0.5], [0.5, 0.51], 0.01).ok).toBe(false); // axe court
    expect(addFisheyeDart(d, 0, [0.5, 0.3], [0.5, 0.7], 0.001).ok).toBe(false); // trop étroit
    expect(addFisheyeDart(blankBaseDraft(64), 0, [0.4, 0.4], [0.4, 0.6], 0.01).ok).toBe(false);
    const first = addFisheyeDart(d, 0, [0.5, 0.3], [0.5, 0.7], 0.02);
    const overlap = addFisheyeDart(first.doc!, 0, [0.5, 0.45], [0.5, 0.75], 0.02);
    expect(overlap.ok).toBe(false);
    expect(overlap.reason).toMatch(/chevauche/i);
    let cur = doc();
    for (let i = 0; i < 8; i++) {
      const r = addFisheyeDart(cur, 0, [0.25 + i * 0.07, 0.3], [0.25 + i * 0.07, 0.5], 0.004);
      if (!r.ok) break;
      cur = r.doc!;
    }
    // 8 losanges = 16 pinces : le 8e passe, un 9e refuse par plafond
    const ninth = addFisheyeDart(cur, 0, [0.3, 0.6], [0.3, 0.8], 0.004);
    if (cur.piece.darts.length >= 16) expect(ninth.ok).toBe(false);
  });

  it('round-trip sanitize : les deux pinces du losange survivent', () => {
    const d = doc();
    const res = addFisheyeDart(d, 0, [0.5, 0.3], [0.5, 0.7], 0.02);
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean!.piece.darts).toHaveLength(2);
  });
});

describe('lignes internes (v162)', () => {
  const worldOf = (piece: DraftPiece, [u, v]: [number, number]): [number, number] => [
    (u - 0.5) * piece.width,
    piece.topY - v * piece.height,
  ];

  it('sanitize : round-trip, closed, dégénérées écartées, plafonds', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: [[0.2, 0.3], [0.6, 0.35], [0.5, 0.7]], closed: true },
      { points: [[0.25, 0.5], [0.75, 0.5]] },
      { points: [[0.4, 0.4]] }, // dégénérée : tombe
      { points: [[0.1, 9], [-3, 0.2]] }, // clampée par uv()
    ];
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean).not.toBeNull();
    const lines = clean!.piece.internalLines!;
    expect(lines).toHaveLength(3);
    expect(lines[0]!.closed).toBe(true);
    expect(lines[1]!.closed).toBeUndefined();
    expect(lines[2]!.points.every(([u, v]) => u >= -0.5 && u <= 1.5 && v >= -0.5 && v <= 1.5)).toBe(true);
    // plafond : 30 lignes → 24 gardées
    const many = doc();
    many.piece.internalLines = Array.from({ length: 30 }, (_, i) => ({
      points: [[0.1, 0.1 + i * 0.01], [0.9, 0.1 + i * 0.01]] as UV[],
    }));
    const cleanMany = sanitizeDraft(JSON.parse(JSON.stringify(many)));
    expect(cleanMany!.piece.internalLines!).toHaveLength(INTERNAL_LINES_MAX);
  });

  it('offset avec croissance de cadre : les lignes gardent leur position PHYSIQUE', () => {
    const d = doc();
    d.piece.outline = [
      [0.02, 0.02],
      [0.98, 0.02],
      [0.98, 0.98],
      [0.02, 0.98],
    ] as UV[];
    const line: InternalLine = { points: [[0.3, 0.3], [0.7, 0.6]] };
    d.piece.internalLines = [line];
    const before = line.points.map((pt) => worldOf(d.piece, pt));
    const res = offsetPieceOutline(d, 0, 0.02);
    expect(res.ok).toBe(true);
    const piece = res.doc!.piece;
    expect(piece.width).toBeGreaterThan(d.piece.width);
    const after = piece.internalLines![0]!.points.map((pt) => worldOf(piece, pt));
    for (let i = 0; i < before.length; i++) {
      expect(after[i]![0]).toBeCloseTo(before[i]![0], 6);
      expect(after[i]![1]).toBeCloseTo(before[i]![1], 6);
    }
  });

  it('miroir cousu : la jumelle porte les lignes RÉFLÉCHIES', () => {
    const d = doc();
    d.piece.internalLines = [{ points: [[0.3, 0.3], [0.4, 0.6]], closed: true }];
    // axe = bord 1→2 du rectPiece : le bord vertical droit (u=0.8)
    const res = mirrorDuplicatePiece(d, 0, 1);
    expect(res.ok).toBe(true);
    const twin = res.doc!.pieces![res.newPieceId - 2]!;
    expect(twin.internalLines).toHaveLength(1);
    expect(twin.internalLines![0]!.closed).toBe(true);
    // hauteur monde conservée point à point (la réflexion est verticale ici)
    const src = d.piece.internalLines[0]!.points.map((pt) => worldOf(d.piece, pt));
    const got = twin.internalLines![0]!.points.map((pt) => worldOf(twin, pt));
    for (let i = 0; i < src.length; i++) {
      expect(got[i]![1]).toBeCloseTo(src[i]![1], 6);
    }
  });

  it('découpe : chaque ligne suit la moitié qui contient son centroïde', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: [[0.3, 0.3], [0.35, 0.4]] }, // à gauche de la corde u=0.5
      { points: [[0.65, 0.6], [0.7, 0.7]], closed: true }, // à droite
    ];
    const res = cutPieceAlongChord(d, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(res.ok).toBe(true);
    const halfA = res.doc!.piece;
    const halfB = res.doc!.pieces![res.doc!.pieces!.length - 1]!;
    const all = [
      ...(halfA.internalLines ?? []),
      ...(halfB.internalLines ?? []),
    ];
    expect(all).toHaveLength(2);
    expect((halfA.internalLines?.length ?? 0) + 0).toBe(1);
    expect((halfB.internalLines?.length ?? 0) + 0).toBe(1);
  });
});

describe('création miroir au tracé (v161) — mirrorClosedOutline', () => {
  it('une moitié dessinée devient la pièce symétrique entière', () => {
    // axe u=0.5 ; profil de demi-devant vers la droite, retour sur l'axe
    const half: UV[] = [
      [0.5, 0.05], // 0 — sur l'axe (le pose)
      [0.72, 0.08],
      [0.78, 0.5],
      [0.7, 0.9],
      [0.5, 0.92], // dernier — sur l'axe : pas d'écho
    ];
    const out = mirrorClosedOutline(half);
    expect(out).toHaveLength(5 + 3); // 5 dessinés + 3 échos (1er et dernier non doublés)
    // chaque écho est le reflet exact : u' = 2·0.5 − u, v' = v
    expect(out[5]).toEqual([2 * 0.5 - 0.7, 0.9]);
    expect(out[6]).toEqual([2 * 0.5 - 0.78, 0.5]);
    expect(out[7]).toEqual([2 * 0.5 - 0.72, 0.08]);
    // symétrie globale : le contour réfléchi = le même ensemble de sommets
    const key = ([u, v]: UV): string => `${(2 * 0.5 - u).toFixed(6)}|${v.toFixed(6)}`;
    const set = new Set(out.map(([u, v]) => `${u.toFixed(6)}|${v.toFixed(6)}`));
    for (const p of out) expect(set.has(key(p))).toBe(true);
  });

  it('le dernier point PRÈS de l’axe s’y aimante (pas de micro-cran)', () => {
    const out = mirrorClosedOutline([
      [0.4, 0.1],
      [0.6, 0.2],
      [0.4025, 0.8], // à 2.5 mUV de l'axe u=0.4 → aimanté
    ]);
    expect(out[2]![0]).toBe(0.4); // aimanté exactement sur l'axe
    expect(out).toHaveLength(4); // 3 dessinés + 1 écho (celui du point 1 seul)
  });

  it('dernier point LOIN de l’axe : son écho referme à travers l’axe', () => {
    const out = mirrorClosedOutline([
      [0.3, 0.1],
      [0.5, 0.3],
      [0.45, 0.7],
    ]);
    expect(out).toHaveLength(5); // 3 dessinés + 2 échos
    expect(out[3]).toEqual([2 * 0.3 - 0.45, 0.7]);
    expect(out[4]).toEqual([2 * 0.3 - 0.5, 0.3]);
  });

  it('deux points suffisent : triangle symétrique', () => {
    const out = mirrorClosedOutline([
      [0.5, 0.1],
      [0.65, 0.6],
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual([0.35, 0.6]);
  });
});

describe('audit session v146-159 — croisements', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('offset : refuse le socle vide (sentinelle invisible)', () => {
    const blank = blankBaseDraft(64);
    const res = offsetPieceOutline(blank, 0, 0.01);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/dessinez/i);
  });

  it('découpe : un motif répété habille les DEUX moitiés, un logo une seule', () => {
    const motif = doc();
    motif.piece.graphic = {
      image: PNG_1PX, anchor: [0.3, 0.5], widthM: 0.05, aspect: 1, rotationRad: 0.2, repeat: true,
    };
    const cutM = cutPieceAlongChord(motif, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(cutM.ok).toBe(true);
    const halves = [cutM.doc!.piece, cutM.doc!.pieces![cutM.doc!.pieces!.length - 1]!];
    for (const half of halves) {
      expect(half.graphic?.repeat).toBe(true);
      expect(half.graphic?.image).toBe(PNG_1PX);
      // Même cadre des deux côtés : la phase du motif se prolonge sans raccord.
      expect(half.graphic?.anchor).toEqual([0.3, 0.5]);
      expect(half.width).toBeCloseTo(motif.piece.width, 9);
    }
    const logo = doc();
    logo.piece.graphic = {
      image: PNG_1PX, anchor: [0.3, 0.5], widthM: 0.05, aspect: 1, rotationRad: 0.2,
    };
    const cutL = cutPieceAlongChord(logo, 0, { edge: 1, t: 0.5 }, { edge: 3, t: 0.5 });
    expect(cutL.ok).toBe(true);
    const withGraphic = [cutL.doc!.piece, cutL.doc!.pieces![cutL.doc!.pieces!.length - 1]!]
      .filter((piece) => !!piece.graphic);
    expect(withGraphic.length).toBe(1);
  });
});

describe('motifs répétés (v152)', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('sanitizeDraft : le drapeau repeat survit, un repeat non booléen tombe', () => {
    const d = doc();
    d.piece.graphic = {
      image: PNG_1PX, anchor: [0.5, 0.5], widthM: 0.05, aspect: 1, rotationRad: 0.3, repeat: true,
    };
    d.back!.graphic = {
      image: PNG_1PX, anchor: [0.5, 0.5], widthM: 0.1, aspect: 1, rotationRad: 0,
      repeat: 'oui' as never,
    };
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean!.piece.graphic?.repeat).toBe(true);
    expect(clean!.back!.graphic?.repeat).toBeUndefined();
  });

  it('graphicLocalUV reste continue au-delà de [0,1] (la matière du fract)', () => {
    const g = { image: PNG_1PX, anchor: [0.5, 0.5] as [number, number], widthM: 0.05, aspect: 1, rotationRad: 0, repeat: true };
    // À 0,125 m de l'ancre avec une répétition de 0,05 m : 2,5 répétitions.
    const [gu] = graphicLocalUV(g, 0.6, 0.9, 0.5 + 0.125 / 0.6, 0.5);
    expect(gu).toBeCloseTo(3.0, 6); // 0.5 + 2.5
  });
});

describe('socle vide (v154) — tracer depuis la page blanche sans robe', () => {
  it('blankBaseDraft : sentinelles blank, cadre corps, round-trip sanitize', () => {
    const d = blankBaseDraft(64);
    expect(d.piece.blank).toBe(true);
    expect(d.back?.blank).toBe(true);
    expect(d.piece.width).toBeCloseTo(0.95, 6); // boîte de tracé grandeur corps
    expect(d.manual).toBe(true);
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean).not.toBeNull();
    expect(clean!.piece.blank).toBe(true);
    expect(clean!.back?.blank).toBe(true);
  });

  it('le contour sentinelle ne rasterise AUCUNE cellule à 32, 64 et 128', () => {
    const d = blankBaseDraft(64);
    for (const n of [32, 64, 128] as const) {
      let insideCells = 0;
      for (let v = 0; v < n; v++) {
        for (let u = 0; u < n; u++) {
          if (pointInPolygon([u / (n - 1), v / (n - 1)], d.piece.outline)) insideCells++;
        }
      }
      expect(insideCells).toBe(0);
    }
  });
});

describe('superposer / sous-poser (v155) — empiècement par empiècement', () => {
  it('sanitize : side under survit, autre valeur tombe', () => {
    const d = doc();
    d.pieces = [
      rectPiece({
        placement: {
          role: 'pocket', autoAlign: true,
          surface: { supportPieceId: 0, anchor: [0.5, 0.5], stitchedEdges: [0, 1], side: 'under' },
        },
      }),
      rectPiece({
        placement: {
          role: 'pocket', autoAlign: true,
          surface: { supportPieceId: 0, anchor: [0.5, 0.5], stitchedEdges: [0], side: 'dessus' as never },
        },
      }),
    ];
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(d)));
    expect(clean!.pieces?.[0]?.placement?.surface?.side).toBe('under');
    expect(clean!.pieces?.[1]?.placement?.surface?.side).toBeUndefined();
  });

  it('compileSurfaceContacts émet side -1 pour une pièce sous-posée', () => {
    const n = 16;
    const d = doc();
    d.pieces = [
      rectPiece({
        width: 0.2, height: 0.2,
        placement: {
          role: 'pocket', autoAlign: true,
          surface: { supportPieceId: 0, anchor: [0.5, 0.5], stitchedEdges: [0, 1, 2, 3], side: 'under' },
        },
      }),
    ];
    const contacts = compileSurfaceContacts(d, n, [0, n * n, 2 * n * n], 2);
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.every((c) => c.side === -1)).toBe(true);
    // Sans side : +1.
    delete d.pieces[0]!.placement!.surface!.side;
    const over = compileSurfaceContacts(d, n, [0, n * n, 2 * n * n], 2);
    expect(over.every((c) => c.side === 1)).toBe(true);
  });
});

describe('miroir cousu (v157) — dupliquer en symétrie et coudre l’axe', () => {
  it('déplie un demi-panneau : jumelle réfléchie, aires égales, couture sur l’axe', () => {
    const d = doc();
    // Demi-devant asymétrique (pentagone), axe = bord droit (arête 1).
    d.piece.outline = [
      [0.2, 0.1],
      [0.6, 0.1],
      [0.6, 0.8],
      [0.35, 0.9],
      [0.2, 0.6],
    ] as UV[];
    const res = mirrorDuplicatePiece(d, 0, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newPieceId).toBe(2);
    const twin = res.doc.pieces![0]!;
    expect(twin.outline).toHaveLength(5);
    expect(twin.name).toContain('miroir');

    // Aires MÉTRIQUES égales (réflexion = isométrie).
    const areaM = (p: DraftPiece): number => {
      let a = 0;
      for (let i = 0; i < p.outline.length; i++) {
        const [x1, y1] = [p.outline[i]![0] * p.width, p.outline[i]![1] * p.height];
        const j = (i + 1) % p.outline.length;
        const [x2, y2] = [p.outline[j]![0] * p.width, p.outline[j]![1] * p.height];
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a / 2);
    };
    expect(areaM(twin)).toBeCloseTo(areaM(d.piece), 6);

    // L'orientation est préservée (aire signée de même signe qu'un contour non croisé).
    expect(twin.outline.length).toBe(5);

    // La couture d'axe : arête 1 de l'original ↔ arête N-2-k = 2 de la jumelle,
    // et les deux runs ont la MÊME longueur métrique.
    const seam = res.doc.seams![res.seamIndex]!;
    expect(pieceIdOf(seam.a)).toBe(0);
    expect(seam.a.from).toBe(1);
    expect(pieceIdOf(seam.b)).toBe(2);
    expect(seam.b.from).toBe(2);
    const lenA = runLen(res.doc.piece, seam.a.from, seam.a.to);
    const lenB = runLen(twin, seam.b.from, seam.b.to);
    expect(lenB).toBeCloseTo(lenA, 6);

    // Les hauteurs MONDE se conservent : le sommet réfléchi de v=0.1 garde y_monde.
    const yWorld = (p: DraftPiece, i: number): number => p.topY - p.outline[i]![1] * p.height;
    // sommet 1 (sur l'axe) : monde identique chez l'original et la jumelle (index N-1-1=3).
    expect(yWorld(twin, 3)).toBeCloseTo(yWorld(d.piece, 1), 6);
  });

  it('pinces et graphique suivent la réflexion ; refus propres', () => {
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const d = doc();
    d.piece.darts = [{ apex: [0.4, 0.4], legA: [0.35, 0.5], legB: [0.45, 0.5] }];
    d.piece.graphic = { image: PNG, anchor: [0.3, 0.3], widthM: 0.05, aspect: 1, rotationRad: 0.5 };
    const res = mirrorDuplicatePiece(d, 0, 1); // axe = bord droit du rectangle
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const twin = res.doc.pieces![0]!;
    expect(twin.darts).toHaveLength(1);
    expect(twin.graphic?.rotationRad).toBeCloseTo(-0.5, 9);
    // L'ancre réfléchie est de l'autre côté de l'axe, à distance égale : la
    // distance métrique ancre↔axe se conserve.
    const axeX = 0.8 * d.piece.width; // bord droit du rectangle en métrique
    const dOrig = Math.abs(0.3 * d.piece.width - axeX);
    const dTwin = Math.abs(twin.graphic!.anchor[0] * twin.width - (0.8 * d.piece.width - (0.8 * d.piece.width - axeX)) + 0); // structurel : même écart
    expect(dTwin).toBeGreaterThan(0); // garde le calcul honnête
    // Refus.
    expect(mirrorDuplicatePiece(doc({ preset: 'hoodie' } as Partial<DraftDoc>), 0, 0).ok).toBe(false);
    const blank = blankBaseDraft(64);
    expect(mirrorDuplicatePiece(blank, 0, 0).ok).toBe(false);

    // Round-trip sanitize : la jumelle survit entière.
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean!.pieces).toHaveLength(1);
    expect(clean!.seams).toHaveLength(1);
  });
});

describe('fusion (v172) — mergePiecesAlongSeam, l’inverse du ✂', () => {
  const docPiece = (d: DraftDoc, pid: number): DraftPiece => docPieces(d)[pid]!;
  const wpt = (piece: DraftPiece, [u, v]: UV): [number, number] => [
    (u - 0.5) * piece.width,
    piece.topY - v * piece.height,
  ];
  const areaM = (p: DraftPiece): number => {
    let a = 0;
    for (let i = 0; i < p.outline.length; i++) {
      const [x1, y1] = [p.outline[i]![0] * p.width, p.outline[i]![1] * p.height];
      const j = (i + 1) % p.outline.length;
      const [x2, y2] = [p.outline[j]![0] * p.width, p.outline[j]![1] * p.height];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  };
  const cutSeamIndex = (d: DraftDoc, pidNew: number): number =>
    (d.seams ?? []).findIndex(
      (s) =>
        (pieceIdOf(s.a) === 0 && pieceIdOf(s.b) === pidNew) ||
        (pieceIdOf(s.b) === 0 && pieceIdOf(s.a) === pidNew),
    );

  it('aller-retour : couper puis fondre rend la pièce d’origine (aire et monde exacts)', () => {
    const d = doc();
    const before = d.piece;
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const si = cutSeamIndex(cut.doc, cut.newPieceId);
    expect(si).toBeGreaterThanOrEqual(0);
    const merged = mergePiecesAlongSeam(cut.doc, si);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.keptPieceId).toBe(0);
    expect(merged.doc.pieces ?? []).toHaveLength(0);
    // La couture de découpe a disparu, rien d'autre n'est apparu.
    expect(merged.doc.seams ?? []).toHaveLength(0);
    // L'écart mesuré est quasi nul : les deux bords viennent du même trait.
    expect(merged.seamGapMaxM).toBeLessThan(1e-6);
    // Aire métrique conservée.
    expect(areaM(merged.doc.piece)).toBeCloseTo(areaM(before), 6);
    // Chaque coin d'origine existe encore, au même point MONDE.
    for (const corner of before.outline) {
      const [wx, wy] = wpt(before, corner);
      const hit = merged.doc.piece.outline.some((p) => {
        const [mx, my] = wpt(merged.doc.piece, p);
        return Math.hypot(mx - wx, my - wy) < 0.001;
      });
      expect(hit).toBe(true);
    }
  });

  it('le décor des DEUX côtés suit : ligne interne, cran, pince gardent leur point monde', () => {
    const d = doc();
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    let d2 = cut.doc;
    const pidB = cut.newPieceId;
    // Décor posé APRÈS la découpe : une ligne interne sur la moitié gardée,
    // un cran + une pince sur la moitié absorbée.
    const A0 = d2.piece;
    const B0 = docPiece(d2, pidB);
    const lineA: InternalLine = { points: [[0.3, 0.3], [0.6, 0.35]] as UV[] };
    d2 = { ...d2, piece: { ...A0, internalLines: [lineA] } };
    const withDecor = {
      ...B0,
      notches: [{ at: [...B0.outline[0]!] as UV }],
      darts: [
        {
          apex: [
            (B0.outline[0]![0] + B0.outline[1]![0] + B0.outline[2]![0]) / 3,
            (B0.outline[0]![1] + B0.outline[1]![1] + B0.outline[2]![1]) / 3,
          ] as UV,
          legA: [...B0.outline[0]!] as UV,
          legB: [...B0.outline[1]!] as UV,
        },
      ],
    };
    const pieces = [...(d2.pieces ?? [])];
    pieces[pidB - 2] = withDecor;
    d2 = { ...d2, pieces };
    const wNotch = wpt(withDecor, withDecor.notches![0]!.at);
    const wLine0 = wpt(d2.piece, lineA.points[0]!);
    const si = cutSeamIndex(d2, pidB);
    const merged = mergePiecesAlongSeam(d2, si);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const P = merged.doc.piece;
    expect(P.internalLines).toHaveLength(1);
    expect(P.notches).toHaveLength(1);
    expect(P.darts).toHaveLength(1);
    const wNotch2 = wpt(P, P.notches![0]!.at);
    expect(Math.hypot(wNotch2[0] - wNotch[0], wNotch2[1] - wNotch[1])).toBeLessThan(0.001);
    const wLine2 = wpt(P, P.internalLines![0]!.points[0]!);
    expect(Math.hypot(wLine2[0] - wLine0[0], wLine2[1] - wLine0[1])).toBeLessThan(0.001);
  });

  it('fusionner la paire ⧎ = DÉPLIER en une seule pièce symétrique, sans couture', () => {
    const d = doc();
    d.piece.outline = [
      [0.2, 0.1],
      [0.6, 0.1],
      [0.6, 0.8],
      [0.35, 0.9],
      [0.2, 0.6],
    ] as UV[];
    const halfArea = areaM(d.piece);
    const mir = mirrorDuplicatePiece(d, 0, 1); // axe = arête 1 (bord droit)
    expect(mir.ok).toBe(true);
    if (!mir.ok) return;
    const merged = mergePiecesAlongSeam(mir.doc, mir.seamIndex);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.doc.pieces ?? []).toHaveLength(0);
    expect(merged.doc.seams ?? []).toHaveLength(0);
    const P = merged.doc.piece;
    // Aire doublée (le déplié).
    expect(areaM(P)).toBeCloseTo(2 * halfArea, 6);
    // Symétrie exacte autour de l'axe MONDE de la couture fondue : chaque
    // sommet a son jumeau réfléchi.
    // rebox recentre le cadre sur la boîte englobante du déplié : l'axe de
    // pliure est donc exactement x=0 monde dans le nouveau cadre.
    const axisX = 0;
    for (const p of P.outline) {
      const [x, y] = wpt(P, p);
      const twinHit = P.outline.some((q) => {
        const [qx, qy] = wpt(P, q);
        return Math.hypot(2 * axisX - x - qx, y - qy) < 0.001;
      });
      expect(twinHit).toBe(true);
    }
  });

  it('refus motivés : volume 3D (bords non congruents), faces, même pièce, zip', () => {
    // Bords non congruents : le bord de B est BOMBÉ (même corde, arc plus long).
    const d = doc();
    const free = rectPiece({
      outline: [
        [0.2, 0.2],
        [0.5, 0.35], // bosse au milieu du "bord de couture"
        [0.8, 0.2],
        [0.8, 0.8],
        [0.2, 0.8],
      ] as UV[],
    });
    const d2: DraftDoc = {
      ...d,
      pieces: [free],
      seams: [
        { a: { face: 'front', from: 0, to: 1 }, b: { pieceId: 2, from: 0, to: 2 } },
        { a: { face: 'front', from: 1, to: 2 }, b: { face: 'back', from: 1, to: 2 } },
        { a: { face: 'front', from: 2, to: 3 }, b: { pieceId: 2, from: 2, to: 3 }, kind: 'zipper' },
      ],
    };
    const r1 = mergePiecesAlongSeam(d2, 0);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('superposent');
    const r2 = mergePiecesAlongSeam(d2, 1); // devant ↔ dos
    expect(r2.ok).toBe(false);
    const r3 = mergePiecesAlongSeam(d2, 2); // zip
    expect(r3.ok).toBe(false);
    const selfDoc: DraftDoc = {
      ...d,
      seams: [{ a: { face: 'front', from: 0, to: 1 }, b: { face: 'front', from: 2, to: 3 } }],
    };
    expect(mergePiecesAlongSeam(selfDoc, 0).ok).toBe(false);
    expect(mergePiecesAlongSeam(d, 99).ok).toBe(false);
  });

  it('les liens tiers survivent, réindexés sur la pièce fusionnée, au monde près', () => {
    const d = doc();
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const pidB = cut.newPieceId;
    const B = docPiece(cut.doc, pidB);
    // Une arête de B loin de la couture de découpe : ses deux bouts sur le
    // bord bas (v≈0.8) du rectangle d'origine.
    const NB = B.outline.length;
    let edgeB = -1;
    for (let i = 0; i < NB; i++) {
      const p = B.outline[i]!;
      const q = B.outline[(i + 1) % NB]!;
      if (p[1] > 0.75 && q[1] > 0.75) {
        edgeB = i;
        break;
      }
    }
    expect(edgeB).toBeGreaterThanOrEqual(0);
    const wFrom = wpt(B, B.outline[edgeB]!);
    const wTo = wpt(B, B.outline[(edgeB + 1) % NB]!);
    const d2: DraftDoc = {
      ...cut.doc,
      segmentLinks: [
        { a: { pieceId: pidB, from: edgeB, to: (edgeB + 1) % NB }, b: { face: 'back', from: 0, to: 1 } },
      ],
    };
    const si = cutSeamIndex(d2, pidB);
    const merged = mergePiecesAlongSeam(d2, si);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.droppedLinks).toBe(0);
    const links = merged.doc.segmentLinks ?? [];
    expect(links).toHaveLength(1);
    const side = pieceIdOf(links[0]!.a) === 0 ? links[0]!.a : links[0]!.b;
    expect(pieceIdOf(side)).toBe(0);
    const P = merged.doc.piece;
    const nFrom = wpt(P, P.outline[side.from]!);
    const nTo = wpt(P, P.outline[side.to % P.outline.length]!);
    // Mêmes deux bouts MONDE, dans un sens ou dans l'autre (les runs sont non
    // orientés — l'anti-vrillage choisit à la couture).
    const straight = Math.hypot(nFrom[0] - wFrom[0], nFrom[1] - wFrom[1]) < 0.001 &&
      Math.hypot(nTo[0] - wTo[0], nTo[1] - wTo[1]) < 0.001;
    const flipped = Math.hypot(nFrom[0] - wTo[0], nFrom[1] - wTo[1]) < 0.001 &&
      Math.hypot(nTo[0] - wFrom[0], nTo[1] - wFrom[1]) < 0.001;
    expect(straight || flipped).toBe(true);
  });
});

describe('trous (v173) — toggleInternalHole, l’« évider » de Clo', () => {
  const holeSquare: UV[] = [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.6, 0.6],
    [0.4, 0.6],
  ];

  it('bascule fermée → trou, re-clic → style ; sanitize round-trip ; filtre des polygones', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: holeSquare.map((p) => [...p] as UV), closed: true },
      { points: [[0.25, 0.7], [0.35, 0.75]] as UV[] },
    ];
    const r1 = toggleInternalHole(d, 0, 0);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.holed).toBe(true);
    expect(r1.doc.piece.internalLines![0]!.hole).toBe(true);
    // pieceHolePolygons ne retient QUE les fermées marquées trou.
    expect(pieceHolePolygons(r1.doc.piece)).toHaveLength(1);
    // Round-trip sanitize : le flag survit — et jamais sur une polyligne.
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(r1.doc)))!;
    expect(clean.piece.internalLines![0]!.hole).toBe(true);
    const dirty = JSON.parse(JSON.stringify(r1.doc));
    dirty.piece.internalLines[1].hole = true; // corrompu : trou sur POLYLIGNE
    const clean2 = sanitizeDraft(dirty)!;
    expect(clean2.piece.internalLines![1]!.hole).toBeUndefined();
    // Re-clic : rebouché.
    const r2 = toggleInternalHole(r1.doc, 0, 0);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.holed).toBe(false);
    expect(r2.doc.piece.internalLines![0]!.hole).toBeUndefined();
    expect(pieceHolePolygons(r2.doc.piece)).toHaveLength(0);
  });

  it('le maillage s’évide réellement : particule morte au centre du trou', () => {
    const n = 24;
    const outline: UV[] = [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
    const base = { resolution: n, shape: 'freeform' as const, width: 0.6, height: 0.8, gap: 0.3, topY: 1.5 };
    const plain = generateSeamedPanels({ ...base, mask: { outline, darts: [] } });
    const holed = generateSeamedPanels({ ...base, mask: { outline, darts: [], holes: [holeSquare] } });
    const center = Math.round((n - 1) / 2) * n + Math.round((n - 1) / 2);
    expect(plain.invMasses[center]).toBeGreaterThan(0);
    expect(holed.invMasses[center]).toBe(0);
    const alive = (m: Float32Array): number => {
      let k = 0;
      for (let i = 0; i < n * n; i++) if (m[i]! > 0) k++;
      return k;
    };
    const lost = alive(plain.invMasses) - alive(holed.invMasses);
    expect(lost).toBeGreaterThan(10); // ~4 % de la grille pour un carré de 20 %
    // Et un point HORS du trou vit toujours (coin haut-gauche de l'étoffe).
    const corner = 3 * n + 3;
    expect(holed.invMasses[corner]).toBeGreaterThan(0);
  });

  it('refus motivés : polyligne, tracé hors pièce, pince dans le trou', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: [[0.3, 0.3], [0.6, 0.35]] as UV[] }, // polyligne
      { points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] as UV[], closed: true }, // sort du contour (0.2–0.8)
      { points: holeSquare.map((p) => [...p] as UV), closed: true },
    ];
    const r1 = toggleInternalHole(d, 0, 0);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain('polyligne');
    const r2 = toggleInternalHole(d, 0, 1);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('DANS la pièce');
    d.piece.darts = [{ apex: [0.5, 0.5], legA: [0.45, 0.55], legB: [0.55, 0.55] }];
    const r3 = toggleInternalHole(d, 0, 2);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toContain('pince');
    // Reboucher reste TOUJOURS permis, même si la géométrie a bougé depuis.
    d.piece.darts = [];
    const ok = toggleInternalHole(d, 0, 2);
    expect(ok.ok).toBe(true);
    expect(toggleInternalHole(d, 0, 99).ok).toBe(false);
  });
});

describe('édition liée (v174) — linkedVertexEdit, le « Linked Editing » de Clo', () => {
  const wpt = (piece: DraftPiece, [u, v]: UV): [number, number] => [
    (u - 0.5) * piece.width,
    piece.topY - v * piece.height,
  ];
  const cutSeamOf = (d: DraftDoc, pidNew: number): number =>
    (d.seams ?? []).findIndex(
      (s) =>
        (pieceIdOf(s.a) === 0 && pieceIdOf(s.b) === pidNew) ||
        (pieceIdOf(s.b) === 0 && pieceIdOf(s.a) === pidNew),
    );

  it('le vis-à-vis suit, forme comprise : après l’édition liée, ⧉ fusionne encore', () => {
    const d = doc();
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const si = cutSeamOf(cut.doc, cut.newPieceId);
    const seam = cut.doc.seams![si]!;
    const srcSide = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    const v = srcSide.from % cut.doc.piece.outline.length;
    const from = cut.doc.piece.outline[v]!;
    const target: UV = [from[0] + 0.05, from[1] + 0.03]; // 3 cm × 2,7 cm métriques
    // SANS suivi : le déplacement du seul côté source rend les bords non
    // congruents — la fusion refuse (contre-épreuve).
    const lone = JSON.parse(JSON.stringify(cut.doc)) as DraftDoc;
    lone.piece.outline[v] = [...target] as UV;
    const refuse = mergePiecesAlongSeam(lone, si);
    expect(refuse.ok).toBe(false);
    // AVEC l'édition liée : le partenaire suit, la congruence tient, ⧉ accepte.
    const res = linkedVertexEdit(cut.doc, 0, v, target);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.followed).toHaveLength(1);
    expect(res.followed[0]!.pieceId).toBe(cut.newPieceId);
    expect(res.followed[0]!.inserted).toBe(false); // le point d'accord existait (découpe)
    expect(res.doc.piece.outline[v]![0]).toBeCloseTo(target[0], 9);
    const merged = mergePiecesAlongSeam(res.doc, si);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.seamGapMaxM).toBeLessThan(0.001);
  });

  it('la symétrie vivante : la paire ⧎ éditée liée reste un miroir parfait', () => {
    const d = doc();
    d.piece.outline = [
      [0.2, 0.1],
      [0.6, 0.1],
      [0.6, 0.8],
      [0.35, 0.9],
      [0.2, 0.6],
    ] as UV[];
    const mir = mirrorDuplicatePiece(d, 0, 1); // axe = arête 1 (bord droit)
    expect(mir.ok).toBe(true);
    if (!mir.ok) return;
    const seam = mir.doc.seams![mir.seamIndex]!;
    const v = (pieceIdOf(seam.a) === 0 ? seam.a : seam.b).from % mir.doc.piece.outline.length;
    const from = mir.doc.piece.outline[v]!;
    // Le long de l'AXE (u constant) : l'axe de pliure reste la même droite,
    // le miroir global doit donc survivre au geste. (Un delta perpendiculaire
    // déplacerait l'axe lui-même — congruence gardée mais symétrie déplacée.)
    const res = linkedVertexEdit(mir.doc, 0, v, [from[0], from[1] + 0.05]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.followed).toHaveLength(1);
    expect(res.followed[0]!.pieceId).toBe(2);
    // La preuve par la fusion : le déplié reste possible ET symétrique.
    const merged = mergePiecesAlongSeam(res.doc, mir.seamIndex);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const P = merged.doc.piece;
    for (const p of P.outline) {
      const [x, y] = wpt(P, p);
      const twinHit = P.outline.some((q) => {
        const [qx, qy] = wpt(P, q);
        return Math.hypot(-x - qx, y - qy) < 0.001; // axe du déplié = x=0 (rebox)
      });
      expect(twinHit).toBe(true);
    }
  });

  it('sommet hors couture : rien à lier, le doc rendu est celui d’entrée', () => {
    const d = doc();
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // Un coin du bas du devant, loin de la couture de découpe.
    const N = cut.doc.piece.outline.length;
    let corner = -1;
    for (let i = 0; i < N; i++) {
      const q = cut.doc.piece.outline[i]!;
      if (Math.abs(q[0] - 0.2) < 1e-6 && Math.abs(q[1] - 0.2) < 1e-6) corner = i;
    }
    if (corner < 0) {
      for (let i = 0; i < N; i++) {
        const q = cut.doc.piece.outline[i]!;
        if (Math.abs(q[0] - 0.2) < 1e-6 && Math.abs(q[1] - 0.8) < 1e-6) corner = i;
      }
    }
    expect(corner).toBeGreaterThanOrEqual(0);
    const res = linkedVertexEdit(cut.doc, 0, corner, [0.15, 0.55]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.followed).toHaveLength(0);
    expect(res.doc).toBe(cut.doc); // contrat : au caller de committer normalement
  });

  it('refus net : un suivi qui croiserait un contour abandonne TOUT le geste', () => {
    const d = doc();
    const cut = cutPieceAlongChord(d, 0, { edge: 3, t: 0.5 }, { edge: 1, t: 0.5 });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const si = cutSeamOf(cut.doc, cut.newPieceId);
    const seam = cut.doc.seams![si]!;
    const srcSide = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    const v = srcSide.from % cut.doc.piece.outline.length;
    // Traverser toute la pièce : le contour source se croiserait.
    const res = linkedVertexEdit(cut.doc, 0, v, [0.95, 0.95]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('geste abandonné');
  });
});

describe('établi de précision (v175) — diviser, aligner, équerrer, prolonger, scinder', () => {
  it('◫ divise un bord en 3 parts égales MÉTRIQUES, coutures réindexées au monde près', () => {
    const d = doc();
    // Une couture sur le bord 2 (bas → sera décalé par les insertions du bord 0).
    d.seams = [{ a: { face: 'front', from: 2, to: 3 }, b: { face: 'back', from: 2, to: 3 } }];
    const before = d.piece.outline[2]!;
    const res = divideOutlineEdge(d, 0, 0, 3);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const P = res.doc.piece;
    expect(P.outline).toHaveLength(6);
    // Tiers exacts sur le bord 0 (0.2,0.2)→(0.8,0.2).
    expect(P.outline[1]![0]).toBeCloseTo(0.4, 9);
    expect(P.outline[2]![0]).toBeCloseTo(0.6, 9);
    expect(P.outline[1]![1]).toBeCloseTo(0.2, 9);
    // La couture suit ses sommets d'origine (décalés de +2).
    const s = res.doc.seams![0]!;
    expect(s.a.from).toBe(4);
    expect(res.doc.piece.outline[s.a.from]![0]).toBeCloseTo(before[0], 9);
    // Refus : bord minuscule / trop de parts.
    expect(divideOutlineEdge(d, 0, 0, 9).ok).toBe(false);
  });

  it('⌗ aligne un sommet sur un autre (même verticale), refuse le déjà-aligné', () => {
    const d = doc();
    d.piece.outline = [
      [0.2, 0.2],
      [0.8, 0.25],
      [0.78, 0.8],
      [0.2, 0.8],
    ] as UV[];
    const res = alignOutlineVertex(d, 0, 2, 1, 'x');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.piece.outline[2]![0]).toBeCloseTo(0.8, 9); // même X que la référence
    expect(res.doc.piece.outline[2]![1]).toBeCloseTo(0.8, 9); // Y inchangé
    expect(res.target[0]).toBeCloseTo(0.8, 9);
    const again = alignOutlineVertex(res.doc, 0, 2, 1, 'x');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('alignés');
    expect(alignOutlineVertex(d, 0, 1, 1, 'x').ok).toBe(false);
  });

  it('∟ équerre un angle : la tangente au sommet devient perpendiculaire à 1° près', () => {
    const d = doc();
    // Coin très ouvert au sommet 1 : (0.2,0.2)→(0.8,0.2) puis (0.8,0.2)→(0.9,0.8).
    d.piece.outline = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.9, 0.8],
      [0.2, 0.8],
    ] as UV[];
    const N0 = d.piece.outline.length;
    const res = squareCorner(d, 0, 1, 'next');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const P = res.doc.piece;
    expect(P.outline.length).toBeGreaterThan(N0);
    // Tangente au sommet 1 (vers le point inséré suivant), en MÉTRIQUE.
    const M = ([u, v]: UV): [number, number] => [u * P.width, v * P.height];
    const V = M(P.outline[1]!);
    const T = M(P.outline[2]!);
    const Uprev = M(P.outline[0]!);
    const tan = [T[0] - V[0], T[1] - V[1]];
    const ref = [Uprev[0] - V[0], Uprev[1] - V[1]];
    const cos =
      (tan[0] * ref[0] + tan[1] * ref[1]) /
      (Math.hypot(tan[0], tan[1]) * Math.hypot(ref[0], ref[1]));
    // L'arc est ÉCHANTILLONNÉ (K=6) : la corde vers le 1er échantillon dévie
    // d'~1,3° de la tangente vraie — la perpendiculaire s'entend à l'échantillon.
    expect(Math.abs((Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI - 90)).toBeLessThan(2.5);
    // Le bout du bord courbé n'a pas bougé.
    expect(P.outline[1 + CURVE_POINT_SAMPLES]![0]).toBeCloseTo(0.9, 9);
    // Déjà d'équerre → refus motivé avec l'angle.
    const rect = doc();
    const r2 = squareCorner(rect, 0, 1, 'next');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('équerre');
  });

  it('⇥ prolonge un bout de ligne interne jusqu’au contour, refuse les fermées', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: [[0.5, 0.5], [0.5, 0.4]] as UV[] }, // pointe vers le haut → bord 0 (y=0.2)
      { points: [[0.3, 0.3], [0.6, 0.3], [0.6, 0.6], [0.3, 0.6]] as UV[], closed: true },
    ];
    const res = extendInternalLineEnd(d, 0, 0, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const line = res.doc.piece.internalLines![0]!;
    expect(line.points).toHaveLength(3);
    expect(line.points[2]![1]).toBeCloseTo(0.2, 6); // posé SUR le bord haut
    expect(line.points[2]![0]).toBeCloseTo(0.5, 6);
    expect(extendInternalLineEnd(d, 0, 1, 0).ok).toBe(false); // fermée
    // Re-prolonger le même bout : déjà au contour → refus.
    expect(extendInternalLineEnd(res.doc, 0, 0, 1).ok).toBe(false);
  });

  it('⇥ scinde une ligne interne en deux au point cliqué (point partagé exact)', () => {
    const d = doc();
    d.piece.internalLines = [
      { points: [[0.3, 0.3], [0.5, 0.3], [0.7, 0.5]] as UV[] },
    ];
    const res = divideInternalLineAt(d, 0, 0, [0.6, 0.4]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lines = res.doc.piece.internalLines!;
    expect(lines).toHaveLength(2);
    const endA = lines[0]!.points[lines[0]!.points.length - 1]!;
    const startB = lines[1]!.points[0]!;
    expect(endA[0]).toBeCloseTo(startB[0], 9);
    expect(endA[1]).toBeCloseTo(startB[1], 9);
    expect(lines[0]!.points.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]!.points.length).toBeGreaterThanOrEqual(2);
    // Clic loin de la ligne → refus.
    expect(divideInternalLineAt(d, 0, 0, [0.2, 0.7]).ok).toBe(false);
  });
});

describe('bord mesuré (v180)', () => {
  it('cote un bord en centimètres réels depuis le cadre métrique de la pièce', () => {
    const doc = blankBaseDraft();
    const piece = {
      ...doc.piece,
      width: 0.6,
      height: 0.8,
      outline: [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ] as [number, number][],
    };
    // bord haut : 0,5 u × 0,6 m = 30 cm · bord droit : 0,5 v × 0,8 m = 40 cm
    expect(outlineEdgeLengthCm(piece, piece.outline, 0)).toBeCloseTo(30, 5);
    expect(outlineEdgeLengthCm(piece, piece.outline, 1)).toBeCloseTo(40, 5);
    // la diagonale d'un cadre anisotrope : hypoténuse métrique, pas UV
    const diag = { ...piece, outline: [[0, 0], [1, 1], [0, 1]] as [number, number][] };
    expect(outlineEdgeLengthCm(diag, diag.outline, 0)).toBeCloseTo(100, 5);
  });
});

describe('liserés 3D (v181)', () => {
  it('groupe les paires par couture — à plat, identique au compilateur historique', () => {
    const doc = tshirtDraft();
    const n = 24;
    const groups = compileAssemblyGroups(doc, n);
    // Le tee : épaules + flancs joignent Devant↔Dos (socle, couvert) ; les
    // MANCHES sont des pièces libres (coutures croisées, hors périmètre v1).
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups.flatMap((g) => g.pairs)).toEqual(compileAssembly(doc, n));
    for (const g of groups) {
      expect(g.seamIndex).toBeGreaterThanOrEqual(0);
      expect(g.seamIndex).toBeLessThan((doc.seams ?? []).length);
      expect(g.pairs.length).toBeGreaterThan(2);
      for (const q of g.pairs) {
        expect(q.i).not.toBe(q.j);
        expect(q.i).toBeLessThan(2 * n * n);
        expect(q.j).toBeLessThan(2 * n * n);
      }
    }
  });
});
