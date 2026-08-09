import { describe, expect, it } from 'vitest';
import {
  compileAssembly,
  compileCrossSeams,
  compileDraft,
  compileSurfaceSeams,
  docPieces,
  pieceIdOf,
  sanitizeDraft,
} from '../src/engine/pattern/Draft';
import { combineClothMeshes, generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';
import {
  VESTE_AVATAR_EASE_CM,
  VESTE_LINING_COLOR,
  VESTE_SIZES,
  draftVeste,
  vesteCm,
  vesteFiniCm,
} from '../src/engine/pattern/veste';
import type { BodyMeasure } from '../src/engine/body/measure';

/** Le même corps femme plausible que les tests de la jupe et de la robe. */
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

const xAt = (piece: { outline: [number, number][]; width: number }, index: number): number =>
  (piece.outline[index]![0] - 0.5) * piece.width;

describe('la veste zippée doublée (v196)', () => {
  it('la table grade de 6 en 6 sur le tour fini ; « avatar » = poitrine + aisance blouson', () => {
    let previous = 0;
    for (const size of VESTE_SIZES) {
      expect(vesteCm(size) - previous).toBe(previous === 0 ? vesteCm(size) : 6);
      previous = vesteCm(size);
    }
    expect(vesteFiniCm('avatar', BODY)).toBe(Math.round(85 + VESTE_AVATAR_EASE_CM));
    expect(vesteFiniCm('M', BODY)).toBe(116);
  });

  it('six pièces : deux devants miroir, un dos pleine largeur, trois doublures', () => {
    const doc = draftVeste('M', BODY, REF);
    const pieces = docPieces(doc);
    expect(pieces).toHaveLength(6);
    const [frontL, back, frontR] = [doc.piece, doc.back!, doc.pieces![0]!];
    // Miroir exact devant G ↔ devant D (mêmes index, x opposés, v identiques).
    for (let i = 0; i < frontL.outline.length; i++) {
      expect(xAt(frontR, i)).toBeCloseTo(-xAt(frontL, i), 9);
      expect(frontR.outline[i]![1]).toBeCloseTo(frontL.outline[i]![1], 9);
    }
    // Le dos couvre les deux moitiés : son aisselle D est au x du côté devant D.
    expect(xAt(back, 3)).toBeCloseTo(xAt(frontR, 5), 9);
    expect(xAt(back, 6)).toBeCloseTo(xAt(doc.piece, 5), 9);
    // Toutes les pièces du corps partagent le MÊME cadre physique.
    for (const p of [back, frontR]) {
      expect(p.width).toBeCloseTo(frontL.width, 9);
      expect(p.height).toBeCloseTo(frontL.height, 9);
      expect(p.topY).toBeCloseTo(frontL.topY, 9);
    }
  });

  it('la fermeture est une couture zipper FERMÉE entre les deux milieux devant', () => {
    const doc = draftVeste('M', BODY, REF);
    const zips = doc.seams!.filter((s) => s.kind === 'zipper');
    expect(zips).toHaveLength(1);
    const zip = zips[0]!;
    expect(zip.closed).toBe(true);
    expect([pieceIdOf(zip.a), pieceIdOf(zip.b)].sort()).toEqual([0, 2]);
    // Même longueur physique des deux bords (le zip ne fronce pas).
    const frontL = doc.piece;
    const frontR = doc.pieces![0]!;
    const len = (p: typeof frontL): number =>
      Math.abs(p.outline[7]![1] - p.outline[0]![1]) * p.height;
    expect(len(frontL)).toBeCloseTo(len(frontR), 9);
  });

  it('kimono : les runs cousus devant↔dos ont la même longueur d’arc', () => {
    const doc = draftVeste('L', BODY, REF);
    const pieces = docPieces(doc);
    const runLen = (pid: number, from: number, to: number): number => {
      const p = pieces[pid]!;
      let sum = 0;
      for (let e = from; e < to; e++) {
        const a = p.outline[e % p.outline.length]!;
        const b = p.outline[(e + 1) % p.outline.length]!;
        sum += Math.hypot((a[0] - b[0]) * p.width, (a[1] - b[1]) * p.height);
      }
      return sum;
    };
    // Épaule+haut de manche : devant {2→3} ↔ dos {8→9} (G) et {0→1} (D).
    expect(runLen(0, 2, 3)).toBeCloseTo(runLen(1, 8, 9), 6);
    expect(runLen(2, 2, 3)).toBeCloseTo(runLen(1, 0, 1), 6);
    // Dessous de manche + côté : devant {4→6} ↔ dos {5→7} (G) et {2→4} (D).
    expect(runLen(0, 4, 6)).toBeCloseTo(runLen(1, 5, 7), 6);
    expect(runLen(2, 4, 6)).toBeCloseTo(runLen(1, 2, 4), 6);
  });

  it('trois doublures bordeaux en soie SOUS leurs supports, cousues au pourtour', () => {
    const doc = draftVeste('M', BODY, REF);
    const linings = doc.pieces!.slice(1);
    expect(linings).toHaveLength(3);
    const supports = linings.map((l) => l.placement?.surface?.supportPieceId).sort();
    expect(supports).toEqual([0, 1, 2]);
    for (const l of linings) {
      expect(l.color).toBe(VESTE_LINING_COLOR);
      expect(l.fabricPreset).toBe('Soie');
      expect(l.placement?.role).toBe('pocket');
      expect(l.placement?.surface?.side).toBe('under');
      expect(l.placement?.surface?.stitchedEdges).toEqual([0, 1, 2, 3]);
      // La doublure vit en retrait DANS son support (jamais plus large).
      expect(l.width).toBeLessThan(doc.piece.width / 2);
      expect(l.height).toBeLessThan(doc.piece.height);
    }
  });

  it('le devant droit est UNE feuille (singlePanel) et le flag survit à sanitizeDraft', () => {
    const doc = draftVeste('M', BODY, REF);
    expect(doc.pieces![0]!.singlePanel).toBe(true);
    expect(doc.piece.singlePanel).toBeUndefined(); // la base garde sa paire (le dos)
    const round = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    expect(round.pieces![0]!.singlePanel).toBe(true);
    expect(round.pieces![1]!.fabricPreset).toBe('Soie');
    expect(round.seams!.some((s) => s.kind === 'zipper' && s.closed === true)).toBe(true);
  });

  it('compile : pièces vivantes, coutures de base, coutures croisées, doublures épinglées', () => {
    const doc = draftVeste('M', BODY, REF);
    const n = doc.gridN;
    for (const pid of [0, 1, 2]) {
      const compiled = compileDraft(docPieces(doc)[pid]!, n);
      expect(compiled.openCells.size).toBeGreaterThan(0);
    }
    // Coutures de base (devant G ↔ dos) : épaule + côté gauches.
    expect(compileAssembly(doc, n).length).toBeGreaterThan(30);
    // Coutures croisées du devant droit : épaule D, côté D et le ZIP, marqué.
    const crossClosed = compileCrossSeams(doc, n, [], 2);
    expect(crossClosed.length).toBeGreaterThan(50);
    expect(crossClosed.filter((p) => p.zipper).length).toBeGreaterThan(10);
    // ZIP À CHAUD (v198) : ouvert, les épingles existent TOUJOURS (mêmes
    // paires, toujours marquées) — c'est l'uniform du solveur qui débraye,
    // pas la compilation. L'habillage se fait donc toujours fermé.
    const open = draftVeste('M', BODY, REF);
    open.seams = open.seams!.map((s) => (s.kind === 'zipper' ? { ...s, closed: false } : s));
    const crossOpen = compileCrossSeams(open, n, [], 2);
    expect(crossOpen.length).toBe(crossClosed.length);
    expect(crossOpen.filter((p) => p.zipper).length).toBe(
      crossClosed.filter((p) => p.zipper).length,
    );
    // Chaque doublure a ses épingles de pourtour sur son support.
    for (const pid of [3, 4, 5]) {
      expect(compileSurfaceSeams(doc, n, [], pid).length).toBeGreaterThan(20);
    }
  });

  it('les épingles de zip portent ConstraintKind.ZipperSeam de bout en bout (v198)', () => {
    // Chemin combineClothMeshes (le zip de la veste : devant G ↔ devant D).
    const a = generateSeamedPanels({ resolution: 8, width: 0.4, height: 0.4, gap: 0.3, topY: 1.5 });
    const b = generateSeamedPanels({ resolution: 8, width: 0.4, height: 0.4, gap: 0.3, topY: 1.5 });
    const combined = combineClothMeshes(a, b, [
      { i: 3, j: a.count + 3, zipper: true },
      { i: 4, j: a.count + 4 },
    ]);
    const kinds = (mesh: { constraintData: ArrayBuffer; constraintCount: number }): number[] => {
      const dv = new DataView(mesh.constraintData);
      const out: number[] = [];
      for (let k = 0; k < mesh.constraintCount; k++) out.push(dv.getUint32(k * 16 + 12, true));
      return out;
    };
    expect(kinds(combined).filter((k) => k === ConstraintKind.ZipperSeam)).toHaveLength(1);
    // Chemin generateSeamedPanels (un zip manuel entre panneaux de base).
    const withZip = generateSeamedPanels({
      resolution: 8,
      width: 0.4,
      height: 0.4,
      gap: 0.3,
      topY: 1.5,
      manualAssembly: true,
      assemblySeams: [
        { i: 2, j: 64 + 2, zipper: true },
        { i: 5, j: 64 + 5 },
      ],
    });
    expect(kinds(withZip).filter((k) => k === ConstraintKind.ZipperSeam)).toHaveLength(1);
    // Le coloriage range le zip dans la phase des coutures (rejouée après
    // l'auto-collision) — jamais dans la phase ordinaire.
    const zipEdges = kinds(withZip)
      .map((k, idx) => ({ k, idx }))
      .filter((e) => e.k === ConstraintKind.ZipperSeam);
    expect(zipEdges.length).toBe(1);
  });

  it('la veste tient par les épaules : encolure bien en dedans du corps, cadre gradé', () => {
    for (const size of [...VESTE_SIZES, 'avatar'] as const) {
      const doc = draftVeste(size, BODY, REF);
      const halfNeck = Math.abs(xAt(doc.back!, 0));
      const halfBody = Math.abs(xAt(doc.back!, 3));
      expect(halfNeck).toBeLessThan(0.35 * halfBody);
      expect(doc.piece.topY).toBeCloseTo(1.52 + (BODY.shoulderY - REF.shoulderY), 9);
      expect(doc.preset).toBe('veste');
    }
  });
});
