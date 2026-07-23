import { MeshProximity, type Vec3 } from '../geometry/MeshProximity';
import { ConstraintKind } from './ConstraintGraph';

/** Contiguous global particle range. Extra fields (for example `instance`) are ignored. */
export interface ClothAuditParticleRange {
  first: number;
  count: number;
}

/**
 * One physical cloth group. `indices` and `ranges` may be combined; duplicate
 * particles are removed. Only particles referenced by this group's rendered
 * triangles are measured, so parked/cut grid particles cannot create false
 * overlap alarms.
 */
export interface ClothAuditGroup {
  label?: string;
  indices?: ArrayLike<number>;
  ranges?: readonly ClothAuditParticleRange[];
}

export interface ClothOverlapAuditOptions {
  /** Current world-space cloth positions, tightly packed xyz. */
  positions: ArrayLike<number>;
  /** Complete rendered cloth triangle list, using global particle indices. */
  triangleIndices: ArrayLike<number>;
  groupA: ClothAuditGroup;
  groupB: ClothAuditGroup;
  /** Physical cloth thickness in metres. */
  thicknessM: number;
  /** Defaults to 0.5 × thickness, in metres. */
  closeThresholdM?: number;
  /** Grid-hop distance to a seam. Values <= 1 form the expected sewn band. */
  seamDist?: ArrayLike<number>;
  /** Explicit self-collision exemption for cross-seams and their first ring. */
  seamFree?: ArrayLike<number>;
  /** Development guard for pathological coplanar meshes. Defaults to 10 000. */
  maxIntersectionPairs?: number;
}

export interface ClothOverlapDirectionReport {
  sampledVertices: number;
  closePairsRaw: number;
  closePairsExcludingSewnBand: number;
  minDistanceMm: number | null;
}

export interface ClothOverlapAuditReport {
  applicable: boolean;
  reason: string | null;
  groupA: { label: string; vertices: number; triangles: number };
  groupB: { label: string; vertices: number; triangles: number };
  closeThresholdMm: number;
  /**
   * Bidirectional vertex-to-nearest-triangle samples below the threshold.
   * This is intentionally a stable directed count, not a cartesian pair count.
   */
  closePairsRaw: number;
  /** Raw count minus contacts whose nearest feature belongs to a sewn band. */
  closePairsExcludingSewnBand: number;
  minDistanceMm: number | null;
  directions: {
    aToB: ClothOverlapDirectionReport;
    bToA: ClothOverlapDirectionReport;
  };
  /** Exact triangle-triangle crossings/touches, counted once per A/B pair. */
  intersectionsRaw: number;
  intersectionsExcludingSewnBand: number;
  intersectionsCapped: boolean;
}

export interface DeclaredSeamKindReport {
  count: number;
  minDistanceMm: number | null;
  meanDistanceMm: number | null;
  maxDistanceMm: number | null;
  overEffectiveThickness: number;
  worstPair: {
    i: number;
    j: number;
    distanceMm: number;
    restDistanceMm: number;
  } | null;
}

export interface DeclaredSeamAuditReport {
  effectiveThicknessMm: number;
  all: DeclaredSeamKindReport;
  regular: DeclaredSeamKindReport;
  surface: DeclaredSeamKindReport;
}

export interface DeclaredSeamAuditOptions {
  /** Current world-space cloth positions, tightly packed xyz. */
  positions: ArrayLike<number>;
  /** Packed 16-byte distance constraints from ClothMeshData. */
  constraintData: ArrayBuffer;
  constraintCount: number;
  effectiveThicknessM: number;
}

interface PreparedGroup {
  label: string;
  membership: Uint8Array;
  vertices: Uint32Array;
  triangles: Uint32Array;
}

interface DirectedResult extends ClothOverlapDirectionReport {}

const FEATURE_WEIGHT_EPSILON = 1e-6;
const DEFAULT_MAX_INTERSECTIONS = 10_000;

/**
 * Measure every declared stitch directly, independently of broad geometric
 * front/back groups. This is the closure invariant used by R1: a group minimum
 * can look healthy when one seam elsewhere is open, or look open when its sewn
 * mate crossed a coarse left/right spatial filter. Here each authored i↔j pair
 * is checked exactly against the effective cloth thickness.
 */
