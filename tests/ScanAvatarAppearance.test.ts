import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSceneMesh, SCENE_VERTEX_FLOATS } from '../src/app/SceneGeometry';
import { buildGlb } from '../src/app/gltfExport';
import {
  applyScanVisualNormalization,
  computeScanVisualNormalization,
  parseScanMesh,
  parseScanVisualGlb,
} from '../src/engine/body/ScanAvatar';
import {
  buildScanRigPoseGeometry,
  evaluateScanRigPose,
  supportsScanRigPose,
  supportsSewingPreview,
  transformScanRigPoint,
} from '../src/engine/body/ScanRigPose';
import { morphMesh, type MorphMarks, NO_MORPH } from '../src/engine/body/morph';

function triangleMesh(withColors: boolean): ArrayBuffer {
  const vertexCount = 3;
  const triangleCount = 1;
  const baseBytes = 8 + vertexCount * 24 + triangleCount * 12;
  const buffer = new ArrayBuffer(baseBytes + (withColors ? vertexCount * 3 : 0));
  const view = new DataView(buffer);
  view.setUint32(0, vertexCount, true);
  view.setUint32(4, triangleCount, true);
  new Float32Array(buffer, 8, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(buffer, 8 + vertexCount * 12, 9).set([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  new Uint32Array(buffer, 8 + vertexCount * 24, 3).set([0, 1, 2]);
  if (withColors) {
    new Uint8Array(buffer, baseBytes, 9).set([
      255, 64, 0,
      0, 128, 255,
      32, 16, 8,
    ]);
  }
  return buffer;
}

describe('scan avatar appearance', () => {
  it('keeps legacy meshes valid and decodes an optional compact RGB block', () => {
    expect(parseScanMesh(triangleMesh(false)).colors).toBeUndefined();
    const mesh = parseScanMesh(triangleMesh(true));
    expect(mesh.colors).toBeDefined();
    expect(mesh.colors![0]).toBe(1);
    expect(mesh.colors![1]).toBeCloseTo(64 / 255, 6);
    expect(mesh.colors![5]).toBe(1);
  });

  it('uses source-derived colours on the body and preserves them through morphing', () => {
    const mesh = parseScanMesh(triangleMesh(true));
    const scene = buildSceneMesh({ rawBody: mesh, colliders: [], groundY: -1 });
    expect([...scene.vertices.slice(6, 9)]).toEqual([...mesh.colors!.slice(0, 3)]);
    expect(scene.bodyIndexCount).toBe(3);
    expect(scene.vertices.length / SCENE_VERTEX_FLOATS).toBe(7); // body + ground

    const marks: MorphMarks = {
      shoulderY: 0.9,
      chestY: 0.75,
      waistY: 0.55,
      hipY: 0.4,
      thighY: 0.25,
    };
    const morphed = morphMesh(mesh, { ...NO_MORPH, taille: 1.08 }, marks);
    expect(morphed.colors).toBe(mesh.colors);
    expect([...morphed.normals].every(Number.isFinite)).toBe(true);
  });

  it('rejects an appearance block whose byte length does not match the vertices', () => {
    const legacy = triangleMesh(false);
    const malformed = new Uint8Array(legacy.byteLength + 1);
    malformed.set(new Uint8Array(legacy));
    expect(() => parseScanMesh(malformed.buffer)).toThrow(/appearance block/);
  });

  it('ships the neutral male avatar with generated UVs and an untextured material', () => {
    const bytes = readFileSync(
      new URL('../public/avatars/jericho.mesh.bin', import.meta.url),
    );
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const proxy = parseScanMesh(buffer);
    expect(proxy.indices.length / 3).toBe(1_766);

    const visualBytes = readFileSync(
      new URL('../public/avatars/jericho.visual.glb', import.meta.url),
    );
    const visualBuffer = visualBytes.buffer.slice(
      visualBytes.byteOffset,
      visualBytes.byteOffset + visualBytes.byteLength,
    ) as ArrayBuffer;
    const visual = parseScanVisualGlb(visualBuffer);
    expect(visual.mesh.positions.length / 3).toBe(885);
    expect(visual.mesh.indices.length / 3).toBe(1_766);
    expect(visual.mesh.uvs.length).toBe((visual.mesh.positions.length / 3) * 2);
    expect(visual.mesh.tangents).toBeUndefined();
    expect(visual.rig).toBeDefined();
    const rig = visual.rig!;
    expect(rig.nodes.length).toBe(26);
    expect(rig.skin.joints.length).toBe(25);
    expect(Array.from(rig.skin.joints, (node) => rig.nodes[node]!.name)).toEqual([
      'Root',
      'Hip',
      'Pelvis',
      'Waist',
      'Spine01',
      'Spine02',
      'NeckTwist01',
      'NeckTwist02',
      'Head',
      'L_Clavicle',
      'L_Upperarm',
      'L_Forearm',
      'L_Hand',
      'R_Clavicle',
      'R_Upperarm',
      'R_Forearm',
      'R_Hand',
      'L_Thigh',
      'L_Calf',
      'L_Foot',
      'L_ToeBase',
      'R_Thigh',
      'R_Calf',
      'R_Foot',
      'R_ToeBase',
    ]);
    expect(rig.skin.jointIndices).toBeInstanceOf(Uint8Array);
    expect(rig.skin.jointIndices.length).toBe(885 * 4);
    expect(rig.skin.jointWeights.length).toBe(885 * 4);
    expect(visual.appearance.baseColor).toBeUndefined();
    expect(visual.appearance.normal).toBeUndefined();
    expect(visual.appearance.metallicRoughness).toBeUndefined();
    expect(visual.appearance.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(visual.appearance.metallicFactor).toBe(0);
    expect(visual.appearance.roughnessFactor).toBeCloseTo(0.5, 6);
    expect(visual.appearance.normalScale).toBeCloseTo(1, 4);
    expect(visual.appearance.doubleSided).toBe(false);

    const normalization = computeScanVisualNormalization(visual.mesh, 1.83, Math.PI);
    const nativePose = evaluateScanRigPose(visual.rig!, normalization, 'native');
    const aPose = evaluateScanRigPose(visual.rig!, normalization, 'a-pose');
    const sewingPose = evaluateScanRigPose(visual.rig!, normalization, 'sewing-preview');
    expect(supportsScanRigPose(visual.rig, 'native')).toBe(true);
    expect(supportsScanRigPose(visual.rig, 'a-pose')).toBe(true);
    expect(supportsScanRigPose(visual.rig, 'sewing-preview')).toBe(true);
    expect(supportsSewingPreview(visual.rig)).toBe(true);
    for (let joint = 0; joint < rig.skin.joints.length; joint++) {
      const matrix = nativePose.jointMatrices.subarray(joint * 16, joint * 16 + 16);
      for (let item = 0; item < 16; item++) {
        expect(matrix[item]).toBe(item % 5 === 0 ? 1 : 0);
      }
    }
    expect(Object.keys(aPose.nodeRotations)).toHaveLength(6);
    expect(Object.keys(sewingPose.nodeRotations)).toHaveLength(6);
    expect([...aPose.jointMatrices].every(Number.isFinite)).toBe(true);
    expect([...sewingPose.jointMatrices].every(Number.isFinite)).toBe(true);
    const nodePoint = (pose: typeof nativePose, name: string) => {
      const index = visual.rig!.nodes.find((node) => node.name === name)!.index;
      const matrix = pose.nodeWorldMatrices.subarray(index * 16, index * 16 + 16);
      return transformScanRigPoint(normalization.matrix, [matrix[12]!, matrix[13]!, matrix[14]!]);
    };
    const nodeDirection = (
      pose: typeof nativePose,
      from: string,
      to: string,
    ): [number, number, number] => {
      const start = nodePoint(pose, from);
      const end = nodePoint(pose, to);
      const direction: [number, number, number] = [
        end[0] - start[0],
        end[1] - start[1],
        end[2] - start[2],
      ];
      const length = Math.hypot(...direction);
      return direction.map((component) => component / length) as [number, number, number];
    };
    for (const side of ['L', 'R'] as const) {
      const nativeShoulder = nodePoint(nativePose, `${side}_Upperarm`);
      const sign = Math.sign(nativeShoulder[0]);
      const aUpper = nodeDirection(aPose, `${side}_Upperarm`, `${side}_Forearm`);
      const aForearm = nodeDirection(aPose, `${side}_Forearm`, `${side}_Hand`);
      for (const direction of [aUpper, aForearm]) {
        expect(direction[0]).toBeCloseTo(sign * Math.SQRT1_2, 6);
        expect(direction[1]).toBeCloseTo(-Math.SQRT1_2, 6);
        expect(direction[2]).toBeCloseTo(0, 6);
      }

      const sewingUpper = nodeDirection(
        sewingPose,
        `${side}_Upperarm`,
        `${side}_Forearm`,
      );
      const sewingForearm = nodeDirection(
        sewingPose,
        `${side}_Forearm`,
        `${side}_Hand`,
      );
      const lowTLength = Math.hypot(1, 0.15);
      for (const direction of [sewingUpper, sewingForearm]) {
        expect(direction[0]).toBeCloseTo(sign / lowTLength, 5);
        expect(direction[1]).toBeCloseTo(-0.15 / lowTLength, 5);
        expect(direction[2]).toBeCloseTo(0, 5);
      }
      const nativeHand = nodePoint(nativePose, `${side}_Hand`);
      const aHand = nodePoint(aPose, `${side}_Hand`);
      const sewingHand = nodePoint(sewingPose, `${side}_Hand`);
      expect((sewingHand[0] - nativeHand[0]) * sign).toBeGreaterThan(0.2);
      expect(sewingHand[1]).toBeGreaterThan(nativeHand[1] + 0.2);
      expect((aHand[0] - nativeHand[0]) * sign).toBeGreaterThan(0.1);
      expect((sewingHand[0] - aHand[0]) * sign).toBeGreaterThan(0.1);
    }

    // The generated neutral rig separates arms and lower body at authoring
    // time, so the legacy contact repair must remain a strict no-op.
    const safePoseGeometry = buildScanRigPoseGeometry(visual.mesh, visual.rig!);
    expect(safePoseGeometry.hardenedVertexCount).toBe(0);
    expect(safePoseGeometry.detachedTriangleCount).toBe(0);
    expect(safePoseGeometry.indices.length).toBe(visual.mesh.indices.length);
    expect(safePoseGeometry.jointIndices).toHaveLength(visual.rig!.skin.jointIndices.length);
    expect(safePoseGeometry.jointWeights).toHaveLength(visual.rig!.skin.jointWeights.length);
    let maximumWeightSumError = 0;
    for (let offset = 0; offset < safePoseGeometry.jointWeights.length; offset += 4) {
      const sum =
        safePoseGeometry.jointWeights[offset]! +
        safePoseGeometry.jointWeights[offset + 1]! +
        safePoseGeometry.jointWeights[offset + 2]! +
        safePoseGeometry.jointWeights[offset + 3]!;
      maximumWeightSumError = Math.max(maximumWeightSumError, Math.abs(1 - sum));
    }
    expect(maximumWeightSumError).toBeLessThan(2e-6);

    const canonical = applyScanVisualNormalization(visual.mesh, normalization);
    const bounds = [0, 1, 2].map((axis) => {
      let min = Infinity;
      let max = -Infinity;
      for (let offset = axis; offset < canonical.positions.length; offset += 3) {
        min = Math.min(min, canonical.positions[offset]!);
        max = Math.max(max, canonical.positions[offset]!);
      }
      return { min, max, extent: max - min };
    });
    expect(bounds[0]!.min + bounds[0]!.max).toBeCloseTo(0, 5);
    expect(bounds[1]!.min).toBeCloseTo(0, 5);
    expect(bounds[1]!.extent).toBeCloseTo(1.83, 5);
    expect(bounds[2]!.min + bounds[2]!.max).toBeCloseTo(0, 5);
    expect(bounds[0]!.extent).toBeCloseTo(0.5049510763, 5);
    expect(bounds[2]!.extent).toBeCloseTo(0.3258903563, 5);
  });

  it('preserves UV seams and compressed PBR bytes from a visual GLB', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
    const glb = buildGlb([{
      name: 'visual',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [0.8, 0.9, 1, 1],
      baseColorTexture: { data: jpeg, mimeType: 'image/jpeg' },
      normalTexture: { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      metallicRoughnessTexture: { data: new Uint8Array([4, 5]), mimeType: 'image/png' },
      metallic: 0.1,
      roughness: 0.65,
      normalScale: 0.75,
      doubleSided: true,
    }]);
    const visual = parseScanVisualGlb(glb);
    expect([...visual.mesh.uvs]).toEqual([0, 0, 1, 0, 0, 1]);
    expect([...visual.mesh.indices]).toEqual([0, 1, 2]);
    expect([...visual.appearance.baseColor!.bytes]).toEqual([...jpeg]);
    expect(visual.appearance.baseColorFactor).toEqual([0.8, 0.9, 1, 1]);
    expect(visual.appearance.metallicFactor).toBe(0.1);
    expect(visual.appearance.roughnessFactor).toBe(0.65);
    expect(visual.appearance.normalScale).toBe(0.75);
    expect(visual.appearance.doubleSided).toBe(true);
  });
});
