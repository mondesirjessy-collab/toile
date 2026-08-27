/**
 * nfpNesting — placement de plan de découpe par No-Fit Polygon EXACT
 * (clipper2-ts), en parallèle du chemin grille de markerLayout.
 *
 * Veille du 27/08/2026 : la grille rasterisée (1,5 cm) laisse du jeu — le
 * NFP place les contours réels au contact exact de la marge de couture.
 * Même contrat que nestPieces (entrées MarkerPiece, sortie MarkerNest) pour
 * un A/B direct ; la bascule ne se fait que sur GAIN MESURÉ (longueur de
 * matelas) par le banc tests/NfpNesting.test.ts.
 *
 * Mécanique :
 *  - contour + marge = inflatePathsD (offset exact, coins arrondis) ;
 *  - zone interdite pour la pièce B face à la pièce A placée =
 *    NFP(A, B) = minkowskiSumD(A, −B) translaté à la position de A
 *    (le NFP se TRANSLATE avec la pièce — on le calcule une fois par
 *    PAIRE DE FORMES et par rotation, puis on le déplace) ;
 *  - candidats de position = coins bas-gauche du rouleau + sommets des NFP
 *    (la position optimale bottom-left est toujours sur un sommet de la
 *    frontière des zones interdites) ;
 *  - faisabilité = point de référence hors de TOUS les NFP
 *    (pointInPolygonD) et bbox dans la laize.
 */
import {
  type PathD,
  type PathsD,
  type PointD,
  FillRule,
  inflatePathsD,
  intersectD,
  JoinType,
  EndType,
  minkowskiSumD,
  pointInPolygonD,
  PointInPolygonResult,
  areaD,
} from 'clipper2-ts';
import type { MarkerNest, MarkerPiece, Placement } from './markerLayout';

/** Contour physique (cm) d'une pièce, avec marge de couture exacte. */
function contourWithSeamAllowance(p: MarkerPiece, saCm: number, rot: 0 | 180): PathD {
  const path: PathD = p.outline.map(([u, v]) => ({
    x: (rot === 180 ? 1 - u : u) * p.wCm,
    y: (rot === 180 ? 1 - v : v) * p.hCm,
  }));
  const inflated: PathsD = inflatePathsD([path], saCm, JoinType.Round, EndType.Polygon, 2, 0.1);
  // inflatePathsD peut renvoyer plusieurs contours (pièces très concaves) —
  // le plus grand est l'enveloppe extérieure.
  let best: PathD = inflated[0] ?? path;
  let bestArea = Math.abs(areaD(best));
  for (const c of inflated.slice(1)) {
    const a = Math.abs(areaD(c));
    if (a > bestArea) { best = c; bestArea = a; }
  }
  return best;
}

function bounds(path: PathD): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of path) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

function translate(path: PathD, dx: number, dy: number): PathD {
  return path.map((q) => ({ x: q.x + dx, y: q.y + dy }));
}

function negate(path: PathD): PathD {
  return path.map((q) => ({ x: -q.x, y: -q.y }));
}

/** Le point est-il STRICTEMENT dans un des contours (bord = dehors, à un
 * cheveu près — le contact exact entre pièces est le but du NFP). */
function insideAny(pt: PointD, regions: readonly PathD[]): boolean {
  for (const r of regions) {
    if (pointInPolygonD(pt, r) === PointInPolygonResult.IsInside) return true;
  }
  return false;
}

/**
 * Nesting NFP bottom-left. Même contrat que nestPieces (markerLayout) :
 * pièces posées plus grosses d'abord, rotations 0/180, sortie en cm.
 */
