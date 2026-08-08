/**
 * Exécuteur du Brief : applique un `BriefResult` validé à l'atelier.
 *
 * L'exécuteur ne touche jamais le moteur : il passe par des hooks injectés qui
 * empruntent les MÊMES chemins que les gestes utilisateur (les boutons et
 * sélecteurs de l'atelier). Un brief ne peut donc rien faire qu'une main ne
 * pourrait pas faire — et tout ce qu'il fait reste annulable par Cmd/Ctrl+Z.
 */

import type { BriefResult } from './BriefContract';

export interface BriefHooks {
  /** Charge un template (clic sur at-tshirt / at-pants / at-hoodie / at-jupe / at-robe). */
  loadArchetype(archetype: 'tshirt_boxy' | 'pantalon' | 'hoodie_zip' | 'jupe' | 'robe'): boolean;
  /** Ne pose la valeur que si l'option existe réellement dans le sélecteur. */
  setSize(size: string): boolean;
  setFabric(preset: string): boolean;
  setMotif(motif: string): boolean;
  setBody(kind: 'scan femme' | 'scan homme'): boolean;
  setStature(cm: number): boolean;
  setSleeves(on: boolean): boolean;
  /** Lance l'essayage 3D (clic sur at-sim). */
  tryOn(): boolean;
  /** Feedback utilisateur (toast + ligne de statut du Brief). */
  say(message: string, ok: boolean): void;
}

export interface BriefExecution {
  ok: boolean;
  applied: string[];
  notes: string[];
}

const note = (notes: string[], msg: string): void => {
  if (!notes.includes(msg)) notes.push(msg);
};

export function executeBrief(result: BriefResult, hooks: BriefHooks): BriefExecution {
  const applied: string[] = [];
  const notes: string[] = [];

  if (result.intent !== 'create' && result.intent !== 'modify') {
    const suffix = result.suggestionFr ? ` ${result.suggestionFr}` : '';
    hooks.say(`${result.resumeFr}${suffix}`, false);
    return { ok: false, applied, notes };
  }

  if (result.intent === 'create') {
    // Le corps d'abord : les templates se gradent sur les mensurations
    // courantes, donc mannequin et stature doivent précéder le chargement.
    if (result.body?.kind) {
      if (hooks.setBody(result.body.kind)) applied.push(`mannequin ${result.body.kind}`);
      else note(notes, 'mannequin inchangé (sélecteur indisponible)');
    }
    if (result.body?.statureCm !== undefined) {
      if (hooks.setStature(result.body.statureCm)) applied.push(`stature ${result.body.statureCm} cm`);
      else note(notes, 'stature inchangée');
    }
    if (!hooks.loadArchetype(result.garment.archetype)) {
      hooks.say('Impossible de charger ce patron (atelier indisponible).', false);
      return { ok: false, applied, notes };
    }
    applied.push(`patron ${result.garment.archetype}`);
    if (result.garment.size) {
      if (hooks.setSize(result.garment.size)) applied.push(`taille ${result.garment.size}`);
      else note(notes, `taille « ${result.garment.size} » absente de ce patron — taille par défaut conservée`);
    }
    if (result.fabric) {
      if (hooks.setFabric(result.fabric)) applied.push(`tissu ${result.fabric}`);
      else note(notes, 'tissu inchangé (préréglage indisponible)');
    }
    if (result.motif) {
      if (hooks.setMotif(result.motif)) applied.push(`motif ${result.motif}`);
      else note(notes, 'motif indisponible ici');
    }
    if (result.sleeves !== undefined) {
      if (hooks.setSleeves(result.sleeves)) applied.push(result.sleeves ? 'manches auto' : 'sans manches');
      else note(notes, 'manches automatiques indisponibles sur ce patron');
    }
    if (result.tryOn) {
      if (hooks.tryOn()) applied.push('essayage 3D');
      else note(notes, 'essayage non lancé');
    }
    const summary = notes.length ? `${result.resumeFr} · ${notes.join(' · ')}` : result.resumeFr;
    hooks.say(summary, true);
    return { ok: true, applied, notes };
  }

  // modify — retouches du vêtement courant, dans l'ordre du brief.
  let wantsTryOn = result.tryOn;
  for (const op of result.ops) {
    switch (op.op) {
      case 'resize':
        if (hooks.setSize(op.size)) applied.push(`taille ${op.size}`);
        else note(notes, `taille « ${op.size} » absente du patron courant`);
        break;
      case 'change_fabric':
        if (hooks.setFabric(op.preset)) applied.push(`tissu ${op.preset}`);
        else note(notes, 'tissu inchangé');
        break;
      case 'change_motif':
        if (hooks.setMotif(op.motif)) applied.push(`motif ${op.motif}`);
        else note(notes, 'motif indisponible');
        break;
      case 'set_body':
        if (hooks.setBody(op.kind)) applied.push(`mannequin ${op.kind}`);
        else note(notes, 'mannequin inchangé');
        break;
      case 'set_stature':
        if (hooks.setStature(op.statureCm)) applied.push(`stature ${op.statureCm} cm`);
        else note(notes, 'stature inchangée');
        break;
      case 'set_sleeves':
        if (hooks.setSleeves(op.on)) applied.push(op.on ? 'manches auto' : 'sans manches');
        else note(notes, 'manches automatiques indisponibles');
        break;
      case 'try_on':
        wantsTryOn = true;
        break;
    }
  }
  if (wantsTryOn) {
    if (hooks.tryOn()) applied.push('essayage 3D');
    else note(notes, 'essayage non lancé');
  }
  const ok = applied.length > 0;
  const base = ok ? `Retouches : ${applied.join(', ')}.` : 'Aucune retouche applicable.';
  const summary = notes.length ? `${base} · ${notes.join(' · ')}` : base;
  hooks.say(summary, ok);
  return { ok, applied, notes };
}
