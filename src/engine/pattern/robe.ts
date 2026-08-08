/**
 * robe — le bloc ROBE CINTRÉE sans manches, dessiné comme un patron de base
 * (pas décalqué d'un PDF) : la seconde moitié du chantier « jupe et robe ».
 *
 * Construction (DEVANT + DOS, mêmes côtés — seuls encolure, pente d'épaule et
 * creux d'emmanchure diffèrent, comme sur le bloc t-shirt éprouvé) :
 * - encolure dérivée du tour de poitrine (0,35·poitrine), creusée devant ;
 * - épaules à la largeur MESURÉE du mannequin (deltoïde rogné), pente réelle ;
 * - emmanchures SANS manches, coupées plus près du corps que celles du tee ;
 * - le côté descend du dessous de bras (poitrine/4 + aisance) en marquant la
 *   taille (le cintrage vit dans la couture de côté, pas dans des pinces),
 *   passe PAR le point de hanche puis évase vers l'ourlet (×1,12) — une ligne A ;
 * - la robe TIENT par les ÉPAULES, comme le tee : aucun ancrage de ceinture à
 *   prévoir (le piège de la jupe ne s'applique pas à un vêtement épaulé).
 *
 * Verticales tirées du CORPS COURANT (taille, hanche, genou mesurés) : une
 * taille EU choisit les tours, le mannequin donne les hauteurs — l'ourlet
 * s'arrête au-dessus du genou quelle que soit la stature.
 *
 * Tailles : EU 34-46 (poitrine/taille/hanches, gradation de 4 en 4, colonnes
 * taille/hanches IDENTIQUES à la table de la jupe) + « avatar » (coupée aux
 * mensurations mesurées). Pur — aucune importation moteur ; compilé par le
 * même pipeline (compileDraft/compileAssembly) que les autres patrons.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, UV } from './Draft';

export const ROBE_SIZES = ['34', '36', '38', '40', '42', '44', '46'] as const;
export type RobeSize = (typeof ROBE_SIZES)[number];

/** Table des corps (cm) — poitrine / taille / hanches, gradation de 4 en 4. */
const ROBE_TABLE: Record<RobeSize, { poitrineCm: number; tailleCm: number; hanchesCm: number }> = {
  '34': { poitrineCm: 80, tailleCm: 60, hanchesCm: 84 },
  '36': { poitrineCm: 84, tailleCm: 64, hanchesCm: 88 },
  '38': { poitrineCm: 88, tailleCm: 68, hanchesCm: 92 },
  '40': { poitrineCm: 92, tailleCm: 72, hanchesCm: 96 },
  '42': { poitrineCm: 96, tailleCm: 76, hanchesCm: 100 },
  '44': { poitrineCm: 100, tailleCm: 80, hanchesCm: 104 },
  '46': { poitrineCm: 104, tailleCm: 84, hanchesCm: 108 },
};

export interface RobeBodyCm {
  poitrineCm: number;
  tailleCm: number;
  hanchesCm: number;
}

export function robeCm(size: RobeSize): RobeBodyCm {
  return ROBE_TABLE[size];
}

/** Les cotes réellement utilisées (taille « avatar » = corps mesuré). */
export function robeBodyCm(size: RobeSize | 'avatar', m: BodyMeasure): RobeBodyCm {
  if (size === 'avatar') {
    return {
      poitrineCm: Math.round(m.chest.circ * 1000) / 10,
      tailleCm: Math.round(m.waist.circ * 1000) / 10,
      hanchesCm: Math.round(m.hip.circ * 1000) / 10,
    };
  }
  return ROBE_TABLE[size];
}

// Constantes de construction (mètres) — mêmes sources que le bloc t-shirt
// (blocs réels Melly Sews / Shapes of Fabric), ajustées au sans-manches.
const EASE_CHEST_QUARTER = 0.015; // 6 cm d'aisance poitrine au tour ÷ 4
const EASE_WAIST_QUARTER = 0.025; // 10 cm à la taille : cintrée, pas moulée (elle s'enfile)
const EASE_HIP_QUARTER = 0.015; // 6 cm aux hanches
const FLARE = 1.12; // demi-ourlet / demi-hanche — le coup de ligne A
const DROP_NECK_F = 0.08; // creux d'encolure devant (un rond de robe, un peu plus qu'un tee)
const DROP_NECK_B = 0.02; // creux dos
const SLOPE_F = 0.036; // pente d'épaule devant
const SLOPE_B = 0.02; // pente dos (plus plate)
const BACK_RISE = 0.013; // l'épaule dos naît plus haut que le devant
const RATIO_NECK = 0.35; // tour d'encolure ≈ 0,35·poitrine (dérivé, non mesuré)
const DELTOID_TRIM = 0.82; // shoulderHalfW inclut le deltoïde ; rogné au point de couture
const ARM_SCOOP = 0.16; // creux d'emmanchure : SANS manche, coupée plus haut que le tee (0,19)
const KNEE_RATIO = 0.3; // hauteur du genou ≈ 0,30·stature — l'ourlet s'arrête juste au-dessus
const SIDE_MARGIN = 0.02; // marge du cadre physique autour de l'ourlet

