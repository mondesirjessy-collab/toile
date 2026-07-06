import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import { generateClothGrid, generateSeamedPanels, combineClothMeshes, type CrossSeam } from './engine/cloth/ClothMesh';
import type { SceneMode } from './app/ControlPanel';
import { ClothRenderer, DEFAULT_FABRIC } from './app/ClothRenderer';
import { OrbitCamera } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh } from './app/SceneGeometry';
import { GpuProfiler } from './app/GpuProfiler';
import { ControlPanel } from './app/ControlPanel';
import { PatternView, type PatternHandleSpec } from './app/PatternView';
import { exportPatternPdf } from './app/patternPdf';
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
import { isNeutral, morphGrid, morphMesh, morphPrims, NO_MORPH, type MorphMarks, type Morphs } from './engine/body/morph';
import { applySkin, buildSkin, poseIdle, type Skin } from './engine/body/pose';
import { bodyRestVertices } from './app/SceneGeometry';

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
  let compliance = { stretch: 1e-7, stretchWarp: 1e-7, shear: 1e-6, bend: 2e-5 };
  let friction = 0.5;
  let fabricStyle = DEFAULT_FABRIC;
  let sceneMode: SceneMode = 'drapé';
  let resolution = DEFAULT_RESOLUTION;
  let selfCollision = true;
  let wind = 0;
  const linearProfile = (flare: number): number[] =>
    Array.from({ length: 6 }, (_, k) => 0.21 + (flare - 0.21) * (k / 5));
  let dressPattern = { length: 1.3, flare: 0.5, neck: 0.1, profile: linearProfile(0.5) };
  let shirtPattern = { sleeve: 0.47, profile: [0.22, 0.22, 0.22] }; // stations v=0.57/0.79/1
  const skirtLinear = (flare: number): number[] =>
    Array.from({ length: 4 }, (_, k) => 0.22 + (flare - 0.22) * (k / 3));
  let skirtPattern = { length: 0.6, flare: 0.46, profile: skirtLinear(0.46) };
  let bodyKind: 'femme' | 'homme' | 'scan homme' | 'scan femme' = 'femme';
  let morphs: Morphs = { ...NO_MORPH };
  let podium = 0; // tours/minute
  let podiumAngle = 0;
  let animate = false;
  let animT = 0;
  // Articulated-animation state, prepared by build() for ARMS prim bodies.
  let animPrims: SdfPrim[] | null = null;
  let animSkin: Skin | null = null;
  let animRest: Float32Array | null = null;
  let animOut: Float32Array | null = null;
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
  const measureFor = (kind: string, prims: SdfPrim[] | null, scan: ScanAvatar['grid'] | null): BodyMeasure => {
    const key = `${kind}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}`;
    if (prims) {
      measureCache[key] ??= measureBody(
        (x, y, z) => sdBody(x, y, z, prims, BODY_BLEND),
        kind === 'homme' ? 1.765 : 1.755,
      );
      return measureCache[key]!;
    }
    if (scan) {
      measureCache[key] ??= measureBody(gridSd(scan), scan.max[1] - 0.06);
      return measureCache[key]!;
    }
    return REF;
  };
  // Full measurements of each UNMORPHED body: warp anchors AND the cm
  // baselines the measurement sliders convert against.
  const baseCache: Record<string, BodyMeasure> = {};
  const baseFor = (kind: string, scan: ScanAvatar | null): BodyMeasure => {
    baseCache[kind] ??=
      kind === 'homme'
        ? measureBody((x, y, z) => sdBody(x, y, z, BODY_MALE, BODY_BLEND), 1.765)
        : scan
          ? measureBody(gridSd(scan.grid), scan.grid.max[1] - 0.06)
          : REF;
    return baseCache[kind]!;
  };
  const marksFor = (kind: string, scan: ScanAvatar | null): MorphMarks => {
    const base = baseFor(kind, scan);
    return {
      shoulderY: base.shoulderY,
      chestY: base.chest.y,
      waistY: base.waist.y,
      hipY: base.hip.y,
      thighY: base.thigh.y,
    };
  };
  /** The selected body's natural prêt-à-porter measurements, in cm. */
  const baseCm = (kind: string, scan: ScanAvatar | null): Record<string, number> => {
    const b = baseFor(kind, scan);
    return {
      stature: b.height * 100,
      carrure: 2 * b.shoulderHalfW * 100,
      poitrine: b.chest.circ * 100,
      taille: b.waist.circ * 100,
      hanches: b.hip.circ * 100,
      cuisse: b.thigh.circ * 100,
    };
  };
  // Morphed-body caches (rebuilt on slider release, keyed by kind+morphs).
  const morphCache: Record<string, { grid: ScanAvatar['grid']; mesh: ScanAvatar['mesh'] }> = {};

  // Stashed by build() so the pattern-view handles use the graded dimensions.
  let lastGrade = { topScale: 1, dressScale: 1, skirtScale: 1, dyShoulder: 0, dyWaist: 0 };

  let currentMesh: ReturnType<typeof generateClothGrid> | null = null;
  let system!: ParticleSystem;
  let renderer!: ClothRenderer;

  // Drag state: the grab test runs synchronously on pointerdown against a
  // periodically-refreshed CPU cache of positions (GPU read-back is async,
  // the press must not be).
  let posCache: Float32Array | null = null;
  // Cloth sleep: when every sampled particle moved less than ~0.5 mm between
  // two position snapshots (~0.27 s apart), three times in a row, the solver
  // is suspended — a settled scene costs (almost) nothing. Any interaction,
  // wind, podium turn, animation or fabric change wakes it.
  // Two-scale detector: solver chatter (mm-level, stationary) never sleeps a
  // MAX criterion, so stillness = near-zero NET DRIFT versus a ~2 s old
  // snapshot (chatter drifts nowhere; a real swing does), three times in a
  // row, while a coarse instantaneous bound rejects fast periodic motion
  // aliasing back onto its own position.
  let sleepSnapshot: Float32Array | null = null; // last readback
  let sleepSnapshotT = 0;
  let driftBase: Float32Array | null = null; // older reference (~2.5 s)
  let driftBaseT = 0;
  let snapshotCount = 0;
  let lastSnapReqT = 0;
  let stillCount = 0;
  let asleep = false;
  const wake = (): void => {
    asleep = false;
    stillCount = 0;
    sleepSnapshot = null;
    driftBase = null;
    snapshotCount = 0;
  };
  let dragIndex: number | null = null;
  let dragDepth = 0;

  const build = (): void => {
    system?.dispose();
    renderer?.dispose();
    // 'drapé': one sheet falling onto the sphere. 'couture': two pattern pieces
    // stitched around the sphere. 'robe': the same seamed pieces closing around
    // a dress form (stacked-sphere bust), falling to the floor.
    const bodyScene =
      sceneMode === 'robe' ||
      sceneMode === 'robe froncée' ||
      sceneMode === 't-shirt' ||
      sceneMode === 'chemise' ||
      sceneMode === 'ensemble' ||
      sceneMode === 'pantalon';
    const scanAvatar = bodyKind.startsWith('scan') ? scans[bodyKind] : null;
    const useScan = bodyScene && scanAvatar !== null;
    const basePrims =
      !bodyScene || useScan
        ? null
        : sceneMode === 'robe' || sceneMode === 'robe froncée'
          ? (bodyKind === 'homme' ? BODY_MALE : BODY_FORM)
          : bodyKind === 'homme'
            ? BODY_MALE_ARMS
            : BODY_FORM_ARMS;
    // Morphology: warp the selected body by the measurement sliders, then let
    // the tailor measure the WARPED figure so garments re-grade themselves.
    const neutral = isNeutral(morphs);
    const marks = bodyScene && !neutral ? marksFor(bodyKind, scanAvatar ?? null) : null;
    const bodyPrims = basePrims && marks ? morphPrims(basePrims, morphs, marks) : basePrims;
    let effScan = useScan ? scanAvatar! : null;
    if (effScan && marks) {
      const key = `${bodyKind}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}`;
      morphCache[key] ??= {
        grid: morphGrid(effScan.grid, morphs, marks),
        mesh: morphMesh(effScan.mesh, morphs, marks),
      };
      effScan = morphCache[key]! as ScanAvatar;
    }
    const colliders = bodyPrims ? toColliders(bodyPrims) : useScan ? [] : SPHERE;
    // Automatic made-to-measure: measure the selected body's field like a
    // tailor (chest, waist, hips, shoulder line) and cut every garment from
    // RATIOS against the reference form the patterns were designed on.
    const m = measureFor(bodyKind, bodyScene ? bodyPrims : null, effScan ? effScan.grid : null);
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
              shapeParams: { profile: dressPattern.profile, scoop: dressPattern.neck },
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
                  shapeParams: { sleeve: shirtPattern.sleeve, profile: [0.22, ...shirtPattern.profile] },
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
                    shapeParams: { profile: skirtPattern.profile },
                    elasticTop: 0.75, // taille élastiquée : fronce et agrippe le corps
                  }),
                )
              : sceneMode === 'robe froncée'
                ? (() => {
                    // Couture v1 au complet dans UN vêtement : bustier élastiqué
                    // (haut qui agrippe) + jupe 1,6× plus large cousue à la
                    // taille — l'EMBU : la couture compresse le bord long sur le
                    // bord court et l'excès de tissu fronce naturellement.
                    const Wb = 0.42 * (m.chest.circ / REF.chest.circ);
                    const Hb = 0.26;
                    const topB = m.chest.y + 0.14; // au-dessus de la poitrine
                    const bod = generateSeamedPanels({
                      resolution,
                      width: Wb,
                      height: Hb,
                      gap: 0.9,
                      topY: topB,
                      elasticTop: 0.85, // bustier : le haut fronce et tient
                    });
                    const jupe = generateSeamedPanels({
                      resolution,
                      width: Wb * 1.6, // l'embu : 60 % de tissu en plus à froncer
                      height: 0.55,
                      gap: 0.9,
                      topY: topB - Hb,
                    });
                    // Couture taille : bas du bustier ↔ haut de la jupe, colonne
                    // à colonne = appariement au prorata des abscisses (mêmes
                    // fractions u/n des deux côtés, longueurs physiques inégales).
                    const cross: CrossSeam[] = [];
                    const ps = resolution * resolution;
                    for (let p = 0; p < 2; p++) {
                      for (let u = 0; u < resolution; u++) {
                        cross.push({
                          i: p * ps + (resolution - 1) * resolution + u,
                          j: bod.count + p * ps + u,
                        });
                      }
                    }
                    return combineClothMeshes(bod, jupe, cross);
                  })()
              : sceneMode === 'pantalon'
                ? // Trousers: yoke + two legs, inseams derived from the cut
                  // between the legs. Snug waist ring sized by the tailor:
                  // hold comes from hips/glutes + Coulomb static friction.
                  generateSeamedPanels({
                    resolution,
                    width: 0.74 * (m.waist.circ / REF.waist.circ),
                    height: m.waist.y + 0.03, // waist band down to the ankles
                    gap: 0.7,
                    topY: m.waist.y + 0.08, // starts above the waist, drops onto it
                    shape: 'pants',
                    elasticTop: 0.8, // ceinture élastiquée
                  })
                : generateClothGrid({ resolution, size: CLOTH_SIZE, topY: CLOTH_TOP_Y, pin: 'none' });
    system = new ParticleSystem(device, mesh, {
      colliders,
      colliderBlend: bodyPrims ? BODY_BLEND : 0,
      sdfGrid: effScan ? effScan.grid : undefined,
      groundY: GROUND_Y,
      friction,
      complianceStretch: compliance.stretch,
      complianceStretchWarp: compliance.stretchWarp,
      complianceShear: compliance.shear,
      complianceBend: compliance.bend,
      selfCollision,
    });
    system.setWind(wind); // keep the breeze across rebuilds
    const sceneMesh = buildSceneMesh({
      colliders: bodyPrims || useScan ? [] : colliders,
      body: bodyPrims ? { prims: bodyPrims, blend: BODY_BLEND } : undefined,
      rawBody: effScan ? effScan.mesh : undefined,
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
    wake();
    // Arm animation applies to sculpted ARMS bodies only (the arms ARE the
    // last 8 primitives; scans are rigid grids — podium only for them).
    if (bodyPrims && bodyPrims !== BODY_FORM && bodyPrims !== BODY_MALE) {
      animPrims = bodyPrims;
      const rest = bodyRestVertices(bodyPrims, BODY_BLEND);
      animSkin = buildSkin(bodyPrims, rest.positions);
      animRest = rest.interleaved;
      animOut = new Float32Array(rest.interleaved);
    } else {
      animPrims = null;
      animSkin = null;
      animRest = null;
      animOut = null;
    }
    currentMesh = mesh;
    patternView.draw(mesh, patternHandles()); // refresh the 2D cutting-layout inset
  };

  // The editable measurements of the current scene, pinned to their cut edges.
  const patternHandles = (): PatternHandleSpec[] => {
    if (sceneMode === 'robe') {
      const grid = { width: 0.95 * lastGrade.dressScale, topY: 1.6 + lastGrade.dyShoulder, height: dressPattern.length };
      // Pattern drafting: one handle per side-seam station — sculpt the
      // silhouette point by point, the dress is re-cut and re-sewn to match.
      const stations: PatternHandleSpec[] = dressPattern.profile.map((w, k) => ({
        id: `profil${k}`,
        label: 'silhouette',
        grid,
        anchor: [0.5 + w, k / 5] as [number, number],
        axis: 'u' as const,
        value: w,
        min: k === 0 ? 0.18 : 0.1,
        max: 0.5,
      }));
      return [
        ...stations,
        { id: 'dressLength', label: 'longueur', grid, anchor: [0.5, 1], axis: 'y', value: dressPattern.length, min: 0.9, max: 1.55, unit: ' m' },
        { id: 'dressNeck', label: 'encolure', grid, anchor: [0.5 + dressPattern.neck, 0], axis: 'u', value: dressPattern.neck, min: 0.06, max: 0.16 },
      ];
    }
    if (sceneMode === 'chemise') {
      const grid = { width: 1.3 * lastGrade.topScale, topY: 1.52 + lastGrade.dyShoulder, height: 0.75 };
      const stations: PatternHandleSpec[] = shirtPattern.profile.map((w, k) => ({
        id: `chemiseProfil${k}`,
        label: 'silhouette',
        grid,
        anchor: [0.5 + w, 0.36 + (0.64 * (k + 1)) / 3] as [number, number],
        axis: 'u' as const,
        value: w,
        min: 0.12,
        max: 0.26,
      }));
      return [
        ...stations,
        { id: 'sleeveLen', label: 'manches', grid, anchor: [0.5 + shirtPattern.sleeve, 0.18], axis: 'u', value: shirtPattern.sleeve, min: 0.33, max: 0.47 },
      ];
    }
    if (sceneMode === 'ensemble') {
      const grid = { width: 0.85 * lastGrade.skirtScale, topY: 1.14 + lastGrade.dyWaist, height: skirtPattern.length };
      const stations: PatternHandleSpec[] = skirtPattern.profile.map((w, k) => ({
        id: `jupeProfil${k}`,
        label: 'silhouette',
        grid,
        anchor: [0.5 + w, k / 3] as [number, number],
        axis: 'u' as const,
        value: w,
        // Waist station: the ring must still close around the body (min) and
        // stay narrower than the hip bulge (max) — measured limits.
        min: k === 0 ? 0.2 : 0.1,
        max: k === 0 ? 0.3 : 0.5,
      }));
      return [
        ...stations,
        { id: 'skirtLength', label: 'longueur', grid, anchor: [0.5, 1], axis: 'y', value: skirtPattern.length, min: 0.4, max: 0.75, unit: ' m' },
      ];
    }
    return [];
  };

  // A handle was released in the layout: commit the measurement everywhere.
  const applyHandle = (id: string, value: number): void => {
    if (id.startsWith('chemiseProfil')) {
      shirtPattern.profile[Number(id.slice(13))] = value;
      panel.setProfiles({ chemise: shirtPattern.profile });
    } else if (id.startsWith('jupeProfil')) {
      skirtPattern.profile[Number(id.slice(10))] = value;
      panel.setProfiles({ jupe: skirtPattern.profile });
    } else if (id.startsWith('profil')) {
      dressPattern.profile[Number(id.slice(6))] = value;
      panel.setProfiles({ robe: dressPattern.profile });
    } else if (id === 'dressFlare') dressPattern.flare = value;
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
  // Double-click: tack the fabric in place right where you aim (pin/unpin).
  canvas.addEventListener('dblclick', (e) => {
    if (!posCache) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const ray = camera.pickRay(ndcX, ndcY, canvas.width / canvas.height);
    const hit = pickParticle(posCache, Math.min(system.count, posCache.length / 4), ray.origin, ray.dir, 0.15);
    if (hit) {
      system.togglePin(hit.index);
      wake();
    }
  });

  const panel = new ControlPanel(
    {
      onScene: (m) => {
        sceneMode = m;
        build();
      },
      onMorph: (cm) => {
        // Sliders speak prêt-à-porter centimeters; the warp speaks ratios.
        const scan = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
        const b = baseCm(bodyKind, scan);
        const r = (target: number, base: number): number =>
          Math.min(1.3, Math.max(0.75, target / Math.max(1, base)));
        morphs = {
          stature: r(cm.stature, b.stature!),
          carrure: r(cm.carrure, b.carrure!),
          poitrine: r(cm.poitrine, b.poitrine!),
          taille: r(cm.taille, b.taille!),
          hanches: r(cm.hanches, b.hanches!),
          cuisse: r(cm.cuisse, b.cuisse!),
        };
        if (sceneMode === 'robe' || sceneMode === 't-shirt' || sceneMode === 'chemise' || sceneMode === 'ensemble' || sceneMode === 'pantalon') {
          build();
        }
      },
      onBody: (kind) => {
        bodyKind = kind;
        morphs = { ...NO_MORPH }; // a new body starts at ITS natural measurements
        panel.syncMorphCm(baseCm(kind, kind.startsWith('scan') ? (scans[kind] ?? null) : null));
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
        wake(); // a different fabric settles into a different shape
      },
      onFriction: (v) => {
        friction = v;
        system.setFriction(v);
        wake();
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
      onPodium: (v) => {
        podium = v;
      },
      onAnimate: (v) => {
        animate = v;
        if (!v && animPrims) build(); // reset to the rest pose cleanly
      },
      onPattern: (p) => {
        // The FLARE slider resets the draft (straight grade); length/neck keep it.
        dressPattern = { ...p, profile: p.flare === dressPattern.flare ? dressPattern.profile : linearProfile(p.flare) };
        panel.setProfiles({ robe: dressPattern.profile });
        // The pattern sliders describe the dress: jump to the dress scene so
        // the adjustment is always visible, then re-cut and re-sew.
        if (sceneMode !== 'robe') {
          sceneMode = 'robe';
          panel.syncScene('robe');
        }
        build();
      },
      onProfile: (kind, profile) => {
        if (kind === 'robe') dressPattern.profile = profile.slice();
        else if (kind === 'chemise') shirtPattern.profile = profile.slice();
        else skirtPattern.profile = profile.slice();
        panel.setProfiles({ [kind]: profile.slice() });
        build();
      },
      onShirtPattern: (p) => {
        shirtPattern = { ...p, profile: shirtPattern.profile };
        if (sceneMode !== 'chemise') {
          sceneMode = 'chemise';
          panel.syncScene('chemise');
        }
        build();
      },
      onSkirtPattern: (p) => {
        // The FLARE slider resets the draft (straight grade); length keeps it.
        skirtPattern = { ...p, profile: p.flare === skirtPattern.flare ? skirtPattern.profile : skirtLinear(p.flare) };
        panel.setProfiles({ jupe: skirtPattern.profile });
        // The skirt lives in the outfit scene.
        if (sceneMode !== 'ensemble') {
          sceneMode = 'ensemble';
          panel.syncScene('ensemble');
        }
        build();
      },
      onFitMap: (v) => renderer.setFitMap(v),
      onPatternPdf: () => {
        if (currentMesh) exportPatternPdf(currentMesh, sceneMode);
      },
      onPins: (held) => {
        system.setCornerPins(held);
        wake();
      },
      onReset: () => {
        system.reset();
        panel.syncPins(false);
        wake();
      },
    },
    { resolution: DEFAULT_RESOLUTION, substeps: DEFAULT_SUBSTEPS },
  );
  // Open the measurement sliders on the default mannequin's own values.
  panel.syncMorphCm(baseCm(bodyKind, null));

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

    // Anything that keeps the cloth alive also keeps the solver awake.
    const sleepEligible =
      wind === 0 && podium === 0 && !animate && dragIndex === null && !mouse.leftDown;
    if (!sleepEligible && asleep) wake();

    // Refresh the CPU position cache used by the instant grab test (time-based
    // ~3 Hz — frame counters mislead when rAF throttles); consecutive
    // snapshots double as the stillness detector for sleep.
    if (now - lastSnapReqT > 300) {
      lastSnapReqT = now;
      void system.readPositions().then((p) => {
        if (!p) return;
        const tArrive = performance.now();
        if (sleepEligible && driftBase && sleepSnapshot && driftBase.length === p.length) {
          // A settled tube garment can keep ROTATING imperceptibly around the
          // body (solver tangential bias at grazing contacts — a whole turn
          // takes ~30 s and a uniform tube looks static). Estimate that rigid
          // rotation about the body axis and measure only the RESIDUAL motion;
          // freezing the rotation is itself a fix, not a lie.
          const residualOver = (ref: Float32Array, limit: number): number => {
            let num = 0;
            let den = 0;
            for (let i = 0; i < p.length; i += 16) {
              const dx = p[i]! - ref[i]!;
              const dz = p[i + 2]! - ref[i + 2]!;
              num += p[i]! * dz - p[i + 2]! * dx; // (r × d)·ŷ
              den += p[i]! * p[i]! + p[i + 2]! * p[i + 2]!;
            }
            const w = den > 1e-6 ? num / den : 0; // radians per interval
            let over = 0;
            for (let i = 0; i < p.length; i += 16) {
              const rx = -w * p[i + 2]!;
              const rz = w * p[i]!;
              const dx = p[i]! - ref[i]! - rx;
              const dy = p[i + 1]! - ref[i + 1]!;
              const dz = p[i + 2]! - ref[i + 2]! - rz;
              if (dx * dx + dy * dy + dz * dz > limit) over++;
            }
            return over;
          };
          const n = p.length / 16;
          // Speed-normalized limits: sustained residual drift > 4 mm/s vs the
          // old reference, or instantaneous residual motion > 4 cm/s.
          const dtBase = Math.max(0.2, (tArrive - driftBaseT) / 1000);
          const dtSnap = Math.max(0.05, (tArrive - sleepSnapshotT) / 1000);
          const drifted = residualOver(driftBase, (0.004 * dtBase) ** 2);
          const fast = residualOver(sleepSnapshot, (0.04 * dtSnap) ** 2);
          if (drifted <= n * 0.005 && fast === 0) {
            stillCount++;
            if (stillCount >= 3) asleep = true;
          } else {
            stillCount = 0;
            asleep = false;
          }
        } else {
          stillCount = 0;
        }
        snapshotCount++;
        if (snapshotCount % 8 === 0 || !driftBase) {
          driftBase = p;
          driftBaseT = tArrive;
        }
        sleepSnapshot = p;
        sleepSnapshotT = tArrive;
        posCache = p;
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
    // Podium: advance the turn, hand the solver the per-second rate (it
    // derives the per-substep surface motion for friction), spin the visual.
    const omega = (podium * 2 * Math.PI) / 60;
    if (omega !== 0) podiumAngle = (podiumAngle + omega * dt) % (2 * Math.PI);
    system.setSpin(podiumAngle, omega);
    renderer.setSpin(podiumAngle);
    // Articulated idle: pose the skeleton, feed the solver the live colliders,
    // skin the visual mesh with the same transforms.
    if (animate && animPrims && animSkin && animRest && animOut) {
      animT += dt;
      const posed = poseIdle(animPrims, animT);
      system.setColliders(toColliders(posed.prims));
      applySkin(animSkin, posed.xfs, animRest, animOut);
      renderer.updateBodyVertices(animOut);
    }
    const sleeping = asleep && sleepEligible;
    if (!sleeping) system.step(dt, substeps, profiler.simSpan());
    renderer.render(camera.matrix(aspect), profiler.renderSpan());
    blit();
    profiler.resolve();

    frames++;
    fpsAccum += dt;
    cpuAccum += performance.now() - t0;
    if (fpsAccum >= 0.5) {
      const fps = Math.round(frames / fpsAccum);
      const timing = asleep
        ? `sim en veille 💤 · rendu ${profiler.enabled ? profiler.renderMs.toFixed(2) : '—'} ms (GPU)`
        : profiler.enabled
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
