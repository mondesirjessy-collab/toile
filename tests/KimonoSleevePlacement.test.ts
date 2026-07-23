import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { gridSd, measureBody } from '../src/engine/body/measure';
import { preWrapKimonoSleeves } from '../src/engine/pattern/KimonoSleevePlacement';
import { preCloseBodySafeMirrorSeams } from '../src/engine/pattern/SeamPlacement';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';

type Vec3 = [number, number, number];

function capsuleDistance(
  x: number,
  y: number,
  z: number,
  a: Vec3,
  b: Vec3,
  radius: number,
): number {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const pax = x - a[0];
  const pay = y - a[1];
  const paz = z - a[2];
  const denominator = bax * bax + bay * bay + baz * baz;
  const h = Math.min(
    1,
    Math.max(0, (pax * bax + pay * bay + paz * baz) / denominator),
  );
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - radius;
}

/** Symmetric true T-pose arms, deliberately 10.5 cm behind the paper plane. */
const armDistance = (x: number, y: number, z: number): number =>
  Math.min(
    capsuleDistance(x, y, z, [0.2, 1.41, -0.105], [0.8, 1.41, -0.105], 0.062),
    capsuleDistance(x, y, z, [-0.2, 1.41, -0.105], [-0.8, 1.41, -0.105], 0.062),
  );

function maleScanDistance() {
  const raw = readFileSync(
    new URL('../public/avatars/homme-scan.sdf.bin', import.meta.url),
  );
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dims: [number, number, number] = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
  ];
  const min: Vec3 = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  const max: Vec3 = [
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  ];
  const packed = new Int16Array(
    raw.buffer,
    raw.byteOffset + 36,
    dims[0] * dims[1] * dims[2],
  );
  const bodyDistance = gridSd({
    dims,
    min,
    max,
    data: Float32Array.from(packed, (millimetres) => millimetres / 1000),
  });
  return { bodyDistance, max };
}

