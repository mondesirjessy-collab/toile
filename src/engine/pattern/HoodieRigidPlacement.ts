/**
 * Rigid pre-dressing for multi-panel garments.
 *
 * A sewing constraint is deliberately much shorter than the distance between
 * two panels in their cutting-room pose. Moving only its two endpoints closes
 * the seam immediately, but also shortens the structural edges incident to
 * those endpoints and can collapse the adjacent triangles. This module instead
 * solves a small rigid Procrustes problem for every complete n×n panel. The
 * panel's authored/pre-wrapped shape is therefore preserved while its seams are
 * brought as close as a rigid placement permits.
 *
 * Surface seams (patch pockets and appliqués) are intentionally ignored: they
 * are one-sided attachments, not assembly joints between garment panels.
 */
import type { ClothMeshData, CrossSeam } from '../cloth/ClothMesh';
import { ConstraintKind } from '../solver/ConstraintGraph';

type Vec3 = [number, number, number];
type Quaternion = [number, number, number, number]; // w, x, y, z
type PositionArray = Float32Array | Float64Array;

interface SeamPair {
  a: number;
  b: number;
  panelA: number;
  panelB: number;
}

interface Correspondence {
  source: Vec3;
  target: Vec3;
  weight: number;
}

interface RigidFit {
  sourceCentre: Vec3;
  targetCentre: Vec3;
  rotation: Quaternion;
}

export interface SeamDistanceStats {
  count: number;
  meanM: number;
  rmsM: number;
  maxM: number;
}

export interface IntraPanelEdgeRatioStats {
  count: number;
  minimum: number;
  maximum: number;
}

export interface HoodieRigidPlacementOptions {
  /** Particle count of one physical panel. Defaults to resolution². */
  panelSize?: number;
  /** Panels that must keep their initial world pose. */
  fixedPanels?: readonly number[];
  /** Gauss-Seidel Procrustes sweeps. */
  iterations?: number;
  /** Fraction of every fitted rotation/translation applied per sweep. */
  damping?: number;
  /** Stop when the RMS seam improvement falls below this value. */
  toleranceM?: number;
  /**
   * Soft resistance to an unconstrained roll around a nearly straight seam.
   * This is a fraction of the seam correspondence weight, not a distance.
   */
  orientationRegularization?: number;
  /**
   * Give each neighbouring panel equal influence, independently of raster
   * stitch count. Useful at hood/body junctions where one long centre seam
   * would otherwise overwhelm the two shorter neckline joins.
   */
  balancePanelNeighbours?: boolean;
  /**
   * Iteratively favour the longest residuals (0 = ordinary least squares,
   * 1 = cubic-distance objective). This lowers visible worst-case gaps without
   * allowing a single stitch to dominate the fit.
   */
  longResidualBias?: number;
  /**
   * Optional authoritative assembly correspondences. When provided, the fit
   * uses only these user/system joins instead of every `Seam` constraint in
   * the mesh. This is important for freely drawn garments: the automatically
   * generated front/back rim stitches close a piece, but must not dominate the
   * calculation of where that piece belongs.
   */
  placementSeams?: readonly CrossSeam[];
}

export interface HoodieRigidPlacementReport {
  panelCount: number;
  crossPanelSeamCount: number;
  internalSeamCount: number;
  surfaceFollowerPanelCount: number;
  fixedPanels: number[];
  iterations: number;
  before: SeamDistanceStats;
  after: SeamDistanceStats;
  intraPanelEdgesBefore: IntraPanelEdgeRatioStats;
  intraPanelEdgesAfter: IntraPanelEdgeRatioStats;
  /** Rigid motion should leave this at floating-point noise. */
  maximumIntraPanelEdgeRatioDrift: number;
  degenerateTrianglesBefore: number;
  degenerateTrianglesAfter: number;
  minimumTriangleArea2Before: number;
  minimumTriangleArea2After: number;
}

