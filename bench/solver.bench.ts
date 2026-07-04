import { bench, describe } from 'vitest';
import { generateClothGrid } from '../src/engine/cloth/ClothMesh';

/**
 * CPU precompute benchmark (brief §8: "chaque jalon se termine par une entrée
 * dans /bench"). This measures the headless-reproducible part of the solver:
 * grid generation + constraint building + greedy graph coloring, across the
 * grid resolutions that map to the success criteria (S1 = 64², S2 = 128²).
 *
 * The GPU sim time per frame (the real S1/S2 target) is NOT measurable in Node
 * — WebGPU is browser-only here — so it is recorded manually from the in-app
 * HUD; see bench/README.md for the results template and protocol.
 *
 * Run: `npm run bench`
 */
for (const resolution of [32, 64, 128] as const) {
  const particles = resolution * resolution;
  describe(`cloth precompute · ${resolution}² (${particles} particles)`, () => {
    bench('generateClothGrid (mesh + constraints + coloring)', () => {
      generateClothGrid({ resolution, size: 1.0, topY: 1.8, pin: 'corners' });
    });
  });
}
