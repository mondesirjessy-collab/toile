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

import { downloadBrowserBlob } from './browserDownload';

export interface GltfImage {
  /** Original compressed bytes; the writer embeds them without transcoding. */
  data: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface GltfPiece {
  name: string;
  /** Tightly packed vec3, world space, meters. */
  positions: Float32Array;
  /** Tightly packed vec3, unit length. */
  normals: Float32Array;
  /** Optional vec4 tangent, including bitangent handedness in w. */
  tangents?: Float32Array;
  /** Optional vec2 — the garment carries its rest-pose UVs in meters. */
  uvs?: Float32Array;
  /** Optional linear RGB vertex colour fallback (`COLOR_0`). */
  colors?: Float32Array;
  indices: Uint32Array;
  /** Base color, linear RGBA. */
  color: [number, number, number, number];
  /** Cloth is visible from both sides; bodies are closed surfaces. */
  doubleSided?: boolean;
  roughness?: number;
  metallic?: number;
  baseColorTexture?: GltfImage;
  normalTexture?: GltfImage;
  metallicRoughnessTexture?: GltfImage;
  normalScale?: number;
}

export type GltfQuaternion = readonly [number, number, number, number];

/**
 * Replacement topology and skin streams for one primitive of the source GLB.
 *
 * Positions, normals, UVs, materials and the skeleton stay authored by the
 * source file. Only the index and four-influence skin accessors are appended
 * and redirected, which lets TOILE repair a pose-specific contact patch
 * without flattening or rebuilding the rig.
 */
export interface GltfRiggedSkinOverride {
  meshIndex: number;
  /** Defaults to the first primitive of the selected mesh. */
  primitiveIndex?: number;
  indices: Uint32Array;
  jointIndices: Uint16Array;
  jointWeights: Float32Array;
}

/**
 * A complete binary glTF whose node graph must survive the combined export.
 *
 * `translation` is the post-scale translation used to place the native asset
 * in TOILE coordinates. Both it and the uniform scale are kept on a parent of
 * the complete source scene, so a skin's mesh and joints receive precisely the
 * same transform and its inverse-bind matrices remain valid.
 */
export interface GltfRiggedSource {
  glb: ArrayBuffer;
  placement: {
    scale: number;
    translation: readonly [number, number, number];
    /** TOILE's podium yaw, in radians. */
    yawRadians?: number;
  };
  /** Optional current local joint rotations, keyed by original source node index. */
  nodeRotations?: Readonly<Record<number, GltfQuaternion>>;
  /** Optional replacement skin streams for one original source primitive. */
  skinOverride?: GltfRiggedSkinOverride;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UINT16 = 5123;
const UINT32 = 5125;

const pad4 = (n: number): number => (n + 3) & ~3;

type GltfRecord = Record<string, any>;

interface ParsedGlb {
  json: GltfRecord;
  bin: Uint8Array;
}

/** Parse the strict, self-contained GLB subset accepted by the merger. */
function parseEmbeddedGlb(glb: ArrayBuffer, label: string): ParsedGlb {
  if (glb.byteLength < 28) throw new Error(`${label}: truncated GLB`);
  const view = new DataView(glb);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error(`${label}: expected a binary glTF 2.0 file`);
  }
  if (view.getUint32(8, true) !== glb.byteLength) {
    throw new Error(`${label}: invalid declared GLB length`);
  }
  const jsonLength = view.getUint32(12, true);
  if (
    view.getUint32(16, true) !== CHUNK_JSON ||
    jsonLength % 4 !== 0 ||
    20 + jsonLength + 8 > glb.byteLength
  ) {
    throw new Error(`${label}: invalid JSON chunk`);
  }
  let json: GltfRecord;
  try {
    json = JSON.parse(
      new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)),
    ) as GltfRecord;
  } catch {
    throw new Error(`${label}: malformed glTF JSON`);
  }
  const binHeader = 20 + jsonLength;
  const binLength = view.getUint32(binHeader, true);
  if (
    view.getUint32(binHeader + 4, true) !== CHUNK_BIN ||
    binHeader + 8 + binLength !== glb.byteLength ||
    binLength % 4 !== 0
  ) {
    throw new Error(`${label}: invalid BIN chunk`);
  }
  const buffers = json.buffers;
  if (!Array.isArray(buffers) || buffers.length !== 1) {
    throw new Error(`${label}: exactly one embedded buffer is required`);
  }
  const buffer = buffers[0] as GltfRecord | undefined;
  if (
    !buffer ||
    buffer.uri !== undefined ||
    !Number.isInteger(buffer.byteLength) ||
    buffer.byteLength < 0 ||
    buffer.byteLength > binLength ||
    binLength - buffer.byteLength > 3
  ) {
    throw new Error(`${label}: invalid embedded buffer declaration`);
  }
  return {
    json,
    bin: new Uint8Array(glb, binHeader + 8, binLength),
  };
}

