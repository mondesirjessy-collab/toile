# TOILE

**Real-time cloth simulation engine for the web.**
XPBD solver running entirely on WebGPU compute shaders — zero CPU round-trips per frame.

TOILE (*French: the muslin test garment a pattern is validated on*) is the open engine at the core of a browser-based 3D garment design tool: an open, web-first alternative to proprietary desktop suites. The engine and the garment file format are free software; anyone can build on them.

> **Status: Phase 0 — feasibility prototype.**
> Current milestone: GPU particle system under gravity (weeks 1–2).
> Next: distance constraints → bending → sphere collision → interactive drape demo.

## Why

- **Proprietary lock-in.** Today's garment simulation tools trap patterns in closed formats and closed ecosystems. Fashion deserves an open interchange format the way the web got HTML.
- **Desktop-only.** Existing tools require heavy installs and per-seat licenses out of reach of independent designers, students and small labels.
- **The WebGPU window.** Modern browsers can now dispatch massively parallel compute. A cloth solver that needed a workstation in 2015 fits in a browser tab in 2026.

## Phase 0 success criteria

| # | Criterion | Threshold |
|---|-----------|-----------|
| S1 | 64×64 grid (4,096 particles) | ≥ 60 fps on recent integrated GPUs |
| S2 | 128×128 grid (16,384 particles) | ≥ 60 fps on mid-range discrete GPUs |
| S3 | Stability | No numerical explosion after 5 min, including under user interaction |
| S4 | Cloth–sphere collision | No visible interpenetration |
| S5 | Drape realism | Side-by-side comparison with Blender cloth sim |
| S6 | Stretch control | ≤ 1% stretch under gravity (quasi-inextensible) |

## Run it

Requires a WebGPU-capable browser (Chrome/Edge 113+, Safari 18+, Firefox 141+).

```bash
npm install
npm run dev
```

## Architecture

```
src/engine/   ← the solver. Framework-free: exposes raw GPU buffers.
src/app/      ← the demo. Rendering, camera, UI. May depend on Three.js later.
```

The engine never imports a rendering framework. This boundary is what makes it publishable as a standalone package.

## Technical approach

- **XPBD** (Macklin, Müller, Chentanez 2016) with the *small steps* scheme (Müller et al. 2019): many substeps, one solver iteration each.
- **Graph coloring** for parallel constraint solving (Jacobi + atomics kept as fallback).
- All simulation state lives in GPU storage buffers; the renderer reads positions directly.

## License

AGPL-3.0-only. If you run a modified version of this engine as a network service, you must publish your modifications. Commercial licensing inquiries are welcome.
