import type { ClothMeshData, CrossSeam } from '../cloth/ClothMesh';
import {
  assemblySeamIsClosed,
  docPieces,
  pieceIdOf,
  type AssemblySeam,
  type DraftDoc,
  type DraftPiece,
  type PiecePlacementRole,
} from './Draft';

export interface PlacementIssue {
  pieceId: number;
  severity: 'error' | 'warning';
  code:
    | 'unassigned'
    | 'missing-support'
    | 'missing-seam'
    | 'unanchored-component'
    | 'free-piece';
  message: string;
}

export interface AutoPlacementResult {
  pairs: number;
  rotationRad: number;
  translation: [number, number];
  /** Depth correction applied after the planar seam fit. */
  depthTranslationM: number;
  meanDistanceBeforeM: number;
}

export type PieceStagingOffset = [number, number, number];

/** Preparation rotation: quaternion [x, y, z, w], applied about the piece centroid. */
export type PieceStagingOrient = [number, number, number, number];

const QUAT_IDENTITY: PieceStagingOrient = [0, 0, 0, 1];

function quatNormalize(q: readonly number[]): PieceStagingOrient {
  const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  if (!(n > 1e-12)) return [0, 0, 0, 1];
  return [q[0]! / n, q[1]! / n, q[2]! / n, q[3]! / n];
}

/** Hamilton product a·b (rotate by b, then by a); quaternions [x, y, z, w]. */
export function quatMultiply(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): PieceStagingOrient {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return quatNormalize([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

/** Unit quaternion for a rotation of `angleRad` about `axis` (need not be unit). */
export function quatFromAxisAngle(
  axis: readonly [number, number, number],
  angleRad: number,
): PieceStagingOrient {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(len > 1e-9) || !Number.isFinite(angleRad)) return [0, 0, 0, 1];
  const s = Math.sin(angleRad / 2) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angleRad / 2)];
}

