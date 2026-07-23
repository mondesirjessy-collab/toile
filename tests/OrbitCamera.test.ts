import { describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/app/OrbitCamera';

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('OrbitCamera mannequin framing', () => {
  it('centres a standing avatar and brings it closer than the default view', () => {
    const camera = new OrbitCamera();
    camera.frameAvatar(1.75, 1);

    const ray = camera.pickRay(0, 0, 1);
    const target = [0, 0.875, 0] as const;
    const radius = distance(ray.origin, target);
    const centreHit = [
      ray.origin[0] + ray.dir[0] * radius,
      ray.origin[1] + ray.dir[1] * radius,
      ray.origin[2] + ray.dir[2] * radius,
    ];

    expect(radius).toBeLessThan(4);
    expect(distance(centreHit, target)).toBeLessThan(1e-6);
  });

  it('backs up for a taller avatar and for a narrower viewport', () => {
    const camera = new OrbitCamera();
    camera.frameAvatar(1.4, 1);
    const shortRadius = distance(camera.pickRay(0, 0, 1).origin, [0, 0.7, 0]);

    camera.frameAvatar(2.1, 1);
    const tallRadius = distance(camera.pickRay(0, 0, 1).origin, [0, 1.05, 0]);

    camera.frameAvatar(2.1, 0.5);
    const narrowRadius = distance(camera.pickRay(0, 0, 0.5).origin, [0, 1.05, 0]);

    expect(tallRadius).toBeGreaterThan(shortRadius);
    expect(narrowRadius).toBeGreaterThan(tallRadius);
  });

  it('fits the real bounds of a wide scan instead of guessing its arm span', () => {
    const camera = new OrbitCamera();
    const bounds = {
      min: [-1.1, 0, -0.3] as const,
      max: [1.1, 2, 0.3] as const,
    };

    camera.frameBounds(bounds, 0.75);
    const centre = [0, 1, 0] as const;
    const fittedRadius = distance(camera.pickRay(0, 0, 0.75).origin, centre);

    camera.frameAvatar(2, 0.75);
    const estimatedRadius = distance(camera.pickRay(0, 0, 0.75).origin, centre);

    expect(fittedRadius).toBeGreaterThan(estimatedRadius);
  });
});
