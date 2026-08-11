/**
 * cloBlocks — reconstruit dans TOILE les blocs de CLO (tee Set-In + pantalon
 * Trousers) extraits par DXF au millimètre (cloBlocksData.ts), gradés sur les
 * mensurations de l'avatar comme oversizeTee / loosePants. Le pantalon réutilise
 * `pantsRuns` (récupération des repères par géométrie) ; le tee a son propre
 * `teeRuns`. Pur — aucun import moteur/GPU.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun, UV } from './Draft';
import { CLO_BLOCKS, CLO_BODY } from './cloBlocksData';
import { pantsRuns } from './loosePants';

const clone = (o: readonly UV[]): UV[] => o.map(([u, v]) => [u, v]);

// ------------------------------------------------------------------ TEE ----
export interface TeeRuns {
  neckline: EdgeRun;
  armholeR: EdgeRun;
  armholeL: EdgeRun;
  shoulderR: EdgeRun;
  shoulderL: EdgeRun;
  sideR: EdgeRun;
  sideL: EdgeRun;
  hem: EdgeRun;
}

/**
 * Récupère les repères d'un devant/dos de tee depuis la géométrie du contour
 * (v=0 en haut, symétrique autour de u=0,5), sans indices figés — le contour
 * CLO n'a pas l'ordre de sommets de boxyData. On repère : les deux pointes
 * d'épaule (sommets hauts extrêmes), les deux dessous de bras (u extrêmes au-
 * dessus de la mi-hauteur), les deux coins d'ourlet (v max), et le centre
 * d'encolure. Les runs suivent l'ordre du contour dans le sens du tracé.
 */
export function teeRuns(piece: DraftPiece): TeeRuns {
  const p = piece.outline;
  const n = p.length;
  const minV = Math.min(...p.map((q) => q[1]));
  const maxV = Math.max(...p.map((q) => q[1]));
  const spanV = Math.max(1e-6, maxV - minV);
  const idxWhere = (score: (q: UV, i: number) => number): number => {
    let best = 0;
    for (let i = 1; i < n; i++) if (score(p[i]!, i) < score(p[best]!, best)) best = i;
    return best;
  };
  // Épaule = point le plus haut de chaque moitié (min v, |u-0.5| notable).
  const shoulderR = idxWhere((q) => q[1] + (q[0] > 0.5 ? 0 : 2)); // droite = u>0.5
  const shoulderL = idxWhere((q) => q[1] + (q[0] < 0.5 ? 0 : 2));
  // Dessous de bras = u extrême dans la bande haute [minV, 0,55·spanV].
  const upper = (q: UV): boolean => q[1] <= minV + 0.55 * spanV;
  const underarmR = idxWhere((q) => (upper(q) ? -q[0] : 10)); // max u
  const underarmL = idxWhere((q) => (upper(q) ? q[0] : 10)); // min u
  // Ourlet = deux coins bas.
  const low = (q: UV): boolean => q[1] >= maxV - 0.03 * spanV;
  const hemR = idxWhere((q) => (low(q) ? -q[0] : 10));
  const hemL = idxWhere((q) => (low(q) ? q[0] : 10));
  // Centre d'encolure = point le plus proche de u=0,5 au-dessus de l'épaule.
  const neckMid = idxWhere((q) => Math.abs(q[0] - 0.5) + (q[1] <= minV + 0.3 * spanV ? 0 : 5));

  // Le devant et le dos de CLO tournent en sens INVERSES : un run from→to peut
  // parcourir 90 % du périmètre selon la pièce. Tous ces bords (épaule, côté,
  // emmanchure, encolure, ourlet) sont COURTS — on oriente chaque run dans le
  // sens qui longe le bord (arc mini), indépendamment du sens du contour.
  const arc = (from: number, to: number): number => {
    let l = 0;
    let i = from;
    let guard = 0;
    while (i !== to && guard++ < n + 1) {
      const j = (i + 1) % n;
      l += Math.hypot(p[i]![0] - p[j]![0], p[i]![1] - p[j]![1]);
      i = j;
    }
    return l;
  };
  const run = (a: number, b: number): EdgeRun =>
    arc(a, b) <= arc(b, a) ? { from: a, to: b } : { from: b, to: a };
  return {
    neckline: run(shoulderL, shoulderR),
    armholeR: run(shoulderR, underarmR),
    armholeL: run(underarmL, shoulderL),
    shoulderR: run(neckMid, shoulderR),
    shoulderL: run(shoulderL, neckMid),
    sideR: run(underarmR, hemR),
    sideL: run(hemL, underarmL),
    hem: run(hemR, hemL),
  };
}

function scaledOutline(data: { outline: UV[] }): UV[] {
  return clone(data.outline);
}

/**
 * Tee Set-In de CLO, gradé sur l'avatar. Devant col en V + dos ras-du-cou,
 * cousus épaules + côtés ; manches WRAP (tête de manche = bouche du tube) ;
 * col bord-côte WRAP. Largeur ← poitrine, hauteur ← stature (ratios CLO).
 */
