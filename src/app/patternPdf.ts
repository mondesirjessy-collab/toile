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
/** Default seam allowance offset, meters (1 cm outside the cut line). */
const SEAM = 0.01;

export function frontOutline(
  mesh: ClothMeshData,
  margin: number = SEAM,
): { segs: Segment[]; seam: Segment[]; notches: Segment[]; labels: { x: number; y: number; n: number }[]; w: number; h: number; pieces: number } {
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
  const notches: Segment[] = []; // short assembly ticks, kept apart from the boundary cut lines
  const labels: { x: number; y: number; n: number }[] = []; // piece number at each piece's centroid (mm)
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
    const gSegs: Segment[] = []; // this piece's cut lines, for the notch scanlines
    for (const [a, b, c] of edges.values()) {
      const [ax, ay] = P(a);
      const [bx, by] = P(b);
      const [px1, py1] = toPaper(ax, ay);
      const [px2, py2] = toPaper(bx, by);
      segs.push({ x1: px1, y1: py1, x2: px2, y2: py2 });
      gSegs.push({ x1: px1, y1: py1, x2: px2, y2: py2 });
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
      const [sx1, sy1] = toPaper(ax + nx * margin, ay + ny * margin);
      const [sx2, sy2] = toPaper(bx + nx * margin, by + ny * margin);
      seam.push({ x1: sx1, y1: sy1, x2: sx2, y2: sy2 });
    }
    // Balance notches (repères de montage): short inward ticks on each side seam
    // at 1/3 and 2/3 of the piece height, so the front and its back can be
    // aligned when sewing. A horizontal scanline gives the two seam edges.
    const gh = (maxY - minY) * 1000;
    const TICK = 6; // mm
    for (const frac of [0.34, 0.66]) {
      const yy = gh * frac;
      const xs: number[] = [];
      for (const s of gSegs) {
        if (s.y1 === s.y2) continue;
        if ((s.y1 <= yy) !== (s.y2 <= yy)) xs.push(s.x1 + ((yy - s.y1) / (s.y2 - s.y1)) * (s.x2 - s.x1));
      }
      if (xs.length < 2) continue;
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      if (hi - lo < 2 * TICK + 4) continue; // too narrow here for a readable notch
      notches.push({ x1: lo, y1: yy, x2: lo + TICK, y2: yy });
      notches.push({ x1: hi, y1: yy, x2: hi - TICK, y2: yy });
    }
    // Piece number, at the piece's centroid (so a multi-piece sheet — body,
    // collar, sleeves, your drawn pieces — tells you which shape is which).
    labels.push({ x: ((maxX - minX) / 2 + cursorX) * 1000, y: ((maxY - minY) / 2) * 1000, n: pieces + 1 });
    cursorX += maxX - minX + GUTTER;
    h = Math.max(h, maxY - minY);
    pieces++;
  }
  return { segs, seam, notches, labels, w: Math.max(0, cursorX - GUTTER) * 1000, h: h * 1000, pieces };
}

/**
 * Liang–Barsky: clip segment (x1,y1)-(x2,y2) to the rectangle, or null if it
 * lies entirely outside. Keeps a printed cut line from overstriking the page
 * label, the frame, or spilling past the tile it belongs to.
 */
function clipToRect(
  x1: number, y1: number, x2: number, y2: number,
  xmin: number, ymin: number, xmax: number, ymax: number,
): [number, number, number, number] | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return null; // parallel and outside
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

