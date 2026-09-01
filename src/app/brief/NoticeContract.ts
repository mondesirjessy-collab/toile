/**
 * Contrat « Notice de montage » (v296) — la gamme d'assemblage rédigée.
 *
 * Même principe que le Brief et le Bilan : l'IA ne dessine pas, elle RÉDIGE
 * depuis les MESURES réelles du patron (pièces, coutures, pinces extraites du
 * DraftDoc) et répond dans un vocabulaire fermé : des étapes numérotées, du
 * texte borné, rien d'autre. La notice reste INDICATIVE : personne ici n'a
 * cousu le vêtement — le document imprimé le dit en toutes lettres.
 */

export interface NoticeStep {
  n: number;
  titreFr: string;
  detailFr: string;
}

export interface NoticeResult {
  intent: 'notice';
  titreFr: string;
  etapes: NoticeStep[];
  /** Conseils transverses (0 à 5) : type de point, aiguille, repassage… */
  conseilsFr: string[];
}

export const NOTICE_MAX_ETAPES = 20;
export const NOTICE_MAX_CONSEILS = 5;
const MAX_TITRE = 160;
const MAX_DETAIL = 600;

const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : null;
};

/** Garde-fou : toute notice (LLM distant OU repli local) repasse ici. */
export function validateNotice(raw: unknown): NoticeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.intent !== 'notice') return null;
  const titreFr = cleanText(r.titreFr, MAX_TITRE);
  if (!titreFr || !Array.isArray(r.etapes)) return null;
  const etapes: NoticeStep[] = [];
  for (const rawStep of r.etapes.slice(0, NOTICE_MAX_ETAPES)) {
    const s = rawStep as Record<string, unknown>;
    const titre = cleanText(s?.titreFr, MAX_TITRE);
    const detail = cleanText(s?.detailFr, MAX_DETAIL);
    if (!titre || !detail) continue;
    etapes.push({ n: etapes.length + 1, titreFr: titre, detailFr: detail });
  }
  if (!etapes.length) return null;
  const conseilsFr: string[] = [];
  if (Array.isArray(r.conseilsFr)) {
    for (const rawConseil of r.conseilsFr.slice(0, NOTICE_MAX_CONSEILS)) {
      const conseil = cleanText(rawConseil, MAX_DETAIL);
      if (conseil) conseilsFr.push(conseil);
    }
  }
  return { intent: 'notice', titreFr, etapes, conseilsFr };
}
