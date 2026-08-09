/**
 * Cœur du proxy Brief→LLM — partagé entre le Worker de production
 * (server/brief-worker.ts) et le middleware de dev Vite (vite.config.ts).
 *
 * Principe (architecture IA v1) : le LLM ne dessine pas, il PILOTE. Il ne peut
 * produire qu'un `BriefResult` du contrat fermé (archétypes, tailles, tissus,
 * motifs, corps réellement disponibles) ; tout le reste devient `clarify` ou
 * `refuse` avec une suggestion constructible. La réponse du modèle est
 * validée ICI par `validateBriefResult` (le même garde-fou que le client) ;
 * une réponse hors contrat vaut UNE relance avec l'erreur, puis un échec
 * franc — côté atelier, `RemoteBackend` retombe alors sur les règles locales.
 */

import { validateBriefResult, type BriefResult } from '../src/app/brief/BriefContract';

/** Adaptateur modèle : reçoit le system prompt + les messages, rend le texte brut. */
export type ModelCaller = (
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
) => Promise<string>;

export const BRIEF_MAX_CHARS = 500;

/** Catalogue des capacités — la seule vérité montrée au modèle. */
const CATALOG = `ARCHÉTYPES CONSTRUCTIBLES (les seuls) :
- "tshirt_boxy" — t-shirt boxy. Tailles : XS, S, M, L, XL, XXL.
- "pantalon" — pantalon large. Tailles EU : 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46.
- "hoodie_zip" — hoodie zippé (7 pièces). Tailles : avatar (ajusté au mannequin), XS, S, M, L, XL, XXL, XXXL.
- "jupe" — jupe trapèze à pinces (mi-genou). Tailles : avatar (coupée aux mensurations du corps), 34, 36, 38, 40, 42, 44, 46.
- "robe" — robe cintrée sans manches (au-dessus du genou, ligne A). Tailles : avatar (coupée aux mensurations du corps), 34, 36, 38, 40, 42, 44, 46.
- "veste" — veste zippée DOUBLÉE (blouson kimono, fermeture milieu devant, doublure bordeaux). Tailles : avatar (poitrine mesurée + aisance blouson), XS, S, M, L, XL, XXL.

TISSUS (presets calibrés) : Jersey, Maille, Popeline, Denim, Lin, Laine, Soie.
MOTIFS : uni, rayures, vichy, pois.
CORPS : "scan femme", "scan homme". Stature : 140 à 210 cm.
OPS DE RETOUCHE (intent "modify") : resize{size}, change_fabric{preset}, change_motif{motif}, set_body{kind}, set_stature{statureCm}, set_sleeves{on}, try_on{}.

NON CONSTRUCTIBLES aujourd'hui (⇒ intent "refuse" + suggestionFr) :
- chemise/chemisier → suggérer : « Le plus proche : le t-shirt BOXY en popeline. »
- manteau long/parka/trench → suggérer : « Le plus proche aujourd'hui : la veste zippée doublée — ou le Hoodie zippé. »
- corset/traîne/baleines/dentelle — même portés par une robe → suggérer : « Constructible aujourd'hui : t-shirt, pantalon large, hoodie zippé, jupe trapèze, robe cintrée, veste doublée — et toute pièce tracée à la main. »
- retouche de longueur (« allonge de 10 cm ») → intent "clarify" : « La retouche de longueur reste manuelle pour l'instant. » + suggestionFr sur l'outil Longueur.`;

const CONTRACT = `CONTRAT DE SORTIE — réponds UNIQUEMENT avec un objet JSON, sans texte autour, d'une des formes :
{"intent":"create","garment":{"archetype":"...","size":"..."},"fabric":"...","motif":"...","body":{"kind":"...","statureCm":170},"sleeves":true,"tryOn":true,"resumeFr":"..."}
{"intent":"modify","ops":[{"op":"...",...}],"tryOn":false,"resumeFr":"..."}
{"intent":"clarify","resumeFr":"...","suggestionFr":"..."}
{"intent":"refuse","resumeFr":"...","suggestionFr":"..."}
Champs optionnels omis s'ils ne sont pas exprimés dans le brief (size, fabric, motif, body, sleeves). "tryOn" vaut true par défaut pour "create" (l'essayage est le moment attendu) sauf si le brief dit « sans essayage ». "resumeFr" : une phrase française claire résumant ce qui va être fait (ou pourquoi non).`;

