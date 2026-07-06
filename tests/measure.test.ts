import { describe, expect, it } from 'vitest';
import { BODY_BLEND, BODY_FORM, BODY_MALE, sdBody } from '../src/engine/body/BodySdf';
import { gridSd, measureBody, type Sd } from '../src/engine/body/measure';

const sdF: Sd = (x, y, z) => sdBody(x, y, z, BODY_FORM, BODY_BLEND);
const sdM: Sd = (x, y, z) => sdBody(x, y, z, BODY_MALE, BODY_BLEND);

describe('measureBody (le tailleur)', () => {
  const F = measureBody(sdF, 1.755);
  const M = measureBody(sdM, 1.765);

  it('finds sane reference-form landmarks', () => {
    expect(F.shoulderY).toBeGreaterThan(1.3);
    expect(F.shoulderY).toBeLessThan(1.5);
    expect(F.waist.y).toBeLessThan(F.chest.y);
    expect(F.hip.y).toBeLessThan(F.waist.y);
    expect(F.hip.circ).toBeGreaterThan(F.waist.circ); // skirts rely on this
    expect(F.chest.circ).toBeGreaterThan(0.5);
    expect(F.chest.circ).toBeLessThan(1.4);
  });

  it('finds the chest at BUST height, not on the ribcage bulge', () => {
    // The diaphragm bulge (~0.66 H) is slightly fuller than the bust on the
    // sculpted female form; a band floor below it graded tops on the wrong
    // line and pointed the « poitrine » morph at the ribs.
    expect(F.chest.y / 1.755).toBeGreaterThan(0.67);
    expect(F.chest.y / 1.755).toBeLessThan(0.76);
    expect(F.chest.y - F.waist.y).toBeGreaterThan(0.12); // clear of the waist band
    expect(M.chest.y / 1.765).toBeGreaterThan(0.67);
    expect(M.chest.y / 1.765).toBeLessThan(0.76);
  });

  it('measures the thigh below the crotch, where the legs are separate', () => {
    // Above the crotch the smin blend fuses both thighs into one solid: the
    // inner caliper ray never exits and the thigh read ~28 cm instead of ~43.
    expect(sdF(0, F.thigh.y, 0)).toBeGreaterThan(0); // mid-plane clear = two legs
    expect(sdM(0, M.thigh.y, 0)).toBeGreaterThan(0);
    expect(F.thigh.circ).toBeGreaterThan(0.36);
    expect(F.thigh.circ).toBeLessThan(0.75);
    expect(M.thigh.circ).toBeGreaterThan(0.36);
    expect(M.thigh.circ).toBeLessThan(0.8);
  });

  it('measures the male broader where it matters', () => {
    expect(M.chest.circ).toBeGreaterThan(F.chest.circ);
    expect(M.shoulderHalfW).toBeGreaterThan(F.shoulderHalfW);
    // Derived top grade lands near the hand-tuned 1.13 it replaces.
    const topScale = Math.max(M.chest.circ / F.chest.circ, M.shoulderHalfW / F.shoulderHalfW);
    expect(topScale).toBeGreaterThan(1.02);
    expect(topScale).toBeLessThan(1.35);
  });

  it('reads a baked grid like the analytic field it came from', () => {
    // Bake a small grid from the female field, then re-measure through it.
    const min: [number, number, number] = [-0.45, -0.05, -0.3];
    const max: [number, number, number] = [0.45, 1.8, 0.3];
    const dims: [number, number, number] = [46, 93, 31];
    const data = new Float32Array(dims[0] * dims[1] * dims[2]);
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++) {
          const x = min[0] + (i / (dims[0] - 1)) * (max[0] - min[0]);
          const y = min[1] + (j / (dims[1] - 1)) * (max[1] - min[1]);
          const z = min[2] + (k / (dims[2] - 1)) * (max[2] - min[2]);
          data[(k * dims[1] + j) * dims[0] + i] = sdF(x, y, z);
        }
    const G = measureBody(gridSd({ dims, min, max, data }), 1.755);
    expect(Math.abs(G.chest.circ - F.chest.circ)).toBeLessThan(0.08);
    expect(Math.abs(G.hip.circ - F.hip.circ)).toBeLessThan(0.08);
    expect(Math.abs(G.shoulderY - F.shoulderY)).toBeLessThan(0.05);
  });
});

describe('morphologies', () => {
  it('widens the hips and the tailor re-measures accordingly', async () => {
    const { morphPrims, morphScale, NO_MORPH } = await import('../src/engine/body/morph');
    const base = measureBody(sdF, 1.755);
    const marks = {
      shoulderY: base.shoulderY,
      chestY: base.chest.y,
      waistY: base.waist.y,
      hipY: base.hip.y,
      thighY: base.thigh.y,
    };
    const m = { ...NO_MORPH, hanches: 1.18 };
    // The warp peaks at the hip line and fades at the chest.
    expect(morphScale(base.hip.y, m, marks)).toBeCloseTo(1.18, 2);
    expect(morphScale(base.chest.y, m, marks)).toBeLessThan(1.03);
    const morphed = morphPrims(BODY_FORM, m, marks);
    const M = measureBody((x, y, z) => sdBody(x, y, z, morphed, BODY_BLEND), 1.755);
    expect(M.hip.circ).toBeGreaterThan(base.hip.circ * 1.1);
    expect(Math.abs(M.chest.circ - base.chest.circ)).toBeLessThan(0.05);
  });
});
