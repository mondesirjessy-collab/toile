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

describe('OrbitCamera gesture cancellation', () => {
  const pointer = (
    pointerId: number,
    clientX: number,
    clientY: number,
    pointerType = 'mouse',
  ): PointerEvent =>
    ({
      pointerId,
      clientX,
      clientY,
      pointerType,
      button: 0,
      shiftKey: false,
    }) as PointerEvent;

  const harness = () => {
    const listeners = new Map<string, Array<(event: PointerEvent) => void>>();
    const captures = new Set<number>();
    const releases: number[] = [];
    const canvas = {
      addEventListener: (
        type: string,
        listener: (event: PointerEvent) => void,
      ) => {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
      setPointerCapture: (pointerId: number) => captures.add(pointerId),
      hasPointerCapture: (pointerId: number) => captures.has(pointerId),
      releasePointerCapture: (pointerId: number) => {
        captures.delete(pointerId);
        releases.push(pointerId);
      },
    } as unknown as HTMLCanvasElement;
    const dispatch = (type: string, event: PointerEvent): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    return { canvas, captures, releases, dispatch };
  };

  it('arrête un orbit en cours et ignore les événements physiques tardifs', () => {
    const camera = new OrbitCamera();
    const { canvas, captures, releases, dispatch } = harness();
    camera.attach(canvas, () => true);

    const before = camera.pickRay(0, 0, 1).origin;
    dispatch('pointerdown', pointer(7, 100, 100));
    dispatch('pointermove', pointer(7, 150, 125));
    const moved = camera.pickRay(0, 0, 1).origin;
    expect(distance(moved, before)).toBeGreaterThan(0.01);
    expect(captures.has(7)).toBe(true);

    expect(camera.cancelGesture()).toBe(true);
    expect(releases).toEqual([7]);
    const cancelledAt = camera.pickRay(0, 0, 1).origin;

    dispatch('pointermove', pointer(7, 260, 220));
    dispatch('pointerup', pointer(7, 260, 220));
    expect(camera.pickRay(0, 0, 1).origin).toEqual(cancelledAt);
    expect(camera.cancelGesture()).toBe(false);
  });

  it('libère toutes les captures d’un pinch', () => {
    const camera = new OrbitCamera();
    const { canvas, captures, releases, dispatch } = harness();
    camera.attach(canvas);

    dispatch('pointerdown', pointer(1, 100, 100, 'touch'));
    dispatch('pointerdown', pointer(2, 180, 100, 'touch'));
    expect([...captures]).toEqual([1, 2]);

    expect(camera.cancelGesture()).toBe(true);
    expect(releases).toEqual([1, 2]);
    expect(captures.size).toBe(0);
  });
});
