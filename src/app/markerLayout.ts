import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { pointInPolygon, addSeamNotches, seamAllowanceOutline } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';

// Plan de découpe (BLUEPRINT §16.7 #2). Nesting SERRÉ : bottom-left-fill sur une
// grille d'occupation, avec les VRAIS contours rasterisés — les pièces
// s'imbriquent dans les creux (encolure, entre-emmanchures), et on essaie la
// rotation 180° pour combler. Bien plus dense que l'ancien placement « shelf ».
const ROLL_WIDTH_CM = 150; // laize standard
const CELL_CM = 1.5; // résolution de la grille de placement

function roleLabel(p: DraftPiece): string {
  const r = p.placement?.role ?? p.wrap;
  if (r === 'armL') return 'Manche G';
  if (r === 'armR') return 'Manche D';
  if (r === 'neck') return 'Col';
  return p.name ?? 'Pièce';
}

export interface MarkerNotch { at: UV; kind: 'seam' | 'attach'; }
export interface MarkerPiece { name: string; wCm: number; hCm: number; outline: readonly UV[]; notches?: readonly MarkerNotch[]; }
export interface Placement extends MarkerPiece { x: number; y: number; rot: 0 | 180; }
export interface MarkerNest { placements: Placement[]; rollWidthCm: number; lengthCm: number }

/** Post-traitement optionnel d'un nest (le tassement exact NFP vit dans
 * nfpNesting.ts / clipper2-ts, 1,6 Mo — injecté par IMPORT DYNAMIQUE aux
 * points d'export pour rester HORS du bundle principal). Absent ⇒ le
 * placement grille brut, comportement historique inchangé. */
export type CompactFn = (nest: MarkerNest, saCm: number) => MarkerNest;

function collect(draft: DraftDoc): MarkerPiece[] {
  const out: MarkerPiece[] = [];
  const hasAttach = (draft.pieces ?? []).some(
    (p) => p.wrap === 'armL' || p.wrap === 'armR' || p.wrap === 'neck',
  );
  // Milieu (UV) d'un tronçon de contour, en gérant l'enroulement.
  const runMidUV = (outline: readonly UV[], from: number, to: number): UV => {
    const N = outline.length;
    const span = (((to - from) % N) + N) % N;
    return outline[(from + Math.round(span / 2)) % N]!;
  };
  // Crans de RACCORD des blocs rapportés (tête de manche, col) + repères
  // d'emmanchure/encolure sur le corps — en plus des crans de couture (v248).
  const attachNotches = (p: DraftPiece, isBody: boolean): UV[] => {
    if (p.wrap === 'armL' || p.wrap === 'armR') return [[0.5, 0.02]]; // sommet de tete de manche -> epaule
    if (p.wrap === 'neck') return [[0.5, 1]]; // centre de la bande col -> milieu d'encolure
    if (isBody && hasAttach) {
      // milieux des ouvertures HAUTES (emmanchures, encolure) ; l'ourlet (bas) est exclu
      return (p.openEdges ?? [])
        .map((run) => runMidUV(p.outline, run.from, run.to))
        .filter((uv) => uv[1] <= 0.7);
    }
    return [];
  };
  const add = (p: DraftPiece, nm: string, isBody = false): void => {
    const base = p.notches?.map((nt) => nt.at) ?? [];
    out.push({
      name: nm,
      wCm: p.width * 100,
      hCm: p.height * 100,
      outline: p.outline,
      notches: [
        ...base.map((at) => ({ at, kind: 'seam' as const })),
        ...attachNotches(p, isBody).map((at) => ({ at, kind: 'attach' as const })),
      ],
    });
  };
  add(draft.piece, 'Devant', true);
  if (draft.back && draft.back.outline.length >= 3) add(draft.back, 'Dos', true);
  for (const p of draft.pieces ?? []) add(p, roleLabel(p));
  return out;
}

interface Raster { mask: Uint8Array; cols: number; rows: number }

/** Draft enrichi de crans de raccord sur chaque couture d'assemblage — points
 * appariés (1/3-2/3, ou milieu si court) de part et d'autre. Non destructif :
 * renvoie une copie, les crans existants (ajoutés main) sont conservés. */
function withSeamNotches(draft: DraftDoc): DraftDoc {
  let doc = draft;
  const n = (draft.seams ?? []).length;
  for (let i = 0; i < n; i++) {
    const r = addSeamNotches(doc, i);
    if (r.ok && r.doc) doc = r.doc;
  }
  return doc;
}

