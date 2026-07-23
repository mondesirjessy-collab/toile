import { describe, expect, it } from 'vitest';
import {
  MeshProximity,
  inverseRotateY,
  trianglesIntersect,
  type Vec3,
} from '../src/engine/geometry/MeshProximity';

const cubePositions = new Float32Array([
  -1, -1, -1,
   1, -1, -1,
   1,  1, -1,
  -1,  1, -1,
  -1, -1,  1,
   1, -1,  1,
   1,  1,  1,
  -1,  1,  1,
]);

// Consistent outward winding, with shared edges (closed manifold).
const cubeIndices = new Uint32Array([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5,
]);

function appendCube(
  positions: number[],
  indices: number[],
  centerX: number,
  flipPositiveXFace = false,
): void {
  const vertexOffset = positions.length / 3;
  for (let offset = 0; offset < cubePositions.length; offset += 3) {
    positions.push(
      cubePositions[offset]! + centerX,
      cubePositions[offset + 1]!,
      cubePositions[offset + 2]!,
    );
  }
  for (let offset = 0; offset < cubeIndices.length; offset += 3) {
    const a = cubeIndices[offset]!;
    const b = cubeIndices[offset + 1]!;
    const c = cubeIndices[offset + 2]!;
    const positiveXFace = (a === 1 || a === 2 || a === 6 || a === 5)
      && (b === 1 || b === 2 || b === 6 || b === 5)
      && (c === 1 || c === 2 || c === 6 || c === 5);
    indices.push(
      vertexOffset + a,
      vertexOffset + (flipPositiveXFace && positiveXFace ? c : b),
      vertexOffset + (flipPositiveXFace && positiveXFace ? b : c),
    );
  }
}

function rotateY(point: Vec3, radians: number): Vec3 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [cosine * point[0] + sine * point[2], point[1], -sine * point[0] + cosine * point[2]];
}

describe('MeshProximity', () => {
  it('mesure sans clamp et signe correctement un cube fermé', () => {
    const mesh = new MeshProximity({ positions: cubePositions, indices: cubeIndices });
    expect(mesh.closed).toBe(true);

    const inside = mesh.closestPoint([0, 0, 0]);
    expect(inside.inside).toBe(true);
    expect(inside.signedDistance).toBeCloseTo(-1, 10);

    const outside = mesh.closestPoint([1.25, 0.2, -0.1]);
    expect(outside.inside).toBe(false);
    expect(outside.signedDistance).toBeCloseTo(0.25, 10);
    expect(outside.point[0]).toBeCloseTo(1, 12);
    expect(outside.point[1]).toBeCloseTo(0.2, 12);
    expect(outside.point[2]).toBeCloseTo(-0.1, 12);

    // A deliberately distant point proves that this is not an SDF band value.
    expect(mesh.signedDistance([21, 0, 0])).toBeCloseTo(20, 10);
  });

  it('vérifie par parité un faux négatif de pseudo-normale sur un maillage fermé', () => {
    // The sample lies in the empty space between two closed components and
    // remains inside their combined AABB.  Reversing the nearby +X patch makes
    // its pseudo-normal claim a 20 cm penetration; ray parity must reject it.
    const positions: number[] = [];
    const indices: number[] = [];
    appendCube(positions, indices, -2, true);
    appendCube(positions, indices, 2);
    const mesh = new MeshProximity({
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    });
    expect(mesh.closed).toBe(true);

    const betweenComponents = mesh.closestPoint([-0.8, 0.2, -0.1]);
    expect(betweenComponents.inside).toBe(false);
    expect(betweenComponents.signedDistance).toBeCloseTo(0.2, 10);

    // The robust containment check must not hide genuine interior samples.
    const insideLeftCube = mesh.closestPoint([-2, 0.2, -0.1]);
    expect(insideLeftCube.inside).toBe(true);
    expect(insideLeftCube.signedDistance).toBeCloseTo(-0.8, 10);
  });

  it('distingue exactement des écarts de plaque de 5 mm et 2 mm', () => {
    const plate = new MeshProximity({
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    });
    expect(plate.closed).toBe(false);
    expect(plate.signedDistance([0, 0.005, 0])).toBeCloseTo(0.005, 12);
    expect(plate.signedDistance([0, 0.002, 0])).toBeCloseTo(0.002, 12);
    expect(plate.signedDistance([0, -0.005, 0])).toBeCloseTo(-0.005, 12);
  });

  it('détecte deux triangles croisés même si aucun sommet ne touche l’autre', () => {
    const horizontal: [Vec3, Vec3, Vec3] = [
      [-2, 0, -2], [2, 0, -2], [0, 0, 2],
    ];
    const vertical: [Vec3, Vec3, Vec3] = [
      [0, -2, -1], [0, 2, -1], [0, 0, 1.5],
    ];
    expect(trianglesIntersect(...horizontal, ...vertical)).toBe(true);

    const mesh = new MeshProximity({
      positions: new Float32Array(horizontal.flat()),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(mesh.intersectsTriangle(...vertical)).toBe(true);
    expect(mesh.intersectingTriangles(...vertical)).toEqual([0]);
  });

  it('est invariant par rotation Y et fournit la transformation inverse', () => {
    const angle = Math.PI * 0.37;
    const rotatedPositions = new Float32Array(cubePositions.length);
    for (let offset = 0; offset < cubePositions.length; offset += 3) {
      const rotated = rotateY([
        cubePositions[offset]!, cubePositions[offset + 1]!, cubePositions[offset + 2]!,
      ], angle);
      rotatedPositions.set(rotated, offset);
    }
    const original = new MeshProximity({ positions: cubePositions, indices: cubeIndices });
    const rotated = new MeshProximity({ positions: rotatedPositions, indices: cubeIndices });
    const point: Vec3 = [1.8, 0.27, -0.31];
    expect(rotated.signedDistance(rotateY(point, angle))).toBeCloseTo(original.signedDistance(point), 6);
    const restored = inverseRotateY(rotateY(point, angle), angle);
    expect(restored[0]).toBeCloseTo(point[0], 12);
    expect(restored[1]).toBeCloseTo(point[1], 12);
    expect(restored[2]).toBeCloseTo(point[2], 12);
  });

  it('accepte directement les positions et normales intercalées du rendu', () => {
    const interleaved = new Float32Array([
      0, 0, 0, 0, 1, 0, 9, 9, 9,
      1, 0, 0, 0, 1, 0, 9, 9, 9,
      0, 0, 1, 0, 1, 0, 9, 9, 9,
    ]);
    const mesh = new MeshProximity({
      positions: interleaved,
      normals: interleaved,
      indices: new Uint32Array([0, 2, 1]),
      positionStride: 9,
      normalStride: 9,
      normalOffset: 3,
    });
    expect(mesh.signedDistance([0.2, 0.005, 0.2])).toBeCloseTo(0.005, 12);
    expect(mesh.closestPoint([0.2, 0.005, 0.2]).normal).toEqual([0, 1, 0]);
  });
});
