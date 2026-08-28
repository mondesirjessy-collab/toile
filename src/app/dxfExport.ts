import type { DraftDoc, UV } from '../engine/pattern/Draft';
import { seamAllowanceOutline } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';
import { nestMarker, placedPoint, draftMarkerPieces, type Placement, type MarkerPiece } from './markerLayout';

// Export DXF (BLUEPRINT §16.7 #3) — le fichier de découpe que les usines
// attendent. DXF R12 ASCII (AC1009), le plus largement lisible : une POLYLINE
// FERMÉE par pièce (contour réel en mm), posée via le même nesting que le
// marker, + un label TEXT. Calque CUT = trait de coupe (marge incluse),
// STITCH = ligne de couture, TEXT = labels.
const g = (code: number | string, val: number | string): string => `${code}\n${val}\n`;

/** POLYLINE fermée d'un contour (UV) posé sur la laize (rotation comprise), calque donné. */
function polyline(pl: Placement, outline: readonly UV[], layer: string): string {
  let s = g(0, 'POLYLINE') + g(8, layer) + g(66, 1) + g(70, 1); // 66=vertices suivent, 70=1 fermée
  for (const [u, v] of outline) {
    const [xCm, yCm] = placedPoint(pl, u, v); // position absolue (rotation comprise)
    s += g(0, 'VERTEX') + g(8, layer) + g(10, (xCm * 10).toFixed(2)) + g(20, (yCm * 10).toFixed(2)) + g(30, '0.0');
  }
  s += g(0, 'SEQEND') + g(8, layer);
  return s;
}

function textLabel(str: string, xCm: number, yCm: number): string {
  return g(0, 'TEXT') + g(8, 'TEXT') + g(10, (xCm * 10).toFixed(2)) + g(20, (yCm * 10).toFixed(2)) + g(40, 15) + g(1, str);
}

/** Assemble un DXF R12 complet. Fonction PURE. */
export function buildDxf(draft: DraftDoc, saCm: number): { dxf: string; pieces: number } {
  const nest = nestMarker(draft, saCm);
  let ents = '';
  for (const pl of nest.placements) {
    // Trait de coupe (calque CUT) = couture décalée de la marge vers l'extérieur.
    const cutUV = saCm > 0
      ? seamAllowanceOutline(pl.outline, pl.wCm / 100, pl.hCm / 100, saCm / 100)
      : pl.outline;
    ents += polyline(pl, cutUV, 'CUT');
    if (saCm > 0) ents += polyline(pl, pl.outline, 'STITCH'); // ligne de couture
    const [cxCm, cyCm] = placedPoint(pl, 0.5, 0.5);
    ents += textLabel(pl.name, cxCm, cyCm);
  }
  const header =
    g(0, 'SECTION') + g(2, 'HEADER') +
    g(9, '$ACADVER') + g(1, 'AC1009') +
    g(9, '$INSUNITS') + g(70, 4) + // 4 = millimètres
    g(0, 'ENDSEC');
  const tables =
    g(0, 'SECTION') + g(2, 'TABLES') +
    g(0, 'TABLE') + g(2, 'LAYER') + g(70, 3) +
    g(0, 'LAYER') + g(2, 'CUT') + g(70, 0) + g(62, 1) + g(6, 'CONTINUOUS') + // 62=1 rouge
    g(0, 'LAYER') + g(2, 'STITCH') + g(70, 0) + g(62, 8) + g(6, 'CONTINUOUS') + // 62=8 gris
    g(0, 'LAYER') + g(2, 'TEXT') + g(70, 0) + g(62, 7) + g(6, 'CONTINUOUS') +
    g(0, 'ENDTAB') + g(0, 'ENDSEC');
  const entities = g(0, 'SECTION') + g(2, 'ENTITIES') + ents + g(0, 'ENDSEC');
  const dxf = header + tables + entities + g(0, 'EOF');
  return { dxf, pieces: nest.placements.length };
}

/** Construit + télécharge le DXF. Renvoie le nombre de pièces (toast). */
export function exportDxf(draft: DraftDoc, saCm: number): { pieces: number } {
  const { dxf, pieces } = buildDxf(draft, saCm);
  downloadBrowserBlob(new Blob([dxf], { type: 'application/dxf' }), 'toile-patron.dxf');
  return { pieces };
}

