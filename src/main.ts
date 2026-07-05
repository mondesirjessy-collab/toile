import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import { generateClothGrid, generateSeamedPanels, combineClothMeshes } from './engine/cloth/ClothMesh';
import type { SceneMode } from './app/ControlPanel';
import { ClothRenderer, DEFAULT_FABRIC } from './app/ClothRenderer';
import { OrbitCamera } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh } from './app/SceneGeometry';
import { GpuProfiler } from './app/GpuProfiler';
import { ControlPanel } from './app/ControlPanel';
import { PatternView } from './app/PatternView';
import { pickParticle } from './app/pick';

const DEFAULT_RESOLUTION = 64;
const DEFAULT_SUBSTEPS = 20;
const CLOTH_SIZE = 1.6;
const CLOTH_TOP_Y = 1.7;

// Shared scene definitions: the solver collides against these, the renderer draws them.
const GROUND_Y = 0;
type V3 = [number, number, number];
const SPHERE = [{ a: [0, 0.8, 0] as V3, radius: 0.55 }];
// Full mannequin, capsule silhouette: head, neck, shoulders, torso, hips, legs.
const MANNEQUIN = [
  { a: [0, 1.62, 0] as V3, radius: 0.11 }, // head
  { a: [0, 1.46, 0] as V3, b: [0, 1.54, 0] as V3, radius: 0.05 }, // neck
  { a: [-0.19, 1.4, 0] as V3, b: [0.19, 1.4, 0] as V3, radius: 0.07 }, // shoulders
  { a: [0, 1.16, 0] as V3, b: [0, 1.38, 0] as V3, radius: 0.155 }, // torso
  { a: [-0.05, 0.94, 0] as V3, b: [0.05, 0.94, 0] as V3, radius: 0.15 }, // hips
  { a: [-0.08, 0.9, 0] as V3, b: [-0.085, 0.08, 0] as V3, radius: 0.065 }, // left leg
  { a: [0.08, 0.9, 0] as V3, b: [0.085, 0.08, 0] as V3, radius: 0.065 }, // right leg
];
// Same mannequin with A-pose arms, angled to match the kimono sleeve slope.
const MANNEQUIN_ARMS = [
  ...MANNEQUIN,
  { a: [-0.21, 1.4, 0] as V3, b: [-0.38, 1.28, 0] as V3, radius: 0.055 }, // left arm
  { a: [0.21, 1.4, 0] as V3, b: [0.38, 1.28, 0] as V3, radius: 0.055 }, // right arm
];

let fatalShown = false;

