import { describe, it, expect } from 'vitest';
import {
  generateClothGrid,
  generateSeamedPanels,
  combineClothMeshes,
  type ClothMeshData,
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
    const byKind = [0, 0, 0, 0, 0];
    for (const e of edges) {
      if (Math.abs(e.rest - spacing) < 1e-5) {
        // Anisotropie : trame (0, horizontale) ou chaîne (4, verticale).
        expect([0, 4], `rest ${e.rest} devrait être trame ou chaîne`).toContain(e.kind);
      } else {
        expect(e.kind, `rest ${e.rest} devrait être du biais`).toBe(1);
        expect(Math.abs(e.rest - diag)).toBeLessThan(1e-5);
      }
      byKind[e.kind]!++;
    }
    // La grille carrée porte autant de trame que de chaîne.
    expect(byKind[0]).toBe(n * (n - 1));
    expect(byKind[4]).toBe(n * (n - 1));
    expect(byKind[0]! + byKind[4]!).toBe(mesh.structuralCount);
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

  it('carries per-axis rest lengths (anisotropic grids)', () => {
    // tee: 1.15 × 0.75 over the same n×n — the two axes differ by 53 %.
    expect(tee.spacing).toBeCloseTo(1.15 / (n - 1));
    expect(tee.spacingV).toBeCloseTo(0.75 / (n - 1));
    expect(outfit.spacing).toBeCloseTo(Math.max(tee.spacing, skirt.spacing));
    expect(outfit.spacingV).toBeCloseTo(Math.max(tee.spacingV, skirt.spacingV));
  });

  it('assigns garment b to the requested layer (dressing order)', () => {
    const layered = combineClothMeshes(tee, skirt, [], 1);
    expect(layered.layers).toHaveLength(layered.count);
    for (let i = 0; i < tee.count; i++) expect(layered.layers![i]).toBe(0);
    for (let i = tee.count; i < layered.count; i++) expect(layered.layers![i]).toBe(1);
    // Sewn combinations default to a single surface: everyone on layer 0.
    for (const l of outfit.layers!) expect(l).toBe(0);
    // Stacking stacks: a third garment over an already-layered outfit.
    const third = combineClothMeshes(layered, skirt, [], 2);
    expect(third.layers![third.count - 1]).toBe(2);
    expect(third.layers![tee.count]).toBe(1);
  });

  it('flags cross-seamed rows as self-collision-exempt', () => {
    // Sew the tee's bottom row to the skirt's top row (front panels).
    const cross = Array.from({ length: n }, (_, u) => ({
      i: (n - 1) * n + u,
      j: tee.count + u,
    }));
    const sewn = combineClothMeshes(tee, skirt, cross);
    expect(sewn.seamFree).toHaveLength(sewn.count);
    for (const cs of cross) {
      expect(sewn.seamFree![cs.i]).toBe(1); // seam endpoints…
      expect(sewn.seamFree![cs.i - n]).toBe(1); // …and one row inward
      expect(sewn.seamFree![cs.j]).toBe(1);
      expect(sewn.seamFree![cs.j + n]).toBe(1);
    }
    // Far from the seam, nothing is exempt.
    expect(sewn.seamFree![0]).toBe(0);
    expect(sewn.seamFree![sewn.count - 1]).toBe(0);
    // An unsewn outfit exempts nobody.
    expect([...outfit.seamFree!].every((v) => v === 0)).toBe(true);
  });

  it('carries hinge softness through the merge (pressing survives)', () => {
    const soft = (mesh: ClothMeshData): number[] => {
      const dv = new DataView(mesh.quadData);
      const out: number[] = [];
      for (let k = 0; k < mesh.quadCount; k++) out.push(dv.getFloat32(k * 32 + 20, true));
      return out;
    };
    const merged = soft(outfit).sort();
    const source = soft(tee).concat(soft(skirt)).sort();
    expect(merged).toEqual(source);
    expect(Math.min(...merged)).toBeGreaterThanOrEqual(1); // never the 0 that an old merge wrote
  });
});

