/**
 * veste — la VESTE ZIPPÉE DOUBLÉE : blouson kimono à devant ouvert, fermeture
 * séparable au milieu et doublure de corps contrastante. Premier archétype à
 * SIX pièces né du chemin générique — aucun compilateur spécialisé.
 *
 * Construction, entièrement sur des mécanismes éprouvés ailleurs :
 * - DEVANT GAUCHE = pièce 0, DOS = pièce 1 (masques indépendants côte-à-côte
 *   dans le MÊME cadre physique, comme un dos dessiné à la main) ;
 * - DEVANT DROIT = pièce libre cousue par pieceId — la topologie exacte que
 *   ✂ Couper & Coudre produit sur un colorblock (validé en essayage v148) ;
 * - manches KIMONO intégrales aux pièces du corps : le haut de manche et le
 *   dessous se cousent devant↔dos et forment le tube autour du bras, la
 *   construction du tee oversize — les manches montées (wrap) liraient les
 *   emmanchures sur doc.piece/doc.back et ne trouveraient jamais celle d'un
 *   devant scindé ;
 * - FERMETURE : une couture `kind: 'zipper'` entre les deux bords du milieu
 *   devant (le modèle du hoodie), fermée pour l'essayage, débrayable ;
 * - DOUBLURE : trois panneaux de surface `side: 'under'` (le geste « doublure
 *   par-dessous » validé v155), glissés ENTRE le corps et chaque pièce du
 *   torse, cousus au pourtour, en bordeaux — l'intérieur habillé d'une veste.
 * - La veste TIENT par les épaules, comme le tee et la robe.
 *
 * Tailles : lettres XS→XXL (tour de poitrine du VÊTEMENT fini, gradation
 * blouson de 6 cm) + « avatar » (poitrine mesurée + aisance blouson). Pur —
 * aucune importation moteur ; compilé par compileDraft/compileAssembly/
 * compileCrossSeams/compileSurfaceSeams comme tout patron de l'atelier.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, EdgeRun } from './Draft';

export const VESTE_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type VesteSize = (typeof VESTE_SIZES)[number];

/** Tour de poitrine du vêtement FINI (cm) — l'aisance blouson est dedans. */
const VESTE_TABLE: Record<VesteSize, { finiCm: number }> = {
  XS: { finiCm: 104 },
  S: { finiCm: 110 },
  M: { finiCm: 116 },
  L: { finiCm: 122 },
  XL: { finiCm: 128 },
  XXL: { finiCm: 134 },
};

export function vesteCm(size: VesteSize): number {
  return VESTE_TABLE[size].finiCm;
}

/** Aisance blouson de la coupe « avatar » : poitrine mesurée + 28 cm. */
export const VESTE_AVATAR_EASE_CM = 28;

export function vesteFiniCm(size: VesteSize | 'avatar', m: BodyMeasure): number {
  if (size === 'avatar') return Math.round(m.chest.circ * 100 + VESTE_AVATAR_EASE_CM);
  return VESTE_TABLE[size].finiCm;
}

// Constantes de construction (mètres).
const LEN = 0.66; // épaule → ourlet (blouson au bassin)
const SLEEVE_LEN = 0.28; // bord du corps → poignet (kimono trois-quarts)
const CUFF_DROP = 0.05; // chute d'épaule tombante, du col au poignet
const CUFF_OPEN = 0.14; // demi-tour du poignet par panneau (tube ≈ 28 cm)
const CF_GAP = 0.005; // demi-jour du milieu devant (le zip vit dans ce centimètre)
const DROP_NECK_F = 0.09; // creux d'encolure devant (ronde, sans col rapporté)
const DROP_NECK_B = 0.03; // creux dos
const RATIO_NECK = 0.033; // demi-encolure ≈ 0,033·tour fini
const SIDE_MARGIN = 0.02;
/** La doublure bordeaux — le flash de couleur qui dit « doublée » en 3D. */
export const VESTE_LINING_COLOR = '#7a2733';
/**
 * Retrait de la doublure sur le pourtour du support. GÉNÉREUX à dessein :
 * dans les plis profonds du surplus blouson, le tissu extérieur plonge et la
 * doublure — cousue au pourtour, libre au milieu — ponte le pli en ligne
 * droite ; un bord trop près des flancs affleure au fond des vagues (percées
 * bordeaux observées à 2 cm, aux flancs et sous la poitrine).
 */
const LINING_INSET = 0.035;

/**
 * La veste complète. `ref` cale la pièce en hauteur (convention du tee) ; le
 * corps mesuré donne les verticales, la taille donne les tours.
 */
