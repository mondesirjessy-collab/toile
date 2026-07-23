import { describe, expect, it } from 'vitest';
import {
  normalizeResolution,
  resolutionRebuildMessage,
} from '../src/app/ControlStateSync';

describe('synchronisation de la résolution', () => {
  it('normalise les valeurs DOM vers les trois résolutions GPU supportées', () => {
    expect(normalizeResolution('128', 64)).toBe(128);
    expect(normalizeResolution(32, 64)).toBe(32);
    expect(normalizeResolution('96', 64)).toBe(64);
  });

  it('annonce explicitement la reconstruction demandée', () => {
    expect(resolutionRebuildMessage(128)).toBe(
      'Reconstruction 128 × 128 en cours…',
    );
  });
});
