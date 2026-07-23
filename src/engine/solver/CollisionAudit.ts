import type { CollisionDistanceSnapshot } from './ParticleSystem';

export interface CollisionAuditZone {
  particleIndex: number;
  x: number;
  y: number;
  z: number;
  depthMm: number;
  signedDistanceMm: number;
  contactOffsetMm: number;
  clearanceMm: number;
}

export interface CollisionAuditReport {
  totalParticles: number;
  sampledParticles: number;
  outsideDomain: number;
  contactParticles: number;
  contactCoveragePct: number;
  penetrating: {
    over0_5mm: number;
    over1mm: number;
    over2mm: number;
    over5mm: number;
  };
  penetratingPct: {
    over0_5mm: number;
    over1mm: number;
    over2mm: number;
    over5mm: number;
  };
  maxDepthMm: number;
  /**
   * Mean `-signedDistance` over the active contact band. Free hems and a
   * flared skirt are intentionally excluded: their centimetres of separation
   * are drape, not a body-contact error. At rest this value is approximately
   * `-contactOffset`, while an actual penetration contributes positively.
   */
  meanDepthMm: number;
  meanClearanceMm: number;
  worstZones: CollisionAuditZone[];
}

export interface CollisionAuditSurfaceReport {
  sampled: number;
  penetrating: number;
  penetratingPct: number;
  maxDepthMm: number;
  meanDepthMm: number;
  worstZones: Array<{
    triangleIndex: number;
    particleIndices: [number, number, number];
    vertices: [[number, number, number], [number, number, number], [number, number, number]];
    sample: 'edge-ab' | 'edge-bc' | 'edge-ca' | 'centroid';
    x: number;
    y: number;
    z: number;
    depthMm: number;
    signedDistanceMm: number;
  }>;
}

/**
 * Version 2 is measured against the body mesh that is actually rendered.
 * Unlike the solver diagnostic above, its mean covers every rendered cloth
 * vertex and its distances are never clamped to the contact band.
 */
export interface VisualCollisionAuditReport extends CollisionAuditReport {
  version: 2;
  metric: 'visual-body-mesh';
  unclamped: true;
  /** Global mean over every finite, rendered cloth vertex. */
  meanDepthMm: number;
  /** Mean retained for the near-body band, useful but not the acceptance KPI. */
  contactMeanDepthMm: number;
  meanSignedDistanceMm: number;
  surfaceSamples: CollisionAuditSurfaceReport;
}

export interface VisualCollisionAuditOptions {
  triangleIndices: Uint32Array;
  /** Signed metres to the exact visible body: negative inside, positive outside. */
  signedDistance(x: number, y: number, z: number): number;
  /** Limit dense midpoint/centroid sampling to target triangles if desired. */
  sampleTriangle?: (
    triangleIndex: number,
    a: number,
    b: number,
    c: number,
  ) => boolean;
}

const CONTACT_SLOP_M = 0.0005;

/** Aggregate one atomic GPU snapshot into the stable public QA contract. */
export function summarizeCollisionAudit(
  snapshot: CollisionDistanceSnapshot,
): CollisionAuditReport {
  const depths: CollisionAuditZone[] = [];
  let totalParticles = 0;
  let sampledParticles = 0;
  let outsideDomain = 0;
  let contactParticles = 0;
  let contactDepthSumMm = 0;
  let contactClearanceSumMm = 0;
  const penetrating = {
    over0_5mm: 0,
    over1mm: 0,
    over2mm: 0,
    over5mm: 0,
  };

  for (let index = 0; index < snapshot.distances.length; index++) {
    const distance = snapshot.distances[index]!;
    if (Number.isNaN(distance)) continue;
    totalParticles++;
    if (!Number.isFinite(distance)) {
      outsideDomain++;
      continue;
    }
    sampledParticles++;
    const depthMm = -distance * 1000;
    const contactOffset = snapshot.contactOffsets[index]!;
    const positionOffset = index * 3;
    depths.push({
      particleIndex: index,
      x: snapshot.positions[positionOffset]!,
      y: snapshot.positions[positionOffset + 1]!,
      z: snapshot.positions[positionOffset + 2]!,
      depthMm,
      signedDistanceMm: distance * 1000,
      contactOffsetMm: contactOffset * 1000,
      clearanceMm: (distance - contactOffset) * 1000,
    });
    if (depthMm > 0.5) penetrating.over0_5mm++;
    if (depthMm > 1) penetrating.over1mm++;
    if (depthMm > 2) penetrating.over2mm++;
    if (depthMm > 5) penetrating.over5mm++;

    if (
      Number.isFinite(contactOffset) &&
      distance <= contactOffset + CONTACT_SLOP_M
    ) {
      contactParticles++;
      contactDepthSumMm += depthMm;
      contactClearanceSumMm += (distance - contactOffset) * 1000;
    }
  }

  depths.sort((a, b) => b.depthMm - a.depthMm);
  const percentage = (count: number): number =>
    totalParticles > 0 ? (count * 100) / totalParticles : 0;
  return {
    totalParticles,
    sampledParticles,
    outsideDomain,
    contactParticles,
    contactCoveragePct: percentage(contactParticles),
    penetrating,
    penetratingPct: {
      over0_5mm: percentage(penetrating.over0_5mm),
      over1mm: percentage(penetrating.over1mm),
      over2mm: percentage(penetrating.over2mm),
      over5mm: percentage(penetrating.over5mm),
    },
    maxDepthMm: depths[0]?.depthMm ?? 0,
    meanDepthMm:
      contactParticles > 0 ? contactDepthSumMm / contactParticles : 0,
    meanClearanceMm:
      contactParticles > 0 ? contactClearanceSumMm / contactParticles : 0,
    worstZones: depths.slice(0, 20),
  };
}

