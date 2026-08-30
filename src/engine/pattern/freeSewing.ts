/**
 * freeSewing — le pont FreeSewing → TOILE.
 *
 * FreeSewing (freesewing.dev, MIT) est une algèbre de patron paramétrique
 * 100 % JavaScript avec ~100 vêtements réels gradés aux mesures. Ce module
 * convertit un patron FreeSewing DÉJÀ DRAPÉ en pièces TOILE (`DraftPiece`) :
 * le contour de couture de chaque pièce, déplié si coupé sur pliure,
 * échantillonné et normalisé dans le repère UV [0,1]² de TOILE (v = 0 en
 * haut, comme le reste du moteur).
 *
 * PUR & DÉCOUPLÉ : ce module n'importe PAS FreeSewing. Il reçoit le patron
 * drapé par typage structurel — l'appelant fait l'`import()` dynamique de
 * FreeSewing (plusieurs centaines de ko de designs) au clic, hors du bundle
 * principal, exactement comme le tassement de marker (clipper2-ts).
 */
import type { DraftPiece, UV } from './Draft';

/** Vue minimale d'un patron FreeSewing drapé (typage structurel). */
export interface FsPoint { x: number; y: number }
export interface FsPath {
  length(): number;
  bbox(): { topLeft: FsPoint; bottomRight: FsPoint };
  shiftFractionAlong(fraction: number): FsPoint;
}
export interface FsPart {
  hidden?: boolean;
  paths: Record<string, FsPath>;
  points: Record<string, FsPoint>;
}
export interface FsPattern { parts: Array<Record<string, FsPart>> }

export interface FsPieceOptions {
  /** Points échantillonnés le long du contour avant simplification. */
  samples?: number;
  /** Tolérance de simplification Ramer–Douglas–Peucker, en mm. */
  rdpMm?: number;
  /**
   * Noms courts de pièces à DÉPLIER même sans repère « cut on fold » — pour
   * les demi-pièces coupées ×2 avec couture milieu (ex. dos de buste Bella) :
   * le miroir reconstitue la pièce entière, la couture milieu droite devient
   * une pliure (approximation assumée : on perd la fente/fermeture).
   */
  unfold?: string[];
}

/** Ramer–Douglas–Peucker sur une polyligne (mm), tolérance en mm. */
function rdp(pts: readonly [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const distToSeg = (p: readonly number[], a: readonly number[], b: readonly number[]): number => {
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p[0]! - a[0]!, p[1]! - a[1]!);
    const t = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / l2));
    return Math.hypot(p[0]! - (a[0]! + t * dx), p[1]! - (a[1]! + t * dy));
  };
  let dmax = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return [...left.slice(0, -1), ...right];
  }
  return [[pts[0]![0], pts[0]![1]], [pts[pts.length - 1]![0], pts[pts.length - 1]![1]]];
}

/**
 * Déplie une pièce coupée sur pliure. `pts` = contour du demi-patron
 * échantillonné (mm). L'axe de pliure est le côté (x min ou x max) qui
 * porte le plus de points colinéaires ; le demi-contour (points hors de
 * l'axe) est reflété pour reconstituer la pièce entière et symétrique.
 */
function unfoldOnAxis(
  pts: readonly [number, number][],
  allowCurvedEdge = false,
): { contour: [number, number][]; axisX: number | null } {
  const n = pts.length;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const tol = Math.max(1.5, (maxX - minX) * 0.01);
  const nearMin = pts.filter(([x]) => Math.abs(x - minX) < tol).length;
  const nearMax = pts.filter(([x]) => Math.abs(x - maxX) < tol).length;
  const axisX = nearMin >= nearMax ? minX : maxX;
  // Bord de pliure = la COURSE CONTIGUË du contour qui longe l'axe — pas une
  // simple bande en x : un bord milieu GALBÉ (couture dos-milieu cintrée de
  // Bella : droite en haut puis s'écartant jusqu'à ~17 mm vers l'ourlet)
  // déborde de la bande, survivait au filtre et se miroitait en FENTE dessinée
  // dans le contour (vu au banc : dos fendu du col à la taille). On prend donc
  // la plus longue course de points EN BANDE, puis on l'ÉTEND aux deux bouts
  // tant que le contour reste près de l'axe (le galbe, borné à 10 % de la
  // largeur) — l'encolure/l'ourlet s'écartent vite et arrêtent l'extension.
  const inBand = (i: number): boolean => Math.abs(pts[i]![0] - axisX) < tol;
  let anchor = -1;
  for (let i = 0; i < n; i++) if (!inBand(i)) { anchor = i; break; }
  if (anchor < 0) return { contour: pts.map((p) => [p[0], p[1]]), axisX: null };
  let best: number[] = [];
  let cur: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (anchor + k) % n;
    if (inBand(i)) {
      cur.push(i);
    } else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  if (best.length < 2) return { contour: pts.map((p) => [p[0], p[1]]), axisX: null };
  // L'extension au galbe ne vaut que pour un dépliage FORCÉ (couture milieu
  // potentiellement cintrée) : une VRAIE pliure « cut on fold » est droite par
  // définition, et étendre y mangerait des points d'encolure (col tronqué de
  // ~1 cm, mesuré sur Teagan) — bande fine inchangée pour elles.
  const galbeMax = allowCurvedEdge ? 0.1 * (maxX - minX) : tol;
  let a = best[0]!;
  let b = best[best.length - 1]!;
  for (let guard = 0; guard < n / 4; guard++) {
    const j = (a - 1 + n) % n;
    if (j === b || Math.abs(pts[j]![0] - axisX) >= galbeMax) break;
    a = j;
  }
  for (let guard = 0; guard < n / 4; guard++) {
    const j = (b + 1) % n;
    if (j === a || Math.abs(pts[j]![0] - axisX) >= galbeMax) break;
    b = j;
  }
  const dropArr: number[] = [];
  for (let k = a; ; k = (k + 1) % n) { dropArr.push(k); if (k === b) break; }
  // Garde-fou : un « bord » qui mangerait la moitié du contour n'en est pas un.
  if (dropArr.length > n / 2) return { contour: pts.map((p) => [p[0], p[1]]), axisX: null };
  const drop = new Set(dropArr);
  // Demi-contour dans l'ordre CIRCULAIRE en partant juste après le bord retiré
  // (le seam peut commencer n'importe où, y compris sur la pliure — repartir
  // du tableau brut aurait coupé la course en deux).
  const half: [number, number][] = [];
  for (let k = 1; k <= n; k++) {
    const i = (b + k) % n;
    if (!drop.has(i)) half.push([pts[i]![0], pts[i]![1]]);
  }
  if (half.length < 2) return { contour: pts.map((p) => [p[0], p[1]]), axisX: null };
  // Miroir du demi-contour par l'axe, parcouru en sens inverse → l'autre moitié.
  const mirror: [number, number][] = half
    .slice()
    .reverse()
    .map(([x, y]) => [2 * axisX - x, y]);
  return { contour: [...half, ...mirror], axisX };
}

