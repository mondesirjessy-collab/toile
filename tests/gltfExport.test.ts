import { describe, expect, it, vi } from 'vitest';
import {
  buildGlb,
  buildGlbWithRiggedSource,
  computeNormals,
  downloadGlb,
  type GltfPiece,
} from '../src/app/gltfExport';

// A unit quad in the XY plane: 4 vertices, 2 CCW triangles facing +Z.
const quad = (): GltfPiece => ({
  name: 'quad',
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  color: [1, 0, 0, 1],
  doubleSided: true,
});

/** Parse a .glb: validate the container layout, return the JSON + bin chunk. */
function parseGlb(buf: ArrayBuffer): { json: any; bin: DataView } {
  const dv = new DataView(buf);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(buf.byteLength); // total length is exact
  const jsonLen = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
  expect(jsonLen % 4).toBe(0);
  const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  expect(dv.getUint32(binStart + 4, true)).toBe(0x004e4942); // 'BIN\0'
  expect(binStart + 8 + binLen).toBe(buf.byteLength);
  return { json: JSON.parse(jsonText), bin: new DataView(buf, binStart + 8, binLen) };
}

/** Small, genuine skin fixture: one joint, one skinned triangle and one image. */
function riggedTriangleGlb(): ArrayBuffer {
  const bin = new Uint8Array(232);
  new Float32Array(bin.buffer, 0, 9).set([
    -0.5, 0, 0,
    0.5, 0, 0,
    0, 1, 0,
  ]);
  new Float32Array(bin.buffer, 36, 9).set([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  new Float32Array(bin.buffer, 72, 6).set([0, 0, 1, 0, 0.5, 1]);
  new Uint8Array(bin.buffer, 96, 12).set([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  new Float32Array(bin.buffer, 108, 12).set([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]);
  new Uint16Array(bin.buffer, 156, 3).set([0, 1, 2]);
  new Float32Array(bin.buffer, 164, 16).set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  bin.set([9, 8, 7, 6], 228);

  const json = {
    asset: { version: '2.0', generator: 'rig-test' },
    scene: 0,
    scenes: [{ name: 'source', nodes: [2] }],
    nodes: [
      { name: 'RootBone', translation: [0, 0.25, 0] },
      { name: 'Body', mesh: 0, skin: 0 },
      { name: 'Armature', children: [1, 0] },
    ],
    skins: [{ name: 'Armature', joints: [0], inverseBindMatrices: 6 }],
    meshes: [{
      name: 'Body',
      primitives: [{
        attributes: {
          POSITION: 0,
          NORMAL: 1,
          TEXCOORD_0: 2,
          JOINTS_0: 3,
          WEIGHTS_0: 4,
        },
        indices: 5,
        material: 0,
      }],
    }],
    materials: [{
      name: 'skin',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ wrapS: 10497, wrapT: 10497 }],
    images: [{ mimeType: 'image/png', bufferView: 7 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 5, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 6, componentType: 5126, count: 1, type: 'MAT4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 72, byteLength: 24, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 12, target: 34962 },
      { buffer: 0, byteOffset: 108, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 156, byteLength: 6, target: 34963 },
      { buffer: 0, byteOffset: 164, byteLength: 64 },
      { buffer: 0, byteOffset: 228, byteLength: 4 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (jsonBytes.length + 3) & ~3;
  const total = 12 + 8 + jsonLength + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, bin.byteLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  bytes.set(bin, binStart + 8);
  return out;
}

describe('buildGlb', () => {
  it('produces a spec-valid container with aligned chunks', () => {
    const { json } = parseGlb(buildGlb([quad()]));
    expect(json.asset.version).toBe('2.0');
    expect(json.scenes[0].nodes).toEqual([0]);
    expect(json.buffers).toHaveLength(1);
    for (const view of json.bufferViews) {
      expect((view.byteOffset ?? 0) % 4).toBe(0);
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength);
    }
  });

  it('round-trips positions, indices and UVs through the accessors', () => {
    const piece = quad();
    const { json, bin } = parseGlb(buildGlb([piece]));
    const prim = json.meshes[0].primitives[0];
    const posAcc = json.accessors[prim.attributes.POSITION];
    expect(posAcc.count).toBe(4);
    expect(posAcc.min).toEqual([0, 0, 0]);
    expect(posAcc.max).toEqual([1, 1, 0]);
    const posView = json.bufferViews[posAcc.bufferView];
    for (let i = 0; i < 12; i++) {
      expect(bin.getFloat32(posView.byteOffset + i * 4, true)).toBe(piece.positions[i]);
    }
    const idxAcc = json.accessors[prim.indices];
    expect(idxAcc.componentType).toBe(5125);
    const idxView = json.bufferViews[idxAcc.bufferView];
    for (let i = 0; i < 6; i++) {
      expect(bin.getUint32(idxView.byteOffset + i * 4, true)).toBe(piece.indices[i]);
    }
    expect(json.accessors[prim.attributes.TEXCOORD_0].type).toBe('VEC2');
    expect(json.materials[0].doubleSided).toBe(true);
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
  });

  it('packs several pieces as separate nodes sharing the one buffer', () => {
    const a = quad();
    const b = { ...quad(), name: 'corps', uvs: undefined, doubleSided: false };
    const { json } = parseGlb(buildGlb([a, b]));
    expect(json.nodes.map((n: any) => n.name)).toEqual(['quad', 'corps']);
    expect(json.scenes[0].nodes).toEqual([0, 1]);
    expect(json.meshes[1].primitives[0].attributes.TEXCOORD_0).toBeUndefined();
    expect(json.materials[1].doubleSided).toBe(false);
  });

  it('embeds UV/PBR images and wires every material texture', () => {
    const piece = quad();
    piece.baseColorTexture = {
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: 'image/jpeg',
    };
    piece.normalTexture = {
      data: new Uint8Array([1, 2, 3, 4, 5]),
      mimeType: 'image/png',
    };
    piece.metallicRoughnessTexture = {
      data: new Uint8Array([6, 7, 8]),
      mimeType: 'image/png',
    };
    piece.metallic = 0.25;
    piece.roughness = 0.7;
    piece.normalScale = 0.8;
    const { json, bin } = parseGlb(buildGlb([piece]));
    expect(json.images.map((image: any) => image.mimeType)).toEqual([
      'image/jpeg',
      'image/png',
      'image/png',
    ]);
    expect(json.textures).toHaveLength(3);
    expect(json.samplers).toHaveLength(1);
    const material = json.materials[0];
    expect(material.pbrMetallicRoughness.baseColorTexture.index).toBe(0);
    expect(material.normalTexture).toEqual({ index: 1, scale: 0.8 });
    expect(material.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(2);
    expect(material.pbrMetallicRoughness.metallicFactor).toBe(0.25);
    expect(material.pbrMetallicRoughness.roughnessFactor).toBe(0.7);
    const firstImage = json.bufferViews[json.images[0].bufferView];
    expect([
      bin.getUint8(firstImage.byteOffset),
      bin.getUint8(firstImage.byteOffset + 1),
      bin.getUint8(firstImage.byteOffset + 2),
      bin.getUint8(firstImage.byteOffset + 3),
    ]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('exports optional vertex colours as COLOR_0', () => {
    const piece = quad();
    piece.colors = new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 1, 1,
    ]);
    const { json } = parseGlb(buildGlb([piece]));
    const accessorIndex = json.meshes[0].primitives[0].attributes.COLOR_0;
    expect(json.accessors[accessorIndex]).toMatchObject({ type: 'VEC3', count: 4 });
  });
});

describe('buildGlbWithRiggedSource', () => {
  it('keeps the complete skin graph and source BIN while appending static pieces', () => {
    const source = riggedTriangleGlb();
    const original = parseGlb(source);
    const garment = quad();
    garment.baseColorTexture = {
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: 'image/jpeg',
    };
    const merged = parseGlb(buildGlbWithRiggedSource([garment], {
      glb: source,
      placement: {
        scale: 1.83,
        translation: [0.1, 0.2, -0.3],
        yawRadians: 0.5,
      },
    }));

    // Every source-indexed object remains first, so its internal references
    // are unchanged: node 1 is still the skinned mesh and joint 0 still owns
    // the exact same inverse-bind accessor.
    expect(merged.json.skins).toEqual(original.json.skins);
    expect(merged.json.nodes.slice(0, 3)).toEqual(original.json.nodes);
    expect(merged.json.meshes[0]).toEqual(original.json.meshes[0]);
    expect(merged.json.accessors.slice(0, 7)).toEqual(original.json.accessors);
    expect(merged.json.nodes[1].skin).toBe(0);
    expect(merged.json.meshes[0].primitives[0].attributes).toMatchObject({
      JOINTS_0: 3,
      WEIGHTS_0: 4,
    });
    expect(merged.json.skins[0]).toEqual({
      name: 'Armature',
      joints: [0],
      inverseBindMatrices: 6,
    });

    // Source geometry, skin matrices and compressed image bytes are an exact
    // prefix, rather than a decoded/re-encoded approximation.
    const originalBin = new Uint8Array(
      original.bin.buffer,
      original.bin.byteOffset,
      original.bin.byteLength,
    );
    const mergedPrefix = new Uint8Array(
      merged.bin.buffer,
      merged.bin.byteOffset,
      original.bin.byteLength,
    );
    expect([...mergedPrefix]).toEqual([...originalBin]);

    // Source resource counts were 7 accessors, 8 views, 1 mesh/material/image/
    // texture/sampler and 3 nodes. All generated references are offset from
    // those namespaces, including embedded garment textures.
    expect(merged.json.nodes[3]).toMatchObject({ name: 'quad', mesh: 1 });
    expect(merged.json.meshes[1].primitives[0]).toMatchObject({
      attributes: { POSITION: 7, NORMAL: 8, TEXCOORD_0: 9 },
      indices: 10,
      material: 1,
    });
    expect(merged.json.materials[1].pbrMetallicRoughness.baseColorTexture.index).toBe(1);
    expect(merged.json.textures[1]).toEqual({ source: 1, sampler: 1 });
    expect(merged.json.images[1].bufferView).toBeGreaterThanOrEqual(8);
    for (const view of merged.json.bufferViews.slice(8)) {
      expect(view.byteOffset).toBeGreaterThanOrEqual(original.bin.byteLength);
      expect(view.byteOffset % 4).toBe(0);
    }

    const yaw = merged.json.nodes[4];
    const normalization = merged.json.nodes[5];
    expect(normalization).toEqual({
      name: 'TOILE avatar normalization',
      translation: [0.1, 0.2, -0.3],
      scale: [1.83, 1.83, 1.83],
      children: [4],
    });
    expect(yaw.name).toBe('TOILE avatar yaw');
    expect(yaw.children).toEqual([2]);
    expect(yaw.rotation[0]).toBe(0);
    expect(yaw.rotation[1]).toBeCloseTo(-Math.sin(0.25), 8);
    expect(yaw.rotation[2]).toBe(0);
    expect(yaw.rotation[3]).toBeCloseTo(Math.cos(0.25), 8);
    expect(merged.json.scenes[0].nodes).toEqual([3, 5]);
  });

  it('appends a source skin override and remaps later garment resources after it', () => {
    const source = riggedTriangleGlb();
    const original = parseGlb(source);
    const indices = new Uint32Array([2, 1, 0]);
    const jointIndices = new Uint16Array([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const jointWeights = new Float32Array([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ]);
    const merged = parseGlb(buildGlbWithRiggedSource([quad()], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      skinOverride: {
        meshIndex: 0,
        indices,
        jointIndices,
        jointWeights,
      },
    }));

    // The source BIN remains byte-for-byte intact. The three replacement
    // streams begin immediately after it and before all generated garment data.
    const originalBytes = new Uint8Array(
      original.bin.buffer,
      original.bin.byteOffset,
      original.bin.byteLength,
    );
    const mergedPrefix = new Uint8Array(
      merged.bin.buffer,
      merged.bin.byteOffset,
      original.bin.byteLength,
    );
    expect([...mergedPrefix]).toEqual([...originalBytes]);

    const primitive = merged.json.meshes[0].primitives[0];
    expect(primitive.indices).toBe(7);
    expect(primitive.attributes.JOINTS_0).toBe(8);
    expect(primitive.attributes.WEIGHTS_0).toBe(9);
    expect(primitive.attributes.POSITION).toBe(0);
    expect(merged.json.accessors[7]).toMatchObject({
      componentType: 5125,
      count: 3,
      type: 'SCALAR',
      min: [0],
      max: [2],
    });
    expect(merged.json.accessors[8]).toMatchObject({
      componentType: 5123,
      count: 3,
      type: 'VEC4',
    });
    expect(merged.json.accessors[9]).toMatchObject({
      componentType: 5126,
      count: 3,
      type: 'VEC4',
    });

    const indexView = merged.json.bufferViews[merged.json.accessors[7].bufferView];
    const jointsView = merged.json.bufferViews[merged.json.accessors[8].bufferView];
    const weightsView = merged.json.bufferViews[merged.json.accessors[9].bufferView];
    expect(indexView).toMatchObject({
      byteOffset: original.bin.byteLength,
      byteLength: indices.byteLength,
      target: 34963,
    });
    expect(jointsView).toMatchObject({
      byteOffset: original.bin.byteLength + indices.byteLength,
      byteLength: jointIndices.byteLength,
      target: 34962,
    });
    expect(weightsView).toMatchObject({
      byteOffset: original.bin.byteLength + indices.byteLength + jointIndices.byteLength,
      byteLength: jointWeights.byteLength,
      target: 34962,
    });
    for (let i = 0; i < indices.length; i++) {
      expect(merged.bin.getUint32(indexView.byteOffset + i * 4, true)).toBe(indices[i]);
    }
    for (let i = 0; i < jointIndices.length; i++) {
      expect(merged.bin.getUint16(jointsView.byteOffset + i * 2, true)).toBe(jointIndices[i]);
      expect(merged.bin.getFloat32(weightsView.byteOffset + i * 4, true)).toBe(jointWeights[i]);
    }

    // Source had seven accessors/eight views. Override owns the next three;
    // quad accessors/views are consequently offset past those new resources.
    expect(merged.json.meshes[1].primitives[0]).toMatchObject({
      attributes: { POSITION: 10, NORMAL: 11, TEXCOORD_0: 12 },
      indices: 13,
      material: 1,
    });
    const generatedBinStart =
      original.bin.byteLength + indices.byteLength +
      jointIndices.byteLength + jointWeights.byteLength;
    for (const view of merged.json.bufferViews.slice(11)) {
      expect(view.byteOffset).toBeGreaterThanOrEqual(generatedBinStart);
      expect(view.byteOffset % 4).toBe(0);
    }

    // Building the merged document never mutates the caller's source GLB.
    expect(parseGlb(source).json.meshes[0].primitives[0]).toEqual(
      original.json.meshes[0].primitives[0],
    );
  });

  it('rejects skin overrides that do not match the selected source primitive', () => {
    const source = riggedTriangleGlb();
    const validWeights = new Float32Array(12).fill(0);
    validWeights[0] = validWeights[4] = validWeights[8] = 1;
    const baseOverride = {
      meshIndex: 0,
      indices: new Uint32Array([0, 1, 2]),
      jointIndices: new Uint16Array(12),
      jointWeights: validWeights,
    };
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      skinOverride: { ...baseOverride, meshIndex: 1 },
    })).toThrow(/mesh index/);
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      skinOverride: {
        ...baseOverride,
        jointIndices: new Uint16Array(8),
        jointWeights: new Float32Array(8),
      },
    })).toThrow(/vertex count/);
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      skinOverride: { ...baseOverride, indices: new Uint32Array([0, 1, 3]) },
    })).toThrow(/outside POSITION/);
  });

  it('applies normalized local joint rotations without mutating the source GLB', () => {
    const source = riggedTriangleGlb();
    const merged = parseGlb(buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      nodeRotations: { 0: [0, 2, 0, 2] },
    }));
    expect(merged.json.nodes[0].rotation[0]).toBe(0);
    expect(merged.json.nodes[0].rotation[1]).toBeCloseTo(Math.SQRT1_2, 8);
    expect(merged.json.nodes[0].rotation[2]).toBe(0);
    expect(merged.json.nodes[0].rotation[3]).toBeCloseTo(Math.SQRT1_2, 8);
    expect(parseGlb(source).json.nodes[0].rotation).toBeUndefined();
    expect(merged.json.scenes[0].nodes).toEqual([4]);
  });

  it('rejects invalid placement and rotation data explicitly', () => {
    const source = riggedTriangleGlb();
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 0, translation: [0, 0, 0] },
    })).toThrow(/scale/);
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      nodeRotations: { 99: [0, 0, 0, 1] },
    })).toThrow(/rotation node/);
    expect(() => buildGlbWithRiggedSource([], {
      glb: source,
      placement: { scale: 1, translation: [0, 0, 0] },
      nodeRotations: { 0: [0, 0, 0, 0] },
    })).toThrow(/degenerate/);
  });
});

