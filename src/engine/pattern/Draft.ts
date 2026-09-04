/**
 * Draft — the freeform pattern document (the "atelier" 2D→3D editor).
 *
 * A draft is a first-class, UV-native description of a hand-drawn pattern
 * piece: an outline polygon, interior darts (wedges sewn shut to shape the
 * flat piece into 3D), hand-defined seams (two boundary runs sewn together),
 * and open edges (boundary left unsewn so the garment is wearable). It is the
 * single source of truth for freeform work, kept ENTIRELY separate from the
 * parametric archetypes — it compiles down to the same cloth mesh via the
 * existing generateSeamedPanels machinery (a polygon → a kept mask; a dart →
 * a mask notch + leg seams; a seam → cross-seam pairs).
 *
 * All coordinates are in pattern UV [0,1]², the same space generateSeamedPanels
 * samples, with v growing DOWNWARD (world y = topY − v·height), like the
 * archetypes. This module is pure (no engine/GPU imports) and unit-testable.
 */

import { clampFabricGsm } from '../solver/FabricMaterial';

export type UV = [number, number];

/** An interior wedge, sewn shut to cup the flat piece into 3D (bust/waist dart). */
export interface Dart {
  apex: UV; // strictly inside the outline
  legA: UV; // mouth corner, on/near the boundary
  legB: UV; // mouth corner, on/near the boundary
}

/** A contiguous slice of the outline, by vertex index (inclusive), walked CCW. */
export interface EdgeRun {
  from: number;
  to: number;
}

/** Sew two boundary runs of the piece together (dart-independent join). */
export interface HandSeam {
  a: EdgeRun;
  b: EdgeRun;
}

/** An outline edge on a named piece. A run identifies its piece either by the
 * legacy `face` ('front'=piece 0, 'back'=piece 1) OR by an explicit `pieceId`
 * (0=front, 1=back, ≥2=free pieces). `pieceIdOf` normalises the two; `face` is
 * kept so pre-N-piece drafts/tests keep round-tripping byte-identically. */
export interface FaceRun {
  face?: 'front' | 'back';
  pieceId?: number;
  from: number;
  to: number;
}

/** Normalised piece index of a run (pieceId wins; else face → 0/1). */
export function pieceIdOf(r: FaceRun): number {
  return r.pieceId ?? (r.face === 'back' ? 1 : 0);
}

/** A user-defined ASSEMBLY seam: sew a run of one face to a run of another
 * (or the same) face. This is the manual "click edge A, click edge B" join —
 * front↔back shoulders/sides, or within one face. */
export interface AssemblySeam {
  a: FaceRun;
  b: FaceRun;
  /**
   * A missing kind is the historical, ordinary stitch. `zipper` keeps the
   * same two-run topology while letting the editor and future garment controls
   * present it as a removable closure rather than a permanent seam.
   */
  kind?: 'seam' | 'zipper';
  /** Zippers are assembled only while closed. Irrelevant to ordinary seams. */
  closed?: boolean;
}

/** Whether an assembly link currently contributes physical seam constraints. */
export function assemblySeamIsClosed(seam: AssemblySeam): boolean {
  return seam.kind !== 'zipper' || seam.closed !== false;
}

export type PiecePlacementRole =
  | 'auto'
  | 'front'
  | 'back'
  | 'armL'
  | 'armR'
  | 'neck'
  | 'waist'
  | 'legL'
  | 'legR'
  | 'pocket'
  | 'free';

export interface PiecePlacement {
  /** Human/body role used by the guided pre-placement assistant. */
  role: PiecePlacementRole;
  /** Align the piece rigidly to its sewn edges before physics starts. */
  autoAlign?: boolean;
  /** Reverse the entering edge order when the preview shows a half-twist. */
  reverseSeam?: boolean;
  /**
   * Patch/pocket placement on the surface of another pattern piece. The
   * overlay keeps its own physical dimensions; `anchor` is the exact point on
   * the support under the overlay's centre. Each entry in `stitchedEdges`
   * represents one independently removable top-stitch.
   */
  surface?: SurfaceAttachment;
}

export interface SurfaceAttachment {
  supportPieceId: number;
  anchor: UV;
  rotationRad?: number;
  stitchedEdges: number[];
  /**
   * De quel côté du support la pièce vit : 'over' (défaut — poche, empiècement
   * superposé) ou 'under' (doublure, fond — glissée ENTRE le corps et le
   * support). La même contrainte unilatérale s'exerce vers l'intérieur.
   */
  side?: 'over' | 'under';
}

/** Une image posée sur une pièce de coupe, dans le repère de la pièce. */
export interface PieceGraphic {
  /** PNG ou JPEG en data URL, déjà réduit à l'import (≤ ~256 Ko). */
  image: string;
  /** Centre du graphique dans le [0,1]² de la pièce. */
  anchor: UV;
  /** Largeur RÉELLE imprimée, en mètres ; la hauteur suit `aspect`. */
  widthM: number;
  /** Ratio hauteur/largeur de l'image, figé à l'import. */
  aspect: number;
  /** Rotation dans le plan de la pièce, en radians (sens patron). */
  rotationRad: number;
  /**
   * MOTIF : l'image se RÉPÈTE sur toute la pièce (widthM = taille d'UNE
   * répétition, l'ancre en règle la phase, la rotation la direction).
   * Absent/false : graphique posé une seule fois.
   */
  repeat?: boolean;
}

/** Taille max du data URL embarqué (≈256 Ko d'image encodée). */
export const GRAPHIC_IMAGE_MAX_CHARS = 360_000;

/** ▱ LIGNE INTERNE — polyligne ou polygone DANS une pièce : ligne de style,
 * pliure, surpiqûre, repère de placement. Points en UV du cadre (comme les
 * pinces et l'ancre du graphique : ils suivent les changements de cadre). */
export interface InternalLine {
  points: UV[];
  /** true = polygone fermé (le dernier point rejoint le premier). */
  closed?: boolean;
  /** ⌾ TROU : ce polygone FERMÉ évide la pièce — les cellules intérieures
   * sortent du maillage, l'export l'imprime en trait de coupe plein.
   * Ignoré sur une polyligne ouverte. */
  hole?: boolean;
  /** Courbe lisse : les points deviennent des points de passage d'une
   * spline Catmull-Rom, le rendu interpole entre eux. */
  smooth?: boolean;
  /** Indices des points « coin » (angle vif) dans une ligne lisse. */
  corners?: number[];
}

export function catmullRomSubdivide(pts: readonly UV[], closed: boolean, samples = 8, cornerSet?: ReadonlySet<number>): UV[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [...p] as UV);
  const out: UV[] = [];
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    if (cornerSet && (cornerSet.has(i) || cornerSet.has((i + 1) % n))) {
      out.push([...p1] as UV);
      continue;
    }
    const p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)]!;
    for (let j = 0; j < samples; j++) {
      const t = j / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const u: number = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const v: number = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([u, v]);
    }
  }
  if (!closed) out.push([...pts[n - 1]!] as UV);
  return out;
}
export const INTERNAL_LINES_MAX = 24;
export const INTERNAL_LINE_POINTS_MAX = 64;

/** ⌾ Les polygones-TROUS d'une pièce (lignes internes fermées marquées hole),
 * prêts pour la soustraction du masque de rasterisation. */
export function pieceHolePolygons(piece: Pick<DraftPiece, 'internalLines'>): UV[][] {
  return (piece.internalLines ?? [])
    .filter((line) => line.closed === true && line.hole === true && line.points.length >= 3)
    .map((line) => line.points.map((p) => [...p] as UV));
}

/** ⌵ CRAN DE MONTAGE (le « Notch » de Clo) : un repère d'alignement sur le
 * bord — petit trait perpendiculaire, imprimé sur le patron. Ancré en UV
 * (comme les lignes internes) : il suit les changements de cadre et se
 * projette sur le bord le plus proche au rendu. */
export interface PieceNotch {
  at: UV;
}
export const NOTCHES_MAX = 64;

/**
 * Coordonnée GRAPHIQUE (repère [0,1]² de l'image, y vers le bas) du point
 * (u,v) de la pièce — l'inverse ancre/rotation/échelle, en espace MÉTRIQUE
 * pour que la rotation reste vraie sur une pièce non carrée. Hors de l'image,
 * les valeurs sortent de [0,1] (l'appelant borne ou masque). Pure.
 */
export function graphicLocalUV(
  graphic: PieceGraphic,
  pieceWidthM: number,
  pieceHeightM: number,
  u: number,
  v: number,
): [number, number] {
  const dxM = (u - graphic.anchor[0]) * pieceWidthM;
  const dyM = (v - graphic.anchor[1]) * pieceHeightM;
  const c = Math.cos(-graphic.rotationRad);
  const s = Math.sin(-graphic.rotationRad);
  const rxM = dxM * c - dyM * s;
  const ryM = dxM * s + dyM * c;
  const w = Math.max(1e-6, graphic.widthM);
  const h = Math.max(1e-6, graphic.widthM * Math.max(1e-6, graphic.aspect));
  return [rxM / w + 0.5, ryM / h + 0.5];
}

export interface DraftPiece {
  outline: UV[]; // closed polygon, ≥3 pts, in [0,1]²
  darts: Dart[];
  seams: HandSeam[];
  openEdges: EdgeRun[]; // boundary runs left OPEN (not mirror-sewn) — e.g. the neckline
  /** Human cutting-room metadata. It stays attached while the piece is edited,
   * exported and re-imported, but does not change its geometry. */
  name?: string;
  cut?: number;
  onFold?: boolean;
  /** A construction piece shown/editable in the 2D atelier but intentionally
   * excluded from cloth simulation (pocket bags, fly pieces, waistband…). */
  patternOnly?: boolean;
  /**
   * UNE SEULE FEUILLE physique : la pièce libre renonce à son panneau jumeau
   * (le mécanisme du masque arrière vide des poches). Pour une pièce PLATE
   * dont chaque bord est soit ouvert soit cousu ailleurs (le demi-devant
   * droit d'une veste), le jumeau ne serait cousu à rien et tomberait au sol
   * en fantôme — observé sur la veste v196.
   */
  singlePanel?: boolean;
  /**
   * SOCLE VIDE : cette face de base n'existe pas encore — contour sentinelle
   * minuscule qui ne rasterise AUCUNE cellule, invisible dans le plan et la 3D.
   * C'est l'état « je pars de zéro » : l'utilisateur trace ses pièces libres
   * sans qu'aucun vêtement socle n'apparaisse.
   */
  blank?: boolean;
  /**
   * Optional fabric assigned to this cutting piece. Absent means that the
   * piece follows the live global fabric selected in the material panel.
   */
  fabricPreset?: import('../solver/FabricMaterial').FabricPresetName;
  /** Piece-specific fabric mass in g/m². Absent means preset/global default. */
  arealDensityGsm?: number;
  /**
   * Couleur d'EMPIÈCEMENT ('#rrggbb') : habille cette pièce de coupe d'une
   * couleur unie choisie, indépendamment du tissu (qui garde la physique et
   * son grain). Absente, le tissu — de la pièce ou global — décide du rendu.
   */
  color?: string;
  /**
   * GRAPHIQUE de pièce (le « Graphic » de Clo) : une image posée sur la pièce
   * — logo, print — éditable sur le plan 2D (déplacer, taille, rotation) et
   * drapée sur le côté endroit du tissu à l'essayage. Un graphique par pièce.
   */
  graphic?: PieceGraphic;
  /** ▱ Lignes internes (style, pliure, repères) — optionnel. */
  internalLines?: InternalLine[];
  /** ⌵ Crans de montage — optionnel. */
  notches?: PieceNotch[];
  // Physical placement in meters — mirrors generateSeamedPanels.
  width: number;
  height: number;
  topY: number;
  gap: number;
  // WRAP MODE (free pieces only): spawn the piece wrapped around a body part —
  // its two panels straddle it in z — instead of flat in front of the body.
  // With its rim mirror-stitched along both long edges (the default), the
  // piece closes into a TUBE ; its top run cross-sewn makes a real sleeve
  // ('armL'/'armR', tilted to the arm's A-pose) or a NECKBAND ('neck', the
  // ring that cinches the neckline — cut shorter than the neck hole, it pulls
  // the collar in and lets a deep front drop hold). Absent → flat spawn.
  wrap?: 'armL' | 'armR' | 'neck';
  /**
   * Bande asymétrique (col en V) : facteur (<1) qui raccourcit le rest du
   * tissage HORIZONTAL du panneau DOS (panel 1) du tube. Le devant garde sa
   * longueur (il borde le V, plus long), le dos se resserre pour froncer au
   * lieu de gondoler. Absent/≥1 → aucun effet (bande symétrique).
   */
  backWeaveScale?: number;
  /** Simulation placement metadata. Independent from the movable 2D layout. */
  placement?: PiecePlacement;
  /**
   * Translation used only to arrange the frozen pieces in the 3D preparation
   * view. It never changes the pattern geometry and is deliberately ignored
   * by the final assembly/simulation spawn.
   */
  stagingOffset?: [number, number, number];
  /**
   * Preparation translations for repeated physical instances of the same
   * cutting piece (for example the left and right trouser fronts). Each copy
   * can be arranged independently in 3D while sharing one editable 2D pattern.
   */
  stagingOffsets?: Array<[number, number, number] | null>;
  /**
   * Preparation rotations (quaternion [x, y, z, w]) for repeated physical
   * instances, applied about each copy's centroid at the arrangement spawn.
   * Like the translation offsets they are preparation-only and honoured by
   * the essayage only when the anatomical pre-assembly is active. Absent or
   * identity ⇒ no rotation.
   */
  stagingOrients?: Array<[number, number, number, number] | null>;
  /**
   * v263 — la RECETTE d'arrangement par instance : le modèle `<Arrangement>`
   * du Pacx CLO. La pièce est ancrée à un volume d'encadrement du corps
   * (volume + X autour + Y le long + offset radial en mm). Contrairement aux
   * stagingOffsets (positions absolues figées), la recette exprime
   * l'INTENTION — elle se réévalue sur le corps COURANT : changer de
   * mannequin ou de pose re-range la pièce sur sa même ancre corporelle.
   */
  arrange?: Array<{ volume: string; xPct: number; yPct: number; offsetMm: number } | null>;
}

export interface DraftDoc {
  format: 'toile-draft';
  version: 1;
  gridN: 32 | 64 | 128; // authoring/sim resolution
  piece: DraftPiece; // the FRONT face
  back?: DraftPiece; // optional INDEPENDENT back face (côte-à-côte). Absent/blank → the back mirrors the front.
  // MANUAL assembly (CLO-style): when true, NOTHING is auto-sewn — the garment
  // holds only where the user defined `seams`. Absent/false → the old automatic
  // perimeter sew (back-compat with pre-manual saved drafts).
  manual?: boolean;
  seams?: AssemblySeam[]; // user-defined assembly seams (edge A ↔ edge B, cross-face)
  // Editing-only constraints: two outline edges whose length changes stay
  // synchronised. Same endpoint shape as AssemblySeam, but no physical stitch
  // is generated from these links.
  segmentLinks?: AssemblySeam[];
  // FREE pieces (multi-piece editor): extra hand-drawn pieces beyond front/back.
  // Index 0 here is pieceId 2, index 1 is pieceId 3, … Each becomes its own mesh
  // combined onto the base via combineClothMeshes (see compileCrossSeams). Absent
  // ⇒ the garment is exactly the front/back base (byte-identical to pre-N-piece).
  pieces?: DraftPiece[];
  /** Optional built-in construction whose assembly needs more than the generic
   * front/back tube (currently the mirrored two-leg loose-pants assembly). */
  preset?: 'loose-pants' | 'lucas-hoodie' | 'jupe' | 'robe' | 'veste' | 'doudoune';
  presetSize?: string;
}

/** All pieces of a doc indexed by pieceId: [front, back, ...free]. Slots may be
 * null (no back drawn yet). Free pieces start at index 2. */
export function docPieces(doc: DraftDoc): (DraftPiece | null)[] {
  return [doc.piece, doc.back ?? null, ...(doc.pieces ?? [])];
}

/** One stable human label everywhere the same pieceId is displayed or exported. */
export function draftPieceLabel(
  piece: DraftPiece | null | undefined,
  pieceId: number,
): string {
  const named = piece?.name?.trim();
  if (named) return named;
  if (pieceId === 0) return 'Devant';
  if (pieceId === 1) return 'Dos';
  if (piece?.wrap === 'armR') return 'Manche droite';
  if (piece?.wrap === 'armL') return 'Manche gauche';
  if (piece?.wrap === 'neck') return 'Col';
  return `Pièce ${pieceId + 1}`;
}

/** Every outline segment starts sewn for an appliqué; the user can open any
 * segment afterwards (for example the top of a patch pocket). */
export function defaultSurfaceStitches(piece: DraftPiece): number[] {
  return piece.outline.map((_point, edge) => edge);
}

/** Exact support UV under one overlay UV, preserving metric size and allowing
 * a future rotation without baking placement into the cutting geometry. */
export function surfaceAttachmentUV(
  overlay: DraftPiece,
  support: DraftPiece,
  surface: SurfaceAttachment,
  overlayUV: readonly [number, number],
): UV {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [u, v] of overlay.outline) {
    const x = (u - 0.5) * overlay.width;
    const y = overlay.topY - v * overlay.height;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const cy = Number.isFinite(minY) ? (minY + maxY) / 2 : overlay.topY - overlay.height / 2;
  const x = (overlayUV[0] - 0.5) * overlay.width - cx;
  const y = overlay.topY - overlayUV[1] * overlay.height - cy;
  const angle = surface.rotationRad ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const anchorX = (surface.anchor[0] - 0.5) * support.width;
  const anchorY = support.topY - surface.anchor[1] * support.height;
  const targetX = anchorX + x * cos - y * sin;
  const targetY = anchorY + x * sin + y * cos;
  return [
    targetX / support.width + 0.5,
    (support.topY - targetY) / support.height,
  ];
}

