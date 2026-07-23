import type { ClothMeshData } from '../cloth/ClothMesh';

export interface KimonoSleevePlacementOptions {
  /** Signed distance to the exact avatar collider (metres). */
  bodyDistance: (x: number, y: number, z: number) => number;
  /** Initial air gap requested between skin and cloth (metres). */
  clearance: number;
}

type CrossSection = {
  y: number;
  z: number;
  distance: number;
};

const KIMONO_BODY_HALF = 0.24;
const CENTRE_REFINEMENTS = 7;
const CLEARANCE_MARGIN = 0.00025;

/**
 * Locate the medial point of the body section at one sleeve column.
 *
 * A scan arm is not necessarily centred on z=0 (the male scan is roughly
 * 9–12 cm behind it). Minimising its signed distance in the local YZ window
 * finds the real arm axis without assuming a particular avatar or pose.
 */
function findCrossSection(
  x: number,
  guessY: number,
  guessZ: number,
  paperArc: number,
  bodyDistance: KimonoSleevePlacementOptions['bodyDistance'],
): CrossSection | undefined {
  const yRadius = Math.max(0.13, paperArc * 0.9);
  const zRadius = Math.max(0.22, paperArc * 1.1);
  let best: CrossSection | undefined;

  // The coarse pass is deliberately rectangular: horizontal/T-pose arms can
  // sit well behind the original pattern plane while their Y axis remains
  // close to the drafted sleeve band.
  const ySteps = 10;
  const zSteps = 14;
  for (let iy = 0; iy <= ySteps; iy++) {
    const y = guessY - yRadius + (2 * yRadius * iy) / ySteps;
    for (let iz = 0; iz <= zSteps; iz++) {
      const z = guessZ - zRadius + (2 * zRadius * iz) / zSteps;
      const distance = bodyDistance(x, y, z);
      if (!Number.isFinite(distance)) continue;
      if (!best || distance < best.distance) best = { y, z, distance };
    }
  }
  if (!best || best.distance >= 0) return undefined;

  // Deterministic coordinate refinement. Nine samples per pass are enough
  // because a true signed-distance field has its most negative point on the
  // cross-section medial axis.
  let stepY = (2 * yRadius) / ySteps;
  let stepZ = (2 * zRadius) / zSteps;
  for (let pass = 0; pass < CENTRE_REFINEMENTS; pass++) {
    const seed: CrossSection = best;
    for (const dy of [-stepY, 0, stepY]) {
      for (const dz of [-stepZ, 0, stepZ]) {
        const candidateY: number = seed.y + dy;
        const candidateZ: number = seed.z + dz;
        const distance = bodyDistance(x, candidateY, candidateZ);
        if (Number.isFinite(distance) && distance < best.distance) {
          best = { y: candidateY, z: candidateZ, distance };
        }
      }
    }
    stepY *= 0.5;
    stepZ *= 0.5;
  }
  return best;
}

/** First crossing of the requested body isosurface along a YZ ray. */
function clearanceRadius(
  x: number,
  centre: CrossSection,
  directionY: number,
  directionZ: number,
  initialRadius: number,
  targetDistance: number,
  bodyDistance: KimonoSleevePlacementOptions['bodyDistance'],
): number | undefined {
  const at = (radius: number): number =>
    bodyDistance(
      x,
      centre.y + directionY * radius,
      centre.z + directionZ * radius,
    );

  let inside = 0;
  let outside = Math.max(0.012, initialRadius);
  let distance = at(outside);
  if (!Number.isFinite(distance)) return undefined;
  while (distance < targetDistance && outside < 0.6) {
    inside = outside;
    outside += 0.004;
    distance = at(outside);
    if (!Number.isFinite(distance)) return undefined;
  }
  if (distance < targetDistance) return undefined;

  for (let iteration = 0; iteration < 14; iteration++) {
    const middle = (inside + outside) * 0.5;
    const middleDistance = at(middle);
    if (!Number.isFinite(middleDistance)) return undefined;
    if (middleDistance >= targetDistance) outside = middle;
    else inside = middle;
  }
  return outside;
}

/**
 * Anatomically pre-wrap only the integral sleeves of a canonical kimono tee.
 *
 * Every sleeve column is treated as a cross-section perpendicular to X. Its
 * live top/bottom rows become the shared endpoints of two semicircles: front
 * panel on +Z, back panel on −Z, both centred on the arm found in the avatar
 * SDF. X coordinates and every constraint/rest length remain untouched. The
 * torso (|u−0.5| <= 0.24), neckline and hem are therefore byte-for-byte
 * unchanged by this dressing-only operation.
 *
 * Returns the number of sleeve columns that found a real body section and
 * were wrapped. A missing arm section is left alone instead of snapping cloth
 * to an unrelated body part.
 */
