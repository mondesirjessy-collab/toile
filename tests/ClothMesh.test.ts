import { describe, it, expect } from 'vitest';
import { generateClothGrid } from '../src/engine/cloth/ClothMesh';

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
  compliance: number;
}

function decodeConstraints(data: ArrayBuffer, count: number): DecodedEdge[] {
  const dv = new DataView(data);
  const out: DecodedEdge[] = [];
  for (let k = 0; k < count; k++) {
    out.push({
      i: dv.getUint32(k * 16, true),
      j: dv.getUint32(k * 16 + 4, true),
      rest: dv.getFloat32(k * 16 + 8, true),
      compliance: dv.getFloat32(k * 16 + 12, true),
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

  it('assigns per-constraint compliance: rigid stretch, soft bending', () => {
    const stretchCompliance = 0;
    const bendCompliance = 1e-5;
    const m = generateClothGrid({ resolution: n, size, stretchCompliance, bendCompliance });
    const edges = decodeConstraints(m.constraintData, m.constraintCount);
    const skip2 = spacing * 2;
    for (const e of edges) {
      const isBending = Math.abs(e.rest - skip2) < 1e-5;
      expect(e.compliance).toBeCloseTo(isBending ? bendCompliance : stretchCompliance, 9);
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