function quatRotateVec(
  q: readonly [number, number, number, number],
  v: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function isIdentityQuat(q: readonly [number, number, number, number]): boolean {
  return Math.hypot(q[0], q[1], q[2]) <= 1e-6;
}

/**
 * Build a transient simulation view of a draft without selected free pieces.
 *
 * The authored document is deliberately left untouched: the 2D plan, undo,
 * autosave and garment JSON keep the pending piece. Keeping its array slot and
 * marking it `patternOnly` also preserves every later pieceId/offset, while
 * filtering physical joins prevents a retained piece from sewing to a mesh
 * that was intentionally omitted for this fitting.
 */
export function draftForSimulationExcluding(
  doc: DraftDoc,
  pieceIds: Iterable<number>,
): DraftDoc {
  const excluded = new Set(
    [...pieceIds].filter(
      (pieceId) =>
        Number.isInteger(pieceId) &&
        pieceId >= 2 &&
        pieceId - 2 < (doc.pieces?.length ?? 0),
    ),
  );
  if (excluded.size === 0) return structuredClone(doc);

  const derived = structuredClone(doc);
  derived.pieces = (derived.pieces ?? []).map((piece, index) =>
    excluded.has(index + 2) ? { ...piece, patternOnly: true } : piece,
  );
  const keepsJoin = (join: AssemblySeam): boolean =>
    !excluded.has(pieceIdOf(join.a)) && !excluded.has(pieceIdOf(join.b));
  if (derived.seams) derived.seams = derived.seams.filter(keepsJoin);
  if (derived.segmentLinks) {
    derived.segmentLinks = derived.segmentLinks.filter(keepsJoin);
  }
  return derived;
}

/**
 * Placement diagnostics that apply to the mesh which will actually be built.
 *
 * The Lucas compiler owns its seven supplied cutting pieces (front, back and
 * five entries in `pieces`). Running the generic graph over those canonical
 * pieces would report false errors because their specialised assembly is not
 * encoded as generic seams. User-added pieces start at pieceId 7 and still
 * need the ordinary placement checks.
 */
export function simulationPlacementIssues(doc: DraftDoc): PlacementIssue[] {
  const issues = placementIssues(doc);
  return doc.preset === 'lucas-hoodie'
    ? issues.filter((issue) => issue.pieceId >= 7)
    : issues;
}

/**
 * Only a physical, user-controlled free piece can be omitted for one fitting.
 * Built-in specialised pieces must stay present because their compilers own
 * the complete garment topology.
 */
export function canTemporarilyExcludePiece(
  doc: DraftDoc,
  pieceId: number,
): boolean {
  if (!Number.isInteger(pieceId) || pieceId < 2) return false;
  const piece = doc.pieces?.[pieceId - 2];
  if (!piece || piece.patternOnly || piece.outline.length < 3) return false;
  return doc.preset !== 'lucas-hoodie' || pieceId >= 7;
}

/** Return a defensive staging offset; malformed/imported values stay inert. */
export function stagingOffsetOf(
  piece: DraftPiece,
  instance = 0,
): PieceStagingOffset {
  const perInstance = piece.stagingOffsets?.[instance];
  if (
    perInstance &&
    perInstance.length === 3 &&
    perInstance.every(Number.isFinite)
  ) {
    return [perInstance[0], perInstance[1], perInstance[2]];
  }
  const raw = piece.stagingOffset;
  return raw && raw.length === 3 && raw.every(Number.isFinite)
    ? [raw[0], raw[1], raw[2]]
    : [0, 0, 0];
}

/** Whether at least one physical copy has been arranged away from its spawn. */
export function hasStagingOffset(piece: DraftPiece): boolean {
  if (Math.hypot(...stagingOffsetOf(piece)) > 1e-8) return true;
  return (piece.stagingOffsets ?? []).some(
    (offset) => !!offset && Math.hypot(...offset) > 1e-8,
  );
}

/**
 * Add one screen-plane drag to a piece's preparation-only 3D translation.
 * The offset is intentionally unbounded: it is an organisational aid and is
 * never sent to the final assembly spawn.
 */
export function movePieceInStaging(
  piece: DraftPiece,
  delta: readonly [number, number, number],
): DraftPiece {
  const current = stagingOffsetOf(piece);
  const next: PieceStagingOffset = [
    current[0] + delta[0],
    current[1] + delta[1],
    current[2] + delta[2],
  ];
  if (Math.hypot(...next) <= 1e-8) {
    const { stagingOffset: _discarded, ...rest } = piece;
    return rest;
  }
  return { ...piece, stagingOffset: next };
}

/**
 * Move one physical copy without pulling the other copies cut from the same
 * pattern. A legacy shared offset is expanded first so older saved drafts keep
 * their visual placement until one copy is deliberately separated.
 */
export function movePieceInstanceInStaging(
  piece: DraftPiece,
  instance: number,
  delta: readonly [number, number, number],
): DraftPiece {
  const safeInstance = Math.max(0, Math.floor(instance));
  const instanceCount = Math.max(
    safeInstance + 1,
    Number.isFinite(piece.cut) ? Math.max(1, Math.floor(piece.cut!)) : 1,
    piece.stagingOffsets?.length ?? 0,
  );
  const offsets: Array<PieceStagingOffset | null> = Array.from(
    { length: instanceCount },
    (_, index) => stagingOffsetOf(piece, index),
  );
  const current = offsets[safeInstance] ?? [0, 0, 0];
  offsets[safeInstance] = [
    current[0] + delta[0],
    current[1] + delta[1],
    current[2] + delta[2],
  ];

  const {
    stagingOffset: _sharedDiscarded,
    stagingOffsets: _instancesDiscarded,
    ...rest
  } = piece;
  return offsets.some((offset) => !!offset && Math.hypot(...offset) > 1e-8)
    ? { ...rest, stagingOffsets: offsets }
    : rest;
}

/** Reset one repeated copy while leaving its siblings where the user put them. */
export function resetPieceInstanceStaging(
  piece: DraftPiece,
  instance: number,
): DraftPiece {
  const safeInstance = Math.max(0, Math.floor(instance));
  const instanceCount = Math.max(
    safeInstance + 1,
    Number.isFinite(piece.cut) ? Math.max(1, Math.floor(piece.cut!)) : 1,
    piece.stagingOffsets?.length ?? 0,
  );
  const offsets: Array<PieceStagingOffset | null> = Array.from(
    { length: instanceCount },
    (_, index) => stagingOffsetOf(piece, index),
  );
  offsets[safeInstance] = [0, 0, 0];

  const {
    stagingOffset: _sharedDiscarded,
    stagingOffsets: _instancesDiscarded,
    ...rest
  } = piece;
  return offsets.some((offset) => !!offset && Math.hypot(...offset) > 1e-8)
    ? { ...rest, stagingOffsets: offsets }
    : rest;
}

/** Reset every physical copy represented by one cutting piece. */
export function resetPieceStaging(piece: DraftPiece): DraftPiece {
  const {
    stagingOffset: _sharedDiscarded,
    stagingOffsets: _instancesDiscarded,
    ...rest
  } = piece;
  return rest;
}

/** Translate one particle range in a generated preview mesh, in place. */
export function applyStagingOffset(
  mesh: ClothMeshData,
  offset: readonly [number, number, number],
  first = 0,
  count = mesh.count,
): void {
  const end = Math.max(first, Math.min(mesh.count, first + count));
  for (let q = Math.max(0, first); q < end; q++) {
    mesh.positions[q * 4] = mesh.positions[q * 4]! + offset[0];
    mesh.positions[q * 4 + 1] = mesh.positions[q * 4 + 1]! + offset[1];
    mesh.positions[q * 4 + 2] = mesh.positions[q * 4 + 2]! + offset[2];
  }
}

/** Defensive per-instance preparation rotation; malformed values stay identity. */
export function stagingOrientOf(
  piece: DraftPiece,
  instance = 0,
): PieceStagingOrient {
  const raw = piece.stagingOrients?.[instance];
  if (raw && raw.length === 4 && raw.every(Number.isFinite)) {
    return [raw[0], raw[1], raw[2], raw[3]];
  }
  return [0, 0, 0, 1];
}

/**
 * Compose one preparation rotation onto a single physical copy, about its
 * centroid. Mirrors movePieceInstanceInStaging: instances are independent and
 * an all-identity set drops the field entirely.
 */
export function rotatePieceInstanceInStaging(
  piece: DraftPiece,
  instance: number,
  quat: readonly [number, number, number, number],
): DraftPiece {
  const safeInstance = Math.max(0, Math.floor(instance));
  const instanceCount = Math.max(
    safeInstance + 1,
    Number.isFinite(piece.cut) ? Math.max(1, Math.floor(piece.cut!)) : 1,
    piece.stagingOrients?.length ?? 0,
  );
  const orients: Array<PieceStagingOrient | null> = Array.from(
    { length: instanceCount },
    (_, index) => stagingOrientOf(piece, index),
  );
  orients[safeInstance] = quatMultiply(
    quatNormalize(quat),
    orients[safeInstance] ?? QUAT_IDENTITY,
  );
  const { stagingOrients: _discarded, ...rest } = piece;
  return orients.some((q) => !!q && !isIdentityQuat(q))
    ? { ...rest, stagingOrients: orients }
    : rest;
}

/**
 * Rotate one particle range about its own centroid, in place. Identity ⇒ no-op.
 * Applied before applyStagingOffset so the translation still lands the centroid
 * on its arrangement target.
 */
export function applyStagingOrient(
  mesh: ClothMeshData,
  quat: readonly [number, number, number, number],
  first = 0,
  count = mesh.count,
): void {
  if (isIdentityQuat(quat)) return;
  const q = quatNormalize(quat);
  const start = Math.max(0, first);
  const end = Math.max(start, Math.min(mesh.count, first + count));
  if (end <= start) return;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = start; i < end; i++) {
    cx += mesh.positions[i * 4]!;
    cy += mesh.positions[i * 4 + 1]!;
    cz += mesh.positions[i * 4 + 2]!;
  }
  const n = end - start;
  cx /= n;
  cy /= n;
  cz /= n;
  for (let i = start; i < end; i++) {
    const r = quatRotateVec(q, [
      mesh.positions[i * 4]! - cx,
      mesh.positions[i * 4 + 1]! - cy,
      mesh.positions[i * 4 + 2]! - cz,
    ]);
    mesh.positions[i * 4] = cx + r[0];
    mesh.positions[i * 4 + 1] = cy + r[1];
    mesh.positions[i * 4 + 2] = cz + r[2];
  }
}

