/**
 * Runtime poses for a native glTF scan rig.
 *
 * The visual mesh is stored in normalized TOILE coordinates while the joint
 * hierarchy and inverse-bind matrices deliberately stay byte-faithful to the
 * source GLB.  A posed palette is therefore conjugated by that one uniform
 * source-to-runtime transform:
 *
 *   C * inverse(meshWorld) * jointWorld * inverseBind * inverse(C)
 *
 * Poses are evaluated only when the user changes a preset. The visual mesh
 * remains on the GPU; only the small matrix palette is uploaded.
 */
import type {
  ScanMatrix4,
  ScanRig,
  ScanVisualMesh,
  ScanVisualNormalization,
} from './ScanAvatar';

export const SCAN_RIG_POSE_PRESETS = ['native', 'a-pose', 'sewing-preview'] as const;
export type ScanRigPosePreset = (typeof SCAN_RIG_POSE_PRESETS)[number];
export type ScanQuaternion = [number, number, number, number];

export function isScanRigPosePreset(value: string): value is ScanRigPosePreset {
  return (SCAN_RIG_POSE_PRESETS as readonly string[]).includes(value);
}

export interface EvaluatedScanRigPose {
  preset: ScanRigPosePreset;
  /** One column-major mat4 per skin ordinal, ready for the WebGPU shader. */
  jointMatrices: Float32Array;
  /** Local glTF rotations changed by the preset, keyed by source node index. */
  nodeRotations: Readonly<Record<number, ScanQuaternion>>;
  /** Packed source-space node worlds, useful for deterministic audits. */
  nodeWorldMatrices: Float64Array;
}

export interface ScanRigPoseGeometry {
  /** Source triangle order with only anatomically impossible contact bridges removed. */
  indices: Uint32Array;
  /** Palette ordinals widened once for WebGPU's uint16x4 vertex format. */
  jointIndices: Uint16Array;
  /** Contact-zone weights hardened to either hand/forearm or lower body. */
  jointWeights: Float32Array;
  detachedTriangleCount: number;
  hardenedVertexCount: number;
}

const EPSILON = 1e-10;

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): ScanMatrix4 {
  const out = new Float64Array(16);
  // Column-major: out[col,row] = sum a[k,row] * b[col,k].
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) {
        value += a[k * 4 + row]! * b[column * 4 + k]!;
      }
      out[column * 4 + row] = value;
    }
  }
  return out;
}

function invert(matrix: ArrayLike<number>): ScanMatrix4 {
  // Gauss-Jordan on rows avoids relying on a particular affine shape and
  // covers source node.matrix transforms as well as ordinary TRS nodes.
  const augmented = Array.from({ length: 4 }, (_, row) => {
    const values = new Float64Array(8);
    for (let column = 0; column < 4; column++) {
      values[column] = matrix[column * 4 + row]!;
    }
    values[4 + row] = 1;
    return values;
  });
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot]![column]!) < EPSILON) {
      throw new Error('scan rig contains a non-invertible transform');
    }
    if (pivot !== column) {
      const swap = augmented[pivot]!;
      augmented[pivot] = augmented[column]!;
      augmented[column] = swap;
    }
    const pivotRow = augmented[column]!;
    const divisor = pivotRow[column]!;
    for (let item = 0; item < 8; item++) {
      pivotRow[item] = pivotRow[item]! / divisor;
    }
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      if (Math.abs(factor) < EPSILON) continue;
      const targetRow = augmented[row]!;
      for (let item = 0; item < 8; item++) {
        targetRow[item] = targetRow[item]! - factor * pivotRow[item]!;
      }
    }
  }
  const out = new Float64Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      out[column * 4 + row] = augmented[row]![4 + column]!;
    }
  }
  return out;
}

function normalizeQuaternion(value: ArrayLike<number>): ScanQuaternion {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!);
  if (!Number.isFinite(length) || length < EPSILON) return [0, 0, 0, 1];
  return [value[0]! / length, value[1]! / length, value[2]! / length, value[3]! / length];
}

/** glTF quaternion multiplication (`a * b`, both [x,y,z,w]). */
function multiplyQuaternion(a: ArrayLike<number>, b: ArrayLike<number>): ScanQuaternion {
  return normalizeQuaternion([
    a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
    a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
    a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
    a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
  ]);
}

function conjugateQuaternion(q: ArrayLike<number>): ScanQuaternion {
  const normalized = normalizeQuaternion(q);
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]];
}

