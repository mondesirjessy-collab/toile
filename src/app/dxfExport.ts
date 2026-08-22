import type { DraftDoc } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';
import { nestMarker, placedPoint, type Placement } from './markerLayout';

// Export DXF (BLUEPRINT §16.7 #3) — le fichier de découpe que les usines
// attendent. DXF R12 ASCII (AC1009), le plus largement lisible : une POLYLINE
// FERMÉE par pièce (contour réel en mm), posée via le même nesting que le
// marker, + un label TEXT. Calques CUT (coupe) et TEXT.
const g = (code: number | string, val: number | string): string => `${code}\n${val}\n`;

function polyline(pl: Placement): string {
  let s = g(0, 'POLYLINE') + g(8, 'CUT') + g(66, 1) + g(70, 1); // 66=vertices suivent, 70=1 fermée
  for (const [u, v] of pl.outline) {
    const [xCm, yCm] = placedPoint(pl, u, v); // position absolue (rotation comprise)
    s += g(0, 'VERTEX') + g(8, 'CUT') + g(10, (xCm * 10).toFixed(2)) + g(20, (yCm * 10).toFixed(2)) + g(30, '0.0');
  }
  s += g(0, 'SEQEND') + g(8, 'CUT');
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
    ents += polyline(pl);
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
    g(0, 'TABLE') + g(2, 'LAYER') + g(70, 2) +
    g(0, 'LAYER') + g(2, 'CUT') + g(70, 0) + g(62, 1) + g(6, 'CONTINUOUS') +
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
