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
import { validateFitAdvice, type FitAdviceResult } from '../src/app/brief/FitContract';

/** Bloc de contenu multimodal (sous-ensemble de l'API Messages d'Anthropic). */
export type ModelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Adaptateur modèle : reçoit le system prompt + les messages, rend le texte brut. */
export type ModelCaller = (
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | ModelContentBlock[] }>,
) => Promise<string>;

export const BRIEF_MAX_CHARS = 500;
/** Types d'image acceptés par l'API Messages (brief visuel). */
export const BRIEF_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
/** ~2 Mo une fois encodée base64 : large pour un croquis compressé côté client. */
export const BRIEF_IMAGE_MAX_BASE64 = 2_800_000;

/** Catalogue des capacités — la seule vérité montrée au modèle. */
const CATALOG = `ARCHÉTYPES CONSTRUCTIBLES (les seuls) :
- "tshirt_boxy" — t-shirt boxy. Tailles : XS, S, M, L, XL, XXL.
- "pantalon" — pantalon large. Tailles EU : 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46.
- "hoodie_zip" — hoodie zippé (7 pièces). Tailles : avatar (ajusté au mannequin), XS, S, M, L, XL, XXL, XXXL.
- "jupe" — jupe trapèze à pinces (mi-genou). Tailles : avatar (coupée aux mensurations du corps), 34, 36, 38, 40, 42, 44, 46.
- "robe" — robe cintrée sans manches (au-dessus du genou, ligne A). Tailles : avatar (coupée aux mensurations du corps), 34, 36, 38, 40, 42, 44, 46.
- "veste" — veste zippée DOUBLÉE (blouson kimono, fermeture milieu devant, doublure bordeaux). Tailles : avatar (poitrine mesurée + aisance blouson), XS, S, M, L, XL, XXL.
- "doudoune" — doudoune MATELASSÉE (le châssis de la veste + canaux de matelassage, le tissu extérieur boudine entre les piqûres). Tailles : avatar (poitrine mesurée + aisance doudoune), XS, S, M, L, XL, XXL.

TISSUS (presets calibrés) : Jersey, Maille, Popeline, Denim, Lin, Laine, Soie.
MOTIFS : uni, rayures, vichy, pois.
COULEURS D'IMPRIMÉ (motifCouleur — nuancier fermé, UNIQUEMENT avec un motif rayures/vichy/pois, jamais pour un uni) : rouge, bordeaux, rose, orange, jaune, vert, bleu, "bleu marine", violet, marron, beige, gris, noir, blanc.
ÉCHELLE D'IMPRIMÉ (motifCm — en cm, 1 à 30) : « petits carreaux / rayures fines » ≈ 1.5, « gros pois / larges rayures » ≈ 8, valeur explicite si donnée (« carreaux de 3 cm » → 3). motifCouleur et motifCm sont des ENRICHISSEMENTS OPTIONNELS : un motif sans couleur ni échelle se construit tel quel (couleur et taille par défaut) — ne demande JAMAIS de précision pour ça, réponds "create". Seul cas à signaler : un vêtement UNI d'une couleur (« t-shirt rouge », sans imprimé) n'est PAS constructible par le motif — construis-le quand même (sans couleur) et dis dans resumeFr que la couleur unie n'est pas encore disponible, ou qu'un imprimé coloré l'est.
CORPS : "scan femme", "scan homme". Stature : 140 à 210 cm.
OPS DE RETOUCHE (intent "modify") : resize{size}, change_fabric{preset}, change_motif{motif, couleur?, cm?}, set_body{kind}, set_stature{statureCm}, set_sleeves{on}, try_on{}.

NON CONSTRUCTIBLES aujourd'hui (⇒ intent "refuse" + suggestionFr) :
- chemise/chemisier → suggérer : « Le plus proche : le t-shirt BOXY en popeline. »
- manteau long/parka/trench → suggérer : « Le plus proche aujourd'hui : la veste zippée doublée — ou le Hoodie zippé. »
- corset/traîne/baleines/dentelle — même portés par une robe → suggérer : « Constructible aujourd'hui : t-shirt, pantalon large, hoodie zippé, jupe trapèze, robe cintrée, veste doublée — et toute pièce tracée à la main. »
- retouche de longueur (« allonge de 10 cm ») → intent "clarify" : « La retouche de longueur reste manuelle pour l'instant. » + suggestionFr sur l'outil Longueur.`;

