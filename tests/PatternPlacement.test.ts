import { describe, expect, it } from 'vitest';
import {
  combineClothMeshes,
  generateSeamedPanels,
  type ClothMeshData,
  type CrossSeam,
} from '../src/engine/cloth/ClothMesh';
import {
  applyStagingOffset,
  autoPlaceMeshFromCrossSeams,
  hasStagingOffset,
  movePieceInstanceInStaging,
  movePieceInStaging,
  placeMeshOnSurface,
  placementIssues,
  placementRoleOf,
  resetPieceInstanceStaging,
  stagingOffsetOf,
} from '../src/engine/pattern/PatternPlacement';
import type { DraftDoc, DraftPiece } from '../src/engine/pattern/Draft';
import { rigidlyPlaceGarmentPanels } from '../src/engine/pattern/HoodieRigidPlacement';

const piece = (name: string): DraftPiece => ({
  name,
  outline: [[0, 0], [1, 0], [1, 1], [0, 1]],
  darts: [],
  seams: [],
  openEdges: [],
  width: 0.5,
  height: 0.6,
  topY: 1.5,
  gap: 0.3,
});

const doc = (extra: DraftPiece): DraftDoc => ({
  format: 'toile-draft',
  version: 1,
  gridN: 32,
  piece: piece('devant'),
  back: piece('dos'),
  pieces: [extra],
  manual: true,
  seams: [],
});

const mesh = (points: Array<[number, number, number]>): ClothMeshData => {
  const positions = new Float32Array(points.length * 4);
  points.forEach(([x, y, z], i) => {
    positions[i * 4] = x;
    positions[i * 4 + 1] = y;
    positions[i * 4 + 2] = z;
    positions[i * 4 + 3] = 1;
  });
  return {
    count: points.length,
    positions,
    invMasses: new Float32Array(points.length).fill(1),
  } as ClothMeshData;
};

