import { describe, expect, it } from 'vitest';
import {
  draftPatternSvg,
  layoutDraftPattern,
} from '../src/app/draftPatternExport';
import { logicalCurveRuns } from '../src/app/PatternView';
import type { BodyMeasure } from '../src/engine/body/measure';
import {
  isSelfIntersecting,
  pairOutlineRuns,
  runCoversEdge,
  sanitizeDraft,
  type DraftPiece,
  type EdgeRun,
} from '../src/engine/pattern/Draft';
import { buildLoosePantsMesh } from '../src/engine/pattern/LoosePantsAssembly';
import {
  loosePants,
  loosePantsSizeLabel,
  LOOSE_PANTS_SIZES,
  pantsRuns,
} from '../src/engine/pattern/loosePants';
import { LOOSE_PANTS_DATA } from '../src/engine/pattern/loosePantsData';

const body = {
  waist: { y: 1.05 },
  hip: { circ: 1.0 },
} as BodyMeasure;

const runLength = (piece: DraftPiece, run: EdgeRun): number => {
  let total = 0;
  for (let edge = 0; edge < piece.outline.length; edge++) {
    if (!runCoversEdge(run, edge, piece.outline.length)) continue;
    const a = piece.outline[edge]!;
    const b = piece.outline[(edge + 1) % piece.outline.length]!;
    total += Math.hypot(
      (b[0] - a[0]) * piece.width,
      (b[1] - a[1]) * piece.height,
    );
  }
  return total;
};

