/**
 * CPU-side inspection of the packed pocket/support contact map.
 *
 * The GPU uses the same 32-byte record. Keeping this pure diagnostic beside
 * the solver makes it possible to reject a bad authored correspondence before
 * it turns into a violent positional projection.
 */
export interface SurfaceContactStats {
  count: number;
  activeCount: number;
  uniqueSupportTriangleCount: number;
  negativeCount: number;
  belowOneMillimeterCount: number;
  degenerateCount: number;
  minSignedDistance: number;
  maxSignedDistance: number;
  meanSignedDistance: number;
}

const STRIDE = 32;

export interface BalancedSurfaceCorrection {
  /** Overlay displacement along the outward normal. */
  overlay: number;
  /** Support-triangle vertex displacements along that same normal. */
  support: [number, number, number];
}

/**
 * Distribute a point/triangle penetration correction without translating the
 * movable system's mass centre when `supportResponse` is 1.
 *
 * This is the CPU reference for the GPU contact kernel. A value below 1 makes
 * the support behave as the much heavier base panel beneath a light appliqué.
 * The point gradient is +1 and the triangle gradients are the negative
 * barycentric weights.
 */
export function distributeBalancedSurfaceCorrection(
  push: number,
  overlayInvMass: number,
  barycentricWeights: readonly [number, number, number],
  supportInvMasses: readonly [number, number, number],
  supportResponse = 1,
): BalancedSurfaceCorrection | null {
  const [w0, w1, w2] = barycentricWeights;
  const [rawM0, rawM1, rawM2] = supportInvMasses;
  const response = Number.isFinite(supportResponse)
    ? Math.max(0, supportResponse)
    : 1;
  const m0 = rawM0 * response;
  const m1 = rawM1 * response;
  const m2 = rawM2 * response;
  const denominator =
    overlayInvMass +
    m0 * w0 * w0 +
    m1 * w1 * w1 +
    m2 * w2 * w2;
  if (
    !Number.isFinite(push) ||
    push <= 0 ||
    !Number.isFinite(denominator) ||
    denominator < 1e-9
  ) {
    return null;
  }
  const multiplier = push / denominator;
  return {
    overlay: overlayInvMass * multiplier,
    support: [
      -m0 * w0 * multiplier,
      -m1 * w1 * multiplier,
      -m2 * w2 * multiplier,
    ],
  };
}

export function measureSurfaceContacts(
  positions: ArrayLike<number>,
  packed: ArrayBuffer | undefined,
  requestedCount: number,
): SurfaceContactStats {
  const available = packed ? Math.floor(packed.byteLength / STRIDE) : 0;
  const count = Math.max(0, Math.min(requestedCount, available));
  const view = packed ? new DataView(packed) : null;
  let activeCount = 0;
  const supportTriangles = new Set<string>();
  let negativeCount = 0;
  let belowOneMillimeterCount = 0;
  let degenerateCount = 0;
  let minSignedDistance = Infinity;
  let maxSignedDistance = -Infinity;
  let sum = 0;

  const point = (index: number): [number, number, number] => [
    Number(positions[index * 4] ?? 0),
    Number(positions[index * 4 + 1] ?? 0),
    Number(positions[index * 4 + 2] ?? 0),
  ];
  const sub = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): [number, number, number] => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  ];

  for (let k = 0; k < count; k++) {
    const base = k * STRIDE;
    if (!view || view.getFloat32(base + 28, true) <= 0.5) continue;
    activeCount++;
    supportTriangles.add(
      `${view.getUint32(base, true)}:${view.getUint32(base + 4, true)}:${view.getUint32(base + 8, true)}`,
    );
    const support = point(view.getUint32(base, true));
    const tangentA = point(view.getUint32(base + 4, true));
    const tangentB = point(view.getUint32(base + 8, true));
    const overlay = point(view.getUint32(base + 12, true));
    const a = sub(tangentA, support);
    const b = sub(tangentB, support);
    const nx = a[1] * b[2] - a[2] * b[1];
    const ny = a[2] * b[0] - a[0] * b[2];
    const nz = a[0] * b[1] - a[1] * b[0];
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) {
      degenerateCount++;
      continue;
    }
    const w0 = view.getFloat32(base + 16, true);
    const wa = view.getFloat32(base + 20, true);
    const wb = view.getFloat32(base + 24, true);
    const sx = support[0] * w0 + tangentA[0] * wa + tangentB[0] * wb;
    const sy = support[1] * w0 + tangentA[1] * wa + tangentB[1] * wb;
    const sz = support[2] * w0 + tangentA[2] * wa + tangentB[2] * wb;
    const signed =
      ((overlay[0] - sx) * nx +
        (overlay[1] - sy) * ny +
        (overlay[2] - sz) * nz) /
      nl;
    if (signed < 0) negativeCount++;
    if (signed < 0.001) belowOneMillimeterCount++;
    minSignedDistance = Math.min(minSignedDistance, signed);
    maxSignedDistance = Math.max(maxSignedDistance, signed);
    sum += signed;
  }

  const measured = activeCount - degenerateCount;
  return {
    count,
    activeCount,
    uniqueSupportTriangleCount: supportTriangles.size,
    negativeCount,
    belowOneMillimeterCount,
    degenerateCount,
    minSignedDistance:
      measured > 0 ? minSignedDistance : Number.POSITIVE_INFINITY,
    maxSignedDistance:
      measured > 0 ? maxSignedDistance : Number.NEGATIVE_INFINITY,
    meanSignedDistance: measured > 0 ? sum / measured : Number.NaN,
  };
}
