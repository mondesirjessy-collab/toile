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
 * longueur 24. Le corps = DEVANT + DOS cousus aux épaules et sous les
 * emmanchures ; chaque emmanchure reste ouverte pour recevoir séparément le
 * panneau devant/dos de sa manche ;
 * les manches = pièces WRAP éditables (tube autour du bras, bouche/poignet
 * ouverts par construction, épinglées par sleeveCrossSeams). Tout est éditable
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
        { from: 1, to: 3 }, // emmanchure G
        { from: 4, to: 5 }, // ourlet
        { from: 6, to: 8 }, // emmanchure D
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
  // papier. La bouche du tube suit la courbe (sleeveCrossSeams épingle la
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
      placement: { role: wrap, autoAlign: true },
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
    placement: { role: 'neck', autoAlign: true },
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
    // Épaules + côtés SOUS les emmanchures. Les arcs 1→3 et 6→8 restent
    // ouverts : manche avant→devant, manche arrière→dos, sans jonction à 4 rims.
    seams: [seam(0, 1), seam(8, 9), seam(3, 4), seam(5, 6)],
  };
}

// ---------------------------------------------------------------------------
// BOXY FIT T-SHIRT — reproduction EXACTE du patron papier fourni par Jessy
// (BOXY T-SHIRT A0.pdf). Les contours ne sont PAS redessinés paramétriquement :
// ils sont LUS dans le vecteur du patron (Béziers aplaties puis ré-échantillonnées
// par abscisse curviligne — chaque micro-courbe du papier est dans la pièce) et
// stockés par taille dans boxyData.ts (généré). Emboîtement mesuré à
// l'extraction : Δépaule devant/dos = 0,0 mm, Δcôté = 0,0 mm, tête de manche =
// 98-99 % des deux emmanchures (l'aisance négative du jersey), sur les 6 tailles.
// La taille est ABSOLUE (XS = tour 100 cm … XXL = 130 cm) ; l'avatar ne sert
// qu'au placement vertical. Mécanique éprouvée : corps cousu épaules + côtés
// sous les emmanchures, manches WRAP, col WRAP.
// ---------------------------------------------------------------------------
import { BOXY_DATA, BOXY_IDX, BOXY_SIZES, type BoxySize } from './boxyData';
export { BOXY_SIZES, type BoxySize };

/** Tour de poitrine (cm) d'une taille — pour l'étiquette du sélecteur. */
export function boxyChestCm(sz: BoxySize): number {
  return BOXY_DATA[sz].chestCm;
}