describe('layered A0 loose-pants pattern', () => {
  it('contains every PDF size layer and the supplied chart labels', () => {
    expect(LOOSE_PANTS_SIZES).toEqual([
      '26', '27', '28', '29', '30', '31', '32', '33',
      '34', '35', '36', '38', '40', '42', '44', '46',
    ]);
    expect(loosePantsSizeLabel('32')).toContain('M / EU 48');
    expect(loosePantsSizeLabel('32')).toContain('81–86 cm');
    expect(loosePantsSizeLabel('32')).toContain('bassin 97–102 cm');
    expect(loosePantsSizeLabel('46')).toContain('5XL / EU 60');
  });

  it('keeps all eight cut outlines valid, bounded and below the Draft vertex cap', () => {
    for (const size of LOOSE_PANTS_SIZES) {
      for (const piece of Object.values(LOOSE_PANTS_DATA[size].pieces)) {
        expect(piece.outline.length).toBeGreaterThanOrEqual(7);
        expect(piece.outline.length).toBeLessThanOrEqual(128);
        expect(isSelfIntersecting(piece.outline)).toBe(false);
        for (const [u, v] of piece.outline) {
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('retains the measured PDF scale and grades monotonically', () => {
    expect(LOOSE_PANTS_DATA['26'].pieces.front.cutWidthCm).toBeCloseTo(33.17, 2);
    expect(LOOSE_PANTS_DATA['26'].pieces.front.cutHeightCm).toBeCloseTo(110.15, 2);
    expect(LOOSE_PANTS_DATA['46'].pieces.front.cutWidthCm).toBeCloseTo(44.82, 2);
    expect(LOOSE_PANTS_DATA['46'].pieces.front.cutHeightCm).toBeCloseTo(116.4, 2);

    const widths = LOOSE_PANTS_SIZES.map((size) => LOOSE_PANTS_DATA[size].pieces.front.cutWidthCm);
    const heights = LOOSE_PANTS_SIZES.map((size) => LOOSE_PANTS_DATA[size].pieces.front.cutHeightCm);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
      expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
    }
  });

  it('creates an editable eight-piece atelier document with construction metadata', () => {
    const doc = loosePants('32', body);
    expect(doc.preset).toBe('loose-pants');
    expect(doc.presetSize).toBe('32');
    expect(doc.piece.name).toBe('devant ×2');
    expect(doc.back?.name).toBe('dos ×2');
    expect(doc.pieces).toHaveLength(6);
    expect(doc.pieces?.every((piece) => piece.patternOnly)).toBe(true);
    expect(doc.pieces?.at(-1)?.onFold).toBe(true);
    expect(doc.pieces?.at(-1)?.name).toBe('ceinture pli ×1');

    const roundTrip = sanitizeDraft(JSON.parse(JSON.stringify(doc)));
    expect(roundTrip.preset).toBe('loose-pants');
    expect(roundTrip.presetSize).toBe('32');
    expect(roundTrip.pieces).toHaveLength(6);
    expect(roundTrip.pieces?.every((piece) => piece.patternOnly)).toBe(true);
  });

  it('présente la fourche et les contours arrondis comme des courbes logiques uniques', () => {
    const doc = loosePants('32', body);
    const centre = pantsRuns(doc.piece).center;
    const frontCurves = logicalCurveRuns(doc.piece);
    expect(frontCurves.some((run) => run.from === centre.from && run.to === centre.to)).toBe(true);
    expect(frontCurves.some((run) => run.indices.length >= 4)).toBe(true);
    const constructionCurves = (doc.pieces ?? []).flatMap((piece) => logicalCurveRuns(piece));
    expect(constructionCurves.length).toBeGreaterThanOrEqual(4);
  });

  it('exports all eight vector pieces at their original millimetre scale', () => {
    const layout = layoutDraftPattern(loosePants('32', body));
    expect(layout.pieces).toHaveLength(8);
    expect(
      Math.abs(
        layout.pieces[0]!.width -
          LOOSE_PANTS_DATA['32'].pieces.front.cutWidthCm * 10,
      ),
    ).toBeLessThan(0.051);
    expect(
      Math.abs(
        layout.pieces[0]!.height -
          LOOSE_PANTS_DATA['32'].pieces.front.cutHeightCm * 10,
      ),
    ).toBeLessThan(0.051);
    expect(
      Math.abs(
        layout.pieces[1]!.width -
          LOOSE_PANTS_DATA['32'].pieces.back.cutWidthCm * 10,
      ),
    ).toBeLessThan(0.051);
    expect(layout.pieces.at(-1)?.onFold).toBe(true);
    expect(layout.width).toBeGreaterThan(1000);
    expect(layout.height).toBeGreaterThan(1000);

    const svg = draftPatternSvg(
      loosePants('32', body),
      'pantalon-large-taille-32',
    );
    expect(svg).toMatch(/^<svg /);
    expect(svg.match(/class="cut"/g)).toHaveLength(8);
    expect(svg).toContain('width="100" height="100"');
    expect(svg).toContain('marge de couture 1,25 cm déjà incluse');
  });

  it('finds continuous waist, rise, inseam, outseam and hem runs at every size', () => {
    for (const size of LOOSE_PANTS_SIZES) {
      const doc = loosePants(size, body);
      const back = doc.back!;
      for (const piece of [doc.piece, back]) {
        const runs = pantsRuns(piece);
        for (const run of Object.values(runs)) {
          expect(runLength(piece, run)).toBeGreaterThan(0.01);
        }
        const centreWaist = piece.outline[runs.waist.from]!;
        const sideWaist = piece.outline[runs.waist.to]!;
        expect(centreWaist[0]).toBeLessThan(sideWaist[0]);
        expect(runs.center.to).toBe(runs.waist.from);
        expect(runLength(piece, runs.waist)).toBeLessThan(0.8);
        expect(runLength(piece, runs.center)).toBeLessThan(0.8);
      }
      const frontRuns = pantsRuns(doc.piece);
      const backRuns = pantsRuns(back);
      // Sewing instructions expect the two leg panels to meet without a large
      // gather; the source grading keeps both long seams within a few percent.
      expect(
        Math.abs(runLength(doc.piece, frontRuns.outseam) - runLength(back, backRuns.outseam)),
      ).toBeLessThan(0.12);
      expect(
        Math.abs(runLength(doc.piece, frontRuns.inseam) - runLength(back, backRuns.inseam)),
      ).toBeLessThan(0.12);
    }
  });

  it('compiles two mirrored legs (four simulated panels) while excluding notions', () => {
    const doc = loosePants('32', body);
    const mesh = buildLoosePantsMesh(doc, 32, body.hip.circ);
    expect(mesh.count).toBe(4 * 32 * 32);
    expect(mesh.seamCount).toBeGreaterThan(100);
    expect(mesh.triangleIndices.length).toBeGreaterThan(0);
    expect(mesh.anchorY).toHaveLength(mesh.count);
    expect(mesh.anchorReleaseSeconds).toBe(3);
  });

  it('places inseams toward the body centre and outseams toward the outside', () => {
    const doc = loosePants('32', body);
    const n = 32;
    const mesh = buildLoosePantsMesh(doc, n, body.hip.circ);
    const run = pantsRuns(doc.piece).waist;
    const waistCells = pairOutlineRuns(
      doc.piece,
      doc.piece,
      run,
      run,
      n,
    )!.a;
    const centre = waistCells[0]!;
    const side = waistCells.at(-1)!;
    const legParticles = 2 * n * n;
    const x = (index: number): number => mesh.positions[index * 4]!;

    // Mirrored left leg: side seam is farther left than centre front.
    expect(x(side)).toBeLessThan(x(centre));
    // Unmirrored right leg: side seam is farther right than centre front.
    expect(x(legParticles + side)).toBeGreaterThan(
      x(legParticles + centre),
    );
  });
});
