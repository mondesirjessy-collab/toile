import { describe, expect, it, vi } from 'vitest';
import {
  draftPatternSvgFilename,
  exportDraftPatternSvg,
  layoutDraftPattern,
} from '../src/app/draftPatternExport';
import type {
  DraftDoc,
  DraftPiece,
} from '../src/engine/pattern/Draft';

const piece = (): DraftPiece => ({
  outline: [[0, 0], [1, 0], [1, 1], [0, 1]],
  darts: [],
  seams: [],
  openEdges: [],
  width: 0.4,
  height: 0.5,
  topY: 1.5,
  gap: 0.3,
});

describe('numérotation du patron exporté', () => {
  it('conserve le pieceId lorsqu’un slot intermédiaire est absent', () => {
    const draft: DraftDoc = {
      format: 'toile-draft',
      version: 1,
      gridN: 32,
      piece: piece(),
      pieces: [piece()],
    };

    expect(layoutDraftPattern(draft).pieces.map(({ name }) => name)).toEqual([
      'Devant',
      'Pièce 3',
    ]);
  });

  it('retourne le nom exact qui sera présenté après le téléchargement SVG', () => {
    expect(draftPatternSvgFilename('Lucas Hoodie · taille M')).toBe(
      'patron-Lucas-Hoodie---taille-M.svg',
    );
  });

  it('nettoie aussi un export SVG de DraftDoc dont le clic échoue', () => {
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
      createObjectURL: vi.fn(() => 'blob:draft-svg-failed'),
      revokeObjectURL,
    });
    const draft: DraftDoc = {
      format: 'toile-draft',
      version: 1,
      gridN: 32,
      piece: piece(),
    };

    expect(() =>
      exportDraftPatternSvg(draft, 'Lucas Hoodie · taille M'),
    ).toThrow(failure);
    expect(anchor.download).toBe('patron-Lucas-Hoodie---taille-M.svg');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:draft-svg-failed');
  });
});
