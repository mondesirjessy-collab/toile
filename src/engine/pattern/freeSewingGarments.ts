/**
 * freeSewingGarments — les vêtements FreeSewing assemblés pour TOILE.
 *
 * Ce module IMPORTE FreeSewing (designs + modèles de mesures) : il est donc
 * chargé par `import()` DYNAMIQUE depuis main.ts (au clic), pour garder les
 * ~centaines de ko de FreeSewing HORS du bundle principal — comme le
 * tassement de marker (clipper2-ts). Il mappe les mensurations de TOILE vers
 * les mesures FreeSewing, drape le design, convertit les pièces (freeSewing.ts)
 * et les assemble par le chemin éprouvé du tee (teeRuns : détection des bords
 * épaule/côté/emmanchure/encolure par géométrie).
 */
import { Aaron } from '@freesewing/aaron';
import { Teagan } from '@freesewing/teagan';
import { Sven } from '@freesewing/sven';
import { Brian } from '@freesewing/brian';
import { Titan } from '@freesewing/titan';
import { Sandy } from '@freesewing/sandy';
import { Diana } from '@freesewing/diana';
import * as models from '@freesewing/models';
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun, UV } from './Draft';
import { teeRuns } from './cloBlocks';
import { freeSewingPieces, type FsPattern } from './freeSewing';

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
 * Manche en DEMI-PANNEAU WRAP, aux cotes de la manche FreeSewing mais avec la
 * flèche de tête (CAP) RÉSOLUE sur l'emmanchure MESURÉE du corps assemblé —
 * la leçon cloTee/openpattern : plaquer le contour PLEIN d'une manche dans la
 * fente wrap la froisse ; la bouche du demi-panneau doit égaler l'emmanchure.
 */