/**
 * La robe complète : DEVANT + DOS cousus aux épaules et sur les côtés
 * (dessous de bras → taille → hanche → ourlet), encolure, emmanchures et
 * ourlet ouverts. `ref` cale la pièce en hauteur comme les autres archétypes.
 */
export function draftRobe(
  size: RobeSize | 'avatar',
  m: BodyMeasure,
  ref: BodyMeasure,
): DraftDoc {
  const body = robeBodyCm(size, m);
  const poitrine = body.poitrineCm / 100;
  const halfBust = poitrine / 4 + EASE_CHEST_QUARTER;
  const halfWaist = body.tailleCm / 100 / 4 + EASE_WAIST_QUARTER;
  const halfHip = body.hanchesCm / 100 / 4 + EASE_HIP_QUARTER;
  const halfHem = halfHip * FLARE;
  const neckHalfW = (RATIO_NECK * poitrine) / 10; // = 0,035·poitrine, IDENTIQUE devant/dos
  const shX = m.shoulderHalfW * DELTOID_TRIM;
  // Profondeurs sous la LIGNE D'ÉPAULE (v = 0) — le corps courant donne les
  // hauteurs, la taille EU donne les tours. Les max en cascade gardent un
  // contour ordonné même sur un corps hors norme (scan importé).
  const dUnder = poitrine / 8 + 0.055 * (m.height / 1.755); // profondeur d'emmanchure
  const dWaist = Math.max(m.shoulderY - m.waist.y, dUnder + 0.04);
  const dHip = Math.max(m.shoulderY - m.hip.y, dWaist + 0.06);
  const dHem = Math.max(m.shoulderY - KNEE_RATIO * m.height, dHip + 0.08);
  const height = dHem + 0.02;
  const width = 2 * (Math.max(halfHem, halfBust, shX) + SIDE_MARGIN);
  const topY = 1.52 + (m.shoulderY - ref.shoulderY); // placement gradé, comme le tee
  const vUnder = dUnder / height;
  const vWaist = dWaist / height;
  const vHip = dHip / height;
  const vHem = dHem / height;
  const armScoop = ARM_SCOOP * dUnder;

  // Une face ; `scoopFac` module le creux d'emmanchure (devant plus creusé).
  const face = (neckDepthM: number, slopeM: number, riseM: number, scoopFac: number): DraftPiece => {
    const u = (xM: number): number => 0.5 + xM / width;
    const vNeck = neckDepthM / height;
    const vSlope = (slopeM - riseM) / height;
    const a1v = vSlope + 0.45 * (vUnder - vSlope);
    const a2v = vSlope + 0.75 * (vUnder - vSlope);
    const a1x = shX - 0.005;
    const a2x = halfBust - scoopFac * armScoop;
    const outline: UV[] = [
      [0.5, vNeck], // 0  creux d'encolure (milieu)
      [u(neckHalfW), 0], // 1  encolure↔épaule D
      [u(shX), vSlope], // 2  point d'épaule D
      [u(a1x), a1v], // 3  emmanchure D haute
      [u(a2x), a2v], // 4  emmanchure D creuse
      [u(halfBust), vUnder], // 5  dessous de bras D
      [u(halfWaist), vWaist], // 6  taille D (le cintrage)
      [u(halfHip), vHip], // 7  hanche D (le côté passe PAR le point de hanche)
      [u(halfHem), vHem], // 8  ourlet D
      [u(-halfHem), vHem], // 9  ourlet G
      [u(-halfHip), vHip], // 10 hanche G
      [u(-halfWaist), vWaist], // 11 taille G
      [u(-halfBust), vUnder], // 12 dessous de bras G
      [u(-a2x), a2v], // 13 emmanchure G creuse
      [u(-a1x), a1v], // 14 emmanchure G haute
      [u(-shX), vSlope], // 15 point d'épaule G
      [u(-neckHalfW), 0], // 16 encolure↔épaule G
    ];
    return {
      outline,
      darts: [],
      seams: [],
      openEdges: [
        { from: 16, to: 1 }, // encolure (les deux arêtes par le creux 0)
        { from: 2, to: 5 }, // emmanchure D (arêtes 2, 3, 4)
        { from: 8, to: 9 }, // ourlet
        { from: 12, to: 15 }, // emmanchure G (arêtes 12, 13, 14)
      ],
      width,
      height,
      topY,
      gap: 0.9,
    };
  };

  const front = face(DROP_NECK_F, SLOPE_F, 0, 1.0);
  const back = face(DROP_NECK_B, SLOPE_B, BACK_RISE, 0.8);
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
    preset: 'robe',
    presetSize: size,
    // Épaules (arêtes 1 et 15) + côtés dessous de bras → taille → hanche →
    // ourlet (arêtes 5-7 et 9-11) : quatre coutures, le cintrage est dedans.
    seams: [seam(1, 2), seam(15, 16), seam(5, 8), seam(9, 12)],
  };
}
