import { describe, expect, it } from 'vitest';
import {
  STAGING_PICK_RADIUS,
  pickFrontmostInRanges,
  type TaggedParticleRange,
} from '../src/app/pick';

const particles = (
  ...points: ReadonlyArray<readonly [number, number, number]>
): Float32Array =>
  new Float32Array(points.flatMap(([x, y, z]) => [x, y, z, 1]));

const origin = [0, 0, 0] as const;
const forward = [0, 0, 1] as const;

describe('pickFrontmostInRanges', () => {
  it('ignores a closer unrelated particle and reaches the tagged piece', () => {
    const positions = particles([0, 0, 1], [0.1, 0, 2]);
    const tag = { pid: 4, instance: 1 };

    const hit = pickFrontmostInRanges(
      positions,
      2,
      [{ first: 1, count: 1, tag }],
      origin,
      forward,
    );

    expect(hit).toEqual({ index: 1, depth: 2, tag });
  });

  it('chooses the visually frontmost range instead of the closest point to the ray', () => {
    const positions = particles([0.12, 0, 1], [0.01, 0, 3]);
    const ranges: TaggedParticleRange<string>[] = [
      { first: 0, count: 1, tag: 'devant' },
      { first: 1, count: 1, tag: 'dos' },
    ];

    const hit = pickFrontmostInRanges(
      positions,
      positions.length / 4,
      ranges,
      origin,
      forward,
    );

    expect(hit).toEqual({ index: 0, depth: 1, tag: 'devant' });
  });

  it('uses the more generous staging tolerance while keeping it overridable', () => {
    const positions = particles([0.1, 0, 2]);
    const ranges = [{ first: 0, count: 1, tag: 'piece' }];

    expect(STAGING_PICK_RADIUS).toBe(0.18);
    expect(
      pickFrontmostInRanges(
        positions,
        1,
        ranges,
        origin,
        forward,
        0.07,
      ),
    ).toBeNull();
    expect(
      pickFrontmostInRanges(positions, 1, ranges, origin, forward),
    ).toMatchObject({ index: 0, tag: 'piece' });
  });

  it('skips immovable particles and preserves the picked instance tag', () => {
    const positions = particles([0, 0, 1], [0.02, 0, 2]);
    const frontTag = { pid: 0, instance: 0 };
    const backTag = { pid: 0, instance: 1 };
    const ranges = [
      { first: 0, count: 1, tag: frontTag },
      { first: 1, count: 1, tag: backTag },
    ];

    const hit = pickFrontmostInRanges(
      positions,
      2,
      ranges,
      origin,
      forward,
      STAGING_PICK_RADIUS,
      (index) => index !== 0,
    );

    expect(hit).toEqual({ index: 1, depth: 2, tag: backTag });
  });

  it('clamps oversized ranges to both the logical count and position buffer', () => {
    const positions = particles([0.02, 0, 3], [0.03, 0, 2], [0, 0, 0.5]);
    const ranges = [{ first: 1, count: 100, tag: 'bounded' }];

    const hit = pickFrontmostInRanges(
      positions,
      2,
      ranges,
      origin,
      forward,
    );

    expect(hit).toEqual({ index: 1, depth: 2, tag: 'bounded' });
  });

  it('skips non-finite particles without masking a later valid hit', () => {
    const positions = particles(
      [Number.NaN, 0, 0.5],
      [0, Number.POSITIVE_INFINITY, 1],
      [0.03, 0, 2],
    );
    const ranges = [{ first: 0, count: 3, tag: 'finite' }];

    const hit = pickFrontmostInRanges(
      positions,
      3,
      ranges,
      origin,
      forward,
    );

    expect(hit).toEqual({ index: 2, depth: 2, tag: 'finite' });
  });
});
