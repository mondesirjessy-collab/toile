import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyScanVisualNormalization,
  computeScanVisualNormalization,
  ensureScanCollisionForPose,
  loadScanAvatar,
  parseScanVisualGlb,
  parseScanSdf,
  type ScanMatrix4,
  scanCollisionForPose,
  scanHasCollisionPose,
} from '../src/engine/body/ScanAvatar';

const align = (value: number, boundary = 4): number =>
  Math.ceil(value / boundary) * boundary;

const bytesOf = (values: ArrayBufferView): Uint8Array =>
  new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

const translationMatrix = (x: number, y: number, z: number): number[] => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
];

function riggedTriangleGlb(options: { cycle?: boolean; invalidJoint?: boolean } = {}): ArrayBuffer {
  const source = [
    bytesOf(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    bytesOf(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])),
    bytesOf(new Float32Array([0, 0, 1, 0, 0, 1])),
    new Uint8Array([
      options.invalidJoint ? 2 : 0, 1, 0, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
    ]),
    bytesOf(new Float32Array([
      1, 0, 0, 0,
      1, 0, 0, 0,
      0.5, 0.5, 0, 0,
    ])),
    bytesOf(new Uint16Array([0, 1, 2])),
    bytesOf(new Float32Array([
      ...translationMatrix(-1, -1, 0),
      ...translationMatrix(-1, 0, 0),
    ])),
  ];
  const offsets: number[] = [];
  let binLength = 0;
  for (const bytes of source) {
    binLength = align(binLength);
    offsets.push(binLength);
    binLength += bytes.byteLength;
  }
  const binary = new Uint8Array(align(binLength));
  source.forEach((bytes, index) => binary.set(bytes, offsets[index]!));
  const bufferViews = source.map((bytes, index) => ({
    buffer: 0,
    byteOffset: offsets[index],
    byteLength: bytes.byteLength,
  }));
  const nodes = options.cycle
    ? [
        { name: 'Root', matrix: translationMatrix(1, 0, 0), children: [1] },
        { name: 'Joint', translation: [0, 1, 0], children: [0] },
        { name: 'Mesh', mesh: 0, skin: 0 },
      ]
    : [
        { name: 'Root', matrix: translationMatrix(1, 0, 0), children: [1] },
        { name: 'Joint', translation: [0, 1, 0] },
        { name: 'Mesh', mesh: 0, skin: 0 },
        { name: 'SceneRoot', children: [0, 2] },
      ];
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: options.cycle ? [0, 2] : [3] }],
    nodes,
    skins: [{ name: 'Skin', joints: [1, 0], inverseBindMatrices: 6 }],
    meshes: [{
      primitives: [{
        attributes: {
          POSITION: 0,
          NORMAL: 1,
          TEXCOORD_0: 2,
          JOINTS_0: 3,
          WEIGHTS_0: 4,
        },
        indices: 5,
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 5, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 6, componentType: 5126, count: 2, type: 'MAT4' },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align(encoded.byteLength);
  const totalLength = 12 + 8 + jsonLength + 8 + binary.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(encoded, 20);
  const binHeader = 20 + jsonLength;
  view.setUint32(binHeader, binary.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  glb.set(binary, binHeader + 8);
  return glb.buffer;
}

const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): ScanMatrix4 => {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let inner = 0; inner < 4; inner++) {
        result[column * 4 + row] += a[inner * 4 + row]! * b[column * 4 + inner]!;
      }
    }
  }
  return result;
};

const expectIdentity = (matrix: ArrayLike<number>, digits = 6): void => {
  for (let index = 0; index < 16; index++) {
    expect(matrix[index]).toBeCloseTo(index % 5 === 0 ? 1 : 0, digits);
  }
};

