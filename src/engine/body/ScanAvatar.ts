/**
 * ScanAvatar — loads a scanned human avatar baked by tools/bake.py:
 *   <base>.mesh.bin : uint32 vertCount, uint32 triCount, pos f32x3*V,
 *                     normal f32x3*V, idx u32x3*T,
 *                     optional color u8x3*V         (render mesh, ~60k tris)
 *   <base>.sdf.bin  : uint32 nx,ny,nz, f32 min[3], f32 max[3],
 *                     int16 sdf_mm[nx*ny*nz]        (x fastest, then y, then z)
 * Historical avatars display the mesh directly. A high-detail avatar may add
 * an independent UV/PBR visual GLB while keeping this closed mesh exclusively
 * for proximity/collision checks. Sources and licences are documented in
 * public/avatars/README.md.
 */
import type { V3 } from './BodySdf';

export interface ScanMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Optional source-derived sRGB vertex colours, normalized to [0,1]. */
  colors?: Float32Array;
}

/** High-detail display/export mesh. It is deliberately independent from the
 * watertight, aggressively decimated collision mesh above: UV seams are real
 * duplicate vertices and must never be welded for SDF baking. */
export interface ScanVisualMesh extends ScanMesh {
  uvs: Float32Array;
  /** Optional glTF tangent (xyz + handedness), retained for faithful export. */
  tangents?: Float32Array;
}

export interface ScanTexture {
  /** Original compressed image bytes, kept verbatim for a lossless GLB export. */
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  /** Down-sized decode used only by the live WebGPU viewport. */
  bitmap?: ImageBitmap;
}

export interface ScanAppearance {
  baseColor?: ScanTexture;
  normal?: ScanTexture;
  metallicRoughness?: ScanTexture;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  normalScale: number;
  /** glTF material sidedness; false is the specification default. */
  doubleSided: boolean;
}

/** glTF matrices are column-major, as required by the glTF 2.0 specification. */
export type ScanMatrix4 = Float64Array;

export type ScanNodeTransform =
  | { kind: 'matrix'; matrix: ScanMatrix4 }
  | {
      kind: 'trs';
      translation: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    };

/** One source glTF node. Non-joint parents are retained because their
 * transforms participate in the joint world matrices. */
export interface ScanRigNode {
  index: number;
  name: string;
  parent: number;
  children: Uint32Array;
  sourceTransform: ScanNodeTransform;
  restLocalMatrix: ScanMatrix4;
}

/** Vertex influences and bind data for the visual mesh. `jointIndices`
 * contains ordinals into `joints`, not glTF node indices. */
export interface ScanRigSkin {
  index: number;
  name: string;
  /** Source glTF mesh owning the skinned primitive. */
  meshIndex: number;
  meshNode: number;
  /** Explicit glTF `skin.skeleton`, if supplied. */
  skeletonRoot: number | null;
  /** Joint nodes without an ancestor in this skin (computed even if omitted). */
  jointRoots: Uint32Array;
  /** Skin ordinal -> glTF node index. */
  joints: Uint32Array;
  /** Skin ordinal -> closest ancestor skin ordinal, or -1 at the root. */
  jointParents: Int32Array;
  inverseBindMatrices: Float32Array;
  jointIndices: Uint8Array | Uint16Array;
  jointWeights: Float32Array;
  meshWorldMatrix: ScanMatrix4;
  inverseMeshWorldMatrix: ScanMatrix4;
}

/** Complete native rest rig. It intentionally stays in source coordinates;
 * `ScanVisualNormalization` supplies the exact conjugation used by runtime
 * posing without modifying the source GLB. */
export interface ScanRig {
  scene: number;
  sceneRoots: Uint32Array;
  nodes: ScanRigNode[];
  /** Packed column-major node world matrices (16 values per node). */
  restWorldMatrices: Float64Array;
  skin: ScanRigSkin;
}

/** Uniform source-to-runtime placement applied to the visual mesh. */
export interface ScanVisualNormalization {
  sourceMin: V3;
  sourceMax: V3;
  targetHeightM: number;
  scale: number;
  translation: V3;
  /** Yaw in TOILE's podium convention (positive turns +Z toward -X). */
  yawRadians: number;
  matrix: ScanMatrix4;
  inverseMatrix: ScanMatrix4;
}

/** Exact GLB URL plus the in-memory transform applied after parsing. Keeping
 * both is enough for a future rig-preserving exporter to reuse the source. */
export interface ScanVisualSource {
  url: string;
  normalization: ScanVisualNormalization;
}

export interface ScanSdfGrid {
  dims: [number, number, number];
  min: V3;
  max: V3;
  data: Float32Array;
}

/** A collision surface and its signed-distance field in one certified pose. */
export interface ScanCollisionPose {
  mesh: ScanMesh;
  grid: ScanSdfGrid;
}

export interface ScanAvatar {
  mesh: ScanMesh;
  /** Faithful UV/PBR representation used for display and export. */
  visual?: ScanVisualMesh;
  appearance?: ScanAppearance;
  rig?: ScanRig;
  visualSource?: ScanVisualSource;
  /** Optional separate full-resolution GLB, fetched only when the user exports. */
  exportVisualUrl?: string;
  grid: ScanSdfGrid;
  /** Pose preset -> independently baked collision matching the skinned visual. */
  collisionPoses?: Record<string, ScanCollisionPose>;
  /** Deferred pose assets. Each loader deduplicates concurrent requests. */
  collisionPoseLoaders?: Record<string, () => Promise<ScanCollisionPose | null>>;
}

