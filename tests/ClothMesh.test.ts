import { describe, it, expect } from 'vitest';
import { generateClothGrid, generateSeamedPanels } from '../src/engine/cloth/ClothMesh';

/**
 * Topology + rest-pose tests for the CPU cloth generator (brief §2, §3.3):
 * particle count, structural vs shear edge counts, rest lengths, pinning via
 * inverse mass, and that the packed constraint buffer is still vertex-disjoint
 * per color (the property the GPU solver depends on).
 */

interface DecodedEdge {
  i: number;
  j: number;
  rest: number;
  kind: number; // 0 structural, 1 shear, 2 bending
}

function decodeConstraints(data: ArrayBuffer, count: number): DecodedEdge[] {
  const dv = new DataView(data);
  const out: DecodedEdge[] = [];
  for (let k = 0; k < count; k++) {
    out.push({
      i: dv.getUint32(k * 16, true),
      j: dv.getUint32(k * 16 + 4, true),
      rest: dv.getFloat32(k * 16 + 8, true),
      kind: dv.getUint32(k * 16 + 12, true),
    });
  }
  return out;
}

describe('generateClothGrid topology', () => {
  const n = 8;
  const size = 1.0;
  const spacing = size / (n - 1);
  const mesh = generateClothGrid({ resolution: n, size, topY: 1.8, pin: 'corners' });

  it('has resolution² particles', () => {
    expect(mesh.count).toBe(n * n);
    expect(mesh.positions.length).toBe(n * n * 4);
    expect(mesh.invMasses.length).toBe(n * n);
  });

  it('counts structural, shear, and bending edges correctly', () => {
    const structural = 2 * n * (n - 1); // horizontal + vertical
    const shear = 2 * (n - 1) * (n - 1); // both diagonals per cell
    const bending = 2 * n * (n - 2); // skip-2 in each axis
    expect(mesh.structuralCount).toBe(structural);
    expect(mesh.shearCount).toBe(shear);
    expect(mesh.bendingCount).toBe(bending);
    expect(mesh.constraintCount).toBe(structural + shear + bending);
    expect(mesh.constraintData.byteLength).toBe(mesh.constraintCount * 16);
  });

  it('classifies rest lengths as structural, shear, or bending (skip-2)', () => {
    const edges = decodeConstraints(mesh.constraintData, mesh.constraintCount);
    const diag = spacing * Math.SQRT2;
    const skip2 = spacing * 2;
    let structural = 0;
    let shear = 0;
    let bending = 0;
    for (const e of edges) {
      if (Math.abs(e.rest - spacing) < 1e-5) structural++;
      else if (Math.abs(e.rest - diag) < 1e-5) shear++;
      else if (Math.abs(e.rest - skip2) < 1e-5) bending++;
      else throw new Error(`unexpected rest length ${e.rest}`);
      expect(e.i).toBeGreaterThanOrEqual(0);
      expect(e.i).toBeLessThan(mesh.count);
      expect(e.j).toBeLessThan(mesh.count);
      expect(e.i).not.toBe(e.j);
    }
    expect(structural).toBe(2 * n * (n - 1));
    expect(shear).toBe(2 * (n - 1) * (n - 1));
    expect(bending).toBe(2 * n * (n - 2));
  });

  it('tags each constraint with the kind matching its rest length', () => {
    const edges = decodeConstraints(mesh.constraintData, mesh.constraintCount);
    const diag = spacing * Math.SQRT2;
    const skip2 = spacing * 2;
    const byKind = [0, 0, 0];
    for (const e of edges) {
      let expectedKind: number;
      if (Math.abs(e.rest - spacing) < 1e-5) expectedKind = 0; // structural
      else if (Math.abs(e.rest - diag) < 1e-5) expectedKind = 1; // shear
      else expectedKind = 2; // bending (skip-2)
      expect(e.kind, `rest ${e.rest} should be kind ${expectedKind}`).toBe(expectedKind);
      if (expectedKind === 2) expect(Math.abs(e.rest - skip2)).toBeLessThan(1e-5);
      byKind[e.kind]!++;
    }
    expect(byKind[0]).toBe(mesh.structuralCount);
    expect(byKind[1]).toBe(mesh.shearCount);
    expect(byKind[2]).toBe(mesh.bendingCount);
  });

  it('emits two triangles per cell with in-range indices', () => {
    expect(mesh.triangleIndices.length).toBe((n - 1) * (n - 1) * 6);
    for (const idx of mesh.triangleIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(mesh.count);
    }
    // Every triangle is non-degenerate (three distinct vertices).
    for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
      const a = mesh.triangleIndices[t]!;
      const b = mesh.triangleIndices[t + 1]!;
      const c = mesh.triangleIndices[t + 2]!;
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    }
  });

  it('lays particles flat in the horizontal plane at topY', () => {
    for (let i = 0; i < mesh.count; i++) {
      expect(mesh.positions[i * 4 + 1]).toBeCloseTo(1.8, 6); // constant y
      expect(Math.abs(mesh.positions[i * 4 + 0]!)).toBeLessThanOrEqual(size / 2 + 1e-6);
      expect(Math.abs(mesh.positions[i * 4 + 2]!)).toBeLessThanOrEqual(size / 2 + 1e-6);
    }
  });

  it('color blocks sum to the constraint count and stay vertex-disjoint', () => {
    const edges = decodeConstraints(mesh.constraintData, mesh.constraintCount);
    expect(mesh.colorCounts.reduce((a, b) => a + b, 0)).toBe(mesh.constraintCount);

    for (let c = 0; c < mesh.colorOffsets.length; c++) {
      const start = mesh.colorOffsets[c]!;
      const end = start + mesh.colorCounts[c]!;
      const seen = new Set<number>();
      for (let k = start; k < end; k++) {
        const e = edges[k]!;
        expect(seen.has(e.i), `color ${c} reuses particle ${e.i}`).toBe(false);
        expect(seen.has(e.j), `color ${c} reuses particle ${e.j}`).toBe(false);
        seen.add(e.i);
        seen.add(e.j);
      }
    }
  });
});

