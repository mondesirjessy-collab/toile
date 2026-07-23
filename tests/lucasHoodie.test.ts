import { describe, expect, it, vi } from 'vitest';
import type { BodyMeasure } from '../src/engine/body/measure';
import {
  pairOutlineRuns,
  pieceIdOf,
  sanitizeDraft,
  type DraftPiece,
  type EdgeRun,
} from '../src/engine/pattern/Draft';
import { buildLucasHoodieMesh } from '../src/engine/pattern/LucasHoodieAssembly';
import {
  hoodieRunLengthM,
  lucasHoodie,
  lucasHoodieAdjusted,
  lucasHoodieFit,
  lucasHoodNecklineRuns,
  lucasHoodieRuns,
  lucasHoodieSizeLabel,
  lucasHoodieSourceSize,
  lucasZipperLengthM,
  LUCAS_HOODIE_SIZES,
} from '../src/engine/pattern/lucasHoodie';
import {
  LUCAS_HOODIE_DATA,
  LUCAS_HOODIE_LANDMARKS,
} from '../src/engine/pattern/lucasHoodieData';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';

const body: BodyMeasure = {
  height: 1.78,
  neckY: 1.51,
  shoulderY: 1.43,
  shoulderHalfW: 0.22,
  chest: { y: 1.28, halfW: 0.24, halfD: 0.145, circ: 1.0 },
  waist: { y: 1.05, halfW: 0.205, halfD: 0.13, circ: 0.86 },
  hip: { y: 0.91, halfW: 0.255, halfD: 0.16, circ: 1.02 },
  thigh: { y: 0.72, halfW: 0.105, halfD: 0.105, circ: 0.66 },
};

const pieces = (size: (typeof LUCAS_HOODIE_SIZES)[number]): DraftPiece[] => {
  const doc = lucasHoodie(size, body);
  return [doc.piece, doc.back!, ...(doc.pieces ?? [])];
};

const physicalBoundsCm = (
  piece: { outline: readonly [number, number][]; width: number; height: number },
): [number, number] => {
  const us = piece.outline.map(([u]) => u);
  const vs = piece.outline.map(([, v]) => v);
  return [
    (Math.max(...us) - Math.min(...us)) * piece.width * 100,
    (Math.max(...vs) - Math.min(...vs)) * piece.height * 100,
  ];
};

const runEdges = (run: EdgeRun, count: number): number[] => {
  const edges: number[] = [];
  for (
    let edge = ((run.from % count) + count) % count;
    edge !== ((run.to % count) + count) % count && edges.length < count;
    edge = (edge + 1) % count
  ) {
    edges.push(edge);
  }
  return edges;
};

const rasterRun = (piece: DraftPiece, run: EdgeRun, n: number): number[] =>
  pairOutlineRuns(piece, piece, run, run, n, false)?.a ?? [];

const maxGridJump = (cells: readonly number[], n: number): number =>
  cells.slice(1).reduce((maximum, cell, index) => {
    const previous = cells[index]!;
    return Math.max(
      maximum,
      Math.abs((cell % n) - (previous % n)),
      Math.abs(Math.floor(cell / n) - Math.floor(previous / n)),
    );
  }, 0);

const expectPartition = (
  piece: DraftPiece,
  runs: readonly EdgeRun[],
): void => {
  const counts = new Uint8Array(piece.outline.length);
  for (const run of runs) {
    for (const edge of runEdges(run, piece.outline.length)) counts[edge]++;
  }
  expect([...counts]).toEqual(
    Array.from({ length: piece.outline.length }, () => 1),
  );
};

const regularSeamSpans = (mesh: {
  constraintData: ArrayBuffer;
  constraintCount: number;
  positions: Float32Array;
}): number[] => {
  const view = new DataView(mesh.constraintData);
  const spans: number[] = [];
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * 16;
    if (view.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
    const a = view.getUint32(offset, true);
    const b = view.getUint32(offset + 4, true);
    spans.push(
      Math.hypot(
        mesh.positions[a * 4]! - mesh.positions[b * 4]!,
        mesh.positions[a * 4 + 1]! - mesh.positions[b * 4 + 1]!,
        mesh.positions[a * 4 + 2]! - mesh.positions[b * 4 + 2]!,
      ),
    );
  }
  return spans;
};