function axisAngle(axis: readonly [number, number, number], degrees: number): ScanQuaternion {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(length) || length < EPSILON) return [0, 0, 0, 1];
  const half = (degrees * Math.PI) / 360;
  const sine = Math.sin(half) / length;
  return normalizeQuaternion([
    axis[0] * sine,
    axis[1] * sine,
    axis[2] * sine,
    Math.cos(half),
  ]);
}

function composeTrs(
  translation: readonly [number, number, number],
  rotation: ArrayLike<number>,
  scale: readonly [number, number, number],
): ScanMatrix4 {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return new Float64Array([
    (1 - (yy + zz)) * scale[0],
    (xy + wz) * scale[0],
    (xz - wy) * scale[0],
    0,
    (xy - wz) * scale[1],
    (1 - (xx + zz)) * scale[1],
    (yz + wx) * scale[1],
    0,
    (xz + wy) * scale[2],
    (yz - wx) * scale[2],
    (1 - (xx + yy)) * scale[2],
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ]);
}

/** Rotation part of an affine matrix, with tiny source scale drift removed. */
function rotationFromMatrix(matrix: ArrayLike<number>): ScanQuaternion {
  const column = (offset: number): [number, number, number] => {
    const length = Math.hypot(matrix[offset]!, matrix[offset + 1]!, matrix[offset + 2]!) || 1;
    return [matrix[offset]! / length, matrix[offset + 1]! / length, matrix[offset + 2]! / length];
  };
  const x = column(0);
  let y = column(4);
  // Gram-Schmidt prevents the source's ~1e-5 non-uniform scale noise from
  // leaking into a quaternion during repeated parent-space conversions.
  const xy = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = [y[0] - xy * x[0], y[1] - xy * x[1], y[2] - xy * x[2]];
  const yLength = Math.hypot(...y) || 1;
  y = [y[0] / yLength, y[1] / yLength, y[2] / yLength];
  const z: [number, number, number] = [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  const m00 = x[0]; const m01 = y[0]; const m02 = z[0];
  const m10 = x[1]; const m11 = y[1]; const m12 = z[1];
  const m20 = x[2]; const m21 = y[2]; const m22 = z[2];
  const trace = m00 + m11 + m22;
  let q: ScanQuaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return normalizeQuaternion(q);
}

function evaluateWorlds(rig: ScanRig, locals: readonly ScanMatrix4[]): Float64Array {
  const worlds = new Float64Array(rig.nodes.length * 16);
  const state = new Uint8Array(rig.nodes.length);
  const visit = (nodeIndex: number): ScanMatrix4 => {
    if (state[nodeIndex] === 2) return worlds.slice(nodeIndex * 16, nodeIndex * 16 + 16);
    if (state[nodeIndex] === 1) throw new Error('scan rig node hierarchy contains a cycle');
    state[nodeIndex] = 1;
    const parent = rig.nodes[nodeIndex]!.parent;
    const world = parent < 0 ? locals[nodeIndex]! : multiply(visit(parent), locals[nodeIndex]!);
    worlds.set(world, nodeIndex * 16);
    state[nodeIndex] = 2;
    return world;
  };
  for (let nodeIndex = 0; nodeIndex < rig.nodes.length; nodeIndex++) visit(nodeIndex);
  return worlds;
}

function worldAt(worlds: Float64Array, nodeIndex: number): ScanMatrix4 {
  return worlds.slice(nodeIndex * 16, nodeIndex * 16 + 16);
}

export type ArticulatedScanRigPosePreset = Exclude<ScanRigPosePreset, 'native'>;

export const ARTICULATED_SCAN_RIG_POSE_PRESETS: readonly ArticulatedScanRigPosePreset[] =
  Object.freeze(SCAN_RIG_POSE_PRESETS.slice(1)) as readonly ArticulatedScanRigPosePreset[];

/** Desired arm direction in runtime space. The horizontal sign is selected
 * from each shoulder's actual spatial side after source orientation, rather
 * than trusting L/R bone labels that some generators mirror. */
const POSE_ARM_SLOPES: Readonly<
  Record<ArticulatedScanRigPosePreset, readonly [horizontal: number, vertical: number]>
> = {
  'a-pose': [1, -1],
  // 8.53 degrees below horizontal: clear sleeves without pinching the axilla.
  'sewing-preview': [1, -0.15],
};

const POSE_CHAIN_NODES = ['Clavicle', 'Upperarm', 'Forearm', 'Hand'] as const;
const POSE_ROTATION_NODES = ['Clavicle', 'Upperarm', 'Forearm'] as const;

function normalizeVector(
  value: readonly [number, number, number],
): [number, number, number] {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length < EPSILON) {
    throw new Error('scan rig pose contains a degenerate direction');
  }
  return [value[0] / length, value[1] / length, value[2] / length];
}

