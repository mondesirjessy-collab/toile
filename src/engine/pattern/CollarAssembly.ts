import type { AttachmentSeam, ClothMeshData } from '../cloth/ClothMesh';
import { preWrapTwoPanelTube } from './TubePlacement';

export interface CollarNecklineRuns {
  /** Local cells of the front panel's authored neckline, left -> right. */
  front: readonly number[];
  /** Local cells of the back panel's authored neckline, left -> right. */
  back: readonly number[];
}

/**
 * Pre-wrap a two-panel neck band into one continuous tube.
 *
 * A flat front/back spawn puts the two side seams on opposite sides of the
 * neck collider. Pulling either stitch straight between them crosses the body;
 * the final collision pass then projects both endpoints back to opposite
 * surfaces and visibly reopens the seam. Map each row onto two matching
 * semicircles instead: corresponding left/right endpoints start coincident,
 * while the flat row length becomes the half-circumference (so structural rest
 * lengths change only by the negligible chord/arc discretisation error).
 *
 * Row-local bounds also support a tapered user-drawn band: its actual two side
 * cells, not necessarily grid columns 0 and n-1, meet exactly.
 */
export function preWrapCollarTube(
  mesh: Pick<
    ClothMeshData,
    'resolution' | 'count' | 'positions' | 'invMasses'
  >,
): void {
  preWrapTwoPanelTube(mesh);
}

/**
 * Pre-fit a wrapped collar to the neckline without creating a one-cell kink.
 *
 * `collarCrossSeams` intentionally emits fewer physical lockstitches than the
 * band's n bottom-row vertices. If the solver alone pulls those stitches onto
 * a wider curved neckline, only the sewn row moves at first: the next row stays
 * on the original narrow tube and the intervening triangles form long chords
 * through the shoulder/neck collider. Reconstruct the target bottom lip from
 * the sparse body pins, then spread every column's displacement linearly over
 * the complete band height (1 at the sewn bottom, 0 at the free top).
 *
 * This is placement only: rest lengths, masses, constraints and authored seam
 * density remain untouched. Front and back panels are fitted independently so
 * their different neckline scoops are respected, except at the two lateral
 * joins: those columns are the band's own front↔back seams and must remain one
 * continuous fold. Their fitted positions are averaged row by row after the
 * neckline fit, which tapers the reconciliation from the sewn lip to the
 * already-coincident free lip instead of leaving two attachment families to
 * tear the side seam apart.
 */
