import { describe, expect, it } from 'vitest';
import {
  MAX_SCENE_JOINTS,
  SCENE_JOINT_INFLUENCES,
  SCENE_JOINT_PALETTE_BYTES,
  SCENE_JOINT_PALETTE_FLOATS,
  SCENE_VERTEX_FLOATS,
  buildSceneMesh,
  sceneJointPalette,
  validateSceneJointMatrices,
  validateSceneSkin,
  type SceneSkin,
} from '../src/app/SceneGeometry';

const triangleBody = {
  positions: new Float32Array([
    -0.2, 0, 0,
    0.2, 0, 0,
    0, 0.4, 0,
  ]),
  normals: new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]),
  indices: new Uint32Array([0, 1, 2]),
};

const triangleSkin = (): SceneSkin => ({
  jointIndices: new Uint16Array([
    1, 2, 0, 0,
    2, 1, 0, 0,
    2, 3, 1, 0,
  ]),
  weights: new Float32Array([
    0.75, 0.25, 0, 0,
    1, 0, 0, 0,
    0.5, 0.3, 0.2, 0,
  ]),
});

describe('flux GPU de skinning de la scène', () => {
  it('étend les influences du corps à tous les sommets et neutralise le sol', () => {
    const input = triangleSkin();
    const scene = buildSceneMesh({
      colliders: [],
      rawBody: triangleBody,
      skin: input,
      groundY: 0,
    });

    const vertexCount = scene.vertices.length / SCENE_VERTEX_FLOATS;
    expect(vertexCount).toBe(7); // trois sommets de corps + quatre de sol
    expect(scene.skin?.jointIndices).toBeInstanceOf(Uint16Array);
    expect(scene.skin?.jointIndices).toHaveLength(vertexCount * SCENE_JOINT_INFLUENCES);
    expect(scene.skin?.weights).toHaveLength(vertexCount * SCENE_JOINT_INFLUENCES);
    expect(scene.skin!.jointIndices.byteLength).toBe(vertexCount * 8); // uint16x4
    expect(scene.skin!.weights.byteLength).toBe(vertexCount * 16); // float32x4
    expect([...scene.skin!.jointIndices.slice(0, 12)]).toEqual([...input.jointIndices]);
    expect([...scene.skin!.weights.slice(0, 12)]).toEqual([...input.weights]);
    expect([...scene.skin!.jointIndices.slice(12)]).toEqual(new Array(16).fill(0));
    expect([...scene.skin!.weights.slice(12)]).toEqual(new Array(16).fill(0));
  });

  it('rejette les flux partiels et les ordinals hors palette', () => {
    expect(() => validateSceneSkin({
      jointIndices: new Uint16Array(7),
      weights: new Float32Array(8),
    }, 2)).toThrow(/four influences per vertex/);

    const invalidJoint = {
      jointIndices: new Uint16Array([MAX_SCENE_JOINTS, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0]),
    };
    expect(() => validateSceneSkin(invalidJoint, 1)).toThrow(/exceeds/);

    const invalidWeight = {
      jointIndices: new Uint16Array(4),
      weights: new Float32Array([Number.NaN, 0, 0, 0]),
    };
    expect(() => validateSceneSkin(invalidWeight, 1)).toThrow(/finite/);
  });
});

describe('palette uniforme des os', () => {
  it('occupe exactement 64 mat4 et respecte l’alignement uniforme WebGPU', () => {
    expect(SCENE_JOINT_PALETTE_FLOATS).toBe(MAX_SCENE_JOINTS * 16);
    expect(SCENE_JOINT_PALETTE_BYTES).toBe(SCENE_JOINT_PALETTE_FLOATS * 4);
    expect(SCENE_JOINT_PALETTE_BYTES % 256).toBe(0);

    const palette = sceneJointPalette();
    expect(palette.byteLength).toBe(SCENE_JOINT_PALETTE_BYTES);
    for (let joint = 0; joint < MAX_SCENE_JOINTS; joint++) {
      const offset = joint * 16;
      expect([
        palette[offset],
        palette[offset + 5],
        palette[offset + 10],
        palette[offset + 15],
      ]).toEqual([1, 1, 1, 1]);
    }
  });

  it('copie les matrices fournies et complète les slots restants à l’identité', () => {
    const translation = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      2, 3, 4, 1,
    ]);
    const palette = sceneJointPalette(translation);
    expect([...palette.slice(0, 16)]).toEqual([...translation]);
    expect([...palette.slice(16, 32)]).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  });

  it('refuse une matrice partielle, une palette trop grande et une valeur non finie', () => {
    expect(() => validateSceneJointMatrices(new Float32Array(15))).toThrow(/complete mat4/);
    expect(() => validateSceneJointMatrices(new Float32Array((MAX_SCENE_JOINTS + 1) * 16)))
      .toThrow(/complete mat4/);
    const nonFinite = new Float32Array(16);
    nonFinite[5] = Number.POSITIVE_INFINITY;
    expect(() => validateSceneJointMatrices(nonFinite)).toThrow(/finite/);
  });
});