export function summarizeDeclaredSeamAudit(
  options: DeclaredSeamAuditOptions,
): DeclaredSeamAuditReport {
  if (options.positions.length % 3 !== 0) {
    throw new RangeError('Cloth positions must contain complete xyz records.');
  }
  if (
    !Number.isInteger(options.constraintCount) ||
    options.constraintCount < 0 ||
    options.constraintData.byteLength < options.constraintCount * 16
  ) {
    throw new RangeError('Constraint data must contain every declared record.');
  }
  if (
    !Number.isFinite(options.effectiveThicknessM) ||
    options.effectiveThicknessM <= 0
  ) {
    throw new RangeError('Effective cloth thickness must be positive and finite.');
  }

  interface MutableKindReport {
    count: number;
    sumDistanceM: number;
    minDistanceM: number;
    maxDistanceM: number;
    overEffectiveThickness: number;
    worstPair: DeclaredSeamKindReport['worstPair'];
  }
  const empty = (): MutableKindReport => ({
    count: 0,
    sumDistanceM: 0,
    minDistanceM: Number.POSITIVE_INFINITY,
    maxDistanceM: Number.NEGATIVE_INFINITY,
    overEffectiveThickness: 0,
    worstPair: null,
  });
  const all = empty();
  const regular = empty();
  const surface = empty();
  const vertexCount = options.positions.length / 3;
  const constraints = new DataView(options.constraintData);
  const add = (
    report: MutableKindReport,
    i: number,
    j: number,
    distanceM: number,
    restDistanceM: number,
  ): void => {
    report.count++;
    report.sumDistanceM += distanceM;
    report.minDistanceM = Math.min(report.minDistanceM, distanceM);
    if (distanceM > options.effectiveThicknessM) {
      report.overEffectiveThickness++;
    }
    if (distanceM >= report.maxDistanceM) {
      report.maxDistanceM = distanceM;
      report.worstPair = {
        i,
        j,
        distanceMm: distanceM * 1000,
        restDistanceMm: restDistanceM * 1000,
      };
    }
  };

  for (let index = 0; index < options.constraintCount; index++) {
    const offset = index * 16;
    const kind = constraints.getUint32(offset + 12, true);
    if (
      kind !== ConstraintKind.Seam &&
      kind !== ConstraintKind.SurfaceSeam &&
      kind !== ConstraintKind.AttachmentSeam
    ) continue;
    const i = constraints.getUint32(offset, true);
    const j = constraints.getUint32(offset + 4, true);
    if (i >= vertexCount || j >= vertexCount) {
      throw new RangeError('Declared seam references a particle outside the cloth buffer.');
    }
    const dx = options.positions[i * 3]! - options.positions[j * 3]!;
    const dy = options.positions[i * 3 + 1]! - options.positions[j * 3 + 1]!;
    const dz = options.positions[i * 3 + 2]! - options.positions[j * 3 + 2]!;
    const distanceM = Math.hypot(dx, dy, dz);
    const restDistanceM = constraints.getFloat32(offset + 8, true);
    add(all, i, j, distanceM, restDistanceM);
    add(
      kind === ConstraintKind.SurfaceSeam ? surface : regular,
      i,
      j,
      distanceM,
      restDistanceM,
    );
  }

  const finish = (report: MutableKindReport): DeclaredSeamKindReport => ({
    count: report.count,
    minDistanceMm:
      report.count > 0 ? report.minDistanceM * 1000 : null,
    meanDistanceMm:
      report.count > 0 ? (report.sumDistanceM / report.count) * 1000 : null,
    maxDistanceMm:
      report.count > 0 ? report.maxDistanceM * 1000 : null,
    overEffectiveThickness: report.overEffectiveThickness,
    worstPair: report.worstPair,
  });
  return {
    effectiveThicknessMm: options.effectiveThicknessM * 1000,
    all: finish(all),
    regular: finish(regular),
    surface: finish(surface),
  };
}

/**
 * Measure visible cloth-to-cloth proximity independently of the GPU solver.
 * The exact rendered triangles are queried in both directions through a BVH.
 */
