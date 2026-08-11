/**
 * doudoune — le blouson MATELASSÉ : le châssis kimono zippé doublé de la
 * veste (v196-198), plus le gonflant. Aucun moteur de pression : comme en
 * vraie couture, le boudinage naît de l'EXCÈS DE TISSU du patron.
 *
 * Le principe (compileQuiltSeams, v199) :
 * - le TISSU EXTÉRIEUR est coupé PLUS LONG dans la zone matelassée
 *   (×(1+PUFF) sous l'aisselle) et porte ses lignes de canal ESPACÉES ;
 * - la DOUBLURE, tendue, porte les mêmes canaux à l'espacement COMPRIMÉ ;
 * - les épingles de matelassage apparient canal à canal : l'extérieur est
 *   ramené à l'espacement de la doublure et son excès BOUDINE entre les
 *   piqûres — poussé dehors par le corps et la doublure. Le taux d'excès
 *   est littéralement le réglage du gonflant.
 *
 * Les canaux sont des LIGNES INTERNES ordinaires (v162) sur les deux
 * couches : le plan 2D montre le matelassage, et il reste éditable. Le zip
 * à chaud (v198), le parement et la doublure flottante de la veste sont
 * hérités tels quels. Tailles lettres (tour fini, ample) + « avatar ».
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun, InternalLine, UV } from './Draft';

export const DOUDOUNE_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type DoudouneSize = (typeof DOUDOUNE_SIZES)[number];

/** Tour de poitrine du vêtement FINI (cm) — une doudoune s'enfile sur tout. */
const DOUDOUNE_TABLE: Record<DoudouneSize, { finiCm: number }> = {
  XS: { finiCm: 110 },
  S: { finiCm: 116 },
  M: { finiCm: 122 },
  L: { finiCm: 128 },
  XL: { finiCm: 134 },
  XXL: { finiCm: 140 },
};

export function doudouneCm(size: DoudouneSize): number {
  return DOUDOUNE_TABLE[size].finiCm;
}

export const DOUDOUNE_AVATAR_EASE_CM = 34;

export function doudouneFiniCm(size: DoudouneSize | 'avatar', m: BodyMeasure): number {
  if (size === 'avatar') return Math.round(m.chest.circ * 100 + DOUDOUNE_AVATAR_EASE_CM);
  return DOUDOUNE_TABLE[size].finiCm;
}

// Constantes de construction (mètres) — le châssis de la veste, matelassé.
const LEN = 0.66; // épaule → ourlet du vêtement PORTÉ (après compression des canaux)
const SLEEVE_LEN = 0.28;
const CUFF_DROP = 0.05;
const CUFF_OPEN = 0.15; // poignet un peu plus ouvert que la veste (l'épaisseur passe)
const CF_GAP = 0.005;
const DROP_NECK_F = 0.09;
const DROP_NECK_B = 0.03;
const RATIO_NECK = 0.033;
const SIDE_MARGIN = 0.02;
export const DOUDOUNE_LINING_COLOR = '#7a2733';
const LINING_INSET = 0.035;
const FACING_W = 0.06; // le parement du zip (leçon v198)
const HEM_RISE = 0.05; // la doublure flotte au-dessus de l'ourlet (leçon v198)
/** L'EXCÈS du tissu extérieur dans la zone matelassée — le gonflant. */
export const DOUDOUNE_PUFF = 0.22;
/** Lignes de canal par panneau de torse (N lignes ⇒ N+1 boudins). */
export const DOUDOUNE_CHANNELS = 6;

