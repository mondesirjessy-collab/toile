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
  const dropF = 0.105 * (chestFlat / 0.61); // creux col devant (10.5 cm, LA cote du patron papier) — tenable depuis que la BANDE D'ENCOLURE (pièce 5) resserre le col
  const dropB = 0.02;
  const slope = 0.02; // pente d'épaule adoucie (2 cm) — l'aplomb avant tout
  const armDepth = 0.135 * (chestFlat / 0.61); // demi-tour d'emmanchure (27 cm/2, gradé)
  // Une face = un tracé COURBE, comme le patron papier : encolure arrondie
  // (5 points d'arc en cosinus), emmanchures légèrement galbées, épaules
  // tombantes. Sens horaire : col G → épaule G → emmanchure G → ourlet →
  // emmanchure D → épaule D → col D → arc d'encolure → retour au col G.
  const face = (dropM: number): DraftPiece => {
    const vSlope = slope / H;
    const vUnder = (slope + armDepth) / H;
    const vDrop = dropM / H;
    // Arc d'encolure (droite → gauche), demi-cosinus passant par le creux.
    const neckArc: UV[] = [];
    for (const t of [0.78, 0.45, 0, -0.45, -0.78]) {
      neckArc.push([0.5 + t * neckHalfU, vDrop * Math.cos((t * Math.PI) / 2) + (1 - Math.cos((t * Math.PI) / 2)) * 0]);
    }
    const outline: UV[] = [
      [0.5 - neckHalfU, 0], // 0 col G
      [0.06, vSlope], // 1 épaule G extérieure (tombante)
      [0.048, vSlope + 0.45 * (vUnder - vSlope)], // 2 emmanchure G (léger galbe)
      [0.05, vUnder], // 3 bas d'emmanchure G
      [0.06, 0.98], // 4 ourlet G
      [0.94, 0.98], // 5 ourlet D
      [0.95, vUnder], // 6 bas d'emmanchure D
      [0.952, vSlope + 0.45 * (vUnder - vSlope)], // 7 emmanchure D (galbe)
      [0.94, vSlope], // 8 épaule D extérieure
      [0.5 + neckHalfU, 0], // 9 col D
      ...neckArc, // 10-14 encolure arrondie (droite → creux → gauche)
    ];
    return {
      outline,
      darts: [],
      seams: [],
      openEdges: [
        { from: 4, to: 5 }, // ourlet
        { from: 9, to: 15 }, // encolure (l'arc complet, col D → col G)
      ],
      width: W,
      height: H,
      topY,
      gap: 0.9,
    };
  };
  // Manche (×2) : pièce WRAP à TÊTE COURBE et FUSELÉE — le sommet arrondi
  // monte au milieu (arc sinus, ~14 % de la longueur), les dessous de bras aux
  // coins, et le poignet se resserre à 80 % du biceps (table : ouverture 20 /
  // biceps 25) : les côtés descendent en oblique, comme la pièce du patron
  // papier. La bouche du tube suit la courbe (wrapCrossSeams épingle la
  // première cellule vivante de chaque colonne) et le poignet suit le fuselage
  // (dernière cellule vivante — le contrat tube ouvre les deux).
  const CAP = 0.14; // hauteur de tête (fraction de la longueur de manche)
  const CUFF = 0.8; // ouverture du poignet / biceps (20 cm / 25 cm, la table)
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => {
    const capArc: UV[] = [];
    for (const u of [0.1, 0.28, 0.5, 0.72, 0.9]) {
      capArc.push([u, CAP * (1 - Math.sin(Math.PI * u))]);
    }
    const cuffIn = (1.02 * (1 - CUFF)) / 2; // rentré de chaque côté au poignet
    return {
      outline: [
        [-0.01, CAP], // coin haut G (dessous de bras, pleine largeur biceps)
        ...capArc, // tête arrondie (monte à v=0 au milieu)
        [1.01, CAP], // coin haut D
        [1.01 - cuffIn, 1.01], // poignet D (fuselé)
        [-0.01 + cuffIn, 1.01], // poignet G
      ],
      darts: [],
      seams: [],
      openEdges: [],
      width: 0.5 * (m.chest.circ * 0.32), // biceps ≈ 0.32·poitrine (25 cm / 78) → demi-tour
      height: 0.245 * (chestFlat / 0.61), // longueur de manche (24.5 cm taille M, gradée)
      topY: m.shoulderY + 0.01, // la tête du tube naît à l'épaule
      gap: 0.18,
      wrap,
    };
  };
  // BANDE D'ENCOLURE (pièce 5 du patron) : un anneau étroit autour du cou,
  // coupé PLUS COURT que le tour d'encolure (~85 %) — cousu au col, il le
  // RESSERRE (l'aisance négative du jersey) : c'est lui qui retient un col
  // creusé à la cote du papier. Tube wrap 'neck' : deux panneaux de part et
  // d'autre du cou, bord bas épinglé au ras de l'encolure (collarCrossSeams).
  const neckArcLen = 2.6 * neckHalfU * W + 1.4 * dropF; // approx. du tour (devant creusé + dos)
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
    width: 0.85 * neckArcLen * 0.5, // demi-tour de bande = 85 % du demi-tour d'encolure (la pince du col)
    height: 0.035, // bande de 3,5 cm
    topY: m.neckY - 0.005, // le bord bas de la bande rejoint l'encolure
    gap: 0.15, // les panneaux enjambent le cou sans naître dedans
    wrap: 'neck',
  });
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: face(dropF),
    back: face(dropB),
    manual: true,
    pieces: [sleeve('armR'), sleeve('armL'), band()],
    // Épaules + côtés PLEINE hauteur (emmanchure comprise) : la ligne soudée
    // devant↔dos sur laquelle les épingles de manche verrouillent le tube.
    seams: [seam(0, 1), seam(8, 9), seam(1, 4), seam(5, 8)],
  };
}