const CONSTRAINT_STRIDE = 16;
const AREA_EPSILON = 1e-12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function particlePosition(positions: PositionArray, particle: number): Vec3 {
  const offset = particle * 4;
  return [
    positions[offset]!,
    positions[offset + 1]!,
    positions[offset + 2]!,
  ];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const length = Math.hypot(...quaternion);
  if (length <= 1e-15) return [1, 0, 0, 0];
  const sign = quaternion[0] < 0 ? -1 : 1;
  return quaternion.map((value) => (sign * value) / length) as Quaternion;
}

function rotate(vector: Vec3, quaternion: Quaternion): Vec3 {
  const [w, x, y, z] = quaternion;
  const [vx, vy, vz] = vector;
  // q * [0,v] * conjugate(q), expanded to avoid temporary quaternions.
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function partialRotation(quaternion: Quaternion, fraction: number): Quaternion {
  const q = normalizeQuaternion(quaternion);
  const angle = Math.acos(clamp(q[0], -1, 1));
  if (angle <= 1e-10) return [1, 0, 0, 0];
  const sinAngle = Math.sin(angle);
  if (Math.abs(sinAngle) <= 1e-10) return q;
  const partialAngle = angle * fraction;
  const factor = Math.sin(partialAngle) / sinAngle;
  return normalizeQuaternion([
    Math.cos(partialAngle),
    q[1] * factor,
    q[2] * factor,
    q[3] * factor,
  ]);
}

/** Largest algebraic eigenvector of a real symmetric 4×4 matrix. */
function largestSymmetricEigenvector(matrix: number[][]): Quaternion {
  const values = matrix.map((row) => [...row]);
  const vectors: number[][] = Array.from({ length: 4 }, (_unused, row) =>
    Array.from({ length: 4 }, (_unused2, column) =>
      row === column ? 1 : 0,
    ),
  );

  for (let sweep = 0; sweep < 32; sweep++) {
    let p = 0;
    let q = 1;
    let maximum = 0;
    for (let row = 0; row < 4; row++) {
      for (let column = row + 1; column < 4; column++) {
        const candidate = Math.abs(values[row]![column]!);
        if (candidate > maximum) {
          maximum = candidate;
          p = row;
          q = column;
        }
      }
    }
    if (maximum <= 1e-14) break;

    const app = values[p]![p]!;
    const aqq = values[q]![q]!;
    const apq = values[p]![q]!;
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let index = 0; index < 4; index++) {
      if (index === p || index === q) continue;
      const aip = values[index]![p]!;
      const aiq = values[index]![q]!;
      const nextP = cosine * aip - sine * aiq;
      const nextQ = sine * aip + cosine * aiq;
      values[index]![p] = nextP;
      values[p]![index] = nextP;
      values[index]![q] = nextQ;
      values[q]![index] = nextQ;
    }
    values[p]![p] =
      cosine * cosine * app -
      2 * sine * cosine * apq +
      sine * sine * aqq;
    values[q]![q] =
      sine * sine * app +
      2 * sine * cosine * apq +
      cosine * cosine * aqq;
    values[p]![q] = 0;
    values[q]![p] = 0;

    for (let row = 0; row < 4; row++) {
      const vip = vectors[row]![p]!;
      const viq = vectors[row]![q]!;
      vectors[row]![p] = cosine * vip - sine * viq;
      vectors[row]![q] = sine * vip + cosine * viq;
    }
  }

  let largest = 0;
  for (let index = 1; index < 4; index++) {
    if (values[index]![index]! > values[largest]![largest]!) largest = index;
  }
  return normalizeQuaternion([
    vectors[0]![largest]!,
    vectors[1]![largest]!,
    vectors[2]![largest]!,
    vectors[3]![largest]!,
  ]);
}

