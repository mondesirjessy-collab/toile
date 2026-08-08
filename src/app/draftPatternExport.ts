/**
 * Exact DraftDoc export.
 *
 * Unlike mesh-derived exports (which follow the simulation grid), this path
 * writes the original editable outline vertices directly in millimetres. It is
 * used by supplied paper patterns whose seam allowance is already in the cut
 * line and therefore must not be re-rasterised or offset a second time.
 */
import { jsPDF } from 'jspdf';
import {
  docPieces,
  draftPieceLabel,
  pointInPolygon,
  type DraftDoc,
  type DraftPiece,
} from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 12;
const OVERLAP = 8;
const GUTTER = 30;
const MAX_ROW_W = 1500;

export interface DraftPatternPieceLayout {
  internal: Array<{ points: Array<[number, number]>; closed: boolean; hole: boolean }>;
  notches: Array<{ x1: number; y1: number; x2: number; y2: number }>;
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
  internal: Array<{ points: Array<[number, number]>; closed: boolean; hole: boolean }>;
  notches: Array<{ x1: number; y1: number; x2: number; y2: number }>;
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
    // ▱ Lignes internes (style, pliure, repères) : même repère que le contour.
    internal: (piece.internalLines ?? []).map((line) => ({
      closed: line.closed === true,
      hole: line.closed === true && line.hole === true,
      points: line.points.map(
        ([u, v]): [number, number] => [
          u * piece.width * 1000 - minX,
          v * piece.height * 1000 - minY,
        ],
      ),
    })),
    // ⌵ Crans : trait perpendiculaire de 6 mm vers l'extérieur du contour.
    notches: (piece.notches ?? []).map((notch) => {
      const N = piece.outline.length;
      const W = piece.width * 1000;
      const H = piece.height * 1000;
      let bestE = 0;
      let bestT = 0;
      let bestD = Infinity;
      for (let e = 0; e < N; e++) {
        const a = piece.outline[e]!;
        const b = piece.outline[(e + 1) % N]!;
        const ex = (b[0] - a[0]) * W;
        const ey = (b[1] - a[1]) * H;
        const px = (notch.at[0] - a[0]) * W;
        const py = (notch.at[1] - a[1]) * H;
        const len2 = ex * ex + ey * ey || 1e-12;
        const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
        const d = Math.hypot(px - t * ex, py - t * ey);
        if (d < bestD) {
          bestD = d;
          bestE = e;
          bestT = t;
        }
      }
      const a = piece.outline[bestE]!;
      const b = piece.outline[(bestE + 1) % N]!;
      const bx = (a[0] + (b[0] - a[0]) * bestT) * W;
      const by = (a[1] + (b[1] - a[1]) * bestT) * H;
      const ex = (b[0] - a[0]) * W;
      const ey = (b[1] - a[1]) * H;
      const el = Math.hypot(ex, ey) || 1e-9;
      let nx = -ey / el;
      let ny = ex / el;
      const probeUV: [number, number] = [(bx + nx * 2) / W, (by + ny * 2) / H];
      if (pointInPolygon(probeUV, piece.outline)) {
        nx = -nx;
        ny = -ny;
      }
      return {
        x1: bx - minX,
        y1: by - minY,
        x2: bx + nx * 6 - minX,
        y2: by + ny * 6 - minY,
      };
    }),
    width: maxX - minX,
    height: maxY - minY,
  };
};

