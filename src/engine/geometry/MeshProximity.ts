/**
 * Exact, CPU-side proximity queries against the mesh which is actually drawn.
 *
 * This module deliberately does not use the solver SDF: it is intended for
 * development/QA measurements where distances must not be truncated to a
 * collision band.  Construction is moderately expensive (a triangle BVH and
 * pseudo normals are built), but queries are allocation-light and logarithmic
 * for ordinary meshes.
 */

export type Vec3Like = readonly [number, number, number] | ArrayLike<number>;
export type Vec3 = [number, number, number];

export interface TriangleMeshSource {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Optional display normals. They are interpolated in query results. */
  normals?: ArrayLike<number>;
  positionStride?: number;
  positionOffset?: number;
  normalStride?: number;
  normalOffset?: number;
}

export interface MeshProximityOptions {
  /** Number of triangles per BVH leaf. */
  leafSize?: number;
  /** Distances at or below this value are reported as exactly zero. */
  surfaceEpsilon?: number;
}

export interface TriangleClosestPoint {
  point: Vec3;
  /** Barycentric weights corresponding to a, b and c. */
  barycentric: Vec3;
  distanceSquared: number;
}

export interface MeshClosestPoint extends TriangleClosestPoint {
  distance: number;
  /** Negative inside a closed mesh, positive outside, never band-clamped. */
  signedDistance: number;
  inside: boolean;
  normal: Vec3;
  triangleIndex: number;
}

interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface BvhNode extends Bounds {
  start: number;
  count: number;
  left: BvhNode | null;
  right: BvhNode | null;
}

interface EdgeNormal {
  x: number;
  y: number;
  z: number;
  count: number;
}

const DEFAULT_EPSILON = 1e-9;
const FEATURE_EPSILON = 1e-7;

function component(v: Vec3Like, index: number): number {
  const value = v[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new RangeError('A 3D point must contain three finite coordinates.');
  }
  return value;
}

function dot(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return ax * bx + ay * by + az * bz;
}

function normalize(x: number, y: number, z: number): Vec3 {
  const length = Math.hypot(x, y, z);
  return length > 1e-20 ? [x / length, y / length, z / length] : [0, 1, 0];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Exact closest point in the complete triangle (faces, edges and vertices). */
export function closestPointOnTriangle(
  point: Vec3Like,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
): TriangleClosestPoint {
  const px = component(point, 0);
  const py = component(point, 1);
  const pz = component(point, 2);
  const ax = component(a, 0);
  const ay = component(a, 1);
  const az = component(a, 2);
  const bx = component(b, 0);
  const by = component(b, 1);
  const bz = component(b, 2);
  const cx = component(c, 0);
  const cy = component(c, 1);
  const cz = component(c, 2);

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = dot(abx, aby, abz, apx, apy, apz);
  const d2 = dot(acx, acy, acz, apx, apy, apz);

  let u: number;
  let v: number;
  let w: number;
  if (d1 <= 0 && d2 <= 0) {
    u = 1;
    v = 0;
    w = 0;
  } else {
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = dot(abx, aby, abz, bpx, bpy, bpz);
    const d4 = dot(acx, acy, acz, bpx, bpy, bpz);
    if (d3 >= 0 && d4 <= d3) {
      u = 0;
      v = 1;
      w = 0;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        u = 1 - t;
        v = t;
        w = 0;
      } else {
        const cpx = px - cx;
        const cpy = py - cy;
        const cpz = pz - cz;
        const d5 = dot(abx, aby, abz, cpx, cpy, cpz);
        const d6 = dot(acx, acy, acz, cpx, cpy, cpz);
        if (d6 >= 0 && d5 <= d6) {
          u = 0;
          v = 0;
          w = 1;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            u = 1 - t;
            v = 0;
            w = t;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / (d4 - d3 + d5 - d6);
              u = 0;
              v = 1 - t;
              w = t;
            } else {
              const denominator = va + vb + vc;
              // Degenerate triangles fall back to their three segments.
              if (Math.abs(denominator) <= 1e-30) {
                return closestPointOnDegenerateTriangle(
                  px,
                  py,
                  pz,
                  [ax, ay, az],
                  [bx, by, bz],
                  [cx, cy, cz],
                );
              }
              const inverse = 1 / denominator;
              v = vb * inverse;
              w = vc * inverse;
              u = 1 - v - w;
            }
          }
        }
      }
    }
  }

  const qx = u * ax + v * bx + w * cx;
  const qy = u * ay + v * by + w * cy;
  const qz = u * az + v * bz + w * cz;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return {
    point: [qx, qy, qz],
    barycentric: [u, v, w],
    distanceSquared: dx * dx + dy * dy + dz * dz,
  };
}

