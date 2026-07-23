import { describe, expect, it } from 'vitest';
import { patternSvgFilename } from '../src/app/patternSvg';

describe('nom du patron SVG maillé', () => {
  it('utilise exactement la même normalisation que le téléchargement', () => {
    expect(patternSvgFilename('robe froncée')).toBe(
      'patron-robe-fronc-e.svg',
    );
  });
});