export function fitCollarTubeToNeckline(
  body: Pick<ClothMeshData, 'count' | 'positions'>,
  band: Pick<
    ClothMeshData,
    'resolution' | 'count' | 'positions' | 'invMasses'
  >,
  seams: readonly Pick<AttachmentSeam, 'i' | 'j'>[],
): void {
  const n = band.resolution;
  if (n < 2 || band.count < 2 * n * n) return;
  const panelSize = n * n;
  type Vec3 = [number, number, number];
  interface TargetAnchor {
    u: number;
    target: Vec3;
  }

  const anchorsByPanel: TargetAnchor[][] = [[], []];
  for (const seam of seams) {
    const localBand = seam.j - body.count;
    if (
      seam.i < 0 ||
      seam.i >= body.count ||
      localBand < 0 ||
      localBand >= band.count
    ) {
      continue;
    }
    const panel = Math.floor(localBand / panelSize);
    if (panel < 0 || panel > 1) continue;
    const panelLocal = localBand - panel * panelSize;
    const v = Math.floor(panelLocal / n);
    const u = panelLocal % n;
    if (v !== n - 1 || band.invMasses[localBand]! <= 0) continue;
    anchorsByPanel[panel]!.push({
      u,
      target: [
        body.positions[seam.i * 4]!,
        body.positions[seam.i * 4 + 1]!,
        body.positions[seam.i * 4 + 2]!,
      ],
    });
  }

  for (let panel = 0; panel < 2; panel++) {
    // Average duplicate columns defensively, then walk the ordered sparse pins
    // once while interpolating the complete bottom lip.
    const sums = new Map<number, { xyz: Vec3; count: number }>();
    for (const anchor of anchorsByPanel[panel]!) {
      const prior = sums.get(anchor.u);
      if (prior) {
        prior.xyz[0] += anchor.target[0];
        prior.xyz[1] += anchor.target[1];
        prior.xyz[2] += anchor.target[2];
        prior.count++;
      } else {
        sums.set(anchor.u, { xyz: [...anchor.target], count: 1 });
      }
    }
    const anchors = [...sums.entries()]
      .map(([u, sum]) => ({
        u,
        target: sum.xyz.map((value) => value / sum.count) as Vec3,
      }))
      .sort((a, b) => a.u - b.u);
    if (anchors.length === 0) continue;

    let right = Math.min(1, anchors.length - 1);
    for (let u = 0; u < n; u++) {
      while (right < anchors.length - 1 && u > anchors[right]!.u) right++;
      const leftAnchor = anchors[Math.max(0, right - 1)]!;
      const rightAnchor = anchors[right]!;
      const bottom = panel * panelSize + (n - 1) * n + u;
      if (band.invMasses[bottom]! <= 0) continue;

      let target: Vec3;
      if (anchors.length === 1) {
        // One pin defines translation, not a shape: preserve the wrapped lip
        // instead of collapsing every column onto the sole body particle.
        const anchorBottom = panel * panelSize + (n - 1) * n + anchors[0]!.u;
        target = [
          band.positions[bottom * 4]! +
            anchors[0]!.target[0] - band.positions[anchorBottom * 4]!,
          band.positions[bottom * 4 + 1]! +
            anchors[0]!.target[1] - band.positions[anchorBottom * 4 + 1]!,
          band.positions[bottom * 4 + 2]! +
            anchors[0]!.target[2] - band.positions[anchorBottom * 4 + 2]!,
        ];
      } else if (u <= anchors[0]!.u) {
        target = anchors[0]!.target;
      } else if (u >= anchors[anchors.length - 1]!.u) {
        target = anchors[anchors.length - 1]!.target;
      } else {
        const span = Math.max(1, rightAnchor.u - leftAnchor.u);
        const t = (u - leftAnchor.u) / span;
        target = [
          leftAnchor.target[0] + (rightAnchor.target[0] - leftAnchor.target[0]) * t,
          leftAnchor.target[1] + (rightAnchor.target[1] - leftAnchor.target[1]) * t,
          leftAnchor.target[2] + (rightAnchor.target[2] - leftAnchor.target[2]) * t,
        ];
      }

      const delta: Vec3 = [
        target[0] - band.positions[bottom * 4]!,
        target[1] - band.positions[bottom * 4 + 1]!,
        target[2] - band.positions[bottom * 4 + 2]!,
      ];
      for (let v = 0; v < n; v++) {
        const index = panel * panelSize + v * n + u;
        if (band.invMasses[index]! <= 0) continue;
        const weight = v / (n - 1);
        band.positions[index * 4] = band.positions[index * 4]! + delta[0] * weight;
        band.positions[index * 4 + 1] = band.positions[index * 4 + 1]! + delta[1] * weight;
        band.positions[index * 4 + 2] = band.positions[index * 4 + 2]! + delta[2] * weight;
      }
    }
  }

  // A collar's front and back neckline paths genuinely differ, but their two
  // lateral endpoints represent the SAME physical points. The endpoint band
  // vertices are deliberately not cross-attached (see collarCrossSeams): keep
  // each front↔back side-seam column coincident after the independent fits.
  // Averaging each row preserves the v/(n-1) taper above and places the join
  // halfway between the front/back neckline samples, i.e. on the anatomical
  // side of the neck rather than on either flat-panel dressing plane.
  for (const u of [0, n - 1]) {
    for (let v = 0; v < n; v++) {
      const front = v * n + u;
      const back = panelSize + front;
      if (band.invMasses[front]! <= 0 || band.invMasses[back]! <= 0) continue;
      for (let axis = 0; axis < 3; axis++) {
        const shared =
          (band.positions[front * 4 + axis]! +
            band.positions[back * 4 + axis]!) *
          0.5;
        band.positions[front * 4 + axis] = shared;
        band.positions[back * 4 + axis] = shared;
      }
    }
  }
}

