import { describe, expect, it } from 'vitest';
import { sewEdgeToMany, pieceIdOf, type DraftDoc, type DraftPiece, type FaceRun } from '../src/engine/pattern/Draft';

/** Rectangle unité (contour normalisé [0,1]²) de largeur physique `wCm` — la
 * longueur d'un bord horizontal = 1 × width. Contour : HG → HD → BD → BG
 * (sommets 0,1,2,3), bord HAUT = run 0→1, bord BAS = run 3→2. */
function rect(width: number, height = 0.5): DraftPiece {
  return {
    outline: [[0, 1], [1, 1], [1, 0], [0, 0]],
    darts: [], seams: [], openEdges: [], width, height, topY: 1.5, gap: 0.2,
  };
}

/** Doc : receveur = pièce libre 0 (long bord haut) ; partenaires = pièces 1..N. */
function makeDoc(recv: DraftPiece, partners: DraftPiece[]): DraftDoc {
  return {
    format: 'toile-draft', version: 1, gridN: 64,
    piece: recv, // slot 0 = receveur
    manual: true,
    pieces: partners, // pieceId 2, 3, ...
    seams: [],
  };
}

describe('couture en série — 1 bord ↔ N pièces', () => {
  it('scinde le bord receveur par LARGEUR des partenaires', () => {
    // Receveur : ceinture de largeur 4 (= somme des partenaires 1+2+1).
    const recv = rect(4, 0.1);
    // 3 partenaires de largeurs 1, 2, 1 (leur bord BAS = la couture).
    const doc = makeDoc(recv, [rect(1), rect(2), rect(1)]);
    // Bord bas d'un partenaire = run 3→2 ; bord haut du receveur = run 0→1.
    const partnerBottom = (pid: number): FaceRun => ({ pieceId: pid, from: 2, to: 3 });
    const receiver: FaceRun = { pieceId: 0, from: 0, to: 1 };
    const r = sewEdgeToMany(doc, receiver, [partnerBottom(2), partnerBottom(3), partnerBottom(4)], 64);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seams).toBe(3);
    // 3 coutures créées, chacune sur un segment du receveur.
    const newSeams = (r.doc.seams ?? []).slice(-3);
    expect(newSeams.length).toBe(3);
    // Le receveur (pid 0) a reçu 2 crans intérieurs → contour 4 → 6 sommets.
    expect(r.doc.piece.outline.length).toBe(6);
    // Les 3 segments couvrent le bord [u=0..3] aux fractions 1/4, 3/4 : les
    // crans tombent à u=0,75 (fin p1) et u=2,25 (fin p2). Vérifier les U des
    // sommets insérés sur le bord haut (v=1).
    const topUs = r.doc.piece.outline.filter(([, v]) => Math.abs(v - 1) < 1e-6).map(([u]) => u).sort((a, b) => a - b);
    expect(topUs[0]).toBeCloseTo(0, 5);
    expect(topUs[1]).toBeCloseTo(0.25, 4); // fin p1 (largeur 1 / total 4)
    expect(topUs[2]).toBeCloseTo(0.75, 4); // fin p2 (largeur 1+2 / total 4)
    expect(topUs[3]).toBeCloseTo(1, 5);
    // Chaque couture apparie le receveur (pid 0) à un partenaire distinct.
    const partners = newSeams.map((s) => pieceIdOf(s.b)).sort();
    expect(partners).toEqual([2, 3, 4]);
    for (const s of newSeams) expect(pieceIdOf(s.a)).toBe(0);
  });

  it('un seul partenaire : couture simple, aucun cran inséré', () => {
    const doc = makeDoc(rect(2, 0.1), [rect(2)]);
    const r = sewEdgeToMany(doc, { pieceId: 0, from: 0, to: 1 }, [{ pieceId: 2, from: 2, to: 3 }], 64);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.seams).toBe(1);
    expect(r.doc.piece.outline.length).toBe(4); // aucun cran ajouté
  });

  it('refuse un partenaire sur la pièce receveuse', () => {
    const doc = makeDoc(rect(3, 0.1), [rect(1)]);
    const r = sewEdgeToMany(doc, { pieceId: 0, from: 0, to: 1 }, [{ pieceId: 0, from: 2, to: 3 }], 64);
    expect(r.ok).toBe(false);
  });

  it('préserve les coutures existantes', () => {
    const doc: DraftDoc = { ...makeDoc(rect(2, 0.1), [rect(1), rect(1)]),
      seams: [{ a: { pieceId: 2, from: 0, to: 1 }, b: { pieceId: 3, from: 0, to: 1 } }] };
    const r = sewEdgeToMany(doc, { pieceId: 0, from: 0, to: 1 }, [{ pieceId: 2, from: 2, to: 3 }, { pieceId: 3, from: 2, to: 3 }], 64);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.doc.seams ?? []).length).toBe(3); // 1 existante + 2 nouvelles
  });
});
