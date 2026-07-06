import { describe, expect, it } from 'vitest';
import {
  BODY_BLEND,
  BODY_FORM,
  BODY_FORM_ARMS,
  bodyBounds,
  bodyNormal,
  sdBody,
  sdRoundCone,
  smin,
  type SdfPrim,
} from '../src/engine/body/BodySdf';
import { surfaceNets } from '../src/app/SurfaceNets';

const sphere: SdfPrim = { a: [1, 2, 3], b: [1, 2, 3], ra: 0.5, rb: 0.5 };
const capsule: SdfPrim = { a: [0, 0, 0], b: [0, 1, 0], ra: 0.2, rb: 0.2 };
const cone: SdfPrim = { a: [0, 0, 0], b: [0, 1, 0], ra: 0.3, rb: 0.1 };

describe('sdRoundCone', () => {
  it('is an exact sphere distance in the degenerate case', () => {
    expect(sdRoundCone(1, 2, 5, sphere)).toBeCloseTo(1.5); // 2 away − 0.5
    expect(sdRoundCone(1, 2, 3, sphere)).toBeCloseTo(-0.5); // center
  });

  it('matches the capsule distance when both radii are equal', () => {
    expect(sdRoundCone(0.5, 0.5, 0, capsule)).toBeCloseTo(0.3); // side, mid-height
    expect(sdRoundCone(0, 1.5, 0, capsule)).toBeCloseTo(0.3); // above the b cap
  });

  it('hits both end radii of a round cone exactly', () => {
    expect(sdRoundCone(0, -0.4, 0, cone)).toBeCloseTo(0.1); // below a: 0.4 − 0.3
    expect(sdRoundCone(0, 1.3, 0, cone)).toBeCloseTo(0.2); // above b: 0.3 − 0.1
  });

  it('is deeply inside ON the axis of a round cone (regression: k uses x2, not l2)', () => {
    // Tangent-line radius halfway up = (ra + rb) / 2 = 0.2.
    expect(sdRoundCone(0, 0.5, 0, cone)).toBeCloseTo(-0.2);
    // The neck of the dress form must be solid on its axis.
    const neck: SdfPrim = { a: [0, 1.565, 0], b: [0, 1.44, 0], ra: 0.047, rb: 0.058 };
    expect(sdRoundCone(0, 1.5, 0, neck)).toBeLessThan(-0.045);
  });

  it('slants the side of a round cone (radius interpolates along the axis)', () => {
    // Halfway up, the cone surface sits between the two radii (tangent line).
    const d = sdRoundCone(0.5, 0.5, 0, cone);
    expect(d).toBeGreaterThan(0.5 - 0.3);
    expect(d).toBeLessThan(0.5 - 0.1);
  });
});

describe('smin', () => {
  it('never exceeds the hard min and blends within k', () => {
    expect(smin(0.3, 0.7, 0)).toBe(0.3);
    expect(smin(0.3, 0.7, 0.05)).toBeCloseTo(0.3); // outside the blend band
    const blended = smin(0.3, 0.31, 0.05);
    expect(blended).toBeLessThan(0.3); // inside the band: pulls tighter
    expect(blended).toBeGreaterThan(0.3 - 0.05);
  });
});

describe('ellipsoid squash', () => {
  const squashed: SdfPrim = { a: [1, 1, 1], b: [1, 1, 1], ra: 0.5, rb: 0.5, s: [1, 1, 0.5] };

  it('is exact along the squashed axis', () => {
    // Ellipsoid half-depth 0.25: surface at z = 1.25.
    expect(sdRoundCone(1, 1, 1.3, squashed)).toBeCloseTo(0.05);
    expect(sdRoundCone(1, 1, 1, squashed)).toBeCloseTo(-0.25);
  });

  it('stays conservative (never overestimates) off-axis', () => {
    // True distance on the unsquashed axis is 0.1; the estimate may be smaller.
    const d = sdRoundCone(1.6, 1, 1, squashed);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe('body field', () => {
  it('has a unit gradient away from the surface', () => {
    const n = bodyNormal(0.5, 1.2, 0.4, BODY_FORM, BODY_BLEND);
    expect(Math.hypot(...n)).toBeCloseTo(1, 3);
  });

  it('is inside at the chest and outside past the shoulders', () => {
    expect(sdBody(0, 1.25, 0, BODY_FORM, BODY_BLEND)).toBeLessThan(0);
    expect(sdBody(0.6, 1.4, 0, BODY_FORM, BODY_BLEND)).toBeGreaterThan(0);
  });

  it('keeps the waist ring tighter than the hip bulge (skirts must not slip)', () => {
    // Radial surface distance at waist vs hip height: hip must stick out more.
    const waistR = -sdBody(0, 1.05, 0, BODY_FORM, BODY_BLEND);
    const hipR = -sdBody(0, 0.93, 0, BODY_FORM, BODY_BLEND);
    expect(hipR).toBeGreaterThan(waistR);
  });

  it('bounds contain every primitive plus padding', () => {
    const { min, max } = bodyBounds(BODY_FORM_ARMS, 0.05);
    expect(min[0]).toBeLessThan(-0.39);
    expect(max[0]).toBeGreaterThan(0.39);
    expect(min[1]).toBeLessThan(0.08);
    expect(max[1]).toBeGreaterThan(1.7);
  });
});

describe('surfaceNets', () => {
  const prim: SdfPrim = { a: [0, 0, 0], b: [0, 0, 0], ra: 0.4, rb: 0.4 };
  const mesh = surfaceNets(
    (x, y, z) => sdRoundCone(x, y, z, prim),
    (x, y, z) => {
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    },
    [-0.6, -0.6, -0.6],
    [0.6, 0.6, 0.6],
    0.05,
  );

  it('meshes a sphere with vertices on the surface', () => {
    expect(mesh.positions.length).toBeGreaterThan(300);
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const r = Math.hypot(mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!);
      expect(r).toBeGreaterThan(0.34);
      expect(r).toBeLessThan(0.46);
    }
  });

  it('is a closed manifold: every edge is shared by exactly two triangles', () => {
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!;
        const b = tri[(e + 1) % 3]!;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const count of edges.values()) expect(count).toBe(2);
  });

  it('winds triangles outward (normal agrees with the field gradient)', () => {
    let outward = 0;
    let total = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [ia, ib, ic] = [mesh.indices[t]! * 3, mesh.indices[t + 1]! * 3, mesh.indices[t + 2]! * 3];
      const ax = mesh.positions[ia]!, ay = mesh.positions[ia + 1]!, az = mesh.positions[ia + 2]!;
      const bx = mesh.positions[ib]!, by = mesh.positions[ib + 1]!, bz = mesh.positions[ib + 2]!;
      const cx = mesh.positions[ic]!, cy = mesh.positions[ic + 1]!, cz = mesh.positions[ic + 2]!;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      // For a sphere at the origin, outward = same side as the position.
      if (nx * ax + ny * ay + nz * az > 0) outward++;
      total++;
    }
    expect(outward).toBe(total);
  });
});
