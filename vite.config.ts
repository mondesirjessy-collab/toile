/**
 * Config Vite de TOILE. Unique ajout : le proxy Brief→LLM en mode dev, pour
 * tester le Studio IA sans rien déployer.
 *
 * Marche à suivre (Mac) :
 *   1. echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env.local   (jamais commité)
 *   2. relancer `npm run dev`
 *   3. dans la console de l'atelier :
 *      localStorage.setItem('toile.brief.endpoint', 'http://localhost:5173/api/brief')
 *   4. taper un brief — sans clé ou sans endpoint, les règles locales
 *      continuent de répondre comme avant (repli silencieux de RemoteBackend).
 */

import { defineConfig, loadEnv, type Plugin } from 'vite';
import { anthropicCaller, handleStudioRequest } from './server/brief-core';

function briefDevProxy(env: Record<string, string>): Plugin {
  return {
    name: 'toile-brief-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/brief', (req, res) => {
        const finish = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET') {
          // Sonde du Studio IA : le client détecte proxy + clé sans coût modèle.
          return finish(200, { ready: !!env.ANTHROPIC_API_KEY, model: env.BRIEF_MODEL || 'claude-haiku-4-5' });
        }
        if (req.method !== 'POST') return finish(405, { error: 'POST uniquement.' });
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return finish(503, { error: 'ANTHROPIC_API_KEY absente de .env.local — règles locales en repli.' });
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              return finish(400, { error: 'Corps JSON attendu.' });
            }
            try {
              const result = await handleStudioRequest(body, anthropicCaller(apiKey, env.BRIEF_MODEL || undefined));
              finish(result.status, result.body);
            } catch (error) {
              finish(502, { error: String(error) });
            }
          })();
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Préfixe '' : lit aussi les variables non VITE_* (.env.local) côté serveur
  // de dev uniquement — rien de tout cela n'est exposé au bundle client.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [briefDevProxy(env)],
  };
});
