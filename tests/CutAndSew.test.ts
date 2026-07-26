import { describe, expect, it } from 'vitest';
import {
  cutPieceAlongChord,
  gatherSeamSide,
  pieceIdOf,
  sanitizeDraft,
  type AssemblySeam,
  type DraftDoc,
  type DraftPiece,
  type UV,
} from '../src/engine/pattern/Draft';

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