function rigidFit(correspondences: readonly Correspondence[]): RigidFit | null {
  let totalWeight = 0;
  let sourceCentre: Vec3 = [0, 0, 0];
  let targetCentre: Vec3 = [0, 0, 0];
  for (const correspondence of correspondences) {
    if (correspondence.weight <= 0) continue;
    totalWeight += correspondence.weight;
    sourceCentre = add(
      sourceCentre,
      scale(correspondence.source, correspondence.weight),
    );
    targetCentre = add(
      targetCentre,
      scale(correspondence.target, correspondence.weight),
    );
  }
  if (totalWeight <= 1e-12) return null;
  sourceCentre = scale(sourceCentre, 1 / totalWeight);
  targetCentre = scale(targetCentre, 1 / totalWeight);

  const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const correspondence of correspondences) {
    const p = subtract(correspondence.source, sourceCentre);
    const q = subtract(correspondence.target, targetCentre);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        covariance[row]![column] =
          covariance[row]![column]! +
          correspondence.weight * p[row]! * q[column]!;
      }
    }
  }
  const sxx = covariance[0]![0]!;
  const sxy = covariance[0]![1]!;
  const sxz = covariance[0]![2]!;
  const syx = covariance[1]![0]!;
  const syy = covariance[1]![1]!;
  const syz = covariance[1]![2]!;
  const szx = covariance[2]![0]!;
  const szy = covariance[2]![1]!;
  const szz = covariance[2]![2]!;
  const trace = sxx + syy + szz;
  const horn = [
    [trace, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  return {
    sourceCentre,
    targetCentre,
    rotation: largestSymmetricEigenvector(horn),
  };
}

function seamStats(
  positions: PositionArray,
  seams: readonly SeamPair[],
): SeamDistanceStats {
  if (!seams.length) return { count: 0, meanM: 0, rmsM: 0, maxM: 0 };
  let sum = 0;
  let sumSquares = 0;
  let maximum = 0;
  for (const seam of seams) {
    const a = particlePosition(positions, seam.a);
    const b = particlePosition(positions, seam.b);
    const distance = Math.hypot(
      a[0] - b[0],
      a[1] - b[1],
      a[2] - b[2],
    );
    sum += distance;
    sumSquares += distance * distance;
    maximum = Math.max(maximum, distance);
  }
  return {
    count: seams.length,
    meanM: sum / seams.length,
    rmsM: Math.sqrt(sumSquares / seams.length),
    maxM: maximum,
  };
}

function triangleQuality(
  positions: PositionArray,
  triangleIndices: Uint32Array,
): { degenerate: number; minimumArea2: number } {
  let degenerate = 0;
  let minimumArea2 = Infinity;
  for (let index = 0; index < triangleIndices.length; index += 3) {
    const a = particlePosition(positions, triangleIndices[index]!);
    const b = particlePosition(positions, triangleIndices[index + 1]!);
    const c = particlePosition(positions, triangleIndices[index + 2]!);
    const ab = subtract(b, a);
    const ac = subtract(c, a);
    const area2 = Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    );
    minimumArea2 = Math.min(minimumArea2, area2);
    if (area2 <= AREA_EPSILON) degenerate++;
  }
  return {
    degenerate,
    minimumArea2: Number.isFinite(minimumArea2) ? minimumArea2 : 0,
  };
}

function intraPanelEdgeRatios(
  mesh: ClothMeshData,
  positions: PositionArray,
  panelSize: number,
): Map<number, number> {
  const ratios = new Map<number, number>();
  const view = new DataView(mesh.constraintData);
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * CONSTRAINT_STRIDE;
    const kind = view.getUint32(offset + 12, true);
    if (
      kind === ConstraintKind.Seam ||
      kind === ConstraintKind.AttachmentSeam ||
      kind === ConstraintKind.SurfaceSeam
    ) {
      continue;
    }
    const a = view.getUint32(offset, true);
    const b = view.getUint32(offset + 4, true);
    if (Math.floor(a / panelSize) !== Math.floor(b / panelSize)) continue;
    const rest = view.getFloat32(offset + 8, true);
    if (rest <= 1e-12) continue;
    const pa = particlePosition(positions, a);
    const pb = particlePosition(positions, b);
    ratios.set(
      index,
      Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) / rest,
    );
  }
  return ratios;
}

