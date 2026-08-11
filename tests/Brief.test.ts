import { describe, expect, it } from 'vitest';
import {
  BRIEF_ENDPOINT_STORAGE_KEY,
  RemoteBackend,
  RulesBackend,
  selectBriefBackend,
} from '../src/app/brief/BriefBackend';
import {
  clampStature,
  validateBriefResult,
  type BriefResult,
} from '../src/app/brief/BriefContract';
import { executeBrief, type BriefHooks } from '../src/app/brief/BriefExecutor';
import { interpretBrief, normalizeBrief } from '../src/app/brief/BriefRules';

/* ------------------------------------------------------------------ */
/* Règles — le vocabulaire français du Brief                           */
/* ------------------------------------------------------------------ */

describe('interpretBrief (règles françaises)', () => {
  it('comprend un brief complet : archétype, tissu, motif, taille', () => {
    const r = interpretBrief('Un t-shirt boxy en popeline rayée, taille M');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('tshirt_boxy');
    expect(r.garment.size).toBe('M');
    expect(r.fabric).toBe('Popeline');
    expect(r.motif).toBe('rayures');
    expect(r.tryOn).toBe(true);
  });

  it('comprend le hoodie en maille, taille L, mannequin homme', () => {
    const r = interpretBrief('hoodie en maille taille L pour mannequin homme');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('hoodie_zip');
    expect(r.garment.size).toBe('L');
    expect(r.fabric).toBe('Maille');
    expect(r.body?.kind).toBe('scan homme');
  });

  it('reconnaît Jericho comme le mannequin homme de 1,83 m', () => {
    const r = interpretBrief('hoodie taille M sur Jericho 1m83');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.body?.kind).toBe('scan homme');
    expect(r.body?.statureCm).toBe(183);
  });

  it('reconnaît le nouveau libellé mannequin neutre', () => {
    const r = interpretBrief('t-shirt taille M sur le mannequin neutre 1m83');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.body?.kind).toBe('scan homme');
    expect(r.body?.statureCm).toBe(183);
  });

  it('comprend le pantalon en taille EU numérique', () => {
    const r = interpretBrief('pantalon large en laine, taille 42');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('pantalon');
    expect(r.garment.size).toBe('42');
    expect(r.fabric).toBe('Laine');
  });

  it('reconnaît l’ajustement au mannequin du hoodie', () => {
    const r = interpretBrief('un hoodie ajusté au mannequin, en jersey');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.size).toBe('avatar');
  });

  it('lit la stature en mètres et l’applique bornée', () => {
    const r = interpretBrief('t-shirt taille S sur un mannequin homme de 1m95');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.body?.statureCm).toBe(195);
    expect(r.garment.size).toBe('S');
  });

  it('comprend la robe en taille EU (v194 — la robe n’est plus un refus)', () => {
    const r = interpretBrief('une robe cintrée en lin, taille 40');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('robe');
    expect(r.garment.size).toBe('40');
    expect(r.fabric).toBe('Lin');
  });

  it('comprend la robe sans taille explicite et garde la taille optionnelle', () => {
    const r = interpretBrief('une robe midi évasée en jersey');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('robe');
    expect(r.garment.size).toBeUndefined();
    expect(r.fabric).toBe('Jersey');
  });

  it('coupe la robe aux mensurations sur « sur mesure »', () => {
    const r = interpretBrief('une robe sur mesure pour ma cliente');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('robe');
    expect(r.garment.size).toBe('avatar');
  });

  it('comprend la veste doublée en taille lettre (v196 — la veste n’est plus un refus)', () => {
    const r = interpretBrief('une veste doublée en laine, taille L');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('veste');
    expect(r.garment.size).toBe('L');
    expect(r.fabric).toBe('Laine');
  });

  it('coupe la veste au mannequin sur « sur mesure », et comprend « blouson »', () => {
    const r = interpretBrief('un blouson sur mesure en denim');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('veste');
    expect(r.garment.size).toBe('avatar');
    expect(r.fabric).toBe('Denim');
  });

  it('comprend la doudoune en taille lettre (v199)', () => {
    const r = interpretBrief('une doudoune bien chaude, taille M');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.garment.archetype).toBe('doudoune');
    expect(r.garment.size).toBe('M');
  });

  it('refuse encore le manteau long, en pointant vers la veste doublée', () => {
    const r = interpretBrief('un manteau long en laine pour l’hiver');
    expect(r.intent).toBe('refuse');
    if (r.intent !== 'refuse') return;
    expect(r.suggestionFr).toContain('veste zippée doublée');
  });

  it('refuse proprement la couture avancée MÊME portée par une robe (corset, traîne)', () => {
    const r = interpretBrief('une robe de bal avec corset baleiné et traîne de 2 mètres');
    expect(r.intent).toBe('refuse');
    if (r.intent !== 'refuse') return;
    expect(r.suggestionFr).toBeTruthy();
    expect(r.suggestionFr).toContain('robe cintrée'); // le refus montre le chemin constructible
  });

  it('refuse la chemise même avec un tissu connu', () => {
    const r = interpretBrief('chemise en lin pour homme');
    expect(r.intent).toBe('refuse');
  });

  it('transforme « passe-le en denim et essaie » en retouches', () => {
    const r = interpretBrief('passe-le en denim et essaie');
    expect(r.intent).toBe('modify');
    if (r.intent !== 'modify') return;
    expect(r.ops).toContainEqual({ op: 'change_fabric', preset: 'Denim' });
    expect(r.ops).toContainEqual({ op: 'try_on' });
    expect(r.tryOn).toBe(true);
  });

  it('combine taille, mannequin et stature en retouches', () => {
    const r = interpretBrief('mets-le en taille XL sur mannequin homme de 185 cm');
    expect(r.intent).toBe('modify');
    if (r.intent !== 'modify') return;
    expect(r.ops).toContainEqual({ op: 'resize', size: 'XL' });
    expect(r.ops).toContainEqual({ op: 'set_body', kind: 'scan homme' });
    expect(r.ops).toContainEqual({ op: 'set_stature', statureCm: 185 });
  });

  it('renvoie la retouche de longueur vers l’outil manuel', () => {
    const r = interpretBrief('allonge-le de 10 cm');
    expect(r.intent).toBe('clarify');
    if (r.intent !== 'clarify') return;
    expect(r.suggestionFr).toContain('Longueur');
  });

  it('demande une précision sur un brief vide ou une salutation', () => {
    expect(interpretBrief('').intent).toBe('clarify');
    expect(interpretBrief('salut !').intent).toBe('clarify');
  });

  it('liste les archétypes constructibles quand rien n’est reconnu', () => {
    const r = interpretBrief('quelque chose de stylé pour cet été');
    expect(r.intent).toBe('clarify');
    if (r.intent !== 'clarify') return;
    expect(r.suggestionFr).toContain('t-shirt');
  });

  it('respecte « sans essayage »', () => {
    const r = interpretBrief('t-shirt boxy en lin sans essayage');
    expect(r.intent).toBe('create');
    if (r.intent !== 'create') return;
    expect(r.tryOn).toBe(false);
  });

  it('normalise accents et espaces', () => {
    expect(normalizeBrief('  Évasée   RAYÉE ')).toBe('evasee rayee');
  });
});

