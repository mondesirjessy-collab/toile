/**
 * Minimal orbit camera, CLO3D-style navigation:
 *   - left-drag on empty space (or middle button / Shift+left / touch): orbit
 *     — a plain left press consults `shouldOrbit` so a press ON the cloth
 *     becomes a fabric grab instead
 *   - right-drag: pan (move the view target laterally/vertically)
 *   - wheel: zoom
 * Hand-rolled matrices (column-major, WebGPU clip space z in [0,1])
 * to keep the milestone dependency-free.
 */
export class OrbitCamera {
  private azimuth = Math.PI / 5;
  private elevation = Math.PI / 7;
  private radius = 4.0; // framed on the draped cloth, CLO3D-style working distance
  private readonly target: [number, number, number] = [0, 0.8, 0];
  private readonly viewProj = new Float32Array(16);
  private readonly fov = Math.PI / 4;

  attach(canvas: HTMLCanvasElement, shouldOrbit?: (e: PointerEvent) => boolean): void {
    let mode: 'none' | 'orbit' | 'pan' = 'none';
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      // Right button pans. Middle button, Shift+left and touch always orbit.
      // A plain left press orbits only when `shouldOrbit` says it missed the
      // cloth (otherwise the press becomes a fabric grab, handled by the app).
      if (e.button === 2) {
        mode = 'pan';
      } else {
        let orbit = e.button === 1 || (e.button === 0 && e.shiftKey) || e.pointerType === 'touch';
        if (!orbit && e.button === 0 && shouldOrbit) orbit = shouldOrbit(e);
        if (!orbit) return;
        mode = 'orbit';
      }
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (mode === 'none') return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (mode === 'orbit') {
        this.azimuth -= dx * 0.005;
        this.elevation += dy * 0.005;
        this.elevation = Math.min(Math.max(this.elevation, 0.05), Math.PI / 2 - 0.05);
      } else {
        this.pan(dx, dy);
      }
    });
    canvas.addEventListener('pointerup', () => (mode = 'none'));
    canvas.addEventListener('pointercancel', () => (mode = 'none'));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.radius = Math.min(Math.max(this.radius * (1 + e.deltaY * 0.001), 2), 20);
      },
      { passive: false },
    );
  }

  /** Slide the view target across the screen plane (right-drag). */
  private pan(dx: number, dy: number): void {
    const eye = this.computeEye();
    const forward = normalize(sub(this.target, eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const k = this.radius * 0.0011; // screen-proportional pan speed
    this.target[0] += (-right[0]! * dx + up[0]! * dy) * k;
    this.target[1] += (-right[1]! * dx + up[1]! * dy) * k;
    this.target[2] += (-right[2]! * dx + up[2]! * dy) * k;
    // Keep the target near the scene so the user can't get lost.
    this.target[0] = Math.min(Math.max(this.target[0], -3), 3);
    this.target[1] = Math.min(Math.max(this.target[1], 0.1), 3);
    this.target[2] = Math.min(Math.max(this.target[2], -3), 3);
  }

  /** World-space eye position for the current orbit state. */
  private computeEye(): [number, number, number] {
    const ce = Math.cos(this.elevation);
    return [
      this.target[0] + this.radius * ce * Math.sin(this.azimuth),
      this.target[1] + this.radius * Math.sin(this.elevation),
      this.target[2] + this.radius * ce * Math.cos(this.azimuth),
    ];
  }

  /**
   * Pinhole ray from the eye through a cursor at NDC (x,y ∈ [-1,1], y up).
   * Returns an orthonormal-basis ray matching the perspective() projection,
   * used to apply the mouse force toward the line under the cursor.
   */
  pickRay(
    ndcX: number,
    ndcY: number,
    aspect: number,
  ): { origin: [number, number, number]; dir: [number, number, number] } {
    const eye = this.computeEye();
    const forward = normalize(sub(this.target, eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    const trueUp = cross(right, forward);
    const tanHalf = Math.tan(this.fov / 2);
    const dir = normalize([
      forward[0]! + ndcX * tanHalf * aspect * right[0]! + ndcY * tanHalf * trueUp[0]!,
      forward[1]! + ndcX * tanHalf * aspect * right[1]! + ndcY * tanHalf * trueUp[1]!,
      forward[2]! + ndcX * tanHalf * aspect * right[2]! + ndcY * tanHalf * trueUp[2]!,
    ]);
    return { origin: eye, dir: [dir[0]!, dir[1]!, dir[2]!] };
  }

  /** Returns the combined view-projection matrix for the current state. */
  matrix(aspect: number): Float32Array {
    const eye = this.computeEye();
    const view = lookAt(eye, this.target, [0, 1, 0]);
    const proj = perspective(this.fov, aspect, 0.05, 100);
    multiply(this.viewProj, proj, view);
    return this.viewProj;
  }
}

// --- Matrix helpers (column-major) ---

function lookAt(eye: number[], target: number[], up: number[]): Float32Array {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return new Float32Array([
    x[0]!, y[0]!, z[0]!, 0,
    x[1]!, y[1]!, z[1]!, 0,
    x[2]!, y[2]!, z[2]!, 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const rangeInv = 1 / (near - far);
  // WebGPU depth range [0, 1]
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * rangeInv, -1,
    0, 0, near * far * rangeInv, 0,
  ]);
}

function multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
}

const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}
