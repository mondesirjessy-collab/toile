import { describe, expect, it } from 'vitest';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { preWrapTwoPanelTube } from '../src/engine/pattern/TubePlacement';

describe('preWrapTwoPanelTube', () => {
  it('place chaque sommet hors du corps sans changer son hémisphère', () => {
    const n = 32;
    const panelSize = n * n;
    const mesh = generateSeamedPanels({
      resolution: n,
      width: 0.28,
      height: 0.26,
      gap: 0.7,
      topY: 1.4,
    });
    const halfWidth = 0.15;
    const halfDepth = 0.1;
    // Smooth signed field with an elliptical zero contour. Its scale is close
    // enough to metric distance for this placement contract.
    const bodyDistance = (x: number, _y: number, z: number): number =>
      (Math.hypot(x / halfWidth, z / halfDepth) - 1) * halfDepth;
    const clearance = 0.012;

    preWrapTwoPanelTube(mesh, { bodyDistance, clearance });

    for (let panel = 0; panel < 2; panel++) {
      const sign = panel === 0 ? 1 : -1;
      for (let local = 0; local < panelSize; local++) {
        const index = panel * panelSize + local;
        expect(
          bodyDistance(
            mesh.positions[index * 4]!,
            mesh.positions[index * 4 + 1]!,
            mesh.positions[index * 4 + 2]!,
          ),
        ).toBeGreaterThanOrEqual(clearance - 1e-5);
        const u = local % n;
        if (u > 0 && u < n - 1) {
          expect(mesh.positions[index * 4 + 2]! * sign).toBeGreaterThan(0);
        }
      }
    }

    // Both side stitches share one ray and therefore one exact spawn point.
    for (let v = 0; v < n; v++) {
      for (const u of [0, n - 1]) {
        const front = v * n + u;
        const back = panelSize + front;
        expect(mesh.positions[front * 4]).toBeCloseTo(
          mesh.positions[back * 4]!,
          7,
        );
        expect(mesh.positions[front * 4 + 2]).toBeCloseTo(
          mesh.positions[back * 4 + 2]!,
          7,
        );
      }
    }
  });
});
