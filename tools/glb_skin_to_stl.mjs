#!/usr/bin/env node

/**
 * Convert the visible pose of a binary glTF avatar to a single binary STL.
 *
 * TOILE bakes its render mesh and collision SDF from the same closed surface.
 * Exporting the raw POSITION accessor of a rigged GLB is therefore unsafe: it
 * ignores the skin pose. This small dependency-free converter evaluates the
 * glTF node hierarchy and linear-blend skinning before writing triangles.
 *
 * Usage:
 *   node tools/glb_skin_to_stl.mjs input.glb output.stl [--tpose]
 *     [--appearance output.appearance.bin]
 *
 * `--tpose` keeps its historical command-line name but produces TOILE's
 * shallow sewing A-pose, not a strict horizontal T-pose. It aims the arms
 * about 8.5 degrees below horizontal, assigns 18% of the lift to each
 * clavicle, straightens the forearms, and corrects the mixed-weight axillary
 * patch left by an arms-down bind pose. `--dqs` optionally uses dual-quaternion
 * skinning for this conversion; linear-blend skinning remains the default.
 *
 * The STL intentionally keeps the source axes and units. tools/bake.py owns
 * the canonical TOILE normalisation (Y-up, feet at zero, requested stature).
 */

import fs from 'node:fs';
import path from 'node:path';

const [, , sourcePath, outputPath, ...flags] = process.argv;
const forceTPose = flags.includes('--tpose');
const useDualQuaternionSkinning = forceTPose && flags.includes('--dqs');
const appearanceFlag = flags.indexOf('--appearance');
const appearancePath = appearanceFlag >= 0 ? flags[appearanceFlag + 1] : null;

if (
  !sourcePath ||
  !outputPath ||
  (appearanceFlag >= 0 && (!appearancePath || appearancePath.startsWith('--')))
) {
  console.error('Usage: node tools/glb_skin_to_stl.mjs input.glb output.stl [--tpose] [--dqs] [--appearance output.appearance.bin]');
  console.error('  --tpose: produce the shallow TOILE sewing A-pose (historical flag name)');
  console.error('  --appearance: preserve triangle UVs and embedded base colour for tools/bake.py');
  process.exit(2);
}

const COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

const COMPONENT_BYTES = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const readComponent = (view, offset, type) => {
  switch (type) {
    case 5120:
      return view.getInt8(offset);
    case 5121:
      return view.getUint8(offset);
    case 5122:
      return view.getInt16(offset, true);
    case 5123:
      return view.getUint16(offset, true);
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      throw new Error(`Unsupported glTF component type ${type}`);
  }
};

const normalizeComponent = (value, type) => {
  switch (type) {
    case 5120:
      return Math.max(value / 127, -1);
    case 5121:
      return value / 255;
    case 5122:
      return Math.max(value / 32767, -1);
    case 5123:
      return value / 65535;
    default:
      return value;
  }
};

const identity = () => new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const multiply = (a, b) => {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let k = 0; k < 4; k++) {
        value += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = value;
    }
  }
  return out;
};

const nodeMatrix = (node) => {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return new Float64Array([
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
};

const transformPoint = (matrix, point) => {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
};

const quatMultiply = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const quaternionFromMatrix = (matrix) => {
  const m00 = matrix[0];
  const m01 = matrix[4];
  const m02 = matrix[8];
  const m10 = matrix[1];
  const m11 = matrix[5];
  const m12 = matrix[9];
  const m20 = matrix[2];
  const m21 = matrix[6];
  const m22 = matrix[10];
  const trace = m00 + m11 + m22;
  let quaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    quaternion = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    quaternion = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    quaternion = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    quaternion = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const length = Math.hypot(...quaternion);
  return quaternion.map((value) => value / length);
};

const dualQuaternionFromMatrix = (matrix) => {
  const real = quaternionFromMatrix(matrix);
  const translation = [matrix[12], matrix[13], matrix[14], 0];
  const dual = quatMultiply(translation, real).map((value) => value * 0.5);
  return { real, dual };
};

const transformPointDualQuaternion = (real, dual, point) => {
  const conjugate = [-real[0], -real[1], -real[2], real[3]];
  const rotated = quatMultiply(
    quatMultiply(real, [point[0], point[1], point[2], 0]),
    conjugate,
  );
  const translation = quatMultiply(dual, conjugate);
  return [
    rotated[0] + 2 * translation[0],
    rotated[1] + 2 * translation[1],
    rotated[2] + 2 * translation[2],
  ];
};

const translationMatrix = ([x, y, z]) => new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
]);

