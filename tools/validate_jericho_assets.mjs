#!/usr/bin/env node
/**
 * Integrity gate for the neutral male visual, export and collision assets.
 *
 * This deliberately parses the shipped binary files instead of trusting an
 * intermediate conversion report. It catches accidental geometry changes,
 * lost UV/skin data, a stale collision pose, surface self-intersections and
 * truncated cache files. The historical `jericho.*` basename is retained for
 * compatibility with saved TOILE projects.
 *
 * Usage:
 *   node tools/validate_jericho_assets.mjs
 *   node tools/validate_jericho_assets.mjs --json
 *   node tools/validate_jericho_assets.mjs --visual path --export path \
 *     --mesh path --sdf path
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const TRIANGLES = 4;

const EXPECTED_REFINED_SHA256 = 'cb23e6635743328c3637c46b0ee29343de5f3a87c4279df6ff6e9a1e8ebb3263';
const EXPECTED_REFINED_BYTES = 96_128;
const EXPECTED_SOURCE_SHA256 = 'a107dfc848f75ecb3d5b0c2e839da70cd9b32a60daeb91e494fe2a0708738057';
const EXPECTED_SOURCE_VERTICES = 885;
const EXPECTED_SOURCE_TRIANGLES = 1_766;
const EXPECTED_SOURCE_HEIGHT_M = 0.998046875;
const EXPECTED_SOURCE_BIN_PREFIX_BYTES = 42_432;
const EXPECTED_SOURCE_BIN_PREFIX_SHA256 = 'ee5d6ec6286f13e4ddac869c2df0c8760e4c4b43551856227446464540d9c4dc';
const EXPECTED_ACTIVE_STREAMS = {
  positions: 'b89b6b70a1bffe284bd30f35027f30ae75241f43c23d1e2e269ecaf28e07581f',
  normals: '0620391bc5915644c56b377cefeb757e52c087770a037424a4b212df6e5cf733',
  uv: '906a1ce5f22fddaa49822d767567f6c1b1336bd8da082dcd4b61a3634e1c473c',
  indices: '3c9d178602ddc565f0913596d9ad2135c4c4b56e3f2cd2f3b69058fb8b28d8ff',
  joints: '82db428504d5dae142759e53f3139a93db65aec496a58887e03d3161840a0442',
  weights: '40a289b944c00275908adf946a51b6dd001e3add546699234d80c1e76d544eda',
};
const EXPECTED_PROXY_TRIANGLES = 1_766;
const EXPECTED_HEIGHT_M = 1.83;
const BOUNDS_TOLERANCE_M = 0.004;
const EXPECTED_JOINT_NAMES = [
  'Root', 'Hip', 'Pelvis', 'Waist', 'Spine01', 'Spine02',
  'NeckTwist01', 'NeckTwist02', 'Head',
  'L_Clavicle', 'L_Upperarm', 'L_Forearm', 'L_Hand',
  'R_Clavicle', 'R_Upperarm', 'R_Forearm', 'R_Hand',
  'L_Thigh', 'L_Calf', 'L_Foot', 'L_ToeBase',
  'R_Thigh', 'R_Calf', 'R_Foot', 'R_ToeBase',
];
const EXPECTED_COLLISION_SHA256 = {
  native: {
    mesh: 'd98aa161c7545290ed37489b5275540761e8d41a6cf0644b109367e57b920157',
    sdf: '69b81b6aeb9ad58b4ed84abb64ace4444e87930febf90b29f0c45b65b381564b',
  },
  apose: {
    mesh: 'b8c7cb1ee21f6916ec8ab7eaf0a23bfc052fe24518ec15d941d82bfcc5da45cd',
    sdf: 'a7acf723b52f1eab75ae135a83da877fd9e65e412ac822903b395356641f6c9d',
  },
  sewing: {
    mesh: '31e9a4eff001307558abda8accdb0b3649db5eb4e0dddba0727882a3cd3ab132',
    sdf: 'a6ed12f3b1e703608770bb38198089b62119fb1b9f5879781f6935835dc07c5c',
  },
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value, label) {
  invariant(Number.isFinite(value), `${label} is not finite`);
  return value;
}

function parseArguments(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    source: path.join(root, 'tools/fixtures/neutre.source.glb'),
    visual: path.join(root, 'public/avatars/jericho.visual.glb'),
    export: path.join(root, 'public/avatars/jericho.export.glb'),
    mesh: path.join(root, 'public/avatars/jericho.mesh.bin'),
    sdf: path.join(root, 'public/avatars/jericho.sdf.bin'),
    aposeMesh: path.join(root, 'public/avatars/jericho.apose.mesh.bin'),
    aposeSdf: path.join(root, 'public/avatars/jericho.apose.sdf.bin'),
    sewingMesh: path.join(root, 'public/avatars/jericho.sewing.mesh.bin'),
    sewingSdf: path.join(root, 'public/avatars/jericho.sewing.sdf.bin'),
    json: false,
  };
  const paths = {
    '--source': 'source',
    '--visual': 'visual',
    '--export': 'export',
    '--mesh': 'mesh',
    '--sdf': 'sdf',
    '--apose-mesh': 'aposeMesh',
    '--apose-sdf': 'aposeSdf',
    '--sewing-mesh': 'sewingMesh',
    '--sewing-sdf': 'sewingSdf',
  };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--json') {
      options.json = true;
      continue;
    }
    invariant(paths[option], `unknown option: ${option}`);
    const value = argv[++index];
    invariant(value, `missing path after ${option}`);
    options[paths[option]] = path.resolve(value);
  }
  return options;
}

function requiredFile(filename) {
  invariant(fs.existsSync(filename), `required neutral avatar asset is missing: ${filename}`);
  const bytes = fs.readFileSync(filename);
  invariant(bytes.byteLength > 0, `neutral avatar asset is empty: ${filename}`);
  return bytes;
}

function componentCount(type) {
  const counts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const count = counts[type];
  invariant(count, `unsupported accessor type ${type}`);
  return count;
}

function componentSize(componentType) {
  if (componentType === 5120 || componentType === 5121) return 1;
  if (componentType === 5122 || componentType === 5123) return 2;
  if (componentType === 5125 || componentType === 5126) return 4;
  throw new Error(`unsupported accessor component type ${componentType}`);
}

function scalar(view, offset, componentType) {
  if (componentType === 5120) return view.getInt8(offset);
  if (componentType === 5121) return view.getUint8(offset);
  if (componentType === 5122) return view.getInt16(offset, true);
  if (componentType === 5123) return view.getUint16(offset, true);
  if (componentType === 5125) return view.getUint32(offset, true);
  if (componentType === 5126) return view.getFloat32(offset, true);
  throw new Error(`unsupported accessor component type ${componentType}`);
}

function parseGlb(filename) {
  const bytes = requiredFile(filename);
  invariant(bytes.byteLength >= 28, `${filename}: truncated GLB header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  invariant(view.getUint32(0, true) === GLB_MAGIC, `${filename}: invalid GLB magic`);
  invariant(view.getUint32(4, true) === 2, `${filename}: GLB version is not 2`);
  invariant(view.getUint32(8, true) === bytes.byteLength, `${filename}: declared GLB size is wrong`);

  const jsonLength = view.getUint32(12, true);
  invariant(view.getUint32(16, true) === JSON_CHUNK, `${filename}: first chunk is not JSON`);
  invariant(jsonLength % 4 === 0, `${filename}: JSON chunk is not 4-byte aligned`);
  const binHeader = 20 + jsonLength;
  invariant(binHeader + 8 <= bytes.byteLength, `${filename}: missing BIN chunk`);
  invariant(view.getUint32(binHeader + 4, true) === BIN_CHUNK, `${filename}: second chunk is not BIN`);
  const binLength = view.getUint32(binHeader, true);
  const binOffset = binHeader + 8;
  invariant(binOffset + binLength === bytes.byteLength, `${filename}: BIN chunk size is wrong`);

  let json;
  try {
    json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
  } catch (error) {
    throw new Error(`${filename}: invalid GLB JSON (${error.message})`);
  }
  invariant(json.asset?.version === '2.0', `${filename}: glTF asset version is not 2.0`);
  invariant(Array.isArray(json.buffers) && json.buffers.length === 1, `${filename}: expected one embedded buffer`);
  invariant(!json.buffers[0].uri, `${filename}: buffer must be embedded`);
  invariant(json.buffers[0].byteLength <= binLength, `${filename}: declared buffer exceeds BIN chunk`);

  const glb = { filename, bytes, view, json, binOffset, binLength };
  for (const [index, bufferView] of (json.bufferViews ?? []).entries()) {
    invariant(bufferView.buffer === 0, `${filename}: bufferView ${index} does not use embedded buffer 0`);
    invariant(Number.isInteger(bufferView.byteLength) && bufferView.byteLength >= 0,
      `${filename}: invalid bufferView ${index} length`);
    const start = bufferView.byteOffset ?? 0;
    invariant(start >= 0 && start + bufferView.byteLength <= binLength,
      `${filename}: bufferView ${index} exceeds BIN chunk`);
  }
  return glb;
}

function accessorReader(glb, accessorIndex, label) {
  const accessor = glb.json.accessors?.[accessorIndex];
  invariant(accessor, `${glb.filename}: missing ${label} accessor`);
  invariant(accessor.sparse === undefined, `${glb.filename}: sparse ${label} is not supported`);
  invariant(Number.isInteger(accessor.count) && accessor.count > 0,
    `${glb.filename}: invalid ${label} count`);
  const bufferView = glb.json.bufferViews?.[accessor.bufferView];
  invariant(bufferView, `${glb.filename}: ${label} has no bufferView`);
  const components = componentCount(accessor.type);
  const size = componentSize(accessor.componentType);
  const elementSize = components * size;
  const stride = bufferView.byteStride ?? elementSize;
  invariant(stride >= elementSize && stride % size === 0,
    `${glb.filename}: invalid ${label} byte stride`);
  const relativeOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = relativeOffset + (accessor.count - 1) * stride + elementSize;
  invariant(relativeOffset >= 0 && end <= glb.binLength,
    `${glb.filename}: ${label} accessor exceeds BIN chunk`);
  const start = glb.binOffset + relativeOffset;
  return {
    accessor,
    count: accessor.count,
    components,
    byteStart: start,
    stride,
    elementSize,
    value(item, component = 0) {
      return scalar(glb.view, start + item * stride + component * size, accessor.componentType);
    },
  };
}

function accessorSha256(glb, reader) {
  const hash = crypto.createHash('sha256');
  for (let item = 0; item < reader.count; item++) {
    const start = reader.byteStart + item * reader.stride;
    hash.update(glb.bytes.subarray(start, start + reader.elementSize));
  }
  return hash.digest('hex');
}

function scanVectors(reader, expectedComponents, label) {
  invariant(reader.components === expectedComponents, `${label}: wrong component count`);
  const min = Array(expectedComponents).fill(Infinity);
  const max = Array(expectedComponents).fill(-Infinity);
  let minimumLength = Infinity;
  let maximumLength = 0;
  for (let item = 0; item < reader.count; item++) {
    let lengthSquared = 0;
    for (let component = 0; component < expectedComponents; component++) {
      const value = finite(reader.value(item, component), `${label}[${item}][${component}]`);
      min[component] = Math.min(min[component], value);
      max[component] = Math.max(max[component], value);
      if (component < 3) lengthSquared += value * value;
    }
    const length = Math.sqrt(lengthSquared);
    minimumLength = Math.min(minimumLength, length);
    maximumLength = Math.max(maximumLength, length);
  }
  return { min, max, minimumLength, maximumLength };
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function segmentHitsTriangle(start, end, triangle, lengthEpsilon) {
  const direction = subtract(end, start);
  const edgeA = subtract(triangle[1], triangle[0]);
  const edgeB = subtract(triangle[2], triangle[0]);
  const perpendicular = cross(direction, edgeB);
  const determinant = dot(edgeA, perpendicular);
  const determinantEpsilon = Math.max(1e-20, lengthEpsilon * lengthEpsilon * lengthEpsilon);
  if (Math.abs(determinant) <= determinantEpsilon) return false;
  const inverse = 1 / determinant;
  const origin = subtract(start, triangle[0]);
  const u = dot(origin, perpendicular) * inverse;
  const barycentricEpsilon = 1e-8;
  if (u < -barycentricEpsilon || u > 1 + barycentricEpsilon) return false;
  const q = cross(origin, edgeA);
  const v = dot(direction, q) * inverse;
  if (v < -barycentricEpsilon || u + v > 1 + barycentricEpsilon) return false;
  const amount = dot(edgeB, q) * inverse;
  return amount >= -barycentricEpsilon && amount <= 1 + barycentricEpsilon;
}

function coplanarTrianglesOverlap(first, second, normal, lengthEpsilon) {
  const axis = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? 0
    : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const project = (point) => axis === 0
    ? [point[1], point[2]]
    : axis === 1 ? [point[0], point[2]] : [point[0], point[1]];
  const a = first.map(project);
  const b = second.map(project);
  const orient = (p, q, r) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const onSegment = (p, q, r) =>
    q[0] >= Math.min(p[0], r[0]) - lengthEpsilon &&
    q[0] <= Math.max(p[0], r[0]) + lengthEpsilon &&
    q[1] >= Math.min(p[1], r[1]) - lengthEpsilon &&
    q[1] <= Math.max(p[1], r[1]) + lengthEpsilon;
  const edgesIntersect = (p1, p2, q1, q2) => {
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    const areaEpsilon = lengthEpsilon * lengthEpsilon;
    if (((o1 > areaEpsilon && o2 < -areaEpsilon) || (o1 < -areaEpsilon && o2 > areaEpsilon)) &&
        ((o3 > areaEpsilon && o4 < -areaEpsilon) || (o3 < -areaEpsilon && o4 > areaEpsilon))) {
      return true;
    }
    return (Math.abs(o1) <= areaEpsilon && onSegment(p1, q1, p2)) ||
      (Math.abs(o2) <= areaEpsilon && onSegment(p1, q2, p2)) ||
      (Math.abs(o3) <= areaEpsilon && onSegment(q1, p1, q2)) ||
      (Math.abs(o4) <= areaEpsilon && onSegment(q1, p2, q2));
  };
  for (let firstEdge = 0; firstEdge < 3; firstEdge++) {
    for (let secondEdge = 0; secondEdge < 3; secondEdge++) {
      if (edgesIntersect(
        a[firstEdge], a[(firstEdge + 1) % 3],
        b[secondEdge], b[(secondEdge + 1) % 3],
      )) return true;
    }
  }
  const contains = (point, triangle) => {
    const values = [
      orient(triangle[0], triangle[1], point),
      orient(triangle[1], triangle[2], point),
      orient(triangle[2], triangle[0], point),
    ];
    const areaEpsilon = lengthEpsilon * lengthEpsilon;
    return values.every((value) => value >= -areaEpsilon) ||
      values.every((value) => value <= areaEpsilon);
  };
  return contains(a[0], b) || contains(b[0], a);
}

function trianglesIntersect(first, second, lengthEpsilon) {
  for (let edge = 0; edge < 3; edge++) {
    if (segmentHitsTriangle(first[edge], first[(edge + 1) % 3], second, lengthEpsilon) ||
        segmentHitsTriangle(second[edge], second[(edge + 1) % 3], first, lengthEpsilon)) {
      return true;
    }
  }
  const firstNormal = cross(subtract(first[1], first[0]), subtract(first[2], first[0]));
  const secondNormal = cross(subtract(second[1], second[0]), subtract(second[2], second[0]));
  const firstLength = Math.hypot(...firstNormal);
  const secondLength = Math.hypot(...secondNormal);
  if (firstLength <= lengthEpsilon * lengthEpsilon || secondLength <= lengthEpsilon * lengthEpsilon) {
    return false;
  }
  const parallel = Math.hypot(...cross(firstNormal, secondNormal)) /
    (firstLength * secondLength);
  const planeDistance = Math.max(...second.map((point) =>
    Math.abs(dot(firstNormal, subtract(point, first[0]))) / firstLength));
  return parallel <= 1e-8 && planeDistance <= lengthEpsilon &&
    coplanarTrianglesOverlap(first, second, firstNormal, lengthEpsilon);
}

function findSelfIntersections(positions, indices, maximumPairs = 20) {
  invariant(indices.length % 3 === 0, 'self-intersection audit requires triangle indices');
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], positions[offset + axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], positions[offset + axis]);
    }
  }
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
  const epsilon = Math.max(1e-12, diagonal * 1e-9);
  const triangles = Array.from({ length: indices.length / 3 }, (_, triangleIndex) => {
    const vertices = [
      indices[triangleIndex * 3],
      indices[triangleIndex * 3 + 1],
      indices[triangleIndex * 3 + 2],
    ];
    const points = vertices.map((vertex) => [
      positions[vertex * 3],
      positions[vertex * 3 + 1],
      positions[vertex * 3 + 2],
    ]);
    return {
      triangleIndex,
      vertices,
      points,
      min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
      max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
    };
  });
  const ordered = [...triangles].sort((first, second) => first.min[0] - second.min[0]);
  const pairs = [];
  let count = 0;
  for (let firstIndex = 0; firstIndex < ordered.length; firstIndex++) {
    const first = ordered[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < ordered.length; secondIndex++) {
      const second = ordered[secondIndex];
      if (second.min[0] > first.max[0] + epsilon) break;
      if (first.vertices.some((vertex) => second.vertices.includes(vertex))) continue;
      if ([1, 2].some((axis) =>
        first.max[axis] < second.min[axis] - epsilon ||
        second.max[axis] < first.min[axis] - epsilon)) continue;
      if (!trianglesIntersect(first.points, second.points, epsilon)) continue;
      count++;
      if (pairs.length < maximumPairs) pairs.push([first.triangleIndex, second.triangleIndex]);
    }
  }
  return { count, pairs };
}

function validateVisualGlb(filename, kind) {
  const glb = parseGlb(filename);
  const fileSha256 = crypto.createHash('sha256').update(glb.bytes).digest('hex');
  invariant(glb.bytes.byteLength === EXPECTED_REFINED_BYTES,
    `${filename}: refined asset is ${glb.bytes.byteLength} bytes, expected ${EXPECTED_REFINED_BYTES}`);
  invariant(fileSha256 === EXPECTED_REFINED_SHA256,
    `${filename}: refined asset SHA-256 changed (${fileSha256})`);
  invariant(glb.binLength >= EXPECTED_SOURCE_BIN_PREFIX_BYTES,
    `${filename}: original BIN prefix is truncated`);
  const sourcePrefix = glb.bytes.subarray(
    glb.binOffset,
    glb.binOffset + EXPECTED_SOURCE_BIN_PREFIX_BYTES,
  );
  invariant(
    crypto.createHash('sha256').update(sourcePrefix).digest('hex') === EXPECTED_SOURCE_BIN_PREFIX_SHA256,
    `${filename}: source GLB binary prefix changed`,
  );
  invariant(glb.json.meshes?.length === 1, `${filename}: expected exactly one mesh`);
  const primitives = glb.json.meshes.flatMap((mesh) => mesh.primitives ?? []);
  invariant(primitives.length === 1, `${filename}: expected exactly one primitive`);
  const primitive = primitives[0];
  invariant((primitive.mode ?? TRIANGLES) === TRIANGLES, `${filename}: primitive is not TRIANGLES`);
  invariant(Number.isInteger(primitive.indices), `${filename}: primitive must be indexed`);

  const required = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
  for (const semantic of required) {
    invariant(Number.isInteger(primitive.attributes?.[semantic]), `${filename}: missing ${semantic}`);
  }
  const position = accessorReader(glb, primitive.attributes.POSITION, 'POSITION');
  const normal = accessorReader(glb, primitive.attributes.NORMAL, 'NORMAL');
  const uv = accessorReader(glb, primitive.attributes.TEXCOORD_0, 'TEXCOORD_0');
  const tangent = primitive.attributes.TANGENT === undefined
    ? null
    : accessorReader(glb, primitive.attributes.TANGENT, 'TANGENT');
  const joints = accessorReader(glb, primitive.attributes.JOINTS_0, 'JOINTS_0');
  const weights = accessorReader(glb, primitive.attributes.WEIGHTS_0, 'WEIGHTS_0');
  const indices = accessorReader(glb, primitive.indices, 'indices');
  const activeStreams = {
    positions: accessorSha256(glb, position),
    normals: accessorSha256(glb, normal),
    uv: accessorSha256(glb, uv),
    indices: accessorSha256(glb, indices),
    joints: accessorSha256(glb, joints),
    weights: accessorSha256(glb, weights),
  };
  for (const [role, digest] of Object.entries(activeStreams)) {
    invariant(digest === EXPECTED_ACTIVE_STREAMS[role],
      `${filename}: active ${role} stream SHA-256 changed (${digest})`);
  }
  invariant(position.accessor.componentType === FLOAT && position.accessor.type === 'VEC3',
    `${filename}: POSITION must be FLOAT VEC3`);
  invariant(normal.accessor.componentType === FLOAT && normal.accessor.type === 'VEC3',
    `${filename}: NORMAL must be FLOAT VEC3`);
  invariant(uv.accessor.componentType === FLOAT && uv.accessor.type === 'VEC2',
    `${filename}: TEXCOORD_0 must be FLOAT VEC2`);
  if (tangent) {
    invariant(tangent.accessor.componentType === FLOAT && tangent.accessor.type === 'VEC4',
      `${filename}: TANGENT must be FLOAT VEC4`);
  }
  invariant(joints.accessor.type === 'VEC4', `${filename}: JOINTS_0 must be VEC4`);
  invariant(weights.accessor.type === 'VEC4', `${filename}: WEIGHTS_0 must be VEC4`);
  invariant(indices.accessor.type === 'SCALAR' && [5121, 5123, 5125].includes(indices.accessor.componentType),
    `${filename}: indices must be unsigned SCALAR`);
  invariant(normal.count === position.count && uv.count === position.count &&
    joints.count === position.count && weights.count === position.count &&
    (!tangent || tangent.count === position.count),
    `${filename}: attribute counts do not match POSITION`);
  invariant(indices.count % 3 === 0, `${filename}: index count is not divisible by three`);

  const positionStats = scanVectors(position, 3, `${filename}: POSITION`);
  const normalStats = scanVectors(normal, 3, `${filename}: NORMAL`);
  const uvStats = scanVectors(uv, 2, `${filename}: TEXCOORD_0`);
  invariant(normalStats.minimumLength > 0.9 && normalStats.maximumLength < 1.1,
    `${filename}: normals are not unit length`);
  if (tangent) {
    const tangentStats = scanVectors(tangent, 4, `${filename}: TANGENT`);
    invariant(tangentStats.minimumLength > 0.9 && tangentStats.maximumLength < 1.1,
      `${filename}: tangent xyz is not unit length`);
    for (let item = 0; item < tangent.count; item++) {
      invariant(Math.abs(Math.abs(tangent.value(item, 3)) - 1) < 1e-4,
        `${filename}: tangent handedness must be -1 or +1`);
    }
  }
  invariant(uvStats.max[0] - uvStats.min[0] > 0.9 && uvStats.max[1] - uvStats.min[1] > 0.9,
    `${filename}: UV map has collapsed`);
  for (const [reader, stats, label] of [
    [position, positionStats, 'POSITION'],
    [uv, uvStats, 'TEXCOORD_0'],
  ]) {
    invariant(reader.accessor.min?.length === stats.min.length &&
      reader.accessor.max?.length === stats.max.length,
    `${filename}: ${label} accessor must declare exact bounds`);
    for (let axis = 0; axis < stats.min.length; axis++) {
      invariant(Math.abs(reader.accessor.min[axis] - stats.min[axis]) <= 1e-7 &&
        Math.abs(reader.accessor.max[axis] - stats.max[axis]) <= 1e-7,
      `${filename}: ${label} accessor bounds are stale`);
    }
  }

  let maximumIndex = 0;
  for (let item = 0; item < indices.count; item++) {
    const index = indices.value(item);
    invariant(Number.isInteger(index) && index >= 0 && index < position.count,
      `${filename}: index ${item} (${index}) exceeds ${position.count} vertices`);
    maximumIndex = Math.max(maximumIndex, index);
  }
  invariant(maximumIndex === position.count - 1, `${filename}: POSITION contains unreferenced trailing vertices`);

  const positions = new Float64Array(position.count * 3);
  for (let item = 0; item < position.count; item++) {
    for (let axis = 0; axis < 3; axis++) positions[item * 3 + axis] = position.value(item, axis);
  }
  const triangleIndices = new Uint32Array(indices.count);
  for (let item = 0; item < indices.count; item++) triangleIndices[item] = indices.value(item);
  const selfIntersections = findSelfIntersections(positions, triangleIndices);
  invariant(selfIntersections.count === 0,
    `${filename}: repaired surface still has ${selfIntersections.count} self-intersections ` +
    `(${JSON.stringify(selfIntersections.pairs)})`);

  const triangleCount = indices.count / 3;
  invariant(triangleCount === EXPECTED_SOURCE_TRIANGLES,
    `${filename}: ${kind} has ${triangleCount} triangles, expected ${EXPECTED_SOURCE_TRIANGLES}`);
  invariant(position.count === EXPECTED_SOURCE_VERTICES,
    `${filename}: ${kind} has ${position.count} positions, expected ${EXPECTED_SOURCE_VERTICES}`);
  invariant(glb.json.nodes?.length === 26,
    `${filename}: neutral asset must contain one mesh node and 25 rig nodes`);
  invariant(glb.json.skins?.length === 1 && glb.json.skins[0]?.joints?.length === 25,
    `${filename}: neutral asset must retain its 25-joint skin`);
  const skin = glb.json.skins[0];
  const jointNames = skin.joints.map((nodeIndex) => glb.json.nodes?.[nodeIndex]?.name);
  invariant(JSON.stringify(jointNames) === JSON.stringify(EXPECTED_JOINT_NAMES),
    `${filename}: generated joint hierarchy changed (${jointNames.join(', ')})`);
  invariant(Number.isInteger(skin.inverseBindMatrices),
    `${filename}: skin has no inverse bind matrices`);
  const inverseBind = accessorReader(glb, skin.inverseBindMatrices, 'inverseBindMatrices');
  invariant(inverseBind.accessor.componentType === FLOAT &&
    inverseBind.accessor.type === 'MAT4' && inverseBind.count === 25,
  `${filename}: inverse bind matrices must be 25 FLOAT MAT4 values`);
  const meshNodes = glb.json.nodes.filter((node) => node.mesh === 0);
  invariant(meshNodes.length === 1 && meshNodes[0].skin === 0,
    `${filename}: exactly one mesh node must reference skin 0`);
  let maximumWeightError = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    let sum = 0;
    for (let influence = 0; influence < 4; influence++) {
      const ordinal = joints.value(vertex, influence);
      const weight = finite(weights.value(vertex, influence),
        `${filename}: WEIGHTS_0[${vertex}][${influence}]`);
      invariant(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < skin.joints.length,
        `${filename}: JOINTS_0[${vertex}][${influence}] is out of range`);
      invariant(weight >= 0 && weight <= 1,
        `${filename}: WEIGHTS_0[${vertex}][${influence}] is outside [0,1]`);
      sum += weight;
    }
    maximumWeightError = Math.max(maximumWeightError, Math.abs(1 - sum));
  }
  invariant(maximumWeightError < 2e-6,
    `${filename}: skin weights do not sum to one (max error ${maximumWeightError})`);
  const provenance = glb.json.asset?.extras?.toile;
  invariant(provenance?.sourceSha256 === EXPECTED_SOURCE_SHA256 && provenance?.rigVersion === 2,
    `${filename}: neutral source provenance or rig version changed`);
  invariant(provenance?.sourceTopologyPreserved === true &&
    provenance?.axillaryRepair?.movedVertices === 25 &&
    provenance?.axillaryRepair?.sourceSelfIntersections === 18 &&
    provenance?.axillaryRepair?.repairedSelfIntersections === 0,
  `${filename}: audited axillary repair metadata is missing`);
  invariant((glb.json.animations?.length ?? 0) === 0,
    `${filename}: unexpected animation data`);

  const nativeHeight = positionStats.max[1] - positionStats.min[1];
  invariant(Math.abs(nativeHeight - EXPECTED_SOURCE_HEIGHT_M) <= 0.000001,
    `${filename}: native height is ${nativeHeight} m, expected ${EXPECTED_SOURCE_HEIGHT_M} m`);
  const canonicalScale = EXPECTED_HEIGHT_M / nativeHeight;
  const nativeCentreX = (positionStats.min[0] + positionStats.max[0]) * 0.5;
  const nativeCentreZ = (positionStats.min[2] + positionStats.max[2]) * 0.5;
  const canonicalBounds = {
    min: [
      (positionStats.min[0] - nativeCentreX) * canonicalScale,
      0,
      (positionStats.min[2] - nativeCentreZ) * canonicalScale,
    ],
    max: [
      (positionStats.max[0] - nativeCentreX) * canonicalScale,
      EXPECTED_HEIGHT_M,
      (positionStats.max[2] - nativeCentreZ) * canonicalScale,
    ],
  };
  const canonicalWidth = canonicalBounds.max[0] - canonicalBounds.min[0];
  invariant(canonicalWidth > 0.50 && canonicalWidth < 0.51,
    `${filename}: canonical native-pose width is ${canonicalWidth} m`);
  const canonicalDepth = canonicalBounds.max[2] - canonicalBounds.min[2];
  invariant(canonicalDepth > 0.32 && canonicalDepth < 0.33,
    `${filename}: canonical native-pose depth is ${canonicalDepth} m`);

  invariant((glb.json.images?.length ?? 0) === 0, `${filename}: neutral asset must not contain images`);
  invariant((glb.json.textures?.length ?? 0) === 0, `${filename}: neutral asset must not contain textures`);
  invariant(glb.json.materials?.length === 1, `${filename}: expected exactly one material`);
  invariant(Number.isInteger(primitive.material), `${filename}: primitive has no material`);
  const material = glb.json.materials[primitive.material];
  const pbr = material?.pbrMetallicRoughness ?? {};
  invariant(pbr.baseColorTexture === undefined && pbr.metallicRoughnessTexture === undefined &&
    material.normalTexture === undefined && material.occlusionTexture === undefined &&
    material.emissiveTexture === undefined,
  `${filename}: neutral material must remain texture-free`);
  invariant(JSON.stringify(pbr.baseColorFactor ?? [1, 1, 1, 1]) === '[1,1,1,1]',
    `${filename}: neutral base colour changed`);
  invariant((pbr.metallicFactor ?? 1) === 0 && (pbr.roughnessFactor ?? 1) === 0.5,
    `${filename}: neutral metallic/roughness values changed`);
  invariant((material.doubleSided ?? false) === false,
    `${filename}: neutral material must remain single-sided`);

  return {
    path: filename,
    bytes: glb.bytes.byteLength,
    sha256: fileSha256,
    vertices: position.count,
    triangles: triangleCount,
    hasTangents: tangent !== null,
    skinJoints: skin.joints.length,
    nodeCount: glb.json.nodes.length,
    nativeBounds: { min: positionStats.min, max: positionStats.max },
    nativeDimensions: positionStats.max.map((value, axis) => value - positionStats.min[axis]),
    canonicalScale,
    bounds: canonicalBounds,
    dimensions: canonicalBounds.max.map((value, axis) => value - canonicalBounds.min[axis]),
    maximumWeightError,
    selfIntersections,
    activeStreams,
    material: {
      baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      doubleSided: material.doubleSided ?? false,
      textureCount: glb.json.textures?.length ?? 0,
      imageCount: glb.json.images?.length ?? 0,
    },
  };
}

function validateProxy(filename, expectedSha256) {
  const bytes = requiredFile(filename);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  invariant(sha256 === expectedSha256,
    `${filename}: collision proxy SHA-256 changed (${sha256})`);
  invariant(bytes.byteLength >= 8, `${filename}: truncated mesh header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertices = view.getUint32(0, true);
  const triangles = view.getUint32(4, true);
  invariant(vertices > 0, `${filename}: proxy has no vertices`);
  invariant(triangles === EXPECTED_PROXY_TRIANGLES,
    `${filename}: proxy has ${triangles} triangles, expected ${EXPECTED_PROXY_TRIANGLES}`);
  const positionsOffset = 8;
  const normalsOffset = positionsOffset + vertices * 12;
  const indicesOffset = normalsOffset + vertices * 12;
  const baseLength = indicesOffset + triangles * 12;
  const expectedLengths = [baseLength, baseLength + vertices * 3];
  invariant(expectedLengths.includes(bytes.byteLength),
    `${filename}: byte size ${bytes.byteLength} does not match its mesh header (${expectedLengths.join(' or ')})`);

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const positions = new Float64Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex++) {
    let normalLengthSquared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const position = finite(view.getFloat32(positionsOffset + (vertex * 3 + axis) * 4, true),
        `${filename}: POSITION[${vertex}][${axis}]`);
      positions[vertex * 3 + axis] = position;
      bounds.min[axis] = Math.min(bounds.min[axis], position);
      bounds.max[axis] = Math.max(bounds.max[axis], position);
      const normal = finite(view.getFloat32(normalsOffset + (vertex * 3 + axis) * 4, true),
        `${filename}: NORMAL[${vertex}][${axis}]`);
      normalLengthSquared += normal * normal;
    }
    const normalLength = Math.sqrt(normalLengthSquared);
    invariant(normalLength > 0.9 && normalLength < 1.1,
      `${filename}: NORMAL[${vertex}] is not unit length`);
  }
  let maximumIndex = 0;
  const indices = new Uint32Array(triangles * 3);
  for (let index = 0; index < triangles * 3; index++) {
    const value = view.getUint32(indicesOffset + index * 4, true);
    invariant(value < vertices, `${filename}: index ${index} (${value}) exceeds ${vertices} vertices`);
    maximumIndex = Math.max(maximumIndex, value);
    indices[index] = value;
  }
  invariant(maximumIndex === vertices - 1, `${filename}: proxy contains unreferenced trailing vertices`);
  const edges = new Map();
  let degenerateTriangles = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]];
    const first = triangle[0] * 3;
    const second = triangle[1] * 3;
    const third = triangle[2] * 3;
    const areaVector = cross(
      [
        positions[second] - positions[first],
        positions[second + 1] - positions[first + 1],
        positions[second + 2] - positions[first + 2],
      ],
      [
        positions[third] - positions[first],
        positions[third + 1] - positions[first + 1],
        positions[third + 2] - positions[first + 2],
      ],
    );
    if (Math.hypot(...areaVector) <= 1e-12) degenerateTriangles++;
    for (const [from, to] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const key = `${low},${high}`;
      const edge = edges.get(key) ?? { count: 0, orientation: 0 };
      edge.count++;
      edge.orientation += from === low ? 1 : -1;
      edges.set(key, edge);
    }
  }
  const invalidEdges = [...edges.entries()].filter(([, edge]) =>
    edge.count !== 2 || edge.orientation !== 0);
  invariant(degenerateTriangles === 0,
    `${filename}: proxy contains ${degenerateTriangles} degenerate triangles`);
  invariant(invalidEdges.length === 0,
    `${filename}: proxy is not a closed consistently-oriented two-manifold ` +
    `(${JSON.stringify(invalidEdges.slice(0, 10))})`);
  const selfIntersections = findSelfIntersections(positions, indices);
  invariant(selfIntersections.count === 0,
    `${filename}: proxy has ${selfIntersections.count} self-intersections ` +
    `(${JSON.stringify(selfIntersections.pairs)})`);
  return {
    path: filename,
    bytes: bytes.byteLength,
    sha256,
    vertices,
    triangles,
    hasVertexColors: bytes.byteLength !== baseLength,
    bounds,
    dimensions: bounds.max.map((value, axis) => value - bounds.min[axis]),
    manifoldEdges: edges.size,
    selfIntersections,
    _bytes: bytes,
    _view: view,
    _positionsOffset: positionsOffset,
  };
}

function validateSdf(filename, expectedSha256) {
  const bytes = requiredFile(filename);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  invariant(sha256 === expectedSha256,
    `${filename}: collision SDF SHA-256 changed (${sha256})`);
  invariant(bytes.byteLength >= 36, `${filename}: truncated SDF header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = [0, 4, 8].map((offset) => view.getUint32(offset, true));
  const min = [12, 16, 20].map((offset) => finite(view.getFloat32(offset, true), `${filename}: min`));
  const max = [24, 28, 32].map((offset) => finite(view.getFloat32(offset, true), `${filename}: max`));
  for (let axis = 0; axis < 3; axis++) {
    invariant(dims[axis] >= 8 && dims[axis] <= 256, `${filename}: invalid SDF dimension ${dims[axis]}`);
    invariant(max[axis] > min[axis], `${filename}: invalid SDF bounds on axis ${axis}`);
    const expected = Math.max(8, Math.min(256, Math.ceil((max[axis] - min[axis]) / 0.007) + 1));
    invariant(dims[axis] === expected,
      `${filename}: dimension ${dims[axis]} on axis ${axis} does not match the 7 mm bake (${expected})`);
  }
  const cells = dims[0] * dims[1] * dims[2];
  invariant(bytes.byteLength === 36 + cells * 2,
    `${filename}: byte size ${bytes.byteLength} does not match ${dims.join('x')} int16 grid`);
  let minimumMm = Infinity;
  let maximumMm = -Infinity;
  for (let cell = 0; cell < cells; cell++) {
    const value = view.getInt16(36 + cell * 2, true);
    minimumMm = Math.min(minimumMm, value);
    maximumMm = Math.max(maximumMm, value);
  }
  invariant(minimumMm < -20, `${filename}: SDF has no meaningful interior (${minimumMm} mm)`);
  invariant(maximumMm > 40, `${filename}: SDF has no meaningful exterior (${maximumMm} mm)`);
  const centre = dims.map((count) => Math.round((count - 1) / 2));
  const centreIndex = (centre[2] * dims[1] + centre[1]) * dims[0] + centre[0];
  const centreMm = view.getInt16(36 + centreIndex * 2, true);
  invariant(centreMm < -10,
    `${filename}: centre of the torso is not inside the body (${centreMm} mm)`);
  return { path: filename, bytes: bytes.byteLength, sha256, dims, min, max, minimumMm, maximumMm, centreMm, _view: view };
}

function maxBoundsDelta(a, b) {
  let delta = 0;
  for (let axis = 0; axis < 3; axis++) {
    delta = Math.max(delta, Math.abs(a.min[axis] - b.min[axis]), Math.abs(a.max[axis] - b.max[axis]));
  }
  return delta;
}

function validateAlignedBounds(label, a, b, tolerance = BOUNDS_TOLERANCE_M) {
  const delta = maxBoundsDelta(a, b);
  invariant(delta <= tolerance,
    `${label}: bounds differ by ${(delta * 1000).toFixed(2)} mm (limit ${(tolerance * 1000).toFixed(1)} mm)`);
  return delta;
}

function validateSdfSurface(sdf, proxy) {
  const cell = sdf.dims.map((count, axis) => (sdf.max[axis] - sdf.min[axis]) / (count - 1));
  const at = (x, y, z) => sdf._view.getInt16(36 + ((z * sdf.dims[1] + y) * sdf.dims[0] + x) * 2, true) / 1000;
  const signedDistances = new Array(proxy.vertices);
  for (let vertex = 0; vertex < proxy.vertices; vertex++) {
    const position = [0, 1, 2].map((axis) =>
      proxy._view.getFloat32(proxy._positionsOffset + (vertex * 3 + axis) * 4, true));
    const grid = position.map((value, axis) => (value - sdf.min[axis]) / cell[axis]);
    const base = grid.map((value, axis) => Math.max(0, Math.min(sdf.dims[axis] - 2, Math.floor(value))));
    const fraction = grid.map((value, axis) => Math.max(0, Math.min(1, value - base[axis])));
    const [x, y, z] = base;
    const [fx, fy, fz] = fraction;
    const mix = (a, b, t) => a + (b - a) * t;
    const x00 = mix(at(x, y, z), at(x + 1, y, z), fx);
    const x10 = mix(at(x, y + 1, z), at(x + 1, y + 1, z), fx);
    const x01 = mix(at(x, y, z + 1), at(x + 1, y, z + 1), fx);
    const x11 = mix(at(x, y + 1, z + 1), at(x + 1, y + 1, z + 1), fx);
    signedDistances[vertex] = mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
  }
  const outsideDistances = signedDistances.map((distance) => Math.max(0, distance));
  outsideDistances.sort((a, b) => a - b);
  const percentile = (values, fraction) => values[Math.floor((values.length - 1) * fraction)];
  const maximumOutside = outsideDistances[outsideDistances.length - 1];
  invariant(maximumOutside <= 0.0025,
    `proxy/SDF maximum outside distance is ${(maximumOutside * 1000).toFixed(2)} mm (limit 2.5 mm)`);
  const minimumSigned = Math.min(...signedDistances);
  // The source contains microscopic capped fissures. Their fan centres can
  // interpolate slightly over one 7 mm cell inside the conservative field,
  // while positive (unsafe) drift remains independently limited to 2.5 mm.
  invariant(minimumSigned >= -0.011,
    `proxy/SDF conservative inset is ${(minimumSigned * 1000).toFixed(2)} mm (limit -11 mm)`);
  return {
    outsideP50Mm: percentile(outsideDistances, 0.5) * 1000,
    outsideP95Mm: percentile(outsideDistances, 0.95) * 1000,
    outsideP99Mm: percentile(outsideDistances, 0.99) * 1000,
    maximumOutsideMm: maximumOutside * 1000,
    maximumInsetMm: -minimumSigned * 1000,
  };
}

function validateSourceRepair(sourceFilename, visualFilename) {
  const sourceBytes = requiredFile(sourceFilename);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  invariant(sourceSha256 === EXPECTED_SOURCE_SHA256,
    `${sourceFilename}: neutral source SHA-256 changed (${sourceSha256})`);
  const source = parseGlb(sourceFilename);
  const visual = parseGlb(visualFilename);
  const primitiveFor = (glb, label) => {
    invariant(glb.json.meshes?.length === 1 && glb.json.meshes[0]?.primitives?.length === 1,
      `${label}: expected one mesh primitive`);
    return glb.json.meshes[0].primitives[0];
  };
  const sourcePrimitive = primitiveFor(source, sourceFilename);
  const visualPrimitive = primitiveFor(visual, visualFilename);
  const sourcePosition = accessorReader(source, sourcePrimitive.attributes.POSITION, 'source POSITION');
  const repairedPosition = accessorReader(visual, visualPrimitive.attributes.POSITION, 'repaired POSITION');
  const sourceIndex = accessorReader(source, sourcePrimitive.indices, 'source indices');
  const repairedIndex = accessorReader(visual, visualPrimitive.indices, 'repaired indices');
  invariant(sourcePosition.count === EXPECTED_SOURCE_VERTICES &&
    repairedPosition.count === sourcePosition.count &&
    sourceIndex.count === EXPECTED_SOURCE_TRIANGLES * 3 &&
    repairedIndex.count === sourceIndex.count,
  'neutral repair changed vertex or index counts');
  invariant(accessorSha256(source, sourceIndex) === EXPECTED_ACTIVE_STREAMS.indices &&
    accessorSha256(visual, repairedIndex) === EXPECTED_ACTIVE_STREAMS.indices,
  'neutral repair changed source triangle indices');
  const sourcePositions = new Float64Array(sourcePosition.count * 3);
  const repairedPositions = new Float64Array(repairedPosition.count * 3);
  const indices = new Uint32Array(sourceIndex.count);
  for (let vertex = 0; vertex < sourcePosition.count; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      sourcePositions[vertex * 3 + axis] = sourcePosition.value(vertex, axis);
      repairedPositions[vertex * 3 + axis] = repairedPosition.value(vertex, axis);
    }
  }
  for (let item = 0; item < sourceIndex.count; item++) {
    const sourceValue = sourceIndex.value(item);
    invariant(repairedIndex.value(item) === sourceValue,
      `neutral repair changed index ${item}`);
    indices[item] = sourceValue;
  }
  const sourceIntersections = findSelfIntersections(sourcePositions, indices);
  const repairedIntersections = findSelfIntersections(repairedPositions, indices);
  invariant(sourceIntersections.count === 18,
    `${sourceFilename}: expected 18 audited self-intersections, got ${sourceIntersections.count}`);
  invariant(repairedIntersections.count === 0,
    `${visualFilename}: axillary repair left ${repairedIntersections.count} self-intersections`);
  const sourceStats = scanVectors(sourcePosition, 3, `${sourceFilename}: POSITION`);
  const scale = EXPECTED_HEIGHT_M / (sourceStats.max[1] - sourceStats.min[1]);
  let movedVertices = 0;
  let maximumDisplacement = 0;
  let squaredDisplacement = 0;
  for (let vertex = 0; vertex < sourcePosition.count; vertex++) {
    const offset = vertex * 3;
    const displacement = Math.hypot(
      repairedPositions[offset] - sourcePositions[offset],
      repairedPositions[offset + 1] - sourcePositions[offset + 1],
      repairedPositions[offset + 2] - sourcePositions[offset + 2],
    );
    if (displacement > 1e-10) movedVertices++;
    maximumDisplacement = Math.max(maximumDisplacement, displacement);
    squaredDisplacement += displacement * displacement;
  }
  const maximumDisplacementMm = maximumDisplacement * scale * 1000;
  const rmsDisplacementMm = Math.sqrt(squaredDisplacement / sourcePosition.count) * scale * 1000;
  invariant(movedVertices === 25,
    `neutral repair moved ${movedVertices} vertices instead of 25`);
  invariant(maximumDisplacementMm >= 10.10 && maximumDisplacementMm <= 10.11,
    `neutral repair maximum displacement is ${maximumDisplacementMm} mm`);
  invariant(rmsDisplacementMm >= 1.08 && rmsDisplacementMm <= 1.09,
    `neutral repair RMS displacement is ${rmsDisplacementMm} mm`);
  let invertedTriangles = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const faceNormal = (positions) => {
      const a = indices[offset] * 3;
      const b = indices[offset + 1] * 3;
      const c = indices[offset + 2] * 3;
      return cross(
        [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]],
        [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]],
      );
    };
    if (dot(faceNormal(sourcePositions), faceNormal(repairedPositions)) <= 0) invertedTriangles++;
  }
  invariant(invertedTriangles === 0,
    `neutral repair inverted ${invertedTriangles} triangles`);
  return {
    path: sourceFilename,
    bytes: sourceBytes.byteLength,
    sha256: sourceSha256,
    vertices: sourcePosition.count,
    triangles: sourceIndex.count / 3,
    sourceIntersections,
    repairedIntersections,
    movedVertices,
    maximumDisplacementMm,
    rmsDisplacementMm,
    invertedTriangles,
  };
}

export function validateJerichoAssets(options = parseArguments([])) {
  const repair = validateSourceRepair(options.source, options.visual);
  const visual = validateVisualGlb(options.visual, 'runtime');
  const exportAsset = validateVisualGlb(options.export, 'export');
  const proxy = validateProxy(options.mesh, EXPECTED_COLLISION_SHA256.native.mesh);
  const sdf = validateSdf(options.sdf, EXPECTED_COLLISION_SHA256.native.sdf);
  const aposeProxy = validateProxy(options.aposeMesh, EXPECTED_COLLISION_SHA256.apose.mesh);
  const aposeSdf = validateSdf(options.aposeSdf, EXPECTED_COLLISION_SHA256.apose.sdf);
  const sewingProxy = validateProxy(options.sewingMesh, EXPECTED_COLLISION_SHA256.sewing.mesh);
  const sewingSdf = validateSdf(options.sewingSdf, EXPECTED_COLLISION_SHA256.sewing.sdf);

  const runtimeToExportM = validateAlignedBounds('runtime/export', visual.bounds, exportAsset.bounds, 0.001);
  const proxyToExportM = validateAlignedBounds('proxy/export', proxy.bounds, exportAsset.bounds);
  const sdfSurfaceBounds = {
    min: sdf.min.map((value) => value + 0.06),
    max: sdf.max.map((value) => value - 0.06),
  };
  const sdfToExportM = validateAlignedBounds('SDF source/export', sdfSurfaceBounds, exportAsset.bounds);
  const sdfSurfaceError = validateSdfSurface(sdf, proxy);

  const poseReport = (label, poseProxy, poseSdf, widthRange) => {
    const surfaceBounds = {
      min: poseSdf.min.map((value) => value + 0.06),
      max: poseSdf.max.map((value) => value - 0.06),
    };
    const sdfToProxyM = validateAlignedBounds(`${label} SDF/proxy`, surfaceBounds, poseProxy.bounds);
    invariant(Math.abs(poseProxy.dimensions[1] - EXPECTED_HEIGHT_M) <= 0.0001,
      `${label}: posed collision height is ${poseProxy.dimensions[1]} m`);
    invariant(poseProxy.dimensions[0] >= widthRange[0] && poseProxy.dimensions[0] <= widthRange[1],
      `${label}: posed collision width is ${poseProxy.dimensions[0]} m`);
    return {
      proxy: poseProxy,
      sdf: poseSdf,
      alignment: {
        sdfToProxyMm: sdfToProxyM * 1000,
        sdfSurfaceError: validateSdfSurface(poseSdf, poseProxy),
      },
    };
  };
  const poses = {
    apose: poseReport('A-pose', aposeProxy, aposeSdf, [1.22, 1.24]),
    sewing: poseReport('sewing pose', sewingProxy, sewingSdf, [1.61, 1.63]),
  };

  const cleanProxy = (value) => {
    const clean = { ...value };
    delete clean._bytes;
    delete clean._view;
    delete clean._positionsOffset;
    return clean;
  };
  const cleanSdf = (value) => {
    const clean = { ...value };
    delete clean._view;
    return clean;
  };
  return {
    ok: true,
    repair,
    visual,
    export: exportAsset,
    proxy: cleanProxy(proxy),
    sdf: cleanSdf(sdf),
    poses: {
      apose: {
        proxy: cleanProxy(poses.apose.proxy),
        sdf: cleanSdf(poses.apose.sdf),
        alignment: poses.apose.alignment,
      },
      sewing: {
        proxy: cleanProxy(poses.sewing.proxy),
        sdf: cleanSdf(poses.sewing.sdf),
        alignment: poses.sewing.alignment,
      },
    },
    alignment: {
      runtimeToExportMm: runtimeToExportM * 1000,
      proxyToExportMm: proxyToExportM * 1000,
      sdfSourceToExportMm: sdfToExportM * 1000,
      sdfSurfaceError,
    },
  };
}

const invokedAsScript = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = validateJerichoAssets(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Neutral avatar assets OK: ${report.visual.triangles.toLocaleString('en-US')} runtime tris, ` +
        `${report.export.triangles.toLocaleString('en-US')} export tris, ` +
        `${report.proxy.triangles.toLocaleString('en-US')} proxy tris; ` +
        `max proxy drift ${report.alignment.proxyToExportMm.toFixed(2)} mm.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Neutral avatar asset validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