// ---------------------------------------------------------------------------
// BOXY FIT T-SHIRT — reproduction FIDÈLE du patron papier fourni par Jessy
// (BOXY T-SHIRT A0.pdf). Coupe oversize à épaules tombantes, 4 pièces
// (devant/dos sur pliure, manche ×2, col), 6 TAILLES XS→XXL. Les cotes viennent
// des contours lus AU 1/10 DE CM dans le vecteur (carré-témoin 6×6 cm vérifié) —
// voir la mémoire `patron-boxy-tshirt`. Contrairement à oversizeTee (gradé sur
// l'avatar), ici chaque taille est ABSOLUE : XS = tour 100 cm, …, XXL = 130 cm ;
// l'avatar ne sert qu'au placement vertical. Reproduit sur la mécanique éprouvée
// (corps devant/dos cousu épaules+côtés pleine hauteur, manches WRAP, col WRAP).
// ---------------------------------------------------------------------------
export type BoxySize = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';

/** Cotes exactes par taille, en MÈTRES (extraites du patron). halfW = demi-
 * largeur (sur pliure) ; len = longueur ; neckHW = demi-encolure ; fDepth/bDepth
 * = creux d'encolure devant/dos ; shTipX = x du bout d'épaule (tombée) ; armD =
 * profondeur d'emmanchure ; capSpan = tour de tête de manche ; cuff = ouverture
 * de manche ; sleeveLen = longueur de manche ; collar = longueur de la bande. */
