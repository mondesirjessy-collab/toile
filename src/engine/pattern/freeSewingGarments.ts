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
): DraftPiece {
  const sleeveH = sleeveHCm / 100;
  void sleeveWCm; // la LARGEUR est résolue sur l'emmanchure, pas prise du patron
  // La BOUCHE du demi-panneau (haut, tête de manche) doit ÉGALER l'emmanchure
  // mesurée. Le tour de manche FreeSewing (largeur de tête à plat) ne
  // correspond pas au modèle wrap ; on résout donc la largeur `sleeveW` à CAP
  // nominal pour que la bouche colle à l'emmanchure — la manche monte sans
  // tirer (le CAP saturé de la version précédente ouvrait les coutures).
  const cap = 0.13; // flèche de tête de tee normale
  const mouthAt = (sw: number): number => {
    const us = [-0.01, 0.1, 0.28, 0.5, 0.72, 0.9, 1.01];
    const vs = us.map((u) => cap * (1 - Math.sin(Math.PI * Math.min(1, Math.max(0, u)))));
    let len = 0;
    for (let i = 1; i < us.length; i++) {
      len += Math.hypot((us[i]! - us[i - 1]!) * sw, (vs[i]! - vs[i - 1]!) * sleeveH);
    }
    return len;
  };
  let sleeveW = armholeM; // init proche (la bouche ≈ largeur × facteur ~1)
  for (let k = 0; k < 16; k++) {
    const err = mouthAt(sleeveW) - armholeM;
    if (Math.abs(err) < 0.0005) break;
    // dérivée ≈ (largeur horizontale totale) ≈ 1,02 ; pas de sécante amortie
    sleeveW = Math.max(0.04, Math.min(0.5, sleeveW - err / 1.02));
  }
  const CUFF = 0.9;
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
}

/** Modèle de mesures FreeSewing complet, écrasé par les mensurations que
 * TOILE connaît (les autres gardent le modèle → le draft réussit toujours).
 * FreeSewing travaille en MILLIMÈTRES. */
function fsMeasurements(m: BodyMeasure): Record<string, number> {
  const base: Record<string, number> = { ...(models.cisFemaleAdult38 as Record<string, number>) };
  base.chest = m.chest.circ * 1000;
  base.waist = m.waist.circ * 1000;
  base.hips = m.hip.circ * 1000;
  base.seat = m.hip.circ * 1000;
  base.height = m.height * 1000;
  base.shoulderToShoulder = m.shoulderHalfW * 2 * 1000;
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
  makeExtra: (armholeM: number) => DraftPiece[] = () => [],
): DraftDoc {
  const topY = 1.5 + (m.shoulderY - ref.shoulderY);
  front.topY = back.topY = topY;
  front.gap = back.gap = 0.9;
  const fr = teeRuns(front);
  const br = teeRuns(back);
  front.openEdges = [fr.neckline, fr.armholeR, fr.hem, fr.armholeL];
  back.openEdges = [br.neckline, br.armholeR, br.hem, br.armholeL];
  const armholeM = (runLenM(front, fr.armholeR) + runLenM(back, br.armholeR)) / 2;
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
    pieces: makeExtra(armholeM),
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
