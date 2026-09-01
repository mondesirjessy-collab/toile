/**
 * Backends du Brief : règles locales (défaut) et endpoint distant optionnel.
 *
 * La « prise LLM » : poser une URL dans localStorage
 * (`toile.brief.endpoint`) suffit à router les briefs vers un serveur qui
 * répond au même contrat JSON. Tout ce qui en revient repasse par
 * `validateBriefResult` — un backend distant ne peut donc demander que des
 * actions de la liste blanche — et toute panne (timeout, HTTP, JSON invalide)
 * retombe sans bruit sur les règles locales : la démo ne dépend jamais du réseau.
 */

import { validateBriefResult, type BriefResult } from './BriefContract';
import { interpretBrief } from './BriefRules';

export interface BriefBackend {
  readonly label: string;
  interpret(briefText: string): Promise<BriefResult>;
}

/** Image jointe à un brief visuel (déjà compressée côté client). */
export interface BriefImageAttachment {
  mediaType: string;
  dataBase64: string;
}

/**
 * Un échange passé du Studio (v295 — « le Studio se souvient ») : le brief
 * tapé et la réponse JSON validée qui lui a été appliquée. Envoyé au proxy
 * pour que « d'accord, fais ça » ou « la même en rouge » se comprennent.
 * Les règles locales restent SANS état : la mémoire est invisible sans clé.
 */
export interface BriefHistoryEntry {
  brief: string;
  reponse: string;
}

/** Profondeur de mémoire : les 4 derniers échanges suffisent aux reprises. */
export const BRIEF_HISTORY_MAX = 4;

export class RulesBackend implements BriefBackend {
  readonly label = 'règles locales';

  interpret(briefText: string): Promise<BriefResult> {
    return Promise.resolve(interpretBrief(briefText));
  }
}

export const BRIEF_ENDPOINT_STORAGE_KEY = 'toile.brief.endpoint';
export const BRIEF_REMOTE_TIMEOUT_MS = 8_000;

/** Qui a réellement produit le dernier résultat (affichage de provenance). */
export type BriefProvenance = 'assistant' | 'règles';

export class RemoteBackend implements BriefBackend {
  readonly label = 'assistant distant';
  lastUsed: BriefProvenance | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly fallback: BriefBackend = new RulesBackend(),
    // Lié explicitement : `this.fetchImpl(...)` invoquerait sinon fetch avec
    // `this` = l'instance → « Illegal invocation » dans Chrome, et le backend
    // distant retomberait silencieusement sur les règles à CHAQUE brief.
    // (Trouvé en validation live v192 — les mocks de test, des fonctions
    // fléchées, ne détectaient pas la sensibilité au `this`.)
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs: number = BRIEF_REMOTE_TIMEOUT_MS,
    /** État atelier joint à chaque brief (« ÉTAT ACTUEL » côté proxy) — optionnel. */
    private readonly contextProvider: (() => Record<string, unknown> | null) | null = null,
    /** Brief visuel : image jointe {mediaType, dataBase64} — optionnel. */
    private readonly imageProvider: (() => BriefImageAttachment | null) | null = null,
    /** Mémoire de session : les derniers échanges {brief, reponse} — optionnel. */
    private readonly historyProvider: (() => BriefHistoryEntry[] | null) | null = null,
  ) {}

  async interpret(briefText: string): Promise<BriefResult> {
    try {
      const controller = new AbortController();
      const image0 = this.imageProvider?.() ?? null;
      const timeout = image0 ? Math.max(this.timeoutMs, 25_000) : this.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeout);
      let raw: unknown;
      try {
        const payload: Record<string, unknown> = { format: 'toile-brief', version: 1, brief: briefText };
        const context = this.contextProvider?.() ?? null;
        if (context && Object.keys(context).length > 0) payload.context = context;
        const history = this.historyProvider?.() ?? null;
        if (history?.length) payload.history = history.slice(-BRIEF_HISTORY_MAX);
        const image = this.imageProvider?.() ?? null;
        if (image) payload.image = image;
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const validated = validateBriefResult(raw);
      if (validated) {
        this.lastUsed = 'assistant';
        return validated;
      }
      // Réponse hors contrat : le fallback local reste plus utile qu'une erreur.
      this.lastUsed = 'règles';
      return this.fallback.interpret(briefText);
    } catch {
      this.lastUsed = 'règles';
      return this.fallback.interpret(briefText);
    }
  }
}

/**
 * Sonde `/api/brief` (GET) : vrai si un proxy Studio IA répond avec une clé
 * configurée. Permet d'activer Claude sans aucune manipulation console —
 * proxy dev Vite en local, Worker/Function en production, même contrat.
 */
export async function probeBriefEndpoint(
  url: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 2500,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      if (!response.ok) return false;
      const data = (await response.json()) as { ready?: unknown } | null;
      return data?.ready === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export interface BriefEndpointStorage {
  getItem(key: string): string | null;
}

/** Choisit le backend au démarrage ; jamais d'échec (storage interdit ⇒ règles). */
export function selectBriefBackend(
  storage: BriefEndpointStorage | null = typeof localStorage === 'undefined' ? null : localStorage,
): BriefBackend {
  try {
    const endpoint = storage?.getItem(BRIEF_ENDPOINT_STORAGE_KEY)?.trim();
    if (endpoint && /^https?:\/\//.test(endpoint)) {
      return new RemoteBackend(endpoint);
    }
  } catch {
    // Webviews privées : storage inaccessible — les règles locales suffisent.
  }
  return new RulesBackend();
}
