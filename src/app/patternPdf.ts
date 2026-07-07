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
/** Seam allowance offset, meters (drawn 1 cm outside the cut line). */
const SEAM = 0.01;

export function frontOutline(mesh: ClothMeshData): { segs: Segment[]; seam: Segment[]; w: number; h: number; pieces: number } {
  const panelSize = mesh.resolution * mesh.resolution;

  // Boundary = triangle edges owned by a single front triangle, per garment.
  // Each surviving edge keeps its owning triangle's THIRD vertex — the
  // interior point — so the seam allowance can be offset the right way out,
  // even around a concave neckline.
  const byGarment = new Map<number, Map<string, [number, number, number]>>();
  const addEdge = (g: number, a: number, b: number, third: number): void => {
    let edges = byGarment.get(g);
    if (!edges) byGarment.set(g, (edges = new Map()));
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edges.has(key)) edges.delete(key);
    else edges.set(key, [a, b, third]);
  };
  for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
    const a = mesh.triangleIndices[t]!;
    const panel = Math.floor(a / panelSize);
    if (panel % 2 !== 0) continue; // back panels mirror their fronts
    const g = panel >> 1;
    const b = mesh.triangleIndices[t + 1]!;
    const c = mesh.triangleIndices[t + 2]!;
    addEdge(g, a, b, c);
    addEdge(g, b, c, a);
    addEdge(g, a, c, b);
  }

  // Rest pose is flat and vertical: (x, y) in meters → mm, y flipped so each
  // piece's top lands at the top of the paper. Pieces advance left to right.
  const GUTTER = 0.03; // 30 mm between pieces on the sheet
  const P = (i: number): [number, number] => [mesh.positions[i * 4]!, mesh.positions[i * 4 + 1]!];
  const segs: Segment[] = [];
  const seam: Segment[] = [];
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
    const toPaper = (x: number, y: number): [number, number] => [(x - minX + cursorX) * 1000, (maxY - y) * 1000];
    for (const [a, b, c] of edges.values()) {
      const [ax, ay] = P(a);
      const [bx, by] = P(b);
      const [px1, py1] = toPaper(ax, ay);
      const [px2, py2] = toPaper(bx, by);
      segs.push({ x1: px1, y1: py1, x2: px2, y2: py2 });
      // Outward edge normal: perpendicular to (b−a), flipped to point AWAY
      // from the interior vertex c. Offset both ends by the seam allowance.
      let nx = -(by - ay);
      let ny = bx - ax;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const [cx, cy] = P(c);
      if (nx * (cx - (ax + bx) / 2) + ny * (cy - (ay + by) / 2) > 0) {
        nx = -nx;
        ny = -ny;
      }
      const [sx1, sy1] = toPaper(ax + nx * SEAM, ay + ny * SEAM);
      const [sx2, sy2] = toPaper(bx + nx * SEAM, by + ny * SEAM);
      seam.push({ x1: sx1, y1: sy1, x2: sx2, y2: sy2 });
    }
    cursorX += maxX - minX + GUTTER;
    h = Math.max(h, maxY - minY);
    pieces++;
  }
  return { segs, seam, w: Math.max(0, cursorX - GUTTER) * 1000, h: h * 1000, pieces };
}

export function exportPatternPdf(mesh: ClothMeshData, garmentName: string): void {
  const { segs, seam, w, h, pieces } = frontOutline(mesh);
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

      // Segment drawer, clipped to this page (with a little slack).
      const draw = (list: Segment[]): void => {
        for (const s of list) {
          const x1 = s.x1 - ox + MARGIN;
          const y1 = s.y1 - oy + MARGIN;
          const x2 = s.x2 - ox + MARGIN;
          const y2 = s.y2 - oy + MARGIN;
          const pad = 5;
          if (Math.max(x1, x2) < MARGIN - pad || Math.min(x1, x2) > PAGE_W - MARGIN + pad) continue;
          if (Math.max(y1, y2) < MARGIN - pad || Math.min(y1, y2) > PAGE_H - MARGIN + pad) continue;
          pdf.line(x1, y1, x2, y2);
        }
      };

      // Seam-allowance line (dashed, grey): 1 cm outside the cut line, the
      // edge you actually cut along. Drawn first so the cut line sits on top.
      pdf.setDrawColor(150);
      pdf.setLineWidth(0.3);
      pdf.setLineDashPattern([2.5, 1.5], 0);
      draw(seam);
      pdf.setLineDashPattern([], 0);

      // Cut/stitch line (échelle 1:1): the seam line, where the pieces join.
      pdf.setDrawColor(0);
      pdf.setLineWidth(0.5);
      draw(segs);

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
        pdf.text('trait plein = couture · trait pointillé extérieur = coupe (marge 1 cm incluse)', MARGIN + 2, PAGE_H - MARGIN - 2);
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
