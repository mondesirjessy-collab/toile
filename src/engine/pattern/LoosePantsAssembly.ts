/**
 * Four-panel trouser assembly:
 *   left front ↔ left back, right front ↔ right back (inseams/outseams)
 *   left front ↔ right front, left back ↔ right back (crotch/centre seams)
 *
 * The generic atelier builder makes one front/back tube. Trousers require two
 * mirrored tubes joined at the rise, so this small specialised compiler keeps
 * the exact editable DraftPieces while producing the correct four panels.
 */
import {
  combineClothMeshes,
  generateSeamedPanels,
  type ClothMeshData,
  type CrossSeam,
} from '../cloth/ClothMesh';
import {
  compileAssembly,
  compileDraft,
  pairOutlineRuns,
  type DraftDoc,
} from './Draft';
import { pantsRuns } from './loosePants';

export function buildLoosePantsMesh(
  doc: DraftDoc,
  resolution: number,
  hipCircumferenceM: number,
): ClothMeshData {
  const front = doc.piece;
  const back = doc.back;
  if (!back) throw new Error('Loose pants require independent front and back pieces');

  const frontCompiled = compileDraft(front, resolution);
  const backCompiled = compileDraft(back, resolution);
  const n = resolution;
  const cellOpen =
    (set: Set<number>) =>
    (u: number, v: number): boolean =>
      set.has(Math.round(v * (n - 1)) * n + Math.round(u * (n - 1)));

  const makeLeg = (): ClothMeshData =>
    generateSeamedPanels({
      resolution,
      width: front.width,
      height: front.height,
      gap: front.gap,
      topY: front.topY,
      shape: 'freeform',
      mask: { outline: front.outline, darts: front.darts },
      maskBack: { outline: back.outline, darts: back.darts },
      extraSeams: frontCompiled.extraSeams,
      extraSeamsBack: backCompiled.extraSeams,
      extraOpenings: cellOpen(frontCompiled.openCells),
      extraOpeningsBack: cellOpen(backCompiled.openCells),
      manualAssembly: true,
      assemblySeams: compileAssembly(doc, resolution),
      // Hold the waist only while the four flat panels sew themselves closed.
      // The final combined mesh releases this dressing aid automatically.
      anchorTop: true,
      // The cut outline includes its 1.25 cm allowance; a slightly shorter top
      // rest length approximates the actual waistband seam line.
      elasticTop: 0.97,
      // The supplied construction uses an interfaced, buttoned waistband.
      // Keep that band dimensionally stable even if the user previews the
      // trousers with a stretchy fabric preset such as Jersey.
      reinforceTop: true,
    });

  const left = makeLeg();
  const right = makeLeg();
  const legCenter = Math.min(0.12, Math.max(0.075, hipCircumferenceM * 0.1));

  for (let i = 0; i < left.count; i++) {
    // The source outline runs from the centre/inseam at the LEFT of the paper
    // piece to the outseam at the RIGHT. It therefore belongs, unmirrored, on
    // the avatar's RIGHT leg. The left leg must be its mirror. Reversing these
    // placements puts both inseams on the outside and makes the crotch seams
    // pull the two leg tubes through one another.
    left.positions[i * 4] = -left.positions[i * 4]! - legCenter;
    right.positions[i * 4] = right.positions[i * 4]! + legCenter;
  }

  const panelSize = n * n;
  const frontCenter = pantsRuns(front).center;
  const backCenter = pantsRuns(back).center;
  const frontPairs = pairOutlineRuns(front, front, frontCenter, frontCenter, n);
  const backPairs = pairOutlineRuns(back, back, backCenter, backCenter, n);
  const cross: CrossSeam[] = [];

  const add = (
    paired: { a: number[]; b: number[] } | null,
    panelOffset: number,
  ): void => {
    if (!paired) return;
    for (let i = 0; i < paired.a.length; i++) {
      cross.push({
        i: panelOffset + paired.a[i]!,
        j: left.count + panelOffset + paired.b[i]!,
      });
    }
  };
  add(frontPairs, 0);
  add(backPairs, panelSize);

  return {
    ...combineClothMeshes(left, right, cross),
    // The long rise and leg seams start several centimetres apart; keep their
    // dressing support long enough to converge before releasing the waistband.
    // The solver then fades the hold over 0.6 s.
    anchorReleaseSeconds: 3,
  };
}
