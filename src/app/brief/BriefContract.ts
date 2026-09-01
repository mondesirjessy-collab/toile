/**
 * Contrat « Brief » — le pont entre un brief en langage naturel et l'atelier.
 *
 * Principe directeur : l'interpréteur (règles locales aujourd'hui, LLM demain)
 * ne produit JAMAIS de géométrie libre. Il émet un `BriefResult` fermé sur des
 * listes blanches — archétypes réellement chargeables, tailles réellement
 * proposées, presets tissu réellement calibrés. Tout ce qui sort de ce
 * vocabulaire devient `clarify` ou `refuse` avec une suggestion constructible,
 * jamais un à-peu-près silencieux.
 */

export const BRIEF_ARCHETYPES = [
  'tshirt_boxy',
  'pantalon',
  'hoodie_zip',
  'jupe',
  'robe',
  'veste',
  'doudoune',
] as const;
export type BriefArchetype = (typeof BRIEF_ARCHETYPES)[number];

export const BRIEF_FABRICS = [
  'Jersey',
  'Maille',
  'Popeline',
  'Denim',
  'Lin',
  'Laine',
  'Soie',
] as const;
export type BriefFabric = (typeof BRIEF_FABRICS)[number];

export const BRIEF_MOTIFS = ['uni', 'rayures', 'vichy', 'pois'] as const;
export type BriefMotif = (typeof BRIEF_MOTIFS)[number];

/**
 * Nuancier FERMÉ des couleurs d'imprimé (français → RGB [0..1] du panneau
 * motif). La couleur ne s'applique qu'aux IMPRIMÉS (rayures, vichy, pois) —
 * un « t-shirt rouge » uni relève du tissu, pas du motif : hors contrat ici.
 */
export const BRIEF_MOTIF_COULEURS = {
  rouge: [0.78, 0.16, 0.16],
  bordeaux: [0.45, 0.09, 0.16],
  rose: [0.91, 0.55, 0.67],
  orange: [0.89, 0.45, 0.13],
  jaune: [0.93, 0.78, 0.2],
  vert: [0.22, 0.55, 0.32],
  'bleu marine': [0.1, 0.16, 0.32],
  bleu: [0.2, 0.42, 0.72],
  violet: [0.45, 0.28, 0.58],
  marron: [0.42, 0.28, 0.18],
  beige: [0.85, 0.78, 0.65],
  gris: [0.55, 0.55, 0.58],
  noir: [0.12, 0.12, 0.14],
  blanc: [1, 1, 1],
} as const;
export type BriefMotifCouleur = keyof typeof BRIEF_MOTIF_COULEURS;

/** Bornes du curseur « échelle (cm) » du panneau motif (lil-gui, pas 0,5). */
export const BRIEF_MOTIF_CM_MIN = 1;
export const BRIEF_MOTIF_CM_MAX = 30;

export function clampMotifCm(cm: number): number {
  if (!Number.isFinite(cm)) return 5;
  const halfSteps = Math.round(cm * 2) / 2;
  return Math.min(BRIEF_MOTIF_CM_MAX, Math.max(BRIEF_MOTIF_CM_MIN, halfSteps));
}

export function isMotifCouleur(v: unknown): v is BriefMotifCouleur {
  return typeof v === 'string' && v in BRIEF_MOTIF_COULEURS;
}