export function nestPiecesNfp(
  list: readonly MarkerPiece[],
  saCm: number,
  rollWidthCm = 150,
): MarkerNest {
  // Formes uniques : les commandes répètent les MÊMES objets MarkerPiece —
  // contours gonflés et NFP sont mis en cache par (forme, rotation).
  const inflatedCache = new Map<string, PathD>();
  const shapeKey = (p: MarkerPiece, rot: 0 | 180): string => {
    let id = shapeIds.get(p);
    if (id === undefined) { id = shapeIds.size; shapeIds.set(p, id); }
    return `${id}:${rot}`;
  };
  const shapeIds = new Map<MarkerPiece, number>();
  const shapeOf = (p: MarkerPiece, rot: 0 | 180): PathD => {
    const k = shapeKey(p, rot);
    let s = inflatedCache.get(k);
    if (!s) { s = contourWithSeamAllowance(p, saCm, rot); inflatedCache.set(k, s); }
    return s;
  };
  // NFP par paire de formes : NFP(formeA, formeB) à l'origine — translaté à
  // l'usage par la position réelle de A. minkowskiSumD(A, −B) donne la zone
  // des positions du POINT DE RÉFÉRENCE de B (son origine locale) qui
  // chevauchent A.
  const nfpCache = new Map<string, PathsD>();
  const nfpOf = (a: MarkerPiece, rotA: 0 | 180, b: MarkerPiece, rotB: 0 | 180): PathsD => {
    const k = `${shapeKey(a, rotA)}|${shapeKey(b, rotB)}`;
    let n = nfpCache.get(k);
    if (!n) {
      n = minkowskiSumD(shapeOf(a, rotA), negate(shapeOf(b, rotB)), true);
      nfpCache.set(k, n);
    }
    return n;
  };

  const order = [...list]
    .map((p) => ({ p, area: Math.abs(areaD(shapeOf(p, 0))) }))
    .sort((x, y) => y.area - x.area);

  const placed: { p: MarkerPiece; rot: 0 | 180; x: number; y: number }[] = [];
  const placements: Placement[] = [];
  let lengthCm = 0;

  for (const { p } of order) {
    let best: { x: number; y: number; rot: 0 | 180; cost: number } | null = null;
    for (const rot of [0, 180] as const) {
      const shape = shapeOf(p, rot);
      const bb = bounds(shape);
      const w = bb.maxX - bb.minX;
      if (w > rollWidthCm + 1e-6) continue; // trop large pour la laize
      // Zones interdites : les NFP de chaque pièce placée, translatés.
      const forbidden: PathD[] = [];
      for (const q of placed) {
        for (const c of nfpOf(q.p, q.rot, p, rot)) forbidden.push(translate(c, q.x, q.y));
      }
      // Positions candidates du point de référence (l'origine locale de la
      // pièce) : le coin bas-gauche du rouleau + tous les sommets des NFP
      // (l'optimum bottom-left est sur la frontière des zones interdites).
      const candidates: PointD[] = [{ x: -bb.minX, y: -bb.minY }];
      for (const region of forbidden) for (const q of region) candidates.push(q);
      // Filtrer : dans la laize, au-dessus de 0, hors de toutes les zones.
      let localBest: { x: number; y: number; cost: number } | null = null;
      for (const cand of candidates) {
        const minX = cand.x + bb.minX;
        const maxX = cand.x + bb.maxX;
        const minY = cand.y + bb.minY;
        if (minX < -1e-6 || maxX > rollWidthCm + 1e-6 || minY < -1e-6) continue;
        // léger retrait du bord pour la stabilité numérique du test intérieur
        if (insideAny(cand, forbidden)) continue;
        const cost = (cand.y + bb.maxY) * 10000 + cand.x; // bas d'abord, puis gauche
        if (!localBest || cost < localBest.cost) localBest = { x: cand.x, y: cand.y, cost };
      }
      if (localBest && (!best || localBest.cost < best.cost)) {
        best = { ...localBest, rot };
      }
    }
    const chosen = best ?? { x: 0, y: lengthCm, rot: 0 as const, cost: 0 };
    placed.push({ p, rot: chosen.rot, x: chosen.x, y: chosen.y });
    const bb = bounds(shapeOf(p, chosen.rot));
    lengthCm = Math.max(lengthCm, chosen.y + bb.maxY);
    // Placement au contrat markerLayout : x/y = coin (0,0) du repère UV de la
    // pièce SANS marge (la grille plaçait le coin du masque dilaté — ici le
    // repère est l'origine locale du contour, donc identique par
    // construction : les contours sont émis dans le repère [0..wCm]×[0..hCm]).
    placements.push({
      name: p.name,
      wCm: p.wCm,
      hCm: p.hCm,
      outline: p.outline,
      notches: p.notches,
      x: chosen.x,
      y: chosen.y,
      rot: chosen.rot,
    });
  }
  return { placements, rollWidthCm, lengthCm };
}

/**
 * COMPACTAGE EXACT d'un nest GRILLE : chaque pièce (ordre bas→haut) glisse
 * verticalement au contact exact des pièces déjà compactées, puis à gauche.
 * La grille garde son rôle de moteur de placement (le banc a montré qu'elle
 * BAT le NFP bottom-left naïf) ; le compactage enlève le quantum de 1,5 cm
 * qu'elle laisse entre les pièces. Exact : l'appui est calculé par
 * intersection du segment de glissement avec les NFP des pièces posées.
 */