function sleeveWrap(
  sleeveWCm: number,
  sleeveHCm: number,
  armholeM: number,
  m: BodyMeasure,
  wrap: 'armL' | 'armR',
  frontArm?: number,
  backArm?: number,
): DraftPiece {
  const sleeveH = sleeveHCm / 100;
  void sleeveWCm; // la LARGEUR est résolue sur l'emmanchure, pas prise du patron
  // Profil de TÊTE DE MANCHE ÉPROUVÉ (identique au tee natif de TOILE,
  // boxyData) : tête profonde (0,17) finement échantillonnée (17 points),
  // poignet quasi droit. Le tee natif en manches LONGUES monte à 0 mm avec ce
  // profil ; mon arc synthétique précédent (tête peu profonde 0,13, 5 points)
  // faisait ÉCLATER les manches longues (bloc Brian 61 cm → 634 mm d'écart
  // Devant↔Dos) — mesuré : à longueur courte il tenait, à 61 cm il cassait.
  // La LARGEUR reste RÉSOLUE pour que la bouche (l'arc de tête) épouse
  // l'emmanchure mesurée du corps assemblé.
  const HEAD: UV[] = [
    [-0.01, 0.17], [0.0625, 0.1597], [0.125, 0.1365], [0.1875, 0.0983],
    [0.25, 0.0599], [0.3125, 0.0314], [0.375, 0.0132], [0.4375, 0.0032],
    [0.5, 0.0], [0.5625, 0.0032], [0.625, 0.0132], [0.6875, 0.0314],
    [0.75, 0.0599], [0.8125, 0.0983], [0.875, 0.1365], [0.9375, 0.1597], [1.01, 0.17],
  ];
  // TÊTE ASYMÉTRIQUE (Diana : emmanchure devant ≠ dos). La tête est un demi-
  // panneau qui se MIROITE, donc chaque moitié doit valoir la MOITIÉ de son
  // emmanchure (devant à gauche du sommet u<0,5, dos à droite). On résout deux
  // demi-largeurs wF, wB indépendantes. Chemin activé UNIQUEMENT si des
  // emmanchures distinctes sont fournies → Teagan/Sven/Brian (symétriques)
  // n'y passent jamais et gardent leur tête symétrique éprouvée intacte.
  if (frontArm !== undefined && backArm !== undefined && Math.abs(frontArm - backArm) > 0.01) {
    const PEAK = 8; // sommet de la tête (u=0,5, v=0)
    const px = (u: number, wF: number, wB: number): number =>
      ((u - 0.5) / 0.5) * (u < 0.5 ? wF : wB); // 0 au sommet, ∓ vers les aisselles
    const halfArc = (w: number, from: number, to: number): number => {
      let len = 0;
      for (let i = from + 1; i <= to; i++) {
        const dx = px(HEAD[i]![0], w, w) - px(HEAD[i - 1]![0], w, w);
        const dy = (HEAD[i]![1] - HEAD[i - 1]![1]) * sleeveH;
        len += Math.hypot(dx, dy);
      }
      return len;
    };
    const solveHalf = (target: number, from: number, to: number): number => {
      let w = 0.15;
      for (let k = 0; k < 24; k++) {
        const err = halfArc(w, from, to) - target;
        if (Math.abs(err) < 0.0004) break;
        w = Math.max(0.02, Math.min(0.4, w - err / 1.02));
      }
      return w;
    };
    const wF = solveHalf(frontArm / 2, 0, PEAK);
    const wB = solveHalf(backArm / 2, PEAK, HEAD.length - 1);
    const phys: [number, number][] = HEAD.map(([u, v]) => [px(u, wF, wB), v * sleeveH]);
    phys.push([px(0.9819, wF, wB), 1.01 * sleeveH]); // coin poignet dos
    phys.push([px(0.0181, wF, wB), 1.01 * sleeveH]); // coin poignet devant
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of phys) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    const width = Math.max(1e-4, maxX - minX);
    const height = Math.max(1e-4, maxY);
    return {
      outline: phys.map(([x, y]) => [(x - minX) / width, y / height] as UV),
      darts: [], seams: [], openEdges: [],
      width, height,
      topY: m.shoulderY + 0.01, gap: 0.2,
      wrap, placement: { role: wrap, autoAlign: true },
    };
  }
  const mouthAt = (sw: number): number => {
    let len = 0;
    for (let i = 1; i < HEAD.length; i++) {
      len += Math.hypot(
        (HEAD[i]![0] - HEAD[i - 1]![0]) * sw,
        (HEAD[i]![1] - HEAD[i - 1]![1]) * sleeveH,
      );
    }
    return len;
  };
  let sleeveW = armholeM; // init proche (la bouche ≈ largeur × facteur ~1)
  for (let k = 0; k < 20; k++) {
    const err = mouthAt(sleeveW) - armholeM;
    if (Math.abs(err) < 0.0005) break;
    // dérivée ≈ (largeur horizontale totale) ≈ 1,02 ; sécante amortie
    sleeveW = Math.max(0.04, Math.min(0.5, sleeveW - err / 1.02));
  }
  return {
    outline: [...HEAD, [0.9819, 1.01], [0.0181, 1.01]],
    darts: [],
    seams: [],
    openEdges: [],
    width: sleeveW,
    height: sleeveH,
    topY: m.shoulderY + 0.01,
    gap: 0.2,
    wrap,
    placement: { role: wrap, autoAlign: true },
  };
}

// Mesures FreeSewing qui varient avec la STATURE (des longueurs). FreeSewing
// n'a PAS de mesure « height » : les vêtements tracent d'après ces longueurs.
// On les met à l'échelle de la stature mesurée (le modèle par défaut gardait
// une longueur fixe → le pantalon tombait toujours à la même hauteur).
const FS_LENGTHS = [
  'bustFront', 'bustPointToUnderbust', 'crossSeam', 'crossSeamFront', 'crotchDepth',
  'highBustFront', 'hpsToBust', 'hpsToWaistBack', 'hpsToWaistFront', 'inseam',
  'seatBack', 'shoulderToElbow', 'shoulderToWrist', 'waistBack', 'waistToArmpit',
  'waistToFloor', 'waistToHips', 'waistToKnee', 'waistToSeat', 'waistToUnderbust',
  'waistToUpperLeg',
] as const;
// Tours secondaires (poignet, biceps, genou, cou…) : mis à l'échelle de la
// corpulence (rapport de tour de poitrine), faute de mesure dédiée dans TOILE.
const FS_GIRTHS = ['ankle', 'biceps', 'bustSpan', 'head', 'heel', 'knee', 'neck', 'underbust', 'wrist'] as const;
// Stature de référence du modèle FreeSewing (mm), estimée de ses longueurs.
const FS_MODEL_HEIGHT_MM = 1750;

/** Modèle de mesures FreeSewing complet, ADAPTÉ aux mensurations de TOILE : les
 * tours connus sont exacts, les LONGUEURS mises à l'échelle de la stature et
 * les tours secondaires à l'échelle de la corpulence — pour que les vêtements
 * (le pantalon surtout) tombent à la bonne longueur. FreeSewing est en MM. */