function edgeRatioStats(
  ratios: ReadonlyMap<number, number>,
): IntraPanelEdgeRatioStats {
  if (!ratios.size) return { count: 0, minimum: 1, maximum: 1 };
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const ratio of ratios.values()) {
    minimum = Math.min(minimum, ratio);
    maximum = Math.max(maximum, ratio);
  }
  return { count: ratios.size, minimum, maximum };
}

function decodeSeams(
  mesh: ClothMeshData,
  panelSize: number,
): { cross: SeamPair[]; internal: number } {
  const cross: SeamPair[] = [];
  let internal = 0;
  const view = new DataView(mesh.constraintData);
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * CONSTRAINT_STRIDE;
    const kind = view.getUint32(offset + 12, true);
    if (
      kind !== ConstraintKind.Seam &&
      kind !== ConstraintKind.AttachmentSeam
    ) continue;
    const a = view.getUint32(offset, true);
    const b = view.getUint32(offset + 4, true);
    const panelA = Math.floor(a / panelSize);
    const panelB = Math.floor(b / panelSize);
    if (panelA === panelB) {
      internal++;
    } else {
      cross.push({ a, b, panelA, panelB });
    }
  }
  return { cross, internal };
}

function explicitPlacementSeams(
  mesh: ClothMeshData,
  panelSize: number,
  seams: readonly CrossSeam[],
): SeamPair[] {
  const unique = new Set<string>();
  const out: SeamPair[] = [];
  for (const seam of seams) {
    if (
      !Number.isInteger(seam.i) ||
      !Number.isInteger(seam.j) ||
      seam.i < 0 ||
      seam.j < 0 ||
      seam.i >= mesh.count ||
      seam.j >= mesh.count ||
      mesh.invMasses[seam.i]! <= 0 ||
      mesh.invMasses[seam.j]! <= 0
    ) {
      continue;
    }
    const panelA = Math.floor(seam.i / panelSize);
    const panelB = Math.floor(seam.j / panelSize);
    if (panelA === panelB) continue;
    const key =
      seam.i < seam.j ? `${seam.i}:${seam.j}` : `${seam.j}:${seam.i}`;
    if (unique.has(key)) continue;
    unique.add(key);
    out.push({ a: seam.i, b: seam.j, panelA, panelB });
  }
  return out;
}

function decodeSurfaceFollowers(
  mesh: ClothMeshData,
  panelSize: number,
): Map<number, Set<number>> {
  // compileSurfaceSeams stores support as i and overlay as j. Keep only the
  // panel relation: the follower must inherit the support's rigid motion but
  // must never pull the support while the assembly graph is being optimized.
  const followers = new Map<number, Set<number>>();
  const view = new DataView(mesh.constraintData);
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * CONSTRAINT_STRIDE;
    if (
      view.getUint32(offset + 12, true) !== ConstraintKind.SurfaceSeam
    ) {
      continue;
    }
    const support = Math.floor(view.getUint32(offset, true) / panelSize);
    const overlay = Math.floor(view.getUint32(offset + 4, true) / panelSize);
    if (support === overlay) continue;
    const supports = followers.get(overlay) ?? new Set<number>();
    supports.add(support);
    followers.set(overlay, supports);
  }
  return followers;
}

function connectedComponents(
  panelCount: number,
  seams: readonly SeamPair[],
): number[][] {
  const neighbours = Array.from({ length: panelCount }, () => new Set<number>());
  for (const seam of seams) {
    neighbours[seam.panelA]!.add(seam.panelB);
    neighbours[seam.panelB]!.add(seam.panelA);
  }
  const seen = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < panelCount; start++) {
    if (seen.has(start) || neighbours[start]!.size === 0) continue;
    const component: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const panel = queue.shift()!;
      component.push(panel);
      for (const neighbour of neighbours[panel]!) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
    components.push(component);
  }
  return components;
}

