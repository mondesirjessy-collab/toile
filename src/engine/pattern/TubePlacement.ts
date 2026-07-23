import type { ClothMeshData } from '../cloth/ClothMesh';

export interface TwoPanelTubeWrapOptions {
  /** Signed distance to the body used by the solver (metres). */
  bodyDistance?: (x: number, y: number, z: number) => number;
  /** Requested initial air gap outside that body field (metres). */
  clearance?: number;
}

/**
 * Pre-wrap a regular two-panel pattern into one continuous cylindrical tube.
 *
 * Flat front/back panels spawn on opposite sides of the avatar. A side-stitch
 * projected between those two faces can cross the body, after which the body
 * collision necessarily opens it again. Mapping each row to two matching
 * semicircles makes the paired side cells coincident before simulation while
 * preserving the row's flat length as the semicircle arc length.
 *
 * Row-local live bounds also support tapered/cut tubes. This mutates only the
 * spawn positions; structural rest lengths and the editable 2D pattern remain
 * unchanged.
 */
export function preWrapTwoPanelTube(
  mesh: Pick<
    ClothMeshData,
    'resolution' | 'count' | 'positions' | 'invMasses'
  >,
  options: TwoPanelTubeWrapOptions = {},
): void {
  const n = mesh.resolution;
  const panelSize = n * n;
  if (n < 2 || mesh.count < 2 * panelSize) return;

  for (let v = 0; v < n; v++) {
    let uMin = -1;
    let uMax = -1;
    for (let u = 0; u < n; u++) {
      const local = v * n + u;
      if (
        mesh.invMasses[local]! <= 0 ||
        mesh.invMasses[panelSize + local]! <= 0
      ) {
        continue;
      }
      if (uMin < 0) uMin = u;
      uMax = u;
    }
    if (uMin < 0 || uMax < 0) continue;

    const first = v * n + uMin;
    const last = v * n + uMax;
    const firstX = mesh.positions[first * 4]!;
    const lastX = mesh.positions[last * 4]!;
    const centreX = (firstX + lastX) * 0.5;
    const centreZ =
      (mesh.positions[first * 4 + 2]! +
        mesh.positions[(panelSize + first) * 4 + 2]!) *
      0.5;
    const span = Math.abs(lastX - firstX);
    const radius = span / Math.PI;
    const columns = Math.max(1, uMax - uMin);
    const clearance = Math.max(0, options.clearance ?? 0);

    /** Keep the natural paper radius whenever it is already outside. If that
     * sample lies in the exact body field, march outward on the same anatomical
     * ray and refine its first clearance crossing. This preserves front/back
     * hemispheres even around asymmetric scans, unlike a collision projection
     * started deep inside the torso where the nearest side can flip by cell. */
    const safeRadius = (
      directionX: number,
      directionZ: number,
    ): number => {
      const bodyDistance = options.bodyDistance;
      if (!bodyDistance) return radius;
      const distanceAt = (candidate: number): number =>
        bodyDistance(
          centreX + directionX * candidate,
          mesh.positions[first * 4 + 1]!,
          centreZ + directionZ * candidate,
        );
      if (distanceAt(radius) >= clearance) return radius;

      const step = 0.004;
      let inside = radius;
      let outside = radius;
      const limit = radius + 1;
      while (outside < limit && distanceAt(outside) < clearance) {
        inside = outside;
        outside += step;
      }
      if (outside >= limit && distanceAt(outside) < clearance) return outside;
      for (let iteration = 0; iteration < 12; iteration++) {
        const middle = (inside + outside) * 0.5;
        if (distanceAt(middle) >= clearance) outside = middle;
        else inside = middle;
      }
      return outside;
    };

    for (let panel = 0; panel < 2; panel++) {
      const zSign = panel === 0 ? 1 : -1;
      for (let u = uMin; u <= uMax; u++) {
        const local = v * n + u;
        const index = panel * panelSize + local;
        if (mesh.invMasses[index]! <= 0) continue;
        const fraction = (u - uMin) / columns;
        const angle = Math.PI * fraction;
        const directionX = -Math.cos(angle);
        const directionZ = zSign * Math.sin(angle);
        const placedRadius = safeRadius(directionX, directionZ);
        mesh.positions[index * 4] = centreX + placedRadius * directionX;
        mesh.positions[index * 4 + 2] =
          centreZ + placedRadius * directionZ;
      }
    }
  }
}