const rotationBetween = (from, to, fraction = 1) => {
  const fromLength = Math.hypot(...from);
  const toLength = Math.hypot(...to);
  if (fromLength <= 1e-9 || toLength <= 1e-9) return identity();
  const a = from.map((value) => value / fromLength);
  const b = to.map((value) => value / toLength);
  let axis = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  let sine = Math.hypot(...axis);
  const cosine = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  if (sine <= 1e-9) {
    if (cosine > 0) return identity();
    axis = Math.abs(a[0]) < 0.8
      ? [0, a[2], -a[1]]
      : [-a[2], 0, a[0]];
    sine = Math.hypot(...axis);
  }
  axis = axis.map((value) => value / sine);
  const angle = Math.acos(cosine) * fraction;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const [x, y, z] = axis;
  return new Float64Array([
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0, 0, 0, 1,
  ]);
};

const source = fs.readFileSync(sourcePath);
if (source.toString('ascii', 0, 4) !== 'glTF' || source.readUInt32LE(4) !== 2) {
  throw new Error('Only binary glTF 2.0 (.glb) is supported.');
}

const jsonLength = source.readUInt32LE(12);
const jsonType = source.readUInt32LE(16);
if (jsonType !== 0x4e4f534a) throw new Error('Missing GLB JSON chunk.');
const gltf = JSON.parse(source.toString('utf8', 20, 20 + jsonLength));
let chunkOffset = 20 + jsonLength;
if (chunkOffset % 4) chunkOffset += 4 - (chunkOffset % 4);
const binLength = source.readUInt32LE(chunkOffset);
const binType = source.readUInt32LE(chunkOffset + 4);
if (binType !== 0x004e4942) throw new Error('Missing GLB BIN chunk.');
const binOffset = chunkOffset + 8;
const bin = new DataView(source.buffer, source.byteOffset + binOffset, binLength);

const readAccessor = (accessorIndex) => {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error(`Sparse accessor ${accessorIndex} is not supported.`);
  const bufferView = gltf.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`Missing buffer view for accessor ${accessorIndex}`);
  const components = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!components || !componentBytes) throw new Error(`Unsupported accessor ${accessorIndex}`);
  const packedStride = components * componentBytes;
  const stride = bufferView.byteStride ?? packedStride;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Array(accessor.count);
  for (let index = 0; index < accessor.count; index++) {
    const row = new Array(components);
    for (let component = 0; component < components; component++) {
      const raw = readComponent(
        bin,
        start + index * stride + component * componentBytes,
        accessor.componentType,
      );
      row[component] = accessor.normalized
        ? normalizeComponent(raw, accessor.componentType)
        : raw;
    }
    values[index] = row;
  }
  return values;
};

// Appearance extraction can briefly coexist with a million skinned vertices.
// Keep its TEXCOORD data packed instead of allocating one JS Array per row.
const readAccessorPackedFloat32 = (accessorIndex) => {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error(`Sparse accessor ${accessorIndex} is not supported.`);
  const bufferView = gltf.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`Missing buffer view for accessor ${accessorIndex}`);
  const components = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!components || !componentBytes) throw new Error(`Unsupported accessor ${accessorIndex}`);
  const packedStride = components * componentBytes;
  const stride = bufferView.byteStride ?? packedStride;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Float32Array(accessor.count * components);
  for (let index = 0; index < accessor.count; index++) {
    for (let component = 0; component < components; component++) {
      const raw = readComponent(
        bin,
        start + index * stride + component * componentBytes,
        accessor.componentType,
      );
      values[index * components + component] = accessor.normalized
        ? normalizeComponent(raw, accessor.componentType)
        : raw;
    }
  }
  return { values, count: accessor.count, components };
};

const parents = new Array(gltf.nodes?.length ?? 0).fill(-1);
for (let parent = 0; parent < parents.length; parent++) {
  for (const child of gltf.nodes[parent]?.children ?? []) parents[child] = parent;
}