/** Ray-cast point-in-polygon (odd crossings = inside). Winding-agnostic. */
export function pointInPolygon(p: UV, poly: readonly UV[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    // Edge straddles the horizontal ray from p going +x?
    if ((yi > p[1]) !== (yj > p[1])) {
      const xCross = xi + ((p[1] - yi) / (yj - yi)) * (xj - xi);
      if (p[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Barycentric point-in-triangle (inclusive of the edges). */
export function pointInTriangle(p: UV, a: UV, b: UV, c: UV): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos); // all same sign (or on an edge) ⇒ inside
}

function sign(p: UV, a: UV, b: UV): number {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}

/** True if the closed polygon has any non-adjacent edge crossing (self-intersecting). */
export function isSelfIntersecting(poly: readonly UV[]): boolean {
  const n = poly.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip shared-vertex neighbours (adjacent edges always "touch").
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % n]!;
      if (segsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function segsCross(p1: UV, p2: UV, p3: UV, p4: UV): boolean {
  const d1 = sign(p3, p4, p1);
  const d2 = sign(p3, p4, p2);
  const d3 = sign(p1, p2, p3);
  const d4 = sign(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** Squared distance from point p to segment a-b. */
function segDist2(p: UV, a: UV, b: UV): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const len2 = abx * abx + aby * aby || 1e-12;
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2));
  const dx = a[0] + t * abx - p[0];
  const dy = a[1] + t * aby - p[1];
  return dx * dx + dy * dy;
}

/** Index of the outline edge (k = vertex k → vertex (k+1)%N) nearest to p. */
export function nearestOutlineEdge(p: UV, outline: readonly UV[]): number {
  const N = outline.length;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < N; k++) {
    const d = segDist2(p, outline[k]!, outline[(k + 1) % N]!);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Does the edge-run (vertices from..to, CCW) contain outline edge `edge`? */
export function runCoversEdge(run: EdgeRun, edge: number, nV: number): boolean {
  const steps = (run.to - run.from + nV) % nV; // number of edges spanned
  for (let k = 0; k < steps; k++) if ((run.from + k) % nV === edge) return true;
  return false;
}

/** Shift an edge-run's indices when a vertex is inserted at position `at`. */
function shiftRunInsert(r: EdgeRun, at: number): EdgeRun {
  return { from: r.from >= at ? r.from + 1 : r.from, to: r.to >= at ? r.to + 1 : r.to };
}

/** Shift/clamp an edge-run when the vertex at `at` is removed (nV = new length). */
function shiftRunDelete(r: EdgeRun, at: number, nV: number): EdgeRun {
  const adj = (i: number): number => Math.min(nV - 1, Math.max(0, i > at ? i - 1 : i === at ? Math.max(0, at - 1) : i));
  return { from: adj(r.from), to: adj(r.to) };
}

function surfaceAfterInsert(
  placement: PiecePlacement | undefined,
  edge: number,
): PiecePlacement | undefined {
  const surface = placement?.surface;
  if (!surface) return placement;
  const shifted = new Set<number>();
  for (const sewn of surface.stitchedEdges) {
    if (sewn < edge) shifted.add(sewn);
    else if (sewn === edge) {
      shifted.add(edge);
      shifted.add(edge + 1);
    } else shifted.add(sewn + 1);
  }
  return {
    ...placement,
    surface: { ...surface, stitchedEdges: [...shifted].sort((a, b) => a - b) },
  };
}

function surfaceAfterDelete(
  placement: PiecePlacement | undefined,
  at: number,
  oldLength: number,
): PiecePlacement | undefined {
  const surface = placement?.surface;
  if (!surface) return placement;
  const previous = (at + oldLength - 1) % oldLength;
  const nextLength = Math.max(1, oldLength - 1);
  const merged = at === 0 ? nextLength - 1 : at - 1;
  const shifted = new Set<number>();
  for (const sewn of surface.stitchedEdges) {
    if (sewn === previous || sewn === at) shifted.add(merged);
    else if (sewn > at) shifted.add(sewn - 1);
    else shifted.add(Math.min(sewn, nextLength - 1));
  }
  return {
    ...placement,
    surface: { ...surface, stitchedEdges: [...shifted].sort((a, b) => a - b) },
  };
}

/**
 * Insert a new outline vertex right after edge `edge` (i.e. between vertices
 * `edge` and `edge+1`), at UV `uv`. Returns a NEW piece with openEdges/seam
 * runs re-indexed so they still point at the same boundary. Pure.
 */
export function insertOutlineVertex(piece: DraftPiece, edge: number, uv: UV): DraftPiece {
  const at = edge + 1; // new vertex index
  const outline = [...piece.outline.slice(0, at), [uv[0], uv[1]] as UV, ...piece.outline.slice(at)];
  return {
    ...piece,
    outline,
    openEdges: piece.openEdges.map((r) => shiftRunInsert(r, at)),
    seams: piece.seams.map((s) => ({ a: shiftRunInsert(s.a, at), b: shiftRunInsert(s.b, at) })),
    placement: surfaceAfterInsert(piece.placement, edge),
  };
}

/**
 * Comme nearestOutlineEdge, mais rend AUSSI la distance — le pont « clic 3D →
 * bord à coudre » : une particule (sa cellule → UV) choisit le bord de patron
 * qu'elle longe, et un clic trop loin de tout bord est rejeté. Pure.
 */
export function nearestOutlineEdgeInfo(p: UV, outline: readonly UV[]): { edge: number; dist: number } {
  const N = outline.length;
  let edge = 0;
  let d2 = Infinity;
  for (let k = 0; k < N; k++) {
    const d = segDist2(p, outline[k]!, outline[(k + 1) % N]!);
    if (d < d2) {
      d2 = d;
      edge = k;
    }
  }
  return { edge, dist: Math.sqrt(d2) };
}

/**
 * Décaler le contour d'une pièce DANS sa boîte (déplacement 3D → glissement du
 * masque), pinces comprises, borné pour que l'emprise reste dans [0,1]².
 * Renvoie une NOUVELLE pièce ; les index de bords ne bougent pas (coutures et
 * bords ouverts restent valides). Pure.
 */
/** L'ancre d'un graphique suit la MÊME transformation UV que le contour et
 * les pinces quand le cadre d'une pièce change — la taille et la rotation du
 * print sont MÉTRIQUES donc invariantes ; seule l'ancre vit en UV de cadre. */
function remapGraphicAnchor(
  piece: DraftPiece,
  map: (p: UV) => UV,
): Pick<DraftPiece, 'graphic' | 'internalLines'> {
  return {
    ...(piece.graphic
      ? { graphic: { ...piece.graphic, anchor: map(piece.graphic.anchor) } }
      : {}),
    ...(piece.internalLines?.length
      ? {
          internalLines: piece.internalLines.map((line) => ({
            ...line,
            points: line.points.map((pt) => map(pt)),
          })),
        }
      : {}),
    ...(piece.notches?.length
      ? { notches: piece.notches.map((notch) => ({ at: map(notch.at) })) }
      : {}),
  };
}

export function shiftOutlineUV(piece: DraftPiece, du: number, dv: number): DraftPiece {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [u, v] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const cu = Math.max(-uMin, Math.min(1 - uMax, du));
  const cv = Math.max(-vMin, Math.min(1 - vMax, dv));
  const sh = ([u, v]: UV): UV => [u + cu, v + cv];
  return {
    ...piece,
    outline: piece.outline.map(sh),
    darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
    ...remapGraphicAnchor(piece, sh),
  };
}

/**
 * Déplacer une pièce LIBRE sans limite (patronner en 3D). Vertical : la boîte
 * suit (topY += dy, le contour ne bouge pas dedans). Horizontal : le contour
 * glisse dans sa boîte ; s'il déborde, la boîte S'ÉLARGIT symétriquement —
 * x = (u−0.5)·width est centré sur 0, donc poser une pièce loin du centre
 * demande une boîte qui couvre jusque-là — puis le contour est re-mappé à
 * géométrie monde constante. Pinces suivies, index de bords intacts. Pure.
 */
export function movePieceWorld(piece: DraftPiece, dx: number, dy: number): DraftPiece {
  const moved: DraftPiece = { ...piece, topY: piece.topY + dy };
  if (Math.abs(dx) < 1e-9) return moved;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const [u] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  const du = dx / piece.width;
  if (uMin + du >= 0 && uMax + du <= 1) {
    const sh = ([u, v]: UV): UV => [u + du, v];
    return {
      ...moved,
      outline: piece.outline.map(sh),
      darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
      ...remapGraphicAnchor(piece, sh),
    };
  }
  // Débordement : élargir la boîte pour couvrir le contour décalé (en monde).
  const xMinW = (uMin - 0.5) * piece.width + dx;
  const xMaxW = (uMax - 0.5) * piece.width + dx;
  const w2 = 2 * (Math.max(Math.abs(xMinW), Math.abs(xMaxW)) + 0.02);
  const sh = ([u, v]: UV): UV => [((u - 0.5) * piece.width + dx) / w2 + 0.5, v];
  return {
    ...moved,
    width: w2,
    outline: piece.outline.map(sh),
    darts: piece.darts.map((d) => ({ apex: sh(d.apex), legA: sh(d.legA), legB: sh(d.legB) })),
    ...remapGraphicAnchor(piece, sh),
  };
}

/**
 * Put two base faces into one shared physical frame without moving either
 * outline. `generateSeamedPanels` rasterises front and back on the front face's
 * frame, so an automatic frame expansion on one face must be mirrored onto the
 * other face or the untouched side would be stretched accidentally.
 */
export function syncPieceFrames(front: DraftPiece, back: DraftPiece): { front: DraftPiece; back: DraftPiece } {
  const physical = (piece: DraftPiece): { outline: [number, number][]; darts: [number, number][][] } => {
    const world = ([u, v]: UV): [number, number] => [(u - 0.5) * piece.width, piece.topY - v * piece.height];
    return {
      outline: piece.outline.map(world),
      darts: piece.darts.map((d) => [world(d.apex), world(d.legA), world(d.legB)]),
    };
  };
  const f = physical(front);
  const b = physical(back);
  let halfWidth = Math.max(front.width, back.width) / 2;
  let topY = Math.max(front.topY, back.topY);
  let bottomY = Math.min(front.topY - front.height, back.topY - back.height);
  for (const [x, y] of [...f.outline, ...b.outline, ...f.darts.flat(), ...b.darts.flat()]) {
    halfWidth = Math.max(halfWidth, Math.abs(x));
    topY = Math.max(topY, y);
    bottomY = Math.min(bottomY, y);
  }
  const width = Math.max(1e-4, halfWidth * 2);
  const height = Math.max(1e-4, topY - bottomY);
  const uv = ([x, y]: [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  const remap = (piece: DraftPiece, data: { outline: [number, number][]; darts: [number, number][][] }): DraftPiece => {
    const world = ([u, v]: UV): [number, number] => [(u - 0.5) * piece.width, piece.topY - v * piece.height];
    return {
      ...piece,
      width,
      height,
      topY,
      outline: data.outline.map(uv),
      darts: data.darts.map((d) => ({ apex: uv(d[0]!), legA: uv(d[1]!), legB: uv(d[2]!) })),
      ...remapGraphicAnchor(piece, (p) => uv(world(p))),
    };
  };
  return { front: remap(front, f), back: remap(back, b) };
}

/**
 * Déplacer une FACE du torse (devant 0 / dos 1) sans limite. Les deux faces
 * partagent LA boîte de base (le mesh est généré sur la boîte du devant) : la
 * face visée est décalée en MONDE, puis la boîte est re-taillée pour couvrir
 * les deux faces (+ marge), et les deux contours sont re-mappés à géométrie
 * monde constante. Les champs de boîte des deux pièces restent synchrones.
 * Rend { front, back } neufs. Pure.
 */
export function moveFaceWorld(
  front: DraftPiece,
  back: DraftPiece,
  which: 0 | 1,
  dx: number,
  dy: number,
): { front: DraftPiece; back: DraftPiece } {
  const box = front; // la boîte de référence du mesh de base
  const world = (piece: DraftPiece, mdx: number, mdy: number): { pts: [number, number][]; darts: [number, number][][] } => ({
    pts: piece.outline.map(([u, v]) => [(u - 0.5) * box.width + mdx, box.topY - v * box.height + mdy]),
    darts: piece.darts.map((d) => [d.apex, d.legA, d.legB].map(([u, v]) => [(u - 0.5) * box.width + mdx, box.topY - v * box.height + mdy])),
  });
  const wF = world(front, which === 0 ? dx : 0, which === 0 ? dy : 0);
  const wB = world(back, which === 1 ? dx : 0, which === 1 ? dy : 0);
  const PAD = 0.02;
  let xAbs = 0;
  let yTop = -Infinity;
  let yBot = Infinity;
  for (const [x, y] of [...wF.pts, ...wB.pts]) {
    xAbs = Math.max(xAbs, Math.abs(x));
    yTop = Math.max(yTop, y);
    yBot = Math.min(yBot, y);
  }
  const width = 2 * (xAbs + PAD);
  const topY = yTop + PAD;
  const height = Math.max(0.05, topY - yBot + PAD);
  const uv = ([x, y]: [number, number]): UV => [x / width + 0.5, (topY - y) / height];
  const rebox = (piece: DraftPiece, w: { pts: [number, number][]; darts: [number, number][][] }, mdx: number, mdy: number): DraftPiece => ({
    ...piece,
    width,
    height,
    topY,
    outline: w.pts.map(uv),
    darts: w.darts.map((t) => ({ apex: uv(t[0]!), legA: uv(t[1]!), legB: uv(t[2]!) })),
    ...remapGraphicAnchor(piece, ([u, v]) =>
      uv([(u - 0.5) * box.width + mdx, box.topY - v * box.height + mdy]),
    ),
  });
  return {
    front: rebox(front, wF, which === 0 ? dx : 0, which === 0 ? dy : 0),
    back: rebox(back, wB, which === 1 ? dx : 0, which === 1 ? dy : 0),
  };
}

/**
 * Re-boîter une pièce sur l'EMPRISE de son tracé : la boîte (width/height/topY)
 * devient le rectangle englobant du contour dessiné, contour et pinces re-mappés
 * en UV pour que la GÉOMÉTRIE MONDE reste identique. C'est le pont « zone de
 * confection libre » → placement : une pièce dessinée sur la silhouette
 * grandeur nature se re-boîte serrée (contour plein bord = la famille de
 * contours éprouvée pour les tubes v112) avant de s'enrouler autour d'un bras
 * ou du cou. `gap` est remplacé par celui du placement. Pure.
 */
export function reboxPiece(piece: DraftPiece, gap: number): DraftPiece {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [u, v] of piece.outline) {
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const w = (uMax - uMin) * piece.width;
  const h = (vMax - vMin) * piece.height;
  if (!(w > 1e-4) || !(h > 1e-4)) return piece; // tracé dégénéré : ne rien casser
  // Monde : x = (u − 0.5)·W (centre colonne 0), y = topY − v·H.
  const topY = piece.topY - vMin * piece.height;
  const cxWorld = ((uMin + uMax) / 2 - 0.5) * piece.width;
  const mapUV = ([u, v]: UV): UV => [
    ((u - 0.5) * piece.width - cxWorld) / w + 0.5,
    (topY - (piece.topY - v * piece.height)) / h,
  ];
  return {
    ...piece,
    width: w,
    height: h,
    topY,
    gap,
    outline: piece.outline.map(mapUV),
    darts: piece.darts.map((d) => ({ apex: mapUV(d.apex), legA: mapUV(d.legA), legB: mapUV(d.legB) })),
    ...remapGraphicAnchor(piece, mapUV),
  };
}

/**
 * Remove the outline vertex at `index` (no-op if that would leave < 3 vertices).
 * Returns a NEW piece with openEdges/seam runs re-indexed. Pure.
 */
export function deleteOutlineVertex(piece: DraftPiece, index: number): DraftPiece {
  if (piece.outline.length <= 3) return piece;
  const oldLength = piece.outline.length;
  const outline = piece.outline.filter((_, i) => i !== index);
  const nV = outline.length;
  return {
    ...piece,
    outline,
    openEdges: piece.openEdges.map((r) => shiftRunDelete(r, index, nV)),
    seams: piece.seams.map((s) => ({ a: shiftRunDelete(s.a, index, nV), b: shiftRunDelete(s.b, index, nV) })),
    placement: surfaceAfterDelete(piece.placement, index, oldLength),
  };
}

/**
 * Compile a piece's openEdges into the UV predicate generateSeamedPanels wants:
 * a boundary cell is "open" (not mirror-sewn) when its nearest outline edge
 * falls inside any open run.
 */
export function draftOpenings(piece: DraftPiece): (uu: number, vv: number) => boolean {
  const { outline, openEdges } = piece;
  const nV = outline.length;
  if (!openEdges.length) return () => false;
  return (uu: number, vv: number): boolean => {
    const e = nearestOutlineEdge([uu, vv], outline);
    return openEdges.some((run) => runCoversEdge(run, e, nV));
  };
}

/** Fractional projection of p onto segment a→b (0 at a, 1 at b), clamped. */
function projFrac(p: UV, a: UV, b: UV): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1e-9;
  return Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
}

/**
 * Compile a freeform piece to the sim inputs at grid resolution n: which
 * boundary cells are OPEN (openEdges + dart legs — not mirror-sewn) and the
 * front-panel LOCAL cell pairs to sew (each dart's two legs, paired by
 * arc-length from the apex, so the wedge closes and cups the flat piece into
 * 3D). Mirrors generateSeamedPanels' own rasterization (same pointInPolygon +
 * dart subtraction), so the cell indices line up.
 */
export function compileDraft(piece: DraftPiece, n: number): { extraSeams: { i: number; j: number }[]; openCells: Set<number> } {
  const { outline, darts, openEdges } = piece;
  const holes = pieceHolePolygons(piece);
  const nV = outline.length;
  const uvOf = (u: number, v: number): UV => [u / (n - 1), v / (n - 1)];

  // 1. Rasterize the kept mask (polygon minus dart wedges).
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p = uvOf(u, v);
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      if (inside) for (const h of holes) if (pointInPolygon(p, h)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const isBoundary = (u: number, v: number): boolean => {
    if (!kept[v * n + u]) return false;
    return (
      u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
      !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
    );
  };

  const openCells = new Set<number>();
  // 2. openEdges → open boundary cells (nearest outline edge in an open run).
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      if (!isBoundary(u, v)) continue;
      const e = nearestOutlineEdge(uvOf(u, v), outline);
      if (openEdges.some((r) => runCoversEdge(r, e, nV))) openCells.add(v * n + u);
    }

  // 3. Each dart: partition the wedge's boundary cells into the two legs (by
  // whichever leg they sit closer to), open them, and pair by arc-length.
  const extraSeams: { i: number; j: number }[] = [];
  const thresh2 = (1.6 / (n - 1)) ** 2;
  for (const d of darts) {
    const A: { cell: number; t: number }[] = [];
    const B: { cell: number; t: number }[] = [];
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        if (!isBoundary(u, v)) continue;
        const p = uvOf(u, v);
        const dA = segDist2(p, d.apex, d.legA);
        const dB = segDist2(p, d.apex, d.legB);
        if (Math.min(dA, dB) > thresh2) continue;
        const cell = v * n + u;
        if (dA <= dB) A.push({ cell, t: projFrac(p, d.apex, d.legA) });
        else B.push({ cell, t: projFrac(p, d.apex, d.legB) });
      }
    A.sort((x, y) => x.t - y.t);
    B.sort((x, y) => x.t - y.t);
    for (const c of A) openCells.add(c.cell);
    for (const c of B) openCells.add(c.cell);
    // Pair by normalized position along each leg (pro-rata, like the gathered
    // waist), resampling to the shorter list.
    const m = Math.min(A.length, B.length);
    for (let k = 0; k < m; k++) {
      const a = A[Math.floor((k * A.length) / m)]!;
      const b = B[Math.floor((k * B.length) / m)]!;
      if (a.cell !== b.cell) extraSeams.push({ i: a.cell, j: b.cell });
    }
  }

  // 4. Hand-defined seams: sew two boundary runs of the piece together. Resolve
  // each run to its ordered boundary cells, pick the direction that zips them
  // together (not twisted), open them, and pair by arc-length.
  const runCells = (run: EdgeRun): { cell: number; t: number }[] =>
    boundaryRunCells(piece, run, n);
  for (const hs of piece.seams) {
    const A = runCells(hs.a);
    const B = runCells(hs.b);
    if (!A.length || !B.length) continue;
    for (const c of A) openCells.add(c.cell);
    for (const c of B) openCells.add(c.cell);
    const m = Math.min(A.length, B.length);
    const cellUV = (cell: number): UV => [(cell % n) / (n - 1), Math.floor(cell / n) / (n - 1)];
    const bAt = (k: number, reversed: boolean): { cell: number } => B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
    // Direction check: forward vs reversed B — keep whichever zips closer.
    const cost = (reversed: boolean): number => {
      let s = 0;
      for (let k = 0; k < m; k++) {
        const pa = cellUV(A[Math.floor((k * A.length) / m)]!.cell);
        const pb = cellUV(bAt(k, reversed).cell);
        s += (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2;
      }
      return s;
    };
    const reversed = cost(true) < cost(false);
    for (let k = 0; k < m; k++) {
      const a = A[Math.floor((k * A.length) / m)]!;
      const b = bAt(k, reversed);
      if (a.cell !== b.cell) extraSeams.push({ i: a.cell, j: b.cell });
    }
  }
  return { extraSeams, openCells };
}

/** Ordered boundary cells (by arc-length along the run) that a run of a piece's
 * outline resolves to at grid resolution n. Shared by hand-seams and manual
 * assembly seams to pair two edges cell-by-cell. */
export function boundaryRunCells(
  piece: Pick<DraftPiece, 'outline' | 'darts' | 'width' | 'height' | 'internalLines'>,
  run: { from: number; to: number },
  n: number,
): { cell: number; t: number }[] {
  const { outline, darts } = piece;
  const holes = pieceHolePolygons(piece);
  const nV = outline.length;
  const uvOf = (u: number, v: number): UV => [u / (n - 1), v / (n - 1)];
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p = uvOf(u, v);
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      if (inside) for (const h of holes) if (pointInPolygon(p, h)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const isBoundary = (u: number, v: number): boolean => {
    if (!kept[v * n + u]) return false;
    return (
      u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
      !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
    );
  };
  const from = ((Math.round(run.from) % nV) + nV) % nV;
  const to = ((Math.round(run.to) % nV) + nV) % nV;
  const edgeIndices: number[] = [];
  for (let edge = from; edge !== to && edgeIndices.length < nV; edge = (edge + 1) % nV) {
    edgeIndices.push(edge);
  }
  if (!edgeIndices.length) return [];

  // A run may follow a deep armhole, hood curve or sleeve cap. Ordering its
  // raster cells by projection on the single from→to chord folds that curve
  // back onto itself and cross-zips distant points. Parameterise the authored
  // polyline by its real metric arc length instead.
  const physical = (point: UV): UV => [
    point[0] * piece.width,
    point[1] * piece.height,
  ];
  const edgeSet = new Set(edgeIndices);
  const before = new Map<number, number>();
  const lengths = new Map<number, number>();
  let totalLength = 0;
  for (const edge of edgeIndices) {
    const a = physical(outline[edge]!);
    const b = physical(outline[(edge + 1) % nV]!);
    before.set(edge, totalLength);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.set(edge, length);
    totalLength += length;
  }
  totalLength = Math.max(totalLength, 1e-9);

  const boundary: Array<{ cell: number; point: UV }> = [];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (isBoundary(u, v)) {
        boundary.push({ cell: v * n + u, point: uvOf(u, v) });
      }
    }
  }

  const nearestEdgePhysical = (point: UV): number => {
    const p = physical(point);
    let bestEdge = 0;
    let bestDistance = Infinity;
    for (let edge = 0; edge < nV; edge++) {
      const distance = segDist2(
        p,
        physical(outline[edge]!),
        physical(outline[(edge + 1) % nV]!),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestEdge = edge;
      }
    }
    return bestEdge;
  };
  const parameterOnEdge = (point: UV, edge: number): number => {
    const p = physical(point);
    const a = physical(outline[edge]!);
    const b = physical(outline[(edge + 1) % nV]!);
    const fraction = projFrac(p, a, b);
    return (
      (before.get(edge) ?? 0) + fraction * (lengths.get(edge) ?? 0)
    ) / totalLength;
  };

  const byCell = new Map<number, number>();
  const boundaryOwner = new Map<number, number>();
  for (const candidate of boundary) {
    const edge = nearestEdgePhysical(candidate.point);
    boundaryOwner.set(candidate.cell, edge);
    if (!edgeSet.has(edge)) continue;
    byCell.set(candidate.cell, parameterOnEdge(candidate.point, edge));
  }

  // Adjacent sewn runs must meet on the same particle. Raster ownership alone
  // assigns a corner to only one of its two incident edges, leaving a visible
  // one-cell eyelet at shoulders, underarms and band junctions. Deliberately
  // include the nearest live boundary particle at both authored endpoints.
  const nearestBoundaryCell = (
    vertex: UV,
    outgoingEdge: number,
  ): number | null => {
    const target = physical(vertex);
    // Use the first raster cell owned by the edge leaving this vertex. Both
    // adjacent runs therefore choose the same junction cell. Picking the
    // globally nearest cell can land two or three columns past the ownership
    // transition on a sharp neckline corner, creating an unstitched raster
    // gap immediately before the nominal endpoint.
    const owned = boundary.filter(
      (candidate) => boundaryOwner.get(candidate.cell) === outgoingEdge,
    );
    if (owned.length) {
      const edgeA = physical(outline[outgoingEdge]!);
      const edgeB = physical(outline[(outgoingEdge + 1) % nV]!);
      let best = owned[0]!.cell;
      let bestFraction = projFrac(physical(owned[0]!.point), edgeA, edgeB);
      for (const candidate of owned.slice(1)) {
        const fraction = projFrac(physical(candidate.point), edgeA, edgeB);
        if (fraction < bestFraction) {
          bestFraction = fraction;
          best = candidate.cell;
        }
      }
      return best;
    }
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const candidate of boundary) {
      const point = physical(candidate.point);
      const distance =
        (point[0] - target[0]) ** 2 + (point[1] - target[1]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.cell;
      }
    }
    return best;
  };
  const startCell = nearestBoundaryCell(outline[from]!, from);
  const endCell = nearestBoundaryCell(outline[to]!, to);
  if (startCell !== null) byCell.set(startCell, 0);
  if (endCell !== null && endCell !== startCell) byCell.set(endCell, 1);

  return [...byCell]
    .map(([cell, t]) => ({ cell, t }))
    .sort((a, b) => a.t - b.t || a.cell - b.cell);
}

/**
 * Resolve the explicitly-open armhole on one side of a body piece.
 *
 * A pattern can have several open runs (neckline, hem, armholes). The left and
 * right armholes are the runs whose raster cells sit furthest from the centre
 * line. Requiring them to stay in the outer third deliberately avoids turning
 * a neckline or hem into a sleeve opening on an arbitrary hand-drawn body.
 *
 * Returned cells are LOCAL grid indices, ordered top→bottom independently of
 * polygon winding, so a right run drawn bottom→top cannot twist the sleeve.
 */
export function sideOpeningCells(piece: DraftPiece, side: 'L' | 'R', n: number): number[] {
  const candidates = piece.openEdges
    .map((run) => {
      const cells = boundaryRunCells(piece, run, n).map((x) => x.cell);
      const meanU = cells.length ? cells.reduce((sum, cell) => sum + (cell % n) / (n - 1), 0) / cells.length : 0.5;
      return { cells, meanU };
    })
    .filter((x) => x.cells.length > 1);
  if (!candidates.length) return [];
  const chosen = candidates.reduce((best, x) =>
    side === 'L' ? (x.meanU < best.meanU ? x : best) : x.meanU > best.meanU ? x : best,
  );
  if ((side === 'L' && chosen.meanU >= 1 / 3) || (side === 'R' && chosen.meanU <= 2 / 3)) return [];
  return chosen.cells.sort((a, b) => Math.floor(a / n) - Math.floor(b / n) || (a % n) - (b % n));
}

/**
 * Resolve the explicitly-open neckline of a body piece.
 *
 * A bodice usually exposes several open runs (neckline, two armholes and hem).
 * The neckline is the open run centred on the fold line and living in the
 * upper half of the pattern. Keeping this selection on the authored runs is
 * important: scanning a hard-coded horizontal interval also catches shoulder
 * cells whenever the real neck is narrower than that interval.
 *
 * Returned cells follow the neckline from pattern-left to pattern-right on
 * both front and back, independently of polygon winding. That common direction
 * lets a two-panel neck band meet its side seams without twisting.
 */
export function neckOpeningCells(piece: DraftPiece, n: number): number[] {
  const candidates = piece.openEdges
    .map((run) => {
      const cells = boundaryRunCells(piece, run, n).map((entry) => entry.cell);
      if (cells.length < 2) return null;
      const meanU =
        cells.reduce((sum, cell) => sum + (cell % n) / (n - 1), 0) /
        cells.length;
      const meanV =
        cells.reduce(
          (sum, cell) => sum + Math.floor(cell / n) / (n - 1),
          0,
        ) / cells.length;
      return { cells, meanU, meanV };
    })
    .filter(
      (
        candidate,
      ): candidate is { cells: number[]; meanU: number; meanV: number } =>
        candidate !== null &&
        candidate.meanU > 1 / 3 &&
        candidate.meanU < 2 / 3 &&
        candidate.meanV < 0.55,
    );
  if (!candidates.length) return [];

  const chosen = candidates.reduce((best, candidate) => {
    const score = candidate.meanV + Math.abs(candidate.meanU - 0.5);
    const bestScore = best.meanV + Math.abs(best.meanU - 0.5);
    return score < bestScore ? candidate : best;
  });
  const cells = chosen.cells.slice();
  if ((cells[0]! % n) > (cells[cells.length - 1]! % n)) cells.reverse();
  return cells;
}

/** Boundary-cell set of a piece's raster mask at resolution n: kept cells on the
 * grid edge or with a cut 4-neighbour (same rule as boundaryRunCells). Used to
 * guard both-faces seams: the mirrored endpoint must land on an EDGE of its own
 * panel's mask — an independent back outline can leave the same (u,v) alive but
 * interior, and a seam into mid-fabric pinches a permanent tuft there. */
function boundaryCellSet(
  outline: readonly UV[],
  darts: readonly Dart[],
  n: number,
  holes: readonly (readonly UV[])[] = [],
): Set<number> {
  const kept = new Array<boolean>(n * n);
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      const p: UV = [u / (n - 1), v / (n - 1)];
      let inside = pointInPolygon(p, outline);
      if (inside) for (const d of darts) if (pointInTriangle(p, d.apex, d.legA, d.legB)) { inside = false; break; }
      if (inside) for (const h of holes) if (pointInPolygon(p, h)) { inside = false; break; }
      kept[v * n + u] = inside;
    }
  const out = new Set<number>();
  for (let v = 0; v < n; v++)
    for (let u = 0; u < n; u++) {
      if (!kept[v * n + u]) continue;
      if (
        u === 0 || u === n - 1 || v === 0 || v === n - 1 ||
        !kept[v * n + (u - 1)] || !kept[v * n + (u + 1)] || !kept[(v - 1) * n + u] || !kept[(v + 1) * n + u]
      )
        out.add(v * n + u);
    }
  return out;
}

/**
 * Boundary cells of piece `pid`'s CROSS-SEWN runs (its edges sewn to another
 * piece via assembly seams). A sewn edge is no longer a free rim: the caller
 * must exclude these cells from the piece's own front↔back rim stitching
 * (extraOpenings), otherwise a both-faces assembly seam would transitively
 * weld the body's open edge shut THROUGH the body (front rim → piece front →
 * piece back → back rim: a few mm of quasi-rigid seam across the anatomy).
 */
export function crossSewnOpenCells(doc: DraftDoc, pid: number, n: number): number[] {
  const pieces = docPieces(doc);
  const piece = pieces[pid];
  if (!piece || piece.outline.length < 3) return [];
  const cells = new Set<number>();
  for (const s of doc.seams ?? []) {
    // Un zip même OUVERT reste une couture MONTÉE : ses épingles existent
    // (émission permanente v198) et ses bords restent des rims libres — les
    // rubans doivent pouvoir s'écarter, pas se souder au panneau jumeau.
    const run = pieceIdOf(s.a) === pid ? s.a : pieceIdOf(s.b) === pid ? s.b : null;
    if (!run) continue;
    for (const c of boundaryRunCells(piece, { from: run.from, to: run.to }, n)) cells.add(c.cell);
  }
  return [...cells];
}

/** Pair two boundary runs cell-by-cell by arc-length, choosing the zip direction
 * (forward vs reversed B) that minimises total offset — anti-twist. Returns the
 * two aligned LOCAL cell lists (equal length), or null if either run is empty.
 * Shared by compileAssembly (base panels) and compileCrossSeams (extra meshes). */
function pairRunCells(
  pa: DraftPiece,
  pb: DraftPiece,
  runA: { from: number; to: number },
  runB: { from: number; to: number },
  n: number,
  reverseBOverride?: boolean,
): { a: number[]; b: number[] } | null {
  const A = boundaryRunCells(pa, runA, n);
  const B = boundaryRunCells(pb, runB, n);
  if (!A.length || !B.length) return null;
  const cellMetric = (piece: DraftPiece, cell: number): UV => [
    ((cell % n) / (n - 1) - 0.5) * piece.width,
    -(Math.floor(cell / n) / (n - 1)) * piece.height,
  ];
  // Zip over the LONGER run: every cell of both edges gets sewn (the shorter
  // run's cells repeat). Equal-length edges pair 1:1 as before; a long edge on
  // a short one GATHERS onto it — the tailor's embu — instead of leaving the
  // extra cells hanging (a sleeve cap held by a handful of pins slides off).
  const m = Math.max(A.length, B.length);
  const bAt = (k: number, reversed: boolean): { cell: number } => B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
  const cost = (reversed: boolean): number => {
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const paUV = cellMetric(pa, A[Math.floor((k * A.length) / m)]!.cell);
      const pbUV = cellMetric(pb, bAt(k, reversed).cell);
      sum += (paUV[0] - pbUV[0]) ** 2 + (paUV[1] - pbUV[1]) ** 2;
    }
    return sum;
  };
  const reversed = reverseBOverride ?? cost(true) < cost(false);
  const a: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < m; k++) {
    a.push(A[Math.floor((k * A.length) / m)]!.cell);
    b.push(bAt(k, reversed).cell);
  }
  return { a, b };
}

/** Zip direction the assembler will choose for these two runs (anti-twist).
 * Public for Couper & Coudre : quand une découpe scinde un run cousu, le bord
 * PARTENAIRE doit être scindé à la fraction correspondante — côté départ ou
 * côté arrivée selon le sens de fermeture éclair retenu par l'assembleur. */
export function runPairReversed(
  pa: DraftPiece,
  pb: DraftPiece,
  runA: EdgeRun,
  runB: EdgeRun,
  n: number,
): boolean {
  const A = boundaryRunCells(pa, runA, n);
  const B = boundaryRunCells(pb, runB, n);
  if (!A.length || !B.length) return false;
  const cellMetric = (piece: DraftPiece, cell: number): UV => [
    ((cell % n) / (n - 1) - 0.5) * piece.width,
    -(Math.floor(cell / n) / (n - 1)) * piece.height,
  ];
  const m = Math.max(A.length, B.length);
  const bAt = (k: number, reversed: boolean): { cell: number } =>
    B[Math.floor(((reversed ? m - 1 - k : k) * B.length) / m)]!;
  const cost = (reversed: boolean): number => {
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const paUV = cellMetric(pa, A[Math.floor((k * A.length) / m)]!.cell);
      const pbUV = cellMetric(pb, bAt(k, reversed).cell);
      sum += (paUV[0] - pbUV[0]) ** 2 + (paUV[1] - pbUV[1]) ** 2;
    }
    return sum;
  };
  return cost(true) < cost(false);
}

/** Resolve two outline runs to equally sampled local grid-cell sequences.
 * Public for specialised assemblies (for example the two mirrored crotch
 * seams of trousers); generic DraftDoc assembly continues through
 * `compileAssembly` below. */
export function pairOutlineRuns(
  pieceA: DraftPiece,
  pieceB: DraftPiece,
  runA: EdgeRun,
  runB: EdgeRun,
  n: number,
  reverseB?: boolean,
): { a: number[]; b: number[] } | null {
  return pairRunCells(pieceA, pieceB, runA, runB, n, reverseB);
}

/**
 * Resolve a draft's BASE assembly seams (front↔back, pieceId 0/1) into GLOBAL
 * cell-index pairs to sew (panel 0 = front, panel 1 = back). Cross-mesh seams
 * that touch a FREE piece (pieceId ≥ 2) are skipped here — they're compiled by
 * compileCrossSeams into the combined-mesh index space instead.
 */
// v181 ⑥ « pas dépaysé » : la même compilation, PAR couture — les liserés 3D
// ont besoin de savoir quelle paire appartient à quelle couture (sa couleur).
export function compileAssemblyGroups(
  doc: DraftDoc,
  n: number,
): { seamIndex: number; pairs: { i: number; j: number; zipper?: boolean }[] }[] {
  const panelSize = n * n;
  const pieces = docPieces(doc);
  const openCells = new Map<number, Set<number>>();
  const explicitlyOpen = (pieceId: number, piece: DraftPiece): Set<number> => {
    const cached = openCells.get(pieceId);
    if (cached) return cached;
    const cells = new Set<number>();
    for (const run of piece.openEdges) {
      for (const candidate of boundaryRunCells(piece, run, n)) {
        cells.add(candidate.cell);
      }
    }
    openCells.set(pieceId, cells);
    return cells;
  };
  const groups: { seamIndex: number; pairs: { i: number; j: number; zipper?: boolean }[] }[] = [];
  (doc.seams ?? []).forEach((s, seamIndex) => {
    // ZIP À CHAUD (v198) : les épingles d'une fermeture sont émises MÊME
    // ouverte, marquées `zipper` — le solveur les active/ignore par un uniform
    // sans reconstruire (l'état porté est préservé). `closed` ne pilote plus
    // l'existence des épingles, seulement l'état initial de l'uniform.
    const zip = s.kind === 'zipper';
    const pidA = pieceIdOf(s.a);
    const pidB = pieceIdOf(s.b);
    if (pidA > 1 || pidB > 1) return; // a free piece is involved → compileCrossSeams
    const pa = pieces[pidA];
    const pb = pieces[pidB];
    if (!pa || !pb || pa.outline.length < 3 || pb.outline.length < 3) return;
    const paired = pairRunCells(pa, pb, { from: s.a.from, to: s.a.to }, { from: s.b.from, to: s.b.to }, n);
    if (!paired) return;
    const offA = pidA * panelSize;
    const offB = pidB * panelSize;
    const pairs: { i: number; j: number; zipper?: boolean }[] = [];
    const openA = explicitlyOpen(pidA, pa);
    const openB = explicitlyOpen(pidB, pb);
    for (let k = 0; k < paired.a.length; k++) {
      // A shared raster corner belongs to both adjacent authored runs. If one
      // of them is explicitly open (armhole, neckline, etc.), the generic
      // front↔back assembler must not reuse that particle for the side seam or
      // it closes the opening transitively. Specialised garment assemblers can
      // still opt into a true three-way junction through pairOutlineRuns.
      if (openA.has(paired.a[k]!) || openB.has(paired.b[k]!)) continue;
      const gi = offA + paired.a[k]!;
      const gj = offB + paired.b[k]!;
      if (gi !== gj) pairs.push({ i: gi, j: gj, ...(zip ? { zipper: true } : {}) });
    }
    if (pairs.length) groups.push({ seamIndex, pairs });
  });
  return groups;
}

export function compileAssembly(
  doc: DraftDoc,
  n: number,
): { i: number; j: number; zipper?: boolean }[] {
  return compileAssemblyGroups(doc, n).flatMap((g) => g.pairs);
}

/**
 * Resolve the CROSS-MESH assembly seams — those touching a FREE piece (pieceId
 * ≥ 2) — for the piece being combined into the garment (`enteringPid`, the
 * higher-indexed endpoint). Returns {i,j} in the COMBINED-mesh index space:
 * `i` is the endpoint already in the garment, `j` the entering piece (offset by
 * garment.count, as combineClothMeshes requires). `offsets[pid]` is the global
 * base index of piece `pid` (0 and 1 = the base panels at 0 and n²; ≥2 = the
 * garment.count captured just before that piece was combined).
 *
 * Each seam is sewn on BOTH FACES: the drawn pair (front panels) plus its
 * back-panel twin, so a piece hugs the body all around instead of flapping.
 */
export function compileCrossSeams(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): { i: number; j: number; zipper?: boolean }[] {
  const panelSize = n * n;
  const pieces = docPieces(doc);
  const globalOf = (pid: number, local: number): number => (offsets[pid] ?? pid * panelSize) + local;
  // The BACK-FACE twin of a cell: every mesh is a doubled panel (front at
  // +gap/2, back at −gap/2). For the base, the twin lives on the OTHER panel
  // (front 0 ↔ back 1); a free piece's twin is its own panel 1 (same outline
  // on both panels, panelSize cells further).
  const mirrorOf = (pid: number, local: number): number =>
    pid <= 1 ? (offsets[1 - pid] ?? (1 - pid) * panelSize) + local : globalOf(pid, local) + panelSize;
  // Mirror guard (base side): the twin must be a BOUNDARY cell of the OTHER
  // base panel's own mask. With an independent back outline the same (u,v)
  // can be alive but INTERIOR there — a quasi-rigid seam into mid-fabric
  // pinches a permanent tuft instead of joining an edge. Free pieces use one
  // outline for both panels, so their twins are boundary by construction.
  // Lazy: only drafts that reach the emission pay the n² rasterisation.
  const baseBoundary: (Set<number> | null)[] = [null, null];
  const twinOnEdge = (pid: number, local: number): boolean => {
    if (pid > 1) return true;
    const other = 1 - pid;
    baseBoundary[other] ??= (() => {
      const p = pieces[other] && pieces[other]!.outline.length >= 3 ? pieces[other]! : pieces[pid]!;
      return boundaryCellSet(p.outline, p.darts, n, pieceHolePolygons(p));
    })();
    return baseBoundary[other]!.has(local);
  };
  // The twin always stays panel-to-panel (front↔front + back↔back). Sending a
  // piece's back panel to the body's FRONT cell pulls the tube through the body
  // instead of joining corresponding fabric faces.
  const out: { i: number; j: number; zipper?: boolean }[] = [];
  for (const s of doc.seams ?? []) {
    // ZIP À CHAUD (v198) : émission permanente, marquée `zipper` — voir
    // compileAssemblyGroups. L'habillage se fait toujours fermé ; l'uniform
    // du solveur ouvre/ferme sans reconstruire.
    const zip = s.kind === 'zipper';
    const pidA = pieceIdOf(s.a);
    const pidB = pieceIdOf(s.b);
    const hi = Math.max(pidA, pidB);
    if (hi < 2 || hi !== enteringPid) continue; // only cross-mesh seams entering with THIS piece
    // The entering piece endpoint (pid === hi) is the j side (in b's space); the
    // other endpoint is the i side (already in the garment).
    const aEnters = pidA === hi;
    const pidJ = hi;
    const pidI = aEnters ? pidB : pidA;
    const runJ = aEnters ? s.a : s.b;
    const runI = aEnters ? s.b : s.a;
    const pJ = pieces[pidJ];
    const pI = pieces[pidI];
    if (!pJ || !pI || pJ.outline.length < 3 || pI.outline.length < 3) continue;
    const paired = pairRunCells(pI, pJ, { from: runI.from, to: runI.to }, { from: runJ.from, to: runJ.to }, n);
    if (!paired) continue;
    const enteringCells = pJ.placement?.reverseSeam ? [...paired.b].reverse() : paired.b;
    for (let k = 0; k < paired.a.length; k++) {
      const li = paired.a[k]!;
      const lj = enteringCells[k]!;
      const gi = globalOf(pidI, li);
      const gj = globalOf(pidJ, lj);
      if (gi !== gj) out.push({ i: gi, j: gj, ...(zip ? { zipper: true } : {}) });
      // Sew BOTH faces: the same seam repeated on the back panels, so the
      // piece HUGS the body instead of flapping (before, only the front rim
      // was sewn — the root cause of « pièces ouvertes »). Guards: the twin
      // must land on a BOUNDARY cell of its own panel's mask (twinOnEdge),
      // and combineClothMeshes drops endpoints that are CUT. The caller also
      // un-stitches the piece's rim along the sewn run (crossSewnOpenCells)
      // so a twin can't weld the body's open edge shut through the body.
      const mi = mirrorOf(pidI, li);
      const mj = mirrorOf(pidJ, lj);
      if (mi !== mj && twinOnEdge(pidI, li) && twinOnEdge(pidJ, lj)) {
        out.push({ i: mi, j: mj, ...(zip ? { zipper: true } : {}) });
      }
    }
  }
  return out;
}

