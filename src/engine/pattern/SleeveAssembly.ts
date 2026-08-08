/**
 * SleeveAssembly — exact body-armhole ↔ sleeve-cap joins.
 *
 * The body front and back keep independent armhole rims. Each rim is sewn to
 * the matching sleeve panel; the two body rims are never welded to each other.
 * This is the manifold topology of a real set-in sleeve.
 */
import type { ClothMeshData, CrossSeam } from '../cloth/ClothMesh';
import type { BodyMeasure } from '../body/measure';
import { sideOpeningCells, type DraftPiece } from './Draft';

function capCells(mesh: ClothMeshData, panel: number, n: number): number[] {
  const ps = n * n;
  const off = panel * ps;
  const cap: number[] = [];
  // A freeform cap may cut away its first rows. Its mouth is the first live
  // particle in every column; for a rectangular sleeve this is simply row 0.
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      const local = v * n + u;
      if (mesh.invMasses[off + local]! > 0) {
        cap.push(local);
        break;
      }
    }
  }
  return cap;
}

/**
 * Sew a two-panel sleeve mesh to the explicit left/right openings of the body.
 * The seam covers every cell of the longer rim (the shorter repeats = embu).
 */
export function sleeveCrossSeams(
  base: ClothMeshData,
  sleeve: ClothMeshData,
  front: DraftPiece,
  back: DraftPiece,
  side: 'L' | 'R',
  n: number,
  tPose = false,
): CrossSeam[] {
  const ps = n * n;
  const faces = [front, back] as const;
  const cross: CrossSeam[] = [];
  for (let panel = 0; panel < 2; panel++) {
    const armhole = sideOpeningCells(faces[panel]!, side, n);
    const cap = capCells(sleeve, panel, n);
    if (!armhole.length || !cap.length) continue;
    const m = Math.max(armhole.length, cap.length);
    for (let k = 0; k < m; k++) {
      const bodyLocal = armhole[Math.min(armhole.length - 1, Math.floor((k * armhole.length) / m))]!;
      const capK = Math.min(cap.length - 1, Math.floor((k * cap.length) / m));
      // In a scan T-pose the right tube's +u axis points upward in world Y,
      // while armholes are ordered top→bottom. Reverse that one cap to avoid a
      // half twist; preserve the proven A-pose mapping.
      const sleeveLocal = cap[tPose && side === 'R' ? cap.length - 1 - capK : capK]!;
      cross.push({ i: panel * ps + bodyLocal, j: base.count + panel * ps + sleeveLocal });
    }
  }
  return cross;
}

/** Place an editable wrap sleeve around the measured arm axis. */
export function placeWrapSleeve(
  mesh: ClothMeshData,
  piece: DraftPiece,
  side: 'L' | 'R',
  body: BodyMeasure,
  tPose: boolean,
): void {
  const sign = side === 'R' ? 1 : -1;
  let theta = Math.atan2(0.11 * (piece.height / 0.5) * sign, piece.height);
  if (tPose) {
    // Follow the measured shoulder→wrist slope. Historical horizontal scans
    // still yield ±π/2; a clean low A-pose yields about ±35°, so the
    // sleeve starts around the real arm instead of cutting across it.
    const path = body.arm?.path;
    if (path && path.length >= 2) {
      const first = path[0]!;
      const last = path[path.length - 1]!;
      const lateral = Math.max(1e-6, last.x - first.x);
      const downward = first.y - last.y;
      theta = sign * Math.atan2(lateral, downward);
    } else {
      theta = sign * (Math.PI / 2);
    }
  }
  const pivotY = tPose ? (body.arm ? body.arm.y : piece.topY - 0.06) : piece.topY;
  const pivotX = (tPose && body.arm ? body.arm.rootX + 0.06 : body.shoulderHalfW) * sign;
  const pivotZ = tPose && body.arm ? body.arm.z : 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (let q = 0; q < mesh.count; q++) {
    const px = mesh.positions[q * 4]!;
    const py = mesh.positions[q * 4 + 1]! - pivotY;
    mesh.positions[q * 4] = px * cos - py * sin + pivotX;
    mesh.positions[q * 4 + 1] = px * sin + py * cos + pivotY;
    mesh.positions[q * 4 + 2] = mesh.positions[q * 4 + 2]! + pivotZ;
  }
}
