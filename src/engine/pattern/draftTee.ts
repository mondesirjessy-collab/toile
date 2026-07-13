/**
 * draftTee — draft a real set-in-sleeve T-SHIRT pattern from the avatar's actual
 * body measurements (BodyMeasure), as an editable DraftDoc. Every dimension comes
 * from a measurement (chest circumference / 4 + ease, armhole depth ≈ chest/8,
 * shoulder = measured shoulder width, neckline = derived neck girth, …) — NOT a
 * single global scale factor. Stage 1: FRONT + BACK only (a fitted tank whose
 * front/back differ — deeper front neckline, higher back shoulder), sewn at the
 * shoulders + sides. The sleeves (a matched sleeve cap ↔ armhole, with a measured
 * ease loop) come in stage 2. Pure — no engine/GPU imports; compiled by the same
 * freeform pipeline (compileDraft + compileAssembly) the atelier already uses.
 */
import type { BodyMeasure } from '../body/measure';
import type { DraftDoc, DraftPiece, AssemblySeam, UV } from './Draft';

// Drafting constants (metres; named so they can be tuned). Sources: real
// t-shirt blocks (Melly Sews / Shapes of Fabric / SewGuide).
const EASE_CHEST_QUARTER = 0.0125; // 5 cm total girth ease ÷ 4 panels
const DROP_NECK_F = 0.075; // front neckline depth below the shoulder line
const DROP_NECK_B = 0.02; // back neckline depth (a real tee's shallow back scoop)
const SLOPE_F = 0.036; // front shoulder slope (drop from neck to shoulder point)
const SLOPE_B = 0.02; // back shoulder slope (flatter)
const BACK_RISE = 0.013; // back shoulder point sits higher than the front
const RATIO_NECK = 0.35; // neck girth ≈ 0.35·chest girth (not measured → derived)
const DELTOID_TRIM = 0.82; // shoulderHalfW includes the deltoid; trim to the seam point
const HEM_LEN = 0.62; // shoulder → hem (hip length, a t-shirt not a tunic)

/**
 * oversizeTee — le patron OVERSIZE drop-shoulder de référence (K.Kose, fourni
 * par l'utilisateur : DEVANT au pli, DOS au pli, 2 MANCHES), redessiné en
 * pièces TOILE et gradé sur les mensurations de l'avatar. Proportions de la
 * table de tailles (cm, taille M ramenée au tour de poitrine mesuré) :
 * poitrine à plat ≈ chest·1.35/2, longueur ≈ 1.24·poitrine à plat, col ≈ ⅓ de
 * la poitrine à plat, creux de col devant ≈ 10.5 cm (dos ≈ 2 cm), emmanchure
 * (épaule tombante, quasi droite) ≈ 27 cm de tour, manche ≈ biceps 25 ×
 * longueur 24. Le corps = DEVANT + DOS cousus épaules + côtés pleine hauteur
 * (la ligne soudée qui porte l'épinglage des manches — recette v104/v112) ;
 * les manches = pièces WRAP éditables (tube autour du bras, bouche/poignet
 * ouverts par construction, épinglées par wrapCrossSeams). Tout est éditable
 * et s'imprime en 4 pièces numérotées.
 */
export function oversizeTee(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const chestFlat = (m.chest.circ * 1.35) / 2; // poitrine du vêtement à plat (oversize ×1.35)
  const W = chestFlat / 0.9; // la pièce garde 5 % de marge de chaque côté (corps u ∈ [0.05, 0.95])
  const H = Math.min(0.7, 1.24 * chestFlat); // longueur totale (ratio 76/61 de la table)
  const topY = 1.52 + (m.shoulderY - ref.shoulderY);
  const neckHalfU = (chestFlat / 3 / 2) / W; // col ≈ ⅓ de la poitrine à plat (~18 cm)
  const dropF = 0.07 * (chestFlat / 0.61); // creux col devant — 10.5 cm sur le patron papier ; 7 cm ici, le compromis qui tient au drapé (le col très creusé glisse des épaules du scan)
  const dropB = 0.02;
  const slope = 0.02; // pente d'épaule adoucie (2 cm) — l'aplomb avant tout
  const armDepth = 0.135 * (chestFlat / 0.61); // demi-tour d'emmanchure (27 cm/2, gradé)
  const face = (dropM: number): DraftPiece => ({
    outline: [
      [0.5 - neckHalfU, 0], // 0 col G
      [0.06, slope / H], // 1 épaule G extérieure (tombante)
      [0.05, (slope + armDepth) / H], // 2 bas d'emmanchure G
      [0.06, 0.98], // 3 ourlet G
      [0.94, 0.98], // 4 ourlet D
      [0.95, (slope + armDepth) / H], // 5 bas d'emmanchure D
      [0.94, slope / H], // 6 épaule D extérieure
      [0.5 + neckHalfU, 0], // 7 col D
      [0.5, dropM / H], // 8 creux du col
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 3, to: 4 }, // ourlet
      { from: 7, to: 9 }, // encolure (arêtes 7 + 8)
    ],
    width: W,
    height: H,
    topY,
    gap: 0.9,
  });
  // Manche (×2) : pièce WRAP — rectangle plein aux cotes de la table (biceps ×
  // longueur). Le contour plein est le tube fiable ; la tête très douce d'une
  // épaule tombante s'en approche bien (le cap courbe = raffinement à venir).
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => ({
    outline: [
      [-0.01, -0.01],
      [1.01, -0.01],
      [1.01, 1.01],
      [-0.01, 1.01],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    width: 0.5 * (m.chest.circ * 0.32), // biceps ≈ 0.32·poitrine (25 cm / 78) → demi-tour
    height: 0.245 * (chestFlat / 0.61), // longueur de manche (24.5 cm taille M, gradée)
    topY: m.shoulderY + 0.005, // la bouche du tube naît à l'épaule
    gap: 0.18,
    wrap,
  });
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: face(dropF),
    back: face(dropB),
    manual: true,
    pieces: [sleeve('armR'), sleeve('armL')],
    // Épaules + côtés PLEINE hauteur (emmanchure comprise) : la ligne soudée
    // devant↔dos sur laquelle les épingles de manche verrouillent le tube.
    seams: [seam(0, 1), seam(6, 7), seam(1, 3), seam(4, 6)],
  };
}

