import { describe, expect, it } from 'vitest';
import {
  measureArmhole,
  fittedSleevePiece,
  generateFittedSleeves,
  fitCapWidthToArmhole,
  blankBaseDraft,
  sanitizeDraft,
  type DraftDoc,
  type DraftPiece,
  type UV,
} from '../src/engine/pattern/Draft';

/** Corps d'essai : épaules, emmanchures ouvertes G/D, ourlet, encolure. */
const bodice = (): DraftPiece => ({
  outline: [
    [0.35, 0], // 0 col G
    [0.06, 0.03], // 1 épaule G
    [0.05, 0.2], // 2 bas d'emmanchure G
    [0.06, 0.95], // 3 ourlet G
    [0.94, 0.95], // 4 ourlet D
    [0.95, 0.2], // 5 bas d'emmanchure D
    [0.94, 0.03], // 6 épaule D
    [0.65, 0], // 7 col D
  ] as UV[],
  darts: [],
  seams: [],
  openEdges: [
    { from: 1, to: 2 }, // emmanchure G
    { from: 3, to: 4 }, // ourlet (central — jamais une emmanchure)
    { from: 5, to: 6 }, // emmanchure D
    { from: 7, to: 0 }, // encolure (centrale)
  ],
  width: 0.6,
  height: 0.7,
  topY: 1.5,
  gap: 0.35,
});

const docOf = (piece: DraftPiece, back?: DraftPiece): DraftDoc => ({
  format: 'toile-draft',
  version: 1,
  gridN: 64,
  piece,
  back,
  manual: true,
});

// Longueur métrique attendue du run d'emmanchure du corps d'essai :
// |M(0.95,0.2) − M(0.94,0.03)| avec M = (u·0.6, v·0.7).
const EXPECTED_ARMHOLE = Math.hypot(0.01 * 0.6, 0.17 * 0.7);

/** Longueur métrique de la bouche (tête) d'une pièce de manche générée :
 * les 7 premiers sommets du contour (coin G, arc, coin D). */
const capLengthOf = (piece: DraftPiece): number => {
  let len = 0;
  for (let i = 1; i <= 6; i++) {
    const a = piece.outline[i - 1]!;
    const b = piece.outline[i]!;
    len += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
  }
  return len;
};

describe('manche adaptée (v160) — mesure d’emmanchure', () => {
  it('mesure les runs ouverts latéraux, ignore ourlet et encolure', () => {
    const b = bodice();
    const right = measureArmhole(b, 'R');
    const left = measureArmhole(b, 'L');
    expect(right).not.toBeNull();
    expect(left).not.toBeNull();
    expect(right!.lengthM).toBeCloseTo(EXPECTED_ARMHOLE, 6);
    expect(left!.lengthM).toBeCloseTo(EXPECTED_ARMHOLE, 6);
    // naissance = le point le plus HAUT du run (v min → monde max)
    expect(right!.topWorldY).toBeCloseTo(1.5 - 0.03 * 0.7, 6);
  });

  it('null sans run ouvert latéral', () => {
    const closed = { ...bodice(), openEdges: [{ from: 3, to: 4 }] };
    expect(measureArmhole(closed, 'R')).toBeNull();
    expect(measureArmhole(closed, 'L')).toBeNull();
    expect(measureArmhole({ ...bodice(), openEdges: [] }, 'R')).toBeNull();
  });
});

describe('manche adaptée (v160) — génération à la cote', () => {
  it('la tête de la pièce générée mesure EXACTEMENT la cible', () => {
    const piece = fittedSleevePiece(0.3, 0.25, 1.4, 'armR');
    expect(capLengthOf(piece)).toBeCloseTo(0.3, 4);
    expect(piece.height).toBe(0.25);
    expect(piece.wrap).toBe('armR');
    expect(piece.placement).toEqual({ role: 'armR', autoAlign: true });
    expect(piece.name).toBe('Manche droite');
  });

  it('génère droite ET gauche sur les emmanchures libres, aux cotes mesurées', () => {
    const res = generateFittedSleeves(docOf(bodice(), bodice()));
    expect(res.ok).toBe(true);
    expect(res.created).toHaveLength(2);
    const wraps = (res.doc!.pieces ?? []).map((p) => p.wrap);
    expect(wraps).toEqual(['armR', 'armL']);
    for (const c of res.created!) {
      expect(c.capM).toBeCloseTo(EXPECTED_ARMHOLE, 6);
      const piece = res.doc!.pieces![c.pieceId - 2]!;
      expect(capLengthOf(piece)).toBeCloseTo(EXPECTED_ARMHOLE, 4);
      expect(piece.topY).toBeCloseTo(1.5 - 0.03 * 0.7 + 0.01, 6);
    }
    // Les deux manches en place → régénérer refuse avec la bonne raison.
    const again = generateFittedSleeves(res.doc!);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/déjà en place/i);
  });

  it('refuse socle vide, modèle intégré et corps sans emmanchure', () => {
    expect(generateFittedSleeves(blankBaseDraft(64)).ok).toBe(false);
    const preset = generateFittedSleeves({
      ...docOf(bodice()),
      preset: 'hoodie',
    } as DraftDoc);
    expect(preset.ok).toBe(false);
    const noArm = generateFittedSleeves(docOf({ ...bodice(), openEdges: [] }));
    expect(noArm.ok).toBe(false);
    expect(noArm.reason).toMatch(/emmanchure/i);
  });

  it('round-trip sanitize : la manche générée garde wrap, rôle et nom', () => {
    const res = generateFittedSleeves(docOf(bodice(), bodice()));
    const clean = sanitizeDraft(JSON.parse(JSON.stringify(res.doc)));
    expect(clean).not.toBeNull();
    const sleeves = (clean!.pieces ?? []).filter((p) => p.wrap === 'armR' || p.wrap === 'armL');
    expect(sleeves).toHaveLength(2);
    expect(sleeves[0]!.placement?.role).toBe('armR');
    expect(sleeves[0]!.name).toBe('Manche droite');
  });
});

describe('manche adaptée (v160) — ajustement d’une pièce dessinée', () => {
  it('la largeur d’une pièce posée « Bras » devient le tour d’emmanchure', () => {
    const drawn: DraftPiece = {
      outline: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as UV[],
      darts: [],
      seams: [],
      openEdges: [],
      width: 0.5,
      height: 0.3,
      topY: 1.45,
      gap: 0.18,
    };
    const fit = fitCapWidthToArmhole(bodice(), bodice(), 'R', drawn);
    expect(fit).not.toBeNull();
    expect(fit!.capM).toBeCloseTo(EXPECTED_ARMHOLE, 6);
    expect(fit!.piece.width).toBeCloseTo(EXPECTED_ARMHOLE, 6);
    expect(fit!.piece.height).toBe(0.3); // la longueur dessinée reste la sienne
  });

  it('null quand le corps n’a pas d’emmanchure ouverte', () => {
    const drawn = { ...bodice(), openEdges: [] };
    expect(fitCapWidthToArmhole({ ...bodice(), openEdges: [] }, null, 'R', drawn)).toBeNull();
  });
});
