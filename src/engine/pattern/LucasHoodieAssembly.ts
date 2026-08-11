/**
 * Specialised Lucas Hoodie assembly.
 *
 * The 2D document stores the seven unique cutting pieces.  Their `cut`
 * quantities are real construction instructions, so this compiler materialises
 * the repeated physical instances: front ×2, sleeve ×2, hood ×2 and cuff ×2.
 * The back and waistband are unfolded from their exact on-fold cut lines.
 */
import type { BodyMeasure, Sd } from '../body/measure';
import {
  combineClothMeshes,
  generateSeamedPanels,
  scaleMeshInverseMassesToReferenceCellArea,
  type ClothMeshData,
  type CrossSeam,
  type SurfaceContact,
} from '../cloth/ClothMesh';
import {
  assemblySeamIsClosed,
  compileSurfaceContacts,
  compileSurfaceSeams,
  pairOutlineRuns,
  surfaceAttachmentUV,
  type DraftDoc,
  type DraftPiece,
  type EdgeRun,
  type SurfaceAttachment,
  type UV,
} from './Draft';
import {
  LUCAS_SEAM_ALLOWANCE_M,
  hoodieRunLengthM,
  lucasHoodNecklineRuns,
  lucasHoodieRuns,
} from './lucasHoodie';
import { rigidlyPlaceHoodiePanels } from './HoodieRigidPlacement';
import { ConstraintKind } from '../solver/ConstraintGraph';

export interface LucasHoodieParticleRange {
  pieceId: number;
  first: number;
  count: number;
  instance: number;
}

export interface LucasHoodieMesh {
  mesh: ClothMeshData;
  ranges: LucasHoodieParticleRange[];
}

interface UnfoldedPiece {
  piece: DraftPiece;
  right: Map<number, number>;
  left: Map<number, number>;
}

interface TorsoShell {
  halfW: number;
  halfD: number;
  finishedCircumference: number;
}

const PANEL_PADDING_M = 0.005;
const SLEEVE_CAP_PRE_SHAPE = 0.7;
const SLEEVE_MIN_SIGNED_EDGE_RATIO = 0.35;
const SLEEVE_CAP_EDGE_MOBILITY = 0.11;
const HOOD_CONTACT_THICKNESS_M = 0.006;
const HOOD_CONTACT_SAFETY_M = 0.002;
const HOOD_NECK_CAPTURE_M = 0.082;
const HOOD_NECK_PRE_DRESS_M = 0.076;
const HOOD_MAX_PRE_DRESS_EDGE_RATIO = 4.25;

type Point3 = [number, number, number];
type HoodNeckTargets = ReadonlyMap<number, Point3>;

function cyclicIndices(from: number, to: number, count: number): number[] {
  const target = ((to % count) + count) % count;
  const out = [((from % count) + count) % count];
  while (out[out.length - 1] !== target && out.length <= count) {
    out.push((out[out.length - 1]! + 1) % count);
  }
  return out;
}

function emptyMask(): { outline: UV[]; darts: [] } {
  return { outline: [], darts: [] };
}

function sameUV(a: UV, b: UV): boolean {
  return Math.abs(a[0] - b[0]) <= 1e-7 && Math.abs(a[1] - b[1]) <= 1e-7;
}

/**
 * PDF pattern notches are encoded as zero-width A→tip→A excursions. They must
 * remain in the editable/exported vector, but a regular particle grid can
 * interpret the retraced ray as a second one-cell island. Collapse only those
 * exact excursions for the physical pocket mask and remap its open/topstitched
 * edges onto the cleaned contour.
 */
function simulationPocketPiece(
  source: DraftPiece,
  sourceOpening: EdgeRun,
): DraftPiece {
  const retracedStarts = source.outline
    .map((_point, index) => index)
    .filter(
      (index) =>
        index + 2 < source.outline.length &&
        sameUV(source.outline[index]!, source.outline[index + 2]!),
    );
  // The first retraced notch marks the lower end of the pocket's fold line;
  // the supplied `opening.to` is its upper end. The intervening contour is the
  // turn-under allowance shown in steps 1–3 of the sewing guide. Once folded,
  // the simulated outer boundary is the direct fold line between these two
  // points (the exact cut allowance remains untouched in the 2D document).
  const foldStart = retracedStarts.find(
    (index) => index < sourceOpening.to,
  );
  const foldEnd = sourceOpening.to;
  const foldedSource =
    foldStart !== undefined && foldStart + 1 < foldEnd
      ? source.outline.filter(
          (_point, index) => index <= foldStart || index >= foldEnd,
        )
      : source.outline;
  const outline: UV[] = [];
  for (const point of foldedSource) {
    if (outline.length >= 2 && sameUV(point, outline[outline.length - 2]!)) {
      outline.pop();
      continue;
    }
    if (!outline.length || !sameUV(point, outline[outline.length - 1]!)) {
      outline.push(point);
    }
  }
  if (outline.length < 3 || outline.length === source.outline.length) {
    return source;
  }
  const findPoint = (point: UV): number =>
    outline.findIndex((candidate) => sameUV(candidate, point));
  const openingFrom =
    foldStart === undefined
      ? source.outline[sourceOpening.from]!
      : source.outline[foldStart]!;
  const from = findPoint(openingFrom);
  const to = findPoint(source.outline[foldEnd]!);
  if (from < 0 || to < 0 || from === to) return source;
  const opening: EdgeRun = { from, to };
  const openEdges = new Set(
    cyclicIndices(from, to, outline.length).slice(0, -1),
  );
  const surface = source.placement?.surface;
  return {
    ...source,
    outline,
    openEdges: [opening],
    ...(surface
      ? {
          placement: {
            ...source.placement!,
            surface: {
              ...surface,
              stitchedEdges: outline
                .map((_point, edge) => edge)
                .filter((edge) => !openEdges.has(edge)),
            },
          },
        }
      : {}),
  };
}

function pairedEdges(
  pieceA: DraftPiece,
  pieceB: DraftPiece,
  runA: EdgeRun,
  runB: EdgeRun,
  n: number,
  reverseB?: boolean,
  coverBothRuns = false,
): { a: number[]; b: number[] } {
  const dense = pairOutlineRuns(pieceA, pieceB, runA, runB, n, reverseB) ?? {
    a: [],
    b: [],
  };
  // The generic assembler emits one constraint for every cell of the denser
  // edge, repeating cells from the sparser edge. That is useful as a gathered
  // seam, but the hoodie pre-dresses its seams before simulation: repeated
  // endpoints would pull several neighbouring vertices onto one point and
  // flatten their triangles. Resample both ordered runs to the same *unique*
  // stitch count instead. Structural edges carry the short intervals between
  // stitches, exactly like a finite stitch pitch, without leaving an open run.
  const uniqueConsecutive = (cells: readonly number[]): number[] =>
    cells.filter((cell, index) => index === 0 || cell !== cells[index - 1]);
  const aCells = uniqueConsecutive(dense.a);
  const bCells = uniqueConsecutive(dense.b);
  // A sleeve head is eased into the armscye: the two raster chains can differ
  // by 20–30% even though their physical sewing lengths match. Sampling only
  // the shorter chain leaves live boundary cells without a stitch and opens a
  // visible crescent around the avatar's shoulder. For those joins, sample at
  // the denser count and repeat isolated cells on the shorter side, exactly as
  // easing distributes a little fullness along a real seam.
  const stitchCount = coverBothRuns
    ? Math.max(aCells.length, bCells.length)
    : Math.min(aCells.length, bCells.length);
  if (stitchCount <= 0) return { a: [], b: [] };
  if (stitchCount === 1) {
    return {
      a: [aCells[Math.floor((aCells.length - 1) / 2)]!],
      b: [bCells[Math.floor((bCells.length - 1) / 2)]!],
    };
  }
  const sample = (cells: readonly number[], index: number): number =>
    cells[Math.round((index * (cells.length - 1)) / (stitchCount - 1))]!;
  return {
    a: Array.from({ length: stitchCount }, (_unused, index) =>
      sample(aCells, index),
    ),
    b: Array.from({ length: stitchCount }, (_unused, index) =>
      sample(bCells, index),
    ),
  };
}

/**
 * Return the upper live raster chain of the finished rib band.  The band is
 * very wide and shallow, so assigning its corner cells through the generic
 * nearest-outline-edge rule can make a horizontal attachment run absorb a
 * sizeable part of the vertical zip edge.  Reading the first live cell of
 * every grid column keeps the four hem sections strictly on the upper edge.
 */
function upperLiveCells(mesh: ClothMeshData): number[] {
  const n = mesh.resolution;
  const cells: number[] = [];
  for (let column = 0; column < n; column++) {
    for (let row = 0; row < n; row++) {
      const cell = row * n + column;
      if (mesh.invMasses[cell]! > 0) {
        cells.push(cell);
        break;
      }
    }
  }
  return cells;
}

function nearestChainIndex(
  cells: readonly number[],
  n: number,
  u: number,
): number {
  let nearest = 0;
  let distance = Infinity;
  for (let index = 0; index < cells.length; index++) {
    const candidateU = (cells[index]! % n) / Math.max(1, n - 1);
    const candidateDistance = Math.abs(candidateU - u);
    if (candidateDistance < distance) {
      distance = candidateDistance;
      nearest = index;
    }
  }
  return nearest;
}

/**
 * Gather a shell edge onto one exact interval of the band upper edge.  The
 * longer chain drives the stitch count and the shorter rib chain repeats cells
 * as real gathered sewing would; adjacent intervals deliberately share their
 * junction cell so no raster eyelet is left at a side seam.
 */
function pairedEdgeToBandTop(
  shellPiece: DraftPiece,
  shellRun: EdgeRun,
  bandPiece: DraftPiece,
  bandRun: EdgeRun,
  bandMesh: ClothMeshData,
  n: number,
  reverseBand = false,
): { a: number[]; b: number[] } {
  const shell =
    pairOutlineRuns(
      shellPiece,
      shellPiece,
      shellRun,
      shellRun,
      n,
      false,
    )?.a.filter(
      (cell, index, cells) => index === 0 || cell !== cells[index - 1],
    ) ?? [];
  const top = upperLiveCells(bandMesh);
  if (!shell.length || !top.length) return { a: [], b: [] };

  const startU = bandPiece.outline[bandRun.from]![0];
  const endU = bandPiece.outline[bandRun.to]![0];
  const start = nearestChainIndex(top, n, startU);
  const end = nearestChainIndex(top, n, endU);
  const band =
    start <= end
      ? top.slice(start, end + 1)
      : top.slice(end, start + 1).reverse();
  if (!band.length) return { a: [], b: [] };

  const stitchCount = Math.max(shell.length, band.length);
  const sample = (
    cells: readonly number[],
    index: number,
    reversed: boolean,
  ): number => {
    const sampled = Math.floor((index * cells.length) / stitchCount);
    return cells[reversed ? cells.length - 1 - sampled : sampled]!;
  };
  return {
    a: Array.from({ length: stitchCount }, (_unused, index) =>
      sample(shell, index, false),
    ),
    b: Array.from({ length: stitchCount }, (_unused, index) =>
      sample(band, index, reverseBand),
    ),
  };
}

function asPairs(pair: { a: number[]; b: number[] }): Array<{ i: number; j: number }> {
  return pair.a.map((cell, index) => ({ i: cell, j: pair.b[index]! }));
}

function appendCross(
  target: CrossSeam[],
  pair: { a: number[]; b: number[] },
  offsetA: number,
  offsetB: number,
  reverseB = false,
): void {
  for (let index = 0; index < pair.a.length; index++) {
    const bIndex = reverseB ? pair.b.length - 1 - index : index;
    target.push({
      i: offsetA + pair.a[index]!,
      j: offsetB + pair.b[bIndex]!,
    });
  }
}

function panelPair(
  piece: DraftPiece,
  n: number,
  extraSeams: readonly { i: number; j: number }[] = [],
  assemblySeams: readonly { i: number; j: number }[] = [],
): ClothMeshData {
  return generateSeamedPanels({
    resolution: n,
    width: piece.width,
    height: piece.height,
    gap: piece.gap,
    topY: piece.topY,
    shape: 'freeform',
    mask: { outline: piece.outline, darts: piece.darts },
    maskBack: { outline: piece.outline, darts: piece.darts },
    extraSeams,
    extraSeamsBack: extraSeams,
    assemblySeams,
    manualAssembly: true,
    flattenSeams: false,
  });
}

function singlePanel(
  piece: DraftPiece,
  n: number,
  extraSeams: readonly { i: number; j: number }[] = [],
): ClothMeshData {
  return generateSeamedPanels({
    resolution: n,
    width: piece.width,
    height: piece.height,
    gap: piece.gap,
    topY: piece.topY,
    shape: 'freeform',
    mask: { outline: piece.outline, darts: piece.darts },
    maskBack: emptyMask(),
    extraSeams,
    manualAssembly: true,
    flattenSeams: false,
  });
}

function unfoldOnFold(
  source: DraftPiece,
  fold: EdgeRun,
): UnfoldedPiece {
  const count = source.outline.length;
  const outerIndices = cyclicIndices(fold.to, fold.from, count);
  const foldA = source.outline[fold.from]!;
  const foldB = source.outline[fold.to]!;
  const foldX =
    (((foldA[0] - 0.5) * source.width) +
      ((foldB[0] - 0.5) * source.width)) /
    2;
  const sourcePhysical = (index: number): [number, number] => {
    const point = source.outline[index]!;
    return [
      (point[0] - 0.5) * source.width - foldX,
      point[1] * source.height,
    ];
  };
  const rightPoints = outerIndices.map(sourcePhysical);
  const mirroredIndices = [...outerIndices].reverse().slice(1, -1);
  const mirroredPoints = mirroredIndices.map((index) => {
    const [x, y] = sourcePhysical(index);
    return [-x, y] as [number, number];
  });
  const physical = [...rightPoints, ...mirroredPoints];
  const xs = physical.map((point) => point[0]);
  const ys = physical.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX + 2 * PANEL_PADDING_M;
  const height = maxY - minY + 2 * PANEL_PADDING_M;
  const outline: UV[] = physical.map(([x, y]) => [
    (PANEL_PADDING_M + x - minX) / width,
    (PANEL_PADDING_M + y - minY) / height,
  ]);
  const right = new Map<number, number>();
  const left = new Map<number, number>();
  outerIndices.forEach((sourceIndex, index) => right.set(sourceIndex, index));
  // The two fold endpoints are shared by both sides of the unfolded contour.
  left.set(outerIndices[0]!, 0);
  left.set(outerIndices[outerIndices.length - 1]!, outerIndices.length - 1);
  mirroredIndices.forEach((sourceIndex, index) =>
    left.set(sourceIndex, rightPoints.length + index),
  );
  return {
    piece: {
      ...source,
      outline,
      onFold: false,
      width,
      height,
    },
    right,
    left,
  };
}