const regularSeamPanelGroups = (
  mesh: {
    constraintData: ArrayBuffer;
    constraintCount: number;
  },
  n: number,
): Map<string, number> => {
  const panelSize = n * n;
  const view = new DataView(mesh.constraintData);
  const groups = new Map<string, number>();
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * 16;
    if (view.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
    const panelA = Math.floor(view.getUint32(offset, true) / panelSize);
    const panelB = Math.floor(view.getUint32(offset + 4, true) / panelSize);
    const key = `${Math.min(panelA, panelB)}-${Math.max(panelA, panelB)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
};

const regularSeamsInPanelGroup = (
  mesh: {
    constraintData: ArrayBuffer;
    constraintCount: number;
    positions: Float32Array;
  },
  n: number,
  group: string,
): Array<{ a: number; b: number; span: number }> => {
  const panelSize = n * n;
  const view = new DataView(mesh.constraintData);
  const seams: Array<{ a: number; b: number; span: number }> = [];
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * 16;
    if (view.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
    const a = view.getUint32(offset, true);
    const b = view.getUint32(offset + 4, true);
    const panelA = Math.floor(a / panelSize);
    const panelB = Math.floor(b / panelSize);
    const key = `${Math.min(panelA, panelB)}-${Math.max(panelA, panelB)}`;
    if (key !== group) continue;
    seams.push({
      a,
      b,
      span: Math.hypot(
        mesh.positions[a * 4]! - mesh.positions[b * 4]!,
        mesh.positions[a * 4 + 1]! - mesh.positions[b * 4 + 1]!,
        mesh.positions[a * 4 + 2]! - mesh.positions[b * 4 + 2]!,
      ),
    });
  }
  return seams;
};

const liveBounds = (
  mesh: { positions: Float32Array; invMasses: Float32Array },
  ranges: readonly { first: number; count: number }[],
): { minimum: [number, number, number]; maximum: [number, number, number] } => {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const range of ranges) {
    for (
      let particle = range.first;
      particle < range.first + range.count;
      particle++
    ) {
      if (mesh.invMasses[particle]! <= 0) continue;
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[particle * 4 + axis]!;
        minimum[axis] = Math.min(minimum[axis]!, value);
        maximum[axis] = Math.max(maximum[axis]!, value);
      }
    }
  }
  return { minimum, maximum };
};

const meshGeometryQuality = (mesh: {
  constraintData: ArrayBuffer;
  constraintCount: number;
  positions: Float32Array;
  triangleIndices: Uint32Array;
}, panelSize?: number): {
  collapsedTriangles: number;
  severelyCompressedEdges: number;
  minimumArea2: number;
  minimumEdgeRatio: number;
  maximumEdgeRatio: number;
  minimumEdge: [number, number];
  maximumEdge: [number, number];
} => {
  let collapsedTriangles = 0;
  let minimumArea2 = Infinity;
  for (let index = 0; index < mesh.triangleIndices.length; index += 3) {
    const particleA = mesh.triangleIndices[index]!;
    const particleB = mesh.triangleIndices[index + 1]!;
    const particleC = mesh.triangleIndices[index + 2]!;
    // Render-only seam ribbons span two independently cut panels. In the
    // canonical pre-dressed pose their sewn rims may coincide exactly, so a
    // zero-area ribbon is expected until physics gives the shell thickness.
    // Geometry quality here protects the authored cloth panels themselves.
    if (
      panelSize &&
      (Math.floor(particleA / panelSize) !== Math.floor(particleB / panelSize) ||
        Math.floor(particleA / panelSize) !== Math.floor(particleC / panelSize))
    ) {
      continue;
    }
    const a = particleA * 4;
    const b = particleB * 4;
    const c = particleC * 4;
    const ab = [
      mesh.positions[b]! - mesh.positions[a]!,
      mesh.positions[b + 1]! - mesh.positions[a + 1]!,
      mesh.positions[b + 2]! - mesh.positions[a + 2]!,
    ];
    const ac = [
      mesh.positions[c]! - mesh.positions[a]!,
      mesh.positions[c + 1]! - mesh.positions[a + 1]!,
      mesh.positions[c + 2]! - mesh.positions[a + 2]!,
    ];
    const area2 = Math.hypot(
      ab[1]! * ac[2]! - ab[2]! * ac[1]!,
      ab[2]! * ac[0]! - ab[0]! * ac[2]!,
      ab[0]! * ac[1]! - ab[1]! * ac[0]!,
    );
    minimumArea2 = Math.min(minimumArea2, area2);
    if (area2 <= 1e-12) collapsedTriangles++;
  }

  const view = new DataView(mesh.constraintData);
  let severelyCompressedEdges = 0;
  let minimumEdgeRatio = Infinity;
  let maximumEdgeRatio = 0;
  let minimumEdge: [number, number] = [0, 0];
  let maximumEdge: [number, number] = [0, 0];
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * 16;
    const kind = view.getUint32(offset + 12, true);
    if (kind === ConstraintKind.Seam || kind === ConstraintKind.SurfaceSeam) {
      continue;
    }
    const rest = view.getFloat32(offset + 8, true);
    if (rest <= 1e-9) continue;
    const particleA = view.getUint32(offset, true);
    const particleB = view.getUint32(offset + 4, true);
    const a = particleA * 4;
    const b = particleB * 4;
    const ratio =
      Math.hypot(
        mesh.positions[a]! - mesh.positions[b]!,
        mesh.positions[a + 1]! - mesh.positions[b + 1]!,
        mesh.positions[a + 2]! - mesh.positions[b + 2]!,
      ) / rest;
    if (ratio < minimumEdgeRatio) {
      minimumEdgeRatio = ratio;
      minimumEdge = [particleA, particleB];
    }
    if (ratio > maximumEdgeRatio) {
      maximumEdgeRatio = ratio;
      maximumEdge = [particleA, particleB];
    }
    if (ratio < 0.05) severelyCompressedEdges++;
  }
  return {
    collapsedTriangles,
    severelyCompressedEdges,
    minimumArea2,
    minimumEdgeRatio,
    maximumEdgeRatio,
    minimumEdge,
    maximumEdge,
  };
};

describe('Lucas Hoodie A0 exact', () => {
  it('expose les sept tailles et leurs mensurations fournies', () => {
    expect(LUCAS_HOODIE_SIZES).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      'XXL',
      'XXXL',
    ]);

    expect(LUCAS_HOODIE_DATA.XS).toMatchObject({
      bodyChestCm: 92,
      bodyWaistCm: 78,
      bodyHipCm: 94,
      finishedLengthCm: 70.1,
      finishedSleeveCm: 88.9,
      finishedChestCm: 119.9,
    });
    expect(LUCAS_HOODIE_DATA.XXXL).toMatchObject({
      bodyChestCm: 121,
      bodyWaistCm: 112,
      bodyHipCm: 123,
      finishedLengthCm: 75.9,
      finishedSleeveCm: 94.5,
      finishedChestCm: 150.1,
    });
    expect(lucasHoodieSizeLabel('M')).toContain('poitrine corps 100 cm');
    expect(lucasHoodieSizeLabel('M')).toContain('vêtement 130,0 cm');
  });

  it('ajuste volume et stature au mannequin sans altérer les courbes A0', () => {
    const referenceFit = lucasHoodieFit(body);
    expect(referenceFit).toMatchObject({
      sourceSize: 'M',
      scaleX: 1,
      scaleY: 1,
      targetFinishedChestCm: 130,
      targetFinishedLengthCm: 71.9,
    });

    const smallBody: BodyMeasure = {
      ...body,
      height: 1.65,
      neckY: 1.42,
      shoulderY: 1.34,
      chest: { ...body.chest, y: 1.2, circ: 0.738 },
      waist: { ...body.waist, y: 0.98, circ: 0.596 },
      hip: { ...body.hip, y: 0.84, circ: 0.75 },
    };
    const fit = lucasHoodieFit(smallBody);
    expect(fit.sourceSize).toBe('XS');
    expect(fit.bodyChestCm).toBeCloseTo(73.8, 5);
    const expectedFinishedChest = 73.8 * (119.9 / 92);
    expect(fit.targetFinishedChestCm).toBeCloseTo(expectedFinishedChest, 5);
    expect(fit.scaleX).toBeCloseTo(
      (expectedFinishedChest + 4) / (119.9 + 4),
      5,
    );
    expect(fit.scaleY).toBeCloseTo(1.65 / 1.78, 5);

    const adjusted = lucasHoodieAdjusted(smallBody);
    const source = lucasHoodie('XS', smallBody);
    expect(adjusted.presetSize).toBe('fit-XS');
    expect(lucasHoodieSourceSize(adjusted)).toBe('XS');
    expect(sanitizeDraft(JSON.parse(JSON.stringify(adjusted))).presetSize).toBe(
      'fit-XS',
    );
    expect(adjusted.piece.outline).toEqual(source.piece.outline);
    expect(adjusted.piece.width / source.piece.width).toBeCloseTo(
      fit.scaleX,
      8,
    );
    expect(adjusted.piece.height / source.piece.height).toBeCloseTo(
      fit.scaleY,
      8,
    );
    const runs = lucasHoodieRuns(adjusted);
    expect(runs.front.armhole.to).toBe(
      LUCAS_HOODIE_LANDMARKS.XS.frontArmholeEnd,
    );
    expect(runs.sleeve.capTop).toBe(
      LUCAS_HOODIE_LANDMARKS.XS.sleeveCapTop,
    );
  });

  it('conserve les sept pièces, quantités de coupe et lignes au pli à chaque taille', () => {
    for (const size of LUCAS_HOODIE_SIZES) {
      const doc = lucasHoodie(size, body);
      const all = [doc.piece, doc.back!, ...(doc.pieces ?? [])];

      expect(doc.preset).toBe('lucas-hoodie');
      expect(doc.presetSize).toBe(size);
      expect(all).toHaveLength(7);
      expect(all.map((piece) => piece.cut)).toEqual([2, 1, 2, 2, 2, 2, 1]);
      expect(all.map((piece) => piece.onFold === true)).toEqual([
        false,
        true,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(all.map((piece) => piece.name)).toEqual([
        'Devant ×2',
        'Dos au pli ×1',
        'Manche ×2',
        'Capuche ×2',
        'Poche ×2',
        'Poignet bord-côte ×2',
        'Ceinture bord-côte au pli ×1',
      ]);
      expect(all.every((piece) => piece.fabricPreset === 'Maille')).toBe(true);
      expect(all.every((piece) => piece.outline.length >= 5)).toBe(true);
      for (const piece of all) {
        for (const point of piece.outline) {
          expect(point.every(Number.isFinite)).toBe(true);
          expect(point[0]).toBeGreaterThanOrEqual(0);
          expect(point[0]).toBeLessThanOrEqual(1);
          expect(point[1]).toBeGreaterThanOrEqual(0);
          expect(point[1]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('garde les dimensions physiques du tracé A0 à l’échelle réelle', () => {
    const medium = LUCAS_HOODIE_DATA.S;
    const expected = {
      front: [32.24, 71.84],
      back: [32.34, 70.06],
      sleeve: [53.65, 65.21],
      hood: [43.72, 34.77],
      pocket: [27.07, 29.32],
      cuff: [31.16, 16],
      waistband: [51.09, 16],
    } as const;

    for (const [name, dimensions] of Object.entries(expected)) {
      const piece = medium.pieces[name as keyof typeof medium.pieces];
      expect(piece.cutWidthCm).toBeCloseTo(dimensions[0], 2);
      expect(piece.cutHeightCm).toBeCloseTo(dimensions[1], 2);
      const [widthCm, heightCm] = physicalBoundsCm(piece);
      expect(widthCm).toBeCloseTo(piece.cutWidthCm, 1);
      expect(heightCm).toBeCloseTo(piece.cutHeightCm, 1);
    }

    const frontWidths = LUCAS_HOODIE_SIZES.map(
      (size) => LUCAS_HOODIE_DATA[size].pieces.front.cutWidthCm,
    );
    for (let index = 1; index < frontWidths.length; index++) {
      expect(frontWidths[index]).toBeGreaterThan(frontWidths[index - 1]!);
    }
  });

  it('utilise les repères de couture exacts et des longueurs compatibles sur les sept tailles', () => {
    expect(
      LUCAS_HOODIE_SIZES.map(
        (size) => LUCAS_HOODIE_LANDMARKS[size].frontArmholeEnd,
      ),
    ).toEqual([42, 42, 44, 46, 45, 46, 49]);
    expect(
      LUCAS_HOODIE_SIZES.map(
        (size) => LUCAS_HOODIE_LANDMARKS[size].sleeveCapTop,
      ),
    ).toEqual([31, 31, 32, 32, 33, 32, 32]);

    for (const size of LUCAS_HOODIE_SIZES) {
      const doc = lucasHoodie(size, body);
      const runs = lucasHoodieRuns(doc);
      const sleeve = doc.pieces![0]!;
      const hood = doc.pieces![1]!;
      const cuff = doc.pieces![3]!;
      const landmarks = LUCAS_HOODIE_LANDMARKS[size];

      expect(runs.front.armhole.to).toBe(landmarks.frontArmholeEnd);
      expect(runs.back.armhole.from).toBe(landmarks.backArmholeStart);
      expect(runs.sleeve.cap.to).toBe(landmarks.sleeveCapEnd);
      expect(runs.sleeve.capB.to).toBe(landmarks.sleeveCapEnd);
      expect(runs.sleeve.capTop).toBe(landmarks.sleeveCapTop);
      expect(runs.hood.neckline).toEqual({
        from: landmarks.hoodCrownFront,
        to: landmarks.hoodCenterBackNeck,
      });
      const frontSleeve = doc.seams?.find(
        (candidate) =>
          pieceIdOf(candidate.a) === 0 && pieceIdOf(candidate.b) === 2 &&
          candidate.a.from === runs.front.armhole.from &&
          candidate.a.to === runs.front.armhole.to,
      );
      const backSleeve = doc.seams?.find(
        (candidate) =>
          pieceIdOf(candidate.a) === 1 && pieceIdOf(candidate.b) === 2 &&
          candidate.a.from === runs.back.armhole.from &&
          candidate.a.to === runs.back.armhole.to,
      );
      expect(frontSleeve?.b).toMatchObject(runs.sleeve.capB);
      expect(backSleeve?.b).toMatchObject(runs.sleeve.capA);

      expectPartition(doc.piece, [
        runs.front.hem,
        runs.front.side,
        runs.front.armhole,
        runs.front.shoulder,
        runs.front.neckline,
        runs.front.centerFront,
      ]);
      expectPartition(doc.back!, [
        runs.back.armhole,
        runs.back.side,
        runs.back.hem,
        runs.back.fold,
        runs.back.neckline,
        runs.back.shoulder,
      ]);
      expectPartition(sleeve, [
        runs.sleeve.underarmA,
        runs.sleeve.cuff,
        runs.sleeve.underarmB,
        runs.sleeve.cap,
      ]);
      expectPartition(hood, [
        runs.hood.neckline,
        runs.hood.center,
        runs.hood.face,
      ]);

      const frontShoulder = hoodieRunLengthM(
        doc.piece,
        runs.front.shoulder,
      );
      const backShoulder = hoodieRunLengthM(
        doc.back!,
        runs.back.shoulder,
      );
      expect(frontShoulder / backShoulder).toBeGreaterThan(0.93);
      expect(frontShoulder / backShoulder).toBeLessThan(0.98);

      const armscye =
        hoodieRunLengthM(doc.piece, runs.front.armhole) +
        hoodieRunLengthM(doc.back!, runs.back.armhole);
      const cap = hoodieRunLengthM(sleeve, runs.sleeve.cap);
      expect(armscye / cap).toBeGreaterThan(1.01);
      expect(armscye / cap).toBeLessThan(1.03);
      expect(
        hoodieRunLengthM(sleeve, runs.sleeve.capA) +
          hoodieRunLengthM(sleeve, runs.sleeve.capB),
      ).toBeCloseTo(cap, 8);

      const underarmA = hoodieRunLengthM(
        sleeve,
        runs.sleeve.underarmA,
      );
      const underarmB = hoodieRunLengthM(
        sleeve,
        runs.sleeve.underarmB,
      );
      expect(underarmA / underarmB).toBeGreaterThan(1);
      expect(underarmA / underarmB).toBeLessThan(1.01);

      const bodyNeck =
        hoodieRunLengthM(doc.piece, runs.front.neckline) +
        hoodieRunLengthM(doc.back!, runs.back.neckline);
      const hoodNeck = hoodieRunLengthM(hood, runs.hood.neckline);
      expect(hoodNeck / bodyNeck).toBeGreaterThan(1.05);
      expect(hoodNeck / bodyNeck).toBeLessThan(1.1);

      for (const end of runs.cuffEnds) {
        expect(hoodieRunLengthM(cuff, end)).toBeGreaterThan(0.159);
        expect(hoodieRunLengthM(cuff, end)).toBeLessThan(0.161);
      }

      const pocket = doc.pieces![2]!;
      const stitchedKeys = runs.pocket.stitchedEdges.map((edge) => {
        const a = pocket.outline[edge]!;
        const b = pocket.outline[(edge + 1) % pocket.outline.length]!;
        const pa = `${a[0].toFixed(6)},${a[1].toFixed(6)}`;
        const pb = `${b[0].toFixed(6)},${b[1].toFixed(6)}`;
        return pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
      });
      expect(new Set(stitchedKeys).size).toBe(stitchedKeys.length);
    }
  });

  it('partage les particules aux jonctions et garde les courbes dans leur ordre à 32/64/128', () => {
    const doc = lucasHoodie('S', body);
    const runs = lucasHoodieRuns(doc);
    const sleeve = doc.pieces![0]!;
    const hood = doc.pieces![1]!;
    const partitions: Array<{
      piece: DraftPiece;
      runs: EdgeRun[];
    }> = [
      {
        piece: doc.piece,
        runs: [
          runs.front.hem,
          runs.front.side,
          runs.front.armhole,
          runs.front.shoulder,
          runs.front.neckline,
          runs.front.centerFront,
        ],
      },
      {
        piece: doc.back!,
        runs: [
          runs.back.armhole,
          runs.back.side,
          runs.back.hem,
          runs.back.fold,
          runs.back.neckline,
          runs.back.shoulder,
        ],
      },
      {
        piece: sleeve,
        runs: [
          runs.sleeve.underarmA,
          runs.sleeve.cuff,
          runs.sleeve.underarmB,
          runs.sleeve.cap,
        ],
      },
      {
        piece: hood,
        runs: [runs.hood.neckline, runs.hood.center, runs.hood.face],
      },
    ];

    for (const n of [32, 64, 128]) {
      for (const partition of partitions) {
        const cells = partition.runs.map((run) =>
          rasterRun(partition.piece, run, n),
        );
        for (let index = 0; index < cells.length; index++) {
          const current = cells[index]!;
          const following = cells[(index + 1) % cells.length]!;
          expect(current.length).toBeGreaterThan(1);
          expect(current.at(-1)).toBe(following[0]);
          expect(
            maxGridJump(current, n),
            `${partition.piece.name ?? 'pièce'} n=${n} run=${JSON.stringify(partition.runs[index])}`,
          ).toBeLessThanOrEqual(2);
        }
      }
    }
  }, 20_000);

  it('scinde l’encolure de capuche une seule fois entre devant et dos', () => {
    for (const size of LUCAS_HOODIE_SIZES) {
      const doc = lucasHoodie(size, body);
      const runs = lucasHoodieRuns(doc);
      const split = lucasHoodNecklineRuns(doc, runs);
      expect(split.front.to).toBe(split.back.from);

      const attachments = (doc.seams ?? []).filter((seam) => {
        const a = pieceIdOf(seam.a);
        const b = pieceIdOf(seam.b);
        return (a === 3 && b <= 1) || (b === 3 && a <= 1);
      });
      expect(attachments).toHaveLength(2);
      const counts = new Map<number, number>();
      for (const seam of attachments) {
        const hoodRun = pieceIdOf(seam.a) === 3 ? seam.a : seam.b;
        for (const edge of runEdges(hoodRun, doc.pieces![1]!.outline.length)) {
          counts.set(edge, (counts.get(edge) ?? 0) + 1);
        }
      }
      const expected = runEdges(
        runs.hood.neckline,
        doc.pieces![1]!.outline.length,
      );
      expect([...counts.keys()].sort((a, b) => a - b)).toEqual(
        [...expected].sort((a, b) => a - b),
      );
      expect([...counts.values()].every((count) => count === 1)).toBe(true);
    }
  });

  it('décrit une fermeture séparable fermée sur les deux milieux devant', () => {
    for (const size of LUCAS_HOODIE_SIZES) {
      const doc = lucasHoodie(size, body);
      const zipper = doc.seams?.find((seam) => seam.kind === 'zipper');
      const center = lucasHoodieRuns(doc).front.centerFront;

      expect(zipper).toBeDefined();
      expect(zipper).toMatchObject({
        a: { pieceId: 0, from: center.from, to: center.to },
        b: { pieceId: 0, from: center.from, to: center.to },
        kind: 'zipper',
        closed: true,
      });
      expect(
        doc.seams?.some(
          (seam) => seam.a.pieceId === 4 || seam.b.pieceId === 4,
        ),
      ).toBe(false);
    }
  });

  it('calcule une longueur de zip physique croissante et cohérente avec le devant', () => {
    const lengths = LUCAS_HOODIE_SIZES.map((size) =>
      lucasZipperLengthM(lucasHoodie(size, body)),
    );

    expect(lengths[0]).toBeGreaterThan(0.65);
    expect(lengths.at(-1)).toBeLessThan(0.9);
    for (let index = 1; index < lengths.length; index++) {
      expect(lengths[index]).toBeGreaterThan(lengths[index - 1]!);
    }
  });

  it('survit à un export/import sans perdre le patron, les plis ni le zip', () => {
    for (const size of LUCAS_HOODIE_SIZES) {
      const source = lucasHoodie(size, body);
      const roundTrip = sanitizeDraft(JSON.parse(JSON.stringify(source)));
      const sourcePieces = pieces(size);
      const roundPieces = [
        roundTrip.piece,
        roundTrip.back!,
        ...(roundTrip.pieces ?? []),
      ];

      expect(roundTrip.preset).toBe('lucas-hoodie');
      expect(roundTrip.presetSize).toBe(size);
      expect(roundPieces).toHaveLength(7);
      expect(roundPieces.map((piece) => piece.outline.length)).toEqual(
        sourcePieces.map((piece) => piece.outline.length),
      );
      expect(roundTrip.back?.onFold).toBe(true);
      expect(roundTrip.pieces?.[4]?.onFold).toBe(true);
      expect(roundTrip.seams?.find((seam) => seam.kind === 'zipper')).toMatchObject({
        kind: 'zipper',
        closed: true,
      });
      expect(roundTrip.pieces?.[2]?.placement?.surface).toMatchObject({
        supportPieceId: 0,
      });
    }
  });

  it('construit les instances physiques attendues avec des positions finies', () => {
    const n = 16;
    const { mesh, ranges } = buildLucasHoodieMesh(
      lucasHoodie('M', body),
      n,
      body,
    );

    expect(mesh.count).toBeGreaterThan(0);
    expect(mesh.positions).toHaveLength(mesh.count * 4);
    expect(mesh.invMasses).toHaveLength(mesh.count);
    expect(mesh.triangleIndices.length).toBeGreaterThan(0);
    expect(mesh.constraintCount).toBeGreaterThan(0);
    expect(mesh.seamCount).toBeGreaterThan(0);
    expect(mesh.surfaceContactCount).toBeGreaterThan(0);
    expect(mesh.anchorReleaseSeconds).toBe(2.5);
    expect(mesh.seamDressingSeconds).toBe(2.5);
    expect([...mesh.positions].every(Number.isFinite)).toBe(true);
    expect([...mesh.invMasses].every((mass) => Number.isFinite(mass) && mass >= 0)).toBe(
      true,
    );
    expect([...mesh.triangleIndices].every((index) => index < mesh.count)).toBe(true);
    const seamSpans = regularSeamSpans(mesh);
    expect(seamSpans.length).toBeGreaterThan(0);
    // The panels are moved rigidly near their partners. The solver then closes
    // the remaining sewing distance progressively, without crushing the first
    // row of triangles as an exact per-vertex pre-closure would do.
    expect(Math.max(...seamSpans)).toBeLessThan(0.32);

    expect(
      ranges
        .filter((range) => range.pieceId === 0)
        .map((range) => range.instance),
    ).toEqual([0, 1]);
    expect(ranges.filter((range) => range.pieceId === 1)).toHaveLength(1);
    expect(ranges.filter((range) => range.pieceId === 2)).toHaveLength(2);
    expect(ranges.filter((range) => range.pieceId === 3)).toHaveLength(2);
    expect(ranges.filter((range) => range.pieceId === 4)).toHaveLength(2);
    expect(ranges.filter((range) => range.pieceId === 5)).toHaveLength(2);
    const waistbandRanges = ranges.filter((range) => range.pieceId === 6);
    expect(waistbandRanges).toHaveLength(1);
    expect(waistbandRanges.map((range) => range.instance)).toEqual([0]);
    for (const range of ranges) {
      expect(range.count).toBe(n * n);
      expect(range.first).toBeGreaterThanOrEqual(0);
      expect(range.first + range.count).toBeLessThanOrEqual(mesh.count);
    }
  });

  it('oriente la tête de manche au-dessus du bras et la couture dessous en T-pose', () => {
    const n = 64;
    const tPoseBody: BodyMeasure = {
      ...body,
      shoulderY: 1.3834,
      arm: { y: 1.3479, z: -0.0957, rootX: 0.185 },
    };
    const doc = lucasHoodie('M', tPoseBody);
    const sleeve = doc.pieces![0]!;
    const runs = lucasHoodieRuns(doc).sleeve;
    const capA = rasterRun(sleeve, runs.capA, n);
    const capB = rasterRun(sleeve, runs.capB, n);
    const capTop = capA.at(-1);
    const underarmEnds = [capA[0], capB.at(-1)];
    expect(capTop).toBeDefined();
    expect(underarmEnds.every((cell) => cell !== undefined)).toBe(true);

    const { mesh, ranges } = buildLucasHoodieMesh(doc, n, tPoseBody);
    const metrics: Array<{ lift: number; meanX: number }> = [];
    for (const range of ranges.filter((candidate) => candidate.pieceId === 2)) {
      const world = (local: number): [number, number, number] => [
        mesh.positions[(range.first + local) * 4]!,
        mesh.positions[(range.first + local) * 4 + 1]!,
        mesh.positions[(range.first + local) * 4 + 2]!,
      ];
      const underarmY =
        underarmEnds.reduce(
          (sum, cell) => sum + world(cell!)[1],
          0,
        ) / underarmEnds.length;
      const capTopY = world(capTop!)[1];
      const lift = capTopY - underarmY;
      const shaftRow = Math.round(0.5 * (n - 1));
      const shaft = Array.from({ length: n }, (_unused, column) =>
        shaftRow * n + column,
      ).filter((local) => mesh.invMasses[range.first + local]! > 0);
      expect(shaft.length).toBeGreaterThan(n / 2);
      const shaftMean = [0, 1, 2].map(
        (axis) =>
          shaft.reduce((sum, local) => sum + world(local)[axis]!, 0) /
          shaft.length,
      );
      const shaftBounds = [1, 2].map((axis) => [
        Math.min(...shaft.map((local) => world(local)[axis]!)),
        Math.max(...shaft.map((local) => world(local)[axis]!)),
      ]);
      const capAMeanZ =
        capA.reduce((sum, local) => sum + world(local)[2], 0) / capA.length;
      const capBMeanZ =
        capB.reduce((sum, local) => sum + world(local)[2], 0) / capB.length;
      const liveRows = Array.from({ length: n }, (_unused, row) => row).filter(
        (row) =>
          Array.from({ length: n }, (_unused, column) => row * n + column).some(
            (local) => mesh.invMasses[range.first + local]! > 0,
          ),
      );
      const wristRow = liveRows.at(-1)!;
      const wrist = Array.from({ length: n }, (_unused, column) =>
        wristRow * n + column,
      ).filter((local) => mesh.invMasses[range.first + local]! > 0);
      const wristA = world(wrist[0]!);
      const wristB = world(wrist.at(-1)!);
      const wristGap = Math.hypot(
        wristA[0] - wristB[0],
        wristA[1] - wristB[1],
        wristA[2] - wristB[2],
      );

      metrics.push({ lift, meanX: shaftMean[0]! });
      expect(
        lift,
        `manche ${range.instance}: la tête doit passer au-dessus du bras`,
      ).toBeGreaterThan(0.06);
      expect(capTopY).toBeGreaterThan(tPoseBody.arm!.y + 0.015);
      expect(underarmY).toBeLessThan(tPoseBody.arm!.y - 0.1);
      expect(capBMeanZ - capAMeanZ).toBeGreaterThan(0.05);
      expect(Math.abs(shaftMean[1]! - tPoseBody.arm!.y)).toBeLessThan(0.005);
      expect(Math.abs(shaftMean[2]! - tPoseBody.arm!.z)).toBeLessThan(0.005);
      expect(shaftBounds[0]![0]).toBeLessThan(tPoseBody.arm!.y - 0.05);
      expect(shaftBounds[0]![1]).toBeGreaterThan(tPoseBody.arm!.y + 0.05);
      expect(shaftBounds[1]![0]).toBeLessThan(tPoseBody.arm!.z - 0.05);
      expect(shaftBounds[1]![1]).toBeGreaterThan(tPoseBody.arm!.z + 0.05);
      expect(wristGap).toBeLessThan(0.02);
    }
    expect(metrics).toHaveLength(2);
    expect(Math.abs(metrics[0]!.lift - metrics[1]!.lift)).toBeLessThan(0.015);
    expect(Math.abs(metrics[0]!.meanX + metrics[1]!.meanX)).toBeLessThan(0.005);
    for (const group of ['0-4', '2-4', '1-5', '2-5']) {
      const seams = regularSeamsInPanelGroup(mesh, n, group);
      expect(seams.length, group).toBeGreaterThan(20);
      expect(
        seams.reduce((sum, seam) => sum + seam.span, 0) / seams.length,
        group,
      ).toBeLessThan(0.09);
      expect(Math.max(...seams.map((seam) => seam.span)), group).toBeLessThan(
        0.14,
      );
    }
    // Every raster cell of both sleeve-cap halves must be sewn. Sampling at
    // the shorter of the two curved chains used to omit up to eight cap cells
    // at n=64, leaving the crescent-shaped shoulder holes visible in 3D.
    const frontArm = new Set(
      rasterRun(doc.piece, lucasHoodieRuns(doc).front.armhole, n),
    );
    const capACells = new Set(capA);
    const capBCells = new Set(capB);
    const seamLocals = (group: string, panel: number): Set<number> => {
      const locals = new Set<number>();
      for (const seam of regularSeamsInPanelGroup(mesh, n, group)) {
        for (const particle of [seam.a, seam.b]) {
          if (Math.floor(particle / (n * n)) === panel) {
            locals.add(particle % (n * n));
          }
        }
      }
      return locals;
    };
    for (const [group, panel, expected] of [
      ['0-4', 0, frontArm],
      ['0-4', 4, capBCells],
      ['2-4', 4, capACells],
      ['1-5', 1, frontArm],
      ['1-5', 5, capBCells],
      ['2-5', 5, capACells],
    ] as const) {
      const stitched = seamLocals(group, panel);
      expect(
        [...expected].every((cell) => stitched.has(cell)),
        `${group}: tous les points du bord du panneau ${panel} sont cousus`,
      ).toBe(true);
    }
    for (const group of ['4-4', '5-5']) {
      const underarmSeams = regularSeamsInPanelGroup(mesh, n, group);
      expect(underarmSeams.length, `${group}: couture sous-manche`).toBeGreaterThan(
        30,
      );
      expect(
        Math.max(...underarmSeams.map((seam) => seam.span)),
        `${group}: la préparation ne rouvre pas le dessous de manche`,
      ).toBeLessThan(0.015);
    }
    const underarmCells = new Set([
      ...rasterRun(sleeve, runs.underarmA, n),
      ...rasterRun(sleeve, runs.underarmB, n),
    ]);
    for (const panel of [4, 5]) {
      const stitched = seamLocals(`${panel}-${panel}`, panel);
      expect(
        [...underarmCells].every((cell) => stitched.has(cell)),
        `panneau ${panel}: aucun point ne reste ouvert sous la manche`,
      ).toBe(true);
    }
    const sleeveCuffCells = new Set(rasterRun(sleeve, runs.cuff, n));
    for (const [sleevePanel, cuffPanel] of [
      [4, 6],
      [5, 7],
    ] as const) {
      const attached = seamLocals(
        `${sleevePanel}-${cuffPanel}`,
        sleevePanel,
      );
      expect(
        [...sleeveCuffCells].every((cell) => attached.has(cell)),
        `panneau ${sleevePanel}: le poignet ferme toute la sortie de manche`,
      ).toBe(true);
      expect(
        regularSeamsInPanelGroup(mesh, n, `${cuffPanel}-${cuffPanel}`).length,
        `panneau ${cuffPanel}: couture du bord-côte fermée`,
      ).toBeGreaterThanOrEqual(n - 2);
    }
    const quality = meshGeometryQuality(mesh, n * n);
    expect(quality.collapsedTriangles, JSON.stringify(quality)).toBe(0);
    expect(quality.minimumEdgeRatio, JSON.stringify(quality)).toBeGreaterThanOrEqual(
      0.25,
    );
    expect(quality.maximumEdgeRatio, JSON.stringify(quality)).toBeLessThanOrEqual(
      4,
    );
  });

  it('dispose le sweat porté: devant/dos séparés, aisance finie et capuche sagittale', () => {
    const n = 32;
    const doc = lucasHoodie('M', body);
    const { mesh, ranges } = buildLucasHoodieMesh(doc, n, body);
    const frontRanges = ranges.filter((range) => range.pieceId === 0);
    const backRanges = ranges.filter((range) => range.pieceId === 1);
    const hoodRanges = ranges.filter((range) => range.pieceId === 3);
    const frontBounds = liveBounds(mesh, frontRanges);
    const backBounds = liveBounds(mesh, backRanges);
    const torsoBounds = liveBounds(mesh, [...frontRanges, ...backRanges]);

    expect(frontBounds.minimum[2]).toBeGreaterThanOrEqual(-0.002);
    expect(backBounds.maximum[2]).toBeLessThanOrEqual(0.002);
    expect(frontBounds.minimum[0]).toBeLessThan(-body.chest.halfW);
    expect(frontBounds.maximum[0]).toBeGreaterThan(body.chest.halfW);
    const halfW = Math.max(
      Math.abs(torsoBounds.minimum[0]),
      Math.abs(torsoBounds.maximum[0]),
    );
    const halfD = Math.max(
      Math.abs(torsoBounds.minimum[2]),
      Math.abs(torsoBounds.maximum[2]),
    );
    const h = ((halfW - halfD) / (halfW + halfD)) ** 2;
    const circumference =
      Math.PI *
      (halfW + halfD) *
      (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    expect(circumference).toBeCloseTo(
      LUCAS_HOODIE_DATA.M.finishedChestCm / 100,
      2,
    );
    expect(torsoBounds.maximum[1] - torsoBounds.minimum[1]).toBeGreaterThan(
      0.7,
    );

    expect(hoodRanges).toHaveLength(2);
    const leftHood = liveBounds(mesh, [hoodRanges[0]!]);
    const rightHood = liveBounds(mesh, [hoodRanges[1]!]);
    expect(leftHood.maximum[0]).toBeLessThanOrEqual(0.002);
    expect(rightHood.minimum[0]).toBeGreaterThanOrEqual(-0.002);
    const hoodBounds = liveBounds(mesh, hoodRanges);
    expect(hoodBounds.maximum[1]).toBeGreaterThan(body.height);
    expect(hoodBounds.minimum[2]).toBeLessThan(-body.chest.halfD);
    expect(hoodBounds.maximum[2]).toBeGreaterThan(body.chest.halfD);

    const centerCells = rasterRun(
      doc.pieces![1]!,
      lucasHoodieRuns(doc).hood.center,
      n,
    );
    const faceCells = rasterRun(
      doc.pieces![1]!,
      lucasHoodieRuns(doc).hood.face,
      n,
    );
    for (const range of hoodRanges) {
      expect(
        Math.max(
          ...centerCells.map((cell) =>
            Math.abs(mesh.positions[(range.first + cell) * 4]!),
          ),
        ),
      ).toBeLessThan(0.004);
      const faceMiddle = faceCells[Math.floor(faceCells.length / 2)]!;
      expect(
        Math.abs(mesh.positions[(range.first + faceMiddle) * 4]!),
      ).toBeGreaterThan(0.06);
      expect(mesh.positions[(range.first + faceMiddle) * 4 + 2]!).toBeGreaterThan(
        0,
      );
      expect(
        Math.abs(mesh.positions[(range.first + faceCells[0]!) * 4]!),
      ).toBeLessThan(0.012);
      expect(
        Math.abs(mesh.positions[(range.first + faceCells.at(-1)!) * 4]!),
      ).toBeLessThan(0.025);
    }
  });

  it('fait suivre au volume 3D une retouche de largeur effectuée dans le patron 2D', () => {
    const n = 16;
    const circumference = (
      result: ReturnType<typeof buildLucasHoodieMesh>,
    ): number => {
      const torso = liveBounds(
        result.mesh,
        result.ranges.filter(
          (range) => range.pieceId === 0 || range.pieceId === 1,
        ),
      );
      const halfW = Math.max(
        Math.abs(torso.minimum[0]),
        Math.abs(torso.maximum[0]),
      );
      const halfD = Math.max(
        Math.abs(torso.minimum[2]),
        Math.abs(torso.maximum[2]),
      );
      const h = ((halfW - halfD) / (halfW + halfD)) ** 2;
      return (
        Math.PI *
        (halfW + halfD) *
        (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
      );
    };

    const original = buildLucasHoodieMesh(lucasHoodie('M', body), n, body);
    const editedDoc = structuredClone(lucasHoodie('M', body));
    editedDoc.piece.width *= 0.9;
    editedDoc.back!.width *= 0.9;
    const edited = buildLucasHoodieMesh(editedDoc, n, body);

    expect(circumference(original)).toBeCloseTo(1.3, 2);
    expect(circumference(edited)).toBeLessThan(
      circumference(original) - 0.1,
    );
    expect(circumference(edited)).toBeCloseTo(1.166, 2);
  });

  it('simule le poignet sur sa largeur de coupe sans ajouter le cadre technique', () => {
    const n = 32;
    const doc = lucasHoodie('M', body);
    const { mesh, ranges } = buildLucasHoodieMesh(doc, n, body);
    const cuffRange = ranges.find(
      (range) => range.pieceId === 5 && range.instance === 0,
    )!;
    const row = Math.floor(n / 2);
    const particles = Array.from({ length: n }, (_unused, column) =>
      cuffRange.first + row * n + column,
    ).filter((particle) => mesh.invMasses[particle]! > 0);
    let wrappedLength = 0;
    for (let index = 1; index < particles.length; index++) {
      const a = particles[index - 1]! * 4;
      const b = particles[index]! * 4;
      wrappedLength += Math.hypot(
        mesh.positions[b]! - mesh.positions[a]!,
        mesh.positions[b + 1]! - mesh.positions[a + 1]!,
        mesh.positions[b + 2]! - mesh.positions[a + 2]!,
      );
    }
    const last = particles.at(-1)! * 4;
    const first = particles[0]! * 4;
    wrappedLength += Math.hypot(
      mesh.positions[last]! - mesh.positions[first]!,
      mesh.positions[last + 1]! - mesh.positions[first + 1]!,
      mesh.positions[last + 2]! - mesh.positions[first + 2]!,
    );

    expect(particles.length).toBeGreaterThanOrEqual(n - 2);
    expect(wrappedLength).toBeCloseTo(
      physicalBoundsCm(doc.pieces![3]!)[0] / 100,
      2,
    );
  });

  it('recalcule l’ancrage du torse après changement de stature sans muter le patron', () => {
    const doc = lucasHoodie('M', body);
    const snapshot = JSON.stringify(doc);
    const tallBody: BodyMeasure = {
      ...body,
      height: 2.1,
      neckY: 1.91,
      shoulderY: 1.82,
      chest: { ...body.chest, y: 1.64 },
      waist: { ...body.waist, y: 1.31 },
      hip: { ...body.hip, y: 1.12 },
      thigh: { ...body.thigh, y: 0.88 },
    };
    const { mesh } = buildLucasHoodieMesh(doc, 16, tallBody);
    const spans = regularSeamSpans(mesh);

    expect(Math.max(...spans)).toBeLessThan(0.15);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('retire bien les contraintes du zip quand il est ouvert', () => {
    const closedDoc = lucasHoodie('M', body);
    const openDoc = {
      ...closedDoc,
      seams: (closedDoc.seams ?? []).map((seam) =>
        seam.kind === 'zipper' ? { ...seam, closed: false } : seam,
      ),
    };
    const closed = buildLucasHoodieMesh(closedDoc, 16, body).mesh;
    const open = buildLucasHoodieMesh(openDoc, 16, body).mesh;

    expect(closed.count).toBe(open.count);
    const monoPanelTriangles = (indices: Uint32Array): number[][] => {
      const panelSize = 16 * 16;
      const triangles: number[][] = [];
      for (let offset = 0; offset < indices.length; offset += 3) {
        const triangle = [
          indices[offset]!,
          indices[offset + 1]!,
          indices[offset + 2]!,
        ];
        if (
          triangle.every(
            (particle) =>
              Math.floor(particle / panelSize) ===
              Math.floor(triangle[0]! / panelSize),
          )
        ) {
          triangles.push(triangle);
        }
      }
      return triangles;
    };
    // Opening the zip removes its physical stitches and the render-only strip
    // that closes those two cut fronts. It must not recut either cloth panel.
    expect(monoPanelTriangles(closed.triangleIndices)).toEqual(
      monoPanelTriangles(open.triangleIndices),
    );
    expect(closed.triangleIndices.length).toBeGreaterThan(
      open.triangleIndices.length,
    );
    expect(closed.seamCount).toBeGreaterThan(open.seamCount);
    const closedGroups = regularSeamPanelGroups(closed, 16);
    const openGroups = regularSeamPanelGroups(open, 16);
    expect(closedGroups.get('0-1')).toBeGreaterThan(0);
    expect(closedGroups.get('8-8')).toBeGreaterThan(0);
    expect(openGroups.get('0-1') ?? 0).toBe(0);
    expect(openGroups.get('8-8') ?? 0).toBe(0);

    const reopened = sanitizeDraft(JSON.parse(JSON.stringify(openDoc)));
    expect(reopened.seams?.find((seam) => seam.kind === 'zipper')).toMatchObject({
      kind: 'zipper',
      closed: false,
    });
  });

  it('préhabille sans trou ni géométrie écrasée les sept tailles à la résolution 64', () => {
    const n = 64;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const size of LUCAS_HOODIE_SIZES) {
        const hoodieDoc = lucasHoodie(size, body);
        const { mesh, ranges } = buildLucasHoodieMesh(
          hoodieDoc,
          n,
          body,
        );

        expect(mesh.count).toBe(14 * n * n);
        expect(ranges).toHaveLength(12);
        expect(mesh.constraintCount).toBeGreaterThan(0);
        expect(mesh.surfaceContactCount).toBeGreaterThan(0);
        expect(mesh.seamDressingSeconds).toBe(2.5);
        expect(Math.max(...regularSeamSpans(mesh))).toBeLessThan(0.32);

        const torsoRanges = ranges.filter(
          (range) => range.pieceId === 0 || range.pieceId === 1,
        );
        const waistbandRanges = ranges.filter(
          (range) => range.pieceId === 6,
        );
        const torsoBounds = liveBounds(mesh, torsoRanges);
        const waistbandBounds = liveBounds(mesh, waistbandRanges);
        // A hoodie torso is a nearly straight tube. The former whole-panel
        // fit increased this depth to ~42 cm and tipped the hem 18 cm forward.
        expect(torsoBounds.maximum[2] - torsoBounds.minimum[2]).toBeLessThan(
          0.36,
        );
        expect(waistbandBounds.maximum[1]).toBeLessThanOrEqual(
          torsoBounds.minimum[1] + 0.03,
        );
        expect(waistbandBounds.maximum[1] - waistbandBounds.minimum[1]).toBeGreaterThan(
          0.04,
        );
        expect(waistbandBounds.maximum[1] - waistbandBounds.minimum[1]).toBeLessThan(
          0.1,
        );

        expect(mesh.anchorY).toBeDefined();
        const dressingRanges = ranges.filter(
          (range) =>
            range.pieceId === 0 ||
            range.pieceId === 1 ||
            range.pieceId === 2 ||
            range.pieceId === 3 ||
            range.pieceId === 5 ||
            range.pieceId === 6,
        );
        const anchored = new Set<number>();
        const sleevePiece = hoodieDoc.pieces![0]!;
        const sleeveCap = lucasHoodieRuns(hoodieDoc).sleeve.cap;
        const sleeveAnchorRow = Math.ceil(
          Math.min(
            1,
            Math.max(
              sleevePiece.outline[sleeveCap.from]![1],
              sleevePiece.outline[sleeveCap.to]![1],
            ) + 0.18,
          ) *
            (n - 1),
        );
        const hoodCenterCells = new Set(
          rasterRun(
            hoodieDoc.pieces![1]!,
            lucasHoodieRuns(hoodieDoc).hood.center,
            n,
          ),
        );
        for (const range of dressingRanges) {
          for (let particle = range.first; particle < range.first + range.count; particle++) {
            const localRow = Math.floor((particle - range.first) / n);
            const local = particle - range.first;
            const hoodCrownAnchor =
              range.pieceId === 3 &&
              hoodCenterCells.has(local) &&
              mesh.positions[particle * 4 + 1]! > body.neckY + 0.035;
            if (
              mesh.invMasses[particle]! > 0 &&
              (range.pieceId === 3
                ? hoodCrownAnchor
                : range.pieceId !== 2 || localRow >= sleeveAnchorRow)
            ) {
              anchored.add(particle);
            }
          }
        }
        let anchorMismatch = 0;
        for (let particle = 0; particle < mesh.count; particle++) {
          if ((mesh.anchorY![particle]! > -1e8) !== anchored.has(particle)) {
            anchorMismatch++;
          }
        }
        expect(anchorMismatch).toBe(0);

        // The waistband remains the one continuous on-fold piece supplied in
        // the PDF. Dense gathered joins cover every body-hem cell while the
        // shorter rib edge is deliberately reused between stitches.
        const seamGroups = regularSeamPanelGroups(mesh, n);
        for (const group of ['0-8', '1-8']) {
          expect(
            seamGroups.get(group) ?? 0,
            `${size}: raccord devant/ceinture ${group}`,
          ).toBeGreaterThanOrEqual(n - 12);
        }
        expect(
          seamGroups.get('2-8') ?? 0,
          `${size}: raccord dos/ceinture 2-8`,
        ).toBeGreaterThanOrEqual(n - 6);
        for (const group of ['0-8', '1-8', '2-8']) {
          const bandSeams = regularSeamsInPanelGroup(mesh, n, group);
          expect(bandSeams.length).toBeGreaterThan(0);
          expect(
            Math.max(...bandSeams.map((seam) => seam.span)),
            `${size}: portée du raccord ceinture ${group}`,
          ).toBeLessThan(0.08);
          // Panel 8 is the single live waistband. Its hem joins must remain on
          // the upper raster chain; the former generic corner assignment put
          // up to 17 cells on the vertical zip edge and pulled one front 21 cm.
          expect(
            bandSeams.every((seam) => {
              const bandParticle =
                Math.floor(seam.a / (n * n)) === 8 ? seam.a : seam.b;
              return Math.floor((bandParticle % (n * n)) / n) <= 1;
            }),
            `${size}: la ceinture ${group} reste sur son bord supérieur`,
          ).toBe(true);
        }

        const quality = meshGeometryQuality(mesh, n * n);
        expect(
          quality.collapsedTriangles,
          `${size}: ${JSON.stringify(quality)}`,
        ).toBe(0);
        expect(
          quality.severelyCompressedEdges,
          `${size}: ${JSON.stringify(quality)}`,
        ).toBe(0);
        expect(quality.minimumArea2).toBeGreaterThan(1e-12);
        expect(
          quality.minimumEdgeRatio,
          `${size}: ${JSON.stringify(quality)}`,
        ).toBeGreaterThanOrEqual(0.25);
        expect(
          quality.maximumEdgeRatio,
          `${size}: ${JSON.stringify(quality)}`,
        ).toBeLessThanOrEqual(4);
      }
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  }, 30_000);
});