function automaticFixedPanels(
  panelCount: number,
  seams: readonly SeamPair[],
  requested: readonly number[],
): number[] {
  const validRequested = new Set(
    requested.filter((panel) => panel >= 0 && panel < panelCount),
  );
  const weights = new Uint32Array(panelCount);
  for (const seam of seams) {
    weights[seam.panelA] = weights[seam.panelA]! + 1;
    weights[seam.panelB] = weights[seam.panelB]! + 1;
  }
  for (const component of connectedComponents(panelCount, seams)) {
    if (component.some((panel) => validRequested.has(panel))) continue;
    let root = component[0]!;
    for (const panel of component.slice(1)) {
      if (weights[panel]! > weights[root]!) root = panel;
    }
    validRequested.add(root);
  }
  return [...validRequested].sort((a, b) => a - b);
}

function panelStabilizers(
  mesh: ClothMeshData,
  positions: PositionArray,
  panel: number,
  panelSize: number,
): Vec3[] {
  const first = panel * panelSize;
  const last = Math.min(mesh.count, first + panelSize);
  const live: number[] = [];
  for (let particle = first; particle < last; particle++) {
    if (mesh.invMasses[particle]! > 0) live.push(particle);
  }
  if (!live.length) return [];
  const axes = [0, 1, 2] as const;
  const selected = new Set<number>();
  for (const axis of axes) {
    let minimum = live[0]!;
    let maximum = live[0]!;
    for (const particle of live.slice(1)) {
      const value = positions[particle * 4 + axis]!;
      if (value < positions[minimum * 4 + axis]!) minimum = particle;
      if (value > positions[maximum * 4 + axis]!) maximum = particle;
    }
    selected.add(minimum);
    selected.add(maximum);
  }
  return [...selected].map((particle) =>
    particlePosition(positions, particle),
  );
}

function applyFitToPanel(
  positions: PositionArray,
  particleCount: number,
  panel: number,
  panelSize: number,
  fit: RigidFit,
  damping: number,
): void {
  const rotation = partialRotation(fit.rotation, damping);
  const centre = add(
    fit.sourceCentre,
    scale(subtract(fit.targetCentre, fit.sourceCentre), damping),
  );
  const first = panel * panelSize;
  const last = Math.min(particleCount, first + panelSize);
  for (let particle = first; particle < last; particle++) {
    const offset = particle * 4;
    const relative = subtract(
      particlePosition(positions, particle),
      fit.sourceCentre,
    );
    const next = add(rotate(relative, rotation), centre);
    positions[offset] = next[0];
    positions[offset + 1] = next[1];
    positions[offset + 2] = next[2];
  }
}

function setPanelFromOriginalFit(
  positions: PositionArray,
  original: PositionArray,
  particleCount: number,
  panel: number,
  panelSize: number,
  fit: RigidFit,
): void {
  const first = panel * panelSize;
  const last = Math.min(particleCount, first + panelSize);
  for (let particle = first; particle < last; particle++) {
    const offset = particle * 4;
    const relative = subtract(
      particlePosition(original, particle),
      fit.sourceCentre,
    );
    const next = add(rotate(relative, fit.rotation), fit.targetCentre);
    positions[offset] = next[0];
    positions[offset + 1] = next[1];
    positions[offset + 2] = next[2];
  }
}

function followSurfaceSupports(
  mesh: ClothMeshData,
  positions: PositionArray,
  original: PositionArray,
  panelSize: number,
  followers: ReadonlyMap<number, ReadonlySet<number>>,
): void {
  // More than one pass also supports an appliqué placed on another appliqué.
  // Every pass resets the follower from `original`, so transforms never stack.
  for (let pass = 0; pass < followers.size; pass++) {
    for (const [overlay, supports] of followers) {
      const correspondences: Correspondence[] = [];
      for (const support of supports) {
        const first = support * panelSize;
        const last = Math.min(mesh.count, first + panelSize);
        const stride = Math.max(1, Math.floor((last - first) / 96));
        for (let particle = first; particle < last; particle += stride) {
          if (mesh.invMasses[particle]! <= 0) continue;
          correspondences.push({
            source: particlePosition(original, particle),
            target: particlePosition(positions, particle),
            weight: 1,
          });
        }
      }
      const fit = rigidFit(correspondences);
      if (fit) {
        setPanelFromOriginalFit(
          positions,
          original,
          mesh.count,
          overlay,
          panelSize,
          fit,
        );
      }
    }
  }
}