function mappedRun(
  unfolded: UnfoldedPiece,
  source: EdgeRun,
  side: 'left' | 'right',
): EdgeRun {
  const mapping = side === 'right' ? unfolded.right : unfolded.left;
  const from = mapping.get(side === 'right' ? source.from : source.to);
  const to = mapping.get(side === 'right' ? source.to : source.from);
  if (from === undefined || to === undefined) {
    throw new Error('Lucas Hoodie on-fold run could not be unfolded');
  }
  return { from, to };
}

/** Recover the cut-edge-adjusted UV generated by ClothMesh before a specialised
 * 3D placement overwrites its flat rest pose. Using the raw integer grid UV
 * loses the boundary snapping and can compress the first ring of triangles. */
function flatParticleUV(
  mesh: ClothMeshData,
  piece: DraftPiece,
  particle: number,
): UV {
  return [
    mesh.positions[particle * 4]! / Math.max(piece.width, 1e-9) + 0.5,
    (piece.topY - mesh.positions[particle * 4 + 1]!) /
      Math.max(piece.height, 1e-9),
  ];
}

function outlinePhysicalWidth(piece: DraftPiece): number {
  const values = piece.outline.map((point) => point[0]);
  return (Math.max(...values) - Math.min(...values)) * piece.width;
}

function ellipseCircumference(halfW: number, halfD: number): number {
  // Ramanujan II is comfortably more accurate than the raster spacing used by
  // the simulator and, unlike a fixed avatar offset, preserves the finished
  // chest circumference authored by the Lucas pattern.
  const h =
    ((halfW - halfD) * (halfW - halfD)) /
    Math.max(1e-12, (halfW + halfD) * (halfW + halfD));
  return (
    Math.PI *
    (halfW + halfD) *
    (1 + (3 * h) / (10 + Math.sqrt(Math.max(0, 4 - 3 * h))))
  );
}

function torsoShell(
  front: DraftPiece,
  backHalf: DraftPiece,
  body: BodyMeasure,
): TorsoShell {
  // At chest level one half of the garment is one front plus one back-half.
  // Remove the four 1 cm joining allowances from the complete cut perimeter;
  // this reproduces the finished measurements from the supplied size chart
  // (130 cm for M) instead of shrink-wrapping the cloth to the avatar collider.
  const cutCircumference =
    2 * (outlinePhysicalWidth(front) + outlinePhysicalWidth(backHalf));
  const patternFinishedCircumference = Math.max(
    body.chest.circ + 0.12,
    cutCircumference - 4 * LUCAS_SEAM_ALLOWANCE_M,
  );
  // The current contour is the source of truth. In particular, resizing the
  // editable 2D pieces must resize the 3D shell instead of being silently
  // overwritten by the original commercial-size chart.
  const finishedCircumference = patternFinishedCircumference;
  const aspect =
    body.chest.halfW / Math.max(1e-6, body.chest.halfD);
  const referenceW = Math.sqrt(aspect);
  const referenceD = 1 / referenceW;
  const scale =
    finishedCircumference /
    ellipseCircumference(referenceW, referenceD);
  return {
    halfW: referenceW * scale,
    halfD: referenceD * scale,
    finishedCircumference,
  };
}

function ellipseAngleAtArcFraction(
  halfW: number,
  halfD: number,
  start: number,
  end: number,
  fraction: number,
): number {
  const steps = 64;
  const cumulative = new Float64Array(steps + 1);
  let total = 0;
  let previousX = halfW * Math.cos(start);
  let previousZ = halfD * Math.sin(start);
  for (let step = 1; step <= steps; step++) {
    const angle = start + ((end - start) * step) / steps;
    const x = halfW * Math.cos(angle);
    const z = halfD * Math.sin(angle);
    total += Math.hypot(x - previousX, z - previousZ);
    cumulative[step] = total;
    previousX = x;
    previousZ = z;
  }
  const target = Math.min(1, Math.max(0, fraction)) * total;
  let upper = 1;
  while (upper < steps && cumulative[upper]! < target) upper++;
  const lower = Math.max(0, upper - 1);
  const interval = cumulative[upper]! - cumulative[lower]!;
  const local =
    interval <= 1e-12 ? 0 : (target - cumulative[lower]!) / interval;
  return start + ((end - start) * (lower + local)) / steps;
}

function frontSurfacePosition(
  piece: DraftPiece,
  uv: UV,
  shell: TorsoShell,
  side: 'left' | 'right',
  normalOffset = 0,
): [number, number, number] {
  const halfW = shell.halfW;
  const halfD = shell.halfD;
  const across = 1 - outlineU01(piece, uv[0]);
  const angle = ellipseAngleAtArcFraction(
    halfD,
    halfW,
    0,
    Math.PI * 0.5,
    across,
  );
  const sign = side === 'left' ? -1 : 1;
  let x = sign * halfW * Math.sin(angle);
  let z = halfD * Math.cos(angle);
  if (normalOffset > 0) {
    const nx0 = x / Math.max(halfW * halfW, 1e-9);
    const nz0 = z / Math.max(halfD * halfD, 1e-9);
    const inverseLength = 1 / Math.max(1e-9, Math.hypot(nx0, nz0));
    x += nx0 * inverseLength * normalOffset;
    z += nz0 * inverseLength * normalOffset;
  }
  return [x, piece.topY - uv[1] * piece.height, z];
}

