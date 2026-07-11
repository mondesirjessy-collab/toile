import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateClothGrid,
  generateSeamedPanels,
  combineClothMeshes,
  countMaskIslands,
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

describe('seam-distance field (audit M3)', () => {
  const n = 16;
  const rect = generateSeamedPanels({ resolution: n, width: 1.0, height: 1.0, gap: 1.0, topY: 1.8 });

  it('is 0 on the side seams and grows inward, clamped to 3', () => {
    expect(rect.seamDist).toBeDefined();
    expect(rect.seamDist!).toHaveLength(rect.count);
    const at = (p: number, u: number, v: number): number => rect.seamDist![p * n * n + v * n + u]!;
    const v = Math.floor(n / 2);
    // Full rect: side seams at columns 0 and n-1 → hop distance 0.
    expect(at(0, 0, v)).toBe(0);
    expect(at(0, n - 1, v)).toBe(0);
    expect(at(1, 0, v)).toBe(0); // both panels share the field
    // One column in → 1 hop.
    expect(at(0, 1, v)).toBe(1);
    // The middle is far from either side seam → clamped to 3.
    expect(at(0, Math.floor(n / 2), v)).toBe(3);
  });

  it('carries through the merge, per garment', () => {
    const skirt = generateSeamedPanels({ resolution: n, width: 0.8, height: 0.6, gap: 0.75, topY: 1.0, shape: 'skirt' });
    const outfit = combineClothMeshes(rect, skirt);
    expect(outfit.seamDist).toBeDefined();
    expect(outfit.seamDist!).toHaveLength(outfit.count);
    // Garment a's field is copied verbatim into the front of the merged field.
    expect(outfit.seamDist![0]).toBe(rect.seamDist![0]);
    expect(outfit.seamDist![rect.count]).toBe(skirt.seamDist![0]);
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
  });

  it('keeps each garment its OWN rest spacing (per-vêtement prints, M24)', () => {
    // Garment 0 (a = tee) keeps its spacing; garment 1 (b = skirt) is exposed
    // separately as spacing2/spacingV2 so its motif prints at true cm even when
    // the two pieces differ in width — the tee (1.15 m) is wider than the
    // skirt (1.0 m), so a single shared spacing would stretch one motif.
    expect(outfit.spacing).toBeCloseTo(tee.spacing);
    expect(outfit.spacingV).toBeCloseTo(tee.spacingV);
    expect(outfit.spacing2).toBeCloseTo(skirt.spacing);
    expect(outfit.spacingV2).toBeCloseTo(skirt.spacingV);
    // The two pieces genuinely differ — otherwise the test proves nothing.
    expect(outfit.spacing).not.toBeCloseTo(outfit.spacing2!);
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
    // Sew the tee's bottom row to the skirt's top row (front panels) — only
    // where BOTH rows carry live fabric: the shapes cut the row ends, and a
    // seam touching a cut (parked, invMass-0) particle is dropped at combine
    // time instead of yanking the garment toward the parking spot.
    const cross = Array.from({ length: n }, (_, u) => ({
      i: (n - 1) * n + u,
      j: tee.count + u,
    })).filter((cs) => tee.invMasses[cs.i]! > 0 && skirt.invMasses[cs.j - tee.count]! > 0);
    expect(cross.length).toBeGreaterThan(0); // the live span really exists
    const sewn = combineClothMeshes(tee, skirt, cross);
    expect(sewn.seamFree).toHaveLength(sewn.count);
    // Cross-seams are real Seam edges, so seamCount must include them (M12).
    expect(sewn.seamCount).toBe(tee.seamCount + skirt.seamCount + cross.length);
    // A seam aimed at a CUT particle (the row's corner, outside both shapes)
    // is dropped — no constraint may reference parked fabric.
    const toCut = combineClothMeshes(tee, skirt, [{ i: (n - 1) * n, j: tee.count }]);
    expect(toCut.seamCount).toBe(tee.seamCount + skirt.seamCount);
    // The per-kind counts sum to constraintCount for a sewn combination.
    expect(sewn.structuralCount + sewn.shearCount + sewn.bendingCount + sewn.seamCount).toBe(sewn.constraintCount);
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

  it('anchors only the top band, at its rest height, and carries it through the merge', () => {
    const NONE = -1e8;
    const bodice = generateSeamedPanels({ resolution: n, width: 0.4, height: 0.26, gap: 0.9, topY: 1.4, anchorTop: true });
    expect(bodice.anchorY).toHaveLength(bodice.count);
    // Top row (v=0) of both panels is anchored to its rest height (topY).
    expect(bodice.anchorY![0]).toBeCloseTo(1.4);
    expect(bodice.anchorY![n * n]).toBeCloseTo(1.4); // back panel top row
    // A row deep in the panel is free.
    const deep = Math.floor(n / 2) * n;
    expect(bodice.anchorY![deep]).toBeLessThan(NONE);
    // No anchorTop → no anchor buffer at all.
    expect(skirt.anchorY).toBeUndefined();
    // Merge with an unanchored skirt: the bodice keeps its anchors, the skirt
    // stays free.
    const dress = combineClothMeshes(bodice, skirt);
    expect(dress.anchorY).toHaveLength(dress.count);
    expect(dress.anchorY![0]).toBeCloseTo(1.4);
    expect(dress.anchorY![bodice.count + deep]).toBeLessThan(NONE);
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

describe('necklines stay open at EVERY resolution', () => {
  // Fixed exemption margins used to lose to the grid step at coarse n: the
  // first kept particle past the scoop fell outside the opening zone and the
  // mirror seam sewed the neckline shut. Scan the range the UI can reach
  // (and then some) and assert no seam crosses any scoop.
  const scoops: Array<{ shape: 'aline' | 'tshirt' | 'setin'; w: number; d: number }> = [
    { shape: 'aline', w: 0.1, d: 0.12 },
    { shape: 'tshirt', w: 0.11, d: 0.09 },
    { shape: 'setin', w: 0.1, d: 0.09 },
  ];
  for (const n of [16, 24, 32, 48, 64, 96, 128]) {
    it(`n=${n}: no mirror seam inside a scoop`, () => {
      for (const { shape, w, d } of scoops) {
        const mesh = generateSeamedPanels({ resolution: n, shape });
        const ps = n * n;
        const dv = new DataView(mesh.constraintData);
        for (let k = 0; k < mesh.constraintCount; k++) {
          if (dv.getUint32(k * 16 + 12, true) !== 3) continue; // seams only
          const i = dv.getUint32(k * 16, true);
          const j = dv.getUint32(k * 16 + 4, true);
          if (Math.abs(j - i) !== ps) continue; // mirror front↔back seams only
          const local = i % ps;
          const uu = (local % n) / (n - 1);
          const vv = Math.floor(local / n) / (n - 1);
          const x = Math.abs(uu - 0.5);
          // Inside the scoop's ellipse (with half a step of slack): sewing
          // here closes the head hole.
          const inScoop = vv < d && x < w * Math.sqrt(Math.max(0, 1 - (vv / d) ** 2)) + 0.5 / (n - 1);
          expect(inScoop, `${shape} n=${n}: seam at u=${uu.toFixed(3)} v=${vv.toFixed(3)}`).toBe(false);
        }
      }
    });
  }
});

describe('setin side seam has no underarm hole', () => {
  // Between the sleeve band's end and the old fixed exemption bound, body
  // rows were neither armhole-seamed (no sleeve there) nor mirror-seamed
  // (exempted) — an open hole under each arm. The exemption now tracks the
  // band exactly; below it, every side-edge row must carry its mirror seam.
  for (const n of [16, 32, 48, 64, 96, 128]) {
    it(`n=${n}: every body row below the band is sewn`, () => {
      const mesh = generateSeamedPanels({ resolution: n, shape: 'setin' });
      const ps = n * n;
      const kept = (u: number, v: number): boolean => mesh.positions[(v * n + u) * 4 + 1]! > -5;
      const mirror = new Set<number>();
      const dv = new DataView(mesh.constraintData);
      for (let k = 0; k < mesh.constraintCount; k++) {
        if (dv.getUint32(k * 16 + 12, true) !== 3) continue;
        const i = dv.getUint32(k * 16, true);
        const j = dv.getUint32(k * 16 + 4, true);
        if (Math.abs(j - i) === ps) mirror.add(Math.min(i, j));
      }
      for (let v = 0; v < n; v++) {
        const vv = v / (n - 1);
        if (vv <= 0.34 + 1 / (n - 1) || vv > 0.9) continue; // band rows + hem margin
        // Left body edge of the row (single run below the band).
        let edge = -1;
        for (let u = 0; u < n; u++) {
          if (kept(u, v)) {
            edge = u;
            break;
          }
        }
        if (edge < 0) continue;
        expect(mirror.has(v * n + edge), `n=${n} row vv=${vv.toFixed(3)} unsewn`).toBe(true);
      }
    });
  }
});

describe('no mirror pair carries contradictory seam + flattening constraints', () => {
  // A seamed boundary pair (front↔back, rest 0.15·spacing) must NOT also get
  // the cross-seam flattening constraint (rest 2·spacing) — the two fight.
  for (const shape of ['aline', 'skirt', 'setin', 'tshirt', 'pants'] as const) {
    it(`${shape}: seam and flattening pairs are disjoint`, () => {
      const mesh = generateSeamedPanels({ resolution: 48, shape });
      const ps = mesh.resolution * mesh.resolution;
      const dv = new DataView(mesh.constraintData);
      const seam = new Set<number>();
      const flat = new Set<number>();
      for (let k = 0; k < mesh.constraintCount; k++) {
        const i = dv.getUint32(k * 16, true);
        const j = dv.getUint32(k * 16 + 4, true);
        const kind = dv.getUint32(k * 16 + 12, true);
        if (Math.abs(j - i) !== ps) continue; // front↔back pairs only
        const key = Math.min(i, j);
        if (kind === 3) seam.add(key); // Seam
        else if (kind === 2) flat.add(key); // Bending (flattener)
      }
      for (const key of seam) {
        expect(flat.has(key), `pair ${key} has both a seam and a flattener`).toBe(false);
      }
    });
  }
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

describe('connectivity guard (audit M14/M10)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('countMaskIslands: 4-neighbour components over a mask', () => {
    const n = 4;
    const full = new Array<boolean>(n * n).fill(true);
    expect(countMaskIslands(full, n)).toBe(1);
    const empty = new Array<boolean>(n * n).fill(false);
    expect(countMaskIslands(empty, n)).toBe(0);
    // Two vertical stripes separated by an empty column → 2 islands.
    const split = new Array<boolean>(n * n).fill(false);
    for (let v = 0; v < n; v++) {
      split[v * n + 0] = true; // column 0
      split[v * n + 3] = true; // column 3 (column 1,2 empty)
    }
    expect(countMaskIslands(split, n)).toBe(2);
    // A lone diagonal touch does NOT connect (4-neighbour only).
    const diag = new Array<boolean>(n * n).fill(false);
    diag[0] = true; // (0,0)
    diag[n + 1] = true; // (1,1) — diagonal neighbour
    expect(countMaskIslands(diag, n)).toBe(2);
  });

  it('a normal garment stays in one piece (no warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateSeamedPanels({ resolution: 64, width: 0.95, height: 1.2, gap: 1.0, topY: 1.6, shape: 'aline', shapeParams: { profile: [0.21, 0.25, 0.3, 0.35, 0.4, 0.45], scoop: 0.1 } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a set-in cutting sheet is exactly 3 islands (no warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateSeamedPanels({ resolution: 64, width: 1.3, height: 0.75, gap: 0.9, topY: 1.52, shape: 'setin', shapeParams: { sleeve: 0.4, profile: [0.22, 0.2, 0.2, 0.2] } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an over-scooped neckline severs the strap and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // neck 0.16 with a pinched top station → strap columns vanish (M14 repro).
    generateSeamedPanels({ resolution: 64, width: 0.95, height: 1.2, gap: 1.0, topY: 1.6, shape: 'aline', shapeParams: { profile: [0.18, 0.1, 0.1, 0.1, 0.1, 0.1], scoop: 0.16 } });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('déconnecté');
  });
});