const CONTRACT = `CONTRAT DE SORTIE — réponds UNIQUEMENT avec un objet JSON, sans texte autour, d'une des formes :
{"intent":"create","garment":{"archetype":"...","size":"..."},"fabric":"...","motif":"...","motifCouleur":"...","motifCm":1.5,"body":{"kind":"...","statureCm":170},"sleeves":true,"tryOn":true,"resumeFr":"..."}
{"intent":"modify","ops":[{"op":"...",...}],"tryOn":false,"resumeFr":"..."}
{"intent":"clarify","resumeFr":"...","suggestionFr":"..."}
{"intent":"refuse","resumeFr":"...","suggestionFr":"..."}
Champs optionnels omis s'ils ne sont pas exprimés dans le brief (size, fabric, motif, motifCouleur, motifCm, body, sleeves). "tryOn" vaut true par défaut pour "create" (l'essayage est le moment attendu) sauf si le brief dit « sans essayage ». "resumeFr" : une phrase française claire résumant ce qui va être fait (ou pourquoi non).`;

const STYLE = `RÈGLES :
1. Vocabulaire STRICTEMENT fermé : toute valeur hors catalogue rend la réponse invalide.
2. Brief ambigu (ni vêtement ni retouche identifiable) → "clarify" avec un exemple constructible.
3. Vêtement non couvert → "refuse" + la suggestion du catalogue, jamais un à-peu-près.
4. Retouche du vêtement courant (« passe-le en… », « la même en… », « ajoute des manches ») → "modify" avec la liste d'ops minimale.
5. Tu peux interpréter les synonymes et l'à-peu-près (« coton léger » → Popeline ; « petits carreaux » → vichy ; « tricot » → Maille ; « 1m85 » → statureCm 185) mais JAMAIS inventer hors catalogue.
6. Réponds en JSON compact sur une seule ligne. Aucun commentaire, aucune balise de code.
7. Un « ÉTAT ACTUEL : … » peut précéder le brief : c'est le vêtement déjà chargé dans l'atelier. Les retouches relatives (« une taille au-dessus », « plus grand », « l'autre mannequin », « enlève le motif ») se calculent depuis cet état, dans la liste de tailles de CE patron.
8. BRIEF VISUEL : une image (photo, croquis, moodboard) peut accompagner ou remplacer le texte. Identifie le vêtement porté ou dessiné et rapproche-le du catalogue : silhouette → archétype le plus proche, texture/aspect → tissu le plus proche, imprimé → motif le plus proche (uni/rayures/vichy/pois). Le texte, s'il existe, PRIME sur l'image en cas de conflit. Ne devine jamais une taille depuis une photo. Vêtement photographié non constructible → "refuse" + suggestion du catalogue ; image sans vêtement identifiable → "clarify". Mentionne « d'après la photo » (ou « d'après le croquis ») dans resumeFr.`;

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
      '{"intent":"create","garment":{"archetype":"tshirt_boxy"},"fabric":"Popeline","motif":"vichy","motifCm":1.5,"body":{"kind":"scan femme","statureCm":175},"tryOn":true,"resumeFr":"T-shirt boxy en popeline vichy petits carreaux, mannequin femme 175 cm — essayage lancé."}',
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
    user: 'une doudoune bien gonflée pour l\'hiver, taille M',
    assistant:
      '{"intent":"create","garment":{"archetype":"doudoune","size":"M"},"tryOn":true,"resumeFr":"Doudoune matelassée taille M — le tissu extérieur boudine entre les piqûres, essayage lancé."}',
  },
  {
    user:
      'ÉTAT ACTUEL : patron=tshirt_boxy, taille=M, tissu=Jersey, motif=uni, mannequin=scan femme, stature=175 cm, manches auto=non, essayage 3D=actif\nBRIEF : une taille au-dessus',
    assistant:
      '{"intent":"modify","ops":[{"op":"resize","size":"L"}],"tryOn":false,"resumeFr":"Taille L — un cran au-dessus de M."}',
  },
  {
    user:
      'ÉTAT ACTUEL : patron=hoodie_zip, taille=avatar, tissu=Maille, motif=uni, mannequin=scan homme, stature=188 cm, manches auto=non, essayage 3D=actif\nBRIEF : l\'autre mannequin, en 1m70',
    assistant:
      '{"intent":"modify","ops":[{"op":"set_body","kind":"scan femme"},{"op":"set_stature","statureCm":170}],"tryOn":false,"resumeFr":"Mannequin femme, stature 170 cm."}',
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

/**
 * Résume l'état atelier transmis par le client (`context`) en une ligne pour
 * le modèle. Tolérant : champs inconnus ignorés, chaînes bornées — cet état
 * n'entre jamais dans le contrat de sortie, il ne fait qu'informer le modèle.
 */
export function briefContextLine(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const ctx = raw as Record<string, unknown>;
  const parts: string[] = [];
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= 60 ? v : null;
  const patron = str(ctx.patron);
  if (patron) parts.push(`patron=${patron}`);
  const taille = str(ctx.taille);
  if (taille) parts.push(`taille=${taille}`);
  const tissu = str(ctx.tissu);
  if (tissu) parts.push(`tissu=${tissu}`);
  const motif = str(ctx.motif);
  if (motif) parts.push(`motif=${motif}`);
  const mannequin = str(ctx.mannequin);
  if (mannequin) parts.push(`mannequin=${mannequin}`);
  if (typeof ctx.statureCm === 'number' && Number.isFinite(ctx.statureCm)) {
    parts.push(`stature=${Math.round(ctx.statureCm)} cm`);
  }
  if (typeof ctx.manchesAuto === 'boolean') parts.push(`manches auto=${ctx.manchesAuto ? 'oui' : 'non'}`);
  if (typeof ctx.essayage === 'boolean') parts.push(`essayage 3D=${ctx.essayage ? 'actif' : 'non'}`);
  return parts.length ? parts.join(', ') : null;
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
  const req = rawBody as {
    format?: unknown;
    version?: unknown;
    brief?: unknown;
    context?: unknown;
    image?: unknown;
  } | null;
  const brief = typeof req?.brief === 'string' ? req.brief.trim() : '';
  // Brief visuel : image optionnelle {mediaType, dataBase64}, bornée et typée.
  let image: { mediaType: string; data: string } | null = null;
  if (req?.image !== undefined && req.image !== null) {
    const rawImage = req.image as { mediaType?: unknown; dataBase64?: unknown };
    const mediaType = rawImage?.mediaType;
    const data = rawImage?.dataBase64;
    if (
      typeof mediaType !== 'string' ||
      !BRIEF_IMAGE_MEDIA_TYPES.includes(mediaType as (typeof BRIEF_IMAGE_MEDIA_TYPES)[number]) ||
      typeof data !== 'string' ||
      data.length === 0
    ) {
      return { status: 400, body: { error: 'Image invalide — attendu {mediaType (jpeg/png/webp/gif), dataBase64}.' } };
    }
    if (data.length > BRIEF_IMAGE_MAX_BASE64) {
      return { status: 400, body: { error: 'Image trop lourde (max ~2 Mo encodée) — réduis-la côté client.' } };
    }
    image = { mediaType, data };
  }
  if (req?.format !== 'toile-brief' || req?.version !== 1 || (!brief && !image)) {
    return { status: 400, body: { error: 'Requête invalide — attendu {format:"toile-brief", version:1, brief et/ou image}.' } };
  }
  if (brief.length > BRIEF_MAX_CHARS) {
    return { status: 400, body: { error: `Brief trop long (max ${BRIEF_MAX_CHARS} caractères).` } };
  }

  const system = buildBriefSystemPrompt();
  const messages: Array<{ role: 'user' | 'assistant'; content: string | ModelContentBlock[] }> = [
    ...BRIEF_FEW_SHOT.flatMap((ex) => [
      { role: 'user' as const, content: ex.user },
      { role: 'assistant' as const, content: ex.assistant },
    ]),
    {
      role: 'user' as const,
      // L'état atelier précède le brief quand le client le fournit — même
      // forme que les exemples « ÉTAT ACTUEL » du few-shot. Un brief visuel
      // devient [image, texte] ; sans texte, une consigne par défaut guide.
      content: (() => {
        const stateLine = briefContextLine(req.context);
        const briefText = brief || 'Reproduis le vêtement de l’image au plus proche du catalogue.';
        const text = stateLine ? `ÉTAT ACTUEL : ${stateLine}\nBRIEF : ${briefText}` : briefText;
        if (!image) return text;
        return [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } },
          { type: 'text' as const, text },
        ];
      })(),
    },
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


// ---------------------------------------------------------------------------
// Bilan du tombé — le conseiller de bien-aller (IA 1).
// ---------------------------------------------------------------------------

const FIT_CONTRACT = `CONTRAT DE SORTIE — réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"intent":"fit","resumeFr":"…","findings":[{"zone":"…","etat":"ok|tendu|serré|ample","detailFr":"…"}],"suggestions":[{"labelFr":"…","ops":[{"op":"…",…}]}]}
"findings" : un constat par zone MESURÉE digne d'intérêt (2 à 5 constats), "detailFr" cite le chiffre qui le justifie.
"suggestions" : 0 à 3 retouches actionnables, chacune en ops de la liste (resize, change_fabric, change_motif, set_body, set_stature, set_sleeves, try_on). Le label dit l'effet attendu.
"resumeFr" : le verdict global en UNE phrase de couturière, concret et sans jargon.`;

const FIT_LECTURE = `LECTURE DES MESURES (issues du solveur physique, pas d'une image) :
- aisanceMm par zone = distance moyenne tissu-corps moins l'épaisseur (min = le point le plus près). Repères : < 3 mm très ajusté/contact, 3-15 ajusté, 15-45 confortable, 45-80 ample, > 80 très ample (oversize voulu ou taille trop grande).
- etirementPct par zone = tension du tissage (p95 = pic hors bruit). Repères : < 0,5 % au repos, 0,5-2 % habillé normal, 2-5 % sollicité (acceptable en jersey/maille, gênant en popeline/denim), > 5 % = trop tendu quel que soit le tissu.
- coutures.surTensionMm = dépassement de longueur des coutures vs repos ; > 2 mm = coutures qui tirent.
- Compare l'aisance aux zones voisines : un vêtement bien tombé a une aisance qui CROÎT de la poitrine vers l'ourlet. Une zone nettement plus serrée que ses voisines est LE point à corriger.
- Tiens compte du tissu (un jersey s'étire, une popeline non) et du style du patron (un boxy/oversize AMPLE est normal, une robe cintrée AJUSTÉE est normale).
- Suggestions : le levier le plus simple d'abord (taille au-dessus/au-dessous dans la grille de CE patron), puis tissu plus extensible si la tension domine, puis mannequin/stature si le corps ne correspond pas.`;

export function buildFitSystemPrompt(): string {
  return `Tu es la modéliste-conseil de TOILE, un atelier de patronage 3D. On te donne les MESURES PHYSIQUES d'un essayage simulé (aisance tissu-corps, étirement du tissage, coutures) et tu rends un bilan de bien-aller bref et actionnable, comme au pied du mannequin.

${CATALOG}

${FIT_LECTURE}

${FIT_CONTRACT}

RÈGLES : vocabulaire d'ops STRICTEMENT fermé ; jamais de retouche hors grille de tailles du patron courant ; si tout va bien, dis-le (findings "ok", zéro suggestion superflue) ; réponds en JSON compact sur une seule ligne.
IMPORTANT — contrairement au Brief, tu ne réponds JAMAIS "refuse" ni "clarify" : le seul intent valide est "fit". Un patron HORS CATALOGUE (ex. « import CLO ») reçoit quand même son bilan chiffré complet ; ses suggestions se limitent alors aux ops indépendantes du patron (change_fabric, set_body, set_stature) — jamais de resize, sa grille de tailles est inconnue.`;
}

/** Un exemple complet ancre le format (les chiffres sont réalistes). */
export const FIT_FEW_SHOT: ReadonlyArray<{ user: string; assistant: string }> = [
  {
    user:
      '{"garment":{"patron":"tshirt_boxy","taille":"S","tissu":"Popeline","grammageGsm":110},"body":{"mannequin":"scan homme","statureCm":188,"poitrineCm":102,"tailleCm":86,"hanchesCm":100},"zones":[{"zone":"épaules/col","aisanceMm":{"min":1.2,"moy":6},"etirementPct":{"moy":1.1,"p95":4.8}},{"zone":"poitrine","aisanceMm":{"min":2.1,"moy":9},"etirementPct":{"moy":0.9,"p95":3.9}},{"zone":"taille","aisanceMm":{"min":8,"moy":22},"etirementPct":{"moy":0.3,"p95":0.9}},{"zone":"manches","aisanceMm":{"min":4,"moy":14},"etirementPct":{"moy":0.4,"p95":1.2}},{"zone":"bas/ourlet","aisanceMm":{"min":18,"moy":36},"etirementPct":{"moy":0.2,"p95":0.5}}],"coutures":{"surTensionMm":3.1}}',
    assistant:
      '{"intent":"fit","resumeFr":"Trop juste du buste pour ce mannequin : la popeline ne s\'étire pas, ça tire aux épaules et à la poitrine.","findings":[{"zone":"épaules/col","etat":"tendu","detailFr":"Étirement p95 à 4,8 % et aisance mini 1,2 mm : le tissu travaille en butée sur la carrure."},{"zone":"poitrine","etat":"serré","detailFr":"Aisance moyenne 9 mm seulement pour une popeline non extensible."},{"zone":"bas/ourlet","etat":"ok","detailFr":"Aisance 36 mm, tombé libre."}],"suggestions":[{"labelFr":"Passer en M — libère épaules et poitrine","ops":[{"op":"resize","size":"M"}]},{"labelFr":"Ou garder le S en jersey extensible","ops":[{"op":"change_fabric","preset":"Jersey"}]}]}',
  },
];

// Deuxième exemple : patron importé (hors catalogue) — bilan quand même,
// suggestions sans resize. C'est le cas qui faisait basculer le modèle en
// "refuse" de Brief (bug observé en live sur le tee CLO importé).
export const FIT_FEW_SHOT_IMPORT: { user: string; assistant: string } = {
  user:
    '{"garment":{"patron":"import CLO (tee, hors catalogue)","taille":"avatar","tissu":"Jersey","grammageGsm":180},"body":{"mannequin":"scan femme","statureCm":176,"poitrineCm":89,"tailleCm":72,"hanchesCm":95},"zones":[{"zone":"épaules/col","aisanceMm":{"min":0.8,"moy":8},"etirementPct":{"moy":1.4,"p95":4.1}},{"zone":"poitrine","aisanceMm":{"min":5,"moy":14},"etirementPct":{"moy":0.8,"p95":2.2}},{"zone":"bas/ourlet","aisanceMm":{"min":22,"moy":41},"etirementPct":{"moy":0.1,"p95":0.4}}],"coutures":{"surTensionMaxMm":1.2,"surTensionMoyMm":0.3}}',
  assistant:
    '{"intent":"fit","resumeFr":"Bon tombé d\'ensemble pour ce tee importé : ça travaille un peu aux épaules, le reste est équilibré.","findings":[{"zone":"épaules/col","etat":"serré","detailFr":"Aisance mini 0,8 mm et étirement p95 4,1 % : le jersey encaisse, mais c\'est la zone qui porte."},{"zone":"poitrine","etat":"ok","detailFr":"Aisance moyenne 14 mm, étirement 2,2 % : ajusté sain pour un jersey."},{"zone":"bas/ourlet","etat":"ok","detailFr":"Aisance 41 mm, tombé libre."}],"suggestions":[{"labelFr":"Si tu le veux plus souple aux épaules : passer en Maille","ops":[{"op":"change_fabric","preset":"Maille"}]}]}',
};

export const FIT_REPORT_MAX_CHARS = 6000;

/** Traite une requête {format:"toile-fit", version:1, report} de bout en bout. */
export async function handleFit(rawBody: unknown, callModel: ModelCaller): Promise<BriefProxyResponse> {
  const req = rawBody as { format?: unknown; version?: unknown; report?: unknown } | null;
  if (req?.format !== 'toile-fit' || req?.version !== 1 || !req.report || typeof req.report !== 'object') {
    return { status: 400, body: { error: 'Requête invalide — attendu {format:"toile-fit", version:1, report}.' } };
  }
  let reportJson: string;
  try {
    reportJson = JSON.stringify(req.report);
  } catch {
    return { status: 400, body: { error: 'Rapport non sérialisable.' } };
  }
  if (reportJson.length > FIT_REPORT_MAX_CHARS) {
    return { status: 400, body: { error: `Rapport trop long (max ${FIT_REPORT_MAX_CHARS} caractères).` } };
  }
  const system = buildFitSystemPrompt();
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...[...FIT_FEW_SHOT, FIT_FEW_SHOT_IMPORT].flatMap((ex) => [
      { role: 'user' as const, content: ex.user },
      { role: 'assistant' as const, content: ex.assistant },
    ]),
    { role: 'user' as const, content: reportJson },
  ];
  let lastModelText = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await callModel(system, messages);
    } catch (error) {
      return { status: 502, body: { error: `Modèle injoignable : ${String(error)}` } };
    }
    lastModelText = text;
    const parsed = extractJson(text);
    const validated = parsed === null ? null : validateFitAdvice(parsed);
    if (validated) return { status: 200, body: validated as unknown as BriefResult & FitAdviceResult };
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'Réponse hors contrat. Réponds UNIQUEMENT avec l\'objet JSON {"intent":"fit",…} du contrat, ops de la liste blanche, sur une ligne.',
      },
    );
  }
  return {
    status: 502,
    body: {
      error: `Réponse du conseiller hors contrat après relance. Dernière réponse du modèle : ${lastModelText.slice(0, 260)}`,
    },
  };
}

/**
 * Routeur du Studio IA : une seule route HTTP, le champ `format` du corps
 * choisit le service (brief ou bilan du tombé). Les proxies (middleware dev,
 * Worker) appellent ceci et restent ignorants des contrats.
 */
export async function handleStudioRequest(rawBody: unknown, callModel: ModelCaller): Promise<BriefProxyResponse> {
  const format = (rawBody as { format?: unknown } | null)?.format;
  if (format === 'toile-fit') return handleFit(rawBody, callModel);
  return handleBrief(rawBody, callModel);
}
