#!/usr/bin/env node

/**
 * Add a deterministic humanoid rig to the supplied static `neutre.glb`.
 *
 * The audited topology and material stay byte-identical. Twenty-five vertices
 * in the two axillary patches are relaxed to remove the source's 18 genuine
 * self-intersections, then normals are regenerated. TEXCOORD_0 (required by
 * the TOILE parser), JOINTS_0, WEIGHTS_0, inverse-bind matrices and joint nodes
 * are appended to the GLB.
 *
 * Usage:
 *   node tools/rig_neutre_avatar.mjs source.glb output.glb
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_SOURCE_SHA256 =
  'a107dfc848f75ecb3d5b0c2e839da70cd9b32a60daeb91e494fe2a0708738057';
const [, , sourceArgument, outputArgument] = process.argv;
if (!sourceArgument || !outputArgument) {
  throw new Error('usage: rig_neutre_avatar.mjs source.glb output.glb');
}

const sourcePath = path.resolve(sourceArgument);
const outputPath = path.resolve(outputArgument);
const source = fs.readFileSync(sourcePath);
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
  throw new Error(
    `refusing an unknown neutral avatar source: expected ${EXPECTED_SOURCE_SHA256}, got ${sourceSha256}`,
  );
}
if (source.toString('ascii', 0, 4) !== 'glTF' || source.readUInt32LE(4) !== 2) {
  throw new Error('source must be a binary glTF 2.0 file');
}

const jsonLength = source.readUInt32LE(12);
if (source.readUInt32LE(16) !== 0x4e4f534a) throw new Error('source has no JSON chunk');
const json = JSON.parse(source.toString('utf8', 20, 20 + jsonLength));
let binHeaderOffset = 20 + jsonLength;
binHeaderOffset += (4 - (binHeaderOffset % 4)) % 4;
if (source.readUInt32LE(binHeaderOffset + 4) !== 0x004e4942) {
  throw new Error('source has no BIN chunk');
}
const sourceBinLength = source.readUInt32LE(binHeaderOffset);
const sourceBinOffset = binHeaderOffset + 8;
const sourceBin = source.subarray(sourceBinOffset, sourceBinOffset + sourceBinLength);

const primitive = json.meshes?.[0]?.primitives?.[0];
if (
  json.meshes?.length !== 1 ||
  json.meshes[0].primitives?.length !== 1 ||
  !primitive ||
  (primitive.mode ?? 4) !== 4 ||
  primitive.attributes?.POSITION === undefined ||
  primitive.attributes?.NORMAL === undefined ||
  primitive.indices === undefined ||
  primitive.attributes.TEXCOORD_0 !== undefined ||
  primitive.attributes.JOINTS_0 !== undefined ||
  primitive.attributes.WEIGHTS_0 !== undefined ||
  json.skins?.length
) {
  throw new Error('source no longer matches the audited static one-primitive avatar');
}

const COMPONENTS = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 });
const COMPONENT_BYTES = Object.freeze({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 });

function accessorLayout(accessorIndex, expectedType) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== expectedType || accessor.sparse) {
    throw new Error(`invalid ${expectedType} accessor ${accessorIndex}`);
  }
  const view = json.bufferViews?.[accessor.bufferView];
  const components = COMPONENTS[accessor.type];
  const bytes = COMPONENT_BYTES[accessor.componentType];
  if (!view || view.buffer !== 0 || !components || !bytes) {
    throw new Error(`unsupported accessor ${accessorIndex}`);
  }
  const packedStride = components * bytes;
  const stride = view.byteStride ?? packedStride;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (start + Math.max(0, accessor.count - 1) * stride + packedStride > sourceBinLength) {
    throw new Error(`truncated accessor ${accessorIndex}`);
  }
  return { accessor, view, components, bytes, stride, start };
}

function readFloatAccessor(accessorIndex, expectedType) {
  const layout = accessorLayout(accessorIndex, expectedType);
  if (layout.accessor.componentType !== 5126 || layout.accessor.normalized) {
    throw new Error(`${expectedType} accessor ${accessorIndex} must be FLOAT`);
  }
  const view = new DataView(
    sourceBin.buffer,
    sourceBin.byteOffset,
    sourceBin.byteLength,
  );
  const values = new Float32Array(layout.accessor.count * layout.components);
  for (let item = 0; item < layout.accessor.count; item++) {
    for (let component = 0; component < layout.components; component++) {
      values[item * layout.components + component] = view.getFloat32(
        layout.start + item * layout.stride + component * 4,
        true,
      );
    }
  }
  return values;
}

function readIndexAccessor(accessorIndex) {
  const layout = accessorLayout(accessorIndex, 'SCALAR');
  if (![5121, 5123, 5125].includes(layout.accessor.componentType)) {
    throw new Error(`index accessor ${accessorIndex} must be unsigned`);
  }
  const view = new DataView(sourceBin.buffer, sourceBin.byteOffset, sourceBin.byteLength);
  const values = new Uint32Array(layout.accessor.count);
  for (let item = 0; item < layout.accessor.count; item++) {
    const offset = layout.start + item * layout.stride;
    values[item] = layout.accessor.componentType === 5121
      ? view.getUint8(offset)
      : layout.accessor.componentType === 5123
        ? view.getUint16(offset, true)
        : view.getUint32(offset, true);
  }
  return values;
}

const sourcePositions = readFloatAccessor(primitive.attributes.POSITION, 'VEC3');
let positions = new Float32Array(sourcePositions);
let sourceIndices = readIndexAccessor(primitive.indices);
const sourceVertexCount = positions.length / 3;
let vertexCount = sourceVertexCount;
if (sourceVertexCount !== 885 || json.accessors[primitive.indices]?.count !== 5_298) {
  throw new Error('source topology changed after audit');
}

const minimum = [Infinity, Infinity, Infinity];
const maximum = [-Infinity, -Infinity, -Infinity];
for (let offset = 0; offset < positions.length; offset += 3) {
  for (let axis = 0; axis < 3; axis++) {
    minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
    maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
  }
}
const extent = maximum.map((value, axis) => value - minimum[axis]);
const centre = maximum.map((value, axis) => (value + minimum[axis]) * 0.5);
const sourceHeight = extent[1];
const sourceWidth = extent[0];
const sourceDepth = extent[2];
if (
  Math.abs(sourceHeight - 0.998046875) > 1e-9 ||
  Math.abs(sourceWidth - 0.275390625) > 1e-9 ||
  Math.abs(sourceDepth - 0.1777343451976776) > 1e-8
) {
  throw new Error('source bounds changed after audit');
}

const world = (x, y, z) => [
  centre[0] + x * sourceWidth,
  minimum[1] + y * sourceHeight,
  centre[2] + z * sourceDepth,
];

// A compact, conventional hierarchy. The arm landmarks follow the visible
// limb centres in the authored arms-down pose; left/right are resolved from
// spatial X by the runtime, so imported naming conventions cannot mirror it.
const jointDefinitions = [
  { name: 'Root', parent: null, position: world(0, 0, 0) },
  { name: 'Hip', parent: 'Root', position: world(0, 0.515, 0.06) },
  { name: 'Pelvis', parent: 'Hip', position: world(0, 0.56, 0.055) },
  { name: 'Waist', parent: 'Pelvis', position: world(0, 0.635, 0.05) },
  { name: 'Spine01', parent: 'Waist', position: world(0, 0.705, 0.05) },
  { name: 'Spine02', parent: 'Spine01', position: world(0, 0.78, 0.035) },
  { name: 'NeckTwist01', parent: 'Spine02', position: world(0, 0.825, 0.015) },
  { name: 'NeckTwist02', parent: 'NeckTwist01', position: world(0, 0.855, 0) },
  { name: 'Head', parent: 'NeckTwist02', position: world(0, 0.91, -0.01) },
  { name: 'L_Clavicle', parent: 'Spine02', position: world(0.17, 0.795, 0.045) },
  { name: 'L_Upperarm', parent: 'L_Clavicle', position: world(0.345, 0.765, 0.11) },
  { name: 'L_Forearm', parent: 'L_Upperarm', position: world(0.425, 0.59, 0.13) },
  { name: 'L_Hand', parent: 'L_Forearm', position: world(0.445, 0.42, 0.09) },
  { name: 'R_Clavicle', parent: 'Spine02', position: world(-0.17, 0.795, 0.045) },
  { name: 'R_Upperarm', parent: 'R_Clavicle', position: world(-0.345, 0.765, 0.11) },
  { name: 'R_Forearm', parent: 'R_Upperarm', position: world(-0.425, 0.59, 0.13) },
  { name: 'R_Hand', parent: 'R_Forearm', position: world(-0.445, 0.42, 0.09) },
  { name: 'L_Thigh', parent: 'Hip', position: world(0.17, 0.505, 0.055) },
  { name: 'L_Calf', parent: 'L_Thigh', position: world(0.18, 0.285, 0.07) },
  { name: 'L_Foot', parent: 'L_Calf', position: world(0.2, 0.075, 0.03) },
  { name: 'L_ToeBase', parent: 'L_Foot', position: world(0.2, 0.025, -0.24) },
  { name: 'R_Thigh', parent: 'Hip', position: world(-0.17, 0.505, 0.055) },
  { name: 'R_Calf', parent: 'R_Thigh', position: world(-0.18, 0.285, 0.07) },
  { name: 'R_Foot', parent: 'R_Calf', position: world(-0.2, 0.075, 0.03) },
  { name: 'R_ToeBase', parent: 'R_Foot', position: world(-0.2, 0.025, -0.24) },
];
const jointOrdinal = new Map(jointDefinitions.map((joint, ordinal) => [joint.name, ordinal]));
const jointByName = new Map(jointDefinitions.map((joint) => [joint.name, joint]));

function smoothstep(edge0, edge1, value) {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}

function addInfluence(influences, name, weight) {
  if (!(weight > 1e-7)) return;
  const ordinal = jointOrdinal.get(name);
  if (ordinal === undefined) throw new Error(`unknown generated joint ${name}`);
  influences.set(ordinal, (influences.get(ordinal) ?? 0) + weight);
}

function addLinearChain(influences, y, knots, scale = 1) {
  if (y <= knots[0][0]) {
    addInfluence(influences, knots[0][1], scale);
    return;
  }
  for (let index = 0; index < knots.length - 1; index++) {
    const [start, startName] = knots[index];
    const [end, endName] = knots[index + 1];
    if (y > end) continue;
    const amount = smoothstep(start, end, y);
    addInfluence(influences, startName, scale * (1 - amount));
    addInfluence(influences, endName, scale * amount);
    return;
  }
  addInfluence(influences, knots.at(-1)[1], scale);
}

const adjacency = Array.from({ length: vertexCount }, () => new Map());
const connect = (first, second) => {
  if (first === second) return;
  const a = first * 3;
  const b = second * 3;
  const distance = Math.hypot(
    positions[a] - positions[b],
    positions[a + 1] - positions[b + 1],
    positions[a + 2] - positions[b + 2],
  );
  const previous = adjacency[first].get(second);
  if (previous === undefined || distance < previous) adjacency[first].set(second, distance);
  adjacency[second].set(first, distance);
};
for (let offset = 0; offset < sourceIndices.length; offset += 3) {
  const a = sourceIndices[offset];
  const b = sourceIndices[offset + 1];
  const c = sourceIndices[offset + 2];
  connect(a, b);
  connect(b, c);
  connect(c, a);
}

// The supplied Tripo surface contains two tiny self-intersecting axillary
// patches. A synchronous one-ring relaxation removes all 18 intersections
// while keeping topology and the complete bounding box unchanged. The two
// coefficients are deliberately asymmetric because the authored mesh is.
const axillaryPatches = [
  {
    vertices: [245, 252, 253, 257, 272, 274, 303, 334, 336, 337, 338, 339, 340, 341],
    amount: 0.42,
  },
  {
    vertices: [233, 241, 465, 467, 469, 470, 471, 473, 474, 475, 478],
    amount: 0.27,
  },
];
const smoothedPositions = new Float32Array(positions);
for (const patch of axillaryPatches) {
  for (const vertex of patch.vertices) {
    const neighbours = [...adjacency[vertex].keys()];
    if (!neighbours.length) throw new Error(`axillary vertex ${vertex} has no neighbours`);
    for (let axis = 0; axis < 3; axis++) {
      const average = neighbours.reduce(
        (sum, neighbour) => sum + positions[neighbour * 3 + axis],
        0,
      ) / neighbours.length;
      const offset = vertex * 3 + axis;
      smoothedPositions[offset] = positions[offset] + patch.amount * (average - positions[offset]);
    }
  }
}
positions = smoothedPositions;
const repairedNormals = new Float32Array(positions.length);
for (let offset = 0; offset < sourceIndices.length; offset += 3) {
  const first = sourceIndices[offset] * 3;
  const second = sourceIndices[offset + 1] * 3;
  const third = sourceIndices[offset + 2] * 3;
  const abX = positions[second] - positions[first];
  const abY = positions[second + 1] - positions[first + 1];
  const abZ = positions[second + 2] - positions[first + 2];
  const acX = positions[third] - positions[first];
  const acY = positions[third + 1] - positions[first + 1];
  const acZ = positions[third + 2] - positions[first + 2];
  const normalX = abY * acZ - abZ * acY;
  const normalY = abZ * acX - abX * acZ;
  const normalZ = abX * acY - abY * acX;
  for (const vertexOffset of [first, second, third]) {
    repairedNormals[vertexOffset] += normalX;
    repairedNormals[vertexOffset + 1] += normalY;
    repairedNormals[vertexOffset + 2] += normalZ;
  }
}
for (let offset = 0; offset < repairedNormals.length; offset += 3) {
  const length = Math.hypot(
    repairedNormals[offset],
    repairedNormals[offset + 1],
    repairedNormals[offset + 2],
  );
  if (!(length > 1e-12)) throw new Error(`cannot regenerate normal for vertex ${offset / 3}`);
  repairedNormals[offset] /= length;
  repairedNormals[offset + 1] /= length;
  repairedNormals[offset + 2] /= length;
}

let repairedVertexCount = 0;
let squaredDisplacement = 0;
let maximumDisplacement = 0;
for (let offset = 0; offset < positions.length; offset += 3) {
  const displacement = Math.hypot(
    positions[offset] - sourcePositions[offset],
    positions[offset + 1] - sourcePositions[offset + 1],
    positions[offset + 2] - sourcePositions[offset + 2],
  );
  if (displacement > 1e-10) repairedVertexCount++;
  squaredDisplacement += displacement * displacement;
  maximumDisplacement = Math.max(maximumDisplacement, displacement);
}
if (repairedVertexCount !== 25) {
  throw new Error(`axillary repair moved ${repairedVertexCount} vertices instead of 25`);
}
for (let vertex = 0; vertex < sourceVertexCount; vertex++) {
  for (const neighbour of adjacency[vertex].keys()) {
    const a = vertex * 3;
    const b = neighbour * 3;
    adjacency[vertex].set(neighbour, Math.hypot(
      positions[a] - positions[b],
      positions[a + 1] - positions[b + 1],
      positions[a + 2] - positions[b + 2],
    ));
  }
}

function geodesicDistances(seeds) {
  if (!seeds.length) throw new Error('generated rig segmentation has no seeds');
  const distances = new Float64Array(vertexCount);
  distances.fill(Infinity);
  const visited = new Uint8Array(vertexCount);
  for (const seed of seeds) distances[seed] = 0;
  for (let iteration = 0; iteration < vertexCount; iteration++) {
    let current = -1;
    let currentDistance = Infinity;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      if (!visited[vertex] && distances[vertex] < currentDistance) {
        current = vertex;
        currentDistance = distances[vertex];
      }
    }
    if (current < 0) break;
    visited[current] = 1;
    for (const [next, edgeLength] of adjacency[current]) {
      const candidate = currentDistance + edgeLength;
      if (candidate < distances[next]) distances[next] = candidate;
    }
  }
  return distances;
}

const segmentationSeeds = { body: [], leftArm: [], rightArm: [] };
for (let vertex = 0; vertex < vertexCount; vertex++) {
  const offset = vertex * 3;
  const x = (positions[offset] - centre[0]) / sourceWidth;
  const y = (positions[offset + 1] - minimum[1]) / sourceHeight;
  if (
    y < 0.34 ||
    y > 0.84 ||
    (y >= 0.49 && y <= 0.82 && Math.abs(x) < 0.2)
  ) {
    segmentationSeeds.body.push(vertex);
  }
  if (y >= 0.38 && y <= 0.5 && x > 0.34) segmentationSeeds.leftArm.push(vertex);
  if (y >= 0.38 && y <= 0.5 && x < -0.34) segmentationSeeds.rightArm.push(vertex);
}
const bodyDistance = geodesicDistances(segmentationSeeds.body);
const leftArmDistance = geodesicDistances(segmentationSeeds.leftArm);
const rightArmDistance = geodesicDistances(segmentationSeeds.rightArm);

function originalArmAmount(vertex) {
  const offset = vertex * 3;
  const x = (positions[offset] - centre[0]) / sourceWidth;
  const y = (positions[offset + 1] - minimum[1]) / sourceHeight;
  const absoluteX = Math.abs(x);
  const side = x >= 0 ? 'L' : 'R';
  if (y < 0.355 || y > 0.835) return 0;
  // The relaxed hands pass the thighs with a real 21–22 mm surface gap. A
  // geometric split through that empty space is more reliable than geodesic
  // proximity on this deliberately low-poly mesh.
  if (y < 0.55) return absoluteX > 0.355 ? 1 : 0;
  if (y < 0.69) {
    const emptyGap = 0.36 - 0.08 * smoothstep(0.58, 0.64, y);
    return absoluteX > emptyGap ? 1 : 0;
  }
  const armDistance = side === 'L' ? leftArmDistance[vertex] : rightArmDistance[vertex];
  const separation = bodyDistance[vertex] - armDistance;
  // A geodesic Voronoi split follows the actual arm branch, including its
  // inner surface, instead of confusing it with the nearby torso or thigh.
  let amount = smoothstep(-0.012, 0.012, separation);
  const shoulderFade = 1 - smoothstep(0.825, 0.845, y);
  amount = Math.max(
    amount,
    smoothstep(0.25, 0.38, absoluteX) * shoulderFade,
  );
  return amount;
}

const originalArmAmounts = new Float64Array(sourceVertexCount);
const originalSurfaceCategory = new Uint8Array(sourceVertexCount);
for (let vertex = 0; vertex < sourceVertexCount; vertex++) {
  const amount = originalArmAmount(vertex);
  originalArmAmounts[vertex] = amount;
  if (amount > 0.5) {
    originalSurfaceCategory[vertex] = positions[vertex * 3] >= centre[0] ? 1 : 2;
  }
}
for (let pass = 0; pass < 2; pass++) {
  const relaxed = new Float64Array(originalArmAmounts);
  for (let vertex = 0; vertex < sourceVertexCount; vertex++) {
    const y = (positions[vertex * 3 + 1] - minimum[1]) / sourceHeight;
    if (y < 0.69 || y > 0.835) continue;
    const neighbours = [...adjacency[vertex].keys()];
    const average = neighbours.reduce(
      (sum, neighbour) => sum + originalArmAmounts[neighbour],
      0,
    ) / neighbours.length;
    relaxed[vertex] = originalArmAmounts[vertex] * 0.55 + average * 0.45;
  }
  originalArmAmounts.set(relaxed);
}

function addArmWeights(influences, side, y, x, scale) {
  const clavicle = `${side}_Clavicle`;
  const upper = `${side}_Upperarm`;
  const forearm = `${side}_Forearm`;
  const hand = `${side}_Hand`;
  if (y >= 0.68) {
    const innerShoulder = 1 - smoothstep(0.33, 0.43, x);
    // The low-poly bind surface needs most of its inner shoulder to follow the
    // gently rotating clavicle. Sending it directly to Upperarm collapses the
    // small axillary triangles when the arm is lifted from the authored-down
    // pose. The audited 0.95 split keeps both A and sewing poses above 38 % of
    // their rest triangle area, with no triangle stretched beyond 2x.
    const upperWeight = 1 - 0.95 * innerShoulder * smoothstep(0.70, 0.81, y);
    addInfluence(influences, upper, scale * upperWeight);
    addInfluence(influences, clavicle, scale * (1 - upperWeight));
  } else if (y >= 0.55) {
    const elbow = smoothstep(0.555, 0.625, y);
    addInfluence(influences, forearm, scale * (1 - elbow));
    addInfluence(influences, upper, scale * elbow);
  } else if (y >= 0.41) {
    const wrist = smoothstep(0.405, 0.465, y);
    addInfluence(influences, hand, scale * (1 - wrist));
    addInfluence(influences, forearm, scale * wrist);
  } else {
    addInfluence(influences, hand, scale);
  }
}

function addLowerWeights(influences, side, y, z, scale) {
  const thigh = `${side}_Thigh`;
  const calf = `${side}_Calf`;
  const foot = `${side}_Foot`;
  const toe = `${side}_ToeBase`;
  if (y >= 0.47) {
    const hipBlend = smoothstep(0.47, 0.55, y);
    addInfluence(influences, thigh, scale * (1 - 0.55 * hipBlend));
    addInfluence(influences, 'Hip', scale * 0.55 * hipBlend);
  } else if (y >= 0.255) {
    const knee = smoothstep(0.255, 0.32, y);
    addInfluence(influences, calf, scale * (1 - knee));
    addInfluence(influences, thigh, scale * knee);
  } else if (y >= 0.065) {
    const ankle = smoothstep(0.065, 0.115, y);
    addInfluence(influences, foot, scale * (1 - ankle));
    addInfluence(influences, calf, scale * ankle);
  } else {
    const toeWeight = 1 - smoothstep(-0.32, -0.02, z);
    addInfluence(influences, toe, scale * toeWeight);
    addInfluence(influences, foot, scale * (1 - toeWeight));
  }
}

const uvs = new Float32Array(vertexCount * 2);
const joints = new Uint8Array(vertexCount * 4);
const weights = new Float32Array(vertexCount * 4);
const weightUsage = new Uint32Array(jointDefinitions.length);
let mixedArmLowerVertices = 0;

for (let vertex = 0; vertex < vertexCount; vertex++) {
  const offset = vertex * 3;
  const xSource = positions[offset];
  const ySource = positions[offset + 1];
  const zSource = positions[offset + 2];
  const x = (xSource - centre[0]) / sourceWidth;
  const y = (ySource - minimum[1]) / sourceHeight;
  const z = (zSource - centre[2]) / sourceDepth;
  const absoluteX = Math.abs(x);
  const side = x >= 0 ? 'L' : 'R';

  uvs[vertex * 2] = 0.5 + Math.atan2(zSource - centre[2], xSource - centre[0]) / (2 * Math.PI);
  uvs[vertex * 2 + 1] = y;

  const influences = new Map();
  const armAmount = originalArmAmounts[vertex];
  if (armAmount > 0) addArmWeights(influences, side, y, absoluteX, armAmount);

  const bodyAmount = 1 - armAmount;
  if (bodyAmount > 0) {
    if (y < 0.56) {
      addLowerWeights(influences, side, y, z, bodyAmount);
    } else {
      addLinearChain(influences, y, [
        [0.56, 'Pelvis'],
        [0.635, 'Waist'],
        [0.705, 'Spine01'],
        [0.78, 'Spine02'],
        [0.825, 'NeckTwist01'],
        [0.855, 'NeckTwist02'],
        [0.91, 'Head'],
      ], bodyAmount);
    }
  }

  const ranked = [...influences.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 4);
  const sum = ranked.reduce((total, entry) => total + entry[1], 0);
  if (!(sum > 1e-8)) throw new Error(`vertex ${vertex} has no generated influence`);
  let hasArm = false;
  let hasLower = false;
  for (let influence = 0; influence < 4; influence++) {
    const [ordinal = 0, weight = 0] = ranked[influence] ?? [];
    joints[vertex * 4 + influence] = ordinal;
    weights[vertex * 4 + influence] = weight / sum;
    if (weight > 0) weightUsage[ordinal]++;
    const name = jointDefinitions[ordinal].name;
    hasArm ||= /_(?:Clavicle|Upperarm|Forearm|Hand)$/.test(name);
    hasLower ||= name === 'Hip' || /_(?:Thigh|Calf|Foot|ToeBase)$/.test(name);
  }
  if (hasArm && hasLower) mixedArmLowerVertices++;
}
if (mixedArmLowerVertices !== 0) {
  throw new Error(`generated ${mixedArmLowerVertices} mixed arm/lower vertices`);
}
let serializedMaximumWeightError = 0;
for (let offset = 0; offset < weights.length; offset += 4) {
  const sum = weights[offset] + weights[offset + 1] + weights[offset + 2] + weights[offset + 3];
  serializedMaximumWeightError = Math.max(serializedMaximumWeightError, Math.abs(1 - sum));
}
if (serializedMaximumWeightError >= 2e-6) {
  throw new Error(`serialized skin weight error is ${serializedMaximumWeightError}`);
}
const uvMinimum = [Infinity, Infinity];
const uvMaximum = [-Infinity, -Infinity];
for (let offset = 0; offset < uvs.length; offset += 2) {
  uvMinimum[0] = Math.min(uvMinimum[0], uvs[offset]);
  uvMinimum[1] = Math.min(uvMinimum[1], uvs[offset + 1]);
  uvMaximum[0] = Math.max(uvMaximum[0], uvs[offset]);
  uvMaximum[1] = Math.max(uvMaximum[1], uvs[offset + 1]);
}

const inverseBindMatrices = new Float32Array(jointDefinitions.length * 16);
for (let ordinal = 0; ordinal < jointDefinitions.length; ordinal++) {
  const position = jointDefinitions[ordinal].position;
  const offset = ordinal * 16;
  inverseBindMatrices[offset] = 1;
  inverseBindMatrices[offset + 5] = 1;
  inverseBindMatrices[offset + 10] = 1;
  inverseBindMatrices[offset + 12] = -position[0];
  inverseBindMatrices[offset + 13] = -position[1];
  inverseBindMatrices[offset + 14] = -position[2];
  inverseBindMatrices[offset + 15] = 1;
}

const chunks = [];
let appendedLength = 0;
function appendTypedArray(array, target) {
  const padding = (4 - ((sourceBinLength + appendedLength) % 4)) % 4;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    appendedLength += padding;
  }
  const byteOffset = sourceBinLength + appendedLength;
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  chunks.push(bytes);
  appendedLength += bytes.byteLength;
  const viewIndex = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
  return viewIndex;
}

const positionView = appendTypedArray(positions, 34962);
const normalView = appendTypedArray(repairedNormals, 34962);
const uvView = appendTypedArray(uvs, 34962);
const jointsView = appendTypedArray(joints, 34962);
const weightsView = appendTypedArray(weights, 34962);
const inverseBindView = appendTypedArray(inverseBindMatrices, null);
const positionAccessor = json.accessors.length;
json.accessors.push({
  bufferView: positionView,
  componentType: 5126,
  count: vertexCount,
  type: 'VEC3',
  min: minimum,
  max: maximum,
});
const normalAccessor = json.accessors.length;
json.accessors.push({
  bufferView: normalView,
  componentType: 5126,
  count: vertexCount,
  type: 'VEC3',
});
const uvAccessor = json.accessors.length;
json.accessors.push({
  bufferView: uvView,
  componentType: 5126,
  count: vertexCount,
  type: 'VEC2',
  min: uvMinimum,
  max: uvMaximum,
});
const jointsAccessor = json.accessors.length;
json.accessors.push({ bufferView: jointsView, componentType: 5121, count: vertexCount, type: 'VEC4' });
const weightsAccessor = json.accessors.length;
json.accessors.push({ bufferView: weightsView, componentType: 5126, count: vertexCount, type: 'VEC4' });
const inverseBindAccessor = json.accessors.length;
json.accessors.push({
  bufferView: inverseBindView,
  componentType: 5126,
  count: jointDefinitions.length,
  type: 'MAT4',
});
primitive.attributes.POSITION = positionAccessor;
primitive.attributes.NORMAL = normalAccessor;
primitive.attributes.TEXCOORD_0 = uvAccessor;
primitive.attributes.JOINTS_0 = jointsAccessor;
primitive.attributes.WEIGHTS_0 = weightsAccessor;

const meshNodeIndex = json.nodes.findIndex((node) => node.mesh === 0);
if (meshNodeIndex < 0 || json.nodes.filter((node) => node.mesh === 0).length !== 1) {
  throw new Error('source must have exactly one active mesh node');
}
const generatedNodeStart = json.nodes.length;
const generatedNodeIndex = new Map(
  jointDefinitions.map((joint, ordinal) => [joint.name, generatedNodeStart + ordinal]),
);
for (const joint of jointDefinitions) {
  const parentPosition = joint.parent ? jointByName.get(joint.parent).position : [0, 0, 0];
  const children = jointDefinitions
    .filter((candidate) => candidate.parent === joint.name)
    .map((candidate) => generatedNodeIndex.get(candidate.name));
  json.nodes.push({
    name: joint.name,
    translation: joint.position.map((value, axis) => value - parentPosition[axis]),
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    ...(children.length ? { children } : {}),
  });
}
const rootNode = generatedNodeIndex.get('Root');
json.nodes[meshNodeIndex].skin = 0;
json.skins = [{
  name: 'TOILE Neutral Humanoid Rig',
  inverseBindMatrices: inverseBindAccessor,
  skeleton: rootNode,
  joints: jointDefinitions.map((joint) => generatedNodeIndex.get(joint.name)),
}];
const sceneIndex = json.scene ?? 0;
json.scenes ??= [{ nodes: [] }];
json.scenes[sceneIndex].nodes ??= [];
if (!json.scenes[sceneIndex].nodes.includes(rootNode)) json.scenes[sceneIndex].nodes.push(rootNode);
json.asset = {
  ...json.asset,
  generator: `${json.asset?.generator ?? 'unknown'} + TOILE deterministic humanoid rig`,
  extras: {
    ...(json.asset?.extras ?? {}),
    toile: {
      sourceSha256,
      rigVersion: 2,
      sourceTopologyPreserved: true,
      axillaryRepair: {
        movedVertices: repairedVertexCount,
        sourceSelfIntersections: 18,
        repairedSelfIntersections: 0,
      },
      statureM: 1.83,
    },
  },
};

const appended = Buffer.concat(chunks, appendedLength);
const outputBin = Buffer.concat([sourceBin, appended]);
json.buffers[0].byteLength = outputBin.byteLength;
let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
if (jsonPadding) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
const binPadding = (4 - (outputBin.byteLength % 4)) % 4;
const paddedBin = binPadding ? Buffer.concat([outputBin, Buffer.alloc(binPadding)]) : outputBin;
const output = Buffer.allocUnsafe(12 + 8 + jsonBytes.byteLength + 8 + paddedBin.byteLength);
output.write('glTF', 0, 'ascii');
output.writeUInt32LE(2, 4);
output.writeUInt32LE(output.byteLength, 8);
output.writeUInt32LE(jsonBytes.byteLength, 12);
output.writeUInt32LE(0x4e4f534a, 16);
jsonBytes.copy(output, 20);
const outputBinHeader = 20 + jsonBytes.byteLength;
output.writeUInt32LE(paddedBin.byteLength, outputBinHeader);
output.writeUInt32LE(0x004e4942, outputBinHeader + 4);
paddedBin.copy(output, outputBinHeader + 8);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
const outputSha256 = crypto.createHash('sha256').update(output).digest('hex');
process.stdout.write(`${JSON.stringify({
  source: sourcePath,
  output: outputPath,
  sourceSha256,
  outputSha256,
  bytes: output.byteLength,
  vertices: vertexCount,
  triangles: json.accessors[primitive.indices].count / 3,
  joints: jointDefinitions.length,
  repairedVertices: repairedVertexCount,
  maximumRepairDisplacementMmAt183cm: maximumDisplacement * (1.83 / sourceHeight) * 1_000,
  rmsRepairDisplacementMmAt183cm:
    Math.sqrt(squaredDisplacement / sourceVertexCount) * (1.83 / sourceHeight) * 1_000,
  repairedPositionSha256: crypto.createHash('sha256')
    .update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength))
    .digest('hex'),
  repairedNormalSha256: crypto.createHash('sha256')
    .update(Buffer.from(repairedNormals.buffer, repairedNormals.byteOffset, repairedNormals.byteLength))
    .digest('hex'),
  generatedUvSha256: crypto.createHash('sha256')
    .update(Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength))
    .digest('hex'),
  generatedJointsSha256: crypto.createHash('sha256')
    .update(Buffer.from(joints.buffer, joints.byteOffset, joints.byteLength))
    .digest('hex'),
  generatedWeightsSha256: crypto.createHash('sha256')
    .update(Buffer.from(weights.buffer, weights.byteOffset, weights.byteLength))
    .digest('hex'),
  preservedIndicesSha256: crypto.createHash('sha256')
    .update(Buffer.from(sourceIndices.buffer, sourceIndices.byteOffset, sourceIndices.byteLength))
    .digest('hex'),
  maximumWeightError: serializedMaximumWeightError,
  mixedArmLowerVertices,
  weightedVerticesByJoint: Object.fromEntries(
    jointDefinitions.map((joint, ordinal) => [joint.name, weightUsage[ordinal]]),
  ),
  bounds: { minimum, maximum, extent },
}, null, 2)}\n`);
