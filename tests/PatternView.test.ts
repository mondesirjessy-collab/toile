import { describe, expect, it } from 'vitest';
import { handleLayoutPos, handleValueFromLayout, type PatternHandleSpec } from '../src/app/PatternView';

const grid = { width: 0.95, topY: 1.6, height: 1.3 };

const flare: PatternHandleSpec = {
  id: 'dressFlare',
  label: 'évasement',
  grid,
  anchor: [1.0, 1],
  axis: 'u',
  value: 0.5,
  min: 0.25,
  max: 0.5,
};

const length: PatternHandleSpec = {
  id: 'dressLength',
  label: 'longueur',
  grid,
  anchor: [0.5, 1],
  axis: 'y',
  value: 1.3,
  min: 0.9,
  max: 1.55,
  unit: ' m',
};

describe('pattern handles', () => {
  it('places a half-width (u) handle on its cut edge', () => {
    const [x, y] = handleLayoutPos(flare, 0.5);
    expect(x).toBeCloseTo(0.475); // 0.5 × width — the hem corner
    expect(y).toBeCloseTo(1.6 - 1.3); // anchored to the hem row
  });

  it('places a length (y) handle below topY by the value', () => {
    const [x, y] = handleLayoutPos(length, 1.1);
    expect(x).toBeCloseTo(0); // hem center: anchor u = 0.5
    expect(y).toBeCloseTo(0.5); // 1.6 − 1.1
  });

  it('inverts a u-drag back to a half-width value', () => {
    // Round-trip: position of value 0.4 maps back to 0.4.
    const [x, y] = handleLayoutPos(flare, 0.4);
    expect(handleValueFromLayout(flare, x, y)).toBeCloseTo(0.4);
  });

  it('inverts a y-drag back to meters from the top', () => {
    const [x, y] = handleLayoutPos(length, 1.42);
    expect(handleValueFromLayout(length, x, y)).toBeCloseTo(1.42);
  });

  it('clamps to the slider bounds', () => {
    expect(handleValueFromLayout(flare, 10, 0)).toBe(0.5);
    expect(handleValueFromLayout(flare, -10, 0)).toBe(0.25);
    expect(handleValueFromLayout(length, 0, -10)).toBe(1.55);
    expect(handleValueFromLayout(length, 0, 10)).toBe(0.9);
  });
});
