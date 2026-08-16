/**
 * Worker Cloudflare — le proxy Brief→LLM de production (la seule pièce backend
 * de TOILE). Déploiement, depuis la racine du dépôt :
 *
 *   npx wrangler deploy --config server/wrangler.toml
 *   npx wrangler secret put ANTHROPIC_API_KEY --config server/wrangler.toml
 *
 * Puis, dans l'atelier (console navigateur) :
 *   localStorage.setItem('toile.brief.endpoint', 'https://<ton-worker>.workers.dev/api/brief')
 *
 * Variables : ANTHROPIC_API_KEY (secret, requis) · BRIEF_MODEL (optionnel,
 * défaut claude-haiku-4-5). CORS ouvert (*) pour la démo — à restreindre au
 * domaine public de TOILE avant une beta.
 */

import { anthropicCaller, handleStudioRequest } from './brief-core';

interface Env {
  ANTHROPIC_API_KEY?: string;
  BRIEF_MODEL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    // Sonde du Studio IA (même contrat que le middleware de dev).
    if (request.method === 'GET') return json(200, { ready: !!env.ANTHROPIC_API_KEY });
    if (request.method !== 'POST') return json(405, { error: 'POST uniquement.' });
    if (!env.ANTHROPIC_API_KEY) return json(503, { error: 'ANTHROPIC_API_KEY non configurée sur le Worker.' });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'Corps JSON attendu.' });
    }
    const result = await handleStudioRequest(body, anthropicCaller(env.ANTHROPIC_API_KEY, env.BRIEF_MODEL));
    return json(result.status, result.body);
  },
};
