/**
 * cloArrangement — LA grille d'arrangement de CLO, portée à l'identique.
 *
 * Source : les préréglages internes de CLO 2026 décodés depuis le disque
 * (`Adult_Auto_Arrangement_Point.arr` : 109 points ; `…Bounding_Volume.pan` :
 * 19 volumes — voir docs/clo-arrangement-extrait/). Le modèle CLO : chaque
 * point vit SUR LA SURFACE d'un volume d'encadrement (capsule elliptique
 * tendue entre deux articulations), repéré par X (fraction de tour), Y
 * (fraction le long de l'axe) et un offset radial en mm. Les deux seuls
 * offsets non nuls de toute la table CLO : la TAILLE à −40 mm (les ceintures
 * se plaquent) et le COL à +40 mm (CLO tient la bande à 4 cm du cou).
 *
 * Ici, les volumes ne sortent pas d'un squelette mais des MENSURATIONS du
 * corps réellement mesuré (measure.ts) : axes et rayons suivent la
 * morphologie et la pose par construction ; seules les FRACTIONS de la
 * grille (X, Y, offsets) sont celles de CLO, converties dans la convention
 * TOILE (xPct : 25 = devant +Z, 75 = dos, 0 = +X, 50 = −X ;
 * yPct : 0 = bas → 100 = haut ; CLO stocke X/Y centrés ±0.5 —
 * conversion xPct = 25 + X·100, yPct = (Y + 0.5)·100).
 *
 * v258 — les VOLUMES sont exposés (arrangementVolumes) et un point s'évalue
 * par (volume, X, Y, offset) via pointOnVolume : c'est l'API de l'éditeur
 * fin d'arrangement (régler X/Y/offset d'une pièce aux curseurs, façon
 * l'éditeur de propriétés de CLO). Les pastilles ci-dessous sont ces mêmes
 * specs, évaluées.
 *
 * Dimensions absolues CLO (avatar V2, stature 1750 mm) mises à l'échelle de
 * la stature mesurée quand aucune mensuration directe n'existe (cou, tête,
 * poignet, cheville, jupe).
 */

import type { ArrangementPoint, BodyMeasure } from './measure';

/** Un volume d'encadrement façon CLO : capsule elliptique le long d'un axe. */
export interface ArrangementVolume {
  id: string;
  labelFr: string;
  /** Axe bas → haut (yPct 0 → 100). */
  a: [number, number, number];
  b: [number, number, number];
  /** Rayons de la section elliptique en t = yPct/100. */
  rx: (t: number) => number;
  rz: (t: number) => number;
  /** Dégagement radial par défaut (la « Compensation 50 » de CLO). */
  clearBase: number;
}

/** Où un réglage (X autour, Y le long, offset mm) tombe sur un volume.
 * Section : volume VERTICAL (torse, jambe, cou…) → plan XZ monde
 * (xPct 0 = +X, 25 = +Z devant) ; volume COUCHÉ (bras en T-pose) → plan
 * YZ (xPct 0 = +Y dessus, 25 = +Z devant) — la convention v257. */
export function pointOnVolume(
  vol: ArrangementVolume,
  xPct: number,
  yPct: number,
  offsetMm: number,
): [number, number, number] {
  const t = yPct / 100;
  const cx = vol.a[0] + (vol.b[0] - vol.a[0]) * t;
  const cy = vol.a[1] + (vol.b[1] - vol.a[1]) * t;
  const cz = vol.a[2] + (vol.b[2] - vol.a[2]) * t;
  const axis: [number, number, number] = [
    vol.b[0] - vol.a[0],
    vol.b[1] - vol.a[1],
    vol.b[2] - vol.a[2],
  ];
  const axisLen = Math.hypot(...axis) || 1;
  const vertical = Math.abs(axis[1] / axisLen) > 0.7;
  const theta = (xPct / 100 - 0.25) * Math.PI * 2; // X25 → +Z (devant)
  const c1 = -Math.sin(theta); // composante n1 (X monde, ou Y si couché)
  const c2 = Math.cos(theta); // composante n2 (+Z devant)
  const rx = vol.rx(t);
  const rz = vol.rz(t);
  const denom = Math.sqrt((c1 * c1) / (rx * rx) + (c2 * c2) / (rz * rz));
  const r = (denom > 1e-9 ? 1 / denom : rx) + vol.clearBase + offsetMm / 1000;
  return vertical
    ? [cx + c1 * r, cy, cz + c2 * r]
    : [cx, cy + c1 * r, cz + c2 * r];
}

