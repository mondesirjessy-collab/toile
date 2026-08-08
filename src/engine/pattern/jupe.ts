/**
 * jupe — le premier patron gradable né APRÈS le Studio IA : une jupe trapèze
 * à pinces, dessinée comme un bloc de patronnier (pas décalquée d'un PDF).
 *
 * Construction (par pièce, DEVANT = DOS au galbe de pince près) :
 * - la ligne de taille porte l'aisance (4 cm au tour) et DEUX bouches de
 *   pince ; la différence taille/hanches se résorbe entre les pinces et le
 *   galbe du côté, comme sur un bloc classique ;
 * - le côté passe PAR le point de hanche (tour de hanches + 6 cm d'aisance à
 *   la ligne de hanche, ~20 cm sous la taille) puis évase vers l'ourlet
 *   (×1,16 du demi-tour de hanche) — la silhouette trapèze ;
 * - la jupe TIENT toute seule : le tour de taille cousu reste inférieur au
 *   tour de hanches, le corps la porte (le zip d'enfilage réel viendra avec
 *   la mercerie ; l'essayage 3D, lui, coud les pièces autour du corps).
 *
 * Tailles : EU 34-46 (table taille/hanches classique) + « avatar » (coupée
 * aux mensurations mesurées du corps courant). Pur — aucune importation
 * moteur ; compilé par le même pipeline (compileDraft/compileAssembly) que
 * les autres patrons de l'atelier.
 */
import type { BodyMeasure } from '../body/measure';
import type { AssemblySeam, DraftDoc, DraftPiece, UV } from './Draft';

export const JUPE_SIZES = ['34', '36', '38', '40', '42', '44', '46'] as const;
export type JupeSize = (typeof JUPE_SIZES)[number];

/** Table des corps (cm) — taille / hanches, gradation classique de 4 en 4. */
const JUPE_TABLE: Record<JupeSize, { tailleCm: number; hanchesCm: number }> = {
  '34': { tailleCm: 60, hanchesCm: 84 },
  '36': { tailleCm: 64, hanchesCm: 88 },
  '38': { tailleCm: 68, hanchesCm: 92 },
  '40': { tailleCm: 72, hanchesCm: 96 },
  '42': { tailleCm: 76, hanchesCm: 100 },
  '44': { tailleCm: 80, hanchesCm: 104 },
  '46': { tailleCm: 84, hanchesCm: 108 },
};

export function jupeCm(size: JupeSize): { tailleCm: number; hanchesCm: number } {
  return JUPE_TABLE[size];
}

// Constantes de construction (mètres) — nommées pour être réglables.
const EASE_WAIST_QUARTER = 0.01; // 4 cm d'aisance au tour de taille ÷ 4
const EASE_HIP_QUARTER = 0.015; // 6 cm d'aisance au tour de hanches ÷ 4
const HIP_DROP = 0.2; // taille → ligne de hanche
const LEN = 0.55; // taille → ourlet (mi-genou)
const FLARE = 1.16; // demi-ourlet / demi-hanche (le trapèze)
// MÊME bouche devant/dos (2,5 cm) : les côtés se cousent bord à bord — la
// différence devant/dos vit dans la PROFONDEUR (le dos résorbe plus long).
const DART_W = 0.025;
const DART_LEN_FRONT = 0.09;
const DART_LEN_BACK = 0.125;
const SIDE_MARGIN = 0.02; // marge du cadre physique autour de l'ourlet

export interface JupeBodyCm {
  tailleCm: number;
  hanchesCm: number;
}

/** Les cotes réellement utilisées (taille « avatar » = corps mesuré). */
export function jupeBodyCm(size: JupeSize | 'avatar', m: BodyMeasure): JupeBodyCm {
  if (size === 'avatar') {
    return {
      tailleCm: Math.round(m.waist.circ * 1000) / 10,
      hanchesCm: Math.round(m.hip.circ * 1000) / 10,
    };
  }
  return JUPE_TABLE[size];
}

function face(
  body: JupeBodyCm,
  dartW: number,
  dartLen: number,
  topY: number,
): DraftPiece {
  const taille = body.tailleCm / 100;
  const hanches = body.hanchesCm / 100;
  const halfWaistSewn = taille / 4 + EASE_WAIST_QUARTER;
  const halfHip = hanches / 4 + EASE_HIP_QUARTER;
  const halfHem = halfHip * FLARE;
  // La ligne de taille COUPÉE inclut les deux bouches de pince : cousues, la
  // taille revient à halfWaistSewn de chaque côté du milieu.
  const halfWaistCut = halfWaistSewn + dartW;
  const width = 2 * (halfHem + SIDE_MARGIN);
  const height = LEN + 0.02;
  const u = (xM: number): number => 0.5 + xM / width;
  const vHip = HIP_DROP / height;
  const vHem = LEN / height;
  const vDart = dartLen / height;
  // Pince à mi-chemin du milieu → côté (au-dessus du bombé de hanche).
  const xDart = 0.5 * halfWaistSewn;

  const outline: UV[] = [
    [u(halfWaistCut), 0], // 0  taille côté D
    [u(halfHip), vHip], // 1  hanche D (le côté passe PAR le point de hanche)
    [u(halfHem), vHem], // 2  ourlet D
    [u(-halfHem), vHem], // 3  ourlet G
    [u(-halfHip), vHip], // 4  hanche G
    [u(-halfWaistCut), 0], // 5  taille côté G
    [u(-xDart - dartW / 2), 0], // 6  pince G, bord côté
    [u(-xDart + dartW / 2), 0], // 7  pince G, bord milieu
    [0.5, 0], // 8  milieu taille
    [u(xDart - dartW / 2), 0], // 9  pince D, bord milieu
    [u(xDart + dartW / 2), 0], // 10 pince D, bord côté
  ];
  return {
    outline,
    darts: [
      { apex: [u(xDart), vDart], legA: [u(xDart - dartW / 2), 0], legB: [u(xDart + dartW / 2), 0] },
      { apex: [u(-xDart), vDart], legA: [u(-xDart + dartW / 2), 0], legB: [u(-xDart - dartW / 2), 0] },
    ],
    seams: [],
    openEdges: [
      { from: 2, to: 3 }, // ourlet
      { from: 5, to: 11 }, // ligne de taille (côté G → milieu → côté D, avec les bouches)
    ],
    width,
    height,
    topY,
    gap: 0.9,
  };
}

/**
 * La jupe complète : DEVANT + DOS cousus aux côtés (taille → hanche → ourlet),
 * taille et ourlet ouverts. `ref` cale la pièce à la taille du mannequin de
 * référence, comme les autres patrons ; le corps réel la porte à SA taille.
 */
export function draftJupe(
  size: JupeSize | 'avatar',
  m: BodyMeasure,
  _ref: BodyMeasure,
): DraftDoc {
  const body = jupeBodyCm(size, m);
  // La ceinture naît à la taille MESURÉE du corps courant (waist.y), le haut
  // de pièce 1 cm au-dessus pour laisser la couture vivre.
  const topY = m.waist.y + 0.01;
  const front = face(body, DART_W, DART_LEN_FRONT, topY);
  const back = face(body, DART_W, DART_LEN_BACK, topY);
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
    presetSize: size,
    // Côté D (taille→hanche→ourlet) et côté G — les deux seules coutures.
    seams: [seam(0, 2), seam(3, 5)],
  };
}
