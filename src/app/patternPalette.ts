// ————— La palette du plan 2D (v179, chantier ④ « pas dépaysé »).
// TOUTES les couleurs du plan vivent ici — PatternView n'a plus un seul
// littéral (un test le garantit). Deux thèmes : NUIT (les valeurs historiques,
// à l'octet près) et PAPIER (le plan clair façon table de coupe — seuls les
// emplacements de SURFACE changent, les pastilles/badges gardent leur encre
// sombre qui lit bien sur les deux fonds). Les clés `aNN` sont partagées entre
// thèmes ; les clés nommées sont celles que PAPIER redéfinit.
// `fond` vaut 'transparent' en NUIT (le CSS du panneau fournit la nuit) ;
// `grilleRVB`/`tissuDefautRVB` sont des triplets pour alpha dynamique.

export const SEAM_COLORS = ['#7fb2ff', '#7ddc96', '#ffd166', '#e08bff', '#6bdfdf', '#ff8fa3', '#c9d96b', '#ffb26b'] as const;

const NUIT = {
  fond: 'transparent', // THÈME · fond peint par le canvas (transparent = CSS)
  grilleRVB: '237, 233, 223', // THÈME · triplet, alpha dynamique
  tissuDefautRVB: '228, 222, 205', // partagé · triplet
  contourPieceFaible: 'rgba(230, 225, 210, 0.4)', // ×1 · THÈME
  a01: 'rgba(255, 214, 170, 0.95)', // ×1 · partagé
  ligneInterne: 'rgba(214, 222, 234, 0.6)', // ×2 · THÈME
  a02: 'rgba(8, 10, 14, 0.82)', // ×1 · partagé
  ligneInterneForte: 'rgba(214, 222, 234, 0.85)', // ×1 · THÈME
  hachureTrou: 'rgba(210, 210, 210, 0.5)', // ×1 · THÈME
  a03: 'rgba(107, 223, 223, 0.16)', // ×1 · partagé
  a04: 'rgba(158, 178, 214, 0.1)', // ×1 · partagé
  a05: 'rgba(255, 191, 96, 0.15)', // ×1 · partagé
  a06: 'rgba(107, 223, 223, 0.98)', // ×5 · partagé
  a07: 'rgba(255, 184, 84, 0.98)', // ×1 · partagé
  crochetNeutre: 'rgba(180, 188, 198, 0.68)', // ×1 · THÈME
  a08: 'rgba(24, 20, 15, 0.94)', // ×1 · partagé
  a09: 'rgba(255, 205, 135, 1)', // ×1 · partagé
  a10: 'rgba(12, 16, 22, 0.92)', // ×1 · partagé
  a11: 'rgba(160, 245, 245, 1)', // ×1 · partagé
  a12: 'rgba(255, 211, 150, 1)', // ×1 · partagé
  a13: 'rgba(90, 160, 255, 0.24)', // ×2 · partagé
  a14: 'rgba(93, 211, 229, 0.17)', // ×1 · partagé
  a15: 'rgba(127, 190, 255, 1)', // ×2 · partagé
  a16: 'rgba(107, 223, 223, 0.95)', // ×2 · partagé
  a17: 'rgba(127, 190, 255, 0.9)', // ×1 · partagé
  a18: 'rgba(107, 223, 223, 0.82)', // ×1 · partagé
  a19: 'rgba(255, 159, 107, 1)', // ×5 · partagé
  sommetNeutre: 'rgba(245, 248, 252, 1)', // ×1 · THÈME
  a20: 'rgba(255, 190, 150, 1)', // ×1 · partagé
  a21: 'rgba(80, 154, 255, 1)', // ×1 · partagé
  a22: 'rgba(65, 190, 205, 1)', // ×1 · partagé
  a23: 'rgba(10, 15, 22, 0.94)', // ×2 · partagé
  a24: 'rgba(177, 215, 255, 1)', // ×1 · partagé
  a25: 'rgba(66, 143, 255, 0.18)', // ×1 · partagé
  a26: 'rgba(66, 143, 255, 0.12)', // ×1 · partagé
  a27: 'rgba(137, 199, 255, 1)', // ×1 · partagé
  a28: 'rgba(101, 171, 255, 0.98)', // ×1 · partagé
  a29: 'rgba(92, 45, 30, 0.96)', // ×1 · partagé
  a30: 'rgba(18, 55, 95, 0.96)', // ×1 · partagé
  a31: 'rgba(255, 213, 190, 1)', // ×1 · partagé
  a32: 'rgba(202, 230, 255, 1)', // ×1 · partagé
  a33: 'rgba(190, 220, 249, 0.9)', // ×1 · partagé
  a34: 'rgba(74, 35, 24, 0.98)', // ×1 · partagé
  a35: 'rgba(255, 226, 210, 1)', // ×1 · partagé
  a36: 'rgba(107, 223, 223, 0.72)', // ×1 · partagé
  pinceTrait: 'rgba(255, 255, 255, 0.4)', // ×1 · THÈME
  pinceFond: 'rgba(255, 255, 255, 0.18)', // ×1 · THÈME
  pinceTraitFort: 'rgba(255, 255, 255, 0.65)', // ×1 · THÈME
  a37: 'rgba(10, 12, 15, 0.95)', // ×2 · partagé
  a38: 'rgba(188, 244, 244, 1)', // ×1 · partagé
  a39: 'rgba(122, 226, 154, 0.55)', // ×1 · partagé
  a40: 'rgba(127, 178, 255, 0.45)', // ×2 · partagé
  a41: 'rgba(127, 178, 255, 0.9)', // ×2 · partagé
  a42: 'rgba(255, 159, 107, 0.95)', // ×12 · partagé
  pointNeutre: 'rgba(255, 255, 255, 0.92)', // ×4 · THÈME
  a43: 'rgba(122, 226, 154, 0.95)', // ×2 · partagé
  a44: 'rgba(122, 226, 154, 0.7)', // ×1 · partagé
  a45: 'rgba(14, 15, 18, 0.85)', // ×2 · partagé
  a46: 'rgba(255, 194, 150, 1)', // ×2 · partagé
  a47: 'rgba(255, 159, 107, 0.6)', // ×1 · partagé
  a48: 'rgba(255, 159, 107, 0.75)', // ×1 · partagé
  ligneInterneVive: 'rgba(214, 222, 234, 0.9)', // ×1 · THÈME
  ligneInterneDouce: 'rgba(214, 222, 234, 0.45)', // ×1 · THÈME
  contourPiece: 'rgba(230, 225, 210, 0.9)', // ×2 · THÈME
  a49: 'rgba(127, 178, 255, 0.95)', // ×3 · partagé
  a50: 'rgba(127, 210, 255, 0.98)', // ×1 · partagé
  a51: 'rgba(15, 24, 34, 0.95)', // ×1 · partagé
  a52: 'rgba(160, 225, 255, 1)', // ×1 · partagé
  a53: 'rgba(255, 209, 102, 1)', // ×2 · partagé
  a54: 'rgba(255, 245, 210, 1)', // ×1 · partagé
  a55: 'rgba(255, 184, 80, 1)', // ×1 · partagé
  a56: 'rgba(10, 15, 22, 0.95)', // ×1 · partagé
  a57: 'rgba(255, 220, 145, 1)', // ×1 · partagé
  a58: 'rgba(224, 139, 255, 0.98)', // ×1 · partagé
  a59: 'rgba(255, 209, 102, 0.95)', // ×1 · partagé
  a60: 'rgba(10, 12, 15, 0.94)', // ×1 · partagé
  a61: 'rgba(255, 209, 102, 0.48)', // ×1 · partagé
  a62: 'rgba(255, 226, 156, 0.82)', // ×1 · partagé
  a63: 'rgba(224, 139, 255, 0.5)', // ×1 · partagé
  a64: 'rgba(224, 170, 255, 0.85)', // ×1 · partagé
  a65: 'rgba(9, 12, 16, 0.94)', // ×1 · partagé
  a66: 'rgba(180, 190, 205, 0.32)', // ×1 · partagé
  a67: 'rgba(237, 233, 223, 0.95)', // ×1 · partagé
  a68: 'rgba(237, 233, 223, 0.88)', // ×1 · partagé
  a69: 'rgba(120, 220, 150, 0.98)', // ×3 · partagé
  a70: 'rgba(255, 159, 107, 0.9)', // ×2 · partagé
  a71: 'rgba(107, 223, 223, 0.96)', // ×1 · partagé
  a72: 'rgba(107, 223, 223, 1)', // ×1 · partagé
  a73: 'rgba(107, 223, 223, 0.9)', // ×2 · partagé
  a74: 'rgba(233, 96, 70, 0.9)', // ×2 · partagé
  a75: 'rgba(255, 202, 71, 1)', // ×4 · partagé
  a76: 'rgba(187, 178, 157, 0.9)', // ×1 · partagé
  a77: 'rgba(38, 34, 29, 0.92)', // ×1 · partagé
  a78: 'rgba(255, 159, 107, 0.98)', // ×4 · partagé
  a79: 'rgba(38, 34, 29, 0.94)', // ×1 · partagé
  a80: 'rgba(255, 209, 102, 0.98)', // ×1 · partagé
  a81: 'rgba(120, 220, 150, 0.95)', // ×1 · partagé
  a82: 'rgba(237, 233, 223, 0.6)', // ×1 · partagé
  silhouette: 'rgba(214, 205, 190, 0.16)', // ×1 · THÈME
  axeLabelFaible: 'rgba(237, 233, 223, 0.28)', // ×1 · THÈME
  axeLabelFort: 'rgba(237, 233, 223, 0.5)', // ×1 · THÈME
  silhouetteTrace: 'rgba(228, 222, 205, 0.28)', // ×1 · THÈME
  a83: 'rgba(237, 233, 223, 0.9)', // ×1 · partagé
};