/**
 * Mutates only `mesh.positions`, applying one rigid transform per n×n panel.
 * Constraint rest lengths, topology, masses, UVs and material assignment are
 * untouched. Call it once after every garment panel has been combined and
 * before the first solver frame.
 */
export function rigidlyPlaceGarmentPanels(
  mesh: ClothMeshData,
  options: HoodieRigidPlacementOptions = {},
): HoodieRigidPlacementReport {
  const panelSize = options.panelSize ?? mesh.resolution * mesh.resolution;
  if (!Number.isInteger(panelSize) || panelSize <= 0) {
    throw new Error('Rigid panel placement requires a positive panelSize');
  }
  const panelCount = Math.ceil(mesh.count / panelSize);
  const decoded = decodeSeams(mesh, panelSize);
  const seams = options.placementSeams
    ? explicitPlacementSeams(mesh, panelSize, options.placementSeams)
    : decoded.cross;
  const internal = decoded.internal;
  const surfaceFollowers = decodeSurfaceFollowers(mesh, panelSize);
  const fixedPanels = automaticFixedPanels(
    panelCount,
    seams,
    options.fixedPanels ?? [],
  );
  const fixed = new Set(fixedPanels);
  // All iterative fits run in f64. Rewriting a Float32Array after every sweep
  // accumulates enough round-off to look like ~0.1 % yarn strain after dozens
  // of passes even though every operation is rigid.
  const beforePositions = new Float64Array(mesh.positions);
  const workingPositions = new Float64Array(beforePositions);
  const before = seamStats(beforePositions, seams);
  const triangleBefore = triangleQuality(
    beforePositions,
    mesh.triangleIndices,
  );
  const edgeRatiosBefore = intraPanelEdgeRatios(
    mesh,
    beforePositions,
    panelSize,
  );
  const damping = clamp(options.damping ?? 0.7, 0.05, 1);
  const maximumIterations = Math.max(0, Math.floor(options.iterations ?? 18));
  const tolerance = Math.max(0, options.toleranceM ?? 1e-5);
  const regularization = Math.max(
    0,
    options.orientationRegularization ?? 0.015,
  );
  const balanceNeighbours = options.balancePanelNeighbours ?? true;
  const longResidualBias = clamp(options.longResidualBias ?? 0.75, 0, 2);
  const seamsByPanel = Array.from({ length: panelCount }, () => [] as SeamPair[]);
  for (const seam of seams) {
    seamsByPanel[seam.panelA]!.push(seam);
    seamsByPanel[seam.panelB]!.push(seam);
  }
  let previousRms = before.rmsM;
  let completedIterations = 0;

  for (let iteration = 0; iteration < maximumIterations; iteration++) {
    for (let panel = 0; panel < panelCount; panel++) {
      if (fixed.has(panel) || seamsByPanel[panel]!.length === 0) continue;
      const panelSeams = seamsByPanel[panel]!;
      const neighbourCounts = new Map<number, number>();
      if (balanceNeighbours) {
        for (const seam of panelSeams) {
          const neighbour = seam.panelA === panel ? seam.panelB : seam.panelA;
          neighbourCounts.set(
            neighbour,
            (neighbourCounts.get(neighbour) ?? 0) + 1,
          );
        }
      }
      const neighbourWeight =
        neighbourCounts.size > 0
          ? panelSeams.length / neighbourCounts.size
          : 1;
      const seamDistances = panelSeams.map((seam) => {
        const sourceParticle = seam.panelA === panel ? seam.a : seam.b;
        const targetParticle = seam.panelA === panel ? seam.b : seam.a;
        const source = particlePosition(workingPositions, sourceParticle);
        const target = particlePosition(workingPositions, targetParticle);
        return Math.hypot(
          source[0] - target[0],
          source[1] - target[1],
          source[2] - target[2],
        );
      });
      const meanDistance = Math.max(
        1e-6,
        seamDistances.reduce((sum, distance) => sum + distance, 0) /
          seamDistances.length,
      );
      const correspondences: Correspondence[] = panelSeams.map(
        (seam, seamIndex) => {
          const sourceParticle = seam.panelA === panel ? seam.a : seam.b;
          const targetParticle = seam.panelA === panel ? seam.b : seam.a;
          const neighbour =
            seam.panelA === panel ? seam.panelB : seam.panelA;
          const residualWeight =
            longResidualBias > 0
              ? clamp(
                  (seamDistances[seamIndex]! / meanDistance) **
                    longResidualBias,
                  0.25,
                  4,
                )
              : 1;
          return {
            source: particlePosition(workingPositions, sourceParticle),
            target: particlePosition(workingPositions, targetParticle),
            weight: balanceNeighbours
              ? (neighbourWeight / neighbourCounts.get(neighbour)!) *
                residualWeight
              : residualWeight,
          };
        },
      );
      if (regularization > 0) {
        const stabilizers = panelStabilizers(
          mesh,
          workingPositions,
          panel,
          panelSize,
        );
        const totalStabilizerWeight =
          correspondences.length * regularization;
        const stabilizerWeight =
          stabilizers.length > 0
            ? totalStabilizerWeight / stabilizers.length
            : 0;
        for (const point of stabilizers) {
          correspondences.push({
            source: point,
            target: point,
            weight: stabilizerWeight,
          });
        }
      }
      const fit = rigidFit(correspondences);
      if (fit) {
        applyFitToPanel(
          workingPositions,
          mesh.count,
          panel,
          panelSize,
          fit,
          damping,
        );
      }
    }
    completedIterations = iteration + 1;
    const current = seamStats(workingPositions, seams);
    if (Math.abs(previousRms - current.rmsM) <= tolerance) break;
    previousRms = current.rmsM;
  }

  // Pockets must accompany a front panel that the assembly fit rotated. They
  // inherit that exact rigid motion afterwards, without contributing any force
  // to the fit and without losing their initial collision offset.
  followSurfaceSupports(
    mesh,
    workingPositions,
    beforePositions,
    panelSize,
    surfaceFollowers,
  );

  mesh.positions.set(workingPositions);
  const after = seamStats(mesh.positions, seams);
  const triangleAfter = triangleQuality(
    mesh.positions,
    mesh.triangleIndices,
  );
  const edgeRatiosAfter = intraPanelEdgeRatios(
    mesh,
    mesh.positions,
    panelSize,
  );
  let maximumRatioDrift = 0;
  for (const [constraint, ratioBefore] of edgeRatiosBefore) {
    maximumRatioDrift = Math.max(
      maximumRatioDrift,
      Math.abs((edgeRatiosAfter.get(constraint) ?? ratioBefore) - ratioBefore),
    );
  }

  return {
    panelCount,
    crossPanelSeamCount: seams.length,
    internalSeamCount: internal,
    surfaceFollowerPanelCount: surfaceFollowers.size,
    fixedPanels,
    iterations: completedIterations,
    before,
    after,
    intraPanelEdgesBefore: edgeRatioStats(edgeRatiosBefore),
    intraPanelEdgesAfter: edgeRatioStats(edgeRatiosAfter),
    maximumIntraPanelEdgeRatioDrift: maximumRatioDrift,
    degenerateTrianglesBefore: triangleBefore.degenerate,
    degenerateTrianglesAfter: triangleAfter.degenerate,
    minimumTriangleArea2Before: triangleBefore.minimumArea2,
    minimumTriangleArea2After: triangleAfter.minimumArea2,
  };
}

/** Backwards-compatible name for the specialised Lucas hoodie compiler. */
export const rigidlyPlaceHoodiePanels = rigidlyPlaceGarmentPanels;
