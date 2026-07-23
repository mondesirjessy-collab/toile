import { describe, expect, it } from 'vitest';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';
import { ConstraintKind } from '../src/engine/solver/ConstraintGraph';
import { preCloseBodySafeMirrorSeams } from '../src/engine/pattern/SeamPlacement';

describe('preCloseBodySafeMirrorSeams', () => {
  it('ferme les coutures miroir hors du collider sans toucher le centre', () => {
    const n = 16;
    const panelSize = n * n;
    const mesh = generateSeamedPanels({
      resolution: n,
      width: 0.24,
      height: 0.4,
      gap: 0.5,
      topY: 1.3,
    });
    const centre = 5 * n + 5;
    const centreBefore = Array.from(mesh.positions.slice(centre * 4, centre * 4 + 3));
    const bodyDistance = (x: number, _y: number, z: number): number =>
      Math.hypot(x, z) - 0.16;
    const clearance = 0.012;

    const closed = preCloseBodySafeMirrorSeams(mesh, {
      bodyDistance,
      clearance,
    });

    expect(closed).toBe(mesh.seamCount);
    expect(Array.from(mesh.positions.slice(centre * 4, centre * 4 + 3))).toEqual(
      centreBefore,
    );
    const constraints = new DataView(mesh.constraintData);
    for (let k = 0; k < mesh.constraintCount; k++) {
      const offset = k * 16;
      if (constraints.getUint32(offset + 12, true) !== ConstraintKind.Seam) continue;
      const i = constraints.getUint32(offset, true);
      const j = constraints.getUint32(offset + 4, true);
      expect(Math.abs(i - j)).toBe(panelSize);
      const distance = Math.hypot(
        mesh.positions[i * 4]! - mesh.positions[j * 4]!,
        mesh.positions[i * 4 + 1]! - mesh.positions[j * 4 + 1]!,
        mesh.positions[i * 4 + 2]! - mesh.positions[j * 4 + 2]!,
      );
      expect(distance).toBeCloseTo(constraints.getFloat32(offset + 8, true), 6);
      expect(bodyDistance(
        mesh.positions[i * 4]!,
        mesh.positions[i * 4 + 1]!,
        mesh.positions[i * 4 + 2]!,
      )).toBeGreaterThanOrEqual(clearance - 1e-5);
      expect(bodyDistance(
        mesh.positions[j * 4]!,
        mesh.positions[j * 4 + 1]!,
        mesh.positions[j * 4 + 2]!,
      )).toBeGreaterThanOrEqual(clearance - 1e-5);
    }
  });
});