/** La NORMALE radiale du volume au X donné — l'axe du champ « Orientation »
 * de CLO : la pièce arrangée tourne sur elle-même face au corps, autour de
 * cette direction. Même convention de section que pointOnVolume. */
export function volumeRadialAt(vol: ArrangementVolume, xPct: number): [number, number, number] {
  const axis: [number, number, number] = [
    vol.b[0] - vol.a[0],
    vol.b[1] - vol.a[1],
    vol.b[2] - vol.a[2],
  ];
  const axisLen = Math.hypot(...axis) || 1;
  const vertical = Math.abs(axis[1] / axisLen) > 0.7;
  const theta = (xPct / 100 - 0.25) * Math.PI * 2;
  const c1 = -Math.sin(theta);
  const c2 = Math.cos(theta);
  return vertical ? [c1, 0, c2] : [0, c1, c2];
}

/** Les axes du PLAN de la pièce arrangée au X donné — les miroirs CLO
 * (UpDownReverse / LeftRightReverse) sont des rotations de 180° autour de
 * ces axes : haut↔bas autour de `right`, gauche↔droite autour de `up`
 * (un retournement rigide change aussi la face présentée au corps, comme
 * retourner une crêpe — c'est le comportement CLO). `up` = la verticale du
 * volume projetée ⊥ à la normale (volume couché : l'axe du bras). */
export function volumePlaneAxesAt(
  vol: ArrangementVolume,
  xPct: number,
): { up: [number, number, number]; right: [number, number, number] } {
  const n = volumeRadialAt(vol, xPct);
  const axis: [number, number, number] = [
    vol.b[0] - vol.a[0],
    vol.b[1] - vol.a[1],
    vol.b[2] - vol.a[2],
  ];
  const axisLen = Math.hypot(...axis) || 1;
  const vertical = Math.abs(axis[1] / axisLen) > 0.7;
  const u0: [number, number, number] = vertical
    ? [0, 1, 0]
    : [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
  const dot = u0[0] * n[0] + u0[1] * n[1] + u0[2] * n[2];
  let up: [number, number, number] = [u0[0] - dot * n[0], u0[1] - dot * n[1], u0[2] - dot * n[2]];
  const upLen = Math.hypot(...up) || 1;
  up = [up[0] / upLen, up[1] / upLen, up[2] / upLen];
  const right: [number, number, number] = [
    n[1] * up[2] - n[2] * up[1],
    n[2] * up[0] - n[0] * up[2],
    n[0] * up[1] - n[1] * up[0],
  ];
  return { up, right };
}

/** L'INVERSE de pointOnVolume : où une position monde tombe sur un volume
 * (X autour, Y le long, offset radial). L'éditeur s'ouvre sur la position
 * RÉELLE de la pièce — pas de saut au premier geste. */
export function volumeSettingsOf(
  vol: ArrangementVolume,
  pos: readonly [number, number, number],
): { xPct: number; yPct: number; offsetMm: number; outsideMm: number } {
  const axis: [number, number, number] = [
    vol.b[0] - vol.a[0],
    vol.b[1] - vol.a[1],
    vol.b[2] - vol.a[2],
  ];
  const len2 = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
  const rel: [number, number, number] = [pos[0] - vol.a[0], pos[1] - vol.a[1], pos[2] - vol.a[2]];
  const tRaw = len2 > 1e-12
    ? (rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2]) / len2
    : 0.5;
  const t = Math.max(0, Math.min(1, tRaw));
  /** Dépassement axial hors du volume, en mm — départage le choix du volume
   * le plus pertinent (une pièce à hauteur de poitrine n'est pas « sur la
   * jupe » même si la surface évasée de la jupe est plus proche). */
  const outsideMm = Math.max(0, (tRaw < 0 ? -tRaw : tRaw - 1) * Math.sqrt(len2)) * 1000;
  const cx = vol.a[0] + axis[0] * t;
  const cy = vol.a[1] + axis[1] * t;
  const cz = vol.a[2] + axis[2] * t;
  const axisLen = Math.sqrt(len2) || 1;
  const vertical = Math.abs(axis[1] / axisLen) > 0.7;
  // Composantes de section : n1 = X monde (vertical) ou Y (couché), n2 = +Z.
  const d1 = vertical ? pos[0] - cx : pos[1] - cy;
  const d2 = pos[2] - cz;
  const dist = Math.hypot(d1, d2);
  const theta = Math.atan2(-d1, d2); // dir = (−sin θ)·n1 + (cos θ)·n2
  let xPct = (theta / (Math.PI * 2) + 0.25) * 100;
  xPct = ((xPct % 100) + 100) % 100;
  const c1 = -Math.sin(theta);
  const c2 = Math.cos(theta);
  const rx = vol.rx(t);
  const rz = vol.rz(t);
  const denom = Math.sqrt((c1 * c1) / (rx * rx) + (c2 * c2) / (rz * rz));
  const rSurface = denom > 1e-9 ? 1 / denom : rx;
  return {
    xPct: Math.round(xPct),
    yPct: Math.round(t * 100),
    offsetMm: Math.round((dist - rSurface - vol.clearBase) * 1000),
    outsideMm: Math.round(outsideMm),
  };
}

