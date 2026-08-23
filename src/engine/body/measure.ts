/**
 * measure — the tailor's tape for any avatar.
 *
 * Every mannequin exposes a signed distance field (analytic prims or a baked
 * scan grid). This module runs a measuring tape over that field: find the
 * neck, the shoulder line, the fullest chest, the narrowest waist, the widest
 * hip, and estimate each circumference from width/depth calipers (Ramanujan's
 * ellipse perimeter). Garments are then cut from RATIOS against the reference
 * body the patterns were designed on — automatic made-to-measure.
 */

export type Sd = (x: number, y: number, z: number) => number;

export interface Level {
  y: number;
  halfW: number; // caliper half-width along x (from the axis outward)
  halfD: number; // caliper half-depth along z (average front/back)
  circ: number; // ellipse-perimeter estimate
}

export interface BodyMeasure {
  height: number;
  neckY: number;
  shoulderY: number;
  shoulderHalfW: number; // includes deltoids (outer caliper)
  chest: Level;
  waist: Level;
  hip: Level;
  thigh: Level; // one leg, mid-thigh
  /** Pose de couture : axe du bras dégagé (hauteur, profondeur, racine) —
   * absent sur un corps bras collés au torse. `path` conserve la vraie courbure du
   * scan par tranches X : réduire le bras à une seule moyenne Y/Z place une
   * partie d'une manche droite à l'intérieur du coude ou de l'avant-bras. */
  arm?: {
    y: number;
    z: number;
    rootX: number;
    path?: { x: number; y: number; z: number }[];
  };
}