export function draftVeste(
  size: VesteSize | 'avatar',
  m: BodyMeasure,
  ref: BodyMeasure,
): DraftDoc {
  const fini = vesteFiniCm(size, m) / 100;
  const halfBody = fini / 4; // demi-largeur d'un panneau de torse
  const armDepth = fini / 8 + 0.115; // profondeur de manche au corps (tube biceps large)
  const cuffX = halfBody + SLEEVE_LEN;
  const halfNeck = RATIO_NECK * fini;
  const width = 2 * (cuffX + SIDE_MARGIN);
  const height = LEN + 0.02;
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);
  const u = (xM: number): number => 0.5 + xM / width;
  const v = (yM: number): number => yM / height;
  const vTopCuff = v(CUFF_DROP);
  const vBotCuff = v(CUFF_DROP + CUFF_OPEN);
  const vArm = v(armDepth);
  const vHem = v(LEN);
  const frame = { width, height, topY, gap: 0.9 };

  // DOS — pleine largeur, manches kimono des deux côtés.
  const back: DraftPiece = {
    outline: [
      [u(halfNeck), 0], // 0  encolure→épaule D
      [u(cuffX), vTopCuff], // 1  bout de manche D, haut
      [u(cuffX), vBotCuff], // 2  poignet D, bas
      [u(halfBody), vArm], // 3  aisselle D
      [u(halfBody), vHem], // 4  ourlet côté D
      [u(-halfBody), vHem], // 5  ourlet côté G
      [u(-halfBody), vArm], // 6  aisselle G
      [u(-cuffX), vBotCuff], // 7  poignet G, bas
      [u(-cuffX), vTopCuff], // 8  bout de manche G, haut
      [u(-halfNeck), 0], // 9  encolure→épaule G
      [0.5, v(DROP_NECK_B)], // 10 creux d'encolure dos
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 2 }, // poignet D
      { from: 4, to: 5 }, // ourlet
      { from: 7, to: 8 }, // poignet G
      { from: 9, to: 11 }, // encolure (par le creux 10)
    ],
    ...frame,
  };

  // UN DEVANT (demi) — `sx` = −1 pour le gauche, +1 pour le droit (miroir).
  const frontHalf = (sx: 1 | -1): DraftPiece => ({
    outline: [
      [u(sx * CF_GAP), v(DROP_NECK_F)], // 0  milieu devant, creux d'encolure
      [u(sx * (CF_GAP + 0.45 * (halfNeck - CF_GAP))), v(0.4 * DROP_NECK_F)], // 1  arrondi
      [u(sx * halfNeck), 0], // 2  encolure→épaule
      [u(sx * cuffX), vTopCuff], // 3  bout de manche, haut
      [u(sx * cuffX), vBotCuff], // 4  poignet, bas
      [u(sx * halfBody), vArm], // 5  aisselle
      [u(sx * halfBody), vHem], // 6  ourlet côté
      [u(sx * CF_GAP), vHem], // 7  milieu devant, ourlet
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 0, to: 2 }, // encolure (quart avant)
      { from: 3, to: 4 }, // poignet
      { from: 6, to: 7 }, // ourlet
    ],
    ...frame,
  });

  // DOUBLURE d'un panneau de torse : un rectangle propre, cousu au pourtour,
  // glissé SOUS son support (entre corps et tissu), bordeaux.
  const lining = (
    supportPieceId: number,
    widthM: number,
    anchorU: number,
    dropM: number,
  ): DraftPiece => ({
    outline: [
      [0.02, 0.02],
      [0.98, 0.02],
      [0.98, 0.98],
      [0.02, 0.98],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    width: widthM,
    height: LEN - dropM - 2 * LINING_INSET,
    topY: topY - dropM - LINING_INSET,
    gap: 0.2,
    color: VESTE_LINING_COLOR,
    // Une doublure se coupe dans la soie — physique plus fine que la laine
    // du dessus, et la vraie construction d'une veste doublée. Le grammage
    // reste celui du preset : alourdie à 120 g/m² (essai), la doublure
    // s'affaissait dans les creux du drapé et perçait DAVANTAGE.
    fabricPreset: 'Soie',
    placement: {
      role: 'pocket',
      surface: {
        supportPieceId,
        anchor: [anchorU, v(dropM + LINING_INSET) + v(LEN - dropM - 2 * LINING_INSET) / 2],
        rotationRad: 0,
        stitchedEdges: [0, 1, 2, 3],
        side: 'under',
      },
    },
  });

  const liningHalfW = halfBody - CF_GAP - 2 * LINING_INSET;
  const frontL = frontHalf(-1);
  // Le devant droit renonce à son panneau jumeau : chacun de ses bords est
  // soit ouvert (encolure, poignet, ourlet) soit cousu ailleurs (épaule,
  // côté, zip) — un jumeau ne serait retenu par rien et tomberait en fantôme.
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
    preset: 'veste',
    presetSize: size,
    pieces: [
      // pid 2 — devant droit : pièce libre auto-placée par ses coutures
      // (la topologie du colorblock ✂, éprouvée en essayage).
      frontR,
      // pid 3/4/5 — doublures devant G, devant D, dos (sous leurs supports).
      lining(0, liningHalfW, u(-(CF_GAP + halfBody) / 2), DROP_NECK_F),
      lining(2, liningHalfW, u((CF_GAP + halfBody) / 2), DROP_NECK_F),
      lining(1, 2 * halfBody - 2 * LINING_INSET, 0.5, DROP_NECK_B),
    ],
    seams: [
      // Épaule + haut de manche kimono, G puis D (devant↔dos).
      seam(0, { from: 2, to: 3 }, 1, { from: 8, to: 9 }),
      seam(2, { from: 2, to: 3 }, 1, { from: 0, to: 1 }),
      // Dessous de manche + côté, G puis D (un seul run continu chacun).
      seam(0, { from: 4, to: 6 }, 1, { from: 5, to: 7 }),
      seam(2, { from: 4, to: 6 }, 1, { from: 2, to: 4 }),
      // La FERMETURE : milieu devant gauche ↔ milieu devant droit.
      seam(0, { from: 7, to: 8 }, 2, { from: 7, to: 8 }, 'zipper'),
    ],
  };
}
