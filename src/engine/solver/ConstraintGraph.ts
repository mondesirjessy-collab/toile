/**
 * ConstraintGraph — CPU graph coloring for GPU-parallel constraint solving
 * (brief §3.4, option A). Two constraints that share a particle cannot be
 * solved in the same GPU dispatch without a write race. We greedily partition
 * the constraints into "colors" such that no two constraints of the same color
 * touch a common particle; the solver then does one dispatch per color.
 *
 * Greedy is sufficient for a regular grid (brief §3.4): it yields ~8 colors for
 * structural + shear edges and is deterministic. Computed once at init.
 */
/** Constraint kind → selects which live compliance (stretch/shear/bend) applies. */
export enum ConstraintKind {
  /** Weft: the horizontal weave (u direction) — its own stretch stiffness. */
  Structural = 0,
  /** Bias: diagonal resistance — what makes bias-cut garments drape. */
  Shear = 1,
  Bending = 2,
  /** Seam between two pattern pieces — solved rigid, like structural. */
  Seam = 3,
  /** Warp: the vertical weave (v direction, the grain line) — anisotropy. */
  StructuralWarp = 4,
  /**
   * Top-stitch between an overlay (pocket/appliqué) and a supporting panel.
   * Endpoint i is always the support, endpoint j the overlay. It stays firm on
   * the pocket but has a deliberately small reaction on the much larger base
   * panel, preventing an open pocket from levering the garment forward.
   */
  SurfaceSeam = 5,
  /**
   * Anatomical attachment from an already body-safe support rim (i) to a
   * separately spawned part (j). The attached part absorbs 98% of projection,
   * preventing a collar born inside the neck from dragging the torso inward.
   */
  AttachmentSeam = 6,
  /**
   * Couture de FERMETURE ÉCLAIR (v198) : même rigidité qu'une couture
   * d'assemblage, mais débrayable À CHAUD par l'uniform `zip_open` du pass
   * distance — ouvrir/fermer ne reconstruit rien, l'état porté est préservé
   * et les rubans s'écartent ou se rejoignent en direct.
   */
  ZipperSeam = 7,
}

export interface Edge {
  i: number;
  j: number;
  rest: number;
  /** Constraint kind; carried through coloring so the GPU can pick its compliance. */
  kind: ConstraintKind;
}

export interface ColoringResult {
  /** Edges reordered so that all edges of a color are contiguous. */
  ordered: Edge[];
  /** Start index of each color block within `ordered`. */
  colorOffsets: number[];
  /** Number of edges in each color block. */
  colorCounts: number[];
  /**
   * Explicit color ranges for the three ordered solver phases. `first` is an
   * index into colorOffsets/colorCounts (not an edge offset). Empty phases keep
   * a zero count, so ParticleSystem never has to infer kinds from packed data.
   */
  phaseColorRanges: ConstraintPhaseColorRanges;
}

export interface ColorRange {
  first: number;
  count: number;
}

export interface ConstraintPhaseColorRanges {
  ordinary: ColorRange;
  seam: ColorRange;
  surfaceSeam: ColorRange;
}

/** Dihedral bending element: shared edge (e0,e1) + the two wing vertices. */
export interface BendQuad {
  e0: number;
  e1: number;
  w0: number;
  w1: number;
  /** Rest dihedral angle (π = flat). */
  restAngle: number;
  /** Compliance multiplier: 1 = fabric bending, >1 = softer (seam pressing). */
  softness?: number;
  /** 0 = curvature across weft, 1 = curvature along warp, intermediate = blend. */
  warpWeight?: number;
  /** Immutable rest angle used when crease recovery relaxes the material. */
  baseRestAngle?: number;
}

export interface QuadColoringResult {
  ordered: BendQuad[];
  colorOffsets: number[];
  colorCounts: number[];
}

/** Same greedy coloring as edges, but each constraint occupies 4 particles. */
export function colorQuads(quads: BendQuad[], particleCount: number): QuadColoringResult {
  const used: Set<number>[] = Array.from({ length: particleCount }, () => new Set<number>());
  const colorOf = new Int32Array(quads.length).fill(-1);
  let numColors = 0;

  for (let q = 0; q < quads.length; q++) {
    const quad = quads[q]!;
    const parts = [quad.e0, quad.e1, quad.w0, quad.w1];
    let c = 0;
    while (parts.some((p) => used[p]!.has(c))) c++;
    colorOf[q] = c;
    for (const p of parts) used[p]!.add(c);
    if (c + 1 > numColors) numColors = c + 1;
  }

  const colorCounts = new Array<number>(numColors).fill(0);
  for (let q = 0; q < quads.length; q++) colorCounts[colorOf[q]!]!++;
  const colorOffsets = new Array<number>(numColors).fill(0);
  for (let c = 1; c < numColors; c++) colorOffsets[c] = colorOffsets[c - 1]! + colorCounts[c - 1]!;

  const cursor = colorOffsets.slice();
  const ordered = new Array<BendQuad>(quads.length);
  for (let q = 0; q < quads.length; q++) {
    ordered[cursor[colorOf[q]!]!++] = quads[q]!;
  }
  return { ordered, colorOffsets, colorCounts };
}

