/**
 * PatternView — the 2D cutting-layout inset (CLO-style dual view).
 * Draws the garment's FRONT pattern pieces flat, from their rest positions:
 * fabric fill, cut outline, stitch marks along mirror seams, and orange links
 * for island-to-island seams (armholes) — i.e. exactly what gets sewn to what.
 *
 * v32: the layout is editable. Each parametric measurement exposes a round
 * handle pinned to its cut edge (hem corner, hem bottom, neckline, sleeve
 * cuff). Dragging a handle previews the new measurement live and, on release,
 * re-cuts and re-sews the garment — the pattern-editor loop.
 *
 * Input model: the canvas keeps pointer-events:none so the inset stays
 * transparent to 3D navigation (orbit/pan work "through" it). Instead we
 * listen on window in the CAPTURE phase and claim a gesture only when it
 * actually lands on a handle; everything else falls through untouched.
 */
import type { ClothMeshData } from '../engine/cloth/ClothMesh';
import { insertOutlineVertex, deleteOutlineVertex, reindexAssemblySeams, pieceIdOf, type UV, type DraftPiece, type AssemblySeam, type FaceRun } from '../engine/pattern/Draft';

/** One draggable measurement, defined against its garment's cutting grid. */
export interface PatternHandleSpec {
  id: string; // matches the ControlPanel setting key
  label: string;
  /** Rest-layout geometry of the garment this handle belongs to. */
  grid: { width: number; topY: number; height: number };
  /** Anchor in grid UV. For 'u' handles, anchor[0] tracks the value. */
  anchor: [number, number];
  /** 'u': horizontal, value = u − 0.5 (half-width). 'y': vertical, in meters from topY. */
  axis: 'u' | 'y';
  value: number;
  min: number;
  max: number;
  unit?: string;
}

/** Where a handle sits in rest-layout coordinates (meters), given a value. */
export function handleLayoutPos(h: PatternHandleSpec, value: number): [number, number] {
  const x = h.axis === 'u' ? value * h.grid.width : (h.anchor[0] - 0.5) * h.grid.width;
  const y = h.axis === 'u' ? h.grid.topY - h.anchor[1] * h.grid.height : h.grid.topY - value;
  return [x, y];
}

/** Inverse: a drag position in rest-layout coordinates → clamped value. */
export function handleValueFromLayout(h: PatternHandleSpec, x: number, y: number): number {
  const raw = h.axis === 'u' ? x / h.grid.width : h.grid.topY - y;
  return Math.min(h.max, Math.max(h.min, raw));
}

/**
 * Glisser-COURBE : les voisins d'arc du sommet saisi. On suit la chaîne des
 * ±2 voisins de v tant que CHAQUE pas est court (≤ step en UV) — vrai le long
 * d'un arc échantillonné (encolure, tête de manche), faux entre deux coins
 * éloignés (épaule↔col, coins d'ourlet). Chaque voisin reçoit un poids
 * d'amorti : tirer un point d'une courbe la déforme en douceur, un coin isolé
 * bouge seul. Pure — testable sans DOM.
 */
export function curveNeighbors(
  outline: readonly UV[],
  v: number,
  step = 0.2,
  weights: readonly number[] = [0.55, 0.22],
): { idx: number; w: number }[] {
  const N = outline.length;
  const out: { idx: number; w: number }[] = [];
  for (const dir of [-1, 1]) {
    let prev = v;
    for (let k = 0; k < weights.length; k++) {
      const idx = (v + dir * (k + 1) + N * 4) % N;
      if (idx === v || out.some((c) => c.idx === idx)) break; // petit polygone : ne pas repasser
      const a = outline[prev]!;
      const b = outline[idx]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > step) break; // un coin : la chaîne s'arrête
      out.push({ idx, w: weights[k]! });
      prev = idx;
    }
  }
  return out;
}

/**
 * Glisser-BOMBER : l'arc qu'un segment devient quand on le tire par un point.
 * Bézier quadratique de a à b dont le contrôle est résolu pour que la courbe
 * PASSE par la souris `m` au paramètre du point saisi (`grab`, projeté sur ab
 * et borné loin des bouts pour rester stable). Renvoie les points INTÉRIEURS
 * de l'arc (sans a ni b), prêts à insérer dans le contour — ou [] si la souris
 * reste trop près de la ligne (l'arc serait plat : rien à courber).
 * Pure — testable sans DOM.
 */
export function bendSamples(a: UV, b: UV, grab: UV, m: UV, minDepth = 0.006): UV[] {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return [];
  const len = Math.sqrt(len2);
  const depth = Math.abs((m[0] - a[0]) * (-aby / len) + (m[1] - a[1]) * (abx / len));
  if (depth < minDepth) return [];
  const t0 = Math.min(0.85, Math.max(0.15, ((grab[0] - a[0]) * abx + (grab[1] - a[1]) * aby) / len2));
  const w = 2 * t0 * (1 - t0);
  const cx = (m[0] - (1 - t0) * (1 - t0) * a[0] - t0 * t0 * b[0]) / w;
  const cy = (m[1] - (1 - t0) * (1 - t0) * a[1] - t0 * t0 * b[1]) / w;
  // Assez de points pour un arc lisse, proportionné à la longueur du segment
  // (les arcs du patron sont déjà échantillonnés à cette densité-là).
  const k = Math.max(3, Math.min(9, Math.round(len * 24)));
  const pts: UV[] = [];
  for (let j = 1; j <= k; j++) {
    const t = j / (k + 1);
    const q0 = (1 - t) * (1 - t);
    const q1 = 2 * t * (1 - t);
    const q2 = t * t;
    pts.push([q0 * a[0] + q1 * cx + q2 * b[0], q0 * a[1] + q1 * cy + q2 * b[1]]);
  }
  return pts;
}

const HIT_RADIUS = 12;
const EDGE_HIT = 8; // click within this many px of an outline edge → add point / bend
const DART_DRAG = 7; // drag farther than this from an edge → it's a bend (Alt: dart), not an add

interface DragState {
  index: number;
  value: number;
  pointerId: number;
  // Grab offset keeps the drag relative: no value jump when the press lands
  // off-center inside the hit radius.
  grabDX: number;
  grabDY: number;
}

