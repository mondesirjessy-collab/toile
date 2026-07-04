import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import { generateClothGrid } from './engine/cloth/ClothMesh';
import { PointsRenderer } from './app/PointsRenderer';
import { OrbitCamera } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh } from './app/SceneGeometry';

const RESOLUTION = 64; // 64×64 = 4 096 particules (brief S1 baseline)
const SUBSTEPS = 20;

// Shared scene definition: the solver collides against these, the renderer draws them.
const SPHERE_CENTER: [number, number, number] = [0, 0.8, 0];
const SPHERE_RADIUS = 0.55;
const GROUND_Y = 0;

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

  const mesh = generateClothGrid({
    resolution: RESOLUTION,
    size: 1.6, // 1.6 m sheet draping over the sphere (brief §4 scene)
    topY: 1.7, // starts flat above the sphere top, falls onto it
    pin: 'none', // free fall + drape; press P to hold the two corners
  });
  const system = new ParticleSystem(device, mesh, {
    sphereCenter: SPHERE_CENTER,
    sphereRadius: SPHERE_RADIUS,
    groundY: GROUND_Y,
    friction: 0.5,
  });

  const scene = buildSceneMesh({
    sphereCenter: SPHERE_CENTER,
    sphereRadius: SPHERE_RADIUS,
    groundY: GROUND_Y,
  });
  const renderer = new PointsRenderer(device, canvas, system.positionBuffer, system.count, scene);
  const camera = new OrbitCamera();
  camera.attach(canvas);
  const mouse = new MouseForce();
  mouse.attach(canvas);

  // Interaction: R re-drops the cloth, P toggles holding the two corners.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') system.reset();
    else if (e.key === 'p' || e.key === 'P') system.setCornerPins(!system.pinsHeld);
  });

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

    const aspect = canvas.width / canvas.height;
    if (mouse.mode !== 0) {
      const { origin, dir } = camera.pickRay(mouse.ndcX, mouse.ndcY, aspect);
      system.setMouse(origin, dir, mouse.mode);
    } else {
      system.setMouse([0, 0, 0], [0, 0, 1], 0);
    }

    system.step(dt, SUBSTEPS);
    renderer.render(camera.matrix(aspect));

    frames++;
    fpsAccum += dt;
    if (fpsAccum >= 0.5) {
      const fps = Math.round(frames / fpsAccum);
      hud.textContent =
        `${fps} fps · ${system.count.toLocaleString('fr-FR')} particules · ` +
        `${system.constraintCount.toLocaleString('fr-FR')} contraintes ` +
        `(${system.bendingCount.toLocaleString('fr-FR')} flexion) · ` +
        `${system.colorCount} couleurs · ${SUBSTEPS} substeps`;
      frames = 0;
      fpsAccum = 0;
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void main();
