/**
 * Lucas Hoodie — exact seven-size cutting pattern extracted from the supplied
 * Illustrator A0 file.  Geometry is never re-drafted parametrically: every
 * point, notch and physical dimension comes from lucasHoodieData.ts.
 */
import type { BodyMeasure } from '../body/measure';
import type {
  AssemblySeam,
  DraftDoc,
  DraftPiece,
  EdgeRun,
  UV,
} from './Draft';
import {
  LUCAS_HOODIE_DATA,
  LUCAS_HOODIE_LANDMARKS,
  LUCAS_HOODIE_SIZES,
  type LucasHoodieLandmarks,
  type LucasHoodiePieceData,
  type LucasHoodieSize,
} from './lucasHoodieData';

export { LUCAS_HOODIE_SIZES, type LucasHoodieSize };

export const LUCAS_SEAM_ALLOWANCE_M = 0.01;
const LUCAS_REFERENCE_STATURE_M = 1.78;

export interface LucasHoodieFit {
  /** Commercial A0 size whose authored curves and landmarks are retained. */
  sourceSize: LucasHoodieSize;
  /** Horizontal and vertical grading applied to every supplied cutting piece. */
  scaleX: number;
  scaleY: number;
  bodyChestCm: number;
  targetFinishedChestCm: number;
  targetFinishedLengthCm: number;
  targetFinishedSleeveCm: number;
}

export interface FrontRuns {
  hem: EdgeRun;
  side: EdgeRun;
  armhole: EdgeRun;
  shoulder: EdgeRun;
  neckline: EdgeRun;
  centerFront: EdgeRun;
}

export interface BackRuns {
  armhole: EdgeRun;
  side: EdgeRun;
  hem: EdgeRun;
  fold: EdgeRun;
  neckline: EdgeRun;
  shoulder: EdgeRun;
}

export interface SleeveRuns {
  underarmA: EdgeRun;
  cuff: EdgeRun;
  underarmB: EdgeRun;
  cap: EdgeRun;
  capA: EdgeRun;
  capB: EdgeRun;
  capTop: number;
}

export interface HoodRuns {
  face: EdgeRun;
  center: EdgeRun;
  neckline: EdgeRun;
}

export interface PocketRuns {
  opening: EdgeRun;
  stitchedEdges: number[];
}

export interface LucasHoodieRuns {
  front: FrontRuns;
  back: BackRuns;
  sleeve: SleeveRuns;
  hood: HoodRuns;
  pocket: PocketRuns;
  cuffEnds: [EdgeRun, EdgeRun];
  waistbandFold: EdgeRun;
}

const cloneOutline = (outline: readonly UV[]): UV[] =>
  outline.map(([u, v]) => [u, v]);

function next(index: number, count: number): number {
  return (index + 1) % count;
}

function cyclicIndices(from: number, to: number, count: number): number[] {
  const out = [((from % count) + count) % count];
  while (out[out.length - 1] !== ((to % count) + count) % count && out.length <= count) {
    out.push(next(out[out.length - 1]!, count));
  }
  return out;
}

function indexOf(
  points: readonly UV[],
  score: (point: UV, index: number) => number,
  candidates = points.map((_point, index) => index),
): number {
  return candidates.reduce((best, index) =>
    score(points[index]!, index) < score(points[best]!, best) ? index : best,
  );
}

function segmentLengthM(piece: DraftPiece, from: number, to: number): number {
  const a = piece.outline[from]!;
  const b = piece.outline[to]!;
  return Math.hypot(
    (b[0] - a[0]) * piece.width,
    (b[1] - a[1]) * piece.height,
  );
}