/**
 * Pièces TOILE issues d'un patron FreeSewing drapé. Chaque pièce visible
 * dotée d'un contour `seam` devient un `DraftPiece` : contour déplié,
 * normalisé (v = 0 en haut), simplifié. Les dimensions physiques (m) sortent
 * de la boîte englobante en mm. L'assemblage (rôles, coutures) est laissé à
 * l'appelant — comme pour l'import openpattern.
 */
export function freeSewingPieces(
  pattern: FsPattern,
  opts: FsPieceOptions = {},
): Array<{ name: string; piece: DraftPiece; points?: Record<string, UV> }> {
  const samples = Math.max(24, Math.min(400, opts.samples ?? 120));
  const rdpMm = opts.rdpMm ?? 2;
  const set = pattern.parts?.[0] ?? {};
  const out: Array<{ name: string; piece: DraftPiece; points?: Record<string, UV> }> = [];
  for (const [name, part] of Object.entries(set)) {
    const seam = part.paths?.seam;
    if (!seam || part.hidden) continue;
    // Échantillonnage uniforme en longueur d'arc le long du contour fermé.
    const raw: [number, number][] = [];
    for (let i = 0; i < samples; i++) {
      const p = seam.shiftFractionAlong(i / samples);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      raw.push([p.x, p.y]);
    }
    if (raw.length < 3) continue;
    const shortName = name.replace(/^[^.]*\./, ''); // "aaron.front" → "front"
    const hasFoldMark = Object.keys(part.paths).some((k) => /cutonfold/i.test(k));
    const forcedUnfold = !hasFoldMark && (opts.unfold?.includes(shortName) ?? false);
    const onFold = hasFoldMark || forcedUnfold;
    const unfolded = onFold ? unfoldOnAxis(raw, forcedUnfold) : null;
    const contourMm = unfolded ? unfolded.contour : raw;
    // Boîte englobante → dimensions physiques.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of contourMm) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const wMm = Math.max(1e-6, maxX - minX);
    const hMm = Math.max(1e-6, maxY - minY);
    // Simplifier PUIS normaliser. v = 0 en haut : FreeSewing a y croissant vers
    // le bas (SVG), donc v = (y − minY)/h place déjà le haut en v = 0.
    const simplified = rdp(contourMm, rdpMm);
    // Retirer le point de fermeture s'il duplique le premier.
    if (
      simplified.length > 1 &&
      Math.hypot(simplified[0]![0] - simplified[simplified.length - 1]![0], simplified[0]![1] - simplified[simplified.length - 1]![1]) < rdpMm
    ) {
      simplified.pop();
    }
    if (simplified.length < 3) continue;
    const outline: UV[] = simplified.map(([x, y]) => [
      +((x - minX) / wMm).toFixed(4),
      +((y - minY) / hMm).toFixed(4),
    ]);
    // Points NOMMÉS du patron (fork, dartTip, waist…) dans le MÊME repère UV
    // que le contour — pour des coutures sémantiques et l'extraction de PINCES.
    // Pour une pièce DÉPLIÉE, le bbox est celui du contour entier : le point
    // d'origine tombe dans sa moitié, et son MIROIR par l'axe de pliure est
    // émis sous « nom~m » (la pince de l'autre moitié, etc.).
    const points: Record<string, UV> = {};
    const emit = (pname: string, x: number, y: number) => {
      points[pname] = [+((x - minX) / wMm).toFixed(4), +((y - minY) / hMm).toFixed(4)];
    };
    for (const [pname, pt] of Object.entries(part.points ?? {})) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      emit(pname, pt.x, pt.y);
      if (unfolded?.axisX != null) emit(pname + '~m', 2 * unfolded.axisX - pt.x, pt.y);
    }
    out.push({
      name: shortName,
      points,
      piece: {
        outline,
        darts: [],
        seams: [],
        openEdges: [],
        width: wMm / 1000,
        height: hMm / 1000,
        topY: 1.5,
        gap: 0.9,
        name: shortName,
      },
    });
  }
  return out;
}
