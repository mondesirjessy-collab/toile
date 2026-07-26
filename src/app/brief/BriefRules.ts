/**
 * Interpréteur de briefs — moteur à règles, français d'abord.
 *
 * Déterministe, instantané, hors-ligne : c'est le moteur de la démo. Le même
 * contrat (`BriefResult`) est produit par le backend distant optionnel, si bien
 * qu'un LLM peut remplacer ces règles sans toucher ni à l'exécuteur ni à l'UI.
 */

import {
  BRIEF_BOXY_SIZES,
  BRIEF_HOODIE_SIZES,
  BRIEF_PANTS_SIZES,
  clampStature,
  type BriefArchetype,
  type BriefBodyKind,
  type BriefFabric,
  type BriefMotif,
  type BriefOp,
  type BriefResult,
} from './BriefContract';

/** Minuscules + accents retirés : les règles matchent « évasée » comme « evasee ». */
export function normalizeBrief(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FabricRule {
  pattern: RegExp;
  preset: BriefFabric;
}

const FABRIC_RULES: FabricRule[] = [
  { pattern: /\bjersey\b/, preset: 'Jersey' },
  { pattern: /\bmaille\b|\btricot\b/, preset: 'Maille' },
  { pattern: /\bpopeline\b|\bcoton chemise\b/, preset: 'Popeline' },
  { pattern: /\bdenim\b|\bjeans?\b/, preset: 'Denim' },
  { pattern: /\blin\b/, preset: 'Lin' },
  { pattern: /\blaine\b|\bwool\b/, preset: 'Laine' },
  { pattern: /\bsoie\b|\bsilk\b/, preset: 'Soie' },
];

const MOTIF_RULES: Array<{ pattern: RegExp; motif: BriefMotif }> = [
  { pattern: /\braye(e|es)?\b|\brayures?\b/, motif: 'rayures' },
  { pattern: /\bvichy\b|\bcarreaux\b/, motif: 'vichy' },
  { pattern: /\bpois\b|\ba pois\b/, motif: 'pois' },
  { pattern: /\buni(e|es)?\b/, motif: 'uni' },
];

/** Vêtements que l'atelier ne sait pas encore patronner → refus + alternative. */
const UNSUPPORTED_GARMENTS: Array<{ pattern: RegExp; nameFr: string; suggestionFr: string }> = [
  {
    pattern: /\brobes?\b/,
    nameFr: 'robe',
    suggestionFr:
      'Le plus proche aujourd’hui : un t-shirt BOXY allongé — charge « T-shirt », puis étire l’ourlet avec l’outil Longueur.',
  },
  {
    pattern: /\bjupes?\b/,
    nameFr: 'jupe',
    suggestionFr:
      'En attendant : trace-la avec « Nouvelle pièce » (deux rectangles cousus), ou pars du pantalon large.',
  },
  {
    pattern: /\bchemises?\b|\bchemisiers?\b/,
    nameFr: 'chemise',
    suggestionFr: 'Le plus proche : le t-shirt BOXY en popeline.',
  },
  {
    pattern: /\bvestes?\b|\bmanteaux?\b|\bblousons?\b|\bparkas?\b/,
    nameFr: 'veste/manteau',
    suggestionFr: 'Le plus proche aujourd’hui : le Hoodie zippé (7 pièces, fermeture séparable).',
  },
  {
    pattern: /\bcorsets?\b|\btraines?\b|\bbaleine(e|es)?\b|\bcrinolines?\b|\bsmokings?\b|\bdentelles?\b/,
    nameFr: 'pièce de couture avancée',
    suggestionFr:
      'Corset baleiné, traîne ou dentelle demandent des techniques que TOILE ne simule pas encore. Constructible aujourd’hui : t-shirt, pantalon large, hoodie zippé — et toute pièce tracée à la main.',
  },
];

interface ArchetypeMatch {
  archetype: BriefArchetype;
  labelFr: string;
}

function detectArchetype(t: string): ArchetypeMatch | null {
  if (/\bhoodies?\b|\bhoody\b|sweat(shirt)?s? (a|à) capuche|sweat zipp|capuches?\b/.test(t)) {
    return { archetype: 'hoodie_zip', labelFr: 'hoodie zippé' };
  }
  if (/\bpantalons?\b|\bpants\b|\bjoggers?\b/.test(t)) {
    return { archetype: 'pantalon', labelFr: 'pantalon large' };
  }
  if (/\bt[- ]?shirts?\b|\btee[- ]?shirts?\b|\btees?\b|\bboxy\b|\bhauts?\b/.test(t)) {
    return { archetype: 'tshirt_boxy', labelFr: 't-shirt boxy' };
  }
  return null;
}

function detectFabric(t: string): BriefFabric | undefined {
  for (const rule of FABRIC_RULES) if (rule.pattern.test(t)) return rule.preset;
  return undefined;
}

function detectMotif(t: string): BriefMotif | undefined {
  for (const rule of MOTIF_RULES) if (rule.pattern.test(t)) return rule.motif;
  return undefined;
}

function detectBodyKind(t: string): BriefBodyKind | undefined {
  if (/\bhommes?\b|\bmasculins?\b|\bmec\b/.test(t)) return 'scan homme';
  if (/\bfemmes?\b|\bfeminin(e|es)?\b|\bmeuf\b/.test(t)) return 'scan femme';
  return undefined;
}

function detectStature(t: string): number | undefined {
  // « 1m85 » / « 1,85 m » / « 1.85m »
  const meters = t.match(/\b1[m,.](\d{2})\s?m?\b/);
  if (meters) return clampStature(100 + Number(meters[1]));
  // « 185 cm » / « de 185 » borné aux statures plausibles pour éviter les faux positifs.
  const cm = t.match(/\b(1[4-9]\d|2[0-1]\d)\s?cm\b/) ?? t.match(/\bde (1[4-9]\d|2[0-1]\d)\b/);
  if (cm) return clampStature(Number(cm[1]));
  return undefined;
}

function detectSize(t: string, archetype: BriefArchetype | null): string | undefined {
  if (archetype === 'pantalon') {
    const eu = t.match(/\b(?:taille|eu)\s?(2[68]|3[02468]|4[0246]|26|46)\b/)?.[1];
    if (eu && (BRIEF_PANTS_SIZES as readonly string[]).includes(eu)) return eu;
    return undefined;
  }
  if (archetype === 'hoodie_zip' && /ajust(e|ee)? au mannequin|sur[- ]mesure|a mes mesures/.test(t)) {
    return 'avatar';
  }
  // XS/XL/XXL/XXXL sont sans ambiguïté ; S, M, L exigent le mot « taille »
  // (sinon « en l », « à s » dans une phrase produiraient des faux positifs).
  const explicit = t.match(/\btaille\s+(xxxl|xxl|xl|xs|s|m|l)\b/);
  const loose = explicit ?? t.match(/\ben\s+(xxxl|xxl|xl|xs)\b/) ?? t.match(/\b(xxxl|xxl|xl|xs)\b/);
  const raw = loose?.[1]?.toUpperCase();
  if (!raw) return undefined;
  const pool = archetype === 'hoodie_zip' ? BRIEF_HOODIE_SIZES : BRIEF_BOXY_SIZES;
  return (pool as readonly string[]).includes(raw) ? raw : undefined;
}

const GREETING_ONLY = /^(salut|bonjour|hello|coucou|hey|yo|bonsoir)[\s!.?]*$/;

/** Verbes qui signalent une retouche du vêtement courant plutôt qu'une création. */
const MODIFY_HINT =
  /\b(passe(?:s|nt)?(?:-| )?(?:le|la|les)?|mets?|change[sz]?|remplace[sz]?|essaie|essaye|simule|re[- ]?essaie|bascule)\b/;

export function interpretBrief(rawText: string): BriefResult {
  const t = normalizeBrief(rawText);

  if (!t || GREETING_ONLY.test(t)) {
    return {
      intent: 'clarify',
      resumeFr: 'Décris le vêtement voulu — par exemple « hoodie en maille, taille L, mannequin homme ».',
    };
  }

  const archetype = detectArchetype(t);
  const fabric = detectFabric(t);
  const motif = detectMotif(t);
  const bodyKind = detectBodyKind(t);
  const stature = detectStature(t);
  const tryOn = !/sans (essayage|essayer|simulation|simuler)/.test(t);

  // « allonge / raccourcis » : l'édition de longueur reste un geste manuel
  // (outil Longueur) tant que l'exécuteur ne pilote pas les bords un à un.
  if (/\ballonge|\braccourci|\bplus long|\bplus court/.test(t) && !archetype) {
    return {
      intent: 'clarify',
      resumeFr: 'La retouche de longueur reste manuelle pour l’instant.',
      suggestionFr:
        'Active l’outil « Longueur » (étape 2) et tire l’extrémité du bord dans son axe — la carte d’aide affiche la cote en direct.',
    };
  }

  // Pas d'archétype : soit un vêtement non couvert (refus outillé), soit une
  // retouche du vêtement courant (ops), soit un brief à préciser.
  if (!archetype) {
    for (const un of UNSUPPORTED_GARMENTS) {
      if (un.pattern.test(t)) {
        return {
          intent: 'refuse',
          resumeFr: `Pas encore de patron « ${un.nameFr} » dans l’atelier.`,
          suggestionFr: un.suggestionFr,
        };
      }
    }
    const ops: BriefOp[] = [];
    const size = detectSize(t, null);
    if (MODIFY_HINT.test(t) || fabric || motif || bodyKind || stature || size) {
      if (size) ops.push({ op: 'resize', size });
      if (fabric) ops.push({ op: 'change_fabric', preset: fabric });
      if (motif) ops.push({ op: 'change_motif', motif });
      if (bodyKind) ops.push({ op: 'set_body', kind: bodyKind });
      if (stature !== undefined) ops.push({ op: 'set_stature', statureCm: stature });
      if (/\bmanches?\b/.test(t)) ops.push({ op: 'set_sleeves', on: !/sans manches?/.test(t) });
      if (/\bessaie|\bessaye|\bsimule|\bessayage/.test(t)) ops.push({ op: 'try_on' });
    }
    if (ops.length) {
      return {
        intent: 'modify',
        ops,
        tryOn: tryOn && ops.some((o) => o.op === 'try_on'),
        resumeFr: `Retouches appliquées au vêtement courant (${ops.length}).`,
      };
    }
    return {
      intent: 'clarify',
      resumeFr: 'Je n’ai pas reconnu de vêtement constructible dans ce brief.',
      suggestionFr:
        'L’atelier patronne aujourd’hui : t-shirt boxy, pantalon large, hoodie zippé. Exemple : « t-shirt boxy en popeline rayée, taille M ».',
    };
  }

  const size = detectSize(t, archetype.archetype);
  const parts: string[] = [archetype.labelFr];
  if (size) parts.push(size === 'avatar' ? 'ajusté au mannequin' : `taille ${size}`);
  if (fabric) parts.push(`en ${fabric.toLowerCase()}`);
  if (motif && motif !== 'uni') parts.push(motif);
  if (bodyKind) parts.push(bodyKind === 'scan homme' ? 'mannequin homme' : 'mannequin femme');
  if (stature !== undefined) parts.push(`stature ${stature} cm`);

  return {
    intent: 'create',
    garment: { archetype: archetype.archetype, ...(size ? { size } : {}) },
    ...(fabric ? { fabric } : {}),
    ...(motif ? { motif } : {}),
    ...(bodyKind !== undefined || stature !== undefined
      ? { body: { ...(bodyKind ? { kind: bodyKind } : {}), ...(stature !== undefined ? { statureCm: stature } : {}) } }
      : {}),
    tryOn,
    resumeFr: `Brief compris : ${parts.join(' · ')}.`,
  };
}
