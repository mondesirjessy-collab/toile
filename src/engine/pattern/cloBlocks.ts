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
  // Jonction col↔épaule = point le plus HAUT de chaque moitié (v min). C'est là
  // que l'encolure rejoint l'épaule — PAS la couture d'épaule (l'ancienne version
  // confondait les deux et cousait les demi-encolures devant↔dos, d'où le col
  // froncé).
  const junctionR = idxWhere((q) => q[1] + (q[0] > 0.5 ? 0 : 2)); // droite = u>0.5
  const junctionL = idxWhere((q) => q[1] + (q[0] < 0.5 ? 0 : 2));
  // Pointe d'épaule = point le plus LARGE de la bande haute (au-dessus de
  // l'emmanchure), là où l'épaule rejoint l'emmanchure. La couture d'épaule va
  // de la pointe à la jonction col ; l'emmanchure part de la pointe vers le bas.
  const shoulderBand = (q: UV): boolean => q[1] <= minV + 0.16 * spanV;
  const tipR = idxWhere((q) => (shoulderBand(q) ? -q[0] : 10)); // max u
  const tipL = idxWhere((q) => (shoulderBand(q) ? q[0] : 10)); // min u
  // Dessous de bras = u extrême dans la bande [minV, 0,6·spanV].
  const upper = (q: UV): boolean => q[1] <= minV + 0.6 * spanV;
  const underarmR = idxWhere((q) => (upper(q) ? -q[0] : 10)); // max u
  const underarmL = idxWhere((q) => (upper(q) ? q[0] : 10)); // min u
  // Ourlet = deux coins bas.
  const low = (q: UV): boolean => q[1] >= maxV - 0.03 * spanV;
  const hemR = idxWhere((q) => (low(q) ? -q[0] : 10));
  const hemL = idxWhere((q) => (low(q) ? q[0] : 10));

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
    neckline: run(junctionL, junctionR), // ouvert — reçoit la bande de col
    shoulderR: run(tipR, junctionR), // couture d'épaule D (pointe → jonction col)
    shoulderL: run(junctionL, tipL), // couture d'épaule G
    armholeR: run(underarmR, tipR), // ouvert — reçoit la manche
    armholeL: run(tipL, underarmL), // ouvert — reçoit la manche
    sideR: run(underarmR, hemR),
    sideL: run(hemL, underarmL),
    hem: run(hemR, hemL),
  };
}

function scaledOutline(data: { outline: UV[] }): UV[] {
  return clone(data.outline);
}

/**
 * Remplace l'encolure d'une face (devant/dos) par un COL ROND (ras-du-cou) :
 * on garde la largeur d'encolure de CLO (jonctions col↔épaule inchangées, donc
 * les coutures d'épaule restent appariées devant↔dos) mais on redessine le bord
 * en arc lisse et peu profond — un vrai col rond au lieu du décolleté d'origine.
 * `depthCm` = profondeur au centre sous la ligne d'épaule ; `hCm` = hauteur de la
 * pièce à plat (pour convertir en v normalisé). v=0 en haut.
 */
function roundNeck(outline: UV[], depthCm: number, hCm: number, sy: number): UV[] {
  const n = outline.length;
  // Jonctions col↔épaule = point le plus haut (v min) de chaque moitié.
  let iR = -1;
  let iL = -1;
  let vR = Infinity;
  let vL = Infinity;
  for (let i = 0; i < n; i++) {
    const [u, v] = outline[i]!;
    if (u > 0.5 && v < vR) { vR = v; iR = i; }
    if (u <= 0.5 && v < vL) { vL = v; iL = i; }
  }
  if (iR < 0 || iL < 0) return outline;
  // Ourlet = v max ; l'arc entre jonctions qui le contient est le CORPS, l'autre
  // est l'encolure (celle qu'on remplace).
  let iHem = 0;
  let vHem = -Infinity;
  for (let i = 0; i < n; i++) if (outline[i]![1] > vHem) { vHem = outline[i]![1]; iHem = i; }
  const containsHem = (from: number, to: number): boolean => {
    let i = from;
    let guard = 0;
    while (guard++ < n + 1) { if (i === iHem) return true; if (i === to) return false; i = (i + 1) % n; }
    return false;
  };
  const bodyFromL = containsHem(iL, iR);
  const start = bodyFromL ? iL : iR;
  const end = bodyFromL ? iR : iL;
  // Arc corps : start → end (inclus), en longeant l'ourlet.
  const body: UV[] = [];
  let i = start;
  let guard = 0;
  while (guard++ < n + 1) { body.push(outline[i]!); if (i === end) break; i = (i + 1) % n; }
  // Arc col rond : de la jonction `end` vers la jonction `start`, en passant par
  // le centre (u=0,5) à la profondeur voulue. sin(πt) → 0 aux jonctions, max au
  // centre (jonctions symétriques autour de u=0,5 sur les blocs CLO).
  const uEnd = outline[end]![0];
  const uStart = outline[start]![0];
  const depthV = depthCm / (hCm * sy); // depthCm ÷ hauteur pièce (cm) = v normalisé
  const K = 16;
  const arc: UV[] = [];
  for (let k = 1; k < K; k++) {
    const t = k / K;
    arc.push([uEnd + (uStart - uEnd) * t, depthV * Math.sin(Math.PI * t)]);
  }
  return [...body, ...arc];
}