/** Rasterise le contour d'une pièce (+ marge de couture dilatée) sur la grille. */
function rasterize(outline: readonly UV[], wCm: number, hCm: number, saCm: number): Raster {
  const cols = Math.max(1, Math.ceil((wCm + 2 * saCm) / CELL_CM));
  const rows = Math.max(1, Math.ceil((hCm + 2 * saCm) / CELL_CM));
  const raw = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xCm = (c + 0.5) * CELL_CM - saCm;
      const yCm = (r + 0.5) * CELL_CM - saCm;
      const u = xCm / wCm;
      const v = yCm / hCm;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1 && pointInPolygon([u, v], outline)) raw[r * cols + c] = 1;
    }
  }
  // Dilate d'un rayon = marge de couture + espace de coupe (≥ 2 cellules)
  // → ~3 cm d'air visible entre les traits de coupe voisins.
  const rad = Math.max(2, Math.ceil(saCm / CELL_CM) + 1);
  const mask = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let on = false;
      for (let dr = -rad; dr <= rad && !on; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && raw[rr * cols + cc]) { on = true; break; }
        }
      }
      mask[r * cols + c] = on ? 1 : 0;
    }
  }
  return { mask, cols, rows };
}

/** Cellule (mr,mc) du masque, tournée de rot (0 ou 180°). */
function maskOn(ra: Raster, mr: number, mc: number, rot: 0 | 180): boolean {
  const r = rot === 180 ? ra.rows - 1 - mr : mr;
  const c = rot === 180 ? ra.cols - 1 - mc : mc;
  return ra.mask[r * ra.cols + c] === 1;
}

/** Nesting bottom-left-fill d'un patron (mono-taille). */
export function nestMarker(draft: DraftDoc, saCm: number, rollWidthCm = ROLL_WIDTH_CM): MarkerNest {
  return nestPieces(collect(draft), saCm, rollWidthCm);
}

/** Toutes les pièces (MarkerPiece) d'un patron, prêtes à placer. */
export function draftMarkerPieces(draft: DraftDoc): MarkerPiece[] {
  return collect(draft);
}

/** Nesting bottom-left-fill : chaque pièce descend le plus bas / à gauche
 * possible. Accepte une LISTE de pièces (mono- OU multi-tailles) — c'est le
 * cœur du placement mélangé. Les rasters sont mis en cache PAR pièce : les
 * copies (mêmes objets, une commande entière) ne sont rasterisées qu'une fois. */
export function nestPieces(list: readonly MarkerPiece[], saCm: number, rollWidthCm = ROLL_WIDTH_CM): MarkerNest {
  const gridCols = Math.max(1, Math.ceil(rollWidthCm / CELL_CM));
  const cache = new Map<MarkerPiece, Raster>();
  const rasterOf = (p: MarkerPiece): Raster => {
    let ra = cache.get(p);
    if (!ra) { ra = rasterize(p.outline, p.wCm, p.hCm, saCm); cache.set(p, ra); }
    return ra;
  };
  const pieces = list
    .map((p) => ({ p, ra: rasterOf(p) }))
    .sort((a, b) => b.ra.cols * b.ra.rows - a.ra.cols * a.ra.rows); // plus grosses d'abord
  const occ: Uint8Array[] = [];
  const rowOf = (y: number): Uint8Array => {
    while (occ.length <= y) occ.push(new Uint8Array(gridCols));
    return occ[y]!;
  };
  const collides = (ra: Raster, x: number, y: number, rot: 0 | 180): boolean => {
    for (let mr = 0; mr < ra.rows; mr++) {
      for (let mc = 0; mc < ra.cols; mc++) {
        if (!maskOn(ra, mr, mc, rot)) continue;
        const gx = x + mc;
        const gy = y + mr;
        if (gx < 0 || gx >= gridCols) return true;
        if (gy < occ.length && occ[gy]![gx]) return true;
      }
    }
    return false;
  };
  const placements: Placement[] = [];
  for (const { p, ra } of pieces) {
    let best: { x: number; y: number; rot: 0 | 180 } | null = null;
    for (const rot of [0, 180] as const) {
      const maxX = Math.max(0, gridCols - ra.cols);
      let found: { x: number; y: number } | null = null;
      for (let y = 0; !found && y < 20000; y++) {
        for (let x = 0; x <= maxX; x++) {
          if (!collides(ra, x, y, rot)) { found = { x, y }; break; }
        }
      }
      if (found && (!best || found.y < best.y || (found.y === best.y && found.x < best.x))) {
        best = { x: found.x, y: found.y, rot };
      }
    }
    const chosen = best ?? { x: 0, y: 0, rot: 0 as const };
    for (let mr = 0; mr < ra.rows; mr++) {
      const row = rowOf(chosen.y + mr);
      for (let mc = 0; mc < ra.cols; mc++) {
        if (maskOn(ra, mr, mc, chosen.rot)) { const gx = chosen.x + mc; if (gx >= 0 && gx < gridCols) row[gx] = 1; }
      }
    }
    placements.push({ name: p.name, wCm: p.wCm, hCm: p.hCm, outline: p.outline, notches: p.notches, x: chosen.x * CELL_CM, y: chosen.y * CELL_CM, rot: chosen.rot });
  }
  return { placements, rollWidthCm, lengthCm: occ.length * CELL_CM };
}

