import { describe, it, expect } from 'vitest';
import { colorConstraints, type Edge } from '../src/engine/solver/ConstraintGraph';

/**
 * The coloring is the correctness guarantee for GPU-parallel solving (brief
 * §3.4): within a single color, no two constraints may share a particle, or
 * their position writes would race. These tests assert exactly that invariant,
 * plus that no constraint is lost or duplicated by the reordering.
 */

/** Assert that no color block contains two edges sharing a vertex. */
function assertVertexDisjointPerColor(
  ordered: Edge[],
  colorOffsets: number[],
  colorCounts: number[],
): void {
  for (let c = 0; c < colorOffsets.length; c++) {
    const start = colorOffsets[c]!;
    const end = start + colorCounts[c]!;
    const seen = new Set<number>();
    for (let k = start; k < end; k++) {
      const e = ordered[k]!;
      expect(seen.has(e.i), `color ${c} reuses particle ${e.i}`).toBe(false);
      expect(seen.has(e.j), `color ${c} reuses particle ${e.j}`).toBe(false);
      seen.add(e.i);
      seen.add(e.j);
    }
  }
}

/** Multiset key so we can compare edge sets ignoring order/orientation. */
const edgeKey = (e: Edge): string => {
  const [a, b] = e.i < e.j ? [e.i, e.j] : [e.j, e.i];
  return `${a}-${b}:${e.rest}`;
};

describe('colorConstraints', () => {
  it('produces vertex-disjoint colors on a hand-built fan graph', () => {
    // A star: particle 0 shares every edge, so each edge needs its own color.
    const edges: Edge[] = [
      { i: 0, j: 1, rest: 1 },
      { i: 0, j: 2, rest: 1 },
      { i: 0, j: 3, rest: 1 },
      { i: 0, j: 4, rest: 1 },
    ];
    const { ordered, colorOffsets, colorCounts } = colorConstraints(edges, 5);
    expect(colorOffsets.length).toBe(4); // one color per edge
    assertVertexDisjointPerColor(ordered, colorOffsets, colorCounts);
  });

  it('reuses a single color when edges are already disjoint', () => {
    const edges: Edge[] = [
      { i: 0, j: 1, rest: 1 },
      { i: 2, j: 3, rest: 1 },
      { i: 4, j: 5, rest: 1 },
    ];
    const { colorOffsets } = colorConstraints(edges, 6);
    expect(colorOffsets.length).toBe(1);
  });

  it('preserves every edge exactly once and keeps counts/offsets consistent', () => {
    const edges: Edge[] = [];
    // Two overlapping triangles → forces several colors.
    for (const [i, j] of [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 4],
      [4, 2],
    ] as const) {
      edges.push({ i, j, rest: 1 });
    }
    const { ordered, colorOffsets, colorCounts } = colorConstraints(edges, 5);

    expect(ordered.length).toBe(edges.length);
    expect(colorCounts.reduce((a, b) => a + b, 0)).toBe(edges.length);
    for (let c = 0; c < colorOffsets.length; c++) {
      const expected = c === 0 ? 0 : colorOffsets[c - 1]! + colorCounts[c - 1]!;
      expect(colorOffsets[c]).toBe(expected);
    }

    // Same multiset in, same multiset out.
    const inKeys = edges.map(edgeKey).sort();
    const outKeys = ordered.map(edgeKey).sort();
    expect(outKeys).toEqual(inKeys);

    assertVertexDisjointPerColor(ordered, colorOffsets, colorCounts);
  });

  it('handles an empty constraint set', () => {
    const { ordered, colorOffsets, colorCounts } = colorConstraints([], 0);
    expect(ordered).toEqual([]);
    expect(colorOffsets).toEqual([]);
    expect(colorCounts).toEqual([]);
  });
});
