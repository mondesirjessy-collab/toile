/**
 * patternSvg — export the front pattern piece(s) as a 1:1 SVG.
 *
 * Reuses `frontOutline` (the same cut-line + seam-allowance geometry the PDF
 * export builds, in millimeters). SVG is the open, web-native vector format:
 * it opens in a browser, edits in Inkscape, and — because the document size is
 * declared in real millimeters — prints at true scale (100%, no fit-to-page).
 */
import { frontOutline } from './patternPdf';
import type { ClothMeshData } from '../engine/cloth/ClothMesh';

const escapeXml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function exportPatternSvg(mesh: ClothMeshData, garmentName: string, hasIndependentBack = false, margin = 0.01): void {
  const { segs, seam, notches, labels, w, h, pieces } = frontOutline(mesh, margin);
  if (!segs.length || !Number.isFinite(w + h)) return; // no front piece → export nothing (parity with the PDF)
  const cm = margin * 100;
  const marginCm = (Number.isInteger(cm) ? String(cm) : cm.toFixed(1)).replace('.', ',');
  const M = 22; // outer margin, mm
  const PAD = 16; // headroom below the header so the top seam-allowance line clears it
  const sq = 100; // control square, mm
  const gap = 26; // gap above the control square, mm
  const totalW = Math.max(w, sq + 60) + M * 2;
  const totalH = h + PAD + gap + sq + M * 2;

  const line = (s: { x1: number; y1: number; x2: number; y2: number }, cls: string): string =>
    `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" class="${cls}"/>`;

  // Grainline: a straight-grain arrow down the piece. Only for a single piece
  // (a combined outfit lays pieces side by side; one central arrow would fall
  // in the gutter between them).
  let grain = '';
  if (pieces === 1 && h > 0) {
    const gx = w / 2;
    const y0 = h * 0.12;
    const y1 = h * 0.88;
    grain =
      `<line x1="${gx.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${y1.toFixed(1)}" class="grain"/>` +
      `<path d="M${(gx - 4).toFixed(1)} ${(y0 + 6).toFixed(1)} L${gx.toFixed(1)} ${y0.toFixed(1)} L${(gx + 4).toFixed(1)} ${(y0 + 6).toFixed(1)}" class="grain"/>` +
      `<path d="M${(gx - 4).toFixed(1)} ${(y1 - 6).toFixed(1)} L${gx.toFixed(1)} ${y1.toFixed(1)} L${(gx + 4).toFixed(1)} ${(y1 - 6).toFixed(1)}" class="grain"/>` +
      `<text x="${(gx + 4).toFixed(1)}" y="${(h / 2).toFixed(1)}" class="lbl">droit-fil</text>`;
  }

  const cy = h + gap; // control square top (inside the shifted group)
  // Since v89 the back can be a DIFFERENT drawn piece — don't tell the tailor to
  // cut it identically when it isn't.
  const backNote = hasIndependentBack ? 'le DOS a été dessiné à part (non inclus ici)' : "couper le dos à l'identique";
  const label = `TOILE — ${escapeXml(garmentName)} · pièce AVANT (${backNote}) · échelle 1:1 — imprimer à 100 %`;
  // The pattern is shifted down by PAD so its top seam-allowance line never
  // overstrikes the header; the header stays at the very top, outside the group.
  const body =
    seam.map((s) => line(s, 'seam')).join('') +
    segs.map((s) => line(s, 'cut')).join('') +
    notches.map((s) => line(s, 'cut')).join('') +
    grain +
    // Piece numbers (only on a multi-piece sheet): each at its piece's centroid.
    (pieces > 1 ? labels.map((l) => `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" class="pieceno">${l.n}</text>`).join('') : '') +
    `<rect x="0" y="${cy.toFixed(1)}" width="${sq}" height="${sq}" class="ctrl"/>` +
    `<text x="3" y="${(cy + sq / 2).toFixed(1)}" class="lbl">carré 100 mm — vérifier l'échelle</text>` +
    `<text x="0" y="${(cy + sq + 8).toFixed(1)}" class="lbl">trait plein = coupe · pointillé = couture (marge ${marginCm} cm) · petits traits = repères de montage (aligner devant/dos)</text>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW.toFixed(1)}mm" height="${totalH.toFixed(1)}mm" ` +
    `viewBox="${(-M).toFixed(1)} ${(-M).toFixed(1)} ${totalW.toFixed(1)} ${totalH.toFixed(1)}">` +
    `<style>` +
    `.cut{stroke:#111;stroke-width:0.7;fill:none;stroke-linejoin:round}` +
    `.seam{stroke:#b0b0b0;stroke-width:0.5;stroke-dasharray:3 2;fill:none}` +
    `.grain{stroke:#111;stroke-width:0.6;fill:none}` +
    `.ctrl{stroke:#111;stroke-width:0.5;fill:none}` +
    `text{font-family:sans-serif;fill:#111}.lbl{font-size:5px}.head{font-size:6px}` +
    `.pieceno{font-size:11px;font-weight:bold;text-anchor:middle}` +
    `</style>` +
    `<text x="0" y="${(-M / 2).toFixed(1)}" class="head">${label}</text>` +
    `<g transform="translate(0 ${PAD})">${body}</g>` +
    `</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `patron-${garmentName.replace(/[^a-z0-9]/gi, '-')}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer the revoke: revoking immediately after click() can abort the download.
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