function cornerTurnRadians(piece: DraftPiece, index: number): number {
  const count = piece.outline.length;
  const previous = piece.outline[(index - 1 + count) % count]!;
  const current = piece.outline[index]!;
  const following = piece.outline[next(index, count)]!;
  const ax = (current[0] - previous[0]) * piece.width;
  const ay = (current[1] - previous[1]) * piece.height;
  const bx = (following[0] - current[0]) * piece.width;
  const by = (following[1] - current[1]) * piece.height;
  const denominator = Math.max(1e-12, Math.hypot(ax, ay) * Math.hypot(bx, by));
  return Math.acos(
    Math.min(1, Math.max(-1, (ax * bx + ay * by) / denominator)),
  );
}

function structuralCorner(
  piece: DraftPiece,
  candidates: readonly number[],
  predicate: (point: UV) => boolean,
): number | null {
  const viable = candidates.filter((index) => {
    if (!predicate(piece.outline[index]!)) return false;
    const previous = (index - 1 + piece.outline.length) % piece.outline.length;
    const following = next(index, piece.outline.length);
    // Source notches are tiny V-shaped excursions with spectacular turn
    // angles. A construction corner has fabric on both sides for at least
    // about 7 mm, so it cannot be mistaken for one of those notch tips.
    return (
      segmentLengthM(piece, previous, index) >= 0.007 &&
      segmentLengthM(piece, index, following) >= 0.007
    );
  });
  if (!viable.length) return null;
  return viable.reduce((best, index) =>
    cornerTurnRadians(piece, index) > cornerTurnRadians(piece, best)
      ? index
      : best,
  );
}

/** Physical length of an authored boundary run, including its sampled curves. */
export function hoodieRunLengthM(piece: DraftPiece, run: EdgeRun): number {
  const indices = cyclicIndices(run.from, run.to, piece.outline.length);
  let length = 0;
  for (let index = 1; index < indices.length; index++) {
    length += segmentLengthM(piece, indices[index - 1]!, indices[index]!);
  }
  return length;
}

function frontRuns(
  piece: DraftPiece,
  landmarks?: LucasHoodieLandmarks,
): FrontRuns {
  const points = piece.outline;
  const count = points.length;
  const maxV = Math.max(...points.map((point) => point[1]));
  const bottom = points
    .map((_point, index) => index)
    .filter((index) => points[index]![1] >= maxV - 0.008);
  const centerBottom = indexOf(points, (point) => -point[0], bottom);
  const sideBottom = indexOf(points, (point) => point[0], bottom);
  const sideTop = next(sideBottom, count);
  const neckShoulder = indexOf(points, (point) => point[1]);
  const armToNeck = cyclicIndices(sideTop, neckShoulder, count);
  const minV = Math.min(...points.map((point) => point[1]));
  const armCorner = structuralCorner(
    piece,
    armToNeck.slice(1, -1),
    (point) => point[1] <= minV + 0.25,
  );
  // The source cut line contains a long transition segment immediately after
  // the visible armscye corner. Lucas assigns that segment to the armscye: it
  // is what makes both shoulder seams and the sleeve cap match at sewing
  // length. The generated landmark is therefore intentionally one sampled
  // vertex after the strongest geometric turn.
  const armholeEnd =
    landmarks?.frontArmholeEnd ??
    (armCorner === null
      ? armToNeck[Math.max(0, armToNeck.length - 2)]!
      : next(armCorner, count));
  const centerCandidates = points
    .map((_point, index) => index)
    .filter((index) => points[index]![0] >= Math.max(...points.map((point) => point[0])) - 0.012);
  const centerTop = indexOf(points, (point) => point[1], centerCandidates);
  return {
    hem: { from: centerBottom, to: sideBottom },
    side: { from: sideBottom, to: sideTop },
    armhole: { from: sideTop, to: armholeEnd },
    shoulder: { from: armholeEnd, to: neckShoulder },
    neckline: { from: neckShoulder, to: centerTop },
    centerFront: { from: centerTop, to: centerBottom },
  };
}

