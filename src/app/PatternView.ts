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
import { insertOutlineVertex, deleteOutlineVertex, type UV, type DraftPiece } from '../engine/pattern/Draft';

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

const HIT_RADIUS = 12;
const EDGE_HIT = 8; // click within this many px of an outline edge → add point / dart
const DART_DRAG = 7; // drag farther than this from an edge → it's a dart, not an add

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
  private readonly onDraftChange: (piece: DraftPiece) => void;
  private draftPiece: DraftPiece | null = null;
  private draftPreview: UV[] | null = null; // live copy while dragging a vertex
  private draftDrag: { vertex: number; pointerId: number; grabDX: number; grabDY: number } | null = null;
  private draftHover: number | null = null;
  // A press on an outline edge: a click adds a point; dragging inward pulls a dart.
  private draftEdge: { edge: number; downUV: UV; downSX: number; downSY: number; pointerId: number; apex: UV | null } | null = null;
  private draftSeamA: number | null = null; // first edge picked for a hand-seam (Shift+click)
  // Pen tool: drawing a new piece from scratch (click to place points, close it).
  private penMode = false;
  private penPoints: UV[] = [];
  // Mannequin silhouette (world x,y closed polygon) drawn behind the atelier grid
  // as a size reference, or null to hide it.
  private bodySil: Array<[number, number]> | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    onChange: (id: string, value: number) => void = () => {},
    onDraftChange: (piece: DraftPiece) => void = () => {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onDraftChange = onDraftChange;
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
    if (!this.draftPiece) return;
    const p = this.canvasPoint(e);
    if (!p) return;
    const v = this.pickVertex(p[0], p[1]);
    if (v === null) return; // not on a vertex → let the 3D canvas handle it
    const next = deleteOutlineVertex(this.draftPiece, v);
    if (next.outline.length === this.draftPiece.outline.length) return; // ≤3 guard
    e.preventDefault();
    e.stopPropagation();
    this.setDraft(next);
    this.render();
    this.onDraftChange(next);
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

  /** Enter freeform draft editing (atelier) with `piece`, or leave it (null). */
  setDraft(piece: DraftPiece | null): void {
    this.draftPiece = piece
      ? {
          ...piece,
          outline: piece.outline.map((p) => [p[0], p[1]] as UV),
          openEdges: piece.openEdges.map((r) => ({ ...r })),
          seams: piece.seams.map((s) => ({ a: { ...s.a }, b: { ...s.b } })),
          darts: piece.darts.map((d) => ({ apex: [...d.apex] as UV, legA: [...d.legA] as UV, legB: [...d.legB] as UV })),
        }
      : null;
    this.draftPreview = null;
    this.draftDrag = null;
    this.draftHover = null;
    this.draftEdge = null;
    this.draftSeamA = null;
  }

  /** Show the mannequin silhouette behind the atelier grid (or null to hide). */
  setBodySilhouette(pts: Array<[number, number]> | null): void {
    this.bodySil = pts && pts.length >= 3 ? pts.map((p) => [p[0], p[1]] as [number, number]) : null;
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

  /** Start drawing a NEW piece from a blank canvas (pen tool). */
  startPen(width: number, height: number, topY: number, gap: number): void {
    this.setDraft({ outline: [], darts: [], seams: [], openEdges: [], width, height, topY, gap });
    this.penMode = true;
    this.penPoints = [];
    this.render();
  }

  get drawing(): boolean {
    return this.penMode;
  }

  /** Close the drawn outline into a piece (≥3 points), seeding a top opening. */
  finishPen(): void {
    if (!this.penMode || this.penPoints.length < 3 || !this.draftPiece) return;
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
    this.penMode = false;
    this.penPoints = [];
    this.setDraft(next);
    this.render();
    this.onDraftChange(next);
  }

  /** Screen position of an outline vertex: UV → the mesh's rest layout → screen. */
  private vertexScreen(uv: UV): [number, number] | null {
    if (!this.tf || !this.draftPiece) return null;
    const x = (uv[0] - 0.5) * this.draftPiece.width;
    const y = this.draftPiece.topY - uv[1] * this.draftPiece.height;
    return this.layoutToScreen(x, y);
  }

  /** A screen point → outline UV, clamped to [0,1]². */
  private screenToUV(px: number, py: number): UV {
    const [x, y] = this.screenToLayout(px, py);
    const p = this.draftPiece!;
    return [Math.min(1, Math.max(0, x / p.width + 0.5)), Math.min(1, Math.max(0, (p.topY - y) / p.height))];
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
    if (this.draftPiece) {
      if (this.draftDrag || e.button !== 0) return;
      const p = this.canvasPoint(e);
      if (!p) return;
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
      // Shift+click two edges → sew them together (a hand-defined seam).
      if (e.shiftKey) {
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          const out = this.draftPiece.outline;
          if (this.draftSeamA === null) {
            this.draftSeamA = ne.edge; // first edge picked
            this.render();
          } else if (this.draftSeamA !== ne.edge) {
            const seam = { a: { from: this.draftSeamA, to: (this.draftSeamA + 1) % out.length }, b: { from: ne.edge, to: (ne.edge + 1) % out.length } };
            const next = { ...this.draftPiece, seams: [...this.draftPiece.seams, seam] };
            this.draftSeamA = null;
            this.setDraft(next);
            this.render();
            this.onDraftChange(next);
          } else {
            this.draftSeamA = null; // clicked the same edge → cancel the pick
            this.render();
          }
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const v = this.pickVertex(p[0], p[1]);
      if (v === null) {
        // Not on a vertex but near an outline edge: hold the gesture — a click
        // adds a point there, a drag inward pulls out a dart. Empty inset space
        // falls through to 3D orbit.
        const ne = this.nearestEdge(p[0], p[1]);
        if (ne && ne.dist <= EDGE_HIT) {
          this.draftEdge = { edge: ne.edge, downUV: this.screenToUV(ne.sx, ne.sy), downSX: ne.sx, downSY: ne.sy, pointerId: e.pointerId, apex: null };
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const s = this.vertexScreen(this.draftPiece.outline[v]!)!;
      this.draftPreview = this.draftPiece.outline.map((q) => [q[0], q[1]] as UV);
      this.draftDrag = { vertex: v, pointerId: e.pointerId, grabDX: p[0] - s[0], grabDY: p[1] - s[1] };
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
        // Dragged far enough inward → the drag point is the dart apex (preview).
        this.draftEdge.apex = dist > DART_DRAG ? this.screenToUV(px, py) : null;
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
        this.draftPreview![this.draftDrag.vertex] = this.screenToUV(px, py);
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
        } else {
          next = insertOutlineVertex(this.draftPiece, g.edge, g.downUV);
        }
        this.setDraft(next);
        this.render();
        this.onDraftChange(next);
        return;
      }
      if (!this.draftDrag || e.pointerId !== this.draftDrag.pointerId) return;
      const preview = this.draftPreview;
      const v = this.draftDrag.vertex;
      this.draftDrag = null;
      document.body.style.cursor = '';
      e.preventDefault();
      e.stopPropagation();
      if (preview) {
        const old = this.draftPiece.outline[v]!;
        const moved = Math.abs(preview[v]![0] - old[0]) > 1e-4 || Math.abs(preview[v]![1] - old[1]) > 1e-4;
        this.draftPiece.outline = preview.map((q) => [q[0], q[1]] as UV);
        this.render();
        if (moved) this.onDraftChange(this.draftPiece); // re-cut only on a real move
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
    if (!ctx || (!this.mesh && !this.draftPiece)) return;
    if (this.staticDirty) {
      this.renderStatic();
      this.staticDirty = false;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    this.renderHandles();
    if (this.draftPiece) this.renderDraft();
  }

  /** Freeform outline: the live preview polygon (while dragging) + vertex handles. */
  private renderDraft(): void {
    const ctx = this.ctx;
    if (!ctx || !this.tf || !this.draftPiece) return;

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

    // Vertex handles.
    for (let i = 0; i < pts.length; i++) {
      const s = pts[i]!;
      const active = this.draftDrag?.vertex === i;
      const r = active || this.draftHover === i ? 6.5 : 4.5;
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

    // Hand-seams: a blue link between each pair of sewn edges; a thick orange
    // highlight on the first edge picked while awaiting the second.
    const edgeMid = (k: number): [number, number] | null => {
      const o = this.draftPiece!.outline;
      const a = this.vertexScreen(o[k % o.length]!);
      const b = this.vertexScreen(o[(k + 1) % o.length]!);
      return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
    };
    ctx.strokeStyle = 'rgba(127, 178, 255, 0.9)';
    ctx.lineWidth = 2;
    for (const s of this.draftPiece.seams) {
      const ma = edgeMid(s.a.from);
      const mb = edgeMid(s.b.from);
      if (ma && mb) {
        ctx.beginPath();
        ctx.moveTo(ma[0], ma[1]);
        ctx.lineTo(mb[0], mb[1]);
        ctx.stroke();
      }
    }
    if (this.draftSeamA !== null) {
      const o = this.draftPiece.outline;
      const a = this.vertexScreen(o[this.draftSeamA]!);
      const b = this.vertexScreen(o[(this.draftSeamA + 1) % o.length]!);
      if (a && b) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 159, 107, 0.95)';
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
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
    if (this.draftPiece) {
      const p = this.draftPiece;
      // Fit the panel to the mannequin silhouette (so pieces are drawn to the
      // body's real scale) UNIONED with the piece's own extent — else just the
      // piece. World (x, y) is the same plane the flat pattern lives in.
      let minX = -p.width / 2;
      let maxX = p.width / 2;
      let minY = p.topY - p.height;
      let maxY = p.topY;
      if (this.bodySil) {
        for (const [x, y] of this.bodySil) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      const margin = 22;
      const spanA = maxX - minX || p.width;
      const spanB = maxY - minY || p.height;
      const scale = Math.min((W - 2 * margin) / spanA, (H - 2 * margin) / spanB);
      const ox = (W - spanA * scale) / 2;
      const oy = (H - spanB * scale) / 2;
      this.tf = { minA: minX, minB: minY, scale, ox, oy, H };
      // Mannequin silhouette behind the grid: a soft filled body shape.
      if (this.bodySil) {
        ctx.beginPath();
        this.bodySil.forEach(([x, y], i) => {
          const [sx, sy] = this.layoutToScreen(x, y);
          i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(212, 202, 186, 0.10)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(212, 202, 186, 0.30)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Grid every ~10 cm across the fitted field.
      ctx.strokeStyle = 'rgba(237, 233, 223, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.ceil(minX / 0.1) * 0.1; gx <= maxX + 1e-6; gx += 0.1) {
        const a = this.layoutToScreen(gx, minY);
        const b = this.layoutToScreen(gx, maxY);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      for (let gy = Math.ceil(minY / 0.1) * 0.1; gy <= maxY + 1e-6; gy += 0.1) {
        const a = this.layoutToScreen(minX, gy);
        const b = this.layoutToScreen(maxX, gy);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
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