function fsMeasurements(m: BodyMeasure): Record<string, number> {
  const model = models.cisFemaleAdult38 as Record<string, number>;
  const base: Record<string, number> = { ...model };
  const fv = (m.height * 1000) / FS_MODEL_HEIGHT_MM; // facteur vertical (longueurs)
  const fh = (m.chest.circ * 1000) / model.chest!; // facteur de corpulence (tours secondaires)
  for (const k of FS_LENGTHS) if (typeof model[k] === 'number') base[k] = model[k]! * fv;
  for (const k of FS_GIRTHS) if (typeof model[k] === 'number') base[k] = model[k]! * fh;
  // Mesures connues exactement par TOILE (mm) :
  base.chest = m.chest.circ * 1000;
  base.highBust = m.chest.circ * 1000 * 0.95;
  base.waist = m.waist.circ * 1000;
  base.hips = m.hip.circ * 1000;
  base.seat = m.hip.circ * 1000;
  base.upperLeg = m.thigh.circ * 1000;
  base.shoulderToShoulder = m.shoulderHalfW * 2 * 1000;
  base.height = m.height * 1000; // conservé même si FreeSewing l'ignore
  return base;
}

/** Assemble les deux faces (devant/dos) d'un patron FreeSewing : épaules +
 * côtés cousus, encolure/emmanchures/ourlet ouverts (teeRuns, mêmes repères
 * qu'openpattern / cloTee). `makeExtra` reçoit l'emmanchure mesurée (m) et
 * rend les pièces montées (manches wrap) — vide pour un vêtement sans manche. */
function assembleTwoFaces(
  front: DraftPiece,
  back: DraftPiece,
  m: BodyMeasure,
  ref: BodyMeasure,
  makeExtra: (armholeM: number, frontArm: number, backArm: number) => DraftPiece[] = () => [],
): DraftDoc {
  const topY = 1.5 + (m.shoulderY - ref.shoulderY);
  front.topY = back.topY = topY;
  front.gap = back.gap = 0.9;
  const fr = teeRuns(front);
  const br = teeRuns(back);
  front.openEdges = [fr.neckline, fr.armholeR, fr.hem, fr.armholeL];
  back.openEdges = [br.neckline, br.armholeR, br.hem, br.armholeL];
  const frontArm = runLenM(front, fr.armholeR);
  const backArm = runLenM(back, br.armholeR);
  const armholeM = (frontArm + backArm) / 2;
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
    pieces: makeExtra(armholeM, frontArm, backArm),
    seams: [
      seam(fr.shoulderR, br.shoulderR),
      seam(fr.shoulderL, br.shoulderL),
      seam(fr.sideR, br.sideR),
      seam(fr.sideL, br.sideL),
    ],
  };
}

/** Le débardeur Aaron de FreeSewing, gradé aux mensurations de l'avatar. Les
 * bandes d'emmanchure/encolure (finitions) sont écartées du premier montage —
 * le corps tient sur ses coutures d'épaule et de côté. */