interface VolumePointSpec {
  id: string;
  labelFr: string;
  xPct: number;
  yPct: number;
  offsetMm: number;
}

/** Offset CLO taille : −40 mm (la ceinture se plaque au corps). */
const WAIST_OFFSET_MM = -40;
/** Offset CLO col : +40 mm (la bande tenue à 4 cm du cou). */
const COLLAR_OFFSET_MM = 40;
/** Stature de l'avatar V2 de CLO — l'échelle des dimensions absolues. */
const CLO_STATURE = 1.75;

/** Les volumes d'encadrement, recalés sur le corps mesuré. */
export function arrangementVolumes(m: BodyMeasure): ArrangementVolume[] {
  const scale = m.height / CLO_STATURE;
  const volumes: ArrangementVolume[] = [];

  // TORSE (CLO Body 580×180/150, Spine→Spine3) : bassin→épaules, rayons
  // interpolés entre les niveaux MESURÉS — plus fidèle que le rayon constant.
  {
    const spanY = Math.max(1e-6, m.shoulderY - m.hip.y);
    const tOfY = (y: number): number => (y - m.hip.y) / spanY;
    const tWaist = tOfY(m.waist.y);
    const tChest = tOfY(m.chest.y);
    const interp3 = (vHip: number, vWaist: number, vChest: number) => (t: number): number => {
      if (t <= tWaist) return vHip + (vWaist - vHip) * (t / Math.max(1e-6, tWaist));
      if (t <= tChest)
        return vWaist + (vChest - vWaist) * ((t - tWaist) / Math.max(1e-6, tChest - tWaist));
      return vChest; // au-dessus de la poitrine : le buste garde sa section
    };
    volumes.push({
      id: 'torso',
      labelFr: 'Torse',
      a: [0, m.hip.y, 0],
      b: [0, m.shoulderY, 0],
      rx: interp3(m.hip.halfW, m.waist.halfW, m.chest.halfW),
      rz: interp3(m.hip.halfD, m.waist.halfD, m.chest.halfD),
      clearBase: 0.1,
    });
  }

  // BRAS + POIGNETS (CLO Arm 550×Ø64, Wrist 100×Ø40) — le long de l'axe
  // MESURÉ (racine→poignet). yPct 100 = épaule.
  if (m.arm?.path && m.arm.path.length > 1) {
    const path = m.arm.path;
    const root = path[0]!;
    const wrist = path[path.length - 1]!;
    const ARM_R = 0.055; // rayon bras (pas de mesure biceps dédiée — Ø110 mm)
    const WRIST_R = 0.04 * scale;
    for (const side of ['r', 'l'] as const) {
      const sgn = side === 'r' ? 1 : -1;
      const sideFr = side === 'r' ? 'D' : 'G';
      volumes.push({
        id: `arm-${side}`,
        labelFr: `Bras ${sideFr}`,
        a: [sgn * Math.abs(wrist.x), wrist.y, wrist.z],
        b: [sgn * Math.abs(root.x), root.y, root.z],
        rx: () => ARM_R,
        rz: () => ARM_R,
        clearBase: 0.03,
      });
      volumes.push({
        id: `wrist-${side}`,
        labelFr: `Poignet ${sideFr}`,
        a: [sgn * Math.abs(wrist.x), wrist.y - 0.001, wrist.z],
        b: [sgn * Math.abs(wrist.x), wrist.y + 0.001, wrist.z],
        rx: () => WRIST_R,
        rz: () => WRIST_R,
        clearBase: 0.02,
      });
    }
  }

  // JAMBES + CHEVILLES (CLO Leg 850×110/90 cheville→cuisse, Ankle 200×50/45).
  {
    const legX = Math.max(0.09, m.hip.halfW * 0.55);
    const ankleY = 0.09 * m.height;
    const rxLeg = (t: number): number => 0.05 * scale + (m.thigh.halfW - 0.05 * scale) * t;
    const rzLeg = (t: number): number => 0.045 * scale + (m.thigh.halfD - 0.045 * scale) * t;
    for (const side of ['r', 'l'] as const) {
      const sgn = side === 'r' ? 1 : -1;
      const sideFr = side === 'r' ? 'D' : 'G';
      volumes.push({
        id: `leg-${side}`,
        labelFr: `Jambe ${sideFr}`,
        a: [sgn * legX, ankleY, 0],
        b: [sgn * legX, m.hip.y, 0],
        rx: rxLeg,
        rz: rzLeg,
        clearBase: 0.06,
      });
      volumes.push({
        id: `ankle-${side}`,
        labelFr: `Cheville ${sideFr}`,
        a: [sgn * legX, 0.087 * m.height - 0.001, 0],
        b: [sgn * legX, 0.087 * m.height + 0.001, 0],
        rx: () => 0.05 * scale,
        rz: () => 0.045 * scale,
        clearBase: 0.02,
      });
    }
  }

  // JUPE (le volume DÉDIÉ de CLO : 700×240/140 au bassin) — le cône d'une
  // jupe déborde le corps. Échelle stature, garde-fou morphologique.
  volumes.push({
    id: 'skirt',
    labelFr: 'Jupe',
    a: [0, m.hip.y - 0.4 * m.height, 0],
    b: [0, m.hip.y, 0],
    rx: () => Math.max(0.137 * m.height, m.hip.halfW + 0.05),
    rz: () => Math.max(0.08 * m.height, m.hip.halfD + 0.03),
    clearBase: 0,
  });

  // COU (CLO Neck 52×Ø162 — le rayon inclut le dégagement des cols).
  volumes.push({
    id: 'neck',
    labelFr: 'Cou',
    a: [0, m.neckY - 0.015, 0],
    b: [0, m.neckY + 0.015, 0],
    rx: () => 0.081 * scale,
    rz: () => 0.081 * scale,
    clearBase: 0,
  });

  // TÊTE (CLO Head 216×138/154) — les capuches.
  volumes.push({
    id: 'head',
    labelFr: 'Tête',
    a: [0, m.neckY, 0],
    b: [0, m.height, 0],
    rx: () => 0.0788 * m.height,
    rz: () => 0.0879 * m.height,
    clearBase: 0.03,
  });

  return volumes;
}