function legacyTriangleMesh(): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + 3 * 24 + 12);
  const view = new DataView(buffer);
  view.setUint32(0, 3, true);
  view.setUint32(4, 1, true);
  new Float32Array(buffer, 8, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(buffer, 44, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  new Uint32Array(buffer, 80, 3).set([0, 1, 2]);
  return buffer;
}

function smallSdf(): ArrayBuffer {
  const buffer = new ArrayBuffer(36 + 2 * 2 * 2 * 2);
  const view = new DataView(buffer);
  view.setUint32(0, 2, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 2, true);
  view.setFloat32(12, -1, true);
  view.setFloat32(16, 0, true);
  view.setFloat32(20, -1, true);
  view.setFloat32(24, 1, true);
  view.setFloat32(28, 2, true);
  view.setFloat32(32, 1, true);
  return buffer;
}

afterEach(() => vi.unstubAllGlobals());

describe('native scan avatar rig', () => {
  it('preserves hierarchy, skin ordinals and bind matrices without skinning vertices', () => {
    const parsed = parseScanVisualGlb(riggedTriangleGlb());
    const rig = parsed.rig!;
    expect(rig.nodes.map((node) => node.name)).toEqual(['Root', 'Joint', 'Mesh', 'SceneRoot']);
    expect(rig.nodes[0]!.sourceTransform.kind).toBe('matrix');
    expect(rig.nodes[1]!.sourceTransform.kind).toBe('trs');
    expect([...rig.sceneRoots]).toEqual([3]);
    expect([...rig.skin.joints]).toEqual([1, 0]);
    expect([...rig.skin.jointParents]).toEqual([1, -1]);
    expect([...rig.skin.jointRoots]).toEqual([0]);
    expect(rig.skin.meshNode).toBe(2);
    expect(rig.skin.skeletonRoot).toBeNull();
    expect(rig.skin.jointIndices).toBeInstanceOf(Uint8Array);
    expect([...rig.skin.jointIndices.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    expect([...rig.skin.jointWeights.slice(8, 12)]).toEqual([0.5, 0.5, 0, 0]);
    expect(rig.restWorldMatrices[12]).toBe(1);
    expect(rig.restWorldMatrices[16 + 12]).toBe(1);
    expect(rig.restWorldMatrices[16 + 13]).toBe(1);
    expectIdentity(multiply(rig.skin.meshWorldMatrix, rig.skin.inverseMeshWorldMatrix));
    for (let ordinal = 0; ordinal < rig.skin.joints.length; ordinal++) {
      const node = rig.skin.joints[ordinal]!;
      const world = rig.restWorldMatrices.subarray(node * 16, node * 16 + 16);
      const inverseBind = rig.skin.inverseBindMatrices.subarray(ordinal * 16, ordinal * 16 + 16);
      expectIdentity(multiply(world, inverseBind));
    }
  });

  it('exposes the exact reversible source-to-runtime normalization', () => {
    const mesh = parseScanVisualGlb(riggedTriangleGlb()).mesh;
    const normalization = computeScanVisualNormalization(mesh, 2);
    expect(normalization.scale).toBe(2);
    expect(normalization.translation).toEqual([-1, 0, 0]);
    expectIdentity(multiply(normalization.matrix, normalization.inverseMatrix));
    expect([
      ...applyScanVisualNormalization(mesh, normalization).positions,
    ]).toEqual([-1, 0, 0, 1, 0, 0, -1, 2, 0]);

    const turned = computeScanVisualNormalization(mesh, 2, Math.PI);
    expect(turned.yawRadians).toBe(Math.PI);
    expectIdentity(multiply(turned.matrix, turned.inverseMatrix));
    expect([
      ...applyScanVisualNormalization(mesh, turned).positions,
    ].map((value) => {
      const rounded = Math.round(value * 1e6) / 1e6;
      return Object.is(rounded, -0) ? 0 : rounded;
    })).toEqual([
      1, 0, 0,
      -1, 0, 0,
      1, 2, 0,
    ]);
    expect([
      ...applyScanVisualNormalization(mesh, turned).normals,
    ].every(Number.isFinite)).toBe(true);
  });

  it('rejects cycles and JOINTS_0 ordinals outside skin.joints', () => {
    expect(() => parseScanVisualGlb(riggedTriangleGlb({ cycle: true }))).toThrow(/cycle/);
    expect(() => parseScanVisualGlb(riggedTriangleGlb({ invalidJoint: true }))).toThrow(/ordinal/);
  });

  it('records the exact visual source URL and normalization during loading', async () => {
    const responses = new Map<string, ArrayBuffer>([
      ['/scan.mesh.bin', legacyTriangleMesh()],
      ['/scan.sdf.bin', smallSdf()],
      ['/scan.visual.glb', riggedTriangleGlb()],
      ['/scan.sewing.mesh.bin', legacyTriangleMesh()],
      ['/scan.sewing.sdf.bin', smallSdf()],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
      arrayBuffer: async () => responses.get(url)!,
    })));
    const avatar = await loadScanAvatar('/scan', {
      visual: true,
      normalizeVisualHeightM: 2,
      visualYawRadians: Math.PI,
      reuseVisualForExport: true,
      collisionPoses: { 'sewing-preview': 'sewing' },
    });
    expect(avatar?.rig?.skin.joints.length).toBe(2);
    expect(avatar?.visualSource?.url).toBe('/scan.visual.glb');
    expect(avatar?.visualSource?.normalization.scale).toBe(2);
    expect(avatar?.visualSource?.normalization.yawRadians).toBe(Math.PI);
    expect(avatar?.exportVisualUrl).toBeUndefined();
    expect(scanHasCollisionPose(avatar!, 'sewing-preview')).toBe(true);
    expect(scanCollisionForPose(avatar!, 'sewing-preview')).toBeNull();
    const [loadedPose, duplicateLoad] = await Promise.all([
      ensureScanCollisionForPose(avatar!, 'sewing-preview'),
      ensureScanCollisionForPose(avatar!, 'sewing-preview'),
    ]);
    expect(duplicateLoad).toBe(loadedPose);
    expect(avatar?.collisionPoses?.['sewing-preview']?.mesh.indices.length).toBe(3);
    expect(avatar?.collisionPoses?.['sewing-preview']?.grid.dims).toEqual([2, 2, 2]);
    expect(scanCollisionForPose(avatar!, 'native')?.mesh).toBe(avatar?.mesh);
    expect(scanCollisionForPose(avatar!, 'sewing-preview')).toBe(
      avatar?.collisionPoses?.['sewing-preview'],
    );
    expect(scanCollisionForPose(avatar!, 'unknown')).toBeNull();
  });

  it('keeps the native collider usable when an optional articulated pose is missing', async () => {
    const responses = new Map<string, ArrayBuffer>([
      ['/scan.mesh.bin', legacyTriangleMesh()],
      ['/scan.sdf.bin', smallSdf()],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
      arrayBuffer: async () => responses.get(url)!,
    })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const avatar = await loadScanAvatar('/scan', {
      collisionPoses: { 'sewing-preview': 'sewing' },
    });

    expect(avatar?.mesh.indices.length).toBe(3);
    expect(avatar?.grid.dims).toEqual([2, 2, 2]);
    expect(avatar?.collisionPoses).toBeUndefined();
    expect(scanHasCollisionPose(avatar!, 'sewing-preview')).toBe(true);
    expect(await ensureScanCollisionForPose(avatar!, 'sewing-preview')).toBeNull();
    expect(scanCollisionForPose(avatar!, 'native')?.mesh).toBe(avatar?.mesh);
  });

  it('lazy-loads pose fields and retains at most two decoded grids', async () => {
    const responses = new Map<string, ArrayBuffer>([
      ['/scan.mesh.bin', legacyTriangleMesh()],
      ['/scan.sdf.bin', smallSdf()],
      ...['one', 'two', 'three'].flatMap((suffix) => [
        [`/scan.${suffix}.mesh.bin`, legacyTriangleMesh()] as const,
        [`/scan.${suffix}.sdf.bin`, smallSdf()] as const,
      ]),
    ]);
    const fetchMock = vi.fn(async (url: string) => ({
      ok: responses.has(url),
      status: responses.has(url) ? 200 : 404,
      arrayBuffer: async () => responses.get(url)!,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const avatar = await loadScanAvatar('/scan', {
      collisionPoses: { p1: 'one', p2: 'two', p3: 'three' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await ensureScanCollisionForPose(avatar!, 'p1');
    await ensureScanCollisionForPose(avatar!, 'p2');
    // Reading p1 promotes it: loading p3 must evict p2, not the older-looking
    // but recently used p1 entry.
    expect(scanCollisionForPose(avatar!, 'p1')).not.toBeNull();
    await ensureScanCollisionForPose(avatar!, 'p3');
    expect(scanCollisionForPose(avatar!, 'p2')).toBeNull();
    expect(scanCollisionForPose(avatar!, 'p1')).not.toBeNull();
    expect(scanCollisionForPose(avatar!, 'p3')).not.toBeNull();
    expect(scanHasCollisionPose(avatar!, 'p1')).toBe(true);

    await ensureScanCollisionForPose(avatar!, 'p2');
    expect(scanCollisionForPose(avatar!, 'p2')).not.toBeNull();
    expect(scanCollisionForPose(avatar!, 'p1')).toBeNull();
  });

  it('rejects malformed SDF dimensions and byte lengths explicitly', () => {
    const badDimensions = smallSdf();
    new DataView(badDimensions).setUint32(0, 257, true);
    expect(() => parseScanSdf(badDimensions)).toThrow(/dimensions/);

    expect(() => parseScanSdf(smallSdf().slice(0, -2))).toThrow(/byte length/);
  });
});