describe('set-in sleeve cap (embu)', () => {
  const n = 64;
  const mesh = generateSeamedPanels({ resolution: n, width: 1.3, height: 0.75, gap: 0.9, topY: 1.52, shape: 'setin' });

  // Walk row by row like the armhole seam does: the left sleeve's inner end
  // (last kept column of the first run) and the body's left edge (first kept
  // column of the middle run). Their polyline lengths are the two sewn edges.
  const edges = (): { cap: number; armhole: number; rows: number } => {
    const P = (u: number, v: number): [number, number] => [mesh.positions[(v * n + u) * 4]!, mesh.positions[(v * n + u) * 4 + 1]!];
    const kept = (u: number, v: number): boolean => mesh.invMasses[v * n + u] !== undefined && mesh.positions[(v * n + u) * 4 + 1]! > -5;
    let cap = 0;
    let armhole = 0;
    let rows = 0;
    let prevCap: [number, number] | null = null;
    let prevArm: [number, number] | null = null;
    for (let v = 0; v < n; v++) {
      const runs: Array<[number, number]> = [];
      let start = -1;
      for (let u = 0; u <= n; u++) {
        const k = u < n && kept(u, v);
        if (k && start < 0) start = u;
        else if (!k && start >= 0) {
          runs.push([start, u - 1]);
          start = -1;
        }
      }
      if (runs.length < 3) {
        prevCap = prevArm = null;
        continue;
      }
      const capPt = P(runs[0]![1], v); // left sleeve inner end (the cap curve)
      const armPt = P(runs[1]![0], v); // body's left edge (the armhole)
      if (prevCap && prevArm) {
        cap += Math.hypot(capPt[0] - prevCap[0], capPt[1] - prevCap[1]);
        armhole += Math.hypot(armPt[0] - prevArm[0], armPt[1] - prevArm[1]);
        rows++;
      }
      prevCap = capPt;
      prevArm = armPt;
    }
    return { cap, armhole, rows };
  };

  it('cuts a curved cap whose edge is a few percent longer than the armhole', () => {
    const { cap, armhole, rows } = edges();
    expect(rows).toBeGreaterThan(10); // the sleeve band spans a real stretch
    const ease = cap / armhole;
    // Tailor's embu: enough to round the shoulder, not enough to gather.
    expect(ease).toBeGreaterThan(1.02);
    expect(ease).toBeLessThan(1.12);
  });

  it('keeps a cutting gap between the cap curve and the body edge', () => {
    // The closest approach of the sleeve island to the body island must stay
    // at least one full cell, or the pieces would fuse at cutting time.
    const P = (u: number, v: number): number => mesh.positions[(v * n + u) * 4]!;
    for (let v = 0; v < n; v++) {
      const runs: Array<[number, number]> = [];
      let start = -1;
      for (let u = 0; u <= n; u++) {
        const k = u < n && mesh.positions[(v * n + u) * 4 + 1]! > -5;
        if (k && start < 0) start = u;
        else if (!k && start >= 0) {
          runs.push([start, u - 1]);
          start = -1;
        }
      }
      if (runs.length < 3) continue;
      expect(runs[1]![0] - runs[0]![1]).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('sideHalfWidth (patron libre)', () => {
  it('interpolates the drafted silhouette between stations', async () => {
    const { sideHalfWidth } = await import('../src/engine/cloth/ClothMesh');
    const profile = [0.2, 0.3, 0.1, 0.1, 0.4, 0.5];
    // La courbe passe EXACTEMENT par chaque station dessinée.
    profile.forEach((w, k) => expect(sideHalfWidth(k / 5, { profile })).toBeCloseTo(w));
    // Entre deux stations : lissée, monotone, jamais de débordement.
    const mid01 = sideHalfWidth(0.1, { profile });
    expect(mid01).toBeGreaterThan(0.2);
    expect(mid01).toBeLessThan(0.3);
    for (let v = 0.2; v < 0.4; v += 0.02) {
      const w = sideHalfWidth(v, { profile });
      expect(w).toBeGreaterThanOrEqual(0.1 - 1e-9); // pas de creux sous la taille pincée
      expect(w).toBeLessThanOrEqual(0.3 + 1e-9);
    }
    // Segment plat entre deux stations égales : reste plat (pas d'ondulation).
    expect(sideHalfWidth(0.5, { profile })).toBeCloseTo(0.1);
    // Sans profil : la pente linéaire historique.
    expect(sideHalfWidth(0.5, { hem: 0.41 })).toBeCloseTo(0.31);
  });
});

describe('profils dessinés — jupe et chemise', () => {
  const n = 64;
  it('la jupe suit sa silhouette libre', () => {
    const m = generateSeamedPanels({
      resolution: n,
      width: 0.85,
      height: 0.6,
      gap: 0.75,
      topY: 1.14,
      shape: 'skirt',
      shapeParams: { profile: [0.2, 0.45, 0.2, 0.45] },
    });
    const kept = (u: number, v: number): boolean => m.invMasses[Math.round(v * (n - 1)) * n + Math.round(u * (n - 1))]! > 0;
    expect(kept(0.5 + 0.4, 1 / 3)).toBe(true); // large à la station évasée
    expect(kept(0.5 + 0.3, 2 / 3)).toBe(false); // étroit à la station pincée
  });

  it('le corps de chemise reste à 0.22 dans la zone emmanchure, libre en dessous', () => {
    const m = generateSeamedPanels({
      resolution: n,
      width: 1.3,
      height: 0.75,
      gap: 0.9,
      topY: 1.52,
      shape: 'setin',
      shapeParams: { sleeve: 0.47, profile: [0.22, 0.14, 0.14, 0.14] },
    });
    const kept = (u: number, v: number): boolean => m.invMasses[Math.round(v * (n - 1)) * n + Math.round(u * (n - 1))]! > 0;
    expect(kept(0.5 + 0.21, 0.2)).toBe(true); // emmanchure intacte
    expect(kept(0.5 + 0.2, 0.9)).toBe(false); // taille resserrée dessinée
    expect(kept(0.5 + 0.12, 0.9)).toBe(true);
  });
});

describe('couture v1 — repassage et élastique', () => {
  const n = 64;
  it('pose des charnières de repassage trans-couture à angle 0', () => {
    const m = generateSeamedPanels({ resolution: n, width: 0.85, height: 0.6, gap: 0.75, topY: 1.14, shape: 'skirt' });
    // quadData : 4×u32 + f32 restAngle (stride 32). Compter les charnières
    // dont l'angle de repos est exactement 0 ET qui relient les deux panneaux.
    const dv = new DataView(m.quadData);
    const panelSize = n * n;
    let press = 0;
    for (let k = 0; k < m.quadCount; k++) {
      const w0 = dv.getUint32(k * 32 + 8, true);
      const w1 = dv.getUint32(k * 32 + 12, true);
      const angle = dv.getFloat32(k * 32 + 16, true);
      const cross = Math.floor(w0 / panelSize) !== Math.floor(w1 / panelSize);
      if (cross && Math.abs(angle - Math.PI) < 1e-5) press++;
    }
    expect(press).toBeGreaterThan(50); // les deux coutures latérales en sont couvertes
  });

  it("réduit la longueur de repos du tissage en zone élastiquée", () => {
    const plain = generateSeamedPanels({ resolution: n, width: 0.85, height: 0.6, gap: 0.75, topY: 1.14, shape: 'skirt' });
    const elast = generateSeamedPanels({ resolution: n, width: 0.85, height: 0.6, gap: 0.75, topY: 1.14, shape: 'skirt', elasticTop: 0.75 });
    const sumTopRest = (m: typeof plain): number => {
      const dv = new DataView(m.constraintData);
      let sum = 0;
      for (let k = 0; k < m.constraintCount; k++) {
        if (dv.getUint32(k * 16 + 12, true) !== 0) continue; // Structural
        const i = dv.getUint32(k * 16, true) % (n * n);
        const j = dv.getUint32(k * 16 + 4, true) % (n * n);
        const vi = Math.floor(i / n);
        const vj = Math.floor(j / n);
        if (vi === vj && vi < Math.floor(0.05 * (n - 1))) sum += dv.getFloat32(k * 16 + 8, true);
      }
      return sum;
    };
    const ratio = sumTopRest(elast) / sumTopRest(plain);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.8);
  });
});
