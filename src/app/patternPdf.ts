/**
 * patternPdf — the bridge to a real sewing table.
 *
 * Exports the current garment's FRONT pattern pieces as a 1:1 scale PDF,
 * tiled over A4 pages (home-sewing style): print at 100 %, tape the pages
 * following the row/column labels, cut on the lines, sew. Page 1 carries a
 * 100 mm calibration square — if it measures 100 mm, the scale is right.
 */
import { jsPDF } from 'jspdf';
import type { ClothMeshData } from '../engine/cloth/ClothMesh';

const PAGE_W = 210; // A4 portrait, mm
const PAGE_H = 297;
const MARGIN = 12; // printable frame
const OVERLAP = 8; // glue band shared between adjacent pages

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Cut-line segments of the front pieces, in millimeters, y pointing down.
 * An outfit (combined mesh) has one front piece PER GARMENT — panels 0, 2, 4…
 * They share the same rest-pose axis, so printing them in place would stack
 * their cut lines; instead each piece is laid out side by side on the sheet,
 * like a real cutting layout. Exposed for tests.
 */
export function frontOutline(mesh: ClothMeshData): { segs: Segment[]; w: number; h: number; pieces: number } {
  const panelSize = mesh.resolution * mesh.resolution;

  // Boundary = triangle edges owned by a single front triangle, per garment.
  const byGarment = new Map<number, Map<string, [number, number]>>();
  const addEdge = (g: number, a: number, b: number): void => {
    let edges = byGarment.get(g);
    if (!edges) byGarment.set(g, (edges = new Map()));
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edges.has(key)) edges.delete(key);
    else edges.set(key, [a, b]);
  };
  for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
    const a = mesh.triangleIndices[t]!;
    const panel = Math.floor(a / panelSize);
    if (panel % 2 !== 0) continue; // back panels mirror their fronts
    const g = panel >> 1;
    const b = mesh.triangleIndices[t + 1]!;
    const c = mesh.triangleIndices[t + 2]!;
    addEdge(g, a, b);
    addEdge(g, b, c);
    addEdge(g, a, c);
  }

  // Rest pose is flat and vertical: (x, y) in meters → mm, y flipped so each
  // piece's top lands at the top of the paper. Pieces advance left to right.
  const GUTTER = 0.03; // 30 mm between pieces on the sheet
  const P = (i: number): [number, number] => [mesh.positions[i * 4]!, mesh.positions[i * 4 + 1]!];
  const segs: Segment[] = [];
  let cursorX = 0;
  let h = 0;
  let pieces = 0;
  for (const g of [...byGarment.keys()].sort((x, y) => x - y)) {
    const edges = byGarment.get(g)!;
    if (!edges.size) continue;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [a, b] of edges.values()) {
      for (const [x, y] of [P(a), P(b)]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    for (const [a, b] of edges.values()) {
      const [ax, ay] = P(a);
      const [bx, by] = P(b);
      segs.push({
        x1: (ax - minX + cursorX) * 1000,
        y1: (maxY - ay) * 1000,
        x2: (bx - minX + cursorX) * 1000,
        y2: (maxY - by) * 1000,
      });
    }
    cursorX += maxX - minX + GUTTER;
    h = Math.max(h, maxY - minY);
    pieces++;
  }
  return { segs, w: Math.max(0, cursorX - GUTTER) * 1000, h: h * 1000, pieces };
}

export function exportPatternPdf(mesh: ClothMeshData, garmentName: string): void {
  const { segs, w, h, pieces } = frontOutline(mesh);
  if (!segs.length || !Number.isFinite(w + h)) return;

  const cellW = PAGE_W - 2 * MARGIN - OVERLAP;
  const cellH = PAGE_H - 2 * MARGIN - OVERLAP;
  const cols = Math.max(1, Math.ceil(w / cellW));
  const rows = Math.max(1, Math.ceil(h / cellH));

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r > 0 || c > 0) pdf.addPage();
      const ox = c * cellW; // pattern-space origin of this page, mm
      const oy = r * cellH;

      // Assembly frame + label + glue guides.
      pdf.setDrawColor(180);
      pdf.setLineWidth(0.2);
      pdf.rect(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN);
      pdf.setLineDashPattern([2, 2], 0);
      if (c < cols - 1) pdf.line(PAGE_W - MARGIN - OVERLAP, MARGIN, PAGE_W - MARGIN - OVERLAP, PAGE_H - MARGIN);
      if (r < rows - 1) pdf.line(MARGIN, PAGE_H - MARGIN - OVERLAP, PAGE_W - MARGIN, PAGE_H - MARGIN - OVERLAP);
      pdf.setLineDashPattern([], 0);
      pdf.setFontSize(9);
      pdf.setTextColor(140);
      pdf.text(`${garmentName} — page ${String.fromCharCode(65 + r)}${c + 1} / ${String.fromCharCode(65 + rows - 1)}${cols}`, MARGIN, MARGIN - 3);

      // Cut lines (échelle 1:1).
      pdf.setDrawColor(0);
      pdf.setLineWidth(0.5);
      for (const s of segs) {
        const x1 = s.x1 - ox + MARGIN;
        const y1 = s.y1 - oy + MARGIN;
        const x2 = s.x2 - ox + MARGIN;
        const y2 = s.y2 - oy + MARGIN;
        // Keep only segments touching this page (with a little slack).
        const pad = 5;
        if (Math.max(x1, x2) < MARGIN - pad || Math.min(x1, x2) > PAGE_W - MARGIN + pad) continue;
        if (Math.max(y1, y2) < MARGIN - pad || Math.min(y1, y2) > PAGE_H - MARGIN + pad) continue;
        pdf.line(x1, y1, x2, y2);
      }

      if (r === 0 && c === 0) {
        // Calibration square + grain line + instructions.
        pdf.setDrawColor(0);
        pdf.setLineWidth(0.4);
        pdf.rect(PAGE_W - MARGIN - 105, MARGIN + 3, 100, 100);
        pdf.setFontSize(8);
        pdf.setTextColor(0);
        pdf.text('carré de contrôle : 100 × 100 mm — imprimer à 100 % (échelle réelle)', PAGE_W - MARGIN - 105, MARGIN + 108);
        pdf.text(
          pieces > 1
            ? `TOILE — ${pieces} pièces AVANT côte à côte · couper chaque dos à l’identique · droit-fil vertical`
            : 'TOILE — pièce AVANT · couper le dos à l’identique · droit-fil vertical',
          MARGIN + 2,
          PAGE_H - MARGIN - 6,
        );
        pdf.text('marges de couture NON incluses : ajouter 1 cm à la coupe', MARGIN + 2, PAGE_H - MARGIN - 2);
        // Grain arrow.
        const gx = MARGIN + 12;
        pdf.setLineWidth(0.5);
        pdf.line(gx, MARGIN + 20, gx, MARGIN + 70);
        pdf.line(gx, MARGIN + 20, gx - 2, MARGIN + 25);
        pdf.line(gx, MARGIN + 20, gx + 2, MARGIN + 25);
      }
    }
  }
  pdf.save(`patron-${garmentName.replace(/[^a-z0-9]/gi, '-')}.pdf`);
}