function closestPointOnDegenerateTriangle(
  px: number,
  py: number,
  pz: number,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): TriangleClosestPoint {
  const candidates = [
    closestPointOnSegment(px, py, pz, a, b, [0, 1, 0]),
    closestPointOnSegment(px, py, pz, b, c, [0, 0, 1]),
    closestPointOnSegment(px, py, pz, c, a, [1, 0, 0]),
  ];
  candidates.sort((lhs, rhs) => lhs.distanceSquared - rhs.distanceSquared);
  return candidates[0]!;
}

function closestPointOnSegment(
  px: number,
  py: number,
  pz: number,
  a: Vec3,
  b: Vec3,
  barycentricAtB: Vec3,
): TriangleClosestPoint {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const denominator = dx * dx + dy * dy + dz * dz;
  const t = denominator > 1e-30
    ? Math.max(0, Math.min(1, dot(px - a[0], py - a[1], pz - a[2], dx, dy, dz) / denominator))
    : 0;
  const qx = a[0] + dx * t;
  const qy = a[1] + dy * t;
  const qz = a[2] + dz * t;
  const barycentric: Vec3 = barycentricAtB[0] === 0 && barycentricAtB[2] === 0
    ? [1 - t, t, 0]
    : barycentricAtB[1] === 0 && barycentricAtB[0] === 0
      ? [0, 1 - t, t]
      : [t, 0, 1 - t];
  return {
    point: [qx, qy, qz],
    barycentric,
    distanceSquared: (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2,
  };
}

function orientation2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangle2d(
  px: number,
  py: number,
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  epsilon: number,
): boolean {
  const o1 = orientation2d(a[0], a[1], b[0], b[1], px, py);
  const o2 = orientation2d(b[0], b[1], c[0], c[1], px, py);
  const o3 = orientation2d(c[0], c[1], a[0], a[1], px, py);
  return (o1 >= -epsilon && o2 >= -epsilon && o3 >= -epsilon)
    || (o1 <= epsilon && o2 <= epsilon && o3 <= epsilon);
}

function segmentsIntersect2d(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
  epsilon: number,
): boolean {
  const o1 = orientation2d(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orientation2d(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orientation2d(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orientation2d(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
    && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) {
    return true;
  }
  const onSegment = (
    p: readonly [number, number],
    q: readonly [number, number],
    r: readonly [number, number],
    orientation: number,
  ): boolean => Math.abs(orientation) <= epsilon
    && q[0] >= Math.min(p[0], r[0]) - epsilon
    && q[0] <= Math.max(p[0], r[0]) + epsilon
    && q[1] >= Math.min(p[1], r[1]) - epsilon
    && q[1] <= Math.max(p[1], r[1]) + epsilon;
  return onSegment(a, c, b, o1)
    || onSegment(a, d, b, o2)
    || onSegment(c, a, d, o3)
    || onSegment(c, b, d, o4);
}

function segmentIntersectsTriangle(
  start: Vec3,
  end: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  epsilon: number,
): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const determinant = dot(e1x, e1y, e1z, hx, hy, hz);
  if (Math.abs(determinant) <= epsilon) return false;
  const inverse = 1 / determinant;
  const sx = start[0] - a[0];
  const sy = start[1] - a[1];
  const sz = start[2] - a[2];
  const u = inverse * dot(sx, sy, sz, hx, hy, hz);
  if (u < -epsilon || u > 1 + epsilon) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = inverse * dot(dx, dy, dz, qx, qy, qz);
  if (v < -epsilon || u + v > 1 + epsilon) return false;
  const t = inverse * dot(e2x, e2y, e2z, qx, qy, qz);
  return t >= -epsilon && t <= 1 + epsilon;
}

/** Inclusive triangle/triangle intersection, including coplanar overlap. */
export function trianglesIntersect(
  a0: Vec3Like,
  a1: Vec3Like,
  a2: Vec3Like,
  b0: Vec3Like,
  b1: Vec3Like,
  b2: Vec3Like,
  epsilon = DEFAULT_EPSILON,
): boolean {
  const a: [Vec3, Vec3, Vec3] = [
    [component(a0, 0), component(a0, 1), component(a0, 2)],
    [component(a1, 0), component(a1, 1), component(a1, 2)],
    [component(a2, 0), component(a2, 1), component(a2, 2)],
  ];
  const b: [Vec3, Vec3, Vec3] = [
    [component(b0, 0), component(b0, 1), component(b0, 2)],
    [component(b1, 0), component(b1, 1), component(b1, 2)],
    [component(b2, 0), component(b2, 1), component(b2, 2)],
  ];
  for (let axis = 0; axis < 3; axis++) {
    const aMin = Math.min(a[0][axis]!, a[1][axis]!, a[2][axis]!);
    const aMax = Math.max(a[0][axis]!, a[1][axis]!, a[2][axis]!);
    const bMin = Math.min(b[0][axis]!, b[1][axis]!, b[2][axis]!);
    const bMax = Math.max(b[0][axis]!, b[1][axis]!, b[2][axis]!);
    if (aMax < bMin - epsilon || bMax < aMin - epsilon) return false;
  }

  const anx = (a[1][1] - a[0][1]) * (a[2][2] - a[0][2])
    - (a[1][2] - a[0][2]) * (a[2][1] - a[0][1]);
  const any = (a[1][2] - a[0][2]) * (a[2][0] - a[0][0])
    - (a[1][0] - a[0][0]) * (a[2][2] - a[0][2]);
  const anz = (a[1][0] - a[0][0]) * (a[2][1] - a[0][1])
    - (a[1][1] - a[0][1]) * (a[2][0] - a[0][0]);
  const bnx = (b[1][1] - b[0][1]) * (b[2][2] - b[0][2])
    - (b[1][2] - b[0][2]) * (b[2][1] - b[0][1]);
  const bny = (b[1][2] - b[0][2]) * (b[2][0] - b[0][0])
    - (b[1][0] - b[0][0]) * (b[2][2] - b[0][2]);
  const bnz = (b[1][0] - b[0][0]) * (b[2][1] - b[0][1])
    - (b[1][1] - b[0][1]) * (b[2][0] - b[0][0]);
  const anLength = Math.hypot(anx, any, anz);
  const bnLength = Math.hypot(bnx, bny, bnz);
  if (anLength <= epsilon || bnLength <= epsilon) return false;

  const planeDistance = (point: Vec3, origin: Vec3, nx: number, ny: number, nz: number): number =>
    dot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2], nx, ny, nz);
  const distanceAtoB = a.map((point) => planeDistance(point, b[0], bnx, bny, bnz) / bnLength);
  const distanceBtoA = b.map((point) => planeDistance(point, a[0], anx, any, anz) / anLength);
  const allPositive = (values: number[]): boolean => values.every((value) => value > epsilon);
  const allNegative = (values: number[]): boolean => values.every((value) => value < -epsilon);
  if (allPositive(distanceAtoB) || allNegative(distanceAtoB)
    || allPositive(distanceBtoA) || allNegative(distanceBtoA)) return false;

  const coplanar = distanceAtoB.every((value) => Math.abs(value) <= epsilon)
    && distanceBtoA.every((value) => Math.abs(value) <= epsilon);
  if (!coplanar) {
    for (let edge = 0; edge < 3; edge++) {
      if (segmentIntersectsTriangle(a[edge]!, a[(edge + 1) % 3]!, b[0], b[1], b[2], epsilon)) return true;
      if (segmentIntersectsTriangle(b[edge]!, b[(edge + 1) % 3]!, a[0], a[1], a[2], epsilon)) return true;
    }
    return false;
  }

  const absNormal = [Math.abs(anx), Math.abs(any), Math.abs(anz)];
  const droppedAxis = absNormal[0]! >= absNormal[1]! && absNormal[0]! >= absNormal[2]!
    ? 0
    : absNormal[1]! >= absNormal[2]! ? 1 : 2;
  const project = (point: Vec3): [number, number] => droppedAxis === 0
    ? [point[1], point[2]]
    : droppedAxis === 1 ? [point[0], point[2]] : [point[0], point[1]];
  const a2d = a.map(project) as [[number, number], [number, number], [number, number]];
  const b2d = b.map(project) as [[number, number], [number, number], [number, number]];
  for (let ae = 0; ae < 3; ae++) {
    for (let be = 0; be < 3; be++) {
      if (segmentsIntersect2d(a2d[ae]!, a2d[(ae + 1) % 3]!, b2d[be]!, b2d[(be + 1) % 3]!, epsilon)) return true;
    }
  }
  return pointInTriangle2d(a2d[0][0], a2d[0][1], b2d[0], b2d[1], b2d[2], epsilon)
    || pointInTriangle2d(b2d[0][0], b2d[0][1], a2d[0], a2d[1], a2d[2], epsilon);
}

/** Inverse of a right-handed rotation around the Y axis and an optional pivot. */
export function inverseRotateY(
  point: Vec3Like,
  radians: number,
  pivot: Vec3Like = [0, 0, 0],
): Vec3 {
  const x = component(point, 0) - component(pivot, 0);
  const y = component(point, 1) - component(pivot, 1);
  const z = component(point, 2) - component(pivot, 2);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    cosine * x - sine * z + component(pivot, 0),
    y + component(pivot, 1),
    sine * x + cosine * z + component(pivot, 2),
  ];
}