/** Encode an already-packed, single-buffer glTF document. */
function encodeEmbeddedGlb(json: GltfRecord, bin: Uint8Array): ArrayBuffer {
  const buffers = json.buffers as GltfRecord[];
  buffers[0]!.byteLength = bin.byteLength;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes.length);
  const binPadded = pad4(bin.byteLength);
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);
  const binStart = 20 + jsonPadded;
  view.setUint32(binStart, binPadded, true);
  view.setUint32(binStart + 4, CHUNK_BIN, true);
  bytes.set(bin, binStart + 8);
  return out;
}

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
  const tangents = piece.tangents ? new Float32Array(kept * 4) : undefined;
  const uvs = piece.uvs ? new Float32Array(kept * 2) : undefined;
  const colors = piece.colors ? new Float32Array(kept * 3) : undefined;
  for (let v = 0; v < vcount; v++) {
    const m = map[v]!;
    if (m === -1) continue;
    positions.set(piece.positions.subarray(v * 3, v * 3 + 3), m * 3);
    normals.set(piece.normals.subarray(v * 3, v * 3 + 3), m * 3);
    if (tangents) tangents.set(piece.tangents!.subarray(v * 4, v * 4 + 4), m * 4);
    if (uvs) uvs.set(piece.uvs!.subarray(v * 2, v * 2 + 2), m * 2);
    if (colors) colors.set(piece.colors!.subarray(v * 3, v * 3 + 3), m * 3);
  }
  const indices = new Uint32Array(piece.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = map[piece.indices[i]!]!;
  return { ...piece, positions, normals, tangents, uvs, colors, indices };
}

/** Assemble a complete .glb file from mesh pieces. Exposed for tests. */
export function buildGlb(rawPieces: GltfPiece[]): ArrayBuffer {
  // An index-less piece would compact to zero vertices and emit null bounds.
  const pieces = rawPieces.filter((p) => p.indices.length > 0).map(compact);
  interface View {
    byteOffset: number;
    byteLength: number;
    target?: number;
  }
  const views: View[] = [];
  const blobs: ArrayBufferView[] = [];
  let binLength = 0;
  const addView = (data: ArrayBufferView, target?: number): number => {
    views.push({ byteOffset: binLength, byteLength: data.byteLength, ...(target ? { target } : {}) });
    blobs.push(data);
    binLength += pad4(data.byteLength);
    return views.length - 1;
  };

  const accessors: object[] = [];
  const meshes: object[] = [];
  const materials: object[] = [];
  const nodes: object[] = [];
  const images: object[] = [];
  const textures: object[] = [];
  const samplers: object[] = [];

  const addTexture = (image: GltfImage | undefined): number | undefined => {
    if (!image) return undefined;
    if (!samplers.length) {
      samplers.push({
        magFilter: 9729, // LINEAR
        minFilter: 9987, // LINEAR_MIPMAP_LINEAR
        wrapS: 10497,
        wrapT: 10497,
      });
    }
    const source = images.length;
    images.push({
      name: `toile-image-${source}`,
      bufferView: addView(image.data),
      mimeType: image.mimeType,
    });
    const index = textures.length;
    textures.push({ source, sampler: 0 });
    return index;
  };

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
    let tangentAcc = -1;
    if (piece.tangents) {
      tangentAcc = accessors.length;
      accessors.push({
        bufferView: addView(piece.tangents, ARRAY_BUFFER),
        componentType: FLOAT,
        count: piece.tangents.length / 4,
        type: 'VEC4',
      });
    }
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
    let colorAcc = -1;
    if (piece.colors) {
      colorAcc = accessors.length;
      accessors.push({
        bufferView: addView(piece.colors, ARRAY_BUFFER),
        componentType: FLOAT,
        count: piece.colors.length / 3,
        type: 'VEC3',
      });
    }
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: addView(piece.indices, ELEMENT_ARRAY_BUFFER),
      componentType: UINT32,
      count: piece.indices.length,
      type: 'SCALAR',
    });

    const baseColorTexture = addTexture(piece.baseColorTexture);
    const normalTexture = addTexture(piece.normalTexture);
    const metallicRoughnessTexture = addTexture(piece.metallicRoughnessTexture);
    const pbrMetallicRoughness: Record<string, unknown> = {
      baseColorFactor: piece.color,
      metallicFactor: piece.metallic ?? 0,
      roughnessFactor: piece.roughness ?? 0.9,
    };
    if (baseColorTexture !== undefined) pbrMetallicRoughness.baseColorTexture = { index: baseColorTexture };
    if (metallicRoughnessTexture !== undefined) {
      pbrMetallicRoughness.metallicRoughnessTexture = { index: metallicRoughnessTexture };
    }
    const materialDefinition: Record<string, unknown> = {
      name: `${piece.name}-mat`,
      pbrMetallicRoughness,
      doubleSided: piece.doubleSided ?? false,
    };
    if (normalTexture !== undefined) {
      materialDefinition.normalTexture = { index: normalTexture, scale: piece.normalScale ?? 1 };
    }
    const material = materials.length;
    materials.push(materialDefinition);
    const attributes: Record<string, number> = { POSITION: posAcc, NORMAL: nrmAcc };
    if (tangentAcc >= 0) attributes.TANGENT = tangentAcc;
    if (uvAcc >= 0) attributes.TEXCOORD_0 = uvAcc;
    if (colorAcc >= 0) attributes.COLOR_0 = colorAcc;
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
    ...(images.length ? { images, textures, samplers } : {}),
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

