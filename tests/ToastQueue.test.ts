import { describe, expect, it } from 'vitest';
import {
  boundedToastMessages,
  MAX_VISIBLE_TOASTS,
  TOAST_VISIBLE_MS,
} from '../src/app/ToastQueue';

describe('file de notifications', () => {
  it('garde au plus les deux messages les plus récents', () => {
    const source = ['premier', 'deuxième'];
    expect(MAX_VISIBLE_TOASTS).toBe(2);
    expect(boundedToastMessages(source, 'troisième')).toEqual([
      'deuxième',
      'troisième',
    ]);
    expect(source).toEqual(['premier', 'deuxième']);
  });

  it('reste lisible six secondes et normalise les limites invalides', () => {
    expect(TOAST_VISIBLE_MS).toBe(6_000);
    expect(boundedToastMessages([], 'message', 0)).toEqual(['message']);
    expect(
      boundedToastMessages(['un', 'deux', 'trois'], 'quatre', Number.NaN),
    ).toEqual(['trois', 'quatre']);
  });
});