function normalizedDirection(
  matrix: ArrayLike<number>,
  direction: readonly [number, number, number],
): [number, number, number] {
  const value: [number, number, number] = [
    matrix[0]! * direction[0] + matrix[4]! * direction[1] + matrix[8]! * direction[2],
    matrix[1]! * direction[0] + matrix[5]! * direction[1] + matrix[9]! * direction[2],
    matrix[2]! * direction[0] + matrix[6]! * direction[1] + matrix[10]! * direction[2],
  ];
  return normalizeVector(value);
}

function rotationBetweenDirections(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  fraction = 1,
): ScanQuaternion {
  const a = normalizeVector(from);
  const b = normalizeVector(to);
  let axis: [number, number, number] = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  let axisLength = Math.hypot(...axis);
  const cosine = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  if (axisLength < EPSILON) {
    if (cosine > 0) return [0, 0, 0, 1];
    const basis: [number, number, number] = Math.abs(a[0]) < 0.8
      ? [1, 0, 0]
      : [0, 1, 0];
    axis = [
      a[1] * basis[2] - a[2] * basis[1],
      a[2] * basis[0] - a[0] * basis[2],
      a[0] * basis[1] - a[1] * basis[0],
    ];
    axisLength = Math.hypot(...axis);
  }
  const degrees = (Math.acos(cosine) * 180 * fraction) / Math.PI;
  return axisAngle(
    [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength],
    degrees,
  );
}

function identityPalette(jointCount: number): Float32Array {
  const palette = new Float32Array(jointCount * 16);
  for (let joint = 0; joint < jointCount; joint++) {
    palette[joint * 16] = 1;
    palette[joint * 16 + 5] = 1;
    palette[joint * 16 + 10] = 1;
    palette[joint * 16 + 15] = 1;
  }
  return palette;
}