/**
 * Compile the independently removable top-stitches of a pocket/appliqué.
 * Unlike an assembly seam, the support endpoint is allowed inside the chosen
 * panel: every boundary cell of the overlay edge is paired with the closest
 * alive support cell under its exact placed position.
 */
interface SurfaceProjection {
  overlay: DraftPiece;
  support: DraftPiece;
  surface: SurfaceAttachment;
  supportOffset: number;
  enteringOffset: number;
  closestSupportCell(target: UV): number | null;
  /**
   * Two support neighbours ordered so their live cross-product points toward
   * the outside of the support panel. The GPU can therefore rebuild a signed
   * contact plane after every deformation instead of assuming world +Z.
   */
  outwardFrame(cell: number): { tangentA: number; tangentB: number } | null;
  /**
   * Exact authored point on one live support triangle. Barycentric weights
   * preserve the placement while the support stretches and bends.
   */
  contactFrame(target: UV): {
    support: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
  } | null;
}

function surfaceProjection(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): SurfaceProjection | null {
  const pieces = docPieces(doc);
  const overlay = pieces[enteringPid];
  const surface = overlay?.placement?.surface;
  if (
    !overlay ||
    overlay.placement?.role !== 'pocket' ||
    !surface ||
    surface.supportPieceId < 0 ||
    surface.supportPieceId >= enteringPid
  ) {
    return null;
  }
  const support = pieces[surface.supportPieceId];
  if (!support || support.outline.length < 3 || overlay.outline.length < 3) return null;

  const panelSize = n * n;
  const supportAlive = new Set<number>();
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const uv: UV = [u / (n - 1), v / (n - 1)];
      let alive = pointInPolygon(uv, support.outline);
      if (alive) {
        for (const dart of support.darts) {
          if (pointInTriangle(uv, dart.apex, dart.legA, dart.legB)) {
            alive = false;
            break;
          }
        }
      }
      if (alive) supportAlive.add(v * n + u);
    }
  }
  if (!supportAlive.size) return null;

  const closestSupportCell = (target: UV): number | null => {
    const cu = Math.round(target[0] * (n - 1));
    const cv = Math.round(target[1] * (n - 1));
    for (let radius = 0; radius < n; radius++) {
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let dv = -radius; dv <= radius; dv++) {
        for (let du = -radius; du <= radius; du++) {
          if (Math.max(Math.abs(du), Math.abs(dv)) !== radius) continue;
          const u = cu + du;
          const v = cv + dv;
          if (u < 0 || u >= n || v < 0 || v >= n) continue;
          const cell = v * n + u;
          if (!supportAlive.has(cell)) continue;
          const dx = (u / (n - 1) - target[0]) * support.width;
          const dy = (v / (n - 1) - target[1]) * support.height;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            best = cell;
            bestDistance = distance;
          }
        }
      }
      if (best !== null) return best;
    }
    return null;
  };

  const supportOffset =
    offsets[surface.supportPieceId] ??
    (surface.supportPieceId <= 1 ? surface.supportPieceId * panelSize : 0);
  const enteringOffset = offsets[enteringPid] ?? enteringPid * panelSize;
  const outwardFrame = (cell: number): { tangentA: number; tangentB: number } | null => {
    const u = cell % n;
    const v = Math.floor(cell / n);
    const axisNeighbour = (
      du: number,
      dv: number,
    ): { cell: number; direction: 1 | -1 } | null => {
      for (let radius = 1; radius < n; radius++) {
        const positiveU = u + du * radius;
        const positiveV = v + dv * radius;
        if (
          positiveU >= 0 &&
          positiveU < n &&
          positiveV >= 0 &&
          positiveV < n
        ) {
          const positive = positiveV * n + positiveU;
          if (supportAlive.has(positive)) return { cell: positive, direction: 1 };
        }
        const negativeU = u - du * radius;
        const negativeV = v - dv * radius;
        if (
          negativeU >= 0 &&
          negativeU < n &&
          negativeV >= 0 &&
          negativeV < n
        ) {
          const negative = negativeV * n + negativeU;
          if (supportAlive.has(negative)) return { cell: negative, direction: -1 };
        }
      }
      return null;
    };
    const tangentU = axisNeighbour(1, 0);
    const tangentV = axisNeighbour(0, 1);
    if (!tangentU || !tangentV) return null;

    // In the generated flat frame, cross(+u,+v) points toward −Z. That is the
    // outside of the base back panel, while front/free panels face +Z.
    const desiredFromCanonical = surface.supportPieceId === 1 ? 1 : -1;
    const selectedFromCanonical = tangentU.direction * tangentV.direction;
    const ordered =
      selectedFromCanonical === desiredFromCanonical
        ? [tangentU.cell, tangentV.cell]
        : [tangentV.cell, tangentU.cell];
    return {
      tangentA: supportOffset + ordered[0]!,
      tangentB: supportOffset + ordered[1]!,
    };
  };
  const contactFrame = (
    target: UV,
  ): {
    support: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
  } | null => {
    const gu = Math.min(n - 1 - 1e-7, Math.max(0, target[0] * (n - 1)));
    const gv = Math.min(n - 1 - 1e-7, Math.max(0, target[1] * (n - 1)));
    const u0 = Math.min(n - 2, Math.floor(gu));
    const v0 = Math.min(n - 2, Math.floor(gv));
    const fu = gu - u0;
    const fv = gv - v0;
    const c00 = v0 * n + u0;
    const c10 = c00 + 1;
    const c01 = c00 + n;
    const c11 = c01 + 1;
    let cells: [number, number, number];
    let weights: [number, number, number];
    if (fu + fv <= 1) {
      cells = [c00, c10, c01];
      weights = [1 - fu - fv, fu, fv];
    } else {
      cells = [c11, c01, c10];
      weights = [fu + fv - 1, 1 - fu, 1 - fv];
    }
    if (cells.every((cell) => supportAlive.has(cell))) {
      // Canonical triangle winding cross(+u,+v) faces −Z. Reverse front/free
      // supports so the stored live cross-product always faces outside.
      if (surface.supportPieceId !== 1) {
        [cells[1], cells[2]] = [cells[2], cells[1]];
        [weights[1], weights[2]] = [weights[2], weights[1]];
      }
      return {
        support: supportOffset + cells[0],
        tangentA: supportOffset + cells[1],
        tangentB: supportOffset + cells[2],
        weight0: weights[0],
        weightA: weights[1],
        weightB: weights[2],
      };
    }

    // Boundary fallback: keep the nearest alive point and an outward live
    // frame. Weight 1 on the centre is conservative but still one-sided.
    const nearest = closestSupportCell(target);
    if (nearest === null) return null;
    const frame = outwardFrame(nearest);
    if (!frame) return null;
    return {
      support: supportOffset + nearest,
      tangentA: frame.tangentA,
      tangentB: frame.tangentB,
      weight0: 1,
      weightA: 0,
      weightB: 0,
    };
  };
  return {
    overlay,
    support,
    surface,
    supportOffset,
    enteringOffset,
    closestSupportCell,
    outwardFrame,
    contactFrame,
  };
}

export function compileSurfaceSeams(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): { i: number; j: number }[] {
  const projection = surfaceProjection(doc, n, offsets, enteringPid);
  if (!projection) return [];
  const {
    overlay,
    support,
    surface,
    supportOffset,
    enteringOffset,
    closestSupportCell,
  } = projection;
  const stitched = new Set(
    surface.stitchedEdges
      .filter(Number.isFinite)
      .map((edge) => ((Math.round(edge) % overlay.outline.length) + overlay.outline.length) % overlay.outline.length),
  );
  const emitted = new Set<string>();
  const out: { i: number; j: number }[] = [];
  for (const edge of stitched) {
    const cells = boundaryRunCells(
      overlay,
      { from: edge, to: (edge + 1) % overlay.outline.length },
      n,
    );
    for (const { cell } of cells) {
      const overlayUV: UV = [(cell % n) / (n - 1), Math.floor(cell / n) / (n - 1)];
      const targetUV = surfaceAttachmentUV(overlay, support, surface, overlayUV);
      const supportCell = closestSupportCell(targetUV);
      if (supportCell === null) continue;
      const key = `${supportCell}:${cell}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({ i: supportOffset + supportCell, j: enteringOffset + cell });
    }
  }
  return out;
}

/**
 * MATELASSAGE (v199) : épingles INTÉRIEURES entre une pièce de surface (la
 * doublure) et son support, appariées LIGNE DE CANAL à LIGNE DE CANAL — la
 * k-ième ligne interne ouverte (ni fermée ni trou) de la doublure se pique
 * sur la k-ième du support, cellule à cellule le long des deux polylignes.
 *
 * Le gonflant d'une doudoune naît de là, SANS moteur de pression : le support
 * (tissu extérieur) est dessiné avec ses canaux PLUS ESPACÉS que ceux de la
 * doublure — un extérieur coupé plus long, comme en vraie couture. Les
 * épingles le compriment à l'espacement de la doublure et l'excès BOUDINE
 * entre les piqûres, poussé vers l'extérieur par le corps et la doublure.
 *
 * Émises comme des coutures ORDINAIRES (bilatérales, kind Seam au montage) :
 * le support doit se laisser comprimer — la réponse asymétrique des
 * surpiqûres de poche (SurfaceSeam) étirerait la doublure au lieu de
 * froisser le tissu du dessus. Les deux couches se piquent l'une à l'autre.
 * Auteur : tracer les lignes homologues DANS LE MÊME SENS sur les deux
 * pièces (l'appariement suit l'ordre des points, sans anti-twist).
 */
export function compileQuiltSeams(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): { i: number; j: number }[] {
  const panelSize = n * n;
  const pieces = docPieces(doc);
  const overlay = pieces[enteringPid];
  const surface = overlay?.placement?.surface;
  if (!overlay || !surface) return [];
  const support = pieces[surface.supportPieceId];
  if (!support || support.outline.length < 3 || overlay.outline.length < 3) return [];
  const channels = (piece: DraftPiece): InternalLine[] =>
    (piece.internalLines ?? []).filter(
      (line) => !line.closed && !line.hole && line.points.length >= 2,
    );
  const linesOverlay = channels(overlay);
  const linesSupport = channels(support);
  const lineCount = Math.min(linesOverlay.length, linesSupport.length);
  if (!lineCount) return [];
  const supportOffset = offsets[surface.supportPieceId] ?? surface.supportPieceId * panelSize;
  const enteringOffset = offsets[enteringPid] ?? enteringPid * panelSize;
  const keptIn = (piece: DraftPiece): ((uu: number, vv: number) => boolean) => {
    const holes = pieceHolePolygons(piece);
    return (uu, vv) => {
      if (!pointInPolygon([uu, vv], piece.outline)) return false;
      for (const dart of piece.darts) {
        if (pointInTriangle([uu, vv], dart.apex, dart.legA, dart.legB)) return false;
      }
      for (const hole of holes) if (pointInPolygon([uu, vv], hole)) return false;
      return true;
    };
  };
  const keptSupport = keptIn(support);
  const keptOverlay = keptIn(overlay);
  // Cellules VIVANTES le long d'une polyligne, échantillonnée sous la cellule.
  const cellsAlong = (
    line: InternalLine,
    kept: (uu: number, vv: number) => boolean,
  ): number[] => {
    const out: number[] = [];
    let last = -1;
    const pts = line.points;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s]!;
      const [bx, by] = pts[s + 1]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * (n - 1) * 2));
      for (let q = 0; q <= steps; q++) {
        const t = q / steps;
        const uu = ax + (bx - ax) * t;
        const vv = ay + (by - ay) * t;
        if (uu < 0 || uu > 1 || vv < 0 || vv > 1) continue;
        const cell = Math.round(vv * (n - 1)) * n + Math.round(uu * (n - 1));
        if (cell === last) continue;
        if (!kept(uu, vv)) continue;
        out.push(cell);
        last = cell;
      }
    }
    return out;
  };
  const out: { i: number; j: number }[] = [];
  const emitted = new Set<string>();
  for (let k = 0; k < lineCount; k++) {
    const cellsS = cellsAlong(linesSupport[k]!, keptSupport);
    const cellsO = cellsAlong(linesOverlay[k]!, keptOverlay);
    if (!cellsS.length || !cellsO.length) continue;
    // Fermeture éclair sur la plus longue des deux listes : chaque cellule des
    // deux canaux est piquée (la plus courte se répète — l'embu du matelassage).
    const m = Math.max(cellsS.length, cellsO.length);
    for (let q = 0; q < m; q++) {
      const cs = cellsS[Math.min(cellsS.length - 1, Math.floor((q * cellsS.length) / m))]!;
      const co = cellsO[Math.min(cellsO.length - 1, Math.floor((q * cellsO.length) / m))]!;
      const key = `${cs}:${co}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({ i: supportOffset + cs, j: enteringOffset + co });
    }
  }
  return out;
}

/**
 * Contact map over the WHOLE pocket/appliqué, not only its stitched outline.
 * Every entry builds the thin pocket/support self-collision mask. The
 * unilateral triangle pass always activates one representative per support
 * triangle so a fully stitched appliqué cannot merge with its support; open
 * outline edges add denser anti-tunnelling samples. It never pulls a free edge
 * inward or constrains sliding.
 */