// --- DXF GRADÉ (BLUEPRINT §16.7 #3) : le patron dans TOUTES les tailles.
// Chaque pièce est dessinée en toutes les tailles, superposées et CENTRÉES
// (nid de gradation, façon AAMA) ; une taille = un calque coloré, isolable
// dans n'importe quel lecteur DXF. Les pièces (rôles) sont alignées en rangée.
const SIZE_COLORS = [1, 2, 3, 5, 6, 4]; // ACI par taille (rouge, jaune, vert, bleu, magenta, cyan)

/** POLYLINE fermée d'une pièce, centrée en (cx,cy) cm, sur un calque donné. */
function gradedPolyline(p: MarkerPiece, cxCm: number, cyCm: number, layer: string): string {
  let s = g(0, 'POLYLINE') + g(8, layer) + g(66, 1) + g(70, 1);
  for (const [u, v] of p.outline) {
    const xCm = cxCm + (u - 0.5) * p.wCm;
    const yCm = cyCm + (v - 0.5) * p.hCm;
    s += g(0, 'VERTEX') + g(8, layer) + g(10, (xCm * 10).toFixed(2)) + g(20, (yCm * 10).toFixed(2)) + g(30, '0.0');
  }
  return s + g(0, 'SEQEND') + g(8, layer);
}

/** DXF gradé complet (une taille par calque). Fonction PURE. */
export function buildGradedDxf(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc }>,
): { dxf: string; sizes: number; pieces: number } {
  const bySize = entries.map((e) => ({ size: e.size, pieces: draftMarkerPieces(e.draft) }));
  const roleCount = bySize.reduce((m, x) => Math.max(m, x.pieces.length), 0);
  const GAP = 8; // cm entre pièces (rôles) posés en rangée
  let ents = textLabel('TOILE - patron grade (une taille par calque)', 0, -4);
  let slotX = 0;
  let pieceCount = 0;
  for (let i = 0; i < roleCount; i++) {
    const maxW = bySize.reduce((m, x) => Math.max(m, x.pieces[i]?.wCm ?? 0), 0);
    const maxH = bySize.reduce((m, x) => Math.max(m, x.pieces[i]?.hCm ?? 0), 0);
    const cx = slotX + maxW / 2;
    const cy = maxH / 2;
    for (const { size, pieces } of bySize) {
      const p = pieces[i];
      if (!p) continue;
      ents += gradedPolyline(p, cx, cy, `TAILLE_${size}`);
      pieceCount++;
    }
    ents += textLabel(bySize[0]?.pieces[i]?.name ?? 'Piece', slotX, maxH + 3);
    slotX += maxW + GAP;
  }
  let layerDefs = '';
  entries.forEach((e, k) => {
    layerDefs += g(0, 'LAYER') + g(2, `TAILLE_${e.size}`) + g(70, 0) + g(62, SIZE_COLORS[k % SIZE_COLORS.length]!) + g(6, 'CONTINUOUS');
  });
  layerDefs += g(0, 'LAYER') + g(2, 'TEXT') + g(70, 0) + g(62, 7) + g(6, 'CONTINUOUS');
  const header =
    g(0, 'SECTION') + g(2, 'HEADER') +
    g(9, '$ACADVER') + g(1, 'AC1009') +
    g(9, '$INSUNITS') + g(70, 4) +
    g(0, 'ENDSEC');
  const tables =
    g(0, 'SECTION') + g(2, 'TABLES') +
    g(0, 'TABLE') + g(2, 'LAYER') + g(70, entries.length + 1) +
    layerDefs +
    g(0, 'ENDTAB') + g(0, 'ENDSEC');
  const entities = g(0, 'SECTION') + g(2, 'ENTITIES') + ents + g(0, 'ENDSEC');
  return { dxf: header + tables + entities + g(0, 'EOF'), sizes: entries.length, pieces: pieceCount };
}

/** Construit + télécharge le DXF gradé. Renvoie tailles + pièces (toast). */
export function exportGradedDxf(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc }>,
): { sizes: number; pieces: number } {
  const { dxf, sizes, pieces } = buildGradedDxf(entries);
  downloadBrowserBlob(new Blob([dxf], { type: 'application/dxf' }), 'toile-patron-grade.dxf');
  return { sizes, pieces };
}