/* ------------------------------------------------------------------ */
/* Contrat — validation & clamps                                       */
/* ------------------------------------------------------------------ */

describe('validateBriefResult (garde-fou du contrat)', () => {
  it('accepte un create minimal et applique les listes blanches', () => {
    const v = validateBriefResult({
      intent: 'create',
      garment: { archetype: 'tshirt_boxy', size: 'M' },
      fabric: 'Denim',
      motif: 'pois',
      tryOn: true,
      resumeFr: 'ok',
    });
    expect(v).not.toBeNull();
    expect(v!.intent).toBe('create');
  });

  it('rejette un archétype hors liste (et accepte la robe depuis v194)', () => {
    expect(
      validateBriefResult({ intent: 'create', garment: { archetype: 'cape' }, resumeFr: 'x' }),
    ).toBeNull();
    expect(
      validateBriefResult({ intent: 'create', garment: { archetype: 'robe' }, resumeFr: 'x' }),
    ).not.toBeNull();
  });

  it('ignore un tissu inconnu sans rejeter le reste', () => {
    const v = validateBriefResult({
      intent: 'create',
      garment: { archetype: 'pantalon' },
      fabric: 'Vantablack',
      resumeFr: 'x',
    });
    expect(v).not.toBeNull();
    if (v?.intent === 'create') expect(v.fabric).toBeUndefined();
  });

  it('borne la stature dans les limites du mannequin', () => {
    expect(clampStature(90)).toBe(140);
    expect(clampStature(300)).toBe(210);
    const v = validateBriefResult({
      intent: 'create',
      garment: { archetype: 'tshirt_boxy' },
      body: { statureCm: 300 },
      resumeFr: 'x',
    });
    if (v?.intent === 'create') expect(v.body?.statureCm).toBe(210);
  });

  it('rejette un modify sans op valide et filtre les ops inconnues', () => {
    expect(validateBriefResult({ intent: 'modify', ops: [], resumeFr: 'x' })).toBeNull();
    expect(
      validateBriefResult({ intent: 'modify', ops: [{ op: 'format_disk' }], resumeFr: 'x' }),
    ).toBeNull();
    const v = validateBriefResult({
      intent: 'modify',
      ops: [{ op: 'format_disk' }, { op: 'change_fabric', preset: 'Soie' }],
      resumeFr: 'x',
    });
    expect(v).not.toBeNull();
    if (v?.intent === 'modify') expect(v.ops).toHaveLength(1);
  });

  it('rejette les intents inconnus et les objets difformes', () => {
    expect(validateBriefResult(null)).toBeNull();
    expect(validateBriefResult({ intent: 'destroy' })).toBeNull();
    expect(validateBriefResult({ intent: 'clarify' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Exécuteur — hooks mockés                                            */
/* ------------------------------------------------------------------ */

interface HookLog {
  calls: string[];
  said: Array<{ message: string; ok: boolean }>;
}

function makeHooks(overrides: Partial<Record<keyof BriefHooks, boolean>> = {}): {
  hooks: BriefHooks;
  log: HookLog;
} {
  const log: HookLog = { calls: [], said: [] };
  const yes = (name: keyof BriefHooks) => overrides[name] !== false;
  const hooks: BriefHooks = {
    loadArchetype: (a) => (log.calls.push(`load:${a}`), yes('loadArchetype')),
    setSize: (s) => (log.calls.push(`size:${s}`), yes('setSize')),
    setFabric: (f) => (log.calls.push(`fabric:${f}`), yes('setFabric')),
    setMotif: (m) => (log.calls.push(`motif:${m}`), yes('setMotif')),
    setBody: (k) => (log.calls.push(`body:${k}`), yes('setBody')),
    setStature: (cm) => (log.calls.push(`stature:${cm}`), yes('setStature')),
    setSleeves: (on) => (log.calls.push(`sleeves:${on}`), yes('setSleeves')),
    tryOn: () => (log.calls.push('tryOn'), yes('tryOn')),
    say: (message, ok) => log.said.push({ message, ok }),
  };
  return { hooks, log };
}

describe('executeBrief (exécuteur à hooks)', () => {
  it('applique un create complet dans le bon ordre (corps avant patron)', () => {
    const { hooks, log } = makeHooks();
    const result: BriefResult = {
      intent: 'create',
      garment: { archetype: 'hoodie_zip', size: 'L' },
      fabric: 'Maille',
      body: { kind: 'scan homme', statureCm: 185 },
      tryOn: true,
      resumeFr: 'Brief compris.',
    };
    const out = executeBrief(result, hooks);
    expect(out.ok).toBe(true);
    expect(log.calls.indexOf('body:scan homme')).toBeLessThan(log.calls.indexOf('load:hoodie_zip'));
    expect(log.calls.indexOf('stature:185')).toBeLessThan(log.calls.indexOf('load:hoodie_zip'));
    expect(log.calls).toContain('size:L');
    expect(log.calls).toContain('fabric:Maille');
    expect(log.calls[log.calls.length - 1]).toBe('tryOn');
    expect(log.said[0]?.ok).toBe(true);
  });

  it('note une taille absente sans faire échouer le brief', () => {
    const { hooks, log } = makeHooks({ setSize: false });
    const out = executeBrief(
      {
        intent: 'create',
        garment: { archetype: 'tshirt_boxy', size: 'XXXL' },
        tryOn: false,
        resumeFr: 'ok',
      },
      hooks,
    );
    expect(out.ok).toBe(true);
    expect(out.notes.join(' ')).toContain('XXXL');
    expect(log.said[0]?.message).toContain('XXXL');
  });

  it('échoue proprement quand le patron ne peut pas se charger', () => {
    const { hooks, log } = makeHooks({ loadArchetype: false });
    const out = executeBrief(
      { intent: 'create', garment: { archetype: 'pantalon' }, tryOn: true, resumeFr: 'ok' },
      hooks,
    );
    expect(out.ok).toBe(false);
    expect(log.said[0]?.ok).toBe(false);
    expect(log.calls).not.toContain('tryOn');
  });

  it('relaie clarify/refuse sans exécuter la moindre action', () => {
    const { hooks, log } = makeHooks();
    const out = executeBrief(
      { intent: 'refuse', resumeFr: 'Pas de robe.', suggestionFr: 'Essaie le t-shirt.' },
      hooks,
    );
    expect(out.ok).toBe(false);
    expect(log.calls).toHaveLength(0);
    expect(log.said[0]?.message).toContain('Essaie le t-shirt.');
  });

  it('applique les retouches puis l’essayage demandé', () => {
    const { hooks, log } = makeHooks();
    const out = executeBrief(
      {
        intent: 'modify',
        ops: [
          { op: 'change_fabric', preset: 'Denim' },
          { op: 'try_on' },
        ],
        tryOn: false,
        resumeFr: 'retouches',
      },
      hooks,
    );
    expect(out.ok).toBe(true);
    expect(log.calls).toEqual(['fabric:Denim', 'tryOn']);
  });
});

/* ------------------------------------------------------------------ */
/* Backends — prise LLM et retombée locale                             */
/* ------------------------------------------------------------------ */

describe('backends du Brief', () => {
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('utilise la réponse distante quand elle respecte le contrat', async () => {
    const remote = new RemoteBackend(
      'https://exemple.test/brief',
      new RulesBackend(),
      async () =>
        okJson({
          intent: 'create',
          garment: { archetype: 'pantalon', size: '38' },
          tryOn: true,
          resumeFr: 'Pantalon 38 (distant).',
        }),
    );
    const r = await remote.interpret('peu importe');
    expect(r.intent).toBe('create');
    if (r.intent === 'create') expect(r.garment.size).toBe('38');
  });

  it('retombe sur les règles locales si la réponse sort du contrat', async () => {
    const remote = new RemoteBackend('https://exemple.test/brief', new RulesBackend(), async () =>
      okJson({ intent: 'create', garment: { archetype: 'robe de bal' }, resumeFr: 'x' }),
    );
    const r = await remote.interpret('hoodie en soie');
    expect(r.intent).toBe('create');
    if (r.intent === 'create') expect(r.garment.archetype).toBe('hoodie_zip');
  });

  it('retombe sur les règles locales sur erreur réseau', async () => {
    const remote = new RemoteBackend('https://exemple.test/brief', new RulesBackend(), async () => {
      throw new Error('offline');
    });
    const r = await remote.interpret('pantalon en denim');
    expect(r.intent).toBe('create');
  });

  it('le fetch PAR DÉFAUT survit à un fetch sensible au this (Illegal invocation, Chrome)', async () => {
    // Régression v192 : `fetchImpl = fetch` non lié → `this.fetchImpl(...)`
    // invoquait fetch avec this = l'instance → TypeError dans Chrome → repli
    // silencieux sur les règles à CHAQUE brief. On simule la sensibilité au
    // this du fetch navigateur, puis on vérifie que la réponse DISTANTE gagne.
    const original = globalThis.fetch;
    function strictFetch(this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      }
      return Promise.resolve(
        okJson({ intent: 'clarify', resumeFr: 'Réponse distante (fetch lié correctement).' }),
      );
    }
    globalThis.fetch = strictFetch as unknown as typeof fetch;
    try {
      const remote = new RemoteBackend('https://exemple.test/brief'); // fetchImpl PAR DÉFAUT
      const r = await remote.interpret('hoodie en maille');
      // Avant le correctif : Illegal invocation → règles locales (intent create).
      expect(r.intent).toBe('clarify');
      expect(r.resumeFr).toContain('distante');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('choisit le backend selon l’endpoint configuré', () => {
    expect(selectBriefBackend(null).label).toBe('règles locales');
    expect(selectBriefBackend({ getItem: () => null }).label).toBe('règles locales');
    expect(selectBriefBackend({ getItem: () => 'pas-une-url' }).label).toBe('règles locales');
    expect(
      selectBriefBackend({
        getItem: (k) => (k === BRIEF_ENDPOINT_STORAGE_KEY ? 'https://mon-proxy.fr/brief' : null),
      }).label,
    ).toBe('assistant distant');
  });
});