function backRuns(
  piece: DraftPiece,
  landmarks?: LucasHoodieLandmarks,
): BackRuns {
  const points = piece.outline;
  const maxV = Math.max(...points.map((point) => point[1]));
  const bottom = points
    .map((_point, index) => index)
    .filter((index) => points[index]![1] >= maxV - 0.008);
  const sideBottom = indexOf(points, (point) => -point[0], bottom);
  const foldBottom = indexOf(points, (point) => point[0], bottom);
  const sideTop = (sideBottom - 1 + points.length) % points.length;
  const foldTop = next(foldBottom, points.length);
  const neckShoulder = indexOf(points, (point) => point[1]);
  const minV = Math.min(...points.map((point) => point[1]));
  const armShoulder =
    landmarks?.backArmholeStart ??
    structuralCorner(
      piece,
      points.map((_point, index) => index),
      (point) => point[0] >= 0.55 && point[1] <= minV + 0.25,
    ) ??
    (points.length - 1);
  return {
    // The closing SVG edge armShoulder→0 is the first centimetre of the
    // armscye, not the last centimetre of the shoulder.
    armhole: { from: armShoulder, to: sideTop },
    side: { from: sideTop, to: sideBottom },
    hem: { from: sideBottom, to: foldBottom },
    fold: { from: foldBottom, to: foldTop },
    neckline: { from: foldTop, to: neckShoulder },
    shoulder: { from: neckShoulder, to: armShoulder },
  };
}

function sleeveRuns(
  piece: DraftPiece,
  landmarks?: LucasHoodieLandmarks,
): SleeveRuns {
  const points = piece.outline;
  const maxV = Math.max(...points.map((point) => point[1]));
  const bottom = points
    .map((_point, index) => index)
    .filter((index) => points[index]![1] >= maxV - 0.006);
  const cuffLeft = indexOf(points, (point) => point[0], bottom);
  const cuffRight = indexOf(points, (point) => -point[0], bottom);
  const capLeft = indexOf(points, (point) => point[0]);
  const capEnd = landmarks?.sleeveCapEnd ?? points.length - 1;
  // The closing SVG edge capEnd→0 continues the first underarm seam. Treating
  // it as cap ease leaves a real gap at the armpit and makes the two underarm
  // seams differ by exactly that closing edge.
  const cap = { from: capLeft, to: capEnd };
  const capIndices = cyclicIndices(cap.from, cap.to, points.length);
  const capTop =
    landmarks?.sleeveCapTop ??
    indexOf(points, (point) => point[1], capIndices);
  return {
    underarmA: { from: capEnd, to: cuffRight },
    cuff: { from: cuffRight, to: cuffLeft },
    underarmB: { from: cuffLeft, to: capLeft },
    cap,
    capA: { from: capLeft, to: capTop },
    capB: { from: capTop, to: capEnd },
    capTop,
  };
}

function hoodRuns(
  piece: DraftPiece,
  landmarks?: LucasHoodieLandmarks,
): HoodRuns {
  const points = piece.outline;
  const minV = Math.min(...points.map((point) => point[1]));
  const faceCandidates = points
    .map((_point, index) => index)
    .filter((index) => points[index]![1] <= minV + 0.015);
  const faceBottom = indexOf(points, (point) => point[0], faceCandidates);
  const crownFront =
    landmarks?.hoodCrownFront ??
    indexOf(points, (point) => -point[0], faceCandidates);
  const crownToFace = cyclicIndices(crownFront, faceBottom, points.length);
  const centerBackNeck =
    landmarks?.hoodCenterBackNeck ??
    structuralCorner(
      piece,
      crownToFace.slice(1, -1),
      (point) => point[1] >= minV + 0.45,
    ) ??
    indexOf(points, (point) => -point[1]);
  return {
    face: { from: faceBottom, to: crownFront },
    center: { from: centerBackNeck, to: faceBottom },
    neckline: { from: crownFront, to: centerBackNeck },
  };
}

