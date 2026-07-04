import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import { PointsRenderer } from './app/PointsRenderer';
import { OrbitCamera } from './app/OrbitCamera';

const PARTICLE_COUNT = 4096; // milestone 1 target (S1 baseline)
const SUBSTEPS = 20;

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const overlay = document.getElementById('overlay') as HTMLElement;

  let gpu;
  try {
    gpu = await initGpu();
  } catch (err) {
    if (err instanceof WebGPUNotSupportedError) {
      overlay.hidden = false;
      overlay.innerHTML =
        '<h1>WebGPU indisponible</h1>' +
        '<p>Cette démo requiert un navigateur avec WebGPU : Chrome / Edge 113+, ' +
        'Safari 18+, Firefox 141+.</p>' +
        `<p class="detail">${(err as Error).message}</p>`;
      return;
    }
    throw err;
  }

  const { device } = gpu;

  const system = new ParticleSystem(device, {
    count: PARTICLE_COUNT,
    spawnMin: [-0.6, 1.2, -0.6],
    spawnMax: [0.6, 3.2, 0.6],
  });

  const renderer = new PointsRenderer(device, canvas, system.positionBuffer, system.count);
  const camera = new OrbitCamera();
  camera.attach(canvas);

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    renderer.resize(canvas.width, canvas.height);
  };
  window.addEventListener('resize', resize);
  resize();

  // --- Loop with fps accounting ---
  let last = performance.now();
  let frames = 0;
  let fpsAccum = 0;

  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp to avoid tab-switch spikes
    last = now;

    system.step(dt, SUBSTEPS);
    renderer.render(camera.matrix(canvas.width / canvas.height));

    frames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      const fps = Math.round(frames / fpsAccum);
      hud.textContent =
        `${fps} fps · ${PARTICLE_COUNT.toLocaleString('fr-FR')} particules · ` +
        `${SUBSTEPS} substeps`;
      frames = 0;
      fpsAccum = 0;
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
