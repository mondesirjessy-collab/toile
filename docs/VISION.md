# Vision — TOILE vs. the proprietary suites

Target reference: CLO3D (CLO 2026), the industry-standard 3D garment tool.
This maps its feature pillars onto TOILE's phases, so scope decisions stay
honest about what exists, what's planned, and what's deliberately out.

## Feature map

| CLO3D pillar | Representative features (CLO 2026) | TOILE status | Planned |
|---|---|---|---|
| **Cloth simulation** | GPU trim simulation, fabric-aware strain maps, fabric swap | ✅ Phase 0 done — XPBD on WebGPU compute, 60 fps at 128², fabric presets (physics + look), measured benchmarks | — |
| **2D pattern making** | Pattern Drafter, sketch-on-avatar, annotations, symmetric tracing | ❌ | Phase 2 — pattern editor |
| **Seaming 2D→3D** | Assemble pattern pieces on the body, gluing, lacing | ✅ First version — shaped pieces (A-line, neckline, straps), side + shoulder seams, assembled live on a capsule mannequin, with cloth self-collision | Phase 1 continues: dihedral bending, richer shapes |
| **Avatars & animation** | Blend shapes, rigged accessories, VRM, animation timeline | Capsule mannequin (head/shoulders/torso/hips/legs) | Phase 2 — SMPL-X |
| **Rendering & details** | Zippers, fur, toon shader, isolate mode | Basic lit surface | Post-Phase 2 |
| **Production** | Auto POM & grading, nesting, cost estimation, DXF export | ❌ | Post-NGI; DXF import considered earlier for interop |

## Where TOILE wins by design

CLO cannot follow on these — they are structural choices, not features:

1. **Zero-install, web-first.** A browser tab replaces a workstation license.
2. **Free software (AGPL).** The engine is a commons; anyone can embed or extend it.
3. **An open garment format.** CLO locks patterns into a proprietary ecosystem.
   An open interchange format for garments — patterns + fabric parameters +
   seams — is the project's core wager, the way HTML opened publishing.

## Discipline

Phase 0 proved the hard foundation (real-time stable drape). Every pillar above
enters scope only at its phase; anything tempting before that goes to
`ROADMAP.md`, not into the code.
