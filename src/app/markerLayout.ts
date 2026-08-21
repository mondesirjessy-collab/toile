import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';

// Plan de découpe (BLUEPRINT §16.7 #2) : on place les pièces sur la laize
// (nesting « shelf » FFDH — simple et démontrable), on en tire un schéma de
// coupe 1:1 (SVG) et le métrage réel. Version démocratisée du marker CLO.
const ROLL_WIDTH_CM = 150; // laize standard
const GAP_CM = 1.5; // jeu entre pièces

function roleLabel(p: DraftPiece): string {
  const r = p.placement?.role ?? p.wrap;
  if (r === 'armL') return 'Manche G';
  if (r === 'armR') return 'Manche D';
  if (r === 'neck') return 'Col';
  return p.name ?? 'Pièce';
}

interface MarkerPiece { name: string; wCm: number; hCm: number; outline: readonly UV[]; }
interface Placement extends MarkerPiece { x: number; y: number; }
export interface MarkerNest { placements: Placement[]; rollWidthCm: number; lengthCm: number; }

function collect(draft: DraftDoc): MarkerPiece[] {
  const out: MarkerPiece[] = [];
  const add = (p: DraftPiece, nm: string): void => {
    out.push({ name: nm, wCm: p.width * 100, hCm: p.height * 100, outline: p.outline });
  };
  add(draft.piece, 'Devant');
  if (draft.back && draft.back.outline.length >= 3) add(draft.back, 'Dos');
  for (const p of draft.pieces ?? []) add(p, roleLabel(p));
  return out;
}

/** Nesting « shelf » (First-Fit Decreasing Height) sur la laize. Fonction PURE. */
export function nestMarker(draft: DraftDoc, saCm: number, rollWidthCm = ROLL_WIDTH_CM): MarkerNest {
  const pieces = collect(draft).sort((a, b) => b.hCm - a.hCm);
  const placements: Placement[] = [];
  let rowY = 0;
  let cursorX = 0;
  let rowMaxH = 0;
  for (const pc of pieces) {
    const bw = pc.wCm + 2 * saCm;
    const bh = pc.hCm + 2 * saCm;
    if (cursorX + bw > rollWidthCm && cursorX > 0) {
      rowY += rowMaxH + GAP_CM;
      cursorX = 0;
      rowMaxH = 0;
    }
    placements.push({ ...pc, x: cursorX + saCm, y: rowY + saCm });
    cursorX += bw + GAP_CM;
    rowMaxH = Math.max(rowMaxH, bh);
  }
  return { placements, rollWidthCm, lengthCm: rowY + rowMaxH };
}

/** Schéma de coupe 1:1 en SVG (mm). Contours réels des pièces posés sur la laize. */
export function markerSvg(nest: MarkerNest): string {
  const { placements, rollWidthCm, lengthCm } = nest;
  const pad = 30;
  const rollW = rollWidthCm * 10;
  const rollH = Math.max(lengthCm * 10, 40);
  const svgW = rollW + 2 * pad;
  const svgH = rollH + 2 * pad + 26;
  const yardM = (lengthCm / 100).toFixed(2);
  const shapes = placements
    .map((pl) => {
      const pts = pl.outline
        .map(([u, v]) => `${(pad + (pl.x + u * pl.wCm) * 10).toFixed(1)},${(pad + (pl.y + v * pl.hCm) * 10).toFixed(1)}`)
        .join(' ');
      const cx = pad + (pl.x + pl.wCm / 2) * 10;
      const cy = pad + (pl.y + pl.hCm / 2) * 10;
      return `<polygon points="${pts}" class="pc"/><text x="${cx.toFixed(0)}" y="${cy.toFixed(0)}" class="lbl">${pl.name}</text>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW.toFixed(0)}mm" height="${svgH.toFixed(0)}mm" ` +
    `viewBox="0 0 ${svgW.toFixed(0)} ${svgH.toFixed(0)}">` +
    `<style>.roll{fill:#fbfaf7;stroke:#111;stroke-width:2;stroke-dasharray:9 5}` +
    `.pc{fill:#e9eefb;stroke:#2a2a2a;stroke-width:1.4;stroke-linejoin:round}` +
    `.lbl{font:11px sans-serif;fill:#333;text-anchor:middle}` +
    `.cap{font:14px sans-serif;fill:#111;font-weight:bold}</style>` +
    `<rect x="${pad}" y="${pad}" width="${rollW.toFixed(0)}" height="${rollH.toFixed(0)}" class="roll"/>` +
    shapes +
    `<text x="${pad}" y="${(rollH + pad + 18).toFixed(0)}" class="cap">` +
    `TOILE · plan de découpe · laize ${rollWidthCm} cm · longueur ${lengthCm.toFixed(0)} cm (~${yardM} m)</text>` +
    `</svg>`
  );
}

/** Nest + SVG + téléchargement. Renvoie le métrage (toast). */
export function exportMarker(draft: DraftDoc, saCm: number): { lengthM: number; pieces: number } {
  const nest = nestMarker(draft, saCm);
  const blob = new Blob([markerSvg(nest)], { type: 'image/svg+xml' });
  downloadBrowserBlob(blob, 'toile-plan-decoupe.svg');
  return { lengthM: +(nest.lengthCm / 100).toFixed(2), pieces: nest.placements.length };
}