/* ------------------------------------------------------------------------- *
 * TABLE RÔLE → RECETTE — le modèle d'assignation de CLO, généralisé.
 *
 * Dans le format Pacx de CLO, chaque pièce porte SA destination : un point
 * d'arrangement (volume + X/Y/offset). Ici, la même idée par RÔLE de pièce :
 * n'importe quel vêtement (openpattern, futur import Pacx…) s'arrange en
 * étiquetant ses pièces, sans code spécifique. Les valeurs de référence
 * sortent de l'export BOM du tee CLO décodé (docs/clo-arrangement-extrait/
 * clo-tee-assemblage.json) : devant/dos au niveau poitrine
 * (Body_Front/Back_Center_3 → Y55), la CEINTURE plaquée à −40 mm
 * (Body_Front_Waist → Y35), la bande d'encolure au DOS du cou (Neck_Back),
 * la manche en HAUT du bras (Arm_Outside_1 remonté à Y87 dans le bloc tee,
 * offset UI 51 = +1 mm).
 * ------------------------------------------------------------------------- */

export interface ArrangeRecipe {
  volume: string;
  xPct: number;
  yPct: number;
  offsetMm: number;
}

export const ROLE_RECIPES: Record<string, ArrangeRecipe> = {
  front: { volume: 'torso', xPct: 25, yPct: 55, offsetMm: 0 },
  back: { volume: 'torso', xPct: 75, yPct: 55, offsetMm: 0 },
  armR: { volume: 'arm-r', xPct: 0, yPct: 87, offsetMm: 1 },
  armL: { volume: 'arm-l', xPct: 0, yPct: 87, offsetMm: 1 },
  neck: { volume: 'neck', xPct: 75, yPct: 50, offsetMm: 0 },
  waist: { volume: 'torso', xPct: 25, yPct: 35, offsetMm: WAIST_OFFSET_MM },
  legR: { volume: 'leg-r', xPct: 25, yPct: 55, offsetMm: 0 },
  legL: { volume: 'leg-l', xPct: 25, yPct: 55, offsetMm: 0 },
  pocket: { volume: 'torso', xPct: 25, yPct: 15, offsetMm: 0 },
};

