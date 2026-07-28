import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVATAR_APPEARANCE,
  avatarAppearanceUniform,
  normalizeAvatarAppearance,
} from '../src/app/ClothRenderer';

describe('avatar appearance', () => {
  it('normalizes persisted styles and skin colors', () => {
    expect(
      normalizeAvatarAppearance({ style: 'cel', skinColor: '#C89573' }),
    ).toEqual({
      style: 'cel',
      skinColor: '#c89573',
    });
    expect(
      normalizeAvatarAppearance({
        style: 'unknown' as 'cel',
        skinColor: 'transparent',
      }),
    ).toEqual(DEFAULT_AVATAR_APPEARANCE);
  });

  it('packs the selected skin and cel mode into the GPU uniform', () => {
    const uniform = avatarAppearanceUniform({
      style: 'cel',
      skinColor: '#ff8040',
    });
    expect(uniform[0]).toBe(1);
    expect(uniform[1]).toBeCloseTo(128 / 255, 6);
    expect(uniform[2]).toBeCloseTo(64 / 255, 6);
    expect(uniform[3]).toBe(1);
    expect([...uniform.slice(4)]).toEqual([1, 4, 1, 0]);
  });

  it('marks the static scene so it keeps its own material color', () => {
    const uniform = avatarAppearanceUniform(DEFAULT_AVATAR_APPEARANCE, false);
    expect(uniform[6]).toBe(0);
  });
});