/** Point (u,v) d'une pièce → position ABSOLUE (cm) sur la laize, rotation comprise. */
export function placedPoint(pl: Placement, u: number, v: number): [number, number] {
  const uu = pl.rot === 180 ? 1 - u : u;
  const vv = pl.rot === 180 ? 1 - v : v;
  return [pl.x + uu * pl.wCm, pl.y + vv * pl.hCm];
}

/** Schéma de coupe 1:1 en SVG (mm). Contours réels posés sur la laize.
 * `saCm` > 0 : on trace le TRAIT DE COUPE (ligne de couture décalée de la marge
 * vers l'extérieur — le bord réel du tissu) plein, et la ligne de couture en
 * pointillé à l'intérieur. Le nesting espace déjà les pièces de la marge, donc
 * les traits de coupe voisins se touchent bord à bord sans se recouvrir. */
export function markerSvg(nest: MarkerNest, saCm = 0): string {
  const { placements, rollWidthCm, lengthCm } = nest;
  const pad = 30;
  const rollW = rollWidthCm * 10;
  const rollH = Math.max(lengthCm * 10, 40);
  const svgW = rollW + 2 * pad;
  const svgH = rollH + 2 * pad + (saCm > 0 ? 92 : 60); // place pour la légende
  const yardM = (lengthCm / 100).toFixed(2);
  const toPts = (uv: readonly UV[], pl: Placement): string =>
    uv
      .map(([u, v]) => { const [x, y] = placedPoint(pl, u, v); return `${(pad + x * 10).toFixed(1)},${(pad + y * 10).toFixed(1)}`; })
      .join(' ');
  const shapes = placements
    .map((pl) => {
      const seamPts = toPts(pl.outline, pl);
      // Trait de coupe = couture décalée de la marge vers l'extérieur.
      const cutUV = saCm > 0
        ? seamAllowanceOutline(pl.outline, pl.wCm / 100, pl.hCm / 100, saCm / 100)
        : pl.outline;
      const cutPts = saCm > 0 ? toPts(cutUV, pl) : seamPts;
      const [cxCm, cyCm] = placedPoint(pl, 0.5, 0.5);
      const marks = (pl.notches ?? [])
        .map(({ at: [u, v], kind }) => {
          const [nx, ny] = placedPoint(pl, u, v);
          let dx = cxCm - nx;
          let dy = cyCm - ny;
          const L = Math.hypot(dx, dy) || 1;
          dx /= L;
          dy /= L;
          const x1 = pad + nx * 10;
          const y1 = pad + ny * 10;
          const x2 = pad + (nx + dx * 0.9) * 10;
          const y2 = pad + (ny + dy * 0.9) * 10;
          const c = kind === 'attach' ? 'A' : '';
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="ntch${c}"/><circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="2.4" class="ntchd${c}"/>`;
        })
        .join('');
      const cutPoly = `<polygon points="${cutPts}" class="cut"/>`;
      const seamPoly = saCm > 0 ? `<polygon points="${seamPts}" class="seam"/>` : '';
      return `${cutPoly}${seamPoly}${marks}<text x="${(pad + cxCm * 10).toFixed(0)}" y="${(pad + cyCm * 10).toFixed(0)}" class="lbl">${pl.name}</text>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW.toFixed(0)}mm" height="${svgH.toFixed(0)}mm" ` +
    `viewBox="0 0 ${svgW.toFixed(0)} ${svgH.toFixed(0)}">` +
    `<style>.roll{fill:#fbfaf7;stroke:#111;stroke-width:2;stroke-dasharray:9 5}` +
    `.cut{fill:#e9eefb;stroke:#2a2a2a;stroke-width:1.4;stroke-linejoin:round}` +
    `.seam{fill:none;stroke:#8a94a8;stroke-width:1;stroke-dasharray:5 3;stroke-linejoin:round}` +
    `.lbl{font:11px sans-serif;fill:#333;text-anchor:middle}` +
    `.ntch{stroke:#c0392b;stroke-width:2.2;stroke-linecap:round}.ntchd{fill:#c0392b}` +
    `.ntchA{stroke:#0e7c86;stroke-width:2.2;stroke-linecap:round}.ntchdA{fill:#0e7c86}` +
    `.leg{font:11px sans-serif;fill:#333}` +
    `.cap{font:14px sans-serif;fill:#111;font-weight:bold}</style>` +
    `<rect x="${pad}" y="${pad}" width="${rollW.toFixed(0)}" height="${rollH.toFixed(0)}" class="roll"/>` +
    shapes +
    `<text x="${pad}" y="${(rollH + pad + 18).toFixed(0)}" class="cap">` +
    `TOILE · plan de découpe · laize ${rollWidthCm} cm · longueur ${lengthCm.toFixed(0)} cm (~${yardM} m)</text>` +
    `<line x1="${pad}" y1="${(rollH + pad + 38).toFixed(0)}" x2="${(pad + 14).toFixed(0)}" y2="${(rollH + pad + 38).toFixed(0)}" class="ntch"/>` +
    `<circle cx="${pad}" cy="${(rollH + pad + 38).toFixed(0)}" r="2.4" class="ntchd"/>` +
    `<text x="${(pad + 22).toFixed(0)}" y="${(rollH + pad + 42).toFixed(0)}" class="leg">crans de couture (devant \u2194 dos)</text>` +
    `<line x1="${pad}" y1="${(rollH + pad + 54).toFixed(0)}" x2="${(pad + 14).toFixed(0)}" y2="${(rollH + pad + 54).toFixed(0)}" class="ntchA"/>` +
    `<circle cx="${pad}" cy="${(rollH + pad + 54).toFixed(0)}" r="2.4" class="ntchdA"/>` +
    `<text x="${(pad + 22).toFixed(0)}" y="${(rollH + pad + 58).toFixed(0)}" class="leg">crans de raccord (manche / col)</text>` +
    (saCm > 0
      ? `<line x1="${pad}" y1="${(rollH + pad + 72).toFixed(0)}" x2="${(pad + 14).toFixed(0)}" y2="${(rollH + pad + 72).toFixed(0)}" style="stroke:#2a2a2a;stroke-width:1.6"/>` +
        `<text x="${(pad + 22).toFixed(0)}" y="${(rollH + pad + 76).toFixed(0)}" class="leg">trait de coupe — bord du tissu (marge ${saCm.toFixed(1)} cm incluse)</text>` +
        `<line x1="${pad}" y1="${(rollH + pad + 88).toFixed(0)}" x2="${(pad + 14).toFixed(0)}" y2="${(rollH + pad + 88).toFixed(0)}" style="stroke:#8a94a8;stroke-width:1.2;stroke-dasharray:5 3"/>` +
        `<text x="${(pad + 22).toFixed(0)}" y="${(rollH + pad + 92).toFixed(0)}" class="leg">ligne de couture</text>`
      : '') +
    `</svg>`
  );
}

/** Nest + SVG + téléchargement. Renvoie le métrage (toast). `compact`
 * optionnel : le tassement exact (NFP) appliqué après le placement grille. */
export function exportMarker(
  draft: DraftDoc,
  saCm: number,
  compact?: CompactFn,
): { lengthM: number; pieces: number } {
  let nest = nestMarker(withSeamNotches(draft), saCm);
  if (compact) nest = compact(nest, saCm);
  const blob = new Blob([markerSvg(nest, saCm)], { type: 'image/svg+xml' });
  downloadBrowserBlob(blob, 'toile-plan-decoupe.svg');
  return { lengthM: +(nest.lengthCm / 100).toFixed(2), pieces: nest.placements.length };
}

/** Plan de découpe MULTI-TAILLES : toutes les pièces commandées (× quantité,
 * étiquetées par taille) placées sur UN matelas, en SVG 1:1 — le marker à
 * donner au façonnier. Le nombre de pièces est borné : au-delà, le SVG
 * devient illisible/énorme (le bilan matière, lui, chiffre les grosses
 * commandes par extrapolation). */
export function exportMultiSizeMarker(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc; qty: number }>,
  saCm: number,
  cap = 200,
  compact?: CompactFn,
): { lengthM: number; pieces: number; capped: boolean } {
  const combined: MarkerPiece[] = [];
  for (const { size, draft, qty } of entries) {
    const q = Math.max(0, Math.round(qty));
    if (q === 0) continue;
    // Une pièce étiquetée PAR taille, réutilisée pour toutes ses copies →
    // le cache raster de nestPieces ne la calcule qu'une fois.
    const labeled = collect(withSeamNotches(draft)).map((p) => ({ ...p, name: `${size} \u00b7 ${p.name}` }));
    for (let i = 0; i < q; i++) for (const p of labeled) combined.push(p);
  }
  if (combined.length === 0 || combined.length > cap) {
    return { lengthM: 0, pieces: combined.length, capped: combined.length > cap };
  }
  let nest = nestPieces(combined, saCm);
  if (compact) nest = compact(nest, saCm);
  const blob = new Blob([markerSvg(nest, saCm)], { type: 'image/svg+xml' });
  downloadBrowserBlob(blob, 'toile-plan-decoupe-multi-tailles.svg');
  return { lengthM: +(nest.lengthCm / 100).toFixed(2), pieces: combined.length, capped: false };
}
