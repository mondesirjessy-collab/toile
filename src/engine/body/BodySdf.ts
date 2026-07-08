/**
 * BodySdf — the sculpted mannequin as a signed distance field.
 *
 * The dress form is a handful of ROUND CONES (capsules whose two ends carry
 * different radii) blended with a smooth minimum: shoulders flow into the
 * chest, the waist tapers into the hips, thighs thin toward the knees — a
 * human silhouette instead of sausage capsules, in ~14 primitives.
 *
 * The same field drives BOTH sides of the engine:
 *  - collisions: collide.wgsl evaluates the identical field on the GPU;
 *  - rendering: SurfaceNets meshes this TS evaluation once per build.
 * Keep the two in sync (same primitives, same smooth-min k).
 */

export type V3 = [number, number, number];

/**
 * Round cone: segment a→b, radius ra at a, rb at b. Sphere when a=b.
 * `s` squashes the shape per axis about the segment midpoint (components in
 * (0,1] — bake any widening into the radii). Real bodies are elliptical:
 * a chest is wider than it is deep.
 */
export interface SdfPrim {
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  s?: V3;
}

/**
 * World-space bounding-sphere radius. An s>1 squash axis grows the world shape
 * (the SDF divides by s), so scale the bound by max(1, s) to stay conservative
 * for any squash — a no-op for current bodies where every s ∈ (0,1] (audit M18).
 */
export function primBoundRadius(p: SdfPrim): number {
  const half =
    Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2;
  const s = p.s ?? [1, 1, 1];
  const sMax = Math.max(1, s[0]!, s[1]!, s[2]!);
  return (half + Math.max(p.ra, p.rb)) * sMax;
}

/** Polynomial smooth minimum (iq). k = 0 degenerates to a hard min. */
export function smin(a: number, b: number, k: number): number {
  if (k < 1e-6) return Math.min(a, b);
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/**
 * Distance to one round cone (iq's formula, with degenerate guards).
 * With `s`, the point is unsquashed about the segment midpoint and the result
 * rescaled by min(s): a conservative ellipsoid distance (exact on-axis).
 */
export function sdRoundCone(px: number, py: number, pz: number, p: SdfPrim): number {
  let sMin = 1;
  if (p.s) {
    const cx = (p.a[0] + p.b[0]) / 2;
    const cy = (p.a[1] + p.b[1]) / 2;
    const cz = (p.a[2] + p.b[2]) / 2;
    px = cx + (px - cx) / p.s[0];
    py = cy + (py - cy) / p.s[1];
    pz = cz + (pz - cz) / p.s[2];
    sMin = Math.min(p.s[0], p.s[1], p.s[2]);
  }
  const bax = p.b[0] - p.a[0];
  const bay = p.b[1] - p.a[1];
  const baz = p.b[2] - p.a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const pax = px - p.a[0];
  const pay = py - p.a[1];
  const paz = pz - p.a[2];
  const rr = p.ra - p.rb;
  const a2 = l2 - rr * rr;
  // Degenerate: zero-length segment, or one end sphere swallowing the other.
  if (l2 < 1e-12 || a2 <= 1e-12) {
    const da = Math.hypot(pax, pay, paz) - p.ra;
    const db = Math.hypot(px - p.b[0], py - p.b[1], pz - p.b[2]) - p.rb;
    return Math.min(da, db) * sMin;
  }
  const il2 = 1 / l2;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xx = pax * l2 - bax * y;
  const xy = pay * l2 - bay * y;
  const xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return (Math.sqrt(x2 + z2) * il2 - p.rb) * sMin;
  if (Math.sign(y) * a2 * y2 < k) return (Math.sqrt(x2 + y2) * il2 - p.ra) * sMin;
  return ((Math.sqrt((x2 * a2) * il2) + y * rr) * il2 - p.ra) * sMin;
}

/** Distance to the whole blended body. */
export function sdBody(px: number, py: number, pz: number, prims: SdfPrim[], k: number): number {
  let d = 1e9;
  for (const p of prims) d = smin(d, sdRoundCone(px, py, pz, p), k);
  return d;
}

/** Field gradient (central differences), for mesh normals. */
export function bodyNormal(px: number, py: number, pz: number, prims: SdfPrim[], k: number): V3 {
  const e = 1e-3;
  const nx = sdBody(px + e, py, pz, prims, k) - sdBody(px - e, py, pz, prims, k);
  const ny = sdBody(px, py + e, pz, prims, k) - sdBody(px, py - e, pz, prims, k);
  const nz = sdBody(px, py, pz + e, prims, k) - sdBody(px, py, pz - e, prims, k);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** AABB of the primitives, padded so the blend never leaks outside. */
export function bodyBounds(prims: SdfPrim[], pad: number): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    for (const [c, r] of [
      [p.a, p.ra],
      [p.b, p.rb],
    ] as [V3, number][]) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, c[i]! - r - pad);
        max[i] = Math.max(max[i]!, c[i]! + r + pad);
      }
    }
  }
  return { min, max };
}

