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
function unfoldOnAxis(pts: readonly [number, number][]): [number, number][] {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const tol = Math.max(1.5, (maxX - minX) * 0.01);
  const nearMin = pts.filter(([x]) => Math.abs(x - minX) < tol).length;
  const nearMax = pts.filter(([x]) => Math.abs(x - maxX) < tol).length;
  const axisX = nearMin >= nearMax ? minX : maxX;
  // Demi-contour = points hors de l'axe (l'arc courbe), dans l'ordre du seam.
  const half = pts.filter(([x]) => Math.abs(x - axisX) >= tol);
  if (half.length < 2) return pts.map((p) => [p[0], p[1]]);
  // Miroir du demi-contour par l'axe, parcouru en sens inverse → l'autre moitié.
  const mirror: [number, number][] = half
    .slice()
    .reverse()
    .map(([x, y]) => [2 * axisX - x, y]);
  return [...half.map((p) => [p[0], p[1]] as [number, number]), ...mirror];
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
    const onFold = Object.keys(part.paths).some((k) => /cutonfold/i.test(k));
    const contourMm = onFold ? unfoldOnAxis(raw) : raw;
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
    const shortName = name.replace(/^[^.]*\./, ''); // "aaron.front" → "front"
    // Points NOMMÉS du patron (fork, waist, knee, floor…) dans le MÊME repère UV
    // que le contour — pour des coutures sémantiques (pantalon). Non fournis
    // pour une pièce sur pliure (le dépliage rendrait le mapping ambigu).
    let points: Record<string, UV> | undefined;
    if (!onFold) {
      points = {};
      for (const [pname, pt] of Object.entries(part.points ?? {})) {
        if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
        points[pname] = [+((pt.x - minX) / wMm).toFixed(4), +((pt.y - minY) / hMm).toFixed(4)];
      }
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
