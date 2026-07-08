/**
 * gltfExport — the draped garment as a standard 3D file.
 *
 * Builds a binary glTF 2.0 (.glb) from the CURRENT simulation state: the
 * garment mesh exactly as it hangs (positions read back from the GPU) plus
 * the mannequin underneath, as two named nodes. Opens in Blender, three.js,
 * Windows/macOS 3D viewers… glTF is Y-up in meters — so are we, verbatim.
 *
 * Hand-rolled writer (no dependency): a .glb is a 12-byte header, a JSON
 * chunk padded with spaces, and a binary chunk padded with zeros. All our
 * arrays are 4-byte typed, so sequential packing keeps every view aligned.
 */

export interface GltfPiece {
  name: string;
  /** Tightly packed vec3, world space, meters. */
  positions: Float32Array;
  /** Tightly packed vec3, unit length. */
  normals: Float32Array;
  /** Optional vec2 — the garment carries its rest-pose UVs in meters. */
  uvs?: Float32Array;
  indices: Uint32Array;
  /** Base color, linear RGBA. */
  color: [number, number, number, number];
  /** Cloth is visible from both sides; bodies are closed surfaces. */
  doubleSided?: boolean;
  roughness?: number;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UINT32 = 5125;

const pad4 = (n: number): number => (n + 3) & ~3;

/**
 * Drop vertices no triangle references and remap the indices. Garment grids
 * keep their cut-away particles in the buffers (masked cells); exporting them
 * would ship zero normals and stretch the bounding box to dead points.
 */
function compact(piece: GltfPiece): GltfPiece {
  const vcount = piece.positions.length / 3;
  const map = new Int32Array(vcount).fill(-1);
  let kept = 0;
  for (const i of piece.indices) if (map[i]! === -1) map[i] = kept++;
  if (kept === vcount) return piece;
  const positions = new Float32Array(kept * 3);
  const normals = new Float32Array(kept * 3);
  const uvs = piece.uvs ? new Float32Array(kept * 2) : undefined;
  for (let v = 0; v < vcount; v++) {
    const m = map[v]!;
    if (m === -1) continue;
    positions.set(piece.positions.subarray(v * 3, v * 3 + 3), m * 3);
    normals.set(piece.normals.subarray(v * 3, v * 3 + 3), m * 3);
    if (uvs) uvs.set(piece.uvs!.subarray(v * 2, v * 2 + 2), m * 2);
  }
  const indices = new Uint32Array(piece.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = map[piece.indices[i]!]!;
  return { ...piece, positions, normals, uvs, indices };
}

/** Assemble a complete .glb file from mesh pieces. Exposed for tests. */
export function buildGlb(rawPieces: GltfPiece[]): ArrayBuffer {
  // An index-less piece would compact to zero vertices and emit null bounds.
  const pieces = rawPieces.filter((p) => p.indices.length > 0).map(compact);
  interface View {
    byteOffset: number;
    byteLength: number;
    target: number;
  }
  const views: View[] = [];
  const blobs: ArrayBufferView[] = [];
  let binLength = 0;
  const addView = (data: Float32Array | Uint32Array, target: number): number => {
    views.push({ byteOffset: binLength, byteLength: data.byteLength, target });
    blobs.push(data);
    binLength += pad4(data.byteLength);
    return views.length - 1;
  };

  const accessors: object[] = [];
  const meshes: object[] = [];
  const materials: object[] = [];
  const nodes: object[] = [];

  for (const piece of pieces) {
    // POSITION accessors must carry min/max (the spec requires it; several
    // importers use it for framing).
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < piece.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        let v = piece.positions[i + k]!;
        // Sanitize non-finite components in place (audit M25): an exploded
        // self-collision state or a bad import can leave NaN/Infinity in a
        // position. Left alone it either poisons min/max into ±Infinity (which
        // JSON.stringify writes as null → the glTF validator/Blender reject the
        // file) or ships a NaN float in the bin chunk. Zeroing the component
        // collapses that vertex to the origin — an obviously-broken but VALID
        // .glb, strictly better than an unopenable one. Must write the stored
        // array, not just the local: the same buffer is copied into the view.
        if (!Number.isFinite(v)) { v = 0; piece.positions[i + k] = 0; }
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
    // Normals have no min/max scan and are written verbatim; a NaN position
    // poisons computeNormals (hypot(NaN)=NaN, past the degenerate guard), so
    // sweep them too.
    for (let i = 0; i < piece.normals.length; i++) {
      if (!Number.isFinite(piece.normals[i]!)) piece.normals[i] = 0;
    }
    const posAcc = accessors.length;
    accessors.push({
      bufferView: addView(piece.positions, ARRAY_BUFFER),
      componentType: FLOAT,
      count: piece.positions.length / 3,
      type: 'VEC3',
      min,
      max,
    });
    const nrmAcc = accessors.length;
    accessors.push({
      bufferView: addView(piece.normals, ARRAY_BUFFER),
      componentType: FLOAT,
      count: piece.normals.length / 3,
      type: 'VEC3',
    });
    let uvAcc = -1;
    if (piece.uvs) {
      uvAcc = accessors.length;
      accessors.push({
        bufferView: addView(piece.uvs, ARRAY_BUFFER),
        componentType: FLOAT,
        count: piece.uvs.length / 2,
        type: 'VEC2',
      });
    }
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: addView(piece.indices, ELEMENT_ARRAY_BUFFER),
      componentType: UINT32,
      count: piece.indices.length,
      type: 'SCALAR',
    });

    const material = materials.length;
    materials.push({
      name: `${piece.name}-mat`,
      pbrMetallicRoughness: {
        baseColorFactor: piece.color,
        metallicFactor: 0,
        roughnessFactor: piece.roughness ?? 0.9,
      },
      doubleSided: piece.doubleSided ?? false,
    });
    const attributes: Record<string, number> = { POSITION: posAcc, NORMAL: nrmAcc };
    if (uvAcc >= 0) attributes.TEXCOORD_0 = uvAcc;
    nodes.push({ name: piece.name, mesh: meshes.length });
    meshes.push({
      name: piece.name,
      primitives: [{ attributes, indices: idxAcc, material }],
    });
  }

  const json = {
    asset: { version: '2.0', generator: 'TOILE' },
    scene: 0,
    scenes: [{ name: 'toile', nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonPadded + 8 + binLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);

  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);

  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonBytes, 20);
  u8.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded); // spec: pad JSON with spaces

  const binStart = 20 + jsonPadded;
  dv.setUint32(binStart, binLength, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  let off = binStart + 8;
  for (const blob of blobs) {
    u8.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength), off);
    off += pad4(blob.byteLength); // zero-padded gaps (ArrayBuffer starts zeroed)
  }
  return out;
}

/** Area-weighted vertex normals from a triangle soup. Exposed for tests. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) {
      normals[v]! += nx;
      normals[v + 1]! += ny;
      normals[v + 2]! += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v]!, normals[v + 1]!, normals[v + 2]!);
    if (l < 1e-12) {
      normals[v + 2] = 1; // degenerate fan — any unit vector beats a zero
      continue;
    }
    normals[v]! /= l;
    normals[v + 1]! /= l;
    normals[v + 2]! /= l;
  }
  return normals;
}

/** Build the .glb and hand it to the browser as a download. */
export function downloadGlb(pieces: GltfPiece[], name: string): void {
  if (!pieces.length) return;
  const blob = new Blob([buildGlb(pieces)], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `toile-${name.replace(/[^a-z0-9]/gi, '-')}.glb`;
  a.click();
  // The download starts asynchronously — revoking right away aborts it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