export function placementRoleOf(piece: DraftPiece): PiecePlacementRole | null {
  if (piece.placement?.role) return piece.placement.role;
  if (piece.wrap === 'armL' || piece.wrap === 'armR' || piece.wrap === 'neck') return piece.wrap;
  return null;
}

export function placementRoleLabel(role: PiecePlacementRole): string {
  switch (role) {
    case 'auto': return 'placement automatique';
    case 'front': return 'torse devant';
    case 'back': return 'torse dos';
    case 'armL': return 'manche gauche';
    case 'armR': return 'manche droite';
    case 'neck': return 'col';
    case 'waist': return 'ceinture';
    case 'legL': return 'jambe gauche';
    case 'legR': return 'jambe droite';
    case 'pocket': return 'poche / applique';
    case 'free': return 'pièce libre';
  }
}

/**
 * Pre-flight diagnostics for user-drawn pieces. Ordinary pieces do not need a
 * manually chosen body role: a path of real seams to the base front/back is a
 * complete placement instruction. Anatomical wraps and surface overlays keep
 * their specialised metadata because their body axis/support cannot be inferred
 * from an isolated outline.
 */
export function placementIssues(doc: DraftDoc): PlacementIssue[] {
  const pieces = docPieces(doc);
  const out: PlacementIssue[] = [];
  const active = (pieceId: number): boolean => {
    const piece = pieces[pieceId];
    return !!piece && !piece.patternOnly && piece.outline.length >= 3;
  };
  const neighbours = Array.from(
    { length: pieces.length },
    () => new Set<number>(),
  );
  const connect = (a: number, b: number): void => {
    if (a === b || !active(a) || !active(b)) return;
    neighbours[a]!.add(b);
    neighbours[b]!.add(a);
  };
  for (const seam of doc.seams ?? []) {
    if (!assemblySeamIsClosed(seam)) continue;
    connect(pieceIdOf(seam.a), pieceIdOf(seam.b));
  }
  // A stitched overlay follows its support unilaterally. Add that relationship
  // to the diagnostic graph without pretending it is an assembly seam.
  for (let pieceId = 2; pieceId < pieces.length; pieceId++) {
    const piece = pieces[pieceId];
    const surface = piece?.placement?.surface;
    if (
      piece?.placement?.role === 'pocket' &&
      surface?.stitchedEdges.length &&
      surface.supportPieceId >= 0 &&
      surface.supportPieceId < pieces.length
    ) {
      connect(pieceId, surface.supportPieceId);
    }
  }

  // Torso faces and explicit anatomical wraps are canonical seeds. Everything
  // connected to one of them can be reconstructed from its seam graph.
  const anchored = new Set<number>();
  const queue: number[] = [];
  for (let pieceId = 0; pieceId < pieces.length; pieceId++) {
    const role = pieces[pieceId] ? placementRoleOf(pieces[pieceId]!) : null;
    if (
      active(pieceId) &&
      (pieceId <= 1 || role === 'armL' || role === 'armR' || role === 'neck')
    ) {
      anchored.add(pieceId);
      queue.push(pieceId);
    }
  }
  while (queue.length) {
    const current = queue.shift()!;
    for (const neighbour of neighbours[current]!) {
      if (anchored.has(neighbour)) continue;
      anchored.add(neighbour);
      queue.push(neighbour);
    }
  }

  const reportedComponents = new Set<number>();
  const componentOf = (start: number): number[] => {
    const component: number[] = [];
    const seen = new Set([start]);
    const pending = [start];
    while (pending.length) {
      const current = pending.shift()!;
      component.push(current);
      for (const neighbour of neighbours[current]!) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        pending.push(neighbour);
      }
    }
    return component.sort((a, b) => a - b);
  };

  for (let pieceId = 2; pieceId < pieces.length; pieceId++) {
    const piece = pieces[pieceId];
    if (!piece || piece.patternOnly || piece.outline.length < 3) continue;
    const role = placementRoleOf(piece);
    if (role === 'free') {
      out.push({
        pieceId,
        severity: 'warning',
        code: 'free-piece',
        message: `${piece.name ?? `pièce ${pieceId + 1}`} restera volontairement libre et ne sera pas recalée`,
      });
      continue;
    }
    if (role === 'pocket') {
      const surface = piece.placement?.surface;
      const support =
        surface &&
        surface.supportPieceId >= 0 &&
        surface.supportPieceId < pieceId
          ? pieces[surface.supportPieceId]
          : null;
      if (!surface || !support || support.patternOnly || support.outline.length < 3) {
        out.push({
          pieceId,
          severity: 'error',
          code: 'missing-support',
          message: `${placementRoleLabel(role)} : choisir la pièce support et cliquer sa position exacte`,
        });
        continue;
      }
      if (!surface.stitchedEdges.length) {
        out.push({
          pieceId,
          severity: 'error',
          code: 'missing-seam',
          message: `${placementRoleLabel(role)} : conserver au moins une couture de contour`,
        });
      }
      continue;
    }
    const systemPlaced = role === 'armL' || role === 'armR' || role === 'neck';
    if (systemPlaced) continue;
    if (!neighbours[pieceId]!.size) {
      out.push({
        pieceId,
        severity: 'error',
        code: 'missing-seam',
        message: `${piece.name ?? `pièce ${pieceId + 1}`} : coudre au moins un bord au vêtement pour calculer sa pose`,
      });
      continue;
    }
    if (!anchored.has(pieceId)) {
      const component = componentOf(pieceId);
      const representative = component[0]!;
      if (reportedComponents.has(representative)) continue;
      reportedComponents.add(representative);
      const names = component
        .filter((id) => id >= 2)
        .map((id) => pieces[id]?.name ?? `pièce ${id + 1}`);
      out.push({
        pieceId: representative,
        severity: 'error',
        code: 'unanchored-component',
        message: `${names.join(' + ')} : cet ensemble est cousu, mais aucun bord ne le relie encore au vêtement`,
      });
    }
  }
  return out;
}