/** Longueur physique (m) d'un run le long du contour d'une pièce. */
function runLenM(piece: DraftPiece, run: EdgeRun): number {
  const p = piece.outline;
  const N = p.length;
  const ph = (q: UV): [number, number] => [q[0] * piece.width, q[1] * piece.height];
  let len = 0;
  let i = run.from;
  let guard = 0;
  while (i !== run.to && guard++ < N + 1) {
    const a = ph(p[i]!);
    const j = (i + 1) % N;
    const b = ph(p[j]!);
    len += Math.hypot(a[0] - b[0], a[1] - b[1]);
    i = j;
  }
  return len;
}

/**
 * Tee Set-In de CLO, gradé sur l'avatar. Col ROND (ras-du-cou) devant et dos,
 * corps devant + dos cousus aux épaules (jonction col → pointe d'épaule) et aux
 * côtés ; manches montées en demi-panneau WRAP ; bande de col bord-côte WRAP
 * taillée au tour d'encolure réel. Largeur ← poitrine, hauteur ← stature.
 */
export function cloTee(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const sx = (m.chest.circ * 100) / CLO_BODY.chestCm; // grade largeur ← poitrine
  const sy = (m.height * 100) / CLO_BODY.heightCm; // grade hauteur ← stature
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);
  const F = CLO_BLOCKS.teeFront;
  const B = CLO_BLOCKS.teeBack;
  const S = CLO_BLOCKS.teeSleeve;

  const face = (data: { outline: UV[]; wCm: number; hCm: number }, neckDepthCm: number): DraftPiece => {
    const piece: DraftPiece = {
      outline: roundNeck(scaledOutline(data), neckDepthCm, data.hCm, sy),
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
  // Col ROND : encolure devant peu profonde (~7 cm sous l'épaule) et dos ras
  // (~2,5 cm), redessinées en arc lisse — le col rond demandé, à la place du
  // décolleté d'origine du bloc CLO.
  const front = face(F, 7);
  const back = face(B, 2.5);
  const fr = teeRuns(front);
  const br = teeRuns(back);

  // CLO exporte sa manche set-in en contour PLEIN (teeSleeve : tête arrondie au
  // milieu, les deux dessous-de-bras aux coins hauts, poignet fuselé). Mais
  // TOILE monte la manche par un DEMI-PANNEAU WRAP : sleeveCrossSeams construit
  // 2 panneaux (moitié devant + moitié dos) et épingle la bouche de chacun à
  // l'emmanchure devant/dos — exactement comme boxyTee / oversizeTee. Plaquer le
  // contour PLEIN de CLO dans cette fente demi-panneau froissait le tube et
  // laissait l'emmanchure béante (le vice « l'assemblage ne rend pas pareil »).
  // On ré-émet donc la manche en demi-panneau, aux COTES MESURÉES sur teeSleeve :
  // poignet = 63 % du biceps (ouverture [0,183…0,817]), demi-biceps et longueur
  // (59,5 cm) gradés comme le reste. La HAUTEUR de tête, elle, n'est pas la cote
  // brute de CLO (tête pleine set-in) mais calée sur la LONGUEUR d'emmanchure du
  // corps : la bouche du demi-panneau (≈ largeur + flèche de la tête) doit égaler
  // l'emmanchure (≈ 22 cm) sinon l'excédent de tissu godaille et ouvre l'épaule.
  // CAP ≈ 0,11 donne une bouche ≈ emmanchure → montage net (à CAP=0,205 la bouche
  // faisait ~31 cm contre 22 cm d'emmanchure : +45 %, d'où les trous à l'épaule).
  const CAP = 0.11; // flèche de tête / longueur — calée sur l'emmanchure du corps
  const CUFF = 0.63; // ouverture poignet / biceps — mesurée sur teeSleeve
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => {
    const capArc: UV[] = [];
    for (const u of [0.1, 0.28, 0.5, 0.72, 0.9]) capArc.push([u, CAP * (1 - Math.sin(Math.PI * u))]);
    const cuffIn = (1.02 * (1 - CUFF)) / 2; // rentré de chaque côté au poignet
    return {
      outline: [[-0.01, CAP], ...capArc, [1.01, CAP], [1.01 - cuffIn, 1.01], [-0.01 + cuffIn, 1.01]],
      darts: [],
      seams: [],
      openEdges: [],
      width: (S.wCm / 100) * sx * 0.5, // demi-tour de biceps (un panneau = une moitié du tube)
      height: (S.hCm / 100) * sy, // longueur de manche (59,5 cm, gradée)
      topY: m.shoulderY + 0.01,
      gap: 0.2,
      wrap,
      placement: { role: wrap, autoAlign: true },
    };
  };
  // Bande de col (bord-côte) : cousue au ras de l'encolure ronde. On la taille à
  // 85 % du VRAI tour d'encolure mesuré (devant + dos, après arrondi) — pas à la
  // cote figée du bloc CLO qui ne correspond plus au col rond. L'aisance négative
  // (85 %) resserre le col comme un jersey côtelé et évite qu'il godaille.
  const neckRingM = runLenM(front, fr.neckline) + runLenM(back, br.neckline);
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
    width: 0.85 * neckRingM * 0.5, // un panneau = une moitié de l'anneau
    height: 0.023, // bande ~2,3 cm — assez haute pour un rendu net (vs 1,7 cm)
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
