import { describe, expect, it } from 'vitest';
import { layoutDraftPattern } from '../src/app/draftPatternExport';
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
});
