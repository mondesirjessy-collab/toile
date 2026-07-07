# TOILE

**Real-time cloth simulation engine for the web.**
XPBD solver running entirely on WebGPU compute shaders — zero CPU round-trips per frame.

<p align="center">
  <img src="docs/media/demo.gif" alt="A dress assembling itself around a realistic scanned avatar, then re-cut slimmer by dragging a handle in the 2D pattern view" width="720" />
</p>

<p align="center">
  <b><a href="https://mondesirjessy-collab.github.io/toile/">▶ Live demo</a></b> — requires a WebGPU browser (Chrome/Edge 113+, Safari 26+, Firefox 141+)
</p>

TOILE (*French: the muslin test garment a pattern is validated on*) is the open engine at the core of a browser-based 3D garment design tool: an open, web-first alternative to proprietary desktop suites. The engine and the garment file format are free software; anyone can build on them.

> **Status: Phase 0 & 1 complete · Phase 2 (a real design tool) well underway.**
> The engine sews and *dresses*: pattern pieces are cut along smooth curves,
> seamed edge-to-edge (mirror seams, set-in armholes, gathered waists),
> made-to-measure by a built-in tailor, and assembled onto sculpted or scanned
> bodies — dresses, shirts with eased sleeve caps, skirts, trousers, gathered
> bustier dresses, and layered outfits. It then leaves the browser: a garment
> prints as a **1:1 sewing pattern** (seam allowance included) or exports as a
> **glTF** 3D file.

## Why

- **Proprietary lock-in.** Today's garment simulation tools trap patterns in closed formats and closed ecosystems. Fashion deserves an open interchange format the way the web got HTML.
- **Desktop-only.** Existing tools require heavy installs and per-seat licenses out of reach of independent designers, students and small labels.
- **The WebGPU window.** Modern browsers can now dispatch massively parallel compute. A cloth solver that needed a workstation in 2015 fits in a browser tab in 2026.

## What works today

**The solver**
- **XPBD cloth on GPU compute** — distance (structural + shear) and **true dihedral bending** (4-particle hinges), graph-colored for race-free parallel solving, 20 substeps per frame, all in a single compute pass
- **Anisotropy** — separate warp / weft / bias stiffness and grain line, so denim, poplin, wool and silk each drape differently (7 fabric presets)
- **Self-collision** — GPU spatial hash (atomic linked cells); folds slide instead of interpenetrating
- **Garment layers** — stacked pieces settle in dressing order (a dress over a tee), gripping *through* the layer beneath by Coulomb friction

**Pattern & fit**
- **Made-to-measure tailor** — the engine measures the body (chest, waist, hips, shoulders, thigh) and grades every garment from ratios; six morphology sliders in **real centimetres**
- **Bodies** — sculpted female/male mannequins (smooth-blended round-cone SDFs) *and* real scanned CC0 avatars (baked SDF grids)
- **Garments** — A-line dress, kimono tee, **set-in-sleeve shirt with an eased sleeve cap** (the tailor's *embu*), flared skirt, trousers, gathered bustier dress, and layered outfits — cut along smooth curves, seamed edge-to-edge, waistbands **anchored to the body** so strapless tops and beltless skirts hold
- **2D cutting-layout inset** — the flat pattern pieces, laid side by side, with **draggable handles** that re-cut and re-sew the garment live
- **Prints** — procedural stripes / gingham / dots, scaled in true cm and woven into the weave so they follow every fold
- **Fit map** — a per-axis tension heatmap (blue slack → red tight)
- **Free pins** — double-click to tack any point to the body

**From browser to sewing table**
- **1:1 PDF pattern** — tiled over A4 with assembly labels, a 100 mm calibration square, grain line, and a **1 cm seam-allowance line** (cut here, sew on the solid line)
- **glTF / .glb 3D export** — the draped garment + mannequin, ready for Blender or any 3D viewer
- **Open `.toile.json` format** — save and reload the whole garment (pattern, fabric, measurements)

**Interaction**
- Grab the fabric (raycast drag), orbit/pan/zoom camera, wind, a rotating **podium**, idle sleep
- **Perf HUD** — fps plus GPU-timestamped sim vs render times

| Silk dress | Kimono tee | Tee + skirt outfit |
|---|---|---|
| ![Silk dress on the mannequin](docs/media/dress.jpg) | ![Kimono tee on the mannequin](docs/media/tee.jpg) | ![Layered tee and skirt outfit](docs/media/outfit.jpg) |

## Controls

| Gesture | Action |
|---|---|
| Left-drag **on the fabric** | Grab and pull it |
| Left-drag on empty space | Orbit the camera |
| Right-drag | Pan |
| Wheel | Zoom |
| Drag a **handle** in the 2D pattern inset | Re-cut the garment (length, silhouette, neckline…) |
| Double-click the fabric | Pin/unpin that point to the body |
| `R` | Drop the cloth again |
| `P` | Pin/release the two corners |

The **fichier** panel prints the 1:1 PDF pattern, exports the draped garment as `.glb`, and saves/loads `.toile.json`.

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

- **Phase 0** — feasibility: stable interactive drape at 60 fps ✅
- **Phase 1** — garment construction: pattern seaming ✅, shaped pieces ✅, self-collision ✅, mannequin ✅, dihedral bending ✅, outfits ✅
- **Phase 2** — a real design tool: made-to-measure tailor ✅, morphology in cm ✅, scanned avatars ✅, set-in sleeves with ease ✅, fabric anisotropy ✅, prints ✅, fit map & pins ✅, garment layers ✅, waistband anchors ✅, 1:1 PDF pattern with seam allowance ✅, glTF export ✅ — next: image-based fabric prints, richer avatars, a community fabric library
- **Phase 3** — collaboration and an open fabric/pattern exchange

## License

AGPL-3.0-only. If you run a modified version of this engine as a network service, you must publish your modifications. Commercial licensing inquiries are welcome.