// Cache bookkeeping stays private to this module: callers only see certified
// pose fields, while every successful lookup refreshes true LRU recency.
const collisionPoseCacheTouches = new WeakMap<ScanAvatar, (pose: string) => void>();

/** Select a collision field only when it is certified for the requested pose. */
export function scanCollisionForPose(
  scan: ScanAvatar,
  pose: string,
): ScanCollisionPose | null {
  if (pose === 'native') return { mesh: scan.mesh, grid: scan.grid };
  const collision = scan.collisionPoses?.[pose] ?? null;
  if (collision) collisionPoseCacheTouches.get(scan)?.(pose);
  return collision;
}

/** True when a pose is native, already loaded, or declared for lazy loading. */
export function scanHasCollisionPose(scan: ScanAvatar, pose: string): boolean {
  return pose === 'native' || Boolean(
    scan.collisionPoses?.[pose] || scan.collisionPoseLoaders?.[pose],
  );
}

/** Load one certified articulated collider on first use and cache the result. */
export async function ensureScanCollisionForPose(
  scan: ScanAvatar,
  pose: string,
): Promise<ScanCollisionPose | null> {
  const loaded = scanCollisionForPose(scan, pose);
  if (loaded) return loaded;
  return scan.collisionPoseLoaders?.[pose]?.() ?? null;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: unknown;
}

interface GltfBufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfSkin {
  name?: string;
  inverseBindMatrices?: number;
  joints?: number[];
  skeleton?: number;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const componentCount = (type: string): number => {
  if (type === 'SCALAR') return 1;
  if (type === 'VEC2') return 2;
  if (type === 'VEC3') return 3;
  if (type === 'VEC4') return 4;
  if (type === 'MAT4') return 16;
  throw new Error(`unsupported visual accessor type ${type}`);
};

const componentSize = (type: number): number => {
  if (type === 5120 || type === 5121) return 1;
  if (type === 5122 || type === 5123) return 2;
  if (type === 5125 || type === 5126) return 4;
  throw new Error(`unsupported visual component type ${type}`);
};

function readComponent(view: DataView, offset: number, type: number, normalized = false): number {
  if (type === 5126) return view.getFloat32(offset, true);
  if (type === 5125) return view.getUint32(offset, true);
  if (type === 5123) return normalized ? view.getUint16(offset, true) / 65535 : view.getUint16(offset, true);
  if (type === 5122) {
    const value = view.getInt16(offset, true);
    return normalized ? Math.max(-1, value / 32767) : value;
  }
  if (type === 5121) return normalized ? view.getUint8(offset) / 255 : view.getUint8(offset);
  const value = view.getInt8(offset);
  return normalized ? Math.max(-1, value / 127) : value;
}

const identityMatrix4 = (): ScanMatrix4 => new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const multiplyMatrix4 = (a: ArrayLike<number>, b: ArrayLike<number>): ScanMatrix4 => {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let inner = 0; inner < 4; inner++) {
        value += a[inner * 4 + row]! * b[column * 4 + inner]!;
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
};

/** Small, allocation-light Gauss-Jordan inverse. Rig setup calls it once. */
const inverseMatrix4 = (matrix: ArrayLike<number>): ScanMatrix4 => {
  const rows = Array.from({ length: 4 }, (_, row) => {
    const values = new Float64Array(8);
    for (let column = 0; column < 4; column++) values[column] = matrix[column * 4 + row]!;
    values[row + 4] = 1;
    return values;
  });
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) <= 1e-12) {
      throw new Error('visual rig contains a singular matrix');
    }
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    const pivotRow = rows[column]!;
    for (let item = 0; item < 8; item++) pivotRow[item] = pivotRow[item]! / divisor;
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      const targetRow = rows[row]!;
      for (let item = 0; item < 8; item++) {
        targetRow[item] = targetRow[item]! - factor * pivotRow[item]!;
      }
    }
  }
  const result = new Float64Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) result[column * 4 + row] = rows[row]![column + 4]!;
  }
  return result;
};

const finiteTuple = <T extends number[]>(
  raw: number[] | undefined,
  fallback: T,
  length: number,
  label: string,
): T => {
  const values = raw ?? fallback;
  if (values.length !== length || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`invalid visual rig ${label}`);
  }
  return [...values] as T;
};

