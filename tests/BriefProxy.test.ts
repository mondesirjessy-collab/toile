import { describe, expect, it, vi } from 'vitest';
import {
  BRIEF_FEW_SHOT,
  BRIEF_HISTORY_MAX,
  BRIEF_HISTORY_REPONSE_MAX,
  BRIEF_MAX_CHARS,
  briefHistoryTurns,
  buildBriefSystemPrompt,
  extractJson,
  handleBrief,
  type ModelCaller,
} from '../server/brief-core';
import { BRIEF_ARCHETYPES, BRIEF_FABRICS, validateBriefResult } from '../src/app/brief/BriefContract';

const req = (brief: string) => ({ format: 'toile-brief', version: 1, brief });

describe('proxy Brief→LLM (v191)', () => {
  it('le system prompt expose tout le catalogue réel', () => {
    const system = buildBriefSystemPrompt();
    for (const archetype of BRIEF_ARCHETYPES) expect(system).toContain(`"${archetype}"`);
    for (const fabric of BRIEF_FABRICS) expect(system).toContain(fabric);
    expect(system).toContain('scan femme');
    expect(system).toContain('refuse');
    expect(system).toContain('UNIQUEMENT');
  });

  it('chaque exemple few-shot VALIDE le contrat (les exemples enseignent le vrai vocabulaire)', () => {
    expect(BRIEF_FEW_SHOT.length).toBeGreaterThanOrEqual(8);
    for (const example of BRIEF_FEW_SHOT) {
      const parsed = extractJson(example.assistant);
      expect(parsed, example.user).not.toBeNull();
      expect(validateBriefResult(parsed), example.user).not.toBeNull();
    }
  });

  it('extrait le JSON même entouré de balises de code ou de texte', () => {
    expect(extractJson('```json\n{"intent":"clarify","resumeFr":"?"}\n```')).toEqual({
      intent: 'clarify',
      resumeFr: '?',
    });
    expect(extractJson('Voici : {"a":1} merci')).toEqual({ a: 1 });
    expect(extractJson('pas de json ici')).toBeNull();
  });

  it('refuse une requête hors format ou un brief trop long', async () => {
    const never: ModelCaller = vi.fn();
    expect((await handleBrief({ nope: true }, never)).status).toBe(400);
    expect((await handleBrief({ format: 'toile-brief', version: 2, brief: 'x' }, never)).status).toBe(400);
    expect((await handleBrief(req('x'.repeat(BRIEF_MAX_CHARS + 1)), never)).status).toBe(400);
    expect(never).not.toHaveBeenCalled();
  });

  it('réponse valide du modèle → 200 avec le BriefResult validé', async () => {
    const model: ModelCaller = vi.fn(async () =>
      '{"intent":"create","garment":{"archetype":"tshirt_boxy","size":"M"},"fabric":"Popeline","tryOn":true,"resumeFr":"ok"}');
    const out = await handleBrief(req('t-shirt en popeline taille M'), model);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ intent: 'create', garment: { archetype: 'tshirt_boxy', size: 'M' } });
    expect(model).toHaveBeenCalledTimes(1);
    // Le few-shot précède le brief dans les messages.
    const messages = (model as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(BRIEF_FEW_SHOT.length * 2 + 1);
    expect(messages.at(-1)!.content).toBe('t-shirt en popeline taille M');
  });

  it('le Studio se souvient (v295) : l’historique rejoué en tours, borné et assaini', async () => {
    // briefHistoryTurns : bornes et assainissement.
    expect(briefHistoryTurns(undefined)).toEqual([]);
    expect(briefHistoryTurns('pas un tableau')).toEqual([]);
    const turns = briefHistoryTurns([
      { brief: 'une robe', reponse: '{"intent":"create"}' },
      { brief: '', reponse: 'jamais' }, // brief vide : écarté
      { brief: 'trop long '.repeat(200), reponse: 'r'.repeat(5000) }, // tronqué
    ]);
    expect(turns).toHaveLength(4);
    expect(turns[0]).toEqual({ role: 'user', content: 'une robe' });
    expect(turns[1]).toEqual({ role: 'assistant', content: '{"intent":"create"}' });
    expect((turns[2]!.content as string).length).toBe(BRIEF_MAX_CHARS);
    expect((turns[3]!.content as string).length).toBe(BRIEF_HISTORY_REPONSE_MAX);
    // Seuls les BRIEF_HISTORY_MAX derniers échanges sont gardés.
    const many = briefHistoryTurns(
      Array.from({ length: 9 }, (_, i) => ({ brief: `b${i}`, reponse: `r${i}` })),
    );
    expect(many).toHaveLength(BRIEF_HISTORY_MAX * 2);
    expect(many[0]!.content).toBe(`b${9 - BRIEF_HISTORY_MAX}`);
    // handleBrief : l'historique s'insère entre le few-shot et le brief courant.
    const model: ModelCaller = vi.fn(async () => '{"intent":"clarify","resumeFr":"?"}');
    await handleBrief(
      { ...req('d’accord, fais ça'), history: [{ brief: 'une jupe ?', reponse: '{"intent":"clarify","resumeFr":"Quelle jupe ?"}' }] },
      model,
    );
    const messages = (model as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(BRIEF_FEW_SHOT.length * 2 + 2 + 1);
    expect(messages.at(-3)!).toEqual({ role: 'user', content: 'une jupe ?' });
    expect(messages.at(-2)!.role).toBe('assistant');
    expect(messages.at(-1)!.content).toBe('d’accord, fais ça');
    // Le system prompt enseigne la mémoire de session.
    expect(buildBriefSystemPrompt()).toContain('MÉMOIRE DE SESSION');
  });

  it('réponse hors contrat → UNE relance avec l’erreur, puis 200 si corrigée', async () => {
    const model = vi
      .fn<Parameters<ModelCaller>, ReturnType<ModelCaller>>()
      .mockResolvedValueOnce('{"intent":"create","garment":{"archetype":"cape_de_bal"},"resumeFr":"?"}')
      .mockResolvedValueOnce('{"intent":"refuse","resumeFr":"Pas de cape.","suggestionFr":"Hoodie zippé."}');
    const out = await handleBrief(req('une cape de bal'), model);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ intent: 'refuse' });
    expect(model).toHaveBeenCalledTimes(2);
    const retryMessages = model.mock.calls[1]![1] as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)!.content).toContain('liste blanche');
  });

  it('toujours hors contrat après relance → 502 (le client retombe sur les règles)', async () => {
    const model: ModelCaller = vi.fn(async () => 'je ne peux pas répondre en JSON');
    const out = await handleBrief(req('hoodie'), model);
    expect(out.status).toBe(502);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('modèle injoignable → 502 propre', async () => {
    const model: ModelCaller = vi.fn(async () => {
      throw new Error('réseau coupé');
    });
    const out = await handleBrief(req('hoodie'), model);
    expect(out.status).toBe(502);
    expect((out.body as { error: string }).error).toContain('réseau coupé');
  });
});