/** Smooth-min blend used by the dress form (meters). */
export const BODY_BLEND = 0.04;

const rc = (a: V3, b: V3, ra: number, rb: number, s?: V3): SdfPrim => ({ a, b, ra, rb, s });

/**
 * Mirror a one-sided primitive list across x (left limbs → both limbs).
 * Primitives already on the centerline (|x| ≈ 0 at both ends) pass through.
 */
function mirrored(prims: SdfPrim[]): SdfPrim[] {
  const out: SdfPrim[] = [];
  for (const p of prims) {
    out.push(p);
    if (Math.abs(p.a[0]) > 1e-6 || Math.abs(p.b[0]) > 1e-6) {
      out.push({
        a: [-p.a[0], p.a[1], p.a[2]],
        b: [-p.b[0], p.b[1], p.b[2]],
        ra: p.ra,
        rb: p.rb,
        s: p.s,
      });
    }
  }
  return out;
}

/**
 * The realistic figure, ~1.75 m. Anatomy in three ingredients the old capsule
 * body lacked: a DEPTH PROFILE in z (chest and bust forward, glutes and calves
 * back — a straight column reads as a bollard, not a person), ELLIPTICAL
 * cross-sections (`s` squash: a torso is wider than deep), and terminal parts
 * (chin, hands, feet). +z is the garment "front" panel side.
 *
 * Fit constraints preserved from the proven capsule form: deltoid shelf
 * spanning the dress-strap ring (±0.20) at y≈1.41; the upper-chest dome wider
 * than the neck-scoop ring (±0.095) at y≈1.45 (the neckline's "hanger");
 * waist ring narrower than hips+glutes (skirts hold); thigh/leg lengths.
 */
export const BODY_FORM: SdfPrim[] = mirrored([
  // — Head: skull dome + jaw wedge down to a chin. Featureless on purpose —
  //   a display-mannequin face reads elegant; a half-realistic one reads eerie.
  rc([0, 1.655, 0.005], [0, 1.655, 0.005], 0.1, 0.1, [0.74, 1, 0.92]),
  rc([0, 1.63, 0.015], [0, 1.575, 0.05], 0.062, 0.026, [0.8, 1, 1]), // jaw → chin
  rc([0, 1.6, -0.005], [0, 1.47, -0.005], 0.044, 0.052, [1, 1, 0.9]), // neck
  // — Shoulder girdle —
  rc([0, 1.475, -0.01], [-0.155, 1.42, -0.005], 0.062, 0.05), // trapezius slope
  rc([-0.14, 1.412, 0], [-0.205, 1.412, 0], 0.058, 0.058, [1, 1, 0.9]), // deltoid shelf
  // — Torso, front-leaning chest to back-leaning seat —
  rc([0, 1.4, 0.005], [0, 1.16, 0], 0.132, 0.142, [1, 1, 0.72]), // ribcage (hanger dome)
  rc([-0.062, 1.275, 0.055], [-0.062, 1.275, 0.055], 0.072, 0.072), // bust
  rc([0, 1.16, 0.012], [0, 1.0, 0.022], 0.115, 0.108, [1, 1, 0.72]), // abdomen, slight belly
  rc([0, 1.0, 0], [0, 0.9, -0.008], 0.14, 0.185, [1, 1, 0.8]), // pelvis flaring to hips
  // (hip span ±0.185 — a real pelvis; also what keeps a skirt waist ring from
  // slipping through: the ring must meet a bulge WIDER than itself below the waist)
  rc([-0.06, 0.9, -0.055], [-0.06, 0.94, -0.05], 0.08, 0.072), // glute
  // — Legs, with knee caps, calf bellies, ankles and FEET —
  rc([-0.085, 0.88, 0.004], [-0.088, 0.5, 0.006], 0.082, 0.057, [1, 1, 0.94]), // thigh
  rc([-0.088, 0.478, 0.012], [-0.088, 0.478, 0.012], 0.051, 0.051), // knee cap
  rc([-0.088, 0.46, -0.004], [-0.089, 0.12, -0.012], 0.048, 0.03), // shank
  rc([-0.089, 0.375, -0.03], [-0.089, 0.375, -0.03], 0.047, 0.047, [0.95, 1, 1]), // calf belly
  rc([-0.089, 0.05, -0.015], [-0.089, 0.042, 0.14], 0.042, 0.026, [1, 0.55, 1]), // foot → toes (0.22 m)
]);

/**
 * Same figure with relaxed A-pose arms at TRUE anatomical length: elbow at
 * ~0.63 of stature, wrist at ~0.49, fingertips reaching mid-thigh — half-length
 * "dress form stubs" read fake the moment the body looks human.
 */