export type TeeSleeves = 'none' | 'short' | 'long';
export type TeeCollar = 'sans' | 'cote' | 'montant';
export type TeeNeck = 'ras' | 'v';
export type TeeLength = 'crop' | 'regular' | 'long';
export function boxyTee(
  size: BoxySize,
  m: BodyMeasure,
  ref: BodyMeasure,
  sleeves: TeeSleeves = 'short',
  collar: TeeCollar = 'cote',
  neck: TeeNeck = 'ras',
  bodyLen: TeeLength = 'regular',
): DraftDoc {
  const D = BOXY_DATA[size];
  const topY = 1.52 + (m.shoulderY - ref.shoulderY); // ligne épaule-encolure = haut de pièce (v=0)
  const clone = (o: readonly UV[]): UV[] => o.map(([a, b]) => [a, b]);
  // DEVANT / DOS : le contour exact du patron (45 points — encolure 15 pts,
  // emmanchures en J 11 pts chacune, épaules droites, côtés/ourlet droits).
  // Bloc LONGUEUR du corps : on allonge (long) ou raccourcit (crop) le corps
  // UNIQUEMENT sous les emmanchures — l'ourlet (hemL/hemR) descend de
  // bodyLenDelta·H, tandis que tout le haut (encolure, épaules, emmanchures)
  // garde sa position physique. Les manches et le col restent donc alignés.
  const bodyLenDelta = bodyLen === 'crop' ? -0.16 : bodyLen === 'long' ? 0.2 : 0;
  const face = (body: { outline: UV[]; width: number; height: number }): DraftPiece => {
    const H = body.height;
    const Hp = H * (1 + bodyLenDelta);
    const outline = clone(body.outline);
    if (bodyLenDelta !== 0) {
      for (let i = 0; i < outline.length; i++) {
        const isHem = i === BOXY_IDX.hemL || i === BOXY_IDX.hemR;
        const y = outline[i]![1] * H + (isHem ? bodyLenDelta * H : 0);
        outline[i] = [outline[i]![0], y / Hp];
      }
    }
    return {
      outline,
      darts: [],
      seams: [],
      openEdges: [
        { from: BOXY_IDX.tipL, to: BOXY_IDX.uaL }, // emmanchure G
        { from: BOXY_IDX.hemL, to: BOXY_IDX.hemR }, // ourlet
        { from: BOXY_IDX.uaR, to: BOXY_IDX.tipR }, // emmanchure D
        { from: BOXY_IDX.neckR, to: BOXY_IDX.N }, // encolure (l'arc complet, colD → colG)
      ],
      width: body.width,
      height: Hp,
      topY,
      gap: 0.9,
    };
  };
  // MANCHE ×2 : panneau de tube WRAP — la bouche = le PROFIL RÉEL de la tête
  // de manche (courbe du patron, hauteur 7,4-9,6 cm selon la taille), le
  // poignet suit le rentré réel. sleeveCrossSeams épingle la bouche à
  // l'emmanchure ; le contrat tube ouvre bouche et poignet.
  // Bloc MANCHE échangeable : longue = tube ~2,8× plus long (jusqu'au
  // poignet), courte = tête de manche du patron. « Sans » retire les
  // deux pièces manche : les emmanchures restent des ouvertures finies.
  const sleeveH = sleeves === 'long' ? D.sleeve.height * 2.8 : D.sleeve.height;
  const sleeve = (wrap: 'armL' | 'armR'): DraftPiece => ({
    outline: clone(D.sleeve.outline),
    darts: [],
    seams: [],
    openEdges: [],
    width: D.sleeve.width, // demi-tour de tête (un panneau = une moitié du tube)
    height: sleeveH,
    topY: m.shoulderY + 0.01,
    gap: 0.2,
    wrap,
    placement: { role: wrap, autoAlign: true },
  });
  // COL : bande wrap 'neck'. La pièce papier fait 64 % du tour d'encolure —
  // une bande CÔTELÉE cousue étirée. La sim n'a pas de pré-étirement : on pose
  // la bande à 85 % du tour réel (l'état porté, la recette v116 éprouvée) ;
  // le 64 % à plat reste documenté dans boxyData (collarLen).
  // Bloc COL échangeable : « montant » = bande ~2,4× plus haute (col
  // cheminée qui se tient), « côte » = bande côtelée ras-du-cou, « sans »
  // retire la bande (l'encolure reste une ouverture finie).
  const collarH = collar === 'montant' ? D.collarH * 2.4 : D.collarH;
  // Longueur de bande = 0,85 × tour d'encolure (fronce côtelée). L'encolure
  // en V allonge ce tour : neckRingEff est recalculé plus bas après le V.
  let neckRingEff = D.neckRing;
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
    width: 0.85 * neckRingEff * 0.5,
    height: collarH,
    topY: m.neckY - 0.005,
    gap: 0.15,
    wrap: 'neck',
    placement: { role: 'neck', autoAlign: true },
  });
  // Encolure en V (DEVANT seul) : on remplace l'arc rond (29→37→0) par deux
  // diagonales droites qui plongent au centre. Les points épaule-encolure 0
  // et 29 restent fixes → les coutures d'épaule rejoignent le dos à
  // l'identique ; le dos garde son encolure ronde. La bande côtelée suit le V
  // (elle se plie à la pointe) ; sa longueur est rallongée au périmètre réel du
  // V pour qu'elle fronce sans tirer sur la pointe (« Sans col » = bord fini).
  const V_DEEP = 0.22; // profondeur du V en v-pièce (col rond ≈ 0.105)
  const applyVNeck = (o: UV[]): void => {
    const A = BOXY_IDX.neckR; // 29 (colD)
    const C = BOXY_IDX.center; // 37 (creux)
    const p29 = o[A]!;
    const p0 = o[0]!;
    const cx = 0.5;
    for (let i = A; i <= C; i++) {
      const t = (i - A) / (C - A);
      o[i] = [p29[0] + (cx - p29[0]) * t, p29[1] + (V_DEEP - p29[1]) * t];
    }
    for (let i = C; i <= 44; i++) {
      const t = (i - C) / (45 - C);
      o[i] = [cx + (p0[0] - cx) * t, V_DEEP + (p0[1] - V_DEEP) * t];
    }
  };
  // Périmètre physique (m) de l'arc d'encolure DEVANT (points 29→44→0).
  const frontNeckPerimeter = (o: UV[], w: number, h: number): number => {
    let len = 0;
    let prev: number = BOXY_IDX.neckR;
    for (let i = BOXY_IDX.neckR + 1; i <= 45; i++) {
      const cur = i === 45 ? 0 : i;
      const a = o[prev]!;
      const b = o[cur]!;
      len += Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
      prev = cur;
    }
    return len;
  };
  const frontFace = face(D.front);
  const backFace = face(D.back);
  if (neck === 'v') {
    applyVNeck(frontFace.outline);
    // Le V allonge le tour d'encolure : on rallonge la bande d'autant (delta
    // rond→V) pour qu'elle fronce au lieu de tirer sur la pointe.
    const roundFront = frontNeckPerimeter(D.front.outline, D.front.width, D.front.height);
    const vFront = frontNeckPerimeter(frontFace.outline, frontFace.width, frontFace.height);
    neckRingEff = D.neckRing + (vFront - roundFront);
  }
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN: 64,
    piece: frontFace,
    back: backFace,
    manual: true,
    pieces: [
      ...(sleeves === 'none' ? [] : [sleeve('armR'), sleeve('armL')]),
      ...(collar === 'sans' ? [] : [band()]),
    ],
    // Épaules + côtés sous les emmanchures. Chaque arc reste ouvert et reçoit
    // le panneau correspondant de la manche.
    seams: [
      seam(0, BOXY_IDX.tipL), // épaule G
      seam(BOXY_IDX.tipR, BOXY_IDX.neckR), // épaule D
      seam(BOXY_IDX.uaL, BOXY_IDX.hemL), // côté G sous l'emmanchure
      seam(BOXY_IDX.hemR, BOXY_IDX.uaR), // côté D sous l'emmanchure
    ],
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
