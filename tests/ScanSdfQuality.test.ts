import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type AvatarName = 'femme-scan' | 'homme-scan';
type Vec3 = [number, number, number];

interface ScanAsset {
  positions: Float32Array;
  vertexCount: number;
  dims: Vec3;
  min: Vec3;
  max: Vec3;
  valuesMm: Int16Array;
}

function readScan(name: AvatarName): ScanAsset {
  const meshBytes = readFileSync(
    new URL(`../public/avatars/${name}.mesh.bin`, import.meta.url),
  );
  const meshView = new DataView(
    meshBytes.buffer,
    meshBytes.byteOffset,
    meshBytes.byteLength,
  );
  const vertexCount = meshView.getUint32(0, true);
  const positions = new Float32Array(
    meshBytes.buffer,
    meshBytes.byteOffset + 8,
    vertexCount * 3,
  );

  const sdfBytes = readFileSync(
    new URL(`../public/avatars/${name}.sdf.bin`, import.meta.url),
  );
  const sdfView = new DataView(
    sdfBytes.buffer,
    sdfBytes.byteOffset,
    sdfBytes.byteLength,
  );
  const dims: Vec3 = [
    sdfView.getUint32(0, true),
    sdfView.getUint32(4, true),
    sdfView.getUint32(8, true),
  ];
  const min: Vec3 = [
    sdfView.getFloat32(12, true),
    sdfView.getFloat32(16, true),
    sdfView.getFloat32(20, true),
  ];
  const max: Vec3 = [
    sdfView.getFloat32(24, true),
    sdfView.getFloat32(28, true),
    sdfView.getFloat32(32, true),
  ];
  const valuesMm = new Int16Array(
    sdfBytes.buffer,
    sdfBytes.byteOffset + 36,
    dims[0] * dims[1] * dims[2],
  );

  return { positions, vertexCount, dims, min, max, valuesMm };
}

function gridCellSize(scan: ScanAsset): Vec3 {
  return scan.dims.map(
    (count, axis) =>
      (scan.max[axis]! - scan.min[axis]!) / Math.max(1, count - 1),
  ) as Vec3;
}

function sampleSdf(scan: ScanAsset, position: Vec3): number {
  const cell = gridCellSize(scan);
  const grid = position.map((coordinate, axis) => {
    const unbounded = (coordinate - scan.min[axis]!) / cell[axis]!;
    return Math.max(0, Math.min(scan.dims[axis]! - 1, unbounded));
  }) as Vec3;
  const base = grid.map((coordinate, axis) =>
    Math.min(scan.dims[axis]! - 2, Math.floor(coordinate)),
  ) as Vec3;
  const fraction = grid.map(
    (coordinate, axis) => coordinate - base[axis]!,
  ) as Vec3;
  const [nx, ny] = scan.dims;
  const at = (x: number, y: number, z: number): number =>
    scan.valuesMm[(z * ny + y) * nx + x]! / 1000;
  const mix = (a: number, b: number, t: number): number =>
    a + (b - a) * t;
  const [x, y, z] = base;
  const [fx, fy, fz] = fraction;
  const x00 = mix(at(x, y, z), at(x + 1, y, z), fx);
  const x10 = mix(at(x, y + 1, z), at(x + 1, y + 1, z), fx);
  const x01 = mix(at(x, y, z + 1), at(x + 1, y, z + 1), fx);
  const x11 = mix(
    at(x, y + 1, z + 1),
    at(x + 1, y + 1, z + 1),
    fx,
  );
  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
}

describe('qualite des SDF des avatars scannes', () => {
  for (const name of ['femme-scan', 'homme-scan'] as const) {
    const scan = readScan(name);

    it(`${name} reste compatible avec la limite WebGPU 3D`, () => {
      for (const dimension of scan.dims) {
        expect(dimension).toBeLessThanOrEqual(256);
      }
    });

    it(`${name} conserve un pas de grille d'au plus 7,5 mm`, () => {
      for (const cellSize of gridCellSize(scan)) {
        expect(cellSize * 1000).toBeLessThanOrEqual(7.5);
      }
    });

    it(`${name} enveloppe le mesh visible avec une erreur positive d'au plus 2,5 mm`, () => {
      let maximumDistance = -Infinity;
      let verticesOverTolerance = 0;
      for (let vertex = 0; vertex < scan.vertexCount; vertex++) {
        const distance = sampleSdf(scan, [
          scan.positions[vertex * 3]!,
          scan.positions[vertex * 3 + 1]!,
          scan.positions[vertex * 3 + 2]!,
        ]);
        maximumDistance = Math.max(maximumDistance, distance);
        if (distance > 0.0025) verticesOverTolerance++;
      }

      expect(verticesOverTolerance).toBe(0);
      expect(maximumDistance * 1000).toBeLessThanOrEqual(2.5);
    });
  }
});