/** Distance from the body axis (0,y,0) to the surface along (dx,0,dz). */
function firstExit(sd: Sd, y: number, dx: number, dz: number): number {
  if (sd(0, y, 0) > 0) return 0; // axis point outside the body at this height
  // Linear march, NOT bisection: the ray may re-enter a hanging hand or arm
  // beyond the torso, and bisection would happily converge on its far edge.
  let prev = 0;
  for (let t = 0.004; t < 0.7; t += 0.004) {
    if (sd(t * dx, y, t * dz) > 0) {
      // refine within the last step
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (sd(mid * dx, y, mid * dz) < 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prev = t;
  }
  return 0.7;
}

/** Outermost distance from the axis on one side (arms/deltoids included). */
function outerXSide(sd: Sd, y: number, side: -1 | 1, maxX = 1.0): number {
  // T-pose scans reach ~0.83–0.90 m from the centre. The former 0.65 m ceiling
  // missed the male arm entirely, so no arm axis was measured and its sleeve
  // spawned around z=0 — inside the backward-curving arm collider.
  const zSamples = [0, 0.04, -0.04, 0.08, -0.08, 0.12, -0.12];
  // 2.5 mm per side keeps the full carrure within 5 mm without making the
  // much denser arm-path sampling depend on the same caliper resolution.
  for (let distance = maxX; distance > 0; distance -= 0.0025) {
    if (zSamples.some((z) => sd(side * distance, y, z) < 0)) return distance;
  }
  return 0;
}

/** Historical right-side caliper, retained for tracking the right arm. */
function outerX(sd: Sd, y: number, maxX = 1.0): number {
  return outerXSide(sd, y, 1, maxX);
}

/** Mean half-width from the two independent outer shoulder calipers. */
function bilateralOuterHalfWidth(sd: Sd, y: number, maxX = 1.0): {
  halfWidth: number;
  left: number;
  right: number;
} {
  const right = outerXSide(sd, y, 1, maxX);
  const left = outerXSide(sd, y, -1, maxX);
  return { halfWidth: (left + right) / 2, left, right };
}

/** Ramanujan's ellipse perimeter. */
function ellipse(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const h3 = 3 * (a + b);
  return Math.PI * (h3 - Math.sqrt((h3 - 2 * b) * (h3 - 2 * a) * 1));
}

function level(
  sd: Sd,
  y: number,
  bilateralWidth = false,
  maxWidthDepthRatio = 1.5,
): Level {
  // Depth caliper along z is arm-proof. The straight x caliper is NOT: on
  // scanned bodies the arms hang against the hips and the ray exits at the
  // arm's outer edge. Instead, sample the section at ±45° (rays that pass
  // between torso and arms) and solve the ellipse half-width a from
  // 1/r45² = 0.5/a² + 0.5/b².
  const halfD = (firstExit(sd, y, 0, 1) + firstExit(sd, y, 0, -1)) / 2;
  const s2 = Math.SQRT1_2;
  const r45 =
    (firstExit(sd, y, s2, s2) + firstExit(sd, y, s2, -s2) + firstExit(sd, y, -s2, s2) + firstExit(sd, y, -s2, -s2)) / 4;
  const directHalfW = firstExit(sd, y, 1, 0);
  // Scanned torsos are not guaranteed to be centred perfectly on x=0. At the
  // chest, average both sides so that a few centimetres of scan asymmetry do
  // not become a false size difference. Lower-body levels retain the legacy
  // one-sided caliper because an arm can hang flush against either hip.
  let halfW = bilateralWidth
    ? (directHalfW + firstExit(sd, y, -1, 0)) / 2
    : directHalfW;
  if (halfD > 1e-4 && r45 > 1e-4) {
    const inv = 1 / (r45 * r45) - 0.5 / (halfD * halfD);
    if (inv > 1e-6) {
      const diagonalHalfW = Math.sqrt(0.5 / inv);
      halfW = Math.min(halfW, diagonalHalfW);
    }
  }
  // Anything beyond the expected torso aspect ratio is a hanging arm or elbow
  // the rays could not dodge. Male pectorals need a slightly wider 1.65 guard
  // than the historical 1.5 lower-body guard.
  halfW = Math.min(halfW, maxWidthDepthRatio * halfD);
  return { y, halfW, halfD, circ: ellipse(halfW, halfD) };
}

/**
 * Measure a body whose top of head is near `height`. Feature heights are
 * searched in anthropometric bands (fractions of stature) — robust across
 * sculpted forms and scans alike.
 */
export function measureBody(sd: Sd, height: number): BodyMeasure {
  const H = height;
  const step = 0.01;
  // Some sewing poses reach close to half the stature per side. Once the
  // public stature and shoulder controls enlarge a scan, a fixed 1 m cap can
  // truncate the wrist and make automatic sleeves stop mid-forearm.
  const armSearchMaxX = Math.max(1.0, 0.68 * H);

  // Neck: thinnest outer width between 78% and 93% of stature.
  let neckY = 0.85 * H;
  let neckW = Infinity;
  for (let y = 0.78 * H; y <= 0.93 * H; y += step) {
    const w = outerX(sd, y, armSearchMaxX);
    if (w > 0.01 && w < neckW) {
      neckW = w;
      neckY = y;
    }
  }

  // Shoulder line: widest outer point in the anthropometric shoulder band
  // (77.5% of stature up to the neck) — below that, hanging arms take over.
  // T-POSE (scans re-cuits, bras à l'horizontale) : les bras traversent avec
  // des largeurs d'ENVERGURE (une racine de manche classique reste bien sous
  // 0.165·H par côté) —
  // ces tranches sont sautées ; la ligne d'épaule devient le HAUT de la bande
  // de bras, et la carrure la largeur du torse juste SOUS le bras (la racine
  // de l'épaule, là où la manche naît).
  const FREE_ARM_HALF_SPAN = 0.165 * H;
  let shoulderY = 0.8 * H;
  let shoulderHalfW = 0;
  let shoulderRightW = 0;
  for (let y = 0.79 * H; y <= neckY; y += step) {
    const width = bilateralOuterHalfWidth(sd, y, armSearchMaxX);
    if (Math.max(width.left, width.right) > FREE_ARM_HALF_SPAN) continue; // bras libre : pas une épaule
    if (width.halfWidth > shoulderHalfW) {
      shoulderHalfW = width.halfWidth;
      shoulderRightW = width.right;
      shoulderY = y;
    }
  }
  // Bande du bras horizontal : cherchée PLUS BAS que la bande d'épaule —
  // l'aisselle d'un corps naturel vit vers 0,75·H et l'ancienne bande 0,79·H
  // la ratait. Un corps bras baissés ne produit jamais outerX > 0,19·H ici
  // (le coude collé à la hanche plafonne bien en dessous) : sans bande, pas
  // de T-pose, rien ne change.
  let armBandTop = -1;
  let armBandBot = Infinity;
  for (let y = 0.68 * H; y <= neckY; y += step) {
    const w = outerX(sd, y, armSearchMaxX);
    if (w > FREE_ARM_HALF_SPAN) {
      armBandTop = Math.max(armBandTop, y);
      armBandBot = Math.min(armBandBot, y);
    }
  }
  let arm: BodyMeasure['arm'];
  if (armBandTop > 0) {
    // `armBandTop` is the highest slice crossed by the free arm. In a low
    // A-pose that slice sits around the lower pectoral, not on the anatomical
    // shoulder line. Keep the high-band shoulder landmark found above for
    // chest grading; only the arm tracker must use armBandTop/armBandBot.
    const rootY = Math.max(0.6 * H, armBandBot - 2 * step);
    const rightRoot = outerX(
      sd,
      rootY,
      armSearchMaxX,
    );
    const roots = bilateralOuterHalfWidth(sd, rootY, armSearchMaxX);
    if (
      shoulderHalfW <= 0.05
      && roots.left > 0.05 && roots.right > 0.05
      && Math.max(roots.left, roots.right) <= FREE_ARM_HALF_SPAN
    ) {
      // Fallback only: never replace the true high shoulder caliper with the
      // lower sleeve-root section merely because a free arm was detected.
      shoulderHalfW = roots.halfWidth;
      shoulderRightW = roots.right;
    }
    // The tailoring carrure is bilateral, but the sleeve path below follows
    // the actual right arm. Keeping its own root avoids shifting that path on
    // an asymmetric scan.
    const armRootX = rightRoot > 0.05 && rightRoot <= FREE_ARM_HALF_SPAN
      ? rightRoot
      : shoulderRightW || shoulderHalfW;
    // Axe du bras : centre des cellules solides sur des tranches x au-delà de
    // la racine (droite ; les mannequins sont symétriques).
    let sy = 0;
    let sz = 0;
    let cnt = 0;
    for (let dx = 0.08; dx <= 0.26; dx += 0.06) {
      for (let y = armBandBot - 0.03; y <= armBandTop + 0.03; y += step) {
        for (let z = -0.3; z <= 0.3; z += step) {
          if (sd(armRootX + dx, y, z) < 0) {
            sy += y;
            sz += z;
            cnt++;
          }
        }
      }
    }
    if (cnt > 0) {
      arm = { y: sy / cnt, z: sz / cnt, rootX: armRootX };

      // A T-pose scan is not a straight cylinder: the upper arm, elbow and
      // forearm sweep several centimetres in depth (and a little in height).
      // Sample the solid cross-section beyond the shoulder and retain its
      // centroid. The sleeve compiler interpolates this polyline so every
      // circular row is centred on the actual limb instead of on one global
      // average. Sampling starts outside the torso and stops after the wrist.
      const rawPath: { x: number; y: number; z: number }[] = [];
      let emptySections = 0;
      // 25 mm sampling keeps enough articulation points for a low A-pose;
      // 40 mm can produce only a few points from shoulder to wrist on a slim scan.
      for (let x = armRootX + 0.025; x <= armSearchMaxX; x += 0.025) {
        // Follow a LOW A-pose as a connected branch instead of scanning one
        // fixed horizontal band. Extrapolation keeps the window on the arm as
        // it descends toward the wrist and avoids averaging in the hip/thigh.
        let predictedY = arm.y;
        let predictedZ = arm.z;
        if (rawPath.length === 1) {
          predictedY = rawPath[0]!.y - 0.035;
          predictedZ = rawPath[0]!.z;
        } else if (rawPath.length >= 2) {
          const previous = rawPath[rawPath.length - 2]!;
          const last = rawPath[rawPath.length - 1]!;
          const dx = Math.max(1e-6, last.x - previous.x);
          const advance = (x - last.x) / dx;
          predictedY = last.y + (last.y - previous.y) * advance;
          predictedZ = last.z + (last.z - previous.z) * advance;
        }
        const pathYMin = Math.max(0.42 * H, predictedY - 0.12);
        const pathYMax = Math.min(armBandTop + 0.1, predictedY + 0.12);
        const pathZMin = Math.max(-0.3, predictedZ - 0.16);
        const pathZMax = Math.min(0.3, predictedZ + 0.16);
        let sectionY = 0;
        let sectionZ = 0;
        let sectionCount = 0;
        for (let y = pathYMin; y <= pathYMax; y += 0.006) {
          for (let z = pathZMin; z <= pathZMax; z += 0.006) {
            if (sd(x, y, z) < 0) {
              sectionY += y;
              sectionZ += z;
              sectionCount++;
            }
          }
        }
        if (sectionCount > 0) {
          rawPath.push({
            x,
            y: sectionY / sectionCount,
            z: sectionZ / sectionCount,
          });
          emptySections = 0;
        } else if (rawPath.length > 2 && ++emptySections >= 2) {
          break;
        }
      }

      // A three-point filter removes the millimetric stair-step of the baked
      // SDF without straightening the centimetric anatomical curve.
      if (rawPath.length >= 2) {
        arm.path = rawPath.map((point, index) => {
          if (index === 0 || index === rawPath.length - 1) return point;
          const previous = rawPath[index - 1]!;
          const next = rawPath[index + 1]!;
          return {
            x: point.x,
            y: (previous.y + 2 * point.y + next.y) / 4,
            z: (previous.z + 2 * point.z + next.z) / 4,
          };
        });
      }
    }
  }

  // Chest/bust: fullest caliper circumference below the shoulders — capped
  // at 76% of stature (a bust never sits above that; the shoulder girdle does).
  // The band FLOOR matters as much: the bust line lives at ~0.72 H, and a
  // floor of 0.62 H let the RIBCAGE bulge (≈ 0.66 H, slightly fuller than
  // the bust on the sculpted female form) win the max — the tailor graded
  // tops on the diaphragm and the « poitrine » slider inflated it.
  let chest = level(sd, 0.7 * H, true, 1.65);
  const chestTop = Math.min(shoulderY - 0.04, 0.76 * H);
  for (let y = 0.695 * H; y <= chestTop; y += step) {
    const l = level(sd, y, true, 1.65);
    if (l.circ > chest.circ) chest = l;
  }

  // Waist: narrowest circumference in the mid band.
  let waist = level(sd, 0.6 * H);
  for (let y = 0.54 * H; y <= 0.66 * H; y += step) {
    const l = level(sd, y);
    if (l.circ > 0 && l.circ < waist.circ) waist = l;
  }

  // Hip: fullest circumference below the waist.
  let hip = level(sd, 0.52 * H);
  for (let y = 0.44 * H; y <= waist.y; y += step) {
    const l = level(sd, y);
    if (l.circ > hip.circ) hip = l;
  }

  // Mid-thigh: one leg's circumference (calipers around the leg axis).
  // Measure BELOW THE CROTCH, where the legs are genuinely separate: above
  // it the smin blend fuses both thighs into one solid, the inner caliper
  // ray never exits, and the thigh reads ~28 cm instead of ~43. The crotch
  // is where the mid-plane leaves the body on the way down from the hip.
  let crotchY = hip.y - 0.25;
  for (let y = hip.y; y > hip.y - 0.35; y -= step) {
    if (sd(0, y, 0) > 0.01) {
      crotchY = y;
      break;
    }
  }
  const thighY = Math.max(crotchY - 0.03, hip.y - 0.35);
  const legX = firstExit(sd, thighY, 1, 0) * 0.55 || 0.09; // rough leg-axis offset
  const legHalfW = (() => {
    // caliper around (legX, thighY): march outward both ways along x
    let inner = 0;
    let outer = 0;
    for (let t = 0.002; t < 0.2; t += 0.002) {
      if (!outer && sd(legX + t, thighY, 0) > 0) outer = t;
      if (!inner && sd(legX - t, thighY, 0) > 0) inner = t;
      if (inner && outer) break;
    }
    return (inner + outer) / 2 || 0.06;
  })();
  const legHalfD = (() => {
    let zp = 0;
    let zm = 0;
    for (let t = 0.002; t < 0.2; t += 0.002) {
      if (!zp && sd(legX, thighY, t) > 0) zp = t;
      if (!zm && sd(legX, thighY, -t) > 0) zm = t;
      if (zp && zm) break;
    }
    return (zp + zm) / 2 || legHalfW;
  })();
  const thigh: Level = {
    y: thighY,
    halfW: legHalfW,
    halfD: Math.min(legHalfD, 1.5 * legHalfW),
    circ: ellipse(legHalfW, Math.min(legHalfD, 1.5 * legHalfW)),
  };

  return { height: H, neckY, shoulderY, shoulderHalfW, chest, waist, hip, thigh, arm };
}

/** Trilinear SDF sampler over a baked scan grid (CPU side). */
export function gridSd(grid: {
  dims: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  data: Float32Array;
}): Sd {
  const [nx, ny, nz] = grid.dims;
  const cell = [
    (grid.max[0] - grid.min[0]) / (nx - 1),
    (grid.max[1] - grid.min[1]) / (ny - 1),
    (grid.max[2] - grid.min[2]) / (nz - 1),
  ];
  return (x, y, z) => {
    const gx = (x - grid.min[0]) / cell[0]!;
    const gy = (y - grid.min[1]) / cell[1]!;
    const gz = (z - grid.min[2]) / cell[2]!;
    if (gx < 0 || gy < 0 || gz < 0 || gx > nx - 1 || gy > ny - 1 || gz > nz - 1) return 1; // outside: far
    const i = Math.min(nx - 2, Math.floor(gx));
    const j = Math.min(ny - 2, Math.floor(gy));
    const k = Math.min(nz - 2, Math.floor(gz));
    const fx = gx - i;
    const fy = gy - j;
    const fz = gz - k;
    const at = (ii: number, jj: number, kk: number): number => grid.data[(kk * ny + jj) * nx + ii]!;
    const c00 = at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx;
    const c10 = at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx;
    const c01 = at(i, j, k + 1) * (1 - fx) + at(i + 1, j, k + 1) * fx;
    const c11 = at(i, j + 1, k + 1) * (1 - fx) + at(i + 1, j + 1, k + 1) * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  };
}

/* ------------------------------------------------------------------------- *
 * POINTS D'ARRANGEMENT — le concept Clo, dérivé des mensurations RÉELLES.
 *
 * Des ancres prédéfinies autour du corps mesuré : cliquer une pièce puis une
 * pastille la range à cet endroit de la préparation 3D (translation de
 * staging pure — le patron, les coutures et la pose d'essayage reconstruite
 * ne changent jamais). Les positions sortent du mètre-ruban, pas de
 * constantes : elles suivent la stature, la corpulence et la T-pose du scan.
 * ------------------------------------------------------------------------- */

export interface ArrangementPoint {
  id: string;
  labelFr: string;
  /** Position monde de l'ancre (le corps est centré en x=0/z=0, devant = +z). */
  pos: [number, number, number];
}

/** Dégagement devant/derrière le torse pour qu'une pièce à plat ne spawne pas
 * dans le corps : demi-profondeur mesurée + marge tissu. */
// v252 — degagements PAR ZONE (offset CLO par ancre) : le pre-assemblage pose
// les pieces PLUS PRES du corps qu'un degagement uniforme (0,16 avant), pour
// partir d'une pose serree facon CLO. Corps ~10 cm ; col au ras (~6 cm). Les
// bras gardent leurs offsets propres (enroulement de la manche).
const CLEAR_BODY = 0.1;
const CLEAR_NECK = 0.06;

/** v256 — la PRÉCISION CLO, relevée en direct dans l'éditeur d'avatar de
 * CLO 2026 : un point d'arrangement n'est pas une position posée à la main,
 * c'est une coordonnée (X% autour, Y% le long) SUR LA SURFACE d'un volume
 * d'encadrement — un cylindre elliptique tendu entre deux ancres du squelette
 * (relevés : Arm_L = Left_Hand→Left_Arm, h 600 mm, Ø 160 ; Body_L =
 * Spine→Spine3, h 680, 400×380 ; Arm_Front_1 = X25 Y75 comp50 « en bas » ;
 * Body_Back_1 = X90 Y90). Convention d'angle relevée : X25 = devant,
 * X75 = dos, X50/X0 = côtés. Ici, les volumes se calculent des MENSURATIONS
 * (l'axe du bras est le vrai axe mesuré m.arm.path) et les pastilles sont
 * générées sur leurs surfaces, niveau par niveau — même densité, même
 * précision, et elles suivent morphologie et pose par construction. */
interface ClonePointSpec {
  id: string;
  labelFr: string;
  xPct: number; // autour (25 devant, 75 dos)
  yPct: number; // le long de l'axe (0 bas → 100 haut)
  clearM: number; // compensation 50 CLO = ce dégagement en mètres
}
function volumeSurfacePoints(
  a: [number, number, number],
  b: [number, number, number],
  radiusX: (t: number) => number,
  radiusZ: (t: number) => number,
  specs: readonly ClonePointSpec[],
): ArrangementPoint[] {
  return specs.map((p) => {
    const t = p.yPct / 100;
    const cx = a[0] + (b[0] - a[0]) * t;
    const cy = a[1] + (b[1] - a[1]) * t;
    const cz = a[2] + (b[2] - a[2]) * t;
    const theta = (p.xPct / 100 - 0.25) * Math.PI * 2; // X25 → +Z (devant)
    const dirX = -Math.sin(theta);
    const dirZ = Math.cos(theta);
    const rx = radiusX(t);
    const rz = radiusZ(t);
    // rayon de l'ellipse dans la direction (dirX, dirZ)
    const denom = Math.sqrt((dirX * dirX) / (rx * rx) + (dirZ * dirZ) / (rz * rz));
    const r = denom > 1e-9 ? 1 / denom : rx;
    return {
      id: p.id,
      labelFr: p.labelFr,
      pos: [cx + dirX * (r + p.clearM), cy, cz + dirZ * (r + p.clearM)] as [number, number, number],
    };
  });
}

export function arrangementPoints(m: BodyMeasure): ArrangementPoint[] {
  const torsoY = (m.chest.y + m.waist.y) / 2;
  const frontZ = m.chest.halfD + CLEAR_BODY;
  const hipZ = m.hip.halfD + CLEAR_BODY;
  const sideX = m.shoulderHalfW + CLEAR_BODY + 0.04;
  const neckZ = m.chest.halfD * 0.5 + CLEAR_NECK;
  const chestZ = m.chest.halfD + CLEAR_BODY;
  const waistZ = m.waist.halfD + CLEAR_BODY;
  const shoulderX = m.shoulderHalfW * 0.75;
  const points: ArrangementPoint[] = [
    { id: 'torso-front', labelFr: 'Devant', pos: [0, torsoY, frontZ] },
    { id: 'torso-back', labelFr: 'Dos', pos: [0, torsoY, -frontZ] },
    { id: 'side-right', labelFr: 'Côté droit', pos: [sideX, torsoY, 0] },
    { id: 'side-left', labelFr: 'Côté gauche', pos: [-sideX, torsoY, 0] },
    { id: 'hip-front', labelFr: 'Bassin devant', pos: [0, m.hip.y, hipZ] },
    { id: 'hip-back', labelFr: 'Bassin dos', pos: [0, m.hip.y, -hipZ] },
    {
      id: 'leg-right',
      labelFr: 'Jambe droite',
      pos: [Math.max(0.09, m.hip.halfW * 0.55), m.thigh.y, m.thigh.halfD + CLEAR_BODY],
    },
    {
      id: 'leg-left',
      labelFr: 'Jambe gauche',
      pos: [-Math.max(0.09, m.hip.halfW * 0.55), m.thigh.y, m.thigh.halfD + CLEAR_BODY],
    },
    { id: 'neck-front', labelFr: 'Encolure devant', pos: [0, m.neckY, neckZ] },
    { id: 'neck-back', labelFr: 'Encolure dos', pos: [0, m.neckY, -neckZ] },
    { id: 'shoulder-right', labelFr: 'Epaule droite', pos: [shoulderX, m.shoulderY, 0] },
    { id: 'shoulder-left', labelFr: 'Epaule gauche', pos: [-shoulderX, m.shoulderY, 0] },
    { id: 'chest-front', labelFr: 'Poitrine devant', pos: [0, m.chest.y, chestZ] },
    { id: 'chest-back', labelFr: 'Poitrine dos', pos: [0, m.chest.y, -chestZ] },
    { id: 'waist-front', labelFr: 'Taille devant', pos: [0, m.waist.y, waistZ] },
    { id: 'waist-back', labelFr: 'Taille dos', pos: [0, m.waist.y, -waistZ] },
  ];
  if (m.arm) {
    // Au-dessus de l'axe mesuré du bras (T-pose) : la pièce plane à côté du
    // bras sans traverser son collider.
    const armX = m.arm.rootX + 0.12;
    points.push(
      { id: 'arm-right', labelFr: 'Bras droit', pos: [armX, m.arm.y + 0.15, m.arm.z] },
      { id: 'arm-left', labelFr: 'Bras gauche', pos: [-armX, m.arm.y + 0.15, m.arm.z] },
    );
    const armPath = m.arm.path;
    if (armPath && armPath.length > 1) {
      const wrist = armPath[armPath.length - 1]!;
      const wristX = Math.abs(wrist.x) + 0.06;
      points.push(
        { id: 'forearm-right', labelFr: 'Avant-bras droit', pos: [wristX, wrist.y + 0.12, wrist.z] },
        { id: 'forearm-left', labelFr: 'Avant-bras gauche', pos: [-wristX, wrist.y + 0.12, wrist.z] },
      );
    }
  }
  // ——— v256 : la grille PRÉCISE façon CLO, générée sur les volumes ———
  // TORSE : cylindre elliptique bassin→épaules, rayons interpolés entre les
  // niveaux MESURÉS (bassin, taille, poitrine) — chaque pastille est posée
  // sur la vraie surface du corps + dégagement.
  const torsoA: [number, number, number] = [0, m.hip.y, 0];
  const torsoB: [number, number, number] = [0, m.shoulderY, 0];
  const spanY = Math.max(1e-6, m.shoulderY - m.hip.y);
  const tOfY = (y: number): number => (y - m.hip.y) / spanY;
  const tWaist = tOfY(m.waist.y);
  const tChest = tOfY(m.chest.y);
  const interp3 = (vHip: number, vWaist: number, vChest: number) => (t: number): number => {
    if (t <= tWaist) return vHip + (vWaist - vHip) * (t / Math.max(1e-6, tWaist));
    if (t <= tChest) return vWaist + (vChest - vWaist) * ((t - tWaist) / Math.max(1e-6, tChest - tWaist));
    return vChest; // au-dessus de la poitrine : le buste garde sa section
  };
  const torsoRX = interp3(m.hip.halfW, m.waist.halfW, m.chest.halfW);
  const torsoRZ = interp3(m.hip.halfD, m.waist.halfD, m.chest.halfD);
  const lvl = (name: string, y: number): { yPct: number; label: string } => ({ yPct: tOfY(y) * 100, label: name });
  const torsoLevels = [
    { ...lvl('poitrine', m.chest.y), n: 1 },
    { ...lvl('taille', m.waist.y), n: 2 },
    { ...lvl('bassin', m.hip.y + 0.02), n: 3 },
  ];
  const torsoSpecs: ClonePointSpec[] = [];
  for (const l of torsoLevels) {
    torsoSpecs.push(
      { id: `body-front-${l.n}`, labelFr: `Devant · ${l.label}`, xPct: 25, yPct: l.yPct, clearM: 0.1 },
      { id: `body-back-${l.n}`, labelFr: `Dos · ${l.label}`, xPct: 75, yPct: l.yPct, clearM: 0.1 },
      { id: `body-side-l-${l.n}`, labelFr: `Côté G · ${l.label}`, xPct: 50, yPct: l.yPct, clearM: 0.1 },
      { id: `body-side-r-${l.n}`, labelFr: `Côté D · ${l.label}`, xPct: 0, yPct: l.yPct, clearM: 0.1 },
    );
  }
  points.push(...volumeSurfacePoints(torsoA, torsoB, torsoRX, torsoRZ, torsoSpecs));
  // BRAS : cylindre le long de l'AXE MESURÉ (racine→poignet), rayon ~biceps.
  if (m.arm?.path && m.arm.path.length > 1) {
    const path = m.arm.path;
    const root = path[0]!;
    const wrist = path[path.length - 1]!;
    const ARM_R = 0.055; // rayon bras (pas de mesure biceps dédiée — Ø110 mm)
    for (const side of ['r', 'l'] as const) {
      const sgn = side === 'r' ? 1 : -1;
      const aArm: [number, number, number] = [sgn * Math.abs(wrist.x), wrist.y, wrist.z];
      const bArm: [number, number, number] = [sgn * Math.abs(root.x), root.y, root.z];
      const sideFr = side === 'r' ? 'D' : 'G';
      const specs: ClonePointSpec[] = [];
      for (const [n, yPct] of [[1, 78], [2, 52], [3, 26]] as const) {
        specs.push(
          { id: `arm-${side}-front-${n}`, labelFr: `Bras ${sideFr} · devant ${n}`, xPct: 25, yPct, clearM: 0.03 },
          { id: `arm-${side}-back-${n}`, labelFr: `Bras ${sideFr} · dos ${n}`, xPct: 75, yPct, clearM: 0.03 },
          { id: `arm-${side}-top-${n}`, labelFr: `Bras ${sideFr} · dessus ${n}`, xPct: side === 'r' ? 0 : 50, yPct, clearM: 0.03 },
        );
      }
      // En T-pose l'axe du bras est ~horizontal : le « dessus » du bras est
      // +Y monde, pas une direction de la section XZ — volumeSurfacePoints
      // travaille dans le plan XZ, on corrige le dessus à la main.
      const pts = volumeSurfacePoints(aArm, bArm, () => ARM_R, () => ARM_R, specs);
      for (const p of pts) {
        if (p.id.includes('-top-')) {
          const t = 1 - (parseInt(p.id.slice(-1), 10) - 1) * 0.26 - 0.22;
          p.pos = [
            aArm[0] + (bArm[0] - aArm[0]) * t,
            aArm[1] + (bArm[1] - aArm[1]) * t + ARM_R + 0.03,
            aArm[2] + (bArm[2] - aArm[2]) * t,
          ];
        }
      }
      points.push(...pts);
    }
  }
  // JAMBES : cylindre bassin→genou par jambe, rayon cuisse mesuré.
  {
    const legX = Math.max(0.09, m.hip.halfW * 0.55);
    const kneeY = Math.max(0.05, m.thigh.y - 0.25);
    for (const side of ['r', 'l'] as const) {
      const sgn = side === 'r' ? 1 : -1;
      const aLeg: [number, number, number] = [sgn * legX, kneeY, 0];
      const bLeg: [number, number, number] = [sgn * legX, m.hip.y, 0];
      const sideFr = side === 'r' ? 'D' : 'G';
      points.push(
        ...volumeSurfacePoints(aLeg, bLeg, () => m.thigh.halfW, () => m.thigh.halfD, [
          { id: `leg-${side}-front-1`, labelFr: `Jambe ${sideFr} · devant 1`, xPct: 25, yPct: 70, clearM: 0.06 },
          { id: `leg-${side}-front-2`, labelFr: `Jambe ${sideFr} · devant 2`, xPct: 25, yPct: 30, clearM: 0.06 },
          { id: `leg-${side}-back-1`, labelFr: `Jambe ${sideFr} · dos 1`, xPct: 75, yPct: 70, clearM: 0.06 },
          { id: `leg-${side}-back-2`, labelFr: `Jambe ${sideFr} · dos 2`, xPct: 75, yPct: 30, clearM: 0.06 },
        ]),
      );
    }
  }
  return points;
}
