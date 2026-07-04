# TOILE

**Real-time cloth simulation engine for the web.**
XPBD solver running entirely on WebGPU compute shaders — zero CPU round-trips per frame.

<p align="center">
  <img src="docs/media/demo.gif" alt="Cloth dropping and draping over a sphere, then silk cascading" width="720" />
</p>

<p align="center">
  <b><a href="https://mondesirjessy-collab.github.io/toile/">▶ Live demo</a></b> — requires a WebGPU browser (Chrome/Edge 113+, Safari 26+, Firefox 141+)
</p>

TOILE (*French: the muslin test garment a pattern is validated on*) is the open engine at the core of a browser-based 3D garment design tool: an open, web-first alternative to proprietary desktop suites. The engine and the garment file format are free software; anyone can build on them.

> **Status: Phase 0 — feasibility prototype, weeks 9-10 of 12.**
> Solver, collisions, interaction, surface rendering and fabric presets are done and deployed.
> Remaining: Blender drape comparison, final polish.

## Why

- **Proprietary lock-in.** Today's garment simulation tools trap patterns in closed formats and closed ecosystems. Fashion deserves an open interchange format the way the web got HTML.
- **Desktop-only.** Existing tools require heavy installs and per-seat licenses out of reach of independent designers, students and small labels.
- **The WebGPU window.** Modern browsers can now dispatch massively parallel compute. A cloth solver that needed a workstation in 2015 fits in a browser tab in 2026.

## What works today

- **XPBD cloth solver on GPU compute** — distance (structural + shear) and bending constraints, graph-colored for race-free parallel solving, 20 substeps per frame
- **Collisions** — sphere + ground with Coulomb friction, zero visible interpenetration
- **Grab the fabric** — raycast picking with a temporary drag constraint; orbit/pan/zoom camera
- **Fabric presets** — Jersey / Denim / Silk: per-fabric stretch, shear, bending compliance, friction *and* look (face/back colors, sheen)
- **Live tuning** — mesh resolution 32/64/128, substeps, log-scale compliance sliders, friction, corner pins
- **Perf HUD** — fps plus GPU-timestamped sim vs render times

| Jersey — soft knit | Silk — fluid, sheeny |
|---|---|
| ![Jersey draped over a sphere](docs/media/jersey.jpg) | ![Silk cascading over a sphere](docs/media/silk.jpg) |

## Controls

| Gesture | Action |
|---|---|
| Left-drag **on the fabric** | Grab and pull it |
| Left-drag on empty space | Orbit the camera |
| Right-drag | Pan |
| Wheel | Zoom |
| `R` | Drop the cloth again |
| `P` | Pin/release the two corners |

## Phase 0 success criteria

| # | Criterion | Threshold | Status |
|---|-----------|-----------|--------|
| S1 | 64×64 grid (4,096 particles) | ≥ 60 fps on recent integrated GPUs | ✅ ~1 ms/frame sim (Apple M-series) |
| S2 | 128×128 grid (16,384 particles) | ≥ 60 fps on mid-range discrete GPUs | ✅ ~3.5 ms/frame sim |
| S3 | Stability | No numerical explosion after 5 min, including under user interaction | ✅ |
| S4 | Cloth–sphere collision | No visible interpenetration | ✅ 0 penetrating particles (measured) |
| S5 | Drape realism | Side-by-side comparison with Blender cloth sim | ⏳ pending |
| S6 | Stretch control | ≤ 1% stretch under gravity (quasi-inextensible) | ✅ 0.76% measured |

Measured benchmarks and protocol live in [`/bench`](bench/README.md).

## Run it

```bash
npm install
npm run dev     # local demo at http://localhost:5173
npm test        # CPU unit tests (topology, graph coloring)
npm run bench   # CPU precompute benchmarks
```

## Architecture

```
src/engine/   ← the solver. Framework-free: exposes raw GPU buffers.
  solver/       XPBD passes (integrate → solve → collide → velocity) + WGSL shaders
  cloth/        grid topology, constraint building, graph coloring
src/app/      ← the demo. Rendering, camera, picking, UI.
```

The engine never imports a rendering framework. This boundary is what makes it publishable as a standalone package.

## Technical approach

- **XPBD** (Macklin, Müller, Chentanez 2016) with the *small steps* scheme (Müller et al. 2019): many substeps, one solver iteration each.
- **Graph coloring** for parallel constraint solving — one dispatch per color, all constraints in a color vertex-disjoint.
- **Single compute pass per frame** — all substep dispatches share one pass (WebGPU synchronizes storage writes between dispatches), cutting encoder overhead ~30% at 128².
- All simulation state lives in GPU storage buffers; the renderer reads positions directly and derives per-vertex normals in a small compute pass.

## Roadmap

- **Phase 0 (now)** — feasibility: stable interactive drape at 60 fps ✅
- **Phase 1** — garment construction: 2D pattern seaming, true dihedral bending, cloth self-collision
- **Phase 2** — SMPL-X avatars, pattern editor, open community fabric library

## License

AGPL-3.0-only. If you run a modified version of this engine as a network service, you must publish your modifications. Commercial licensing inquiries are welcome.
