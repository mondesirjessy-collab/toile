/**
 * Interpréteur de briefs — moteur à règles, français d'abord.
 *
 * Déterministe, instantané, hors-ligne : c'est le moteur de la démo. Le même
 * contrat (`BriefResult`) est produit par le backend distant optionnel, si bien
 * qu'un LLM peut remplacer ces règles sans toucher ni à l'exécuteur ni à l'UI.
 */

import {
  BRIEF_BOXY_SIZES,
  clampMotifCm,
  clampTeeEase,
  BRIEF_HOODIE_SIZES,
  BRIEF_JUPE_SIZES,
  BRIEF_DOUDOUNE_SIZES,
  BRIEF_PANTS_SIZES,
  BRIEF_ROBE_SIZES,
  BRIEF_VESTE_SIZES,
  clampStature,
  type BriefArchetype,
  type BriefBodyKind,
  type BriefFabric,
  type BriefMotif,
  type BriefMotifCouleur,
  type BriefOp,
  type BriefResult,
  type BriefTeeCollar,
  type BriefTeeLength,
  type BriefTeeNeck,
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

/**
 * Couleurs d'IMPRIMÉ (texte normalisé sans accents). Ordre = priorité :
 * « bleu marine » avant « bleu ». La couleur n'est retenue que si un motif
 * est présent — « robe rouge » (uni) relève du tissu, hors périmètre ici.
 */
const COULEUR_RULES: Array<{ pattern: RegExp; couleur: BriefMotifCouleur }> = [
  { pattern: /\bbleu marine\b|\bmarines?\b/, couleur: 'bleu marine' },
  { pattern: /\bbordeaux\b/, couleur: 'bordeaux' },
  { pattern: /\brouges?\b/, couleur: 'rouge' },
  { pattern: /\broses?\b/, couleur: 'rose' },
  { pattern: /\boranges?\b/, couleur: 'orange' },
  { pattern: /\bjaunes?\b/, couleur: 'jaune' },
  { pattern: /\bvert(?:e|es|s)?\b/, couleur: 'vert' },
  { pattern: /\bbleu(?:e|es|s)?\b/, couleur: 'bleu' },
  { pattern: /\bviolet(?:te|tes|s)?\b|\bmauves?\b/, couleur: 'violet' },
  { pattern: /\bmarrons?\b|\bchocolat\b/, couleur: 'marron' },
  { pattern: /\bbeiges?\b|\becrus?\b/, couleur: 'beige' },
  { pattern: /\bgris(?:e|es)?\b|\banthracite\b/, couleur: 'gris' },
  { pattern: /\bnoir(?:e|es|s)?\b/, couleur: 'noir' },
  { pattern: /\bblanc(?:he|hes|s)?\b/, couleur: 'blanc' },
];

const MOTIF_WORDS = String.raw`carreaux|rayures?|pois|vichy|motifs?|imprimes?`;
/** « carreaux de 3 cm », « rayures 2,5 cm » — bornée au curseur réel (1..30). */
const MOTIF_CM_EXPLICIT = new RegExp(
  String.raw`(?:${MOTIF_WORDS})[^.,;]{0,16}?\b(\d{1,2}(?:[.,]\d)?)\s?cm\b`,
);
/** Qualificatifs ADJACENTS seulement (« petits carreaux », « rayures fines ») —
 * un « grand mannequin à pois » ne doit pas grossir les pois. */
const MOTIF_SMALL = new RegExp(
  String.raw`\b(?:petit(?:s|es)?|fin(?:s|es?)?|minis?)\s+(?:${MOTIF_WORDS})|(?:${MOTIF_WORDS})\s+(?:fin(?:s|es?)?|serre(?:s|es)?|minis?)\b`,
);
const MOTIF_LARGE = new RegExp(
  String.raw`\b(?:gros(?:ses)?|grand(?:s|es)?|larges?|maxis?)\s+(?:${MOTIF_WORDS})|(?:${MOTIF_WORDS})\s+larges?\b`,
);

/** Vêtements que l'atelier ne sait pas encore patronner → refus + alternative. */
const UNSUPPORTED_GARMENTS: Array<{ pattern: RegExp; nameFr: string; suggestionFr: string }> = [
  {
    pattern: /\bchemises?\b|\bchemisiers?\b/,
    nameFr: 'chemise',
    suggestionFr: 'Le plus proche : le t-shirt BOXY en popeline.',
  },
  {
    pattern: /\bmanteaux?\b|\bparkas?\b|\btrenchs?\b/,
    nameFr: 'manteau long',
    suggestionFr:
      'Le plus proche aujourd’hui : la veste zippée doublée (blouson, doublure bordeaux) — ou le Hoodie zippé.',
  },
];

/**
 * Couture avancée — corset baleiné, traîne, crinoline, dentelle : des
 * TECHNIQUES que la simulation ne fait pas, quel que soit le vêtement porteur.
 * Vérifiée AVANT la création : « robe de bal à corset baleiné » doit refuser
 * honnêtement, pas produire une robe cintrée en silence.
 */
const ADVANCED_COUTURE = {
  pattern: /\bcorsets?\b|\btraines?\b|\bbaleine(e|es)?\b|\bcrinolines?\b|\bsmokings?\b|\bdentelles?\b/,
  nameFr: 'pièce de couture avancée',
  suggestionFr:
    'Corset baleiné, traîne ou dentelle demandent des techniques que TOILE ne simule pas encore. Constructible aujourd’hui : t-shirt, pantalon large, jupe trapèze, robe cintrée, veste doublée — et toute pièce tracée à la main.',
};

interface ArchetypeMatch {
  archetype: BriefArchetype;
  labelFr: string;
}

function detectArchetype(t: string): ArchetypeMatch | null {
  // v254 — hoodie retiré du catalogue public (moteur multi-pièces en chantier) :
  // « hoodie » tombe sur le message catalogue, honnête, au lieu de charger un
  // vêtement qui se découd à l'essayage.
  if (/\bdoudounes?\b|\bpuffers?\b|\bmatelass(e|ee)s?\b/.test(t)) {
    return { archetype: 'doudoune', labelFr: 'doudoune matelassée' };
  }
  if (/\bvestes?\b|\bblousons?\b|\bjackets?\b|\bbombers?\b/.test(t)) {
    return { archetype: 'veste', labelFr: 'veste zippée doublée' };
  }
  if (/\brobes?\b|\bdress(es)?\b/.test(t)) {
    return { archetype: 'robe', labelFr: 'robe cintrée' };
  }
  if (/\bjupes?\b|\bskirts?\b/.test(t)) {
    return { archetype: 'jupe', labelFr: 'jupe trapèze' };
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

function detectMotifCouleur(t: string): BriefMotifCouleur | undefined {
  for (const rule of COULEUR_RULES) if (rule.pattern.test(t)) return rule.couleur;
  return undefined;
}

function detectMotifCm(t: string): number | undefined {
  const explicit = t.match(MOTIF_CM_EXPLICIT)?.[1];
  if (explicit) return clampMotifCm(Number(explicit.replace(',', '.')));
  if (MOTIF_SMALL.test(t)) return 1.5;
  if (MOTIF_LARGE.test(t)) return 8;
  return undefined;
}

/** Retouches parlées du tee boxy (v293) — blocs longueur / encolure / col / aisance. */
interface TeeTouch {
  length?: BriefTeeLength;
  /** Un cran plus court (−1) ou plus long (+1) depuis la valeur courante. */
  lengthDelta?: -1 | 1;
  neck?: BriefTeeNeck;
  collar?: BriefTeeCollar;
  easePct?: number;
  easeDelta?: number;
}

const TEE_BODY_WORDS = String.raw`tee(?:[- ]?shirt)?|t[- ]?shirt|haut|corps|coupe|version`;

function detectTeeTouch(t: string): TeeTouch {
  const touch: TeeTouch = {};
  // Col (bloc) AVANT encolure : « col montant » / « sans col » doivent gagner
  // sur le « col » générique. « col roulé » reste hors vocabulaire (honnêteté).
  if (/\bcol montant\b/.test(t)) touch.collar = 'montant';
  else if (/\bsans col\b/.test(t)) touch.collar = 'sans';
  else if (/\bbord[- ]cote\b|\bcol cote\b/.test(t)) touch.collar = 'cote';
  if (/\b(?:col|encolure) (?:en )?v\b/.test(t)) touch.neck = 'v';
  else if (/\bras du cou\b|\bcol rond\b|\bencolure ronde?\b/.test(t)) touch.neck = 'ras';
  // Longueur du CORPS : relatif d'abord, absolu ensuite. Les manches sont
  // exclues (« manches plus longues », « raccourcis les manches » = bloc manche).
  const mancheLength = /\b(?:allonge|raccourci)[a-z]*\b[^.,;]{0,12}\bmanches?\b/.test(t);
  if (!mancheLength) {
    if (/(?<!manches? )\bplus court(?:e)?\b|\braccourci[a-z]*\b/.test(t)) touch.lengthDelta = -1;
    else if (/(?<!manches? )\bplus long(?:ue)?\b|\ballonge[a-z]*\b/.test(t)) touch.lengthDelta = 1;
    else if (
      /\bcrop(?:pe|pee)?\b/.test(t) ||
      new RegExp(String.raw`\b(?:${TEE_BODY_WORDS}) court\b`).test(t)
    ) {
      touch.length = 'crop';
    } else if (new RegExp(String.raw`\b(?:${TEE_BODY_WORDS}) long\b`).test(t)) touch.length = 'long';
    else if (/\blongueur normale\b/.test(t)) touch.length = 'regular';
  }
  // Aisance : relatif (« plus ample ») ou absolu (« oversize », « près du corps »).
  // « ajusté au mannequin » = TAILLE avatar (detectSize), jamais l'aisance.
  if (/\bplus ample\b|\bplus large\b|\bplus loose\b/.test(t)) touch.easeDelta = 10;
  else if (/\bmoins ample\b|\bplus pres du corps\b|\bplus cintre(?:e)?\b|\bplus ajuste(?:e)?\b/.test(t)) {
    touch.easeDelta = -10;
  } else if (/\btres ample\b|\boversize\b/.test(t)) touch.easePct = clampTeeEase(116);
  else if (/\bample\b|\bloose\b/.test(t)) touch.easePct = clampTeeEase(110);
  else if (/\bpres du corps\b|\bcintre(?:e|es)?\b/.test(t)) touch.easePct = clampTeeEase(92);
  return touch;
}

/** Les ops de retouche du tee, dans l'ordre stable longueur → encolure → col → aisance. */
function teeTouchOps(touch: TeeTouch): BriefOp[] {
  const ops: BriefOp[] = [];
  if (touch.length !== undefined) ops.push({ op: 'set_tee_length', value: touch.length });
  else if (touch.lengthDelta !== undefined) ops.push({ op: 'set_tee_length', delta: touch.lengthDelta });
  if (touch.neck !== undefined) ops.push({ op: 'set_tee_neck', value: touch.neck });
  if (touch.collar !== undefined) ops.push({ op: 'set_tee_collar', value: touch.collar });
  if (touch.easePct !== undefined) ops.push({ op: 'set_tee_ease', pct: touch.easePct });
  else if (touch.easeDelta !== undefined) ops.push({ op: 'set_tee_ease', deltaPct: touch.easeDelta });
  return ops;
}

function detectBodyKind(t: string): BriefBodyKind | undefined {
  if (/\bjericho\b|\bneutres?\b|\bhommes?\b|\bmasculins?\b|\bmec\b/.test(t)) return 'scan homme';
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
  // Retouche du vêtement courant (« la même ajustée au mannequin ») : l'op
  // resize('avatar') n'aboutit que si le sélecteur du patron courant propose
  // vraiment cette option — sinon l'exécuteur note honnêtement.
  if (archetype === null && /ajust(e|ee)? au mannequin|sur[- ]mesure|a mes mesures/.test(t)) {
    return 'avatar';
  }
  if (archetype === 'pantalon') {
    const eu = t.match(/\b(?:taille|eu)\s?(2[68]|3[02468]|4[0246]|26|46)\b/)?.[1];
    if (eu && (BRIEF_PANTS_SIZES as readonly string[]).includes(eu)) return eu;
    return undefined;
  }
  if (archetype === 'jupe' || archetype === 'robe') {
    if (/ajust(e|ee)? au mannequin|sur[- ]mesure|a mes mesures/.test(t)) return 'avatar';
    const eu = t.match(/\b(?:taille|eu)\s?(3[468]|4[0246])\b/)?.[1];
    const pool = archetype === 'jupe' ? BRIEF_JUPE_SIZES : BRIEF_ROBE_SIZES;
    if (eu && (pool as readonly string[]).includes(eu)) return eu;
    return undefined;
  }
  if (
    (archetype === 'hoodie_zip' || archetype === 'veste' || archetype === 'doudoune') &&
    /ajust(e|ee)? au mannequin|sur[- ]mesure|a mes mesures/.test(t)
  ) {
    return 'avatar';
  }
  // XS/XL/XXL/XXXL sont sans ambiguïté ; S, M, L exigent le mot « taille »
  // (sinon « en l », « à s » dans une phrase produiraient des faux positifs).
  const explicit = t.match(/\btaille\s+(xxxl|xxl|xl|xs|s|m|l)\b/);
  const loose = explicit ?? t.match(/\ben\s+(xxxl|xxl|xl|xs)\b/) ?? t.match(/\b(xxxl|xxl|xl|xs)\b/);
  const raw = loose?.[1]?.toUpperCase();
  if (!raw) return undefined;
  const pool =
    archetype === 'hoodie_zip'
      ? BRIEF_HOODIE_SIZES
      : archetype === 'veste'
        ? BRIEF_VESTE_SIZES
        : archetype === 'doudoune'
          ? BRIEF_DOUDOUNE_SIZES
          : BRIEF_BOXY_SIZES;
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
  const motifCouleur = detectMotifCouleur(t);
  const motifCm = detectMotifCm(t);
  // Honnêteté : la couleur ne s'applique qu'aux IMPRIMÉS. Sans motif (ou en
  // uni), on l'écarte ET on le DIT — jamais d'à-peu-près silencieux.
  const couleurSansMotif = motifCouleur !== undefined && (!motif || motif === 'uni');
  const couleurNote = couleurSansMotif
    ? ` (couleur « ${motifCouleur} » ignorée : elle s'applique aux imprimés — rayures, vichy ou pois)`
    : '';
  const bodyKind = detectBodyKind(t);
  const stature = detectStature(t);
  const teeTouch = detectTeeTouch(t);
  const tryOn = !/sans (essayage|essayer|simulation|simuler)/.test(t);

  // Cote de longueur PRÉCISE (« allonge de 10 cm ») : les blocs du tee n'ont
  // que 3 crans — la retouche au centimètre reste un geste manuel (honnêteté).
  if (
    /\b(?:allonge|raccourci)[a-z]*\b[^.,;]{0,16}\bde \d+(?:[.,]\d+)? ?cm\b/.test(t) &&
    !/\bmanches?\b/.test(t)
  ) {
    return {
      intent: 'clarify',
      resumeFr: 'La retouche de longueur au centimètre reste manuelle.',
      suggestionFr:
        'À la voix, le tee connaît 3 crans (« plus court », « plus long », « crop »). Pour une cote exacte : outil « Longueur » (étape 2), la carte d’aide affiche la cote en direct.',
    };
  }

  // Couture avancée : refus AVANT toute création — même si un archétype
  // constructible apparaît dans la phrase (« robe de bal à corset baleiné »
  // ne doit pas produire une robe cintrée en silence).
  if (ADVANCED_COUTURE.pattern.test(t)) {
    return {
      intent: 'refuse',
      resumeFr: `Pas encore de patron « ${ADVANCED_COUTURE.nameFr} » dans l’atelier.`,
      suggestionFr: ADVANCED_COUTURE.suggestionFr,
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
    const teeOps = teeTouchOps(teeTouch);
    if (MODIFY_HINT.test(t) || fabric || motif || bodyKind || stature || size || teeOps.length) {
      if (size) ops.push({ op: 'resize', size });
      ops.push(...teeOps);
      if (fabric) ops.push({ op: 'change_fabric', preset: fabric });
      if (motif) {
        ops.push({
          op: 'change_motif',
          motif,
          ...(motif !== 'uni' && motifCouleur ? { couleur: motifCouleur } : {}),
          ...(motif !== 'uni' && motifCm !== undefined ? { cm: motifCm } : {}),
        });
      }
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
        resumeFr: `Retouches appliquées au vêtement courant (${ops.length}).${couleurNote}`,
      };
    }
    // Une couleur seule (« en rouge ») : le chemin constructible passe par un
    // imprimé — l'expliquer vaut mieux qu'un clarify générique.
    if (motifCouleur !== undefined) {
      return {
        intent: 'clarify',
        resumeFr: `La couleur seule ne suffit pas : elle s'applique aux imprimés.`,
        suggestionFr: `Précise l'imprimé : « mets des rayures ${motifCouleur} », « vichy ${motifCouleur} petits carreaux » ou « à pois ${motifCouleur} ».`,
      };
    }
    return {
      intent: 'clarify',
      resumeFr: 'Je n’ai pas reconnu de vêtement constructible dans ce brief.',
      suggestionFr:
        'L’atelier patronne aujourd’hui : t-shirt boxy, pantalon large, jupe trapèze, robe cintrée, veste doublée, doudoune matelassée. Exemple : « une doudoune, taille M ».',
    };
  }

  let size = detectSize(t, archetype.archetype);
  const isTee = archetype.archetype === 'tshirt_boxy';
  // Blocs du tee à la CRÉATION : les crans relatifs se résolvent depuis les
  // valeurs par défaut (longueur normale, aisance 100 %).
  const teeLength = isTee
    ? (teeTouch.length ?? (teeTouch.lengthDelta === -1 ? 'crop' : teeTouch.lengthDelta === 1 ? 'long' : undefined))
    : undefined;
  const teeEasePct = isTee
    ? (teeTouch.easePct ??
      (teeTouch.easeDelta !== undefined ? clampTeeEase(100 + teeTouch.easeDelta) : undefined))
    : undefined;
  // L'aisance n'existe qu'en sur-mesure : un « tee ample » sans taille bascule
  // sur la coupe au mannequin (et le dit), sinon l'aisance resterait lettre morte.
  const easeForcesAvatar = teeEasePct !== undefined && !size;
  if (easeForcesAvatar) size = 'avatar';
  // Honnêteté : un bloc parlé (col V, longueur, aisance) demandé sur un AUTRE
  // vêtement que le tee est écarté EN LE DISANT, jamais en silence.
  const teeBlocksAsked =
    teeTouch.neck === 'v' ||
    teeTouch.collar !== undefined ||
    teeTouch.length !== undefined ||
    teeTouch.lengthDelta !== undefined ||
    teeTouch.easeDelta !== undefined;
  const teeNote =
    !isTee && teeBlocksAsked
      ? ' (col, longueur et aisance parlés : blocs du t-shirt boxy pour l’instant)'
      : '';
  const parts: string[] = [archetype.labelFr];
  if (size) parts.push(size === 'avatar' ? 'ajusté au mannequin' : `taille ${size}`);
  if (teeLength) parts.push(`longueur ${teeLength === 'crop' ? 'courte' : teeLength === 'long' ? 'longue' : 'normale'}`);
  if (isTee && teeTouch.neck) parts.push(teeTouch.neck === 'v' ? 'encolure V' : 'ras du cou');
  if (isTee && teeTouch.collar) {
    parts.push(teeTouch.collar === 'sans' ? 'sans col' : teeTouch.collar === 'cote' ? 'col bord côte' : 'col montant');
  }
  if (teeEasePct !== undefined) parts.push(`aisance ${teeEasePct} %`);
  if (fabric) parts.push(`en ${fabric.toLowerCase()}`);
  if (motif && motif !== 'uni') {
    const details: string[] = [motif];
    if (motifCouleur) details.push(motifCouleur);
    if (motifCm !== undefined) details.push(`${String(motifCm).replace('.', ',')} cm`);
    parts.push(details.join(' '));
  }
  if (bodyKind) parts.push(bodyKind === 'scan homme' ? 'mannequin homme' : 'mannequin femme');
  if (stature !== undefined) parts.push(`stature ${stature} cm`);

  return {
    intent: 'create',
    garment: { archetype: archetype.archetype, ...(size ? { size } : {}) },
    ...(fabric ? { fabric } : {}),
    ...(motif ? { motif } : {}),
    ...(motif && motif !== 'uni' && motifCouleur ? { motifCouleur } : {}),
    ...(motif && motif !== 'uni' && motifCm !== undefined ? { motifCm } : {}),
    ...(teeLength ? { teeLength } : {}),
    ...(isTee && teeTouch.neck ? { teeNeck: teeTouch.neck } : {}),
    ...(isTee && teeTouch.collar ? { teeCollar: teeTouch.collar } : {}),
    ...(teeEasePct !== undefined ? { teeEasePct } : {}),
    ...(bodyKind !== undefined || stature !== undefined
      ? { body: { ...(bodyKind ? { kind: bodyKind } : {}), ...(stature !== undefined ? { statureCm: stature } : {}) } }
      : {}),
    tryOn,
    resumeFr: `Brief compris : ${parts.join(' · ')}.${couleurNote}${teeNote}`,
  };
}
