import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyScanVisualNormalization,
  computeScanVisualNormalization,
  parseScanMesh,
  parseScanSdf,
  parseScanVisualGlb,
  type ScanMesh,
  type ScanRig,
  type ScanSdfGrid,
  type ScanVisualMesh,
} from '../src/engine/body/ScanAvatar';
import {
  buildScanRigPoseGeometry,
  evaluateScanRigPose,
  type EvaluatedScanRigPose,
  type ScanRigPoseGeometry,
  type ScanRigPosePreset,
} from '../src/engine/body/ScanRigPose';
import { trianglesIntersect } from '../src/engine/geometry/MeshProximity';

function fileBuffer(relativePath: string): ArrayBuffer {
  const bytes = readFileSync(new URL(relativePath, import.meta.url));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function sampleGrid(
  grid: ScanSdfGrid,
  point: readonly [number, number, number],
): number {
  const [nx, ny, nz] = grid.dims;
  const dimensions = [nx, ny, nz] as const;
  const cell = dimensions.map(
    (count, axis) =>
      (grid.max[axis]! - grid.min[axis]!) / Math.max(1, count - 1),
  );
  const coordinate = point.map(
    (value, axis) => (value - grid.min[axis]!) / cell[axis]!,
  );
  if (
    coordinate.some(
      (value, axis) => value < 0 || value > dimensions[axis]! - 1,
    )
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const base = coordinate.map((value, axis) =>
    Math.min(dimensions[axis]! - 2, Math.floor(value)),
  );
  const fraction = coordinate.map((value, axis) => value - base[axis]!);
  const [x, y, z] = base;
  const [fx, fy, fz] = fraction;
  const at = (i: number, j: number, k: number): number =>
    grid.data[(k * ny + j) * nx + i]!;
  const mix = (a: number, b: number, amount: number): number =>
    a + (b - a) * amount;
  const x00 = mix(at(x!, y!, z!), at(x! + 1, y!, z!), fx!);
  const x10 = mix(at(x!, y! + 1, z!), at(x! + 1, y! + 1, z!), fx!);
  const x01 = mix(at(x!, y!, z! + 1), at(x! + 1, y!, z! + 1), fx!);
  const x11 = mix(
    at(x!, y! + 1, z! + 1),
    at(x! + 1, y! + 1, z! + 1),
    fx!,
  );
  return mix(mix(x00, x10, fy!), mix(x01, x11, fy!), fz!);
}

interface SewingFixture {
  proxy: ScanMesh;
  grid: ScanSdfGrid;
  visual: ScanVisualMesh;
  rig: ScanRig;
  pose: EvaluatedScanRigPose;
  geometry: ScanRigPoseGeometry;
}

interface VisualRigFixture {
  visual: ScanVisualMesh;
  rig: ScanRig;
  geometry: ScanRigPoseGeometry;
  normalization: ReturnType<typeof computeScanVisualNormalization>;
}

let visualRigCache: VisualRigFixture | null = null;
const fixtureCache = new Map<ScanRigPosePreset, SewingFixture>();

function visualRigFixture(): VisualRigFixture {
  if (visualRigCache) return visualRigCache;
  const parsed = parseScanVisualGlb(
    fileBuffer('../public/avatars/jericho.visual.glb'),
  );
  if (!parsed.rig) throw new Error('Neutral avatar pose certification requires its rig');
  const normalization = computeScanVisualNormalization(parsed.mesh, 1.83, Math.PI);
  const visual = applyScanVisualNormalization(parsed.mesh, normalization);
  visualRigCache = {
    visual,
    rig: parsed.rig,
    geometry: buildScanRigPoseGeometry(parsed.mesh, parsed.rig),
    normalization,
  };
  return visualRigCache;
}

function poseFixture(
  preset: Exclude<ScanRigPosePreset, 'native'>,
  suffix: string,
): SewingFixture {
  const cached = fixtureCache.get(preset);
  if (cached) return cached;
  const base = visualRigFixture();
  const fixture: SewingFixture = {
    proxy: parseScanMesh(
      fileBuffer(`../public/avatars/jericho.${suffix}.mesh.bin`),
    ),
    grid: parseScanSdf(
      fileBuffer(`../public/avatars/jericho.${suffix}.sdf.bin`),
    ),
    visual: base.visual,
    rig: base.rig,
    pose: evaluateScanRigPose(base.rig, base.normalization, preset),
    geometry: base.geometry,
  };
  fixtureCache.set(preset, fixture);
  return fixture;
}

function sewingFixture(): SewingFixture {
  return poseFixture('sewing-preview', 'sewing');
}

function aPoseFixture(): SewingFixture {
  return poseFixture('a-pose', 'apose');
}

function skinnedPoint(
  fixture: SewingFixture,
  vertex: number,
): [number, number, number] {
  const positionOffset = vertex * 3;
  const influenceOffset = vertex * 4;
  const x = fixture.visual.positions[positionOffset]!;
  const y = fixture.visual.positions[positionOffset + 1]!;
  const z = fixture.visual.positions[positionOffset + 2]!;
  const result: [number, number, number] = [0, 0, 0];
  for (let influence = 0; influence < 4; influence++) {
    const weight = fixture.geometry.jointWeights[influenceOffset + influence]!;
    if (weight <= 0) continue;
    const matrixOffset =
      fixture.geometry.jointIndices[influenceOffset + influence]! * 16;
    const matrix = fixture.pose.jointMatrices;
    result[0] +=
      weight *
      (matrix[matrixOffset]! * x +
        matrix[matrixOffset + 4]! * y +
        matrix[matrixOffset + 8]! * z +
        matrix[matrixOffset + 12]!);
    result[1] +=
      weight *
      (matrix[matrixOffset + 1]! * x +
        matrix[matrixOffset + 5]! * y +
        matrix[matrixOffset + 9]! * z +
        matrix[matrixOffset + 13]!);
    result[2] +=
      weight *
      (matrix[matrixOffset + 2]! * x +
        matrix[matrixOffset + 6]! * y +
        matrix[matrixOffset + 10]! * z +
        matrix[matrixOffset + 14]!);
  }
  return result;
}

function skinnedPositions(fixture: SewingFixture): Float32Array {
  const positions = new Float32Array(fixture.visual.positions.length);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    positions.set(skinnedPoint(fixture, vertex), vertex * 3);
  }
  return positions;
}

function triangleArea(
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  const aOffset = a * 3;
  const bOffset = b * 3;
  const cOffset = c * 3;
  const abX = positions[bOffset]! - positions[aOffset]!;
  const abY = positions[bOffset + 1]! - positions[aOffset + 1]!;
  const abZ = positions[bOffset + 2]! - positions[aOffset + 2]!;
  const acX = positions[cOffset]! - positions[aOffset]!;
  const acY = positions[cOffset + 1]! - positions[aOffset + 1]!;
  const acZ = positions[cOffset + 2]! - positions[aOffset + 2]!;
  return Math.hypot(
    abY * acZ - abZ * acY,
    abZ * acX - abX * acZ,
    abX * acY - abY * acX,
  ) * 0.5;
}

function distortionRange(
  rest: ArrayLike<number>,
  posed: ArrayLike<number>,
  indices: Uint32Array,
): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!;
    const b = indices[offset + 1]!;
    const c = indices[offset + 2]!;
    const restArea = triangleArea(rest, a, b, c);
    if (!(restArea > 1e-12)) throw new Error(`Degenerate neutral-avatar triangle ${offset / 3}`);
    const ratio = triangleArea(posed, a, b, c) / restArea;
    minimum = Math.min(minimum, ratio);
    maximum = Math.max(maximum, ratio);
  }
  return { minimum, maximum };
}