export function exportPatternPdf(mesh: ClothMeshData, garmentName: string, hasIndependentBack = false, margin: number = SEAM): void {
  const { segs, seam, notches, labels, w, h, pieces } = frontOutline(mesh, margin);
  if (!segs.length || !Number.isFinite(w + h)) return;
  const cm = margin * 100;
  const marginCm = (Number.isInteger(cm) ? String(cm) : cm.toFixed(1)).replace('.', ',');

  const cellW = PAGE_W - 2 * MARGIN - OVERLAP;
  const cellH = PAGE_H - 2 * MARGIN - OVERLAP;
  // Each page's frame is cellW + OVERLAP wide but only ADVANCES by cellW, so k
  // pages cover k·cellW + OVERLAP. Sizing the grid by ceil(w / cellW) prints a
  // whole extra near-empty column whenever w spills past a multiple by ≤ OVERLAP
  // — content already inside the previous page's glue band.
  const cols = Math.max(1, Math.ceil((w - OVERLAP) / cellW));
  const rows = Math.max(1, Math.ceil((h - OVERLAP) / cellH));

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });

  // Cover page (audit M22): the 100 mm calibration square, grain arrow and
  // instructions used to be drawn ON page A1, on top of the pattern geometry —
  // a garment wider than ~80 mm ran under the square and its solid edges read
  // as stray cut lines. They now live on their own page so they never collide
  // with the pieces; the pattern grid starts on page 2.
  pdf.setFontSize(16);
  pdf.setTextColor(0);
  pdf.text('TOILE — patron 1:1', MARGIN, MARGIN + 6);
  pdf.setFontSize(9);
  pdf.setTextColor(60);
  pdf.text(`${garmentName} · ${pieces > 1 ? `${pieces} pièces AVANT` : 'pièce AVANT'} · droit-fil vertical`, MARGIN, MARGIN + 13);
  // Calibration square.
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.4);
  pdf.rect(PAGE_W - MARGIN - 105, MARGIN + 3, 100, 100);
  pdf.setFontSize(8);
  pdf.setTextColor(0);
  pdf.text('carré de contrôle : 100 × 100 mm — imprimer à 100 % (échelle réelle)', PAGE_W - MARGIN - 105, MARGIN + 108);
  // Grain arrow.
  {
    const gx = MARGIN + 12;
    pdf.setLineWidth(0.5);
    pdf.line(gx, MARGIN + 30, gx, MARGIN + 80);
    pdf.line(gx, MARGIN + 30, gx - 2, MARGIN + 35);
    pdf.line(gx, MARGIN + 30, gx + 2, MARGIN + 35);
    pdf.setFontSize(8);
    pdf.text('droit-fil', gx + 4, MARGIN + 55);
  }
  // Instructions.
  pdf.setFontSize(10);
  pdf.setTextColor(0);
  pdf.text(
    [
      '1. Imprimer toutes les pages à 100 % (échelle réelle) — vérifier le carré de contrôle ci-dessus.',
      '2. Assembler les pages en suivant les repères de ligne/colonne (A1, A2… en marge).',
      '3. Coller le long des bandes pointillées.',
      `4. Couper sur le trait pointillé extérieur (marge de couture ${marginCm} cm incluse).`,
      hasIndependentBack
        ? '5. Le trait plein = ligne de couture. Le DOS a été dessiné à part (non inclus dans ces pages).'
        : '5. Le trait plein = ligne de couture. Couper chaque dos à l’identique.',
      '6. Les petits traits sur les côtés = repères de montage : les faire coïncider pour aligner devant et dos.',
    ],
    MARGIN,
    MARGIN + 130,
    { maxWidth: PAGE_W - 2 * MARGIN, lineHeightFactor: 1.6 },
  );

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pdf.addPage(); // cover is page 1; every pattern tile gets its own page
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
      // Repeat the seam-allowance caveat on every sheet (audit M22): a sewer
      // working from page D3 shouldn't have to flip back to the cover.
      pdf.text(`trait plein = couture · pointillé extérieur = coupe (marge ${marginCm} cm incluse)`, PAGE_W - MARGIN, MARGIN - 3, { align: 'right' });

      // Segment drawer, clipped to this page's printable frame so no cut line
      // spills over the label or past the tile it belongs to.
      const draw = (list: Segment[]): void => {
        for (const s of list) {
          const clipped = clipToRect(
            s.x1 - ox + MARGIN, s.y1 - oy + MARGIN, s.x2 - ox + MARGIN, s.y2 - oy + MARGIN,
            MARGIN, MARGIN, PAGE_W - MARGIN, PAGE_H - MARGIN,
          );
          if (clipped) pdf.line(clipped[0], clipped[1], clipped[2], clipped[3]);
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

      // Balance notches (assembly marks), same clip so they never spill a tile.
      pdf.setLineWidth(0.7);
      draw(notches);

      // Piece numbers (only on a multi-piece sheet): drawn on the page whose
      // printable frame contains the piece's centroid, so each number shows once.
      if (pieces > 1) {
        pdf.setFontSize(18);
        pdf.setTextColor(0);
        for (const l of labels) {
          const lx = l.x - ox + MARGIN;
          const ly = l.y - oy + MARGIN;
          if (lx >= MARGIN && lx <= PAGE_W - MARGIN && ly >= MARGIN && ly <= PAGE_H - MARGIN) {
            pdf.text(String(l.n), lx, ly, { align: 'center' });
          }
        }
      }
    }
  }
  pdf.save(`patron-${garmentName.replace(/[^a-z0-9]/gi, '-')}.pdf`);
}
