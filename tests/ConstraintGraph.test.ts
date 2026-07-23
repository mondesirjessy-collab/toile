import { describe, it, expect } from 'vitest';
import { colorConstraints, ConstraintKind, type Edge } from '../src/engine/solver/ConstraintGraph';

/**
 * The coloring is the correctness guarantee for GPU-parallel solving (brief
 * §3.4): within a single color, no two constraints may share a particle, or
 * their position writes would race. These tests assert exactly that invariant,
 * that no constraint is lost or duplicated by the reordering, and that the
 * per-constraint kind (stretch vs bending) survives it.
 */

/** Build an edge, defaulting rest/kind so fixtures stay terse. */
const e = (i: number, j: number, kind: ConstraintKind = ConstraintKind.Structural, rest = 1): Edge => ({
  i,
  j,
  rest,
  kind,
});

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
      const edge = ordered[k]!;
      expect(seen.has(edge.i), `color ${c} reuses particle ${edge.i}`).toBe(false);
      expect(seen.has(edge.j), `color ${c} reuses particle ${edge.j}`).toBe(false);
      seen.add(edge.i);
      seen.add(edge.j);
    }
  }
}

/** Multiset key so we can compare edge sets ignoring order/orientation. */
const edgeKey = (edge: Edge): string => {
  const [a, b] = edge.i < edge.j ? [edge.i, edge.j] : [edge.j, edge.i];
  return `${a}-${b}:${edge.rest}:${edge.kind}`;
};

describe('colorConstraints', () => {
  it('produces vertex-disjoint colors on a hand-built fan graph', () => {
    // A star: particle 0 shares every edge, so each edge needs its own color.
    const edges = [e(0, 1), e(0, 2), e(0, 3), e(0, 4)];
    const { ordered, colorOffsets, colorCounts } = colorConstraints(edges, 5);
    expect(colorOffsets.length).toBe(4); // one color per edge
    assertVertexDisjointPerColor(ordered, colorOffsets, colorCounts);
  });

  it('reuses a single color when edges are already disjoint', () => {
    const edges = [e(0, 1), e(2, 3), e(4, 5)];
    const { colorOffsets } = colorConstraints(edges, 6);
    expect(colorOffsets.length).toBe(1);
  });

  it('preserves every edge exactly once and keeps counts/offsets consistent', () => {
    // Two overlapping triangles with mixed structural and bending kinds, so the
    // preservation check also covers the kind field.
    const edges = [
      e(0, 1, ConstraintKind.Structural),
      e(1, 2, ConstraintKind.Structural),
      e(2, 0, ConstraintKind.Structural),
      e(2, 3, ConstraintKind.Bending),
      e(3, 4, ConstraintKind.Bending),
      e(4, 2, ConstraintKind.Bending),
    ];
    const { ordered, colorOffsets, colorCounts } = colorConstraints(edges, 5);

    expect(ordered.length).toBe(edges.length);
    expect(colorCounts.reduce((a, b) => a + b, 0)).toBe(edges.length);
    for (let c = 0; c < colorOffsets.length; c++) {
      const expected = c === 0 ? 0 : colorOffsets[c - 1]! + colorCounts[c - 1]!;
      expect(colorOffsets[c]).toBe(expected);
    }

    // Same multiset in, same multiset out (rest + compliance included).
    expect(ordered.map(edgeKey).sort()).toEqual(edges.map(edgeKey).sort());

    assertVertexDisjointPerColor(ordered, colorOffsets, colorCounts);
  });

  it('projects regular and surface stitches in a terminal solver phase', () => {
    // Deliberately put stitches first in input order. The coloring contract must
    // still place every weave/bend edge before them, and must recolor stitches
    // among themselves when they share a junction particle.
    const edges = [
      e(0, 4, ConstraintKind.Seam),
      e(0, 1, ConstraintKind.Structural),
      e(1, 2, ConstraintKind.Shear),
      e(0, 5, ConstraintKind.SurfaceSeam),
      e(2, 3, ConstraintKind.Bending),
      e(6, 7, ConstraintKind.Seam),
      e(4, 7, ConstraintKind.AttachmentSeam),
    ];
    const { ordered, colorOffsets, colorCounts, phaseColorRanges } = colorConstraints(edges, 8);
    const stitch = (edge: Edge): boolean =>
      edge.kind === ConstraintKind.Seam ||
      edge.kind === ConstraintKind.AttachmentSeam ||
      edge.kind === ConstraintKind.SurfaceSeam;
    const firstStitch = ordered.findIndex(stitch);

    expect(firstStitch).toBeGreaterThan(0);
    expect(ordered.slice(0, firstStitch).every((edge) => !stitch(edge))).toBe(true);
    expect(ordered.slice(firstStitch).every(stitch)).toBe(true);
    const seamStart = colorOffsets[phaseColorRanges.seam.first]!;
    const surfaceStart = colorOffsets[phaseColorRanges.surfaceSeam.first]!;
    expect(ordered.slice(0, seamStart).every((edge) => !stitch(edge))).toBe(true);
    expect(
      ordered
        .slice(seamStart, surfaceStart)
        .every(
          (edge) =>
            edge.kind === ConstraintKind.Seam ||
            edge.kind === ConstraintKind.AttachmentSeam,
        ),
    ).toBe(true);
    expect(
      ordered
        .slice(surfaceStart)
        .every((edge) => edge.kind === ConstraintKind.SurfaceSeam),
    ).toBe(true);
    expect(phaseColorRanges.ordinary.first).toBe(0);
    expect(phaseColorRanges.seam.first).toBe(
      phaseColorRanges.ordinary.count,
    );
    expect(phaseColorRanges.surfaceSeam.first).toBe(
      phaseColorRanges.seam.first + phaseColorRanges.seam.count,
    );
    // No ordinary constraint may execute after a stitch and reopen either of
    // its endpoints. Shared stitches remain safe through their own coloring.
    for (let k = firstStitch; k < ordered.length; k++) {
      const seam = ordered[k]!;
      for (let later = k + 1; later < ordered.length; later++) {
        const edge = ordered[later]!;
        if (!stitch(edge)) {
          expect([edge.i, edge.j]).not.toContain(seam.i);
          expect([edge.i, edge.j]).not.toContain(seam.j);
        }
      }
    }
    expect(ordered.map(edgeKey).sort()).toEqual(edges.map(edgeKey).sort());
    assertVertexDisjointPerColor(ordered, colorOffsets, colorCounts);
    expect(ConstraintKind.AttachmentSeam).toBe(6);
  });

  it('handles an empty constraint set', () => {
    const { ordered, colorOffsets, colorCounts, phaseColorRanges } = colorConstraints([], 0);
    expect(ordered).toEqual([]);
    expect(colorOffsets).toEqual([]);
    expect(colorCounts).toEqual([]);
    expect(phaseColorRanges).toEqual({
      ordinary: { first: 0, count: 0 },
      seam: { first: 0, count: 0 },
      surfaceSeam: { first: 0, count: 0 },
    });
  });
});
