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

/** Round cone: segment a→b, radius ra at a, rb at b. Sphere when a=b. */
export interface SdfPrim {
  a: V3;
  b: V3;
  ra: number;
  rb: number;
}

/** Polynomial smooth minimum (iq). k = 0 degenerates to a hard min. */
export function smin(a: number, b: number, k: number): number {
  if (k < 1e-6) return Math.min(a, b);
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Exact distance to one round cone (iq's formula, with degenerate guards). */
export function sdRoundCone(px: number, py: number, pz: number, p: SdfPrim): number {
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
    return Math.min(da, db);
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
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.ra;
  return (Math.sqrt((x2 * a2) * il2) + y * rr) * il2 - p.ra;
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
export const BODY_BLEND = 0.045;

const rc = (a: V3, b: V3, ra: number, rb: number): SdfPrim => ({ a, b, ra, rb });

/**
 * The sculpted dress form. Same key measurements as the old capsule mannequin
 * (shoulder span, bust, waist ring smaller than the hip bulge, leg length) so
 * every existing pattern still fits — but with a continuous, human silhouette.
 */
export const BODY_FORM: SdfPrim[] = [
  rc([0, 1.63, 0], [0, 1.63, 0], 0.105, 0.105), // head
  rc([0, 1.565, 0], [0, 1.45, 0], 0.047, 0.062), // neck, flaring to the trapezius
  rc([0, 1.452, 0], [-0.155, 1.408, 0], 0.066, 0.056), // left trapezius slope
  rc([0, 1.452, 0], [0.155, 1.408, 0], 0.066, 0.056), // right trapezius slope
  // Deltoid shelves: a level runway under the strap zone (the dress neck ring
  // spans ±0.20), rounding off past ±0.21 — same hold as the proven capsule
  // shoulder bar, but only its outer third so the trapezius slope stays.
  rc([-0.14, 1.405, 0], [-0.21, 1.405, 0], 0.062, 0.062),
  rc([0.14, 1.405, 0], [0.21, 1.405, 0], 0.062, 0.062),
  rc([0, 1.375, 0], [0, 1.21, 0], 0.125, 0.146), // chest into the bust — the top
  // dome doubles as the "hanger" the dress neckline rests on (its cross-section
  // at y≈1.45 must stay wider than the neck-scoop ring, or straps slide off)
  rc([0, 1.21, 0], [0, 1.055, 0], 0.146, 0.112), // bust tapering to the waist
  rc([0, 1.055, 0], [0, 0.935, 0], 0.112, 0.147), // waist flaring to the hips
  rc([-0.048, 0.92, 0], [0.048, 0.92, 0], 0.143, 0.143), // pelvis width
  rc([-0.082, 0.9, 0], [-0.086, 0.46, 0], 0.077, 0.056), // left thigh → knee
  rc([0.082, 0.9, 0], [0.086, 0.46, 0], 0.077, 0.056), // right thigh → knee
  rc([-0.086, 0.46, 0], [-0.086, 0.08, 0], 0.052, 0.043), // left calf → ankle
  rc([0.086, 0.46, 0], [0.086, 0.08, 0], 0.052, 0.043), // right calf → ankle
];

/** Same form with A-pose arms, angled to match the kimono sleeve slope. */
export const BODY_FORM_ARMS: SdfPrim[] = [
  ...BODY_FORM,
  rc([-0.195, 1.405, 0], [-0.3, 1.335, 0], 0.056, 0.047), // left upper arm
  rc([0.195, 1.405, 0], [0.3, 1.335, 0], 0.056, 0.047), // right upper arm
  rc([-0.3, 1.335, 0], [-0.39, 1.27, 0], 0.045, 0.038), // left forearm
  rc([0.3, 1.335, 0], [0.39, 1.27, 0], 0.045, 0.038), // right forearm
];
