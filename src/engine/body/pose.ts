/**
 * pose — articulated animation for the sculpted bodies.
 *
 * The round cones ARE the skeleton: posing = rigidly transforming a subset of
 * primitives (each arm swings as a pendulum about its shoulder pivot). The
 * same transforms drive both sides of the engine: the solver gets the posed
 * primitives as live colliders, and the renderer skins the surface-nets mesh
 * with them (linear blend skinning, weights from the rest-pose distances).
 */
import { sdRoundCone, type SdfPrim, type V3 } from './BodySdf';

/** Rigid transform: 3×3 rotation (row-major) + translation. */
export interface PrimXf {
  r: [number, number, number, number, number, number, number, number, number];
  t: V3;
}

export const ID_XF: PrimXf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** Rotation about the X axis through pivot p, angle φ (arm swing fwd/back). */
function swingX(pivot: V3, phi: number): PrimXf {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // r = Rx(φ); t = pivot − r·pivot
  const r: PrimXf['r'] = [1, 0, 0, 0, c, -s, 0, s, c];
  const t: V3 = [
    pivot[0] - (r[0] * pivot[0] + r[1] * pivot[1] + r[2] * pivot[2]),
    pivot[1] - (r[3] * pivot[0] + r[4] * pivot[1] + r[5] * pivot[2]),
    pivot[2] - (r[6] * pivot[0] + r[7] * pivot[1] + r[8] * pivot[2]),
  ];
  return { r, t };
}

export function applyXf(xf: PrimXf, p: V3): V3 {
  return [
    xf.r[0] * p[0] + xf.r[1] * p[1] + xf.r[2] * p[2] + xf.t[0],
    xf.r[3] * p[0] + xf.r[4] * p[1] + xf.r[5] * p[2] + xf.t[1],
    xf.r[6] * p[0] + xf.r[7] * p[1] + xf.r[8] * p[2] + xf.t[2],
  ];
}

/**
 * Idle pose at time t for an ARMS body: the last 8 primitives are the arms
 * (4 mirrored pairs: upper L/R, elbow L/R, forearm L/R, hand L/R — see
 * BODY_FORM_ARMS / BODY_MALE_ARMS). Each whole arm swings about its shoulder
 * pivot like a slow pendulum, left in counter-phase with right.
 * Returns { prims (posed copies), xfs (one transform per prim, for skinning) }.
 */
export function poseIdle(base: SdfPrim[], t: number): { prims: SdfPrim[]; xfs: PrimXf[] } {
  const n = base.length;
  const armCount = 8;
  const first = n - armCount;
  const phi = 0.32 * Math.sin(t * 1.6); // ±18°, slow stroll rhythm
  // Shoulder pivots = the 'a' end of each upper-arm prim (first mirrored pair).
  const upperL = base[first]!;
  const upperR = base[first + 1]!;
  const xfL = swingX(upperL.a, phi);
  const xfR = swingX(upperR.a, -phi);

  const xfs: PrimXf[] = new Array(n);
  const prims: SdfPrim[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i < first) {
      xfs[i] = ID_XF;
      prims[i] = base[i]!;
      continue;
    }
    // mirrored() interleaves left/right: even offsets are left, odd right.
    const xf = (i - first) % 2 === 0 ? xfL : xfR;
    xfs[i] = xf;
    const p = base[i]!;
    prims[i] = { a: applyXf(xf, p.a), b: applyXf(xf, p.b), ra: p.ra, rb: p.rb, s: p.s };
  }
  return { prims, xfs };
}

/** Per-vertex skinning weights against the rest-pose primitives. */
export interface Skin {
  /** 3 prim indices + 3 weights per vertex. */
  idx: Uint16Array;
  w: Float32Array;
}

export function buildSkin(prims: SdfPrim[], positions: Float32Array): Skin {
  const vcount = positions.length / 3;
  const idx = new Uint16Array(vcount * 3);
  const w = new Float32Array(vcount * 3);
  for (let v = 0; v < vcount; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    // Three nearest primitives by rest distance.
    let i0 = 0, i1 = 0, i2 = 0;
    let d0 = Infinity, d1 = Infinity, d2 = Infinity;
    for (let i = 0; i < prims.length; i++) {
      const d = Math.max(1e-3, sdRoundCone(x, y, z, prims[i]!) + 0.02);
      if (d < d0) { d2 = d1; i2 = i1; d1 = d0; i1 = i0; d0 = d; i0 = i; }
      else if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; }
      else if (d < d2) { d2 = d; i2 = i; }
    }
    const w0 = 1 / (d0 * d0);
    const w1 = 1 / (d1 * d1);
    const w2 = 1 / (d2 * d2);
    const sum = w0 + w1 + w2;
    idx[v * 3] = i0;
    idx[v * 3 + 1] = i1;
    idx[v * 3 + 2] = i2;
    w[v * 3] = w0 / sum;
    w[v * 3 + 1] = w1 / sum;
    w[v * 3 + 2] = w2 / sum;
  }
  return { idx, w };
}

/**
 * Linear blend skinning of interleaved scene vertices (pos3, normal3, color3).
 * `rest` holds the rest-pose interleaved data; `out` receives the posed copy.
 */
export function applySkin(skin: Skin, xfs: PrimXf[], rest: Float32Array, out: Float32Array): void {
  const vcount = skin.idx.length / 3;
  for (let v = 0; v < vcount; v++) {
    const o = v * 9;
    const px = rest[o]!, py = rest[o + 1]!, pz = rest[o + 2]!;
    const nx = rest[o + 3]!, ny = rest[o + 4]!, nz = rest[o + 5]!;
    let X = 0, Y = 0, Z = 0, NX = 0, NY = 0, NZ = 0;
    for (let k = 0; k < 3; k++) {
      const xf = xfs[skin.idx[v * 3 + k]!]!;
      const wk = skin.w[v * 3 + k]!;
      if (wk === 0) continue;
      const r = xf.r;
      X += wk * (r[0] * px + r[1] * py + r[2] * pz + xf.t[0]);
      Y += wk * (r[3] * px + r[4] * py + r[5] * pz + xf.t[1]);
      Z += wk * (r[6] * px + r[7] * py + r[8] * pz + xf.t[2]);
      NX += wk * (r[0] * nx + r[1] * ny + r[2] * nz);
      NY += wk * (r[3] * nx + r[4] * ny + r[5] * nz);
      NZ += wk * (r[6] * nx + r[7] * ny + r[8] * nz);
    }
    const nl = Math.hypot(NX, NY, NZ) || 1;
    out[o] = X;
    out[o + 1] = Y;
    out[o + 2] = Z;
    out[o + 3] = NX / nl;
    out[o + 4] = NY / nl;
    out[o + 5] = NZ / nl;
    // colors (6..8) already present in `out` (copied once from rest)
  }
}
