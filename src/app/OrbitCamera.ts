/**
 * Minimal orbit camera. Drag to rotate, wheel to zoom.
 * Hand-rolled matrices (column-major, WebGPU clip space z in [0,1])
 * to keep milestone 1 dependency-free.
 */
export class OrbitCamera {
  private azimuth = Math.PI / 5;
  private elevation = Math.PI / 7;
  private radius = 5.5;
  private readonly target: [number, number, number] = [0, 0.8, 0];
  private readonly viewProj = new Float32Array(16);

  attach(canvas: HTMLCanvasElement): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.azimuth -= (e.clientX - lastX) * 0.005;
      this.elevation += (e.clientY - lastY) * 0.005;
      this.elevation = Math.min(Math.max(this.elevation, 0.05), Math.PI / 2 - 0.05);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', () => (dragging = false));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.radius = Math.min(Math.max(this.radius * (1 + e.deltaY * 0.001), 2), 20);
      },
      { passive: false },
    );
  }

  /** Returns the combined view-projection matrix for the current state. */
  matrix(aspect: number): Float32Array {
    const ce = Math.cos(this.elevation);
    const eye: [number, number, number] = [
      this.target[0] + this.radius * ce * Math.sin(this.azimuth),
      this.target[1] + this.radius * Math.sin(this.elevation),
      this.target[2] + this.radius * ce * Math.cos(this.azimuth),
    ];

    const view = lookAt(eye, this.target, [0, 1, 0]);
    const proj = perspective(Math.PI / 4, aspect, 0.05, 100);
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