const worldCache = new Map();
const worldMatrix = (index) => {
  const cached = worldCache.get(index);
  if (cached) return cached;
  const local = nodeMatrix(gltf.nodes[index] ?? {});
  const parent = parents[index];
  const world = parent >= 0 ? multiply(worldMatrix(parent), local) : local;
  worldCache.set(index, world);
  return world;
};

const tPoseWorldOverrides = new Map();
const tPoseDetails = [];
const tPoseArmRegions = [];
if (forceTPose) {
  const nodeNamed = (name) => gltf.nodes?.findIndex((node) => node.name === name) ?? -1;
  const descendants = (root) => {
    const result = new Set([root]);
    const visit = (index) => {
      for (const child of gltf.nodes?.[index]?.children ?? []) {
        result.add(child);
        visit(child);
      }
    };
    visit(root);
    return result;
  };
  for (const side of ['L', 'R']) {
    const clavicle = nodeNamed(`${side}_Clavicle`);
    const upperArm = nodeNamed(`${side}_Upperarm`);
    const forearm = nodeNamed(`${side}_Forearm`);
    const hand = nodeNamed(`${side}_Hand`);
    if (clavicle < 0 || upperArm < 0 || forearm < 0 || hand < 0) {
      throw new Error(
        `--tpose needs ${side}_Clavicle, ${side}_Upperarm, ${side}_Forearm and ${side}_Hand joints.`,
      );
    }
    const clavicleMatrix = worldMatrix(clavicle);
    const shoulderMatrix = worldMatrix(upperArm);
    const elbowMatrix = worldMatrix(forearm);
    const handMatrix = worldMatrix(hand);
    const claviclePivot = [
      clavicleMatrix[12],
      clavicleMatrix[13],
      clavicleMatrix[14],
    ];
    const pivot = [shoulderMatrix[12], shoulderMatrix[13], shoulderMatrix[14]];
    const elbowPoint = [elbowMatrix[12], elbowMatrix[13], elbowMatrix[14]];
    const handPoint = [handMatrix[12], handMatrix[13], handMatrix[14]];
    // Some exporters use anatomical L/R while their world X convention puts
    // anatomical left on +X. Extend away from the torso using the measured
    // shoulder position instead of assuming a naming convention.
    // A shallow garment A-pose keeps a usable gap between the hood/neckline
    // and the arms while remaining close enough to horizontal for sleeve
    // wrapping. A strict T-pose makes the shoulder collider continue at hood
    // height all the way to the wrist.
    const targetDirection = [pivot[0] < 0 ? -1 : 1, -0.15, 0];
    const upperDirection = elbowPoint.map((value, axis) => value - pivot[axis]);
    // Share the lift with the clavicle so vertices blended between torso and
    // upper arm do not become a long triangular membrane under the armpit.
    // About 14 degrees on the calibrated neutral rig: enough to open the shoulder girdle without
    // lifting/narrowing the shoulders as a proportional 35% rotation did.
    const clavicleRotation = rotationBetween(upperDirection, targetDirection, 0.18);
    const aroundClavicle = multiply(
      translationMatrix(claviclePivot),
      multiply(
        clavicleRotation,
        translationMatrix(claviclePivot.map((value) => -value)),
      ),
    );
    const clavicleAffected = descendants(clavicle);
    for (const joint of clavicleAffected) {
      tPoseWorldOverrides.set(joint, multiply(aroundClavicle, worldMatrix(joint)));
    }
    const pivotAfterClavicle = transformPoint(aroundClavicle, pivot);
    const elbowAfterClavicle = transformPoint(aroundClavicle, elbowPoint);
    const remainingUpperDirection = elbowAfterClavicle.map(
      (value, axis) => value - pivotAfterClavicle[axis],
    );
    const rotation = rotationBetween(remainingUpperDirection, targetDirection);
    const aroundShoulder = multiply(
      translationMatrix(pivotAfterClavicle),
      multiply(
        rotation,
        translationMatrix(pivotAfterClavicle.map((value) => -value)),
      ),
    );
    const completeUpperTransform = multiply(aroundShoulder, aroundClavicle);
    const upperAffected = descendants(upperArm);
    for (const joint of upperAffected) {
      tPoseWorldOverrides.set(
        joint,
        multiply(completeUpperTransform, worldMatrix(joint)),
      );
    }
    // Straighten the elbow independently. Rotating the whole arm only from
    // shoulder to hand preserves the source's downward elbow bend (~7 cm at
    // target scale), which makes sleeve tubes start crooked despite the arm
    // endpoints looking horizontal.
    const elbowAfter = transformPoint(completeUpperTransform, elbowPoint);
    const handAfterShoulder = transformPoint(completeUpperTransform, handPoint);
    const forearmDirection = handAfterShoulder.map(
      (value, axis) => value - elbowAfter[axis],
    );
    const forearmRotation = rotationBetween(forearmDirection, targetDirection);
    const aroundElbow = multiply(
      translationMatrix(elbowAfter),
      multiply(
        forearmRotation,
        translationMatrix(elbowAfter.map((value) => -value)),
      ),
    );
    const forearmAffected = descendants(forearm);
    for (const joint of forearmAffected) {
      tPoseWorldOverrides.set(
        joint,
        multiply(aroundElbow, multiply(completeUpperTransform, worldMatrix(joint))),
      );
    }
    tPoseArmRegions.push({
      side,
      sign: targetDirection[0],
      shoulder: pivotAfterClavicle,
      elbow: elbowAfter,
      upperAffected,
    });
    tPoseDetails.push({
      side,
      claviclePivot,
      pivot,
      elbow: elbowPoint,
      hand: handPoint,
      clavicleAffectedJoints: clavicleAffected.size,
      upperAffectedJoints: upperAffected.size,
      forearmAffectedJoints: forearmAffected.size,
    });
  }
}