/** Shelf-pack every cut piece while retaining exact physical dimensions. */
export function layoutDraftPattern(doc: DraftDoc): DraftPatternLayout {
  const source = docPieces(doc)
    .map((piece, pieceId) => ({ piece, pieceId }))
    .filter(
      (entry): entry is { piece: DraftPiece; pieceId: number } =>
        !!entry.piece && !entry.piece.blank, // le socle vide ne s'exporte pas
    );
  const pieces: DraftPatternPieceLayout[] = [];
  let rowX = 0;
  let rowY = 0;
  let rowH = 0;
  let width = 0;

  source.forEach(({ piece, pieceId }) => {
    const cut = cutExtent(piece);
    if (rowX > 0 && rowX + cut.width > MAX_ROW_W) {
      rowY += rowH + GUTTER;
      rowX = 0;
      rowH = 0;
    }
    pieces.push({
      name: draftPieceLabel(piece, pieceId),
      cut: piece.cut ?? (pieceId < 2 ? 2 : 1),
      onFold: piece.onFold === true,
      points: cut.points.map(([x, y]) => [x + rowX, y + rowY]),
      internal: cut.internal.map((line) => ({
        closed: line.closed,
        hole: line.hole,
        points: line.points.map(([x, y]): [number, number] => [x + rowX, y + rowY]),
      })),
      notches: cut.notches.map((n) => ({
        x1: n.x1 + rowX,
        y1: n.y1 + rowY,
        x2: n.x2 + rowX,
        y2: n.y2 + rowY,
      })),
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

const layoutNotchSegments = (layout: DraftPatternLayout): Segment[] =>
  layout.pieces.flatMap((piece) => piece.notches.map((n) => ({ x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 })));

const internalLineSegments = (
  layout: DraftPatternLayout,
  keep: (line: { hole: boolean }) => boolean,
): Segment[] =>
  layout.pieces.flatMap((piece) =>
    piece.internal.filter(keep).flatMap((line) => {
      const segs: Segment[] = [];
      const n = line.closed ? line.points.length : line.points.length - 1;
      for (let i = 0; i < n; i++) {
        const a = line.points[i]!;
        const b = line.points[(i + 1) % line.points.length]!;
        segs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      }
      return segs;
    }),
  );

const layoutInternalSegments = (layout: DraftPatternLayout): Segment[] =>
  internalLineSegments(layout, (line) => !line.hole);

/** ⌾ Trous : arêtes en trait de COUPE plein sur le PDF (des ciseaux passent). */
const layoutHoleSegments = (layout: DraftPatternLayout): Segment[] =>
  internalLineSegments(layout, (line) => line.hole);

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
export const draftPatternSvgFilename = (garmentName: string): string =>
  `patron-${safeName(garmentName)}.svg`;
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
      const notchMarks = piece.notches
        .map(
          (n) =>
            `<line x1="${(n.x1 + PAD).toFixed(2)}" y1="${(n.y1 + PAD + HEADER).toFixed(2)}" x2="${(n.x2 + PAD).toFixed(2)}" y2="${(n.y2 + PAD + HEADER).toFixed(2)}" class="notch"/>`,
        )
        .join('');
      const marks = piece.internal
        .map((line) => {
          const md = line.points
            .map(([x, y], index) => `${index ? 'L' : 'M'}${(x + PAD).toFixed(2)} ${(y + PAD + HEADER).toFixed(2)}`)
            .join(' ');
          return `<path d="${md}${line.closed ? ' Z' : ''}" class="${line.hole ? 'cutout' : 'mark'}"/>`;
        })
        .join('');
      return (
        `<path d="${d} Z" class="cut"/>` +
        marks +
        notchMarks +
        `<line x1="${cx.toFixed(2)}" y1="${grainTop.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${grainBottom.toFixed(2)}" class="grain"/>` +
        `<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" class="piece">${escapeXml(note)}</text>`
      );
    })
    .join('');
  const squareY = layout.height + PAD + HEADER + 20;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW.toFixed(1)}mm" height="${totalH.toFixed(1)}mm" viewBox="0 0 ${totalW.toFixed(1)} ${totalH.toFixed(1)}">` +
    `<style>.cut{fill:none;stroke:#111;stroke-width:.7;stroke-linejoin:round}.grain{stroke:#777;stroke-width:.45;stroke-dasharray:6 3}.mark{fill:none;stroke:#555;stroke-width:.4;stroke-dasharray:4 2.5}.cutout{fill:none;stroke:#111;stroke-width:.7;stroke-linejoin:round}.notch{stroke:#111;stroke-width:.6}.piece{font:8px sans-serif;text-anchor:middle;fill:#222}.head{font:7px sans-serif;fill:#111}.note{font:5px sans-serif;fill:#333}.ctrl{fill:none;stroke:#111;stroke-width:.5}</style>` +
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
): string | null {
  const svg = draftPatternSvg(doc, garmentName, seamAllowanceCm);
  if (!svg) return null;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const filename = draftPatternSvgFilename(garmentName);
  return downloadBrowserBlob(blob, filename);
}

export function exportDraftPatternPdf(
  doc: DraftDoc,
  garmentName: string,
  seamAllowanceCm = 1.25,
): void {
  const layout = layoutDraftPattern(doc);
  const segments = layoutSegments(layout);
  const markSegments = layoutInternalSegments(layout);
  const holeSegments = layoutHoleSegments(layout);
  const notchSegments = layoutNotchSegments(layout);
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
      // ▱ Repères internes : trait fin pointillé, distinct du bord de coupe.
      if (markSegments.length) {
        pdf.setDrawColor(90);
        pdf.setLineWidth(0.3);
        pdf.setLineDashPattern([2.5, 1.8], 0);
        for (const segment of markSegments) {
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
        pdf.setLineDashPattern([], 0);
      }
      // ⌾ Trous : trait de COUPE plein, comme le contour — des ciseaux passent.
      if (holeSegments.length) {
        pdf.setDrawColor(0);
        pdf.setLineWidth(0.5);
        for (const segment of holeSegments) {
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
      }
      // ⌵ Crans : trait plein court, mêmes règles de découpe en tuiles.
      if (notchSegments.length) {
        pdf.setDrawColor(0);
        pdf.setLineWidth(0.5);
        for (const segment of notchSegments) {
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
          if (clipped) pdf.line(clipped[0], clipped[1], clipped[2], clipped[3]);
        }
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