const STYLE = `RÈGLES :
1. Vocabulaire STRICTEMENT fermé : toute valeur hors catalogue rend la réponse invalide.
2. Brief ambigu (ni vêtement ni retouche identifiable) → "clarify" avec un exemple constructible.
3. Vêtement non couvert → "refuse" + la suggestion du catalogue, jamais un à-peu-près.
4. Retouche du vêtement courant (« passe-le en… », « la même en… », « ajoute des manches ») → "modify" avec la liste d'ops minimale.
5. Tu peux interpréter les synonymes et l'à-peu-près (« coton léger » → Popeline ; « petits carreaux » → vichy ; « tricot » → Maille ; « 1m85 » → statureCm 185) mais JAMAIS inventer hors catalogue.
6. Réponds en JSON compact sur une seule ligne. Aucun commentaire, aucune balise de code.`;

export function buildBriefSystemPrompt(): string {
  return `Tu es l'interprète de briefs de TOILE, un atelier de patronage 3D dans le navigateur. Tu traduis un brief français (parfois anglais) en une action JSON du contrat — tu ne dessines jamais, tu pilotes des capacités existantes.

${CATALOG}

${CONTRACT}

${STYLE}`;
}

/** Few-shot : chaque réponse DOIT valider `validateBriefResult` (testé en CI). */
export const BRIEF_FEW_SHOT: ReadonlyArray<{ user: string; assistant: string }> = [
  {
    user: 'hoodie zippé en maille, taille L',
    assistant:
      '{"intent":"create","garment":{"archetype":"hoodie_zip","size":"L"},"fabric":"Maille","tryOn":true,"resumeFr":"Hoodie zippé en maille, taille L — essayage lancé."}',
  },
  {
    user: 'un pantalon large en laine à rayures',
    assistant:
      '{"intent":"create","garment":{"archetype":"pantalon"},"fabric":"Laine","motif":"rayures","tryOn":true,"resumeFr":"Pantalon large en laine rayée — essayage lancé."}',
  },
  {
    user: 'jupe en denim, longueur genou',
    assistant:
      '{"intent":"create","garment":{"archetype":"jupe"},"fabric":"Denim","tryOn":true,"resumeFr":"Jupe trapèze en denim, mi-genou par construction — essayage lancé. (La longueur se retouche à l\'outil Longueur.)"}',
  },
  {
    user: 'une jupe sur mesure pour ma cliente',
    assistant:
      '{"intent":"create","garment":{"archetype":"jupe","size":"avatar"},"tryOn":true,"resumeFr":"Jupe trapèze coupée aux mensurations du mannequin courant — essayage lancé."}',
  },
  {
    user: 'tee-shirt oversize en popeline avec une poche poitrine gauche',
    assistant:
      '{"intent":"create","garment":{"archetype":"tshirt_boxy"},"fabric":"Popeline","tryOn":true,"resumeFr":"T-shirt boxy en popeline — la poche poitrine se trace ensuite avec « Nouvelle pièce » (rectangle posé au slot poitrine)."}',
  },
  {
    user: 'un haut ample manches courtes en coton léger, motif petits carreaux, pour une femme de 1m75',
    assistant:
      '{"intent":"create","garment":{"archetype":"tshirt_boxy"},"fabric":"Popeline","motif":"vichy","body":{"kind":"scan femme","statureCm":175},"tryOn":true,"resumeFr":"T-shirt boxy en popeline vichy, mannequin femme 175 cm — essayage lancé."}',
  },
  {
    user: 'hoodie ajusté à mes mesures, sans essayage',
    assistant:
      '{"intent":"create","garment":{"archetype":"hoodie_zip","size":"avatar"},"tryOn":false,"resumeFr":"Hoodie zippé ajusté au mannequin — préparé sans lancer l\'essayage."}',
  },
  {
    user: 'passe-le en denim et ajoute des manches',
    assistant:
      '{"intent":"modify","ops":[{"op":"change_fabric","preset":"Denim"},{"op":"set_sleeves","on":true}],"tryOn":false,"resumeFr":"Tissu passé en denim, manches ajoutées."}',
  },
  {
    user: 'la même en taille XL sur mannequin homme',
    assistant:
      '{"intent":"modify","ops":[{"op":"resize","size":"XL"},{"op":"set_body","kind":"scan homme"}],"tryOn":false,"resumeFr":"Taille XL sur le mannequin homme."}',
  },
  {
    user: 'robe évasée en jersey, encolure ronde, taille 38',
    assistant:
      '{"intent":"create","garment":{"archetype":"robe","size":"38"},"fabric":"Jersey","tryOn":true,"resumeFr":"Robe cintrée en jersey, taille 38, encolure ronde par construction — essayage lancé."}',
  },
  {
    user: 'une robe de bal avec corset baleiné et traîne de 2 m',
    assistant:
      '{"intent":"refuse","resumeFr":"Corset baleiné et traîne demandent des techniques que TOILE ne simule pas encore.","suggestionFr":"Constructible aujourd\'hui : t-shirt, pantalon large, hoodie zippé, jupe trapèze, robe cintrée, veste doublée — et toute pièce tracée à la main."}',
  },
  {
    user: 'une veste doublée en laine, taille L',
    assistant:
      '{"intent":"create","garment":{"archetype":"veste","size":"L"},"fabric":"Laine","tryOn":true,"resumeFr":"Veste zippée doublée en laine, taille L — doublure bordeaux, essayage lancé."}',
  },
  {
    user: 'allonge-la de 10 cm',
    assistant:
      '{"intent":"clarify","resumeFr":"La retouche de longueur reste manuelle pour l\'instant.","suggestionFr":"Active l\'outil « Longueur » (étape 2) et tire l\'extrémité du bord dans son axe — la cote s\'affiche en direct."}',
  },
];

