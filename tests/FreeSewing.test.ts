import { describe, expect, it } from 'vitest';
import {
  freeSeamBetween,
  pieceIdOf,
  sanitizeDraft,
  type DraftDoc,
  type DraftPiece,
  type FreeRunSpec,
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

const spec = (
  pieceId: number,
  start: { edge: number; t: number },
  end: { edge: number; t: number },
  dir: 1 | -1 = 1,
): FreeRunSpec => ({ pieceId, start, end, dir });

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

/** Les arêtes couvertes par un run, en indices cycliques. */
const runEdges = (piece: DraftPiece, from: number, to: number): number[] => {
  const N = piece.outline.length;
  const steps = (to - from + N) % N;
  const edges: number[] = [];
  for (let k = 0; k < steps; k++) edges.push((from + k) % N);
  return edges;
};

describe('Couture libre — freeSeamBetween', () => {
  it('coud deux tracés mi-arête ↔ mi-arête en insérant les points d’accord', () => {
    const d = doc();
    // Devant : moitié droite du bas (arête 0, de t=0.5 au coin 1 — t=0.99
    // s'accroche au coin même après la 1re insertion qui rétrécit l'arête).
    // Dos : moitié gauche du bas (coin 0 → t=0.5).
    const res = freeSeamBetween(
      d,
      spec(0, { edge: 0, t: 0.5 }, { edge: 0, t: 0.99 }),
      spec(1, { edge: 0, t: 0.01 }, { edge: 0, t: 0.5 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // t=0.96 s'accroche au coin existant (CUT_SNAP_T) : le devant ne gagne
    // QU'UN sommet (le départ mi-arête) ; pareil pour le dos.
    expect(res.doc.piece.outline).toHaveLength(5);
    expect(res.doc.back!.outline).toHaveLength(5);

    expect(res.doc.seams).toHaveLength(1);
    const seam = res.doc.seams![0]!;
    const front = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    const back = pieceIdOf(seam.a) === 1 ? seam.a : seam.b;
    // Chaque run couvre exactement UNE arête : la moitié découpée.
    expect(runEdges(res.doc.piece, front.from, front.to)).toHaveLength(1);
    expect(runEdges(res.doc.back!, back.from, back.to)).toHaveLength(1);
    // Longueurs : une demi-arête basse = 0.3 × 0.6 m = 0.18 m.
    expect(res.lengthAM).toBeCloseTo(0.18, 2);
    expect(res.lengthBM).toBeCloseTo(0.18, 2);
  });

  it('passe les coins : un tracé sur DEUX arêtes cousu à un tracé d’une arête', () => {
    const d = doc();
    // Devant : du milieu du bas (arête 0) au milieu du côté droit (arête 1) —
    // le tracé tourne le coin 1. Dos : le haut entier (arête 2).
    const res = freeSeamBetween(
      d,
      spec(0, { edge: 0, t: 0.5 }, { edge: 1, t: 0.5 }),
      spec(1, { edge: 2, t: 0.02 }, { edge: 2, t: 0.98 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const seam = res.doc.seams![0]!;
    const front = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    // 2 sommets insérés sur le devant → contour à 6 ; le run couvre 2 arêtes
    // (demi-bas puis demi-droit), coin compris.
    expect(res.doc.piece.outline).toHaveLength(6);
    expect(runEdges(res.doc.piece, front.from, front.to)).toHaveLength(2);
    // Longueur devant = 0.3×0.6 + 0.3×0.9 = 0.18 + 0.27 = 0.45 m ; l'embu est
    // rendu tel quel (l'assembleur froncera le long sur le court).
    expect(res.lengthAM).toBeCloseTo(0.45, 2);
    expect(res.lengthBM).toBeCloseTo(0.6 * 0.6, 2);
  });

  it('dir=-1 choisit l’ARC COMPLÉMENTAIRE entre les deux mêmes points', () => {
    const base = doc();
    const start = { edge: 0, t: 0.5 };
    const end = { edge: 1, t: 0.5 };
    const fwd = freeSeamBetween(base, spec(0, start, end, 1), spec(1, { edge: 2, t: 0.2 }, { edge: 2, t: 0.8 }));
    const bwd = freeSeamBetween(base, spec(0, start, end, -1), spec(1, { edge: 2, t: 0.2 }, { edge: 2, t: 0.8 }));
    expect(fwd.ok).toBe(true);
    expect(bwd.ok).toBe(true);
    if (!fwd.ok || !bwd.ok) return;
    const runOf = (r: typeof fwd): { piece: DraftPiece; from: number; to: number } => {
      const seam = r.doc.seams![0]!;
      const run = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
      return { piece: r.doc.piece, from: run.from, to: run.to };
    };
    const f = runOf(fwd);
    const b = runOf(bwd);
    const fEdges = runEdges(f.piece, f.from, f.to).length;
    const bEdges = runEdges(b.piece, b.from, b.to).length;
    // Mêmes deux points, arcs complémentaires : 2 arêtes dans un sens,
    // 4 dans l'autre (contour passé à 6 sommets) — jamais le même arc.
    expect(fEdges + bEdges).toBe(6);
    expect(fEdges).toBe(2);
    expect(bEdges).toBe(4);
    // Les longueurs des deux arcs se complètent au périmètre exact.
    const perimeter = runLen(f.piece, 0, 0) || runLen(f.piece, 0, f.piece.outline.length - 1) + runLen(f.piece, f.piece.outline.length - 1, 0);
    const fLen = runLen(f.piece, f.from, f.to);
    const bLen = runLen(b.piece, b.from, b.to);
    expect(fLen + bLen).toBeCloseTo(2 * (0.6 * 0.6 + 0.6 * 0.9), 6);
    expect(perimeter).toBeGreaterThan(0); // garde le helper honnête
  });

  it('s’accroche aux sommets existants : aucun point inséré près d’un coin', () => {
    const d = doc();
    const res = freeSeamBetween(
      d,
      spec(0, { edge: 0, t: 0.02 }, { edge: 0, t: 0.98 }),
      spec(1, { edge: 2, t: 0.01 }, { edge: 2, t: 0.99 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.piece.outline).toHaveLength(4);
    expect(res.doc.back!.outline).toHaveLength(4);
    const seam = res.doc.seams![0]!;
    const front = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    expect(runEdges(res.doc.piece, front.from, front.to)).toEqual([0]);
  });

  it('ré-indexe les coutures EXISTANTES quand l’insertion les décale', () => {
    // Une couture existante sur le haut du devant (arête 2→3).
    const existing = { a: { pieceId: 0, from: 2, to: 3 }, b: { pieceId: 1, from: 2, to: 3 } };
    const d = doc({ seams: [existing] });
    const topLenBefore = runLen(rectPiece(), 2, 3);
    // Couture libre sur le BAS du devant (arête 0, mi-arête → insertion à
    // l'index 1 : tout ce qui suit se décale de +1).
    const res = freeSeamBetween(
      d,
      spec(0, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
      spec(1, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.doc.seams).toHaveLength(2);
    const shifted = res.doc.seams![0]!;
    // L'ancienne couture pointe toujours le HAUT physique : même longueur.
    const stillTop = runLen(res.doc.piece, shifted.a.from, shifted.a.to);
    expect(stillTop).toBeCloseTo(topLenBefore, 9);
    // Et ses bornes ont bien été décalées (+2 : deux insertions sur l'arête 0).
    expect(shifted.a.from).toBe(4);
    expect(shifted.a.to).toBe(5);
  });

  it('tracé partiel DANS une seule arête : coudre le tiers central de deux bords', () => {
    const d = doc();
    const res = freeSeamBetween(
      d,
      spec(0, { edge: 0, t: 1 / 3 }, { edge: 0, t: 2 / 3 }),
      spec(1, { edge: 0, t: 1 / 3 }, { edge: 0, t: 2 / 3 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 2 insertions sur la même arête, de part et d'autre.
    expect(res.doc.piece.outline).toHaveLength(6);
    expect(res.lengthAM).toBeCloseTo(0.6 * 0.6 / 3, 3);
    const seam = res.doc.seams![0]!;
    const front = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    expect(runEdges(res.doc.piece, front.from, front.to)).toHaveLength(1);
  });

  it('refuse : modèle intégré, chevauchement même pièce, tracé vide, doublon', () => {
    // Modèle intégré.
    const preset = freeSeamBetween(
      doc({ preset: 'hoodie' } as Partial<DraftDoc>),
      spec(0, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
      spec(1, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
    );
    expect(preset.ok).toBe(false);

    // Chevauchement : deux tracés sur la même pièce qui partagent l'arête 1.
    const overlap = freeSeamBetween(
      doc(),
      spec(0, { edge: 0, t: 0.5 }, { edge: 1, t: 0.5 }),
      spec(0, { edge: 1, t: 0.2 }, { edge: 2, t: 0.5 }),
    );
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.reason).toContain('chevauchent');

    // Tracé vide : départ = arrivée (accrochés au même sommet).
    const empty = freeSeamBetween(
      doc(),
      spec(0, { edge: 0, t: 0.01 }, { edge: 0, t: 0.02 }),
      spec(1, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
    );
    expect(empty.ok).toBe(false);

    // Doublon : re-poser la MÊME couture. Les points de la 1re passe sont
    // devenus les sommets 1 et 2 du contour — la 2e passe s'y accroche et
    // produit des runs identiques → refus.
    const first = freeSeamBetween(
      doc(),
      spec(0, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
      spec(1, { edge: 0, t: 0.3 }, { edge: 0, t: 0.7 }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = freeSeamBetween(
      first.doc,
      spec(0, { edge: 1, t: 0.02 }, { edge: 1, t: 0.98 }),
      spec(1, { edge: 1, t: 0.02 }, { edge: 1, t: 0.98 }),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain('déjà cousus');
  });

  it('round-trip sanitizeDraft : la couture libre survit à la sauvegarde', () => {
    const res = freeSeamBetween(
      doc(),
      spec(0, { edge: 0, t: 0.5 }, { edge: 1, t: 0.5 }),
      spec(1, { edge: 2, t: 0.2 }, { edge: 2, t: 0.8 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean).not.toBeNull();
    expect(clean!.seams).toHaveLength(1);
    const seam = clean!.seams![0]!;
    const front = pieceIdOf(seam.a) === 0 ? seam.a : seam.b;
    expect(runEdges(clean!.piece, front.from, front.to)).toHaveLength(2);
    expect(clean!.piece.outline).toHaveLength(res.doc.piece.outline.length);
  });
});