/**
 * Aggregate the same atomic position snapshot against an independent visible
 * mesh query. Referencing `triangleIndices` is deliberate: held/pinned vertices
 * remain visible and must be audited, while cut-away grid particles must not.
 */
export function summarizeVisualCollisionAudit(
  snapshot: CollisionDistanceSnapshot,
  options: VisualCollisionAuditOptions,
): VisualCollisionAuditReport {
  const referenced = new Uint8Array(snapshot.positions.length / 3);
  for (const index of options.triangleIndices) {
    if (index < referenced.length) referenced[index] = 1;
  }

  const depths: CollisionAuditZone[] = [];
  let totalParticles = 0;
  let sampledParticles = 0;
  let outsideDomain = 0;
  let contactParticles = 0;
  let globalDepthSumMm = 0;
  let contactDepthSumMm = 0;
  let contactClearanceSumMm = 0;
  const penetrating = {
    over0_5mm: 0,
    over1mm: 0,
    over2mm: 0,
    over5mm: 0,
  };

  const acceptDistance = (index: number, distance: number): void => {
    totalParticles++;
    if (!Number.isFinite(distance)) {
      outsideDomain++;
      return;
    }
    sampledParticles++;
    const depthMm = -distance * 1000;
    globalDepthSumMm += depthMm;
    const contactOffset = snapshot.contactOffsets[index] ?? Number.NaN;
    const positionOffset = index * 3;
    depths.push({
      particleIndex: index,
      x: snapshot.positions[positionOffset]!,
      y: snapshot.positions[positionOffset + 1]!,
      z: snapshot.positions[positionOffset + 2]!,
      depthMm,
      signedDistanceMm: distance * 1000,
      contactOffsetMm: contactOffset * 1000,
      clearanceMm: (distance - contactOffset) * 1000,
    });
    if (depthMm > 0.5) penetrating.over0_5mm++;
    if (depthMm > 1) penetrating.over1mm++;
    if (depthMm > 2) penetrating.over2mm++;
    if (depthMm > 5) penetrating.over5mm++;
    if (Number.isFinite(contactOffset) && distance <= contactOffset + CONTACT_SLOP_M) {
      contactParticles++;
      contactDepthSumMm += depthMm;
      contactClearanceSumMm += (distance - contactOffset) * 1000;
    }
  };

  for (let index = 0; index < referenced.length; index++) {
    if (referenced[index] === 0) continue;
    const offset = index * 3;
    acceptDistance(
      index,
      options.signedDistance(
        snapshot.positions[offset]!,
        snapshot.positions[offset + 1]!,
        snapshot.positions[offset + 2]!,
      ),
    );
  }

  let surfaceSampled = 0;
  let surfacePenetrating = 0;
  let surfaceMaxDepthMm = Number.NEGATIVE_INFINITY;
  let surfaceDepthSumMm = 0;
  const surfaceDepths: CollisionAuditSurfaceReport['worstZones'] = [];
  const p = snapshot.positions;
  const sample = (
    triangleIndex: number,
    particleIndices: [number, number, number],
    vertices: [[number, number, number], [number, number, number], [number, number, number]],
    kind: CollisionAuditSurfaceReport['worstZones'][number]['sample'],
    x: number,
    y: number,
    z: number,
  ): void => {
    const distance = options.signedDistance(x, y, z);
    if (!Number.isFinite(distance)) return;
    const depthMm = -distance * 1000;
    surfaceSampled++;
    surfaceDepthSumMm += depthMm;
    surfaceMaxDepthMm = Math.max(surfaceMaxDepthMm, depthMm);
    if (depthMm > 0.5) surfacePenetrating++;
    surfaceDepths.push({
      triangleIndex,
      particleIndices,
      vertices,
      sample: kind,
      x,
      y,
      z,
      depthMm,
      signedDistanceMm: distance * 1000,
    });
  };
  for (let offset = 0, triangle = 0; offset + 2 < options.triangleIndices.length; offset += 3, triangle++) {
    const a = options.triangleIndices[offset]!;
    const b = options.triangleIndices[offset + 1]!;
    const c = options.triangleIndices[offset + 2]!;
    if (a >= referenced.length || b >= referenced.length || c >= referenced.length) continue;
    if (options.sampleTriangle && !options.sampleTriangle(triangle, a, b, c)) continue;
    const ao = a * 3;
    const bo = b * 3;
    const co = c * 3;
    const ax = p[ao]!; const ay = p[ao + 1]!; const az = p[ao + 2]!;
    const bx = p[bo]!; const by = p[bo + 1]!; const bz = p[bo + 2]!;
    const cx = p[co]!; const cy = p[co + 1]!; const cz = p[co + 2]!;
    const particleIndices: [number, number, number] = [a, b, c];
    const vertices: [[number, number, number], [number, number, number], [number, number, number]] = [
      [ax, ay, az], [bx, by, bz], [cx, cy, cz],
    ];
    // Triangle interiors can chord through a curved shoulder even when all
    // three particles are valid. Three edge midpoints + centroid expose it.
    sample(triangle, particleIndices, vertices, 'edge-ab', (ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    sample(triangle, particleIndices, vertices, 'edge-bc', (bx + cx) * 0.5, (by + cy) * 0.5, (bz + cz) * 0.5);
    sample(triangle, particleIndices, vertices, 'edge-ca', (cx + ax) * 0.5, (cy + ay) * 0.5, (cz + az) * 0.5);
    sample(triangle, particleIndices, vertices, 'centroid', (ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
  }

  depths.sort((a, b) => b.depthMm - a.depthMm);
  surfaceDepths.sort((a, b) => b.depthMm - a.depthMm);
  const percentage = (count: number): number =>
    totalParticles > 0 ? (count * 100) / totalParticles : 0;
  const meanDepthMm = sampledParticles > 0 ? globalDepthSumMm / sampledParticles : 0;
  return {
    version: 2,
    metric: 'visual-body-mesh',
    unclamped: true,
    totalParticles,
    sampledParticles,
    outsideDomain,
    contactParticles,
    contactCoveragePct: percentage(contactParticles),
    penetrating,
    penetratingPct: {
      over0_5mm: percentage(penetrating.over0_5mm),
      over1mm: percentage(penetrating.over1mm),
      over2mm: percentage(penetrating.over2mm),
      over5mm: percentage(penetrating.over5mm),
    },
    maxDepthMm: depths[0]?.depthMm ?? 0,
    meanDepthMm,
    contactMeanDepthMm: contactParticles > 0 ? contactDepthSumMm / contactParticles : 0,
    meanSignedDistanceMm: -meanDepthMm,
    meanClearanceMm:
      contactParticles > 0 ? contactClearanceSumMm / contactParticles : 0,
    worstZones: depths.slice(0, 20),
    surfaceSamples: {
      sampled: surfaceSampled,
      penetrating: surfacePenetrating,
      penetratingPct: surfaceSampled > 0 ? (surfacePenetrating * 100) / surfaceSampled : 0,
      maxDepthMm: surfaceSampled > 0 ? surfaceMaxDepthMm : 0,
      meanDepthMm: surfaceSampled > 0 ? surfaceDepthSumMm / surfaceSampled : 0,
      worstZones: surfaceDepths.slice(0, 20),
    },
  };
}
