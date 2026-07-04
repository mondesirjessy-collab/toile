# /bench — reproducible solver benchmarks

Per the Phase 0 brief (§8), every milestone ends with a bench entry: a
reproducible scene + measurements. Benchmarks split in two, because half the
solver runs on the GPU (not measurable headlessly in Node) and half is CPU
precompute (measurable anywhere).

## 1. CPU precompute (automated)

`solver.bench.ts` measures grid generation + constraint building + graph
coloring across the resolutions tied to the success criteria (S1 = 64²,
S2 = 128²). This is the part that runs headlessly, so it lives in CI-adjacent
tooling and is fully reproducible.

Run:

```bash
npm run bench
```

Vitest prints ops/sec and mean time per resolution. This precompute happens
once at load (or on a resolution change), so it is not the per-frame budget —
it just guards against the coloring/topology build regressing into something
pathologically slow.

## 2. GPU simulation (manual, until GPU timestamps land)

The real S1/S2 target is **simulation time per frame on the GPU**, which WebGPU
only exposes in a browser. Until the GPU timestamp-query HUD lands (brief §4:
"ms/frame sim vs rendu via timestamps GPU"), record it by hand from the in-app
HUD (`npm run dev`, then read the fps / particle / substep line).

### Protocol

1. `npm run dev`, open the app in a WebGPU browser (Chrome/Edge 113+, Safari 18+).
2. Let the cloth settle (~5 s), then read steady-state fps from the HUD.
3. Keep substeps at 20 unless the row says otherwise.
4. Note the GPU (S1 = recent integrated GPU, e.g. Apple M1 / Iris Xe;
   S2 = mid-range discrete).

### Results template

| Date | Milestone | Grid | Particles | Constraints | Substeps | GPU | fps | Criterion | Pass |
|------|-----------|------|-----------|-------------|----------|-----|-----|-----------|------|
| —    | M3        | 64²  | 4 096     | ~16 000     | 20       | _fill_ | _fill_ | S1 ≥ 60 fps | _?_ |
| —    | M3        | 128² | 16 384    | ~65 000     | 20       | _fill_ | _fill_ | S2 ≥ 60 fps | _?_ |

Add a new row per milestone/hardware rather than overwriting, so regressions
across milestones stay visible for the NGI dossier.
