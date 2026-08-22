import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';
import { nestMarker } from './markerLayout';

// Bilan matière multi-tailles (BLUEPRINT §16) : pour une gradation complète, le
// métrage de placement — le MÊME nesting serré que le plan de découpe (marker)
// et le DXF — taille par taille, ET une courbe de tailles (quantités) qui donne
// le métrage TOTAL d'une commande. CSV ouvrable en tableur. Le bilan porte
// toujours sur les tailles STANDARD (pas le sur-mesure, propre à un corps).

/** Aire du polygone normalisé [0,1] (formule du lacet), en unités [0,1]². */
function polygonAreaUnit(outline: readonly UV[]): number {
  let a = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const p = outline[i]!;
    const q = outline[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Surface totale des pièces d'un patron, en m² (comme le tech pack). */
function draftAreaM2(draft: DraftDoc): number {
  const pieces: DraftPiece[] = [draft.piece];
  if (draft.back && draft.back.outline.length >= 3) pieces.push(draft.back);
  for (const p of draft.pieces ?? []) pieces.push(p);
  return pieces.reduce((s, p) => s + polygonAreaUnit(p.outline) * p.width * p.height, 0);
}

/**
 * Interprète une courbe de tailles saisie librement en quantités par taille.
 * - vide → 1 par taille (bilan de base, un exemplaire de chaque) ;
 * - liste ordonnée « 2,5,8,8,5,2 » → dans l'ordre des tailles ;
 * - paires « M:10 L:8 » (séparateurs souples, insensible à la casse) → les
 *   tailles citées, les autres à 0 ;
 * - format non reconnu → 1 par taille (repli sûr).
 */
export function parseSizeCurve(curve: string, sizes: readonly string[]): Record<string, number> {
  const q: Record<string, number> = {};
  const t = curve.trim();
  if (!t) {
    for (const s of sizes) q[s] = 1;
    return q;
  }
  if (/^[\d\s,]+$/.test(t)) {
    for (const s of sizes) q[s] = 0;
    t.split(/[\s,]+/).filter(Boolean).forEach((n, i) => {
      const size = sizes[i];
      if (size) q[size] = Math.max(0, parseInt(n, 10) || 0);
    });
    return q;
  }
  for (const s of sizes) q[s] = 0;
  const re = /([A-Za-z]+)\s*[:=]\s*(\d+)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(t))) {
    const key = m[1]!.toUpperCase();
    const size = sizes.find((s) => s.toUpperCase() === key);
    if (size) {
      q[size] = Math.max(0, parseInt(m[2]!, 10) || 0);
      any = true;
    }
  }
  if (!any) for (const s of sizes) q[s] = 1;
  return q;
}

export interface MaterialRow {
  taille: string;
  quantite: number;
  metrage_piece_m: number;
  metrage_total_m: number;
  surface_m2: number;
  rendement: number;
}

export interface MaterialReportInput {
  garment: string;
  fabric: string;
  config: string; // description des blocs (manches, encolure, col, longueur)
  seamAllowanceCm: number;
}

/** Bilan matière par taille (× quantité) + total commande. Fonction PURE. */
export function buildMaterialReport(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc; qty: number }>,
  input: MaterialReportInput,
): { rows: MaterialRow[]; laize_cm: number; total: { quantite: number; metrage_total_m: number } } {
  let laizeCm = 150;
  const rows: MaterialRow[] = entries.map(({ size, draft, qty }) => {
    const nest = nestMarker(draft, input.seamAllowanceCm);
    laizeCm = nest.rollWidthCm;
    const metrage = +(nest.lengthCm / 100).toFixed(2);
    const surface = +draftAreaM2(draft).toFixed(3);
    const usedM2 = (nest.rollWidthCm / 100) * metrage;
    const rendement = usedM2 > 0 ? +(surface / usedM2).toFixed(2) : 0;
    const q = Math.max(0, Math.round(qty));
    return {
      taille: size,
      quantite: q,
      metrage_piece_m: metrage,
      metrage_total_m: +(metrage * q).toFixed(2),
      surface_m2: surface,
      rendement,
    };
  });
  const total = {
    quantite: rows.reduce((s, r) => s + r.quantite, 0),
    metrage_total_m: +rows.reduce((s, r) => s + r.metrage_total_m, 0).toFixed(2),
  };
  return { rows, laize_cm: laizeCm, total };
}

/** Construit + télécharge le bilan matière (CSV). Renvoie l'entête (toast). */
export function exportMaterialReport(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc; qty: number }>,
  input: MaterialReportInput,
): { total_m: number; units: number; sizes: number } {
  const rep = buildMaterialReport(entries, input);
  const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const lines: string[] = [];
  lines.push('Bilan matiere multi-tailles - TOILE');
  lines.push(`Vetement,${esc(input.garment)}`);
  lines.push(`Configuration,${esc(input.config)}`);
  lines.push(`Tissu,${esc(input.fabric)}`);
  lines.push(`Laize (cm),${rep.laize_cm}`);
  lines.push(`Marge couture (cm),${input.seamAllowanceCm}`);
  lines.push('');
  lines.push('Taille,Quantite,Metrage/piece (m),Metrage total (m),Surface piece (m2),Rendement placement');
  for (const r of rep.rows) {
    lines.push(`${esc(r.taille)},${r.quantite},${r.metrage_piece_m},${r.metrage_total_m},${r.surface_m2},${r.rendement}`);
  }
  lines.push(`${esc('Total commande')},${rep.total.quantite},,${rep.total.metrage_total_m},,`);
  // BOM UTF-8 pour qu'Excel lise correctement les accents de la configuration.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBrowserBlob(blob, 'toile-bilan-matiere.csv');
  return { total_m: rep.total.metrage_total_m, units: rep.total.quantite, sizes: rep.rows.length };
}