describe('compaction', () => {
  it('drops unreferenced vertices and shrinks the POSITION bounds', () => {
    const piece = quad();
    // A stray cut-away vertex far outside the garment, referenced by nothing.
    piece.positions = new Float32Array([...piece.positions, 99, 99, 99]);
    piece.normals = new Float32Array([...piece.normals, 0, 0, 0]);
    piece.uvs = new Float32Array([...piece.uvs!, 0, 0]);
    const { json } = parseGlb(buildGlb([piece]));
    const posAcc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(posAcc.count).toBe(4); // the stray vertex is gone
    expect(posAcc.max).toEqual([1, 1, 0]); // bounds no longer stretched to it
  });
});

describe('computeNormals', () => {
  it('yields unit +Z normals for a CCW quad in the XY plane', () => {
    const q = quad();
    const n = computeNormals(q.positions, q.indices);
    for (let v = 0; v < 4; v++) {
      expect(n[v * 3]).toBeCloseTo(0);
      expect(n[v * 3 + 1]).toBeCloseTo(0);
      expect(n[v * 3 + 2]).toBeCloseTo(1);
    }
  });
});

describe('downloadGlb', () => {
  it('retourne le nom exact du fichier dont le téléchargement a démarré', () => {
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:glb'),
      revokeObjectURL,
    });

    vi.useFakeTimers();
    try {
      expect(downloadGlb([quad()], 'Lucas hoodie')).toBe(
        'toile-Lucas-hoodie.glb',
      );
      expect(anchor.download).toBe('toile-Lucas-hoodie.glb');
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(appendChild).toHaveBeenCalledWith(anchor);
      expect(anchor.remove).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:glb');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retourne null sans fabriquer de faux succès si aucune pièce n’existe', () => {
    expect(downloadGlb([], 'atelier')).toBeNull();
  });

  it('retire l’ancre et révoque immédiatement le Blob si le clic échoue', () => {
    const failure = new Error('navigation bloquée');
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(() => {
        throw failure;
      }),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:glb-failed'),
      revokeObjectURL,
    });

    expect(() => downloadGlb([quad()], 'Lucas hoodie')).toThrow(failure);
    expect(anchor.download).toBe('toile-Lucas-hoodie.glb');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:glb-failed');
  });
});
