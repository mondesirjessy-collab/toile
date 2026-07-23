import type { ClothMeshData } from '../cloth/ClothMesh';
import { ConstraintKind } from '../solver/ConstraintGraph';

export interface BodySafeSeamPlacementOptions {
  bodyDistance: (x: number, y: number, z: number) => number;
  clearance: number;
}

type Point = [number, number, number];

/** Project one point onto the requested exterior body isosurface. */
function projectOutsideBody(
  point: Point,
  fallbackAnchor: Point,
  targetDistance: number,
  bodyDistance: BodySafeSeamPlacementOptions['bodyDistance'],
): Point {
  const result: Point = [...point];
  const epsilon = 0.002;
  for (let iteration = 0; iteration < 18; iteration++) {
    const distance = bodyDistance(result[0], result[1], result[2]);
    if (distance >= targetDistance) return result;
    const gx =
      bodyDistance(result[0] + epsilon, result[1], result[2]) -
      bodyDistance(result[0] - epsilon, result[1], result[2]);
    const gy =
      bodyDistance(result[0], result[1] + epsilon, result[2]) -
      bodyDistance(result[0], result[1] - epsilon, result[2]);
    const gz =
      bodyDistance(result[0], result[1], result[2] + epsilon) -
      bodyDistance(result[0], result[1], result[2] - epsilon);
    const gradientLength = Math.hypot(gx, gy, gz) / (2 * epsilon);
    if (!Number.isFinite(gradientLength) || gradientLength < 1e-4) break;
    const correction = Math.min(
      0.08,
      Math.max(0.001, (targetDistance - distance) / Math.max(gradientLength, 0.25)),
    );
    result[0] += (gx / (2 * epsilon * gradientLength)) * correction;
    result[1] += (gy / (2 * epsilon * gradientLength)) * correction;
    result[2] += (gz / (2 * epsilon * gradientLength)) * correction;
  }
  if (bodyDistance(result[0], result[1], result[2]) >= targetDistance) {
    return result;
  }

  // The exact centre of a symmetric collider has no usable gradient. The
  // original front endpoint is known to live on a dressing plane; continue on
  // that ray until it reaches the same exterior isosurface.
  let dx = fallbackAnchor[0] - point[0];
  let dy = fallbackAnchor[1] - point[1];
  let dz = fallbackAnchor[2] - point[2];
  let directionLength = Math.hypot(dx, dy, dz);
  if (directionLength < 1e-8) {
    dx = 0;
    dy = 0;
    dz = 1;
    directionLength = 1;
  }
  dx /= directionLength;
  dy /= directionLength;
  dz /= directionLength;
  let inside = 0;
  let outside = 0;
  while (outside < 1 && bodyDistance(
    point[0] + dx * outside,
    point[1] + dy * outside,
    point[2] + dz * outside,
  ) < targetDistance) {
    inside = outside;
    outside += 0.004;
  }
  for (let iteration = 0; iteration < 12; iteration++) {
    const middle = (inside + outside) * 0.5;
    const distance = bodyDistance(
      point[0] + dx * middle,
      point[1] + dy * middle,
      point[2] + dz * middle,
    );
    if (distance >= targetDistance) outside = middle;
    else inside = middle;
  }
  return [
    point[0] + dx * outside,
    point[1] + dy * outside,
    point[2] + dz * outside,
  ];
}

/**
 * Pre-close the canonical front/back mirror stitches on the exterior body
 * surface. This is a dressing placement only: constraints/rest lengths remain
 * untouched and body collision keeps final positional authority.
 *
 * Flat panels put a mirror pair on opposite sides of the avatar. Its symmetric
 * seam then takes the shortest path through a torso/arm and the final collision
 * correctly separates it again. Starting the same pair at its sewn rest length
 * on one body isosurface makes both endpoints receive the same collision
 * projection. Other seams (darts, gathered joins, overlays) are not altered.
 */
export function preCloseBodySafeMirrorSeams(
  mesh: Pick<
    ClothMeshData,
    | 'resolution'
    | 'count'
    | 'positions'
    | 'invMasses'
    | 'constraintData'
    | 'constraintCount'
  >,
  options: BodySafeSeamPlacementOptions,
): number {
  const panelSize = mesh.resolution * mesh.resolution;
  const view = new DataView(mesh.constraintData);
  const clearance = Math.max(0, options.clearance);
  let closed = 0;

  for (let constraint = 0; constraint < mesh.constraintCount; constraint++) {
    const offset = constraint * 16;
    if (view.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
    const i = view.getUint32(offset, true);
    const j = view.getUint32(offset + 4, true);
    if (
      i >= mesh.count ||
      j >= mesh.count ||
      Math.abs(i - j) !== panelSize ||
      i % panelSize !== j % panelSize ||
      (mesh.invMasses[i]! <= 0 && mesh.invMasses[j]! <= 0)
    ) {
      continue;
    }
    const xi: Point = [
      mesh.positions[i * 4]!,
      mesh.positions[i * 4 + 1]!,
      mesh.positions[i * 4 + 2]!,
    ];
    const xj: Point = [
      mesh.positions[j * 4]!,
      mesh.positions[j * 4 + 1]!,
      mesh.positions[j * 4 + 2]!,
    ];
    const midpoint: Point = [
      (xi[0] + xj[0]) * 0.5,
      (xi[1] + xj[1]) * 0.5,
      (xi[2] + xj[2]) * 0.5,
    ];
    const rest = Math.max(0, view.getFloat32(offset + 8, true));
    const target = projectOutsideBody(
      midpoint,
      xi,
      clearance + rest,
      options.bodyDistance,
    );
    let nx = xi[0] - xj[0];
    let ny = xi[1] - xj[1];
    let nz = xi[2] - xj[2];
    const pairLength = Math.hypot(nx, ny, nz);
    if (pairLength < 1e-8) {
      nx = 0;
      ny = 0;
      nz = 1;
    } else {
      nx /= pairLength;
      ny /= pairLength;
      nz /= pairLength;
    }
    const halfRest = rest * 0.5;
    mesh.positions[i * 4] = target[0] + nx * halfRest;
    mesh.positions[i * 4 + 1] = target[1] + ny * halfRest;
    mesh.positions[i * 4 + 2] = target[2] + nz * halfRest;
    mesh.positions[j * 4] = target[0] - nx * halfRest;
    mesh.positions[j * 4 + 1] = target[1] - ny * halfRest;
    mesh.positions[j * 4 + 2] = target[2] - nz * halfRest;
    closed++;
  }
  return closed;
}