const nodeTransform = (node: GltfNode, index: number): {
  source: ScanNodeTransform;
  matrix: ScanMatrix4;
} => {
  if (node.matrix !== undefined) {
    if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) {
      throw new Error(`visual rig node ${index} mixes matrix and TRS`);
    }
    const source = finiteTuple(node.matrix, new Array(16).fill(0), 16, `node ${index} matrix`);
    const matrix = Float64Array.from(source);
    return { source: { kind: 'matrix', matrix: new Float64Array(matrix) }, matrix };
  }
  const translation = finiteTuple(
    node.translation,
    [0, 0, 0],
    3,
    `node ${index} translation`,
  ) as [number, number, number];
  const rotation = finiteTuple(
    node.rotation,
    [0, 0, 0, 1],
    4,
    `node ${index} rotation`,
  ) as [number, number, number, number];
  const scale = finiteTuple(
    node.scale,
    [1, 1, 1],
    3,
    `node ${index} scale`,
  ) as [number, number, number];
  const quaternionLength = Math.hypot(...rotation);
  if (quaternionLength <= 1e-12) throw new Error(`invalid visual rig node ${index} rotation`);
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const [tx, ty, tz] = translation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const matrix = new Float64Array([
    (1 - 2 * (yy + zz)) * sx,
    (2 * (xy + wz)) * sx,
    (2 * (xz - wy)) * sx,
    0,
    (2 * (xy - wz)) * sy,
    (1 - 2 * (xx + zz)) * sy,
    (2 * (yz + wx)) * sy,
    0,
    (2 * (xz + wy)) * sz,
    (2 * (yz - wx)) * sz,
    (1 - 2 * (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
  return {
    source: { kind: 'trs', translation, rotation, scale },
    matrix,
  };
};

/**
 * Parse the deliberately small glTF subset used by scanned or generated
 * avatars. Unlike the collision bake this preserves UVs and optional PBR
 * maps. Exported for deterministic parser tests.
 */
export function parseScanVisualGlb(glb: ArrayBuffer): {
  mesh: ScanVisualMesh;
  appearance: ScanAppearance;
  rig?: ScanRig;
} {
  if (glb.byteLength < 20) throw new Error('truncated visual GLB');
  const header = new DataView(glb);
  if (header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(4, true) !== 2) {
    throw new Error('invalid visual GLB header');
  }
  const declaredLength = header.getUint32(8, true);
  if (declaredLength !== glb.byteLength) throw new Error('invalid visual GLB declared length');
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength + 8 > declaredLength) {
    throw new Error('invalid visual GLB JSON chunk');
  }
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)),
  ) as {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    scene?: number;
    scenes?: Array<{ name?: string; nodes?: number[] }>;
    nodes?: GltfNode[];
    skins?: GltfSkin[];
    meshes?: Array<{ primitives?: Array<{
      attributes?: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }> }>;
    materials?: Array<{
      pbrMetallicRoughness?: {
        baseColorFactor?: [number, number, number, number];
        baseColorTexture?: { index: number };
        metallicRoughnessTexture?: { index: number };
        metallicFactor?: number;
        roughnessFactor?: number;
      };
      normalTexture?: { index: number; scale?: number };
      doubleSided?: boolean;
    }>;
    textures?: Array<{ source?: number }>;
    images?: Array<{ bufferView?: number; mimeType?: string }>;
  };
  const binHeader = 20 + jsonLength;
  const binLength = header.getUint32(binHeader, true);
  if (header.getUint32(binHeader + 4, true) !== CHUNK_BIN || binHeader + 8 + binLength > declaredLength) {
    throw new Error('invalid visual GLB BIN chunk');
  }
  const binOffset = binHeader + 8;
  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];
  const primitiveRefs = (json.meshes ?? []).flatMap((mesh, meshIndex) =>
    (mesh.primitives ?? []).map((primitive) => ({ meshIndex, primitive })),
  );
  if (primitiveRefs.length !== 1) throw new Error('visual GLB must contain exactly one primitive');
  const { meshIndex, primitive } = primitiveRefs[0]!;
  if (!primitive?.attributes || primitive.indices === undefined) {
    throw new Error('visual GLB has no indexed mesh primitive');
  }
  if ((primitive.mode ?? 4) !== 4) throw new Error('visual GLB primitive is not triangles');

  const accessorLayout = (accessorIndex: number, expectedType: string) => {
    const accessor = accessors[accessorIndex];
    if (!accessor || accessor.type !== expectedType) throw new Error(`missing ${expectedType} visual accessor`);
    if (accessor.sparse !== undefined) throw new Error('sparse visual accessors are not supported');
    if (accessor.bufferView === undefined) throw new Error('missing visual accessor bufferView');
    const source = bufferViews[accessor.bufferView];
    if (!source) throw new Error('missing visual bufferView');
    if ((source.buffer ?? 0) !== 0) throw new Error('visual accessor references a non-GLB buffer');
    const count = componentCount(accessor.type);
    const size = componentSize(accessor.componentType);
    const packedStride = count * size;
    const stride = source.byteStride ?? count * size;
    if (!Number.isInteger(stride) || stride < packedStride) throw new Error('invalid visual accessor stride');
    const start = binOffset + (source.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const end = start + Math.max(0, accessor.count - 1) * stride + count * size;
    if (
      !Number.isInteger(accessor.count) ||
      accessor.count < 0 ||
      start < binOffset ||
      end > binOffset + binLength ||
      end > binOffset + (source.byteOffset ?? 0) + source.byteLength
    ) {
      throw new Error('truncated visual accessor');
    }
    return { accessor, count, size, stride, start };
  };

  const floats = (accessorIndex: number, expectedType: string): Float32Array => {
    const { accessor, count, size, stride, start } = accessorLayout(accessorIndex, expectedType);
    const sourceView = new DataView(glb);
    const result = new Float32Array(accessor.count * count);
    for (let item = 0; item < accessor.count; item++) {
      for (let component = 0; component < count; component++) {
        result[item * count + component] = readComponent(
          sourceView,
          start + item * stride + component * size,
          accessor.componentType,
          accessor.normalized,
        );
      }
    }
    return result;
  };

  const integerVectors4 = (accessorIndex: number): Uint8Array | Uint16Array => {
    const { accessor, stride, start } = accessorLayout(accessorIndex, 'VEC4');
    if (accessor.normalized || (accessor.componentType !== 5121 && accessor.componentType !== 5123)) {
      throw new Error('visual rig JOINTS_0 must use unnormalized unsigned bytes or shorts');
    }
    const sourceView = new DataView(glb);
    const result = accessor.componentType === 5121
      ? new Uint8Array(accessor.count * 4)
      : new Uint16Array(accessor.count * 4);
    const size = componentSize(accessor.componentType);
    for (let item = 0; item < accessor.count; item++) {
      for (let component = 0; component < 4; component++) {
        result[item * 4 + component] = readComponent(
          sourceView,
          start + item * stride + component * size,
          accessor.componentType,
        );
      }
    }
    return result;
  };

  const indices = (accessorIndex: number): Uint32Array => {
    const { accessor, stride, start } = accessorLayout(accessorIndex, 'SCALAR');
    if (accessor.componentType !== 5121 && accessor.componentType !== 5123 && accessor.componentType !== 5125) {
      throw new Error('visual GLB indices must be unsigned integers');
    }
    const sourceView = new DataView(glb);
    const result = new Uint32Array(accessor.count);
    for (let item = 0; item < accessor.count; item++) {
      result[item] = readComponent(sourceView, start + item * stride, accessor.componentType) >>> 0;
    }
    return result;
  };

  const positionAccessor = primitive.attributes.POSITION;
  const normalAccessor = primitive.attributes.NORMAL;
  const uvAccessor = primitive.attributes.TEXCOORD_0;
  if (positionAccessor === undefined || normalAccessor === undefined || uvAccessor === undefined) {
    throw new Error('visual GLB must contain POSITION, NORMAL and TEXCOORD_0');
  }
  const mesh: ScanVisualMesh = {
    positions: floats(positionAccessor, 'VEC3'),
    normals: floats(normalAccessor, 'VEC3'),
    uvs: floats(uvAccessor, 'VEC2'),
    indices: indices(primitive.indices),
    ...(primitive.attributes.TANGENT !== undefined
      ? { tangents: floats(primitive.attributes.TANGENT, 'VEC4') }
      : {}),
  };
  const vertexCount = mesh.positions.length / 3;
  if (
    mesh.normals.length !== vertexCount * 3 ||
    mesh.uvs.length !== vertexCount * 2 ||
    (mesh.tangents && mesh.tangents.length !== vertexCount * 4)
  ) {
    throw new Error('visual GLB attribute counts do not match POSITION');
  }
  if (mesh.indices.length % 3 !== 0) throw new Error('visual GLB index count is not triangular');
  for (const values of [mesh.positions, mesh.normals, mesh.uvs, ...(mesh.tangents ? [mesh.tangents] : [])]) {
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error('visual GLB contains a non-finite attribute');
    }
  }
  for (const index of mesh.indices) {
    if (index >= vertexCount) throw new Error('visual GLB index exceeds POSITION count');
  }

  const jointsAccessorIndex = primitive.attributes.JOINTS_0;
  const weightsAccessorIndex = primitive.attributes.WEIGHTS_0;
  if ((jointsAccessorIndex === undefined) !== (weightsAccessorIndex === undefined)) {
    throw new Error('visual rig must contain both JOINTS_0 and WEIGHTS_0');
  }
  let rig: ScanRig | undefined;
  if (jointsAccessorIndex !== undefined && weightsAccessorIndex !== undefined) {
    const sourceNodes = json.nodes ?? [];
    if (sourceNodes.length === 0) throw new Error('visual rig has no nodes');
    const parents = new Int32Array(sourceNodes.length);
    parents.fill(-1);
    const parsedNodes = sourceNodes.map((node, index): ScanRigNode => {
      const { source, matrix } = nodeTransform(node, index);
      const children = node.children ?? [];
      const seenChildren = new Set<number>();
      for (const child of children) {
        if (!Number.isInteger(child) || child < 0 || child >= sourceNodes.length) {
          throw new Error(`visual rig node ${index} has an invalid child`);
        }
        if (child === index || seenChildren.has(child)) {
          throw new Error(`visual rig node ${index} has a duplicate or self child`);
        }
        seenChildren.add(child);
        if (parents[child] !== -1) throw new Error(`visual rig node ${child} has multiple parents`);
        parents[child] = index;
      }
      return {
        index,
        name: node.name ?? '',
        parent: -1,
        children: Uint32Array.from(children),
        sourceTransform: source,
        restLocalMatrix: matrix,
      };
    });
    for (let index = 0; index < parsedNodes.length; index++) parsedNodes[index]!.parent = parents[index]!;

    // Validate the complete node graph, including nodes outside the active
    // scene. Otherwise a malformed joint subtree could recurse forever later.
    const state = new Uint8Array(sourceNodes.length);
    const visit = (index: number): void => {
      if (state[index] === 1) throw new Error('visual rig node hierarchy contains a cycle');
      if (state[index] === 2) return;
      state[index] = 1;
      for (const child of parsedNodes[index]!.children) visit(child);
      state[index] = 2;
    };
    for (let index = 0; index < sourceNodes.length; index++) visit(index);

    const sourceScenes = json.scenes ?? [];
    const sceneIndex = json.scene ?? (sourceScenes.length > 0 ? 0 : -1);
    if (sceneIndex < -1 || sceneIndex >= sourceScenes.length) {
      throw new Error('visual rig references an invalid scene');
    }
    const roots = sceneIndex >= 0
      ? sourceScenes[sceneIndex]!.nodes ?? []
      : parsedNodes.filter((node) => node.parent < 0).map((node) => node.index);
    const uniqueRoots = new Set<number>();
    for (const root of roots) {
      if (!Number.isInteger(root) || root < 0 || root >= sourceNodes.length || uniqueRoots.has(root)) {
        throw new Error('visual rig scene has an invalid root');
      }
      uniqueRoots.add(root);
    }
    if (uniqueRoots.size === 0) throw new Error('visual rig scene has no roots');
    const reachable = new Uint8Array(sourceNodes.length);
    const markReachable = (index: number): void => {
      if (reachable[index]) return;
      reachable[index] = 1;
      for (const child of parsedNodes[index]!.children) markReachable(child);
    };
    for (const root of uniqueRoots) markReachable(root);

    const meshNodes = sourceNodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.mesh === meshIndex);
    if (meshNodes.length !== 1 || meshNodes[0]!.node.skin === undefined) {
      throw new Error('visual rig mesh must have exactly one skinned node');
    }
    const meshNode = meshNodes[0]!.index;
    if (!reachable[meshNode]) throw new Error('visual rig mesh node is outside the active scene');
    const skinIndex = meshNodes[0]!.node.skin!;
    const sourceSkin = json.skins?.[skinIndex];
    const sourceJoints = sourceSkin?.joints ?? [];
    if (!sourceSkin || sourceJoints.length === 0) throw new Error('visual rig has an invalid skin');
    const jointNodeSet = new Set<number>();
    for (const nodeIndex of sourceJoints) {
      if (
        !Number.isInteger(nodeIndex) ||
        nodeIndex < 0 ||
        nodeIndex >= sourceNodes.length ||
        jointNodeSet.has(nodeIndex)
      ) {
        throw new Error('visual rig skin contains an invalid or duplicate joint');
      }
      if (!reachable[nodeIndex]) throw new Error('visual rig joint is outside the active scene');
      jointNodeSet.add(nodeIndex);
    }
    const skeletonRoot = sourceSkin.skeleton ?? null;
    if (
      skeletonRoot !== null &&
      (!Number.isInteger(skeletonRoot) || skeletonRoot < 0 || skeletonRoot >= sourceNodes.length)
    ) {
      throw new Error('visual rig has an invalid skeleton root');
    }

    const jointOrdinal = new Map<number, number>();
    sourceJoints.forEach((nodeIndex, ordinal) => jointOrdinal.set(nodeIndex, ordinal));
    const jointParents = new Int32Array(sourceJoints.length);
    jointParents.fill(-1);
    const jointRoots: number[] = [];
    for (let ordinal = 0; ordinal < sourceJoints.length; ordinal++) {
      let parent = parents[sourceJoints[ordinal]!]!;
      while (parent >= 0 && !jointOrdinal.has(parent)) parent = parents[parent]!;
      if (parent >= 0) jointParents[ordinal] = jointOrdinal.get(parent)!;
      else jointRoots.push(sourceJoints[ordinal]!);
    }
    if (skeletonRoot !== null) {
      for (const joint of sourceJoints) {
        let ancestor = joint;
        while (ancestor >= 0 && ancestor !== skeletonRoot) ancestor = parents[ancestor]!;
        if (ancestor !== skeletonRoot) {
          throw new Error('visual rig skeleton root is not an ancestor of every joint');
        }
      }
    }

    const jointIndices = integerVectors4(jointsAccessorIndex);
    const weightsAccessor = accessors[weightsAccessorIndex];
    if (
      !weightsAccessor ||
      (!(
        weightsAccessor.componentType === 5126 && !weightsAccessor.normalized
      ) &&
        !(
          (weightsAccessor.componentType === 5121 || weightsAccessor.componentType === 5123) &&
          weightsAccessor.normalized
        ))
    ) {
      throw new Error('visual rig WEIGHTS_0 must use floats or normalized unsigned integers');
    }
    const jointWeights = floats(weightsAccessorIndex, 'VEC4');
    if (jointIndices.length !== vertexCount * 4 || jointWeights.length !== vertexCount * 4) {
      throw new Error('visual rig influence counts do not match POSITION');
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      let weightSum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const offset = vertex * 4 + influence;
        const weight = jointWeights[offset]!;
        if (!Number.isFinite(weight) || weight < 0) throw new Error('visual rig contains an invalid weight');
        if (jointIndices[offset]! >= sourceJoints.length) {
          throw new Error('visual rig contains a joint ordinal outside its skin');
        }
        weightSum += weight;
      }
      if (weightSum <= 1e-8) throw new Error('visual rig contains a vertex without skin weight');
    }

    let inverseBindMatrices: Float32Array;
    if (sourceSkin.inverseBindMatrices === undefined) {
      inverseBindMatrices = new Float32Array(sourceJoints.length * 16);
      for (let joint = 0; joint < sourceJoints.length; joint++) {
        inverseBindMatrices[joint * 16] = 1;
        inverseBindMatrices[joint * 16 + 5] = 1;
        inverseBindMatrices[joint * 16 + 10] = 1;
        inverseBindMatrices[joint * 16 + 15] = 1;
      }
    } else {
      const inverseBindAccessor = accessors[sourceSkin.inverseBindMatrices];
      if (
        !inverseBindAccessor ||
        inverseBindAccessor.componentType !== 5126 ||
        inverseBindAccessor.normalized ||
        inverseBindAccessor.count !== sourceJoints.length
      ) {
        throw new Error('visual rig inverse bind accessor must be FLOAT MAT4 per joint');
      }
      inverseBindMatrices = floats(sourceSkin.inverseBindMatrices, 'MAT4');
    }

    const restWorldMatrices = new Float64Array(sourceNodes.length * 16);
    const worldReady = new Uint8Array(sourceNodes.length);
    const worldMatrix = (index: number): ScanMatrix4 => {
      const offset = index * 16;
      if (!worldReady[index]) {
        const parent = parents[index]!;
        const world = parent >= 0
          ? multiplyMatrix4(worldMatrix(parent), parsedNodes[index]!.restLocalMatrix)
          : new Float64Array(parsedNodes[index]!.restLocalMatrix);
        restWorldMatrices.set(world, offset);
        worldReady[index] = 1;
      }
      return restWorldMatrices.subarray(offset, offset + 16);
    };
    for (let index = 0; index < sourceNodes.length; index++) worldMatrix(index);
    const meshWorldMatrix = new Float64Array(worldMatrix(meshNode));
    rig = {
      scene: sceneIndex,
      sceneRoots: Uint32Array.from(uniqueRoots),
      nodes: parsedNodes,
      restWorldMatrices,
      skin: {
        index: skinIndex,
        name: sourceSkin.name ?? '',
        meshIndex,
        meshNode,
        skeletonRoot,
        jointRoots: Uint32Array.from(jointRoots),
        joints: Uint32Array.from(sourceJoints),
        jointParents,
        inverseBindMatrices,
        jointIndices,
        jointWeights,
        meshWorldMatrix,
        inverseMeshWorldMatrix: inverseMatrix4(meshWorldMatrix),
      },
    };
  }

  const material = json.materials?.[primitive.material ?? -1];
  const pbr = material?.pbrMetallicRoughness;
  const texture = (textureIndex: number | undefined): ScanTexture | undefined => {
    if (textureIndex === undefined) return undefined;
    const imageIndex = json.textures?.[textureIndex]?.source;
    if (imageIndex === undefined) return undefined;
    const image = json.images?.[imageIndex];
    const viewIndex = image?.bufferView;
    const mimeType = image?.mimeType;
    if (viewIndex === undefined || (mimeType !== 'image/jpeg' && mimeType !== 'image/png')) return undefined;
    const source = bufferViews[viewIndex];
    if (!source) return undefined;
    const start = binOffset + (source.byteOffset ?? 0);
    const end = start + source.byteLength;
    if (end > binOffset + binLength) throw new Error('truncated visual texture');
    return { bytes: new Uint8Array(glb.slice(start, end)), mimeType };
  };
  const appearance: ScanAppearance = {
    baseColor: texture(pbr?.baseColorTexture?.index),
    normal: texture(material?.normalTexture?.index),
    metallicRoughness: texture(pbr?.metallicRoughnessTexture?.index),
    baseColorFactor: pbr?.baseColorFactor ?? [1, 1, 1, 1],
    metallicFactor: pbr?.metallicFactor ?? 1,
    roughnessFactor: pbr?.roughnessFactor ?? 1,
    normalScale: material?.normalTexture?.scale ?? 1,
    doubleSided: material?.doubleSided ?? false,
  };
  return { mesh, appearance, ...(rig ? { rig } : {}) };
}