function outlineU01(piece: DraftPiece, u: number): number {
  const values = piece.outline.map((point) => point[0]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return Math.min(
    1,
    Math.max(0, (u - minimum) / Math.max(1e-9, maximum - minimum)),
  );
}

function nearestRunProjection(
  piece: DraftPiece,
  point: UV,
  run: EdgeRun,
): { distance: number; fraction: number } {
  const px = point[0] * piece.width;
  const py = point[1] * piece.height;
  const edges = cyclicIndices(run.from, run.to, piece.outline.length).slice(
    0,
    -1,
  );
  const lengths = edges.map((edge) => {
    const a = piece.outline[edge]!;
    const b = piece.outline[(edge + 1) % piece.outline.length]!;
    return Math.hypot(
      (b[0] - a[0]) * piece.width,
      (b[1] - a[1]) * piece.height,
    );
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let traversed = 0;
  let bestDistance = Infinity;
  let bestFraction = 0;
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index]!;
    const a = piece.outline[edge]!;
    const b = piece.outline[(edge + 1) % piece.outline.length]!;
    const ax = a[0] * piece.width;
    const ay = a[1] * piece.height;
    const bx = b[0] * piece.width;
    const by = b[1] * piece.height;
    const dx = bx - ax;
    const dy = by - ay;
    const local = Math.min(
      1,
      Math.max(
        0,
        ((px - ax) * dx + (py - ay) * dy) /
          Math.max(1e-12, dx * dx + dy * dy),
      ),
    );
    const distance = Math.hypot(
      px - ax - dx * local,
      py - ay - dy * local,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestFraction =
        total <= 1e-9
          ? 0
          : (traversed + local * lengths[index]!) / total;
    }
    traversed += lengths[index]!;
  }
  return { distance: bestDistance, fraction: bestFraction };
}

function quadraticPoint(
  a: readonly [number, number, number],
  control: readonly [number, number, number],
  b: readonly [number, number, number],
  fraction: number,
): [number, number, number] {
  const t = Math.min(1, Math.max(0, fraction));
  const inverse = 1 - t;
  return [0, 1, 2].map(
    (axis) =>
      inverse * inverse * a[axis]! +
      2 * inverse * t * control[axis]! +
      t * t * b[axis]!,
  ) as [number, number, number];
}

function placeFronts(
  mesh: ClothMeshData,
  piece: DraftPiece,
  shell: TorsoShell,
): void {
  const panelSize = mesh.resolution * mesh.resolution;
  for (let panel = 0; panel < 2; panel++) {
    const side = panel === 0 ? 'left' : 'right';
    for (let local = 0; local < panelSize; local++) {
      const particle = panel * panelSize + local;
      if (mesh.invMasses[particle]! <= 0) continue;
      const uv = flatParticleUV(mesh, piece, particle);
      const world = frontSurfacePosition(piece, uv, shell, side);
      mesh.positions[particle * 4] = world[0];
      mesh.positions[particle * 4 + 1] = world[1];
      mesh.positions[particle * 4 + 2] = world[2];
    }
  }
}

function placeBack(
  mesh: ClothMeshData,
  piece: DraftPiece,
  shell: TorsoShell,
): void {
  const halfW = shell.halfW;
  const halfD = shell.halfD;
  for (let particle = 0; particle < mesh.count; particle++) {
    if (mesh.invMasses[particle]! <= 0) continue;
    const [u] = flatParticleUV(mesh, piece, particle);
    const angle = ellipseAngleAtArcFraction(
      halfW,
      halfD,
      Math.PI,
      2 * Math.PI,
      outlineU01(piece, u),
    );
    mesh.positions[particle * 4] = halfW * Math.cos(angle);
    mesh.positions[particle * 4 + 2] = halfD * Math.sin(angle);
  }
}

/**
 * Fold a shallow neighbourhood toward the sagittal shoulder line. A shoulder
 * is a bend in one continuous sheet: snapping just its edge collapses the first
 * triangles, while rotating the whole panel turns the torso into a cone.
 * Scaling the already-smooth depth field keeps the fold itself continuous.
 */
function applyLocalShoulderFold(
  mesh: ClothMeshData,
  panel: number,
  flatPositions: Float32Array,
  shoulderCells: readonly number[],
  radiusM = 0.18,
): void {
  if (!shoulderCells.length) return;
  const n = mesh.resolution;
  const panelSize = n * n;
  const first = panel * panelSize;
  const anchors = [...new Set(shoulderCells)];

  for (let local = 0; local < panelSize; local++) {
    const particle = first + local;
    if (mesh.invMasses[particle]! <= 0) continue;
    const flatOffset = particle * 4;
    let nearest = Infinity;
    for (const anchor of anchors) {
      const anchorOffset = (first + anchor) * 4;
      nearest = Math.min(
        nearest,
        Math.hypot(
          flatPositions[flatOffset]! - flatPositions[anchorOffset]!,
          flatPositions[flatOffset + 1]! - flatPositions[anchorOffset + 1]!,
        ),
      );
    }
    if (!Number.isFinite(nearest) || nearest >= radiusM) continue;
    const proximity = Math.max(0, 1 - nearest / radiusM);
    const fade = proximity * proximity * (3 - 2 * proximity);
    mesh.positions[particle * 4 + 2] =
      mesh.positions[particle * 4 + 2]! * (1 - fade);
  }
}

/** Fold the front/back shoulder allowances together without moving the hem. */
function preFoldBodyShoulders(
  front: ClothMeshData,
  back: ClothMeshData,
  frontFlatPositions: Float32Array,
  backFlatPositions: Float32Array,
  frontPiece: DraftPiece,
  unfoldedBack: UnfoldedPiece,
  frontShoulder: EdgeRun,
  backShoulder: EdgeRun,
  n: number,
): void {
  const frontShoulderCells: number[][] = [[], []];
  const backShoulderCells: number[] = [];
  for (const [panel, side] of [
    [0, 'left'],
    [1, 'right'],
  ] as const) {
    const pair = pairedEdges(
      frontPiece,
      unfoldedBack.piece,
      frontShoulder,
      mappedRun(unfoldedBack, backShoulder, side),
      n,
      side === 'right',
    );
    frontShoulderCells[panel]!.push(...pair.a);
    backShoulderCells.push(...pair.b);
  }
  applyLocalShoulderFold(front, 0, frontFlatPositions, frontShoulderCells[0]!);
  applyLocalShoulderFold(front, 1, frontFlatPositions, frontShoulderCells[1]!);
  applyLocalShoulderFold(back, 0, backFlatPositions, backShoulderCells);
}

type ArmFrame3 = {
  centre: [number, number, number];
  sideNormal: [number, number, number];
  frontNormal: [number, number, number];
};

function normalised3(
  vector: readonly [number, number, number],
): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [1, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function armFrame(
  side: 'left' | 'right',
  body: BodyMeasure,
  along: number,
): ArmFrame3 {
  const sign = side === 'right' ? 1 : -1;
  let centre: [number, number, number];
  let tangent: [number, number, number];

  if (body.arm) {
    const rootX = body.arm.rootX + 0.02025;
    const x = rootX + along;
    const sample = (sampleX: number): [number, number, number] => {
      const path = body.arm?.path;
      if (!path || path.length < 2) {
        return [sampleX, body.arm!.y - 0.003, body.arm!.z + 0.004];
      }
      let upper = 1;
      while (upper < path.length && path[upper]!.x < sampleX) upper++;
      if (sampleX <= path[0]!.x) {
        return [sampleX, path[0]!.y - 0.003, path[0]!.z + 0.004];
      }
      if (upper >= path.length) {
        const last = path[path.length - 1]!;
        return [sampleX, last.y - 0.003, last.z + 0.004];
      }
      const previous = path[upper - 1]!;
      const next = path[upper]!;
      const fraction =
        (sampleX - previous.x) / Math.max(1e-9, next.x - previous.x);
      return [
        sampleX,
        previous.y + (next.y - previous.y) * fraction - 0.003,
        previous.z + (next.z - previous.z) * fraction + 0.004,
      ];
    };
    const point = sample(x);
    centre = [sign * point[0], point[1], point[2]];
    const before = sample(Math.max(rootX, x - 0.012));
    const after = sample(x + 0.012);
    tangent = normalised3([
      sign * (after[0] - before[0]),
      after[1] - before[1],
      after[2] - before[2],
    ]);
  } else {
    const theta = Math.atan2(0.25, 0.6);
    tangent = [sign * Math.sin(theta), -Math.cos(theta), 0];
    const root: [number, number, number] = [
      sign * (body.shoulderHalfW - 0.00475),
      body.shoulderY - 0.003,
      0.004,
    ];
    centre = [
      root[0] + tangent[0] * along,
      root[1] + tangent[1] * along,
      root[2],
    ];
  }

  // Project world +Z into the cross-section plane, then cross it with the
  // tangent. This transports a stable front/down frame along the measured
  // curve without twisting the authored front/back cap identities.
  const frontDot = tangent[2];
  let frontNormal = normalised3([
    -tangent[0] * frontDot,
    -tangent[1] * frontDot,
    1 - tangent[2] * frontDot,
  ]);
  if (Math.abs(frontNormal[2]) < 0.25) frontNormal = [0, 0, 1];
  const sideNormal = normalised3([
    frontNormal[1] * tangent[2] - frontNormal[2] * tangent[1],
    frontNormal[2] * tangent[0] - frontNormal[0] * tangent[2],
    frontNormal[0] * tangent[1] - frontNormal[1] * tangent[0],
  ]);
  return { centre, sideNormal, frontNormal };
}

/**
 * Orient a closed sleeve section around its arm axis. The authored underarm
 * edges live at u=0/1 and must meet on the lower/inside generatrix, while the
 * middle of the sleeve cap (u≈0.5) must sit over the deltoid. The previous
 * zero-angle convention put the seam in front and the cap behind the arm,
 * forcing the rigid dressing fit to pull the whole tube downward.
 */
function sleeveWrapAngle(
  side: 'left' | 'right',
  fraction: number,
): number {
  // capB carries the front-notch in the supplied A0 pattern, so it occupies
  // +Z; capA occupies the back (-Z). The quarter turn keeps u=0/1 underneath
  // and u≈0.5 over the deltoid on both mirrored sleeves.
  const authoredAngle = 2 * Math.PI * fraction + Math.PI / 2;
  return (side === 'right' ? -1 : 1) * authoredAngle;
}

/** End of the cap-to-shaft transition used by both wrapping and anchoring. */
function sleeveShaftStartV(piece: DraftPiece, cap: EdgeRun): number {
  const capEndV = Math.max(
    piece.outline[cap.from]![1],
    piece.outline[cap.to]![1],
  );
  return Math.min(1, capEndV + 0.18);
}

/**
 * Wrap the tapered shaft row-by-row. Below the sleeve cap, both authored
 * underarm edges must map to the same lower generatrix; using the global piece
 * width left a 50–60° wedge open at the wrist. The cap itself keeps its global
 * parameterisation so its curved sewing edge remains a shaped sleeve head.
 */
function sleeveSection(
  mesh: ClothMeshData,
  panel: number,
  piece: DraftPiece,
  cap: EdgeRun,
  local: number,
  u: number,
  v: number,
): { fraction: number; radius: number } {
  const globalFraction = outlineU01(piece, u);
  const globalRadius = Math.max(0.048, piece.width / (2 * Math.PI));
  const n = mesh.resolution;
  const row = Math.floor(local / n);
  const column = local % n;
  const panelFirst = panel * n * n;
  let left = n;
  let right = -1;
  for (let candidate = 0; candidate < n; candidate++) {
    if (mesh.invMasses[panelFirst + row * n + candidate]! <= 0) continue;
    left = Math.min(left, candidate);
    right = Math.max(right, candidate);
  }
  if (right <= left) return { fraction: globalFraction, radius: globalRadius };

  const shaftStartV = Math.max(
    piece.outline[cap.from]![1],
    piece.outline[cap.to]![1],
  );
  // Spread the change over roughly the upper 12 cm of the shaft. A one-row
  // switch closes the wedge too, but shears that row by more than 5×.
  const transitionStart = shaftStartV - 0.005;
  const transitionEnd = sleeveShaftStartV(piece, cap);
  const rawBlend = Math.min(
    1,
    Math.max(
      0,
      (v - transitionStart) /
        Math.max(1e-6, transitionEnd - transitionStart),
    ),
  );
  const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
  // Use the contiguous live raster columns rather than individually snapped
  // boundary UVs. Two neighbouring cut-edge cells can snap to different
  // outline segments; using those UVs made one structural edge 5× too long.
  const localFraction = Math.min(
    1,
    Math.max(0, (column - left) / Math.max(1, right - left)),
  );
  const localRadius = Math.max(
    0.035,
    (((right - left) / Math.max(1, n - 1)) * piece.width) / (2 * Math.PI),
  );
  return {
    fraction: globalFraction + (localFraction - globalFraction) * blend,
    radius: globalRadius + (localRadius - globalRadius) * blend,
  };
}

function placeSleevePanel(
  mesh: ClothMeshData,
  panel: number,
  piece: DraftPiece,
  cap: EdgeRun,
  body: BodyMeasure,
  side: 'left' | 'right',
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  for (let local = 0; local < panelSize; local++) {
    const particle = panel * panelSize + local;
    if (mesh.invMasses[particle]! <= 0) continue;
    const [u, v] = flatParticleUV(mesh, piece, particle);
    const section = sleeveSection(mesh, panel, piece, cap, local, u, v);
    // The second cut sleeve is a true mirror of the first. Mirroring the
    // angular parameter keeps its authored front/back cap identities intact;
    // swapping cap halves later would sew the front notch into the back armhole.
    const angle = sleeveWrapAngle(side, section.fraction);
    const along = v * piece.height;
    const frame = armFrame(side, body, along);
    const radialSide = Math.sin(angle) * section.radius;
    const radialFront = Math.cos(angle) * section.radius;
    mesh.positions[particle * 4] =
      frame.centre[0] +
      frame.sideNormal[0] * radialSide +
      frame.frontNormal[0] * radialFront;
    mesh.positions[particle * 4 + 1] =
      frame.centre[1] +
      frame.sideNormal[1] * radialSide +
      frame.frontNormal[1] * radialFront;
    mesh.positions[particle * 4 + 2] =
      frame.centre[2] +
      frame.sideNormal[2] * radialSide +
      frame.frontNormal[2] * radialFront;
  }
}

/**
 * Pre-form only the sleeve head toward its authored armscye stitches. The
 * shaft is a correctly centred tube around the arm and must not follow this
 * displacement. This runs after rigid accessory placement so the residual of
 * a sleeve seam cannot alter the hood or rib-band fit. Dirichlet displacements
 * on the cap seam are diffused through the live raster with a zero boundary at
 * the end of the wrap transition, producing a smooth local fold instead of
 * translating the complete sleeve away from the avatar.
 */
function preShapeSleeveCaps(
  mesh: ClothMeshData,
  capSeams: readonly CrossSeam[],
  underarmPairs: readonly { i: number; j: number }[],
  sleeveOffset: number,
  sleevePiece: DraftPiece,
  cap: EdgeRun,
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  const sleeveCount = 2 * panelSize;
  const shaftRow = Math.ceil(sleeveShaftStartV(sleevePiece, cap) * (n - 1));
  const targetSums = new Float64Array(sleeveCount * 3);
  const targetCounts = new Uint16Array(sleeveCount);

  for (const seam of capSeams) {
    const sleeveParticle = seam.j - sleeveOffset;
    if (sleeveParticle < 0 || sleeveParticle >= sleeveCount) continue;
    const sourceOffset = seam.j * 4;
    const targetOffset = seam.i * 4;
    for (let axis = 0; axis < 3; axis++) {
      const targetIndex = sleeveParticle * 3 + axis;
      targetSums[targetIndex] =
        targetSums[targetIndex]! +
        mesh.positions[targetOffset + axis]! -
        mesh.positions[sourceOffset + axis]!;
    }
    targetCounts[sleeveParticle] = targetCounts[sleeveParticle]! + 1;
  }

  for (let panel = 0; panel < 2; panel++) {
    const panelFirst = panel * panelSize;
    let displacement = new Float64Array(panelSize * 3);
    let next = new Float64Array(panelSize * 3);
    const fixed = new Uint8Array(panelSize);

    for (let local = 0; local < panelSize; local++) {
      const sleeveParticle = panelFirst + local;
      const particle = sleeveOffset + sleeveParticle;
      if (mesh.invMasses[particle]! <= 0) continue;
      const targetCount = targetCounts[sleeveParticle]!;
      if (targetCount > 0) {
        fixed[local] = 1;
        for (let axis = 0; axis < 3; axis++) {
          displacement[local * 3 + axis] =
            (SLEEVE_CAP_PRE_SHAPE *
              targetSums[sleeveParticle * 3 + axis]!) /
            targetCount;
        }
      } else if (Math.floor(local / n) >= shaftRow) {
        fixed[local] = 2;
      }
    }

    // Jacobi relaxation of the three displacement components. A fixed number
    // keeps the result deterministic across browsers and is ample for the
    // roughly 22-row cap domain at the largest workshop resolution.
    for (let iteration = 0; iteration < 8 * n; iteration++) {
      next.set(displacement);
      for (let local = 0; local < panelSize; local++) {
        if (fixed[local] !== 0) continue;
        const particle = sleeveOffset + panelFirst + local;
        if (mesh.invMasses[particle]! <= 0) continue;
        const row = Math.floor(local / n);
        if (row >= shaftRow) continue;
        const column = local % n;
        const neighbours: number[] = [];
        if (column > 0) neighbours.push(local - 1);
        if (column + 1 < n) neighbours.push(local + 1);
        if (row > 0) neighbours.push(local - n);
        if (row + 1 < n) neighbours.push(local + n);
        let liveNeighbours = 0;
        const sum = [0, 0, 0];
        for (const neighbour of neighbours) {
          if (
            mesh.invMasses[sleeveOffset + panelFirst + neighbour]! <= 0
          ) {
            continue;
          }
          liveNeighbours++;
          for (let axis = 0; axis < 3; axis++) {
            sum[axis] =
              sum[axis]! + displacement[neighbour * 3 + axis]!;
          }
        }
        if (liveNeighbours <= 0) continue;
        for (let axis = 0; axis < 3; axis++) {
          next[local * 3 + axis] = sum[axis]! / liveNeighbours;
        }
      }
      [displacement, next] = [next, displacement];
    }

    // Linear blending alone can make two neighbouring rows cross where the
    // cap turns sharply into the armscye. Relax the harmonic target through a
    // small position-based cloth solve: cap stitches remain soft targets, the
    // shaft is immovable, and original warp/weft/bias distances are restored.
    // This lets the excess cap length buckle in 3D instead of being crushed.
    const original = new Float64Array(panelSize * 3);
    const desired = new Float64Array(panelSize * 3);
    const deformed = new Float64Array(panelSize * 3);
    for (let local = 0; local < panelSize; local++) {
      const particle = sleeveOffset + panelFirst + local;
      for (let axis = 0; axis < 3; axis++) {
        const source = mesh.positions[particle * 4 + axis]!;
        original[local * 3 + axis] = source;
        desired[local * 3 + axis] =
          source + displacement[local * 3 + axis]!;
        deformed[local * 3 + axis] = desired[local * 3 + axis]!;
      }
    }
    const edgeDirections = [
      [1, 0],
      [0, 1],
      [1, 1],
      [-1, 1],
    ] as const;
    const live = (local: number): boolean =>
      mesh.invMasses[sleeveOffset + panelFirst + local]! > 0;
    const closeUnderarm = (strength: number): void => {
      for (const pair of underarmPairs) {
        if (!live(pair.i) || !live(pair.j)) continue;
        const mobilityA = Math.floor(pair.i / n) < shaftRow ? 1 : 0;
        const mobilityB = Math.floor(pair.j / n) < shaftRow ? 1 : 0;
        const mobility = mobilityA + mobilityB;
        if (mobility <= 0) continue;
        const a = pair.i * 3;
        const b = pair.j * 3;
        for (let axis = 0; axis < 3; axis++) {
          const delta = deformed[b + axis]! - deformed[a + axis]!;
          const correction = (strength * delta) / mobility;
          deformed[a + axis] =
            deformed[a + axis]! + correction * mobilityA;
          deformed[b + axis] =
            deformed[b + axis]! - correction * mobilityB;
        }
      }
    };
    const clothEdges: Array<{
      a: number;
      b: number;
      restLength: number;
      referenceLength: number;
      weightA: number;
      weightB: number;
    }> = [];
    const constraintRest = new Map<number, number>();
    const constraintView = new DataView(mesh.constraintData);
    const globalFirst = sleeveOffset + panelFirst;
    const globalLast = globalFirst + panelSize;
    for (let constraint = 0; constraint < mesh.constraintCount; constraint++) {
      const offset = constraint * 16;
      const kind = constraintView.getUint32(offset + 12, true);
      if (
        kind !== ConstraintKind.Structural &&
        kind !== ConstraintKind.StructuralWarp &&
        kind !== ConstraintKind.Shear
      ) {
        continue;
      }
      const globalA = constraintView.getUint32(offset, true);
      const globalB = constraintView.getUint32(offset + 4, true);
      if (
        globalA < globalFirst || globalA >= globalLast ||
        globalB < globalFirst || globalB >= globalLast
      ) {
        continue;
      }
      const localA = globalA - globalFirst;
      const localB = globalB - globalFirst;
      const minimum = Math.min(localA, localB);
      const maximum = Math.max(localA, localB);
      constraintRest.set(
        minimum * panelSize + maximum,
        constraintView.getFloat32(offset + 8, true),
      );
    }
    for (let localA = 0; localA < panelSize; localA++) {
      if (!live(localA)) continue;
      const rowA = Math.floor(localA / n);
      const columnA = localA % n;
      for (const [columnStep, rowStep] of edgeDirections) {
        const rowB = rowA + rowStep;
        const columnB = columnA + columnStep;
        if (rowB >= n || columnB < 0 || columnB >= n) continue;
        const localB = rowB * n + columnB;
        if (!live(localB)) continue;
        const weightA = rowA < shaftRow ? 1 : 0;
        const weightB = rowB < shaftRow ? 1 : 0;
        if (weightA + weightB <= 0) continue;
        const ax = original[localA * 3]!;
        const ay = original[localA * 3 + 1]!;
        const az = original[localA * 3 + 2]!;
        const bx = original[localB * 3]!;
        const by = original[localB * 3 + 1]!;
        const bz = original[localB * 3 + 2]!;
        const referenceLength = Math.hypot(bx - ax, by - ay, bz - az);
        if (referenceLength <= 1e-9) continue;
        const minimum = Math.min(localA, localB);
        const maximum = Math.max(localA, localB);
        const restLength =
          constraintRest.get(minimum * panelSize + maximum) ?? referenceLength;
        clothEdges.push({
          a: localA,
          b: localB,
          restLength,
          referenceLength,
          weightA,
          weightB,
        });
      }
    }
    for (let iteration = 0; iteration < 4 * n; iteration++) {
      for (let local = 0; local < panelSize; local++) {
        if (!live(local)) continue;
        const row = Math.floor(local / n);
        if (row >= shaftRow) {
          for (let axis = 0; axis < 3; axis++) {
            deformed[local * 3 + axis] = original[local * 3 + axis]!;
          }
          continue;
        }
        const capTarget = targetCounts[panelFirst + local]! > 0;
        const attraction = capTarget ? 0.5 : 0.008;
        for (let axis = 0; axis < 3; axis++) {
          deformed[local * 3 + axis] =
            deformed[local * 3 + axis]! +
            attraction *
              (desired[local * 3 + axis]! -
                deformed[local * 3 + axis]!);
        }
      }

      const reverse = iteration % 2 === 1;
      for (let step = 0; step < clothEdges.length; step++) {
        const edge = clothEdges[reverse ? clothEdges.length - 1 - step : step]!;
        const a = edge.a * 3;
        const b = edge.b * 3;
        let dx = deformed[b]! - deformed[a]!;
        let dy = deformed[b + 1]! - deformed[a + 1]!;
        let dz = deformed[b + 2]! - deformed[a + 2]!;
        const length = Math.hypot(dx, dy, dz);
        let distanceError: number;
        if (length <= 1e-9) {
          dx = (original[b]! - original[a]!) / edge.referenceLength;
          dy = (original[b + 1]! - original[a + 1]!) / edge.referenceLength;
          dz = (original[b + 2]! - original[a + 2]!) / edge.referenceLength;
          distanceError = -edge.referenceLength;
        } else {
          dx /= length;
          dy /= length;
          dz /= length;
          distanceError = length - edge.referenceLength;
        }
        const correction =
          (0.9 * distanceError) / (edge.weightA + edge.weightB);
        const correctionA = correction * edge.weightA;
        const correctionB = correction * edge.weightB;
        deformed[a] = deformed[a]! + dx * correctionA;
        deformed[a + 1] = deformed[a + 1]! + dy * correctionA;
        deformed[a + 2] = deformed[a + 2]! + dz * correctionA;
        deformed[b] = deformed[b]! - dx * correctionB;
        deformed[b + 1] = deformed[b + 1]! - dy * correctionB;
        deformed[b + 2] = deformed[b + 2]! - dz * correctionB;
      }
      // The underarm was already a closed tube before cap shaping. Diffusing
      // the armscye displacement without this projection reopened its upper
      // end by up to 5 cm, so the solver had to choose between the armhole and
      // the sleeve seam and produced the visible wing. Keep the mobile cap
      // portion paired while the fixed shaft remains on the measured arm.
      closeUnderarm(0.55);
    }

    // Distance constraints alone cannot distinguish a preserved edge from the
    // same edge flipped through 180°. Keep a signed projection in the original
    // yarn direction so no warp, weft or bias edge can invert. Cap stitches
    // have a small mobility (rather than zero) to let the barrier resolve the
    // rare conflict without opening the armscye; the shaft remains immovable.
    const cleanupMobility = (local: number, shaftWeight: number): number =>
      shaftWeight <= 0
        ? 0
        : targetCounts[panelFirst + local]! > 0
          ? SLEEVE_CAP_EDGE_MOBILITY
          : 1;
    for (let sweep = 0; sweep < n; sweep++) {
      const reverse = sweep % 2 === 1;
      // Re-project lengths between signed-barrier passes. Without this paired
      // projection, resolving several neighbouring inversions can merely move
      // the error into one greatly stretched edge.
      for (let step = 0; step < clothEdges.length; step++) {
        const edge = clothEdges[reverse ? clothEdges.length - 1 - step : step]!;
        const a = edge.a * 3;
        const b = edge.b * 3;
        let dx = deformed[b]! - deformed[a]!;
        let dy = deformed[b + 1]! - deformed[a + 1]!;
        let dz = deformed[b + 2]! - deformed[a + 2]!;
        const length = Math.hypot(dx, dy, dz);
        let distanceError: number;
        if (length <= 1e-9) {
          dx = (original[b]! - original[a]!) / edge.referenceLength;
          dy = (original[b + 1]! - original[a + 1]!) / edge.referenceLength;
          dz = (original[b + 2]! - original[a + 2]!) / edge.referenceLength;
          distanceError = -edge.referenceLength;
        } else {
          dx /= length;
          dy /= length;
          dz /= length;
          distanceError = length - edge.referenceLength;
        }
        const mobilityA = cleanupMobility(edge.a, edge.weightA);
        const mobilityB = cleanupMobility(edge.b, edge.weightB);
        const mobility = mobilityA + mobilityB;
        if (mobility <= 0) continue;
        const correction = (0.75 * distanceError) / mobility;
        deformed[a] = deformed[a]! + correction * dx * mobilityA;
        deformed[a + 1] = deformed[a + 1]! + correction * dy * mobilityA;
        deformed[a + 2] = deformed[a + 2]! + correction * dz * mobilityA;
        deformed[b] = deformed[b]! - correction * dx * mobilityB;
        deformed[b + 1] = deformed[b + 1]! - correction * dy * mobilityB;
        deformed[b + 2] = deformed[b + 2]! - correction * dz * mobilityB;
      }
      for (let step = 0; step < clothEdges.length; step++) {
        const edge = clothEdges[reverse ? clothEdges.length - 1 - step : step]!;
        const a = edge.a * 3;
        const b = edge.b * 3;
        const ux = (original[b]! - original[a]!) / edge.referenceLength;
        const uy = (original[b + 1]! - original[a + 1]!) / edge.referenceLength;
        const uz = (original[b + 2]! - original[a + 2]!) / edge.referenceLength;
        const projection =
          (deformed[b]! - deformed[a]!) * ux +
          (deformed[b + 1]! - deformed[a + 1]!) * uy +
          (deformed[b + 2]! - deformed[a + 2]!) * uz;
        const deficit =
          SLEEVE_MIN_SIGNED_EDGE_RATIO * edge.restLength - projection;
        if (deficit <= 0) continue;
        const mobilityA = cleanupMobility(edge.a, edge.weightA);
        const mobilityB = cleanupMobility(edge.b, edge.weightB);
        const mobility = mobilityA + mobilityB;
        if (mobility <= 0) continue;
        const correction = deficit / mobility;
        deformed[a] = deformed[a]! - correction * ux * mobilityA;
        deformed[a + 1] = deformed[a + 1]! - correction * uy * mobilityA;
        deformed[a + 2] = deformed[a + 2]! - correction * uz * mobilityA;
        deformed[b] = deformed[b]! + correction * ux * mobilityB;
        deformed[b + 1] = deformed[b + 1]! + correction * uy * mobilityB;
        deformed[b + 2] = deformed[b + 2]! + correction * uz * mobilityB;
      }
      closeUnderarm(0.4);
    }

    for (let local = 0; local < panelSize; local++) {
      const particle = sleeveOffset + panelFirst + local;
      if (mesh.invMasses[particle]! <= 0) continue;
      for (let axis = 0; axis < 3; axis++) {
        mesh.positions[particle * 4 + axis] = deformed[local * 3 + axis]!;
      }
    }
  }
}

function hoodCollisionClearance(
  mesh: ClothMeshData,
  particle: number,
): number {
  return (
    HOOD_CONTACT_THICKNESS_M +
    (mesh.layers?.[particle] ?? 0) * HOOD_CONTACT_THICKNESS_M +
    HOOD_CONTACT_SAFETY_M
  );
}

/**
 * Give the hood its own continuous body-contact shell. The neckline remains
 * on layer zero so it can meet the bodice; the rest reaches layer one over
 * roughly five centimetres of pattern depth and therefore keeps a real hood
 * volume (12 mm at runtime with the default knit), instead of collapsing into
 * a skin-tight cap.
 */
function withHoodCollisionLayers(
  mesh: ClothMeshData,
  piece: DraftPiece,
  neckline: EdgeRun,
): ClothMeshData {
  const layers = new Float32Array(mesh.count);
  for (let particle = 0; particle < mesh.count; particle++) {
    if (mesh.invMasses[particle]! <= 0) continue;
    const uv = flatParticleUV(mesh, piece, particle);
    const distance = nearestRunProjection(piece, uv, neckline).distance;
    const linear = Math.min(1, Math.max(0, distance / 0.05));
    layers[particle] = linear * linear * (3 - 2 * linear);
  }
  return { ...mesh, layers };
}

/**
 * Clamp one hood point to a polar envelope of the real body SDF.
 *
 * A nearest-gradient projection can eject adjacent vertices through opposite
 * sides of the skull. Following the current radial component at fixed
 * (y, theta) preserves the panel side and exits whichever body component
 * actually contains the point (torso, head or deltoid).
 */
// v200 : l'enveloppe radiale de placement pousse chaque cellule juste hors du
// corps le long d'un rayon. Sur un corps en T-POSE, à hauteur d'épaule, cette
// marche peut ENTRER dans le bras horizontal et ressortir de l'autre côté : la
// cellule du torse atterrit sur la face externe du bras, à 30-70× la maille de
// ses voisines restées sur le torse — le vêtement naît disloqué et convulse en
// « cape » au premier pas de simulation (incident Mia FV2_T). On NE plafonne
// PAS la marche (l'éjection légitime du trapèze sur un corps naturel la dépasse
// largement, et la borner casse l'embu du col de capuche) : la téléportation
// est neutralisée APRÈS coup, dans makePolarBodyPlacementSafe, en annulant les
// seules cellules isolées de leurs voisines de grille.
function hoodRadialEnvelope(
  sd: Sd,
  point: readonly [number, number, number],
  clearance: number,
  fallbackSign: -1 | 1,
  // Défaut = 0,4 m, la portée de recherche historique (capuche + col) : le
  // torse passe explicitement le plafond serré de 0,045 m.
  maxTravel = 0.4,
): Point3 {
  const y = point[1];
  const radius = Math.hypot(point[0], point[2]);
  let directionX = radius > 1e-7 ? point[0] / radius : fallbackSign;
  let directionZ = radius > 1e-7 ? point[2] / radius : 0;
  const directionLength = Math.hypot(directionX, directionZ);
  directionX /= Math.max(1e-9, directionLength);
  directionZ /= Math.max(1e-9, directionLength);

  const distanceAt = (radial: number): number =>
    sd(directionX * radial, y, directionZ * radial);
  if (distanceAt(radius) >= clearance) {
    return [point[0], point[1], point[2]];
  }

  let lower = radius;
  let upper = 0;
  for (let radial = radius + 0.004; radial <= radius + maxTravel; radial += 0.004) {
    if (distanceAt(radial) >= clearance) {
      upper = radial;
      break;
    }
    lower = radial;
  }

  if (upper <= lower) return [point[0], point[1], point[2]];
  for (let iteration = 0; iteration < 10; iteration++) {
    const middle = (lower + upper) / 2;
    if (distanceAt(middle) < clearance) lower = middle;
    else upper = middle;
  }
  const safeRadius = (lower + upper) / 2;
  if (safeRadius - radius > maxTravel) return [point[0], point[1], point[2]];
  return [directionX * safeRadius, y, directionZ * safeRadius];
}

/**
 * Keep the paired hood centre seam on the sagittal plane while giving it the
 * same body clearance as the surrounding panels. A generic radial projection
 * may choose opposite X directions when a crown sample sits at x=z=0; moving
 * strictly along the seam's current front/back direction avoids that split.
 */
function hoodSagittalEnvelope(
  sd: Sd,
  point: readonly [number, number, number],
  clearance: number,
): Point3 {
  const y = point[1];
  const initialZ = point[2];
  if (sd(0, y, initialZ) >= clearance) return [0, y, initialZ];

  // The centre curve is authored from the back neckline over the crown to the
  // face opening. Preserve that local side; an exactly centred sample defaults
  // to the back, where the centre seam is meant to lie.
  const directionZ = initialZ > 1e-7 ? 1 : -1;
  let lower = Math.abs(initialZ);
  let upper = 0;
  for (
    let radial = lower + 0.004;
    radial <= lower + 0.4;
    radial += 0.004
  ) {
    if (sd(0, y, directionZ * radial) >= clearance) {
      upper = radial;
      break;
    }
    lower = radial;
  }
  if (upper <= lower) return [0, y, initialZ];
  for (let iteration = 0; iteration < 10; iteration++) {
    const middle = (lower + upper) / 2;
    if (sd(0, y, directionZ * middle) < clearance) lower = middle;
    else upper = middle;
  }
  return [0, y, directionZ * ((lower + upper) / 2)];
}

/**
 * The hood neckline is sewn to the torso neckline, so its pre-dressing target
 * must stay on the first body shell and never jump across the shoulder gap to
 * the far side of a deltoid.
 */
function hoodFirstRadialEnvelope(
  sd: Sd,
  point: Point3,
  clearance: number,
  fallbackSign: -1 | 1,
): Point3 {
  const radius = Math.hypot(point[0], point[2]);
  let directionX = radius > 1e-7 ? point[0] / radius : fallbackSign;
  let directionZ = radius > 1e-7 ? point[2] / radius : 0;
  const directionLength = Math.hypot(directionX, directionZ);
  directionX /= Math.max(1e-9, directionLength);
  directionZ /= Math.max(1e-9, directionLength);
  const distanceAt = (radial: number): number =>
    sd(directionX * radial, point[1], directionZ * radial);
  // A neckline stitch is authored from the already placed bodice edge. Keep
  // that exact sewing position whenever it already clears the avatar; forcing
  // every safe stitch back onto the first SDF shell separates the hood from a
  // deliberately loose garment neckline (especially across broad shoulders).
  if (distanceAt(radius) >= clearance) return [...point];
  if (distanceAt(0) >= clearance) return [...point];
  let lower = 0;
  let upper = 0;
  for (let radial = 0.004; radial <= 0.6; radial += 0.004) {
    if (distanceAt(radial) >= clearance) {
      upper = radial;
      break;
    }
    lower = radial;
  }
  if (upper <= lower) return [...point];
  for (let iteration = 0; iteration < 10; iteration++) {
    const middle = (lower + upper) / 2;
    if (distanceAt(middle) < clearance) lower = middle;
    else upper = middle;
  }
  const safeRadius = (lower + upper) / 2;
  return [directionX * safeRadius, point[1], directionZ * safeRadius];
}

// Au-delà de cette distance à un voisin de grille vivant, une cellule n'a pas
// été « ajustée » mais TÉLÉPORTÉE : l'embu du col ou d'une pince reste bien en
// deçà (< 6 cm), une cellule projetée à travers un bras en T saute 30 cm et
// plus. Seuil sous le plafond du test de non-régression (12 cm) pour qu'après
// annulation aucune arête de torse ne le dépasse.
const TORSO_TELEPORT_STRAND_M = 0.1;

function makePolarBodyPlacementSafe(
  mesh: ClothMeshData,
  sd: Sd,
  body: BodyMeasure,
  clearance = HOOD_CONTACT_THICKNESS_M + HOOD_CONTACT_SAFETY_M,
): void {
  // v200 : mémorise la pose cohérente d'AVANT l'enveloppe, applique l'enveloppe,
  // puis n'ANNULE que les cellules téléportées — celles qui atterrissent à plus
  // de TORSO_TELEPORT_STRAND_M d'un voisin de grille vivant (la marche radiale a
  // traversé un bras horizontal). L'embu cohérent du col reste intact.
  //
  // Sans bras mesuré (corps bras baissés — jericho natif), aucune
  // téléportation n'est possible : on ne lance même pas l'annulation, et le
  // placement est rigoureusement identique à l'historique.
  const before = mesh.positions.slice();
  const moved = new Uint8Array(mesh.count);
  for (let particle = 0; particle < mesh.count; particle++) {
    if (mesh.invMasses[particle]! <= 0) continue;
    const offset = particle * 4;
    const x = mesh.positions[offset]!;
    const safe = hoodRadialEnvelope(
      sd,
      [x, mesh.positions[offset + 1]!, mesh.positions[offset + 2]!],
      clearance,
      x < 0 ? -1 : 1,
    );
    if (
      safe[0] !== mesh.positions[offset]! ||
      safe[1] !== mesh.positions[offset + 1]! ||
      safe[2] !== mesh.positions[offset + 2]!
    ) {
      moved[particle] = 1;
    }
    mesh.positions[offset] = safe[0];
    mesh.positions[offset + 1] = safe[1];
    mesh.positions[offset + 2] = safe[2];
  }
  // Pas de bras horizontal = pas de traversée possible : on n'annule rien.
  if (!body.arm) return;
  const n = mesh.resolution;
  const panelSize = n * n;
  const strandLimit2 = TORSO_TELEPORT_STRAND_M * TORSO_TELEPORT_STRAND_M;
  const strandedNeighbour = (particle: number): boolean => {
    const local = particle % panelSize;
    const base = particle - local;
    const u = local % n;
    const v = Math.floor(local / n);
    const px = mesh.positions[particle * 4]!;
    const py = mesh.positions[particle * 4 + 1]!;
    const pz = mesh.positions[particle * 4 + 2]!;
    const neighbours: [number, number][] = [
      [u - 1, v],
      [u + 1, v],
      [u, v - 1],
      [u, v + 1],
    ];
    for (const [nu, nv] of neighbours) {
      if (nu < 0 || nu >= n || nv < 0 || nv >= n) continue;
      const other = base + nv * n + nu;
      if (mesh.invMasses[other]! <= 0) continue;
      const dx = px - mesh.positions[other * 4]!;
      const dy = py - mesh.positions[other * 4 + 1]!;
      const dz = pz - mesh.positions[other * 4 + 2]!;
      if (dx * dx + dy * dy + dz * dz > strandLimit2) return true;
    }
    return false;
  };
  // Le retrait d'une éjection peut en isoler une autre : itère jusqu'au point
  // fixe (borné — chaque passe ne fait que restaurer des cellules déplacées).
  for (let sweep = 0; sweep < 4; sweep++) {
    let reverted = 0;
    for (let particle = 0; particle < mesh.count; particle++) {
      if (!moved[particle]) continue;
      if (!strandedNeighbour(particle)) continue;
      const offset = particle * 4;
      mesh.positions[offset] = before[offset]!;
      mesh.positions[offset + 1] = before[offset + 1]!;
      mesh.positions[offset + 2] = before[offset + 2]!;
      moved[particle] = 0;
      reverted++;
    }
    if (reverted === 0) break;
  }
}

function hoodNeckTargetCurves(
  mesh: ClothMeshData,
  piece: DraftPiece,
  neckline: EdgeRun,
  targets: HoodNeckTargets,
): Array<Array<{ fraction: number; point: Point3 }>> {
  const panelSize = mesh.resolution * mesh.resolution;
  const curves: Array<Array<{ fraction: number; point: Point3 }>> = [[], []];
  for (const [particle, point] of targets) {
    const panel = Math.floor(particle / panelSize);
    if (panel < 0 || panel > 1) continue;
    const uv = flatParticleUV(mesh, piece, particle);
    curves[panel]!.push({
      fraction: nearestRunProjection(piece, uv, neckline).fraction,
      point,
    });
  }
  for (const curve of curves) {
    curve.sort((a, b) => a.fraction - b.fraction);
  }
  return curves;
}

function samplePointCurve(
  samples: readonly { fraction: number; point: Point3 }[],
  fraction: number,
  fallback: Point3,
): Point3 {
  if (!samples.length) return fallback;
  if (fraction <= samples[0]!.fraction) return [...samples[0]!.point];
  if (fraction >= samples[samples.length - 1]!.fraction) {
    return [...samples[samples.length - 1]!.point];
  }
  let upper = 1;
  while (upper < samples.length && samples[upper]!.fraction < fraction) {
    upper++;
  }
  const a = samples[upper - 1]!;
  const b = samples[upper]!;
  const span = Math.max(1e-9, b.fraction - a.fraction);
  const t = (fraction - a.fraction) / span;
  return [
    a.point[0] + (b.point[0] - a.point[0]) * t,
    a.point[1] + (b.point[1] - a.point[1]) * t,
    a.point[2] + (b.point[2] - a.point[2]) * t,
  ];
}

function placeHoodPanels(
  mesh: ClothMeshData,
  piece: DraftPiece,
  body: BodyMeasure,
  neckline: EdgeRun,
  centerRun: EdgeRun,
  faceRun: EdgeRun,
  baseY: number,
  neckTargets: HoodNeckTargets,
  bodySd?: Sd,
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  const neckHalfW = Math.max(0.075, body.shoulderHalfW * 0.4);
  const hoodHalfW = Math.max(0.135, body.shoulderHalfW * 0.66);
  const frontZ = body.chest.halfD + 0.055;
  const backZ = -(body.chest.halfD + 0.045);
  // Keep the crown curve above the complete two-layer hood clearance. If its
  // first interior row sits only ~12 mm above a tall scan, the radial safety
  // envelope must eject that row sideways while the sagittal seam stays at
  // x=0, creating one highly stretched edge at the crown.
  const crownY = Math.max(body.height + 0.04, baseY + 0.31);
  const foreheadY = crownY - 0.095;
  const neckCurves = hoodNeckTargetCurves(
    mesh,
    piece,
    neckline,
    neckTargets,
  );
  const centreTarget = (fraction: number): [number, number, number] => {
    if (fraction <= 0.56) {
      return quadraticPoint(
        [0, baseY, backZ],
        [0, baseY + 0.25, backZ - 0.055],
        [0, crownY, -0.015],
        fraction / 0.56,
      );
    }
    return quadraticPoint(
      [0, crownY, -0.015],
      [0, crownY + 0.015, frontZ * 0.62],
      [0, foreheadY, frontZ],
      (fraction - 0.56) / 0.44,
    );
  };

  for (let panel = 0; panel < 2; panel++) {
    const sign = panel === 0 ? -1 : 1;
    for (let local = 0; local < panelSize; local++) {
      const particle = panel * panelSize + local;
      if (mesh.invMasses[particle]! <= 0) continue;
      const uv = flatParticleUV(mesh, piece, particle);
      const centre = nearestRunProjection(piece, uv, centerRun);
      const face = nearestRunProjection(piece, uv, faceRun);
      const neck = nearestRunProjection(piece, uv, neckline);
      const centrePoint = centreTarget(centre.fraction);
      const faceSpan = Math.pow(Math.sin(Math.PI * face.fraction), 0.8);
      const facePoint: [number, number, number] = [
        sign * hoodHalfW * faceSpan,
        foreheadY + (baseY - foreheadY) * face.fraction,
        frontZ + 0.018 * faceSpan,
      ];
      const fallbackNeckPoint: Point3 = [
        sign * neckHalfW * Math.sin(Math.PI * neck.fraction),
        baseY - 0.012 * Math.sin(Math.PI * neck.fraction),
        frontZ * (1 - neck.fraction) + backZ * neck.fraction,
      ];
      const neckPoint = samplePointCurve(
        neckCurves[panel]!,
        neck.fraction,
        fallbackNeckPoint,
      );
      const epsilon = 1e-7;
      const wc = 1 / (centre.distance * centre.distance + epsilon);
      const wf = 1 / (face.distance * face.distance + epsilon);
      const wn = 1 / (neck.distance * neck.distance + epsilon);
      const total = wc + wf + wn;
      const exactNeckTarget = neckTargets.get(particle);
      const point: Point3 = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        point[axis] =
          (wc * centrePoint[axis]! +
            wf * facePoint[axis]! +
            wn * neckPoint[axis]!) /
          total;
      }
      const placed = exactNeckTarget
        ? exactNeckTarget
        : bodySd
          ? centre.distance < 1e-7
            ? point
            : hoodRadialEnvelope(
              bodySd,
              point,
              hoodCollisionClearance(mesh, particle),
              sign,
            )
          : point;
      mesh.positions[particle * 4] = placed[0];
      mesh.positions[particle * 4 + 1] = placed[1];
      mesh.positions[particle * 4 + 2] = placed[2];
    }
  }
}

function relaxHoodPanels(
  mesh: ClothMeshData,
  piece: DraftPiece,
  center: EdgeRun,
  face: EdgeRun,
  neckline: EdgeRun,
  neckTargets: HoodNeckTargets,
  bodySd?: Sd,
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  const targets = new Float32Array(mesh.positions);
  const centreCells = new Set(pairedEdges(piece, piece, center, center, n).a);
  const faceCells = new Set(pairedEdges(piece, piece, face, face, n).a);
  const neckCells = new Set(
    pairedEdges(piece, piece, neckline, neckline, n).a,
  );
  const view = new DataView(mesh.constraintData);

  for (let panel = 0; panel < 2; panel++) {
    const first = panel * panelSize;
    const edges: Array<{ a: number; b: number; rest: number }> = [];
    for (let index = 0; index < mesh.constraintCount; index++) {
      const offset = index * 16;
      const kind = view.getUint32(offset + 12, true);
      if (
        kind !== ConstraintKind.Structural &&
        kind !== ConstraintKind.StructuralWarp &&
        kind !== ConstraintKind.Shear
      ) {
        continue;
      }
      const globalA = view.getUint32(offset, true);
      const globalB = view.getUint32(offset + 4, true);
      if (
        globalA < first ||
        globalA >= first + panelSize ||
        globalB < first ||
        globalB >= first + panelSize
      ) {
        continue;
      }
      edges.push({
        a: globalA,
        b: globalB,
        rest: view.getFloat32(offset + 8, true),
      });
    }
    for (let iteration = 0; iteration < 6 * n; iteration++) {
      for (let local = 0; local < panelSize; local++) {
        const particle = first + local;
        if (mesh.invMasses[particle]! <= 0) continue;
        const attraction = neckTargets.has(particle)
          ? 0.18
          : centreCells.has(local)
            ? 0.16
            : faceCells.has(local) || neckCells.has(local)
            ? 0.09
            : bodySd
              ? 0
              : 0.002;
        for (let axis = 0; axis < 3; axis++) {
          const offset = particle * 4 + axis;
          mesh.positions[offset] =
            mesh.positions[offset]! +
            attraction * (targets[offset]! - mesh.positions[offset]!);
        }
      }
      const reverse = iteration % 2 === 1;
      for (let step = 0; step < edges.length; step++) {
        const edge = edges[reverse ? edges.length - 1 - step : step]!;
        const a = edge.a * 4;
        const b = edge.b * 4;
        const dx = mesh.positions[b]! - mesh.positions[a]!;
        const dy = mesh.positions[b + 1]! - mesh.positions[a + 1]!;
        const dz = mesh.positions[b + 2]! - mesh.positions[a + 2]!;
        const length = Math.hypot(dx, dy, dz);
        if (length <= 1e-9) continue;
        const correction = (0.44 * (length - edge.rest)) / length;
        mesh.positions[a] = mesh.positions[a]! + dx * correction;
        mesh.positions[a + 1] = mesh.positions[a + 1]! + dy * correction;
        mesh.positions[a + 2] = mesh.positions[a + 2]! + dz * correction;
        mesh.positions[b] = mesh.positions[b]! - dx * correction;
        mesh.positions[b + 1] = mesh.positions[b + 1]! - dy * correction;
        mesh.positions[b + 2] = mesh.positions[b + 2]! - dz * correction;
      }
      // Restore the sagittal direction before sampling the polar body shell.
      // Doing this afterwards would shorten a diagonally projected point back
      // toward the skull and invalidate the just-computed clearance.
      const panelSign = panel === 0 ? -1 : 1;
      for (let local = 0; local < panelSize; local++) {
        const particle = first + local;
        if (mesh.invMasses[particle]! <= 0) continue;
        const xOffset = particle * 4;
        mesh.positions[xOffset] =
          panelSign < 0
            ? Math.min(0, mesh.positions[xOffset]!)
            : Math.max(0, mesh.positions[xOffset]!);
      }
      for (const local of centreCells) {
        mesh.positions[(first + local) * 4] = 0;
      }
      if (bodySd) {
        for (let local = 0; local < panelSize; local++) {
          const particle = first + local;
          if (mesh.invMasses[particle]! <= 0) continue;
          const offset = particle * 4;
          const point: Point3 = [
            mesh.positions[offset]!,
            mesh.positions[offset + 1]!,
            mesh.positions[offset + 2]!,
          ];
          const safe = centreCells.has(local) && !neckCells.has(local)
            ? hoodSagittalEnvelope(
                bodySd,
                point,
                hoodCollisionClearance(mesh, particle),
              )
            : hoodRadialEnvelope(
                bodySd,
                point,
                hoodCollisionClearance(mesh, particle),
                panelSign,
              );
          mesh.positions[offset] = safe[0];
          mesh.positions[offset + 1] = safe[1];
          mesh.positions[offset + 2] = safe[2];
        }
      }
      // The paired centre seam is the garment's sagittal datum. Projecting X
      // after every length sweep keeps both halves coincident without freezing
      // their Y/Z response to the metric solve.
    }

  }
}

/**
 * Reconcile the three constraints that matter at the start of progressive
 * sewing: a short neckline pull, a bounded cloth metric and a collision-safe
 * pose. Alternating those projections avoids fixing one criterion by breaking
 * another, and only touches the hood after its authored 3D drape is built.
 */
function settleHoodAssemblyPose(
  mesh: ClothMeshData,
  centreCells: ReadonlySet<number>,
  seamTargets: ReadonlyMap<number, Point3>,
  bodySd?: Sd,
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  const view = new DataView(mesh.constraintData);
  const edges: Array<{ a: number; b: number; rest: number }> = [];
  for (let index = 0; index < mesh.constraintCount; index++) {
    const offset = index * 16;
    const kind = view.getUint32(offset + 12, true);
    if (
      kind !== ConstraintKind.Structural &&
      kind !== ConstraintKind.StructuralWarp &&
      kind !== ConstraintKind.Shear
    ) {
      continue;
    }
    const a = view.getUint32(offset, true);
    const b = view.getUint32(offset + 4, true);
    if (Math.floor(a / panelSize) !== Math.floor(b / panelSize)) continue;
    edges.push({ a, b, rest: view.getFloat32(offset + 8, true) });
  }

  const clampNeckline = (): void => {
    for (const [particle, target] of seamTargets) {
      const offset = particle * 4;
      const dx = mesh.positions[offset]! - target[0];
      const dy = mesh.positions[offset + 1]! - target[1];
      const dz = mesh.positions[offset + 2]! - target[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance <= HOOD_NECK_PRE_DRESS_M) continue;
      const scale = HOOD_NECK_PRE_DRESS_M / Math.max(distance, 1e-9);
      mesh.positions[offset] = target[0] + dx * scale;
      mesh.positions[offset + 1] = target[1] + dy * scale;
      mesh.positions[offset + 2] = target[2] + dz * scale;
    }
  };

  for (let iteration = 0; iteration < 2 * n; iteration++) {
    const reverse = iteration % 2 === 1;
    for (let step = 0; step < edges.length; step++) {
      const edge = edges[reverse ? edges.length - 1 - step : step]!;
      const a = edge.a * 4;
      const b = edge.b * 4;
      const dx = mesh.positions[b]! - mesh.positions[a]!;
      const dy = mesh.positions[b + 1]! - mesh.positions[a + 1]!;
      const dz = mesh.positions[b + 2]! - mesh.positions[a + 2]!;
      const length = Math.hypot(dx, dy, dz);
      const maximumLength = HOOD_MAX_PRE_DRESS_EDGE_RATIO * edge.rest;
      if (length <= maximumLength || length <= 1e-9) continue;
      const correction = (0.34 * (length - maximumLength)) / (2 * length);
      mesh.positions[a] = mesh.positions[a]! + dx * correction;
      mesh.positions[a + 1] = mesh.positions[a + 1]! + dy * correction;
      mesh.positions[a + 2] = mesh.positions[a + 2]! + dz * correction;
      mesh.positions[b] = mesh.positions[b]! - dx * correction;
      mesh.positions[b + 1] = mesh.positions[b + 1]! - dy * correction;
      mesh.positions[b + 2] = mesh.positions[b + 2]! - dz * correction;
    }

    clampNeckline();
    for (let particle = 0; particle < mesh.count; particle++) {
      if (mesh.invMasses[particle]! <= 0) continue;
      const local = particle % panelSize;
      const panelSign = Math.floor(particle / panelSize) === 0 ? -1 : 1;
      const offset = particle * 4;
      mesh.positions[offset] =
        panelSign < 0
          ? Math.min(0, mesh.positions[offset]!)
          : Math.max(0, mesh.positions[offset]!);
      if (centreCells.has(local)) {
        mesh.positions[offset] = 0;
      }
      if (!bodySd) continue;
      const point: Point3 = [
        mesh.positions[offset]!,
        mesh.positions[offset + 1]!,
        mesh.positions[offset + 2]!,
      ];
      const safe = centreCells.has(local)
        ? hoodSagittalEnvelope(
            bodySd,
            point,
            hoodCollisionClearance(mesh, particle) + 0.001,
          )
        : hoodRadialEnvelope(
            bodySd,
            point,
            hoodCollisionClearance(mesh, particle) + 0.001,
            panelSign,
          );
      mesh.positions[offset] = safe[0];
      mesh.positions[offset + 1] = safe[1];
      mesh.positions[offset + 2] = safe[2];
    }
  }
}

interface BandPanelPiece {
  piece: DraftPiece;
  attach: {
    frontLeft: EdgeRun;
    backLeft: EdgeRun;
    backRight: EdgeRun;
    frontRight: EdgeRun;
  };
  start: EdgeRun;
  end: EdgeRun;
}

function finishedWaistband(
  source: DraftPiece,
  bodyRuns: {
    front: DraftPiece;
    frontHem: EdgeRun;
    backHalf: DraftPiece;
    backHem: EdgeRun;
  },
): {
  band: BandPanelPiece;
} {
  const sourceCutWidth =
    (Math.max(...source.outline.map((point) => point[0])) -
      Math.min(...source.outline.map((point) => point[0]))) *
    source.width;
  const sourceCutHeight =
    (Math.max(...source.outline.map((point) => point[1])) -
      Math.min(...source.outline.map((point) => point[1]))) *
    source.height;
  const width = 2 * sourceCutWidth;
  const height = Math.max(
    0.035,
    sourceCutHeight / 2 - LUCAS_SEAM_ALLOWANCE_M,
  );
  const frontLength = hoodieRunLengthM(
    bodyRuns.front,
    bodyRuns.frontHem,
  );
  const backLength = hoodieRunLengthM(
    bodyRuns.backHalf,
    bodyRuns.backHem,
  );
  const total = Math.max(1e-6, 2 * frontLength + 2 * backLength);
  const f1 = frontLength / total;
  const f2 = (frontLength + backLength) / total;
  const f3 = (frontLength + 2 * backLength) / total;
  return {
    band: {
      piece: {
        ...source,
        // The PDF supplies one waistband cut on the fold. Unfolding it creates
        // one continuous strip from centre-front, around the back, to the
        // other centre-front — no invented side or centre-back seams.
        name: source.name,
        onFold: false,
        width,
        height,
        outline: [
          [0, 1],
          [0, 0],
          [f1, 0],
          [f2, 0],
          [f3, 0],
          [1, 0],
          [1, 1],
        ],
      },
      attach: {
        frontLeft: { from: 1, to: 2 },
        backLeft: { from: 2, to: 3 },
        backRight: { from: 3, to: 4 },
        frontRight: { from: 4, to: 5 },
      },
      start: { from: 0, to: 1 },
      end: { from: 5, to: 6 },
    },
  };
}

function placeWaistband(
  mesh: ClothMeshData,
  piece: DraftPiece,
  shell: TorsoShell,
  hemY: number,
): void {
  const n = mesh.resolution;
  const aspect = shell.halfW / Math.max(1e-6, shell.halfD);
  const referenceW = Math.sqrt(aspect);
  const referenceD = 1 / referenceW;
  const scale =
    outlinePhysicalWidth(piece) /
    ellipseCircumference(referenceW, referenceD);
  const halfW = referenceW * scale;
  const halfD = referenceD * scale;
  for (let local = 0; local < n * n; local++) {
    const particle = local;
    if (mesh.invMasses[particle]! <= 0) continue;
    const [u, v] = flatParticleUV(mesh, piece, particle);
    const fraction = outlineU01(piece, u);
    const angle = ellipseAngleAtArcFraction(
      halfW,
      halfD,
      Math.PI / 2,
      Math.PI / 2 + 2 * Math.PI,
      fraction,
    );
    mesh.positions[particle * 4] = halfW * Math.cos(angle);
    mesh.positions[particle * 4 + 1] = hemY - v * piece.height;
    mesh.positions[particle * 4 + 2] = halfD * Math.sin(angle);
  }
}

function minimumLiveY(
  mesh: ClothMeshData,
  first: number,
  count: number,
): number {
  let minimum = Infinity;
  for (let particle = first; particle < first + count; particle++) {
    if (mesh.invMasses[particle]! <= 0) continue;
    minimum = Math.min(minimum, mesh.positions[particle * 4 + 1]!);
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function placePocketPanels(
  mesh: ClothMeshData,
  pocket: DraftPiece,
  front: DraftPiece,
  surface: SurfaceAttachment,
  shell: TorsoShell,
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  for (let panel = 0; panel < 2; panel++) {
    for (let local = 0; local < panelSize; local++) {
      const particle = panel * panelSize + local;
      if (mesh.invMasses[particle]! <= 0) continue;
      const uv = flatParticleUV(mesh, pocket, particle);
      const target = surfaceAttachmentUV(pocket, front, surface, uv);
      const world = frontSurfacePosition(
        front,
        target,
        shell,
        panel === 0 ? 'left' : 'right',
        0.004,
      );
      mesh.positions[particle * 4] = world[0];
      mesh.positions[particle * 4 + 1] = world[1];
      mesh.positions[particle * 4 + 2] = world[2];
    }
  }
}

interface CuffPiece {
  piece: DraftPiece;
  attach: EdgeRun;
  ends: [EdgeRun, EdgeRun];
}

function finishedCuff(source: DraftPiece): CuffPiece {
  const cutHeight =
    (Math.max(...source.outline.map((point) => point[1])) -
      Math.min(...source.outline.map((point) => point[1]))) *
    source.height;
  return {
    piece: {
      ...source,
      // The source bounding box includes 5 mm of generator padding on either
      // side. Once the outline is replaced by a full rectangle, keeping that
      // box adds a spurious centimetre to the simulated cuff circumference.
      width: outlinePhysicalWidth(source),
      height: Math.max(0.035, cutHeight / 2 - LUCAS_SEAM_ALLOWANCE_M),
      outline: [
        [0, 1],
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
    attach: { from: 1, to: 2 },
    ends: [
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ],
  };
}

function placeCuffPanel(
  mesh: ClothMeshData,
  panel: number,
  piece: DraftPiece,
  sleeve: DraftPiece,
  body: BodyMeasure,
  side: 'left' | 'right',
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  const radius = Math.max(0.035, piece.width / (2 * Math.PI));
  for (let local = 0; local < panelSize; local++) {
    const particle = panel * panelSize + local;
    if (mesh.invMasses[particle]! <= 0) continue;
    const [u, v] = flatParticleUV(mesh, piece, particle);
    const angle = sleeveWrapAngle(side, outlineU01(piece, u));
    const along = sleeve.height + v * piece.height;
    const frame = armFrame(side, body, along);
    const radialSide = Math.sin(angle) * radius;
    const radialFront = Math.cos(angle) * radius;
    mesh.positions[particle * 4] =
      frame.centre[0] +
      frame.sideNormal[0] * radialSide +
      frame.frontNormal[0] * radialFront;
    mesh.positions[particle * 4 + 1] =
      frame.centre[1] +
      frame.sideNormal[1] * radialSide +
      frame.frontNormal[1] * radialFront;
    mesh.positions[particle * 4 + 2] =
      frame.centre[2] +
      frame.sideNormal[2] * radialSide +
      frame.frontNormal[2] * radialFront;
  }
}

function projectOutsideBody(
  sd: Sd,
  point: readonly [number, number, number],
  clearance: number,
): [number, number, number] {
  const projected: [number, number, number] = [point[0], point[1], point[2]];
  const epsilon = 0.0025;
  for (let iteration = 0; iteration < 10; iteration++) {
    const distance = sd(projected[0], projected[1], projected[2]);
    if (distance >= clearance) break;
    const gradient: [number, number, number] = [
      sd(projected[0] + epsilon, projected[1], projected[2]) -
        sd(projected[0] - epsilon, projected[1], projected[2]),
      sd(projected[0], projected[1] + epsilon, projected[2]) -
        sd(projected[0], projected[1] - epsilon, projected[2]),
      sd(projected[0], projected[1], projected[2] + epsilon) -
        sd(projected[0], projected[1], projected[2] - epsilon),
    ];
    let normal = normalised3(gradient);
    if (Math.hypot(...gradient) < 1e-8) {
      normal = normalised3([projected[0], 0, projected[2]]);
    }
    const push = Math.min(0.04, clearance - distance + 0.0005);
    projected[0] += normal[0] * push;
    projected[1] += normal[1] * push;
    projected[2] += normal[2] * push;
  }
  return projected;
}

/**
 * Keep the collision-safe side chosen by the wrapped sleeve before its cap is
 * drawn toward the armscye. A final-point projection alone can push a deeply
 * intersecting stitch out through the opposite side of the arm; this sweep
 * stops at the first SDF contact along the pre-dressing displacement instead.
 */
function makeInitialPlacementCollisionSafe(
  mesh: ClothMeshData,
  ranges: readonly LucasHoodieParticleRange[],
  beforePreShape: Float32Array,
  sd: Sd,
  clearance = 0.008,
): void {
  const swept = new Uint8Array(mesh.count);
  for (const range of ranges) {
    if (range.pieceId !== 2 && range.pieceId !== 5) continue;
    swept.fill(1, range.first, range.first + range.count);
  }

  for (let particle = 0; particle < mesh.count; particle++) {
    // Torso, hood, rib band and pockets already have coherent authored poses.
    // Projecting their vertices independently destroys their triangles. Only
    // sleeve/cuff particles use the swept pre-shape path below.
    if (!swept[particle]) continue;
    if (mesh.invMasses[particle]! <= 0) continue;
    const offset = particle * 4;
    const target: [number, number, number] = [
      mesh.positions[offset]!,
      mesh.positions[offset + 1]!,
      mesh.positions[offset + 2]!,
    ];
    let result = target;

    const safeStart = projectOutsideBody(
      sd,
      [
        beforePreShape[offset]!,
        beforePreShape[offset + 1]!,
        beforePreShape[offset + 2]!,
      ],
      clearance + 0.001,
    );
    const delta: [number, number, number] = [
      target[0] - safeStart[0],
      target[1] - safeStart[1],
      target[2] - safeStart[2],
    ];
    const travel = Math.hypot(delta[0], delta[1], delta[2]);
    const steps = Math.min(32, Math.max(2, Math.ceil(travel / 0.006)));
    let previousFraction = 0;
    let hit = false;
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      const sample: [number, number, number] = [
        safeStart[0] + delta[0] * fraction,
        safeStart[1] + delta[1] * fraction,
        safeStart[2] + delta[2] * fraction,
      ];
      if (sd(sample[0], sample[1], sample[2]) >= clearance) {
        previousFraction = fraction;
        continue;
      }
      let outside = previousFraction;
      let inside = fraction;
      for (let iteration = 0; iteration < 7; iteration++) {
        const middle = (outside + inside) / 2;
        const middlePoint: [number, number, number] = [
          safeStart[0] + delta[0] * middle,
          safeStart[1] + delta[1] * middle,
          safeStart[2] + delta[2] * middle,
        ];
        if (sd(middlePoint[0], middlePoint[1], middlePoint[2]) >= clearance) {
          outside = middle;
        } else {
          inside = middle;
        }
      }
      result = projectOutsideBody(
        sd,
        [
          safeStart[0] + delta[0] * outside,
          safeStart[1] + delta[1] * outside,
          safeStart[2] + delta[2] * outside,
        ],
        clearance + 0.001,
      );
      hit = true;
      break;
    }
    if (!hit) result = projectOutsideBody(sd, target, clearance + 0.001);

    mesh.positions[offset] = result[0];
    mesh.positions[offset + 1] = result[1];
    mesh.positions[offset + 2] = result[2];
  }
}

/**
 * Build the physical hoodie while keeping the exact seven-piece DraftDoc as
 * the source of truth for editing/export.
 */
export function buildLucasHoodieMesh(
  doc: DraftDoc,
  resolution: number,
  body: BodyMeasure,
  bodySd?: Sd,
): LucasHoodieMesh {
  const sourceBackHalf = doc.back;
  const sleeve = doc.pieces?.[0];
  const hood = doc.pieces?.[1];
  const pocket = doc.pieces?.[2];
  const cuffSource = doc.pieces?.[3];
  const waistbandSource = doc.pieces?.[4];
  if (
    !sourceBackHalf ||
    !sleeve ||
    !hood ||
    !pocket ||
    !cuffSource ||
    !waistbandSource
  ) {
    throw new Error('Lucas Hoodie is missing one or more supplied pieces');
  }
  // 2D editing dimensions are persistent, but placement anchors are not
  // measurements. Recompute the torso anchor from the CURRENT mannequin on
  // every assembly so changing avatar/stature cannot leave the body panels at
  // their previous height while sleeves and hood move to the new shoulders.
  // Clone locally: the user's editable DraftDoc remains byte-for-byte intact.
  const canonicalTopY = Math.max(
    body.shoulderY + 0.035,
    body.neckY - 0.025,
  );
  const frontPiece: DraftPiece = { ...doc.piece, topY: canonicalTopY };
  const backHalf: DraftPiece = { ...sourceBackHalf, topY: canonicalTopY };
  const runs = lucasHoodieRuns(doc);
  const n = resolution;
  const panelSize = n * n;
  const zipperClosed = (doc.seams ?? []).some(
    (seam) => seam.kind === 'zipper' && assemblySeamIsClosed(seam),
  );
  const shell = torsoShell(frontPiece, backHalf, body);

  const zipperPair = pairedEdges(
    frontPiece,
    frontPiece,
    runs.front.centerFront,
    runs.front.centerFront,
    n,
    false,
  );
  const front = generateSeamedPanels({
    resolution: n,
    width: frontPiece.width,
    height: frontPiece.height,
    gap: frontPiece.gap,
    topY: frontPiece.topY,
    shape: 'freeform',
    mask: { outline: frontPiece.outline, darts: frontPiece.darts },
    maskBack: { outline: frontPiece.outline, darts: frontPiece.darts },
    manualAssembly: true,
    assemblySeams: zipperClosed
      ? zipperPair.a.map((cell, index) => ({
          i: cell,
          j: panelSize + zipperPair.b[index]!,
        }))
      : [],
    flattenSeams: false,
  });
  const frontFlatPositions = new Float32Array(front.positions);
  placeFronts(front, frontPiece, shell);

  const unfoldedBack = unfoldOnFold(backHalf, runs.back.fold);
  const back = singlePanel(unfoldedBack.piece, n);
  scaleMeshInverseMassesToReferenceCellArea(
    back,
    front.spacing * front.spacingV,
  );
  const backFlatPositions = new Float32Array(back.positions);
  placeBack(back, unfoldedBack.piece, shell);
  preFoldBodyShoulders(
    front,
    back,
    frontFlatPositions,
    backFlatPositions,
    frontPiece,
    unfoldedBack,
    runs.front.shoulder,
    runs.back.shoulder,
    n,
  );
  const bodyCross: CrossSeam[] = [];
  for (const [panel, side] of [
    [0, 'left'],
    [1, 'right'],
  ] as const) {
    appendCross(
      bodyCross,
      pairedEdges(
        frontPiece,
        unfoldedBack.piece,
        runs.front.shoulder,
        mappedRun(unfoldedBack, runs.back.shoulder, side),
        n,
        side === 'right',
      ),
      panel * panelSize,
      front.count,
    );
    appendCross(
      bodyCross,
      pairedEdges(
        frontPiece,
        unfoldedBack.piece,
        runs.front.side,
        mappedRun(unfoldedBack, runs.back.side, side),
        n,
        side === 'right',
      ),
      panel * panelSize,
      front.count,
    );
  }
  let garment = combineClothMeshes(front, back, bodyCross);
  if (bodySd) {
    // Correct the coherent torso shell before any sleeve, pocket or hood is
    // attached. In particular, the scanned trapezius rises inside the flat
    // pattern neckline; moving the complete polar shell here gives the hood a
    // collision-safe seam target without tearing either mesh afterwards.
    makePolarBodyPlacementSafe(garment, bodySd, body);
  }
  const ranges: LucasHoodieParticleRange[] = [
    { pieceId: 0, first: 0, count: panelSize, instance: 0 },
    { pieceId: 0, first: panelSize, count: panelSize, instance: 1 },
    { pieceId: 1, first: front.count, count: panelSize, instance: 0 },
  ];

  const underarm = asPairs(
    pairedEdges(
      sleeve,
      sleeve,
      runs.sleeve.underarmA,
      runs.sleeve.underarmB,
      n,
      true,
      true,
    ),
  );
  const sleeves = panelPair(sleeve, n, underarm);
  scaleMeshInverseMassesToReferenceCellArea(
    sleeves,
    front.spacing * front.spacingV,
  );
  placeSleevePanel(sleeves, 0, sleeve, runs.sleeve.cap, body, 'left');
  placeSleevePanel(sleeves, 1, sleeve, runs.sleeve.cap, body, 'right');
  const sleeveOffset = garment.count;
  const sleeveCross: CrossSeam[] = [];
  for (const [panel, side] of [
    [0, 'left'],
    [1, 'right'],
  ] as const) {
    const backArm = mappedRun(unfoldedBack, runs.back.armhole, side);
    // The lateral notch visible on the A0 sleeve belongs to capB and matches
    // the sole notch on the FRONT armscye. capA is the un-notched back half.
    // Both physical sleeves keep this identity; mirroring happens in 3D.
    const frontCap = runs.sleeve.capB;
    const backCap = runs.sleeve.capA;
    appendCross(
      sleeveCross,
      pairedEdges(
        frontPiece,
        sleeve,
        runs.front.armhole,
        frontCap,
        n,
        true,
        true,
      ),
      panel * panelSize,
      garment.count + panel * panelSize,
    );
    appendCross(
      sleeveCross,
      pairedEdges(
        unfoldedBack.piece,
        sleeve,
        backArm,
        backCap,
        n,
        side === 'right',
        true,
      ),
      front.count,
      garment.count + panel * panelSize,
    );
  }
  garment = combineClothMeshes(garment, sleeves, sleeveCross);
  ranges.push(
    { pieceId: 2, first: sleeveOffset, count: panelSize, instance: 0 },
    {
      pieceId: 2,
      first: sleeveOffset + panelSize,
      count: panelSize,
      instance: 1,
    },
  );

  const cuff = finishedCuff(cuffSource);
  const cuffSeams = asPairs(
    pairedEdges(
      cuff.piece,
      cuff.piece,
      cuff.ends[0],
      cuff.ends[1],
      n,
      true,
      true,
    ),
  );
  const cuffs = panelPair(cuff.piece, n, cuffSeams);
  scaleMeshInverseMassesToReferenceCellArea(
    cuffs,
    front.spacing * front.spacingV,
  );
  placeCuffPanel(cuffs, 0, cuff.piece, sleeve, body, 'left');
  placeCuffPanel(cuffs, 1, cuff.piece, sleeve, body, 'right');
  const cuffOffset = garment.count;
  const cuffCross: CrossSeam[] = [];
  for (const panel of [0, 1]) {
    appendCross(
      cuffCross,
      pairedEdges(
        sleeve,
        cuff.piece,
        runs.sleeve.cuff,
        cuff.attach,
        n,
        true,
        true,
      ),
      sleeveOffset + panel * panelSize,
      garment.count + panel * panelSize,
    );
  }
  garment = combineClothMeshes(garment, cuffs, cuffCross);
  ranges.push(
    { pieceId: 5, first: cuffOffset, count: panelSize, instance: 0 },
    {
      pieceId: 5,
      first: cuffOffset + panelSize,
      count: panelSize,
      instance: 1,
    },
  );

  const waistband = finishedWaistband(waistbandSource, {
    front: frontPiece,
    frontHem: runs.front.hem,
    backHalf,
    backHem: runs.back.hem,
  });
  const bandZip = pairedEdges(
    waistband.band.piece,
    waistband.band.piece,
    waistband.band.start,
    waistband.band.end,
    n,
    true,
  );
  const band = singlePanel(
    waistband.band.piece,
    n,
    zipperClosed
      ? bandZip.a.map((cell, index) => ({
          i: cell,
          j: bandZip.b[index]!,
        }))
      : [],
  );
  scaleMeshInverseMassesToReferenceCellArea(
    band,
    front.spacing * front.spacingV,
  );
  const hemY = minimumLiveY(front, 0, panelSize);
  placeWaistband(band, waistband.band.piece, shell, hemY);
  const bandOffset = garment.count;
  const bandCross: CrossSeam[] = [];
  const leftBackHem = mappedRun(unfoldedBack, runs.back.hem, 'left');
  const rightBackHem = mappedRun(unfoldedBack, runs.back.hem, 'right');
  appendCross(
    bandCross,
    pairedEdgeToBandTop(
      frontPiece,
      runs.front.hem,
      waistband.band.piece,
      waistband.band.attach.frontLeft,
      band,
      n,
      false,
    ),
    0,
    garment.count,
  );
  appendCross(
    bandCross,
    pairedEdgeToBandTop(
      unfoldedBack.piece,
      leftBackHem,
      waistband.band.piece,
      waistband.band.attach.backLeft,
      band,
      n,
      true,
    ),
    front.count,
    garment.count,
  );
  appendCross(
    bandCross,
    pairedEdgeToBandTop(
      unfoldedBack.piece,
      rightBackHem,
      waistband.band.piece,
      waistband.band.attach.backRight,
      band,
      n,
      true,
    ),
    front.count,
    garment.count,
  );
  appendCross(
    bandCross,
    pairedEdgeToBandTop(
      frontPiece,
      runs.front.hem,
      waistband.band.piece,
      waistband.band.attach.frontRight,
      band,
      n,
      true,
    ),
    panelSize,
    garment.count,
  );
  garment = combineClothMeshes(garment, band, bandCross);
  ranges.push({ pieceId: 6, first: bandOffset, count: panelSize, instance: 0 });

  // Two independent patch pockets are cut from the one supplied pocket
  // outline. They are laid directly over their matching front panel. The
  // diagonal opening remains free; every other authored edge is stitched to
  // the support through the same one-sided contact model as user appliqués.
  const pocketSurface = pocket.placement?.surface;
  if (pocketSurface) {
    const physicalPocket = simulationPocketPiece(
      pocket,
      runs.pocket.opening,
    );
    const pockets = panelPair(physicalPocket, n);
    scaleMeshInverseMassesToReferenceCellArea(
      pockets,
      front.spacing * front.spacingV,
    );
    placePocketPanels(
      pockets,
      physicalPocket,
      frontPiece,
      pocketSurface,
      shell,
    );
    const pocketOffset = garment.count;
    const pocketDoc: DraftDoc = {
      format: 'toile-draft',
      version: 1,
      gridN: doc.gridN,
      piece: frontPiece,
      pieces: [physicalPocket],
    };
    const pocketSeams: CrossSeam[] = [];
    const pocketContacts: SurfaceContact[] = [];
    for (const panel of [0, 1]) {
      const offsets = [
        panel * panelSize,
        0,
        garment.count + panel * panelSize,
      ];
      pocketSeams.push(
        ...compileSurfaceSeams(pocketDoc, n, offsets, 2),
      );
      const contacts = compileSurfaceContacts(
        pocketDoc,
        n,
        offsets,
        2,
      );
      // The right front is mirrored in world space. Reverse its stored support
      // triangle so the unilateral normal still points away from the torso.
      pocketContacts.push(
        ...contacts.map((contact) =>
          panel === 0
            ? contact
            : {
                ...contact,
                tangentA: contact.tangentB,
                tangentB: contact.tangentA,
                weightA: contact.weightB,
                weightB: contact.weightA,
              },
        ),
      );
    }
    garment = combineClothMeshes(
      garment,
      pockets,
      pocketSeams,
      0,
      pocketContacts,
      pocketSeams,
    );
    ranges.push(
      {
        pieceId: 4,
        first: pocketOffset,
        count: panelSize,
        instance: 0,
      },
      {
        pieceId: 4,
        first: pocketOffset + panelSize,
        count: panelSize,
        instance: 1,
      },
    );
  }

  const centerSeam = pairedEdges(
    hood,
    hood,
    runs.hood.center,
    runs.hood.center,
    n,
    false,
  );
  let hoods = generateSeamedPanels({
    resolution: n,
    width: hood.width,
    height: hood.height,
    gap: hood.gap,
    topY: hood.topY,
    shape: 'freeform',
    mask: { outline: hood.outline, darts: hood.darts },
    maskBack: { outline: hood.outline, darts: hood.darts },
    manualAssembly: true,
    assemblySeams: centerSeam.a.map((cell, index) => ({
      i: cell,
      j: panelSize + centerSeam.b[index]!,
    })),
    flattenSeams: false,
  });
  scaleMeshInverseMassesToReferenceCellArea(
    hoods,
    front.spacing * front.spacingV,
  );
  hoods = withHoodCollisionLayers(hoods, hood, runs.hood.neckline);

  const hoodOffset = garment.count;
  const hoodCross: CrossSeam[] = [];
  const hoodCrossCandidates: number[][] = [];
  const hoodBodyCandidates: Array<Set<number>> = [new Set(), new Set()];
  const hoodNeckline = lucasHoodNecklineRuns(doc, runs);
  const targetSums = new Map<
    number,
    { x: number; y: number; z: number; count: number }
  >();
  const addNeckJoin = (
    pair: { a: number[]; b: number[] },
    bodyOffset: number,
    panel: 0 | 1,
  ): void => {
    const bodyCells = pair.a.filter(
      (cell, index) => index === 0 || cell !== pair.a[index - 1],
    );
    const bodyCandidates = bodyCells.map((cell) => bodyOffset + cell);
    for (const candidate of bodyCandidates) {
      hoodBodyCandidates[panel]!.add(candidate);
    }
    const bodyPoints = bodyCells.map(
      (cell): Point3 => [
        garment.positions[(bodyOffset + cell) * 4]!,
        garment.positions[(bodyOffset + cell) * 4 + 1]!,
        garment.positions[(bodyOffset + cell) * 4 + 2]!,
      ],
    );
    if (!bodyPoints.length) return;
    const cumulative = new Float64Array(bodyPoints.length);
    for (let index = 1; index < bodyPoints.length; index++) {
      cumulative[index] =
        cumulative[index - 1]! +
        Math.hypot(
          bodyPoints[index]![0] - bodyPoints[index - 1]![0],
          bodyPoints[index]![1] - bodyPoints[index - 1]![1],
          bodyPoints[index]![2] - bodyPoints[index - 1]![2],
        );
    }
    const sampleBodyPoint = (fraction: number): Point3 => {
      if (bodyPoints.length === 1) return [...bodyPoints[0]!];
      const target = fraction * cumulative[cumulative.length - 1]!;
      let upper = 1;
      while (upper < cumulative.length && cumulative[upper]! < target) {
        upper++;
      }
      const lower = upper - 1;
      const span = Math.max(
        1e-9,
        cumulative[upper]! - cumulative[lower]!,
      );
      const t = (target - cumulative[lower]!) / span;
      return [
        bodyPoints[lower]![0] +
          (bodyPoints[upper]![0] - bodyPoints[lower]![0]) * t,
        bodyPoints[lower]![1] +
          (bodyPoints[upper]![1] - bodyPoints[lower]![1]) * t,
        bodyPoints[lower]![2] +
          (bodyPoints[upper]![2] - bodyPoints[lower]![2]) * t,
      ];
    };
    let nearestBodyIndex = 0;
    for (let index = 0; index < pair.a.length; index++) {
      const fraction =
        pair.a.length <= 1 ? 0 : index / (pair.a.length - 1);
      const targetLength =
        fraction * cumulative[cumulative.length - 1]!;
      while (
        nearestBodyIndex + 1 < cumulative.length &&
        Math.abs(cumulative[nearestBodyIndex + 1]! - targetLength) <=
          Math.abs(cumulative[nearestBodyIndex]! - targetLength)
      ) {
        nearestBodyIndex++;
      }
      const hoodParticle = panel * panelSize + pair.b[index]!;
      // Use the same physical arc-length parameter for the discrete GPU
      // stitch and the interpolated pre-dressing target. Raster-index pairing
      // repeats cells unevenly on eased curves and can otherwise assign a
      // hood point to a body stitch several centimetres away from its target.
      hoodCross.push({
        i: bodyOffset + bodyCells[nearestBodyIndex]!,
        j: hoodOffset + hoodParticle,
      });
      // Retain the authored run candidates so retargeting can preserve its
      // front/back provenance whenever the rasterised shoulder permits it.
      hoodCrossCandidates.push(bodyCandidates);
      const point = sampleBodyPoint(fraction);
      const current = targetSums.get(hoodParticle) ?? {
        x: 0,
        y: 0,
        z: 0,
        count: 0,
      };
      current.x += point[0];
      current.y += point[1];
      current.z += point[2];
      current.count++;
      targetSums.set(hoodParticle, current);
    }
  };
  for (const [panel, side] of [
    [0, 'left'],
    [1, 'right'],
  ] as const) {
    addNeckJoin(
      pairedEdges(
        unfoldedBack.piece,
        hood,
        mappedRun(unfoldedBack, runs.back.neckline, side),
        hoodNeckline.back,
        n,
        side === 'right',
        true,
      ),
      front.count,
      panel,
    );
    addNeckJoin(
      pairedEdges(
        frontPiece,
        hood,
        runs.front.neckline,
        hoodNeckline.front,
        n,
        true,
        true,
      ),
      panel * panelSize,
      panel,
    );
  }
  const hoodNeckTargets = new Map<number, Point3>();
  const hoodCenterCells = new Set(centerSeam.a);
  for (const [particle, sum] of targetSums) {
    const panel = Math.floor(particle / panelSize);
    const averagedX = sum.x / sum.count;
    let target: Point3 = [
      hoodCenterCells.has(particle % panelSize)
        ? 0
        : panel === 0
          ? Math.min(0, averagedX)
          : Math.max(0, averagedX),
      sum.y / sum.count,
      sum.z / sum.count,
    ];
    if (bodySd) {
      target = hoodFirstRadialEnvelope(
        bodySd,
        target,
        hoodCollisionClearance(hoods, particle),
        panel === 0 ? -1 : 1,
      );
    }
    hoodNeckTargets.set(particle, target);
  }

  // Front and back neckline runs are rasterised independently. At their
  // shoulder junction that can assign two neighbouring hood cells to body
  // samples several centimetres apart. Reparameterise the combined target
  // polyline by the hood's own neckline fraction so the sewing ease is spread
  // continuously instead of concentrated in one yarn edge.
  for (let panel = 0; panel < 2; panel++) {
    const entries = [...hoodNeckTargets.entries()]
      .filter(([particle]) => Math.floor(particle / panelSize) === panel)
      .map(([particle, point]) => ({
        particle,
        point,
        fraction: nearestRunProjection(
          hood,
          flatParticleUV(hoods, hood, particle),
          runs.hood.neckline,
        ).fraction,
      }))
      .sort((a, b) => a.fraction - b.fraction);
    if (entries.length < 3) continue;
    const cumulative = new Float64Array(entries.length);
    for (let index = 1; index < entries.length; index++) {
      const a = entries[index - 1]!.point;
      const b = entries[index]!.point;
      cumulative[index] =
        cumulative[index - 1]! +
        Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const total = cumulative[cumulative.length - 1]!;
    const firstFraction = entries[0]!.fraction;
    const fractionSpan = Math.max(
      1e-9,
      entries[entries.length - 1]!.fraction - firstFraction,
    );
    for (const entry of entries) {
      const targetLength =
        ((entry.fraction - firstFraction) / fractionSpan) * total;
      let upper = 1;
      while (
        upper < cumulative.length &&
        cumulative[upper]! < targetLength
      ) {
        upper++;
      }
      upper = Math.min(upper, entries.length - 1);
      const lower = Math.max(0, upper - 1);
      const interval = Math.max(
        1e-9,
        cumulative[upper]! - cumulative[lower]!,
      );
      const t = (targetLength - cumulative[lower]!) / interval;
      const a = entries[lower]!.point;
      const b = entries[upper]!.point;
      const sign = panel === 0 ? -1 : 1;
      hoodNeckTargets.set(entry.particle, [
        sign < 0
          ? Math.min(0, a[0] + (b[0] - a[0]) * t)
          : Math.max(0, a[0] + (b[0] - a[0]) * t),
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ]);
    }
  }

  const frontNeckCells = pairedEdges(
    frontPiece,
    frontPiece,
    runs.front.neckline,
    runs.front.neckline,
    n,
    false,
  ).a;
  const frontCentreNeck = frontNeckCells.at(-1);
  const hoodBaseY =
    frontCentreNeck === undefined
      ? body.shoulderY - 0.04
      : front.positions[frontCentreNeck * 4 + 1]!;
  placeHoodPanels(
    hoods,
    hood,
    body,
    runs.hood.neckline,
    runs.hood.center,
    runs.hood.face,
    hoodBaseY,
    hoodNeckTargets,
    bodySd,
  );
  relaxHoodPanels(
    hoods,
    hood,
    runs.hood.center,
    runs.hood.face,
    runs.hood.neckline,
    hoodNeckTargets,
    bodySd,
  );
  // The same continuous parameterisation must drive the actual GPU stitches.
  // The metric/contact solve can move the pre-dressed neckline a few cells
  // from its analytical target, so pair against the final hood position. This
  // only redistributes ease along the same authored body neckline and prevents
  // a stale front/back raster pairing from recreating the shoulder jump.
  const retargetHoodCross = (): Map<number, Point3> => {
    const sums = new Map<
      number,
      { x: number; y: number; z: number; count: number }
    >();
    for (let seamIndex = 0; seamIndex < hoodCross.length; seamIndex++) {
      const seam = hoodCross[seamIndex]!;
      const hoodParticle = seam.j - hoodOffset;
      const panel = Math.floor(hoodParticle / panelSize);
      const runCandidates = hoodCrossCandidates[seamIndex];
      const hoodPointOffset = hoodParticle * 4;
      if (!runCandidates?.length) continue;
      const distanceTo = (candidate: number): number => {
        const bodyPointOffset = candidate * 4;
        return Math.hypot(
          garment.positions[bodyPointOffset]! -
            hoods.positions[hoodPointOffset]!,
          garment.positions[bodyPointOffset + 1]! -
            hoods.positions[hoodPointOffset + 1]!,
          garment.positions[bodyPointOffset + 2]! -
            hoods.positions[hoodPointOffset + 2]!,
        );
      };
      const nearestDistance = (candidates: readonly number[]): number =>
        candidates.reduce(
          (minimum, candidate) => Math.min(minimum, distanceTo(candidate)),
          Infinity,
        );
      const runDistance = nearestDistance(runCandidates);
      const allCandidates = [...hoodBodyCandidates[panel]!];
      const allDistance = nearestDistance(allCandidates);
      // Keep the authored front/back run whenever it can start inside the
      // progressive-stitch capture radius. Only a separated shoulder raster
      // sample may borrow the coincident endpoint of the adjoining run.
      const candidates =
        runDistance <= HOOD_NECK_CAPTURE_M || runDistance <= allDistance
          ? runCandidates
          : allCandidates;
      let nearest = seam.i;
      let minimumDistance = Infinity;
      for (const candidate of candidates) {
        const distance = distanceTo(candidate);
        if (distance < minimumDistance) {
          minimumDistance = distance;
          nearest = candidate;
        }
      }
      seam.i = nearest;
      const offset = nearest * 4;
      const sum = sums.get(hoodParticle) ?? {
        x: 0,
        y: 0,
        z: 0,
        count: 0,
      };
      sum.x += garment.positions[offset]!;
      sum.y += garment.positions[offset + 1]!;
      sum.z += garment.positions[offset + 2]!;
      sum.count++;
      sums.set(hoodParticle, sum);
    }
    const seamTargets = new Map<number, Point3>();
    for (const [particle, sum] of sums) {
      seamTargets.set(particle, [
        sum.x / sum.count,
        sum.y / sum.count,
        sum.z / sum.count,
      ]);
    }
    return seamTargets;
  };
  settleHoodAssemblyPose(
    hoods,
    hoodCenterCells,
    retargetHoodCross(),
    bodySd,
  );
  settleHoodAssemblyPose(
    hoods,
    hoodCenterCells,
    retargetHoodCross(),
    bodySd,
  );
  garment = combineClothMeshes(garment, hoods, hoodCross);
  ranges.push(
    { pieceId: 3, first: hoodOffset, count: panelSize, instance: 0 },
    {
      pieceId: 3,
      first: hoodOffset + panelSize,
      count: panelSize,
      instance: 1,
    },
  );

  // Align complete panels as rigid bodies. This reduces the residual sewing
  // distance without changing a single triangle, yarn edge or pattern rest
  // length; surface-attached pockets follow their supporting front panel
  // unilaterally and therefore cannot pull the body during pre-dressing.
  rigidlyPlaceHoodiePanels(garment, {
    // The two fronts and the unfolded back already form the authored boxy
    // torso around the avatar. Keep that silhouette as the dressing frame:
    // letting sleeves, hood and rib bands vote the body panels into a global
    // least-squares compromise narrows/tilts the hem and turns the hoodie into
    // a long cone. Accessories may move toward the body, never the reverse.
    // Sleeves 4/5 already form true tubes around the measured arm axes. A
    // whole-panel Procrustes fit cannot distinguish their shaped cap from the
    // shaft: it used to lower/translate each complete tube by about 20 cm just
    // to approach the deep armhole, leaving the avatar's arm outside. Keep the
    // shafts in their canonical wrap pose; sewing may shape the cap locally.
    // The two hood halves are one coupled folded volume. Letting the generic
    // fitter rotate panels 12/13 independently can satisfy their separate
    // neckline samples while reopening/overlapping the sagittal centre seam.
    // Their boundary construction is already pre-aligned, so preserve it.
    fixedPanels: [0, 1, 2, 4, 5, 8, 12, 13],
    iterations: 24,
    damping: 0.7,
    orientationRegularization: 0.015,
  });

  // Shape only the sleeve heads after every other accessory has found its
  // rigid pre-dressing pose. The shaft stays on the measured arm axis.
  const beforeSleevePreShape = new Float32Array(garment.positions);
  preShapeSleeveCaps(
    garment,
    sleeveCross,
    underarm,
    sleeveOffset,
    sleeve,
    runs.sleeve.cap,
  );
  if (bodySd) {
    makeInitialPlacementCollisionSafe(
      garment,
      ranges,
      beforeSleevePreShape,
      bodySd,
    );
  }

  // During progressive sewing, keep the canonical torso, continuous rib band,
  // sleeve shafts and cuffs at their authored heights. The arm pieces remain
  // free in X/Z and can settle against the collider, but an armhole stitch
  // cannot drag the whole tube below a horizontal or sloping arm. The existing
  // timed fade releases every point after the cap has dressed.
  const dressingAnchorY = new Float32Array(garment.count).fill(-1e9);
  for (const range of ranges) {
    if (range.pieceId === 3) {
      // Hold only the sagittal crown while the neckline stitches tighten. A
      // completely free hood can slide behind the skull during those first
      // frames; anchoring the whole panel made it fight head collision. This
      // one-dimensional guide is released with every other dressing anchor.
      for (
        let particle = range.first;
        particle < range.first + range.count;
        particle++
      ) {
        const local = particle - range.first;
        const y = garment.positions[particle * 4 + 1]!;
        if (
          garment.invMasses[particle]! > 0 &&
          hoodCenterCells.has(local) &&
          y > body.neckY + 0.035
        ) {
          dressingAnchorY[particle] = y;
        }
      }
      continue;
    }
    if (
      range.pieceId !== 0 &&
      range.pieceId !== 1 &&
      range.pieceId !== 2 &&
      range.pieceId !== 5 &&
      range.pieceId !== 6
    ) {
      continue;
    }
    for (
      let particle = range.first;
      particle < range.first + range.count;
      particle++
    ) {
      if (
        range.pieceId === 2 &&
        Math.floor((particle - range.first) / n) <
          Math.ceil(sleeveShaftStartV(sleeve, runs.sleeve.cap) * (n - 1))
      ) {
        continue;
      }
      if (garment.invMasses[particle]! > 0) {
        dressingAnchorY[particle] = garment.positions[particle * 4 + 1]!;
      }
    }
  }

  return {
    mesh: {
      ...garment,
      // Long multi-piece joins need a calm dressing interval before the normal
      // free simulation takes over.
      anchorY: dressingAnchorY,
      anchorReleaseSeconds: 2.5,
      seamDressingSeconds: 2.5,
    },
    ranges,
  };
}