/** Development/QA BVH for exact visible-mesh measurements. */
export class MeshProximity {
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly closed: boolean;

  private readonly positions: Float64Array;
  private readonly indices: Uint32Array;
  private readonly displayNormals: Float64Array | null;
  private readonly faceNormals: Float64Array;
  private readonly vertexPseudoNormals: Float64Array;
  private readonly edgePseudoNormals = new Map<string, EdgeNormal>();
  private readonly triangleOrder: number[];
  private readonly root: BvhNode;
  private readonly leafSize: number;
  private readonly surfaceEpsilon: number;

  constructor(source: TriangleMeshSource, options: MeshProximityOptions = {}) {
    const positionStride = source.positionStride ?? 3;
    const positionOffset = source.positionOffset ?? 0;
    if (!Number.isInteger(positionStride) || positionStride < 3 || positionOffset < 0) {
      throw new RangeError('Invalid position stride or offset.');
    }
    this.vertexCount = recordCount(source.positions.length, positionOffset, positionStride);
    if (this.vertexCount < 3 || source.indices.length < 3 || source.indices.length % 3 !== 0) {
      throw new RangeError('A triangle mesh needs vertices and complete triangle indices.');
    }
    this.positions = new Float64Array(this.vertexCount * 3);
    for (let vertex = 0; vertex < this.vertexCount; vertex++) {
      const sourceOffset = positionOffset + vertex * positionStride;
      for (let axis = 0; axis < 3; axis++) {
        const value = source.positions[sourceOffset + axis];
        if (value === undefined || !Number.isFinite(value)) throw new RangeError('Mesh positions must be finite.');
        this.positions[vertex * 3 + axis] = value;
      }
    }

    this.triangleCount = source.indices.length / 3;
    this.indices = new Uint32Array(source.indices.length);
    for (let offset = 0; offset < source.indices.length; offset++) {
      const index = source.indices[offset];
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= this.vertexCount) {
        throw new RangeError(`Triangle index ${String(index)} is outside the vertex buffer.`);
      }
      this.indices[offset] = index;
    }