const inverseBindCache = new Map();
const inverseBindMatrices = (skinIndex) => {
  const cached = inverseBindCache.get(skinIndex);
  if (cached) return cached;
  const skin = gltf.skins?.[skinIndex];
  if (!skin) throw new Error(`Missing skin ${skinIndex}`);
  const rows = skin.inverseBindMatrices == null
    ? skin.joints.map(() => Array.from(identity()))
    : readAccessor(skin.inverseBindMatrices);
  const matrices = rows.map((row) => Float64Array.from(row));
  inverseBindCache.set(skinIndex, matrices);
  return matrices;
};

const triangles = [];
const appearanceUvChunks = [];
let appearanceImage = null;
let appearanceMime = null;
let appearanceTriangleCount = 0;
let sourceVertexCount = 0;
for (let nodeIndex = 0; nodeIndex < (gltf.nodes?.length ?? 0); nodeIndex++) {
  const node = gltf.nodes[nodeIndex];
  if (node?.mesh == null) continue;
  const mesh = gltf.meshes?.[node.mesh];
  if (!mesh) throw new Error(`Missing mesh ${node.mesh}`);
  for (const primitive of mesh.primitives ?? []) {
    if ((primitive.mode ?? 4) !== 4) throw new Error('Only triangle-list primitives are supported.');
    const positions = readAccessor(primitive.attributes.POSITION);
    const indices = primitive.indices == null
      ? positions.map((_, index) => [index])
      : readAccessor(primitive.indices);
    const joints = primitive.attributes.JOINTS_0 == null
      ? null
      : readAccessor(primitive.attributes.JOINTS_0);
    const weights = primitive.attributes.WEIGHTS_0 == null
      ? null
      : readAccessor(primitive.attributes.WEIGHTS_0);
    let texCoords = null;
    if (appearancePath) {
      if (primitive.attributes.TEXCOORD_0 == null) {
        throw new Error('--appearance needs TEXCOORD_0 on every rendered primitive.');
      }
      texCoords = readAccessorPackedFloat32(primitive.attributes.TEXCOORD_0);
      if (texCoords.components !== 2 || texCoords.count !== positions.length) {
        throw new Error('TEXCOORD_0 must be a VEC2 matching POSITION.');
      }
      const material = gltf.materials?.[primitive.material];
      const baseInfo = material?.pbrMetallicRoughness?.baseColorTexture;
      if (!baseInfo || (baseInfo.texCoord ?? 0) !== 0) {
        throw new Error('--appearance needs one baseColorTexture using TEXCOORD_0.');
      }
      const texture = gltf.textures?.[baseInfo.index];
      const image = gltf.images?.[texture?.source];
      const imageView = image?.bufferView == null ? null : gltf.bufferViews?.[image.bufferView];
      if (!image || !imageView) {
        throw new Error('--appearance currently needs an image embedded in the GLB BIN chunk.');
      }
      const imageStart = binOffset + (imageView.byteOffset ?? 0);
      const bytes = source.subarray(imageStart, imageStart + imageView.byteLength);
      if (appearanceImage && !appearanceImage.equals(bytes)) {
        throw new Error('--appearance currently supports one shared base-colour image.');
      }
      appearanceImage = Buffer.from(bytes);
      appearanceMime = image.mimeType ?? 'application/octet-stream';
    }
    const world = worldMatrix(nodeIndex);
    let posed;
    if (node.skin != null && joints && weights) {
      const skin = gltf.skins[node.skin];
      const inverseBinds = inverseBindMatrices(node.skin);
      const jointWorld = skin.joints.map((jointNode, jointIndex) =>
        multiply(tPoseWorldOverrides.get(jointNode) ?? worldMatrix(jointNode), inverseBinds[jointIndex]),
      );
      const jointDualQuaternions = useDualQuaternionSkinning
        ? jointWorld.map(dualQuaternionFromMatrix)
        : null;
      const correctAxilla = (point, vertex) => {
        if (!forceTPose) return point;
        for (const region of tPoseArmRegions) {
          let armWeight = 0;
          for (let influence = 0; influence < joints[vertex].length; influence++) {
            const jointNode = skin.joints[joints[vertex][influence]];
            if (region.upperAffected.has(jointNode)) {
              armWeight += weights[vertex][influence];
            }
          }
          if (armWeight <= 0.02 || armWeight >= 0.98) continue;
          const lateralDistance = (point[0] - region.shoulder[0]) * region.sign;
          if (lateralDistance < -0.035 || lateralDistance > 0.19) continue;
          // An arms-down rig blends Spine directly with Upperarm over a broad
          // patch. Ordinary skinning places those vertices on a flat chord,
          // producing a bat-wing collider. Pull only that mixed axillary patch
          // onto a concave underarm arc; pure torso and pure arm vertices stay
          // untouched, as do the chest, back and elbow.
          const progress = Math.max(0, Math.min(1, lateralDistance / 0.15));
          const smoothProgress = progress * progress * (3 - 2 * progress);
          const upperArmSpan = Math.max(
            1e-6,
            (region.elbow[0] - region.shoulder[0]) * region.sign,
          );
          const alongUpperArm = Math.max(
            0,
            Math.min(1, lateralDistance / upperArmSpan),
          );
          const armAxisY =
            region.shoulder[1] +
            (region.elbow[1] - region.shoulder[1]) * alongUpperArm;
          const underarmY = armAxisY - 0.06 + 0.028 * smoothProgress;
          if (point[1] >= underarmY || point[1] < region.shoulder[1] - 0.2) continue;
          const enter = Math.max(0, Math.min(1, (armWeight - 0.02) / 0.16));
          const leave = Math.max(0, Math.min(1, (0.98 - armWeight) / 0.16));
          const correction = enter * leave;
          point[1] += (underarmY - point[1]) * correction;
        }
        return point;
      };
      posed = positions.map((position, vertex) => {
        // Linear blending collapses the axillary volume when a source avatar
        // is raised roughly 80 degrees from an arms-down bind pose. Dual
        // quaternions interpolate those rotations on an arc instead, keeping
        // the shoulder round and avoiding a planar torso-to-arm membrane.
        if (jointDualQuaternions) {
          const blendedReal = [0, 0, 0, 0];
          const blendedDual = [0, 0, 0, 0];
          let reference = null;
          let totalWeight = 0;
          for (let influence = 0; influence < joints[vertex].length; influence++) {
            const weight = weights[vertex][influence];
            if (!(weight > 0)) continue;
            const dualQuaternion = jointDualQuaternions[joints[vertex][influence]];
            if (!dualQuaternion) continue;
            reference ??= dualQuaternion.real;
            const dot = reference.reduce(
              (sum, value, component) => sum + value * dualQuaternion.real[component],
              0,
            );
            const signedWeight = dot < 0 ? -weight : weight;
            for (let component = 0; component < 4; component++) {
              blendedReal[component] += dualQuaternion.real[component] * signedWeight;
              blendedDual[component] += dualQuaternion.dual[component] * signedWeight;
            }
            totalWeight += weight;
          }
          const realLength = Math.hypot(...blendedReal);
          if (totalWeight > 1e-8 && realLength > 1e-8) {
            for (let component = 0; component < 4; component++) {
              blendedReal[component] /= realLength;
              blendedDual[component] /= realLength;
            }
            return correctAxilla(
              transformPointDualQuaternion(blendedReal, blendedDual, position),
              vertex,
            );
          }
        }
        const out = [0, 0, 0];
        let totalWeight = 0;
        for (let influence = 0; influence < joints[vertex].length; influence++) {
          const weight = weights[vertex][influence];
          if (!(weight > 0)) continue;
          const matrix = jointWorld[joints[vertex][influence]];
          if (!matrix) continue;
          const transformed = transformPoint(matrix, position);
          out[0] += transformed[0] * weight;
          out[1] += transformed[1] * weight;
          out[2] += transformed[2] * weight;
          totalWeight += weight;
        }
        if (totalWeight <= 1e-8) return transformPoint(world, position);
        if (Math.abs(totalWeight - 1) > 1e-6) {
          out[0] /= totalWeight;
          out[1] /= totalWeight;
          out[2] /= totalWeight;
        }
        return correctAxilla(out, vertex);
      });
    } else {
      posed = positions.map((position) => transformPoint(world, position));
    }
    sourceVertexCount += posed.length;
    let uvChunk = null;
    if (texCoords) {
      uvChunk = new Float32Array(indices.length * 2);
      for (let corner = 0; corner < indices.length; corner++) {
        const vertex = indices[corner][0];
        uvChunk[corner * 2] = texCoords.values[vertex * 2];
        uvChunk[corner * 2 + 1] = texCoords.values[vertex * 2 + 1];
      }
      appearanceUvChunks.push(uvChunk);
      appearanceTriangleCount += indices.length / 3;
    }
    for (let index = 0; index + 2 < indices.length; index += 3) {
      triangles.push([
        posed[indices[index][0]],
        posed[indices[index + 1][0]],
        posed[indices[index + 2][0]],
      ]);
    }
  }
}