export function evaluateScanRigPose(
  rig: ScanRig,
  normalization: ScanVisualNormalization,
  preset: ScanRigPosePreset,
): EvaluatedScanRigPose {
  if (rig.skin.joints.length > 64) {
    throw new Error('scan rig exceeds the 64-joint viewport limit');
  }
  const locals = rig.nodes.map((node) => new Float64Array(node.restLocalMatrix));
  const rotations = new Map<number, ScanQuaternion>();
  if (preset !== 'native') {
    const byName = new Map(rig.nodes.map((node) => [node.name, node.index] as const));
    const nodeIndex = (name: string): number => {
      const index = byName.get(name);
      if (index === undefined) throw new Error(`scan rig is missing ${name}`);
      return index;
    };
    const runtimePoint = (worlds: Float64Array, name: string): [number, number, number] => {
      const world = worldAt(worlds, nodeIndex(name));
      return transformScanRigPoint(normalization.matrix, [world[12]!, world[13]!, world[14]!]);
    };
    const aimChain = (
      rotationNodeName: string,
      directionFromName: string,
      directionToName: string,
      targetSource: readonly [number, number, number],
      fraction: number,
    ): void => {
      const worlds = evaluateWorlds(rig, locals);
      const fromWorld = worldAt(worlds, nodeIndex(directionFromName));
      const toWorld = worldAt(worlds, nodeIndex(directionToName));
      const currentDirection: [number, number, number] = [
        toWorld[12]! - fromWorld[12]!,
        toWorld[13]! - fromWorld[13]!,
        toWorld[14]! - fromWorld[14]!,
      ];
      const rotationIndex = nodeIndex(rotationNodeName);
      const node = rig.nodes[rotationIndex]!;
      if (node.sourceTransform.kind !== 'trs') {
        throw new Error(`${rotationNodeName} cannot be posed because it uses node.matrix`);
      }
      const parentRotation = node.parent < 0
        ? ([0, 0, 0, 1] as ScanQuaternion)
        : rotationFromMatrix(worldAt(worlds, node.parent));
      const worldDelta = rotationBetweenDirections(currentDirection, targetSource, fraction);
      const localDelta = multiplyQuaternion(
        multiplyQuaternion(conjugateQuaternion(parentRotation), worldDelta),
        parentRotation,
      );
      const current = rotations.get(rotationIndex) ?? node.sourceTransform.rotation;
      const next = multiplyQuaternion(localDelta, current);
      rotations.set(rotationIndex, next);
      locals[rotationIndex]!.set(composeTrs(
        node.sourceTransform.translation,
        next,
        node.sourceTransform.scale,
      ));
    };

    const [horizontal, vertical] = POSE_ARM_SLOPES[preset];
    for (const sourceSide of ['L', 'R'] as const) {
      const restWorlds = evaluateWorlds(rig, locals);
      const shoulder = runtimePoint(restWorlds, `${sourceSide}_Upperarm`);
      const spatialSign = Math.sign(shoulder[0]) || (sourceSide === 'L' ? 1 : -1);
      const targetLength = Math.hypot(horizontal, vertical);
      const targetRuntime: [number, number, number] = [
        (spatialSign * horizontal) / targetLength,
        vertical / targetLength,
        0,
      ];
      const targetSource = normalizedDirection(normalization.inverseMatrix, targetRuntime);
      // Share a small part of the lift with the clavicle, then make the upper
      // arm exact and finally straighten the forearm onto the same axis.
      aimChain(
        `${sourceSide}_Clavicle`,
        `${sourceSide}_Upperarm`,
        `${sourceSide}_Forearm`,
        targetSource,
        0.18,
      );
      aimChain(
        `${sourceSide}_Upperarm`,
        `${sourceSide}_Upperarm`,
        `${sourceSide}_Forearm`,
        targetSource,
        1,
      );
      aimChain(
        `${sourceSide}_Forearm`,
        `${sourceSide}_Forearm`,
        `${sourceSide}_Hand`,
        targetSource,
        1,
      );
    }
  }

  const nodeWorldMatrices = preset === 'native'
    ? new Float64Array(rig.restWorldMatrices)
    : evaluateWorlds(rig, locals);
  if (preset === 'native') {
    return {
      preset,
      jointMatrices: identityPalette(rig.skin.joints.length),
      nodeRotations: {},
      nodeWorldMatrices,
    };
  }

  const meshWorld = worldAt(nodeWorldMatrices, rig.skin.meshNode);
  const inverseMeshWorld = invert(meshWorld);
  const palette = new Float32Array(rig.skin.joints.length * 16);
  for (let ordinal = 0; ordinal < rig.skin.joints.length; ordinal++) {
    const jointNode = rig.skin.joints[ordinal]!;
    const jointWorld = worldAt(nodeWorldMatrices, jointNode);
    const inverseBind = rig.skin.inverseBindMatrices.subarray(ordinal * 16, ordinal * 16 + 16);
    const sourcePalette = multiply(multiply(inverseMeshWorld, jointWorld), inverseBind);
    const canonical = multiply(
      multiply(normalization.matrix, sourcePalette),
      normalization.inverseMatrix,
    );
    for (let item = 0; item < 16; item++) {
      const value = canonical[item]!;
      if (!Number.isFinite(value)) throw new Error('scan rig pose produced a non-finite matrix');
      palette[ordinal * 16 + item] = value;
    }
  }
  return {
    preset,
    jointMatrices: palette,
    nodeRotations: Object.fromEntries(rotations) as Record<number, ScanQuaternion>,
    nodeWorldMatrices,
  };
}

/** True only when a rig owns every joint needed by the requested preset. */
export function supportsScanRigPose(
  rig: ScanRig | undefined,
  preset: ScanRigPosePreset,
): rig is ScanRig {
  if (!rig || rig.skin.joints.length === 0 || rig.skin.joints.length > 64) return false;
  if (preset === 'native') return true;
  const nodesByName = new Map(rig.nodes.map((node) => [node.name, node] as const));
  return (['L', 'R'] as const).every((side) =>
    POSE_CHAIN_NODES.every((suffix) => {
      const node = nodesByName.get(`${side}_${suffix}`);
      return Boolean(
        node &&
        (!POSE_ROTATION_NODES.includes(suffix as (typeof POSE_ROTATION_NODES)[number]) ||
          node.sourceTransform.kind === 'trs'),
      );
    }));
}

/** Backward-compatible capability check used by the current atelier UI. */
export function supportsSewingPreview(rig: ScanRig | undefined): rig is ScanRig {
  return supportsScanRigPose(rig, 'sewing-preview');
}

/**
 * Detach an authored hand-on-thigh contact before lifting the arms.
 *
 * Some legacy scans were generated with both hands resting against the lower
 * body. A narrow contact patch can then mix Hand/Thigh weights, which looks
 * correct only in that exact pose and becomes long bands in an A-pose. This
 * routine does not remodel the avatar: it
 * selects one anatomical side for those already-existing contact vertices and
 * removes only triangles that still cross from a distal arm to the lower body.
 * Native rendering keeps the untouched source streams. A clean rig passes
 * through this guard with zero hardened vertices and zero removed triangles.
 */