export function cloTee(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const sx = (m.chest.circ * 100) / CLO_BODY.chestCm; // grade largeur ← poitrine
  const sy = (m.height * 100) / CLO_BODY.heightCm; // grade hauteur ← stature
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);
  const F = CLO_BLOCKS.teeFront;
  const B = CLO_BLOCKS.teeBack;
  const S = CLO_BLOCKS.teeSleeve;
  const C = CLO_BLOCKS.teeCollar;

  const face = (data: { outline: UV[]; wCm: number; hCm: number }): DraftPiece => {
    const piece: DraftPiece = {
      outline: scaledOutline(data),
      darts: [],
      seams: [],
      openEdges: [],
      width: (data.wCm / 100) * sx,
      height: (data.hCm / 100) * sy,
      topY,
      gap: 0.9,
    };
    const r = teeRuns(piece);
    piece.openEdges = [r.neckline, r.armholeR, r.hem, r.armholeL];
    return piece;
  };
  const front = face(F);
  const back = face(B);
  const fr = teeRuns(front);
  const br = teeRuns(back);

  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => ({
    outline: scaledOutline(S),
    darts: [],
    seams: [],
    openEdges: [],
    width: (S.wCm / 100) * sx * 0.5, // un panneau = une moitié du tube
    height: (S.hCm / 100) * sy,
    topY: m.shoulderY + 0.01,
    gap: 0.2,
    wrap,
    placement: { role: wrap, autoAlign: true },
  });
  const band = (): DraftPiece => ({
    outline: [
      [-0.01, -0.01],
      [1.01, -0.01],
      [1.01, 1.01],
      [-0.01, 1.01],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    width: 0.85 * (C.wCm / 100) * sx * 0.5,
    height: (C.hCm / 100) * sy,
    topY: m.neckY - 0.005,
    gap: 0.15,
    wrap: 'neck',
    placement: { role: 'neck', autoAlign: true },
  });

  const seam = (a: EdgeRun, b: EdgeRun): AssemblySeam => ({
    a: { face: 'front', ...a },
    b: { face: 'back', ...b },
  });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: front,
    back,
    manual: true,
    pieces: [sleeve('armR'), sleeve('armL'), band()],
    seams: [
      seam(fr.shoulderR, br.shoulderR),
      seam(fr.shoulderL, br.shoulderL),
      seam(fr.sideR, br.sideR),
      seam(fr.sideL, br.sideL),
    ],
    // Pas de preset : le tee passe par l'assemblage générique (devant + dos
    // cousus épaules/côtés, manches WRAP, col WRAP) — le même chemin éprouvé
    // que boxyTee.
  };
}

// ---------------------------------------------------------------- PANTS ----
/**
 * Pantalon Trousers de CLO, gradé sur l'avatar. Jambe devant + jambe dos
 * (chacune coupée ×2) cousues à la couture de côté et d'entrejambe ; ceinture.
 * Réutilise `pantsRuns` (repères par géométrie) comme loosePants. Largeur ←
 * bassin, hauteur ← stature, ceinture ← taille.
 */
export function cloPants(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  void ref;
  const sx = (m.hip.circ * 100) / CLO_BODY.hipCm; // grade largeur ← bassin
  const sy = (m.height * 100) / CLO_BODY.heightCm; // grade longueur ← stature
  const F = CLO_BLOCKS.pantFront;
  const B = CLO_BLOCKS.pantBack;
  const W = CLO_BLOCKS.pantWaistband;
  const frameWidth = (Math.max(F.wCm, B.wCm) / 100) * sx;
  const frameHeight = (Math.max(F.hCm, B.hCm) / 100) * sy;
  const topY = m.waist.y + 0.055;
  const gap = Math.min(0.34, Math.max(0.22, (m.hip.circ / Math.PI) * 0.72));

  // Replace chaque contour (normalisé sur SON cadre) dans le cadre commun.
  const inFrame = (data: { outline: UV[]; wCm: number; hCm: number }): UV[] =>
    data.outline.map(([u, v]) => {
      const x = (u - 0.5) * (data.wCm / 100) * sx;
      const y = v * (data.hCm / 100) * sy;
      return [0.5 + x / frameWidth, (y / frameHeight) as number];
    });

  const leg = (data: { outline: UV[]; wCm: number; hCm: number }, name: string): DraftPiece => {
    const piece: DraftPiece = {
      outline: inFrame(data),
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
    const r = pantsRuns(piece);
    piece.openEdges = [r.center, r.waist, r.hem];
    return piece;
  };
  const front = leg(F, 'devant ×2');
  const back = leg(B, 'dos ×2');
  const fr = pantsRuns(front);
  const br = pantsRuns(back);

  const waistband: DraftPiece = {
    outline: clone(W.outline),
    darts: [],
    seams: [],
    openEdges: [{ from: 0, to: 0 }],
    name: 'ceinture pli ×1',
    cut: 1,
    onFold: true,
    patternOnly: true,
    width: (W.wCm / 100) * ((m.waist.circ * 100) / CLO_BODY.waistCm),
    height: (W.hCm / 100) * sy,
    topY,
    gap: 0.12,
  };

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
    seams: [seam(fr.outseam, br.outseam), seam(fr.inseam, br.inseam)],
    pieces: [waistband],
    // Réutilise le preset loose-pants : buildLoosePantsMesh n'a besoin que du
    // devant et du dos (4 panneaux, deux jambes miroir), la ceinture reste
    // patternOnly — toute la machinerie pantalon éprouvée s'applique.
    preset: 'loose-pants',
  };
}
