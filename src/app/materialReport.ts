import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';
import { nestMarker } from './markerLayout';

// Bilan matière multi-tailles (BLUEPRINT §16) : pour une gradation complète, le
// métrage de placement — le MÊME nesting serré que le plan de découpe (marker)
// et le DXF — taille par taille, plus le total d'un exemplaire par taille. CSV
// ouvrable en tableur, pour chiffrer une commande. Le bilan porte toujours sur
// les tailles STANDARD (pas le sur-mesure, qui est propre à un corps).

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

export interface MaterialRow {
  taille: string;
  metrage_m: number;
  surface_m2: number;
  rendement: number;
}

export interface MaterialReportInput {
  garment: string;
  fabric: string;
  config: string; // description des blocs (manches, encolure, col, longueur)
  seamAllowanceCm: number;
}

/** Bilan matière par taille + total (1 exemplaire par taille). Fonction PURE. */
export function buildMaterialReport(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc }>,
  input: MaterialReportInput,
): { rows: MaterialRow[]; laize_cm: number; total: MaterialRow } {
  let laizeCm = 150;
  const rows: MaterialRow[] = entries.map(({ size, draft }) => {
    const nest = nestMarker(draft, input.seamAllowanceCm);
    laizeCm = nest.rollWidthCm;
    const metrage = +(nest.lengthCm / 100).toFixed(2);
    const surface = +draftAreaM2(draft).toFixed(3);
    const usedM2 = (nest.rollWidthCm / 100) * metrage;
    const rendement = usedM2 > 0 ? +(surface / usedM2).toFixed(2) : 0;
    return { taille: size, metrage_m: metrage, surface_m2: surface, rendement };
  });
  const totMetrage = +rows.reduce((s, r) => s + r.metrage_m, 0).toFixed(2);
  const totSurface = +rows.reduce((s, r) => s + r.surface_m2, 0).toFixed(3);
  const totUsed = (laizeCm / 100) * totMetrage;
  const total: MaterialRow = {
    taille: 'Total (1/taille)',
    metrage_m: totMetrage,
    surface_m2: totSurface,
    rendement: totUsed > 0 ? +(totSurface / totUsed).toFixed(2) : 0,
  };
  return { rows, laize_cm: laizeCm, total };
}

/** Construit + télécharge le bilan matière (CSV). Renvoie l'entête (toast). */
export function exportMaterialReport(
  entries: ReadonlyArray<{ size: string; draft: DraftDoc }>,
  input: MaterialReportInput,
): { total_m: number; sizes: number } {
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
  lines.push('Taille,Metrage (m),Surface pieces (m2),Rendement placement');
  for (const r of rep.rows) {
    lines.push(`${esc(r.taille)},${r.metrage_m},${r.surface_m2},${r.rendement}`);
  }
  lines.push(`${esc(rep.total.taille)},${rep.total.metrage_m},${rep.total.surface_m2},${rep.total.rendement}`);
  // BOM UTF-8 pour qu'Excel lise correctement les accents de la configuration.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBrowserBlob(blob, 'toile-bilan-matiere.csv');
  return { total_m: rep.total.metrage_m, sizes: rep.rows.length };
}