export function draftDoudoune(
  size: DoudouneSize | 'avatar',
  m: BodyMeasure,
  ref: BodyMeasure,
): DraftDoc {
  const fini = doudouneFiniCm(size, m) / 100;
  const halfBody = fini / 4;
  const armDepth = fini / 8 + 0.115;
  const cuffX = halfBody + SLEEVE_LEN;
  const halfNeck = RATIO_NECK * fini;
  // Le TISSU EXTÉRIEUR est coupé plus long : la zone sous l'aisselle porte
  // l'excès du matelassage. La longueur PORTÉE redevient LEN une fois les
  // canaux épinglés à l'espacement de la doublure.
  const shellLen = armDepth + (LEN - armDepth) * (1 + DOUDOUNE_PUFF);
  const width = 2 * (cuffX + SIDE_MARGIN);
  const height = shellLen + 0.02;
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);
  const u = (xM: number): number => 0.5 + xM / width;
  const v = (yM: number): number => yM / height;
  const vTopCuff = v(CUFF_DROP);
  const vBotCuff = v(CUFF_DROP + CUFF_OPEN);
  const vArm = v(armDepth);
  const vHem = v(shellLen);
  const frame = { width, height, topY, gap: 0.9 };

  // Positions des canaux sur le TISSU EXTÉRIEUR (métrique vêtement, sous la
  // ligne d'épaule) : régulièrement répartis dans la zone matelassée.
  const quiltTopShell = armDepth + 0.05;
  const quiltBottomShell = shellLen - 0.1;
  const shellChannelY = (k: number): number =>
    quiltTopShell + ((quiltBottomShell - quiltTopShell) * k) / (DOUDOUNE_CHANNELS - 1);
  // La position COMPRIMÉE du même canal — là où la doublure tendue le tient.
  const wornChannelY = (k: number): number =>
    armDepth + (shellChannelY(k) - armDepth) / (1 + DOUDOUNE_PUFF);

  // Canaux d'une pièce EXTÉRIEURE, de xA à xB (tracés gauche → droite : les
  // lignes homologues des deux couches doivent suivre le même sens).
  const shellChannels = (xA: number, xB: number): InternalLine[] =>
    Array.from({ length: DOUDOUNE_CHANNELS }, (_, k) => ({
      points: [
        [u(Math.min(xA, xB)), v(shellChannelY(k))],
        [u(Math.max(xA, xB)), v(shellChannelY(k))],
      ] as UV[],
    }));

  // DOS — pleine largeur, manches kimono, canaux d'un flanc à l'autre.
  const back: DraftPiece = {
    outline: [
      [u(halfNeck), 0],
      [u(cuffX), vTopCuff],
      [u(cuffX), vBotCuff],
      [u(halfBody), vArm],
      [u(halfBody), vHem],
      [u(-halfBody), vHem],
      [u(-halfBody), vArm],
      [u(-cuffX), vBotCuff],
      [u(-cuffX), vTopCuff],
      [u(-halfNeck), 0],
      [0.5, v(DROP_NECK_B)],
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 2 },
      { from: 4, to: 5 },
      { from: 7, to: 8 },
      { from: 9, to: 11 },
    ],
    internalLines: shellChannels(-halfBody + 0.015, halfBody - 0.015),
    ...frame,
  };

  const frontHalf = (sx: 1 | -1): DraftPiece => ({
    outline: [
      [u(sx * CF_GAP), v(DROP_NECK_F)],
      [u(sx * (CF_GAP + 0.45 * (halfNeck - CF_GAP))), v(0.4 * DROP_NECK_F)],
      [u(sx * halfNeck), 0],
      [u(sx * cuffX), vTopCuff],
      [u(sx * cuffX), vBotCuff],
      [u(sx * halfBody), vArm],
      [u(sx * halfBody), vHem],
      [u(sx * CF_GAP), vHem],
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 0, to: 2 },
      { from: 3, to: 4 },
      { from: 6, to: 7 },
    ],
    internalLines: shellChannels(sx * (CF_GAP + 0.015), sx * (halfBody - 0.015)),
    ...frame,
  });

  // DOUBLURE matelassée d'un panneau : rectangle tendu, cousu au pourtour,
  // canaux à l'espacement COMPRIMÉ — l'écart avec le tissu extérieur devient
  // le boudin. Soie bordeaux, parement et flottement d'ourlet hérités.
  const lining = (
    supportPieceId: number,
    widthM: number,
    anchorU: number,
    dropM: number,
  ): DraftPiece => {
    const topDrop = dropM + LINING_INSET; // métrique vêtement du haut de doublure
    const heightM = LEN - topDrop - HEM_RISE;
    const channelV = (k: number): number => (wornChannelY(k) - topDrop) / heightM;
    return {
      outline: [
        [0.02, 0.02],
        [0.98, 0.02],
        [0.98, 0.98],
        [0.02, 0.98],
      ],
      darts: [],
      seams: [],
      openEdges: [],
      internalLines: Array.from({ length: DOUDOUNE_CHANNELS }, (_, k) => ({
        points: [
          [0.05, channelV(k)],
          [0.95, channelV(k)],
        ] as UV[],
      })),
      width: widthM,
      height: heightM,
      topY: topY - topDrop,
      gap: 0.2,
      color: DOUDOUNE_LINING_COLOR,
      fabricPreset: 'Soie',
      placement: {
        role: 'pocket',
        surface: {
          supportPieceId,
          anchor: [anchorU, v(topDrop) + v(heightM) / 2],
          rotationRad: 0,
          stitchedEdges: [0, 1, 2, 3],
          side: 'under',
        },
      },
    };
  };

  const liningHalfW = halfBody - CF_GAP - FACING_W - LINING_INSET;
  const liningHalfX = CF_GAP + FACING_W + liningHalfW / 2;
  const frontL = frontHalf(-1);
  // Le devant droit renonce à son jumeau (le fantôme de la veste, v196).
  const frontR: DraftPiece = { ...frontHalf(1), singlePanel: true };
  const seam = (
    pieceA: number,
    runA: EdgeRun,
    pieceB: number,
    runB: EdgeRun,
    kind?: 'seam' | 'zipper',
  ): AssemblySeam => ({
    a: { pieceId: pieceA, ...runA },
    b: { pieceId: pieceB, ...runB },
    ...(kind ? { kind } : {}),
    ...(kind === 'zipper' ? { closed: true } : {}),
  });

  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: frontL,
    back,
    manual: true,
    preset: 'doudoune',
    presetSize: size,
    pieces: [
      frontR,
      lining(0, liningHalfW, u(-liningHalfX), DROP_NECK_F),
      lining(2, liningHalfW, u(liningHalfX), DROP_NECK_F),
      lining(1, 2 * halfBody - 2 * LINING_INSET, 0.5, DROP_NECK_B),
    ],
    seams: [
      seam(0, { from: 2, to: 3 }, 1, { from: 8, to: 9 }),
      seam(2, { from: 2, to: 3 }, 1, { from: 0, to: 1 }),
      seam(0, { from: 4, to: 6 }, 1, { from: 5, to: 7 }),
      seam(2, { from: 4, to: 6 }, 1, { from: 2, to: 4 }),
      seam(0, { from: 7, to: 8 }, 2, { from: 7, to: 8 }, 'zipper'),
    ],
  };
}