const visualBounds = (mesh: ScanVisualMesh): { min: V3; max: V3 } => {
  if (mesh.positions.length < 3 || mesh.positions.length % 3 !== 0) {
    throw new Error('visual mesh has no valid positions');
  }
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[offset + axis]!;
      if (!Number.isFinite(value)) throw new Error('visual mesh contains a non-finite position');
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min, max };
};

/** Exact source-to-runtime transform: uniform height scale, optional Y yaw,
 * feet at Y=0 and horizontal centring. The inverse is retained for rigging. */
export function computeScanVisualNormalization(
  mesh: ScanVisualMesh,
  targetHeightM: number,
  yawRadians = 0,
): ScanVisualNormalization {
  if (!Number.isFinite(targetHeightM) || targetHeightM <= 0) {
    throw new Error('visual target height must be a finite positive number');
  }
  const { min, max } = visualBounds(mesh);
  const sourceHeight = max[1] - min[1];
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 1e-8) {
    throw new Error('visual mesh has no measurable Y-up height');
  }
  if (!Number.isFinite(yawRadians)) {
    throw new Error('visual yaw must be finite');
  }
  const scale = targetHeightM / sourceHeight;
  const centreX = (min[0] + max[0]) * 0.5;
  const centreZ = (min[2] + max[2]) * 0.5;
  const cosine = Math.cos(yawRadians);
  const sine = Math.sin(yawRadians);
  const cleanZero = (value: number): number => (Object.is(value, -0) ? 0 : value);
  const translation: V3 = [
    cleanZero(-(cosine * centreX - sine * centreZ) * scale),
    cleanZero(-min[1] * scale),
    cleanZero(-(sine * centreX + cosine * centreZ) * scale),
  ];
  const matrix = new Float64Array([
    cosine * scale, 0, sine * scale, 0,
    0, scale, 0, 0,
    -sine * scale, 0, cosine * scale, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
  const inverseScale = 1 / scale;
  const inverseMatrix = new Float64Array([
    cosine * inverseScale, 0, -sine * inverseScale, 0,
    0, inverseScale, 0, 0,
    sine * inverseScale, 0, cosine * inverseScale, 0,
    centreX, min[1], centreZ, 1,
  ]);
  return {
    sourceMin: [...min],
    sourceMax: [...max],
    targetHeightM,
    scale,
    translation,
    yawRadians,
    matrix,
    inverseMatrix,
  };
}

/** Identity placement used when a caller deliberately keeps source units. */
export function identityScanVisualNormalization(mesh: ScanVisualMesh): ScanVisualNormalization {
  const { min, max } = visualBounds(mesh);
  return {
    sourceMin: [...min],
    sourceMax: [...max],
    targetHeightM: max[1] - min[1],
    scale: 1,
    translation: [0, 0, 0],
    yawRadians: 0,
    matrix: identityMatrix4(),
    inverseMatrix: identityMatrix4(),
  };
}

export function applyScanVisualNormalization(
  mesh: ScanVisualMesh,
  normalization: ScanVisualNormalization,
): ScanVisualMesh {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const matrix = normalization.matrix;
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const x = mesh.positions[offset]!;
    const y = mesh.positions[offset + 1]!;
    const z = mesh.positions[offset + 2]!;
    positions[offset] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
    positions[offset + 1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
    positions[offset + 2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;

    const nx = mesh.normals[offset]!;
    const ny = mesh.normals[offset + 1]!;
    const nz = mesh.normals[offset + 2]!;
    const transformed: V3 = [
      matrix[0]! * nx + matrix[4]! * ny + matrix[8]! * nz,
      matrix[1]! * nx + matrix[5]! * ny + matrix[9]! * nz,
      matrix[2]! * nx + matrix[6]! * ny + matrix[10]! * nz,
    ];
    const length = Math.hypot(...transformed) || 1;
    normals[offset] = transformed[0] / length;
    normals[offset + 1] = transformed[1] / length;
    normals[offset + 2] = transformed[2] / length;
  }
  let tangents: Float32Array | undefined;
  if (mesh.tangents) {
    tangents = new Float32Array(mesh.tangents.length);
    for (let offset = 0; offset < mesh.tangents.length; offset += 4) {
      const tx = mesh.tangents[offset]!;
      const ty = mesh.tangents[offset + 1]!;
      const tz = mesh.tangents[offset + 2]!;
      const transformed: V3 = [
        matrix[0]! * tx + matrix[4]! * ty + matrix[8]! * tz,
        matrix[1]! * tx + matrix[5]! * ty + matrix[9]! * tz,
        matrix[2]! * tx + matrix[6]! * ty + matrix[10]! * tz,
      ];
      const length = Math.hypot(...transformed) || 1;
      tangents[offset] = transformed[0] / length;
      tangents[offset + 1] = transformed[1] / length;
      tangents[offset + 2] = transformed[2] / length;
      tangents[offset + 3] = mesh.tangents[offset + 3]!;
    }
  }
  return { ...mesh, positions, normals, ...(tangents ? { tangents } : {}) };
}

/**
 * Place a native Y-up visual at a real-world stature without rewriting its
 * GLB. The operation is deliberately limited to one uniform scale plus a
 * translation: proportions, pose, normals, UVs, indices and textures remain
 * exactly those of the supplied model.
 */
export function normalizeScanVisualMesh(
  mesh: ScanVisualMesh,
  targetHeightM: number,
): ScanVisualMesh {
  return applyScanVisualNormalization(mesh, computeScanVisualNormalization(mesh, targetHeightM));
}

/** Parse the backward-compatible mesh block, including optional RGB8 colour. */
export function parseScanMesh(meshBuf: ArrayBuffer): ScanMesh {
  if (meshBuf.byteLength < 8) throw new Error('truncated avatar mesh header');
  const mv = new DataView(meshBuf);
  const vertCount = mv.getUint32(0, true);
  const triCount = mv.getUint32(4, true);
  const positionsOffset = 8;
  const normalsOffset = positionsOffset + vertCount * 12;
  const indicesOffset = normalsOffset + vertCount * 12;
  const colorsOffset = indicesOffset + triCount * 12;
  if (colorsOffset > meshBuf.byteLength) throw new Error('truncated avatar mesh data');
  const remaining = meshBuf.byteLength - colorsOffset;
  if (remaining !== 0 && remaining !== vertCount * 3) {
    throw new Error('invalid avatar mesh appearance block');
  }
  const positions = new Float32Array(meshBuf, positionsOffset, vertCount * 3);
  const normals = new Float32Array(meshBuf, normalsOffset, vertCount * 3);
  const indices = new Uint32Array(meshBuf, indicesOffset, triCount * 3);
  let colors: Float32Array | undefined;
  if (remaining) {
    const packed = new Uint8Array(meshBuf, colorsOffset, vertCount * 3);
    colors = new Float32Array(packed.length);
    for (let index = 0; index < packed.length; index++) {
      colors[index] = packed[index]! / 255;
    }
  }
  return { positions, normals, indices, ...(colors ? { colors } : {}) };
}

/** Decode the compact int16-millimetre SDF used by scanned avatars. */
export function parseScanSdf(sdfBuf: ArrayBuffer): ScanSdfGrid {
  if (sdfBuf.byteLength < 36) throw new Error('scan SDF header is truncated');
  const view = new DataView(sdfBuf);
  const dims: [number, number, number] = [
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
  ];
  if (dims.some((dimension) => dimension < 2 || dimension > 256)) {
    throw new Error('scan SDF dimensions must be between 2 and 256');
  }
  const cellCount = dims[0] * dims[1] * dims[2];
  if (!Number.isSafeInteger(cellCount) || sdfBuf.byteLength !== 36 + cellCount * 2) {
    throw new Error('scan SDF byte length does not match its dimensions');
  }
  const min: V3 = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  const max: V3 = [
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  ];
  for (let axis = 0; axis < 3; axis++) {
    if (
      !Number.isFinite(min[axis]) ||
      !Number.isFinite(max[axis]) ||
      max[axis]! <= min[axis]!
    ) {
      throw new Error('scan SDF contains invalid bounds');
    }
  }
  const millimetres = new Int16Array(sdfBuf, 36, cellCount);
  const data = new Float32Array(cellCount);
  for (let index = 0; index < cellCount; index++) {
    data[index] = millimetres[index]! / 1000;
  }
  return { dims, min, max, data };
}

async function decodeViewportTexture(texture: ScanTexture, maxSize: number): Promise<void> {
  if (typeof createImageBitmap !== 'function') return;
  try {
    // Decode source maps directly to a viewport-sized GPU image; the original
    // compressed bytes remain untouched and are embedded in exports.
    const encoded = new Uint8Array(texture.bytes).buffer as ArrayBuffer;
    texture.bitmap = await createImageBitmap(new Blob([encoded], { type: texture.mimeType }), {
      resizeWidth: maxSize,
      resizeHeight: maxSize,
      resizeQuality: 'high',
    });
  } catch (error) {
    console.warn('[toile] texture mannequin indisponible dans la vue 3D:', error);
  }
}

export async function loadScanAvatar(
  base: string,
  options: {
    visual?: boolean;
    /** Normalize the supplied Y-up GLB in memory; the file stays byte-identical. */
    normalizeVisualHeightM?: number;
    /** Rigid Y rotation in TOILE podium convention; source GLB stays untouched. */
    visualYawRadians?: number;
    /** Maximum decoded map edge for the live viewport (export bytes stay original). */
    viewportTextureMaxSize?: number;
    /** Reuse the loaded visual for export instead of fetching `<base>.export.glb`. */
    reuseVisualForExport?: boolean;
    /** Additional `<base>.<suffix>.mesh/sdf.bin` pairs keyed by pose preset. */
    collisionPoses?: Readonly<Record<string, string>>;
  } = {},
): Promise<ScanAvatar | null> {
  try {
    const load = async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
      const r = await fetch(url, signal ? { signal } : undefined);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.arrayBuffer();
    };
    const [meshBuf, sdfBuf] = await Promise.all([load(`${base}.mesh.bin`), load(`${base}.sdf.bin`)]);

    const mesh = parseScanMesh(meshBuf);
    const avatar: ScanAvatar = { mesh, grid: parseScanSdf(sdfBuf) };
    const requestedCollisionPoses = Object.entries(options.collisionPoses ?? {});
    if (requestedCollisionPoses.length) {
      const loadedOrder: string[] = [];
      const touchLoadedPose = (pose: string): void => {
        const previous = loadedOrder.indexOf(pose);
        if (previous >= 0) loadedOrder.splice(previous, 1);
        loadedOrder.push(pose);
      };
      collisionPoseCacheTouches.set(avatar, touchLoadedPose);
      const loaders: Record<string, () => Promise<ScanCollisionPose | null>> = {};
      for (const [pose, suffix] of requestedCollisionPoses) {
        let pending: Promise<ScanCollisionPose | null> | null = null;
        loaders[pose] = (): Promise<ScanCollisionPose | null> => {
          const cached = avatar.collisionPoses?.[pose];
          if (cached) {
            touchLoadedPose(pose);
            return Promise.resolve(cached);
          }
          if (pending) return pending;
          pending = (async () => {
            const controller = new AbortController();
            const timeout = globalThis.setTimeout(() => controller.abort(), 20_000);
            try {
              const [poseMesh, poseSdf] = await Promise.all([
                load(`${base}.${suffix}.mesh.bin`, controller.signal),
                load(`${base}.${suffix}.sdf.bin`, controller.signal),
              ]);
              const collision = {
                mesh: parseScanMesh(poseMesh),
                grid: parseScanSdf(poseSdf),
              };
              avatar.collisionPoses ??= {};
              avatar.collisionPoses[pose] = collision;
              touchLoadedPose(pose);
              // Each 256³-capable SDF expands to Float32 at runtime. Two poses
              // keep switching responsive without retaining an unbounded pose
              // library in memory; active GPU resources own their references.
              while (loadedOrder.length > 2) {
                const evicted = loadedOrder.shift();
                if (evicted) delete avatar.collisionPoses[evicted];
              }
              return collision;
            } catch (error) {
              // The native physical body remains usable. The UI keeps simulation
              // locked for a visual pose whose certified collision failed.
              console.warn(`[toile] collision articulée « ${pose} » indisponible:`, error);
              return null;
            } finally {
              globalThis.clearTimeout(timeout);
              pending = null;
            }
          })();
          return pending;
        };
      }
      avatar.collisionPoseLoaders = loaders;
    }
    if (options.visual) {
      try {
        const visualUrl = `${base}.visual.glb`;
        const visual = parseScanVisualGlb(await load(visualUrl));
        const normalization = options.normalizeVisualHeightM === undefined
          ? identityScanVisualNormalization(visual.mesh)
          : computeScanVisualNormalization(
              visual.mesh,
              options.normalizeVisualHeightM,
              options.visualYawRadians ?? 0,
            );
        avatar.visual = applyScanVisualNormalization(visual.mesh, normalization);
        avatar.appearance = visual.appearance;
        if (visual.rig) avatar.rig = visual.rig;
        avatar.visualSource = { url: visualUrl, normalization };
        if (!options.reuseVisualForExport) avatar.exportVisualUrl = `${base}.export.glb`;
        const requestedTextureMaxSize = options.viewportTextureMaxSize ?? 2048;
        const viewportTextureMaxSize = Number.isFinite(requestedTextureMaxSize)
          ? Math.max(1, Math.min(8192, Math.floor(requestedTextureMaxSize)))
          : 2048;
        // Browsers may transiently decode each complete source image before
        // resizing it. Decode sequentially so large scratch surfaces do not
        // coexist on memory-constrained machines.
        if (visual.appearance.baseColor) {
          await decodeViewportTexture(visual.appearance.baseColor, viewportTextureMaxSize);
        }
        if (visual.appearance.normal) {
          await decodeViewportTexture(visual.appearance.normal, viewportTextureMaxSize);
        }
        if (visual.appearance.metallicRoughness) {
          await decodeViewportTexture(
            visual.appearance.metallicRoughness,
            viewportTextureMaxSize,
          );
        }
      } catch (error) {
        // The physical avatar remains fully usable if its optional visual asset
        // is missing (old deployments, offline caches, unsupported decoder).
        console.warn('[toile] mannequin visuel haute fidélité indisponible:', error);
      }
    }
    return avatar;
  } catch (e) {
    console.warn('[toile] avatar scanné indisponible:', e);
    return null;
  }
}
