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

/**
 * Small world-space floor for coarse pattern grids. At ordinary working
 * distances the 10 CSS-pixel cone below remains authoritative, so a visually
 * empty gap is not magnetised to a piece several dozen pixels away.
 */
export const STAGING_PICK_RADIUS = 0.04;
/** Minimum visual tolerance promised by C4-2, expressed in CSS pixels. */
export const STAGING_PICK_RADIUS_PX = 10;

/** A contiguous particle span carrying the identity needed by its caller. */
export interface TaggedParticleRange<Tag> {
  first: number;
  count: number;
  tag: Tag;
}

/** A particle hit together with the identity of the range that owns it. */
export interface TaggedPick<Tag> extends Pick {
  tag: Tag;
}

/**
 * Pick the visually frontmost movable particle from explicit particle ranges.
 *
 * Unlike `pickParticle`, this deliberately prioritises depth once a particle
 * lies inside the pick cylinder. That makes overlapping flat pieces behave
 * like what the user sees: the front piece wins. Iterating the supplied ranges
 * directly also prevents unrelated cloth or system-generated geometry from
 * masking an otherwise valid pattern piece. `minPickSlope` is the world-space
 * radius gained per unit of ray depth for a screen-space tolerance. Combining
 * it with `maxPickDist` keeps nearby/coarse grids easy to grab while ensuring
 * that zooming the camera out never shrinks the target below the promised
 * number of CSS pixels.
 */
export function pickFrontmostInRanges<Tag>(
  positions: Float32Array,
  count: number,
  ranges: readonly TaggedParticleRange<Tag>[],
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxPickDist = STAGING_PICK_RADIUS,
  movable?: (i: number) => boolean,
  minPickSlope = 0,
): TaggedPick<Tag> | null {
  const available = Math.floor(positions.length / 4);
  const limit = Math.min(
    available,
    Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
  );
  if (limit === 0 || !Number.isFinite(maxPickDist) || maxPickDist < 0) {
    return null;
  }

  const safePickSlope =
    Number.isFinite(minPickSlope) && minPickSlope > 0 ? minPickSlope : 0;
  let best: TaggedPick<Tag> | null = null;
  let bestPerp2 = Number.POSITIVE_INFINITY;

  for (const range of ranges) {
    if (
      !Number.isFinite(range.first) ||
      !Number.isFinite(range.count) ||
      range.count <= 0
    ) {
      continue;
    }
    const rawFirst = Math.trunc(range.first);
    const rawEnd = rawFirst + Math.trunc(range.count);
    const first = Math.max(0, Math.min(limit, rawFirst));
    const end = Math.max(first, Math.min(limit, rawEnd));

    for (let i = first; i < end; i++) {
      if (movable && !movable(i)) continue;
      const vx = positions[i * 4 + 0]! - origin[0];
      const vy = positions[i * 4 + 1]! - origin[1];
      const vz = positions[i * 4 + 2]! - origin[2];
      const depth = vx * dir[0] + vy * dir[1] + vz * dir[2];
      if (!Number.isFinite(depth) || depth <= 0) continue;
      const perp2 = Math.max(
        0,
        vx * vx + vy * vy + vz * vz - depth * depth,
      );
      const screenRadius = depth * safePickSlope;
      const allowedRadius = Math.max(maxPickDist, screenRadius);
      if (
        !Number.isFinite(perp2) ||
        perp2 > allowedRadius * allowedRadius
      ) {
        continue;
      }

      if (
        !best ||
        depth < best.depth ||
        (depth === best.depth && perp2 < bestPerp2)
      ) {
        best = { index: i, depth, tag: range.tag };
        bestPerp2 = perp2;
      }
    }
  }

  return best;
}

export function pickParticle(
  positions: Float32Array,
  count: number,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  maxPickDist = 0.12,
  movable?: (i: number) => boolean,
  minPickSlope = 0,
): Pick | null {
  const safeSlope = Number.isFinite(minPickSlope) && minPickSlope > 0 ? minPickSlope : 0;
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
    const screenR = t * safeSlope;
    const allowed = Math.max(maxPickDist, screenR);
    if (perp2 < allowed * allowed && perp2 < bestPerp2) {
      bestPerp2 = perp2;
      best = { index: i, depth: t };
    }
  }
  return best;
}

/** Find the nearest movable particle to a 3D position (for redirecting a
 *  pinned-particle hit to its closest grabbable neighbor). */
export function nearestMovableParticle(
  positions: Float32Array,
  count: number,
  pos: readonly [number, number, number],
  maxDist: number,
  movable: (i: number) => boolean,
): number | null {
  let best: number | null = null;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < count; i++) {
    if (!movable(i)) continue;
    const dx = positions[i * 4 + 0]! - pos[0];
    const dy = positions[i * 4 + 1]! - pos[1];
    const dz = positions[i * 4 + 2]! - pos[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}
