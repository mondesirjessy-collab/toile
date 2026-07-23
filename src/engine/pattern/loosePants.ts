/**
 * Men's wide-leg loose trousers supplied as a layered A0 sewing pattern.
 *
 * Every outline below comes from loosePantsData.ts, generated directly from
 * the selected PDF size layer at 1/72-inch scale.  The pieces are editable
 * DraftPieces; seam allowance (1.25 cm) is already part of the cut line.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun, UV } from './Draft';
import {
  LOOSE_PANTS_DATA,
  LOOSE_PANTS_SIZES,
  type LoosePantsPieceData,
  type LoosePantsSize,
} from './loosePantsData';

export { LOOSE_PANTS_SIZES, type LoosePantsSize };

export interface PantsRuns {
  center: EdgeRun;
  waist: EdgeRun;
  outseam: EdgeRun;
  hem: EdgeRun;
  inseam: EdgeRun;
}

const cloneOutline = (outline: readonly UV[]): UV[] =>
  outline.map(([u, v]) => [u, v]);

/** Fit pieces of different source dimensions into one physical simulation
 * frame without changing their cut dimensions. */
function inFrame(
  data: LoosePantsPieceData,
  width: number,
  height: number,
): UV[] {
  return data.outline.map(([u, v]) => {
    const x = (u - 0.5) * data.width;
    const y = v * data.height;
    return [0.5 + x / width, y / height];
  });
}

/** Construction landmarks are recovered from the stable geometry rather than
 * hard-coded vertex numbers, so all 16 graded sizes share the same assembly. */
export function pantsRuns(piece: DraftPiece): PantsRuns {
  const points = piece.outline;
  const minV = Math.min(...points.map((p) => p[1]));
  const maxV = Math.max(...points.map((p) => p[1]));
  const spanV = Math.max(1e-6, maxV - minV);
  const count = points.length;
  const indexOf = (score: (p: UV) => number, candidates = points.map((_p, i) => i)): number =>
    candidates.reduce((best, i) => (score(points[i]!) < score(points[best]!) ? i : best));

  // The graded waist is not perfectly horizontal. At larger sizes its outer
  // endpoint can even sit a few millimetres above centre front, so the global
  // minimum-Y vertex is NOT a stable centre-waist landmark. Recover the
  // contiguous near-horizontal top run instead: it begins immediately after
  // the centre-rise curve and ends immediately before the outseam.
  const topLimit = minV + 0.04 * spanV;
  const isTop = points.map((p) => p[1] <= topLimit);
  const entries = points
    .map((_p, i) => i)
    .filter((i) => isTop[i] && !isTop[(i - 1 + count) % count]);
  const waistStart = entries.length
    ? indexOf((p) => p[0], entries)
    : indexOf((p) => p[1]);
  let sideTop = waistStart;
  for (let step = 1; step < count; step++) {
    const i = (waistStart + step) % count;
    if (!isTop[i]) break;
    sideTop = i;
  }
  const hem = points
    .map((_p, i) => i)
    .filter((i) => points[i]![1] >= maxV - 0.025 * spanV);
  const hemRight = indexOf((p) => -p[0], hem);
  const hemLeft = indexOf((p) => p[0], hem);
  const innerTop = indexOf((p) => p[0]);

  return {
    center: { from: innerTop, to: waistStart },
    waist: { from: waistStart, to: sideTop },
    outseam: { from: sideTop, to: hemRight },
    hem: { from: hemRight, to: hemLeft },
    inseam: { from: hemLeft, to: innerTop },
  };
}

/** Text shown in the shared size selector. */
export function loosePantsSizeLabel(size: LoosePantsSize): string {
  const d = LOOSE_PANTS_DATA[size];
  return `${size} · ${d.alpha} / EU ${d.eu} · taille ${d.waistRangeCm} cm · bassin ${d.hipRangeCm} cm`;
}

export function loosePants(size: LoosePantsSize, body: BodyMeasure): DraftDoc {
  const data = LOOSE_PANTS_DATA[size];
  const sourceFront = data.pieces.front;
  const sourceBack = data.pieces.back;
  const frameWidth = Math.max(sourceFront.width, sourceBack.width);
  const frameHeight = Math.max(sourceFront.height, sourceBack.height);
  const topY = body.waist.y + 0.055;
  const gap = Math.min(0.34, Math.max(0.22, (body.hip.circ / Math.PI) * 0.72));

  const main = (
    source: LoosePantsPieceData,
    name: string,
  ): DraftPiece => {
    const piece: DraftPiece = {
      outline: inFrame(source, frameWidth, frameHeight),
      darts: [],
      seams: [],
      openEdges: [],
      name,
      cut: 2,
      width: frameWidth,
      height: frameHeight,
      topY,
      gap,
    };
    const runs = pantsRuns(piece);
    piece.openEdges = [runs.center, runs.waist, runs.hem];
    return piece;
  };

  const construction = (
    source: LoosePantsPieceData,
    name: string,
    cut: number,
    onFold = false,
  ): DraftPiece => ({
    outline: cloneOutline(source.outline),
    darts: [],
    seams: [],
    openEdges: [{ from: 0, to: 0 }],
    name,
    cut,
    ...(onFold ? { onFold: true } : {}),
    patternOnly: true,
    width: source.width,
    height: source.height,
    topY,
    gap: 0.12,
  });

  const front = main(sourceFront, 'devant ×2');
  const back = main(sourceBack, 'dos ×2');
  const frontRuns = pantsRuns(front);
  const backRuns = pantsRuns(back);
  const seam = (a: EdgeRun, b: EdgeRun): AssemblySeam => ({
    a: { pieceId: 0, ...a },
    b: { pieceId: 1, ...b },
  });

  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: front,
    back,
    manual: true,
    seams: [
      seam(frontRuns.outseam, backRuns.outseam),
      seam(frontRuns.inseam, backRuns.inseam),
    ],
    pieces: [
      construction(data.pieces.backPocket, 'poche dos ×2', 2),
      construction(data.pieces.pocketFacing, 'parement ×2', 2),
      construction(data.pieces.pocketBag, 'fond poche ×2', 2),
      construction(data.pieces.fly, 'braguette ×1', 1),
      construction(data.pieces.flyShield, 'sous-patte ×1', 1),
      construction(data.pieces.waistband, 'ceinture pli ×1', 1, true),
    ],
    preset: 'loose-pants',
    presetSize: size,
  };
}