/** A real set-in-sleeve tee pattern (front + back, drafted to `m`). `ref` is the
 * reference mannequin (for the vertical placement, like the archetypes). */
export function draftTee(m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const chest = m.chest.circ;
  const neckHalfW = (RATIO_NECK * chest) / 10; // = 0.035·chest; IDENTICAL front/back (shoulder seams must meet)
  const halfChest = chest / 4 + EASE_CHEST_QUARTER;
  const halfHip = Math.max(m.hip.circ / 4, chest / 4) + EASE_CHEST_QUARTER; // a straight tee never dips under the hip
  const AD = chest / 8 + 0.055 * (m.height / 1.755); // armhole depth (shoulder → underarm)
  const shX = m.shoulderHalfW * DELTOID_TRIM; // shoulder seam point (deltoid trimmed off)
  const widthBody = 2 * (m.shoulderHalfW + 0.03); // physical piece width (m), maps to u∈[0,1]
  const heightBody = HEM_LEN;
  const topY = 1.52 + (m.shoulderY - ref.shoulderY); // graded vertical placement, like tee()
  const vUnder = AD / heightBody; // underarm height in piece-v
  const armScoop = 0.19 * AD; // how far the armhole hollows inward from the side

  // Build one face. `scoopFac` scales the armhole hollow (front deeper than back).
  const face = (neckDepthM: number, slopeM: number, riseM: number, scoopFac: number): DraftPiece => {
    const u = (xM: number): number => 0.5 + xM / widthBody; // world-x (m) → piece-u
    const vNeck = neckDepthM / heightBody;
    const vSlope = (slopeM - riseM) / heightBody; // shoulder-point height (back raised)
    const scoop = scoopFac * armScoop;
    // Right-half armhole: two intermediate points that hollow the armscye inward.
    const a1v = vSlope + 0.45 * (vUnder - vSlope);
    const a2v = vSlope + 0.75 * (vUnder - vSlope);
    const a1x = shX - 0.005;
    const a2x = halfChest - scoop;
    const outline: UV[] = [
      [0.5, vNeck], // 0  N0  neck centre (scoop bottom)
      [u(neckHalfW), 0], // 1  N1_R neck↔shoulder right
      [u(shX), vSlope], // 2  S_R  shoulder point right
      [u(a1x), a1v], // 3  armhole R upper
      [u(a2x), a2v], // 4  armhole R lower (deepest hollow)
      [u(halfChest), vUnder], // 5  A_R  underarm right
      [u(halfHip), 0.98], // 6  hem right
      [u(-halfHip), 0.98], // 7  hem left
      [u(-halfChest), vUnder], // 8  A_L  underarm left
      [u(-a2x), a2v], // 9  armhole L lower
      [u(-a1x), a1v], // 10 armhole L upper
      [u(-shX), vSlope], // 11 S_L  shoulder point left
      [u(-neckHalfW), 0], // 12 N1_L neck↔shoulder left
    ];
    return {
      outline,
      darts: [],
      seams: [],
      openEdges: [
        { from: 12, to: 1 }, // neckline (edges 12 + 0, the head hole)
        { from: 2, to: 5 }, // right armhole (edges 2,3,4 — arm hole; the sleeve sews here in stage 2)
        { from: 6, to: 7 }, // hem
        { from: 8, to: 11 }, // left armhole (edges 8,9,10)
      ],
      width: widthBody,
      height: heightBody,
      topY,
      gap: 0.9,
    };
  };

  const front = face(DROP_NECK_F, SLOPE_F, 0, 1.0); // deeper neck, full slope, deeper armhole
  const back = face(DROP_NECK_B, SLOPE_B, BACK_RISE, 0.8); // shallow neck, flatter+raised shoulder, shallower armhole

  // Shoulders (edges 1 R, 11 L) and sides (edges 5 R, 7 L) sewn front↔back.
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: front,
    back,
    manual: true,
    seams: [seam(1, 2), seam(11, 12), seam(5, 6), seam(7, 8)],
  };
}
