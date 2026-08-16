/**
 * Contrat « Bilan du tombé » — le conseiller de bien-aller.
 *
 * Même principe que le Brief : l'IA ne dessine pas, elle lit des MESURES
 * (aisance, étirement, coutures — calculées par le solveur) et répond dans un
 * vocabulaire fermé : constats par zone + suggestions exprimées dans les MÊMES
 * ops que le Brief, validées par la même liste blanche des deux côtés.
 */

import { validateBriefOps, type BriefOp } from './BriefContract';

/** États de zone affichables (icône + ton du constat). */
export const FIT_ETATS = ['ok', 'tendu', 'serré', 'ample'] as const;
export type FitEtat = (typeof FIT_ETATS)[number];

export interface FitFinding {
  zone: string;
  etat: FitEtat;
  detailFr: string;
}

export interface FitSuggestion {
  labelFr: string;
  ops: BriefOp[];
}

export interface FitAdviceResult {
  intent: 'fit';
  /** Verdict global en une phrase de couturière. */
  resumeFr: string;
  findings: FitFinding[];
  suggestions: FitSuggestion[];
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Garde-fou : toute réponse du conseiller repasse ici avant affichage. */
export function validateFitAdvice(raw: unknown): FitAdviceResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.intent !== 'fit' || !isString(r.resumeFr)) return null;
  const findings: FitFinding[] = [];
  if (Array.isArray(r.findings)) {
    for (const rawF of r.findings) {
      const f = rawF as Record<string, unknown>;
      if (isString(f?.zone) && isString(f?.detailFr) && FIT_ETATS.includes(f?.etat as FitEtat)) {
        findings.push({ zone: f.zone, etat: f.etat as FitEtat, detailFr: f.detailFr });
      }
    }
  }
  const suggestions: FitSuggestion[] = [];
  if (Array.isArray(r.suggestions)) {
    for (const rawS of r.suggestions) {
      const sg = rawS as Record<string, unknown>;
      if (!isString(sg?.labelFr)) continue;
      const ops = validateBriefOps(sg.ops);
      if (ops.length) suggestions.push({ labelFr: sg.labelFr, ops });
    }
  }
  if (!findings.length && !suggestions.length) return null;
  return { intent: 'fit', resumeFr: r.resumeFr, findings, suggestions };
}
