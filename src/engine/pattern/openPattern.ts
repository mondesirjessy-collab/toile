/**
 * openPattern — les patrons openpattern.io reconstruits dans TOILE.
 *
 * Premier vêtement : le Loose Fit T-Shirt (CC BY © Open Pattern), extrait de
 * son DXF-AAMA au millimètre (openPatternData.ts, lignes de couture nettes)
 * en tailles ABSOLUES S-XXL. Même chemin d'assemblage éprouvé que cloTee :
 * devant + dos cousus aux épaules et aux côtés (runs détectés par géométrie
 * via teeRuns), manches montées en demi-panneau WRAP (leçon cloTee : plaquer
 * le contour PLEIN d'une manche dans la fente wrap froisse le tube — on
 * ré-émet la manche aux cotes mesurées de la pièce), bande de col WRAP à la
 * cote réelle du patron. Pur — aucun import moteur/GPU.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun, UV } from './Draft';
import { teeRuns } from './cloBlocks';
import { OP_LOOSE_TEE, type OpLooseTeeSize, type OpPieceData } from './openPatternData';

export { OP_LOOSE_TEE_SIZES, type OpLooseTeeSize } from './openPatternData';

const clone = (o: readonly UV[]): UV[] => o.map(([u, v]) => [u, v]);

/** Tour de poitrine du vêtement (cm) — l'étiquette du sélecteur de taille. */
export function opLooseTeeChestCm(size: OpLooseTeeSize): number {
  return Math.round(OP_LOOSE_TEE[size].front.wCm * 2);
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
 * Loose Fit T-Shirt openpattern, à la taille choisie (cotes absolues du
 * patron — comme boxyTee). Les encolures, emmanchures et ourlets sont les
 * VRAIES courbes du patron (aucun redessin) ; seule la manche est ré-émise
 * en demi-panneau wrap, sa flèche de tête calée sur l'emmanchure MESURÉE du
 * corps (bouche ≈ emmanchure — sinon l'excédent godaille, leçon cloTee).
 */
export function opLooseTee(size: OpLooseTeeSize, m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const D = OP_LOOSE_TEE[size];
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);

  const face = (data: OpPieceData): DraftPiece => {
    const piece: DraftPiece = {
      outline: clone(data.outline),
      darts: [],
      seams: [],
      openEdges: [],
      width: data.wCm / 100,
      height: data.hCm / 100,
      topY,
      gap: 0.9,
    };
    const r = teeRuns(piece);
    piece.openEdges = [r.neckline, r.armholeR, r.hem, r.armholeL];
    return piece;
  };
  const front = face(D.front);
  const back = face(D.back);
  const fr = teeRuns(front);
  const br = teeRuns(back);

  // Manche en demi-panneau WRAP : largeur = demi-tour de la pièce réelle,
  // longueur = la cote du patron. La flèche de tête (CAP) est résolue pour que
  // la BOUCHE du demi-panneau égale l'emmanchure mesurée du corps : la bouche
  // suit v = CAP·(1−sin(πu)) — sa longueur ≈ hypoténuses cumulées ; on résout
  // par sécante sur la polyline réelle (robuste, pas d'approximation).
  const armholeM = (runLenM(front, fr.armholeR) + runLenM(back, br.armholeR)) / 2;
  const sleeveW = (D.sleeveWCm / 100) * 0.5;
  const sleeveH = D.sleeveHCm / 100;
  const mouthLen = (cap: number): number => {
    const us = [-0.01, 0.1, 0.28, 0.5, 0.72, 0.9, 1.01];
    const vs = us.map((u) => cap * (1 - Math.sin(Math.PI * Math.min(1, Math.max(0, u)))));
    let len = 0;
    for (let i = 1; i < us.length; i++) {
      len += Math.hypot((us[i]! - us[i - 1]!) * sleeveW, (vs[i]! - vs[i - 1]!) * sleeveH);
    }
    return len;
  };
  let cap = 0.11;
  for (let k = 0; k < 12; k++) {
    const err = mouthLen(cap) - armholeM;
    if (Math.abs(err) < 0.001) break;
    cap = Math.max(0.03, Math.min(0.35, cap - err / sleeveH));
  }
  const CUFF = 0.9; // manche loose : ouverture large, léger fuselage
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => {
    const capArc: UV[] = [];
    for (const u of [0.1, 0.28, 0.5, 0.72, 0.9]) capArc.push([u, cap * (1 - Math.sin(Math.PI * u))]);
    const cuffIn = (1.02 * (1 - CUFF)) / 2;
    return {
      outline: [[-0.01, cap], ...capArc, [1.01, cap], [1.01 - cuffIn, 1.01], [-0.01 + cuffIn, 1.01]],
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
  };

  // Bande de col : la pièce Collar du patron, pliée en deux à la couture
  // (hauteur portée = la moitié de la pièce à plat), wrap 'neck'.
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
    width: (D.collarWCm / 100) * 0.5, // un panneau = une moitié de l'anneau
    height: D.collarHCm / 100 / 2,
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
  };
}
