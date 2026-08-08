import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeScanVisualNormalization,
  parseScanVisualGlb,
} from '../src/engine/body/ScanAvatar';
import {
  evaluateScanRigPose,
  transformScanRigPoint,
} from '../src/engine/body/ScanRigPose';

const bytes = readFileSync(
  new URL('../public/avatars/jericho.visual.glb', import.meta.url),
);
const parsed = parseScanVisualGlb(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
);
if (!parsed.rig) throw new Error('neutral avatar anatomy certification requires its rig');
const rig = parsed.rig;
const normalization = computeScanVisualNormalization(parsed.mesh, 1.83, Math.PI);
const native = evaluateScanRigPose(rig, normalization, 'native');
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd()) as {
  asset?: {
    extras?: {
      toile?: {
        sourceSha256?: string;
        rigVersion?: number;
        sourceTopologyPreserved?: boolean;
        axillaryRepair?: {
          movedVertices?: number;
          sourceSelfIntersections?: number;
          repairedSelfIntersections?: number;
        };
      };
    };
  };
};

function point(name: string): [number, number, number] {
  const node = rig.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`missing neutral avatar joint ${name}`);
  const matrix = native.nodeWorldMatrices.subarray(node.index * 16, node.index * 16 + 16);
  return transformScanRigPoint(normalization.matrix, [
    matrix[12]!,
    matrix[13]!,
    matrix[14]!,
  ]);
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

describe('anatomie et réparation du mannequin neutre', () => {
  it('trace la source et la réparation axillaire déterministes', () => {
    expect(gltf.asset?.extras?.toile).toEqual({
      sourceSha256: 'a107dfc848f75ecb3d5b0c2e839da70cd9b32a60daeb91e494fe2a0708738057',
      rigVersion: 2,
      sourceTopologyPreserved: true,
      axillaryRepair: {
        movedVertices: 25,
        sourceSelfIntersections: 18,
        repairedSelfIntersections: 0,
      },
      statureM: 1.83,
    });
  });

  it('centre le squelette sur un axe anatomique unique', () => {
    const axis = point('Hip')[0];
    // Le viewport centre l’AABB complet, dont les doigts sont légèrement
    // asymétriques. L’axe anatomique peut donc être décalé dans le monde,
    // mais le tronc et toutes les paires doivent partager exactement cet axe.
    for (const name of [
      'Hip',
      'Pelvis',
      'Waist',
      'Spine01',
      'Spine02',
      'NeckTwist01',
      'NeckTwist02',
      'Head',
    ]) {
      expect(Math.abs(point(name)[0] - axis)).toBeLessThan(0.0001);
    }

    for (const suffix of [
      'Clavicle',
      'Upperarm',
      'Forearm',
      'Hand',
      'Thigh',
      'Calf',
      'Foot',
      'ToeBase',
    ]) {
      const left = point(`L_${suffix}`);
      const right = point(`R_${suffix}`);
      expect(Math.abs((left[0] + right[0]) * 0.5 - axis)).toBeLessThan(0.0001);
      expect(Math.abs(left[1] - right[1])).toBeLessThan(0.0001);
      expect(Math.abs(left[2] - right[2])).toBeLessThan(0.0001);
    }
  });

  it('donne aux deux bras les mêmes longueurs humaines', () => {
    const lengths = (side: 'L' | 'R') => ({
      upper: distance(point(`${side}_Upperarm`), point(`${side}_Forearm`)),
      forearm: distance(point(`${side}_Forearm`), point(`${side}_Hand`)),
    });
    const left = lengths('L');
    const right = lengths('R');
    expect(left.upper).toBeCloseTo(0.3228535087, 5);
    expect(right.upper).toBeCloseTo(0.3228535087, 5);
    expect(left.forearm).toBeCloseTo(0.3115367193, 5);
    expect(right.forearm).toBeCloseTo(0.3115367193, 5);
    expect(Math.abs(left.upper - right.upper)).toBeLessThan(0.0001);
    expect(Math.abs(left.forearm - right.forearm)).toBeLessThan(0.0001);
  });

  it('conserve un bind natif strictement neutre après le recentrage', () => {
    for (let joint = 0; joint < rig.skin.joints.length; joint++) {
      const matrix = native.jointMatrices.subarray(joint * 16, joint * 16 + 16);
      for (let item = 0; item < 16; item++) {
        expect(matrix[item]).toBe(item % 5 === 0 ? 1 : 0);
      }
    }
  });

  it('livre une topologie sans triangle dégénéré et des normales régénérées', () => {
    const { positions, indices, normals } = parsed.mesh;
    const regenerated = new Float32Array(normals.length);
    let minimumDoubleArea = Infinity;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const first = indices[offset]! * 3;
      const second = indices[offset + 1]! * 3;
      const third = indices[offset + 2]! * 3;
      const abX = positions[second]! - positions[first]!;
      const abY = positions[second + 1]! - positions[first + 1]!;
      const abZ = positions[second + 2]! - positions[first + 2]!;
      const acX = positions[third]! - positions[first]!;
      const acY = positions[third + 1]! - positions[first + 1]!;
      const acZ = positions[third + 2]! - positions[first + 2]!;
      const normalX = abY * acZ - abZ * acY;
      const normalY = abZ * acX - abX * acZ;
      const normalZ = abX * acY - abY * acX;
      minimumDoubleArea = Math.min(
        minimumDoubleArea,
        Math.hypot(normalX, normalY, normalZ),
      );
      for (const vertex of [first, second, third]) {
        regenerated[vertex] += normalX;
        regenerated[vertex + 1] += normalY;
        regenerated[vertex + 2] += normalZ;
      }
    }
    expect(minimumDoubleArea).toBeGreaterThan(1e-8);

    for (let offset = 0; offset < regenerated.length; offset += 3) {
      const length = Math.hypot(
        regenerated[offset]!,
        regenerated[offset + 1]!,
        regenerated[offset + 2]!,
      );
      expect(length).toBeGreaterThan(1e-8);
      regenerated[offset] /= length;
      regenerated[offset + 1] /= length;
      regenerated[offset + 2] /= length;
      expect(normals[offset]).toBeCloseTo(regenerated[offset]!, 6);
      expect(normals[offset + 1]).toBeCloseTo(regenerated[offset + 1]!, 6);
      expect(normals[offset + 2]).toBeCloseTo(regenerated[offset + 2]!, 6);
      expect(Math.hypot(
        normals[offset]!,
        normals[offset + 1]!,
        normals[offset + 2]!,
      )).toBeCloseTo(1, 6);
    }
  });
});
