import { describe, expect, it, vi } from 'vitest';
import {
  exportPatternSvg,
  patternSvgFilename,
} from '../src/app/patternSvg';
import { generateSeamedPanels } from '../src/engine/cloth/ClothMesh';

describe('nom du patron SVG maillé', () => {
  it('utilise exactement la même normalisation que le téléchargement', () => {
    expect(patternSvgFilename('robe froncée')).toBe(
      'patron-robe-fronc-e.svg',
    );
  });

  it('retire l’ancre et révoque immédiatement le Blob si le clic échoue', () => {
    const failure = new Error('navigation bloquée');
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(() => {
        throw failure;
      }),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:svg-failed'),
      revokeObjectURL,
    });
    const mesh = generateSeamedPanels({
      resolution: 8,
      width: 1.15,
      height: 0.75,
      gap: 0.9,
      topY: 1.52,
      shape: 'tshirt',
    });

    expect(() => exportPatternSvg(mesh, 'robe froncée')).toThrow(failure);
    expect(anchor.download).toBe('patron-robe-fronc-e.svg');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:svg-failed');
  });
});