export function compactNest(nest: MarkerNest, saCm: number): MarkerNest {
  const shapeCache = new Map<string, PathD>();
  const shapeOf = (p: Placement): PathD => {
    const k = `${p.name}|${p.wCm}|${p.hCm}|${p.rot}`;
    let s = shapeCache.get(k);
    if (!s) { s = contourWithSeamAllowance(p, saCm, p.rot); shapeCache.set(k, s); }
    return s;
  };
  // NFP par paire de formes (à l'origine), translaté à l'usage.
  const nfpCache = new Map<string, PathsD>();
  const nfpOf = (a: Placement, b: Placement): PathsD => {
    const k = `${a.name}|${a.wCm}|${a.rot}||${b.name}|${b.wCm}|${b.rot}`;
    let n = nfpCache.get(k);
    if (!n) { n = minkowskiSumD(shapeOf(a), negate(shapeOf(b)), true); nfpCache.set(k, n); }
    return n;
  };
  /** Bornes admissibles du point de référence de `b` glissant sur l'axe
   * donné depuis sa position courante : la plus grande valeur < courante qui
   * reste hors de tous les NFP. Balayage exact des arêtes. */
  const slideDown = (
    b: Placement,
    fixed: readonly Placement[],
    axis: 'x' | 'y',
  ): number => {
    const cur = axis === 'y' ? b.y : b.x;
    const other = axis === 'y' ? b.x : b.y;
    let floor = 0; // borne physique (bord du rouleau / y=0)
    const bb = bounds(shapeOf(b));
    if (axis === 'y') floor = -bb.minY; else floor = -bb.minX;
    let limit = floor;
    const bbB = bounds(shapeOf(b));
    for (const q of fixed) {
      // Filtre bbox : une pièce posée dont l'empreinte ne recouvre pas le
      // rail de glissement ne peut pas faire appui — O(n²) → quasi-linéaire.
      const bbQ = bounds(shapeOf(q));
      if (axis === 'y') {
        if (q.x + bbQ.maxX < b.x + bbB.minX - 1e-6 || q.x + bbQ.minX > b.x + bbB.maxX + 1e-6) continue;
      } else {
        if (q.y + bbQ.maxY < b.y + bbB.minY - 1e-6 || q.y + bbQ.minY > b.y + bbB.maxY + 1e-6) continue;
      }
      for (const region of nfpOf(q, b)) {
        const poly = translate(region, q.x, q.y);
        // Intersections du rail { axis = t, other = const } avec le polygone.
        const n = poly.length;
        for (let i = 0; i < n; i++) {
          const p1 = poly[i]!;
          const p2 = poly[(i + 1) % n]!;
          const a1 = axis === 'y' ? p1.y : p1.x;
          const a2 = axis === 'y' ? p2.y : p2.x;
          const o1 = axis === 'y' ? p1.x : p1.y;
          const o2 = axis === 'y' ? p2.x : p2.y;
          if ((o1 - other) * (o2 - other) > 0) continue; // n'enjambe pas le rail
          const span = o2 - o1;
          const t = Math.abs(span) < 1e-12 ? Math.max(a1, a2) : a1 + ((other - o1) / span) * (a2 - a1);
          // Le rail entre dans la zone interdite en t : on ne peut pas
          // descendre en dessous du PLUS HAUT franchissement sous la
          // position courante.
          if (t <= cur + 1e-9 && t > limit) limit = t;
        }
        // Position courante DANS la zone (ne devrait pas arriver depuis la
        // grille) : ne pas bouger.
        if (pointInPolygonD({ x: b.x, y: b.y }, poly) === PointInPolygonResult.IsInside) {
          return cur;
        }
      }
    }
    return Math.min(cur, Math.max(limit, floor));
  };
  const ordered = [...nest.placements].sort((a, b2) => a.y - b2.y || a.x - b2.x);
  const done: Placement[] = [];
  for (const pl of ordered) {
    const moved: Placement = { ...pl };
    moved.y = slideDown(moved, done, 'y');
    moved.x = slideDown(moved, done, 'x');
    moved.y = slideDown(moved, done, 'y'); // une 2e descente après le glissement gauche
    done.push(moved);
  }
  let lengthCm = 0;
  for (const pl of done) {
    const bb = bounds(shapeOf(pl));
    lengthCm = Math.max(lengthCm, pl.y + bb.maxY);
  }
  return { placements: done, rollWidthCm: nest.rollWidthCm, lengthCm };
}

/** Aire de chevauchement (cm²) entre deux placements — le juge de validité
 * du banc A/B (doit être ~0 pour toute paire, marges comprises). */
export function placementsOverlapCm2(a: Placement, b: Placement, saCm: number): number {
  const pa = translate(contourWithSeamAllowance(a, saCm, a.rot), a.x, a.y);
  const pb = translate(contourWithSeamAllowance(b, saCm, b.rot), b.x, b.y);
  const inter = intersectD([pa], [pb], FillRule.NonZero);
  let area = 0;
  for (const c of inter) area += Math.abs(areaD(c));
  return area;
}