export function compileSurfaceContacts(
  doc: DraftDoc,
  n: number,
  offsets: number[],
  enteringPid: number,
): {
  i: number;
  j: number;
  tangentA: number;
  tangentB: number;
  weight0: number;
  weightA: number;
  weightB: number;
  /**
   * True for the sparse physical manifold: one representative per support
   * triangle plus particles on deliberately unstitched boundary edges.
   */
  active: boolean;
  /** +1 = par-dessus le support (défaut), -1 = par-dessous (doublure). */
  side: 1 | -1;
}[] {
  const projection = surfaceProjection(doc, n, offsets, enteringPid);
  if (!projection) return [];
  const {
    overlay,
    support,
    surface,
    enteringOffset,
    contactFrame,
  } = projection;
  const emitted = new Set<string>();
  const contactSide: 1 | -1 = surface.side === 'under' ? -1 : 1;
  const out: {
    i: number;
    j: number;
    tangentA: number;
    tangentB: number;
    weight0: number;
    weightA: number;
    weightB: number;
    active: boolean;
    side: 1 | -1;
  }[] = [];
  const stitched = new Set(
    surface.stitchedEdges
      .filter(Number.isFinite)
      .map(
        (edge) =>
          ((Math.round(edge) % overlay.outline.length) +
            overlay.outline.length) %
          overlay.outline.length,
      ),
  );
  const openEdgeCells = new Set<number>();
  for (let edge = 0; edge < overlay.outline.length; edge++) {
    if (stitched.has(edge)) continue;
    for (const { cell } of boundaryRunCells(
      overlay,
      { from: edge, to: (edge + 1) % overlay.outline.length },
      n,
    )) {
      openEdgeCells.add(cell);
    }
  }
  const surfaceOpen = stitched.size < overlay.outline.length;
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const overlayUV: UV = [u / (n - 1), v / (n - 1)];
      if (!pointInPolygon(overlayUV, overlay.outline)) continue;
      if (overlay.darts.some((dart) => pointInTriangle(overlayUV, dart.apex, dart.legA, dart.legB))) continue;
      const targetUV = surfaceAttachmentUV(overlay, support, surface, overlayUV);
      const frame = contactFrame(targetUV);
      if (!frame) continue;
      const overlayCell = v * n + u;
      const key = `${frame.support}:${overlayCell}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({
        i: frame.support,
        j: enteringOffset + overlayCell,
        tangentA: frame.tangentA,
        tangentB: frame.tangentB,
        weight0: frame.weight0,
        weightA: frame.weightA,
        weightB: frame.weightB,
        active: false,
        side: contactSide,
      });
    }
  }

  // A pocket grid always uses n×n particles, even when the physical patch is
  // much smaller than its support. Activating every overlay sample can create
  // hundreds of projections against the SAME coarse shirt triangle (961 in
  // the 19×24 cm regression), turning the pocket into a pressure plate that
  // drags the whole garment. Build an area-correct sparse manifold instead:
  // one interior representative nearest each support-triangle centroid for
  // every appliqué, plus every open-boundary sample for anti-tunnelling.
  const representative = new Map<
    string,
    { index: number; score: number }
  >();
  for (let index = 0; index < out.length; index++) {
    const contact = out[index]!;
    const key = `${contact.i}:${contact.tangentA}:${contact.tangentB}`;
    const score =
      (contact.weight0 - 1 / 3) ** 2 +
      (contact.weightA - 1 / 3) ** 2 +
      (contact.weightB - 1 / 3) ** 2;
    const current = representative.get(key);
    if (!current || score < current.score) {
      representative.set(key, { index, score });
    }
    if (
      surfaceOpen &&
      openEdgeCells.has(contact.j - enteringOffset)
    ) {
      contact.active = true;
    }
  }
  for (const { index } of representative.values()) out[index]!.active = true;
  return out;
}

/**
 * Re-index assembly seams after a vertex was inserted at / removed from `at` on
 * ONE face's outline, so each seam keeps pointing at the same physical edge
 * (the outline edge indices shift, exactly like openEdges/hand-seams do).
 */
export function reindexAssemblySeams(
  seams: readonly AssemblySeam[],
  target: 'front' | 'back' | number,
  kind: 'insert' | 'delete',
  at: number,
  nV: number,
): AssemblySeam[] {
  const targetPid = typeof target === 'number' ? target : target === 'back' ? 1 : 0;
  const shift = (r: FaceRun): FaceRun => {
    if (pieceIdOf(r) !== targetPid) return { ...r };
    const s = kind === 'insert' ? shiftRunInsert(r, at) : shiftRunDelete(r, at, nV);
    return { ...r, from: s.from, to: s.to }; // preserve face/pieceId identity
  };
  return seams.map((s) => ({ ...s, a: shift(s.a), b: shift(s.b) }));
}

/**
 * Remove a FREE piece (pieceId ≥ 2) from a draft's `pieces` list and fix up its
 * assembly seams: DROP any seam touching the removed piece, and DECREMENT the
 * pieceId of every run pointing at a piece ABOVE it (the survivors compact down
 * by one, exactly like sanitizeDraft's remap). Base runs (face front/back,
 * pieceId ≤ 1) are untouched. Pure — the caller commits the result and rebuilds.
 */
export function removeFreePiece(
  pieces: readonly DraftPiece[],
  seams: readonly AssemblySeam[],
  pieceId: number,
): { pieces: DraftPiece[]; seams: AssemblySeam[] } {
  const k = pieceId - 2;
  const outPieces = pieces
    .filter((_, i) => i !== k)
    .map((piece) => {
      const surface = piece.placement?.surface;
      if (!surface) return piece;
      if (surface.supportPieceId === pieceId) {
        const { surface: _removed, ...placement } = piece.placement!;
        return { ...piece, placement };
      }
      if (surface.supportPieceId > pieceId) {
        return {
          ...piece,
          placement: {
            ...piece.placement!,
            surface: { ...surface, supportPieceId: surface.supportPieceId - 1 },
          },
        };
      }
      return piece;
    });
  const shift = (r: FaceRun): FaceRun => (pieceIdOf(r) > pieceId ? { ...r, pieceId: pieceIdOf(r) - 1 } : { ...r });
  const outSeams = seams
    .filter((s) => pieceIdOf(s.a) !== pieceId && pieceIdOf(s.b) !== pieceId)
    .map((s) => ({ ...s, a: shift(s.a), b: shift(s.b) }));
  return { pieces: outPieces, seams: outSeams };
}


/** Physical placement of the blank canvas (meters). Single source of truth so
 * defaultDraft and the sanitizeDraft fallbacks can't drift apart. */
const DEFAULT_PIECE_DIMS = { width: 0.95, height: 1.1, topY: 1.6, gap: 1.0 };

/** The atelier's starting pieces: a sleeveless A-line dress FRONT and an
 * identical BACK, laid out côte-à-côte, PRE-SEWN at the shoulders (edges 0→1,
 * 3→4) and sides (4→5, 6→0) — the neckline (1→2→3) and hem (5→6) stay open.
 * Ergonomie (audit v119) : le premier « ▶ Simuler » d'un débutant doit draper
 * un débardeur, pas faire tomber deux panneaux par terre — les coutures se
 * DÉFONT d'un clic pour qui veut apprendre l'assemblage manuel. */
export function defaultDraft(gridN: 32 | 64 | 128 = 64): DraftDoc {
  const face = (): DraftPiece => ({
    outline: [
      [0.24, 0.03], // 0 left shoulder outer
      [0.42, 0.03], // 1 left shoulder inner (neckline start)
      [0.5, 0.12], // 2 neckline bottom
      [0.58, 0.03], // 3 right shoulder inner
      [0.76, 0.03], // 4 right shoulder outer
      [0.9, 0.97], // 5 hem right
      [0.1, 0.97], // 6 hem left
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 3 }, // neckline
      { from: 5, to: 6 }, // hem
    ],
    ...DEFAULT_PIECE_DIMS,
  });
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: face(),
    back: face(),
    manual: true,
    seams: [seam(0, 1), seam(3, 4), seam(4, 5), seam(6, 7)],
  };
}

/**
 * A basic T-SHIRT BODY preset: front + back IDENTICAL torso outlines (shoulders,
 * armholes, a neck scoop, near-straight sides to the hem), with the shoulders
 * and lower sides PRE-SEWN front↔back. Neckline, hem and both armholes stay open.
 * The ARMS go into SEPARATE placed sleeves (the atelier "+ Manches" tubes that
 * straddle each arm) added by the caller, so the arms are truly IN the sleeves —
 * a flat kimono sleeve just hangs. Front=back ⇒ the hand seams pair cell-for-cell
 * like an automatic mirror seam, so it drapes as a clean closed shell but stays
 * editable. Sized to the avatar by the caller (width ≈ 0.7·topScale, height 0.62,
 * gap 0.9, topY 1.52 + dyShoulder). */
/** Le SOCLE VIDE : un doc dont les deux faces de base sont des sentinelles
 * `blank` — contour minuscule logé ENTRE les centres de cellules (aucune
 * cellule rasterisée à 32/64/128), cadre grandeur corps pour servir de boîte
 * de tracé. L'atelier « page blanche » trace ses pièces libres dessus sans
 * qu'aucun vêtement n'apparaisse. */
export function blankBaseDraft(gridN: 32 | 64 | 128 = 64): DraftDoc {
  const face = (): DraftPiece => ({
    outline: [
      [0.0002, 0.0002],
      [0.0007, 0.0002],
      [0.0005, 0.0007],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    blank: true,
    ...DEFAULT_PIECE_DIMS,
  });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: face(),
    back: face(),
    manual: true,
    seams: [],
  };
}

export function tshirtDraft(width: number, height: number, gap: number, topY: number, gridN: 32 | 64 | 128 = 64): DraftDoc {
  const body = (): DraftPiece => ({
    outline: [
      [0.42, 0.0], // 0 neck top left
      [0.14, 0.02], // 1 left shoulder outer
      [0.14, 0.28], // 2 left underarm
      [0.16, 0.98], // 3 left hem (a hair of waist taper)
      [0.84, 0.98], // 4 right hem
      [0.86, 0.28], // 5 right underarm
      [0.86, 0.02], // 6 right shoulder outer
      [0.58, 0.0], // 7 neck top right
      [0.5, 0.12], // 8 neck bottom (scoop dip)
    ],
    darts: [],
    seams: [],
    openEdges: [
      { from: 1, to: 2 }, // left armhole
      { from: 3, to: 4 }, // hem
      { from: 5, to: 6 }, // right armhole
      { from: 7, to: 0 }, // neckline (edges 7 + 8, the head hole)
    ],
    width,
    height,
    topY,
    gap,
  });
  // Shoulders and sides are distinct: the armhole between them remains a real
  // two-rim opening, ready to receive the sleeve front and back separately.
  const seam = (from: number, to: number): AssemblySeam => ({ a: { face: 'front', from, to }, b: { face: 'back', from, to } });
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: body(),
    back: body(),
    manual: true,
    seams: [seam(0, 1), seam(2, 3), seam(4, 5), seam(6, 7)],
  };
}

/**
 * Validate an untrusted draft (import path): clamp every coord to [0,1], cap
 * element counts, and reject a self-intersecting outline (→ fall back to the
 * default) so a bad file can't produce a degenerate mesh or a GPU blowup.
 */
export function sanitizeDraft(raw: unknown): DraftDoc {
  const fallback = defaultDraft(64);
  if (!raw || typeof raw !== 'object') return fallback;
  const d = raw as Partial<DraftDoc>;
  if (d.format !== 'toile-draft') return fallback;
  const gridN = [32, 64, 128].includes(d.gridN as number) ? (d.gridN as 32 | 64 | 128) : 64;

  const uv = (a: unknown): UV => {
    const t = a as [number, number];
    return [clamp01(Array.isArray(t) ? t[0] : 0.5), clamp01(Array.isArray(t) ? t[1] : 0.5)];
  };
  const num = (v: unknown, min: number, max: number, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
  // Parse one face; null (→ dropped) if its outline is missing/degenerate/self-
  // intersecting, so a bad file can't produce a GPU blowup. `minGap` lets a thin
  // FREE piece (spawned with gap 0.12) survive the round-trip — the base clamp
  // floor (0.3) is tuned for the body and would inflate a small piece's panels.
  const parsePiece = (pp: Partial<DraftPiece> | undefined, minGap = 0.3, minDim = 0.3): DraftPiece | null => {
    if (!pp || !Array.isArray(pp.outline) || pp.outline.length < 3) return null;
    const outline = pp.outline.slice(0, 128).map(uv);
    if (isSelfIntersecting(outline)) return null;
    const nV = outline.length;
    const run = (r: unknown): EdgeRun => {
      const e = r as EdgeRun;
      const idx = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(nV - 1, Math.max(0, Math.round(v))) : 0;
      return { from: idx(e?.from), to: idx(e?.to) };
    };
    return {
      outline,
      darts: (Array.isArray(pp.darts) ? pp.darts : []).slice(0, 16).map((x) => {
        const dd = x as Dart;
        return { apex: uv(dd?.apex), legA: uv(dd?.legA), legB: uv(dd?.legB) };
      }),
      seams: (Array.isArray(pp.seams) ? pp.seams : []).slice(0, 16).map((x) => {
        const hs = x as HandSeam;
        return { a: run(hs?.a), b: run(hs?.b) };
      }),
      openEdges: (Array.isArray(pp.openEdges) ? pp.openEdges : []).slice(0, 16).map(run),
      width: num(pp.width, minDim, 2.0, DEFAULT_PIECE_DIMS.width),
      height: num(pp.height, minDim, 2.0, DEFAULT_PIECE_DIMS.height),
      topY: num(pp.topY, 0.5, 2.2, DEFAULT_PIECE_DIMS.topY),
      gap: num(pp.gap, minGap, 1.6, DEFAULT_PIECE_DIMS.gap),
      ...(typeof pp.name === 'string' && pp.name.trim()
        ? { name: pp.name.trim().slice(0, 64) }
        : {}),
      ...(typeof pp.cut === 'number' && Number.isFinite(pp.cut)
        ? { cut: Math.min(8, Math.max(1, Math.round(pp.cut))) }
        : {}),
      ...(pp.onFold === true ? { onFold: true } : {}),
      ...(pp.patternOnly === true ? { patternOnly: true } : {}),
      ...(pp.singlePanel === true ? { singlePanel: true } : {}),
      ...(pp.blank === true ? { blank: true } : {}),
      ...((): Pick<DraftPiece, 'fabricPreset'> => {
        const allowed = ['Jersey', 'Maille', 'Popeline', 'Denim', 'Lin', 'Laine', 'Soie'] as const;
        return allowed.includes(pp.fabricPreset as (typeof allowed)[number])
          ? { fabricPreset: pp.fabricPreset as (typeof allowed)[number] }
          : {};
      })(),
      ...((): Pick<DraftPiece, 'arealDensityGsm'> => {
        // Same stable apparel range as FabricMaterial. Keep the document in
        // the unit used on textile labels; conversion to kg/m² happens once
        // when the GPU material table is assembled.
        return typeof pp.arealDensityGsm === 'number' && Number.isFinite(pp.arealDensityGsm)
          ? { arealDensityGsm: clampFabricGsm(pp.arealDensityGsm) }
          : {};
      })(),
      // Couleur d'empiècement : un hex strict survit (en minuscules), le reste tombe.
      ...(typeof pp.color === 'string' && /^#[0-9a-f]{6}$/i.test(pp.color)
        ? { color: pp.color.toLowerCase() }
        : {}),
      // Graphique de pièce : data URL image borné + transform assaini, sinon il tombe.
      ...((): { graphic?: PieceGraphic } => {
        const raw = pp.graphic as Partial<PieceGraphic> | undefined;
        if (
          !raw ||
          typeof raw.image !== 'string' ||
          raw.image.length > GRAPHIC_IMAGE_MAX_CHARS ||
          !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(raw.image) ||
          typeof raw.widthM !== 'number' ||
          !Number.isFinite(raw.widthM) ||
          typeof raw.aspect !== 'number' ||
          !Number.isFinite(raw.aspect)
        ) {
          return {};
        }
        const rotation =
          typeof raw.rotationRad === 'number' && Number.isFinite(raw.rotationRad)
            ? Math.min(Math.PI * 2, Math.max(-Math.PI * 2, raw.rotationRad))
            : 0;
        return {
          graphic: {
            image: raw.image,
            anchor: uv(raw.anchor),
            widthM: Math.min(2, Math.max(0.01, raw.widthM)),
            aspect: Math.min(20, Math.max(0.05, raw.aspect)),
            rotationRad: rotation,
            ...(raw.repeat === true ? { repeat: true } : {}),
          },
        };
      })(),
      // ▱ Lignes internes : points UV clampés, tailles bornées, dégénérées
      // (< 2 points) écartées ; le drapeau closed ne survit que s'il est vrai.
      ...((): { internalLines?: InternalLine[] } => {
        if (!Array.isArray(pp.internalLines)) return {};
        const lines: InternalLine[] = [];
        for (const rawLine of pp.internalLines.slice(0, INTERNAL_LINES_MAX)) {
          const rl = rawLine as Partial<InternalLine> | undefined;
          if (!rl || !Array.isArray(rl.points)) continue;
          const points = rl.points
            .slice(0, INTERNAL_LINE_POINTS_MAX)
            .filter(
              (pt): pt is UV =>
                Array.isArray(pt) &&
                typeof pt[0] === 'number' &&
                Number.isFinite(pt[0]) &&
                typeof pt[1] === 'number' &&
                Number.isFinite(pt[1]),
            )
            .map((pt) => uv(pt));
          if (points.length < 2) continue;
          lines.push({
            points,
            ...(rl.closed === true ? { closed: true } : {}),
            ...(rl.closed === true && rl.hole === true && points.length >= 3 ? { hole: true } : {}),
          });
        }
        return lines.length ? { internalLines: lines } : {};
      })(),
      // ⌵ Crans : UV clampés, plafond, dégénérés écartés.
      ...((): { notches?: PieceNotch[] } => {
        if (!Array.isArray(pp.notches)) return {};
        const notches: PieceNotch[] = [];
        for (const rawNotch of pp.notches.slice(0, NOTCHES_MAX)) {
          const rn = rawNotch as Partial<PieceNotch> | undefined;
          const at = rn?.at;
          if (
            !Array.isArray(at) ||
            typeof at[0] !== 'number' ||
            !Number.isFinite(at[0]) ||
            typeof at[1] !== 'number' ||
            !Number.isFinite(at[1])
          ) {
            continue;
          }
          notches.push({ at: uv(at) });
        }
        return notches.length ? { notches } : {};
      })(),
      // Proven wrap modes survive the round-trip.
      ...(pp.wrap === 'armL' || pp.wrap === 'armR' || pp.wrap === 'neck' ? { wrap: pp.wrap } : {}),
      ...((): { placement?: PiecePlacement } => {
        const raw = pp.placement as Partial<PiecePlacement> | undefined;
        const roles: PiecePlacementRole[] = ['auto', 'front', 'back', 'armL', 'armR', 'neck', 'waist', 'legL', 'legR', 'pocket', 'free'];
        return raw && roles.includes(raw.role as PiecePlacementRole)
          ? {
              placement: {
                role: raw.role as PiecePlacementRole,
                autoAlign: raw.autoAlign !== false,
                ...(raw.reverseSeam === true ? { reverseSeam: true } : {}),
                ...((): { surface?: SurfaceAttachment } => {
                  const surface = raw.surface as Partial<SurfaceAttachment> | undefined;
                  if (
                    raw.role !== 'pocket' ||
                    !surface ||
                    typeof surface.supportPieceId !== 'number' ||
                    !Number.isFinite(surface.supportPieceId)
                  ) {
                    return {};
                  }
                  const stitchedEdges = [
                    ...new Set(
                      (Array.isArray(surface.stitchedEdges) ? surface.stitchedEdges : [])
                        .slice(0, nV)
                        .filter((edge): edge is number => typeof edge === 'number' && Number.isFinite(edge))
                        .map((edge) => Math.min(nV - 1, Math.max(0, Math.round(edge)))),
                    ),
                  ].sort((a, b) => a - b);
                  return {
                    surface: {
                      supportPieceId: Math.min(64, Math.max(0, Math.round(surface.supportPieceId))),
                      anchor: uv(surface.anchor),
                      ...(surface.side === 'under' ? { side: 'under' as const } : {}),
                      ...(typeof surface.rotationRad === 'number' && Number.isFinite(surface.rotationRad)
                        ? { rotationRad: Math.min(Math.PI * 2, Math.max(-Math.PI * 2, surface.rotationRad)) }
                        : {}),
                      stitchedEdges,
                    },
                  };
                })(),
              },
            }
          : {};
      })(),
      ...((): { stagingOffset?: [number, number, number] } => {
        const raw = pp.stagingOffset;
        if (
          !Array.isArray(raw) ||
          raw.length !== 3 ||
          !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
        ) {
          return {};
        }
        const offset: [number, number, number] = [raw[0] as number, raw[1] as number, raw[2] as number];
        return Math.hypot(...offset) > 1e-8 ? { stagingOffset: offset } : {};
      })(),
      ...((): { stagingOffsets?: Array<[number, number, number] | null> } => {
        if (!Array.isArray(pp.stagingOffsets)) return {};
        const offsets = pp.stagingOffsets.slice(0, 8).map((raw) => {
          if (
            !Array.isArray(raw) ||
            raw.length !== 3 ||
            !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
          ) {
            return null;
          }
          return [raw[0], raw[1], raw[2]] as [number, number, number];
        });
        return offsets.some((offset) => offset && Math.hypot(...offset) > 1e-8)
          ? { stagingOffsets: offsets }
          : {};
      })(),
      ...((): { stagingOrients?: Array<[number, number, number, number] | null> } => {
        if (!Array.isArray(pp.stagingOrients)) return {};
        const orients = pp.stagingOrients.slice(0, 8).map((raw) => {
          if (
            !Array.isArray(raw) ||
            raw.length !== 4 ||
            !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
          ) {
            return null;
          }
          return [raw[0], raw[1], raw[2], raw[3]] as [number, number, number, number];
        });
        // Identity quaternion (0,0,0,±1) carries no rotation ⇒ drop it.
        return orients.some((q) => q && Math.hypot(q[0], q[1], q[2]) > 1e-6)
          ? { stagingOrients: orients }
          : {};
      })(),
      ...((): { arrange?: Array<{ volume: string; xPct: number; yPct: number; offsetMm: number } | null> } => {
        if (!Array.isArray(pp.arrange)) return {};
        const recipes = pp.arrange.slice(0, 8).map((raw) => {
          const r = raw as { volume?: unknown; xPct?: unknown; yPct?: unknown; offsetMm?: unknown } | null;
          if (
            !r ||
            typeof r.volume !== 'string' ||
            r.volume.length === 0 ||
            r.volume.length > 32 ||
            typeof r.xPct !== 'number' ||
            !Number.isFinite(r.xPct) ||
            typeof r.yPct !== 'number' ||
            !Number.isFinite(r.yPct) ||
            typeof r.offsetMm !== 'number' ||
            !Number.isFinite(r.offsetMm)
          ) {
            return null;
          }
          return {
            volume: r.volume,
            xPct: Math.max(0, Math.min(100, r.xPct)),
            yPct: Math.max(0, Math.min(100, r.yPct)),
            offsetMm: Math.max(-200, Math.min(300, r.offsetMm)),
          };
        });
        return recipes.some(Boolean) ? { arrange: recipes } : {};
      })(),
    };
  };
  const front = parsePiece(d.piece);
  if (!front) return fallback;
  const back = parsePiece(d.back);
  // FREE pieces (pieceId ≥ 2, multi-piece editor): parse each slot; drop any that
  // is degenerate/self-intersecting (parsePiece → null). Dropping a middle piece
  // COMPACTS the survivors, shifting their pieceIds, so build an old→new remap
  // and re-point (or drop) each seam through it — otherwise a hand-edited/corrupt
  // file could bind a seam to the WRONG surviving piece. Capped so a bad file
  // can't spawn an unbounded number of meshes. Thin free pieces keep a lower gap
  // floor (0.1) so they round-trip byte-identically.
  const freePieces: DraftPiece[] = [];
  const remap = new Map<number, number>(); // old pieceId (2+k) → new pieceId
  (Array.isArray(d.pieces) ? d.pieces : []).slice(0, 6).forEach((x, k) => {
    const p = parsePiece(x as Partial<DraftPiece>, 0.1, 0.1); // thin/narrow free pieces (sleeves) keep their true size
    if (p) {
      remap.set(2 + k, 2 + freePieces.length);
      freePieces.push(p);
    }
  });
  const hasBack = !!back;
  freePieces.forEach((piece, k) => {
    const surface = piece.placement?.surface;
    if (!surface) return;
    const supportPieceId =
      surface.supportPieceId < 2
        ? surface.supportPieceId
        : remap.get(surface.supportPieceId);
    const ownPieceId = 2 + k;
    const supportExists =
      supportPieceId === 0 ||
      (supportPieceId === 1 ? hasBack : supportPieceId !== undefined && supportPieceId < ownPieceId);
    if (!supportExists || supportPieceId === ownPieceId) {
      const { surface: _discarded, ...placement } = piece.placement!;
      piece.placement = placement;
      return;
    }
    piece.placement = {
      ...piece.placement!,
      surface: { ...surface, supportPieceId: supportPieceId! },
    };
  });
  // Assembly seams (manual mode): validate face/pieceId + edge indices. Runs are
  // taken modulo the outline length at compile time, so a loose cap is enough.
  const faceRun = (r: unknown): FaceRun => {
    const e = r as FaceRun;
    const idx = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(256, Math.max(0, Math.round(v))) : 0);
    const run: FaceRun = { from: idx(e?.from), to: idx(e?.to) };
    if (typeof e?.pieceId === 'number' && Number.isFinite(e.pieceId)) {
      const old = Math.max(0, Math.round(e.pieceId));
      // Re-point free-piece references through the compaction remap; an unmapped
      // one (its piece was dropped) becomes -1 → filtered out by pieceExists.
      run.pieceId = old < 2 ? old : remap.get(old) ?? -1;
    } else run.face = e?.face === 'back' ? 'back' : 'front';
    return run;
  };
  // Drop "ghost" seams whose endpoint references a piece that doesn't exist: the
  // back when no back was drawn, or a free piece that was dropped/out of range.
  const pieceExists = (r: FaceRun): boolean => {
    const pid = pieceIdOf(r);
    if (pid < 0) return false; // a dropped free piece (remap miss)
    return pid === 0 || (pid === 1 ? hasBack : pid < 2 + freePieces.length);
  };
  const parseEdgePairs = (value: unknown): AssemblySeam[] =>
    (Array.isArray(value) ? value : [])
      .slice(0, 128)
      .map((x) => {
        const s = x as AssemblySeam;
        return {
          a: faceRun(s?.a),
          b: faceRun(s?.b),
          ...(s?.kind === 'seam' || s?.kind === 'zipper' ? { kind: s.kind } : {}),
          ...(typeof s?.closed === 'boolean' ? { closed: s.closed } : {}),
        };
      })
      .filter((s) => pieceExists(s.a) && pieceExists(s.b));
  const seams = parseEdgePairs(d.seams);
  const segmentLinks = parseEdgePairs(d.segmentLinks);
  return {
    format: 'toile-draft',
    version: 1,
    gridN,
    piece: front,
    ...(back ? { back } : {}),
    ...(freePieces.length ? { pieces: freePieces } : {}),
    manual: d.manual === true,
    seams,
    ...(segmentLinks.length ? { segmentLinks } : {}),
    ...(d.preset === 'loose-pants' || d.preset === 'lucas-hoodie'
      ? { preset: d.preset }
      : {}),
    ...((d.preset === 'loose-pants' || d.preset === 'lucas-hoodie') &&
    typeof d.presetSize === 'string'
      ? { presetSize: d.presetSize.slice(0, 8) }
      : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * COUPER & COUDRE — scinder une pièce le long d'une corde, couture auto.
 *
 * Le geste Clo signature, en pur : deux points sur le contour d'une pièce, la
 * pièce se scinde en deux polygones simples, une couture d'assemblage est
 * posée le long de la découpe, et TOUTES les références existantes suivent :
 * coutures/zips d'assemblage, bords ouverts, pinces, poches posées en surface.
 * Quand la découpe traverse un bord déjà cousu, le bord PARTENAIRE reçoit un
 * point d'accord à la fraction correspondante (dans le sens de fermeture
 * anti-twist de l'assembleur) et la couture est scindée en deux — le montage
 * survit à la découpe, comme chez un vrai patronnier.
 * ------------------------------------------------------------------------- */

/** Un point de découpe : sur l'arête `edge`, au paramètre t ∈ [0,1]. */
export interface ChordCutPoint {
  edge: number;
  t: number;
}

export interface ChordCutOk {
  ok: true;
  doc: DraftDoc;
  newPieceId: number;
  /** Coutures scindées avec point d'accord propagé au partenaire. */
  splitSeams: number;
  /** Liens Marier abandonnés (sémantique ambiguë après scission). */
  droppedLinks: number;
}

export interface ChordCutError {
  ok: false;
  /** Message court, affichable tel quel dans l'atelier. */
  reason: string;
}

export type ChordCutResult = ChordCutOk | ChordCutError;

const CUT_SNAP_T = 0.04; // sous ce paramètre, la découpe s'accroche au sommet existant

/** Longueur métrique (m) d'un run de contour, arêtes sommées. */
export function runLengthM(piece: DraftPiece, run: EdgeRun): number {
  const N = piece.outline.length;
  const steps = (run.to - run.from + N) % N;
  let len = 0;
  for (let k = 0; k < steps; k++) {
    const a = piece.outline[(run.from + k) % N]!;
    const b = piece.outline[(run.from + k + 1) % N]!;
    len += Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
  }
  return len;
}

/** Sommet (index) à la fraction f de la longueur d'un run, en INSÉRANT un
 * point si nécessaire. Rend le doc mis à jour (ré-indexation comprise) et
 * l'index du sommet d'accord dans la pièce mise à jour. */
function ensureVertexAtRunFraction(
  doc: DraftDoc,
  pieceId: number,
  run: EdgeRun,
  f: number,
): { doc: DraftDoc; vertex: number } {
  const piece = docPieces(doc)[pieceId]!;
  const N = piece.outline.length;
  const steps = (run.to - run.from + N) % N;
  const total = runLengthM(piece, run);
  const target = Math.min(1, Math.max(0, f)) * total;
  let walked = 0;
  for (let k = 0; k < steps; k++) {
    const ia = (run.from + k) % N;
    const ib = (run.from + k + 1) % N;
    const a = piece.outline[ia]!;
    const b = piece.outline[ib]!;
    const edgeLen = Math.hypot((a[0] - b[0]) * piece.width, (a[1] - b[1]) * piece.height);
    if (walked + edgeLen >= target - 1e-9 || k === steps - 1) {
      const t = edgeLen > 1e-9 ? (target - walked) / edgeLen : 0;
      if (t <= CUT_SNAP_T) return { doc, vertex: ia };
      if (t >= 1 - CUT_SNAP_T) return { doc, vertex: ib };
      const uv: UV = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const next = insertOutlineVertex(piece, ia, uv);
      const nV = next.outline.length;
      const updated = replaceDocPiece(doc, pieceId, next);
      return {
        doc: {
          ...updated,
          seams: reindexAssemblySeams(updated.seams ?? [], pieceId, 'insert', ia + 1, nV),
          segmentLinks: updated.segmentLinks?.length
            ? reindexAssemblySeams(updated.segmentLinks, pieceId, 'insert', ia + 1, nV)
            : updated.segmentLinks,
        },
        vertex: ia + 1,
      };
    }
    walked += edgeLen;
  }
  return { doc, vertex: run.from };
}

/**
 * COUTURE EN SÉRIE (atelier pro) — coudre UN bord receveur (long) à
 * PLUSIEURS bords partenaires bout à bout. Le receveur est scindé en autant
 * de segments, chacun à la fraction de sa longueur donnée par la LARGEUR
 * (longueur de bord) du partenaire — l'embu du modéliste : un panneau large
 * prend plus de ceinture qu'un étroit. Purement de la géométrie de patron :
 * insertion de crans (ensureVertexAtRunFraction) + coutures d'assemblage
 * classiques. AUCUN changement au moteur d'assemblage — chaque segment part
 * dans pairRunCells comme une couture ordinaire.
 *
 * Robuste aux décalages d'indices : les points de découpe sont suivis par
 * leur UV (fixe), pas par leur index (qui bouge à chaque insertion).
 */
export function sewEdgeToMany(
  doc: DraftDoc,
  receiver: FaceRun,
  partners: readonly FaceRun[],
  _n: number,
): { ok: true; doc: DraftDoc; seams: number } | { ok: false; reason: string } {
  if (partners.length === 0) return { ok: false, reason: 'Aucune pièce à raccorder.' };
  const recvPid = pieceIdOf(receiver);
  const recvPiece0 = docPieces(doc)[recvPid];
  if (!recvPiece0 || recvPiece0.outline.length < 3) return { ok: false, reason: 'Bord receveur introuvable.' };
  if (partners.some((p) => pieceIdOf(p) === recvPid)) {
    return { ok: false, reason: 'Un partenaire est sur la pièce receveuse — choisissez d’autres pièces.' };
  }
  // Fractions par LARGEUR : la longueur de bord de chaque partenaire.
  const lens: number[] = [];
  for (const pr of partners) {
    const pp = docPieces(doc)[pieceIdOf(pr)];
    if (!pp || pp.outline.length < 3) return { ok: false, reason: 'Pièce partenaire introuvable.' };
    const L = runLengthM(pp, { from: pr.from, to: pr.to });
    if (L < 1e-6) return { ok: false, reason: 'Un bord partenaire est dégénéré.' };
    lens.push(L);
  }
  const total = lens.reduce((s, l) => s + l, 0);
  const cum: number[] = [0];
  for (const l of lens) cum.push(cum[cum.length - 1]! + l / total); // cum[0..N] : 0 → 1
  // Sommet du contour le plus proche d'un UV (les extrémités et crans du run
  // sont suivis par position, jamais par index — l'index bouge à l'insertion).
  const findVertex = (piece: DraftPiece, uv: UV): number => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < piece.outline.length; i++) {
      const p = piece.outline[i]!;
      const d = (p[0] - uv[0]) ** 2 + (p[1] - uv[1]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const uvFrom = recvPiece0.outline[((receiver.from % recvPiece0.outline.length) + recvPiece0.outline.length) % recvPiece0.outline.length]!;
  const uvTo = recvPiece0.outline[((receiver.to % recvPiece0.outline.length) + recvPiece0.outline.length) % recvPiece0.outline.length]!;
  let work = doc;
  const cutUV: UV[] = [];
  // Insérer les crans intérieurs cum[1..N-1] en ordre CROISSANT ; re-résoudre
  // le run receveur par UV avant chaque insertion (from/to ne bougent pas de
  // position, seulement d'index).
  for (let i = 1; i < partners.length; i++) {
    const rp = docPieces(work)[recvPid]!;
    const run: EdgeRun = { from: findVertex(rp, uvFrom), to: findVertex(rp, uvTo) };
    const ensured = ensureVertexAtRunFraction(work, recvPid, run, cum[i]!);
    work = ensured.doc;
    cutUV.push([...docPieces(work)[recvPid]!.outline[ensured.vertex]!] as UV);
  }
  // Points de découpe finaux, re-résolus par UV : [from, cran1…, to].
  const rpFinal = docPieces(work)[recvPid]!;
  const boundary = [uvFrom, ...cutUV, uvTo].map((uv) => findVertex(rpFinal, uv));
  const faceFields = (r: FaceRun): { pieceId: number } | { face?: 'front' | 'back' } =>
    r.pieceId !== undefined ? { pieceId: r.pieceId } : { face: r.face };
  const seams: AssemblySeam[] = [...(work.seams ?? [])];
  let made = 0;
  for (let i = 0; i < partners.length; i++) {
    const from = boundary[i]!;
    const to = boundary[i + 1]!;
    if (from === to) continue; // segment de fraction nulle
    seams.push({ a: { ...faceFields(receiver), from, to }, b: { ...partners[i]! } });
    made += 1;
  }
  if (made === 0) return { ok: false, reason: 'Aucun segment cousable.' };
  return { ok: true, doc: { ...work, seams }, seams: made };
}

/** Remplace la pièce `pieceId` dans le doc (slots 0/1 et pièces libres). */
function replaceDocPiece(doc: DraftDoc, pieceId: number, piece: DraftPiece): DraftDoc {
  if (pieceId === 0) return { ...doc, piece };
  if (pieceId === 1) return { ...doc, back: piece };
  const pieces = [...(doc.pieces ?? [])];
  pieces[pieceId - 2] = piece;
  return { ...doc, pieces };
}

/** La position cyclique `v` est-elle DANS l'arc [from..to] (inclus) ? */
function cyclicWithin(v: number, from: number, to: number, N: number): boolean {
  return (v - from + N) % N <= (to - from + N) % N;
}

/** Pose (ou retrouve) un sommet au point UV du contour de la pièce `pieceId`,
 * avec accrochage aux sommets proches (CUT_SNAP_T) et ré-indexation complète du
 * doc (coutures d'assemblage + mariages ; openEdges/coutures main/surface via
 * insertOutlineVertex). L'index rendu n'est STABLE que jusqu'à la prochaine
 * insertion sur la même pièce — relire par géométrie ensuite. Partagé par
 * Couper & Coudre et la couture libre. */
function placeVertexAtUV(
  work: DraftDoc,
  pieceId: number,
  uv: UV,
): { work: DraftDoc; vertex: number } | null {
  const cur = docPieces(work)[pieceId];
  if (!cur) return null;
  const Ncur = cur.outline.length;
  // Accrochage sommet existant ?
  for (let i = 0; i < Ncur; i++) {
    const q = cur.outline[i]!;
    if (Math.hypot(q[0] - uv[0], q[1] - uv[1]) < 0.004) return { work, vertex: i };
  }
  const { edge } = nearestOutlineEdgeInfo(uv, cur.outline);
  const a = cur.outline[edge]!;
  const b = cur.outline[(edge + 1) % Ncur]!;
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const d2 = ex * ex + ey * ey;
  const t = d2 > 1e-12 ? ((uv[0] - a[0]) * ex + (uv[1] - a[1]) * ey) / d2 : 0;
  if (t <= CUT_SNAP_T) return { work, vertex: edge };
  if (t >= 1 - CUT_SNAP_T) return { work, vertex: (edge + 1) % Ncur };
  const next = insertOutlineVertex(cur, edge, uv);
  const nV = next.outline.length;
  let out = replaceDocPiece(work, pieceId, next);
  out = {
    ...out,
    seams: reindexAssemblySeams(out.seams ?? [], pieceId, 'insert', edge + 1, nV),
    segmentLinks: out.segmentLinks?.length
      ? reindexAssemblySeams(out.segmentLinks, pieceId, 'insert', edge + 1, nV)
      : out.segmentLinks,
  };
  return { work: out, vertex: edge + 1 };
}

export function cutPieceAlongChord(
  doc: DraftDoc,
  pieceId: number,
  cutA: ChordCutPoint,
  cutB: ChordCutPoint,
  /** Chemin INTÉRIEUR de la découpe (scission le long d'une ligne interne) :
   * points UV ordonnés du côté cutA vers le côté cutB. Vide = corde droite. */
  interiorPath: readonly UV[] = [],
  /** Poser une couture d'assemblage le long de la découpe (Shift). */
  withSeam = false,
): ChordCutResult {
  const pieces0 = docPieces(doc);
  const piece0 = pieces0[pieceId];
  if (!piece0 || piece0.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (doc.preset) {
    return {
      ok: false,
      reason: 'Ce modèle intégré utilise un assemblage spécial — la découpe fonctionne sur le t-shirt et les pièces dessinées.',
    };
  }
  if (piece0.wrap) {
    return { ok: false, reason: 'Cette pièce est enroulée (manche/col) — la découpe des tubes viendra plus tard.' };
  }
  if (piece0.placement?.surface) {
    return { ok: false, reason: 'Découper une poche posée n’est pas encore supporté.' };
  }
  if ((doc.pieces?.length ?? 0) >= 14) {
    return { ok: false, reason: 'Trop de pièces libres pour en créer une nouvelle.' };
  }

  // 1 · Poser les deux sommets de découpe (accrochage aux sommets proches).
  //     Insertion du bord le plus haut d'abord : l'index du plus bas ne bouge pas.
  const N0 = piece0.outline.length;
  const norm = (p: ChordCutPoint): ChordCutPoint => ({
    edge: ((Math.round(p.edge) % N0) + N0) % N0,
    t: Math.min(1, Math.max(0, p.t)),
  });
  const first = norm(cutA);
  const second = norm(cutB);
  let work = doc;
  const placeVertex = (p: ChordCutPoint): number | null => {
    // L'arête visée peut avoir été décalée par l'insertion précédente : le
    // point cible est calculé sur le contour D'ORIGINE, puis retrouvé/inséré
    // par proximité géométrique sur l'état courant (helper partagé).
    const a0 = piece0.outline[p.edge]!;
    const b0 = piece0.outline[(p.edge + 1) % N0]!;
    const uv: UV = [a0[0] + (b0[0] - a0[0]) * p.t, a0[1] + (b0[1] - a0[1]) * p.t];
    const placed = placeVertexAtUV(work, pieceId, uv);
    if (!placed) return null;
    work = placed.work;
    return placed.vertex;
  };
  const xiRaw = placeVertex(first);
  if (xiRaw === null) return { ok: false, reason: 'Point de découpe introuvable.' };
  const yiRaw = placeVertex(second);
  if (yiRaw === null) return { ok: false, reason: 'Point de découpe introuvable.' };
  const cutPiece = docPieces(work)[pieceId]!;
  const N = cutPiece.outline.length;
  // xi/yi peuvent avoir bougé si la 2e insertion est passée avant dans l'ordre
  // cyclique — on les retrouve par géométrie.
  const findNear = (p: ChordCutPoint): number => {
    const a0 = piece0.outline[p.edge]!;
    const b0 = piece0.outline[(p.edge + 1) % N0]!;
    const uv: UV = [a0[0] + (b0[0] - a0[0]) * p.t, a0[1] + (b0[1] - a0[1]) * p.t];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const q = cutPiece.outline[i]!;
      const d = Math.hypot(q[0] - uv[0], q[1] - uv[1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const xi = findNear(first);
  const yi = findNear(second);
  if (xi === yi) return { ok: false, reason: 'Les deux points de découpe se confondent.' };
  const spanAB = (yi - xi + N) % N;
  if (spanAB < 2 || (N - spanAB) < 2) {
    return { ok: false, reason: 'La découpe longe le contour — visez deux bords différents.' };
  }
  // La corde doit traverser l'INTÉRIEUR de la pièce.
  const X = cutPiece.outline[xi]!;
  const Y = cutPiece.outline[yi]!;
  if (!interiorPath.length) {
    const mid: UV = [(X[0] + Y[0]) / 2, (X[1] + Y[1]) / 2];
    if (!pointInPolygon(mid, cutPiece.outline)) {
      return { ok: false, reason: 'La découpe doit traverser la pièce de part en part.' };
    }
  }

  // 2 · Les deux moitiés. A = xi→yi (CCW), B = yi→xi. Même repère physique.
  const idxA: number[] = [];
  for (let k = 0; k <= spanAB; k++) idxA.push((xi + k) % N);
  const idxB: number[] = [];
  for (let k = 0; k <= N - spanAB; k++) idxB.push((yi + k) % N);
  const interior = interiorPath.map((q) => [q[0], q[1]] as UV);
  if (idxA.length + interior.length > 128 || idxB.length + interior.length > 128) {
    return { ok: false, reason: 'Contour trop dense pour cette découpe (128 sommets max).' };
  }
  // A = contour xi→yi puis le chemin REBROUSSÉ (yi → … → xi par l'intérieur) ;
  // B = contour yi→xi puis le chemin dans l'ordre. Corde droite : chemins vides.
  const outlineA = [
    ...idxA.map((i) => [...cutPiece.outline[i]!] as UV),
    ...[...interior].reverse(),
  ];
  const outlineB = [
    ...idxB.map((i) => [...cutPiece.outline[i]!] as UV),
    ...interior,
  ];
  if (isSelfIntersecting(outlineA) || isSelfIntersecting(outlineB)) {
    return { ok: false, reason: 'Cette découpe créerait une pièce croisée.' };
  }
  const localA = new Map<number, number>();
  idxA.forEach((old, local) => localA.set(old, local));
  const localB = new Map<number, number>();
  idxB.forEach((old, local) => localB.set(old, local));
  // Une ARÊTE ancienne u (u→u+1) vit dans A ssi son span est dans [xi..yi].
  const edgeInA = (u: number): boolean =>
    cyclicWithin(u, xi, yi, N) && cyclicWithin((u + 1) % N, xi, yi, N) && u !== yi
    && !(u === xi && spanAB === 0);
  const mapEdge = (u: number): { half: 'A' | 'B'; edge: number } =>
    edgeInA(u)
      ? { half: 'A', edge: localA.get(u)! }
      : { half: 'B', edge: localB.get(u)! };

  // 3 · Pinces : chacune suit la moitié qui contient son sommet.
  const dartsA: Dart[] = [];
  const dartsB: Dart[] = [];
  for (const dart of cutPiece.darts) {
    const inA = pointInPolygon(dart.apex, outlineA);
    const target = inA ? outlineA : outlineB;
    if (!pointInPolygon(dart.legA, target) && !pointInPolygon(dart.legB, target)) {
      const nearA = segDistToPoly(dart.legA, target) < 0.03;
      if (!nearA) return { ok: false, reason: 'La découpe traverse une pince — déplacez-la d’abord.' };
    }
    (inA ? dartsA : dartsB).push({ apex: [...dart.apex], legA: [...dart.legA], legB: [...dart.legB] });
  }

  // 4 · Scinder un run ancien en sous-runs par moitié (0, 1 ou 2 morceaux).
  const splitRun = (run: EdgeRun): Array<{ half: 'A' | 'B'; from: number; to: number; fraction: number }> => {
    const steps = (run.to - run.from + N) % N;
    if (steps === 0) return [];
    const parts: Array<{ half: 'A' | 'B'; edges: number[] }> = [];
    for (let k = 0; k < steps; k++) {
      const u = (run.from + k) % N;
      const m = mapEdge(u);
      const last = parts[parts.length - 1];
      if (last && last.half === m.half) last.edges.push(u);
      else parts.push({ half: m.half, edges: [u] });
    }
    const totalLen = runLengthM(cutPiece, run);
    return parts.map((part) => {
      const firstEdge = part.edges[0]!;
      const lastEdge = part.edges[part.edges.length - 1]!;
      const m0 = mapEdge(firstEdge);
      const outLen = m0.half === 'A' ? outlineA.length : outlineB.length;
      const fromLocal = m0.half === 'A' ? localA.get(firstEdge)! : localB.get(firstEdge)!;
      const toLocal = ((m0.half === 'A' ? localA.get(lastEdge)! : localB.get(lastEdge)!) + 1) % outLen;
      let len = 0;
      for (const e of part.edges) {
        len += Math.hypot(
          (cutPiece.outline[(e + 1) % N]![0] - cutPiece.outline[e]![0]) * cutPiece.width,
          (cutPiece.outline[(e + 1) % N]![1] - cutPiece.outline[e]![1]) * cutPiece.height,
        );
      }
      return { half: m0.half, from: fromLocal, to: toLocal, fraction: totalLen > 1e-9 ? len / totalLen : 0 };
    });
  };

  const newPid = 2 + (doc.pieces?.length ?? 0);
  const gridN = doc.gridN;

  // 5 · Réécrire coutures + liens — EN DEUX PHASES. Les scissions de
  //     partenaires insèrent des sommets sur d'autres pièces, ce qui
  //     ré-indexe TOUTES les coutures de ces pièces (deux coutures peuvent
  //     partager le même partenaire — les deux côtés du t-shirt !). Donc :
  //     phase 1 = toutes les insertions de points d'accord, en relisant
  //     chaque couture depuis l'état COURANT ; phase 2 = un remappage unique
  //     sur l'état final, plus aucune insertion.
  let splitSeams = 0;
  let droppedLinks = 0;

  // Un self-seam (les deux côtés sur la pièce coupée) qui traverse la découpe
  // est hors périmètre v1 ; les autres se remappent normalement en phase 2.
  const straddleInfo = new Map<number, { reversed: boolean; cutVertex: number; f1: number }>();
  {
    const seamsNow = work.seams ?? [];
    for (let i = 0; i < seamsNow.length; i++) {
      const s = seamsNow[i]!;
      const aOn = pieceIdOf(s.a) === pieceId;
      const bOn = pieceIdOf(s.b) === pieceId;
      if (!aOn && !bOn) continue;
      const runOn = aOn ? s.a : s.b;
      const parts = splitRun({ from: runOn.from, to: runOn.to });
      if (parts.length !== 2) continue; // 0/1 morceau, ou >2 : traité en phase 2
      if (s.kind === 'zipper') {
        return { ok: false, reason: 'La découpe traverse une fermeture éclair — retirez-la d’abord.' };
      }
      if (aOn && bOn) continue; // self-seam scindé → abandonné en phase 2
      // RELIRE la couture depuis l'état courant : une insertion précédente a pu
      // décaler son run partenaire.
      const cur = (work.seams ?? [])[i]!;
      const partner = aOn ? cur.b : cur.a;
      const partnerPid = pieceIdOf(partner);
      const partnerPiece = docPieces(work)[partnerPid];
      if (!partnerPiece) continue;
      const reversed = runPairReversed(
        cutPiece,
        partnerPiece,
        { from: runOn.from, to: runOn.to },
        { from: partner.from, to: partner.to },
        gridN,
      );
      const f1 = parts[0]!.fraction;
      const splitAt = reversed ? 1 - f1 : f1;
      const ensured = ensureVertexAtRunFraction(
        work,
        partnerPid,
        { from: partner.from, to: partner.to },
        splitAt,
      );
      work = ensured.doc;
      straddleInfo.set(i, { reversed, cutVertex: ensured.vertex, f1 });
    }
  }

  // Phase 2 — remappage unique sur l'état final.
  const remapWholeRun = (r: FaceRun): FaceRun | null => {
    const parts = splitRun({ from: r.from, to: r.to });
    if (parts.length !== 1) return null;
    const p = parts[0]!;
    return p.half === 'A'
      ? { ...r, from: p.from, to: p.to }
      : { pieceId: newPid, from: p.from, to: p.to };
  };

  const outSeams: AssemblySeam[] = [];
  const seamsFinal = work.seams ?? [];
  for (let i = 0; i < seamsFinal.length; i++) {
    const s = seamsFinal[i]!;
    const aOn = pieceIdOf(s.a) === pieceId;
    const bOn = pieceIdOf(s.b) === pieceId;
    if (!aOn && !bOn) {
      outSeams.push(s);
      continue;
    }
    if (aOn && bOn) {
      // Self-seam : remappe si chaque côté reste entier dans une moitié.
      const ma = remapWholeRun(s.a);
      const mb = remapWholeRun(s.b);
      if (ma && mb) outSeams.push({ ...s, a: ma, b: mb });
      else droppedLinks++;
      continue;
    }
    const runOn = aOn ? s.a : s.b;
    const partner = aOn ? s.b : s.a;
    const parts = splitRun({ from: runOn.from, to: runOn.to });
    if (!parts.length) continue;
    if (parts.length === 1) {
      const mapped = remapWholeRun(runOn)!;
      outSeams.push(aOn ? { ...s, a: mapped } : { ...s, b: mapped });
      continue;
    }
    const info = straddleInfo.get(i);
    if (parts.length > 2 || !info) {
      // Un run qui traverse les deux points de découpe : hors périmètre v1.
      droppedLinks++;
      continue;
    }
    const cutV = info.cutVertex;
    const s1: FaceRun = { ...partner, from: partner.from, to: cutV };
    const s2: FaceRun = { ...partner, from: cutV, to: partner.to };
    const runRef = (p: { half: 'A' | 'B'; from: number; to: number }): FaceRun =>
      p.half === 'A' ? { ...runOn, from: p.from, to: p.to } : { pieceId: newPid, from: p.from, to: p.to };
    const partnerFor1 = info.reversed ? s2 : s1;
    const partnerFor2 = info.reversed ? s1 : s2;
    outSeams.push(
      aOn
        ? { ...s, a: runRef(parts[0]!), b: partnerFor1 }
        : { ...s, a: partnerFor1, b: runRef(parts[0]!) },
      aOn
        ? { ...s, a: runRef(parts[1]!), b: partnerFor2 }
        : { ...s, a: partnerFor2, b: runRef(parts[1]!) },
    );
    splitSeams++;
  }

  const outLinks: AssemblySeam[] = [];
  for (const l of work.segmentLinks ?? []) {
    const aOn = pieceIdOf(l.a) === pieceId;
    const bOn = pieceIdOf(l.b) === pieceId;
    if (!aOn && !bOn) {
      outLinks.push(l);
      continue;
    }
    const ma = aOn ? remapWholeRun(l.a) : l.a;
    const mb = bOn ? remapWholeRun(l.b) : l.b;
    if (!ma || !mb) {
      droppedLinks++;
      continue;
    }
    outLinks.push({ ...l, a: ma, b: mb });
  }

  // 6 · Bords ouverts + coutures internes de la pièce.
  const openA: EdgeRun[] = [];
  const openB: EdgeRun[] = [];
  for (const r of cutPiece.openEdges) {
    for (const p of splitRun(r)) {
      (p.half === 'A' ? openA : openB).push({ from: p.from, to: p.to });
    }
  }
  const handA: HandSeam[] = [];
  const handB: HandSeam[] = [];
  for (const hs of cutPiece.seams) {
    const pa = splitRun(hs.a);
    const pb = splitRun(hs.b);
    if (pa.length === 1 && pb.length === 1 && pa[0]!.half === pb[0]!.half) {
      const target = pa[0]!.half === 'A' ? handA : handB;
      target.push({ a: { from: pa[0]!.from, to: pa[0]!.to }, b: { from: pb[0]!.from, to: pb[0]!.to } });
    }
    // Une couture main qui traverse la découpe est abandonnée (v1).
  }

  // 7 · La moitié A garde l'identité (slot, placement, nom) ; B devient une
  //     pièce libre auto-alignée par ses coutures.
  const pieceA: DraftPiece = {
    ...cutPiece,
    outline: outlineA,
    darts: dartsA,
    seams: handA,
    openEdges: openA,
  };
  const labelBase = draftPieceLabel(cutPiece, pieceId);
  const origSoloSheet = cutPiece.singlePanel === true || (!cutPiece.wrap && (!cutPiece.placement || cutPiece.placement.role === 'free'));
  const pieceB: DraftPiece = {
    ...cutPiece,
    outline: outlineB,
    darts: dartsB,
    seams: handB,
    openEdges: openB,
    name: `${labelBase} · découpe`,
    placement: { role: 'auto', autoAlign: false },
    stagingOffset: undefined,
    stagingOffsets: undefined,
    ...(origSoloSheet ? { singlePanel: true } : {}),
  };
  // Un LOGO suit LA moitié qui contient son ancre (comme les poches) — pas de
  // logo dupliqué des deux côtés de la découpe. Un MOTIF répété est un tissu
  // imprimé : les DEUX moitiés le gardent, et comme elles partagent le même
  // cadre, le motif se prolonge sans raccord à travers la découpe (audit).
  if (cutPiece.graphic && !cutPiece.graphic.repeat) {
    if (pointInPolygon(cutPiece.graphic.anchor, outlineA)) {
      delete (pieceB as { graphic?: PieceGraphic }).graphic;
    } else {
      delete (pieceA as { graphic?: PieceGraphic }).graphic;
    }
  }
  // ▱ Lignes internes : chacune suit la moitié qui contient son centroïde
  // (pas de découpe de ligne en v1 — une ligne à cheval part entière).
  if (cutPiece.internalLines?.length) {
    const linesA: InternalLine[] = [];
    const linesB: InternalLine[] = [];
    for (const line of cutPiece.internalLines) {
      let cu = 0;
      let cv = 0;
      for (const [u, v] of line.points) {
        cu += u;
        cv += v;
      }
      const centroid: UV = [cu / line.points.length, cv / line.points.length];
      (pointInPolygon(centroid, outlineA) ? linesA : linesB).push(line);
    }
    if (linesA.length) pieceA.internalLines = linesA;
    else delete (pieceA as { internalLines?: InternalLine[] }).internalLines;
    if (linesB.length) pieceB.internalLines = linesB;
    else delete (pieceB as { internalLines?: InternalLine[] }).internalLines;
  }

  // ⌵ Crans : chacun suit la moitié dont le BORD passe le plus près de lui.
  if (cutPiece.notches?.length) {
    const notchesA: PieceNotch[] = [];
    const notchesB: PieceNotch[] = [];
    for (const notch of cutPiece.notches) {
      (segDistToPoly(notch.at, outlineA) <= segDistToPoly(notch.at, outlineB)
        ? notchesA
        : notchesB
      ).push({ at: [...notch.at] as UV });
    }
    if (notchesA.length) pieceA.notches = notchesA;
    else delete (pieceA as { notches?: PieceNotch[] }).notches;
    if (notchesB.length) pieceB.notches = notchesB;
    else delete (pieceB as { notches?: PieceNotch[] }).notches;
  }

  // 8 · Poches posées sur la pièce coupée : suivre la moitié qui porte l'ancre.
  let docOut: DraftDoc = replaceDocPiece(work, pieceId, pieceA);
  docOut = { ...docOut, pieces: [...(docOut.pieces ?? []), pieceB] };
  const allPieces = docPieces(docOut);
  for (let pid = 2; pid < allPieces.length; pid++) {
    const overlay = allPieces[pid];
    const surf = overlay?.placement?.surface;
    if (!overlay || !surf || surf.supportPieceId !== pieceId) continue;
    const anchorInA = pointInPolygon(surf.anchor, outlineA);
    const nextStitched: number[] = [];
    for (const e of surf.stitchedEdges) nextStitched.push(e);
    const updated: DraftPiece = {
      ...overlay,
      placement: {
        ...overlay.placement!,
        surface: {
          ...surf,
          supportPieceId: anchorInA ? pieceId : newPid,
          stitchedEdges: nextStitched,
        },
      },
    };
    docOut = replaceDocPiece(docOut, pid, updated);
  }

  // 9 · Couture le long de la découpe : seulement si demandé (Shift).
  const finalSeams = withSeam
    ? (() => {
        const chordA: FaceRun = pieceId <= 1
          ? { ...(pieceId === 1 ? { face: 'back' as const } : { face: 'front' as const }), pieceId, from: idxA.length - 1, to: 0 }
          : { pieceId, from: idxA.length - 1, to: 0 };
        const chordB: FaceRun = { pieceId: newPid, from: idxB.length - 1, to: 0 };
        return [...outSeams, { a: chordA, b: chordB }];
      })()
    : outSeams;
  docOut = {
    ...docOut,
    manual: true,
    seams: finalSeams,
    segmentLinks: outLinks.length ? outLinks : undefined,
  };

  return { ok: true, doc: docOut, newPieceId: newPid, splitSeams, droppedLinks };
}

/** Distance UV d'un point au polygone (bord le plus proche). */
function segDistToPoly(p: UV, poly: readonly UV[]): number {
  let d2 = Infinity;
  for (let k = 0; k < poly.length; k++) {
    d2 = Math.min(d2, segDist2(p, poly[k]!, poly[(k + 1) % poly.length]!));
  }
  return Math.sqrt(d2);
}

/* ------------------------------------------------------------------------- *
 * COUTURE LIBRE — coudre deux TRACÉS quelconques du contour (façon Clo
 * « Free Sewing ») : départ et arrivée n'importe où sur le bord, mi-arête
 * comprise, coins passés. Les points d'accord nécessaires sont insérés avec
 * la ré-indexation complète (même machinerie que Couper & Coudre) ; la
 * direction du tracé choisit L'ARC du contour, l'anti-vrillage de
 * l'assembleur reste automatique (pairRunCells).
 * ------------------------------------------------------------------------- */

/** Un tracé de couture libre : du point `start` au point `end` en suivant le
 * contour dans la direction `dir` (+1 = sens des index de sommets croissants,
 * -1 = sens inverse). start/end sont exprimés sur le contour AVANT insertion. */
export interface FreeRunSpec {
  pieceId: number;
  start: ChordCutPoint;
  end: ChordCutPoint;
  dir: 1 | -1;
}

export type FreeSeamResult =
  | { ok: true; doc: DraftDoc; seamIndex: number; lengthAM: number; lengthBM: number }
  | { ok: false; reason: string };

export function freeSeamBetween(
  doc: DraftDoc,
  specA: FreeRunSpec,
  specB: FreeRunSpec,
): FreeSeamResult {
  if (doc.preset) {
    return {
      ok: false,
      reason:
        'Ce modèle intégré utilise un assemblage spécial — la couture libre fonctionne sur le t-shirt et les pièces dessinées.',
    };
  }
  const pieces0 = docPieces(doc);
  for (const spec of [specA, specB]) {
    if (
      !Number.isFinite(spec.start.edge) ||
      !Number.isFinite(spec.start.t) ||
      !Number.isFinite(spec.end.edge) ||
      !Number.isFinite(spec.end.t)
    ) {
      return { ok: false, reason: 'Point de couture invalide.' };
    }
    const piece = pieces0[spec.pieceId];
    if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
    if (piece.outline.length > 124) {
      return { ok: false, reason: 'Contour trop dense pour ajouter des points de couture.' };
    }
    if (piece.placement?.surface) {
      return {
        ok: false,
        reason: 'Une poche posée se coud par ses pointillés (outil 🪡) — pas en couture libre.',
      };
    }
  }

  // 1 · UVs cibles depuis les contours D'ORIGINE (les insertions décalent les
  //     index ; la géométrie, elle, ne bouge pas).
  const uvAt = (pid: number, p: ChordCutPoint): UV => {
    const piece = pieces0[pid]!;
    const N = piece.outline.length;
    const e = ((Math.round(p.edge) % N) + N) % N;
    const t = Math.min(1, Math.max(0, p.t));
    const a = piece.outline[e]!;
    const b = piece.outline[(e + 1) % N]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const targets = [
    { pieceId: specA.pieceId, uv: uvAt(specA.pieceId, specA.start) },
    { pieceId: specA.pieceId, uv: uvAt(specA.pieceId, specA.end) },
    { pieceId: specB.pieceId, uv: uvAt(specB.pieceId, specB.start) },
    { pieceId: specB.pieceId, uv: uvAt(specB.pieceId, specB.end) },
  ] as const;

  // 2 · Poser les (jusqu'à) 4 sommets, en relisant le doc COURANT à chaque pose.
  let work = doc;
  for (const target of targets) {
    const placed = placeVertexAtUV(work, target.pieceId, target.uv);
    if (!placed) return { ok: false, reason: 'Point de couture introuvable.' };
    work = placed.work;
  }

  // 3 · Retrouver les 4 index par géométrie sur l'état FINAL (les insertions
  //     suivantes ont pu décaler les précédents).
  const vertexNear = (pid: number, uv: UV): number => {
    const piece = docPieces(work)[pid]!;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < piece.outline.length; i++) {
      const q = piece.outline[i]!;
      const d = Math.hypot(q[0] - uv[0], q[1] - uv[1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const aStart = vertexNear(specA.pieceId, targets[0].uv);
  const aEnd = vertexNear(specA.pieceId, targets[1].uv);
  const bStart = vertexNear(specB.pieceId, targets[2].uv);
  const bEnd = vertexNear(specB.pieceId, targets[3].uv);
  if (aStart === aEnd || bStart === bEnd) {
    return { ok: false, reason: 'Tracé trop court — écartez le point de départ et celui d’arrivée.' };
  }

  // 4 · Runs orientés par la direction TRACÉE. Un FaceRun se parcourt toujours
  //     dans le sens des index croissants : un tracé en sens inverse décrit le
  //     même arc en échangeant from/to. L'orientation de fermeture (quel bout
  //     rejoint quel bout) reste choisie par l'anti-vrillage de l'assembleur.
  const mkRun = (pid: number, startV: number, endV: number, dir: 1 | -1): FaceRun => {
    const from = dir === 1 ? startV : endV;
    const to = dir === 1 ? endV : startV;
    return pid <= 1 ? { face: pid === 1 ? 'back' : 'front', from, to } : { pieceId: pid, from, to };
  };
  const runA = mkRun(specA.pieceId, aStart, aEnd, specA.dir);
  const runB = mkRun(specB.pieceId, bStart, bEnd, specB.dir);

  // 5 · Garde-fous sur l'état final.
  const pieceA = docPieces(work)[specA.pieceId]!;
  const pieceB = docPieces(work)[specB.pieceId]!;
  const edgesOf = (piece: DraftPiece, r: EdgeRun): Set<number> => {
    const N = piece.outline.length;
    const steps = (r.to - r.from + N) % N;
    const set = new Set<number>();
    for (let k = 0; k < steps; k++) set.add((r.from + k) % N);
    return set;
  };
  const edgesA = edgesOf(pieceA, { from: runA.from, to: runA.to });
  const edgesB = edgesOf(pieceB, { from: runB.from, to: runB.to });
  if (!edgesA.size || !edgesB.size) return { ok: false, reason: 'Tracé vide.' };
  if (specA.pieceId === specB.pieceId) {
    for (const e of edgesA) {
      if (edgesB.has(e)) {
        return { ok: false, reason: 'Les deux tracés se chevauchent sur la même pièce — écartez-les.' };
      }
    }
  }
  const lengthAM = runLengthM(pieceA, { from: runA.from, to: runA.to });
  const lengthBM = runLengthM(pieceB, { from: runB.from, to: runB.to });
  if (lengthAM < 0.01 || lengthBM < 0.01) {
    return { ok: false, reason: 'Tracé trop court pour une couture (moins de 1 cm).' };
  }
  const sameRun = (x: FaceRun, y: FaceRun): boolean =>
    pieceIdOf(x) === pieceIdOf(y) && x.from === y.from && x.to === y.to;
  for (const s of work.seams ?? []) {
    if ((sameRun(s.a, runA) && sameRun(s.b, runB)) || (sameRun(s.a, runB) && sameRun(s.b, runA))) {
      return { ok: false, reason: 'Ces deux bords sont déjà cousus ensemble.' };
    }
  }

  const seams = [...(work.seams ?? []), { a: runA, b: runB }];
  return { ok: true, doc: { ...work, seams }, seamIndex: seams.length - 1, lengthAM, lengthBM };
}

/* ------------------------------------------------------------------------- *
 * MIROIR COUSU (le « Clone-Off Symmetric » de Clo) — dupliquer une pièce en
 * SYMÉTRIE par rapport à un de ses bords, et coudre la paire le long de cet
 * axe. Le geste patronnière fondamental : dessiner un demi-devant, le déplier.
 * La réflexion se fait en espace MÉTRIQUE (vraie sur une pièce non carrée) ;
 * la jumelle est une pièce libre avec son propre cadre, sa pose d'essayage
 * vient de la couture d'axe (placement automatique par les coutures).
 * ------------------------------------------------------------------------- */

export type MirrorDuplicateResult =
  | { ok: true; doc: DraftDoc; newPieceId: number; seamIndex: number }
  | { ok: false; reason: string };

export function mirrorDuplicatePiece(
  doc: DraftDoc,
  pieceId: number,
  axisEdge: number,
): MirrorDuplicateResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : le miroir cousu fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const piece = docPieces(doc)[pieceId];
  if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (piece.blank) return { ok: false, reason: 'Rien à dupliquer ici.' };
  if (piece.wrap) return { ok: false, reason: 'Cette pièce est enroulée (manche/col) — le miroir des tubes viendra plus tard.' };
  if (piece.placement?.surface) {
    return { ok: false, reason: 'Détachez d’abord la pièce de son support (elle est posée dessus).' };
  }
  if ((doc.pieces?.length ?? 0) >= 14) {
    return { ok: false, reason: 'Trop de pièces libres pour en créer une nouvelle.' };
  }
  const N = piece.outline.length;
  const k = ((Math.round(axisEdge) % N) + N) % N;

  // 1 · Réflexion MÉTRIQUE sur la droite du bord-axe.
  const M = ([u, v]: UV): [number, number] => [u * piece.width, v * piece.height];
  const A = M(piece.outline[k]!);
  const B = M(piece.outline[(k + 1) % N]!);
  const axisLen = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (axisLen < 1e-6) return { ok: false, reason: 'Bord d’axe dégénéré.' };
  const dx = (B[0] - A[0]) / axisLen;
  const dy = (B[1] - A[1]) / axisLen;
  const reflect = ([u, v]: UV): [number, number] => {
    const [x, y] = M([u, v]);
    const t = (x - A[0]) * dx + (y - A[1]) * dy;
    const px = A[0] + t * dx;
    const py = A[1] + t * dy;
    return [2 * px - x, 2 * py - y];
  };

  // 2 · Contour jumeau : points réfléchis en ordre INVERSE (une réflexion
  //     retourne l'orientation ; inverser l'ordre la restaure). Le sommet i
  //     devient l'index N-1-i, l'arête k devient l'arête N-2-k.
  const mirroredM = piece.outline.map(reflect).reverse();

  // 3 · Cadre neuf ajusté sur l'emprise réfléchie (même hauteur de monde que
  //     l'original le long de l'axe — le cadre est recentré, positions
  //     physiques du contour préservées dans SON repère).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of mirroredM) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const PAD = 0.01;
  const w = Math.max(0.02, maxX - minX + 2 * PAD);
  const h = Math.max(0.02, maxY - minY + 2 * PAD);
  const toUV = ([x, y]: [number, number]): UV => [
    (x - minX + PAD) / w,
    (y - minY + PAD) / h,
  ];
  const twinOutline = mirroredM.map(toUV);
  const reflectUV = (p: UV): UV => toUV(reflect(p));

  const label = draftPieceLabel(piece, pieceId);
  const twin: DraftPiece = {
    ...piece,
    outline: twinOutline,
    darts: piece.darts.map((d) => ({
      apex: reflectUV(d.apex),
      legA: reflectUV(d.legA),
      legB: reflectUV(d.legB),
    })),
    // Coutures main : les runs suivent l'inversion d'index (from/to échangés).
    seams: piece.seams.map((s) => ({
      a: { from: (N - 1 - s.a.to + N) % N, to: (N - 1 - s.a.from + N) % N },
      b: { from: (N - 1 - s.b.to + N) % N, to: (N - 1 - s.b.from + N) % N },
    })),
    openEdges: [],
    width: w,
    height: h,
    // Même monde vertical (y = topY − y_métrique) : le haut du nouveau cadre
    // se cale pour que chaque point réfléchi garde sa hauteur réelle.
    topY: piece.topY - minY + PAD,
    name: `${label} · miroir`,
    placement: { role: 'auto', autoAlign: true },
    stagingOffset: undefined,
    stagingOffsets: undefined,
    ...(piece.graphic
      ? {
          graphic: {
            ...piece.graphic,
            anchor: reflectUV(piece.graphic.anchor),
            rotationRad: -piece.graphic.rotationRad,
          },
        }
      : {}),
    ...(piece.internalLines?.length
      ? {
          internalLines: piece.internalLines.map((line) => ({
            ...line,
            points: line.points.map(reflectUV),
          })),
        }
      : {}),
    ...(piece.notches?.length
      ? { notches: piece.notches.map((notch) => ({ at: reflectUV(notch.at) })) }
      : {}),
  };

  // 4 · La couture d'axe : l'arête k de l'original ↔ l'arête N-2-k de la
  //     jumelle (l'anti-vrillage de l'assembleur choisit l'orientation).
  const newPieceId = 2 + (doc.pieces?.length ?? 0);
  const mkRun = (pid: number, from: number, to: number): FaceRun =>
    pid <= 1 ? { face: pid === 1 ? 'back' : 'front', from, to } : { pieceId: pid, from, to };
  const seam: AssemblySeam = {
    a: mkRun(pieceId, k, (k + 1) % N),
    b: mkRun(newPieceId, (N - 2 - k + N) % N, (N - 1 - k + N) % N),
  };
  const seams = [...(doc.seams ?? []), seam];
  return {
    ok: true,
    doc: { ...doc, pieces: [...(doc.pieces ?? []), twin], seams },
    newPieceId,
    seamIndex: seams.length - 1,
  };
}

/* ------------------------------------------------------------------------- *
 * OFFSET DU CONTOUR (l'« Offset Pattern Outline » de Clo) — décaler TOUTE la
 * pièce d'une distance uniforme, vers l'extérieur (aisance) ou l'intérieur
 * (doublure). Sommet par sommet le long des bissectrices, en espace MÉTRIQUE
 * (vrai sur une pièce non carrée). Le nombre de points ne change pas : toutes
 * les coutures, mariages et bords ouverts restent valides sans ré-indexation —
 * ils recousent aux nouvelles longueurs (l'embu suit).
 * ------------------------------------------------------------------------- */

export interface OffsetOutlineResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
}

/**
 * Contour de COUPE d'une pièce : sa ligne de couture (`outline`) décalée vers
 * l'EXTÉRIEUR de `marginM` mètres — le trait où le tissu est réellement coupé,
 * la marge de couture. PUR et non destructif (la ligne de couture reste
 * `outline`), pour tracer/exporter le trait de coupe à côté d'elle. Même miter
 * borné et même contrôle du sens par l'aire que `offsetPieceOutline` (donc
 * bulletproof quel que soit l'enroulement), mais renvoie juste un nouvel
 * `UV[]` de même longueur (crans/coutures préservés). `marginM ≤ 0` ⇒ le
 * contour est renvoyé inchangé.
 */
export function seamAllowanceOutline(
  outline: readonly UV[],
  widthM: number,
  heightM: number,
  marginM: number,
): UV[] {
  const N = outline.length;
  const same = (): UV[] => outline.map(([u, v]) => [u, v]);
  if (N < 3 || !(marginM > 0) || !(widthM > 0) || !(heightM > 0)) return same();
  const pts: [number, number][] = outline.map(([u, v]) => [u * widthM, v * heightM]);
  const signedArea = (poly: readonly [number, number][]): number => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const offsetBy = (d: number): [number, number][] => {
    const normals: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % N]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      normals.push(len > 1e-9 ? [ey / len, -ex / len] : [0, 0]);
    }
    return pts.map((p, i) => {
      let np = normals[(i - 1 + N) % N]!;
      let nn = normals[i]!;
      if (np[0] === 0 && np[1] === 0) np = nn;
      if (nn[0] === 0 && nn[1] === 0) nn = np;
      const denom = 1 + (np[0] * nn[0] + np[1] * nn[1]);
      const safe = Math.max(denom, 2 / 16); // miter borné : pointe aiguë ≤ 4×d
      let mx = (np[0] + nn[0]) / safe;
      let my = (np[1] + nn[1]) / safe;
      const m = Math.hypot(mx, my);
      if (m > 4) {
        mx = (mx / m) * 4;
        my = (my / m) * 4;
      }
      return [p[0] + d * mx, p[1] + d * my];
    });
  };
  const areaBefore = signedArea(pts);
  if (Math.abs(areaBefore) < 1e-8) return same();
  let next = offsetBy(marginM);
  // Une distance positive doit AGRANDIR l'aire ; sinon le contour tourne à
  // l'envers et on décale de l'autre côté.
  if ((Math.abs(signedArea(next)) - Math.abs(areaBefore)) * marginM < 0) next = offsetBy(-marginM);
  return next.map(([x, y]) => [x / widthM, y / heightM]);
}

export function offsetPieceOutline(
  doc: DraftDoc,
  pieceId: number,
  distanceM: number,
): OffsetOutlineResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : l’offset fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const piece = docPieces(doc)[pieceId];
  if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  // Audit v150×v154 : décaler la sentinelle invisible du socle vide la ferait
  // grandir jusqu'à devenir un vrai tissu fantôme — indessinable et incliquable.
  if (piece.blank) return { ok: false, reason: 'Rien à décaler ici — dessinez d’abord une pièce.' };
  if (!Number.isFinite(distanceM) || Math.abs(distanceM) < 1e-5) {
    return { ok: false, reason: 'Distance d’offset invalide.' };
  }
  const N = piece.outline.length;
  const W = piece.width;
  const H = piece.height;
  // 1 · Espace métrique (y patron vers le bas, comme v).
  const pts: [number, number][] = piece.outline.map(([u, v]) => [u * W, v * H]);
  const signedArea = (poly: readonly [number, number][]): number => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const areaBefore = signedArea(pts);
  if (Math.abs(areaBefore) < 1e-8) return { ok: false, reason: 'Pièce dégénérée.' };

  const offsetBy = (d: number): [number, number][] => {
    // Normales d'arêtes (perpendiculaire cohérente ; le sens « extérieur » est
    // vérifié après coup par l'aire — bulletproof quel que soit l'enroulement).
    const normals: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % N]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      normals.push(len > 1e-9 ? [ey / len, -ex / len] : [0, 0]);
    }
    return pts.map((p, i) => {
      let np = normals[(i - 1 + N) % N]!;
      let nn = normals[i]!;
      if (np[0] === 0 && np[1] === 0) np = nn;
      if (nn[0] === 0 && nn[1] === 0) nn = np;
      const denom = 1 + (np[0] * nn[0] + np[1] * nn[1]);
      // Miter borné : une pointe aiguë est déplacée d'au plus 4×d (léger
      // arrondi de la distance au lieu d'une aiguille qui explose).
      const safe = Math.max(denom, 2 / 16);
      let mx = (np[0] + nn[0]) / safe;
      let my = (np[1] + nn[1]) / safe;
      const m = Math.hypot(mx, my);
      if (m > 4) {
        mx = (mx / m) * 4;
        my = (my / m) * 4;
      }
      return [p[0] + d * mx, p[1] + d * my];
    });
  };
  // 2 · Une distance positive doit AGRANDIR la pièce, quel que soit le sens
  //     d'enroulement du contour : on vérifie sur l'aire et on retourne sinon.
  let next = offsetBy(distanceM);
  if ((Math.abs(signedArea(next)) - Math.abs(areaBefore)) * distanceM < 0) {
    next = offsetBy(-distanceM);
  }
  // Aucune arête ne doit INVERSER sa direction : un bord qui se retourne a
  // été avalé par l'offset (l'inversion centrale d'un rectangle garde aire et
  // simplicité — seul ce critère l'attrape).
  for (let i = 0; i < N; i++) {
    const a0 = pts[i]!;
    const b0 = pts[(i + 1) % N]!;
    const a1 = next[i]!;
    const b1 = next[(i + 1) % N]!;
    const dot = (b0[0] - a0[0]) * (b1[0] - a1[0]) + (b0[1] - a0[1]) * (b1[1] - a1[1]);
    if (dot <= 0) {
      return {
        ok: false,
        reason:
          distanceM < 0
            ? 'La pièce disparaîtrait — offset trop grand vers l’intérieur.'
            : 'L’offset avale un bord — réduisez la distance.',
      };
    }
  }
  const areaAfter = signedArea(next);
  if (
    Math.abs(areaAfter) < Math.abs(areaBefore) * 0.02 ||
    areaAfter * areaBefore <= 0
  ) {
    return { ok: false, reason: 'La pièce disparaîtrait — offset trop grand vers l’intérieur.' };
  }
  const uvCandidate: UV[] = next.map(([x, y]) => [x / W, y / H]);
  if (isSelfIntersecting(uvCandidate)) {
    return { ok: false, reason: 'L’offset croise le contour — réduisez la distance.' };
  }

  // 3 · Cadre : un offset vers l'extérieur peut sortir de [0,1]² — on prend
  //     une plus grande feuille (largeur centrée, topY remonté), positions
  //     PHYSIQUES du contour et des pinces préservées.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of next) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const needsFrame = minX < 0 || maxX > W || minY < 0 || maxY > H;
  if (!needsFrame) {
    const out: DraftPiece = { ...piece, outline: uvCandidate };
    return { ok: true, doc: replaceDocPiece(doc, pieceId, out) };
  }
  // Le x métrique du doc est x = (u − 0,5)·W : centre du cadre à W/2. On garde
  // ce centre ; la nouvelle largeur couvre l'excursion la plus large.
  const halfW = Math.max(W / 2 - minX, maxX - W / 2);
  const nextW = Math.max(W, (halfW * 2) / 0.98);
  // La nouvelle hauteur couvre l'ANCIEN cadre entier plus toute excursion —
  // haut (minY < 0) comme bas (maxY > H) — avec 1 % de marge de chaque côté.
  const spanY = Math.max(H, maxY) - Math.min(0, minY);
  const nextH = Math.max(H, spanY / 0.98);
  // v = (y − yTop)/H avec yTop = 0 dans notre espace local ; remonter le haut
  // du cadre si le contour est monté au-dessus (minY < 0), en topY réel.
  const yTopLocal = Math.min(0, minY) - 0.01 * nextH;
  const remap = ([x, y]: [number, number]): UV => [
    (x - W / 2) / nextW + 0.5,
    (y - yTopLocal) / nextH,
  ];
  const remapUV = ([u, v]: UV): UV => remap([u * W, v * H]);
  const out: DraftPiece = {
    ...piece,
    outline: next.map(remap),
    darts: piece.darts.map((d) => ({
      apex: remapUV(d.apex),
      legA: remapUV(d.legA),
      legB: remapUV(d.legB),
    })),
    ...remapGraphicAnchor(piece, remapUV),
    width: nextW,
    height: nextH,
    topY: piece.topY - yTopLocal, // yTopLocal ≤ 0 : le cadre monte d'autant
  };
  return { ok: true, doc: replaceDocPiece(doc, pieceId, out) };
}

/* ------------------------------------------------------------------------- *
 * CRÉATION MIROIR AU TRACÉ — le 1er point du tracé pose un AXE VERTICAL ;
 * fermer une moitié dessinée produit la pièce symétrique ENTIÈRE : les points
 * dessinés + leur écho réfléchi en ordre inverse. Le dernier point posé près
 * de l'axe s'y aimante (pas de micro-cran au raccord) et n'est pas doublé.
 * ------------------------------------------------------------------------- */

export function mirrorClosedOutline(points: readonly UV[]): UV[] {
  const pts = points.map((p) => [p[0], p[1]] as UV);
  if (pts.length < 2) return pts;
  const axisU = pts[0]![0];
  const EPS = 0.004;
  const last = pts[pts.length - 1]!;
  if (Math.abs(last[0] - axisU) < EPS) last[0] = axisU;
  const tail = pts.slice(1);
  const mirrored = tail
    .filter((p, i) => !(i === tail.length - 1 && p[0] === axisU))
    .map(([u, v]) => [2 * axisU - u, v] as UV)
    .reverse();
  return [...pts, ...mirrored];
}

/* ------------------------------------------------------------------------- *
 * ⧢ ÉVASEMENT (l'« Add Dart Fullness » de Clo, le COUPER-PIVOTER du
 * patronage) — entailler la pièce du point d'ouverture au pivot, faire
 * tourner un côté autour du pivot : l'ouverture devient de l'AMPLEUR (ourlet
 * évasé, godet, tête froncée). La pièce reste UNE pièce ; l'entaille
 * disparaît dans le tissu ajouté. Tout le décor du côté pivoté suit.
 * ------------------------------------------------------------------------- */

export interface SlashSpreadResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
  /** Ouverture réellement obtenue au bord (m). */
  openedM?: number;
}

export function slashSpreadFullness(
  doc: DraftDoc,
  pieceId: number,
  pivotCut: ChordCutPoint,
  openCut: ChordCutPoint,
  openM: number,
): SlashSpreadResult {
  const pieces0 = docPieces(doc);
  const piece0 = pieces0[pieceId];
  if (!piece0 || piece0.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : l’évasement fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  if (piece0.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  if (piece0.wrap) return { ok: false, reason: 'Cette pièce est enroulée (manche/col) — l’évasement des tubes viendra plus tard.' };
  if (piece0.placement?.surface) {
    return { ok: false, reason: 'Détachez d’abord la pièce de son support.' };
  }
  if (!Number.isFinite(openM) || openM < 0.005) {
    return { ok: false, reason: 'Ouverture trop petite — 5 mm minimum.' };
  }
  if (piece0.outline.length + 3 > 128) {
    return { ok: false, reason: 'Contour trop dense pour un évasement de plus (128 sommets max).' };
  }

  // 1 · Poser le PIVOT puis les DEUX sommets d'ouverture (jumeaux au même
  //     point — l'arête de longueur nulle entre eux deviendra l'ampleur).
  const N0 = piece0.outline.length;
  const uvOfCut = (p: ChordCutPoint): UV => {
    const e = ((Math.round(p.edge) % N0) + N0) % N0;
    const t = Math.min(1, Math.max(0, p.t));
    const a = piece0.outline[e]!;
    const b = piece0.outline[(e + 1) % N0]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const pivotUV = uvOfCut(pivotCut);
  const openUV = uvOfCut(openCut);
  const W = piece0.width;
  const H = piece0.height;
  const L = Math.hypot((openUV[0] - pivotUV[0]) * W, (openUV[1] - pivotUV[1]) * H);
  if (L < 0.03) return { ok: false, reason: 'Pivot et ouverture trop proches — 3 cm minimum.' };
  if (openM > L) {
    return { ok: false, reason: 'Ouverture trop grande pour cette entaille — rapprochez-vous ou réduisez les cm.' };
  }
  // L'entaille doit traverser l'INTÉRIEUR.
  const midCheck: UV = [(pivotUV[0] + openUV[0]) / 2, (pivotUV[1] + openUV[1]) / 2];
  if (!pointInPolygon(midCheck, piece0.outline)) {
    return { ok: false, reason: 'L’entaille doit traverser la pièce de part en part.' };
  }
  // Une pince à cheval sur l'entaille tournerait à moitié : refus propre.
  const sideOf = (pt: UV): number =>
    Math.sign(
      ((openUV[0] - pivotUV[0]) * W) * ((pt[1] - pivotUV[1]) * H) -
        ((openUV[1] - pivotUV[1]) * H) * ((pt[0] - pivotUV[0]) * W),
    );
  for (const d of piece0.darts) {
    const signs = [d.apex, d.legA, d.legB].map(sideOf).filter((x) => x !== 0);
    if (signs.length && new Set(signs).size > 1) {
      return { ok: false, reason: 'L’entaille traverse une pince — déplacez-la d’abord.' };
    }
  }

  let work = doc;
  const placeAt = (uv: UV): number | null => {
    const placed = placeVertexAtUV(work, pieceId, uv);
    if (!placed) return null;
    work = placed.work;
    return placed.vertex;
  };
  if (placeAt(pivotUV) === null) return { ok: false, reason: 'Point de pivot introuvable.' };
  if (placeAt(openUV) === null) return { ok: false, reason: 'Point d’ouverture introuvable.' };
  let piece = docPieces(work)[pieceId]!;
  const findNear = (uv: UV): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < piece.outline.length; i++) {
      const q = piece.outline[i]!;
      const d = Math.hypot(q[0] - uv[0], q[1] - uv[1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  let qa = findNear(openUV);
  // Jumeau Qb juste APRÈS Qa (arête Qa→Qb de longueur nulle), ré-indexé.
  {
    const nBefore = piece.outline.length;
    const qaUV = piece.outline[qa]!;
    piece = insertOutlineVertex(piece, qa, [qaUV[0], qaUV[1]]);
    work = replaceDocPiece(work, pieceId, piece);
    work = {
      ...work,
      seams: reindexAssemblySeams(work.seams ?? [], pieceId, 'insert', qa + 1, nBefore),
      segmentLinks: work.segmentLinks?.length
        ? reindexAssemblySeams(work.segmentLinks, pieceId, 'insert', qa + 1, nBefore)
        : work.segmentLinks,
    };
  }
  piece = docPieces(work)[pieceId]!;
  const N = piece.outline.length;
  const pIdx = findNear(pivotUV);
  qa = findNear(openUV); // le premier des jumeaux
  const qb = (qa + 1) % N;

  // 2 · Rotation MÉTRIQUE du côté B (de Qb au pivot, pivot exclu) autour du
  //     pivot, de l'angle qui ouvre exactement openM au bord. Le SIGNE est
  //     choisi par l'aire : l'évasement AGRANDIT toujours la pièce.
  const theta = 2 * Math.asin(Math.min(1, openM / (2 * L)));
  const P: [number, number] = [pivotUV[0] * W, pivotUV[1] * H];
  const rotate = (pt: UV, ang: number): UV => {
    const x = pt[0] * W - P[0];
    const y = pt[1] * H - P[1];
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    return [(x * c - y * sn + P[0]) / W, (x * sn + y * c + P[1]) / H];
  };
  // Indices du côté B : de qb (inclus) en avançant jusqu'au pivot (exclu).
  const bIndices: number[] = [];
  for (let k = qb; k !== pIdx; k = (k + 1) % N) bIndices.push(k);
  const signedArea = (poly: readonly UV[]): number => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const u = poly[i]!;
      const v = poly[(i + 1) % poly.length]!;
      a += u[0] * W * (v[1] * H) - v[0] * W * (u[1] * H);
    }
    return a / 2;
  };
  const build = (ang: number): UV[] =>
    piece.outline.map((pt, i) => (bIndices.includes(i) ? rotate(pt, ang) : ([pt[0], pt[1]] as UV)));
  const plus = build(theta);
  const minus = build(-theta);
  const outline = Math.abs(signedArea(plus)) >= Math.abs(signedArea(minus)) ? plus : minus;
  const ang = outline === plus ? theta : -theta;
  if (isSelfIntersecting(outline)) {
    return { ok: false, reason: 'Cet évasement croiserait le contour — réduisez l’ouverture.' };
  }

  // 3 · Le décor du côté B tourne avec lui (pinces, ancre, lignes, crans).
  // Référence de côté B : le premier sommet de B strictement hors de la
  // droite d'entaille (un sommet pile dessus rendrait le signe muet).
  let bRefSign = 0;
  for (const k of bIndices) {
    bRefSign = sideOf(piece.outline[k]!);
    if (bRefSign !== 0) break;
  }
  const bSide = (pt: UV): boolean => bRefSign !== 0 && sideOf(pt) === bRefSign;
  const rotIf = (pt: UV): UV => (bSide(pt) ? rotate(pt, ang) : ([pt[0], pt[1]] as UV));
  let next: DraftPiece = {
    ...piece,
    outline,
    darts: piece.darts.map((d) => ({ apex: rotIf(d.apex), legA: rotIf(d.legA), legB: rotIf(d.legB) })),
    ...(piece.graphic ? { graphic: { ...piece.graphic, anchor: rotIf(piece.graphic.anchor) } } : {}),
    ...(piece.internalLines?.length
      ? { internalLines: piece.internalLines.map((l) => ({ ...l, points: l.points.map(rotIf) })) }
      : {}),
    ...(piece.notches?.length ? { notches: piece.notches.map((nt) => ({ at: rotIf(nt.at) })) } : {}),
  };

  // 4 · Cadre : la rotation peut sortir de [0,1]² — même croissance que
  //     l'offset (largeur centrée, topY remonté), tout le décor remappé.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [u, v] of next.outline) {
    minX = Math.min(minX, u * W);
    maxX = Math.max(maxX, u * W);
    minY = Math.min(minY, v * H);
    maxY = Math.max(maxY, v * H);
  }
  if (minX < 0 || maxX > W || minY < 0 || maxY > H) {
    const halfW = Math.max(W / 2 - minX, maxX - W / 2);
    const nextW = Math.max(W, (halfW * 2) / 0.98);
    const spanY = Math.max(H, maxY) - Math.min(0, minY);
    const nextH = Math.max(H, spanY / 0.98);
    const yTopLocal = Math.min(0, minY) - 0.01 * nextH;
    const remapUV = ([u, v]: UV): UV => [((u * W - W / 2) / nextW) + 0.5, (v * H - yTopLocal) / nextH];
    next = {
      ...next,
      outline: next.outline.map(remapUV),
      darts: next.darts.map((d) => ({ apex: remapUV(d.apex), legA: remapUV(d.legA), legB: remapUV(d.legB) })),
      ...remapGraphicAnchor(next, remapUV),
      width: nextW,
      height: nextH,
      topY: next.topY - yTopLocal,
    };
  }

  return { ok: true, doc: replaceDocPiece(work, pieceId, next), openedM: openM };
}

/* ------------------------------------------------------------------------- *
 * ⌵ CRANS DE MONTAGE — poser/retirer un cran sur un bord, et générer les
 * CRANS D'ACCORD d'une couture : les deux côtés reçoivent leurs repères aux
 * positions APPARIÉES par abscisse de couture (sens de fermeture compris),
 * comme au patronage réel — le cran de la manche tombe sur celui du corps.
 * ------------------------------------------------------------------------- */

/** Point UV à la fraction f de la LONGUEUR MÉTRIQUE d'un run du contour. */
export function runPointAtFraction(piece: DraftPiece, run: EdgeRun, fraction: number): UV {
  const N = piece.outline.length;
  const steps = ((run.to - run.from + N) % N) || 1;
  const f = Math.min(1, Math.max(0, fraction));
  const total = runLengthM(piece, run);
  if (total < 1e-9) return [...piece.outline[run.from % N]!] as UV;
  let target = f * total;
  for (let k = 0; k < steps; k++) {
    const a = piece.outline[(run.from + k) % N]!;
    const b = piece.outline[(run.from + k + 1) % N]!;
    const len = Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height);
    if (target <= len || k === steps - 1) {
      const t = len > 1e-12 ? Math.min(1, target / len) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    target -= len;
  }
  return [...piece.outline[run.to % N]!] as UV;
}

const notchNearM = (piece: DraftPiece, a: UV, b: UV): number =>
  Math.hypot((a[0] - b[0]) * piece.width, (a[1] - b[1]) * piece.height);

export interface NotchToggleResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
  action?: 'added' | 'removed';
}

/** Poser un cran au point du bord le plus proche du clic — ou RETIRER le cran
 * existant si le clic tombe dessus (à 6 mm métriques). */
export function toggleNotchAt(doc: DraftDoc, pieceId: number, uvPt: UV): NotchToggleResult {
  const piece = docPieces(doc)[pieceId];
  if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (piece.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  const existing = piece.notches ?? [];
  // Projection sur le bord le plus proche (le cran vit SUR le contour).
  const N = piece.outline.length;
  let best: UV | null = null;
  let bestD = Infinity;
  for (let e = 0; e < N; e++) {
    const a = piece.outline[e]!;
    const b = piece.outline[(e + 1) % N]!;
    const ex = (b[0] - a[0]) * piece.width;
    const ey = (b[1] - a[1]) * piece.height;
    const px = (uvPt[0] - a[0]) * piece.width;
    const py = (uvPt[1] - a[1]) * piece.height;
    const len2 = ex * ex + ey * ey || 1e-12;
    const t = Math.max(0, Math.min(1, (px * ex + py * ey) / len2));
    const d = Math.hypot(px - t * ex, py - t * ey);
    if (d < bestD) {
      bestD = d;
      best = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  if (!best || bestD > 0.03) {
    return { ok: false, reason: 'Cliquez plus près d’un bord — le cran vit sur le contour.' };
  }
  // Bascule sur le point PROJETÉ : re-cliquer le même endroit du bord retire
  // le cran existant (et l'ajout ne peut jamais créer un doublon à 6 mm).
  for (let i = 0; i < existing.length; i++) {
    if (notchNearM(piece, existing[i]!.at, best) < 0.006) {
      const notches = existing.filter((_, k) => k !== i);
      const next: DraftPiece = { ...piece };
      if (notches.length) next.notches = notches;
      else delete (next as { notches?: PieceNotch[] }).notches;
      return { ok: true, doc: replaceDocPiece(doc, pieceId, next), action: 'removed' };
    }
  }
  if (existing.length >= NOTCHES_MAX) {
    return { ok: false, reason: `Plafond atteint : ${NOTCHES_MAX} crans par pièce.` };
  }
  const next: DraftPiece = { ...piece, notches: [...existing, { at: best }] };
  return { ok: true, doc: replaceDocPiece(doc, pieceId, next), action: 'added' };
}

export interface SeamNotchesResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
  added?: number;
}

/** Crans d'accord d'une couture : chaque côté reçoit ses repères aux MÊMES
 * abscisses de couture (1 cran à mi-longueur, 2 aux tiers si > 25 cm), le
 * sens de fermeture respecté (runPairReversed). Idempotent à 6 mm près. */
export function addSeamNotches(doc: DraftDoc, seamIndex: number): SeamNotchesResult {
  const seam = (doc.seams ?? [])[seamIndex];
  if (!seam) return { ok: false, reason: 'Couture introuvable.' };
  const pidA = pieceIdOf(seam.a);
  const pidB = pieceIdOf(seam.b);
  const pieceA = docPieces(doc)[pidA];
  const pieceB = docPieces(doc)[pidB];
  if (!pieceA || !pieceB) return { ok: false, reason: 'Pièces de la couture introuvables.' };
  const lenA = runLengthM(pieceA, seam.a);
  const lenB = runLengthM(pieceB, seam.b);
  const longest = Math.max(lenA, lenB);
  if (longest < 0.03) return { ok: false, reason: 'Couture trop courte pour des crans.' };
  const fractions = longest < 0.25 ? [0.5] : [1 / 3, 2 / 3];
  const reversed = runPairReversed(pieceA, pieceB, seam.a, seam.b, doc.gridN);
  let out = doc;
  let added = 0;
  const place = (pid: number, run: EdgeRun, f: number): void => {
    const cur = docPieces(out)[pid]!;
    const at = runPointAtFraction(cur, run, f);
    const existing = cur.notches ?? [];
    if (existing.some((notch) => notchNearM(cur, notch.at, at) < 0.006)) return;
    if (existing.length >= NOTCHES_MAX) return;
    out = replaceDocPiece(out, pid, { ...cur, notches: [...existing, { at }] });
    added++;
  };
  for (const f of fractions) {
    place(pidA, seam.a, f);
    place(pidB, seam.b, reversed ? 1 - f : f);
  }
  if (!added) return { ok: false, reason: 'Crans déjà en place sur cette couture.' };
  return { ok: true, doc: out, added };
}

/* ------------------------------------------------------------------------- *
 * SCINDER SUR UNE LIGNE INTERNE — la ligne dessinée au ▱ devient le chemin de
 * découpe : ses extrémités sont PROLONGÉES le long de leurs derniers segments
 * jusqu'au contour, puis la pièce se scinde le long du tracé entier (courbes
 * et empiècements en un geste), couture auto-posée sur tout le chemin.
 * ------------------------------------------------------------------------- */

/** Premier bord du contour touché par le rayon métrique parti de `fromUV` dans
 * la direction UV donnée (convertie en métrique). null si aucun. */
function castRayToOutline(
  piece: DraftPiece,
  fromUV: UV,
  dirUV: readonly [number, number],
): ChordCutPoint | null {
  const W = piece.width;
  const H = piece.height;
  const N = piece.outline.length;
  const ox = fromUV[0] * W;
  const oy = fromUV[1] * H;
  const dx = dirUV[0] * W;
  const dy = dirUV[1] * H;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-12) return null;
  let best: { edge: number; t: number; s: number } | null = null;
  for (let e = 0; e < N; e++) {
    const a = piece.outline[e]!;
    const b = piece.outline[(e + 1) % N]!;
    const ax = a[0] * W;
    const ay = a[1] * H;
    const ex = b[0] * W - ax;
    const ey = b[1] * H - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const t = (dx * (oy - ay) - dy * (ox - ax)) / denom;
    const sRay = Math.abs(dx) > Math.abs(dy) ? (ax + t * ex - ox) / dx : (ay + t * ey - oy) / dy;
    if (t < -1e-9 || t > 1 + 1e-9 || sRay < 1e-9) continue;
    if (!best || sRay < best.s) best = { edge: e, t: Math.min(1, Math.max(0, t)), s: sRay };
  }
  return best ? { edge: best.edge, t: best.t } : null;
}

export function cutPieceAlongInternalLine(
  doc: DraftDoc,
  pieceId: number,
  lineIndex: number,
): ChordCutResult {
  const piece = docPieces(doc)[pieceId];
  if (!piece) return { ok: false, reason: 'Pièce introuvable.' };
  const line = piece.internalLines?.[lineIndex];
  if (!line) return { ok: false, reason: 'Ligne interne introuvable.' };
  if (line.closed) {
    return { ok: false, reason: 'Un polygone fermé ne scinde pas la pièce — dessinez une ligne OUVERTE qui la traverse.' };
  }
  const pts = line.points;
  if (pts.length < 2) return { ok: false, reason: 'Ligne trop courte pour scinder.' };
  // Prolonger chaque extrémité le long de SON dernier segment jusqu'au contour.
  const d0: [number, number] = [pts[0]![0] - pts[1]![0], pts[0]![1] - pts[1]![1]];
  const dn: [number, number] = [
    pts[pts.length - 1]![0] - pts[pts.length - 2]![0],
    pts[pts.length - 1]![1] - pts[pts.length - 2]![1],
  ];
  const hitStart = castRayToOutline(piece, pts[0]!, d0);
  const hitEnd = castRayToOutline(piece, pts[pts.length - 1]!, dn);
  if (!hitStart || !hitEnd) {
    return { ok: false, reason: 'La ligne ne rejoint pas le contour — orientez ses extrémités vers les bords.' };
  }
  // La ligne devient LA découpe : elle quitte la pièce avant la scission.
  const remaining = piece.internalLines!.filter((_, i) => i !== lineIndex);
  const trimmed: DraftPiece = { ...piece };
  if (remaining.length) trimmed.internalLines = remaining;
  else delete (trimmed as { internalLines?: InternalLine[] }).internalLines;
  const work = replaceDocPiece(doc, pieceId, trimmed);
  return cutPieceAlongChord(work, pieceId, hitStart, hitEnd, pts);
}

/* ------------------------------------------------------------------------- *
 * ∿ POINT COURBE (l'« Edit Curve Point » de Clo) — arrondir un SOMMET du
 * contour : le coin devient un arc de Bézier quadratique (le coin d'origine
 * en point de contrôle), échantillonné en vrais sommets. Les coutures, bords
 * ouverts, mariages et poches sont ré-indexés par les primitives éprouvées
 * (insertOutlineVertex / deleteOutlineVertex + reindexAssemblySeams).
 * ------------------------------------------------------------------------- */

export const CURVE_POINT_SAMPLES = 6;

export interface RoundCornerResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
  /** Rayon effectivement appliqué (borné par les bords adjacents), en m. */
  radiusM?: number;
}

export function roundOutlineCorner(
  doc: DraftDoc,
  pieceId: number,
  vertex: number,
  radiusM: number,
): RoundCornerResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : le point courbe fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (source.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  const N0 = source.outline.length;
  if (N0 + CURVE_POINT_SAMPLES - 1 > 128) {
    return { ok: false, reason: 'Contour trop dense pour un arrondi de plus (128 sommets max).' };
  }
  const i = ((Math.round(vertex) % N0) + N0) % N0;
  const W = source.width;
  const H = source.height;
  const M = ([u, v]: UV): [number, number] => [u * W, v * H];
  const P = M(source.outline[i]!);
  const A = M(source.outline[(i - 1 + N0) % N0]!);
  const B = M(source.outline[(i + 1) % N0]!);
  const lenIn = Math.hypot(P[0] - A[0], P[1] - A[1]);
  const lenOut = Math.hypot(P[0] - B[0], P[1] - B[1]);
  if (Math.min(lenIn, lenOut) < 0.008) {
    return { ok: false, reason: 'Les bords autour de ce sommet sont trop courts pour un arrondi.' };
  }
  const r = Math.min(Math.max(radiusM, 0.003), 0.45 * Math.min(lenIn, lenOut));
  // Arc de Bézier quadratique : départ/arrivée à r du coin sur chaque bord,
  // le coin d'origine en contrôle. K échantillons, extrémités comprises.
  const start: [number, number] = [P[0] + ((A[0] - P[0]) * r) / lenIn, P[1] + ((A[1] - P[1]) * r) / lenIn];
  const end: [number, number] = [P[0] + ((B[0] - P[0]) * r) / lenOut, P[1] + ((B[1] - P[1]) * r) / lenOut];
  const K = CURVE_POINT_SAMPLES;
  const arc: UV[] = [];
  for (let j = 0; j < K; j++) {
    const t = j / (K - 1);
    const x = (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * P[0] + t * t * end[0];
    const y = (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * P[1] + t * t * end[1];
    arc.push([x / W, y / H]);
  }
  const target = pieceId === 0 ? ('front' as const) : pieceId === 1 ? ('back' as const) : pieceId;
  let piece = source;
  let seams = doc.seams ?? [];
  let links = doc.segmentLinks ?? [];
  let corner = i;
  // 1 · Les points d'arc APRÈS le coin (c1..cK-1), insérés en ordre inverse sur
  //     le bord sortant : chaque insertion à corner+1 laisse le coin en place.
  for (let j = K - 1; j >= 1; j--) {
    const nBefore = piece.outline.length;
    piece = insertOutlineVertex(piece, corner, arc[j]!);
    seams = reindexAssemblySeams(seams, target, 'insert', corner + 1, nBefore);
    links = reindexAssemblySeams(links, target, 'insert', corner + 1, nBefore);
  }
  // 2 · Le point d'arc AVANT le coin (c0), sur le bord entrant. corner = 0 :
  //     l'insertion « après le bord N−1 » tombe en fin de contour, le coin
  //     reste à l'index 0 ; sinon le coin glisse d'un cran.
  {
    const nBefore = piece.outline.length;
    const edge = (corner - 1 + nBefore) % nBefore;
    piece = insertOutlineVertex(piece, edge, arc[0]!);
    seams = reindexAssemblySeams(seams, target, 'insert', edge + 1, nBefore);
    links = reindexAssemblySeams(links, target, 'insert', edge + 1, nBefore);
    if (corner > 0) corner += 1;
  }
  // 3 · Le coin d'origine disparaît : l'arc parle à sa place.
  {
    const nBefore = piece.outline.length;
    piece = deleteOutlineVertex(piece, corner);
    seams = reindexAssemblySeams(seams, target, 'delete', corner, nBefore - 1);
    links = reindexAssemblySeams(links, target, 'delete', corner, nBefore - 1);
  }
  let out = replaceDocPiece(doc, pieceId, piece);
  out = { ...out, seams, segmentLinks: links.length ? links : undefined };
  return { ok: true, doc: out, radiusM: r };
}

/* ------------------------------------------------------------------------- *
 * ◆ PINCE LOSANGE (le « Dart » interne de Clo, la fisheye du patronage) — un
 * losange en plein milieu de pièce, aux deux pointes effilées : LA pince de
 * cintrage taille/poitrine. Un losange = DEUX pinces triangulaires dos à dos
 * partageant leurs jambes — exactement ce que le moteur sait déjà découper et
 * recoudre (compileDraft), donc aucun chemin physique nouveau.
 * ------------------------------------------------------------------------- */

export interface FisheyeDartResult {
  ok: boolean;
  doc?: DraftDoc;
  reason?: string;
  /** Largeur totale du losange à la taille, en mètres. */
  widthM?: number;
  /** Hauteur (pointe à pointe), en mètres. */
  heightM?: number;
}

/** Poser une pince losange : pointes haute et basse + DEMI-largeur métrique.
 * La taille du losange est PERPENDICULAIRE à l'axe en espace MÉTRIQUE (vraie
 * sur une pièce non carrée). Refus propres si le losange sort de la pièce. */
export function addFisheyeDart(
  doc: DraftDoc,
  pieceId: number,
  top: UV,
  bottom: UV,
  halfWidthM: number,
): FisheyeDartResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : la pince losange fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const piece = docPieces(doc)[pieceId];
  if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (piece.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  if (piece.darts.length > 14) {
    return { ok: false, reason: 'Trop de pinces sur cette pièce (16 max — le losange en compte deux).' };
  }
  const W = piece.width;
  const H = piece.height;
  const M = ([u, v]: UV): [number, number] => [u * W, v * H];
  const toUV = ([x, y]: [number, number]): UV => [x / W, y / H];
  const a = M(top);
  const b = M(bottom);
  const axis = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (axis < 0.02) return { ok: false, reason: 'Losange trop court — écartez les deux pointes (2 cm minimum).' };
  if (!Number.isFinite(halfWidthM) || halfWidthM < 0.002) {
    return { ok: false, reason: 'Losange trop étroit — élargissez la taille (4 mm minimum).' };
  }
  // Taille au MILIEU de l'axe, perpendiculaire métrique.
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]) / axis;
  const ny = (b[0] - a[0]) / axis;
  const waistL = toUV([mx - nx * halfWidthM, my - ny * halfWidthM]);
  const waistR = toUV([mx + nx * halfWidthM, my + ny * halfWidthM]);
  for (const pt of [top, bottom, waistL, waistR]) {
    if (!pointInPolygon(pt, piece.outline)) {
      return { ok: false, reason: 'Le losange sort de la pièce — resserrez-le ou déplacez ses pointes.' };
    }
  }
  // Le losange ne doit pas mordre une pince existante (les coutures de deux
  // coins qui se chevauchent se disputeraient les mêmes cellules).
  for (const d of piece.darts) {
    for (const pt of [top, bottom, waistL, waistR]) {
      if (pointInTriangle(pt, d.apex, d.legA, d.legB)) {
        return { ok: false, reason: 'Le losange chevauche une pince existante.' };
      }
    }
    for (const pt of [d.apex, d.legA, d.legB]) {
      if (pointInTriangle(pt, top, waistL, waistR) || pointInTriangle(pt, bottom, waistL, waistR)) {
        return { ok: false, reason: 'Le losange chevauche une pince existante.' };
      }
    }
  }
  const next: DraftPiece = {
    ...piece,
    darts: [
      ...piece.darts,
      { apex: [top[0], top[1]], legA: waistL, legB: waistR },
      { apex: [bottom[0], bottom[1]], legA: waistL, legB: waistR },
    ],
  };
  return {
    ok: true,
    doc: replaceDocPiece(doc, pieceId, next),
    widthM: 2 * halfWidthM,
    heightM: axis,
  };
}

/* ------------------------------------------------------------------------- *
 * MANCHE ADAPTÉE À L'EMMANCHURE — mesurer le run d'emmanchure OUVERT du corps
 * (le même choix de run que sideOpeningCells : le run ouvert le plus à gauche
 * ou à droite, dans le tiers latéral) en LONGUEUR MÉTRIQUE, puis produire une
 * manche dont l'arc de tête mesure exactement ce tour — ou ajuster la largeur
 * d'une pièce dessinée à la main au moment de sa pose sur le bras.
 * ------------------------------------------------------------------------- */

export interface ArmholeMeasure {
  /** Longueur métrique du run d'emmanchure (m). */
  lengthM: number;
  /** Hauteur monde du point le plus haut du run (naissance de la manche). */
  topWorldY: number;
}

/** Mesure l'emmanchure ouverte d'une face du corps, côté demandé. null si la
 * face ne déclare aucun run ouvert dans le tiers latéral correspondant. */
export function measureArmhole(piece: DraftPiece, side: 'L' | 'R'): ArmholeMeasure | null {
  const N = piece.outline.length;
  if (N < 3) return null;
  const M = ([u, v]: UV): [number, number] => [u * piece.width, v * piece.height];
  let best: { lengthM: number; meanU: number; minV: number } | null = null;
  for (const run of piece.openEdges) {
    const steps = ((run.to - run.from + N) % N) || 0;
    if (steps < 1) continue;
    let len = 0;
    let sumU = 0;
    let minV = Infinity;
    for (let i = 0; i < steps; i++) {
      const a = piece.outline[(run.from + i) % N]!;
      const b = piece.outline[(run.from + i + 1) % N]!;
      const [ax, ay] = M(a);
      const [bx, by] = M(b);
      len += Math.hypot(bx - ax, by - ay);
      sumU += (a[0] + b[0]) / 2;
      minV = Math.min(minV, a[1], b[1]);
    }
    const meanU = sumU / steps;
    if (len < 1e-4) continue;
    const pick = side === 'L' ? !best || meanU < best.meanU : !best || meanU > best.meanU;
    if (pick) best = { lengthM: len, meanU, minV };
  }
  if (!best) return null;
  // Même seuil latéral que sideOpeningCells : un run central (ourlet, encolure)
  // n'est jamais une emmanchure.
  if (side === 'L' && best.meanU >= 1 / 3) return null;
  if (side === 'R' && best.meanU <= 2 / 3) return null;
  return { lengthM: best.lengthM, topWorldY: piece.topY - best.minV * piece.height };
}

/** Forme de manche maison (la même famille que le t-shirt paramétrique) :
 * tête en arc sinus, poignet fuselé. */
const SLEEVE_CAP_RATIO = 0.14;
const SLEEVE_CUFF_RATIO = 0.8;
const SLEEVE_CAP_US = [0.1, 0.28, 0.5, 0.72, 0.9] as const;

const sleeveCapLengthM = (w: number, lengthM: number): number => {
  const rise = SLEEVE_CAP_RATIO * lengthM;
  const pts: [number, number][] = [[-0.01 * w, rise]];
  for (const u of SLEEVE_CAP_US) pts.push([u * w, rise * (1 - Math.sin(Math.PI * u))]);
  pts.push([1.01 * w, rise]);
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return len;
};

/** La pièce de manche (tube wrap éditable) dont la TÊTE mesure targetCapM. */
export function fittedSleevePiece(
  targetCapM: number,
  lengthM: number,
  topY: number,
  wrap: 'armL' | 'armR',
): DraftPiece {
  // Résoudre la largeur : l'arc de tête est monotone en w — sécante suffit.
  let w = Math.max(0.04, targetCapM * 0.92);
  for (let it = 0; it < 32; it++) {
    const f = sleeveCapLengthM(w, lengthM) - targetCapM;
    if (Math.abs(f) < 1e-6) break;
    const df = (sleeveCapLengthM(w + 1e-4, lengthM) - sleeveCapLengthM(w, lengthM)) / 1e-4;
    w = Math.max(0.03, w - f / Math.max(df, 1e-6));
  }
  const capArc: UV[] = SLEEVE_CAP_US.map((u) => [
    u,
    SLEEVE_CAP_RATIO * (1 - Math.sin(Math.PI * u)),
  ]);
  const cuffIn = (1.02 * (1 - SLEEVE_CUFF_RATIO)) / 2;
  return {
    outline: [
      [-0.01, SLEEVE_CAP_RATIO],
      ...capArc,
      [1.01, SLEEVE_CAP_RATIO],
      [1.01 - cuffIn, 1.01],
      [-0.01 + cuffIn, 1.01],
    ],
    darts: [],
    seams: [],
    openEdges: [],
    width: w,
    height: lengthM,
    topY,
    gap: 0.18,
    wrap,
    placement: { role: wrap, autoAlign: true },
    name: wrap === 'armR' ? 'Manche droite' : 'Manche gauche',
  };
}

export interface FittedSleevesResult {
  ok: boolean;
  doc?: DraftDoc;
  created?: { side: 'L' | 'R'; pieceId: number; capM: number }[];
  reason?: string;
}

/** Génère une manche ADAPTÉE pour chaque emmanchure libre (droite puis
 * gauche) : tête = moyenne des runs devant/dos, naissance à la hauteur réelle
 * du haut d'emmanchure. Les côtés déjà pourvus d'une manche sont laissés. */
export function generateFittedSleeves(doc: DraftDoc, lengthM = 0.25): FittedSleevesResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : la manche adaptée fonctionne sur le t-shirt et les corps dessinés.' };
  }
  if (doc.piece.blank) {
    return { ok: false, reason: 'Dessinez d’abord un corps — la manche se mesure sur son emmanchure.' };
  }
  const existing = new Set((doc.pieces ?? []).map((p) => p.wrap).filter(Boolean));
  const created: { side: 'L' | 'R'; pieceId: number; capM: number }[] = [];
  let out = doc;
  let blockedBySlots = false;
  for (const side of ['R', 'L'] as const) {
    const wrap = side === 'R' ? ('armR' as const) : ('armL' as const);
    if (existing.has(wrap)) continue;
    const front = measureArmhole(doc.piece, side);
    const back = doc.back ? measureArmhole(doc.back, side) : null;
    if (!front && !back) continue;
    if ((out.pieces?.length ?? 0) >= 14) {
      blockedBySlots = true;
      break;
    }
    const target = ((front?.lengthM ?? back!.lengthM) + (back?.lengthM ?? front!.lengthM)) / 2;
    const topWorldY = Math.max(front?.topWorldY ?? -Infinity, back?.topWorldY ?? -Infinity);
    const len = Math.min(Math.max(lengthM, 0.08), 0.8);
    const piece = fittedSleevePiece(target, len, topWorldY + 0.01, wrap);
    out = { ...out, pieces: [...(out.pieces ?? []), piece] };
    created.push({ side, pieceId: (out.pieces!.length - 1) + 2, capM: target });
  }
  if (!created.length) {
    if (blockedBySlots) return { ok: false, reason: 'Trop de pièces libres pour en créer une nouvelle.' };
    if (existing.has('armR') && existing.has('armL')) {
      return { ok: false, reason: 'Les deux manches sont déjà en place — supprimez-en une pour la régénérer à la cote.' };
    }
    return { ok: false, reason: 'Aucune emmanchure ouverte mesurable — l’emmanchure est un bord laissé LIBRE (non cousu) sur le côté du corps.' };
  }
  return { ok: true, doc: out, created };
}

/** Ajuste la LARGEUR d'une pièce dessinée à la main pour que sa tête (la
 * bouche du tube, qui court sur toute la largeur) corresponde à l'emmanchure
 * mesurée. null si aucune emmanchure ouverte de ce côté. */
export function fitCapWidthToArmhole(
  front: DraftPiece,
  back: DraftPiece | null,
  side: 'L' | 'R',
  piece: DraftPiece,
): { piece: DraftPiece; capM: number } | null {
  const f = measureArmhole(front, side);
  const b = back ? measureArmhole(back, side) : null;
  if (!f && !b) return null;
  const target = ((f?.lengthM ?? b!.lengthM) + (b?.lengthM ?? f!.lengthM)) / 2;
  if (!(target > 0.02)) return null;
  return { piece: { ...piece, width: target }, capM: target };
}

/* ------------------------------------------------------------------------- *
 * FRONCES — allonger le bord froncé (l'« embu » du tailleur).
 *
 * Le moteur fronce déjà : pairRunCells zippe le run le plus long sur le plus
 * court. Froncer = donner PLUS de tissu d'un côté d'une couture — comme au
 * patronage réel, on recoupe la pièce avec un bord plus long, on ne triche
 * pas sur la physique. Cette fonction étire le run choisi le long de sa
 * corde (espace métrique), à ratio × la longueur du côté partenaire.
 * ------------------------------------------------------------------------- */

export interface GatherResult {
  ok: boolean;
  doc?: DraftDoc;
  /** Ratio effectivement atteint (borné par le cadre de la pièce). */
  achievedRatio?: number;
  reason?: string;
}

export function gatherSeamSide(
  doc: DraftDoc,
  seamIndex: number,
  side: 'a' | 'b',
  ratio: number,
): GatherResult {
  const seam = (doc.seams ?? [])[seamIndex];
  if (!seam) return { ok: false, reason: 'Couture introuvable.' };
  if (seam.kind === 'zipper') return { ok: false, reason: 'On ne fronce pas une fermeture éclair.' };
  const runG = side === 'a' ? seam.a : seam.b;
  const runP = side === 'a' ? seam.b : seam.a;
  const pidG = pieceIdOf(runG);
  const pidP = pieceIdOf(runP);
  const pieceG = docPieces(doc)[pidG];
  const pieceP = docPieces(doc)[pidP];
  if (!pieceG || !pieceP) return { ok: false, reason: 'Pièce introuvable.' };
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : les fronces se posent sur le t-shirt et les pièces dessinées.' };
  }
  const r = Math.min(3, Math.max(1.05, ratio));
  const partnerLen = runLengthM(pieceP, { from: runP.from, to: runP.to });
  const currentLen = runLengthM(pieceG, { from: runG.from, to: runG.to });
  if (partnerLen < 1e-6 || currentLen < 1e-6) return { ok: false, reason: 'Bord dégénéré.' };
  const targetLen = partnerLen * r;
  const scale = targetLen / currentLen;
  if (Math.abs(scale - 1) < 0.02) {
    return { ok: false, reason: 'Ce bord est déjà à cette longueur.' };
  }

  // Étirement le long de la corde du run, autour de son milieu, en métrique.
  const N = pieceG.outline.length;
  const steps = (runG.to - runG.from + N) % N;
  const runIdx = new Set<number>();
  for (let k = 0; k <= steps; k++) runIdx.add((runG.from + k) % N);
  const M = (p: UV): [number, number] => [p[0] * pieceG.width, p[1] * pieceG.height];
  const UVof = (m: [number, number]): UV => [m[0] / pieceG.width, m[1] / pieceG.height];
  const A = M(pieceG.outline[runG.from]!);
  const B = M(pieceG.outline[runG.to]!);
  let ax = B[0] - A[0];
  let ay = B[1] - A[1];
  const chord = Math.hypot(ax, ay);
  if (chord < 1e-9) return { ok: false, reason: 'Bord fermé sur lui-même.' };
  ax /= chord;
  ay /= chord;
  const mid: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

  // Le facteur le long de la corde qui produit la longueur cible : étirer
  // axialement de s multiplie la composante axiale de chaque arête par s.
  // Résolution par itération de point fixe (converge en 2-3 tours).
  const lenAt = (s: number): number => {
    let len = 0;
    for (let k = 0; k < steps; k++) {
      const p = M(pieceG.outline[(runG.from + k) % N]!);
      const q = M(pieceG.outline[(runG.from + k + 1) % N]!);
      const paA = (p[0] - mid[0]) * ax + (p[1] - mid[1]) * ay;
      const qaA = (q[0] - mid[0]) * ax + (q[1] - mid[1]) * ay;
      const pPerp: [number, number] = [p[0] - mid[0] - paA * ax, p[1] - mid[1] - paA * ay];
      const qPerp: [number, number] = [q[0] - mid[0] - qaA * ax, q[1] - mid[1] - qaA * ay];
      const dAx = (qaA - paA) * s;
      const dPerp = Math.hypot(qPerp[0] - pPerp[0], qPerp[1] - pPerp[1]);
      len += Math.hypot(dAx, dPerp);
    }
    return len;
  };
  let s = scale;
  for (let it = 0; it < 12; it++) {
    const cur = lenAt(s);
    if (Math.abs(cur - targetLen) < 1e-5) break;
    s *= targetLen / Math.max(1e-9, cur);
  }

  const apply = (sUse: number): UV[] =>
    pieceG.outline.map((p, i) => {
      if (!runIdx.has(i)) return [p[0], p[1]] as UV;
      const m = M(p);
      const a = (m[0] - mid[0]) * ax + (m[1] - mid[1]) * ay;
      const px = m[0] - mid[0] - a * ax;
      const py = m[1] - mid[1] - a * ay;
      return UVof([mid[0] + a * sUse * ax + px, mid[1] + a * sUse * ay + py]);
    });

  // Le ratio demandé est HONORÉ : si le bord allongé déborde du cadre UV de
  // la pièce, on AGRANDIT le cadre (comme un patronnier prend une feuille plus
  // grande) au lieu de rogner les fronces. Les positions PHYSIQUES de tous
  // les sommets sont préservées exactement : x = (u−0,5)·W est invariant par
  // u′ = 0,5 + (u−0,5)·W/W′ ; y = v·H (depuis topY) l'est par v′ = v·H/H′.
  // Aucun index ne bouge — coutures, bords ouverts et pinces restent valides.
  const candidate = apply(s);
  if (isSelfIntersecting(candidate)) {
    return { ok: false, reason: 'Ces fronces replieraient la pièce sur elle-même.' };
  }
  let uHalf = 0; // demi-portée physique autour du centre du cadre, en u
  let vMax = 0;
  let vMin = 0;
  for (const [u, v] of candidate) {
    uHalf = Math.max(uHalf, Math.abs(u - 0.5));
    vMax = Math.max(vMax, v);
    vMin = Math.min(vMin, v);
  }
  let outline = candidate;
  let nextW = pieceG.width;
  let nextH = pieceG.height;
  let nextTopY = pieceG.topY;
  const needsWiden = uHalf > 0.5 || vMax > 1 || vMin < 0;
  if (needsWiden) {
    const margin = 1.02;
    const growU = Math.max(1, (uHalf / 0.5) * margin);
    // v peut déborder vers le bas (v>1) ou vers le haut (v<0 : on remonte topY
    // pour garder l'ancrage physique, y_monde = topY − v·H).
    const growVDown = Math.max(1, vMax * margin);
    const upShift = Math.max(0, -vMin) * margin; // en fraction du H actuel
    nextW = pieceG.width * growU;
    nextH = pieceG.height * (growVDown + upShift);
    nextTopY = pieceG.topY + upShift * pieceG.height;
    outline = candidate.map(([u, v]) => [
      0.5 + (u - 0.5) * (pieceG.width / nextW),
      (v + upShift) * (pieceG.height / nextH),
    ] as UV);
    // Les sommets HORS run doivent aussi rester à leur place physique — c'est
    // le cas : la transformation est appliquée uniformément à tout le contour.
  }

  // La MÊME transformation de cadre s'applique aux pinces et à l'ancre du
  // graphique (audit v151 : elles restaient en UV de l'ancien cadre).
  const frameMap = ([u, v]: UV): UV =>
    needsWiden
      ? [
          0.5 + (u - 0.5) * (pieceG.width / nextW),
          (v + Math.max(0, -vMin) * 1.02) * (pieceG.height / nextH),
        ]
      : [u, v];
  const achieved = lenAt(s) / partnerLen;
  const nextPiece: DraftPiece = {
    ...pieceG,
    outline,
    darts: pieceG.darts.map((d) => ({
      apex: frameMap(d.apex),
      legA: frameMap(d.legA),
      legB: frameMap(d.legB),
    })),
    ...remapGraphicAnchor(pieceG, frameMap),
    width: nextW,
    height: nextH,
    topY: nextTopY,
  };
  return { ok: true, doc: replaceDocPiece(doc, pidG, nextPiece), achievedRatio: achieved };
}

/** Transformée rigide (directe OU réfléchie, la congruence mesurée tranche)
 * posant le run de B sur celui de A, bouts en correspondance de couture
 * (`reversed` au sens de runPairReversed). `lin` transporte un DELTA métrique
 * de B vers A (partie linéaire, miroir compris). Partagé ⧉ / ⛓. */
interface RunFit {
  T: (p: [number, number]) => [number, number];
  lin: (d: [number, number]) => [number, number];
  dev: number;
  th: number;
  mirror: boolean;
}
function fitRunOntoRun(
  A: DraftPiece,
  runA: EdgeRun,
  B: DraftPiece,
  runB: EdgeRun,
  reversed: boolean,
): RunFit | null {
  const NA = A.outline.length;
  const NB = B.outline.length;
  const mA = ([u, v]: UV): [number, number] => [u * A.width, v * A.height];
  const mB = ([u, v]: UV): [number, number] => [u * B.width, v * B.height];
  const aFrom = mA(A.outline[runA.from % NA]!);
  const aTo = mA(A.outline[runA.to % NA]!);
  const bFromIdx = (reversed ? runB.to : runB.from) % NB;
  const bToIdx = (reversed ? runB.from : runB.to) % NB;
  const chordA = Math.hypot(aTo[0] - aFrom[0], aTo[1] - aFrom[1]);
  const K = 16;
  const samplesA: [number, number][] = [];
  for (let k = 0; k <= K; k++) samplesA.push(mA(runPointAtFraction(A, runA, k / K)));
  const candidate = (mirror: boolean): RunFit | null => {
    const pre = ([x, y]: [number, number]): [number, number] => (mirror ? [x, -y] : [x, y]);
    const bf = pre(mB(B.outline[bFromIdx]!));
    const bt = pre(mB(B.outline[bToIdx]!));
    const chordB = Math.hypot(bt[0] - bf[0], bt[1] - bf[1]);
    if (chordA < 1e-6 || chordB < 1e-6) return null;
    const th =
      Math.atan2(aTo[1] - aFrom[1], aTo[0] - aFrom[0]) - Math.atan2(bt[1] - bf[1], bt[0] - bf[0]);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const T = (p: [number, number]): [number, number] => {
      const q = pre(p);
      const dx = q[0] - bf[0];
      const dy = q[1] - bf[1];
      return [aFrom[0] + dx * c - dy * s, aFrom[1] + dx * s + dy * c];
    };
    const lin = (d: [number, number]): [number, number] => {
      const q = pre(d);
      return [q[0] * c - q[1] * s, q[0] * s + q[1] * c];
    };
    let dev = Math.abs(chordA - chordB);
    for (let k = 0; k <= K; k++) {
      const fB = reversed ? 1 - k / K : k / K;
      const pB = T(mB(runPointAtFraction(B, runB, fB)));
      const pA = samplesA[k]!;
      dev = Math.max(dev, Math.hypot(pA[0] - pB[0], pA[1] - pB[1]));
    }
    return { T, lin, dev, th, mirror };
  };
  const cands = [candidate(false), candidate(true)].filter((x): x is RunFit => x !== null);
  if (!cands.length) return null;
  cands.sort((x, y) => x.dev - y.dev);
  return cands[0]!;
}

/* ------------------------------------------------------------------------- *
 * ⧉ FUSIONNER (le « Merge » de Clo) — deux pièces cousues deviennent UNE
 * pièce, la couture s'efface. L'inverse exact du ✂ : la pièce absorbée est
 * posée rigidement contre le bord de l'autre (alignement métrique des deux
 * runs, sens de couture respecté), puis les contours se concatènent et tout
 * le décor (pinces, lignes internes, crans, graphique) suit. HONNÊTETÉ : la
 * fusion n'est acceptée que si les deux bords sont superposables à plat
 * (congruents au millimètre près) — une couture qui porte du volume 3D
 * (princesse, cintrage) ne peut PAS s'aplatir sans mentir : refus motivé,
 * écart mesuré à l'appui.
 * ------------------------------------------------------------------------- */

/** Écart maxi toléré entre les deux bords superposés (m). */
export const MERGE_TOL_M = 0.008;

export type MergeSeamResult =
  | {
      ok: true;
      doc: DraftDoc;
      keptPieceId: number;
      removedPieceId: number;
      /** Écart maxi mesuré entre les deux bords superposés (m). */
      seamGapMaxM: number;
      /** Liens Marier abandonnés (leur bord a disparu dans la fusion). */
      droppedLinks: number;
      note?: string;
    }
  | { ok: false; reason: string };

export function mergePiecesAlongSeam(doc: DraftDoc, seamIndex: number): MergeSeamResult {
  const seams0 = doc.seams ?? [];
  const seam = seams0[seamIndex];
  if (!seam) return { ok: false, reason: 'Couture introuvable.' };
  if (seam.kind === 'zipper') {
    return { ok: false, reason: 'Une fermeture éclair est un ouvrant — elle ne se fond pas dans le patron.' };
  }
  if (doc.preset) {
    return {
      ok: false,
      reason: 'Ce modèle intégré utilise un assemblage spécial — la fusion fonctionne sur le t-shirt et les pièces dessinées.',
    };
  }
  const pidA0 = pieceIdOf(seam.a);
  const pidB0 = pieceIdOf(seam.b);
  if (pidA0 === pidB0) {
    return { ok: false, reason: 'Cette couture relie la pièce à elle-même — rien à fondre.' };
  }
  const keep = Math.min(pidA0, pidB0);
  const gone = Math.max(pidA0, pidB0);
  if (gone <= 1) {
    return {
      ok: false,
      reason: 'Devant et Dos restent les deux faces du patron — leur fusion viendra avec les grandes planches.',
    };
  }
  const pieces0 = docPieces(doc);
  const A = pieces0[keep];
  const B = pieces0[gone];
  if (!A || !B || A.outline.length < 3 || B.outline.length < 3) {
    return { ok: false, reason: 'Pièce introuvable.' };
  }
  if (A.wrap || B.wrap) {
    return { ok: false, reason: 'Cette pièce est enroulée (manche/col) — la fusion des tubes viendra plus tard.' };
  }
  if (A.blank || B.blank) return { ok: false, reason: 'Rien à fondre sur une face vide.' };
  if (A.placement?.surface || B.placement?.surface) {
    return { ok: false, reason: 'Une poche posée vit SUR sa pièce support — détachez-la avant de fusionner.' };
  }
  const runA: EdgeRun =
    pidA0 === keep ? { from: seam.a.from, to: seam.a.to } : { from: seam.b.from, to: seam.b.to };
  const runB: EdgeRun =
    pidA0 === keep ? { from: seam.b.from, to: seam.b.to } : { from: seam.a.from, to: seam.a.to };
  const NA = A.outline.length;
  const NB = B.outline.length;
  const spanA = (runA.to - runA.from + NA) % NA;
  const spanB = (runB.to - runB.from + NB) % NB;
  if (spanA === 0 || spanB === 0) return { ok: false, reason: 'Couture vide — rien à fondre.' };
  if (NA - spanA < 1 || NB - spanB < 1) {
    return { ok: false, reason: 'La couture fait tout le tour — il ne resterait pas de contour.' };
  }

  // 1 · Correspondance des bouts (sens de couture) + transformée rigide B → A,
  //     en espace MÉTRIQUE (vrai sur pièces non carrées). Deux candidates :
  //     directe et réfléchie — la congruence mesurée tranche.
  const mB = ([u, v]: UV): [number, number] => [u * B.width, v * B.height];
  const reversed = runPairReversed(A, B, runA, runB, doc.gridN);
  const best = fitRunOntoRun(A, runA, B, runB, reversed);
  if (!best) return { ok: false, reason: 'Couture dégénérée — rien à fondre.' };
  const bFromIdx = (reversed ? runB.to : runB.from) % NB;
  const bToIdx = (reversed ? runB.from : runB.to) % NB;
  if (best.dev > MERGE_TOL_M) {
    return {
      ok: false,
      reason: `Ces deux bords ne se superposent pas à plat (écart maxi ${(best.dev * 100).toFixed(1)} cm) — cette couture porte du volume ; la fondre mentirait sur le patron.`,
    };
  }

  // 2 · Contour fusionné, en UV ÉTENDU du cadre de A (renormalisé par rebox à
  //     la fin — ce qui remappe aussi tout le décor d'un seul geste).
  const toExtA = (p: [number, number]): UV => [p[0] / A.width, p[1] / A.height];
  interface SrcVert {
    uv: UV;
    aIdx?: number;
    bIdx?: number;
  }
  const merged: SrcVert[] = [];
  const compA = NA - spanA;
  for (let k = 0; k <= compA; k++) {
    const idx = (runA.to + k) % NA;
    merged.push({ uv: [...A.outline[idx]!] as UV, aIdx: idx });
  }
  // Les deux bouts sont PARTAGÉS : premier sommet ≡ bout bToIdx de B, dernier
  // sommet ≡ bFromIdx — annotés des deux identités pour les tables d'arêtes.
  merged[0]!.bIdx = bToIdx;
  merged[merged.length - 1]!.bIdx = bFromIdx;
  const ascB: number[] = [];
  for (let k = 0; k <= NB - spanB; k++) ascB.push((runB.to + k) % NB);
  const pathB = reversed ? ascB : [...ascB].reverse();
  for (let k = 1; k < pathB.length - 1; k++) {
    const idx = pathB[k]!;
    merged.push({ uv: toExtA(best.T(mB(B.outline[idx]!))), bIdx: idx });
  }
  const M = merged.length;
  if (M > 128) return { ok: false, reason: 'Contour trop dense pour cette fusion (128 sommets max).' };
  if (M < 3) return { ok: false, reason: 'Il ne resterait pas de contour après fusion.' };
  const outlineExt = merged.map((v) => v.uv);
  if (isSelfIntersecting(outlineExt)) {
    return { ok: false, reason: 'La fusion croiserait le contour — décousez plutôt cette couture.' };
  }
  const areaOf = (poly: readonly UV[], w: number, h: number): number => {
    let a2 = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      a2 += p[0] * w * (q[1] * h) - q[0] * w * (p[1] * h);
    }
    return Math.abs(a2) / 2;
  };
  const areaA = areaOf(A.outline, A.width, A.height);
  const areaB = areaOf(B.outline, B.width, B.height);
  const areaM = areaOf(outlineExt, A.width, A.height);
  if (Math.abs(areaM - (areaA + areaB)) > Math.max(0.001, 0.02 * (areaA + areaB))) {
    return { ok: false, reason: 'La fusion recouvrirait une pièce sur l’autre — décousez plutôt.' };
  }

  // 3 · Tables ancien → nouveau, sommets puis ARÊTES (les arêtes du run fondu
  //     n'existent plus : toute couture/lien qui s'y accrochait le dira).
  const inRunA = (u: number): boolean => (u - runA.from + NA) % NA < spanA;
  const inRunB = (u: number): boolean => (u - runB.from + NB) % NB < spanB;
  const edgeMapA = new Map<number, number>();
  const edgeMapB = new Map<number, number>();
  for (let i = 0; i < M; i++) {
    const va = merged[i]!;
    const vb = merged[(i + 1) % M]!;
    if (
      va.aIdx !== undefined &&
      vb.aIdx !== undefined &&
      (va.aIdx + 1) % NA === vb.aIdx &&
      !inRunA(va.aIdx)
    ) {
      edgeMapA.set(va.aIdx, i);
    }
    if (va.bIdx !== undefined && vb.bIdx !== undefined) {
      if ((va.bIdx + 1) % NB === vb.bIdx && !inRunB(va.bIdx)) edgeMapB.set(va.bIdx, i);
      else if ((vb.bIdx + 1) % NB === va.bIdx && !inRunB(vb.bIdx)) edgeMapB.set(vb.bIdx, i);
    }
  }
  type RunRemap = EdgeRun | 'lost' | null;
  const remapRun = (pid: number, run: EdgeRun): RunRemap => {
    const onA = pid === keep;
    const onB = pid === gone;
    if (!onA && !onB) return null;
    const N = onA ? NA : NB;
    const map = onA ? edgeMapA : edgeMapB;
    const steps = (run.to - run.from + N) % N;
    if (steps === 0) return 'lost';
    const set = new Set<number>();
    for (let k = 0; k < steps; k++) {
      const e = map.get((run.from + k) % N);
      if (e === undefined) return 'lost';
      set.add(e);
    }
    if (set.size !== steps) return 'lost';
    let start = -1;
    for (const e of set) {
      if (!set.has((e - 1 + M) % M)) {
        if (start >= 0) return 'lost';
        start = e;
      }
    }
    if (start < 0) return 'lost';
    for (let k = 0; k < set.size; k++) if (!set.has((start + k) % M)) return 'lost';
    return { from: start, to: (start + set.size) % M };
  };
  const mkSide = (from: number, to: number): FaceRun =>
    keep <= 1 ? { face: keep === 1 ? 'back' : 'front', from, to } : { pieceId: keep, from, to };

  // 4 · Réécrire coutures d'assemblage, liens Marier, coutures main, bords
  //     ouverts. Une COUTURE accrochée au bord fondu = refus (elle a un sens
  //     physique) ; un LIEN accroché = abandonné (contrainte d'édition).
  const outSeams: AssemblySeam[] = [];
  for (let i = 0; i < seams0.length; i++) {
    if (i === seamIndex) continue;
    const s = seams0[i]!;
    const sides: FaceRun[] = [];
    for (const side of [s.a, s.b]) {
      const rr = remapRun(pieceIdOf(side), { from: side.from, to: side.to });
      if (rr === null) {
        sides.push({ ...side });
        continue;
      }
      if (rr === 'lost') {
        return { ok: false, reason: 'Une autre couture passe sur le bord à fondre — décousez-la d’abord.' };
      }
      sides.push(mkSide(rr.from, rr.to));
    }
    outSeams.push({ ...s, a: sides[0]!, b: sides[1]! });
  }
  let droppedLinks = 0;
  const outLinks: AssemblySeam[] = [];
  for (const link of doc.segmentLinks ?? []) {
    const ra = remapRun(pieceIdOf(link.a), { from: link.a.from, to: link.a.to });
    const rb = remapRun(pieceIdOf(link.b), { from: link.b.from, to: link.b.to });
    if (ra === 'lost' || rb === 'lost') {
      droppedLinks++;
      continue;
    }
    outLinks.push({
      ...link,
      a: ra === null ? { ...link.a } : mkSide(ra.from, ra.to),
      b: rb === null ? { ...link.b } : mkSide(rb.from, rb.to),
    });
  }
  const handSeams: HandSeam[] = [];
  for (const [piece, pid] of [
    [A, keep],
    [B, gone],
  ] as const) {
    for (const hs of piece.seams) {
      const ra = remapRun(pid, hs.a);
      const rb = remapRun(pid, hs.b);
      if (ra === 'lost' || rb === 'lost' || ra === null || rb === null) {
        return { ok: false, reason: 'Une couture main passe sur le bord à fondre — décousez-la d’abord.' };
      }
      handSeams.push({ a: ra, b: rb });
    }
  }
  const openEdgesNew: number[] = [];
  for (const [piece, N, map] of [
    [A, NA, edgeMapA],
    [B, NB, edgeMapB],
  ] as const) {
    for (const run of piece.openEdges) {
      const steps = (run.to - run.from + N) % N;
      for (let k = 0; k < steps; k++) {
        const e = map.get((run.from + k) % N);
        if (e !== undefined) openEdgesNew.push(e);
      }
    }
  }
  const openSet = [...new Set(openEdgesNew)].sort((x, y) => x - y);
  const groupedOpen: EdgeRun[] = [];
  {
    const isOpen = new Set(openSet);
    for (const e of openSet) {
      if (isOpen.has((e - 1 + M) % M) && openSet.length < M) continue; // pas un début de groupe
      let len = 1;
      while (len < openSet.length && isOpen.has((e + len) % M)) len++;
      groupedOpen.push({ from: e, to: (e + len) % M });
      if (openSet.length >= M) break; // tout le tour ouvert (théorique)
    }
  }

  // 5 · Décor réuni : celui de A reste en place, celui de B suit la
  //     transformée rigide. Plafonds de la maison respectés.
  const mapBext = (p: UV): UV => toExtA(best.T(mB(p)));
  const darts: Dart[] = [
    ...A.darts.map((d) => ({ apex: [...d.apex] as UV, legA: [...d.legA] as UV, legB: [...d.legB] as UV })),
    ...B.darts.map((d) => ({ apex: mapBext(d.apex), legA: mapBext(d.legA), legB: mapBext(d.legB) })),
  ];
  if (darts.length > 16) return { ok: false, reason: 'Trop de pinces réunies (16 max par pièce).' };
  const internalLines: InternalLine[] = [
    ...(A.internalLines ?? []).map((line) => ({ ...line, points: line.points.map((p) => [...p] as UV) })),
    ...(B.internalLines ?? []).map((line) => ({ ...line, points: line.points.map(mapBext) })),
  ];
  if (internalLines.length > INTERNAL_LINES_MAX) {
    return { ok: false, reason: `Trop de lignes internes réunies (${INTERNAL_LINES_MAX} max par pièce).` };
  }
  const notches: PieceNotch[] = [
    ...(A.notches ?? []).map((n) => ({ at: [...n.at] as UV })),
    ...(B.notches ?? []).map((n) => ({ at: mapBext(n.at) })),
  ];
  if (notches.length > NOTCHES_MAX) {
    return { ok: false, reason: `Trop de crans réunis (${NOTCHES_MAX} max par pièce).` };
  }
  let note: string | undefined;
  let graphic = A.graphic;
  if (!graphic && B.graphic) {
    if (best.mirror) {
      note = 'Le graphique de la pièce absorbée ne pouvait pas suivre la réflexion — reposez-le.';
    } else {
      graphic = {
        ...B.graphic,
        anchor: mapBext(B.graphic.anchor),
        rotationRad: (B.graphic.rotationRad ?? 0) + best.th,
      };
    }
  } else if (A.graphic && B.graphic) {
    note = 'Deux graphiques pour une seule pièce fusionnée — celui de la pièce conservée reste, reposez l’autre.';
  }

  // 6 · La pièce fusionnée : cadre de A étendu puis renormalisé (rebox — qui
  //     remappe contour, pinces et décor d'un seul geste, sans toucher aux
  //     index), coutures réécrites, pièce absorbée retirée (compactage des
  //     pieceId par la mécanique du ✂).
  const preRebox: DraftPiece = {
    ...A,
    outline: outlineExt.map((p) => [...p] as UV),
    darts,
    seams: handSeams,
    openEdges: groupedOpen,
  };
  if (internalLines.length) preRebox.internalLines = internalLines;
  else delete preRebox.internalLines;
  if (notches.length) preRebox.notches = notches;
  else delete preRebox.notches;
  if (graphic) preRebox.graphic = graphic;
  else delete preRebox.graphic;
  const mergedPiece = reboxPiece(preRebox, A.gap);
  let next = replaceDocPiece(doc, keep, mergedPiece);
  const removed = removeFreePiece(next.pieces ?? [], outSeams, gone);
  const bumpPid = (r: FaceRun): FaceRun => {
    const pid = pieceIdOf(r);
    return pid > gone ? { pieceId: pid - 1, from: r.from, to: r.to } : { ...r };
  };
  const linksOut = outLinks.map((l) => ({ ...l, a: bumpPid(l.a), b: bumpPid(l.b) }));
  next = { ...next, pieces: removed.pieces, seams: removed.seams };
  if (linksOut.length) next.segmentLinks = linksOut;
  else delete next.segmentLinks;
  return {
    ok: true,
    doc: next,
    keptPieceId: keep,
    removedPieceId: gone,
    seamGapMaxM: best.dev,
    droppedLinks,
    ...(note ? { note } : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * ⌾ ÉVIDER (le « Convert to Hole/Internal Shape » de Clo) — une ligne interne
 * FERMÉE devient un TROU : ses cellules intérieures sortent du maillage (le
 * même test point-dans-polygone que le contour, nié), l'export l'imprime en
 * trait de coupe plein, le plan la montre évidée. Re-basculer rebouche : le
 * trou redevient une forme de style. Aucune couture nouvelle — le bord du
 * trou est un bord brut, comme un contour.
 * ------------------------------------------------------------------------- */

export type HoleToggleResult =
  | { ok: true; doc: DraftDoc; holed: boolean }
  | { ok: false; reason: string };

export function toggleInternalHole(
  doc: DraftDoc,
  pieceId: number,
  lineIndex: number,
): HoleToggleResult {
  const piece = docPieces(doc)[pieceId];
  if (!piece || piece.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  const line = piece.internalLines?.[lineIndex];
  if (!line) return { ok: false, reason: 'Ligne interne introuvable.' };
  const commit = (nextLine: InternalLine, holed: boolean): HoleToggleResult => {
    const internalLines = piece.internalLines!.map((l, i) => (i === lineIndex ? nextLine : l));
    return { ok: true, doc: replaceDocPiece(doc, pieceId, { ...piece, internalLines }), holed };
  };
  if (line.hole) {
    const { hole: _off, ...rest } = line;
    return commit({ ...rest, points: line.points.map((p) => [...p] as UV) }, false);
  }
  if (doc.preset) {
    return {
      ok: false,
      reason: 'Ce modèle intégré utilise un assemblage spécial — les trous fonctionnent sur le t-shirt et les pièces dessinées.',
    };
  }
  if (piece.blank) return { ok: false, reason: 'Rien à évider sur une face vide.' };
  if (line.closed !== true || line.points.length < 3) {
    return {
      ok: false,
      reason: 'Une polyligne n’évide rien — fermez le tracé (re-clic au 1er point du ▱) pour faire un trou.',
    };
  }
  if (isSelfIntersecting(line.points)) {
    return { ok: false, reason: 'Ce tracé se croise — il ne peut pas devenir un trou.' };
  }
  // Le trou doit vivre STRICTEMENT dans la pièce : chaque sommet dedans, et
  // aucune arête du trou ne croise le contour.
  for (const pt of line.points) {
    if (!pointInPolygon(pt, piece.outline)) {
      return { ok: false, reason: 'Le trou doit rester DANS la pièce — éloignez-le du contour.' };
    }
  }
  const cross = (a: UV, b: UV, c: UV, d: UV): boolean => {
    const o = (p: UV, q: UV, r: UV): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = o(a, b, c);
    const o2 = o(a, b, d);
    const o3 = o(c, d, a);
    const o4 = o(c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
  };
  const NH = line.points.length;
  const NO = piece.outline.length;
  for (let i = 0; i < NH; i++) {
    const a = line.points[i]!;
    const b = line.points[(i + 1) % NH]!;
    for (let j = 0; j < NO; j++) {
      if (cross(a, b, piece.outline[j]!, piece.outline[(j + 1) % NO]!)) {
        return { ok: false, reason: 'Le trou doit rester DANS la pièce — éloignez-le du contour.' };
      }
    }
  }
  for (const d of piece.darts) {
    if (
      pointInPolygon(d.apex, line.points) ||
      pointInPolygon(d.legA, line.points) ||
      pointInPolygon(d.legB, line.points)
    ) {
      return { ok: false, reason: 'Une pince tombe dans le trou — déplacez-la d’abord.' };
    }
  }
  return commit(
    { ...line, points: line.points.map((p) => [...p] as UV), hole: true },
    true,
  );
}

/* ------------------------------------------------------------------------- *
 * ⛓ ÉDITION LIÉE (le « Linked Editing » de Clo) — retoucher un sommet posé
 * sur un bord COUSU déplace aussi son vis-à-vis sur la pièce partenaire,
 * FORME comprise : le delta est transporté par la transformée rigide qui pose
 * un run sur l'autre (fraction d'arc + sens de couture respectés — la même
 * géométrie que ⧉ Fusionner). Si le partenaire n'a pas de sommet au point
 * correspondant, il en gagne un (insertion réindexée). Un niveau seulement —
 * le suivi ne cascade pas. Les coutures d'une pièce sur elle-même sont
 * laissées de côté (v1).
 * ------------------------------------------------------------------------- */

export type LinkedEditResult =
  | {
      ok: true;
      doc: DraftDoc;
      /** Pièces partenaires qui ont suivi (id + sommet inséré ou non). */
      followed: Array<{ pieceId: number; inserted: boolean }>;
    }
  | { ok: false; reason: string };

export function linkedVertexEdit(
  doc: DraftDoc,
  pieceId: number,
  vertex: number,
  toUV: UV,
): LinkedEditResult {
  const pieces0 = docPieces(doc);
  const source0 = pieces0[pieceId];
  if (!source0 || source0.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  const N0 = source0.outline.length;
  const v0 = ((Math.round(vertex) % N0) + N0) % N0;
  const fromUV = source0.outline[v0]!;
  const deltaM: [number, number] = [
    (toUV[0] - fromUV[0]) * source0.width,
    (toUV[1] - fromUV[1]) * source0.height,
  ];
  if (Math.hypot(deltaM[0], deltaM[1]) < 1e-6) {
    return { ok: true, doc, followed: [] };
  }

  // 1 · Les coutures dont un côté, posé sur CETTE pièce, contient le sommet.
  const inRun = (v: number, run: EdgeRun, N: number): boolean =>
    (v - run.from + N) % N <= (run.to - run.from + N) % N;
  const jobs: Array<{ seamIndex: number; sourceSide: 'a' | 'b' }> = [];
  (doc.seams ?? []).forEach((seam, i) => {
    const pa = pieceIdOf(seam.a);
    const pb = pieceIdOf(seam.b);
    if (pa === pb) return; // self-seam : hors périmètre v1
    if (pa === pieceId && inRun(v0, { from: seam.a.from, to: seam.a.to }, N0)) {
      jobs.push({ seamIndex: i, sourceSide: 'a' });
    } else if (pb === pieceId && inRun(v0, { from: seam.b.from, to: seam.b.to }, N0)) {
      jobs.push({ seamIndex: i, sourceSide: 'b' });
    }
  });
  if (!jobs.length) return { ok: true, doc, followed: [] };

  // 2 · Fraction d'arc du sommet le long de chaque run (géométrie AVANT geste),
  //     fit rigide source → partenaire, transport du delta, sommet partenaire
  //     assuré (insertion réindexée) puis déplacé. Relecture de la couture
  //     depuis l'état courant après chaque insertion (les index bougent).
  let work = doc;
  const followed: Array<{ pieceId: number; inserted: boolean }> = [];
  const moves: Array<{ pieceId: number; vertex: number; toUV: UV }> = [];
  for (const job of jobs) {
    const seam = (work.seams ?? [])[job.seamIndex]!;
    const sourceRunRaw = job.sourceSide === 'a' ? seam.a : seam.b;
    const partnerRunRaw = job.sourceSide === 'a' ? seam.b : seam.a;
    const partnerPid = pieceIdOf(partnerRunRaw);
    const source = docPieces(work)[pieceId]!;
    const partner = docPieces(work)[partnerPid];
    if (!partner || partner.outline.length < 3) continue;
    const sourceRun: EdgeRun = { from: sourceRunRaw.from, to: sourceRunRaw.to };
    const partnerRun: EdgeRun = { from: partnerRunRaw.from, to: partnerRunRaw.to };
    const NS = source.outline.length;
    // Fraction d'arc de v0 sur le run source.
    const steps = (sourceRun.to - sourceRun.from + NS) % NS;
    const total = runLengthM(source, sourceRun);
    if (total < 1e-9 || steps === 0) continue;
    let walked = 0;
    let found = v0 === sourceRun.from % NS;
    for (let k = 0; k < steps && !found; k++) {
      const ia = (sourceRun.from + k) % NS;
      const ib = (sourceRun.from + k + 1) % NS;
      const a = source.outline[ia]!;
      const b = source.outline[ib]!;
      walked += Math.hypot((b[0] - a[0]) * source.width, (b[1] - a[1]) * source.height);
      if (ib === v0) found = true;
    }
    if (!found) continue;
    const f = Math.min(1, Math.max(0, walked / total));
    const reversed = runPairReversed(source, partner, sourceRun, partnerRun, work.gridN);
    const fit = fitRunOntoRun(partner, partnerRun, source, sourceRun, reversed);
    if (!fit) continue;
    const fPartner = reversed ? 1 - f : f;
    const partnerN0 = partner.outline.length;
    const ensured = ensureVertexAtRunFraction(work, partnerPid, partnerRun, fPartner);
    work = ensured.doc;
    const partnerNow = docPieces(work)[partnerPid]!;
    const inserted = partnerNow.outline.length !== partnerN0;
    const dPartner = fit.lin(deltaM);
    const pv = partnerNow.outline[ensured.vertex]!;
    moves.push({
      pieceId: partnerPid,
      vertex: ensured.vertex,
      toUV: [
        pv[0] + dPartner[0] / partnerNow.width,
        pv[1] + dPartner[1] / partnerNow.height,
      ],
    });
    followed.push({ pieceId: partnerPid, inserted });
  }
  if (!moves.length) return { ok: true, doc, followed: [] };

  // 3 · Appliquer : source puis partenaires. Chaque contour doit rester simple,
  //     sinon TOUT le geste est refusé (rien n'est committé à moitié). Un point
  //     qui sort du cadre [0,1]² renormalise sa pièce (rebox — décor compris).
  const applyMove = (
    d: DraftDoc,
    pid: number,
    v: number,
    uv: UV,
  ): { doc: DraftDoc } | { reason: string } => {
    const piece = docPieces(d)[pid]!;
    const outline = piece.outline.map((p, i) => (i === v ? ([uv[0], uv[1]] as UV) : ([...p] as UV)));
    if (isSelfIntersecting(outline)) {
      return {
        reason: `Le suivi croiserait le contour de « ${draftPieceLabel(piece, pid)} » — geste abandonné.`,
      };
    }
    let next: DraftPiece = { ...piece, outline };
    const out = outline.some(([u2, v2]) => u2 < 0 || u2 > 1 || v2 < 0 || v2 > 1);
    if (out) next = reboxPiece(next, piece.gap);
    return { doc: replaceDocPiece(d, pid, next) };
  };
  // Le sommet SOURCE n'a pas bougé d'index : les insertions ne touchent que
  // les partenaires (les self-seams sont exclus).
  const srcApplied = applyMove(work, pieceId, v0, toUV);
  if ('reason' in srcApplied) return { ok: false, reason: srcApplied.reason };
  work = srcApplied.doc;
  for (const mv of moves) {
    const applied = applyMove(work, mv.pieceId, mv.vertex, mv.toUV);
    if ('reason' in applied) return { ok: false, reason: applied.reason };
    work = applied.doc;
  }
  return { ok: true, doc: work, followed };
}

/* ------------------------------------------------------------------------- *
 * ⌖ ÉTABLI DE PRÉCISION (v175) — les gestes « au chiffre » de Clo, en quatre
 * outils d'un seul bouton : diviser un bord en N parts égales (Add Point/
 * Split Line), aligner un sommet sur un autre (Align Points), équerrer un
 * angle (Perpendicular Pattern Corner), prolonger une ligne interne jusqu'au
 * contour et la scinder en deux (Extend/Trim, Divide Internal Lines).
 * ------------------------------------------------------------------------- */

export type PrecisionResult = { ok: true; doc: DraftDoc; note?: string } | { ok: false; reason: string };

/** ◫ Diviser un bord du contour en N parts d'égale longueur (N−1 sommets). */
export function divideOutlineEdge(
  doc: DraftDoc,
  pieceId: number,
  edge: number,
  parts: number,
): PrecisionResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : la division fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (source.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  const n = Math.round(parts);
  if (n < 2 || n > 8) return { ok: false, reason: 'Divisez en 2 à 8 parts.' };
  const N0 = source.outline.length;
  if (N0 + n - 1 > 128) return { ok: false, reason: 'Contour trop dense pour cette division (128 sommets max).' };
  const e = ((Math.round(edge) % N0) + N0) % N0;
  const a = source.outline[e]!;
  const b = source.outline[(e + 1) % N0]!;
  const lenM = Math.hypot((b[0] - a[0]) * source.width, (b[1] - a[1]) * source.height);
  if (lenM < 0.02) return { ok: false, reason: 'Bord trop court à diviser (moins de 2 cm).' };
  const target = pieceId === 0 ? ('front' as const) : pieceId === 1 ? ('back' as const) : pieceId;
  let piece = source;
  let seams = doc.seams ?? [];
  let links = doc.segmentLinks ?? [];
  // Un bord est un segment DROIT : parts égales = fractions égales de t.
  for (let k = n - 1; k >= 1; k--) {
    const t = k / n;
    const uv: UV = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const nBefore = piece.outline.length;
    piece = insertOutlineVertex(piece, e, uv);
    seams = reindexAssemblySeams(seams, target, 'insert', e + 1, nBefore);
    links = reindexAssemblySeams(links, target, 'insert', e + 1, nBefore);
  }
  let out = replaceDocPiece(doc, pieceId, piece);
  out = { ...out, seams, segmentLinks: links.length ? links : undefined };
  return { ok: true, doc: out, note: `${(lenM / n * 100).toFixed(1).replace('.', ',')} cm par part` };
}

/** ⌗ Aligner un sommet sur un autre de la MÊME pièce : même verticale ('x')
 * ou même horizontale ('y'). Rend aussi la cible pour l'édition liée. */
export function alignOutlineVertex(
  doc: DraftDoc,
  pieceId: number,
  vertex: number,
  refVertex: number,
  axis: 'x' | 'y',
): { ok: true; doc: DraftDoc; target: UV } | { ok: false; reason: string } {
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (source.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  const N0 = source.outline.length;
  const v = ((Math.round(vertex) % N0) + N0) % N0;
  const r = ((Math.round(refVertex) % N0) + N0) % N0;
  if (v === r) return { ok: false, reason: 'Choisissez deux sommets différents.' };
  const p = source.outline[v]!;
  const ref = source.outline[r]!;
  const targetUV: UV = axis === 'x' ? [ref[0], p[1]] : [p[0], ref[1]];
  const dM = Math.hypot((targetUV[0] - p[0]) * source.width, (targetUV[1] - p[1]) * source.height);
  if (dM < 0.0005) return { ok: false, reason: 'Ces deux sommets sont déjà alignés (moins d’½ mm).' };
  const outline = source.outline.map((q, i) => (i === v ? ([...targetUV] as UV) : ([...q] as UV)));
  if (isSelfIntersecting(outline)) {
    return { ok: false, reason: 'Cet alignement croiserait le contour — geste abandonné.' };
  }
  return { ok: true, doc: replaceDocPiece(doc, pieceId, { ...source, outline }), target: targetUV };
}

/** ∟ Équerrer un angle : le bord choisi arrive PERPENDICULAIRE à l'autre au
 * sommet cliqué — arc quadratique échantillonné, pour les ourlets et les
 * milieux au pli. */
export function squareCorner(
  doc: DraftDoc,
  pieceId: number,
  vertex: number,
  side: 'prev' | 'next',
): PrecisionResult {
  if (doc.preset) {
    return { ok: false, reason: 'Modèle intégré : l’équerre fonctionne sur le t-shirt et les pièces dessinées.' };
  }
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  if (source.blank) return { ok: false, reason: 'Dessinez d’abord une pièce.' };
  const N0 = source.outline.length;
  const K = CURVE_POINT_SAMPLES;
  if (N0 + K - 1 > 128) return { ok: false, reason: 'Contour trop dense pour une équerre de plus (128 sommets max).' };
  const vIdx = ((Math.round(vertex) % N0) + N0) % N0;
  const W = source.width;
  const H = source.height;
  const M = ([u, v]: UV): [number, number] => [u * W, v * H];
  const V = M(source.outline[vIdx]!);
  const U = M(source.outline[(vIdx - 1 + N0) % N0]!);
  const Wn = M(source.outline[(vIdx + 1) % N0]!);
  const other = side === 'next' ? Wn : U; // bout du bord qui se COURBE
  const refPt = side === 'next' ? U : Wn; // le bord de référence reste droit
  const lenCurve = Math.hypot(other[0] - V[0], other[1] - V[1]);
  const lenRef = Math.hypot(refPt[0] - V[0], refPt[1] - V[1]);
  if (Math.min(lenCurve, lenRef) < 0.01) {
    return { ok: false, reason: 'Les bords autour de ce sommet sont trop courts pour une équerre.' };
  }
  const d1: [number, number] = [(other[0] - V[0]) / lenCurve, (other[1] - V[1]) / lenCurve];
  const d2: [number, number] = [(refPt[0] - V[0]) / lenRef, (refPt[1] - V[1]) / lenRef];
  const angle = (Math.acos(Math.min(1, Math.max(-1, d1[0] * d2[0] + d1[1] * d2[1]))) * 180) / Math.PI;
  if (Math.abs(angle - 90) < 3) {
    return { ok: false, reason: `Déjà d’équerre (${angle.toFixed(1).replace('.', ',')}°).` };
  }
  // Perpendiculaire au bord de référence, orientée vers le bord à courber.
  let perp: [number, number] = [-d2[1], d2[0]];
  if (perp[0] * d1[0] + perp[1] * d1[1] < 0) perp = [-perp[0], -perp[1]];
  const C: [number, number] = [V[0] + perp[0] * 0.4 * lenCurve, V[1] + perp[1] * 0.4 * lenCurve];
  // Quadratique du sommet V vers l'autre bout — tangente en V le long de perp.
  const eIdx = side === 'next' ? vIdx : (vIdx - 1 + N0) % N0;
  const S = M(source.outline[eIdx]!);
  const E = M(source.outline[(eIdx + 1) % N0]!);
  const samples: UV[] = [];
  for (let j = 1; j < K; j++) {
    const t = j / K;
    const x = (1 - t) * (1 - t) * S[0] + 2 * (1 - t) * t * C[0] + t * t * E[0];
    const y = (1 - t) * (1 - t) * S[1] + 2 * (1 - t) * t * C[1] + t * t * E[1];
    samples.push([x / W, y / H]);
  }
  const target = pieceId === 0 ? ('front' as const) : pieceId === 1 ? ('back' as const) : pieceId;
  let piece = source;
  let seams = doc.seams ?? [];
  let links = doc.segmentLinks ?? [];
  for (let j = samples.length - 1; j >= 0; j--) {
    const nBefore = piece.outline.length;
    piece = insertOutlineVertex(piece, eIdx, samples[j]!);
    seams = reindexAssemblySeams(seams, target, 'insert', eIdx + 1, nBefore);
    links = reindexAssemblySeams(links, target, 'insert', eIdx + 1, nBefore);
  }
  if (isSelfIntersecting(piece.outline)) {
    return { ok: false, reason: 'Cette équerre croiserait le contour — geste abandonné.' };
  }
  let out = replaceDocPiece(doc, pieceId, piece);
  out = { ...out, seams, segmentLinks: links.length ? links : undefined };
  return { ok: true, doc: out, note: `angle ${angle.toFixed(1).replace('.', ',')}° → 90°` };
}

/** ⇥ Prolonger un BOUT de ligne interne ouverte jusqu'au contour, dans la
 * direction de son dernier segment (la géométrie du ✂ sur ligne interne). */
export function extendInternalLineEnd(
  doc: DraftDoc,
  pieceId: number,
  lineIndex: number,
  end: 0 | 1,
): PrecisionResult {
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  const line = source.internalLines?.[lineIndex];
  if (!line || line.points.length < 2) return { ok: false, reason: 'Ligne interne introuvable.' };
  if (line.closed) return { ok: false, reason: 'Un polygone fermé n’a pas de bout à prolonger.' };
  if (line.points.length + 1 > INTERNAL_LINE_POINTS_MAX) {
    return { ok: false, reason: `Ligne pleine (${INTERNAL_LINE_POINTS_MAX} points max).` };
  }
  const P = end === 0 ? line.points[0]! : line.points[line.points.length - 1]!;
  const Q = end === 0 ? line.points[1]! : line.points[line.points.length - 2]!;
  const dir: [number, number] = [P[0] - Q[0], P[1] - Q[1]];
  const hit = castRayToOutline(source, P, dir);
  if (!hit) return { ok: false, reason: 'Ce bout ne pointe vers aucun bord de la pièce.' };
  const a = source.outline[hit.edge % source.outline.length]!;
  const b = source.outline[(hit.edge + 1) % source.outline.length]!;
  const onEdge: UV = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t];
  const distM = Math.hypot((onEdge[0] - P[0]) * source.width, (onEdge[1] - P[1]) * source.height);
  if (distM < 0.002) return { ok: false, reason: 'Ce bout touche déjà le contour.' };
  const points = end === 0 ? [onEdge, ...line.points.map((p) => [...p] as UV)] : [...line.points.map((p) => [...p] as UV), onEdge];
  const internalLines = source.internalLines!.map((l, i) => (i === lineIndex ? { ...l, points } : l));
  return {
    ok: true,
    doc: replaceDocPiece(doc, pieceId, { ...source, internalLines }),
    note: `prolongée de ${(distM * 100).toFixed(1).replace('.', ',')} cm`,
  };
}

/** ⇥ Scinder une ligne interne OUVERTE en deux au point cliqué. */
export function divideInternalLineAt(
  doc: DraftDoc,
  pieceId: number,
  lineIndex: number,
  at: UV,
): PrecisionResult {
  const source = docPieces(doc)[pieceId];
  if (!source || source.outline.length < 3) return { ok: false, reason: 'Pièce introuvable.' };
  const line = source.internalLines?.[lineIndex];
  if (!line || line.points.length < 2) return { ok: false, reason: 'Ligne interne introuvable.' };
  if (line.closed) {
    return { ok: false, reason: 'Un polygone fermé ne se scinde pas ici — le ✂ scinde la pièce, ⌾ fait les trous.' };
  }
  if ((source.internalLines?.length ?? 0) + 1 > INTERNAL_LINES_MAX) {
    return { ok: false, reason: `Trop de lignes internes (${INTERNAL_LINES_MAX} max par pièce).` };
  }
  // Projeter le clic sur la ligne (métrique, 8 mm de tolérance).
  const W = source.width;
  const H = source.height;
  let best: { seg: number; t: number; d: number } | null = null;
  for (let s = 0; s < line.points.length - 1; s++) {
    const a = line.points[s]!;
    const b = line.points[s + 1]!;
    const abx = (b[0] - a[0]) * W;
    const aby = (b[1] - a[1]) * H;
    const len2 = abx * abx + aby * aby || 1e-12;
    const t = Math.min(1, Math.max(0, (((at[0] - a[0]) * W) * abx + ((at[1] - a[1]) * H) * aby) / len2));
    const d = Math.hypot((at[0] - a[0]) * W - t * abx, (at[1] - a[1]) * H - t * aby);
    if (!best || d < best.d) best = { seg: s, t, d };
  }
  if (!best || best.d > 0.008) return { ok: false, reason: 'Cliquez SUR la ligne à scinder.' };
  let partA: UV[];
  let partB: UV[];
  const cp = (p: UV): UV => [...p] as UV;
  if (best.t < 0.15 && best.seg >= 1) {
    partA = line.points.slice(0, best.seg + 1).map(cp);
    partB = line.points.slice(best.seg).map(cp);
  } else if (best.t > 0.85 && best.seg + 1 <= line.points.length - 2) {
    partA = line.points.slice(0, best.seg + 2).map(cp);
    partB = line.points.slice(best.seg + 1).map(cp);
  } else {
    const a = line.points[best.seg]!;
    const b = line.points[best.seg + 1]!;
    const P: UV = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
    partA = [...line.points.slice(0, best.seg + 1).map(cp), [...P] as UV];
    partB = [[...P] as UV, ...line.points.slice(best.seg + 1).map(cp)];
  }
  if (partA.length < 2 || partB.length < 2) {
    return { ok: false, reason: 'Scindez plus loin des bouts — chaque moitié doit garder au moins un segment.' };
  }
  const internalLines = [
    ...source.internalLines!.slice(0, lineIndex),
    { points: partA },
    { points: partB },
    ...source.internalLines!.slice(lineIndex + 1),
  ];
  return { ok: true, doc: replaceDocPiece(doc, pieceId, { ...source, internalLines }) };
}