describe('generateClothGrid pinning', () => {
  const n = 8;

  it("pins the two corners of the anchored edge with 'corners'", () => {
    const mesh = generateClothGrid({ resolution: n, pin: 'corners' });
    const zeros = [...mesh.invMasses].filter((w) => w === 0);
    expect(zeros.length).toBe(2);
    expect(mesh.invMasses[0]).toBe(0); // (u=0, v=0)
    expect(mesh.invMasses[n - 1]).toBe(0); // (u=n-1, v=0)
    // Interior/other particles are free.
    expect(mesh.invMasses[n]).toBe(1); // (u=0, v=1)
  });

  it("pins the whole anchored edge with 'edge'", () => {
    const mesh = generateClothGrid({ resolution: n, pin: 'edge' });
    const zeros = [...mesh.invMasses].filter((w) => w === 0);
    expect(zeros.length).toBe(n); // full v=0 row
    for (let u = 0; u < n; u++) expect(mesh.invMasses[u]).toBe(0);
  });

  it("leaves every particle free with 'none'", () => {
    const mesh = generateClothGrid({ resolution: n, pin: 'none' });
    expect([...mesh.invMasses].every((w) => w === 1)).toBe(true);
  });
});

describe('generateSeamedPanels (phase 1)', () => {
  const n = 8;
  const width = 1.2;
  const gap = 1.3;
  const mesh = generateSeamedPanels({ resolution: n, width, height: 1.2, gap, topY: 1.9 });

  it('has two panels of resolution² particles, facing across the gap', () => {
    expect(mesh.count).toBe(2 * n * n);
    // Panel 0 at z=+gap/2, panel 1 at z=-gap/2.
    expect(mesh.positions[0 * 4 + 2]).toBeCloseTo(gap / 2, 6);
    expect(mesh.positions[(n * n) * 4 + 2]).toBeCloseTo(-gap / 2, 6);
    expect([...mesh.invMasses].every((w) => w === 1)).toBe(true);
  });

  it('counts in-panel constraints as twice the single-sheet counts, plus 2n seams', () => {
    const single = generateClothGrid({ resolution: n, pin: 'none' });
    expect(mesh.structuralCount).toBe(2 * single.structuralCount);
    expect(mesh.shearCount).toBe(2 * single.shearCount);
    expect(mesh.bendingCount).toBe(2 * single.bendingCount);
    expect(mesh.seamCount).toBe(2 * n); // both side edges, one seam per row
    expect(mesh.constraintCount).toBe(
      mesh.structuralCount + mesh.shearCount + mesh.bendingCount + mesh.seamCount,
    );
  });

  it('seams (kind 3) connect matching edge rows across the two panels', () => {
    const dv = new DataView(mesh.constraintData);
    const panelSize = n * n;
    let seams = 0;
    for (let k = 0; k < mesh.constraintCount; k++) {
      const kind = dv.getUint32(k * 16 + 12, true);
      if (kind !== 3) continue;
      seams++;
      const i = dv.getUint32(k * 16, true);
      const j = dv.getUint32(k * 16 + 4, true);
      // One endpoint per panel…
      expect(i < panelSize).toBe(true);
      expect(j >= panelSize).toBe(true);
      // …same (u,v) cell on each side, and u on a side edge.
      const li = i % panelSize;
      const lj = (j - panelSize) % panelSize;
      expect(li).toBe(lj);
      const u = li % n;
      expect(u === 0 || u === n - 1).toBe(true);
      // Rest length is the fabric spacing, not the initial gap.
      expect(dv.getFloat32(k * 16 + 8, true)).toBeCloseTo(width / (n - 1), 5);
    }
    expect(seams).toBe(mesh.seamCount);
  });

  it('keeps the coloring vertex-disjoint with seams included', () => {
    const dv = new DataView(mesh.constraintData);
    for (let c = 0; c < mesh.colorOffsets.length; c++) {
      const start = mesh.colorOffsets[c]!;
      const end = start + mesh.colorCounts[c]!;
      const seen = new Set<number>();
      for (let k = start; k < end; k++) {
        const i = dv.getUint32(k * 16, true);
        const j = dv.getUint32(k * 16 + 4, true);
        expect(seen.has(i)).toBe(false);
        expect(seen.has(j)).toBe(false);
        seen.add(i);
        seen.add(j);
      }
    }
  });

  it('emits triangles for both panels', () => {
    expect(mesh.triangleIndices.length).toBe(2 * (n - 1) * (n - 1) * 6);
    for (const idx of mesh.triangleIndices) expect(idx).toBeLessThan(mesh.count);
  });
});