/** La cible monde du rôle sur CE corps — null si le rôle n'a pas de recette
 * ou si son volume n'existe pas (bras absents sur un corps bras collés). */
export function roleArrangeTarget(
  m: BodyMeasure,
  role: string,
): { pos: [number, number, number]; recipe: ArrangeRecipe } | null {
  const recipe = ROLE_RECIPES[role];
  if (!recipe) return null;
  const vol = arrangementVolumes(m).find((v) => v.id === recipe.volume);
  if (!vol) return null;
  return { pos: pointOnVolume(vol, recipe.xPct, recipe.yPct, recipe.offsetMm), recipe };
}

/** La grille de pastilles : les specs CLO évaluées sur les volumes. yPct 50
 * partout où le volume est une tranche (poignet, cheville, cou). */
export function cloArrangementPoints(m: BodyMeasure): ArrangementPoint[] {
  const volumes = new Map(arrangementVolumes(m).map((v) => [v.id, v] as const));
  const points: ArrangementPoint[] = [];
  const emit = (volId: string, specs: readonly VolumePointSpec[]): void => {
    const vol = volumes.get(volId);
    if (!vol) return;
    for (const p of specs) {
      points.push({
        id: p.id,
        labelFr: p.labelFr,
        pos: pointOnVolume(vol, p.xPct, p.yPct, p.offsetMm),
        spec: { volume: volId, xPct: p.xPct, yPct: p.yPct, offsetMm: p.offsetMm },
      });
    }
  };

  // ——— TORSE : 5 niveaux CLO (Y +0.40/+0.25/+0.05/−0.15/−0.35 → yPct
  // 90/75/55/35/15) × colonnes front/back center+D+G, + side/back-side au
  // niveau 3, + la TAILLE (niveau 4) plaquée à −40 mm.
  {
    const torso: VolumePointSpec[] = [];
    const levels = [90, 75, 55, 35, 15] as const;
    for (const [i, yPct] of levels.entries()) {
      const n = i + 1;
      const waist = n === 4; // le niveau CLO « Waist »
      const off = waist ? WAIST_OFFSET_MM : 0;
      const tag = waist ? 'taille' : `niveau ${n}`;
      torso.push(
        { id: `body-front-center-${n}`, labelFr: `Devant centre · ${tag}`, xPct: 25, yPct, offsetMm: off },
        { id: `body-back-center-${n}`, labelFr: `Dos centre · ${tag}`, xPct: 75, yPct, offsetMm: off },
        { id: `body-front-r-${n}`, labelFr: `Devant D · ${tag}`, xPct: 15, yPct, offsetMm: off },
        { id: `body-front-l-${n}`, labelFr: `Devant G · ${tag}`, xPct: 35, yPct, offsetMm: off },
        { id: `body-back-r-${n}`, labelFr: `Dos D · ${tag}`, xPct: 85, yPct, offsetMm: off },
        { id: `body-back-l-${n}`, labelFr: `Dos G · ${tag}`, xPct: 65, yPct, offsetMm: off },
      );
      if (waist) {
        torso.push(
          { id: 'body-waist-r', labelFr: 'Taille · côté D', xPct: 0, yPct, offsetMm: off },
          { id: 'body-waist-l', labelFr: 'Taille · côté G', xPct: 50, yPct, offsetMm: off },
        );
      }
      if (n === 3) {
        torso.push(
          { id: 'body-side-r', labelFr: 'Côté D', xPct: 5, yPct, offsetMm: 0 },
          { id: 'body-side-l', labelFr: 'Côté G', xPct: 45, yPct, offsetMm: 0 },
          { id: 'body-back-side-r', labelFr: 'Dos côté D', xPct: 95, yPct, offsetMm: 0 },
          { id: 'body-back-side-l', labelFr: 'Dos côté G', xPct: 55, yPct, offsetMm: 0 },
        );
      }
    }
    emit('torso', torso);
  }

  // ——— BRAS : 4 directions × 3 niveaux CLO (Y ±0.25 → 75/50/25, 75 = épaule).
  // Le volume couché met « outside » (deltoïde) à +Y monde — la T-pose.
  for (const side of ['r', 'l'] as const) {
    const sideFr = side === 'r' ? 'D' : 'G';
    const arm: VolumePointSpec[] = [];
    for (const [n, yPct] of [[1, 75], [2, 50], [3, 25]] as const) {
      arm.push(
        { id: `arm-${side}-front-${n}`, labelFr: `Bras ${sideFr} · devant ${n}`, xPct: 25, yPct, offsetMm: 0 },
        { id: `arm-${side}-back-${n}`, labelFr: `Bras ${sideFr} · dos ${n}`, xPct: 75, yPct, offsetMm: 0 },
        { id: `arm-${side}-outside-${n}`, labelFr: `Bras ${sideFr} · dessus ${n}`, xPct: 0, yPct, offsetMm: 0 },
        { id: `arm-${side}-inside-${n}`, labelFr: `Bras ${sideFr} · dessous ${n}`, xPct: 50, yPct, offsetMm: 0 },
      );
    }
    emit(`arm-${side}`, arm);
    emit(`wrist-${side}`, [
      { id: `wrist-${side}-front`, labelFr: `Poignet ${sideFr} · devant`, xPct: 25, yPct: 50, offsetMm: 0 },
      { id: `wrist-${side}-back`, labelFr: `Poignet ${sideFr} · dos`, xPct: 75, yPct: 50, offsetMm: 0 },
      { id: `wrist-${side}-outside`, labelFr: `Poignet ${sideFr} · dessus`, xPct: 0, yPct: 50, offsetMm: 0 },
      { id: `wrist-${side}-inside`, labelFr: `Poignet ${sideFr} · dessous`, xPct: 50, yPct: 50, offsetMm: 0 },
    ]);
  }

  // ——— JAMBES (7 points CLO) + CHEVILLES (4).
  for (const side of ['r', 'l'] as const) {
    const sideFr = side === 'r' ? 'D' : 'G';
    const outPct = side === 'r' ? 0 : 50; // extérieur de la jambe = ±X
    emit(`leg-${side}`, [
      { id: `leg-${side}-front`, labelFr: `Jambe ${sideFr} · devant`, xPct: 25, yPct: 55, offsetMm: 0 },
      { id: `leg-${side}-back`, labelFr: `Jambe ${sideFr} · dos`, xPct: 75, yPct: 55, offsetMm: 0 },
      { id: `leg-${side}-calf-front`, labelFr: `Mollet ${sideFr} · devant`, xPct: 25, yPct: 30, offsetMm: 0 },
      { id: `leg-${side}-calf-back`, labelFr: `Mollet ${sideFr} · dos`, xPct: 75, yPct: 30, offsetMm: 0 },
      { id: `leg-${side}-outside-1`, labelFr: `Jambe ${sideFr} · ext. 1`, xPct: outPct, yPct: 85, offsetMm: 0 },
      { id: `leg-${side}-outside-2`, labelFr: `Jambe ${sideFr} · ext. 2`, xPct: outPct, yPct: 55, offsetMm: 0 },
      { id: `leg-${side}-outside-3`, labelFr: `Jambe ${sideFr} · ext. 3`, xPct: outPct, yPct: 30, offsetMm: 0 },
    ]);
    const inPct = side === 'r' ? 50 : 0;
    emit(`ankle-${side}`, [
      { id: `ankle-${side}-front`, labelFr: `Cheville ${sideFr} · devant`, xPct: 25, yPct: 50, offsetMm: 0 },
      { id: `ankle-${side}-back`, labelFr: `Cheville ${sideFr} · dos`, xPct: 75, yPct: 50, offsetMm: 0 },
      { id: `ankle-${side}-outside`, labelFr: `Cheville ${sideFr} · ext.`, xPct: outPct, yPct: 50, offsetMm: 0 },
      { id: `ankle-${side}-inside`, labelFr: `Cheville ${sideFr} · int.`, xPct: inPct, yPct: 50, offsetMm: 0 },
    ]);
  }

  // ——— JUPE : points CLO à Y+0.30 (yPct 80, près du bassin).
  emit('skirt', [
    { id: 'skirt-front', labelFr: 'Jupe · devant', xPct: 25, yPct: 80, offsetMm: 0 },
    { id: 'skirt-back', labelFr: 'Jupe · dos', xPct: 75, yPct: 80, offsetMm: 0 },
    { id: 'skirt-front-r', labelFr: 'Jupe · devant D', xPct: 15, yPct: 80, offsetMm: 0 },
    { id: 'skirt-front-l', labelFr: 'Jupe · devant G', xPct: 35, yPct: 80, offsetMm: 0 },
    { id: 'skirt-back-r', labelFr: 'Jupe · dos D', xPct: 85, yPct: 80, offsetMm: 0 },
    { id: 'skirt-back-l', labelFr: 'Jupe · dos G', xPct: 65, yPct: 80, offsetMm: 0 },
  ]);

  // ——— COU : LE point signature Neck_Collar (dos, +40 mm) + les côtés.
  emit('neck', [
    { id: 'neck-collar', labelFr: 'Col (dégagé 4 cm)', xPct: 75, yPct: 50, offsetMm: COLLAR_OFFSET_MM },
    { id: 'neck-side-r', labelFr: 'Cou · côté D', xPct: 0, yPct: 50, offsetMm: 0 },
    { id: 'neck-side-l', labelFr: 'Cou · côté G', xPct: 50, yPct: 50, offsetMm: 0 },
  ]);

  // ——— TÊTE : côtés/dos sur le volume ; le CRÂNE (3 points CLO Head_Top)
  // est AU-DESSUS de l'axe — hors paramétrage de surface, posé directement.
  emit('head', [
    { id: 'head-r', labelFr: 'Tête · côté D', xPct: 0, yPct: 50, offsetMm: 0 },
    { id: 'head-l', labelFr: 'Tête · côté G', xPct: 50, yPct: 50, offsetMm: 0 },
    { id: 'head-back', labelFr: 'Tête · dos', xPct: 75, yPct: 50, offsetMm: 0 },
  ]);
  {
    const rz = 0.0879 * m.height;
    const topY = m.height + 0.03;
    points.push(
      { id: 'head-top-front', labelFr: 'Crâne · devant', pos: [0, topY, 0.35 * rz] },
      { id: 'head-top-center', labelFr: 'Crâne · centre', pos: [0, topY, 0] },
      { id: 'head-top-back', labelFr: 'Crâne · dos', pos: [0, topY, -0.35 * rz] },
    );
  }

  return points;
}
