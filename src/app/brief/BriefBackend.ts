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

export class RulesBackend implements BriefBackend {
  readonly label = 'règles locales';

  interpret(briefText: string): Promise<BriefResult> {
    return Promise.resolve(interpretBrief(briefText));
  }
}

export const BRIEF_ENDPOINT_STORAGE_KEY = 'toile.brief.endpoint';
export const BRIEF_REMOTE_TIMEOUT_MS = 8_000;

export class RemoteBackend implements BriefBackend {
  readonly label = 'assistant distant';

  constructor(
    private readonly endpoint: string,
    private readonly fallback: BriefBackend = new RulesBackend(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = BRIEF_REMOTE_TIMEOUT_MS,
  ) {}

  async interpret(briefText: string): Promise<BriefResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let raw: unknown;
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'toile-brief', version: 1, brief: briefText }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const validated = validateBriefResult(raw);
      if (validated) return validated;
      // Réponse hors contrat : le fallback local reste plus utile qu'une erreur.
      return this.fallback.interpret(briefText);
    } catch {
      return this.fallback.interpret(briefText);
    }
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