/**
 * Sew a two-panel collar band's bottom row to each body's OWN neckline.
 *
 * Front and back patterns deliberately have different scoops. Reusing the
 * front `(u,v)` cell on the back can target an interior point 4–9 rows below
 * its real edge, turning the quasi-rigid seam into an inward body pull.
 */
export function collarCrossSeams(
  base: Pick<ClothMeshData, 'count' | 'invMasses'>,
  n: number,
  necklines: CollarNecklineRuns,
): AttachmentSeam[] {
  const panelSize = n * n;
  const result: AttachmentSeam[] = [];
  for (let panel = 0; panel < 2; panel++) {
    const panelOffset = panel * panelSize;
    const authored = panel === 0 ? necklines.front : necklines.back;
    const neckline = authored.filter(
      (local, index) =>
        local >= 0 &&
        local < panelSize &&
        authored.indexOf(local) === index &&
        base.invMasses[panelOffset + local]! > 0,
    );
    if (neckline.length === 0) continue;

    // The two endpoint vertices belong to the band's own lateral front↔back
    // seams. Attaching each endpoint independently to the front and back body
    // panels creates a three-way junction with incompatible targets, because
    // the two neckline scoops approach the neck from opposite hemispheres.
    // Leave those two side-fold vertices under the authority of their mirror
    // seam and sew the n-2 interior bottom vertices instead. The adjacent
    // stitches still attach the whole continuous lip without a loose corner.
    const firstBandU = n >= 3 ? 1 : 0;
    const lastBandU = n >= 3 ? n - 2 : n - 1;
    const availableBandVertices = lastBandU - firstBandU + 1;
    // Piquer le bord le plus DENSE au complet (max, pas min) : avec min, quand
    // la bande a plus de sommets que l'encolure n'a de cellules, les sommets
    // entre deux points restaient libres → la bande FRONÇAIT en jour. En
    // couvrant le bord dense, elle se fronce uniformément sur l'encolure au
    // lieu de bâiller (appariement 1:n net, note COUTURES-TROUS #5).
    const seamCount = Math.max(availableBandVertices, neckline.length);
    for (let k = 0; k < seamCount; k++) {
      const fraction = seamCount === 1 ? 0.5 : k / (seamCount - 1);
      const bodyLocal = neckline[
        Math.round(fraction * (neckline.length - 1))
      ]!;
      const bandU = Math.round(
        firstBandU + fraction * (lastBandU - firstBandU),
      );
      const bodyIndex = panelOffset + bodyLocal;
      const bandIndex =
        base.count + panelOffset + (n - 1) * n + bandU;
      const bodyInward = bodyIndex + n;
      const bandInward = bandIndex - n;
      result.push({
        i: bodyIndex,
        j: bandIndex,
        // The neckline is already body-safe; the separately spawned band may
        // begin inside the neck. Keep the support quasi-fixed during dressing.
        attachment: true,
        // A neckline opens upward (interior below); the band is sewn by its
        // bottom edge (interior above). These are the reverse of the generic
        // bottom(a)->top(b) waist convention in combineClothMeshes.
        inwardI:
          bodyInward < panelOffset + panelSize &&
          base.invMasses[bodyInward]! > 0
            ? bodyInward
            : bodyIndex,
        inwardJ: bandInward,
      });
    }
  }
  return result;
}