if (!triangles.length) throw new Error('The GLB contains no triangle mesh.');

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const triangle of triangles) {
  for (const point of triangle) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
}

const output = Buffer.allocUnsafe(84 + triangles.length * 50);
output.fill(0, 0, 80);
output.write(
  `TOILE posed GLB: ${path.basename(sourcePath)}`.slice(0, 80),
  0,
  'ascii',
);
output.writeUInt32LE(triangles.length, 80);
let outputOffset = 84;
for (const triangle of triangles) {
  const [a, b, c] = triangle;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...normal);
  normal = length > 1e-12 ? normal.map((value) => value / length) : [0, 0, 0];
  for (const value of [...normal, ...a, ...b, ...c]) {
    output.writeFloatLE(value, outputOffset);
    outputOffset += 4;
  }
  output.writeUInt16LE(0, outputOffset);
  outputOffset += 2;
}

fs.writeFileSync(outputPath, output);
if (appearancePath) {
  if (!appearanceImage || !appearanceUvChunks.length) {
    throw new Error('No base-colour appearance was extracted.');
  }
  const header = Buffer.alloc(24);
  header.write('TOILEA1\0', 0, 'ascii');
  header.writeUInt32LE(appearanceTriangleCount, 8);
  header.writeUInt32LE(appearanceImage.byteLength, 12);
  header.writeUInt32LE(appearanceMime === 'image/jpeg' ? 1 : appearanceMime === 'image/png' ? 2 : 0, 16);
  header.writeUInt32LE(0, 20);
  const fd = fs.openSync(appearancePath, 'w');
  try {
    fs.writeSync(fd, header);
    for (const chunk of appearanceUvChunks) {
      fs.writeSync(fd, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    fs.writeSync(fd, appearanceImage);
  } finally {
    fs.closeSync(fd);
  }
}
const extent = max.map((value, axis) => value - min[axis]);
console.log(JSON.stringify({
  source: sourcePath,
  output: outputPath,
  vertices: sourceVertexCount,
  triangles: triangles.length,
  appearance: appearancePath
    ? {
        output: appearancePath,
        triangles: appearanceTriangleCount,
        imageBytes: appearanceImage.byteLength,
        mimeType: appearanceMime,
      }
    : false,
  tPose: forceTPose ? tPoseDetails : false,
  bounds: { min, max, extent },
}, null, 2));