interface TriangleAuditRecord {
  vertices: readonly [number, number, number];
  points: readonly [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
}

function selfIntersectionCount(
  positions: ArrayLike<number>,
  indices: Uint32Array,
): number {
  const point = (vertex: number): [number, number, number] => {
    const offset = vertex * 3;
    return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
  };
  const triangles: TriangleAuditRecord[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const vertices: [number, number, number] = [
      indices[offset]!,
      indices[offset + 1]!,
      indices[offset + 2]!,
    ];
    triangles.push({
      vertices,
      points: [point(vertices[0]), point(vertices[1]), point(vertices[2])],
    });
  }
  let intersections = 0;
  for (let firstIndex = 0; firstIndex < triangles.length; firstIndex++) {
    const first = triangles[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < triangles.length; secondIndex++) {
      const second = triangles[secondIndex]!;
      if (first.vertices.some((vertex) => second.vertices.includes(vertex))) continue;
      if (trianglesIntersect(
        first.points[0],
        first.points[1],
        first.points[2],
        second.points[0],
        second.points[1],
        second.points[2],
        1e-9,
      )) {
        intersections++;
      }
    }
  }
  return intersections;
}

describe('collisions certifiees des poses de conception de l avatar neutre', () => {
  it('livre une grille WebGPU precise et un proxy ferme', () => {
    for (const fixture of [aPoseFixture(), sewingFixture()]) {
    const { proxy, grid } = fixture;
    const cellSizes = grid.dims.map(
      (count, axis) =>
        (grid.max[axis]! - grid.min[axis]!) / Math.max(1, count - 1),
    );
    expect(grid.dims.every((dimension) => dimension <= 256)).toBe(true);
    expect(Math.max(...cellSizes) * 1000).toBeLessThanOrEqual(7.75);
    let minimumGridDistance = Number.POSITIVE_INFINITY;
    let maximumGridDistance = Number.NEGATIVE_INFINITY;
    for (const distance of grid.data) {
      minimumGridDistance = Math.min(minimumGridDistance, distance);
      maximumGridDistance = Math.max(maximumGridDistance, distance);
    }
    expect(minimumGridDistance).toBeLessThan(-0.02);
    expect(maximumGridDistance).toBeGreaterThan(0.04);

    const vertexCount = proxy.positions.length / 3;
    expect(proxy.indices.length / 3).toBe(1_766);
    const edgeCounts = new Map<number, number>();
    const countEdge = (first: number, second: number): void => {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const key = low * vertexCount + high;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    };
    let maximumSurfaceDistance = Number.NEGATIVE_INFINITY;
    let minimumSurfaceDistance = Number.POSITIVE_INFINITY;
    let degenerateTriangles = 0;
    for (let offset = 0; offset < proxy.indices.length; offset += 3) {
      const a = proxy.indices[offset]!;
      const b = proxy.indices[offset + 1]!;
      const c = proxy.indices[offset + 2]!;
      if (a === b || b === c || c === a) degenerateTriangles++;
      countEdge(a, b);
      countEdge(b, c);
      countEdge(c, a);
    }
    let nonManifoldEdges = 0;
    for (const count of edgeCounts.values()) {
      if (count !== 2) nonManifoldEdges++;
    }
    expect(degenerateTriangles).toBe(0);
    expect(nonManifoldEdges).toBe(0);
    expect(edgeCounts.size).toBe(proxy.indices.length / 2);

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const offset = vertex * 3;
      const distance = sampleGrid(grid, [
        proxy.positions[offset]!,
        proxy.positions[offset + 1]!,
        proxy.positions[offset + 2]!,
      ]);
      maximumSurfaceDistance = Math.max(maximumSurfaceDistance, distance);
      minimumSurfaceDistance = Math.min(minimumSurfaceDistance, distance);
    }
    expect(maximumSurfaceDistance * 1000).toBeLessThanOrEqual(2.5);
    // A negative value is conservative (the collision is very slightly
    // outside the proxy), and remains within one 7 mm SDF cell.
    expect(minimumSurfaceDistance * 1000).toBeGreaterThanOrEqual(-7);
    }
  });

  it('enveloppe exactement le visuel skinne et ne conserve pas les bras natifs fantomes', () => {
    for (const fixture of [aPoseFixture(), sewingFixture()]) {
    const vertexCount = fixture.visual.positions.length / 3;
    const armOrdinal = new Uint8Array(fixture.rig.skin.joints.length);
    for (let ordinal = 0; ordinal < fixture.rig.skin.joints.length; ordinal++) {
      const node = fixture.rig.nodes[fixture.rig.skin.joints[ordinal]!]!;
      if (/^(?:L|R)_(?:Clavicle|Upperarm|Forearm|Hand)/.test(node.name)) {
        armOrdinal[ordinal] = 1;
      }
    }

    let maximumPosedDistance = Number.NEGATIVE_INFINITY;
    let movedArmSamples = 0;
    let nativeArmInside = 0;
    let posedArmCovered = 0;
    const nativeArmDistances: number[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const posed = skinnedPoint(fixture, vertex);
      const posedDistance = sampleGrid(fixture.grid, posed);
      maximumPosedDistance = Math.max(maximumPosedDistance, posedDistance);

      // Avec seulement 885 sommets, verifier chaque point du bras reste peu
      // couteux et evite qu un sous-echantillonnage masque un pli local.
      const influenceOffset = vertex * 4;
      let armWeight = 0;
      for (let influence = 0; influence < 4; influence++) {
        const ordinal = fixture.geometry.jointIndices[influenceOffset + influence]!;
        if (armOrdinal[ordinal]) {
          armWeight += fixture.geometry.jointWeights[influenceOffset + influence]!;
        }
      }
      if (armWeight < 0.9) continue;
      const positionOffset = vertex * 3;
      const native: [number, number, number] = [
        fixture.visual.positions[positionOffset]!,
        fixture.visual.positions[positionOffset + 1]!,
        fixture.visual.positions[positionOffset + 2]!,
      ];
      if (
        Math.hypot(
          posed[0] - native[0],
          posed[1] - native[1],
          posed[2] - native[2],
        ) <= 0.15
      ) {
        continue;
      }
      const nativeDistance = sampleGrid(fixture.grid, native);
      movedArmSamples++;
      nativeArmDistances.push(nativeDistance);
      if (nativeDistance < 0) nativeArmInside++;
      if (posedDistance <= 0.0025) posedArmCovered++;
    }

    expect(maximumPosedDistance * 1000).toBeLessThanOrEqual(2.5);
    expect(movedArmSamples).toBeGreaterThan(150);
    // Les sommets sont sur la surface du proxy : une distance positive sous
    // 2,5 mm reste dans la tolerance SDF certifiee juste au-dessus.
    expect(posedArmCovered / movedArmSamples).toBeGreaterThan(0.99);
    expect(nativeArmInside / movedArmSamples).toBeLessThan(0.1);
    nativeArmDistances.sort((a, b) => a - b);
    expect(nativeArmDistances[Math.floor(nativeArmDistances.length / 2)]! * 1000)
      .toBeGreaterThan(30);
    }
  }, 60_000);

  it('borne la distorsion et exclut toute auto-intersection en poses A et T', () => {
    const cases = [
      { fixture: aPoseFixture(), minimum: 0.38, maximum: 1.53, strictMaximum: false },
      { fixture: sewingFixture(), minimum: 0.40, maximum: 2.0, strictMaximum: true },
    ];
    for (const certification of cases) {
      const { fixture } = certification;
      expect(fixture.visual.positions.length / 3).toBe(885);
      expect(fixture.geometry.indices.length / 3).toBe(1_766);
      expect(fixture.geometry.detachedTriangleCount).toBe(0);
      expect(fixture.geometry.hardenedVertexCount).toBe(0);

      const posed = skinnedPositions(fixture);
      const range = distortionRange(
        fixture.visual.positions,
        posed,
        fixture.geometry.indices,
      );
      expect(range.minimum).toBeGreaterThanOrEqual(certification.minimum);
      if (certification.strictMaximum) {
        expect(range.maximum).toBeLessThan(certification.maximum);
      } else {
        expect(range.maximum).toBeLessThanOrEqual(certification.maximum);
      }
      expect(selfIntersectionCount(posed, fixture.geometry.indices)).toBe(0);
    }
  }, 60_000);
});
