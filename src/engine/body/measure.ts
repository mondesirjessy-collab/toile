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

/** Outermost |x| of the body at height y (arms/deltoids included). */
function outerX(sd: Sd, y: number): number {
  for (let x = 0.65; x > 0; x -= 0.005) {
    if (sd(x, y, 0) < 0 || sd(x, y, 0.04) < 0 || sd(x, y, -0.04) < 0) return x;
  }
  return 0;
}

/** Ramanujan's ellipse perimeter. */
function ellipse(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const h3 = 3 * (a + b);
  return Math.PI * (h3 - Math.sqrt((h3 - 2 * b) * (h3 - 2 * a) * 1));
}

function level(sd: Sd, y: number): Level {
  // Depth caliper along z is arm-proof. The straight x caliper is NOT: on
  // scanned bodies the arms hang against the hips and the ray exits at the
  // arm's outer edge. Instead, sample the section at ±45° (rays that pass
  // between torso and arms) and solve the ellipse half-width a from
  // 1/r45² = 0.5/a² + 0.5/b².
  const halfD = (firstExit(sd, y, 0, 1) + firstExit(sd, y, 0, -1)) / 2;
  const s2 = Math.SQRT1_2;
  const r45 =
    (firstExit(sd, y, s2, s2) + firstExit(sd, y, s2, -s2) + firstExit(sd, y, -s2, s2) + firstExit(sd, y, -s2, -s2)) / 4;
  let halfW = firstExit(sd, y, 1, 0);
  if (halfD > 1e-4 && r45 > 1e-4) {
    const inv = 1 / (r45 * r45) - 0.5 / (halfD * halfD);
    if (inv > 1e-6) halfW = Math.min(halfW, Math.sqrt(0.5 / inv));
  }
  // A human torso is never wider than ~1.5x its depth — anything beyond is a
  // hanging arm or elbow the rays could not dodge.
  halfW = Math.min(halfW, 1.5 * halfD);
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

  // Neck: thinnest outer width between 78% and 93% of stature.
  let neckY = 0.85 * H;
  let neckW = Infinity;
  for (let y = 0.78 * H; y <= 0.93 * H; y += step) {
    const w = outerX(sd, y);
    if (w > 0.01 && w < neckW) {
      neckW = w;
      neckY = y;
    }
  }

  // Shoulder line: widest outer point in the anthropometric shoulder band
  // (77.5% of stature up to the neck) — below that, hanging arms take over.
  let shoulderY = 0.8 * H;
  let shoulderHalfW = 0;
  for (let y = 0.79 * H; y <= neckY; y += step) {
    const w = outerX(sd, y);
    if (w > shoulderHalfW) {
      shoulderHalfW = w;
      shoulderY = y;
    }
  }

  // Chest/bust: fullest caliper circumference below the shoulders — capped
  // at 76% of stature (a bust never sits above that; the shoulder girdle does).
  // The band FLOOR matters as much: the bust line lives at ~0.72 H, and a
  // floor of 0.62 H let the RIBCAGE bulge (≈ 0.66 H, slightly fuller than
  // the bust on the sculpted female form) win the max — the tailor graded
  // tops on the diaphragm and the « poitrine » slider inflated it.
  let chest = level(sd, 0.7 * H);
  const chestTop = Math.min(shoulderY - 0.04, 0.76 * H);
  for (let y = 0.695 * H; y <= chestTop; y += step) {
    const l = level(sd, y);
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
  const thighY = hip.y - 0.17;
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

  return { height: H, neckY, shoulderY, shoulderHalfW, chest, waist, hip, thigh };
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