export function summarizeClothOverlapAudit(
  options: ClothOverlapAuditOptions,
): ClothOverlapAuditReport {
  validateInput(options);
  const vertexCount = options.positions.length / 3;
  const groupA = prepareGroup(options.groupA, options.triangleIndices, vertexCount, 'A');
  const groupB = prepareGroup(options.groupB, options.triangleIndices, vertexCount, 'B');
  const closeThresholdM = options.closeThresholdM ?? options.thicknessM * 0.5;

  const base = (
    applicable: boolean,
    reason: string | null,
  ): ClothOverlapAuditReport => ({
    applicable,
    reason,
    groupA: {
      label: groupA.label,
      vertices: groupA.vertices.length,
      triangles: groupA.triangles.length / 3,
    },
    groupB: {
      label: groupB.label,
      vertices: groupB.vertices.length,
      triangles: groupB.triangles.length / 3,
    },
    closeThresholdMm: closeThresholdM * 1000,
    closePairsRaw: 0,
    closePairsExcludingSewnBand: 0,
    minDistanceMm: null,
    directions: {
      aToB: emptyDirection(),
      bToA: emptyDirection(),
    },
    intersectionsRaw: 0,
    intersectionsExcludingSewnBand: 0,
    intersectionsCapped: false,
  });

  if (groupA.vertices.length === 0 || groupA.triangles.length === 0) {
    return base(false, `group-${groupA.label}-has-no-rendered-triangles`);
  }
  if (groupB.vertices.length === 0 || groupB.triangles.length === 0) {
    return base(false, `group-${groupB.label}-has-no-rendered-triangles`);
  }
  for (let index = 0; index < vertexCount; index++) {
    if (groupA.membership[index] === 1 && groupB.membership[index] === 1) {
      return base(false, 'groups-share-particles');
    }
  }

  const proximityA = new MeshProximity({
    positions: options.positions,
    indices: groupA.triangles,
  });
  const proximityB = new MeshProximity({
    positions: options.positions,
    indices: groupB.triangles,
  });
  const aToB = directedProximity(
    options,
    groupA.vertices,
    groupB.triangles,
    proximityB,
    closeThresholdM,
  );
  const bToA = directedProximity(
    options,
    groupB.vertices,
    groupA.triangles,
    proximityA,
    closeThresholdM,
  );
  const intersections = countIntersections(options, groupA, groupB, proximityB);
  const report = base(true, null);
  report.directions = { aToB, bToA };
  report.closePairsRaw = aToB.closePairsRaw + bToA.closePairsRaw;
  report.closePairsExcludingSewnBand =
    aToB.closePairsExcludingSewnBand + bToA.closePairsExcludingSewnBand;
  report.minDistanceMm = minimumFinite(aToB.minDistanceMm, bToA.minDistanceMm);
  report.intersectionsRaw = intersections.raw;
  report.intersectionsExcludingSewnBand = intersections.actionable;
  report.intersectionsCapped = intersections.capped;
  return report;
}

function validateInput(options: ClothOverlapAuditOptions): void {
  if (options.positions.length % 3 !== 0 || options.positions.length < 9) {
    throw new RangeError('Cloth positions must contain complete xyz records.');
  }
  if (options.triangleIndices.length % 3 !== 0) {
    throw new RangeError('Cloth triangle indices must contain complete triangles.');
  }
  if (!Number.isFinite(options.thicknessM) || options.thicknessM <= 0) {
    throw new RangeError('Cloth thickness must be a positive finite value.');
  }
  const threshold = options.closeThresholdM ?? options.thicknessM * 0.5;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError('Cloth overlap threshold must be a positive finite value.');
  }
  if (options.seamDist && options.seamDist.length < options.positions.length / 3) {
    throw new RangeError('seamDist must cover every cloth particle.');
  }
  if (options.seamFree && options.seamFree.length < options.positions.length / 3) {
    throw new RangeError('seamFree must cover every cloth particle.');
  }
}

function prepareGroup(
  source: ClothAuditGroup,
  allTriangles: ArrayLike<number>,
  vertexCount: number,
  fallbackLabel: string,
): PreparedGroup {
  const membership = new Uint8Array(vertexCount);
  if (source.indices) {
    for (let offset = 0; offset < source.indices.length; offset++) {
      addMember(membership, source.indices[offset], vertexCount);
    }
  }
  for (const range of source.ranges ?? []) {
    if (!Number.isInteger(range.first) || !Number.isInteger(range.count)
      || range.first < 0 || range.count < 0 || range.first + range.count > vertexCount) {
      throw new RangeError('Cloth group ranges must stay inside the particle buffer.');
    }
    membership.fill(1, range.first, range.first + range.count);
  }

  const triangles: number[] = [];
  const rendered = new Uint8Array(vertexCount);
  for (let offset = 0; offset < allTriangles.length; offset += 3) {
    const a = checkedTriangleIndex(allTriangles[offset], vertexCount);
    const b = checkedTriangleIndex(allTriangles[offset + 1], vertexCount);
    const c = checkedTriangleIndex(allTriangles[offset + 2], vertexCount);
    if (membership[a] === 0 || membership[b] === 0 || membership[c] === 0) continue;
    triangles.push(a, b, c);
    rendered[a] = 1;
    rendered[b] = 1;
    rendered[c] = 1;
  }
  const vertices: number[] = [];
  for (let index = 0; index < rendered.length; index++) {
    if (rendered[index] === 1) vertices.push(index);
  }
  return {
    label: source.label?.trim() || fallbackLabel,
    membership,
    vertices: Uint32Array.from(vertices),
    triangles: Uint32Array.from(triangles),
  };
}

