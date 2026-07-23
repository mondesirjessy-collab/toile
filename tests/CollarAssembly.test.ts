import { describe, expect, it } from 'vitest';
import {
  combineClothMeshes,
  generateSeamedPanels,
} from '../src/engine/cloth/ClothMesh';
import {
  collarCrossSeams,
  fitCollarTubeToNeckline,
  preWrapCollarTube,
} from '../src/engine/pattern/CollarAssembly';
import { preWrapTwoPanelTube } from '../src/engine/pattern/TubePlacement';
import { neckOpeningCells } from '../src/engine/pattern/Draft';
import { boxyTee } from '../src/engine/pattern/draftTee';
import type { BodyMeasure, Level } from '../src/engine/body/measure';

const level = (y: number): Level => ({
  y,
  halfW: 0.16,
  halfD: 0.11,
  circ: 0.85,
});

const mannequin: BodyMeasure = {
  height: 1.75,
  neckY: 1.48,
  shoulderY: 1.4,
  shoulderHalfW: 0.22,
  chest: level(1.28),
  waist: level(1.05),
  hip: level(0.92),
  thigh: level(0.7),
};

describe('assemblage de la bande d’encolure', () => {
  it('pré-enroule les deux panneaux sans ouvrir leurs coutures latérales', () => {
    const n = 64;
    const panelSize = n * n;
    const band = generateSeamedPanels({
      resolution: n,
      width: 0.2,
      height: 0.04,
      gap: 0.15,
      shape: 'rect',
    });
    const row = Math.floor(n * 0.67);
    const before = Math.abs(
      band.positions[(row * n) * 4 + 2]! -
      band.positions[(panelSize + row * n) * 4 + 2]!,
    );
    expect(before).toBeCloseTo(0.15, 6);

    preWrapCollarTube(band);

    for (let v = 0; v < n; v++) {
      for (const u of [0, n - 1]) {
        const front = v * n + u;
        const back = panelSize + front;
        const separation = Math.hypot(
          band.positions[front * 4]! - band.positions[back * 4]!,
          band.positions[front * 4 + 1]! - band.positions[back * 4 + 1]!,
          band.positions[front * 4 + 2]! - band.positions[back * 4 + 2]!,
        );
        expect(separation).toBeLessThan(1e-7);
      }
    }
    const middleFront = row * n + Math.floor(n / 2);
    const middleBack = panelSize + middleFront;
    expect(band.positions[middleFront * 4 + 2]).toBeGreaterThan(0);
    expect(band.positions[middleBack * 4 + 2]).toBeLessThan(0);

    // Half-circle chord length closely preserves the flat structural spacing.
    const neighbour = middleFront + 1;
    const chord = Math.hypot(
      band.positions[middleFront * 4]! - band.positions[neighbour * 4]!,
      band.positions[middleFront * 4 + 2]! - band.positions[neighbour * 4 + 2]!,
    );
    expect(chord / band.spacing).toBeGreaterThan(0.999);
    expect(chord / band.spacing).toBeLessThanOrEqual(1);
  });

  it('place des tubes froncés de largeurs différentes dans les mêmes hémisphères', () => {
    const n = 64;
    const panelSize = n * n;
    const upper = generateSeamedPanels({
      resolution: n,
      width: 0.42,
      height: 0.26,
      gap: 0.9,
      topY: 1.4,
    });
    const gathered = generateSeamedPanels({
      resolution: n,
      width: 0.42 * 1.6,
      height: 0.55,
      gap: 0.9,
      topY: 1.14,
    });

    preWrapTwoPanelTube(upper);
    preWrapTwoPanelTube(gathered);

    for (const mesh of [upper, gathered]) {
      for (let v = 0; v < n; v++) {
        for (const u of [0, n - 1]) {
          const front = v * n + u;
          const back = panelSize + front;
          expect(mesh.positions[front * 4]).toBeCloseTo(
            mesh.positions[back * 4]!,
            7,
          );
          expect(mesh.positions[front * 4 + 2]).toBeCloseTo(
            mesh.positions[back * 4 + 2]!,
            7,
          );
        }
      }
    }

    // Every future waist pair stays on one body hemisphere. The seam segment
    // therefore gathers radially/tangentially instead of crossing the torso.
    for (let panel = 0; panel < 2; panel++) {
      const sign = panel === 0 ? 1 : -1;
      for (let u = 1; u < n - 1; u++) {
        const upperIndex = panel * panelSize + (n - 1) * n + u;
        const lowerIndex = panel * panelSize + u;
        expect(upper.positions[upperIndex * 4 + 2]! * sign).toBeGreaterThan(0);
        expect(gathered.positions[lowerIndex * 4 + 2]! * sign).toBeGreaterThan(0);
      }
    }
  });

  it('échantillonne séparément le bord réel du devant et celui du dos', () => {
    const n = 8;
    const panelSize = n * n;
    const invMasses = new Float32Array(panelSize * 2);
    // Same central columns, deliberately deep front and shallow back scoop.
    const front: number[] = [];
    const back: number[] = [];
    for (let u = Math.floor(0.24 * n); u <= Math.ceil(0.76 * n); u++) {
      front.push(4 * n + u);
      back.push(1 * n + u);
      invMasses[4 * n + u] = 1;
      invMasses[5 * n + u] = 1;
      invMasses[panelSize + 1 * n + u] = 1;
      invMasses[panelSize + 2 * n + u] = 1;
    }

    const seams = collarCrossSeams(
      { count: panelSize * 2, invMasses },
      n,
      { front, back },
    );
    const frontSeams = seams.filter((seam) => seam.i < panelSize);
    const backSeams = seams.filter((seam) => seam.i >= panelSize);

    expect(frontSeams).toHaveLength(Math.min(n - 2, front.length));
    expect(backSeams).toHaveLength(Math.min(n - 2, back.length));
    expect(frontSeams.every((seam) => Math.floor(seam.i / n) === 4)).toBe(true);
    expect(
      backSeams.every((seam) => Math.floor((seam.i - panelSize) / n) === 1),
    ).toBe(true);
    expect(new Set(frontSeams.map((seam) => seam.i)).size).toBe(frontSeams.length);
    expect(new Set(frontSeams.map((seam) => seam.j)).size).toBe(frontSeams.length);
    expect(frontSeams.every((seam) => seam.inwardI === seam.i + n)).toBe(true);
    expect(frontSeams.every((seam) => seam.inwardJ === seam.j - n)).toBe(true);
  });

  it('répartit le pré-ajustement du bas cousu jusqu’au haut libre du col', () => {
    const n = 5;
    const panelSize = n * n;
    const body = generateSeamedPanels({
      resolution: n,
      width: 0.5,
      height: 0.5,
      gap: 0.36,
      topY: 1.45,
      shape: 'rect',
    });
    const band = generateSeamedPanels({
      resolution: n,
      width: 0.22,
      height: 0.08,
      gap: 0.08,
      topY: 1.55,
      shape: 'rect',
    });
    preWrapCollarTube(band);
    const runs = {
      front: [2 * n + 1, 3 * n + 2, 2 * n + 3],
      back: [2 * n + 1, 1 * n + 2, 2 * n + 3],
    };
    const seams = collarCrossSeams(body, n, runs);
    // Make the two target scoops deliberately distinct and wider than the
    // original tube. The three pins map to interior band columns 1, 2 and 3;
    // columns 0 and 4 remain the collar's own lateral seams.
    for (const seam of seams) {
      const localBand = seam.j - body.count;
      const panel = Math.floor(localBand / panelSize);
      const u = localBand % n;
      body.positions[seam.i * 4] = -0.24 + u * 0.12;
      body.positions[seam.i * 4 + 1] =
        1.4 - (panel === 0 ? 0.025 : 0.01) * (2 - Math.abs(u - 2));
      body.positions[seam.i * 4 + 2] = panel === 0 ? 0.16 : -0.13;
    }
    const before = band.positions.slice();

    fitCollarTubeToNeckline(body, band, seams);

    for (const seam of seams) {
      const localBand = seam.j - body.count;
      for (let axis = 0; axis < 3; axis++) {
        expect(band.positions[localBand * 4 + axis]).toBeCloseTo(
          body.positions[seam.i * 4 + axis]!,
          6,
        );
      }
    }
    for (let panel = 0; panel < 2; panel++) {
      for (let u = 0; u < n; u++) {
        const top = panel * panelSize + u;
        for (let axis = 0; axis < 3; axis++) {
          expect(band.positions[top * 4 + axis]).toBeCloseTo(
            before[top * 4 + axis]!,
            7,
          );
        }
      }
    }

    // At an interpolated column, every row receives exactly its v/(n-1)
    // share of the bottom displacement; front/back keep their own z target.
    for (const panel of [0, 1]) {
      const u = 1;
      const bottom = panel * panelSize + (n - 1) * n + u;
      const delta = [0, 1, 2].map(
        (axis) => band.positions[bottom * 4 + axis]! - before[bottom * 4 + axis]!,
      );
      for (let v = 0; v < n; v++) {
        const index = panel * panelSize + v * n + u;
        for (let axis = 0; axis < 3; axis++) {
          expect(
            band.positions[index * 4 + axis]! - before[index * 4 + axis]!,
          ).toBeCloseTo(delta[axis]! * v / (n - 1), 6);
        }
      }
      expect(Math.sign(band.positions[bottom * 4 + 2]!)).toBe(
        panel === 0 ? 1 : -1,
      );
    }

    // The two different neckline scoops must not open either lateral seam.
    // Reconciliation is row-local, so it remains exact from the sewn bottom
    // through the tapered displacement to the free top.
    for (const u of [0, n - 1]) {
      for (let v = 0; v < n; v++) {
        const front = v * n + u;
        const back = panelSize + front;
        expect(band.positions[front * 4]).toBeCloseTo(
          band.positions[back * 4]!,
          7,
        );
        expect(band.positions[front * 4 + 1]).toBeCloseTo(
          band.positions[back * 4 + 1]!,
          7,
        );
        expect(band.positions[front * 4 + 2]).toBeCloseTo(
          band.positions[back * 4 + 2]!,
          7,
        );
      }
    }
  });

  it('réduit le saut BOXY row62→row63 à 1/63 du déplacement de couture', () => {
    const n = 64;
    const panelSize = n * n;
    const doc = boxyTee('S', mannequin, mannequin);
    const body = generateSeamedPanels({
      resolution: n,
      width: doc.piece.width,
      height: doc.piece.height,
      gap: doc.piece.gap,
      topY: doc.piece.topY,
      shape: 'freeform',
      mask: { outline: doc.piece.outline, darts: doc.piece.darts },
      maskBack: { outline: doc.back!.outline, darts: doc.back!.darts },
      manualAssembly: true,
    });
    const collar = doc.pieces!.find((piece) => piece.wrap === 'neck')!;
    const band = generateSeamedPanels({
      resolution: n,
      width: collar.width,
      height: collar.height,
      gap: collar.gap,
      topY: collar.topY,
      shape: 'freeform',
      mask: { outline: collar.outline, darts: collar.darts },
      maskBack: { outline: collar.outline, darts: collar.darts },
      // Same tube contract as the atelier build: top/bottom are open while
      // the two lateral runs close the front and back faces into one band.
      extraOpenings: (_uu, vv) => {
        const v = Math.round(vv * (n - 1));
        return v === 0 || v === n - 1;
      },
      extraOpeningsBack: (_uu, vv) => {
        const v = Math.round(vv * (n - 1));
        return v === 0 || v === n - 1;
      },
      flattenSeams: false,
    });
    preWrapCollarTube(band);
    const seams = collarCrossSeams(body, n, {
      front: neckOpeningCells(doc.piece, n),
      back: neckOpeningCells(doc.back!, n),
    });
    const before = band.positions.slice();

    fitCollarTubeToNeckline(body, band, seams);

    let largestPinMove = 0;
    for (const seam of seams) {
      const bottom = seam.j - body.count;
      const previousRow = bottom - n;
      const pinDelta = [0, 1, 2].map(
        (axis) => body.positions[seam.i * 4 + axis]! - before[bottom * 4 + axis]!,
      );
      largestPinMove = Math.max(largestPinMove, Math.hypot(...pinDelta));
      for (let axis = 0; axis < 3; axis++) {
        const oldEdge =
          before[bottom * 4 + axis]! - before[previousRow * 4 + axis]!;
        const fittedEdge =
          band.positions[bottom * 4 + axis]! -
          band.positions[previousRow * 4 + axis]!;
        expect(fittedEdge - oldEdge).toBeCloseTo(pinDelta[axis]! / 63, 5);
        expect(band.positions[bottom * 4 + axis]).toBeCloseTo(
          body.positions[seam.i * 4 + axis]!,
          5,
        );
      }
    }
    expect(seams.some((seam) => seam.j - body.count >= panelSize)).toBe(true);
    expect(largestPinMove).toBeGreaterThan(0.05);
  });

  for (const n of [64, 128]) {
    it(`suit uniquement les runs d’encolure du BOXY S à ${n}`, () => {
      const doc = boxyTee('S', mannequin, mannequin);
      const front = neckOpeningCells(doc.piece, n);
      const back = neckOpeningCells(doc.back!, n);

      expect(front.length).toBeGreaterThan(8);
      expect(back.length).toBeGreaterThan(8);
      expect(front[0]! % n).toBeLessThanOrEqual(front[front.length - 1]! % n);
      expect(back[0]! % n).toBeLessThanOrEqual(back[back.length - 1]! % n);

      // The supplied BOXY S neckline spans u=0.3438…0.6562. One raster-cell
      // tolerance covers endpoint snapping; the former hard-coded 0.24…0.76
      // scan fails these guards because it includes the shoulder seams.
      const tolerance = 1.5 / (n - 1);
      for (const cell of [...front, ...back]) {
        const u = (cell % n) / (n - 1);
        expect(u).toBeGreaterThanOrEqual(0.3438 - tolerance);
        expect(u).toBeLessThanOrEqual(0.6562 + tolerance);
      }

      const panelSize = n * n;
      const invMasses = new Float32Array(panelSize * 2).fill(1);
      const seams = collarCrossSeams(
        { count: panelSize * 2, invMasses },
        n,
        { front, back },
      );
      const frontSeams = seams.filter((seam) => seam.i < panelSize);
      const backSeams = seams.filter((seam) => seam.i >= panelSize);
      expect(frontSeams).toHaveLength(Math.min(n, front.length));
      expect(backSeams).toHaveLength(Math.min(n, back.length));
      expect(new Set(frontSeams.map((seam) => seam.i)).size).toBe(frontSeams.length);
      expect(new Set(backSeams.map((seam) => seam.i)).size).toBe(backSeams.length);
      expect(new Set(frontSeams.map((seam) => seam.j)).size).toBe(frontSeams.length);
      expect(new Set(backSeams.map((seam) => seam.j)).size).toBe(backSeams.length);
      expect(
        seams.every((seam) => {
          const bandU = (seam.j - 2 * panelSize) % n;
          return bandU > 0 && bandU < n - 1;
        }),
      ).toBe(true);
    });
  }

  it('exempte la vraie rangée intérieure du col de l’auto-collision', () => {
    const n = 8;
    const panelSize = n * n;
    const body = generateSeamedPanels({
      resolution: n,
      width: 0.5,
      height: 0.6,
      shape: 'rect',
    });
    const band = generateSeamedPanels({
      resolution: n,
      width: 0.2,
      height: 0.04,
      shape: 'rect',
    });
    const front = [2 * n + 2, 2 * n + 3, 2 * n + 4, 2 * n + 5];
    const back = front.map((cell) => cell);
    const seams = collarCrossSeams(body, n, { front, back });
    const sewn = combineClothMeshes(body, band, seams);

    for (const seam of seams) {
      expect(seam.attachment).toBe(true);
      expect(seam.inwardI).toBe(seam.i + n);
      expect(seam.inwardJ).toBe(seam.j - n);
      expect(sewn.seamFree![seam.i]).toBe(1);
      expect(sewn.seamFree![seam.inwardI!]).toBe(1);
      expect(sewn.seamFree![seam.j]).toBe(1);
      expect(sewn.seamFree![seam.inwardJ!]).toBe(1);
    }
    const constraints = new DataView(sewn.constraintData);
    const attachments = new Set(
      seams.map((seam) => `${seam.i}:${seam.j}`),
    );
    let attachmentCount = 0;
    for (let index = 0; index < sewn.constraintCount; index++) {
      const offset = index * 16;
      if (constraints.getUint32(offset + 12, true) !== 6) continue;
      attachmentCount++;
      expect(
        attachments.has(
          `${constraints.getUint32(offset, true)}:${constraints.getUint32(offset + 4, true)}`,
        ),
      ).toBe(true);
    }
    expect(attachmentCount).toBe(seams.length);
  });

  it('classe toute la lèvre cousue du col BOXY comme bande de couture sans densifier les points', () => {
    const n = 64;
    const panelSize = n * n;
    const doc = boxyTee('S', mannequin, mannequin);
    const body = generateSeamedPanels({
      resolution: n,
      width: doc.piece.width,
      height: doc.piece.height,
      gap: doc.piece.gap,
      topY: doc.piece.topY,
      shape: 'freeform',
      mask: { outline: doc.piece.outline, darts: doc.piece.darts },
      maskBack: { outline: doc.back!.outline, darts: doc.back!.darts },
      manualAssembly: true,
    });
    const collar = doc.pieces!.find((piece) => piece.wrap === 'neck')!;
    const band = generateSeamedPanels({
      resolution: n,
      width: collar.width,
      height: collar.height,
      gap: collar.gap,
      topY: collar.topY,
      shape: 'freeform',
      mask: { outline: collar.outline, darts: collar.darts },
      maskBack: { outline: collar.outline, darts: collar.darts },
      extraOpenings: (_uu, vv) => {
        const v = Math.round(vv * (n - 1));
        return v === 0 || v === n - 1;
      },
      extraOpeningsBack: (_uu, vv) => {
        const v = Math.round(vv * (n - 1));
        return v === 0 || v === n - 1;
      },
      flattenSeams: false,
    });
    const seams = collarCrossSeams(body, n, {
      front: neckOpeningCells(doc.piece, n),
      back: neckOpeningCells(doc.back!, n),
    });
    const sewn = combineClothMeshes(body, band, seams);
    const pinnedBandVertices = new Set(seams.map((seam) => seam.j));

    // The physical lockstitches deliberately remain sparse (the back scoop
    // has far fewer cells than the 64-point band), while the render zipper and
    // self-collision mask cover every vertex on the continuous sewn lip.
    expect(pinnedBandVertices.size).toBeLessThan(2 * n);
    expect(sewn.constraintCount).toBe(
      body.constraintCount + band.constraintCount + seams.length,
    );
    for (let panel = 0; panel < 2; panel++) {
      for (let u = 1; u < n - 1; u++) {
        const index = body.count + panel * panelSize + (n - 1) * n + u;
        expect(sewn.seamFree![index]).toBe(1);
      }
    }
    // The two unpinned corners inherit the band's lateral seam-distance mask;
    // mirror self-collision therefore cannot prise the reconciled join apart.
    for (let panel = 0; panel < 2; panel++) {
      for (const u of [0, n - 1]) {
        const index = body.count + panel * panelSize + (n - 1) * n + u;
        expect(sewn.seamFree![index]).toBe(0);
        expect(sewn.seamDist![index]).toBeLessThanOrEqual(2);
      }
    }
    expect(
      Array.from({ length: 2 * n }, (_, flat) => {
        const panel = Math.floor(flat / n);
        const u = flat % n;
        return body.count + panel * panelSize + (n - 1) * n + u;
      }).some((index) => !pinnedBandVertices.has(index)),
    ).toBe(true);
  });
});
