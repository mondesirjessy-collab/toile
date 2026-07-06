import { describe, it, expect } from 'vitest';
import {
  generateClothGrid,
  generateSeamedPanels,
  combineClothMeshes,
} from '../src/engine/cloth/ClothMesh';

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

  it('counts structural and shear edges, bending now lives in dihedral hinges', () => {
    const structural = 2 * n * (n - 1); // horizontal + vertical
    const shear = 2 * (n - 1) * (n - 1); // both diagonals per cell
    expect(mesh.structuralCount).toBe(structural);
    expect(mesh.shearCount).toBe(shear);
    expect(mesh.bendingCount).toBe(0); // replaced by true dihedral hinges
    expect(mesh.constraintCount).toBe(structural + shear);
    expect(mesh.constraintData.byteLength).toBe(mesh.constraintCount * 16);
    // One hinge per interior grid edge, both directions.
    expect(mesh.quadCount).toBe(2 * (n - 1) * (n - 2));
    expect(mesh.quadData.byteLength).toBe(mesh.quadCount * 32);
  });

  it('keeps hinge colors vertex-disjoint (4 particles each)', () => {
    const dv = new DataView(mesh.quadData);
    expect(mesh.quadColorCounts.reduce((a, b) => a + b, 0)).toBe(mesh.quadCount);
    for (let c = 0; c < mesh.quadColorOffsets.length; c++) {
      const start = mesh.quadColorOffsets[c]!;
      const end = start + mesh.quadColorCounts[c]!;
      const seen = new Set<number>();
      for (let k = start; k < end; k++) {
        for (let f = 0; f < 4; f++) {
          const p = dv.getUint32(k * 32 + f * 4, true);
          expect(seen.has(p)).toBe(false);
          seen.add(p);
          expect(p).toBeLessThan(mesh.count);
        }
        // Flat rest pose → rest angle π.
        expect(dv.getFloat32(k * 32 + 16, true)).toBeCloseTo(Math.PI, 4);
      }
    }
  });

  it('classifies rest lengths as structural or shear', () => {
    const edges = decodeConstraints(mesh.constraintData, mesh.constraintCount);
    const diag = spacing * Math.SQRT2;
    let structural = 0;
    let shear = 0;
    for (const e of edges) {
      if (Math.abs(e.rest - spacing) < 1e-5) structural++;
      else if (Math.abs(e.rest - diag) < 1e-5) shear++;
      else throw new Error(`unexpected rest length ${e.rest}`);
      expect(e.i).toBeGreaterThanOrEqual(0);
      expect(e.i).toBeLessThan(mesh.count);
      expect(e.j).toBeLessThan(mesh.count);
      expect(e.i).not.toBe(e.j);
    }
    expect(structural).toBe(2 * n * (n - 1));
    expect(shear).toBe(2 * (n - 1) * (n - 1));
  });

  it('tags each constraint with the kind matching its rest length', () => {
    const edges = decodeConstraints(mesh.constraintData, mesh.constraintCount);
    const diag = spacing * Math.SQRT2;
    const byKind = [0, 0, 0];
    for (const e of edges) {
      let expectedKind: number;
      if (Math.abs(e.rest - spacing) < 1e-5) expectedKind = 0; // structural
      else expectedKind = 1; // shear
      expect(e.kind, `rest ${e.rest} should be kind ${expectedKind}`).toBe(expectedKind);
      if (expectedKind === 1) expect(Math.abs(e.rest - diag)).toBeLessThan(1e-5);
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
      // Rest length is a fraction of the fabric spacing (sewn = touching),
      // not the initial gap.
      expect(dv.getFloat32(k * 16 + 8, true)).toBeCloseTo((width / (n - 1)) * 0.15, 5);
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

describe("generateSeamedPanels shape 'setin' (set-in sleeves)", () => {
  const n = 32;
  const mesh = generateSeamedPanels({
    resolution: n,
    width: 1.3,
    height: 0.75,
    gap: 0.9,
    topY: 1.52,
    shape: 'setin',
  });
  const kept = (i: number): boolean => mesh.invMasses[i] === 1;

  it('lays out three islands on sleeve rows (sleeve, body, sleeve)', () => {
    const v = Math.floor(0.2 * (n - 1));
    let runs = 0;
    let run = 0;
    for (let u = 0; u <= n; u++) {
      const k = u < n && kept(v * n + u);
      if (k) run++;
      else if (run > 0) {
        runs++;
        run = 0;
      }
    }
    expect(runs).toBe(3);
  });

  it('grades the sleeve length via shapeParams.sleeve', () => {
    const short = generateSeamedPanels({
      resolution: n,
      width: 1.3,
      height: 0.75,
      gap: 0.9,
      topY: 1.52,
      shape: 'setin',
      shapeParams: { sleeve: 0.35 },
    });
    const keptCount = (m: typeof mesh): number => [...m.invMasses].filter((w) => w === 1).length;
    expect(keptCount(short)).toBeLessThan(keptCount(mesh)); // shorter sleeves → less fabric
    // Still three islands on a sleeve row.
    const v = Math.floor(0.2 * (n - 1));
    let runs = 0;
    let run = 0;
    for (let u = 0; u <= n; u++) {
      const k = u < n && short.invMasses[v * n + u] === 1;
      if (k) run++;
      else if (run > 0) {
        runs++;
        run = 0;
      }
    }
    expect(runs).toBe(3);
  });

  it('stitches armholes island-to-island: same-panel seams between different columns', () => {
    const dv = new DataView(mesh.constraintData);
    const panelSize = n * n;
    let armholeSeams = 0;
    for (let k = 0; k < mesh.constraintCount; k++) {
      if (dv.getUint32(k * 16 + 12, true) !== 3) continue; // Seam kind
      const i = dv.getUint32(k * 16, true);
      const j = dv.getUint32(k * 16 + 4, true);
      expect(kept(i)).toBe(true);
      expect(kept(j)).toBe(true);
      if (Math.floor(i / panelSize) === Math.floor(j / panelSize)) {
        // Same panel → must be an armhole seam: same row, different columns.
        const li = i % panelSize;
        const lj = j % panelSize;
        expect(Math.floor(li / n)).toBe(Math.floor(lj / n));
        expect(li % n).not.toBe(lj % n);
        armholeSeams++;
      }
    }
    expect(armholeSeams).toBeGreaterThan(0); // both sleeves, every band row
  });
});

describe('combineClothMeshes (outfits)', () => {
  const n = 16;
  const tee = generateSeamedPanels({ resolution: n, width: 1.15, height: 0.75, gap: 0.9, topY: 1.52, shape: 'tshirt' });
  const skirt = generateSeamedPanels({ resolution: n, width: 1.0, height: 0.55, gap: 0.75, topY: 1.0, shape: 'skirt' });
  const outfit = combineClothMeshes(tee, skirt);

  it('sums particles, constraints and triangles with offset indices', () => {
    expect(outfit.count).toBe(tee.count + skirt.count);
    expect(outfit.constraintCount).toBe(tee.constraintCount + skirt.constraintCount);
    expect(outfit.triangleIndices.length).toBe(tee.triangleIndices.length + skirt.triangleIndices.length);
    expect(outfit.seamCount).toBe(tee.seamCount + skirt.seamCount);
    // Skirt triangles all point past the tee block.
    for (let t = tee.triangleIndices.length; t < outfit.triangleIndices.length; t++) {
      expect(outfit.triangleIndices[t]).toBeGreaterThanOrEqual(tee.count);
    }
  });

  it('re-colors the union: every color block stays vertex-disjoint', () => {
    const dv = new DataView(outfit.constraintData);
    expect(outfit.colorCounts.reduce((a, b) => a + b, 0)).toBe(outfit.constraintCount);
    for (let c = 0; c < outfit.colorOffsets.length; c++) {
      const start = outfit.colorOffsets[c]!;
      const end = start + outfit.colorCounts[c]!;
      const seen = new Set<number>();
      for (let k = start; k < end; k++) {
        const i = dv.getUint32(k * 16, true);
        const j = dv.getUint32(k * 16 + 4, true);
        expect(seen.has(i)).toBe(false);
        expect(seen.has(j)).toBe(false);
        seen.add(i);
        seen.add(j);
        expect(i).toBeLessThan(outfit.count);
        expect(j).toBeLessThan(outfit.count);
      }
    }
  });

  it('rejects mismatched resolutions', () => {
    const other = generateSeamedPanels({ resolution: 8, shape: 'skirt' });
    expect(() => combineClothMeshes(tee, other)).toThrow();
  });
});

describe('sideHalfWidth (patron libre)', () => {
  it('interpolates the drafted silhouette between stations', async () => {
    const { sideHalfWidth } = await import('../src/engine/cloth/ClothMesh');
    const profile = [0.2, 0.3, 0.1, 0.1, 0.4, 0.5];
    expect(sideHalfWidth(0, { profile })).toBeCloseTo(0.2);
    expect(sideHalfWidth(1, { profile })).toBeCloseTo(0.5);
    expect(sideHalfWidth(0.1, { profile })).toBeCloseTo(0.25); // mi-chemin station 0-1
    expect(sideHalfWidth(0.4, { profile })).toBeCloseTo(0.1);
    // Sans profil : la pente linéaire historique.
    expect(sideHalfWidth(0.5, { hem: 0.41 })).toBeCloseTo(0.31);
  });
});
