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

  constructor(canvas: HTMLCanvasElement, onChange: (id: string, value: number) => void = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = canvas.width;
    this.staticLayer.height = canvas.height;
    window.addEventListener('pointerdown', this.onDown, true);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancel, true);
  }

  draw(mesh: ClothMeshData, handles: PatternHandleSpec[] = []): void {
    this.mesh = mesh;
    this.handles = handles;
    this.staticDirty = true;
    this.drag = null;
    this.hover = null;
    document.body.style.cursor = '';
    this.render();
  }

  /** Pointer position in canvas pixels, or null when outside the inset. */
  private canvasPoint(e: PointerEvent): [number, number] | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return x >= 0 && y >= 0 && x <= r.width && y <= r.height ? [x, y] : null;
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
    // An interrupted gesture (OS gesture, palm rejection) must not re-cut the
    // garment with a half-dragged value: revert to the pre-drag state.
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    document.body.style.cursor = '';
    this.render();
  };

  private render(): void {
    const ctx = this.ctx;
    if (!ctx || !this.mesh) return;
    if (this.staticDirty) {
      this.renderStatic();
      this.staticDirty = false;
    }
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    this.renderHandles();
  }

  private renderStatic(): void {
    const ctx = this.staticLayer.getContext('2d');
    const mesh = this.mesh;
    this.tf = null;
    if (!ctx || !mesh) return;
    const W = this.staticLayer.width;
    const H = this.staticLayer.height;
    ctx.clearRect(0, 0, W, H);

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