    this.displayNormals = source.normals
      ? this.copyNormals(source.normals, source.normalStride ?? 3, source.normalOffset ?? 0)
      : null;
    this.faceNormals = new Float64Array(this.triangleCount * 3);
    this.vertexPseudoNormals = new Float64Array(this.vertexCount * 3);
    this.buildPseudoNormals();
    this.closed = [...this.edgePseudoNormals.values()].every((edge) => edge.count === 2);
    this.leafSize = Math.max(2, Math.floor(options.leafSize ?? 8));
    this.surfaceEpsilon = Math.max(0, options.surfaceEpsilon ?? 1e-8);
    this.triangleOrder = Array.from({ length: this.triangleCount }, (_, index) => index);
    this.root = this.buildNode(0, this.triangleCount);
  }

  /** Exact, untruncated closest point and signed distance. */
  closestPoint(point: Vec3Like): MeshClosestPoint {
    const px = component(point, 0);
    const py = component(point, 1);
    const pz = component(point, 2);
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestTriangle = -1;
    let best: TriangleClosestPoint | null = null;
    const stack: BvhNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (distanceSquaredToBounds(px, py, pz, node) > bestDistanceSquared) continue;
      if (node.left === null || node.right === null) {
        for (let local = node.start; local < node.start + node.count; local++) {
          const triangle = this.triangleOrder[local]!;
          const [a, b, c] = this.triangleVertices(triangle);
          const candidate = closestPointOnTriangle([px, py, pz], a, b, c);
          if (candidate.distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = candidate.distanceSquared;
            bestTriangle = triangle;
            best = candidate;
          }
        }
      } else {
        const leftDistance = distanceSquaredToBounds(px, py, pz, node.left);
        const rightDistance = distanceSquaredToBounds(px, py, pz, node.right);
        // Stack is LIFO: push farther child first.
        if (leftDistance < rightDistance) {
          if (rightDistance <= bestDistanceSquared) stack.push(node.right);
          if (leftDistance <= bestDistanceSquared) stack.push(node.left);
        } else {
          if (leftDistance <= bestDistanceSquared) stack.push(node.left);
          if (rightDistance <= bestDistanceSquared) stack.push(node.right);
        }
      }
    }
    if (!best || bestTriangle < 0) throw new Error('The proximity BVH contains no queryable triangle.');

    const distance = Math.sqrt(Math.max(0, bestDistanceSquared));
    const pseudoNormal = this.pseudoNormalAt(bestTriangle, best.barycentric);
    const normal = this.displayNormalAt(bestTriangle, best.barycentric) ?? pseudoNormal;
    if (distance <= this.surfaceEpsilon) {
      return { ...best, distance: 0, signedDistance: 0, inside: false, normal, triangleIndex: bestTriangle };
    }
    const pseudoProjection = dot(
      px - best.point[0],
      py - best.point[1],
      pz - best.point[2],
      pseudoNormal[0],
      pseudoNormal[1],
      pseudoNormal[2],
    );
    // Angle-weighted pseudo normals give an excellent local sign on a clean,
    // consistently-oriented manifold.  They are not a reliable containment
    // test for a distant/medial-axis sample, however, and one locally reversed
    // patch can make an exterior point look deeply embedded.  Verify every
    // pseudo-negative (and numerically ambiguous) closed-mesh candidate with
    // winding-independent ray parity.  Ordinary exterior samples keep the
    // cheap pseudo-positive fast path, which matters for whole-cloth audits.
    const ambiguousSign = Math.abs(pseudoProjection) <= Math.max(1e-12, distance * 1e-7);
    const pseudoInside = pseudoProjection < 0;
    const needsContainmentVerification = this.closed && (pseudoInside || ambiguousSign);
    const inside = needsContainmentVerification
      ? this.insideByRayParity(px, py, pz)
      : pseudoInside;
    return {
      ...best,
      distance,
      signedDistance: inside ? -distance : distance,
      inside,
      normal,
      triangleIndex: bestTriangle,
    };
  }

  signedDistance(point: Vec3Like): number {
    return this.closestPoint(point).signedDistance;
  }

  /** True when the supplied triangle crosses or touches any mesh triangle. */
  intersectsTriangle(a: Vec3Like, b: Vec3Like, c: Vec3Like, epsilon = DEFAULT_EPSILON): boolean {
    return this.intersectingTriangles(a, b, c, 1, epsilon).length > 0;
  }

  /** Triangle ordinals intersecting the supplied triangle (BVH accelerated). */
  intersectingTriangles(
    aLike: Vec3Like,
    bLike: Vec3Like,
    cLike: Vec3Like,
    limit = Number.POSITIVE_INFINITY,
    epsilon = DEFAULT_EPSILON,
  ): number[] {
    if (limit <= 0) return [];
    const a: Vec3 = [component(aLike, 0), component(aLike, 1), component(aLike, 2)];
    const b: Vec3 = [component(bLike, 0), component(bLike, 1), component(bLike, 2)];
    const c: Vec3 = [component(cLike, 0), component(cLike, 1), component(cLike, 2)];
    const bounds: Bounds = {
      minX: Math.min(a[0], b[0], c[0]) - epsilon,
      minY: Math.min(a[1], b[1], c[1]) - epsilon,
      minZ: Math.min(a[2], b[2], c[2]) - epsilon,
      maxX: Math.max(a[0], b[0], c[0]) + epsilon,
      maxY: Math.max(a[1], b[1], c[1]) + epsilon,
      maxZ: Math.max(a[2], b[2], c[2]) + epsilon,
    };
    const hits: number[] = [];
    const stack: BvhNode[] = [this.root];
    while (stack.length > 0 && hits.length < limit) {
      const node = stack.pop()!;
      if (!boundsOverlap(bounds, node)) continue;
      if (node.left === null || node.right === null) {
        for (let local = node.start; local < node.start + node.count && hits.length < limit; local++) {
          const triangle = this.triangleOrder[local]!;
          const [ta, tb, tc] = this.triangleVertices(triangle);
          if (trianglesIntersect(a, b, c, ta, tb, tc, epsilon)) hits.push(triangle);
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return hits;
  }

  private copyNormals(normals: ArrayLike<number>, stride: number, offset: number): Float64Array {
    if (!Number.isInteger(stride) || stride < 3 || offset < 0
      || recordCount(normals.length, offset, stride) < this.vertexCount) {
      throw new RangeError('Normal buffer does not match the mesh vertices.');
    }
    const result = new Float64Array(this.vertexCount * 3);
    for (let vertex = 0; vertex < this.vertexCount; vertex++) {
      const sourceOffset = offset + vertex * stride;
      const normal = normalize(normals[sourceOffset]!, normals[sourceOffset + 1]!, normals[sourceOffset + 2]!);
      result.set(normal, vertex * 3);
    }
    return result;
  }

  private buildPseudoNormals(): void {
    for (let triangle = 0; triangle < this.triangleCount; triangle++) {
      const ia = this.indices[triangle * 3]!;
      const ib = this.indices[triangle * 3 + 1]!;
      const ic = this.indices[triangle * 3 + 2]!;
      const [a, b, c] = this.triangleVertices(triangle);
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const abz = b[2] - a[2];
      const acx = c[0] - a[0];
      const acy = c[1] - a[1];
      const acz = c[2] - a[2];
      const face = normalize(
        aby * acz - abz * acy,
        abz * acx - abx * acz,
        abx * acy - aby * acx,
      );
      this.faceNormals.set(face, triangle * 3);
      this.addVertexPseudoNormal(ia, face, angleAt(a, b, c));
      this.addVertexPseudoNormal(ib, face, angleAt(b, c, a));
      this.addVertexPseudoNormal(ic, face, angleAt(c, a, b));
      this.addEdgePseudoNormal(ia, ib, face);
      this.addEdgePseudoNormal(ib, ic, face);
      this.addEdgePseudoNormal(ic, ia, face);
    }
    for (let vertex = 0; vertex < this.vertexCount; vertex++) {
      const offset = vertex * 3;
      const normal = normalize(
        this.vertexPseudoNormals[offset]!,
        this.vertexPseudoNormals[offset + 1]!,
        this.vertexPseudoNormals[offset + 2]!,
      );
      this.vertexPseudoNormals.set(normal, offset);
    }
  }

  private addVertexPseudoNormal(vertex: number, normal: Vec3, weight: number): void {
    const offset = vertex * 3;
    this.vertexPseudoNormals[offset] = this.vertexPseudoNormals[offset]! + normal[0] * weight;
    this.vertexPseudoNormals[offset + 1] = this.vertexPseudoNormals[offset + 1]! + normal[1] * weight;
    this.vertexPseudoNormals[offset + 2] = this.vertexPseudoNormals[offset + 2]! + normal[2] * weight;
  }

  private addEdgePseudoNormal(a: number, b: number, normal: Vec3): void {
    const key = edgeKey(a, b);
    const edge = this.edgePseudoNormals.get(key) ?? { x: 0, y: 0, z: 0, count: 0 };
    edge.x += normal[0];
    edge.y += normal[1];
    edge.z += normal[2];
    edge.count++;
    this.edgePseudoNormals.set(key, edge);
  }

  private displayNormalAt(triangle: number, barycentric: Vec3): Vec3 | null {
    if (!this.displayNormals) return null;
    const indices: Vec3 = [
      this.indices[triangle * 3]!,
      this.indices[triangle * 3 + 1]!,
      this.indices[triangle * 3 + 2]!,
    ];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let corner = 0; corner < 3; corner++) {
      const offset = indices[corner]! * 3;
      nx += this.displayNormals[offset]! * barycentric[corner]!;
      ny += this.displayNormals[offset + 1]! * barycentric[corner]!;
      nz += this.displayNormals[offset + 2]! * barycentric[corner]!;
    }
    return normalize(nx, ny, nz);
  }

  private pseudoNormalAt(triangle: number, barycentric: Vec3): Vec3 {
    const indices: Vec3 = [
      this.indices[triangle * 3]!,
      this.indices[triangle * 3 + 1]!,
      this.indices[triangle * 3 + 2]!,
    ];
    const zero = barycentric.map((weight) => weight <= FEATURE_EPSILON);
    const zeroCount = zero.filter(Boolean).length;
    if (zeroCount >= 2) {
      const corner = barycentric[0] >= barycentric[1]
        ? barycentric[0] >= barycentric[2] ? 0 : 2
        : barycentric[1] >= barycentric[2] ? 1 : 2;
      const offset = indices[corner]! * 3;
      return [
        this.vertexPseudoNormals[offset]!,
        this.vertexPseudoNormals[offset + 1]!,
        this.vertexPseudoNormals[offset + 2]!,
      ];
    }
    if (zeroCount === 1) {
      const omitted = zero.findIndex(Boolean);
      const ia = indices[(omitted + 1) % 3]!;
      const ib = indices[(omitted + 2) % 3]!;
      const edge = this.edgePseudoNormals.get(edgeKey(ia, ib));
      if (edge) return normalize(edge.x, edge.y, edge.z);
    }
    const offset = triangle * 3;
    return [this.faceNormals[offset]!, this.faceNormals[offset + 1]!, this.faceNormals[offset + 2]!];
  }

  private triangleVertices(triangle: number): [Vec3, Vec3, Vec3] {
    const result: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let corner = 0; corner < 3; corner++) {
      const offset = this.indices[triangle * 3 + corner]! * 3;
      result[corner] = [this.positions[offset]!, this.positions[offset + 1]!, this.positions[offset + 2]!];
    }
    return result;
  }

  private buildNode(start: number, end: number): BvhNode {
    const bounds = emptyBounds();
    const centroidBounds = emptyBounds();
    for (let local = start; local < end; local++) {
      const triangleBounds = this.triangleBounds(this.triangleOrder[local]!);
      expandBounds(bounds, triangleBounds);
      const cx = (triangleBounds.minX + triangleBounds.maxX) * 0.5;
      const cy = (triangleBounds.minY + triangleBounds.maxY) * 0.5;
      const cz = (triangleBounds.minZ + triangleBounds.maxZ) * 0.5;
      expandPoint(centroidBounds, cx, cy, cz);
    }
    const node: BvhNode = { ...bounds, start, count: end - start, left: null, right: null };
    if (end - start <= this.leafSize) return node;
    const extents = [
      centroidBounds.maxX - centroidBounds.minX,
      centroidBounds.maxY - centroidBounds.minY,
      centroidBounds.maxZ - centroidBounds.minZ,
    ];
    const axis = extents[0]! >= extents[1]! && extents[0]! >= extents[2]!
      ? 0
      : extents[1]! >= extents[2]! ? 1 : 2;
    const sorted = this.triangleOrder.slice(start, end).sort((lhs, rhs) =>
      this.triangleCentroid(lhs, axis) - this.triangleCentroid(rhs, axis));
    for (let index = 0; index < sorted.length; index++) {
      this.triangleOrder[start + index] = sorted[index]!;
    }
    const middle = start + Math.floor((end - start) / 2);
    node.left = this.buildNode(start, middle);
    node.right = this.buildNode(middle, end);
    return node;
  }

  private triangleBounds(triangle: number): Bounds {
    const [a, b, c] = this.triangleVertices(triangle);
    return {
      minX: Math.min(a[0], b[0], c[0]), minY: Math.min(a[1], b[1], c[1]), minZ: Math.min(a[2], b[2], c[2]),
      maxX: Math.max(a[0], b[0], c[0]), maxY: Math.max(a[1], b[1], c[1]), maxZ: Math.max(a[2], b[2], c[2]),
    };
  }

  private triangleCentroid(triangle: number, axis: number): number {
    const ia = this.indices[triangle * 3]! * 3 + axis;
    const ib = this.indices[triangle * 3 + 1]! * 3 + axis;
    const ic = this.indices[triangle * 3 + 2]! * 3 + axis;
    return (this.positions[ia]! + this.positions[ib]! + this.positions[ic]!) / 3;
  }

  private insideByRayParity(px: number, py: number, pz: number): boolean {
    const directions: Vec3[] = [
      normalize(1, 0.371390676, 0.127831),
      normalize(-0.219531, 1, 0.413729),
      normalize(0.337913, -0.171293, 1),
    ];
    let insideVotes = 0;
    for (const direction of directions) {
      const hits: number[] = [];
      const stack: BvhNode[] = [this.root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (!rayIntersectsBounds(px, py, pz, direction, node)) continue;
        if (node.left === null || node.right === null) {
          for (let local = node.start; local < node.start + node.count; local++) {
            const triangle = this.triangleOrder[local]!;
            const [a, b, c] = this.triangleVertices(triangle);
            const t = rayTriangleDistance(px, py, pz, direction, a, b, c);
            if (t !== null) hits.push(t);
          }
        } else {
          stack.push(node.left, node.right);
        }
      }
      hits.sort((lhs, rhs) => lhs - rhs);
      let uniqueHits = 0;
      let previous = Number.NEGATIVE_INFINITY;
      for (const hit of hits) {
        const tolerance = Math.max(1e-9, Math.abs(hit) * 1e-8);
        if (hit - previous > tolerance) {
          uniqueHits++;
          previous = hit;
        }
      }
      if (uniqueHits % 2 === 1) insideVotes++;
    }
    return insideVotes >= 2;
  }
}

