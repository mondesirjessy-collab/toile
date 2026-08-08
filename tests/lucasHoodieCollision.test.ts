import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gridSd, measureBody } from '../src/engine/body/measure';
import { buildLucasHoodieMesh } from '../src/engine/pattern/LucasHoodieAssembly';
import { lucasHoodie } from '../src/engine/pattern/lucasHoodie';

function scan(name: 'femme-scan' | 'jericho') {
  const raw = readFileSync(
    new URL(`../public/avatars/${name}.sdf.bin`, import.meta.url),
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
  const millimetres = new Int16Array(
    raw.buffer,
    raw.byteOffset + 36,
    dims[0] * dims[1] * dims[2],
  );
  return {
    dims,
    min,
    max,
    data: Float32Array.from(millimetres, (value) => value / 1000),
  };
}

describe('Lucas Hoodie — collision réelle des manches et de la capuche', () => {
  for (const name of ['femme-scan', 'jericho'] as const) {
    it(`prépare les manches hors du ${name}`, () => {
      const grid = scan(name);
      const sd = gridSd(grid);
      const body = measureBody(sd, grid.max[1] - 0.06);
      if (name === 'jericho') {
        // The neutral GLB stays in its native arms-down pose. The
        // specialised hoodie assembler must use its vertical-arm fallback,
        // never invent an A-pose measurement.
        expect(body.arm).toBeUndefined();
      } else {
        expect(body.arm?.path?.length ?? 0).toBeGreaterThan(8);
      }

      const built = buildLucasHoodieMesh(
        lucasHoodie('S', body),
        64,
        body,
        sd,
      );
      const armRanges = built.ranges.filter(
        (range) => range.pieceId === 2 || range.pieceId === 5,
      );
      let minimumDistance = Infinity;
      let liveParticles = 0;
      for (const range of armRanges) {
        for (
          let particle = range.first;
          particle < range.first + range.count;
          particle++
        ) {
          if (built.mesh.invMasses[particle]! <= 0) continue;
          liveParticles++;
          minimumDistance = Math.min(
            minimumDistance,
            sd(
              built.mesh.positions[particle * 4]!,
              built.mesh.positions[particle * 4 + 1]!,
              built.mesh.positions[particle * 4 + 2]!,
            ),
          );
        }
      }

      expect(liveParticles).toBeGreaterThan(10_000);
      // Maille uses a 6 mm collision thickness. The pre-dressing pose adds a
      // 2 mm safety margin so the first GPU step cannot choose the wrong side.
      expect(minimumDistance).toBeGreaterThanOrEqual(0.008);

      const hoodRanges = built.ranges.filter(
        (range) => range.pieceId === 3,
      );
      expect(hoodRanges).toHaveLength(2);
      const isHoodParticle = (particle: number): boolean =>
        hoodRanges.some(
          (range) =>
            particle >= range.first && particle < range.first + range.count,
        );
      let hoodLiveParticles = 0;
      let hoodDressingAnchors = 0;
      let minimumHoodVertexDistance = Infinity;
      let maximumHoodLayer = 0;
      for (const range of hoodRanges) {
        for (
          let particle = range.first;
          particle < range.first + range.count;
          particle++
        ) {
          if (built.mesh.invMasses[particle]! <= 0) continue;
          hoodLiveParticles++;
          minimumHoodVertexDistance = Math.min(
            minimumHoodVertexDistance,
            sd(
              built.mesh.positions[particle * 4]!,
              built.mesh.positions[particle * 4 + 1]!,
              built.mesh.positions[particle * 4 + 2]!,
            ),
          );
          maximumHoodLayer = Math.max(
            maximumHoodLayer,
            built.mesh.layers?.[particle] ?? 0,
          );
          const anchor = built.mesh.anchorY?.[particle] ?? -1e9;
          if (anchor > -1e8) {
            hoodDressingAnchors++;
            expect(Math.abs(built.mesh.positions[particle * 4]!)).toBeLessThan(
              1e-5,
            );
            expect(anchor).toBeGreaterThan(body.neckY + 0.035);
          }
        }
      }
      expect(hoodLiveParticles).toBeGreaterThan(6_000);
      expect(hoodDressingAnchors).toBeGreaterThan(10);
      expect(hoodDressingAnchors).toBeLessThan(hoodLiveParticles * 0.03);
      expect(minimumHoodVertexDistance).toBeGreaterThanOrEqual(0.0075);
      expect(maximumHoodLayer).toBeGreaterThanOrEqual(0.99);

      const position = (particle: number): [number, number, number] => [
        built.mesh.positions[particle * 4]!,
        built.mesh.positions[particle * 4 + 1]!,
        built.mesh.positions[particle * 4 + 2]!,
      ];
      let minimumHoodSurfaceDistance = Infinity;
      for (
        let index = 0;
        index < built.mesh.triangleIndices.length;
        index += 3
      ) {
        const particles = [
          built.mesh.triangleIndices[index]!,
          built.mesh.triangleIndices[index + 1]!,
          built.mesh.triangleIndices[index + 2]!,
        ];
        if (!particles.every(isHoodParticle)) continue;
        const points = particles.map(position);
        const samples: Array<[number, number, number]> = [
          [
            (points[0]![0] + points[1]![0]) / 2,
            (points[0]![1] + points[1]![1]) / 2,
            (points[0]![2] + points[1]![2]) / 2,
          ],
          [
            (points[1]![0] + points[2]![0]) / 2,
            (points[1]![1] + points[2]![1]) / 2,
            (points[1]![2] + points[2]![2]) / 2,
          ],
          [
            (points[2]![0] + points[0]![0]) / 2,
            (points[2]![1] + points[0]![1]) / 2,
            (points[2]![2] + points[0]![2]) / 2,
          ],
          [
            (points[0]![0] + points[1]![0] + points[2]![0]) / 3,
            (points[0]![1] + points[1]![1] + points[2]![1]) / 3,
            (points[0]![2] + points[1]![2] + points[2]![2]) / 3,
          ],
        ];
        for (const sample of samples) {
          minimumHoodSurfaceDistance = Math.min(
            minimumHoodSurfaceDistance,
            sd(sample[0], sample[1], sample[2]),
          );
        }
      }
      // This catches the former false positive where every vertex was outside
      // but more than 220 long triangle chords still crossed the head.
      expect(minimumHoodSurfaceDistance).toBeGreaterThanOrEqual(0.0065);

      const constraints = new DataView(built.mesh.constraintData);
      let maximumHoodEdgeRatio = 0;
      let maximumNeckSeamSpan = 0;
      for (let index = 0; index < built.mesh.constraintCount; index++) {
        const offset = index * 16;
        const a = constraints.getUint32(offset, true);
        const b = constraints.getUint32(offset + 4, true);
        const rest = constraints.getFloat32(offset + 8, true);
        const kind = constraints.getUint32(offset + 12, true);
        const pointA = position(a);
        const pointB = position(b);
        const length = Math.hypot(
          pointB[0] - pointA[0],
          pointB[1] - pointA[1],
          pointB[2] - pointA[2],
        );
        if (kind !== 3 && kind !== 5 && isHoodParticle(a) && isHoodParticle(b)) {
          maximumHoodEdgeRatio = Math.max(
            maximumHoodEdgeRatio,
            length / Math.max(1e-9, rest),
          );
        }
        if (kind === 3 && isHoodParticle(a) !== isHoodParticle(b)) {
          maximumNeckSeamSpan = Math.max(maximumNeckSeamSpan, length);
        }
      }
      expect(maximumHoodEdgeRatio).toBeLessThan(5);
      // The rasterised hood edge has more cells than the body neckline. Its
      // distributed ease starts below 8.2 cm, including the quantisation of
      // the nearest body cell on the 7 mm SDF/raster grid (formerly 15 cm),
      // and the 2.5 s progressive stitch pass closes it without an impact.
      expect(maximumNeckSeamSpan).toBeLessThan(0.082);

      for (const [panel, range] of hoodRanges.entries()) {
        for (
          let particle = range.first;
          particle < range.first + range.count;
          particle++
        ) {
          if (built.mesh.invMasses[particle]! <= 0) continue;
          const x = built.mesh.positions[particle * 4]!;
          expect(panel === 0 ? x : -x).toBeLessThanOrEqual(1e-6);
        }
      }
    }, 30_000);
  }
});