describe.each([64, 128])('placement anatomique des manches kimono n=%i', (n) => {
  const clearance = 0.024;
  const make = () =>
    generateSeamedPanels({
      resolution: n,
      width: 1.15,
      height: 0.75,
      gap: 0.38,
      topY: 1.52,
      shape: 'tshirt',
    });

  it('enroule les deux bras sans déplacer le torse ni les X', () => {
    const mesh = make();
    const before = mesh.positions.slice();
    const wrapped = preWrapKimonoSleeves(mesh, { bodyDistance: armDistance, clearance });
    expect(wrapped).toBeGreaterThan(n * 0.35);

    const panelSize = n * n;
    let sleeveParticles = 0;
    for (let panel = 0; panel < 2; panel++) {
      for (let v = 0; v < n; v++) {
        for (let u = 0; u < n; u++) {
          const particle = panel * panelSize + v * n + u;
          const offset = particle * 4;
          expect(mesh.positions[offset]).toBe(before[offset]);
          if (Math.abs(u / (n - 1) - 0.5) <= 0.24) {
            expect(mesh.positions[offset + 1]).toBe(before[offset + 1]);
            expect(mesh.positions[offset + 2]).toBe(before[offset + 2]);
          } else if (mesh.invMasses[particle]! > 0) {
            expect(armDistance(
              mesh.positions[offset]!,
              mesh.positions[offset + 1]!,
              mesh.positions[offset + 2]!,
            )).toBeGreaterThanOrEqual(clearance - 5e-4);
            sleeveParticles++;
          }
        }
      }
    }
    expect(sleeveParticles).toBeGreaterThan(0);
  });

  it('forme deux demi-cercles symétriques avec des lèvres communes', () => {
    const mesh = make();
    preWrapKimonoSleeves(mesh, { bodyDistance: armDistance, clearance });
    const panelSize = n * n;
    let auditedColumns = 0;
    for (let u = 0; u < Math.floor(n / 2); u++) {
      if (Math.abs(u / (n - 1) - 0.5) <= 0.24) continue;
      const rows = Array.from({ length: n }, (_, v) => v).filter(
        (v) => mesh.invMasses[v * n + u]! > 0,
      );
      if (rows.length < 3) continue;
      const mirrorU = n - 1 - u;
      const top = rows[0]!;
      const bottom = rows[rows.length - 1]!;
      const middle = rows[Math.floor(rows.length / 2)]!;
      for (const v of [top, bottom]) {
        const front = v * n + u;
        const back = panelSize + front;
        expect(mesh.positions[front * 4 + 1]).toBe(mesh.positions[back * 4 + 1]);
        expect(mesh.positions[front * 4 + 2]).toBe(mesh.positions[back * 4 + 2]);
      }
      const middleLocal = middle * n + u;
      expect(mesh.positions[middleLocal * 4 + 2]!).toBeGreaterThan(
        mesh.positions[(panelSize + middleLocal) * 4 + 2]!,
      );
      for (const v of rows) {
        const left = v * n + u;
        const right = v * n + mirrorU;
        expect(mesh.positions[left * 4 + 1]).toBeCloseTo(mesh.positions[right * 4 + 1]!, 5);
        expect(mesh.positions[left * 4 + 2]).toBeCloseTo(mesh.positions[right * 4 + 2]!, 5);
      }
      auditedColumns++;
    }
    expect(auditedColumns).toBeGreaterThan(0);
  });

  it('reste compatible avec le pré-close complet des coutures miroir', () => {
    const mesh = make();
    preWrapKimonoSleeves(mesh, { bodyDistance: armDistance, clearance });
    preCloseBodySafeMirrorSeams(mesh, { bodyDistance: armDistance, clearance });
    const panelSize = n * n;
    const constraints = new DataView(mesh.constraintData);
    let sleeveSeams = 0;
    for (let k = 0; k < mesh.constraintCount; k++) {
      const offset = k * 16;
      if (constraints.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
      const i = constraints.getUint32(offset, true);
      const j = constraints.getUint32(offset + 4, true);
      if (Math.abs(i - j) !== panelSize || i % panelSize !== j % panelSize) continue;
      const u = (i % panelSize) % n;
      if (Math.abs(u / (n - 1) - 0.5) <= 0.24) continue;
      expect(Math.hypot(
        mesh.positions[i * 4]! - mesh.positions[j * 4]!,
        mesh.positions[i * 4 + 1]! - mesh.positions[j * 4 + 1]!,
        mesh.positions[i * 4 + 2]! - mesh.positions[j * 4 + 2]!,
      )).toBeCloseTo(constraints.getFloat32(offset + 8, true), 6);
      sleeveSeams++;
    }
    expect(sleeveSeams).toBeGreaterThan(0);
  });
});

describe('régression scan homme (bras décalés derrière z=0)', () => {
  const scan = maleScanDistance();
  const body = measureBody(scan.bodyDistance, scan.max[1] - 0.06);

  for (const n of [64, 128]) {
    it(`trouve l’axe des deux bras, pas le torse, à n=${n}`, () => {
      expect(body.arm?.path?.length).toBeGreaterThan(2);
      const mesh = generateSeamedPanels({
        resolution: n,
        width: 1.15,
        height: 0.75,
        gap: 0.38,
        topY: 1.52,
        shape: 'tshirt',
      });
      const wrapped = preWrapKimonoSleeves(mesh, {
        bodyDistance: scan.bodyDistance,
        clearance: 0.024,
      });
      expect(wrapped).toBeGreaterThan(n * 0.3);

      const panelSize = n * n;
      let compared = 0;
      for (let u = 0; u < n; u++) {
        if (Math.abs(u / (n - 1) - 0.5) < 0.31) continue;
        const rows = Array.from({ length: n }, (_, v) => v).filter(
          (v) => mesh.invMasses[v * n + u]! > 0,
        );
        if (rows.length < 2) continue;
        const top = rows[0]! * n + u;
        const bottom = rows[rows.length - 1]! * n + u;
        const centreY =
          (mesh.positions[top * 4 + 1]! + mesh.positions[bottom * 4 + 1]!) * 0.5;
        const centreZ = mesh.positions[top * 4 + 2]!;
        const x = mesh.positions[top * 4]!;
        const armPoint = body.arm!.path!.reduce((closest, point) =>
          Math.abs(Math.abs(point.x) - Math.abs(x)) <
          Math.abs(Math.abs(closest.x) - Math.abs(x))
            ? point
            : closest,
        );
        expect(Math.abs(centreY - armPoint.y)).toBeLessThan(0.07);
        expect(Math.abs(centreZ - armPoint.z)).toBeLessThan(0.055);
        expect(mesh.positions[(panelSize + top) * 4 + 2]).toBe(centreZ);
        compared++;
      }
      expect(compared).toBeGreaterThan(0);
    });
  }
});
