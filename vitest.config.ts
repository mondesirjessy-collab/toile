import { defineConfig } from 'vitest/config';

// CPU-only unit tests (brief §2): mesh topology + constraint-graph coloring.
// These import the pure-TypeScript engine modules; nothing here touches WebGPU,
// so the suite runs headlessly in Node (and in CI).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});
