import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  distributeBalancedSurfaceCorrection,
  measureSurfaceContacts,
} from '../src/engine/solver/SurfaceContact';

const shader = readFileSync(
  new URL('../src/engine/solver/shaders/surfaceContact.wgsl', import.meta.url),
  'utf8',
);
const reactionShader = readFileSync(
  new URL('../src/engine/solver/shaders/surfaceReaction.wgsl', import.meta.url),
  'utf8',
);
const distanceShader = readFileSync(
  new URL('../src/engine/solver/shaders/distance.wgsl', import.meta.url),
  'utf8',
);

function packedContact(active = true): ArrayBuffer {
  const data = new ArrayBuffer(32);
  const view = new DataView(data);
  view.setUint32(0, 0, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 3, true);
  view.setFloat32(16, 1, true);
  view.setFloat32(28, active ? 1 : 0, true);
  return data;
}

describe('measureSurfaceContacts', () => {
  const positions = new Float32Array([
    0, 0, 0, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0.004, 0,
  ]);

  it('reports the signed clearance on the authored side', () => {
    const stats = measureSurfaceContacts(positions, packedContact(), 1);
    expect(stats.activeCount).toBe(1);
    expect(stats.uniqueSupportTriangleCount).toBe(1);
    expect(stats.negativeCount).toBe(0);
    expect(stats.minSignedDistance).toBeCloseTo(0.004);
  });

  it('detects a pocket point behind its support triangle', () => {
    const behind = new Float32Array(positions);
    behind[14] = -0.002;
    const stats = measureSurfaceContacts(behind, packedContact(), 1);
    expect(stats.negativeCount).toBe(1);
    expect(stats.minSignedDistance).toBeCloseTo(-0.002);
  });

  it('ignores explicitly mask-only contact records', () => {
    const stats = measureSurfaceContacts(positions, packedContact(false), 1);
    expect(stats.activeCount).toBe(0);
  });
});

describe('balanced surface-contact correction', () => {
  it('closes the requested penetration without translating the mass centre', () => {
    const weights = [0.2, 0.3, 0.5] as const;
    const supportInvMasses = [2, 4, 5] as const;
    const overlayInvMass = 3;
    const push = 0.0015;
    const correction = distributeBalancedSurfaceCorrection(
      push,
      overlayInvMass,
      weights,
      supportInvMasses,
    );
    expect(correction).not.toBeNull();
    if (!correction) return;

    // Relative point/triangle correction is exactly the penetration depth.
    const relative =
      correction.overlay -
      weights.reduce(
        (sum, weight, index) => sum + weight * correction.support[index]!,
        0,
      );
    expect(relative).toBeCloseTo(push, 12);

    // mass × displacement sums to zero: no forward ratchet of the garment.
    const massCentre =
      correction.overlay / overlayInvMass +
      correction.support.reduce(
        (sum, value, index) => sum + value / supportInvMasses[index]!,
        0,
      );
    expect(massCentre).toBeCloseTo(0, 12);
  });

  it('lets immovable support vertices absorb reaction through their anchors', () => {
    const correction = distributeBalancedSurfaceCorrection(
      0.001,
      2,
      [0.2, 0.3, 0.5],
      [0, 0, 0],
    );
    expect(correction).toEqual({
      overlay: 0.001,
      support: [-0, -0, -0],
    });
  });

  it('keeps a light appliqué correction mostly off the supporting garment', () => {
    const weights = [0.2, 0.3, 0.5] as const;
    const masses = [2, 4, 5] as const;
    const balanced = distributeBalancedSurfaceCorrection(
      0.0015,
      3,
      weights,
      masses,
    )!;
    const overlayBiased = distributeBalancedSurfaceCorrection(
      0.0015,
      3,
      weights,
      masses,
      0.02,
    )!;
    const relative =
      overlayBiased.overlay -
      weights.reduce(
        (sum, weight, index) =>
          sum + weight * overlayBiased.support[index]!,
        0,
      );
    expect(relative).toBeCloseTo(0.0015, 12);
    expect(
      overlayBiased.support.reduce(
        (sum, value) => sum + Math.abs(value),
        0,
      ),
    ).toBeLessThan(
      balanced.support.reduce(
        (sum, value) => sum + Math.abs(value),
        0,
      ) * 0.05,
    );
  });
});

describe('surfaceContact shader', () => {
  it('is a unilateral anti-penetration pass, not an attachment tether', () => {
    expect(shader).toContain(
      'if (signed_distance >= separation - params.slop) { return; }',
    );
    expect(shader).toContain('if (contact.weights.w < 0.5) { return; }');
    expect(shader).toContain(
      'let inward_motion = min(dot(relative_motion, normal), 0.0);',
    );
    expect(shader).toContain(
      'dot(raw_normal, previous_raw_normal) < 0.0',
    );
    expect(shader).not.toContain('max_lift');
    expect(shader).not.toContain('max_tangent');
    expect(shader).not.toContain('tangent_correction');
  });

  it('removes correction energy from the reconstructed previous position', () => {
    expect(shader).toContain(
      'prev_positions[overlay] = vec4f(corrected - preserved_motion, 0.0);',
    );
  });

  it('accumulates the bounded support reaction without racing shared vertices', () => {
    expect(shader).toContain('let denominator =');
    expect(shader).toContain('let overlay_correction = normal *');
    expect(shader).toContain(
      'const SURFACE_SUPPORT_RESPONSE: f32 = 0.02;',
    );
    expect(shader).toContain(
      'inv_masses[contact.support] * SURFACE_SUPPORT_RESPONSE',
    );
    expect(shader).toContain('atomicAdd(&reactions[base]');
    expect(reactionShader).toContain(
      'atomicExchange(&reactions[base], 0)',
    );
    expect(reactionShader).toContain(
      'prev_positions[index].xyz + correction',
    );
  });

  it('prevents an open pocket seam from levering the whole support panel', () => {
    expect(distanceShader).toContain(
      'const SURFACE_SUPPORT_RESPONSE: f32 = 0.02;',
    );
    expect(distanceShader).toContain(
      'if (c.kind == 5u) { solve_wi *= SURFACE_SUPPORT_RESPONSE; }',
    );
    expect(distanceShader).toContain(
      'positions[c.i] = vec4f(xi + solve_wi * corr, 0.0);',
    );
  });

  it('moves an anatomical attachment onto its body-safe support without dragging the support', () => {
    expect(distanceShader).toContain(
      'const ATTACHMENT_SUPPORT_RESPONSE: f32 = 0.02;',
    );
    expect(distanceShader).toContain(
      'else if (c.kind == 6u) { solve_wi *= ATTACHMENT_SUPPORT_RESPONSE; }',
    );
    expect(distanceShader).toContain(
      'else if (c.kind == 6u) { compliance = 1e-9; }',
    );
  });

  it('tightens assembly seams progressively without softening surface top-stitches', () => {
    expect(distanceShader).toContain('seam_dressing_progress: f32');
    expect(distanceShader).toContain(
      'let p = smoothstep(0.0, 1.0, params.seam_dressing_progress);',
    );
    expect(distanceShader).toContain(
      'compliance = mix(5e-4, 1e-9, p);',
    );
    expect(distanceShader).toContain(
      'else if (c.kind == 5u) { compliance = 1e-9; }',
    );
  });
});
