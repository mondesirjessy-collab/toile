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
import { PatternView, type PatternHandleSpec } from './app/PatternView';
import { pickParticle } from './app/pick';
import {
  BODY_BLEND,
  BODY_FORM,
  BODY_FORM_ARMS,
  BODY_MALE,
  BODY_MALE_ARMS,
  sdBody,
  type SdfPrim,
} from './engine/body/BodySdf';
import { loadScanAvatar, type ScanAvatar } from './engine/body/ScanAvatar';
import { gridSd, measureBody, type BodyMeasure } from './engine/body/measure';

const DEFAULT_RESOLUTION = 64;
const DEFAULT_SUBSTEPS = 20;
const CLOTH_SIZE = 1.6;
const CLOTH_TOP_Y = 1.7;

// Shared scene definitions: the solver collides against these, the renderer draws them.
const GROUND_Y = 0;
type V3 = [number, number, number];
const SPHERE = [{ a: [0, 0.8, 0] as V3, radius: 0.55 }];
// The sculpted dress form lives in engine/body/BodySdf.ts: round cones blended
// into one smooth field (BODY_FORM, BODY_FORM_ARMS). The solver collides with
// the field; the renderer meshes the very same field via surface nets.
const toColliders = (prims: SdfPrim[]) =>
  prims.map((p) => ({ a: p.a, b: p.b, radius: p.ra, radius2: p.rb, scale: p.s }));

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
  // Dragging a handle in the 2D layout edits the measurement: update the
  // pattern state, mirror it into the panel sliders, then re-cut and re-sew.
  const patternView = new PatternView(document.getElementById('pattern') as HTMLCanvasElement, (id, value) =>
    applyHandle(id, value),
  );
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
  let shirtPattern = { sleeve: 0.47 };
  let skirtPattern = { length: 0.6, flare: 0.46 };
  let bodyKind: 'femme' | 'homme' | 'scan homme' | 'scan femme' = 'femme';
  // The scanned CC0 avatar (Blender Studio realistic male via Wikimedia
  // Commons) — rendered as a real mesh, felt by the cloth as a baked SDF grid.
  const scans: Record<string, ScanAvatar | null> = {
    'scan homme': await loadScanAvatar(`${import.meta.env.BASE_URL}avatars/homme-scan`),
    'scan femme': await loadScanAvatar(`${import.meta.env.BASE_URL}avatars/femme-scan`),
  };

  // The tailor: measurements of the reference form the patterns were cut on,
  // then lazy per-mannequin measurements (analytic field or scan grid).
  const REF = measureBody((x, y, z) => sdBody(x, y, z, BODY_FORM, BODY_BLEND), 1.755);
  const measureCache: Record<string, BodyMeasure> = {};
  const measureFor = (kind: string, scan: ScanAvatar | null): BodyMeasure => {
    if (kind === 'homme') {
      measureCache[kind] ??= measureBody((x, y, z) => sdBody(x, y, z, BODY_MALE, BODY_BLEND), 1.765);
      return measureCache[kind]!;
    }
    if (scan) {
      measureCache[kind] ??= measureBody(gridSd(scan.grid), scan.grid.max[1] - 0.06);
      return measureCache[kind]!;
    }
    return REF;
  };

  // Stashed by build() so the pattern-view handles use the graded dimensions.
  let lastGrade = { topScale: 1, dressScale: 1, skirtScale: 1, dyShoulder: 0, dyWaist: 0 };

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
    const bodyScene =
      sceneMode === 'robe' || sceneMode === 't-shirt' || sceneMode === 'chemise' || sceneMode === 'ensemble';
    const scanAvatar = bodyKind.startsWith('scan') ? scans[bodyKind] : null;
    const useScan = bodyScene && scanAvatar !== null;
    const bodyPrims =
      !bodyScene || useScan
        ? null
        : sceneMode === 'robe'
          ? (bodyKind === 'homme' ? BODY_MALE : BODY_FORM)
          : bodyKind === 'homme'
            ? BODY_MALE_ARMS
            : BODY_FORM_ARMS;
    const colliders = bodyPrims ? toColliders(bodyPrims) : useScan ? [] : SPHERE;
    // Automatic made-to-measure: measure the selected body's field like a
    // tailor (chest, waist, hips, shoulder line) and cut every garment from
    // RATIOS against the reference form the patterns were designed on.
    const m = measureFor(bodyKind, useScan && scanAvatar ? scanAvatar : null);
    const clampR = (v: number): number => Math.min(1.35, Math.max(0.8, v));
    const chestR = m.chest.circ / REF.chest.circ;
    const shoulderR = m.shoulderHalfW / REF.shoulderHalfW;
    // Strap/neckline-held garments live or die on the SHOULDER fit; the body
    // of the garment stretches over the chest. 70/30 reproduces the grades
    // that were hand-tuned per body before this tailor existed.
    const dressScale = clampR(0.7 * shoulderR + 0.3 * chestR);
    const topScale = clampR(Math.max(chestR, 0.7 * shoulderR + 0.3 * chestR));
    const skirtScale = clampR(m.hip.circ / REF.hip.circ);
    const dyShoulder = m.shoulderY - REF.shoulderY;
    lastGrade = { topScale, dressScale, skirtScale, dyShoulder, dyWaist: m.waist.y - REF.waist.y };
    const tee = () =>
      generateSeamedPanels({
        resolution,
        width: 1.15 * topScale, // sleeve tip to sleeve tip
        height: 0.75,
        gap: 0.9,
        topY: 1.52 + dyShoulder,
        shape: 'tshirt', // kimono tee: body + sleeves in one piece
      });
    const mesh =
      sceneMode === 'couture'
        ? generateSeamedPanels({ resolution, width: 1.2, height: 1.2, gap: 1.3, topY: 1.9 })
        : sceneMode === 'robe'
          ? generateSeamedPanels({
              resolution,
              width: 0.95 * dressScale,
              height: dressPattern.length,
              gap: 1.0,
              topY: 1.6 + dyShoulder,
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
                  width: 1.3 * topScale,
                  height: 0.75,
                  gap: 0.9,
                  topY: 1.52 + dyShoulder,
                  shape: 'setin',
                  shapeParams: { sleeve: shirtPattern.sleeve },
                })
            : sceneMode === 'ensemble'
              ? // Outfit: tee + flared skirt, one simulation — self-collision
                // keeps the layers apart where they overlap.
                combineClothMeshes(
                  tee(),
                  generateSeamedPanels({
                    resolution,
                    // Waist ring smaller than the hip bulge — cannot slip past.
                    // Honest physics: on the male body (waist ≈ hips) a skirt
                    // has nothing to catch on and slides down at ANY size —
                    // like in real life without a belt. Belts are future work.
                    width: 0.85 * skirtScale,
                    height: skirtPattern.length,
                    gap: 0.75,
                    topY: 1.14 + (m.waist.y - REF.waist.y), // starts above the hips, drops onto them
                    shape: 'skirt',
                    shapeParams: { hem: skirtPattern.flare },
                  }),
                )
              : generateClothGrid({ resolution, size: CLOTH_SIZE, topY: CLOTH_TOP_Y, pin: 'none' });
    system = new ParticleSystem(device, mesh, {
      colliders,
      colliderBlend: bodyPrims ? BODY_BLEND : 0,
      sdfGrid: useScan ? scanAvatar!.grid : undefined,
      groundY: GROUND_Y,
      friction,
      complianceStretch: compliance.stretch,
      complianceShear: compliance.shear,
      complianceBend: compliance.bend,
      selfCollision,
    });
    system.setWind(wind); // keep the breeze across rebuilds
    const sceneMesh = buildSceneMesh({
      colliders: bodyPrims || useScan ? [] : colliders,
      body: bodyPrims ? { prims: bodyPrims, blend: BODY_BLEND } : undefined,
      rawBody: useScan ? scanAvatar!.mesh : undefined,
      groundY: GROUND_Y,
    });
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
    patternView.draw(mesh, patternHandles()); // refresh the 2D cutting-layout inset
  };

  // The editable measurements of the current scene, pinned to their cut edges.
  const patternHandles = (): PatternHandleSpec[] => {
    if (sceneMode === 'robe') {
      const grid = { width: 0.95 * lastGrade.dressScale, topY: 1.6 + lastGrade.dyShoulder, height: dressPattern.length };
      return [
        { id: 'dressFlare', label: 'évasement', grid, anchor: [0.5 + dressPattern.flare, 1], axis: 'u', value: dressPattern.flare, min: 0.25, max: 0.5 },
        { id: 'dressLength', label: 'longueur', grid, anchor: [0.5, 1], axis: 'y', value: dressPattern.length, min: 0.9, max: 1.55, unit: ' m' },
        { id: 'dressNeck', label: 'encolure', grid, anchor: [0.5 + dressPattern.neck, 0], axis: 'u', value: dressPattern.neck, min: 0.06, max: 0.16 },
      ];
    }
    if (sceneMode === 'chemise') {
      const grid = { width: 1.3 * lastGrade.topScale, topY: 1.52 + lastGrade.dyShoulder, height: 0.75 };
      return [
        { id: 'sleeveLen', label: 'manches', grid, anchor: [0.5 + shirtPattern.sleeve, 0.18], axis: 'u', value: shirtPattern.sleeve, min: 0.33, max: 0.47 },
      ];
    }
    if (sceneMode === 'ensemble') {
      const grid = { width: 0.85 * lastGrade.skirtScale, topY: 1.14 + lastGrade.dyWaist, height: skirtPattern.length };
      return [
        { id: 'skirtFlare', label: 'évasement', grid, anchor: [0.5 + skirtPattern.flare, 1], axis: 'u', value: skirtPattern.flare, min: 0.3, max: 0.46 },
        { id: 'skirtLength', label: 'longueur', grid, anchor: [0.5, 1], axis: 'y', value: skirtPattern.length, min: 0.4, max: 0.75, unit: ' m' },
      ];
    }
    return [];
  };

  // A handle was released in the layout: commit the measurement everywhere.
  const applyHandle = (id: string, value: number): void => {
    if (id === 'dressFlare') dressPattern.flare = value;
    else if (id === 'dressLength') dressPattern.length = value;
    else if (id === 'dressNeck') dressPattern.neck = value;
    else if (id === 'sleeveLen') shirtPattern.sleeve = value;
    else if (id === 'skirtLength') skirtPattern.length = value;
    else if (id === 'skirtFlare') skirtPattern.flare = value;
    else return;
    panel.syncPattern({ [id]: value });
    build();
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
      onBody: (kind) => {
        bodyKind = kind;
        // Only rebuild where a body is actually on stage; drapé/couture keep
        // their cloth instead of resetting for an invisible change.
        if (sceneMode === 'robe' || sceneMode === 't-shirt' || sceneMode === 'chemise' || sceneMode === 'ensemble') {
          build();
        }
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
      onShirtPattern: (p) => {
        shirtPattern = p;
        if (sceneMode !== 'chemise') {
          sceneMode = 'chemise';
          panel.syncScene('chemise');
        }
        build();
      },
      onSkirtPattern: (p) => {
        skirtPattern = p;
        // The skirt lives in the outfit scene.
        if (sceneMode !== 'ensemble') {
          sceneMode = 'ensemble';
          panel.syncScene('ensemble');
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
