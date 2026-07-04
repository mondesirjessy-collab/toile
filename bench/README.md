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

### Results

GPU sim time per frame (timestamp queries, 20 substeps). The 60 fps budget is
16.7 ms/frame; sim must share it with rendering (< 1 ms here).

| Date | Milestone | Grid | Particles | Constraints | GPU | sim ms (in-app) | sim ms (saturated) | Criterion | Pass |
|------|-----------|------|-----------|-------------|-----|-----------------|--------------------|-----------|------|
| 2026-07-04 | M9-10 (multi-pass, before) | 64²  | 4 096  | 23 938 | Apple (metal-3) | 3.08 | — | S1 ≥ 60 fps | ✅ |
| 2026-07-04 | M9-10 (multi-pass, before) | 128² | 16 384 | 97 026 | Apple (metal-3) | 4.98 | — | S2 ≥ 60 fps | ✅ |
| 2026-07-04 | M9-10 (single-pass) | 64²  | 4 096  | 23 938 | Apple (metal-3) | —    | 0.98 | S1 ≥ 60 fps | ✅ |
| 2026-07-04 | M9-10 (single-pass) | 128² | 16 384 | 97 026 | Apple (metal-3) | 3.47 | 0.66 | S2 ≥ 60 fps | ✅ |

Notes:
- *in-app*: read from the HUD during normal interactive use. Includes GPU
  power-management downclocking at low utilization, so it overstates the cost.
- *saturated*: median of 60 back-to-back `step()` calls (harness driven by
  `onSubmittedWorkDone`), GPU at boost clocks — the intrinsic solver cost.
- The M9-10 optimization collapsed ~16×substeps compute passes per frame into
  ONE pass (WebGPU synchronizes storage writes between dispatches of a pass);
  at 128² the in-app cost dropped 4.98 → 3.47 ms (−30 %).

Add a new row per milestone/hardware rather than overwriting, so regressions
across milestones stay visible for the NGI dossier.