export const BRIEF_BOXY_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export const BRIEF_PANTS_SIZES = [
  '26', '28', '30', '32', '34', '36', '38', '40', '42', '44', '46',
] as const;
/** Le hoodie accepte en plus l'ajustement dynamique au mannequin. */
export const BRIEF_HOODIE_SIZES = ['avatar', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;
/** La jupe : tailles EU + coupe aux mensurations du corps courant. */
export const BRIEF_JUPE_SIZES = ['avatar', '34', '36', '38', '40', '42', '44', '46'] as const;
/** La robe cintrée : mêmes tailles EU + coupe aux mensurations. */
export const BRIEF_ROBE_SIZES = ['avatar', '34', '36', '38', '40', '42', '44', '46'] as const;
/** La veste zippée doublée : lettres + coupe aux mensurations. */
export const BRIEF_VESTE_SIZES = ['avatar', 'XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
/** La doudoune matelassée : mêmes lettres + coupe aux mensurations. */
export const BRIEF_DOUDOUNE_SIZES = ['avatar', 'XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;

export type BriefBodyKind = 'scan femme' | 'scan homme';

/** Bornes du slider mannequin (index.html #at-avatar-stature). */
export const BRIEF_STATURE_MIN_CM = 140;
export const BRIEF_STATURE_MAX_CM = 210;

export interface BriefGarment {
  archetype: BriefArchetype;
  /** Valeur du sélecteur de taille ; validée à l'exécution contre les options réelles. */
  size?: string;
}

export interface BriefBody {
  kind?: BriefBodyKind;
  statureCm?: number;
}

export type BriefOp =
  | { op: 'resize'; size: string }
  | { op: 'change_fabric'; preset: BriefFabric }
  | { op: 'change_motif'; motif: BriefMotif; couleur?: BriefMotifCouleur; cm?: number }
  | { op: 'set_body'; kind: BriefBodyKind }
  | { op: 'set_stature'; statureCm: number }
  | { op: 'set_sleeves'; on: boolean }
  | { op: 'try_on' };

export interface BriefCreate {
  intent: 'create';
  garment: BriefGarment;
  fabric?: BriefFabric;
  motif?: BriefMotif;
  /** Couleur d'imprimé (nuancier fermé) — ignorée si motif absent ou uni. */
  motifCouleur?: BriefMotifCouleur;
  /** Échelle de l'imprimé en cm (bornée au curseur réel 1..30). */
  motifCm?: number;
  body?: BriefBody;
  sleeves?: boolean;
  /** Lancer l'essayage 3D à la fin (défaut : oui — c'est le moment « waouh »). */
  tryOn: boolean;
  resumeFr: string;
}

export interface BriefModify {
  intent: 'modify';
  ops: BriefOp[];
  tryOn: boolean;
  resumeFr: string;
}

export interface BriefSay {
  intent: 'clarify' | 'refuse';
  resumeFr: string;
  /** Toujours proposer le chemin constructible le plus proche. */
  suggestionFr?: string;
}

export type BriefResult = BriefCreate | BriefModify | BriefSay;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function clampStature(cm: number): number {
  if (!Number.isFinite(cm)) return BRIEF_STATURE_MIN_CM;
  return Math.min(BRIEF_STATURE_MAX_CM, Math.max(BRIEF_STATURE_MIN_CM, Math.round(cm)));
}

/**
 * Garde-fou côté TOILE : tout résultat (règles locales, LLM distant, fichier
 * importé) repasse par ici avant exécution. Un backend distant compromis ou
 * halluciné ne peut donc demander que des actions du vocabulaire fermé.
 */
export function validateBriefResult(raw: unknown): BriefResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.intent === 'clarify' || r.intent === 'refuse') {
    if (!isString(r.resumeFr)) return null;
    const out: BriefSay = { intent: r.intent, resumeFr: r.resumeFr };
    if (isString(r.suggestionFr)) out.suggestionFr = r.suggestionFr;
    return out;
  }
  if (r.intent === 'create') {
    const g = r.garment as Record<string, unknown> | undefined;
    if (!g || !BRIEF_ARCHETYPES.includes(g.archetype as BriefArchetype)) return null;
    if (!isString(r.resumeFr)) return null;
    const out: BriefCreate = {
      intent: 'create',
      garment: { archetype: g.archetype as BriefArchetype },
      tryOn: r.tryOn !== false,
      resumeFr: r.resumeFr,
    };
    if (isString(g.size)) out.garment.size = g.size;
    if (BRIEF_FABRICS.includes(r.fabric as BriefFabric)) out.fabric = r.fabric as BriefFabric;
    if (BRIEF_MOTIFS.includes(r.motif as BriefMotif)) out.motif = r.motif as BriefMotif;
    if (out.motif && out.motif !== 'uni' && isMotifCouleur(r.motifCouleur)) {
      out.motifCouleur = r.motifCouleur;
    }
    if (out.motif && out.motif !== 'uni' && typeof r.motifCm === 'number') {
      out.motifCm = clampMotifCm(r.motifCm);
    }
    if (typeof r.sleeves === 'boolean') out.sleeves = r.sleeves;
    const b = r.body as Record<string, unknown> | undefined;
    if (b && typeof b === 'object') {
      const body: BriefBody = {};
      if (b.kind === 'scan femme' || b.kind === 'scan homme') body.kind = b.kind;
      if (typeof b.statureCm === 'number') body.statureCm = clampStature(b.statureCm);
      if (body.kind !== undefined || body.statureCm !== undefined) out.body = body;
    }
    return out;
  }
  if (r.intent === 'modify') {
    if (!isString(r.resumeFr) || !Array.isArray(r.ops)) return null;
    const ops = validateBriefOps(r.ops);
    if (!ops.length) return null;
    return { intent: 'modify', ops, tryOn: r.tryOn === true, resumeFr: r.resumeFr };
  }
  return null;
}

/**
 * Valide une liste d'ops contre la liste blanche — partagé entre le Brief
 * (intent "modify") et le Bilan du tombé (suggestions du conseiller).
 * Op inconnue : ignorée silencieusement ; l'exécuteur n'a donc jamais à gérer
 * autre chose que le vocabulaire fermé.
 */
export function validateBriefOps(rawOps: unknown): BriefOp[] {
  if (!Array.isArray(rawOps)) return [];
  const ops: BriefOp[] = [];
  for (const rawOp of rawOps) {
    const o = rawOp as Record<string, unknown>;
    switch (o?.op) {
      case 'resize':
        if (isString(o.size)) ops.push({ op: 'resize', size: o.size });
        break;
      case 'change_fabric':
        if (BRIEF_FABRICS.includes(o.preset as BriefFabric)) {
          ops.push({ op: 'change_fabric', preset: o.preset as BriefFabric });
        }
        break;
      case 'change_motif':
        if (BRIEF_MOTIFS.includes(o.motif as BriefMotif)) {
          const op: BriefOp = { op: 'change_motif', motif: o.motif as BriefMotif };
          if (op.motif !== 'uni' && isMotifCouleur(o.couleur)) op.couleur = o.couleur;
          if (op.motif !== 'uni' && typeof o.cm === 'number') op.cm = clampMotifCm(o.cm);
          ops.push(op);
        }
        break;
      case 'set_body':
        if (o.kind === 'scan femme' || o.kind === 'scan homme') {
          ops.push({ op: 'set_body', kind: o.kind });
        }
        break;
      case 'set_stature':
        if (typeof o.statureCm === 'number') {
          ops.push({ op: 'set_stature', statureCm: clampStature(o.statureCm) });
        }
        break;
      case 'set_sleeves':
        if (typeof o.on === 'boolean') ops.push({ op: 'set_sleeves', on: o.on });
        break;
      case 'try_on':
        ops.push({ op: 'try_on' });
        break;
      default:
        break;
    }
  }
  return ops;
}