export class PatternView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly onChange: (id: string, value: number) => void;

  // The pattern pieces are redrawn into an offscreen layer once per build;
  // hover/drag frames just blit it and repaint the handles.
  private readonly staticLayer: HTMLCanvasElement;
  private staticDirty = true;

  private mesh: ClothMeshData | null = null;
  private handles: PatternHandleSpec[] = [];
  // Rest-layout → canvas transform, captured when the static layer renders.
  private tf: { minA: number; minB: number; scale: number; ox: number; oy: number; H: number } | null = null;
  // Side-by-side layout of a combined outfit's pieces: a per-garment x-offset
  // (layout meters) so overlapping fronts separate, plus each garment's y-range
  // for matching a handle back to its piece. Null for a single garment.
  private gLayout: { offsetX: number[]; gY: [number, number][] } | null = null;

  private hover: number | null = null;
  private drag: DragState | null = null;

  // Freeform "atelier" editing: when a draft piece is set, the outline vertices
  // become draggable handles (a separate path from the parametric handles).
  private readonly onDraftChange: (piece: DraftPiece, pieceId: number, seams?: AssemblySeam[]) => void;
  // Manual-assembly callbacks: add a seam (edge A ↔ edge B), or delete seam #i.
  private readonly onAssemblySeam: (seam: AssemblySeam) => void;
  private readonly onAssemblyDelete: (index: number) => void;
  // Remove a FREE piece (its column + its seams) by pieceId (≥ 2).
  private readonly onDeletePiece: (pieceId: number) => void;
  // Le mode plume s'allume/s'éteint : la barre d'outils montre « Terminer »
  // seulement pendant un tracé (outil contextuel, façon CLO).
  private readonly onPenState: (drawing: boolean) => void;
  // Multi-piece columns (CLO-style): pieces[0]=FRONT, [1]=BACK (may be null,
  // drawn from scratch), [≥2]=FREE pieces (collar, yoke…). Gestures edit
  // whichever column the pointer went down in (`activePiece`); `draftPiece` is
  // that active piece.
  private pieces: (DraftPiece | null)[] = [];
  private activePiece = 0;
  // World-x offset of each column (offsets[0]=0); columns lay out left→right,
  // one per piece, each AS WIDE AS ITS PIECE (body columns span the avatar
  // silhouette; free pieces take just their own width — plan de coupe épuré).
  // colEdges = the boundary x between adjacent columns (mid-gutter), so
  // pickColumn can route a gesture by interval even with unequal widths.
  private offsets: number[] = [];
  private colEdges: number[] = [];
  private get nCols(): number {
    return Math.max(2, this.pieces.length); // front + back always shown, then extras
  }
  private get inDraft(): boolean {
    return this.pieces.some((p) => !!p);
  }
  private pieceAt(pid: number): DraftPiece | null {
    return this.pieces[pid] ?? null;
  }
  private get draftPiece(): DraftPiece | null {
    return this.pieceAt(this.activePiece);
  }
  private setActive(piece: DraftPiece | null): void {
    this.pieces[this.activePiece] = piece;
  }
  private pieceOffset(pid: number): number {
    return this.offsets[pid] ?? 0;
  }
  private activeOffset(): number {
    return this.pieceOffset(this.activePiece);
  }
  /** Human label for a column: DEVANT / DOS / MANCHE D/G / COL / PIÈCE n. */
  private pieceLabel(pid: number): string {
    if (pid === 0) return 'devant';
    if (pid === 1) return 'dos';
    const wrap = this.pieceAt(pid)?.wrap;
    if (wrap === 'armR') return 'manche D';
    if (wrap === 'armL') return 'manche G';
    if (wrap === 'neck') return 'col';
    return `pièce ${pid + 1}`;
  }
  private draftPreview: UV[] | null = null; // live copy while dragging a vertex
  // Glisser-COURBE : les voisins d'arc (reliés au point saisi par des arêtes
  // COURTES = l'échantillonnage d'une courbe) suivent le déplacement avec un
  // amorti — tirer un point d'encolure déforme l'arc en douceur au lieu de
  // faire un pic. Un coin isolé (arêtes longues) bouge seul, comme avant.
  private draftDrag: {
    vertex: number;
    pointerId: number;
    grabDX: number;
    grabDY: number;
    orig: UV[]; // contour figé au début du geste
    curve: { idx: number; w: number }[]; // voisins d'arc + poids d'amorti
  } | null = null;
  private draftHover: number | null = null;
  // A press on an outline edge: a click adds a point; dragging inward pulls a dart.
  private draftEdge: {
    edge: number;
    downUV: UV;
    downSX: number;
    downSY: number;
    pointerId: number;
    apex: UV | null; // pince (Alt+glisser) : pointe de la pince en aperçu
    dart: boolean; // Alt enfoncé à la prise → le glisser tire une pince, pas un arc
    bend: UV[] | null; // bomber (glisser simple) : points intérieurs de l'arc en aperçu
  } | null = null;
  // Manual assembly: user-defined seams (front/back edge ↔ edge), plus the first
  // edge picked while awaiting the second (Shift+click), which may be on either face.
  private assembly: AssemblySeam[] = [];
  private seamPickA: { pieceId: number; edge: number } | null = null;
  // Mode COUDRE guidé (bouton 🪡) : les clics SIMPLES près d'un bord font les
  // deux choix de couture (plus besoin de connaître Maj+clic) ; le mode se
  // referme après la couture. Maj+clic reste disponible en raccourci expert.
  private sewMode = false;
  // Pen tool: drawing a new piece from scratch (click to place points, close it).
  private penMode = false;
  /** Écrit penMode ET prévient la barre d'outils quand l'état change. */
  private setPen(on: boolean): void {
    if (this.penMode !== on) this.onPenState(on);
    this.penMode = on;
  }
  private penPoints: UV[] = [];
  // Filet de sécurité de la plume : la pièce remplacée pendant le tracé, pour
  // la restaurer si le tracé est abandonné (✎ ne détruit jamais un patron).
  private penBackup: DraftPiece | null = null;
  private penBackupPid: number | null = null;
  // Exact avatar silhouette (world-space filled rects + bounds), drawn behind
  // the atelier grid as a size reference, or null to hide it.
  private bodySil: { minX: number; maxX: number; minY: number; maxY: number; rects: Array<[number, number, number, number]> } | null =
    null;

  constructor(
    canvas: HTMLCanvasElement,
    onChange: (id: string, value: number) => void = () => {},
    onDraftChange: (piece: DraftPiece, pieceId: number, seams?: AssemblySeam[]) => void = () => {},
    onAssemblySeam: (seam: AssemblySeam) => void = () => {},
    onAssemblyDelete: (index: number) => void = () => {},
    onDeletePiece: (pieceId: number) => void = () => {},
    onPenState: (drawing: boolean) => void = () => {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onDraftChange = onDraftChange;
    this.onAssemblySeam = onAssemblySeam;
    this.onAssemblyDelete = onAssemblyDelete;
    this.onDeletePiece = onDeletePiece;
    this.onPenState = onPenState;
    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = canvas.width;
    this.staticLayer.height = canvas.height;
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
    window.addEventListener('dblclick', this.onDblClick, true);
    if (import.meta.env.DEV) (window as unknown as { __toilePattern?: PatternView }).__toilePattern = this;
  }

  /** Double-click an outline vertex to remove it (freeform drawing). */
  private readonly onDblClick = (e: MouseEvent): void => {
    if (!this.inDraft) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    this.pickColumn(p[0]);
    if (!this.draftPiece) return;
    const v = this.pickVertex(p[0], p[1]);
    if (v === null) return; // not on a vertex → let the 3D canvas handle it
    const next = deleteOutlineVertex(this.draftPiece, v);
    if (next.outline.length === this.draftPiece.outline.length) return; // ≤3 guard
    e.preventDefault();
    e.stopPropagation();
    // Removing a point shifts edge indices → re-index the assembly seams (on this
    // column's pieceId) so they keep pointing at the same physical edges.
    this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'delete', v, next.outline.length);
    this.applyActive(next);
    this.render();
    this.onDraftChange(next, this.activePiece, this.assembly);
  };

  /** DEV: current outline vertices in canvas-local pixels (for input tests). */
  debugVertexScreens(): [number, number][] {
    if (!this.draftPiece) return [];
    return this.draftPiece.outline
      .map((uv) => this.vertexScreen(uv))
      .filter((s): s is [number, number] => s !== null);
  }

  draw(mesh: ClothMeshData, handles: PatternHandleSpec[] = []): void {
    this.mesh = mesh;
    this.handles = handles;
    this.staticDirty = true;
    this.drag = null;
    this.hover = null;
    this.draftPreview = null; // the rebuild committed the drag
    this.draftDrag = null;
    document.body.style.cursor = '';
    this.render();
  }

  private clonePiece(piece: DraftPiece | null): DraftPiece | null {
    return piece
      ? {
          ...piece,
          outline: piece.outline.map((p) => [p[0], p[1]] as UV),
          openEdges: piece.openEdges.map((r) => ({ ...r })),
          seams: piece.seams.map((s) => ({ a: { ...s.a }, b: { ...s.b } })),
          darts: piece.darts.map((d) => ({ apex: [...d.apex] as UV, legA: [...d.legA] as UV, legB: [...d.legB] as UV })),
        }
      : null;
  }
  private resetDraftTransient(): void {
    this.draftPreview = null;
    this.draftDrag = null;
    this.draftHover = null;
    this.draftEdge = null;
    this.seamPickA = null;
  }

  /** Update the manual-assembly seams to render (front/back edge ↔ edge). */
  setAssembly(seams: AssemblySeam[]): void {
    this.assembly = seams.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));
    this.render();
  }

  /**
   * Enter freeform draft editing (atelier) with the FRONT `piece` and an optional
   * independent BACK face, or leave draft mode (both null).
   */
  setDraft(piece: DraftPiece | null, back: DraftPiece | null = null, extra: DraftPiece[] = []): void {
    this.pieces = [this.clonePiece(piece), this.clonePiece(back), ...extra.map((e) => this.clonePiece(e))];
    // Keep the active column if it still holds a piece; else fall back to front.
    if (!this.pieceAt(this.activePiece)) this.activePiece = 0;
    this.setPen(false);
    this.penPoints = [];
    this.resetDraftTransient();
  }

  /** Replace the ACTIVE face after an edit (keeps the other face + which column). */
  private applyActive(next: DraftPiece): void {
    this.setActive(this.clonePiece(next));
    this.resetDraftTransient();
  }

  /** Show the avatar silhouette behind the atelier grid (or null to hide). */
  setBodySilhouette(
    sil: { minX: number; maxX: number; minY: number; maxY: number; rects: Array<[number, number, number, number]> } | null,
  ): void {
    this.bodySil = sil && sil.rects.length ? sil : null;
    this.staticDirty = true;
    this.render();
  }

  /** Resize the 2D panel canvas (small inset ↔ large CAD panel). */
  resize(w: number, h: number): void {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.staticLayer.width = w;
    this.staticLayer.height = h;
    this.staticDirty = true;
    this.render();
  }

  /** Start drawing a NEW piece from a blank canvas (pen tool), on the front or
   * back column. Only the target face is reset — the other column is kept. */
  startPen(width: number, height: number, topY: number, gap: number, pieceId = 0): void {
    if (this.penMode) this.abortPen(); // un tracé en cours ? on le range d'abord (sans rien perdre)
    this.activePiece = pieceId;
    // Ensure the column slot exists (a new free piece extends the array; back is
    // slot 1). Fill any gap with nulls so indices stay aligned with pieceId.
    while (this.pieces.length <= pieceId) this.pieces.push(null);
    // FILET DE SÉCURITÉ : la pièce existante est mise de côté pendant le tracé.
    // Un tracé abandonné (Terminer sans 3 points, changement d'outil) la
    // RESTAURE — un clic sur ✎ ne peut plus effacer un patron par accident.
    const existing = this.pieceAt(pieceId);
    this.penBackup = existing ? structuredClone(existing) : null;
    this.penBackupPid = pieceId;
    this.setActive({ outline: [], darts: [], seams: [], openEdges: [], width, height, topY, gap });
    this.resetDraftTransient();
    this.setPen(true);
    this.penPoints = [];
    this.render();
  }

  /** Abandonner le tracé en cours : restaure la pièce mise de côté (ou retire
   * la colonne vide d'une pièce toute neuve). Rien n'est perdu. */
  private abortPen(): void {
    if (!this.penMode) return;
    this.setPen(false);
    this.penPoints = [];
    if (this.penBackup) {
      this.applyActive(this.penBackup);
    } else if (this.penBackupPid !== null && this.penBackupPid >= 2 && this.penBackupPid === this.pieces.length - 1 && !this.pieceAt(this.penBackupPid)) {
      this.pieces.pop(); // la colonne vide d'une pièce jamais dessinée disparaît
      if (this.activePiece === this.penBackupPid) this.activePiece = 0;
    }
    this.penBackup = null;
    this.penBackupPid = null;
    this.render();
  }

  get drawing(): boolean {
    return this.penMode;
  }

  /** Basculer le mode COUDRE guidé (bouton 🪡). Rend l'état courant. */
  toggleSew(): boolean {
    this.sewMode = !this.sewMode;
    this.seamPickA = null;
    this.render();
    return this.sewMode;
  }

  get sewing(): boolean {
    return this.sewMode;
  }

  /** Close the drawn outline into a piece (≥3 points), seeding a top opening.
   * Sans 3 points, le tracé est ABANDONNÉ et la pièce d'origine restaurée. */
  finishPen(): void {
    if (!this.penMode) return;
    if (this.penPoints.length < 3 || !this.draftPiece) {
      this.abortPen();
      return;
    }
    this.penBackup = null; // tracé réussi : l'ancienne pièce est volontairement remplacée
    this.penBackupPid = null;
    const outline = this.penPoints.map((p) => [p[0], p[1]] as UV);
    // Seed the topmost edge as an opening so a body can enter (a fully-sewn
    // piece would inflate like a sealed pillow).
    let topEdge = 0;
    let topV = Infinity;
    for (let k = 0; k < outline.length; k++) {
      const v = (outline[k]![1] + outline[(k + 1) % outline.length]![1]) / 2;
      if (v < topV) {
        topV = v;
        topEdge = k;
      }
    }
    const next = { ...this.draftPiece, outline, openEdges: [{ from: topEdge, to: (topEdge + 1) % outline.length }] };
    this.setPen(false);
    this.penPoints = [];
    this.applyActive(next);
    this.render();
    this.onDraftChange(next, this.activePiece);
  }

  /** True when a FREE piece (a drawn column, pieceId ≥ 2) is the active one —
   * i.e. deleting is meaningful. The base front/back can't be removed. */
  get canDeleteActive(): boolean {
    return this.activePiece >= 2 && !!this.pieceAt(this.activePiece);
  }

  /** Remove the active FREE piece (its column + the seams touching it). No-op on
   * the base front/back. The rebuild re-lays the remaining columns. */
  deleteActiveFreePiece(): void {
    if (!this.canDeleteActive) return;
    const pid = this.activePiece;
    this.activePiece = 0; // fall back to the front before the columns re-index
    this.setPen(false);
    this.penPoints = [];
    this.resetDraftTransient();
    this.onDeletePiece(pid);
  }

  /** Screen position of an outline vertex: UV → world layout (+ the face's column
   * offset) → screen. Defaults to the active face; pass (piece, offset) to draw
   * the other column. */
  private vertexScreen(uv: UV, piece: DraftPiece | null = this.draftPiece, offset: number = this.activeOffset()): [number, number] | null {
    if (!this.tf || !piece) return null;
    const x = (uv[0] - 0.5) * piece.width + offset;
    const y = piece.topY - uv[1] * piece.height;
    return this.layoutToScreen(x, y);
  }

  /** A screen point → the ACTIVE face's outline UV, clamped to [0,1]². */
  private screenToUV(px: number, py: number): UV {
    const [x, y] = this.screenToLayout(px, py);
    const p = this.draftPiece!;
    return [
      Math.min(1, Math.max(0, (x - this.activeOffset()) / p.width + 0.5)),
      Math.min(1, Math.max(0, (p.topY - y) / p.height)),
    ];
  }

  /** Route a gesture to the column it fell in. Columns have UNEQUAL widths
   * (each spans its own piece), so the split points are the mid-gutter
   * boundaries captured at layout time (colEdges). */
  private pickColumn(px: number): void {
    if (!this.tf || !this.offsets.length) {
      this.activePiece = 0;
      return;
    }
    const [lx] = this.screenToLayout(px, 0);
    let c = 0;
    while (c < this.colEdges.length && lx > this.colEdges[c]!) c++;
    this.activePiece = Math.min(this.nCols - 1, c);
  }

  /** Screen midpoint of an outline edge on a piece (with its column offset). */
  private edgeMidScreen(pid: number, edge: number): [number, number] | null {
    const piece = this.pieceAt(pid);
    if (!piece) return null;
    const o = piece.outline;
    const off = this.pieceOffset(pid);
    const a = this.vertexScreen(o[edge % o.length]!, piece, off);
    const b = this.vertexScreen(o[(edge + 1) % o.length]!, piece, off);
    return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
  }

  /** Index of the assembly seam whose link (between the two edge midpoints) is
   * clicked, or null — used to delete a seam. */
  private pickSeam(px: number, py: number): number | null {
    for (let i = 0; i < this.assembly.length; i++) {
      const s = this.assembly[i]!;
      const ma = this.edgeMidScreen(pieceIdOf(s.a), s.a.from);
      const mb = this.edgeMidScreen(pieceIdOf(s.b), s.b.from);
      if (!ma || !mb) continue;
      const mx = (ma[0] + mb[0]) / 2;
      const my = (ma[1] + mb[1]) / 2;
      if ((px - mx) ** 2 + (py - my) ** 2 <= HIT_RADIUS * HIT_RADIUS) return i;
    }
    return null;
  }

  /** Real length (cm) of an outline edge on a piece — for the walk/true-up
   * feedback (matching two edges' lengths, showing a seam's gather ratio). */
  private edgeLenCm(pid: number, edge: number): number {
    const piece = this.pieceAt(pid);
    if (!piece) return 0;
    const o = piece.outline;
    const a = o[edge % o.length]!;
    const b = o[(edge + 1) % o.length]!;
    return Math.hypot((b[0] - a[0]) * piece.width, (b[1] - a[1]) * piece.height) * 100;
  }

  private pickVertex(px: number, py: number): number | null {
    const out = this.draftPreview ?? this.draftPiece?.outline;
    if (!out) return null;
    for (let i = 0; i < out.length; i++) {
      const s = this.vertexScreen(out[i]!);
      if (s && (px - s[0]) ** 2 + (py - s[1]) ** 2 <= HIT_RADIUS * HIT_RADIUS) return i;
    }
    return null;
  }

  /** Pointer position in canvas pixels, or null when outside the inset. */
  private canvasPoint(e: MouseEvent): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return x >= 0 && y >= 0 && x <= r.width && y <= r.height ? [x, y] : null;
  }

  /** Nearest outline edge to a screen point + the closest point on it. */
  private nearestEdge(px: number, py: number): { edge: number; sx: number; sy: number; dist: number } | null {
    const out = this.draftPreview ?? this.draftPiece?.outline;
    if (!out || !this.tf) return null;
    let best = { edge: -1, sx: 0, sy: 0, dist: Infinity };
    for (let k = 0; k < out.length; k++) {
      const a = this.vertexScreen(out[k]!);
      const b = this.vertexScreen(out[(k + 1) % out.length]!);
      if (!a || !b) continue;
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1e-6;
      const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby) / len2));
      const sx = a[0] + t * abx;
      const sy = a[1] + t * aby;
      const d = Math.hypot(px - sx, py - sy);
      if (d < best.dist) best = { edge: k, sx, sy, dist: d };
    }
    return best.edge >= 0 ? best : null;
  }

  private layoutToScreen(x: number, y: number): [number, number] {
    const t = this.tf!;
    return [t.ox + (x - t.minA) * t.scale, t.H - (t.oy + (y - t.minB) * t.scale)];
  }

  private screenToLayout(px: number, py: number): [number, number] {
    const t = this.tf!;
    return [t.minA + (px - t.ox) / t.scale, t.minB + (t.H - py - t.oy) / t.scale];
  }

  /** Layout-space x-offset for the garment this handle belongs to (0 alone). */
  private handleOffset(h: PatternHandleSpec): number {
    const gl = this.gLayout;
    if (!gl) return 0;
    // Match the handle to its garment by the y-range its grid describes.
    const top = h.grid.topY;
    const bot = h.grid.topY - h.grid.height;
    let best = 0;
    let bestErr = Infinity;
    for (let g = 0; g < gl.gY.length; g++) {
      const err = Math.abs(gl.gY[g]![1] - top) + Math.abs(gl.gY[g]![0] - bot);
      if (err < bestErr) {
        bestErr = err;
        best = g;
      }
    }
    return gl.offsetX[best] ?? 0;
  }

  private handleScreenPos(h: PatternHandleSpec, value: number): [number, number] {
    const [x, y] = handleLayoutPos(h, value);
    return this.layoutToScreen(x + this.handleOffset(h), y);
  }

  private pickHandle(px: number, py: number): number | null {
    if (!this.tf) return null;
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i]!;
      const [hx, hy] = this.handleScreenPos(h, h.value);
      if ((px - hx) ** 2 + (py - hy) ** 2 <= HIT_RADIUS * HIT_RADIUS) return i;
    }
    return null;
  }

  private readonly onDown = (e: PointerEvent): void => {
    // Freeform draft: grab an outline vertex; empty inset space falls through.
    if (this.inDraft) {
      if (this.draftDrag || e.button !== 0) return;
      const p = this.canvasPoint(e);
      if (!p) return;
      if (!this.penMode) this.pickColumn(p[0]); // the pen stays on the face it started
      if (!this.draftPiece) return; // empty column with nothing to grab yet
      // Pen: place points to trace a new piece; clicking near the first point
      // (with ≥3 points) closes it.
      if (this.penMode) {
        if (this.penPoints.length >= 3) {
          const s0 = this.vertexScreen(this.penPoints[0]!);
          if (s0 && (p[0] - s0[0]) ** 2 + (p[1] - s0[1]) ** 2 <= (HIT_RADIUS * 1.6) ** 2) {
            this.finishPen();
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        this.penPoints.push(this.screenToUV(p[0], p[1]));
        this.render();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Shift+click two edges → sew them together (MANUAL assembly). The two
      // edges can be on different columns (front shoulder ↔ back shoulder, or a
      // free piece ↔ the body) — the column the pointer went down in (pickColumn,
      // above) sets the piece.
      if (e.shiftKey || this.sewMode) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          const pid = this.activePiece;
          const lenOf = (q: number): number => this.pieceAt(q)?.outline.length ?? 1;
          // Base pieces (0/1) carry the legacy `face` so pre-N-piece drafts/tests
          // stay byte-identical; free pieces (≥2) carry `pieceId`.
          const run = (q: number, edge: number): FaceRun =>
            q <= 1
              ? { face: q === 1 ? 'back' : 'front', from: edge, to: (edge + 1) % lenOf(q) }
              : { pieceId: q, from: edge, to: (edge + 1) % lenOf(q) };
          if (this.seamPickA === null) {
            this.seamPickA = { pieceId: pid, edge: ne.edge }; // first edge picked
            this.render();
          } else if (this.seamPickA.pieceId === pid && this.seamPickA.edge === ne.edge) {
            this.seamPickA = null; // clicked the same edge → cancel the pick
            this.render();
          } else {
            const a = this.seamPickA;
            const seam: AssemblySeam = { a: run(a.pieceId, a.edge), b: run(pid, ne.edge) };
            this.seamPickA = null;
            this.sewMode = false; // couture faite : le mode guidé se referme
            this.render();
            this.onAssemblySeam(seam);
          }
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const v = this.pickVertex(p[0], p[1]);
      if (v === null) {
        // Not on a vertex: a seam link? delete it (a vertex grab wins over this,
        // so it can't steal a click meant for editing the outline). Otherwise,
        // near an outline edge? hold the gesture — a click adds a point, a drag
        // inward pulls out a dart. Empty inset space falls through to 3D orbit.
        const si = this.pickSeam(p[0], p[1]);
        if (si !== null) {
          this.seamPickA = null;
          this.onAssemblyDelete(si);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          this.draftEdge = {
            edge: ne.edge,
            downUV: this.screenToUV(ne.sx, ne.sy),
            downSX: ne.sx,
            downSY: ne.sy,
            pointerId: e.pointerId,
            apex: null,
            dart: e.altKey,
            bend: null,
          };
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const s = this.vertexScreen(this.draftPiece.outline[v]!)!;
      this.draftPreview = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
      const orig = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
      this.draftDrag = { vertex: v, pointerId: e.pointerId, grabDX: p[0] - s[0], grabDY: p[1] - s[1], orig, curve: curveNeighbors(orig, v) };
      document.body.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    // One gesture at a time; secondary buttons stay with the 3D view.
    if (this.drag || e.button !== 0) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    const i = this.pickHandle(p[0], p[1]);
    if (i === null) return; // not on a handle → fall through to the 3D canvas
    const h = this.handles[i]!;
    const [hx, hy] = this.handleScreenPos(h, h.value);
    this.drag = { index: i, value: h.value, pointerId: e.pointerId, grabDX: p[0] - hx, grabDY: p[1] - hy };
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation();
    this.render();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.draftPiece) {
      if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const dist = Math.hypot(px - this.draftEdge.downSX, py - this.draftEdge.downSY);
        const dragged = dist > DART_DRAG;
        if (this.draftEdge.dart) {
          // Alt+glisser : le point de la souris est la pointe de la pince (aperçu).
          this.draftEdge.apex = dragged ? this.screenToUV(px, py) : null;
        } else {
          // Glisser simple : le segment se BOMBE — l'arc suit la souris (aperçu).
          const out = this.draftPiece!.outline;
          const a = out[this.draftEdge.edge]!;
          const b = out[(this.draftEdge.edge + 1) % out.length]!;
          const arc = dragged ? bendSamples(a, b, this.draftEdge.downUV, this.screenToUV(px, py)) : [];
          this.draftEdge.bend = arc.length ? arc : null;
        }
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      if (this.draftDrag) {
        if (e.pointerId !== this.draftDrag.pointerId) return;
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left - this.draftDrag.grabDX;
        const py = e.clientY - r.top - this.draftDrag.grabDY;
        const d = this.draftDrag;
        const target = this.screenToUV(px, py);
        const o = d.orig[d.vertex]!;
        const dx = target[0] - o[0];
        const dy = target[1] - o[1];
        this.draftPreview![d.vertex] = target;
        // Les voisins d'arc suivent avec leur amorti (glisser-courbe).
        for (const { idx, w } of d.curve) {
          const q = d.orig[idx]!;
          this.draftPreview![idx] = [q[0] + dx * w, q[1] + dy * w];
        }
        e.preventDefault();
        e.stopPropagation();
        this.render();
        return;
      }
      const p = this.canvasPoint(e);
      const v = p === null ? null : this.pickVertex(p[0], p[1]);
      if (v !== this.draftHover) {
        this.draftHover = v;
        document.body.style.cursor = v === null ? '' : 'grab';
        this.render();
      }
      return;
    }
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left - this.drag.grabDX;
      const py = e.clientY - r.top - this.drag.grabDY;
      const h = this.handles[this.drag.index]!;
      const [lx, ly] = this.screenToLayout(px, py);
      // Undo the garment's side-by-side offset before reading the value.
      this.drag.value = handleValueFromLayout(h, lx - this.handleOffset(h), ly);
      e.preventDefault();
      e.stopPropagation();
      this.render();
      return;
    }
    const p = this.canvasPoint(e);
    const i = p === null ? null : this.pickHandle(p[0], p[1]);
    if (i !== this.hover) {
      this.hover = i;
      document.body.style.cursor = i === null ? '' : 'grab';
      this.render();
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (this.draftPiece) {
      // An edge press resolved: no drag → add a point; dragged inward → a dart.
      if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
        const g = this.draftEdge;
        this.draftEdge = null;
        e.preventDefault();
        e.stopPropagation();
        let next: DraftPiece;
        let reidx: AssemblySeam[] | undefined;
        if (g.apex) {
          // Dart: legs a small span either side of the mouth along the edge,
          // apex at the drag end. The wedge is cut and its legs sewn shut.
          const out = this.draftPiece.outline;
          const a = out[g.edge]!;
          const b = out[(g.edge + 1) % out.length]!;
          let dx = b[0] - a[0];
          let dy = b[1] - a[1];
          const len = Math.hypot(dx, dy) || 1e-6;
          dx /= len;
          dy /= len;
          const d = 0.045;
          const legA: UV = [g.downUV[0] - dx * d, g.downUV[1] - dy * d];
          const legB: UV = [g.downUV[0] + dx * d, g.downUV[1] + dy * d];
          next = { ...this.draftPiece, darts: [...this.draftPiece.darts, { apex: g.apex, legA, legB }] };
        } else if (g.bend && g.bend.length) {
          // Bomber : l'arc remplace le segment — ses points s'insèrent un à un
          // dans le contour (chaque insertion ré-indexe openEdges/coutures de la
          // pièce, et les coutures d'assemblage suivent pareil). Un bord cousu
          // ou ouvert qui se courbe reste donc cousu/ouvert sur tout l'arc.
          next = this.draftPiece;
          for (let j = 0; j < g.bend.length; j++) {
            next = insertOutlineVertex(next, g.edge + j, g.bend[j]!);
            this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'insert', g.edge + j + 1, next.outline.length);
          }
          reidx = this.assembly;
        } else {
          next = insertOutlineVertex(this.draftPiece, g.edge, g.downUV);
          // A new vertex shifts edge indices → re-index the assembly seams (on
          // this column's pieceId).
          this.assembly = reindexAssemblySeams(this.assembly, this.activePiece, 'insert', g.edge + 1, next.outline.length);
          reidx = this.assembly;
        }
        this.applyActive(next);
        this.render();
        this.onDraftChange(next, this.activePiece, reidx);
        return;
      }
      if (!this.draftDrag || e.pointerId !== this.draftDrag.pointerId) return;
      const preview = this.draftPreview;
      const v = this.draftDrag.vertex;
      this.draftDrag = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      const piece = this.draftPiece;
      if (preview && piece) {
        const old = piece.outline[v]!;
        const moved = Math.abs(preview[v]![0] - old[0]) > 1e-4 || Math.abs(preview[v]![1] - old[1]) > 1e-4;
        piece.outline = preview.map((q) => [q[0], q[1]] as UV);
        this.render();
        if (moved) this.onDraftChange(piece, this.activePiece); // re-cut only on a real move
      } else {
        this.render();
      }
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const h = this.handles[this.drag.index]!;
    const value = this.drag.value;
    this.drag = null;
    document.body.style.cursor = '';
    e.preventDefault();
    e.stopPropagation();
    if (Math.abs(value - h.value) > 1e-4) {
      h.value = value; // keep the preview in place while the rebuild runs
      this.render();
      this.onChange(h.id, value);
    } else {
      this.render();
    }
  };

  private readonly onCancel = (e: PointerEvent): void => {
    if (this.draftEdge && e.pointerId === this.draftEdge.pointerId) {
      this.draftEdge = null;
      this.render();
      return;
    }
    if (this.draftDrag && e.pointerId === this.draftDrag.pointerId) {
      this.draftDrag = null;
      this.draftPreview = null; // discard the half-drag, keep the committed outline
      document.body.style.cursor = '';
      this.render();
      return;
    }
    // An interrupted gesture (OS gesture, palm rejection) must not re-cut the
    // garment with a half-dragged value: revert to the pre-drag state.
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    document.body.style.cursor = '';
    this.render();
  };

  private render(): void {
    const ctx = this.ctx;
    // Draw when there's a mesh OR a freeform draft (drawing from scratch has no
    // mesh until the outline closes).
    if (!ctx || (!this.mesh && !this.inDraft)) return;
    if (this.staticDirty) {
      this.renderStatic();
      this.staticDirty = false;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    this.renderHandles();
    if (this.inDraft) this.renderDraft();
  }

  /** Draw a face's outline + vertices with no live/transient decoration — used
   * for the INACTIVE column (dimmed) so both faces are always visible. */
  private drawFaceStatic(ctx: CanvasRenderingContext2D, piece: DraftPiece, offset: number): void {
    const pts = piece.outline
      .map((uv) => this.vertexScreen(uv, piece, offset))
      .filter((s): s is [number, number] => s !== null);
    if (pts.length >= 3) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
      ctx.closePath();
      ctx.fillStyle = 'rgba(228, 222, 205, 0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230, 225, 210, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    for (const s of pts) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210, 210, 210, 0.5)';
      ctx.fill();
    }
  }

  /** Freeform outline: the live preview polygon (while dragging) + vertex handles. */
  private renderDraft(): void {
    const ctx = this.ctx;
    if (!ctx || !this.tf) return;
    // Every INACTIVE column first (dimmed, underneath the active one).
    for (let pid = 0; pid < this.nCols; pid++) {
      if (pid === this.activePiece) continue;
      const p = this.pieceAt(pid);
      if (p) this.drawFaceStatic(ctx, p, this.pieceOffset(pid));
    }
    if (!this.draftPiece) return;

    // Pen: draw the growing polyline + points; the first point glows once the
    // shape can be closed.
    if (this.penMode) {
      const sp = this.penPoints.map((uv) => this.vertexScreen(uv)).filter((s): s is [number, number] => s !== null);
      if (sp.length) {
        ctx.strokeStyle = 'rgba(127, 178, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        sp.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
        ctx.stroke();
        for (let i = 0; i < sp.length; i++) {
          const closable = i === 0 && sp.length >= 3;
          ctx.beginPath();
          ctx.arc(sp[i]![0], sp[i]![1], closable ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = closable ? 'rgba(255, 159, 107, 0.95)' : 'rgba(255, 255, 255, 0.92)';
          ctx.fill();
        }
      }
      return;
    }

    const out = this.draftPreview ?? this.draftPiece.outline;
    const pts = out.map((uv) => this.vertexScreen(uv)).filter((s): s is [number, number] => s !== null);
    if (pts.length !== out.length) return;

    // The piece outline: a filled shape with its cut edges (vector, CAD-style).
    if (pts.length >= 3) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s[0], s[1]) : ctx.lineTo(s[0], s[1])));
      ctx.closePath();
      ctx.fillStyle = 'rgba(228, 222, 205, 0.14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230, 225, 210, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // Vertex handles. Corner points get the full ringed handle; the sample
    // points of an ARC (both neighbour edges short — same test as the
    // glisser-courbe chain) draw as small plain dots, so a curve reads as a
    // line instead of a bead chain. Hover/drag always brings the full handle
    // back (they stay grabbable, hit radius unchanged).
    const isArcPt = (i: number): boolean => {
      const a = out[(i + out.length - 1) % out.length]!;
      const b = out[i]!;
      const c = out[(i + 1) % out.length]!;
      return Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0.2 && Math.hypot(c[0] - b[0], c[1] - b[1]) <= 0.2;
    };
    for (let i = 0; i < pts.length; i++) {
      const s = pts[i]!;
      const active = this.draftDrag?.vertex === i;
      const hovered = this.draftHover === i;
      if (!active && !hovered && isArcPt(i)) {
        ctx.beginPath();
        ctx.arc(s[0], s[1], 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.fill();
        continue;
      }
      const r = active || hovered ? 6.5 : 4.5;
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? 'rgba(255, 159, 107, 0.95)' : 'rgba(127, 178, 255, 0.95)';
      ctx.stroke();
    }

    // Darts: draw each as its two legs meeting at the apex (orange), plus the
    // live preview wedge while pulling one out.
    ctx.strokeStyle = 'rgba(255, 159, 107, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    const drawDart = (apex: UV, legA: UV, legB: UV): void => {
      const a = this.vertexScreen(apex);
      const la = this.vertexScreen(legA);
      const lb = this.vertexScreen(legB);
      if (!a || !la || !lb) return;
      ctx.beginPath();
      ctx.moveTo(la[0], la[1]);
      ctx.lineTo(a[0], a[1]);
      ctx.lineTo(lb[0], lb[1]);
      ctx.stroke();
    };
    for (const d of this.draftPiece.darts) drawDart(d.apex, d.legA, d.legB);
    if (this.draftEdge?.apex) {
      const out = this.draftPiece.outline;
      const a = out[this.draftEdge.edge]!;
      const b = out[(this.draftEdge.edge + 1) % out.length]!;
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1e-6;
      dx /= len;
      dy /= len;
      const m = this.draftEdge.downUV;
      drawDart(this.draftEdge.apex, [m[0] - dx * 0.045, m[1] - dy * 0.045], [m[0] + dx * 0.045, m[1] + dy * 0.045]);
    }
    ctx.setLineDash([]);
    // Aperçu du BOMBER : l'arc que le segment deviendra au relâchement (bleu,
    // par-dessus le contour encore droit).
    if (this.draftEdge?.bend) {
      const o = this.draftPiece.outline;
      const a = this.vertexScreen(o[this.draftEdge.edge]!);
      const b = this.vertexScreen(o[(this.draftEdge.edge + 1) % o.length]!);
      const arc = this.draftEdge.bend.map((uv) => this.vertexScreen(uv));
      if (a && b && arc.every((s) => s !== null)) {
        ctx.strokeStyle = 'rgba(127, 178, 255, 0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        for (const s of arc) ctx.lineTo(s![0], s![1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }

    // Skip the assembly overlay while a vertex is being dragged: it reads the
    // committed outline, so it would lag the live preview until the drag commits.
    if (!this.draftDrag) {
    // MANUAL ASSEMBLY overlay: free edges (still to sew) in red, the sewn seams
    // as blue links across the two columns, and the first-picked edge in orange.
    ctx.setLineDash([]);
    const edgePts = (pid: number, edge: number): [[number, number], [number, number]] | null => {
      const piece = this.pieceAt(pid);
      if (!piece) return null;
      const o = piece.outline;
      const off = this.pieceOffset(pid);
      const a = this.vertexScreen(o[edge % o.length]!, piece, off);
      const b = this.vertexScreen(o[(edge + 1) % o.length]!, piece, off);
      return a && b ? [a, b] : null;
    };
    const runSet = (piece: DraftPiece, runs: readonly { from: number; to: number }[]): Set<number> => {
      const set = new Set<number>();
      const nV = piece.outline.length;
      for (const r of runs) {
        let steps = ((r.to - r.from) + nV) % nV;
        if (steps === 0) steps = 1;
        for (let k = 0; k < steps; k++) set.add((r.from + k) % nV);
      }
      return set;
    };
    // Which edges are already sewn (touched by an assembly seam run), per piece.
    const sewn = new Map<number, Set<number>>();
    const sewnOf = (pid: number): Set<number> => {
      let s = sewn.get(pid);
      if (!s) sewn.set(pid, (s = new Set<number>()));
      return s;
    };
    for (const s of this.assembly) {
      for (const fr of [s.a, s.b]) {
        const pid = pieceIdOf(fr);
        const piece = this.pieceAt(pid);
        if (!piece) continue;
        runSet(piece, [{ from: fr.from, to: fr.to }]).forEach((e) => sewnOf(pid).add(e));
      }
    }
    // Free edges (still to sew) = neither sewn nor an intentional opening. Only the
    // BASE shell (front=0 / back=1) reports them — a free piece auto-closes its own
    // perimeter and just attaches at one seam, so its edges aren't "to sew".
    // ÉPURE (façon CLO « Show 2D Sewing ») : le rouge ne s'affiche QUE pendant
    // le mode 🪡 Coudre, là où il est actionnable (« les bords rouges
    // attendent ») — le reste du temps le compteur du pied de plan suffit.
    const drawFree = (pid: number): void => {
      const piece = this.pieceAt(pid);
      if (!piece) return;
      const s = sewn.get(pid) ?? new Set<number>();
      const open = runSet(piece, piece.openEdges);
      ctx.strokeStyle = 'rgba(233, 96, 70, 0.9)';
      ctx.lineWidth = 2.5;
      for (let k = 0; k < piece.outline.length; k++) {
        if (s.has(k) || open.has(k)) continue;
        const pts = edgePts(pid, k);
        if (pts) {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[1][0], pts[1][1]);
          ctx.stroke();
        }
      }
    };
    if (this.sewMode || this.seamPickA) {
      drawFree(0);
      drawFree(1);
    }
    // La marge de couture ne se dessine PLUS dans l'éditeur (un seul contour
    // par pièce = plan calme) — elle reste sur le patron imprimé (PDF/SVG).
    // Sewn seams, épuré : the sewn EDGES themselves colour in on the pieces
    // (blue = flat, orange = gathered), a THIN link joins the two runs (still
    // the unsew click target), and the ratio label only appears when the seam
    // actually gathers (a plan full of « 1:1 » said nothing).
    const runLenCm = (pid: number, r: { from: number; to: number }): number => {
      const piece = this.pieceAt(pid);
      if (!piece) return 0;
      let cm = 0;
      runSet(piece, [r]).forEach((e) => (cm += this.edgeLenCm(pid, e)));
      return cm;
    };
    const strokeRun = (pid: number, r: { from: number; to: number }): void => {
      const piece = this.pieceAt(pid);
      if (!piece) return;
      runSet(piece, [r]).forEach((e) => {
        const pts = edgePts(pid, e);
        if (!pts) return;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.stroke();
      });
    };
    for (const s of this.assembly) {
      const pidA = pieceIdOf(s.a);
      const pidB = pieceIdOf(s.b);
      const pa = edgePts(pidA, s.a.from);
      const pb = edgePts(pidB, s.b.from);
      if (!pa || !pb) continue;
      const ma: [number, number] = [(pa[0][0] + pa[1][0]) / 2, (pa[0][1] + pa[1][1]) / 2];
      const mb: [number, number] = [(pb[0][0] + pb[1][0]) / 2, (pb[0][1] + pb[1][1]) / 2];
      const la = runLenCm(pidA, { from: s.a.from, to: s.a.to });
      const lb = runLenCm(pidB, { from: s.b.from, to: s.b.to });
      const ratio = Math.max(la, lb) / (Math.min(la, lb) || 1);
      const gathered = ratio >= 1.12;
      ctx.strokeStyle = gathered ? 'rgba(255, 190, 120, 0.85)' : 'rgba(127, 178, 255, 0.8)';
      ctx.lineWidth = 2.5;
      strokeRun(pidA, { from: s.a.from, to: s.a.to });
      strokeRun(pidB, { from: s.b.from, to: s.b.to });
      ctx.lineWidth = 1;
      ctx.strokeStyle = gathered ? 'rgba(255, 190, 120, 0.45)' : 'rgba(127, 178, 255, 0.3)';
      ctx.beginPath();
      ctx.moveTo(ma[0], ma[1]);
      ctx.lineTo(mb[0], mb[1]);
      ctx.stroke();
      if (gathered) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255, 190, 120, 1)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${ratio.toFixed(1).replace('.', ',')}:1 fronce`, (ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2 - 6);
      }
    }
    // First-picked edge, awaiting the second click.
    if (this.seamPickA) {
      const pts = edgePts(this.seamPickA.pieceId, this.seamPickA.edge);
      if (pts) {
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(255, 159, 107, 0.98)';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        ctx.lineTo(pts[1][0], pts[1][1]);
        ctx.stroke();
      }
    }
    // Status line (bottom-left): the picked edge's length while sewing, else how
    // many edges are still free to sew (0 = fully assembled).
    const freeOf = (pid: number): number => {
      const piece = this.pieceAt(pid);
      if (!piece) return 0;
      const s = sewn.get(pid) ?? new Set<number>();
      const open = runSet(piece, piece.openEdges);
      let c = 0;
      for (let k = 0; k < piece.outline.length; k++) if (!s.has(k) && !open.has(k)) c++;
      return c;
    };
    const freeCount = freeOf(0) + freeOf(1); // base shell only (free pieces auto-close)
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (this.seamPickA) {
      ctx.fillStyle = 'rgba(255, 159, 107, 0.98)';
      ctx.fillText(
        `bord : ${Math.round(this.edgeLenCm(this.seamPickA.pieceId, this.seamPickA.edge))} cm — cliquez maintenant le 2e bord, celui à assembler`,
        8,
        this.canvas.height - 20,
      );
    } else if (this.sewMode) {
      ctx.fillStyle = 'rgba(255, 159, 107, 0.98)';
      ctx.fillText('🪡 couture : cliquez le 1er bord (les bords rouges attendent)', 8, this.canvas.height - 20);
    } else {
      ctx.fillStyle = freeCount === 0 ? 'rgba(120, 220, 150, 0.95)' : 'rgba(233, 96, 70, 0.9)';
      ctx.fillText(
        freeCount === 0
          ? `${this.assembly.length} coutures · tout est assemblé ✓`
          : `${this.assembly.length} couture(s) · ${freeCount} bord(s) à coudre`,
        8,
        this.canvas.height - 20,
      );
    }
    } // end assembly overlay (skipped during a vertex drag)

    // Live size readout of the ACTIVE piece, in real centimetres (its outline
    // extent × the piece's physical dimensions). Updates as the outline changes.
    const ap = this.draftPiece;
    if (ap && ap.outline.length >= 2) {
      const src = this.draftPreview ?? ap.outline;
      let uMin = 1;
      let uMax = 0;
      let vMin = 1;
      let vMax = 0;
      for (const [u, v] of src) {
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
      const wCm = Math.round((uMax - uMin) * ap.width * 100);
      const hCm = Math.round((vMax - vMin) * ap.height * 100);
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(237, 233, 223, 0.6)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${this.pieceLabel(this.activePiece)} ≈ ${wCm} × ${hCm} cm`, 8, this.canvas.height - 6);
    }
  }

  private renderStatic(): void {
    const ctx = this.staticLayer.getContext('2d');
    const mesh = this.mesh;
    this.tf = null;
    if (!ctx) return;
    const W = this.staticLayer.width;
    const H = this.staticLayer.height;
    ctx.clearRect(0, 0, W, H);

    // Atelier (freeform) mode: a fixed, mesh-independent transform (the full
    // width×height cutting field fits the panel) so vertices don't jump as the
    // outline changes and drawing works even before there's a mesh. A grid
    // backdrop makes it read like a 2D CAD surface. The draft overlay
    // (renderDraft) draws the outline, points, darts and seams on top.
    if (this.inDraft) {
      const p = this.pieces.find((x): x is DraftPiece => !!x)!;
      // Vertical extent: every piece (a collar band above the hem line must not
      // clip) unioned with the silhouette.
      let minY = p.topY - p.height;
      let maxY = p.topY;
      for (const q of this.pieces) {
        if (!q) continue;
        minY = Math.min(minY, q.topY - q.height);
        maxY = Math.max(maxY, q.topY);
      }
      if (this.bodySil) {
        minY = Math.min(minY, this.bodySil.minY);
        maxY = Math.max(maxY, this.bodySil.maxY);
      }
      // N columns side by side (CLO-style): DEVANT, DOS, then one column per
      // free piece — each column AS WIDE AS ITS CONTENT (plan de coupe épuré).
      // Body columns (0/1) span piece ∪ silhouette (pieces are drawn against
      // the avatar); a free piece takes just its own width, so a narrow collar
      // band no longer claims a body-wide column and the whole plan zooms in.
      // An EMPTY free column (pen about to trace) keeps a generous front-width
      // slot to draw in.
      const nCols = this.nCols;
      const colRange = (k: number): [number, number] => {
        const q = this.pieceAt(k);
        const w = (q ? q.width : p.width) / 2;
        if (k <= 1 && this.bodySil) return [Math.min(-w, this.bodySil.minX), Math.max(w, this.bodySil.maxX)];
        const pad = k <= 1 ? 0 : 0.03;
        return [-w - pad, w + pad];
      };
      const GUTTER = 0.08;
      this.offsets = new Array<number>(nCols).fill(0);
      this.colEdges = [];
      const ranges: [number, number][] = [];
      let cursor = 0; // running right edge of the laid-out columns (layout x)
      for (let k = 0; k < nCols; k++) {
        const r = colRange(k);
        this.offsets[k] = k === 0 ? 0 : cursor + GUTTER - r[0];
        if (k > 0) this.colEdges.push(cursor + GUTTER / 2);
        cursor = this.offsets[k]! + r[1];
        ranges.push(r);
      }
      const minX = ranges[0]![0];
      const maxX = cursor;
      const margin = 22;
      const spanA = maxX - minX || p.width;
      const spanB = maxY - minY || p.height;
      const scale = Math.min((W - 2 * margin) / spanA, (H - 2 * margin) / spanB);
      const ox = (W - spanA * scale) / 2;
      const oy = (H - spanB * scale) / 2;
      this.tf = { minA: minX, minB: minY, scale, ox, oy, H };
      // Avatar silhouette behind the BODY columns only (DEVANT/DOS are drawn
      // against the body; a sleeve or collar column stays clean) — the exact
      // body shape, filled as one padded path (closes hairlines; a single fill
      // keeps the alpha uniform).
      const drawSil = (offset: number): void => {
        if (!this.bodySil) return;
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of this.bodySil.rects) {
          const a = this.layoutToScreen(x0 + offset, y1);
          const b = this.layoutToScreen(x1 + offset, y0);
          ctx.rect(a[0], a[1], b[0] - a[0] + 0.7, b[1] - a[1] + 0.7);
        }
        ctx.fillStyle = 'rgba(214, 205, 190, 0.16)';
        ctx.fill();
      };
      for (let k = 0; k < Math.min(nCols, 2); k++) drawSil(this.offsets[k]!);
      // Grid, hiérarchisée pour rester calme : lignes fines tous les 10 cm,
      // à peine plus présentes tous les 50 cm.
      ctx.lineWidth = 1;
      for (const [step, alpha] of [
        [0.1, 0.035],
        [0.5, 0.08],
      ] as const) {
        ctx.strokeStyle = `rgba(237, 233, 223, ${alpha})`;
        ctx.beginPath();
        for (let gx = Math.ceil(minX / step) * step; gx <= maxX + 1e-6; gx += step) {
          const a = this.layoutToScreen(gx, minY);
          const b = this.layoutToScreen(gx, maxY);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
        for (let gy = Math.ceil(minY / step) * step; gy <= maxY + 1e-6; gy += step) {
          const a = this.layoutToScreen(minX, gy);
          const b = this.layoutToScreen(maxX, gy);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
        ctx.stroke();
      }
      // Height ruler down the left edge, in real centimeters (0 = the floor) —
      // un chiffre tous les 20 cm suffit pour se repérer.
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(237, 233, 223, 0.28)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let gy = Math.ceil(minY / 0.2) * 0.2; gy <= maxY + 1e-6; gy += 0.2) {
        const cm = Math.round(gy * 100);
        const [sx, sy] = this.layoutToScreen(minX, gy);
        ctx.fillText(`${cm}`, sx + 2, sy);
      }
      // Column labels, centred over each column's own extent. A label wider
      // than its (narrow) column wraps onto two lines at the first space, so
      // MANCHE D · MANCHE G · COL never overlap each other.
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(237, 233, 223, 0.5)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labY = this.layoutToScreen(0, maxY)[1] - 3;
      for (let k = 0; k < nCols; k++) {
        const label = this.pieceLabel(k).toUpperCase();
        const sx = this.layoutToScreen(this.offsets[k]! + (ranges[k]![0] + ranges[k]![1]) / 2, maxY)[0];
        const colPx = (ranges[k]![1] - ranges[k]![0]) * scale;
        const sp = label.indexOf(' ');
        if (ctx.measureText(label).width > colPx && sp > 0) {
          ctx.fillText(label.slice(0, sp), sx, labY - 11);
          ctx.fillText(label.slice(sp + 1), sx, labY);
        } else {
          ctx.fillText(label, sx, labY);
        }
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      return;
    }
    if (!mesh) return;

    const panelSize = mesh.resolution * mesh.resolution;
    const kept = (i: number): boolean => mesh.invMasses[i]! > 0;
    const frontPanel = (i: number): boolean => Math.floor(i / panelSize) % 2 === 0;
    // Panels pair front/back into garments: front panels 0, 2, 4… → garments 0, 1, 2…
    const garmentOf = (i: number): number => Math.floor(Math.floor(i / panelSize) / 2);

    // The rest pose is flat: pick the two axes that actually vary.
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      if (!kept(i) || !frontPanel(i)) continue;
      const y = mesh.positions[i * 4 + 1]!;
      const z = mesh.positions[i * 4 + 2]!;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    if (!Number.isFinite(maxY - minY)) return;
    // Horizontal sheet → (x,z); vertical panels → (x,y).
    const useXZ = maxZ - minZ > maxY - minY;

    // Side-by-side: lay each garment's front piece out left to right in layout
    // space (like the printed pattern), so a combined outfit's overlapping
    // fronts separate instead of stacking. Vertical (x,y) layouts only.
    const G = Math.max(1, Math.floor(mesh.count / panelSize / 2));
    const offsetX = new Array<number>(G).fill(0);
    const gY: [number, number][] = [];
    const sideBySide = !useXZ && G > 1;
    if (sideBySide) {
      const GUTTER = 0.05; // 5 cm between pieces in layout space
      let cursor = 0;
      for (let g = 0; g < G; g++) {
        let aMin = Infinity, aMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (let i = 0; i < mesh.count; i++) {
          if (!kept(i) || !frontPanel(i) || garmentOf(i) !== g) continue;
          const x = mesh.positions[i * 4]!;
          const y = mesh.positions[i * 4 + 1]!;
          aMin = Math.min(aMin, x); aMax = Math.max(aMax, x);
          yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        }
        if (!Number.isFinite(aMin)) { gY.push([0, 0]); continue; }
        offsetX[g] = cursor - aMin;
        cursor += aMax - aMin + GUTTER;
        gY.push([yMin, yMax]);
      }
    }
    this.gLayout = sideBySide ? { offsetX, gY } : null;
    const offOf = (i: number): number => (sideBySide ? offsetX[garmentOf(i)]! : 0);

    // Axis coordinates (x shifted by the garment offset) and their bounds.
    const aOf = (i: number): number => mesh.positions[i * 4]! + offOf(i);
    const bOf = (i: number): number => (useXZ ? mesh.positions[i * 4 + 2]! : mesh.positions[i * 4 + 1]!);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let i = 0; i < mesh.count; i++) {
      if (!kept(i) || !frontPanel(i)) continue;
      const a = aOf(i), b = bOf(i);
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
      minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    }
    const spanA = maxA - minA || 1;
    const spanB = maxB - minB || 1;

    const margin = 16;
    const scale = Math.min((W - 2 * margin) / spanA, (H - 2 * margin) / spanB);
    const ox = (W - spanA * scale) / 2;
    const oy = (H - spanB * scale) / 2;
    // Handles only make sense on vertical (x,y) layouts.
    this.tf = useXZ ? null : { minA, minB, scale, ox, oy, H };
    const toScreen = (i: number): [number, number] => [
      ox + (aOf(i) - minA) * scale,
      H - (oy + (bOf(i) - minB) * scale),
    ];

    // Fabric fill from front-panel triangles.
    ctx.fillStyle = 'rgba(228, 222, 205, 0.28)';
    ctx.beginPath();
    for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
      const a = mesh.triangleIndices[t]!;
      if (!frontPanel(a)) continue;
      const [ax, ay] = toScreen(a);
      const [bx, by] = toScreen(mesh.triangleIndices[t + 1]!);
      const [cx2, cy2] = toScreen(mesh.triangleIndices[t + 2]!);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx2, cy2);
      ctx.closePath();
    }
    ctx.fill();

    // Cut outline: triangle edges that belong to a single triangle.
    const edgeCount = new Map<string, [number, number]>();
    const addEdge = (a: number, b: number): void => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edgeCount.has(key)) edgeCount.delete(key);
      else edgeCount.set(key, [a, b]);
    };
    for (let t = 0; t < mesh.triangleIndices.length; t += 3) {
      const a = mesh.triangleIndices[t]!;
      if (!frontPanel(a)) continue;
      const b = mesh.triangleIndices[t + 1]!;
      const c = mesh.triangleIndices[t + 2]!;
      addEdge(a, b);
      addEdge(b, c);
      addEdge(a, c);
    }
    ctx.strokeStyle = 'rgba(230, 225, 210, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const [a, b] of edgeCount.values()) {
      const [ax, ay] = toScreen(a);
      const [bx, by] = toScreen(b);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    // Seams: mirror seams (front↔back) become stitch dots on the outline;
    // island-to-island seams (armholes) become orange links between pieces.
    const dv = new DataView(mesh.constraintData);
    ctx.fillStyle = 'rgba(127, 178, 255, 0.9)';
    ctx.strokeStyle = 'rgba(255, 159, 107, 0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let k = 0; k < mesh.constraintCount; k++) {
      if (dv.getUint32(k * 16 + 12, true) !== 3) continue; // Seam kind
      const i = dv.getUint32(k * 16, true);
      const j = dv.getUint32(k * 16 + 4, true);
      const pi = Math.floor(i / panelSize);
      const pj = Math.floor(j / panelSize);
      if (pi === pj && frontPanel(i)) {
        // Same-panel seam (armhole): draw the link.
        const [ax, ay] = toScreen(i);
        const [bx, by] = toScreen(j);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      } else if (pi + 1 === pj && frontPanel(i)) {
        // Mirror seam: stitch dot on the front piece.
        const [ax, ay] = toScreen(i);
        ctx.fillRect(ax - 1, ay - 1, 2.4, 2.4);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private renderHandles(): void {
    const ctx = this.ctx;
    if (!ctx || !this.tf || this.handles.length === 0) return;

    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i]!;
      const active = this.drag?.index === i;
      const value = active ? this.drag!.value : h.value;
      const [hx, hy] = this.handleScreenPos(h, value);

      if (active) {
        // Axis guide through the dragged handle.
        ctx.strokeStyle = 'rgba(127, 178, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (h.axis === 'u') {
          ctx.moveTo(hx, 0);
          ctx.lineTo(hx, this.canvas.height);
        } else {
          ctx.moveTo(0, hy);
          ctx.lineTo(this.canvas.width, hy);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const r = active || this.hover === i ? 6.5 : 4.5;
      ctx.beginPath();
      ctx.arc(hx, hy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? 'rgba(255, 159, 107, 0.95)' : 'rgba(127, 178, 255, 0.95)';
      ctx.stroke();
    }

    // Status line: the hovered/dragged measurement and its live value.
    const shown = this.drag ? this.handles[this.drag.index] : this.hover !== null ? this.handles[this.hover] : null;
    if (shown) {
      const value = this.drag ? this.drag.value : shown.value;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(237, 233, 223, 0.9)';
      ctx.fillText(`${shown.label} ${value.toFixed(shown.unit ? 2 : 3)}${shown.unit ?? ''}`, 8, 12);
    }
  }
}