function pocketRuns(piece: DraftPiece): PocketRuns {
  const points = piece.outline;
  const minU = indexOf(points, (point) => point[0]);
  const minV = indexOf(points, (point) => point[1]);
  const opening: EdgeRun = { from: minU, to: minV };
  const openEdges = new Set(
    cyclicIndices(opening.from, opening.to, points.length).slice(0, -1),
  );
  const stitchedEdges: number[] = [];
  const stitchedGeometry = new Set<string>();
  const pointKey = (point: UV): string =>
    `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
  for (let edge = 0; edge < points.length; edge++) {
    if (openEdges.has(edge)) continue;
    const a = pointKey(points[edge]!);
    const b = pointKey(points[next(edge, points.length)]!);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    // Vector notches in the supplied PDF retrace the same cut edge in reverse.
    // Keep the notch in the exact 2D outline, but emit one physical top-stitch
    // for that geometry so it cannot locally double the pocket stiffness.
    if (stitchedGeometry.has(key)) continue;
    stitchedGeometry.add(key);
    stitchedEdges.push(edge);
  }
  return {
    opening,
    stitchedEdges,
  };
}

function bandFold(piece: DraftPiece): EdgeRun {
  const points = piece.outline;
  const minU = Math.min(...points.map((point) => point[0]));
  const fold = points
    .map((_point, edge) => edge)
    .filter((edge) => {
      const a = points[edge]!;
      const b = points[next(edge, points.length)]!;
      return a[0] <= minU + 0.005 && b[0] <= minU + 0.005;
    });
  const edge = fold.reduce((best, candidate) =>
    segmentLengthM(piece, candidate, next(candidate, points.length)) >
    segmentLengthM(piece, best, next(best, points.length))
      ? candidate
      : best,
  );
  return { from: edge, to: next(edge, points.length) };
}

export function lucasHoodieRuns(doc: DraftDoc): LucasHoodieRuns {
  const sleeve = doc.pieces?.[0];
  const hood = doc.pieces?.[1];
  const pocket = doc.pieces?.[2];
  const cuff = doc.pieces?.[3];
  const waistband = doc.pieces?.[4];
  if (!doc.back || !sleeve || !hood || !pocket || !cuff || !waistband) {
    throw new Error('Lucas Hoodie requires its seven supplied cutting pieces');
  }
  const sourceSize = lucasHoodieSourceSize(doc);
  const source = sourceSize ? LUCAS_HOODIE_DATA[sourceSize] : null;
  const sourcePieces = source
    ? [
        source.pieces.front,
        source.pieces.back,
        source.pieces.sleeve,
        source.pieces.hood,
        source.pieces.pocket,
        source.pieces.cuff,
        source.pieces.waistband,
      ]
    : [];
  const currentPieces = [doc.piece, doc.back, sleeve, hood, pocket, cuff, waistband];
  const landmarks =
    sourceSize &&
    sourcePieces.every(
      (piece, index) =>
        piece.outline.length === currentPieces[index]!.outline.length,
    )
      ? LUCAS_HOODIE_LANDMARKS[sourceSize]
      : undefined;
  const cuffPoints = cuff.outline;
  const cuffEdges = cuffPoints
    .map((_point, edge) => edge)
    .sort(
      (a, b) =>
        segmentLengthM(cuff, a, next(a, cuffPoints.length)) -
        segmentLengthM(cuff, b, next(b, cuffPoints.length)),
    );
  const firstCuffEnd = cuffEdges[0]!;
  const secondCuffEnd =
    cuffEdges.find(
      (edge) =>
        edge !== firstCuffEnd &&
        next(edge, cuffPoints.length) !== firstCuffEnd &&
        next(firstCuffEnd, cuffPoints.length) !== edge,
    ) ?? cuffEdges[1]!;
  const cuffEnds: [EdgeRun, EdgeRun] =
    cuffPoints.length === 5
      ? [
          { from: 1, to: 2 },
          // The opposite 16 cm end is split at the on-fold registration point
          // and therefore crosses the SVG closing edge: 3→4→0.
          { from: 3, to: 0 },
        ]
      : [
          { from: firstCuffEnd, to: next(firstCuffEnd, cuffPoints.length) },
          { from: secondCuffEnd, to: next(secondCuffEnd, cuffPoints.length) },
        ];
  return {
    front: frontRuns(doc.piece, landmarks),
    back: backRuns(doc.back, landmarks),
    sleeve: sleeveRuns(sleeve, landmarks),
    hood: hoodRuns(hood, landmarks),
    pocket: pocketRuns(pocket),
    cuffEnds,
    waistbandFold: bandFold(waistband),
  };
}

/** Split the one supplied hood neckline into its front-neck and back-neck
 * sewing runs. The source outline travels from the face opening toward centre
 * back, so the front part comes first. Both returned runs deliberately share
 * their split vertex; the raster compiler then shares the exact same particle
 * at that three-way neck junction. */
export function lucasHoodNecklineRuns(
  doc: DraftDoc,
  runs = lucasHoodieRuns(doc),
): { front: EdgeRun; back: EdgeRun } {
  const hood = doc.pieces?.[1];
  if (!doc.back || !hood) {
    throw new Error('Lucas Hoodie is missing its hood or back piece');
  }
  const indices = cyclicIndices(
    runs.hood.neckline.from,
    runs.hood.neckline.to,
    hood.outline.length,
  );
  const frontLength = hoodieRunLengthM(doc.piece, runs.front.neckline);
  const backLength = hoodieRunLengthM(doc.back, runs.back.neckline);
  const target =
    hoodieRunLengthM(hood, runs.hood.neckline) *
    Math.min(
      0.9,
      Math.max(0.1, frontLength / Math.max(1e-9, frontLength + backLength)),
    );
  let length = 0;
  let split = indices[Math.max(1, indices.length - 1)]!;
  for (let index = 1; index < indices.length; index++) {
    length += segmentLengthM(hood, indices[index - 1]!, indices[index]!);
    if (length >= target) {
      split = indices[index]!;
      break;
    }
  }
  return {
    front: { from: runs.hood.neckline.from, to: split },
    back: { from: split, to: runs.hood.neckline.to },
  };
}

function pieceFromData(
  data: LucasHoodiePieceData,
  options: Pick<DraftPiece, 'name' | 'cut'> &
    Partial<Pick<DraftPiece, 'onFold' | 'fabricPreset' | 'placement'>>,
  topY: number,
): DraftPiece {
  return {
    outline: cloneOutline(data.outline),
    darts: [],
    seams: [],
    openEdges: [],
    ...options,
    width: data.width,
    height: data.height,
    topY,
    gap: 0.52,
  };
}

function seam(
  pieceA: number,
  runA: EdgeRun,
  pieceB: number,
  runB: EdgeRun,
  kind?: 'seam' | 'zipper',
): AssemblySeam {
  return {
    a: { pieceId: pieceA, ...runA },
    b: { pieceId: pieceB, ...runB },
    ...(kind ? { kind } : {}),
    ...(kind === 'zipper' ? { closed: true } : {}),
  };
}

/** UI label for the shared pattern-size selector. */
export function lucasHoodieSizeLabel(size: LucasHoodieSize): string {
  const data = LUCAS_HOODIE_DATA[size];
  return `${size} · poitrine corps ${data.bodyChestCm} cm · vêtement ${data.finishedChestCm.toFixed(1).replace('.', ',')} cm`;
}

/**
 * Return the untouched A0 size behind either a commercial draft (`M`) or a
 * mannequin-adjusted draft (`fit-M`). Keeping this identity lets the adjusted
 * pattern reuse the exact PDF landmarks instead of rediscovering notches from
 * the scaled geometry.
 */
export function lucasHoodieSourceSize(
  doc: Pick<DraftDoc, 'presetSize'>,
): LucasHoodieSize | undefined {
  const value = doc.presetSize?.startsWith('fit-')
    ? doc.presetSize.slice(4)
    : doc.presetSize;
  return LUCAS_HOODIE_SIZES.find((size) => size === value);
}

/**
 * Choose the smallest supplied size that covers chest, waist and hips, then
 * retain Lucas' authored chest-ease proportion. Stature is an independent axis:
 * the commercial range grades only 5.8 cm in length, whereas the workshop
 * mannequins span 140–210 cm.
 */
export function lucasHoodieFit(body: BodyMeasure): LucasHoodieFit {
  const chestCm = body.chest.circ * 100;
  const waistCm = body.waist.circ * 100;
  const hipCm = body.hip.circ * 100;
  const sourceSize =
    LUCAS_HOODIE_SIZES.find((size) => {
      const data = LUCAS_HOODIE_DATA[size];
      return (
        chestCm <= data.bodyChestCm &&
        waistCm <= data.bodyWaistCm &&
        hipCm <= data.bodyHipCm
      );
    }) ?? LUCAS_HOODIE_SIZES[LUCAS_HOODIE_SIZES.length - 1]!;
  const source = LUCAS_HOODIE_DATA[sourceSize];
  const targetFinishedChestCm =
    chestCm * (source.finishedChestCm / source.bodyChestCm);
  // Four one-centimetre side allowances are removed from the complete front
  // + back cut perimeter by the 3D assembler. Include them on both sides of
  // the ratio so that fixed seam allowance remains 1 cm after grading.
  const scaleX =
    (targetFinishedChestCm + 4) / (source.finishedChestCm + 4);
  const scaleY = body.height / LUCAS_REFERENCE_STATURE_M;
  return {
    sourceSize,
    scaleX,
    scaleY,
    bodyChestCm: chestCm,
    targetFinishedChestCm,
    targetFinishedLengthCm: source.finishedLengthCm * scaleY,
    targetFinishedSleeveCm: source.finishedSleeveCm * scaleY,
  };
}

/**
 * Grade a faithful A0 size onto the current mannequin without changing a
 * single normalized outline point. The same two-axis transform is applied to
 * all seven pieces, so matched edges remain governed by the same construction
 * logic while the overall volume and stature stop drifting apart.
 */
export function lucasHoodieAdjusted(body: BodyMeasure): DraftDoc {
  const fit = lucasHoodieFit(body);
  const draft = lucasHoodie(fit.sourceSize, body);
  const allPieces = [draft.piece, draft.back!, ...(draft.pieces ?? [])];
  for (const piece of allPieces) {
    piece.width *= fit.scaleX;
    piece.height *= fit.scaleY;
  }
  // Eight characters at most, so this survives DraftDoc sanitisation even for
  // the largest source size (`fit-XXXL`).
  draft.presetSize = `fit-${fit.sourceSize}`;
  return draft;
}

/**
 * Exact finished zipper length derived from the selected cutting line.  The
 * body centre-front loses 1 cm at the waist join and 1 cm at the hood/neck
 * join; the 16 cm rib band folds to 8 cm and loses 1 cm at its attachment.
 */
export function lucasZipperLengthM(doc: DraftDoc): number {
  const runs = lucasHoodieRuns(doc);
  const bodyEdge = hoodieRunLengthM(doc.piece, runs.front.centerFront);
  const waistband = doc.pieces?.[4];
  if (!waistband) return bodyEdge;
  const cutHeight = Math.max(
    ...waistband.outline.map((point) => point[1]),
  ) - Math.min(...waistband.outline.map((point) => point[1]));
  const physicalCutHeight = cutHeight * waistband.height;
  const finishedBand = physicalCutHeight / 2 - LUCAS_SEAM_ALLOWANCE_M;
  return Math.max(0, bodyEdge - 2 * LUCAS_SEAM_ALLOWANCE_M + finishedBand);
}

export function lucasHoodie(
  size: LucasHoodieSize,
  body: BodyMeasure,
): DraftDoc {
  const data = LUCAS_HOODIE_DATA[size];
  // Align the pattern's highest neckline/shoulder allowance with the base of
  // the measured neck. On a T-pose scan `shoulderY` is the top of the broad
  // arm band and can sit 10–12 cm below `neckY`; using it directly dropped the
  // complete armscye about 7 cm below the sleeve cap, opening shoulder holes
  // and creating the characteristic batwing pull during sewing.
  const topY = Math.max(body.shoulderY + 0.035, body.neckY - 0.025);
  const front = pieceFromData(
    data.pieces.front,
    { name: 'Devant ×2', cut: 2, fabricPreset: 'Maille' },
    topY,
  );
  const back = pieceFromData(
    data.pieces.back,
    { name: 'Dos au pli ×1', cut: 1, onFold: true, fabricPreset: 'Maille' },
    topY,
  );
  const sleeve = pieceFromData(
    data.pieces.sleeve,
    {
      name: 'Manche ×2',
      cut: 2,
      fabricPreset: 'Maille',
      placement: { role: 'armL', autoAlign: true },
    },
    topY,
  );
  const hood = pieceFromData(
    data.pieces.hood,
    {
      name: 'Capuche ×2',
      cut: 2,
      fabricPreset: 'Maille',
      placement: { role: 'neck', autoAlign: true },
    },
    body.neckY + data.pieces.hood.width,
  );
  const pocket = pieceFromData(
    data.pieces.pocket,
    { name: 'Poche ×2', cut: 2, fabricPreset: 'Maille' },
    topY - front.height * 0.55,
  );
  const cuff = pieceFromData(
    data.pieces.cuff,
    { name: 'Poignet bord-côte ×2', cut: 2, fabricPreset: 'Maille' },
    body.waist.y,
  );
  const waistband = pieceFromData(
    data.pieces.waistband,
    {
      name: 'Ceinture bord-côte au pli ×1',
      cut: 1,
      onFold: true,
      fabricPreset: 'Maille',
    },
    body.waist.y,
  );

  const draft: DraftDoc = {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: front,
    back,
    pieces: [sleeve, hood, pocket, cuff, waistband],
    manual: true,
    seams: [],
    preset: 'lucas-hoodie',
    presetSize: size,
  };
  const runs = lucasHoodieRuns(draft);
  const hoodNeckline = lucasHoodNecklineRuns(draft, runs);
  pocket.openEdges = [runs.pocket.opening];
  pocket.placement = {
    role: 'pocket',
    surface: {
      supportPieceId: 0,
      anchor: [0.53, 0.77],
      stitchedEdges: runs.pocket.stitchedEdges,
    },
  };
  // The seam list is construction metadata for the editable 2D workshop.
  // Repeated cut pieces represent both symmetric physical instances.
  draft.seams = [
    seam(0, runs.front.centerFront, 0, runs.front.centerFront, 'zipper'),
    seam(0, runs.front.shoulder, 1, runs.back.shoulder),
    seam(0, runs.front.side, 1, runs.back.side),
    // The lateral sleeve notch is on capB and matches the front armscye notch;
    // capA is the back half (confirmed against the supplied A0 layers).
    seam(0, runs.front.armhole, 2, runs.sleeve.capB),
    seam(1, runs.back.armhole, 2, runs.sleeve.capA),
    seam(2, runs.sleeve.underarmA, 2, runs.sleeve.underarmB),
    seam(3, runs.hood.center, 3, runs.hood.center),
    seam(0, runs.front.neckline, 3, hoodNeckline.front),
    seam(1, runs.back.neckline, 3, hoodNeckline.back),
    seam(5, runs.cuffEnds[0], 5, runs.cuffEnds[1]),
  ];
  return draft;
}