describe('assistant de placement', () => {
  it('demande un support exact puis au moins une couture pour une applique', () => {
    const extra = piece('empiècement');
    const draft = doc(extra);
    expect(placementIssues(draft)).toMatchObject([
      { pieceId: 2, severity: 'error', code: 'missing-seam' },
    ]);

    extra.placement = { role: 'pocket', autoAlign: true };
    expect(placementIssues(draft)).toMatchObject([
      { pieceId: 2, severity: 'error', code: 'missing-support' },
    ]);

    extra.placement.surface = {
      supportPieceId: 0,
      anchor: [0.5, 0.5],
      stitchedEdges: [],
    };
    expect(placementIssues(draft)).toMatchObject([
      { pieceId: 2, severity: 'error', code: 'missing-seam' },
    ]);

    extra.placement.surface.stitchedEdges = [0, 1, 2];
    expect(placementIssues(draft)).toEqual([]);
  });

  it('reconnaît les anciens placements bras/cou à partir de wrap', () => {
    const sleeve = piece('manche');
    sleeve.wrap = 'armL';
    expect(placementRoleOf(sleeve)).toBe('armL');
    expect(placementIssues(doc(sleeve))).toEqual([]);
  });

  it('aligne rigidement une couture dessinée sur sa couture cible', () => {
    const base = mesh([[2, 3, 0], [2, 4, 0]]);
    const entering = mesh([[0, 0, 0.3], [1, 0, 0.3], [0, 1, 0.3]]);
    const result = autoPlaceMeshFromCrossSeams(
      base,
      entering,
      [{ i: 0, j: 2 }, { i: 1, j: 3 }],
      2,
    );
    expect(result?.pairs).toBe(2);
    expect(result?.rotationRad).toBeCloseTo(Math.PI / 2, 8);
    expect(result?.depthTranslationM).toBeCloseTo(-0.3, 7);
    expect(entering.positions[0]).toBeCloseTo(2, 8);
    expect(entering.positions[1]).toBeCloseTo(3, 8);
    expect(entering.positions[4]).toBeCloseTo(2, 8);
    expect(entering.positions[5]).toBeCloseTo(4, 8);
    expect(entering.positions[2]).toBeCloseTo(0, 6);
    expect(entering.positions[6]).toBeCloseTo(0, 6);
  });

  it('pose une applique juste au-dessus de la surface choisie', () => {
    const base = mesh([[2, 3, 0.4], [2, 4, 0.4]]);
    const entering = mesh([[0, 0, 0.02], [1, 0, 0.02], [0, 1, 0.02]]);
    const result = placeMeshOnSurface(
      base,
      entering,
      [{ i: 0, j: 2 }, { i: 1, j: 3 }],
      2,
      1,
    );
    expect(result?.pairs).toBe(2);
    expect(result?.depthTranslationM).toBeCloseTo(0.38, 7);
    expect(result?.zTranslation).toBeCloseTo(0.004, 7);
    expect(entering.positions[2]).toBeCloseTo(0.404, 7);
    expect(entering.positions[6]).toBeCloseTo(0.404, 7);
  });

  it('déduit automatiquement la destination d’une pièce reliée au devant', () => {
    const extra = piece('empiècement automatique');
    const draft = doc(extra);
    draft.seams = [
      {
        a: { pieceId: 0, from: 0, to: 1 },
        b: { pieceId: 2, from: 2, to: 3 },
      },
    ];

    expect(placementIssues(draft)).toEqual([]);
  });

  it('signale une seule fois un ensemble cousu mais non relié au vêtement', () => {
    const a = piece('empiècement A');
    const b = piece('empiècement B');
    const draft = doc(a);
    draft.pieces = [a, b];
    draft.seams = [
      {
        a: { pieceId: 2, from: 0, to: 1 },
        b: { pieceId: 3, from: 2, to: 3 },
      },
    ];

    expect(placementIssues(draft)).toMatchObject([
      {
        pieceId: 2,
        severity: 'error',
        code: 'unanchored-component',
      },
    ]);
  });

  it('propage l’ancrage dans une chaîne indépendamment de l’ordre des identifiants', () => {
    const lowerId = piece('pièce créée en premier');
    const higherId = piece('pièce reliée au devant');
    const draft = doc(lowerId);
    draft.pieces = [lowerId, higherId];
    draft.seams = [
      {
        a: { pieceId: 0, from: 0, to: 1 },
        b: { pieceId: 3, from: 2, to: 3 },
      },
      {
        a: { pieceId: 3, from: 0, to: 1 },
        b: { pieceId: 2, from: 2, to: 3 },
      },
    ];

    expect(placementIssues(draft)).toEqual([]);
  });

  it('reconstruit en 3D une paire de panneaux éloignée avec des gaps différents', () => {
    const n = 8;
    const panelSize = n * n;
    const base = generateSeamedPanels({
      resolution: n,
      width: 0.7,
      height: 0.75,
      topY: 1.55,
      gap: 0.82,
      shape: 'rect',
    });
    const entering = generateSeamedPanels({
      resolution: n,
      width: 0.7,
      height: 0.4,
      topY: -2.2,
      gap: 0.18,
      shape: 'rect',
    });
    for (let particle = 0; particle < entering.count; particle++) {
      if (entering.invMasses[particle]! <= 0) continue;
      entering.positions[particle * 4] += 3.4;
      entering.positions[particle * 4 + 1] -= 1.7;
      entering.positions[particle * 4 + 2] += 2.8;
    }
    const seams: CrossSeam[] = [];
    for (let u = 0; u < n; u++) {
      seams.push(
        { i: u, j: base.count + (n - 1) * n + u },
        {
          i: panelSize + u,
          j: base.count + panelSize + (n - 1) * n + u,
        },
      );
    }
    const garment = combineClothMeshes(base, entering, seams);
    const report = rigidlyPlaceGarmentPanels(garment, {
      panelSize,
      fixedPanels: [0, 1],
      placementSeams: seams,
      iterations: 40,
      damping: 0.8,
      orientationRegularization: 0.02,
    });

    expect(report.before.rmsM).toBeGreaterThan(3);
    expect(report.after.rmsM).toBeLessThan(0.01);
    expect(report.maximumIntraPanelEdgeRatioDrift).toBeLessThan(1e-5);
    // Both physical faces find their own target depth despite the entering
    // piece having a different gap and an arbitrary initial Z translation.
    const frontZ = garment.positions[(base.count + (n - 1) * n) * 4 + 2]!;
    const backZ = garment.positions[(base.count + panelSize + (n - 1) * n) * 4 + 2]!;
    expect(frontZ).toBeCloseTo(base.positions[2]!, 2);
    expect(backZ).toBeCloseTo(base.positions[panelSize * 4 + 2]!, 2);
  });

  it('résout globalement une chaîne dont la première pièce créée n’est pas encore ancrée', () => {
    const n = 6;
    const panelSize = n * n;
    const makePair = (topY: number) =>
      generateSeamedPanels({
        resolution: n,
        width: 0.6,
        height: 0.3,
        topY,
        gap: 0.7,
        shape: 'rect',
      });
    const base = makePair(1.55);
    const createdFirst = makePair(-1.5);
    const bridgeCreatedLater = makePair(3.8);
    applyStagingOffset(createdFirst, [4.2, -1.1, 2.5]);
    applyStagingOffset(bridgeCreatedLater, [-3.6, 1.7, -2.2]);

    const baseAndFirst = combineClothMeshes(base, createdFirst);
    const firstOffset = base.count;
    const bridgeOffset = baseAndFirst.count;
    const seams: CrossSeam[] = [];
    for (let u = 0; u < n; u++) {
      // Base top ↔ bridge bottom.
      seams.push(
        { i: u, j: bridgeOffset + (n - 1) * n + u },
        {
          i: panelSize + u,
          j: bridgeOffset + panelSize + (n - 1) * n + u,
        },
        // The earlier, initially disconnected piece ↔ bridge top.
        { i: firstOffset + (n - 1) * n + u, j: bridgeOffset + u },
        {
          i: firstOffset + panelSize + (n - 1) * n + u,
          j: bridgeOffset + panelSize + u,
        },
      );
    }
    const garment = combineClothMeshes(baseAndFirst, bridgeCreatedLater, seams);
    const report = rigidlyPlaceGarmentPanels(garment, {
      panelSize,
      fixedPanels: [0, 1],
      placementSeams: seams,
      iterations: 60,
      damping: 0.8,
      orientationRegularization: 0.015,
    });

    expect(report.before.rmsM).toBeGreaterThan(2);
    expect(report.after.rmsM).toBeLessThan(0.015);
    expect(report.maximumIntraPanelEdgeRatioDrift).toBeLessThan(1e-5);
  });

  it('mémorise un déplacement 3D sans toucher à la géométrie du patron', () => {
    const original = piece('poche');
    const moved = movePieceInStaging(original, [3.5, -2, 1.25]);
    const movedAgain = movePieceInStaging(moved, [-0.5, 1, 0.75]);

    expect(stagingOffsetOf(original)).toEqual([0, 0, 0]);
    expect(stagingOffsetOf(movedAgain)).toEqual([3, -1, 2]);
    expect(movedAgain.outline).toEqual(original.outline);
    expect(movedAgain.width).toBe(original.width);
    expect(movedAgain.height).toBe(original.height);
    expect(movedAgain.topY).toBe(original.topY);
  });

  it('déplace deux exemplaires du même patron indépendamment', () => {
    const original = { ...piece('devant ×2'), cut: 2 };
    const leftMoved = movePieceInstanceInStaging(original, 0, [-0.4, 0.2, 0]);
    const bothMoved = movePieceInstanceInStaging(leftMoved, 1, [0.6, -0.1, 0.3]);

    expect(stagingOffsetOf(bothMoved, 0)).toEqual([-0.4, 0.2, 0]);
    expect(stagingOffsetOf(bothMoved, 1)).toEqual([0.6, -0.1, 0.3]);
    expect(bothMoved.outline).toEqual(original.outline);
    expect(hasStagingOffset(bothMoved)).toBe(true);

    const rightReset = resetPieceInstanceStaging(bothMoved, 1);
    expect(stagingOffsetOf(rightReset, 0)).toEqual([-0.4, 0.2, 0]);
    expect(stagingOffsetOf(rightReset, 1)).toEqual([0, 0, 0]);
  });

  it('applique le décalage seulement à la plage de prévisualisation demandée', () => {
    const preview = mesh([[0, 0, 0], [1, 1, 1], [2, 2, 2]]);
    applyStagingOffset(preview, [4, -2, 0.5], 1, 1);

    expect(Array.from(preview.positions.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(preview.positions.slice(4, 7))).toEqual([5, -1, 1.5]);
    expect(Array.from(preview.positions.slice(8, 11))).toEqual([2, 2, 2]);
  });
});