export const BODY_FORM_ARMS: SdfPrim[] = [
  ...BODY_FORM,
  ...mirrored([
    rc([-0.2, 1.415, 0], [-0.27, 1.14, -0.004], 0.046, 0.037), // upper arm → elbow
    rc([-0.272, 1.135, -0.004], [-0.272, 1.135, -0.004], 0.037, 0.037), // elbow
    rc([-0.274, 1.13, 0], [-0.31, 0.9, 0.008], 0.036, 0.024), // forearm → wrist
    rc([-0.312, 0.89, 0.01], [-0.32, 0.77, 0.028], 0.024, 0.012, [0.6, 1, 1]), // hand
  ]),
];

/**
 * The average male figure (~1.76 m, European means): broader shoulders
 * (bideltoid ≈ 0.49), squarer and wider jaw, thicker neck, a flat pectoral
 * plate instead of a bust, a straighter waist with the honest slight belly of
 * an AVERAGE man, narrower pelvis with flatter glutes, heavier arms, bigger
 * hands and feet. Key garment heights (shoulder ≈ 1.41, hips ≈ 0.95) match
 * the female form so every scene's spawn positions still fit.
 */
export const BODY_MALE: SdfPrim[] = mirrored([
  // — Head: larger skull, square jaw, wide chin —
  rc([0, 1.66, 0.005], [0, 1.66, 0.005], 0.104, 0.104, [0.76, 1, 0.94]),
  rc([0, 1.625, 0.01], [0, 1.57, 0.045], 0.072, 0.038, [0.78, 1, 1]), // jaw → chin
  rc([0, 1.6, -0.005], [0, 1.46, -0.005], 0.056, 0.066, [1, 1, 0.92]), // thick neck
  // — Shoulder girdle. Bideltoid ≈ 0.55 m: a bit over the true average (0.49)
  //   on purpose — it must stay broader than the female form (0.53), whose
  //   shoulders are themselves oversized to carry the dress-strap ring.
  rc([0, 1.48, -0.012], [-0.17, 1.425, -0.005], 0.068, 0.055), // trapezius slope
  rc([-0.15, 1.415, 0], [-0.215, 1.415, 0], 0.06, 0.06, [1, 1, 0.9]), // deltoid shelf
  // — Torso: wide ribcage, pec plate, straight waist, slight belly —
  //   The ribcage cap must top out BELOW the chin (1.53) or the neck vanishes.
  rc([0, 1.39, 0.005], [0, 1.15, 0], 0.138, 0.158, [1, 1, 0.72]), // ribcage
  rc([-0.07, 1.31, 0.08], [-0.07, 1.31, 0.08], 0.062, 0.062, [1, 0.9, 0.6]), // pectoral
  rc([0, 1.15, 0.015], [0, 0.98, 0.028], 0.148, 0.138, [1, 1, 0.75]), // abdomen + belly
  rc([0, 0.99, 0], [0, 0.9, -0.005], 0.152, 0.168, [1, 1, 0.76]), // pelvis
  rc([-0.06, 0.92, -0.05], [-0.06, 0.95, -0.045], 0.075, 0.068, [1, 1, 0.92]), // flat glute
  // — Legs, heavier —
  rc([-0.095, 0.88, 0.004], [-0.097, 0.5, 0.006], 0.088, 0.061, [1, 1, 0.94]), // thigh
  rc([-0.097, 0.478, 0.012], [-0.097, 0.478, 0.012], 0.054, 0.054), // knee cap
  rc([-0.097, 0.46, -0.004], [-0.098, 0.12, -0.012], 0.052, 0.033), // shank
  rc([-0.098, 0.375, -0.032], [-0.098, 0.375, -0.032], 0.05, 0.05, [0.95, 1, 1]), // calf belly
  rc([-0.098, 0.052, -0.02], [-0.098, 0.045, 0.16], 0.048, 0.03, [1, 0.55, 1]), // foot → toes (0.26 m)
]);

/** Male figure with relaxed A-pose arms at anatomical length, heavier build. */
export const BODY_MALE_ARMS: SdfPrim[] = [
  ...BODY_MALE,
  ...mirrored([
    rc([-0.225, 1.42, 0], [-0.315, 1.135, -0.004], 0.055, 0.043), // upper arm → elbow
    rc([-0.318, 1.13, -0.004], [-0.318, 1.13, -0.004], 0.043, 0.043), // elbow
    rc([-0.32, 1.125, 0], [-0.36, 0.89, 0.008], 0.042, 0.028), // forearm → wrist
    rc([-0.362, 0.88, 0.01], [-0.372, 0.75, 0.03], 0.028, 0.014, [0.6, 1, 1]), // hand
  ]),
];