function directedProximity(
  options: ClothOverlapAuditOptions,
  queryVertices: Uint32Array,
  targetTriangles: Uint32Array,
  target: MeshProximity,
  closeThresholdM: number,
): DirectedResult {
  let closePairsRaw = 0;
  let closePairsExcludingSewnBand = 0;
  let minDistanceM = Number.POSITIVE_INFINITY;
  for (const vertex of queryVertices) {
    const point = readPoint(options.positions, vertex);
    const closest = target.closestPoint(point);
    minDistanceM = Math.min(minDistanceM, closest.distance);
    if (closest.distance >= closeThresholdM) continue;
    closePairsRaw++;
    const triangleOffset = closest.triangleIndex * 3;
    const queryIsSewn = isSewnBand(options, vertex);
    const targetFeatureIsSewn = [0, 1, 2].some((corner) => {
      if (closest.barycentric[corner]! <= FEATURE_WEIGHT_EPSILON) return false;
      return isSewnBand(options, targetTriangles[triangleOffset + corner]!);
    });
    if (!queryIsSewn && !targetFeatureIsSewn) closePairsExcludingSewnBand++;
  }
  return {
    sampledVertices: queryVertices.length,
    closePairsRaw,
    closePairsExcludingSewnBand,
    minDistanceMm: Number.isFinite(minDistanceM) ? minDistanceM * 1000 : null,
  };
}

function countIntersections(
  options: ClothOverlapAuditOptions,
  groupA: PreparedGroup,
  groupB: PreparedGroup,
  proximityB: MeshProximity,
): { raw: number; actionable: number; capped: boolean } {
  const maximum = Math.max(0, Math.floor(options.maxIntersectionPairs ?? DEFAULT_MAX_INTERSECTIONS));
  if (maximum === 0) return { raw: 0, actionable: 0, capped: true };
  let raw = 0;
  let actionable = 0;
  let capped = false;
  for (let offset = 0; offset < groupA.triangles.length; offset += 3) {
    const aIndices = [
      groupA.triangles[offset]!,
      groupA.triangles[offset + 1]!,
      groupA.triangles[offset + 2]!,
    ] as const;
    const remaining = maximum - raw;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const hits = proximityB.intersectingTriangles(
      readPoint(options.positions, aIndices[0]),
      readPoint(options.positions, aIndices[1]),
      readPoint(options.positions, aIndices[2]),
      remaining,
    );
    const aIsSewn = aIndices.some((index) => isSewnBand(options, index));
    for (const triangle of hits) {
      raw++;
      const bOffset = triangle * 3;
      const bIsSewn = isSewnBand(options, groupB.triangles[bOffset]!)
        || isSewnBand(options, groupB.triangles[bOffset + 1]!)
        || isSewnBand(options, groupB.triangles[bOffset + 2]!);
      if (!aIsSewn && !bIsSewn) actionable++;
    }
    if (raw >= maximum) {
      capped = true;
      break;
    }
  }
  return { raw, actionable, capped };
}

function addMember(membership: Uint8Array, value: number | undefined, vertexCount: number): void {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value >= vertexCount) {
    throw new RangeError(`Cloth group index ${String(value)} is outside the particle buffer.`);
  }
  membership[value] = 1;
}

function checkedTriangleIndex(value: number | undefined, vertexCount: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value >= vertexCount) {
    throw new RangeError(`Triangle index ${String(value)} is outside the particle buffer.`);
  }
  return value;
}

function readPoint(positions: ArrayLike<number>, vertex: number): Vec3 {
  const offset = vertex * 3;
  const point: Vec3 = [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
  if (!point.every(Number.isFinite)) {
    throw new RangeError(`Cloth particle ${vertex} has a non-finite position.`);
  }
  return point;
}

function isSewnBand(options: ClothOverlapAuditOptions, vertex: number): boolean {
  return (options.seamFree?.[vertex] ?? 0) !== 0
    || (options.seamDist?.[vertex] ?? Number.POSITIVE_INFINITY) <= 1;
}

function emptyDirection(): ClothOverlapDirectionReport {
  return {
    sampledVertices: 0,
    closePairsRaw: 0,
    closePairsExcludingSewnBand: 0,
    minDistanceMm: null,
  };
}

function minimumFinite(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