export function buildScanRigPoseGeometry(
  mesh: Pick<ScanVisualMesh, 'positions' | 'indices'>,
  rig: ScanRig,
): ScanRigPoseGeometry {
  const vertexCount = mesh.positions.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error('scan rig pose geometry requires a valid vertex array');
  }
  if (
    rig.skin.jointIndices.length !== vertexCount * 4 ||
    rig.skin.jointWeights.length !== vertexCount * 4
  ) {
    throw new Error('scan rig pose geometry influence count does not match the mesh');
  }
  const categoryByOrdinal = new Uint8Array(rig.skin.joints.length);
  for (let ordinal = 0; ordinal < rig.skin.joints.length; ordinal++) {
    const name = rig.nodes[rig.skin.joints[ordinal]!]!.name;
    if (/^L_(?:Forearm|Hand)/.test(name)) categoryByOrdinal[ordinal] = 1;
    else if (/^R_(?:Forearm|Hand)/.test(name)) categoryByOrdinal[ordinal] = 2;
    else if (
      name === 'Hip' ||
      name === 'Pelvis' ||
      /^(?:L|R)_(?:Thigh|Calf|Foot|ToeBase)/.test(name)
    ) {
      categoryByOrdinal[ordinal] = 3;
    }
  }

  const jointIndices = Uint16Array.from(rig.skin.jointIndices);
  const jointWeights = new Float32Array(rig.skin.jointWeights);
  const vertexCategory = new Uint8Array(vertexCount);
  let hardenedVertexCount = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 4;
    let leftArm = 0;
    let rightArm = 0;
    let lower = 0;
    for (let influence = 0; influence < 4; influence++) {
      const weight = jointWeights[offset + influence]!;
      const category = categoryByOrdinal[jointIndices[offset + influence]!]!;
      if (category === 1) leftArm += weight;
      else if (category === 2) rightArm += weight;
      else if (category === 3) lower += weight;
    }
    const armCategory = leftArm >= rightArm ? 1 : 2;
    const arm = Math.max(leftArm, rightArm);
    const authoredContact = arm > 0.02 && lower > 0.02;
    const selected = authoredContact ? (arm >= lower ? armCategory : 3) : 0;
    if (authoredContact) {
      hardenedVertexCount++;
      let sum = 0;
      for (let influence = 0; influence < 4; influence++) {
        const category = categoryByOrdinal[jointIndices[offset + influence]!]!;
        const opposing = selected === 3
          ? category === 1 || category === 2
          : category === 3 || (category !== 0 && category !== selected);
        if (opposing) jointWeights[offset + influence] = 0;
        sum += jointWeights[offset + influence]!;
      }
      if (sum <= 1e-8) {
        throw new Error('scan rig contact hardening removed every influence');
      }
      for (let influence = 0; influence < 4; influence++) {
        const index = offset + influence;
        jointWeights[index] = jointWeights[index]! / sum;
      }
      vertexCategory[vertex] = selected;
    } else if (arm > 0.5 && lower < 0.02) {
      vertexCategory[vertex] = armCategory;
    } else if (lower > 0.5 && arm < 0.02) {
      vertexCategory[vertex] = 3;
    }
  }

  const kept = new Uint32Array(mesh.indices.length);
  let write = 0;
  let detachedTriangleCount = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset]!;
    const b = mesh.indices[offset + 1]!;
    const c = mesh.indices[offset + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new Error('scan rig pose geometry index exceeds the mesh');
    }
    const ca = vertexCategory[a]!;
    const cb = vertexCategory[b]!;
    const cc = vertexCategory[c]!;
    const hasLower = ca === 3 || cb === 3 || cc === 3;
    const hasDistalArm = ca === 1 || ca === 2 || cb === 1 || cb === 2 || cc === 1 || cc === 2;
    if (hasLower && hasDistalArm) {
      detachedTriangleCount++;
      continue;
    }
    kept[write++] = a;
    kept[write++] = b;
    kept[write++] = c;
  }
  return {
    indices: kept.slice(0, write),
    jointIndices,
    jointWeights,
    detachedTriangleCount,
    hardenedVertexCount,
  };
}

/** Exported for small matrix-convention tests without exposing internal math. */
export function transformScanRigPoint(
  matrix: ArrayLike<number>,
  point: readonly [number, number, number],
): [number, number, number] {
  return [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
  ];
}