interface BoxyDims {
  halfW: number; len: number; neckHW: number; fDepth: number; bDepth: number;
  shTipX: number; armD: number; capSpan: number; cuff: number; sleeveLen: number; collar: number;
}
const BOXY: Record<BoxySize, BoxyDims> = {
  XS:  { halfW: 0.250, len: 0.68, neckHW: 0.087, fDepth: 0.072, bDepth: 0.022, shTipX: 0.224, armD: 0.183, capSpan: 0.420, cuff: 0.360, sleeveLen: 0.140, collar: 0.270 },
  S:   { halfW: 0.265, len: 0.70, neckHW: 0.089, fDepth: 0.074, bDepth: 0.025, shTipX: 0.238, armD: 0.193, capSpan: 0.445, cuff: 0.380, sleeveLen: 0.150, collar: 0.280 },
  M:   { halfW: 0.280, len: 0.72, neckHW: 0.092, fDepth: 0.077, bDepth: 0.027, shTipX: 0.253, armD: 0.203, capSpan: 0.468, cuff: 0.400, sleeveLen: 0.155, collar: 0.290 },
  L:   { halfW: 0.295, len: 0.74, neckHW: 0.094, fDepth: 0.079, bDepth: 0.030, shTipX: 0.269, armD: 0.213, capSpan: 0.492, cuff: 0.420, sleeveLen: 0.165, collar: 0.300 },
  XL:  { halfW: 0.310, len: 0.76, neckHW: 0.097, fDepth: 0.082, bDepth: 0.032, shTipX: 0.284, armD: 0.223, capSpan: 0.515, cuff: 0.440, sleeveLen: 0.175, collar: 0.310 },
  XXL: { halfW: 0.325, len: 0.78, neckHW: 0.099, fDepth: 0.084, bDepth: 0.035, shTipX: 0.305, armD: 0.233, capSpan: 0.540, cuff: 0.460, sleeveLen: 0.185, collar: 0.320 },
};
export const BOXY_SIZES: BoxySize[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
/** Tour de poitrine (cm) d'une taille — pour l'étiquette du sélecteur. */
export function boxyChestCm(sz: BoxySize): number {
  return Math.round(BOXY[sz].halfW * 4 * 100); // 2 faces × 2 (pliure)
}

export function boxyTee(size: BoxySize, m: BodyMeasure, ref: BodyMeasure): DraftDoc {
  const D = BOXY[size];
  const MARGIN = 0.02; // 2 cm de marge de chaque côté (le corps ne touche pas le bord u=0/1)
  const W = 2 * D.halfW + 2 * MARGIN; // largeur physique de la pièce (m)
  const H = D.len;
  const topY = 1.52 + (m.shoulderY - ref.shoulderY); // ligne épaule-encolure = haut de la pièce (v=0)
  const u = (xM: number): number => 0.5 + xM / W; // x monde (m, centré 0) → u
  const vDropTip = D.armD > 0 ? 0.051 / H : 0; // tombée d'épaule 5,1 cm (constante)
  const vUnder = (0.051 + D.armD) / H; // dessous de bras = tombée + emmanchure
  const hollowX = (D.shTipX + D.halfW) / 2 - 0.024; // l'emmanchure se creuse de ~2,4 cm
  const vHollow = (vDropTip + vUnder) / 2;
  // Une face, DEVANT (creux profond) ou DOS (creux faible). Même structure
  // d'indices qu'oversizeTee → les mêmes coutures/bords ouverts s'appliquent.
  const face = (neckDepth: number): DraftPiece => {
    const vNeckC = neckDepth / H;
    const neckArc: UV[] = [];
    for (const t of [0.82, 0.45, 0, -0.45, -0.82]) {
      neckArc.push([0.5 + t * (D.neckHW / W), vNeckC * Math.cos((t * Math.PI) / 2)]);
    }
    const outline: UV[] = [
      [u(-D.neckHW), 0],       // 0 encolure↔épaule G
      [u(-D.shTipX), vDropTip], // 1 bout d'épaule G (tombante)
      [u(-hollowX), vHollow],   // 2 creux d'emmanchure G
      [u(-D.halfW), vUnder],    // 3 dessous de bras G
      [u(-D.halfW), 0.985],     // 4 ourlet G
      [u(D.halfW), 0.985],      // 5 ourlet D
      [u(D.halfW), vUnder],     // 6 dessous de bras D
      [u(hollowX), vHollow],    // 7 creux d'emmanchure D
      [u(D.shTipX), vDropTip],  // 8 bout d'épaule D
      [u(D.neckHW), 0],         // 9 encolure↔épaule D
      ...neckArc,               // 10-14 arc d'encolure (D → creux → G)
    ];
    return {
      outline, darts: [], seams: [],
      openEdges: [{ from: 4, to: 5 }, { from: 9, to: 15 }], // ourlet + encolure
      width: W, height: H, topY, gap: 0.9,
    };
  };
  // Manche WRAP ×2 : tube court et large (boxy). La tête (courbe) se coud à
  // l'emmanchure (wrapCrossSeams) ; le poignet reste ouvert et large.
  const CAP = 0.16; // hauteur de tête (fraction de la longueur)
  const cuffIn = ((D.capSpan - D.cuff) / D.capSpan) / 2; // rentré au poignet (tête plus large que poignet)
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => {
    const capArc: UV[] = [];
    for (const uu of [0.1, 0.28, 0.5, 0.72, 0.9]) {
      capArc.push([uu, CAP * (1 - Math.sin(Math.PI * uu))]);
    }
    return {
      outline: [
        [-0.01, CAP], ...capArc, [1.01, CAP],
        [1.01 - cuffIn, 1.01], [-0.01 + cuffIn, 1.01],
      ],
      darts: [], seams: [], openEdges: [],
      width: 0.5 * D.capSpan, // demi-tour de tête = ce qui s'épingle à l'emmanchure
      height: D.sleeveLen,
      topY: m.shoulderY + 0.01,
      gap: 0.20, // tube large (boxy) autour du bras
      wrap,
    };
  };
  // BANDE D'ENCOLURE (col) : anneau coupé plus court que l'encolure (~88 %),
  // resserre le col. Tube wrap 'neck'.
  const neckRing = 2 * (D.fDepth + D.bDepth) + 2.2 * D.neckHW; // approx. du tour d'encolure
  const band = (): DraftPiece => ({
    outline: [[-0.01, -0.01], [1.01, -0.01], [1.01, 1.01], [-0.01, 1.01]],
    darts: [], seams: [], openEdges: [],
    width: 0.88 * neckRing * 0.5,
    height: 0.035,
    topY: m.neckY - 0.005,
    gap: 0.15,
    wrap: 'neck',
  });
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft', version: 1, gridN: 64,
    piece: face(D.fDepth), back: face(D.bDepth), manual: true,
    pieces: [sleeve('armR'), sleeve('armL'), band()],
    // Épaules {0,1}/{8,9} + côtés pleine hauteur {1,4}/{5,8} (la ligne soudée
    // qui verrouille l'épinglage des manches — recette éprouvée v104/v112).
    seams: [seam(0, 1), seam(8, 9), seam(1, 4), seam(5, 8)],
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
