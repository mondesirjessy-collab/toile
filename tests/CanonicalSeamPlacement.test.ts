import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { gridSd, measureBody } from '../src/engine/body/measure';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';
import { preCloseBodySafeMirrorSeams } from '../src/engine/pattern/SeamPlacement';
import { preWrapTwoPanelTube } from '../src/engine/pattern/TubePlacement';
import { boxyTee } from '../src/engine/pattern/draftTee';
import { compileAssembly, compileDraft } from '../src/engine/pattern/Draft';

function femaleScan() {
  const raw = readFileSync(
    new URL('../public/avatars/femme-scan.sdf.bin', import.meta.url),
  );
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dims: [number, number, number] = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
  ];
  const min: [number, number, number] = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  const max: [number, number, number] = [
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  ];
  const packed = new Int16Array(
    raw.buffer,
    raw.byteOffset + 36,
    dims[0] * dims[1] * dims[2],
  );
  return {
    dims,
    min,
    max,
    data: Float32Array.from(packed, (millimetres) => millimetres / 1000),
  };
}

describe('placement canonique des coutures sur le scan femme', () => {
  const grid = femaleScan();
  const bodyDistance = gridSd(grid);
  const body = measureBody(bodyDistance, grid.max[1] - 0.06);
  const gap = Math.max(
    0.24,
    2 * Math.max(body.chest.halfD, body.waist.halfD, body.hip.halfD) + 0.08,
  );

  for (const [name, make, tube] of [
    ['t-shirt', () => generateSeamedPanels({
      resolution: 64,
      width: 1.15,
      height: 0.75,
      gap,
      topY: 1.52,
      shape: 'tshirt',
    }), false],
    ['jupe ensemble', () => generateSeamedPanels({
      resolution: 64,
      width: 0.85,
      height: 0.6,
      gap: 0.75,
      topY: body.waist.y + 0.04,
      shape: 'skirt',
    }), true],
    ['robe tenue', () => generateSeamedPanels({
      resolution: 64,
      width: 0.95,
      height: 0.85,
      gap: gap + 0.06,
      topY: 1.78,
      shape: 'aline',
    }), false],
  ] as const) {
    it(`${name} ferme chaque vraie couture miroir hors du corps`, () => {
      const mesh = make();
      const clearance = Math.max(
        0.012,
        1.5 * Math.max(mesh.spacing, mesh.spacingV),
      ) + (tube ? 0.005 : 0);
      if (tube) preWrapTwoPanelTube(mesh, { bodyDistance, clearance });
      const closed = preCloseBodySafeMirrorSeams(mesh, {
        bodyDistance,
        clearance,
      });
      expect(closed).toBe(mesh.seamCount);

      const constraints = new DataView(mesh.constraintData);
      let audited = 0;
      for (let k = 0; k < mesh.constraintCount; k++) {
        const offset = k * 16;
        if (constraints.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
        const i = constraints.getUint32(offset, true);
        const j = constraints.getUint32(offset + 4, true);
        const rest = constraints.getFloat32(offset + 8, true);
        const distance = Math.hypot(
          mesh.positions[i * 4]! - mesh.positions[j * 4]!,
          mesh.positions[i * 4 + 1]! - mesh.positions[j * 4 + 1]!,
          mesh.positions[i * 4 + 2]! - mesh.positions[j * 4 + 2]!,
        );
        expect(distance).toBeCloseTo(rest, 6);
        for (const particle of [i, j]) {
          expect(bodyDistance(
            mesh.positions[particle * 4]!,
            mesh.positions[particle * 4 + 1]!,
            mesh.positions[particle * 4 + 2]!,
          )).toBeGreaterThanOrEqual(clearance - 1e-5);
        }
        audited++;
      }
      expect(audited).toBe(mesh.seamCount);
    });
  }

  it('robe froncée pré-enroule tous ses sommets hors du scan', () => {
    const upper = generateSeamedPanels({
      resolution: 64,
      width: 0.42,
      height: 0.26,
      gap: 0.9,
      topY: body.chest.y + 0.14,
    });
    const skirt = generateSeamedPanels({
      resolution: 64,
      width: 0.42 * 1.6,
      height: 0.55,
      gap: 0.9,
      topY: body.chest.y + 0.14 - 0.26,
    });
    const clearance = Math.max(
      0.012,
      3 * Math.max(
        upper.spacing,
        upper.spacingV,
        skirt.spacing,
        skirt.spacingV,
      ),
    );
    for (const mesh of [upper, skirt]) {
      preWrapTwoPanelTube(mesh, { bodyDistance, clearance });
      preCloseBodySafeMirrorSeams(mesh, { bodyDistance, clearance });
      for (let particle = 0; particle < mesh.count; particle++) {
        if (mesh.invMasses[particle]! <= 0) continue;
        expect(bodyDistance(
          mesh.positions[particle * 4]!,
          mesh.positions[particle * 4 + 1]!,
          mesh.positions[particle * 4 + 2]!,
        )).toBeGreaterThanOrEqual(clearance - 1e-5);
      }
    }
  });

  it('BOXY S garde ses coutures miroir d’épaule hors du scan', () => {
    const n = 64;
    const doc = boxyTee('S', body, body);
    const front = compileDraft(doc.piece, n);
    const back = compileDraft(doc.back!, n);
    const open = (cells: Set<number>) => (u: number, v: number): boolean =>
      cells.has(Math.round(v * (n - 1)) * n + Math.round(u * (n - 1)));
    const mesh = generateSeamedPanels({
      resolution: n,
      width: doc.piece.width,
      height: doc.piece.height,
      gap,
      topY: doc.piece.topY,
      shape: 'freeform',
      mask: { outline: doc.piece.outline, darts: doc.piece.darts },
      extraSeams: front.extraSeams,
      extraOpenings: open(front.openCells),
      maskBack: { outline: doc.back!.outline, darts: doc.back!.darts },
      extraSeamsBack: back.extraSeams,
      extraOpeningsBack: open(back.openCells),
      manualAssembly: true,
      assemblySeams: compileAssembly(doc, n),
    });
    const clearance = Math.max(
      0.012,
      1.5 * Math.max(mesh.spacing, mesh.spacingV),
    );
    const closed = preCloseBodySafeMirrorSeams(mesh, {
      bodyDistance,
      clearance,
    });
    expect(closed).toBeGreaterThan(0);

    const constraints = new DataView(mesh.constraintData);
    let mirrorSeams = 0;
    for (let k = 0; k < mesh.constraintCount; k++) {
      const offset = k * 16;
      if (constraints.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
      const i = constraints.getUint32(offset, true);
      const j = constraints.getUint32(offset + 4, true);
      if (Math.abs(i - j) !== n * n || i % (n * n) !== j % (n * n)) continue;
      const distance = Math.hypot(
        mesh.positions[i * 4]! - mesh.positions[j * 4]!,
        mesh.positions[i * 4 + 1]! - mesh.positions[j * 4 + 1]!,
        mesh.positions[i * 4 + 2]! - mesh.positions[j * 4 + 2]!,
      );
      expect(distance).toBeCloseTo(constraints.getFloat32(offset + 8, true), 6);
      expect(bodyDistance(
        mesh.positions[i * 4]!,
        mesh.positions[i * 4 + 1]!,
        mesh.positions[i * 4 + 2]!,
      )).toBeGreaterThanOrEqual(clearance - 1e-5);
      expect(bodyDistance(
        mesh.positions[j * 4]!,
        mesh.positions[j * 4 + 1]!,
        mesh.positions[j * 4 + 2]!,
      )).toBeGreaterThanOrEqual(clearance - 1e-5);
      mirrorSeams++;
    }
    expect(mirrorSeams).toBe(closed);
  });
});