export function preWrapKimonoSleeves(
  mesh: Pick<
    ClothMeshData,
    'resolution' | 'count' | 'positions' | 'invMasses'
  >,
  options: KimonoSleevePlacementOptions,
): number {
  const n = mesh.resolution;
  const panelSize = n * n;
  if (n < 2 || mesh.count < 2 * panelSize) return 0;

  const clearance = Math.max(0, options.clearance);
  const targetDistance = clearance + CLEARANCE_MARGIN;
  let wrappedColumns = 0;

  for (let u = 0; u < n; u++) {
    const normalizedU = u / (n - 1);
    if (Math.abs(normalizedU - 0.5) <= KIMONO_BODY_HALF) continue;

    let vMin = -1;
    let vMax = -1;
    for (let v = 0; v < n; v++) {
      const local = v * n + u;
      if (
        mesh.invMasses[local]! <= 0 ||
        mesh.invMasses[panelSize + local]! <= 0
      ) {
        continue;
      }
      if (vMin < 0) vMin = v;
      vMax = v;
    }
    if (vMin < 0 || vMax <= vMin) continue;

    const top = vMin * n + u;
    const bottom = vMax * n + u;
    const topY = mesh.positions[top * 4 + 1]!;
    const bottomY = mesh.positions[bottom * 4 + 1]!;
    const paperArc = Math.abs(topY - bottomY);
    if (paperArc < 1e-6) continue;

    // Preserve every particle's own X below. The column average is used only
    // for SDF sampling; edge-smoothed cut vertices can differ by a fraction of
    // one grid cell at the cuff/underarm boundary.
    let xSum = 0;
    let zSum = 0;
    let liveRows = 0;
    for (let v = vMin; v <= vMax; v++) {
      const local = v * n + u;
      if (
        mesh.invMasses[local]! <= 0 ||
        mesh.invMasses[panelSize + local]! <= 0
      ) {
        continue;
      }
      xSum += mesh.positions[local * 4]!;
      zSum +=
        (mesh.positions[local * 4 + 2]! +
          mesh.positions[(panelSize + local) * 4 + 2]!) *
        0.5;
      liveRows++;
    }
    if (liveRows < 2) continue;

    const sampleX = xSum / liveRows;
    const centre = findCrossSection(
      sampleX,
      (topY + bottomY) * 0.5,
      zSum / liveRows,
      paperArc,
      options.bodyDistance,
    );
    if (!centre) continue;

    const paperRadius = paperArc / Math.PI;
    let radius = paperRadius;
    const requiredAtAngle = (angle: number): boolean => {
      const required = clearanceRadius(
        sampleX,
        centre,
        Math.cos(angle),
        Math.sin(angle),
        paperRadius,
        targetDistance,
        options.bodyDistance,
      );
      if (required === undefined) return false;
      radius = Math.max(radius, required);
      return true;
    };

    // A uniform radius retains a clean, non-intersecting tube. Sample the full
    // arm section plus every exact row angle so all placed vertices satisfy the
    // requested clearance even on an elliptical/asymmetric scan.
    const radialSamples = Math.max(32, 2 * liveRows);
    let validSection = true;
    for (let sample = 0; sample < radialSamples; sample++) {
      if (!requiredAtAngle((2 * Math.PI * sample) / radialSamples)) {
        validSection = false;
        break;
      }
    }
    if (!validSection) continue;
    for (let v = vMin; v <= vMax; v++) {
      const local = v * n + u;
      if (
        mesh.invMasses[local]! <= 0 ||
        mesh.invMasses[panelSize + local]! <= 0
      ) {
        continue;
      }
      const originalY = mesh.positions[local * 4 + 1]!;
      const fraction = Math.min(
        1,
        Math.max(0, (topY - originalY) / paperArc),
      );
      if (!requiredAtAngle(Math.PI * fraction)) {
        validSection = false;
        break;
      }
      if (!requiredAtAngle(-Math.PI * fraction)) {
        validSection = false;
        break;
      }
    }
    if (!validSection) continue;

    for (const [panel, hemisphere] of [[0, 1], [1, -1]] as const) {
      for (let v = vMin; v <= vMax; v++) {
        const local = v * n + u;
        const particle = panel * panelSize + local;
        if (mesh.invMasses[particle]! <= 0) continue;
        const originalY = mesh.positions[particle * 4 + 1]!;
        const fraction = Math.min(
          1,
          Math.max(0, (topY - originalY) / paperArc),
        );
        const angle = Math.PI * fraction;
        mesh.positions[particle * 4 + 1] = centre.y + radius * Math.cos(angle);
        mesh.positions[particle * 4 + 2] =
          fraction <= 1e-8 || fraction >= 1 - 1e-8
            ? centre.z
            : centre.z + hemisphere * radius * Math.sin(angle);
      }
    }
    wrappedColumns++;
  }

  return wrappedColumns;
}
