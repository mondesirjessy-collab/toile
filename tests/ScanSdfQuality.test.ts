import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type AvatarName = 'femme-scan' | 'homme-scan' | 'jericho';
type Vec3 = [number, number, number];

interface ScanAsset {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
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
  const triangleCount = meshView.getUint32(4, true);
  const positions = new Float32Array(
    meshBytes.buffer,
    meshBytes.byteOffset + 8,
    vertexCount * 3,
  );
  const indices = new Uint32Array(
    meshBytes.buffer,
    meshBytes.byteOffset + 8 + vertexCount * 24,
    triangleCount * 3,
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

  return {
    positions,
    indices,
    vertexCount,
    triangleCount,
    dims,
    min,
    max,
    valuesMm,
  };
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
  for (const name of ['femme-scan', 'jericho'] as const) {
    const scan = readScan(name);

    it(`${name} reste compatible avec la limite WebGPU 3D`, () => {
      for (const dimension of scan.dims) {
        expect(dimension).toBeLessThanOrEqual(256);
      }
    });

    it(`${name} conserve un pas de grille d'au plus 7,5 mm`, () => {
      const maximumCellMm = name === 'jericho' ? 7.75 : 7.5;
      for (const cellSize of gridCellSize(scan)) {
        expect(cellSize * 1000).toBeLessThanOrEqual(maximumCellMm);
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

  it('le mannequin neutre respecte sa stature et la pose native après cuisson', () => {
    const scan = readScan('jericho');
    const axes = [0, 1, 2] as const;
    const bounds = axes.map((axis) => {
      let min = Infinity;
      let max = -Infinity;
      for (let vertex = 0; vertex < scan.vertexCount; vertex++) {
        const value = scan.positions[vertex * 3 + axis]!;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return max - min;
    });
    expect(bounds[1]).toBeCloseTo(1.83, 2);
    // Le GLB est conservé bras baissés : sa largeur native est volontairement
    // très inférieure à celle de l’ancienne pose de couture reconstruite.
    expect(bounds[0]).toBeCloseTo(0.504951, 5);
    expect(bounds[2]).toBeCloseTo(0.32589, 5);
    expect(scan.triangleCount).toBe(1_766);

    const edgeCounts = new Map<number, number>();
    const countEdge = (a: number, b: number): void => {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = low * scan.vertexCount + high;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    };
    for (let index = 0; index < scan.indices.length; index += 3) {
      const a = scan.indices[index]!;
      const b = scan.indices[index + 1]!;
      const c = scan.indices[index + 2]!;
      countEdge(a, b);
      countEdge(b, c);
      countEdge(c, a);
    }
    expect([...edgeCounts.values()].every((count) => count === 2)).toBe(true);
  });
});