export function buildAaron(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const pattern = new Aaron({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const pieces = freeSewingPieces(pattern);
  const front = pieces.find((p) => p.name === 'front')?.piece;
  const back = pieces.find((p) => p.name === 'back')?.piece;
  if (!front || !back) {
    throw new Error('FreeSewing Aaron : devant ou dos introuvable après draft.');
  }
  return assembleTwoFaces(front, back, m, ref);
}

/** Le T-shirt Teagan de FreeSewing, gradé aux mensurations — devant + dos +
 * DEUX manches montées en demi-panneau wrap (cotes de la manche FreeSewing,
 * tête calée sur l'emmanchure mesurée). */
export function buildTeagan(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const pattern = new Teagan({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const pieces = freeSewingPieces(pattern);
  const front = pieces.find((p) => p.name === 'front')?.piece;
  const back = pieces.find((p) => p.name === 'back')?.piece;
  const sleeve = pieces.find((p) => p.name === 'sleeve')?.piece;
  if (!front || !back) {
    throw new Error('FreeSewing Teagan : devant ou dos introuvable après draft.');
  }
  // La manche FreeSewing est un contour PLEIN (tête + fuselage) : on n'en garde
  // que les COTES (tour de biceps = largeur, longueur = hauteur) pour ré-émettre
  // un demi-panneau wrap. Sans pièce manche, on retombe sur des cotes de tee.
  const sleeveWCm = sleeve ? sleeve.width * 100 : 34;
  const sleeveHCm = sleeve ? sleeve.height * 100 : 20;
  return assembleTwoFaces(front, back, m, ref, (armholeM) => [
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armR'),
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armL'),
  ]);
}

/** La ROBE Diana de FreeSewing, gradée aux mensurations — devant + dos + DEUX
 * manches montées en demi-panneau wrap. Contour sans pince (comme le tee) mais
 * en longueur ROBE : la première robe du pont FreeSewing. Même montage que
 * Teagan (assembleTwoFaces + têtes de manche calées sur l'emmanchure mesurée). */
export function buildDiana(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  // lengthBonus 0,5 (max) : Diana par défaut tombe à mi-cuisse (62 cm) ; +50 %
  // → ~90 cm depuis l'épaule = longueur genou, une vraie robe.
  const pattern = new Diana({
    measurements: fsMeasurements(m),
    options: { lengthBonus: 0.5 },
  }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const pieces = freeSewingPieces(pattern);
  const front = pieces.find((p) => p.name === 'front')?.piece;
  const back = pieces.find((p) => p.name === 'back')?.piece;
  const sleeve = pieces.find((p) => p.name === 'sleeve')?.piece;
  if (!front || !back) {
    throw new Error('FreeSewing Diana : devant ou dos introuvable après draft.');
  }
  // Diana a un DEVANT et un DOS asymétriques (emmanchures devant ≠ dos) : on
  // monte des manches à TÊTE ASYMÉTRIQUE (sleeveWrap reçoit frontArm/backArm →
  // chaque moitié de tête épouse son emmanchure). Symétriques, elles cassaient.
  const sleeveHCm = sleeve ? sleeve.height * 100 : 58;
  return assembleTwoFaces(front, back, m, ref, (armholeM, frontArm, backArm) => [
    sleeveWrap(34, sleeveHCm, armholeM, m, 'armR', frontArm, backArm),
    sleeveWrap(34, sleeveHCm, armholeM, m, 'armL', frontArm, backArm),
  ]);
}

/** Le sweat-shirt Sven de FreeSewing, gradé aux mensurations — devant + dos +
 * DEUX manches longues montées en demi-panneau wrap. Les bandes de finition
 * (poignets `cuff`, bord-côte `waistband`) sont écartées du premier montage,
 * comme les bandes d'Aaron : le corps tient sur ses coutures d'épaule/côté. */
export function buildSven(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const pattern = new Sven({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const pieces = freeSewingPieces(pattern);
  const front = pieces.find((p) => p.name === 'front')?.piece;
  const back = pieces.find((p) => p.name === 'back')?.piece;
  const sleeve = pieces.find((p) => p.name === 'sleeve')?.piece;
  if (!front || !back) {
    throw new Error('FreeSewing Sven : devant ou dos introuvable après draft.');
  }
  const sleeveWCm = sleeve ? sleeve.width * 100 : 40;
  const sleeveHCm = sleeve ? sleeve.height * 100 : 58;
  return assembleTwoFaces(front, back, m, ref, (armholeM) => [
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armR'),
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armL'),
  ]);
}

/** Le bloc de base Brian de FreeSewing, gradé aux mensurations — devant + dos +
 * DEUX manches LONGUES. Le patron torse fondamental d'un atelier (contour
 * lisse, sans pince). Sert aussi de cas de test des manches longues wrap. */
export function buildBrian(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const pattern = new Brian({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const pieces = freeSewingPieces(pattern);
  const front = pieces.find((p) => p.name === 'front')?.piece;
  const back = pieces.find((p) => p.name === 'back')?.piece;
  const sleeve = pieces.find((p) => p.name === 'sleeve')?.piece;
  if (!front || !back) {
    throw new Error('FreeSewing Brian : devant ou dos introuvable après draft.');
  }
  const sleeveWCm = sleeve ? sleeve.width * 100 : 40;
  const sleeveHCm = sleeve ? sleeve.height * 100 : 61;
  return assembleTwoFaces(front, back, m, ref, (armholeM) => [
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armR'),
    sleeveWrap(sleeveWCm, sleeveHCm, armholeM, m, 'armL'),
  ]);
}

/** Indice du sommet du contour le plus proche d'un point UV. */
function nearestOutlineIdx(outline: readonly UV[], target: UV): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const d = Math.hypot(outline[i]![0] - target[0], outline[i]![1] - target[1]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Les 5 bords d'une jambe de pantalon, ancrés sur les points NOMMÉS FreeSewing
 * (fork, floorOut, seatOut, cf/cbSeat) plutôt que sur la détection géométrique
 * `pantsRuns` — que le tracé FreeSewing met en défaut (taille inclinée, fourche
 * qui coïncide avec la taille). L'ourlet intérieur, sans point nommé, est le
 * coin bas OPPOSÉ à l'ourlet extérieur. Le contour est ré-orienté pour
 * parcourir fork → entrejambe → ourlet → côté → taille → fourche en avançant,
 * afin que les runs et l'appariement devant/dos soient cohérents. */
function legRunsFromPoints(
  piece: DraftPiece,
  pts: Record<string, UV>,
  waistCenterName: 'cfSeat' | 'cbSeat',
): { center: EdgeRun; waist: EdgeRun; outseam: EdgeRun; hem: EdgeRun; inseam: EdgeRun } {
  const N = piece.outline.length;
  const maxV = Math.max(...piece.outline.map((p) => p[1]));
  const minV = Math.min(...piece.outline.map((p) => p[1]));
  const spanV = Math.max(1e-6, maxV - minV);
  const hemOuter = nearestOutlineIdx(piece.outline, pts.floorOut!);
  const outerU = piece.outline[hemOuter]![0];
  let hemInner = hemOuter;
  let bestDu = -1;
  for (let i = 0; i < N; i++) {
    if (piece.outline[i]![1] < maxV - 0.03 * spanV) continue; // bande d'ourlet
    const du = Math.abs(piece.outline[i]![0] - outerU);
    if (du > bestDu) { bestDu = du; hemInner = i; }
  }
  const idx = {
    fork: nearestOutlineIdx(piece.outline, pts.fork!),
    hemInner,
    hemOuter,
    waistSide: nearestOutlineIdx(piece.outline, pts.seatOut!),
    waistCenter: nearestOutlineIdx(piece.outline, pts[waistCenterName]!),
  };
  const ahead = (a: number, b: number): number => (b - a + N) % N;
  // Sens voulu : depuis la fourche, rencontrer l'ourlet intérieur AVANT le
  // centre-taille. Sinon le contour tourne à l'envers → on l'inverse.
  if (ahead(idx.fork, idx.waistCenter) < ahead(idx.fork, idx.hemInner)) {
    piece.outline.reverse();
    for (const k of Object.keys(idx) as (keyof typeof idx)[]) idx[k] = N - 1 - idx[k];
  }
  return {
    inseam: { from: idx.fork, to: idx.hemInner },
    hem: { from: idx.hemInner, to: idx.hemOuter },
    outseam: { from: idx.hemOuter, to: idx.waistSide },
    waist: { from: idx.waistSide, to: idx.waistCenter },
    center: { from: idx.waistCenter, to: idx.fork },
  };
}

/** Le bloc PANTALON Titan de FreeSewing, gradé aux mensurations — jambe devant
 * + jambe dos (chacune coupée ×2). Réutilise le montage 4 panneaux ÉPROUVÉ de
 * TOILE (preset 'loose-pants') : les 2 jambes en miroir, la fourche avant/
 * arrière et les tubes de jambe s'assemblent automatiquement. Les bords sont
 * ancrés sur les points nommés du patron (voir legRunsFromPoints). */
export function buildTitan(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  void ref;
  const pattern = new Titan({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  // Contour fin (peu de simplification) : les coins d'ourlet/fourche voisins
  // doivent rester des sommets distincts pour ancrer les coutures.
  const pieces = freeSewingPieces(pattern, { samples: 200, rdpMm: 0.8 });
  const fe = pieces.find((p) => p.name === 'front');
  const be = pieces.find((p) => p.name === 'back');
  if (!fe?.points || !be?.points) {
    throw new Error('FreeSewing Titan : pièces ou points nommés introuvables.');
  }
  const front = fe.piece;
  const back = be.piece;
  let fpts = fe.points;
  const bpts = be.points;
  // Aligner la fourche des deux jambes du même côté : le montage superpose
  // devant/dos d'UNE jambe, leurs bords doivent coïncider en X. Le dos a la
  // fourche à gauche ; on MIROITE le devant en u s'il l'a à droite.
  if ((fpts.fork?.[0] ?? 0) > 0.5) {
    for (const p of front.outline) p[0] = 1 - p[0];
    fpts = Object.fromEntries(
      Object.entries(fpts).map(([k, uv]) => [k, [1 - uv[0], uv[1]] as UV]),
    ) as Record<string, UV>;
  }
  const topY = m.waist.y + 0.055;
  const gap = Math.min(0.34, Math.max(0.22, (m.hip.circ / Math.PI) * 0.72));
  for (const pc of [front, back]) {
    pc.topY = topY;
    pc.gap = gap;
    pc.cut = 2; // chaque jambe est coupée deux fois (gauche + droite)
  }
  front.name = 'devant ×2';
  back.name = 'dos ×2';
  const fr = legRunsFromPoints(front, fpts, 'cfSeat');
  const br = legRunsFromPoints(back, bpts, 'cbSeat');
  front.openEdges = [fr.center, fr.waist, fr.hem];
  back.openEdges = [br.center, br.waist, br.hem];
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
    pieces: [],
    seams: [
      seam(fr.outseam, br.outseam), // couture de côté
      seam(fr.inseam, br.inseam), // entrejambe
    ],
    preset: 'loose-pants',
  };
}

/** La jupe CERCLE Sandy de FreeSewing, gradée aux mensurations. Le patron est un
 * secteur d'anneau (courbe) qui ne se monte pas tel quel dans le montage jupe de
 * TOILE (qui attend un trapèze taille→ourlet). On le DÉROULE : on lit l'évasement
 * (rayon ourlet / rayon taille) et la longueur radiale du secteur, puis on émet
 * un trapèze évasé (tour de taille du corps, évasement + longueur de Sandy) monté
 * par le preset 'jupe' éprouvé — devant + dos, deux coutures de côté, l'ourlet
 * et la taille ouverts, la jupe tient car la taille cousue reste sous les hanches. */
export function buildSandy(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  void ref;
  const pattern = new Sandy({ measurements: fsMeasurements(m) }) as unknown as {
    draft(): void;
  } & FsPattern;
  pattern.draft();
  const set = pattern.parts?.[0] ?? {};
  const skirtKey = Object.keys(set).find((k) => /skirt/i.test(k));
  const pts = (skirtKey ? set[skirtKey]?.points : undefined) ?? {};
  // Évasement et longueur lus sur le secteur : center → taille (in) et ourlet (ex).
  let flare = 2;
  let lengthM = 0.5;
  const c = pts.center;
  const inPt = pts.in1 ?? pts.in2;
  const exPt = pts.ex1 ?? pts.ex2;
  if (c && inPt && exPt) {
    const rTaille = Math.hypot(inPt.x - c.x, inPt.y - c.y) / 1000;
    const rOurlet = Math.hypot(exPt.x - c.x, exPt.y - c.y) / 1000;
    if (rTaille > 0.01 && rOurlet > rTaille) {
      flare = Math.min(3.2, rOurlet / rTaille); // borne l'évasement extrême
      lengthM = rOurlet - rTaille;
    }
  }
  const halfWaist = m.waist.circ / 4; // demi-largeur d'une face (le devant couvre taille/2)
  const halfHem = halfWaist * flare;
  const width = 2 * (halfHem + 0.02);
  const height = lengthM + 0.02;
  const u = (xM: number): number => 0.5 + xM / width;
  const vHem = lengthM / height;
  const topY = m.waist.y + 0.01;
  const face = (): DraftPiece => ({
    outline: [
      [u(halfWaist), 0], // 0 taille D
      [u(halfHem), vHem], // 1 ourlet D
      [u(-halfHem), vHem], // 2 ourlet G
      [u(-halfWaist), 0], // 3 taille G
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 2 }, // ourlet
      { from: 3, to: 0 }, // ligne de taille
    ],
    width,
    height,
    topY,
    gap: 0.9,
  });
  const front = face();
  const back = face();
  const seam = (from: number, to: number): AssemblySeam => ({
    a: { face: 'front', from, to },
    b: { face: 'back', from, to },
  });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: front,
    back,
    manual: true,
    preset: 'jupe',
    seams: [seam(0, 1), seam(2, 3)], // côté D (taille→ourlet), côté G
  };
}