function angleAt(origin: Vec3, b: Vec3, c: Vec3): number {
  const bx = b[0] - origin[0];
  const by = b[1] - origin[1];
  const bz = b[2] - origin[2];
  const cx = c[0] - origin[0];
  const cy = c[1] - origin[1];
  const cz = c[2] - origin[2];
  const denominator = Math.hypot(bx, by, bz) * Math.hypot(cx, cy, cz);
  if (denominator <= 1e-30) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(bx, by, bz, cx, cy, cz) / denominator)));
}

function recordCount(length: number, offset: number, stride: number): number {
  const remaining = length - offset;
  return remaining < 3 ? 0 : Math.floor((remaining - 3) / stride) + 1;
}

function emptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function expandPoint(bounds: Bounds, x: number, y: number, z: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function expandBounds(target: Bounds, source: Bounds): void {
  expandPoint(target, source.minX, source.minY, source.minZ);
  expandPoint(target, source.maxX, source.maxY, source.maxZ);
}

function distanceSquaredToBounds(x: number, y: number, z: number, bounds: Bounds): number {
  const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const dy = Math.max(bounds.minY - y, 0, y - bounds.maxY);
  const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
  return dx * dx + dy * dy + dz * dz;
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minY <= b.maxY && a.maxY >= b.minY
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function rayIntersectsBounds(
  ox: number,
  oy: number,
  oz: number,
  direction: Vec3,
  bounds: Bounds,
): boolean {
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;
  const origins = [ox, oy, oz];
  const minima = [bounds.minX, bounds.minY, bounds.minZ];
  const maxima = [bounds.maxX, bounds.maxY, bounds.maxZ];
  for (let axis = 0; axis < 3; axis++) {
    const inverse = 1 / direction[axis]!;
    let near = (minima[axis]! - origins[axis]!) * inverse;
    let far = (maxima[axis]! - origins[axis]!) * inverse;
    if (near > far) [near, far] = [far, near];
    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    if (tMin > tMax) return false;
  }
  return tMax >= 0;
}

function rayTriangleDistance(
  ox: number,
  oy: number,
  oz: number,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): number | null {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const hx = direction[1] * e2z - direction[2] * e2y;
  const hy = direction[2] * e2x - direction[0] * e2z;
  const hz = direction[0] * e2y - direction[1] * e2x;
  const determinant = dot(e1x, e1y, e1z, hx, hy, hz);
  if (Math.abs(determinant) <= 1e-12) return null;
  const inverse = 1 / determinant;
  const sx = ox - a[0];
  const sy = oy - a[1];
  const sz = oz - a[2];
  const u = inverse * dot(sx, sy, sz, hx, hy, hz);
  if (u < -1e-10 || u > 1 + 1e-10) return null;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = inverse * dot(direction[0], direction[1], direction[2], qx, qy, qz);
  if (v < -1e-10 || u + v > 1 + 1e-10) return null;
  const t = inverse * dot(e2x, e2y, e2z, qx, qy, qz);
  return t > 1e-10 ? t : null;
}
