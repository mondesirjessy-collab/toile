import { describe, expect, it } from 'vitest';
import { buildGlb, computeNormals, type GltfPiece } from '../src/app/gltfExport';

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
