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
  Structural = 0,
  Shear = 1,
  Bending = 2,
  /** Seam between two pattern pieces — solved rigid, like structural. */
  Seam = 3,
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
}

export function colorConstraints(edges: Edge[], particleCount: number): ColoringResult {
  // Per-particle set of colors already used by an incident edge.
  const used: Set<number>[] = Array.from({ length: particleCount }, () => new Set<number>());
  const colorOf = new Int32Array(edges.length).fill(-1);
  let numColors = 0;

  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e]!;
    const ui = used[edge.i]!;
    const uj = used[edge.j]!;
    let c = 0;
    while (ui.has(c) || uj.has(c)) c++;
    colorOf[e] = c;
    ui.add(c);
    uj.add(c);
    if (c + 1 > numColors) numColors = c + 1;
  }

  // Bucket edges by color into a contiguous array.
  const colorCounts = new Array<number>(numColors).fill(0);
  for (let e = 0; e < edges.length; e++) colorCounts[colorOf[e]!]!++;

  const colorOffsets = new Array<number>(numColors).fill(0);
  for (let c = 1; c < numColors; c++) colorOffsets[c] = colorOffsets[c - 1]! + colorCounts[c - 1]!;

  const cursor = colorOffsets.slice();
  const ordered = new Array<Edge>(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const c = colorOf[e]!;
    ordered[cursor[c]!++] = edges[e]!;
  }

  return { ordered, colorOffsets, colorCounts };
}