/**
 * Rigid planar Procrustes fit of an entering mesh onto its already-compiled
 * sewn edges, followed by the exact centroid correction in depth. Keeping Z
 * untouched used to leave ordinary pieces roughly 45 cm in front of their
 * target; near-zero-rest seams then had to pull them through the avatar.
 */
export function autoPlaceMeshFromCrossSeams(
  base: ClothMeshData,
  entering: ClothMeshData,
  seams: readonly CrossSeam[],
  enteringGlobalOffset: number,
): AutoPlacementResult | null {
  const pairs: Array<{
    source: [number, number, number];
    target: [number, number, number];
  }> = [];
  const seen = new Set<string>();
  for (const seam of seams) {
    const local = seam.j - enteringGlobalOffset;
    if (seam.i < 0 || seam.i >= base.count || local < 0 || local >= entering.count) continue;
    if (base.invMasses[seam.i]! <= 0 || entering.invMasses[local]! <= 0) continue;
    const key = `${seam.i}:${local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      source: [
        entering.positions[local * 4]!,
        entering.positions[local * 4 + 1]!,
        entering.positions[local * 4 + 2]!,
      ],
      target: [
        base.positions[seam.i * 4]!,
        base.positions[seam.i * 4 + 1]!,
        base.positions[seam.i * 4 + 2]!,
      ],
    });
  }
  if (!pairs.length) return null;

  const sourceCenter: [number, number] = [0, 0];
  const targetCenter: [number, number] = [0, 0];
  let sourceCenterZ = 0;
  let targetCenterZ = 0;
  let meanDistanceBeforeM = 0;
  for (const pair of pairs) {
    sourceCenter[0] += pair.source[0];
    sourceCenter[1] += pair.source[1];
    sourceCenterZ += pair.source[2];
    targetCenter[0] += pair.target[0];
    targetCenter[1] += pair.target[1];
    targetCenterZ += pair.target[2];
    meanDistanceBeforeM += Math.hypot(
      pair.target[0] - pair.source[0],
      pair.target[1] - pair.source[1],
      pair.target[2] - pair.source[2],
    );
  }
  sourceCenter[0] /= pairs.length;
  sourceCenter[1] /= pairs.length;
  targetCenter[0] /= pairs.length;
  targetCenter[1] /= pairs.length;
  sourceCenterZ /= pairs.length;
  targetCenterZ /= pairs.length;
  meanDistanceBeforeM /= pairs.length;

  let dot = 0;
  let cross = 0;
  let sourceVariance = 0;
  for (const pair of pairs) {
    const sx = pair.source[0] - sourceCenter[0];
    const sy = pair.source[1] - sourceCenter[1];
    const tx = pair.target[0] - targetCenter[0];
    const ty = pair.target[1] - targetCenter[1];
    dot += sx * tx + sy * ty;
    cross += sx * ty - sy * tx;
    sourceVariance += sx * sx + sy * sy;
  }
  const rotationRad = sourceVariance > 1e-10 ? Math.atan2(cross, dot) : 0;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const depthTranslationM = targetCenterZ - sourceCenterZ;
  for (let q = 0; q < entering.count; q++) {
    if (entering.invMasses[q]! <= 0) continue;
    const x = entering.positions[q * 4]! - sourceCenter[0];
    const y = entering.positions[q * 4 + 1]! - sourceCenter[1];
    entering.positions[q * 4] = targetCenter[0] + x * cos - y * sin;
    entering.positions[q * 4 + 1] = targetCenter[1] + x * sin + y * cos;
    entering.positions[q * 4 + 2] = entering.positions[q * 4 + 2]! + depthTranslationM;
  }
  return {
    pairs: pairs.length,
    rotationRad,
    translation: [targetCenter[0] - sourceCenter[0], targetCenter[1] - sourceCenter[1]],
    depthTranslationM,
    meanDistanceBeforeM,
  };
}

/**
 * Place a patch directly over its support surface after the exact XYZ fit. The
 * small outward clearance prevents the new layer from starting inside the
 * support; the top-stitches then keep every selected edge at that location.
 */
export function placeMeshOnSurface(
  base: ClothMeshData,
  entering: ClothMeshData,
  seams: readonly CrossSeam[],
  enteringGlobalOffset: number,
  outwardSign: 1 | -1,
  clearanceM = 0.004,
): (AutoPlacementResult & { zTranslation: number }) | null {
  const placed = autoPlaceMeshFromCrossSeams(base, entering, seams, enteringGlobalOffset);
  if (!placed) return null;
  let targetZ = 0;
  let sourceZ = 0;
  let count = 0;
  const seen = new Set<string>();
  for (const seam of seams) {
    const local = seam.j - enteringGlobalOffset;
    if (seam.i < 0 || seam.i >= base.count || local < 0 || local >= entering.count) continue;
    if (base.invMasses[seam.i]! <= 0 || entering.invMasses[local]! <= 0) continue;
    const key = `${seam.i}:${local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targetZ += base.positions[seam.i * 4 + 2]!;
    sourceZ += entering.positions[local * 4 + 2]!;
    count++;
  }
  if (!count) return null;
  const zTranslation = targetZ / count + outwardSign * clearanceM - sourceZ / count;
  for (let q = 0; q < entering.count; q++) {
    if (entering.invMasses[q]! > 0) {
      entering.positions[q * 4 + 2] = entering.positions[q * 4 + 2]! + zTranslation;
    }
  }
  return { ...placed, zTranslation };
}
