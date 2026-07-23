/**
 * Exact DraftDoc export.
 *
 * Unlike mesh-derived exports (which follow the simulation grid), this path
 * writes the original editable outline vertices directly in millimetres. It is
 * used by supplied paper patterns whose seam allowance is already in the cut
 * line and therefore must not be re-rasterised or offset a second time.
 */
import { jsPDF } from 'jspdf';
import { docPieces, type DraftDoc, type DraftPiece } from '../engine/pattern/Draft';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 12;
const OVERLAP = 8;
const GUTTER = 30;
const MAX_ROW_W = 1500;

export interface DraftPatternPieceLayout {
  name: string;
  cut: number;
  onFold: boolean;
  points: Array<[number, number]>;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftPatternLayout {
  pieces: DraftPatternPieceLayout[];
  width: number;
  height: number;
}

const cutExtent = (piece: DraftPiece): {
  points: Array<[number, number]>;
  width: number;
  height: number;
} => {
  const physical = piece.outline.map(
    ([u, v]): [number, number] => [u * piece.width * 1000, v * piece.height * 1000],
  );
  const minX = Math.min(...physical.map((p) => p[0]));
  const minY = Math.min(...physical.map((p) => p[1]));
  const maxX = Math.max(...physical.map((p) => p[0]));
  const maxY = Math.max(...physical.map((p) => p[1]));
  return {
    points: physical.map(([x, y]) => [x - minX, y - minY]),
    width: maxX - minX,
    height: maxY - minY,
  };
};

/** Shelf-pack every cut piece while retaining exact physical dimensions. */
export function layoutDraftPattern(doc: DraftDoc): DraftPatternLayout {
  const source = docPieces(doc).filter((p): p is DraftPiece => !!p);
  const pieces: DraftPatternPieceLayout[] = [];
  let rowX = 0;
  let rowY = 0;
  let rowH = 0;
  let width = 0;

  source.forEach((piece, index) => {
    const cut = cutExtent(piece);
    if (rowX > 0 && rowX + cut.width > MAX_ROW_W) {
      rowY += rowH + GUTTER;
      rowX = 0;
      rowH = 0;
    }
    pieces.push({
      name: piece.name ?? (index === 0 ? 'devant' : index === 1 ? 'dos' : `pièce ${index + 1}`),
      cut: piece.cut ?? (index < 2 ? 2 : 1),
      onFold: piece.onFold === true,
      points: cut.points.map(([x, y]) => [x + rowX, y + rowY]),
      x: rowX,
      y: rowY,
      width: cut.width,
      height: cut.height,
    });
    rowX += cut.width + GUTTER;
    rowH = Math.max(rowH, cut.height);
    width = Math.max(width, rowX - GUTTER);
  });

  return {
    pieces,
    width,
    height: rowY + rowH,
  };
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const layoutSegments = (layout: DraftPatternLayout): Segment[] =>
  layout.pieces.flatMap((piece) =>
    piece.points.map((point, index) => {
      const next = piece.points[(index + 1) % piece.points.length]!;
      return { x1: point[0], y1: point[1], x2: next[0], y2: next[1] };
    }),
  );

function clipToRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): [number, number, number, number] | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return null;
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return null;
        t0 = Math.max(t0, t);
      } else {
        if (t < t0) return null;
        t1 = Math.min(t1, t);
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

const safeName = (name: string): string => name.replace(/[^a-z0-9]/gi, '-');
const escapeXml = (value: string): string =>
  value.replace(
    /[<>&'"]/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[
        char
      ]!,
  );

/** Build the exact printable SVG without touching the browser. */
export function draftPatternSvg(
  doc: DraftDoc,
  garmentName: string,
  seamAllowanceCm = 1.25,
): string {
  const layout = layoutDraftPattern(doc);
  if (!layout.pieces.length) return '';
  const PAD = 25;
  const HEADER = 35;
  const totalW = layout.width + 2 * PAD;
  const totalH = layout.height + 2 * PAD + HEADER + 120;
  const paths = layout.pieces
    .map((piece) => {
      const d = piece.points
        .map(([x, y], index) => `${index ? 'L' : 'M'}${(x + PAD).toFixed(2)} ${(y + PAD + HEADER).toFixed(2)}`)
        .join(' ');
      const cx = piece.x + piece.width / 2 + PAD;
      const cy = piece.y + piece.height / 2 + PAD + HEADER;
      const note = `${piece.name} · couper ${piece.cut}${piece.onFold ? ' sur pli' : ''}`;
      const grainTop = piece.y + piece.height * 0.15 + PAD + HEADER;
      const grainBottom = piece.y + piece.height * 0.85 + PAD + HEADER;
      return (
        `<path d="${d} Z" class="cut"/>` +
        `<line x1="${cx.toFixed(2)}" y1="${grainTop.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${grainBottom.toFixed(2)}" class="grain"/>` +
        `<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" class="piece">${escapeXml(note)}</text>`
      );
    })
    .join('');
  const squareY = layout.height + PAD + HEADER + 20;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW.toFixed(1)}mm" height="${totalH.toFixed(1)}mm" viewBox="0 0 ${totalW.toFixed(1)} ${totalH.toFixed(1)}">` +
    `<style>.cut{fill:none;stroke:#111;stroke-width:.7;stroke-linejoin:round}.grain{stroke:#777;stroke-width:.45;stroke-dasharray:6 3}.piece{font:8px sans-serif;text-anchor:middle;fill:#222}.head{font:7px sans-serif;fill:#111}.note{font:5px sans-serif;fill:#333}.ctrl{fill:none;stroke:#111;stroke-width:.5}</style>` +
    `<text x="${PAD}" y="14" class="head">TOILE — ${escapeXml(garmentName)} · patron vectoriel 1:1 · imprimer à 100 %</text>` +
    `<text x="${PAD}" y="25" class="note">Trait plein = coupe · marge de couture ${seamAllowanceCm.toFixed(2).replace('.', ',')} cm déjà incluse · droit-fil pointillé</text>` +
    paths +
    `<rect x="${PAD}" y="${squareY.toFixed(1)}" width="100" height="100" class="ctrl"/>` +
    `<text x="${PAD + 105}" y="${(squareY + 52).toFixed(1)}" class="note">carré de contrôle 100 × 100 mm</text>` +
    `</svg>`
  );
}