export function colorConstraints(edges: Edge[], particleCount: number): ColoringResult {
  /** Color one ordered solver phase. Colors are local to that phase: distinct
   * phases execute in sequence and may therefore reuse the same particles. */
  const colorPhase = (
    phaseEdges: Edge[],
    sparse = false,
  ): Pick<ColoringResult, 'ordered' | 'colorOffsets' | 'colorCounts'> => {
    // Per-particle set of colors already used by an incident edge.
    // The ordinary weave touches almost every particle, while a stitch phase
    // touches only its rims. Keep that second palette sparse: multi-piece
    // hoodies are repeatedly combined and should not allocate one empty Set
    // per particle merely to color a few hundred seams.
    const denseUsed: Set<number>[] | null = sparse
      ? null
      : Array.from({ length: particleCount }, () => new Set<number>());
    const sparseUsed = sparse ? new Map<number, Set<number>>() : null;
    const colorsAt = (particle: number): Set<number> => {
      if (denseUsed) return denseUsed[particle]!;
      let colors = sparseUsed!.get(particle);
      if (!colors) {
        colors = new Set<number>();
        sparseUsed!.set(particle, colors);
      }
      return colors;
    };
    const colorOf = new Int32Array(phaseEdges.length).fill(-1);
    let numColors = 0;

    for (let e = 0; e < phaseEdges.length; e++) {
      const edge = phaseEdges[e]!;
      const ui = colorsAt(edge.i);
      const uj = colorsAt(edge.j);
      let c = 0;
      while (ui.has(c) || uj.has(c)) c++;
      colorOf[e] = c;
      ui.add(c);
      uj.add(c);
      if (c + 1 > numColors) numColors = c + 1;
    }

    const colorCounts = new Array<number>(numColors).fill(0);
    for (let e = 0; e < phaseEdges.length; e++) {
      colorCounts[colorOf[e]!]!++;
    }
    const colorOffsets = new Array<number>(numColors).fill(0);
    for (let c = 1; c < numColors; c++) {
      colorOffsets[c] = colorOffsets[c - 1]! + colorCounts[c - 1]!;
    }

    const cursor = colorOffsets.slice();
    const ordered = new Array<Edge>(phaseEdges.length);
    for (let e = 0; e < phaseEdges.length; e++) {
      const c = colorOf[e]!;
      ordered[cursor[c]!++] = phaseEdges[e]!;
    }
    return { ordered, colorOffsets, colorCounts };
  };

  // A seam is a terminal positional invariant, not another yarn spring.
  // Solving it in the same color palette as structural/shear edges allowed a
  // later color touching the same boundary particle to pull the stitch open
  // again. This was intermittent because the final residual depended on the
  // garment topology and collision pose (robe/flancs were the clearest case).
  // Keep assembly/attachment and one-sided SurfaceSeam stitches in separately
  // colored terminal phases. SurfaceSeam's asymmetric support response remains
  // entirely in the shader; this also lets ParticleSystem replay only regular
  // seams after self-collision without strengthening pocket top-stitches.
  const ordinary: Edge[] = [];
  const stitches: Edge[] = [];
  for (const edge of edges) {
    if (
      edge.kind === ConstraintKind.Seam ||
      edge.kind === ConstraintKind.AttachmentSeam ||
      edge.kind === ConstraintKind.SurfaceSeam ||
      edge.kind === ConstraintKind.ZipperSeam
    ) {
      stitches.push(edge);
    } else {
      ordinary.push(edge);
    }
  }

  const seams: Edge[] = [];
  const surfaceSeams: Edge[] = [];
  for (const edge of stitches) {
    if (edge.kind === ConstraintKind.SurfaceSeam) surfaceSeams.push(edge);
    else seams.push(edge);
  }

  // Keep support/overlay top-stitches in their own final phase. The solver may
  // safely replay regular assembly seams after self-collision without also
  // increasing the asymmetric reaction of pockets and appliqués.
  const phases = [
    colorPhase(ordinary),
    colorPhase(seams, true),
    colorPhase(surfaceSeams, true),
  ];
  const ordered: Edge[] = [];
  const colorOffsets: number[] = [];
  const colorCounts: number[] = [];
  const phaseRanges: ColorRange[] = [];
  for (const phase of phases) {
    const phaseOffset = ordered.length;
    const first = colorOffsets.length;
    // Large hoodie/outfit meshes carry hundreds of thousands of constraints;
    // spreading that array exceeds JavaScript's argument-stack limit.
    for (const edge of phase.ordered) ordered.push(edge);
    for (let c = 0; c < phase.colorOffsets.length; c++) {
      colorOffsets.push(phaseOffset + phase.colorOffsets[c]!);
      colorCounts.push(phase.colorCounts[c]!);
    }
    phaseRanges.push({ first, count: phase.colorOffsets.length });
  }
  return {
    ordered,
    colorOffsets,
    colorCounts,
    phaseColorRanges: {
      ordinary: phaseRanges[0]!,
      seam: phaseRanges[1]!,
      surfaceSeam: phaseRanges[2]!,
    },
  };
}
