import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';

// Pont de production (BLUEPRINT §16) : une fiche de production « miroir CLO »,
// native web. Première brique de la feuille de route §16.7 : le techpack JSON
// (résumé sourcing) enrichi du métrage estimé (nesting simplifié).
const ROLL_WIDTH_M = 1.5; // laize standard
const NEST_EFFICIENCY = 0.8; // rendement de placement (marker)

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

function roleLabel(p: DraftPiece): string {
  const r = p.placement?.role ?? p.wrap;
  if (r === 'armL') return 'Manche gauche';
  if (r === 'armR') return 'Manche droite';
  if (r === 'neck') return 'Col';
  if (r === 'front') return 'Devant';
  if (r === 'back') return 'Dos';
  return p.name ?? 'Pièce';
}

interface TechPackPiece {
  nom: string;
  largeur_cm: number;
  hauteur_cm: number;
  aire_cm2: number;
  tissu?: string;
}

export interface TechPackInput {
  garment: string;
  size: string;
  fabric: string;
  measureCm?: { poitrine?: number; taille?: number; bassin?: number; stature?: number } | null;
  seamAllowanceCm: number;
}

/** Assemble une fiche de production (Tech Pack simplifié). Fonction PURE. */
export function buildTechPack(draft: DraftDoc, input: TechPackInput): Record<string, unknown> {
  const entry = (p: DraftPiece, forcedName?: string): TechPackPiece => {
    const areaM2 = polygonAreaUnit(p.outline) * p.width * p.height;
    return {
      nom: forcedName ?? roleLabel(p),
      largeur_cm: +(p.width * 100).toFixed(1),
      hauteur_cm: +(p.height * 100).toFixed(1),
      aire_cm2: Math.round(areaM2 * 1e4),
      tissu: p.fabricPreset ?? undefined,
    };
  };
  const pieces: TechPackPiece[] = [entry(draft.piece, 'Devant')];
  if (draft.back && draft.back.outline.length >= 3) pieces.push(entry(draft.back, 'Dos'));
  for (const p of draft.pieces ?? []) pieces.push(entry(p));

  const totalAreaM2 = pieces.reduce((s, p) => s + p.aire_cm2, 0) / 1e4;
  // Métrage ≈ aire totale (marge de couture incluse) / (laize × rendement).
  const saFactor = 1 + Math.min(0.25, (input.seamAllowanceCm / 100) * 6);
  const yardageM = +((totalAreaM2 * saFactor) / (ROLL_WIDTH_M * NEST_EFFICIENCY)).toFixed(2);

  return {
    format: 'toile-techpack',
    version: 1,
    genere_par: 'TOILE',
    date_iso: null as string | null,
    vetement: { type: input.garment, taille: input.size },
    mensurations_cm: input.measureCm ?? null,
    tissu: input.fabric,
    marge_couture_cm: input.seamAllowanceCm,
    pieces,
    assemblage: { nb_pieces: pieces.length, coutures: draft.seams?.length ?? 0 },
    matiere: {
      laize_cm: ROLL_WIDTH_M * 100,
      rendement_placement: NEST_EFFICIENCY,
      metrage_estime_m: yardageM,
    },
    nomenclature: [
      { poste: 'Tissu principal', reference: input.fabric, quantite_m: yardageM, laize_cm: ROLL_WIDTH_M * 100 },
      { poste: 'Fil a coudre', reference: 'assorti', quantite: 'selon assemblage' },
    ],
  };
}

/** Construit + télécharge la fiche de production JSON. Renvoie l'entête (toast). */
export function exportTechPack(
  draft: DraftDoc,
  input: TechPackInput,
): { yardageM: number; pieces: number } {
  const tp = buildTechPack(draft, input);
  tp.date_iso = new Date().toISOString();
  const blob = new Blob([JSON.stringify(tp, null, 2)], { type: 'application/json' });
  const slug =
    input.garment.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vetement';
  downloadBrowserBlob(blob, `toile-techpack-${slug}.json`);
  const matiere = tp.matiere as { metrage_estime_m: number };
  const assemblage = tp.assemblage as { nb_pieces: number };
  return { yardageM: matiere.metrage_estime_m, pieces: assemblage.nb_pieces };
}