/** Extrait le premier objet JSON du texte du modèle (balises de code tolérées). */
export function extractJson(text: string): unknown | null {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface BriefProxyResponse {
  status: number;
  body: BriefResult | { error: string };
}

/**
 * Traite une requête `{format:"toile-brief", version:1, brief}` de bout en
 * bout : validation d'entrée, appel modèle (few-shot inclus), extraction et
 * validation du JSON, UNE relance en cas de réponse hors contrat.
 */
export async function handleBrief(rawBody: unknown, callModel: ModelCaller): Promise<BriefProxyResponse> {
  const req = rawBody as { format?: unknown; version?: unknown; brief?: unknown } | null;
  const brief = typeof req?.brief === 'string' ? req.brief.trim() : '';
  if (req?.format !== 'toile-brief' || req?.version !== 1 || !brief) {
    return { status: 400, body: { error: 'Requête invalide — attendu {format:"toile-brief", version:1, brief}.' } };
  }
  if (brief.length > BRIEF_MAX_CHARS) {
    return { status: 400, body: { error: `Brief trop long (max ${BRIEF_MAX_CHARS} caractères).` } };
  }

  const system = buildBriefSystemPrompt();
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...BRIEF_FEW_SHOT.flatMap((ex) => [
      { role: 'user' as const, content: ex.user },
      { role: 'assistant' as const, content: ex.assistant },
    ]),
    { role: 'user' as const, content: brief },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await callModel(system, messages);
    } catch (error) {
      return { status: 502, body: { error: `Modèle injoignable : ${String(error)}` } };
    }
    const parsed = extractJson(text);
    const validated = parsed === null ? null : validateBriefResult(parsed);
    if (validated) return { status: 200, body: validated };
    // Une seule relance, avec l'erreur : le modèle corrige presque toujours.
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          parsed === null
            ? 'Ta réponse n’était pas un JSON parsable. Réponds UNIQUEMENT avec l’objet JSON du contrat, sur une ligne.'
            : 'Ce JSON sort du contrat (intent, archétype, taille, tissu, motif ou op hors liste blanche). Corrige en n’utilisant que le vocabulaire du catalogue.',
      },
    );
  }
  return { status: 502, body: { error: 'Réponse du modèle hors contrat après relance.' } };
}

/** Appelle l'API Anthropic Messages (Workers et Node ≥ 18 : fetch global). */
export function anthropicCaller(apiKey: string, model = 'claude-haiku-4-5'): ModelCaller {
  return async (system, messages) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 600, temperature: 0, system, messages }),
    });
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = data.content?.find((c) => typeof c.text === 'string')?.text;
    if (!text) throw new Error('Réponse Anthropic sans texte.');
    return text;
  };
}