describe("generateSeamedPanels shape 'aline' (pattern cutting)", () => {
  const n = 16;
  const mesh = generateSeamedPanels({
    resolution: n,
    width: 1.1,
    height: 1.6,
    gap: 1.1,
    topY: 1.78,
    shape: 'aline',
  });
  const kept = (i: number): boolean => mesh.invMasses[i] === 1;

  it('cuts particles outside the pattern (parked, immovable, out of scene)', () => {
    const cut = [...mesh.invMasses].filter((w) => w === 0).length;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(mesh.count); // and plenty of fabric remains
    for (let i = 0; i < mesh.count; i++) {
      if (!kept(i)) expect(mesh.positions[i * 4 + 1]).toBe(-10); // parked below
    }
  });

  it('is narrower at the top than at the hem (A-line) with a neckline scoop', () => {
    const rowKept = (v: number): number => {
      let c = 0;
      for (let u = 0; u < n; u++) if (kept(v * n + u)) c++;
      return c;
    };
    expect(rowKept(n - 1)).toBeGreaterThan(rowKept(2)); // flare
    // Top row splits into two straps: kept particles but a gap in the middle.
    let topRun = 0;
    let runs = 0;
    for (let u = 0; u <= n; u++) {
      const k = u < n && kept(u);
      if (k) topRun++;
      else if (topRun > 0) {
        runs++;
        topRun = 0;
      }
    }
    expect(runs).toBe(2);
  });

  it('references only kept particles from constraints and triangles', () => {
    const dv = new DataView(mesh.constraintData);
    for (let k = 0; k < mesh.constraintCount; k++) {
      expect(kept(dv.getUint32(k * 16, true))).toBe(true);
      expect(kept(dv.getUint32(k * 16 + 4, true))).toBe(true);
    }
    for (const idx of mesh.triangleIndices) expect(kept(idx)).toBe(true);
  });

  it('anchors the P-pin corners on kept particles', () => {
    expect(kept(mesh.cornerIndices[0])).toBe(true);
    expect(kept(mesh.cornerIndices[1])).toBe(true);
  });
});

describe("generateSeamedPanels shape 'tshirt' (kimono tee)", () => {
  const n = 25;
  const mesh = generateSeamedPanels({
    resolution: n,
    width: 1.15,
    height: 0.75,
    gap: 0.9,
    topY: 1.52,
    shape: 'tshirt',
  });
  const kept = (i: number): boolean => mesh.invMasses[i] === 1;
  const rowKept = (v: number): number => {
    let c = 0;
    for (let u = 0; u < n; u++) if (kept(v * n + u)) c++;
    return c;
  };

  it('is a T: sleeve band full width, body narrower below the underarm', () => {
    const sleeveRow = Math.floor(0.28 * (n - 1)); // inside the angled sleeve band
    const bodyRow = Math.floor(0.75 * (n - 1)); // below the underarm
    expect(rowKept(sleeveRow)).toBe(n); // full width
    expect(rowKept(bodyRow)).toBeGreaterThan(0);
    expect(rowKept(bodyRow)).toBeLessThan(rowKept(sleeveRow) * 0.6);
  });

  it('has a neck scoop splitting the top row in two', () => {
    let runs = 0;
    let run = 0;
    for (let u = 0; u <= n; u++) {
      const k = u < n && kept(u);
      if (k) run++;
      else if (run > 0) {
        runs++;
        run = 0;
      }
    }
    expect(runs).toBe(2);
  });

  it('references only kept particles from constraints and triangles', () => {
    const dv = new DataView(mesh.constraintData);
    for (let k = 0; k < mesh.constraintCount; k++) {
      expect(kept(dv.getUint32(k * 16, true))).toBe(true);
      expect(kept(dv.getUint32(k * 16 + 4, true))).toBe(true);
    }
    for (const idx of mesh.triangleIndices) expect(kept(idx)).toBe(true);
  });
});