/** Surface any startup/GPU error on screen instead of failing to a blank canvas. */
function showFatal(title: string, detail: string): void {
  if (fatalShown) return;
  fatalShown = true;
  const overlay = document.getElementById('overlay') as HTMLElement;
  overlay.hidden = false;
  overlay.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'detail';
  p.style.whiteSpace = 'pre-wrap';
  p.textContent = detail;
  overlay.append(h, p);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const mirror = document.getElementById('mirror') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  // 2D mirror of the WebGPU canvas — some systems never present WebGPU frames
  // to screen even though the content is rendered; a 2D canvas always shows.
  const mirrorCtx = mirror.getContext('2d');
  const blit = (): void => {
    if (!mirrorCtx || canvas.width === 0) return;
    try {
      mirrorCtx.drawImage(canvas, 0, 0, mirror.width, mirror.height);
    } catch {
      /* source not drawable yet — skip this frame */
    }
  };

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
  // Surface WebGPU validation/pipeline errors (e.g. a shader a browser rejects)
  // on screen — otherwise they only blank the canvas silently.
  device.addEventListener('uncapturederror', (e) => {
    const msg = (e as GPUUncapturedErrorEvent).error.message;
    console.error('[toile] WebGPU error:', msg);
    showFatal('Erreur WebGPU', msg);
  });

  const camera = new OrbitCamera(); // attached below, once the grab test exists
  const mouse = new MouseForce();
  mouse.attach(canvas);
  const patternView = new PatternView(document.getElementById('pattern') as HTMLCanvasElement);
  const profiler = new GpuProfiler(device);

  // Fabric params kept across rebuilds (a resolution change recreates the sim).
  let compliance = { stretch: 1e-7, shear: 1e-6, bend: 2e-5 };
  let friction = 0.5;
  let fabricStyle = DEFAULT_FABRIC;
  let sceneMode: SceneMode = 'drapé';
  let resolution = DEFAULT_RESOLUTION;
  let selfCollision = true;
  let wind = 0;
  let dressPattern = { length: 1.3, flare: 0.5, neck: 0.1 };

  let system!: ParticleSystem;
  let renderer!: ClothRenderer;

  // Drag state: the grab test runs synchronously on pointerdown against a
  // periodically-refreshed CPU cache of positions (GPU read-back is async,
  // the press must not be).
  let posCache: Float32Array | null = null;
  let dragIndex: number | null = null;
  let dragDepth = 0;

  const build = (): void => {
    system?.dispose();
    renderer?.dispose();
    // 'drapé': one sheet falling onto the sphere. 'couture': two pattern pieces
    // stitched around the sphere. 'robe': the same seamed pieces closing around
    // a dress form (stacked-sphere bust), falling to the floor.
    const colliders =
      sceneMode === 'robe'
        ? MANNEQUIN
        : sceneMode === 't-shirt' || sceneMode === 'chemise' || sceneMode === 'ensemble'
          ? MANNEQUIN_ARMS
          : SPHERE;
    const tee = () =>
      generateSeamedPanels({
        resolution,
        width: 1.15, // sleeve tip to sleeve tip
        height: 0.75,
        gap: 0.9,
        topY: 1.52,
        shape: 'tshirt', // kimono tee: body + sleeves in one piece
      });
    const mesh =
      sceneMode === 'couture'
        ? generateSeamedPanels({ resolution, width: 1.2, height: 1.2, gap: 1.3, topY: 1.9 })
        : sceneMode === 'robe'
          ? generateSeamedPanels({
              resolution,
              width: 0.95,
              height: dressPattern.length,
              gap: 1.0,
              topY: 1.6,
              shape: 'aline', // real pattern piece: fitted, flared, scooped neckline
              shapeParams: { hem: dressPattern.flare, scoop: dressPattern.neck },
            })
          : sceneMode === 't-shirt'
            ? tee()
            : sceneMode === 'chemise'
              ? // Set-in sleeves: body + two separate sleeve pieces on one
                // cutting sheet, armholes stitched island-to-island.
                generateSeamedPanels({
                  resolution,
                  width: 1.3,
                  height: 0.75,
                  gap: 0.9,
                  topY: 1.52,
                  shape: 'setin',
                })
            : sceneMode === 'ensemble'
              ? // Outfit: tee + flared skirt, one simulation — self-collision
                // keeps the layers apart where they overlap.
                combineClothMeshes(
                  tee(),
                  generateSeamedPanels({
                    resolution,
                    width: 0.85, // waist ring smaller than the hip bulge — cannot slip past
                    height: 0.6,
                    gap: 0.75,
                    topY: 1.14, // starts above the hips, drops onto them
                    shape: 'skirt',
                  }),
                )
              : generateClothGrid({ resolution, size: CLOTH_SIZE, topY: CLOTH_TOP_Y, pin: 'none' });
    system = new ParticleSystem(device, mesh, {
      colliders,
      groundY: GROUND_Y,
      friction,
      complianceStretch: compliance.stretch,
      complianceShear: compliance.shear,
      complianceBend: compliance.bend,
      selfCollision,
    });
    system.setWind(wind); // keep the breeze across rebuilds
    const sceneMesh = buildSceneMesh({ colliders, groundY: GROUND_Y });
    renderer = new ClothRenderer(
      device,
      canvas,
      system.positionBuffer,
      system.count,
      mesh.resolution,
      mesh.spacing,
      mesh.triangleIndices,
      sceneMesh,
    );
    renderer.setFabric(fabricStyle); // keep the preset's look across rebuilds
    renderer.resize(canvas.width, canvas.height);
    posCache = null; // stale cache belongs to the previous system
    dragIndex = null;
    patternView.draw(mesh); // refresh the 2D cutting-layout inset
  };
  build();

  // CLO3D-style pointer model: a left press ON the fabric grabs it; a left
  // press on empty space orbits the camera. Returns true when orbit is allowed.
  const tryOrbit = (e: PointerEvent): boolean => {
    if (!posCache) return true; // no cache yet → just orbit
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const ray = camera.pickRay(ndcX, ndcY, canvas.width / canvas.height);
    const count = Math.min(system.count, posCache.length / 4);
    const hit = pickParticle(posCache, count, ray.origin, ray.dir, 0.15);
    if (!hit) return true;
    dragIndex = hit.index;
    dragDepth = hit.depth;
    return false; // fabric grabbed — the camera stays put
  };
  camera.attach(canvas, tryOrbit);

  const panel = new ControlPanel(
    {
      onScene: (m) => {
        sceneMode = m;
        build();
      },
      onResolution: (r) => {
        resolution = r;
        build();
      },
      onCompliance: (c) => {
        compliance = c;
        system.setCompliance(c);
      },
      onFriction: (v) => {
        friction = v;
        system.setFriction(v);
      },
      onStyle: (style) => {
        fabricStyle = style;
        renderer.setFabric(style);
      },
      onSelfCollision: (enabled) => {
        selfCollision = enabled;
        system.setSelfCollision(enabled);
      },
      onWind: (v) => {
        wind = v;
        system.setWind(v);
      },
      onPattern: (p) => {
        dressPattern = p;
        // The pattern sliders describe the dress: jump to the dress scene so
        // the adjustment is always visible, then re-cut and re-sew.
        if (sceneMode !== 'robe') {
          sceneMode = 'robe';
          panel.syncScene('robe');
        }
        build();
      },
      onPins: (held) => system.setCornerPins(held),
      onReset: () => {
        system.reset();
        panel.syncPins(false);
      },
    },
    { resolution: DEFAULT_RESOLUTION, substeps: DEFAULT_SUBSTEPS },
  );

  // Keyboard shortcuts mirror the panel (brief §3.3 release flow).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      system.reset();
      panel.syncPins(false);
    } else if (e.key === 'p' || e.key === 'P') {
      const held = !system.pinsHeld;
      system.setCornerPins(held);
      panel.syncPins(held);
    }
  });

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    mirror.width = canvas.width;
    mirror.height = canvas.height;
    renderer.resize(canvas.width, canvas.height);
  };
  window.addEventListener('resize', resize);
  // A ResizeObserver also catches late/zero-then-nonzero sizing (some embedded
  // webviews report a 0×0 viewport on load, which would leave nothing to draw).
  new ResizeObserver(resize).observe(canvas);
  resize();

  // --- Loop with fps + timing accounting ---
  let last = performance.now();
  let frames = 0;
  let fpsAccum = 0;
  let cpuAccum = 0;

  const frame = (now: number): void => {
    const t0 = performance.now();
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp tab-switch spikes
    last = now;

    // Skip while the canvas has no size (some webviews report a 0×0 viewport
    // until laid out) — rendering into a 0-sized surface errors.
    if (canvas.width === 0 || canvas.height === 0) {
      schedule();
      return;
    }

    const aspect = canvas.width / canvas.height;
    const ray = camera.pickRay(mouse.ndcX, mouse.ndcY, aspect);

    // Refresh the CPU position cache used by the instant grab test (~7 Hz).
    if ((frames & 7) === 0) {
      void system.readPositions().then((p) => {
        if (p) posCache = p;
      });
    }

    // Drive or release the drag constraint.
    if (dragIndex !== null) {
      if (mouse.leftDown) {
        system.setDrag(dragIndex, [
          ray.origin[0] + ray.dir[0] * dragDepth,
          ray.origin[1] + ray.dir[1] * dragDepth,
          ray.origin[2] + ray.dir[2] * dragDepth,
        ]);
      } else {
        system.setDrag(null, [0, 0, 0]);
        dragIndex = null;
      }
    }

    const substeps = panel.substeps;
    system.step(dt, substeps, profiler.simSpan());
    renderer.render(camera.matrix(aspect), profiler.renderSpan());
    blit();
    profiler.resolve();

    frames++;
    fpsAccum += dt;
    cpuAccum += performance.now() - t0;
    if (fpsAccum >= 0.5) {
      const fps = Math.round(frames / fpsAccum);
      const timing = profiler.enabled
        ? `sim ${profiler.simMs.toFixed(2)} ms · rendu ${profiler.renderMs.toFixed(2)} ms (GPU)`
        : `${(cpuAccum / frames).toFixed(2)} ms/frame (CPU)`;
      hud.textContent =
        `${fps} fps · ${timing} · ${system.count.toLocaleString('fr-FR')} part. · ` +
        `${system.constraintCount.toLocaleString('fr-FR')} contr. · ${substeps} substeps`;
      frames = 0;
      fpsAccum = 0;
      cpuAccum = 0;
    }

    schedule();
  };

  // Drive the loop with requestAnimationFrame AND a watchdog timer, armed
  // together: whichever fires first runs the frame and re-arms both (frame()
  // ends with schedule(), which cancels the loser). On healthy systems rAF wins
  // at 60 fps; on systems where rAF never fires (hidden tabs, or machines whose
  // display compositor is broken for this page — observed in the field), the
  // 50 ms watchdog keeps the sim and interaction alive at ~20 fps.
  let rafId = 0;
  let timeoutId = 0;
  const schedule = (): void => {
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
    rafId = requestAnimationFrame(frame);
    timeoutId = window.setTimeout(() => frame(performance.now()), 50);
  };

  // Draw the initial state once so the scene shows immediately, before the loop.
  renderer.render(camera.matrix(canvas.width / canvas.height));
  blit();
  schedule();
}

main().catch((e) => showFatal('Erreur au démarrage', e?.stack ?? e?.message ?? String(e)));