export type PatternPalette = typeof NUIT;
export type PatternTheme = 'nuit' | 'papier';

const PAPIER: PatternPalette = {
  ...NUIT,
  fond: '#eceadf',
  grilleRVB: '84, 92, 112',
  contourPieceFaible: 'rgba(43, 63, 107, 0.45)',
  ligneInterne: 'rgba(52, 62, 84, 0.65)',
  ligneInterneForte: 'rgba(52, 62, 84, 0.9)',
  hachureTrou: 'rgba(110, 110, 110, 0.55)',
  crochetNeutre: 'rgba(60, 72, 96, 0.75)',
  sommetNeutre: 'rgba(43, 63, 107, 0.95)',
  pinceTrait: 'rgba(43, 63, 107, 0.55)',
  pinceFond: 'rgba(43, 63, 107, 0.14)',
  pinceTraitFort: 'rgba(43, 63, 107, 0.8)',
  pointNeutre: 'rgba(43, 63, 107, 0.92)',
  ligneInterneVive: 'rgba(52, 62, 84, 0.95)',
  ligneInterneDouce: 'rgba(52, 62, 84, 0.5)',
  contourPiece: 'rgba(43, 63, 107, 0.95)',
  silhouette: 'rgba(120, 116, 105, 0.2)',
  axeLabelFaible: 'rgba(45, 52, 68, 0.4)',
  axeLabelFort: 'rgba(45, 52, 68, 0.65)',
  silhouetteTrace: 'rgba(100, 96, 88, 0.32)',
};

const THEMES: Record<PatternTheme, PatternPalette> = { nuit: NUIT, papier: PAPIER };

/** L'objet VIVANT lu par PatternView à chaque frame — muté par setPatternTheme. */
export const PAL: PatternPalette = { ...NUIT };

let current: PatternTheme = 'nuit';
export function setPatternTheme(theme: PatternTheme): void {
  current = theme;
  Object.assign(PAL, THEMES[theme]);
}
export function patternTheme(): PatternTheme {
  return current;
}