function documentArray(json: GltfRecord, key: string, label: string): GltfRecord[] {
  const value = json[key];
  if (value === undefined) {
    const created: GltfRecord[] = [];
    json[key] = created;
    return created;
  }
  if (!Array.isArray(value)) throw new Error(`${label}: glTF ${key} must be an array`);
  return value as GltfRecord[];
}

function remapTextureInfo(info: unknown, textureOffset: number): unknown {
  if (!info || typeof info !== 'object') return info;
  const record = info as GltfRecord;
  if (!Number.isInteger(record.index)) throw new Error('TOILE pieces: invalid material texture index');
  return { ...record, index: record.index + textureOffset };
}

/**
 * Add static TOILE pieces to a complete source GLB without flattening its
 * scene graph. The source document stays first in every indexed glTF array,
 * which means all node/skin/joint/accessor references remain numerically
 * unchanged. Its complete BIN chunk is copied byte-for-byte as the prefix of
 * the combined BIN; only the generated pieces are remapped and appended.
 */
export function buildGlbWithRiggedSource(
  rawPieces: GltfPiece[],
  source: GltfRiggedSource,
): ArrayBuffer {
  const scale = source.placement.scale;
  const translation = source.placement.translation;
  const yaw = source.placement.yawRadians ?? 0;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('rigged source: placement scale must be finite and positive');
  }
  if (translation.length !== 3 || !translation.every(Number.isFinite)) {
    throw new Error('rigged source: placement translation must contain three finite values');
  }
  if (!Number.isFinite(yaw)) throw new Error('rigged source: yaw must be finite');

  const base = parseEmbeddedGlb(source.glb, 'rigged source');
  const addition = parseEmbeddedGlb(buildGlb(rawPieces), 'TOILE pieces');
  const json = base.json;
  const added = addition.json;

  const baseScenes = documentArray(json, 'scenes', 'rigged source');
  const activeSceneIndex = json.scene ?? 0;
  if (!Number.isInteger(activeSceneIndex) || activeSceneIndex < 0 || activeSceneIndex >= baseScenes.length) {
    throw new Error('rigged source: invalid active scene');
  }
  const activeScene = baseScenes[activeSceneIndex]!;
  if (activeScene.nodes !== undefined && !Array.isArray(activeScene.nodes)) {
    throw new Error('rigged source: active scene roots must be an array');
  }

  const baseNodes = documentArray(json, 'nodes', 'rigged source');
  const originalNodeCount = baseNodes.length;
  const sourceRoots = [...((activeScene.nodes as number[] | undefined) ?? [])];
  if (
    !sourceRoots.length ||
    sourceRoots.some((node) => !Number.isInteger(node) || node < 0 || node >= originalNodeCount)
  ) {
    throw new Error('rigged source: active scene has invalid roots');
  }

  // Joint-local pose edits alter only the copied JSON. The source ArrayBuffer
  // and its inverse-bind matrices remain untouched. Matrix-authored nodes are
  // rejected because overriding just their quaternion would discard their
  // embedded translation and scale.
  for (const [rawIndex, rawRotation] of Object.entries(source.nodeRotations ?? {})) {
    const index = Number(rawIndex);
    const node = baseNodes[index];
    if (!Number.isInteger(index) || index < 0 || index >= originalNodeCount || !node) {
      throw new Error(`rigged source: invalid rotation node ${rawIndex}`);
    }
    if (node.matrix !== undefined) {
      throw new Error(`rigged source: cannot override matrix-authored node ${index}`);
    }
    if (!Array.isArray(rawRotation) || rawRotation.length !== 4 || !rawRotation.every(Number.isFinite)) {
      throw new Error(`rigged source: node ${index} rotation must contain four finite values`);
    }
    const length = Math.hypot(...rawRotation);
    if (length < 1e-12) throw new Error(`rigged source: node ${index} rotation is degenerate`);
    node.rotation = rawRotation.map((component) => component / length);
  }

  const baseBufferViews = documentArray(json, 'bufferViews', 'rigged source');
  for (const bufferView of baseBufferViews) {
    if (bufferView.buffer !== 0) {
      throw new Error('rigged source: every bufferView must reference buffer 0');
    }
  }
  const baseAccessors = documentArray(json, 'accessors', 'rigged source');
  const baseMeshes = documentArray(json, 'meshes', 'rigged source');
  const baseMaterials = documentArray(json, 'materials', 'rigged source');
  const baseImages = documentArray(json, 'images', 'rigged source');
  const baseTextures = documentArray(json, 'textures', 'rigged source');
  const baseSamplers = documentArray(json, 'samplers', 'rigged source');

  // Optional repaired streams are inserted after the complete source BIN.
  // They become part of the source namespace before offsets for generated
  // garment resources are captured, so every later remap stays correct.
  const overrideBlobs: ArrayBufferView[] = [];
  let overrideBinLength = 0;
  const addOverrideView = (data: ArrayBufferView, target: number): number => {
    const viewIndex = baseBufferViews.length;
    baseBufferViews.push({
      buffer: 0,
      byteOffset: base.bin.byteLength + overrideBinLength,
      byteLength: data.byteLength,
      target,
    });
    overrideBlobs.push(data);
    overrideBinLength += pad4(data.byteLength);
    return viewIndex;
  };

  if (source.skinOverride) {
    const override = source.skinOverride;
    const primitiveIndex = override.primitiveIndex ?? 0;
    if (
      !Number.isInteger(override.meshIndex) ||
      override.meshIndex < 0 ||
      override.meshIndex >= baseMeshes.length
    ) {
      throw new Error('rigged source: skin override has an invalid mesh index');
    }
    const mesh = baseMeshes[override.meshIndex]!;
    const primitives = mesh.primitives;
    if (
      !Array.isArray(primitives) ||
      !Number.isInteger(primitiveIndex) ||
      primitiveIndex < 0 ||
      primitiveIndex >= primitives.length
    ) {
      throw new Error('rigged source: skin override has an invalid primitive index');
    }
    if (!(override.indices instanceof Uint32Array) || !override.indices.length) {
      throw new Error('rigged source: skin override indices must be a non-empty Uint32Array');
    }
    if (!(override.jointIndices instanceof Uint16Array)) {
      throw new Error('rigged source: skin override joint indices must be a Uint16Array');
    }
    if (!(override.jointWeights instanceof Float32Array)) {
      throw new Error('rigged source: skin override joint weights must be a Float32Array');
    }
    if (
      override.jointIndices.length === 0 ||
      override.jointIndices.length % 4 !== 0 ||
      override.jointWeights.length !== override.jointIndices.length
    ) {
      throw new Error('rigged source: skin override must contain matching non-empty VEC4 streams');
    }
    for (const weight of override.jointWeights) {
      if (!Number.isFinite(weight)) {
        throw new Error('rigged source: skin override weights must be finite');
      }
    }

    const primitive = primitives[primitiveIndex] as GltfRecord | undefined;
    const attributes = primitive?.attributes;
    if (!primitive || !attributes || typeof attributes !== 'object') {
      throw new Error('rigged source: skin override primitive has no attributes');
    }
    const positionAccessorIndex = (attributes as GltfRecord).POSITION;
    const positionAccessor = Number.isInteger(positionAccessorIndex)
      ? baseAccessors[positionAccessorIndex]
      : undefined;
    const vertexCount = override.jointIndices.length / 4;
    if (!positionAccessor || positionAccessor.count !== vertexCount) {
      throw new Error('rigged source: skin override vertex count does not match POSITION');
    }
    let minIndex = 0xffff_ffff;
    let maxIndex = 0;
    for (const index of override.indices) {
      if (index >= vertexCount) {
        throw new Error('rigged source: skin override index is outside POSITION');
      }
      if (index < minIndex) minIndex = index;
      if (index > maxIndex) maxIndex = index;
    }

    const indexAccessor = baseAccessors.length;
    baseAccessors.push({
      bufferView: addOverrideView(override.indices, ELEMENT_ARRAY_BUFFER),
      componentType: UINT32,
      count: override.indices.length,
      type: 'SCALAR',
      min: [minIndex],
      max: [maxIndex],
    });
    const jointsAccessor = baseAccessors.length;
    baseAccessors.push({
      bufferView: addOverrideView(override.jointIndices, ARRAY_BUFFER),
      componentType: UINT16,
      count: vertexCount,
      type: 'VEC4',
    });
    const weightsAccessor = baseAccessors.length;
    baseAccessors.push({
      bufferView: addOverrideView(override.jointWeights, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC4',
    });
    primitive.indices = indexAccessor;
    primitive.attributes = {
      ...(attributes as GltfRecord),
      JOINTS_0: jointsAccessor,
      WEIGHTS_0: weightsAccessor,
    };
  }

  const bufferViewOffset = baseBufferViews.length;
  const accessorOffset = baseAccessors.length;
  const meshOffset = baseMeshes.length;
  const materialOffset = baseMaterials.length;
  const imageOffset = baseImages.length;
  const textureOffset = baseTextures.length;
  const samplerOffset = baseSamplers.length;
  const nodeOffset = baseNodes.length;
  const binOffset = base.bin.byteLength + overrideBinLength;

  const addedBufferViews = documentArray(added, 'bufferViews', 'TOILE pieces');
  for (const bufferView of addedBufferViews) {
    if (bufferView.buffer !== 0) throw new Error('TOILE pieces: only buffer 0 can be merged');
    const byteOffset = bufferView.byteOffset ?? 0;
    if (!Number.isInteger(byteOffset) || byteOffset < 0) {
      throw new Error('TOILE pieces: invalid bufferView offset');
    }
    baseBufferViews.push({ ...bufferView, buffer: 0, byteOffset: binOffset + byteOffset });
  }

  for (const accessor of documentArray(added, 'accessors', 'TOILE pieces')) {
    baseAccessors.push({
      ...accessor,
      ...(accessor.bufferView === undefined
        ? {}
        : { bufferView: accessor.bufferView + bufferViewOffset }),
    });
  }

  for (const image of documentArray(added, 'images', 'TOILE pieces')) {
    baseImages.push({
      ...image,
      ...(image.bufferView === undefined
        ? {}
        : { bufferView: image.bufferView + bufferViewOffset }),
    });
  }
  for (const sampler of documentArray(added, 'samplers', 'TOILE pieces')) {
    baseSamplers.push({ ...sampler });
  }
  for (const texture of documentArray(added, 'textures', 'TOILE pieces')) {
    baseTextures.push({
      ...texture,
      ...(texture.source === undefined ? {} : { source: texture.source + imageOffset }),
      ...(texture.sampler === undefined ? {} : { sampler: texture.sampler + samplerOffset }),
    });
  }

  for (const material of documentArray(added, 'materials', 'TOILE pieces')) {
    const pbr = material.pbrMetallicRoughness as GltfRecord | undefined;
    baseMaterials.push({
      ...material,
      ...(pbr
        ? {
            pbrMetallicRoughness: {
              ...pbr,
              ...(pbr.baseColorTexture === undefined
                ? {}
                : { baseColorTexture: remapTextureInfo(pbr.baseColorTexture, textureOffset) }),
              ...(pbr.metallicRoughnessTexture === undefined
                ? {}
                : {
                    metallicRoughnessTexture: remapTextureInfo(
                      pbr.metallicRoughnessTexture,
                      textureOffset,
                    ),
                  }),
            },
          }
        : {}),
      ...(material.normalTexture === undefined
        ? {}
        : { normalTexture: remapTextureInfo(material.normalTexture, textureOffset) }),
      ...(material.occlusionTexture === undefined
        ? {}
        : { occlusionTexture: remapTextureInfo(material.occlusionTexture, textureOffset) }),
      ...(material.emissiveTexture === undefined
        ? {}
        : { emissiveTexture: remapTextureInfo(material.emissiveTexture, textureOffset) }),
    });
  }

  for (const mesh of documentArray(added, 'meshes', 'TOILE pieces')) {
    const primitives = mesh.primitives;
    if (!Array.isArray(primitives)) throw new Error('TOILE pieces: mesh has no primitives');
    baseMeshes.push({
      ...mesh,
      primitives: primitives.map((primitive: GltfRecord) => {
        const attributes = primitive.attributes;
        if (!attributes || typeof attributes !== 'object') {
          throw new Error('TOILE pieces: primitive has no attributes');
        }
        return {
          ...primitive,
          attributes: Object.fromEntries(
            Object.entries(attributes as GltfRecord).map(([semantic, accessor]) => {
              if (!Number.isInteger(accessor)) {
                throw new Error(`TOILE pieces: invalid ${semantic} accessor`);
              }
              return [semantic, (accessor as number) + accessorOffset];
            }),
          ),
          ...(primitive.indices === undefined
            ? {}
            : { indices: primitive.indices + accessorOffset }),
          ...(primitive.material === undefined
            ? {}
            : { material: primitive.material + materialOffset }),
          ...(Array.isArray(primitive.targets)
            ? {
                targets: primitive.targets.map((target: GltfRecord) =>
                  Object.fromEntries(
                    Object.entries(target).map(([semantic, accessor]) => [
                      semantic,
                      (accessor as number) + accessorOffset,
                    ]),
                  ),
                ),
              }
            : {}),
        };
      }),
    });
  }

  const addedNodes = documentArray(added, 'nodes', 'TOILE pieces');
  for (const node of addedNodes) {
    baseNodes.push({
      ...node,
      ...(node.mesh === undefined ? {} : { mesh: node.mesh + meshOffset }),
      ...(Array.isArray(node.children)
        ? { children: node.children.map((child: number) => child + nodeOffset) }
        : {}),
    });
  }
  const addedScenes = documentArray(added, 'scenes', 'TOILE pieces');
  const addedSceneIndex = added.scene ?? 0;
  const addedScene = addedScenes[addedSceneIndex];
  if (!addedScene || (addedScene.nodes !== undefined && !Array.isArray(addedScene.nodes))) {
    throw new Error('TOILE pieces: invalid active scene');
  }
  const pieceRoots = ((addedScene.nodes as number[] | undefined) ?? []).map(
    (node) => node + nodeOffset,
  );

  const yawNode = baseNodes.length;
  baseNodes.push({
    name: 'TOILE avatar yaw',
    rotation: [0, -Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    children: sourceRoots,
  });
  const normalizationNode = baseNodes.length;
  baseNodes.push({
    name: 'TOILE avatar normalization',
    translation: [...translation],
    scale: [scale, scale, scale],
    children: [yawNode],
  });
  // Parent order is T·S·R, equivalent to runtime T·R·S because the scale is
  // uniform. Rotating the translation (R·T·S) would offset centred avatars.
  activeScene.nodes = [...pieceRoots, normalizationNode];
  json.scene = activeSceneIndex;

  // Optional glTF collections generally require at least one member when the
  // property is present. documentArray creates them to simplify remapping, so
  // remove any that stayed empty in an untextured source/export.
  for (const [key, values] of [
    ['materials', baseMaterials],
    ['images', baseImages],
    ['textures', baseTextures],
    ['samplers', baseSamplers],
  ] as const) {
    if (!values.length) delete json[key];
  }

  const combinedBin = new Uint8Array(binOffset + addition.bin.byteLength);
  combinedBin.set(base.bin, 0);
  let overrideOffset = base.bin.byteLength;
  for (const blob of overrideBlobs) {
    combinedBin.set(
      new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength),
      overrideOffset,
    );
    overrideOffset += pad4(blob.byteLength);
  }
  combinedBin.set(addition.bin, binOffset);
  return encodeEmbeddedGlb(json, combinedBin);
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
export function downloadGlb(
  pieces: GltfPiece[],
  name: string,
  riggedSource?: GltfRiggedSource,
): string | null {
  if (!pieces.length && !riggedSource) return null;
  const data = riggedSource
    ? buildGlbWithRiggedSource(pieces, riggedSource)
    : buildGlb(pieces);
  const blob = new Blob([data], { type: 'model/gltf-binary' });
  const filename = `toile-${name.replace(/[^a-z0-9]/gi, '-')}.glb`;
  return downloadBrowserBlob(blob, filename);
}
