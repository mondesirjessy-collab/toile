/**
 * Raycast particle picking (brief §4 interaction). Given the read-back particle
 * positions and a world-space cursor ray, find the particle with the smallest
 * perpendicular distance to the ray (in front of the camera), within a screen-ish
 * pick radius. Returns its index and its depth along the ray so the drag can
 * keep it at that depth while the cursor moves.
 */
export interface Pick {
  index: number;
  depth: number; // distance along the ray to the grabbed particle
}

export function pickParticle(
  positions: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxPickDist = 0.12,
  movable?: (i: number) => boolean,
): Pick | null {
  let best: Pick | null = null;
  let bestPerp2 = maxPickDist * maxPickDist;
  for (let i = 0; i < count; i++) {
    if (movable && !movable(i)) continue; // skip pinned/cut particles (M37)
    const vx = positions[i * 4 + 0]! - origin[0];
    const vy = positions[i * 4 + 1]! - origin[1];
    const vz = positions[i * 4 + 2]! - origin[2];
    const t = vx * dir[0] + vy * dir[1] + vz * dir[2];
    if (t <= 0) continue; // behind the camera
    const perp2 = vx * vx + vy * vy + vz * vz - t * t;
    if (perp2 < bestPerp2) {
      bestPerp2 = perp2;
      best = { index: i, depth: t };
    }
  }
  return best;
}