export function exportDraftPatternSvg(
  doc: DraftDoc,
  garmentName: string,
  seamAllowanceCm = 1.25,
): void {
  const svg = draftPatternSvg(doc, garmentName, seamAllowanceCm);
  if (!svg) return;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `patron-${safeName(garmentName)}.svg`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 30000);
}

export function exportDraftPatternPdf(
  doc: DraftDoc,
  garmentName: string,
  seamAllowanceCm = 1.25,
): void {
  const layout = layoutDraftPattern(doc);
  const segments = layoutSegments(layout);
  if (!segments.length) return;
  const cellW = PAGE_W - 2 * MARGIN - OVERLAP;
  const cellH = PAGE_H - 2 * MARGIN - OVERLAP;
  const cols = Math.max(1, Math.ceil((layout.width - OVERLAP) / cellW));
  const rows = Math.max(1, Math.ceil((layout.height - OVERLAP) / cellH));
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });

  pdf.setFontSize(16);
  pdf.text('TOILE — patron vectoriel 1:1', MARGIN, MARGIN + 6);
  pdf.setFontSize(9);
  pdf.text(
    `${garmentName} · ${layout.pieces.length} pièces de coupe · marge ${seamAllowanceCm
      .toFixed(2)
      .replace('.', ',')} cm déjà incluse`,
    MARGIN,
    MARGIN + 14,
  );
  pdf.rect(PAGE_W - MARGIN - 105, MARGIN + 3, 100, 100);
  pdf.text('carré de contrôle 100 × 100 mm — imprimer à 100 %', MARGIN, MARGIN + 115);
  pdf.text(
    [
      'Assembler les pages selon leurs coordonnées (A1, A2…).',
      'Le trait plein est le bord de coupe exact du PDF source.',
      'La marge de couture est déjà comprise : ne pas en ajouter une seconde.',
      ...layout.pieces.map(
        (piece, index) =>
          `${index + 1}. ${piece.name} — couper ${piece.cut}${piece.onFold ? ' sur pli' : ''}`,
      ),
    ],
    MARGIN,
    MARGIN + 130,
    { maxWidth: PAGE_W - 2 * MARGIN, lineHeightFactor: 1.45 },
  );

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      pdf.addPage();
      const ox = col * cellW;
      const oy = row * cellH;
      pdf.setDrawColor(180);
      pdf.setLineWidth(0.2);
      pdf.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN);
      pdf.setLineDashPattern([2, 2], 0);
      if (col < cols - 1)
        pdf.line(
          PAGE_W - MARGIN - OVERLAP,
          MARGIN,
          PAGE_W - MARGIN - OVERLAP,
          PAGE_H - MARGIN,
        );
      if (row < rows - 1)
        pdf.line(
          MARGIN,
          PAGE_H - MARGIN - OVERLAP,
          PAGE_W - MARGIN,
          PAGE_H - MARGIN - OVERLAP,
        );
      pdf.setLineDashPattern([], 0);
      pdf.setFontSize(8);
      pdf.setTextColor(130);
      pdf.text(
        `${garmentName} — ${String.fromCharCode(65 + row)}${col + 1}`,
        MARGIN,
        MARGIN - 3,
      );

      pdf.setDrawColor(0);
      pdf.setLineWidth(0.5);
      for (const segment of segments) {
        const clipped = clipToRect(
          segment.x1 - ox + MARGIN,
          segment.y1 - oy + MARGIN,
          segment.x2 - ox + MARGIN,
          segment.y2 - oy + MARGIN,
          MARGIN,
          MARGIN,
          PAGE_W - MARGIN,
          PAGE_H - MARGIN,
        );
        if (clipped)
          pdf.line(clipped[0], clipped[1], clipped[2], clipped[3]);
      }

      pdf.setFontSize(7);
      for (const piece of layout.pieces) {
        const x = piece.x + piece.width / 2 - ox + MARGIN;
        const y = piece.y + piece.height / 2 - oy + MARGIN;
        if (
          x >= MARGIN &&
          x <= PAGE_W - MARGIN &&
          y >= MARGIN &&
          y <= PAGE_H - MARGIN
        ) {
          pdf.text(
            `${piece.name} · ×${piece.cut}${piece.onFold ? ' · PLI' : ''}`,
            x,
            y,
            { align: 'center' },
          );
        }
      }
    }
  }
  pdf.save(`patron-${safeName(garmentName)}.pdf`);
}
