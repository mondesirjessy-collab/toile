import type { DraftDoc, DraftPiece, UV } from '../engine/pattern/Draft';
import { downloadBrowserBlob } from './browserDownload';
import { nestMarker } from './markerLayout';

// Pont de production (BLUEPRINT §16) : une fiche de production « miroir CLO »,
// native web (feuille §16.7 #1). Le métrage vient du MÊME nesting serré que le
// plan de découpe (marker) et le DXF → les trois exports affichent le même
// chiffre.

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
  // Métrage RÉEL : longueur du plan de découpe (même nesting serré que le
  // marker SVG et le DXF). Rendement = aire des pièces / surface utilisée.
  const nest = nestMarker(draft, input.seamAllowanceCm);
  const rollWidthM = nest.rollWidthCm / 100;
  const yardageM = +(nest.lengthCm / 100).toFixed(2);
  const usedM2 = rollWidthM * yardageM;
  const efficiency = usedM2 > 0 ? +(totalAreaM2 / usedM2).toFixed(2) : 0;

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
      laize_cm: nest.rollWidthCm,
      metrage_reel_m: yardageM,
      rendement_placement: efficiency,
    },
    nomenclature: [
      { poste: 'Tissu principal', reference: input.fabric, quantite_m: yardageM, laize_cm: nest.rollWidthCm },
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
  const matiere = tp.matiere as { metrage_reel_m: number };
  const assemblage = tp.assemblage as { nb_pieces: number };
  return { yardageM: matiere.metrage_reel_m, pieces: assemblage.nb_pieces };
}
