import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { liveSceneGpuResources } from './engine/gpu/SceneResourceRegistry';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import {
  summarizeCollisionAudit,
  summarizeVisualCollisionAudit,
  type CollisionAuditReport,
  type VisualCollisionAuditReport,
} from './engine/solver/CollisionAudit';
import { inverseRotateY, MeshProximity } from './engine/geometry/MeshProximity';
import {
  summarizeDeclaredSeamAudit,
  summarizeClothOverlapAudit,
  type ClothAuditParticleRange,
  type DeclaredSeamAuditReport,
  type ClothOverlapAuditReport,
} from './engine/solver/ClothOverlapAudit';
import {
  FABRIC_PHYSICS,
  MAX_FABRIC_GSM,
  MIN_FABRIC_GSM,
  fabricMaterialLibrary,
  isFabricPresetName,
  type FabricCompliance,
  type FabricDynamics,
} from './engine/solver/FabricMaterial';
import { generateClothGrid, generateSeamedPanels, combineClothMeshes, scaleMeshInverseMassesToReferenceCellArea, type CrossSeam, type ClothMeshData } from './engine/cloth/ClothMesh';
import { defaultDraft, blankBaseDraft, tshirtDraft, compileDraft, compileAssembly, compileAssemblyGroups, compileCrossSeams, compileQuiltSeams, compileSurfaceContacts, compileSurfaceSeams, crossSewnOpenCells, cutPieceAlongChord, docPieces, freeSeamBetween, mirrorDuplicatePiece, graphicLocalUV, GRAPHIC_IMAGE_MAX_CHARS, INTERNAL_LINES_MAX, offsetPieceOutline, generateFittedSleeves, addFisheyeDart, roundOutlineCorner, cutPieceAlongInternalLine, toggleNotchAt, addSeamNotches, slashSpreadFullness, mergePiecesAlongSeam, toggleInternalHole, linkedVertexEdit, divideOutlineEdge, alignOutlineVertex, squareCorner, extendInternalLineEnd, divideInternalLineAt, pieceHolePolygons, isSelfIntersecting, fitCapWidthToArmhole, draftPieceLabel, gatherSeamSide, neckOpeningCells, removeFreePiece, reboxPiece, pieceIdOf, nearestOutlineEdgeInfo, syncPieceFrames, sanitizeDraft, pointInPolygon, pointInTriangle, surfaceAttachmentUV, type DraftDoc, type AssemblySeam, type DraftPiece, type PieceGraphic, type UV } from './engine/pattern/Draft';
import {
  applyStagingOffset,
  applyStagingOrient,
  quatFromAxisAngle,
  rotatePieceInstanceInStaging,
  stagingOrientOf,
  autoPlaceMeshFromCrossSeams,
  canTemporarilyExcludePiece,
  draftForSimulationExcluding,
  hasStagingOffset,
  movePieceInstanceInStaging,
  placeMeshOnSurface,
  placementRoleLabel,
  placementRoleOf,
  resetPieceInstanceStaging,
  resetPieceStaging,
  stagingOffsetOf,
  simulationPlacementIssues,
} from './engine/pattern/PatternPlacement';
import { boxyTee, boxyChestCm, BOXY_SIZES, type BoxySize, type TeeSleeves, type TeeCollar, type TeeNeck, type TeeLength } from './engine/pattern/draftTee';
import { draftJupe, jupeCm, JUPE_SIZES, type JupeSize } from './engine/pattern/jupe';
import { draftRobe, robeCm, ROBE_SIZES, type RobeSize } from './engine/pattern/robe';
import { draftVeste, vesteCm, VESTE_AVATAR_EASE_CM, VESTE_SIZES, type VesteSize } from './engine/pattern/veste';
import { draftDoudoune, doudouneCm, DOUDOUNE_AVATAR_EASE_CM, DOUDOUNE_SIZES, type DoudouneSize } from './engine/pattern/doudoune';
import { cloTee, cloPants } from './engine/pattern/cloBlocks';
import {
  loosePants,
  loosePantsSizeLabel,
  LOOSE_PANTS_SIZES,
  type LoosePantsSize,
} from './engine/pattern/loosePants';
import { buildLoosePantsMesh } from './engine/pattern/LoosePantsAssembly';
import {
  lucasHoodie,
  lucasHoodieAdjusted,
  lucasHoodieFit,
  lucasHoodieSizeLabel,
  lucasHoodieSourceSize,
  lucasZipperLengthM,
  LUCAS_HOODIE_SIZES,
  type LucasHoodieSize,
} from './engine/pattern/lucasHoodie';
import { buildLucasHoodieMesh } from './engine/pattern/LucasHoodieAssembly';
import { rigidlyPlaceGarmentPanels } from './engine/pattern/HoodieRigidPlacement';
import { placeWrapSleeve, sleeveCrossSeams } from './engine/pattern/SleeveAssembly';
import {
  collarCrossSeams,
  fitCollarTubeToNeckline,
  preWrapCollarTube,
} from './engine/pattern/CollarAssembly';
import { preWrapTwoPanelTube } from './engine/pattern/TubePlacement';
import { preWrapKimonoSleeves } from './engine/pattern/KimonoSleevePlacement';
import { preCloseBodySafeMirrorSeams } from './engine/pattern/SeamPlacement';
import { ClothRenderer, DEFAULT_FABRIC, packVisualMaterial } from './app/ClothRenderer';
import { OrbitCamera, type CameraBounds } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh, SCENE_VERTEX_FLOATS, type SceneMesh } from './app/SceneGeometry';
import { computeNormals, downloadGlb, type GltfPiece } from './app/gltfExport';
import { exportTechPack } from './app/techPack';
import { exportMarker, exportMultiSizeMarker } from './app/markerLayout';
import { exportDxf, exportGradedDxf } from './app/dxfExport';
import { exportMaterialReport, parseSizeCurve } from './app/materialReport';
import { GpuProfiler } from './app/GpuProfiler';
import {
  AVATAR_STATURE_MAX_CM,
  AVATAR_STATURE_MIN_CM,
  ControlPanel,
  type GlobalFabricPreset,
  type SceneMode,
} from './app/ControlPanel';
import {
  fixedGarmentSizeMessage,
  GLOBAL_FABRIC_INHERIT_VALUE,
  inheritedFabricLabel,
  normalizeResolution,
  pieceFabricSelectEnabled,
  resolutionRebuildMessage,
  type SupportedResolution,
} from './app/ControlStateSync';
import { showToast, undoToastMessage } from './app/ToastQueue';
import { claimFirstUseTip } from './app/FirstUseTip';
import { BRIEF_ENDPOINT_STORAGE_KEY, probeBriefEndpoint, RemoteBackend, RulesBackend, type BriefBackend, type BriefImageAttachment } from './app/brief/BriefBackend';
import { validateFitAdvice, type FitAdviceResult } from './app/brief/FitContract';
import { executeBrief, type BriefHooks } from './app/brief/BriefExecutor';
import { PatternView, SEAM_COLORS, type PatternHandleSpec, type SystemLink } from './app/PatternView';
import { setPatternTheme, type PatternTheme } from './app/patternPalette';
import { exportDraftPatternPdf, exportDraftPatternSvg } from './app/draftPatternExport';
import { exportPatternPdf } from './app/patternPdf';
import { exportPatternSvg } from './app/patternSvg';
import {
  STAGING_PICK_RADIUS,
  STAGING_PICK_RADIUS_PX,
  pickFrontmostInRanges,
  pickParticle,
  type TaggedParticleRange,
} from './app/pick';
import {
  SceneBuildTimeoutError,
  SceneLifecycle,
  SceneTeardownTimeoutError,
  SceneTransitionChurnError,
  SceneTransitionStallError,
  type SceneBuildContext,
} from './app/SceneLifecycle';
import {
  AutosaveController,
  IndexedDbAutosaveStore,
  markRecoveryHandled,
  shouldOfferRecovery,
  type AutosaveSnapshot,
} from './app/AutosaveStore';
import {
  BODY_BLEND,
  BODY_FORM,
  BODY_FORM_ARMS,
  BODY_MALE,
  BODY_MALE_ARMS,
  horizontalizeArmChains,
  sdBody,
  type SdfPrim,
} from './engine/body/BodySdf';
import {
  ensureScanCollisionForPose,
  loadScanAvatar,
  scanHasCollisionPose,
  type ScanAvatar,
  type ScanCollisionPose,
} from './engine/body/ScanAvatar';
import { arrangementPoints, gridSd, measureBody, type ArrangementPoint, type BodyMeasure, type Sd } from './engine/body/measure';
import { isNeutral, morphGrid, morphMesh, morphPrims, NO_MORPH, type MorphMarks, type Morphs } from './engine/body/morph';
import { parseObj, buildImportedBody } from './engine/body/importBody';
import { applySkin, buildSkin, poseIdle, type Skin } from './engine/body/pose';
import { bodyRestVertices } from './app/SceneGeometry';

const DEFAULT_RESOLUTION: SupportedResolution = 64;
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
let fatalCount = 0;

/** Surface any startup/GPU error on screen instead of failing to a blank canvas. */
function showFatal(title: string, detail: string): void {
  if (fatalShown) return;
  fatalShown = true;
  fatalCount++;
  const overlay = document.getElementById('overlay') as HTMLElement;
  overlay.hidden = false;
  overlay.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'detail';
  p.style.whiteSpace = 'pre-wrap';
  p.textContent = detail;
  // Recovery path (audit — robustness): a lost device (laptop GPU switch, a
  // driver TDR reset) or a one-off render error otherwise leaves a dead page.
  // A reload re-inits WebGPU cleanly — far simpler and safer than programmatic
  // device re-creation (the device is a const wired through the whole engine).
  const retry = document.createElement('button');
  retry.textContent = 'Recharger';
  retry.style.cssText = 'margin-top:1rem;padding:0.5rem 1.2rem;font:inherit;cursor:pointer;';
  retry.addEventListener('click', () => window.location.reload());
  overlay.append(h, p, retry);
}

/**
 * The EXACT front-view silhouette of the 3D avatar, projected from its rendered
 * mesh into the SAME world (x, y) plane the flat pattern lives in — so a piece
 * drawn over it in the 2D atelier is sized against the real body shown in 3D.
 * Rasterizes the mesh vertices into a fine (x, y) occupancy grid, then emits,
 * per row, the filled horizontal runs — bridging small vertex gaps but leaving
 * true gaps (between the legs, arm-to-torso) open. Returns world-space filled
 * rectangles plus the overall bounds (for fitting the panel to the body).
 */
export interface AvatarSilhouette {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  rects: Array<[number, number, number, number]>; // [x0, y0, x1, y1] world
}

function avatarBounds(positions: Float32Array): CameraBounds | null {
  if (positions.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite)
    ? { min, max }
    : null;
}

function avatarSilhouette(positions: Float32Array, indices: Uint32Array): AvatarSilhouette {
  const N = positions.length / 3;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const rows = 176;
  const cellH = (maxY - minY) / rows || 1;
  const cols = Math.max(8, Math.round((maxX - minX) / cellH));
  const cellW = (maxX - minX) / cols || 1;
  const bits = new Uint8Array(cols * rows);
  // Rasterize the mesh TRIANGLES projected to the (x, y) plane: mark every cell
  // whose centre falls inside a triangle. The union is the solid front
  // silhouette — no interior speckle — while true gaps (between the legs,
  // arm-to-torso) stay empty because no triangle spans them.
  const T = (indices.length / 3) | 0;
  for (let t = 0; t < T; t++) {
    const ia = indices[t * 3]!;
    const ib = indices[t * 3 + 1]!;
    const ic = indices[t * 3 + 2]!;
    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const bx = positions[ib * 3]!;
    const by = positions[ib * 3 + 1]!;
    const cx = positions[ic * 3]!;
    const cy = positions[ic * 3 + 1]!;
    let c0 = Math.floor((Math.min(ax, bx, cx) - minX) / cellW);
    let c1 = Math.floor((Math.max(ax, bx, cx) - minX) / cellW);
    let r0 = Math.floor((Math.min(ay, by, cy) - minY) / cellH);
    let r1 = Math.floor((Math.max(ay, by, cy) - minY) / cellH);
    if (c0 < 0) c0 = 0;
    if (r0 < 0) r0 = 0;
    if (c1 >= cols) c1 = cols - 1;
    if (r1 >= rows) r1 = rows - 1;
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (d === 0) continue;
    for (let r = r0; r <= r1; r++) {
      const py = minY + (r + 0.5) * cellH;
      for (let c = c0; c <= c1; c++) {
        const px = minX + (c + 0.5) * cellW;
        // Barycentric sign test (centre inside the triangle).
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) bits[r * cols + c] = 1;
      }
    }
  }
  // Emit each row's contiguous filled runs as world-space rectangles.
  const rects: Array<[number, number, number, number]> = [];
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let runStart = -1;
    const flush = (a: number, b: number): void => {
      rects.push([minX + a * cellW, minY + r * cellH, minX + (b + 1) * cellW, minY + (r + 1) * cellH]);
    };
    for (let c = 0; c < cols; c++) {
      if (bits[base + c]) {
        if (runStart < 0) runStart = c;
      } else if (runStart >= 0) {
        flush(runStart, c - 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) flush(runStart, cols - 1);
  }
  return { minX, maxX, minY, maxY, rects };
}

/**
 * A rectangular tube "sleeve" (multi-piece stage 1): its own 2-panel mesh from
 * the EXISTING generateSeamedPanels, spawned beside the body on the given side.
 * Sewn to the body's explicit armhole by sleeveCrossSeams + combineClothMeshes
 * cross-garment sewing proven on the gathered dress). It hangs from the armhole
 * at this stage; wrapping the arm is a later step.
 */
function sleeveMesh(
  n: number,
  side: 'L' | 'R',
  shoulderX: number,
  shoulderY: number,
  armLen = 0.5,
  tPose = false,
  arm?: { y: number; z: number; rootX: number },
): ClothMeshData {
  const outX = 0.11 * (armLen / 0.5); // A-pose outward angle scales with length (short sleeve ⇒ small drift)
  const SPAWN_TOP = 1.0; // the tube's top-centre y before we reposition it
  // Tube hugs the arm WITHOUT spawning inside its collider: gap 0.18 keeps both
  // panels clear (±0.09 > deltoid radius ~0.06) so the sleeve isn't ejected and
  // tangled; width 0.13 keeps the circumference modest. (0.14/0.14 tangled —
  // panels ±0.07 grazed the arm; 0.26/0.24 was far too loose and flapped.)
  // Debug hash #v96b (bisection chantier 3/3) : le MÊME tube via le générateur
  // FREEFORM (outline débordant ⇒ masque plein, cap+ourlet ouverts) — isole le
  // codepath mesh : si #v96b tient comme #v96, le freeform est innocent.
  const mesh =
    location.hash === '#v96b'
      ? (() => {
          const openTopBottom = (_uu: number, vv: number): boolean => vv < 0.5 / (n - 1) || vv > 1 - 0.5 / (n - 1);
          return generateSeamedPanels({
            resolution: n,
            width: 0.13,
            height: armLen,
            gap: 0.18,
            topY: SPAWN_TOP,
            shape: 'freeform',
            mask: { outline: [[-0.01, -0.01], [1.01, -0.01], [1.01, 1.01], [-0.01, 1.01]], darts: [] },
            extraSeams: [],
            extraOpenings: openTopBottom,
            maskBack: { outline: [[-0.01, -0.01], [1.01, -0.01], [1.01, 1.01], [-0.01, 1.01]], darts: [] },
            extraSeamsBack: [],
            extraOpeningsBack: openTopBottom,
            flattenSeams: false, // un tube s'enroule : pas d'anneaux plats
          });
        })()
      : generateSeamedPanels({ resolution: n, width: 0.13, height: armLen, gap: 0.18, topY: SPAWN_TOP, shape: 'rect' });
  // Rotate the vertical tube to follow the shoulder→wrist axis, then drop its top
  // onto the shoulder so the tube WRAPS the arm (front/back straddle it in z) and
  // the armhole seam attaches it. A small gap keeps it OUTSIDE the arm (spawning
  // inside the collider ejects it).
  const sign = side === 'R' ? 1 : -1;
  // T-POSE (scans re-cuits) : bras horizontal → tube pivoté de 90°, centré sur
  // l'AXE MESURÉ du bras quand il existe (un bras naturel s'arque en z — voir
  // BodyMeasure.arm). Sinon : la légère inclinaison A-pose, axe z=0.
  const theta = tPose ? sign * (Math.PI / 2) : Math.atan2(outX * sign, armLen);
  const axisY = tPose && arm ? arm.y : tPose ? shoulderY - 0.06 : shoulderY;
  const pivX = (tPose && arm ? arm.rootX + 0.06 : shoulderX) * sign;
  const armZ = tPose && arm ? arm.z : 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (let i = 0; i < mesh.count; i++) {
    const px = mesh.positions[i * 4]!;
    const py = mesh.positions[i * 4 + 1]! - SPAWN_TOP; // relative to the top-centre pivot
    mesh.positions[i * 4] = px * cos - py * sin + pivX;
    mesh.positions[i * 4 + 1] = px * sin + py * cos + axisY;
    mesh.positions[i * 4 + 2] = mesh.positions[i * 4 + 2]! + armZ;
  }
  return mesh;
}

/** A short standing band (collar) — its own 2-panel rect band, spawned at the
 * neck; its bottom edge is sewn to the body's neckline. Additive, same path. */
function collarMesh(n: number, neckWidth: number, neckY: number): ClothMeshData {
  const mesh = generateSeamedPanels({ resolution: n, width: neckWidth, height: 0.09, gap: 0.09, topY: neckY + 0.09, shape: 'rect' });
  preWrapCollarTube(mesh);
  return mesh;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const mirror = document.getElementById('mirror') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLElement;
  const resolutionStatus = document.getElementById('resolution-rebuild-status') as HTMLElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  // 2D mirror of the WebGPU canvas — some systems never present WebGPU frames
  // to screen even though the content is rendered; a 2D canvas always shows.
  // (TOILE-18 : le plafond « 30-44 fps » constaté en QA était un artefact
  // d'onglet MASQUÉ — Chrome throttle requestAnimationFrame quand l'onglet
  // n'est pas au premier plan ; l'app tombe alors sur son watchdog 50 ms.
  // Onglet visible = fps au rythme de l'écran. Cette copie n'est donc pas le
  // goulot, et elle reste le filet de sécurité des machines sans présentation
  // WebGPU directe — on la garde.)
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
  // A lost GPU (driver reset, laptop GPU switch, TDR) makes every later
  // command fail. Surface it instead of freezing on a dead device — the app
  // never destroys the device itself, so any loss is unexpected.
  void device.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      showFatal('Carte graphique perdue', `Le contexte WebGPU a été perdu (${info.reason}). Rechargez la page.\n${info.message}`);
    }
  });
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
  // Lucas keeps two explicit contracts: exact commercial PDF sizes, and a
  // mannequin-adjusted grade. Automatic regrading is allowed only while the
  // user has not reshaped or re-sewn the loaded hoodie.
  let hoodieFitMode: 'avatar' | 'standard' = 'avatar';
  let hoodieFitPristine = true;
  let hoodieFitBodyKey = '';
  // Freeform "atelier" pattern (draw-your-own piece). Lazily created; a peer
  // of the archetype patterns, reached only by sceneMode 'atelier'.
  let draft: DraftDoc | null = null;
  // `draft` alone cannot distinguish the lazy rendering fallback from a real
  // user/imported pattern. Keep that distinction available to the onboarding
  // and size controls from their very first synchronisation.
  let draftTouched = false;
  const hoodieBodyKey = (body: BodyMeasure): string =>
    [
      body.height,
      body.neckY,
      body.shoulderY,
      body.chest.circ,
      body.waist.circ,
      body.hip.circ,
      body.waist.y,
    ]
      .map((value) => value.toFixed(4))
      .join('|');
  // Dragging a handle in the 2D layout edits the measurement: update the
  // pattern state, mirror it into the panel sliders, then re-cut and re-sew.
  // ⛓ ÉDITION LIÉE (préférence collante, comme ⋈) : retoucher un sommet
  // posé sur un bord COUSU déplace aussi son vis-à-vis, forme comprise.
  let linkedEditPref = false;
  const patternView = new PatternView(
    document.getElementById('pattern') as HTMLCanvasElement,
    (id, value) => applyHandle(id, value),
    (piece, pieceId, seams, segmentLinks, linkedPieces) => {
      // A piece changed (vertex moved / added / deleted / drawn). Commit it into
      // the current draft — front (0), the côte-à-côte back (1), or a FREE piece
      // (≥ 2) — and re-cut. Editing returns to the flat design view (physics
      // paused) so the change shows without the piece draping away.
      // ⛓ ÉDITION LIÉE : si le geste est le déplacement d'UN sommet (même
      // cadre, même nombre de points) posé sur un bord cousu, le moteur rend
      // le document ENTIER — source + vis-à-vis + coutures réindexées. Refus
      // (contour croisé chez un suivi) = geste abandonné AVANT l'historique.
      let linkedDoc: DraftDoc | null = null;
      let linkedFollowNote: string | null = null;
      if (linkedEditPref && draft && !linkedPieces?.length && !seams && !segmentLinks) {
        const prev =
          pieceId === 0 ? draft.piece : pieceId === 1 ? draft.back : draft.pieces?.[pieceId - 2];
        if (
          prev &&
          prev.outline.length === piece.outline.length &&
          prev.width === piece.width &&
          prev.height === piece.height &&
          Math.abs(prev.topY - piece.topY) < 1e-9
        ) {
          let moved = -1;
          let count = 0;
          for (let i = 0; i < prev.outline.length; i++) {
            const a = prev.outline[i]!;
            const b = piece.outline[i]!;
            if (Math.abs(a[0] - b[0]) > 1e-7 || Math.abs(a[1] - b[1]) > 1e-7) {
              moved = i;
              count++;
            }
          }
          if (count === 1) {
            const res = linkedVertexEdit(draft, pieceId, moved, piece.outline[moved]!);
            if (!res.ok) {
              showToast(res.reason);
              refreshPatternDoc();
              refreshHint();
              return;
            }
            if (res.followed.length) {
              linkedDoc = res.doc;
              linkedFollowNote = res.followed
                .map(
                  (f) =>
                    draftPieceLabel(docPieces(res.doc)[f.pieceId] ?? null, f.pieceId) +
                    (f.inserted ? ' (point d’accord inséré)' : ''),
                )
                .join(' · ');
            }
          }
        }
      }
      pushHistory(); // un cran d'annulation par geste
      if (draft?.preset === 'lucas-hoodie') hoodieFitPristine = false;
      teePreset = false; // a manual edit ⇒ freeform mode; keep the edit (stop re-drafting)
      const gridN = resolution as 32 | 64 | 128;
      if (!draft) draft = { format: 'toile-draft', version: 1, gridN, piece: defaultDraft(gridN).piece };
      draft.gridN = gridN;
      if (linkedDoc) {
        // ⛓ le moteur a tout rendu d'un bloc (source, vis-à-vis, coutures).
        draft = linkedDoc;
        draft.gridN = gridN;
        if (draft.back) {
          const synced = syncPieceFrames(draft.piece, draft.back);
          draft.piece = synced.front;
          draft.back = synced.back;
        }
      } else {
        const updates = [{ pieceId, piece }, ...(linkedPieces ?? [])];
        for (const update of updates) {
          if (update.pieceId >= 2) {
            (draft.pieces ??= [])[update.pieceId - 2] = update.piece;
          } else if (update.pieceId === 1) {
            draft.back = update.piece;
          } else {
            draft.piece = update.piece;
          }
        }
        // Front and back share one physical cutting frame. Synchronise once after
        // every linked update has landed, without stretching either outline.
        if (draft.back && updates.some((update) => update.pieceId === 0 || update.pieceId === 1)) {
          const synced = syncPieceFrames(draft.piece, draft.back);
          draft.piece = synced.front;
          draft.back = synced.back;
        }
      }
      if (pieceId >= 2) {
        // ZONE DE CONFECTION LIBRE : une pièce fraîchement fermée à la plume
        // (armée par « ✎ Pièce ») demande son PLACEMENT — l'utilisateur dit
        // quel endroit du corps elle couvrira (ou la laisse libre). Une seule
        // fois : les retouches suivantes ne redemandent rien.
        if (penPlacement) {
          penPlacement = false;
          placePending = pieceId;
          showChooser(true);
        }
      }
      // Adding/removing an outline point shifts the edge indices; the editor
      // re-indexes the assembly seams so they keep pointing at the same edges.
      if (seams) draft.seams = seams;
      if (segmentLinks) draft.segmentLinks = segmentLinks.length ? segmentLinks : undefined;
      draftTouched = true; // a real edit — this draft is now worth saving
      atelierDesign = true;
      document.getElementById('at-sim')?.classList.remove('running');
      build();
      if (linkedFollowNote) {
        const note = linkedFollowNote;
        void lifecycle.whenIdle().then(() => {
          showPlacementStatus(
            [
              `Édition LIÉE — le vis-à-vis a suivi, forme comprise : ${note}.`,
              'Les coutures recousent aux nouvelles formes · Ctrl+Z annule tout le geste d’un coup.',
            ],
            true,
          );
        });
      }
      const surface = piece.placement?.role === 'pocket' ? piece.placement.surface : null;
      if (surface) {
        pocketPlacementPid = null; // ancrage réussi : la poche n'est plus révocable comme « en attente »
        const support =
          surface.supportPieceId === 0
            ? draft.piece
            : surface.supportPieceId === 1
              ? draft.back
              : draft.pieces?.[surface.supportPieceId - 2];
        showPlacementStatus(
          surface.stitchedEdges.length
            ? [
                `${piece.name ?? 'Poche'} ${surface.side === 'under' ? 'glissée sous' : 'posée sur'} ${support?.name ?? `pièce ${surface.supportPieceId + 1}`} · ${surface.stitchedEdges.length}/${piece.outline.length} segments cousus.`,
                'Cliquez un × orange pour retirer cette couture · 🪡 Coudre puis un bord pointillé pour la remettre.',
              ]
            : [
                `${piece.name ?? 'Poche'} n’a plus aucune couture : remettez-en une avec 🪡 Coudre puis cliquez un bord pointillé.`,
              ],
          surface.stitchedEdges.length > 0,
        );
      }
      syncAtelierControls();
    },
    // Manual assembly: the user sewed edge A ↔ edge B (Shift+click).
    (seam: AssemblySeam) => {
      document.getElementById('at-sew')?.classList.remove('active');
      document.getElementById('at-zipper')?.classList.remove('active');
      refreshHint();
      pushHistory();
      if (draft?.preset === 'lucas-hoodie') hoodieFitPristine = false;
      const gridN = resolution as 32 | 64 | 128;
      if (!draft) draft = { format: 'toile-draft', version: 1, gridN, piece: defaultDraft(gridN).piece, manual: true, seams: [] };
      // Going manual disables the automatic front↔back perimeter sew; without an
      // explicit back to sew to, the garment would fall apart. Materialise one
      // (a copy of the front) so front↔back seams are possible (old files).
      if (!draft.back) draft.back = structuredClone(draft.piece);
      draft.seams = [...(draft.seams ?? []), seam];
      draft.manual = true;
      draftTouched = true;
      atelierDesign = true;
      document.getElementById('at-sim')?.classList.remove('running');
      build();
      const remaining = simulationPlacementIssues(draft).filter(
        (issue) => issue.severity === 'error',
      );
      const assemblyMessage =
        seam.kind === 'zipper'
          ? 'Fermeture éclair enregistrée · les deux rubans sont associés et fermés pour la simulation.'
          : 'Couture enregistrée · pré-placement et orientation automatiques prêts pour ▶ Simuler.';
      showPlacementStatus(
        remaining.length
          ? remaining.map((issue) => issue.message)
          : [assemblyMessage],
        remaining.length === 0,
      );
    },
    // Delete assembly seam #i (clicked its link).
    (index: number) => {
      if (!draft?.seams) return;
      pushHistory();
      if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
      draft.seams = draft.seams.filter((_, k) => k !== index);
      draftTouched = true;
      atelierDesign = true;
      document.getElementById('at-sim')?.classList.remove('running');
      build();
    },
    // Remove a FREE piece (pieceId ≥ 2): drop it from the list and fix up the
    // assembly seams (drop the ones touching it, decrement the pieces above it).
    (pieceId: number) => {
      if (!draft?.pieces) return;
      pushHistory();
      if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
      const { pieces, seams } = removeFreePiece(draft.pieces, draft.seams ?? [], pieceId);
      const linked = removeFreePiece(draft.pieces, draft.segmentLinks ?? [], pieceId);
      draft.pieces = pieces.length ? pieces : undefined;
      draft.seams = seams;
      draft.segmentLinks = linked.seams.length ? linked.seams : undefined;
      draftTouched = true;
      atelierDesign = true;
      document.getElementById('at-sim')?.classList.remove('running');
      build();
    },
    // La plume s'allume/s'éteint : « Terminer » n'apparaît que pendant un
    // tracé (outil contextuel — la barre reste courte le reste du temps).
    (drawing: boolean) => {
      const b = document.getElementById('at-pen');
      if (b) (b as HTMLButtonElement).hidden = !drawing;
      const pieceButton = document.getElementById('at-piece');
      pieceButton?.classList.toggle('active', drawing);
      pieceButton?.setAttribute('aria-pressed', String(drawing));
      // Tracé refermé SANS pièce (abandon) : ne pas redemander un placement
      // plus tard. Le commit d'un tracé réussi est SYNCHRONE (onDraftChange
      // juste après), donc il consomme penPlacement avant ce timeout.
      if (!drawing) setTimeout(() => { penPlacement = false; }, 0);
    },
    // Editing marriage: persist the complete link set, but never compile it as
    // a physical seam. One history step covers marry/remarry/dissociate.
    (links: AssemblySeam[]) => {
      pushHistory();
      if (draft?.preset === 'lucas-hoodie') hoodieFitPristine = false;
      const gridN = resolution as 32 | 64 | 128;
      if (!draft) draft = { format: 'toile-draft', version: 1, gridN, piece: defaultDraft(gridN).piece };
      draft.segmentLinks = links.length ? links : undefined;
      draftTouched = true;
      atelierDesign = true;
      document.getElementById('at-link')?.classList.remove('active');
      document.getElementById('at-sim')?.classList.remove('running');
      build();
    },
  );

  // --- Atelier CAD toolbar (freeform 2D drawing) ---
  const zoomResetButton = document.getElementById('at-zoom-reset') as HTMLButtonElement;
  const syncPatternZoom = (percent = patternView.zoomPercent): void => {
    zoomResetButton.textContent = `${percent}%`;
    zoomResetButton.title =
      percent === 100
        ? 'Toutes les pièces sont affichées'
        : 'Revenir à 100 % et afficher toutes les pièces';
  };
  document
    .getElementById('pattern')
    ?.addEventListener('patternzoom', (event) => {
      const percent = (event as CustomEvent<{ percent: number }>).detail.percent;
      syncPatternZoom(percent);
    });
  document.getElementById('at-zoom-in')?.addEventListener('click', () => {
    patternView.zoomBy(1.5);
  });
  document.getElementById('at-zoom-out')?.addEventListener('click', () => {
    patternView.zoomBy(1 / 1.5);
  });
  zoomResetButton.addEventListener('click', () => {
    patternView.resetView();
    syncPatternZoom();
  });
  syncPatternZoom();

  const atelierBar = document.getElementById('atelier-bar') as HTMLElement;
  const patternBox = document.getElementById('patternBox') as HTMLElement;
  const patternCanvas = document.getElementById('pattern') as HTMLCanvasElement;
  const splitButton = document.getElementById('at-big') as HTMLButtonElement;
  const advancedButton = document.getElementById('at-advanced') as HTMLButtonElement;
  const guidanceEl = document.getElementById('atelier-guidance') as HTMLElement;
  const avatarStatureInput = document.getElementById('at-avatar-stature') as HTMLInputElement;
  const avatarStatureNum = document.getElementById('at-avatar-stature-num') as HTMLInputElement;
  const avatarStatureHelp = document.getElementById('at-avatar-stature-help') as HTMLElement;
  const atelierHelpButton = document.getElementById('at-help') as HTMLButtonElement;
  const atelierHelpPanel = document.getElementById('atelier-cheatsheet') as HTMLElement;
  const atelierHelpClose = document.getElementById('at-help-close') as HTMLButtonElement;
  const atelierEmptyState = document.getElementById('atelier-empty-state') as HTMLElement;
  let atelierHelpReturnFocus: HTMLElement | null = null;
  const setAtelierHelpOpen = (
    open: boolean,
    restoreFocus = true,
  ): void => {
    if (open === !atelierHelpPanel.hidden) return;
    atelierHelpPanel.hidden = !open;
    atelierHelpButton.setAttribute('aria-expanded', String(open));
    if (open) {
      atelierHelpReturnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : atelierHelpButton;
      atelierHelpPanel.focus();
    } else if (restoreFocus) {
      atelierHelpReturnFocus?.focus();
      atelierHelpReturnFocus = null;
    } else {
      atelierHelpReturnFocus = null;
    }
  };
  atelierHelpButton.addEventListener('click', () => {
    setAtelierHelpOpen(atelierHelpPanel.hidden);
  });
  atelierHelpClose.addEventListener('click', () => setAtelierHelpOpen(false));
  document.getElementById('at-empty-tshirt')?.addEventListener('click', () => {
    const modelChoice = document.getElementById('at-tshirt');
    modelChoice?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    modelChoice?.focus({ preventScroll: true });
  });
  document.getElementById('at-empty-piece')?.addEventListener('click', () => {
    document.getElementById('at-piece')?.click();
  });
  document.getElementById('at-empty-femme')?.addEventListener('click', () => {
    if (!bodyKind.includes('femme')) applyBody('scan femme');
  });
  document.getElementById('at-empty-homme')?.addEventListener('click', () => {
    if (!bodyKind.includes('homme')) applyBody('scan homme');
  });
  const firstUseTipsSeen = new Set<string>();
  let firstUseTipStorage: Storage | null = null;
  try {
    firstUseTipStorage = window.localStorage;
  } catch {
    // An opaque/private webview can block even access to the storage object.
  }
  document.addEventListener('click', (event) => {
    if (sceneMode !== 'atelier') return;
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('button[data-first-tip]')
        : null;
    if (!button) return;
    const tip = claimFirstUseTip(
      button,
      firstUseTipsSeen,
      firstUseTipStorage,
    );
    if (!tip) return;
    window.setTimeout(() => showToast(`Astuce · ${tip}`), 0);
  });
  window.addEventListener('keydown', (event) => {
    if (sceneMode !== 'atelier' || event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    setAtelierHelpOpen(atelierHelpPanel.hidden);
  });
  avatarStatureInput.min = String(AVATAR_STATURE_MIN_CM);
  avatarStatureInput.max = String(AVATAR_STATURE_MAX_CM);
  const syncAvatarStature = (cm: number): void => {
    const clamped = Math.min(AVATAR_STATURE_MAX_CM, Math.max(AVATAR_STATURE_MIN_CM, cm));
    const rounded = Math.round(clamped * 2) / 2;
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    avatarStatureInput.value = String(rounded);
    avatarStatureInput.setAttribute('aria-valuetext', `${label} centimètres`);
    if (document.activeElement !== avatarStatureNum) avatarStatureNum.value = label;
  };
  // v182 ① « avatar » — les mensurations dans l'atelier : 5 curseurs cotés cm
  // (le pendant natif de l'onglet « Taille de l'avatar » de Clo). Ils pilotent
  // les MÊMES morphs que le panneau avancé — panel = source unique, l'atelier
  // en est une façade. Le curseur « Taille globale » au-dessus reste la stature.
  const ATELIER_MEASURES: ReadonlyArray<{ field: 'poitrine' | 'taille' | 'hanches' | 'carrure' | 'cuisse'; id: string }> = [
    { field: 'poitrine', id: 'at-m-poitrine' },
    { field: 'taille', id: 'at-m-taille' },
    { field: 'hanches', id: 'at-m-hanches' },
    { field: 'carrure', id: 'at-m-carrure' },
    { field: 'cuisse', id: 'at-m-cuisse' },
  ];
  const measureInput = (id: string): HTMLInputElement =>
    document.getElementById(id) as HTMLInputElement;
  const measureNum = (id: string): HTMLInputElement =>
    document.getElementById(`${id}-num`) as HTMLInputElement;
  const round2 = (cm: number): number => Math.round(cm * 2) / 2;
  const fmtNum = (cm: number): string => {
    const r = round2(cm);
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  // Recopie les valeurs mesurées du corps (via le panel) dans les curseurs ET
  // les champs numériques — sauf celui qu'on est en train d'éditer (focus).
  const syncAtelierMeasures = (): void => {
    const cm = panel.measurementsCm();
    for (const { field, id } of ATELIER_MEASURES) {
      const v = cm[field];
      if (typeof v !== 'number') continue;
      const input = measureInput(id);
      if (input) input.value = String(round2(v));
      const num = measureNum(id);
      if (num && document.activeElement !== num) num.value = fmtNum(v);
    }
  };
  const simBtn = (): HTMLButtonElement =>
    document.getElementById('at-sim') as HTMLButtonElement;
  let bigPanel = false;
  // Atelier "design vs simulate" (CLO-style): in DESIGN the drawn piece hangs
  // FLAT and FROZEN where it was drawn (weightless), so it can be reshaped;
  // pressing Simuler drops it onto the mannequin. Opening the 2D plan / editing
  // returns to design. Only meaningful in the 'atelier' scene.
  let atelierDesign = true;
  // Preparation-only spatial layout. Dragging a whole piece in 3D records a
  // staging offset, never a pattern edit; Simuler rebuilds without those
  // offsets so the sewn topology always starts from its canonical placement.
  let move3DEnabled = true;
  let activeStagingInstance: { pid: number; instance: number } | null = null;
  // ⊹ POINTS D'ARRANGEMENT (concept Clo) : des ancres autour du corps mesuré.
  // Cliquer une pièce en 3D puis une pastille la RANGE là — translation de
  // staging pure, deux clics au lieu d'un drag 3D en profondeur.
  let arrangeMode = false;
  let arrangePick: { pid: number; instance: number } | null = null;
  let arrangeHoverId: string | null = null;
  // ⊹ PRÉ-ASSEMBLAGE ANATOMIQUE (B2) : quand actif, l'essayage NE jette
  // plus l'arrangement de préparation — il fait naître les pièces depuis
  // leurs offsets de staging (posés sur le corps) au lieu du canonique.
  // Défaut OFF ⇒ comportement produit strictement inchangé.
  let respectArrangement = false;
  let atelierSleeves = location.hash.startsWith('#v96'); // multi-piece stage 1: add system sleeves to the atelier garment (debug hash: #v96 = proven rect tubes, #v96b = same via the freeform generator)
  let atelierSleeveLen = 0.5; // sleeve length (shoulder→cuff, m): 0.5 long, ~0.22 short (t-shirt)
  let atelierCollar = false; // multi-piece: add a system collar band at the neckline
  let teePreset = false; // T-shirt preset: build a real set-in-sleeve tee instead of the draft
  // ZONE DE CONFECTION LIBRE : « ✎ Pièce » arme la plume ; à la fermeture du
  // tracé, le choix de placement (#place-chooser) s'ouvre pour CETTE pièce.
  let penPlacement = false; // la prochaine pièce fermée demandera son placement
  let placePending: number | null = null; // pieceId en attente de placement
  // pieceId d'une poche COMMITTÉE dans le patron mais qui attend encore son
  // clic d'ancrage (support + centre). Suivi côté main — pas via patternView,
  // dont la synchro des pièces passe par un build() asynchrone : l'annulation
  // (Échap, changement de scène) doit pouvoir révoquer le commit de façon
  // fiable dès l'instant où la poche est posée.
  let pocketPlacementPid: number | null = null;
  const placeChooser = document.getElementById('place-chooser') as HTMLElement;
  const placementStatus = document.getElementById('placement-status') as HTMLElement;
  const placementStatusMessage = document.getElementById(
    'placement-status-message',
  ) as HTMLElement;
  const simulateWithoutPieceButton = document.getElementById(
    'at-sim-without-piece',
  ) as HTMLButtonElement;
  // Runtime-only fitting filter. The authored draft remains the source of
  // truth for the 2D plan, undo, autosave and garment JSON.
  let simulationExcludedPieceIds = new Set<number>();
  const showChooser = (on: boolean): void => {
    placeChooser.hidden = !on;
    const placementButton = document.getElementById('at-place');
    placementButton?.classList.toggle('active', on);
    placementButton?.setAttribute('aria-pressed', String(on));
    if (bigPanel) requestAnimationFrame(applySplit);
  };
  const showPlacementStatus = (messages: string[], ok = false): void => {
    placementStatus.hidden = messages.length === 0;
    placementStatus.classList.toggle('ok', ok);
    placementStatusMessage.textContent = messages.join(' · ');
    simulateWithoutPieceButton.hidden = true;
    delete simulateWithoutPieceButton.dataset.pieceId;
    if (bigPanel) requestAnimationFrame(applySplit);
  };
  const offerSimulationWithoutPiece = (pieceId: number): void => {
    simulateWithoutPieceButton.dataset.pieceId = String(pieceId);
    simulateWithoutPieceButton.hidden = false;
  };
  const resetPlacement = (): void => {
    penPlacement = false;
    placePending = null;
    pocketPlacementPid = null;
    simulationExcludedPieceIds.clear();
    showChooser(false);
    showPlacementStatus([]);
  };
  // ANNULER (Ctrl/Cmd+Z) : historique par instantanés du patron — un cran par
  // geste (déplacement de point, couture, suppression de pièce, chargement).
  const draftHistory: {
    draft: DraftDoc | null;
    touched: boolean;
    hoodieFitPristine: boolean;
    hoodieFitBodyKey: string;
  }[] = [];
  const undoButton = document.getElementById('at-undo') as HTMLButtonElement;
  const syncUndoButton = (): void => {
    undoButton.disabled = draftHistory.length === 0;
  };
  const pushHistory = (): void => {
    draftHistory.push({
      draft: draft ? structuredClone(draft) : null,
      touched: draftTouched,
      hoodieFitPristine,
      hoodieFitBodyKey,
    });
    if (draftHistory.length > 40) draftHistory.shift();
    syncUndoButton();
  };
  const replaceDraftPiece = (pid: number, piece: DraftPiece): void => {
    if (!draft) return;
    if (pid === 0) draft.piece = piece;
    else if (pid === 1) draft.back = piece;
    else if (draft.pieces?.[pid - 2]) draft.pieces[pid - 2] = piece;
  };
  const applyHistorySnapshot = (h: (typeof draftHistory)[number]): void => {
    draft = h.draft;
    draftTouched = h.touched;
    hoodieFitPristine = h.hoodieFitPristine;
    hoodieFitBodyKey = h.hoodieFitBodyKey;
    syncPatternContextFromDraft(draft, {
      pristine: hoodieFitPristine,
      bodyKey: hoodieFitBodyKey,
    });
    teePreset = false;
    atelierDesign = true;
    resetPlacement(); // un placement en attente ne survit pas à l'annulation
    document.getElementById('at-sim')?.classList.remove('running');
    syncUndoButton();
  };
  const undoDraft = (): void => {
    const h = draftHistory.pop();
    if (!h) return;
    applyHistorySnapshot(h);
    build();
    showToast(undoToastMessage());
  };
  // Une poche/applique est COMMITTÉE dans le patron dès le choix « Poche /
  // applique » (avant tout clic de support), puis attend son point d'ancrage.
  // L'abandonner (Échap, changement de scène) doit donc annuler ce commit —
  // sinon une colonne « poche » orpheline, sans surface, reste dans le patron.
  // placePiece('pocket') a empilé un cran juste avant le commit : le dépiler
  // restaure l'état d'avant la poche. `rebuild:false` pour le teardown, qui ne
  // doit pas ré-entrer dans le cycle de scènes.
  const revertPendingPocket = (opts: { rebuild: boolean }): boolean => {
    if (pocketPlacementPid === null) return false;
    pocketPlacementPid = null;
    patternView.cancelInteractions(); // désarme le fantôme cyan de placement
    const h = draftHistory.pop();
    if (!h) {
      resetPlacement();
      return false;
    }
    applyHistorySnapshot(h);
    if (opts.rebuild) build();
    return true;
  };
  undoButton.addEventListener('click', undoDraft);
  syncUndoButton();
  window.addEventListener('keydown', (e) => {
    if (sceneMode !== 'atelier') return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoDraft();
    }
  });

  const setPressed = (id: string, on: boolean): void => {
    const element = document.getElementById(id);
    element?.classList.toggle('active', on);
    element?.setAttribute('aria-pressed', String(on));
  };
  const syncAtelierControls = (): void => {
    setPressed('at-piece', patternView.drawing);
    setPressed('at-mirror-draw', patternView.penMirroring);
    setPressed('at-length', patternView.lengthEditing);
    setPressed('at-snap', patternView.lengthSnapping);
    setPressed('at-link', patternView.linkingSegments);
    setPressed('at-sew', patternView.sewing || !!patternView.seamPick);
    setPressed(
      'at-zipper',
      patternView.zippering || !!patternView.zipperPick,
    );
    setPressed('at-sew-free', patternView.freeSewing);
    setPressed('at-cut', patternView.cutting);
    setPressed('at-internal', patternView.internalDrawing);
    setPressed('at-dart', patternView.fisheyeDrawing);
    setPressed('at-curvepoint', patternView.curvePointing);
    setPressed('at-notch', patternView.notching);
    setPressed('at-merge', patternView.merging);
    setPressed('at-hole', patternView.holing);
    setPressed('at-linkedit', linkedEditPref);
    setPressed('at-precision', patternView.precisioning);
    setPressed('at-fullness', patternView.fullnessing);
    setPressed('at-mirror', patternView.mirroring);
    setPressed('at-gather', patternView.gathering);
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    setPressed('at-draw3d', draw3dMode);
    setPressed('at-edit3d', edit3dMode);
    setPressed('at-sketch3d', sketch3dMode);
    setPressed('at-sleeves', atelierSleeves);
    setPressed(
      'at-place',
      !placeChooser.hidden ||
        placePending !== null ||
        patternView.placingSurfacePiece,
    );
  };
  const deactivateEditingTools = (): void => {
    if (patternView.lengthEditing) patternView.toggleLength();
    if (patternView.linkingSegments) patternView.toggleSegmentLink();
    if (patternView.sewing || patternView.seamPick) patternView.toggleSew();
    if (patternView.zippering || patternView.zipperPick) {
      patternView.toggleZipper();
    }
    if (patternView.freeSewing) patternView.toggleFreeSew();
    if (patternView.cutting) patternView.toggleCut();
    if (patternView.internalDrawing) patternView.toggleInternalLine();
    if (patternView.fisheyeDrawing) patternView.toggleFisheyeDart();
    if (patternView.curvePointing) patternView.toggleCurvePoint();
    if (patternView.notching) patternView.toggleNotch();
    if (patternView.merging) patternView.toggleMerge();
    if (patternView.holing) patternView.toggleHole();
    if (patternView.precisioning) patternView.togglePrecision();
    if (patternView.fullnessing) patternView.toggleFullness();
    if (patternView.mirroring) patternView.toggleMirror();
    if (patternView.gathering) patternView.toggleGather();
    syncAtelierControls();
  };
  const syncAtelierPhase = (): void => {
    if (!atelierDesign) {
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
    }
    const mode = atelierDesign ? 'design' : 'simulation';
    atelierBar.dataset.mode = mode;
    patternBox.dataset.mode = mode;
    document.body.classList.toggle('atelier-simulating', !atelierDesign);
    patternView.setInteractionEnabled(atelierDesign);
    simBtn().classList.toggle('running', !atelierDesign);
    simBtn().setAttribute('aria-pressed', String(!atelierDesign));
    // Préparation à plat (design) : pièces PLEINES seulement (sans les rubans de
    // liaison entre pièces) + liserés ; à l'essayage, surface complète.
    renderer?.setPreparationMode(sceneMode === 'atelier' && atelierDesign);
    syncAtelierControls();
  };

  const atelierRailWidth = (): number => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--atelier-rail-w')
      .trim();
    return Number.parseFloat(raw) || 232;
  };
  // In the split workspace `splitPx` is the 2D pane width AFTER the fixed tool
  // rail. Measuring the actual pane keeps the canvas stable when messages or
  // the placement chooser appear as overlays.
  let splitPx = Math.round((window.innerWidth - atelierRailWidth()) * 0.44);
  const applySplit = (): void => {
    const rail = sceneMode === 'atelier' ? atelierRailWidth() : 0;
    const available = Math.max(640, window.innerWidth - rail);
    splitPx = Math.min(
      Math.max(splitPx, 320),
      Math.max(340, available - 340),
    );
    document.documentElement.style.setProperty('--plan2d', `${splitPx}px`);
    if (!bigPanel) {
      patternView.resize(
        sceneMode === 'atelier' ? Math.min(410, splitPx) : 250,
        sceneMode === 'atelier' ? 235 : 290,
      );
      return;
    }
    const paneRect = patternBox.getBoundingClientRect();
    const canvasTop = patternCanvas.getBoundingClientRect().top;
    const w = Math.max(300, Math.floor(paneRect.width));
    const h = Math.max(260, Math.floor(paneRect.bottom - canvasTop));
    patternView.resize(w, h);
  };
  const setBig = (on: boolean): void => {
    bigPanel = on;
    patternBox.classList.toggle('big', on);
    document.body.classList.toggle('plan-split', on);
    splitButton.classList.toggle('active', on);
    splitButton.setAttribute('aria-expanded', String(on));
    applySplit();
  };
  // v178 ③ « pas dépaysé » — disposition Clo : la 3D à gauche, le plan à
  // droite. Un clic, mémorisé ; les largeurs ne bougent pas, les côtés
  // s'échangent (CSS body.layout-3d-left). Chargée AVANT le séparateur, dont
  // la géométrie dépend du côté du plan.
  const LAYOUT_CLO_KEY = 'toile.layout3dLeft';
  let layout3dLeft = false;
  try {
    layout3dLeft = window.localStorage.getItem(LAYOUT_CLO_KEY) === '1';
  } catch {
    /* stockage indisponible : la préférence vaudra pour la session */
  }
  // Séparateur : glisser = ajuster le partage en direct (2D et 3D suivent).
  {
    const divider = document.getElementById('split-divider') as HTMLElement;
    let dragging = false;
    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.classList.add('dragging');
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Plan à droite (disposition Clo) : sa largeur se mesure depuis le bord
      // droit de la fenêtre, le séparateur vivant à son flanc gauche.
      splitPx = layout3dLeft
        ? window.innerWidth - e.clientX
        : e.clientX - atelierRailWidth();
      applySplit();
    });
    const end = (): void => {
      dragging = false;
      divider.classList.remove('dragging');
    };
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => {
      if (bigPanel) applySplit();
    });
  }
  const layoutCloButton = document.getElementById('at-layout-clo') as HTMLButtonElement;
  const applyLayoutClo = (resize: boolean): void => {
    document.body.classList.toggle('layout-3d-left', layout3dLeft);
    layoutCloButton.classList.toggle('active', layout3dLeft);
    layoutCloButton.setAttribute('aria-pressed', String(layout3dLeft));
    // Au boot, applySplit est encore hors de portée (sceneMode plus bas) — et
    // inutile : la séquence normale le fait. Au clic, on recadre en direct.
    if (resize) applySplit();
  };
  layoutCloButton.addEventListener('click', () => {
    layout3dLeft = !layout3dLeft;
    try {
      window.localStorage.setItem(LAYOUT_CLO_KEY, layout3dLeft ? '1' : '0');
    } catch {
      /* stockage indisponible : la préférence vaut pour la session */
    }
    applyLayoutClo(true);
    showToast(
      layout3dLeft
        ? 'Disposition Clo — la 3D à gauche, le plan 2D à droite. Mémorisé.'
        : 'Disposition TOILE — le plan 2D à gauche. Mémorisé.',
    );
  });
  applyLayoutClo(false);
  // v179 ④ « pas dépaysé » — thème du plan : NUIT (défaut) ou PAPIER, la
  // table de coupe au jour. Persisté ; seule la surface du plan change — la
  // 3D et les pastilles gardent leur encre.
  const PLAN_THEME_KEY = 'toile.planTheme';
  const themeButton = document.getElementById('at-plan-theme') as HTMLButtonElement;
  let planTheme: PatternTheme = 'nuit';
  try {
    if (window.localStorage.getItem(PLAN_THEME_KEY) === 'papier') planTheme = 'papier';
  } catch {
    /* stockage indisponible : nuit par défaut */
  }
  const applyPlanTheme = (repaint: boolean): void => {
    setPatternTheme(planTheme);
    themeButton.classList.toggle('active', planTheme === 'papier');
    themeButton.setAttribute('aria-pressed', String(planTheme === 'papier'));
    if (repaint) patternView.refreshTheme();
  };
  themeButton.addEventListener('click', () => {
    planTheme = planTheme === 'papier' ? 'nuit' : 'papier';
    try {
      window.localStorage.setItem(PLAN_THEME_KEY, planTheme);
    } catch {
      /* stockage indisponible : la préférence vaut pour la session */
    }
    applyPlanTheme(true);
    showToast(
      planTheme === 'papier'
        ? 'Plan PAPIER — la table de coupe passe au jour. Mémorisé.'
        : 'Plan NUIT — le plan retrouve son encre claire. Mémorisé.',
    );
  });
  applyPlanTheme(planTheme === 'papier');
  // v181 ⑥ « pas dépaysé » — 🪡 les coutures sur le vêtement 3D : liserés aux
  // couleurs du plan posés sur les particules (drapé compris), fils tendus
  // entre pièces écartées. Interrupteur indépendant de l'outil, mémorisé.
  const SEAMS3D_KEY = 'toile.seams3d';
  let seams3dOn = true;
  try {
    if (window.localStorage.getItem(SEAMS3D_KEY) === '0') seams3dOn = false;
  } catch {
    /* stockage indisponible : visible par défaut */
  }
  const seamOverlayVerts = (doc: DraftDoc, n: number): Uint32Array | null => {
    const groups = compileAssemblyGroups(doc, n);
    if (!groups.length) return null;
    const packed = (hex: string, alpha: number): number => {
      const v = parseInt(hex.slice(1), 16);
      return (
        ((alpha & 255) << 24) |
        ((v & 255) << 16) |
        (((v >> 8) & 255) << 8) |
        ((v >> 16) & 255)
      );
    };
    const verts: number[] = [];
    const panelSize = n * n;
    // pairRunCells ne garantit PAS l'ordre le long du bord — relier les
    // cellules par ADJACENCE DE GRILLE rend l'ordre indifférent : chaque
    // cellule se lie à sa voisine (+1 en u, +n en v) si elle est du même run.
    const strip = (cells: readonly number[], color: number): void => {
      const set = new Set(cells);
      for (const c of cells) {
        const base = Math.floor(c / panelSize) * panelSize;
        const local = c - base;
        const u = local % n;
        const v = Math.floor(local / n);
        if (u < n - 1 && set.has(c + 1)) verts.push(c, color, c + 1, color);
        if (v < n - 1 && set.has(c + n)) verts.push(c, color, c + n, color);
      }
    };
    for (const g of groups) {
      const hex = SEAM_COLORS[g.seamIndex % SEAM_COLORS.length]!;
      const color = packed(hex, 235);
      const rung = packed(hex, 140);
      const pairs = g.pairs;
      strip(pairs.map((q) => q.i), color);
      strip(pairs.map((q) => q.j), color);
      // Les FILS : une paire cousue écartée se tend, une paire soudée est un
      // segment de longueur nulle — l'affichage se règle tout seul.
      const step = Math.max(1, Math.floor(pairs.length / 9));
      for (let k = 0; k < pairs.length; k += step) {
        verts.push(pairs[k]!.i, rung, pairs[k]!.j, rung);
      }
      const last = pairs[pairs.length - 1]!;
      verts.push(last.i, rung, last.j, rung);
    }
    return new Uint32Array(verts);
  };
  const seams3dButton = document.getElementById('at-seams3d') as HTMLButtonElement;
  const applySeams3d = (): void => {
    seams3dButton.classList.toggle('active', seams3dOn);
    seams3dButton.setAttribute('aria-pressed', String(seams3dOn));
  };
  seams3dButton.addEventListener('click', () => {
    seams3dOn = !seams3dOn;
    try {
      window.localStorage.setItem(SEAMS3D_KEY, seams3dOn ? '1' : '0');
    } catch {
      /* stockage indisponible : la préférence vaut pour la session */
    }
    applySeams3d();
    renderer.setSeamsVisible(seams3dOn);
    showToast(
      seams3dOn
        ? '🪡 Coutures VISIBLES sur le vêtement 3D — drapé compris, fils tendus entre pièces écartées.'
        : '🪡 Coutures masquées en 3D — le plan garde ses liserés.',
    );
  });
  applySeams3d();
  // Back to the drawing board: re-freeze flat (a rebuild re-spawns the piece at
  // its flat rest pose) so it can be edited without physics moving it.
  const enterDesign = (): void => {
    const restored = [...simulationExcludedPieceIds].map((pieceId) => {
      const piece =
        pieceId === 0
          ? draft?.piece
          : pieceId === 1
            ? draft?.back
            : draft?.pieces?.[pieceId - 2];
      return draftPieceLabel(piece, pieceId);
    });
    simulationExcludedPieceIds.clear();
    atelierDesign = true;
    syncAtelierPhase();
    build();
    if (restored.length) {
      showPlacementStatus([
        `${restored.join(' + ')} de nouveau active${restored.length > 1 ? 's' : ''} dans le patron.`,
        'Terminez son placement ou sa couture avant de relancer l’essayage.',
      ]);
    }
    if (placePending !== null) showChooser(true);
  };
  // "The assembly is done" — let the solver drape the piece onto the body.
  const simulate = (excludedPieceId: number | null = null): void => {
    const simulationDraft =
      draft && excludedPieceId !== null
        ? draftForSimulationExcluding(draft, [excludedPieceId])
        : draft;
    const issues = simulationDraft
      ? simulationPlacementIssues(simulationDraft)
      : [];
    const blocking = issues.filter((issue) => issue.severity === 'error');
    const pendingBlocks =
      placePending !== null && placePending !== excludedPieceId;
    if (pendingBlocks || blocking.length) {
      const first = blocking[0];
      const pendingPieceId =
        pendingBlocks &&
        draft &&
        placePending !== null &&
        canTemporarilyExcludePiece(draft, placePending)
          ? placePending
          : null;
      const issuePieceId =
        blocking.length === 1 &&
        first &&
        (first.code === 'missing-support' || first.code === 'missing-seam') &&
        draft &&
        canTemporarilyExcludePiece(draft, first.pieceId)
          ? first.pieceId
          : null;
      const skippablePieceId = pendingPieceId ?? issuePieceId;
      simulationExcludedPieceIds.clear();
      atelierDesign = true;
      syncAtelierPhase();
      if (!bigPanel) setBig(true);
      if (first) {
        patternView.selectPiece(first.pieceId);
        if (first.code === 'unassigned') {
          placePending = first.pieceId;
          showChooser(true);
        }
      }
      // The chooser otherwise covers the status card. Once the user explicitly
      // asks to simulate, keep the one-click escape hatch visible in that same
      // feedback message; ◎ Placer reopens the chooser whenever desired.
      if (pendingPieceId !== null) showChooser(false);
      showPlacementStatus([
        'Simulation en attente',
        ...(pendingBlocks && placePending !== null
          ? [
              `${draftPieceLabel(
                draft?.pieces?.[placePending - 2],
                placePending,
              )} n’a pas encore de destination`,
            ]
          : []),
        ...blocking.map((issue) => issue.message),
        blocking.some((issue) => issue.code === 'missing-support')
          ? 'Sélectionnez Poche / applique, puis cliquez sa position exacte sur la pièce support'
          : blocking.some((issue) => issue.code === 'missing-seam')
          ? 'Utilisez 🪡 Coudre : bord de la nouvelle pièce, puis bord correspondant du vêtement'
          : blocking.some((issue) => issue.code === 'unanchored-component')
          ? 'Reliez un bord de cet ensemble au devant, au dos, à une manche ou au col'
          : 'Choisissez d’abord la destination de la pièce',
      ]);
      if (skippablePieceId !== null) {
        offerSimulationWithoutPiece(skippablePieceId);
      }
      return;
    }
    simulationExcludedPieceIds =
      excludedPieceId === null
        ? new Set<number>()
        : new Set([excludedPieceId]);
    const warnings = issues.filter((issue) => issue.severity === 'warning');
    const staged =
      !!draft &&
      [draft.piece, ...(draft.back ? [draft.back] : []), ...(draft.pieces ?? [])].some(
        hasStagingOffset,
      );
    const excludedName =
      excludedPieceId === null
        ? null
        : draftPieceLabel(
            draft?.pieces?.[excludedPieceId - 2],
            excludedPieceId,
          );
    const exclusionMessage = excludedName
      ? `${excludedName} non simulée · elle reste en attente dans le plan 2D et sera réintégrée après son placement.`
      : null;
    showPlacementStatus(
      [
        ...warnings.map((issue) => `Attention : ${issue.message}`),
        ...(staged
          ? ['Recalage automatique : les déplacements 3D de préparation sont ignorés pour garantir l’assemblage.']
          : []),
        ...(exclusionMessage ? [exclusionMessage] : []),
      ],
      warnings.length === 0 && exclusionMessage === null,
    );
    deactivateEditingTools();
    atelierDesign = false;
    if (!bigPanel) setBig(true);
    syncAtelierPhase();
    build(); // canonical spawn: staging offsets are design-only
    if (simulationDraft && (simulationDraft.seams?.length ?? 0) > 0) {
      showPlacementStatus(
        [
          ...warnings.map((issue) => `Attention : ${issue.message}`),
          `Placement automatique terminé : la pose 3D a été reconstruite depuis ${simulationDraft.seams!.length} couture${simulationDraft.seams!.length > 1 ? 's' : ''}, indépendamment du plan de coupe.`,
          ...(exclusionMessage ? [exclusionMessage] : []),
        ],
        warnings.length === 0 && exclusionMessage === null,
      );
    }
    wake();
  };
  simulateWithoutPieceButton.addEventListener('click', () => {
    const pieceId = Number(simulateWithoutPieceButton.dataset.pieceId);
    if (!Number.isInteger(pieceId) || pieceId < 2) return;
    showChooser(false);
    patternView.selectPiece(pieceId);
    simulate(pieceId);
  });
  const updateAtelierBar = (): void => {
    const active = sceneMode === 'atelier';
    const wasActive = document.body.classList.contains('atelier-active');
    atelierBar.classList.toggle('on', active);
    document.body.classList.toggle('atelier-active', active);
    if (active) {
      syncAtelierPhase();
      requestAnimationFrame(applySplit);
      if (!wasActive) {
        requestAnimationFrame(() => {
          const entryTarget = atelierEmptyState.hidden
            ? document.getElementById('at-tshirt')
            : document.getElementById('at-empty-tshirt');
          entryTarget?.focus({ preventScroll: true });
        });
      }
    } else {
      setAtelierHelpOpen(false, false);
      patternView.setInteractionEnabled(true);
      document.body.classList.remove(
        'atelier-simulating',
        'atelier-advanced-open',
      );
      patternView.resetView();
      if (bigPanel) setBig(false);
      if (patternView.lengthEditing) patternView.toggleLength();
      if (patternView.linkingSegments) patternView.toggleSegmentLink();
      if (patternView.sewing || patternView.seamPick) patternView.toggleSew();
      if (patternView.zippering || patternView.zipperPick) {
        patternView.toggleZipper();
      }
      syncAtelierControls();
      if (wasActive) canvas.focus({ preventScroll: true });
    }
  };
  (document.getElementById('at-big') as HTMLElement).addEventListener('click', () => {
    const on = !bigPanel;
    setBig(on);
    if (on && atelierDesign) enterDesign();
  });
  advancedButton.addEventListener('click', () => {
    const on = !document.body.classList.contains('atelier-advanced-open');
    document.body.classList.toggle('atelier-advanced-open', on);
    advancedButton.classList.toggle('active', on);
    advancedButton.setAttribute('aria-pressed', String(on));
  });
  // ✎ PIÈCE — la zone de confection LIBRE : la plume s'ouvre dans une NOUVELLE
  // colonne, avec la silhouette de l'avatar en fond (le gabarit grandeur
  // nature). L'utilisateur trace sa pièce dessus, aux bonnes dimensions ; à la
  // fermeture, le choix de placement s'ouvre : quel endroit du corps la pièce
  // couvrira (devant, dos, bras, cou) — ou libre, posée là où elle est dessinée.
  (document.getElementById('at-piece') as HTMLElement).addEventListener('click', () => {
    if (!bigPanel) setBig(true);
    if (patternView.lengthEditing) patternView.toggleLength();
    if (patternView.linkingSegments) patternView.toggleSegmentLink();
    if (patternView.sewing || patternView.seamPick) patternView.toggleSew();
    if (patternView.zippering || patternView.zipperPick) {
      patternView.toggleZipper();
    }
    document.getElementById('at-length')?.classList.remove('active');
    document.getElementById('at-snap')?.classList.remove('active');
    document.getElementById('at-link')?.classList.remove('active');
    document.getElementById('at-sew')?.classList.remove('active');
    document.getElementById('at-zipper')?.classList.remove('active');
    atelierDesign = true;
    teePreset = false; // back to freeform editing
    simBtn().classList.remove('running');
    resetPlacement();
    penPlacement = true;
    // PAGE BLANCHE : tracer ne doit révéler AUCUNE robe socle — le doc devient
    // le SOCLE VIDE (faces sentinelles sans cellules) et la pièce dessinée
    // sera le premier vrai contenu du patron.
    if (!atelierEmptyState.hidden) {
      draft = blankBaseDraft(resolution as 32 | 64 | 128);
      // Le plan reflète le socle vide immédiatement (sans build : le tissu 3D
      // reste caché tant que le doc n'a aucun contenu réel — voir refreshHint).
      patternView.setDraft(draft.piece, draft.back ?? null, []);
      patternView.setAssembly([]);
      patternView.setSegmentLinks([]);
    }
    // Boîte de tracé = la boîte du corps (grandeur nature, posée sur la
    // silhouette) : la position du dessin SUR la silhouette est sa position
    // sur le corps. Les placements bras/cou re-boîtent ensuite sur l'emprise.
    const dims = (draft ?? defaultDraft(resolution as 32 | 64 | 128)).piece;
    const pid = 2 + (draft?.pieces?.length ?? 0);
    patternView.startPen(dims.width, dims.height, dims.topY, dims.gap, pid);
    syncAtelierControls();
    refreshHint();
  });
  (document.getElementById('at-place') as HTMLElement).addEventListener('click', () => {
    const pid = patternView.activeDraftPieceId;
    if (!draft || pid < 2 || !draft.pieces?.[pid - 2]) {
      showPlacementStatus(['Sélectionnez d’abord une pièce dessinée (pièce 3 ou suivante) dans le plan 2D.']);
      return;
    }
    placePending = pid;
    showChooser(true);
    showPlacementStatus([
      `${draftPieceLabel(draft.pieces[pid - 2], pid)} : choisissez sa destination corporelle.`,
    ]);
  });
  (document.getElementById('at-reverse') as HTMLElement).addEventListener('click', () => {
    const pid = patternView.activeDraftPieceId;
    const piece = draft && pid >= 2 ? draft.pieces?.[pid - 2] : null;
    if (!draft || !piece) {
      showPlacementStatus(['Sélectionnez d’abord une pièce dessinée reliée par une couture.']);
      return;
    }
    if (piece.wrap) {
      showPlacementStatus([`${placementRoleLabel(piece.wrap)} utilise déjà une orientation corporelle dédiée.`], true);
      return;
    }
    const sewn = (draft.seams ?? []).some((seam) => pieceIdOf(seam.a) === pid || pieceIdOf(seam.b) === pid);
    if (!sewn) {
      showPlacementStatus(['Ajoutez d’abord une couture avec 🪡 Coudre, puis inversez son sens si la prévisualisation est torsadée.']);
      return;
    }
    if (!piece.placement) {
      showPlacementStatus(['Choisissez d’abord la destination avec ◎ Placer.']);
      return;
    }
    pushHistory();
    piece.placement.reverseSeam = !piece.placement.reverseSeam;
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    showPlacementStatus([
      `Sens de couture ${piece.placement.reverseSeam ? 'inversé' : 'normal'} · contrôlez la prévisualisation 3D avant ▶ Simuler.`,
    ], true);
  });
  const move3DBtn = document.getElementById('at-move3d') as HTMLElement;
  setPressed('at-move3d', move3DEnabled);
  move3DBtn.addEventListener('click', () => {
    if (!atelierDesign) {
      move3DEnabled = true;
      enterDesign();
    } else {
      move3DEnabled = !move3DEnabled;
    }
    pieceHoverDirty = true;
    if (move3DEnabled) {
      draw3dMode = false;
      clearDraw3d();
      setPressed('at-draw3d', false);
      edit3dMode = false;
      clearEdit3d();
      setPressed('at-edit3d', false);
      sketch3dMode = false;
      clearSketch3d();
      setPressed('at-sketch3d', false);
    }
    if (!move3DEnabled) {
      setPieceHover(null);
      gizmoPick = null; // ✥ rangé → trièdre rangé
    }
    if (move3DEnabled) {
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
    }
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    showPlacementStatus(
      move3DEnabled
        ? [
            'Déplacement 3D actif : glissez une pièce, ou cliquez-la — un trièdre X·Y·Z apparaît, tirez une flèche pour un déplacement précis sur cet axe (cm en direct).',
            'Le patron 2D, les tailles communes et les coutures restent inchangés.',
            '▶ Simuler la recalera automatiquement avant de libérer la physique.',
          ]
        : ['Déplacement 3D désactivé : glissez dans la vue pour tourner la caméra.'],
      true,
    );
    refreshHint();
  });
  // ⊹ POINTS D'ARRANGEMENT : pastilles autour du corps (mensurations réelles).
  // Deux clics : la pièce, puis l'ancre — elle s'y range (staging pur, undo ✓).
  const currentArrangePoints = (): ArrangementPoint[] => arrangementPoints(lastMeasure);
  /** NDC du point monde avec la matrice caméra courante (même math que
   * l'overlay atelier) ; null derrière la caméra. */
  const arrangeNdcOf = (pos: readonly [number, number, number]): [number, number] | null => {
    const m = camera.matrix(canvas.width / Math.max(1, canvas.height));
    const cw = m[3]! * pos[0] + m[7]! * pos[1] + m[11]! * pos[2] + m[15]!;
    if (cw <= 1e-6) return null;
    const cx = (m[0]! * pos[0] + m[4]! * pos[1] + m[8]! * pos[2] + m[12]!) / cw;
    const cy = (m[1]! * pos[0] + m[5]! * pos[1] + m[9]! * pos[2] + m[13]!) / cw;
    return [cx, cy];
  };
  /** L'ancre sous (ndcX, ndcY), tolérance en pixels écran. */
  const arrangePointNear = (ndcX: number, ndcY: number, tolPx = 22): ArrangementPoint | null => {
    let best: ArrangementPoint | null = null;
    let bestPx = tolPx;
    for (const point of currentArrangePoints()) {
      const ndc = arrangeNdcOf(point.pos);
      if (!ndc) continue;
      const dxPx = ((ndc[0] - ndcX) * canvas.clientWidth) / 2;
      const dyPx = ((ndc[1] - ndcY) * canvas.clientHeight) / 2;
      const d = Math.hypot(dxPx, dyPx);
      if (d < bestPx) {
        bestPx = d;
        best = point;
      }
    }
    return best;
  };
  /** Centre (monde) de l'exemplaire d'une pièce, depuis le cache de positions. */
  const stagingInstanceCentroid = (
    pid: number,
    instance: number,
  ): [number, number, number] | null => {
    if (!posCache) return null;
    const ranges = (pieceParticleRanges.get(pid) ?? []).filter(
      (range) => range.instance === instance,
    );
    let n = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const range of ranges) {
      for (let i = range.first; i < range.first + range.count; i++) {
        if (!system.isMovable(i)) continue;
        cx += posCache[i * 4]!;
        cy += posCache[i * 4 + 1]!;
        cz += posCache[i * 4 + 2]!;
        n++;
      }
    }
    if (!n) return null;
    return [cx / n, cy / n, cz / n];
  };
  const applyArrangement = (
    pick: { pid: number; instance: number },
    point: ArrangementPoint,
  ): void => {
    if (!draft) return;
    const centroid = stagingInstanceCentroid(pick.pid, pick.instance);
    if (!centroid) {
      showToast('Pièce introuvable dans la préparation — re-cliquez-la.');
      arrangePick = null;
      return;
    }
    const delta: [number, number, number] = [
      point.pos[0] - centroid[0],
      point.pos[1] - centroid[1],
      point.pos[2] - centroid[2],
    ];
    pushHistory();
    let piece = draftPieceOf(pick.pid);
    if (!piece) {
      draftHistory.pop();
      syncUndoButton();
      return;
    }
    // Même contrat que le drag 3D : matérialiser un dos indépendant avant de
    // lui donner sa propre translation de préparation.
    if (pick.pid === 1 && !draft.back) piece = structuredClone(draft.piece);
    replaceDraftPiece(pick.pid, movePieceInstanceInStaging(piece, pick.instance, delta));
    draftTouched = true;
    atelierDesign = true;
    build();
    const label = draftPieceLabel(draftPieceOf(pick.pid), pick.pid);
    showToast(`« ${label} » rangée : ${point.labelFr}.`);
  };

  // ⊹ PRÉ-ASSEMBLAGE ANATOMIQUE (auto) — range TOUTES les pièces sur le corps
  // en UNE passe : torse devant/dos par construction (pid 0/1), les autres
  // pièces via leur rôle (manches/col résolus depuis leur `wrap`). Même
  // translation de staging que l'arrange manuel, mais groupée (un seul build).
  // N'a d'effet sur l'essayage que si `respectArrangement` est actif.
  const ROLE_TO_PASTILLE: Record<string, string> = {
    front: 'torso-front',
    back: 'torso-back',
    armL: 'arm-left',
    armR: 'arm-right',
    neck: 'neck-front',
    waist: 'waist-front',
    legL: 'leg-left',
    legR: 'leg-right',
    pocket: 'hip-front',
  };
  const autoArrangeByRole = (): number => {
    if (!draft) return 0;
    const byId = new Map(currentArrangePoints().map((point) => [point.id, point] as const));
    const pastilleForPiece = (pid: number): ArrangementPoint | null => {
      if (pid === 0) return byId.get('torso-front') ?? null;
      if (pid === 1) return byId.get('torso-back') ?? null;
      const piece = draftPieceOf(pid);
      if (!piece) return null;
      const role = placementRoleOf(piece);
      if (!role) return null;
      const target = ROLE_TO_PASTILLE[role];
      return target ? byId.get(target) ?? null : null;
    };
    const seen = new Set<string>();
    let moved = 0;
    let pushed = false;
    for (const [pid, ranges] of pieceParticleRanges) {
      const point = pastilleForPiece(pid);
      if (!point) continue;
      for (const range of ranges) {
        const key = `${pid}:${range.instance}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const centroid = stagingInstanceCentroid(pid, range.instance);
        if (!centroid) continue;
        const delta: [number, number, number] = [
          point.pos[0] - centroid[0],
          point.pos[1] - centroid[1],
          point.pos[2] - centroid[2],
        ];
        let piece = draftPieceOf(pid);
        if (!piece) continue;
        if (pid === 1 && !draft.back) piece = structuredClone(draft.piece);
        if (!pushed) {
          pushHistory();
          pushed = true;
        }
        replaceDraftPiece(pid, movePieceInstanceInStaging(piece, range.instance, delta));
        moved++;
      }
    }
    if (moved) {
      draftTouched = true;
      atelierDesign = true;
      build();
    }
    return moved;
  };
  // Hook dev (validation avant UI) : __toileAnatomical(true) active le respect
  // de l'arrangement par l'essayage + auto-range par rôle ; (false) le coupe.
  (window as unknown as { __toileAnatomical?: (on?: boolean) => unknown }).__toileAnatomical = (
    on: boolean = true,
  ) => {
    respectArrangement = !!on;
    const moved = on ? autoArrangeByRole() : 0;
    return { respectArrangement, moved };
  };
  // Hook dev : rotate-panneau façon CLO. __toileRotatePiece(pid, degrés, axe?,
  // instance?) tourne une pièce autour de son centroïde ; la rotation est
  // rendue au pré-essayage, et respectée par l'essayage si respectArrangement
  // est actif (via __toileAnatomical(true)). Axe défaut Y (rotation verticale).
  (
    window as unknown as {
      __toileRotatePiece?: (
        pid: number,
        deg: number,
        axis?: [number, number, number],
        instance?: number,
      ) => unknown;
    }
  ).__toileRotatePiece = (
    pid: number,
    deg: number,
    axis: [number, number, number] = [0, 1, 0],
    instance = 0,
  ) => {
    if (!draft) return { ok: false, reason: 'no draft' };
    let piece = draftPieceOf(pid);
    if (!piece) return { ok: false, reason: 'no piece' };
    if (pid === 1 && !draft.back) piece = structuredClone(draft.piece);
    const quat = quatFromAxisAngle(axis, (deg * Math.PI) / 180);
    pushHistory();
    replaceDraftPiece(pid, rotatePieceInstanceInStaging(piece, instance, quat));
    draftTouched = true;
    atelierDesign = true;
    build();
    return { ok: true, pid, deg, axis, instance };
  };
  (document.getElementById('at-arrange') as HTMLElement).addEventListener('click', () => {
    if (!atelierDesign) {
      arrangeMode = true;
      enterDesign();
    } else {
      arrangeMode = !arrangeMode;
    }
    arrangePick = null;
    arrangeHoverId = null;
    if (arrangeMode) {
      move3DEnabled = false;
      pieceHoverDirty = true;
      setPieceHover(null);
      gizmoPick = null;
      draw3dMode = false;
      clearDraw3d();
      setPressed('at-draw3d', false);
      edit3dMode = false;
      clearEdit3d();
      setPressed('at-edit3d', false);
      sketch3dMode = false;
      clearSketch3d();
      setPressed('at-sketch3d', false);
    }
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    showPlacementStatus(
      arrangeMode
        ? [
            'Points d’arrangement actifs : cliquez une pièce dans la vue 3D, puis une pastille autour du corps — elle s’y range.',
            respectArrangement
              ? 'Pré-assemblage anatomique actif : l’essayage PART de cette préparation.'
              : 'Organisation de la préparation uniquement : patron, coutures et pose d’essayage restent inchangés.',
          ]
        : ['Points d’arrangement désactivés.'],
      true,
    );
    refreshHint();
  });
  // ⚓ PRÉ-ASSEMBLAGE ANATOMIQUE : auto-ancre par rôle + l'essayage respecte
  // la préparation (remplace le hook dev __toileAnatomical). Défaut OFF.
  (document.getElementById('at-preassemble') as HTMLElement | null)?.addEventListener('click', () => {
    if (!atelierDesign) enterDesign();
    respectArrangement = !respectArrangement;
    setPressed('at-preassemble', respectArrangement);
    if (respectArrangement) {
      const moved = autoArrangeByRole();
      showPlacementStatus(
        [
          moved > 0
            ? `Pré-assemblage anatomique : ${moved} pièce${moved > 1 ? 's' : ''} posée${moved > 1 ? 's' : ''} sur le corps par rôle.`
            : 'Pré-assemblage anatomique actif.',
          'L’essayage PART de cette pose — ajuste à la main (✥ déplacer / anneaux de rotation) au besoin.',
        ],
        true,
      );
    } else {
      showPlacementStatus(
        ['Pré-assemblage anatomique désactivé : l’essayage repart du placement canonique (coutures).'],
        false,
      );
    }
    refreshHint();
  });
  (document.getElementById('at-reset3d') as HTMLElement).addEventListener('click', () => {
    const pid = patternView.activeDraftPieceId;
    const current =
      draft &&
      (pid === 0
        ? draft.piece
        : pid === 1
          ? draft.back ?? draft.piece
          : draft.pieces?.[pid - 2]);
    if (!draft || !current) {
      showPlacementStatus(['Sélectionnez d’abord une pièce dans le plan 2D ou la vue 3D.']);
      return;
    }
    const pickedInstance =
      activeStagingInstance?.pid === pid
        ? activeStagingInstance.instance
        : null;
    const hasOffset =
      pickedInstance === null
        ? hasStagingOffset(current)
        : Math.hypot(...stagingOffsetOf(current, pickedInstance)) > 1e-8;
    if (!hasOffset) {
      showPlacementStatus([`${draftPieceLabel(current, pid)} est déjà à sa position 3D de référence.`], true);
      return;
    }
    pushHistory();
    const reset =
      pickedInstance === null
        ? resetPieceStaging(current)
        : resetPieceInstanceStaging(current, pickedInstance);
    replaceDraftPiece(pid, reset);
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    showPlacementStatus(
      [
        `${draftPieceLabel(current, pid)}${
          pickedInstance === null ? '' : ` · exemplaire ${pickedInstance + 1}`
        } replacé à sa position 3D de référence.`,
      ],
      true,
    );
  });
  // Application du PLACEMENT choisi pour la pièce en attente.
  const placePiece = (place: string): void => {
    const pid = placePending;
    penPlacement = false;
    placePending = null;
    showChooser(false);
    if (pid === null || !draft?.pieces) return;
    const idx = pid - 2;
    const piece = draft.pieces[idx];
    if (!piece) return;
    pushHistory();
    let armFitCapM: number | null = null;
    if (place === 'auto') {
      const placed = structuredClone(piece);
      delete placed.wrap;
      placed.placement = { role: 'auto', autoAlign: true };
      if (!placed.name) placed.name = 'Pièce automatique';
      draft.pieces[idx] = placed;
    } else if (place === 'front' || place === 'back') {
      // La pièce devient la face du torse (l'ancienne est remplacée — Ctrl+Z la rend).
      const { pieces, seams } = removeFreePiece(draft.pieces, draft.seams ?? [], pid);
      const linked = removeFreePiece(draft.pieces, draft.segmentLinks ?? [], pid);
      draft.pieces = pieces.length ? pieces : undefined;
      const fid = place === 'front' ? 0 : 1;
      // Les coutures de la face REMPLACÉE pointaient sur les bords d'un contour
      // qui n'existe plus : les garder produirait des fronces absurdes vers des
      // bords arbitraires. On les laisse tomber — 🪡 Coudre refait l'assemblage
      // proprement sur la nouvelle pièce.
      draft.seams = seams.filter((s) => pieceIdOf(s.a) !== fid && pieceIdOf(s.b) !== fid);
      draft.segmentLinks = linked.seams.filter((s) => pieceIdOf(s.a) !== fid && pieceIdOf(s.b) !== fid);
      if (!draft.segmentLinks.length) draft.segmentLinks = undefined;
      if (place === 'front') draft.piece = piece;
      else draft.back = piece;
    } else if (place === 'armR' || place === 'armL' || place === 'neck') {
      // Bras / cou : la pièce est re-boîtée sur l'emprise de son tracé (contour
      // plein bord — la famille éprouvée pour les tubes), puis le placement
      // wrap l'enroule et l'épingle (emmanchure / encolure).
      let wrapped = reboxPiece(piece, place === 'neck' ? 0.15 : 0.18);
      wrapped.wrap = place;
      wrapped.placement = { role: place, autoAlign: true };
      if (!wrapped.name) wrapped.name = placementRoleLabel(place);
      // Manche dessinée à la main : sa tête s'adapte à l'emmanchure MESURÉE
      // (largeur = tour du run ouvert, moyenne devant/dos) — v160.
      if (place === 'armR' || place === 'armL') {
        const fit = fitCapWidthToArmhole(
          draft.piece,
          draft.back ?? null,
          place === 'armR' ? 'R' : 'L',
          wrapped,
        );
        if (fit) {
          wrapped = fit.piece;
          armFitCapM = fit.capM;
        } else {
          armFitCapM = null;
        }
      }
      draft.pieces[idx] = wrapped;
    } else if (place === 'pocket' || place === 'under') {
      // Une couche unique, boîtée serrée : par-dessus (poche, empiècement) ou
      // par-dessous (doublure, fond). Le clic suivant choisit le support et le
      // centre exact, sans figer ce placement dans le patron.
      const placed = reboxPiece(piece, 0.02);
      delete placed.wrap;
      placed.placement = { role: 'pocket', autoAlign: true };
      if (!placed.name) placed.name = place === 'under' ? 'Doublure' : placementRoleLabel('pocket');
      draft.pieces[idx] = placed;
    } else {
      const role =
        place === 'waist' || place === 'legR' || place === 'legL'
          ? place
          : 'free';
      const placed = structuredClone(piece);
      delete placed.wrap;
      placed.placement = { role, autoAlign: true };
      if (!placed.name) placed.name = placementRoleLabel(role);
      draft.pieces[idx] = placed;
    }
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    if (place === 'pocket' || place === 'under') {
      const side = place === 'under' ? ('under' as const) : ('over' as const);
      pocketPlacementPid = pid; // committée, en attente d'ancrage → révocable
      // Le patternView ne reçoit la pièce (avec son rôle « pocket ») que via le
      // setDraft du build, qui est ASYNCHRONE. Armer le geste de surface tout de
      // suite lirait un patternView encore périmé : startSurfacePlacement
      // refuserait (rôle ≠ pocket) et le fantôme cyan n'apparaîtrait jamais.
      // On arme donc une fois la scène stabilisée ; le garde pocketPlacementPid
      // empêche d'armer si l'utilisateur a annulé entre-temps (Échap).
      void lifecycle.whenIdle().then(() => {
        if (pocketPlacementPid !== pid) return;
        patternView.startSurfacePlacement(pid, side);
        syncAtelierControls();
      });
      syncAtelierControls();
      showPlacementStatus([
        side === 'under'
          ? 'Par-dessous : survolez la pièce support — la vôtre glissera ENTRE le corps et elle (doublure, fond).'
          : 'Par-dessus : survolez la pièce support de votre choix dans le plan (poche, empiècement).',
        'Le fantôme cyan suit la souris; cliquez au centre de la position exacte. Tous les côtés seront cousus, puis retirables séparément.',
        'Échap pour annuler la pose.',
      ]);
      return;
    }
    if (place === 'front' || place === 'back') {
      showPlacementStatus([`${place === 'front' ? 'Torse devant' : 'Torse dos'} remplacé · utilisez 🪡 Coudre pour refaire les bords d’assemblage.`], true);
      return;
    }
    const role = draft.pieces?.[idx]?.placement?.role;
    if (role === 'auto') {
      const sewn = (draft.seams ?? []).some(
        (seam) => pieceIdOf(seam.a) === pid || pieceIdOf(seam.b) === pid,
      );
      showPlacementStatus(
        sewn
          ? ['Placement automatique prêt : les coutures détermineront entièrement la pose 3D.']
          : ['Placement automatique choisi · étape suivante : 🪡 cousez au moins un bord au vêtement.'],
        sewn,
      );
    } else if (role === 'armL' || role === 'armR' || role === 'neck') {
      showPlacementStatus(
        armFitCapM !== null && role !== 'neck'
          ? [
              `${placementRoleLabel(role)} : tête de manche AJUSTÉE à l'emmanchure mesurée — ${(armFitCapM * 100).toFixed(1).replace('.', ',')} cm.`,
              'Pré-placement corporel automatique prêt · ↔ Longueur règle la longueur de manche.',
            ]
          : role === 'neck'
            ? [`${placementRoleLabel(role)} : pré-placement corporel automatique prêt.`]
            : [
                `${placementRoleLabel(role)} : pré-placement prêt — aucune emmanchure ouverte mesurable, la pièce garde sa taille dessinée.`,
              ],
        true,
      );
    } else if (role === 'free') {
      showPlacementStatus(['Pièce laissée libre : elle ne sera pas assemblée automatiquement.']);
    } else if (role) {
      const sewn = (draft.seams ?? []).some((seam) => pieceIdOf(seam.a) === pid || pieceIdOf(seam.b) === pid);
      showPlacementStatus(
        sewn
          ? [`${placementRoleLabel(role)} : couture détectée, orientation automatique prête.`]
          : [`${placementRoleLabel(role)} enregistrée · étape suivante : 🪡 Coudre un bord à son bord correspondant.`],
        sewn,
      );
    }
  };
  placeChooser.querySelectorAll<HTMLButtonElement>('button[data-place]').forEach((b) => {
    b.addEventListener('click', () => placePiece((b as HTMLElement).dataset.place ?? 'free'));
  });
  // Préréglage 👕 : le VRAI patron 4 pièces (le patron oversize drop-shoulder
  // de référence fourni par l'utilisateur — DEVANT, DOS, 2 MANCHES), gradé sur
  // les mensurations de l'avatar. ÉDITABLE (c'est un draft) et imprimable en
  // pièces numérotées. Remplace le préréglage kimono d'un seul tenant (v108),
  // qui n'était ni un vrai patron ni éditable.
  // Le sélecteur est partagé par les patrons intégrés. Son contenu suit le
  // vêtement actif pour éviter de mélanger XS–XXL et les tailles pantalon 26–46.
  let boxySize: BoxySize = 'S';
  let boxySurMesure = false; // T-shirt composable coupé aux cotes du mannequin
  let boxySleeves: TeeSleeves = 'short'; // bloc manche échangeable du tee
  let boxyCollar: TeeCollar = 'cote'; // bloc col échangeable du tee
  let boxyNeck: TeeNeck = 'ras'; // forme d'encolure échangeable du tee
  let boxyLen: TeeLength = 'regular'; // longueur du corps échangeable du tee
  let boxyFitBodyKey = ''; // v242 — corps du dernier regrade sur-mesure du tee (ne recalcule que si le corps change)
  let boxyEase = 1; // v243 — aisance sur-mesure du tee : <1 pres du corps, >1 ample (multiplie la largeur graduee)
  // The bundled male scan measures about 70.5 cm at the waist; size 26 is the
  // closest supplied pattern. Starting on 32 made an intentionally oversized
  // waistband look as though it needed an invisible suspension.
  let pantsSize: LoosePantsSize = '26';
  let jupeSize: JupeSize | 'avatar' = '38';
  let robeSize: RobeSize | 'avatar' = '38';
  let vesteSize: VesteSize | 'avatar' = 'M';
  let doudouneSize: DoudouneSize | 'avatar' = 'M';
  let hoodieSize: LucasHoodieSize = 'S';
  let loadedPattern: 'boxy' | 'pants' | 'hoodie' | 'jupe' | 'robe' | 'veste' | 'doudoune' | 'clo-tee' | 'clo-pants' = 'boxy';
  const sizeSel = document.getElementById('at-size') as HTMLSelectElement | null;
  const teeSleevesRow = document.getElementById('at-tee-sleeves-row');
  const teeSleevesSel = document.getElementById('at-tee-sleeves') as HTMLSelectElement | null;
  const teeCollarRow = document.getElementById('at-tee-collar-row');
  const teeCollarSel = document.getElementById('at-tee-collar') as HTMLSelectElement | null;
  const teeNeckRow = document.getElementById('at-tee-neck-row');
  const teeNeckSel = document.getElementById('at-tee-neck') as HTMLSelectElement | null;
  const teeLengthRow = document.getElementById('at-tee-length-row');
  const teeLengthSel = document.getElementById('at-tee-length') as HTMLSelectElement | null;
  const teeEaseRow = document.getElementById('at-tee-ease-row');
  const teeEaseSlider = document.getElementById('at-tee-ease') as HTMLInputElement | null;
  const teeEaseVal = document.getElementById('at-tee-ease-val');
  const easeWord = (pct: number): string =>
    pct <= 94 ? 'pres du corps' : pct >= 108 ? 'ample' : 'standard';
  const syncEaseLabel = (): void => {
    if (teeEaseVal && teeEaseSlider) teeEaseVal.textContent = easeWord(teeEaseSlider.valueAsNumber);
  };
  const syncAvatarStatureHelp = (): void => {
    if (sizeSel) sizeSel.disabled = !draftTouched;
    if (!draftTouched) {
      const nextSize =
        loadedPattern === 'pants'
          ? pantsSize
          : loadedPattern === 'hoodie'
            ? hoodieFitMode === 'avatar'
              ? 'un ajustement au mannequin'
              : hoodieSize
            : boxySize;
      avatarStatureHelp.textContent =
        `Redimensionne le mannequin et ses collisions. Le prochain patron sera chargé avec ${nextSize}.`;
      return;
    }
    const frozenHoodie =
      loadedPattern === 'hoodie' &&
      hoodieFitMode === 'avatar' &&
      !hoodieFitPristine;
    const frozenValue = 'avatar-frozen';
    const frozenOption = sizeSel?.querySelector<HTMLOptionElement>(
      `option[value="${frozenValue}"]`,
    );
    if (frozenHoodie) {
      if (sizeSel && !frozenOption) {
        const option = document.createElement('option');
        option.value = frozenValue;
        option.textContent = 'Ajustement personnalisé · dimensions figées';
        sizeSel.prepend(option);
      }
      if (sizeSel) sizeSel.value = frozenValue;
      avatarStatureHelp.textContent =
        'Redimensionne le mannequin et ses collisions. Le vêtement personnalisé garde ses dimensions ; choisissez « Ajusté au mannequin » pour recalculer le patron.';
      return;
    }
    frozenOption?.remove();
    if (loadedPattern === 'hoodie' && hoodieFitMode === 'avatar') {
      avatarStatureHelp.textContent =
        'Redimensionne le mannequin et ses collisions. « Ajusté au mannequin » suit ces mensurations ; choisissez une taille PDF pour garder des mesures fixes.';
      return;
    }
    const selectedSize =
      loadedPattern === 'pants'
        ? pantsSize
        : loadedPattern === 'hoodie'
          ? hoodieSize
          : boxySize;
    avatarStatureHelp.textContent =
      `Redimensionne le mannequin et ses collisions. ${fixedGarmentSizeMessage(selectedSize)}`;
  };
  const showSizes = (kind: 'boxy' | 'pants' | 'hoodie' | 'jupe' | 'robe' | 'veste' | 'doudoune' | 'clo-tee' | 'clo-pants'): void => {
    if (!sizeSel) return;
    loadedPattern = kind;
    // Bloc manche : sélecteur visible pour le tee seulement (1er bloc composable).
    if (teeSleevesRow) teeSleevesRow.hidden = kind !== 'boxy';
    if (teeSleevesSel && kind === 'boxy') teeSleevesSel.value = boxySleeves;
    // Bloc col : sélecteur visible pour le tee seulement (2e bloc composable).
    if (teeCollarRow) teeCollarRow.hidden = kind !== 'boxy';
    if (teeCollarSel && kind === 'boxy') teeCollarSel.value = boxyCollar;
    // Encolure : sélecteur visible pour le tee seulement (3e bloc composable).
    if (teeNeckRow) teeNeckRow.hidden = kind !== 'boxy';
    if (teeNeckSel && kind === 'boxy') teeNeckSel.value = boxyNeck;
    // Longueur du corps : sélecteur visible pour le tee seulement (4e bloc composable).
    if (teeLengthRow) teeLengthRow.hidden = kind !== 'boxy';
    if (teeLengthSel && kind === 'boxy') teeLengthSel.value = boxyLen;
    // Aisance : visible pour le tee EN SUR-MESURE seulement (agit sur la coupe aux cotes).
    if (teeEaseRow) teeEaseRow.hidden = !(kind === 'boxy' && boxySurMesure);
    if (teeEaseSlider && kind === 'boxy') {
      teeEaseSlider.value = String(Math.round(boxyEase * 100));
      syncEaseLabel();
    }
    if (kind === 'clo-tee') {
      sizeSel.innerHTML = `<option value="avatar">Bloc CLO ajusté au mannequin · poitrine ${(lastMeasure.chest.circ * 100).toFixed(0)} cm</option>`;
      sizeSel.value = 'avatar';
    } else if (kind === 'clo-pants') {
      sizeSel.innerHTML = `<option value="avatar">Bloc CLO ajusté au mannequin · taille ${(lastMeasure.waist.circ * 100).toFixed(0)} · bassin ${(lastMeasure.hip.circ * 100).toFixed(0)} cm</option>`;
      sizeSel.value = 'avatar';
    } else if (kind === 'boxy') {
      // lastMeasure est en zone morte au tout premier showSizes de l'init :
      // on affiche l'option sans la cote, elle réapparaît dès le tee chargé.
      let avatarChest = '';
      try {
        avatarChest = ` · poitrine ${(lastMeasure.chest.circ * 100).toFixed(0)} cm`;
      } catch {
        /* mannequin pas encore mesuré */
      }
      sizeSel.innerHTML =
        `<option value="avatar">Ajusté au mannequin${avatarChest}</option>` +
        BOXY_SIZES.map((s) => `<option value="${s}">${s} · poitrine ${boxyChestCm(s)} cm</option>`).join('');
      sizeSel.value = boxySurMesure ? 'avatar' : boxySize;
    } else if (kind === 'doudoune') {
      sizeSel.innerHTML = [
        `<option value="avatar">Ajustée au mannequin · poitrine ${(lastMeasure.chest.circ * 100).toFixed(0)} + ${DOUDOUNE_AVATAR_EASE_CM} cm d'aisance</option>`,
        ...DOUDOUNE_SIZES.map((s) => `<option value="${s}">${s} · vêtement ${doudouneCm(s)} cm</option>`),
      ].join('');
      sizeSel.value = doudouneSize;
    } else if (kind === 'veste') {
      sizeSel.innerHTML = [
        `<option value="avatar">Ajustée au mannequin · poitrine ${(lastMeasure.chest.circ * 100).toFixed(0)} + ${VESTE_AVATAR_EASE_CM} cm d'aisance</option>`,
        ...VESTE_SIZES.map((s) => `<option value="${s}">${s} · vêtement ${vesteCm(s)} cm</option>`),
      ].join('');
      sizeSel.value = vesteSize;
    } else if (kind === 'robe') {
      sizeSel.innerHTML = [
        `<option value="avatar">Ajustée au mannequin · poitrine ${(lastMeasure.chest.circ * 100).toFixed(0)} · taille ${(lastMeasure.waist.circ * 100).toFixed(0)} · hanches ${(lastMeasure.hip.circ * 100).toFixed(0)} cm</option>`,
        ...ROBE_SIZES.map(
          (s) =>
            `<option value="${s}">${s} · poitrine ${robeCm(s).poitrineCm} · taille ${robeCm(s).tailleCm} · hanches ${robeCm(s).hanchesCm} cm</option>`,
        ),
      ].join('');
      sizeSel.value = robeSize;
    } else if (kind === 'jupe') {
      sizeSel.innerHTML = [
        `<option value="avatar">Ajustée au mannequin · taille ${(lastMeasure.waist.circ * 100).toFixed(0)} · hanches ${(lastMeasure.hip.circ * 100).toFixed(0)} cm</option>`,
        ...JUPE_SIZES.map(
          (s) => `<option value="${s}">${s} · taille ${jupeCm(s).tailleCm} · hanches ${jupeCm(s).hanchesCm} cm</option>`,
        ),
      ].join('');
      sizeSel.value = jupeSize;
    } else if (kind === 'pants') {
      sizeSel.innerHTML = LOOSE_PANTS_SIZES.map((s) => `<option value="${s}">${loosePantsSizeLabel(s)}</option>`).join('');
      sizeSel.value = pantsSize;
    } else {
      const fit = lucasHoodieFit(lastMeasure);
      const adjustedLabel = [
        'Ajusté au mannequin · recommandé',
        `base ${fit.sourceSize}`,
        `${fit.bodyChestCm.toFixed(1).replace('.', ',')} → ${fit.targetFinishedChestCm.toFixed(1).replace('.', ',')} cm`,
      ].join(' · ');
      sizeSel.innerHTML = [
        `<option value="avatar">${adjustedLabel}</option>`,
        ...LUCAS_HOODIE_SIZES.map(
          (size) =>
            `<option value="${size}">${lucasHoodieSizeLabel(size)} · PDF exact</option>`,
        ),
      ].join('');
      sizeSel.value = hoodieFitMode === 'avatar' ? 'avatar' : hoodieSize;
    }
    syncAvatarStatureHelp();
  };
  const isLegacyBoxyDraft = (source: DraftDoc): boolean =>
    source.preset === undefined &&
    !!source.back &&
    (source.seams?.length ?? 0) === 4 &&
    source.pieces?.length === 3 &&
    source.pieces[0]?.wrap === 'armR' &&
    source.pieces[1]?.wrap === 'armL' &&
    source.pieces[2]?.wrap === 'neck';
  const nearestBoxySize = (source: DraftDoc): BoxySize => {
    let bestSize = boxySize;
    let bestError = Number.POSITIVE_INFINITY;
    for (const candidateSize of BOXY_SIZES) {
      const candidate = boxyTee(candidateSize, lastMeasure, REF);
      const error =
        Math.abs(candidate.piece.width - source.piece.width) +
        Math.abs(candidate.piece.height - source.piece.height) +
        Math.abs(
          (candidate.pieces?.[0]?.width ?? 0) -
            (source.pieces?.[0]?.width ?? 0),
        ) +
        Math.abs(
          (candidate.pieces?.[0]?.height ?? 0) -
            (source.pieces?.[0]?.height ?? 0),
        );
      if (error < bestError) {
        bestError = error;
        bestSize = candidateSize;
      }
    }
    return bestSize;
  };
  function syncPatternContextFromDraft(
    source: DraftDoc | null,
    hoodieState: { pristine: boolean; bodyKey: string } = {
      pristine: false,
      bodyKey: '',
    },
  ): boolean {
    if (!source) {
      showSizes('boxy');
      return true;
    }
    const legacyBoxy = isLegacyBoxyDraft(source);
    if (legacyBoxy) {
      const savedSize = source.presetSize;
      boxySize =
        savedSize && BOXY_SIZES.includes(savedSize as BoxySize)
          ? (savedSize as BoxySize)
          : nearestBoxySize(source);
      showSizes('boxy');
      return true;
    }
    if (source.preset === 'loose-pants') {
      const savedSize = source.presetSize;
      if (
        savedSize &&
        LOOSE_PANTS_SIZES.includes(savedSize as LoosePantsSize)
      ) {
        pantsSize = savedSize as LoosePantsSize;
      }
      showSizes('pants');
      return true;
    }
    if (source.preset === 'jupe') {
      const savedSize = source.presetSize;
      if (savedSize === 'avatar' || (JUPE_SIZES as readonly string[]).includes(savedSize ?? '')) {
        jupeSize = savedSize as JupeSize | 'avatar';
      }
      showSizes('jupe');
      return true;
    }
    if (source.preset === 'robe') {
      const savedSize = source.presetSize;
      if (savedSize === 'avatar' || (ROBE_SIZES as readonly string[]).includes(savedSize ?? '')) {
        robeSize = savedSize as RobeSize | 'avatar';
      }
      showSizes('robe');
      return true;
    }
    if (source.preset === 'veste') {
      const savedSize = source.presetSize;
      if (savedSize === 'avatar' || (VESTE_SIZES as readonly string[]).includes(savedSize ?? '')) {
        vesteSize = savedSize as VesteSize | 'avatar';
      }
      showSizes('veste');
      return true;
    }
    if (source.preset === 'doudoune') {
      const savedSize = source.presetSize;
      if (savedSize === 'avatar' || (DOUDOUNE_SIZES as readonly string[]).includes(savedSize ?? '')) {
        doudouneSize = savedSize as DoudouneSize | 'avatar';
      }
      showSizes('doudoune');
      return true;
    }
    if (source.preset === 'lucas-hoodie') {
      const sourceSize = lucasHoodieSourceSize(source);
      hoodieFitMode = source.presetSize?.startsWith('fit-')
        ? 'avatar'
        : 'standard';
      if (sourceSize) hoodieSize = sourceSize;
      hoodieFitPristine = hoodieState.pristine;
      hoodieFitBodyKey = hoodieState.bodyKey;
      showSizes('hoodie');
      return true;
    }
    return false;
  }
  const loadBoxyTee = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // le patron chargé remplace tout : placement en attente caduc
    pushHistory();
    showSizes('boxy');
    teePreset = false;
    draft = boxyTee(boxySize, lastMeasure, REF, boxySleeves, boxyCollar, boxyNeck, boxyLen, boxySurMesure, boxyEase);
    draftTouched = true; // un vrai draft : éditable, exportable
    atelierSleeves = false; // les manches sont DES PIÈCES du patron
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-tshirt') as HTMLElement).addEventListener('click', loadBoxyTee);
  // Bloc manche échangeable : change la variante et recompose le tee.
  teeSleevesSel?.addEventListener('change', () => {
    boxySleeves = teeSleevesSel.value as TeeSleeves;
    if (loadedPattern === 'boxy' && sceneMode === 'atelier') loadBoxyTee();
  });
  // Bloc col échangeable : change la variante et recompose le tee.
  teeCollarSel?.addEventListener('change', () => {
    boxyCollar = teeCollarSel.value as TeeCollar;
    if (loadedPattern === 'boxy' && sceneMode === 'atelier') loadBoxyTee();
  });
  // Encolure échangeable : change la forme et recompose le tee.
  teeNeckSel?.addEventListener('change', () => {
    boxyNeck = teeNeckSel.value as TeeNeck;
    if (loadedPattern === 'boxy' && sceneMode === 'atelier') loadBoxyTee();
  });
  // Longueur du corps échangeable : change la coupe et recompose le tee.
  teeLengthSel?.addEventListener('change', () => {
    boxyLen = teeLengthSel.value as TeeLength;
    if (loadedPattern === 'boxy' && sceneMode === 'atelier') loadBoxyTee();
  });
  // Aisance sur-mesure : pres du corps <-> ample. Le libelle suit en direct
  // (input) ; le patron se recoupe au relachement (change), comme les curseurs
  // de mensuration. On passe par build() (pas loadBoxyTee) : la vue et
  // l'historique sont gardes, et le bloc de regrade reporte le design par-piece.
  teeEaseSlider?.addEventListener('input', syncEaseLabel);
  teeEaseSlider?.addEventListener('change', () => {
    boxyEase = teeEaseSlider.valueAsNumber / 100;
    syncEaseLabel();
    if (loadedPattern === 'boxy' && boxySurMesure && sceneMode === 'atelier') build();
  });

  const loadLoosePants = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('pants');
    teePreset = false;
    draft = loosePants(pantsSize, lastMeasure);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-pants') as HTMLElement).addEventListener('click', loadLoosePants);

  // v193 : la JUPE — le premier patron gradable né après le Studio IA. Même
  // liturgie que les autres archétypes ; le bloc vit dans engine/pattern/jupe.
  const loadJupe = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('jupe');
    teePreset = false;
    draft = draftJupe(jupeSize, lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-jupe') as HTMLElement | null)?.addEventListener('click', loadJupe);

  // v194 : la ROBE cintrée sans manches — la seconde moitié du chantier
  // « jupe et robe ». Épaulée comme le tee : aucun ancrage de ceinture.
  const loadRobe = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('robe');
    teePreset = false;
    draft = draftRobe(robeSize, lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-robe') as HTMLElement | null)?.addEventListener('click', loadRobe);

  // v196 : la VESTE zippée doublée — six pièces sur le chemin générique
  // (devant scindé + zip + doublures de surface), épaulée comme le tee.
  const loadVeste = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('veste');
    teePreset = false;
    draft = draftVeste(vesteSize, lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-veste') as HTMLElement | null)?.addEventListener('click', loadVeste);

  // v199 : la DOUDOUNE matelassée — le châssis de la veste plus le gonflant
  // (l'excès du tissu extérieur boudine entre les épingles de canal).
  const loadDoudoune = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('doudoune');
    teePreset = false;
    draft = draftDoudoune(doudouneSize, lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-doudoune') as HTMLElement | null)?.addEventListener('click', loadDoudoune);

  // Blocs de CLO reconstruits (tee Set-In + pantalon Trousers), lus au DXF et
  // gradés sur l'avatar. Le tee passe par l'assemblage générique (comme boxy) ;
  // le pantalon réutilise le châssis loose-pants (buildLoosePantsMesh).
  const loadCloTee = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('clo-tee');
    teePreset = false;
    draft = cloTee(lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-clo-tee') as HTMLElement | null)?.addEventListener('click', loadCloTee);

  const loadCloPants = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    showSizes('clo-pants');
    teePreset = false;
    draft = cloPants(lastMeasure, REF);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-clo-pants') as HTMLElement | null)?.addEventListener('click', loadCloPants);

  // v197 : OUVRIR / FERMER la fermeture du patron — le geste de démo (ouverte,
  // la veste s'écarte sur sa doublure à l'essayage). La bascule vit dans le
  // DOCUMENT (`closed` des coutures zipper) ; la reconstruction rejoue
  // l'essayage avec ou sans les épingles du zip — même chemin que l'undo.
  const zipToggleBtn = document.getElementById('at-zip-open') as HTMLButtonElement | null;
  const draftZipSeams = (): AssemblySeam[] =>
    (draft?.seams ?? []).filter((s) => s.kind === 'zipper');
  const syncZipToggle = (): void => {
    if (!zipToggleBtn) return;
    const zips = draftZipSeams();
    // Le hoodie monte sa fermeture dans son assembleur spécialisé, qui ne lit
    // pas `closed` : la bascule n'y ferait rien — réservée au chemin générique
    // (veste, fermetures posées à la main avec ⚡).
    const usable = zips.length > 0 && draft?.preset !== 'lucas-hoodie';
    zipToggleBtn.hidden = !usable;
    if (!usable) return;
    const anyClosed = zips.some((s) => s.closed !== false);
    zipToggleBtn.textContent = anyClosed ? '🤐 Ouvrir la fermeture' : '⚡ Fermer la fermeture';
  };
  zipToggleBtn?.addEventListener('click', () => {
    if (!draft || !draftZipSeams().length) return;
    const anyClosed = draftZipSeams().some((s) => s.closed !== false);
    pushHistory();
    draft.seams = draft.seams!.map((s) =>
      s.kind === 'zipper' ? { ...s, closed: !anyClosed } : s,
    );
    draftTouched = true;
    if (!atelierDesign) {
      // v198 — À CHAUD : l'essayage tourne, la veste est PORTÉE. On ne
      // reconstruit rien : les épingles ZipperSeam sont déjà dans le maillage,
      // l'uniform du solveur les débraye (ou les re-tend) et le tissu répond
      // depuis son état porté — le geste réel d'ouvrir une veste sur soi.
      system.setZipperOpen(anyClosed);
      refreshPatternDoc(); // le plan 2D affiche OUVERT/fermé sans rebuild
    } else {
      build();
    }
    syncZipToggle();
    showToast(
      anyClosed
        ? 'Fermeture ouverte — les devants s’écartent.'
        : 'Fermeture fermée — les rubans se rejoignent.',
    );
  });

  const loadLucasHoodie = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    // Selecting either the live mannequin grade or a PDF size explicitly
    // starts from a fresh built-in pattern. Later manual edits mark it frozen.
    hoodieFitPristine = true;
    showSizes('hoodie');
    teePreset = false;
    const fit = lucasHoodieFit(lastMeasure);
    draft =
      hoodieFitMode === 'avatar'
        ? lucasHoodieAdjusted(lastMeasure)
        : lucasHoodie(hoodieSize, lastMeasure);
    hoodieFitBodyKey = hoodieBodyKey(lastMeasure);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
    showPlacementStatus(
      [
        hoodieFitMode === 'avatar'
          ? `Lucas Hoodie ajusté au mannequin · base A0 ${fit.sourceSize} · poitrine finie ${fit.targetFinishedChestCm.toFixed(1).replace('.', ',')} cm · longueur ${fit.targetFinishedLengthCm.toFixed(1).replace('.', ',')} cm.`
          : `Lucas Hoodie ${hoodieSize} chargé · taille PDF exacte, 7 pièces et marge de couture 1 cm incluse.`,
        `Fermeture séparable calculée : ${(lucasZipperLengthM(draft) * 100).toFixed(1).replace('.', ',')} cm · du bas de la ceinture au col.`,
      ],
      true,
    );
  };
  (document.getElementById('at-hoodie') as HTMLElement).addEventListener(
    'click',
    loadLucasHoodie,
  );

  // Remplir + brancher le sélecteur de taille.
  if (sizeSel) {
    showSizes('boxy');
    sizeSel.addEventListener('change', () => {
      if (loadedPattern === 'pants') {
        pantsSize = sizeSel.value as LoosePantsSize;
        if (sceneMode === 'atelier') loadLoosePants();
      } else if (loadedPattern === 'jupe') {
        jupeSize = sizeSel.value as JupeSize | 'avatar';
        if (sceneMode === 'atelier') loadJupe();
      } else if (loadedPattern === 'robe') {
        robeSize = sizeSel.value as RobeSize | 'avatar';
        if (sceneMode === 'atelier') loadRobe();
      } else if (loadedPattern === 'veste') {
        vesteSize = sizeSel.value as VesteSize | 'avatar';
        if (sceneMode === 'atelier') loadVeste();
      } else if (loadedPattern === 'doudoune') {
        doudouneSize = sizeSel.value as DoudouneSize | 'avatar';
        if (sceneMode === 'atelier') loadDoudoune();
      } else if (loadedPattern === 'clo-tee') {
        if (sceneMode === 'atelier') loadCloTee();
      } else if (loadedPattern === 'clo-pants') {
        if (sceneMode === 'atelier') loadCloPants();
      } else if (loadedPattern === 'hoodie') {
        if (sizeSel.value === 'avatar-frozen') return;
        if (sizeSel.value === 'avatar') {
          hoodieFitMode = 'avatar';
          hoodieFitPristine = true;
        } else {
          hoodieFitMode = 'standard';
          hoodieSize = sizeSel.value as LucasHoodieSize;
        }
        if (sceneMode === 'atelier') loadLucasHoodie();
      } else {
        if (sizeSel.value === 'avatar') {
          boxySurMesure = true;
        } else {
          boxySurMesure = false;
          boxySize = sizeSel.value as BoxySize;
        }
        if (sceneMode === 'atelier') loadBoxyTee();
      }
    });
  }
  // (✎ Devant / ✎ Dos / ✎ Manche retirés en v124 : la confection est LIBRE —
  // une seule plume « ✎ Pièce », le placement se choisit à la fermeture.)
  // « + Pièce / − Pièce / + Col » : boutons retirés (v109) — le moteur ne cousait
  // une pièce rapportée que sur la face avant (pièces ouvertes). Le machinery
  // (startPen(pid), deleteActiveFreePiece, atelierCollar dans build()) reste en
  // place pour la fin du chantier « pièces qui s'enroulent ».
  // « + Manches » (v111) : REVENU sur le chemin éprouvé v96-104 — des tubes
  // sleeveMesh autour des bras, chaque panneau étant cousu à sa propre lèvre
  // d'emmanchure (devant→devant, dos→dos).
  // Si rien n'est encore dessiné, le clic charge d'abord le corps t-shirt
  // éprouvé (tshirtDraft, dimensionné à l'avatar) : un clic = bras dans les
  // manches. Sur un corps dessiné/importé, les tubes s'épinglent tel quel.
  (document.getElementById('at-sleeves') as HTMLElement).addEventListener('click', (e) => {
    atelierSleeves = !atelierSleeves;
    (e.currentTarget as HTMLElement).classList.toggle('active', atelierSleeves);
    if (atelierSleeves && !draftTouched) {
      pushHistory();
      draft = tshirtDraft(0.7 * lastGrade.topScale, 0.62, 0.9, 1.52 + lastGrade.dyShoulder, resolution as 32 | 64 | 128);
      draftTouched = true; // the loaded body is a real editable draft (exports carry it)
      teePreset = false;
    }
    atelierDesign = true; // re-freeze flat so the new tubes are visible before draping
    simBtn().classList.remove('running');
    syncAtelierControls();
    build();
  });
  // ▱ LIGNE INTERNE : polylignes et polygones DANS une pièce — style, pliure,
  // surpiqûre, repère. Géométrie de patron pure : AUCUNE reconstruction du
  // solveur (setDraft direct), l'essayage n'y touche pas.
  (document.getElementById('at-internal') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleInternalLine();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  const refreshPatternDoc = (): void => {
    if (!draft) return;
    patternView.setDraft(draft.piece, draft.back ?? null, draft.pieces ?? []);
    patternView.setAssembly(draft.seams ?? []);
    patternView.setSegmentLinks(draft.segmentLinks ?? []);
  };
  patternView.onInternalLine = (pid, line) => {
    if (!draft) return;
    const piece = draftPieceAt(pid);
    if (!piece) return;
    if ((piece.internalLines?.length ?? 0) >= INTERNAL_LINES_MAX) {
      showToast(`Plafond atteint : ${INTERNAL_LINES_MAX} lignes internes par pièce.`);
      return;
    }
    pushHistory();
    const next = structuredClone(piece);
    next.internalLines = [...(next.internalLines ?? []), line];
    replaceDraftPiece(pid, next);
    draftTouched = true;
    refreshPatternDoc();
    showPlacementStatus(
      [
        `Ligne interne ${line.closed ? 'FERMÉE (polygone)' : 'posée'} — ${line.points.length} points, sur « ${draftPieceLabel(next, pid)} ».`,
        'Style, pliure ou repère : visible au plan, sur la préparation 3D et dans les exports PDF/SVG · re-cliquez une ligne (outil armé) pour la supprimer · Ctrl+Z annule.',
      ],
      true,
    );
  };
  // ◆ PINCE LOSANGE : trois clics = un losange cousu (2 pinces dos à dos).
  (document.getElementById('at-dart') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleFisheyeDart();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ∿ POINT COURBE : un sommet saisi + un rayon = le coin s'arrondit en arc.
  (document.getElementById('at-curvepoint') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleCurvePoint();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ⌵ CRANS DE MONTAGE : repères d'alignement — géométrie de patron pure,
  // AUCUNE reconstruction du solveur (setDraft direct, comme les lignes ▱).
  (document.getElementById('at-notch') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleNotch();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ⧉ FUSIONNER : l'inverse du ✂ — cliquer une couture fond ses deux pièces
  // en une seule (congruence des bords vérifiée par le moteur, refus en mots).
  (document.getElementById('at-merge') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleMerge();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ⛓ ÉDITION LIÉE : préférence collante — pas un mode, un comportement.
  (document.getElementById('at-linkedit') as HTMLElement | null)?.addEventListener('click', (e) => {
    linkedEditPref = !linkedEditPref;
    (e.currentTarget as HTMLElement).classList.toggle('active', linkedEditPref);
    setPressed('at-linkedit', linkedEditPref);
    showToast(
      linkedEditPref
        ? '⛓ Édition liée ACTIVE : déplacer un sommet posé sur un bord cousu déplace aussi son vis-à-vis, forme comprise.'
        : '⛓ Édition liée désactivée : les sommets bougent seuls, les coutures recousent aux longueurs.',
    );
    refreshHint();
  });
  // ⌖ ÉTABLI DE PRÉCISION : un outil, quatre gestes — le clic dit lequel.
  const cornerChooser = document.getElementById('precision-corner-chooser') as HTMLElement | null;
  const axisChooser = document.getElementById('precision-axis-chooser') as HTMLElement | null;
  const divideChooser = document.getElementById('divide-chooser') as HTMLElement | null;
  let cornerPending: { pid: number; vertex: number } | null = null;
  let axisPending: { pid: number; vertex: number; ref: number } | null = null;
  let dividePending: { pid: number; edge: number } | null = null;
  let precisionAlign: { pid: number; vertex: number } | null = null;
  const closePrecisionChoosers = (): void => {
    if (cornerChooser) cornerChooser.hidden = true;
    if (axisChooser) axisChooser.hidden = true;
    if (divideChooser) divideChooser.hidden = true;
    cornerPending = null;
    axisPending = null;
    dividePending = null;
  };
  const commitPrecision = (
    res: { ok: true; doc: DraftDoc; note?: string } | { ok: false; reason: string },
    lines: (note: string | undefined) => string[],
    rebuild: boolean,
  ): void => {
    if (!draft) return;
    if (!res.ok) {
      showToast(res.reason);
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    if (rebuild) {
      build();
      void lifecycle.whenIdle().then(() => showPlacementStatus(lines(res.note), true));
    } else {
      refreshPatternDoc();
      showPlacementStatus(lines(res.note), true);
    }
  };
  (document.getElementById('at-precision') as HTMLElement | null)?.addEventListener('click', (e) => {
    closePrecisionChoosers();
    precisionAlign = null;
    const on = patternView.togglePrecision();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  patternView.onPrecisionVertex = (pid, vertex) => {
    if (!draft) return;
    if (precisionAlign) {
      if (precisionAlign.pid !== pid) {
        showToast('Alignez deux sommets de la MÊME pièce.');
        precisionAlign = null;
        refreshHint();
        return;
      }
      if (precisionAlign.vertex === vertex) {
        showToast('Cliquez un AUTRE sommet comme référence.');
        return;
      }
      const mover = precisionAlign.vertex;
      precisionAlign = null;
      closePrecisionChoosers();
      axisPending = { pid, vertex: mover, ref: vertex };
      if (axisChooser) axisChooser.hidden = false;
      refreshHint();
      return;
    }
    cornerPending = { pid, vertex };
    if (cornerChooser) cornerChooser.hidden = false;
    refreshHint();
  };
  cornerChooser?.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const pending = cornerPending;
    closePrecisionChoosers();
    if (!pending || !draft) return;
    if (act === 'align') {
      precisionAlign = pending;
      showToast('⌗ Cliquez maintenant le sommet de RÉFÉRENCE (même pièce).');
      refreshHint();
      return;
    }
    if (act === 'sq-prev' || act === 'sq-next') {
      commitPrecision(
        squareCorner(draft, pending.pid, pending.vertex, act === 'sq-prev' ? 'prev' : 'next'),
        (note) => [
          `Angle ÉQUERRÉ${note ? ` — ${note}` : ''} : le bord arrive perpendiculaire au sommet (le geste des ourlets et des milieux au pli).`,
          'Les coutures suivent leurs sommets · Ctrl+Z annule.',
        ],
        true,
      );
    }
  });
  axisChooser?.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-axis]');
    if (!btn) return;
    const axis = btn.dataset.axis === 'y' ? 'y' : 'x';
    const pending = axisPending;
    closePrecisionChoosers();
    if (!pending || !draft) return;
    const res = alignOutlineVertex(draft, pending.pid, pending.vertex, pending.ref, axis);
    if (!res.ok) {
      showToast(res.reason);
      refreshHint();
      return;
    }
    // ⛓ armée : le vis-à-vis cousu suit aussi l'alignement.
    if (linkedEditPref) {
      const linked = linkedVertexEdit(draft, pending.pid, pending.vertex, res.target);
      if (!linked.ok) {
        showToast(linked.reason);
        refreshHint();
        return;
      }
      if (linked.followed.length) {
        commitPrecision(
          { ok: true, doc: linked.doc },
          () => [
            `Sommets ALIGNÉS (${axis === 'x' ? 'même verticale' : 'même horizontale'}) — et le vis-à-vis cousu a suivi (⛓).`,
            'Ctrl+Z annule tout le geste d’un coup.',
          ],
          true,
        );
        return;
      }
    }
    commitPrecision(
      { ok: true, doc: res.doc },
      () => [
        `Sommets ALIGNÉS — ${axis === 'x' ? 'même verticale (X de la référence)' : 'même horizontale (Y de la référence)'}.`,
        'Ctrl+Z annule.',
      ],
      true,
    );
  });
  patternView.onDivideEdge = (pid, edge) => {
    if (!draft) return;
    dividePending = { pid, edge };
    if (divideChooser) divideChooser.hidden = false;
    refreshHint();
  };
  divideChooser?.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-parts]');
    if (!btn) return;
    const parts = Number(btn.dataset.parts) || 0;
    const pending = dividePending;
    closePrecisionChoosers();
    if (!pending || !draft || !parts) return;
    commitPrecision(
      divideOutlineEdge(draft, pending.pid, pending.edge, parts),
      (note) => [
        `Bord DIVISÉ en ${parts} parts égales${note ? ` — ${note}` : ''} : des sommets prêts pour coutures, crans et alignements.`,
        'La géométrie ne bouge pas d’un millimètre · Ctrl+Z retire les points.',
      ],
      false,
    );
  });
  for (const cancelId of ['precision-corner-cancel', 'precision-axis-cancel', 'divide-cancel']) {
    document.getElementById(cancelId)?.addEventListener('click', () => {
      closePrecisionChoosers();
      refreshHint();
    });
  }
  patternView.onExtendInternal = (pid, lineIndex, end) => {
    if (!draft) return;
    commitPrecision(
      extendInternalLineEnd(draft, pid, lineIndex, end),
      (note) => [
        `Ligne interne PROLONGÉE jusqu’au contour${note ? ` — ${note}` : ''}, dans la direction de son dernier segment.`,
        'Prête pour le ✂ (scission le long de la ligne) · Ctrl+Z annule.',
      ],
      false,
    );
  };
  patternView.onDivideInternal = (pid, lineIndex, at) => {
    if (!draft) return;
    commitPrecision(
      divideInternalLineAt(draft, pid, lineIndex, at),
      () => [
        'Ligne interne SCINDÉE en deux au point cliqué — le point de scission est partagé, exact.',
        'Chaque moitié vit sa vie (supprimable, prolongeable) · Ctrl+Z recolle.',
      ],
      false,
    );
  };
  // ⌾ ÉVIDER : une ligne interne fermée devient un trou du maillage (et retour).
  (document.getElementById('at-hole') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleHole();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ⧢ ÉVASEMENT : deux clics (pivot, ouverture) → choix des cm → couper-pivoter.
  const fullnessChooser = document.getElementById('fullness-chooser') as HTMLElement | null;
  let fullnessPending: { pid: number; pivot: { edge: number; t: number }; opening: { edge: number; t: number } } | null = null;
  const closeFullnessChooser = (): void => {
    if (fullnessChooser) fullnessChooser.hidden = true;
    fullnessPending = null;
    document.getElementById('at-fullness')?.classList.remove('active');
  };
  (document.getElementById('at-fullness') as HTMLElement | null)?.addEventListener('click', (e) => {
    if (fullnessChooser && !fullnessChooser.hidden) {
      closeFullnessChooser();
      return;
    }
    const on = patternView.toggleFullness();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  patternView.onFullnessPicked = (pid, pivot, opening) => {
    if (!draft || !fullnessChooser) return;
    fullnessPending = { pid, pivot, opening };
    fullnessChooser.hidden = false;
    syncAtelierControls();
    refreshHint();
  };
  fullnessChooser?.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-open-cm]');
    if (btn) {
      const cm = Number(btn.dataset.openCm) || 0;
      const pending = fullnessPending;
      closeFullnessChooser();
      if (!cm || !pending || !draft) return;
      const res = slashSpreadFullness(draft, pending.pid, pending.pivot, pending.opening, cm / 100);
      if (!res.ok || !res.doc) {
        showToast(res.reason ?? 'Évasement impossible ici.');
        syncAtelierControls();
        refreshHint();
        return;
      }
      pushHistory();
      draft = res.doc;
      draftTouched = true;
      teePreset = false;
      atelierDesign = true;
      simBtn().classList.remove('running');
      build();
      const label = draftPieceLabel(draftPieceAt(pending.pid), pending.pid);
      void lifecycle.whenIdle().then(() => {
        showPlacementStatus(
          [
            `Évasement posé sur « ${label} » — ${(res.openedM! * 100).toFixed(1).replace('.', ',')} cm d'ampleur ajoutés au bord d'ouverture (couper-pivoter autour du point vert).`,
            'La pièce reste UNE pièce : l’entaille est devenue du tissu · les coutures recousent aux nouvelles longueurs · Ctrl+Z annule.',
          ],
          true,
        );
      });
      return;
    }
    if ((event.target as Element | null)?.closest('#fullness-cancel')) closeFullnessChooser();
  });
  // ✂3D dans la foulée : la proposition qui suit un tracé ✎3D OUVERT.
  const draw3dSplitChooser = document.getElementById('draw3d-chooser') as HTMLElement | null;
  let draw3dSplitPending: { pid: number; lineIndex: number } | null = null;
  const closeDraw3dChooser = (): void => {
    if (draw3dSplitChooser) draw3dSplitChooser.hidden = true;
    draw3dSplitPending = null;
  };
  draw3dSplitChooser?.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('#draw3d-split-now')) {
      const pending = draw3dSplitPending;
      closeDraw3dChooser();
      if (pending) splitAlongInternalLine(pending.pid, pending.lineIndex);
      return;
    }
    if (target?.closest('#draw3d-split-keep')) {
      closeDraw3dChooser();
      showToast('Ligne gardée — ✂ + clic dessus (au plan) scindera plus tard.');
    }
  });
  /** ⛶ : la zone fermée sur le corps devient une pièce (cadre corps, comme
   * la plume 2D) et passe au place-chooser — tout l'aval existant s'applique
   * (Devant/Dos remplacent la face, Bras = manche adaptée à l'emmanchure). */
  const commitSketch3d = (): void => {
    const drawn = sketch3dPoints.map((q) => [q[0], q[1]] as [number, number]);
    sketch3dPoints = [];
    if (drawn.length < 3) return;
    const gridN = resolution as 32 | 64 | 128;
    // Page blanche : le doc devient le socle vide, comme « Nouvelle pièce ».
    if (!atelierEmptyState.hidden || !draft) {
      draft = blankBaseDraft(gridN);
      patternView.setDraft(draft.piece, draft.back ?? null, []);
      patternView.setAssembly([]);
      patternView.setSegmentLinks([]);
    }
    const world = patternView.penMirroring ? closeSketchMirror(drawn) : drawn;
    if (world.length < 3) return;
    const dims = draft.piece;
    const W = dims.width;
    const H = dims.height;
    const outline = world.map(
      ([x, y]) => [x / W + 0.5, (dims.topY - y) / H] as UV,
    );
    if (isSelfIntersecting(outline)) {
      showToast('Cette zone se croise — reprenez le tracé (Échap pour annuler).');
      sketch3dPoints = drawn; // rendre le tracé pour retouche
      return;
    }
    pushHistory();
    const piece: DraftPiece = {
      outline,
      darts: [],
      seams: [],
      openEdges: [],
      width: W,
      height: H,
      topY: dims.topY,
      gap: dims.gap,
      name: 'Croquis corps',
    };
    draft.pieces = [...(draft.pieces ?? []), piece];
    const pid = 1 + (draft.pieces.length);
    draftTouched = true;
    atelierDesign = true;
    teePreset = false;
    refreshPatternDoc();
    refreshHint();
    placePending = pid;
    showChooser(true);
    showPlacementStatus(
      [
        `Zone dessinée SUR LE CORPS — ${world.length} points${patternView.penMirroring ? ', symétrisée sur l’axe du corps' : ''}.`,
        'Choisissez son placement : Devant/Dos remplacent la face, Bras = manche adaptée à l’emmanchure mesurée.',
      ],
      true,
    );
  };
  /** ✎3D : le tracé posé sur le tissu devient une ligne interne du patron. */
  const commitDraw3d = (closed: boolean): void => {
    const pid = draw3dTarget;
    const points = draw3dPoints.map((pt) => [pt[0], pt[1]] as UV);
    clearDraw3d();
    draw3dMode = true; // le mode reste armé pour enchaîner les tracés
    if (pid === null || points.length < 2 || !draft) return;
    const piece = draftPieceAt(pid);
    if (!piece) return;
    if ((piece.internalLines?.length ?? 0) >= INTERNAL_LINES_MAX) {
      showToast(`Plafond atteint : ${INTERNAL_LINES_MAX} lignes internes par pièce.`);
      return;
    }
    pushHistory();
    const next = structuredClone(piece);
    next.internalLines = [...(next.internalLines ?? []), { points, ...(closed ? { closed: true } : {}) }];
    replaceDraftPiece(pid, next);
    draftTouched = true;
    refreshPatternDoc();
    // Polyligne OUVERTE sur une pièce plate : proposer la scission tout de
    // suite — le Cut & Sew de Clo en un geste, sans repasser par le plan.
    const canSplitNow = !closed && !draftPieceAt(pid)?.wrap && draw3dSplitChooser;
    if (canSplitNow) {
      draw3dSplitPending = { pid, lineIndex: (next.internalLines?.length ?? 1) - 1 };
      draw3dSplitChooser.hidden = false;
    }
    showPlacementStatus(
      [
        `Tracé posé SUR LE TISSU — retombé au patron de « ${draftPieceLabel(next, pid)} » (${points.length} points${closed ? ', polygone fermé' : ''}).`,
        canSplitNow
          ? 'Scinder la pièce le long MAINTENANT ? Choisissez ci-dessus — ou gardez la ligne (style, repère) et scindez plus tard au ✂.'
          : 'La boucle Clo complète : ✂ Découper + clic sur cette ligne (au plan) = la pièce se scinde le long · visible aussi aux exports · Ctrl+Z retire.',
      ],
      true,
    );
  };
  patternView.onNotchToggle = (pid, at) => {
    if (!draft) return;
    const res = toggleNotchAt(draft, pid, at);
    if (!res.ok || !res.doc) {
      showToast(res.reason ?? 'Cran impossible ici.');
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    refreshPatternDoc();
    showToast(res.action === 'removed' ? 'Cran retiré · Ctrl+Z le rend.' : 'Cran posé sur le bord · re-cliquez-le pour le retirer.');
  };
  patternView.onNotchSeam = (seamIndex) => {
    if (!draft) return;
    const res = addSeamNotches(draft, seamIndex);
    if (!res.ok || !res.doc) {
      showToast(res.reason ?? 'Crans impossibles sur cette couture.');
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    refreshPatternDoc();
    showPlacementStatus(
      [
        `Crans d'accord posés : ${res.added} repères appariés sur les deux côtés de la couture (sens de fermeture respecté).`,
        'Le cran d’une pièce tombe exactement sur celui de sa partenaire · imprimés sur les exports PDF/SVG · Ctrl+Z retire.',
      ],
      true,
    );
  };
  patternView.onMergeSeam = (seamIndex) => {
    if (!draft) return;
    const res = mergePiecesAlongSeam(draft, seamIndex);
    if (!res.ok) {
      showToast(res.reason);
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    void lifecycle.whenIdle().then(() => {
      const gapMm = res.seamGapMaxM * 1000;
      showPlacementStatus(
        [
          `Pièces FUSIONNÉES en une seule — la couture s'efface, bords superposés ${gapMm < 0.05 ? 'à l’identique' : `à ${gapMm.toFixed(1)} mm près`}.`,
          `Pinces, lignes internes et crans des deux côtés ont suivi${res.droppedLinks ? ` · ${res.droppedLinks} lien(s) Marier abandonné(s)` : ''}${res.note ? ` · ${res.note}` : ''} · Ctrl+Z sépare à nouveau.`,
        ],
        true,
      );
    });
  };
  patternView.onHoleToggle = (pid, lineIndex) => {
    if (!draft) return;
    const res = toggleInternalHole(draft, pid, lineIndex);
    if (!res.ok) {
      showToast(res.reason);
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        res.holed
          ? [
              'Pièce ÉVIDÉE — la zone est un TROU : découpée du maillage 3D, imprimée en trait de coupe PLEIN aux exports.',
              'Re-clic au ⌾ dessus pour la reboucher (elle redevient ligne de style) · Ctrl+Z annule.',
            ]
          : [
              'Trou REBOUCHÉ — la forme redevient une ligne de style (pointillés, aucune découpe).',
              'Ctrl+Z annule.',
            ],
        true,
      );
    });
  };
  /** Scinder le long d'une ligne interne — partagé entre le clic ✂ au plan
   * et le « Scinder maintenant ? » qui suit un tracé ✎3D. */
  const splitAlongInternalLine = (pid: number, lineIndex: number): void => {
    if (!draft) return;
    const res = cutPieceAlongInternalLine(draft, pid, lineIndex);
    if (!res.ok) {
      showToast(res.reason);
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        [
          'Pièce SCINDÉE le long de la ligne interne — extrémités prolongées jusqu’au contour, la couture suit tout le tracé.',
          'Empiècement courbe en un geste : les deux moitiés recousent exactement le long du chemin · Ctrl+Z annule.',
        ],
        true,
      );
    });
  };
  patternView.onCutAlongInternalLine = (pid, lineIndex) => splitAlongInternalLine(pid, lineIndex);
  patternView.onRoundCorner = (pid, vertex, radiusM) => {
    if (!draft) return;
    const res = roundOutlineCorner(draft, pid, vertex, radiusM);
    if (!res.ok || !res.doc) {
      showToast(res.reason ?? 'Arrondi impossible sur ce sommet.');
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const label = draftPieceLabel(draftPieceAt(pid), pid);
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        [
          `Sommet ARRONDI sur « ${label} » — rayon ${(res.radiusM! * 100).toFixed(1).replace('.', ',')} cm.`,
          'Le coin est devenu un arc à vrais sommets : coutures ré-indexées, points réglables un à un · Ctrl+Z rend le coin.',
        ],
        true,
      );
    });
  };
  patternView.onFisheyeDart = (pid, top, bottom, halfWidthM) => {
    if (!draft) return;
    const res = addFisheyeDart(draft, pid, top, bottom, halfWidthM);
    if (!res.ok || !res.doc) {
      showToast(res.reason ?? 'Pince losange impossible ici.');
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const label = draftPieceLabel(draftPieceAt(pid), pid);
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        [
          `Pince LOSANGE posée sur « ${label} » — ${(res.widthM! * 100).toFixed(1).replace('.', ',')} cm de taille × ${(res.heightM! * 100).toFixed(1).replace('.', ',')} cm pointe à pointe.`,
          'Lancez ▶ l’essayage : le losange se coud fermé et cintre le tissu · les 6 poignées restent réglables · Ctrl+Z retire.',
        ],
        true,
      );
    });
  };
  patternView.onInternalLineDelete = (pid, index) => {
    if (!draft) return;
    const piece = draftPieceAt(pid);
    if (!piece?.internalLines?.[index]) return;
    pushHistory();
    const next = structuredClone(piece);
    next.internalLines = next.internalLines!.filter((_, i) => i !== index);
    if (!next.internalLines.length) delete next.internalLines;
    replaceDraftPiece(pid, next);
    draftTouched = true;
    refreshPatternDoc();
    showToast('Ligne interne supprimée · Ctrl+Z la rend.');
  };
  // 🪡 COUDRE guidé : bascule le mode « deux clics = une couture ». Les deux
  // clics marchent en 2D (le pied du plan guide) ET en 3D (près des bords,
  // directement sur les pièces autour de l'avatar) — le grand plan ne s'ouvre
  // plus d'office pour laisser la 3D visible. Maj+clic reste le raccourci 2D.
  (document.getElementById('at-sew') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleSew();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    document.getElementById('at-length')?.classList.remove('active');
    document.getElementById('at-snap')?.classList.remove('active');
    document.getElementById('at-link')?.classList.remove('active');
    syncAtelierControls();
    refreshHint(); // l'aide guide la couture pendant que 🪡 est armé
  });
  // ⚡ FERMETURE ÉCLAIR : même sélection guidée à deux bords que la couture,
  // mais le lien reste identifiable et pourra être simulé ouvert ou fermé.
  (document.getElementById('at-zipper') as HTMLElement).addEventListener(
    'click',
    (e) => {
      const on = patternView.toggleZipper();
      (e.currentTarget as HTMLElement).classList.toggle('active', on);
      syncAtelierControls();
      refreshHint();
    },
  );
  // ↔ LONGUEUR : glisser directement un segment, contraint sur son axe. Le
  // point le plus proche suit la souris, l'autre reste fixe ; la cote vit en cm.
  (document.getElementById('at-length') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleLength();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    document.getElementById('at-snap')?.classList.toggle('active', patternView.lengthSnapping);
    document.getElementById('at-sew')?.classList.remove('active');
    document.getElementById('at-link')?.classList.remove('active');
    syncAtelierControls();
    refreshHint();
  });
  // 🧲 AJUSTER AUTO : option de magnétisme du mode longueur. Elle ne fait
  // rien à distance ; dans la zone proche, le glisser devient exactement 1:1
  // avec la couture ou le bord parallèle, et rectifie parallèle/angle droit.
  (document.getElementById('at-snap') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleLengthSnap();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    document.getElementById('at-length')?.classList.toggle('active', patternView.lengthEditing);
    document.getElementById('at-sew')?.classList.remove('active');
    document.getElementById('at-link')?.classList.remove('active');
    syncAtelierControls();
    refreshHint();
  });
  // 🔗 MARIER : deux clics créent une contrainte d'édition persistante. Cliquer
  // un bord déjà lié le dissocie ; ce lien ne crée aucune couture physique.
  (document.getElementById('at-link') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleSegmentLink();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    document.getElementById('at-length')?.classList.remove('active');
    document.getElementById('at-snap')?.classList.remove('active');
    document.getElementById('at-sew')?.classList.remove('active');
    syncAtelierControls();
    refreshHint();
  });
  // 🧵 COUTURE LIBRE (façon Clo « Free Sewing ») : tracer un run QUELCONQUE du
  // contour (départ/fin mi-bord permis, coins passés), puis le run partenaire —
  // les points d'accord s'insèrent tout seuls, la couture se pose (Draft.ts).
  (document.getElementById('at-sew-free') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleFreeSew();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  patternView.onFreeSeam = (a, b) => {
    if (!draft) return;
    const res = freeSeamBetween(draft, a, b);
    if (import.meta.env.DEV) {
      console.debug('[toile] couture libre', { a, b, ok: res.ok, reason: res.ok ? undefined : res.reason });
    }
    if (!res.ok) {
      showToast(res.reason);
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const cmA = Math.round(res.lengthAM * 100);
    const cmB = Math.round(res.lengthBM * 100);
    const ratio = Math.max(res.lengthAM, res.lengthBM) / (Math.min(res.lengthAM, res.lengthBM) || 1);
    const notes = [`Couture libre posée — ${cmA} cm ↔ ${cmB} cm.`];
    if (ratio >= 1.12) {
      notes.push(`Embu ×${ratio.toFixed(2).replace('.', ',')} : le bord long froncera sur le court à l'essayage.`);
    } else {
      notes.push('Lancez ▶ l’essayage pour voir l’assemblage.');
    }
    // Le build asynchrone repeint le statut à sa fin — poser le message APRÈS.
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(notes, true);
    });
    syncAtelierControls();
    refreshHint();
  };
  // ✂ COUPER & COUDRE : deux clics sur le contour d'une pièce — elle se scinde
  // le long de la corde et la couture d'assemblage se pose toute seule. Les
  // coutures traversées reçoivent un point d'accord sur leur bord partenaire.
  (document.getElementById('at-cut') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleCut();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  patternView.onCutPiece = (pid, a, b) => {
    if (!draft) return;
    pushHistory();
    const res = cutPieceAlongChord(draft, pid, a, b);
    if (!res.ok) {
      draftHistory.pop(); // rien n'a changé : pas de cran d'annulation fantôme
      syncUndoButton();
      showToast(res.reason);
      syncAtelierControls();
      refreshHint();
      return;
    }
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const cutLabel = draftPieceLabel(docPieces(draft)[res.newPieceId] ?? null, res.newPieceId);
    const notes: string[] = [
      `Pièce scindée — la couture est posée le long de la découpe (« ${cutLabel} »).`,
      'Chaque moitié a maintenant son propre tissu : un clic sur une moitié, puis « Tissu de la sélection ».',
    ];
    if (res.splitSeams) notes.push(`${res.splitSeams} couture(s) traversée(s) : point d'accord posé sur le bord partenaire.`);
    if (res.droppedLinks) notes.push(`${res.droppedLinks} lien(s)/couture(s) non transposables ont été défaits — recousez si besoin.`);
    showPlacementStatus(notes, true);
    syncAtelierControls();
    refreshHint();
  };
  // ⧎ MIROIR COUSU : un clic sur le bord-axe d'une pièce — la jumelle
  // symétrique apparaît, cousue le long de l'axe (mirrorDuplicatePiece).
  (document.getElementById('at-mirror') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.toggleMirror();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    syncAtelierControls();
    refreshHint();
  });
  // ⌒ MANCHE ADAPTÉE : mesurer chaque emmanchure LIBRE du corps et générer la
  // manche à la cote (tête = tour du run ouvert, naissance à sa hauteur
  // réelle). Les côtés déjà pourvus sont laissés ; moteur d'abord, refus doux.
  (document.getElementById('at-sleeve-fit') as HTMLElement | null)?.addEventListener('click', () => {
    if (!draft) {
      showToast('Chargez un modèle ou dessinez un corps d’abord.');
      return;
    }
    const res = generateFittedSleeves(draft);
    if (!res.ok || !res.doc) {
      showToast(res.reason ?? 'Manche adaptée impossible ici.');
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const parts = (res.created ?? []).map(
      (c) => `${c.side === 'R' ? 'droite' : 'gauche'} ${(c.capM * 100).toFixed(1).replace('.', ',')} cm`,
    );
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        [
          `Manche${parts.length > 1 ? 's' : ''} générée${parts.length > 1 ? 's' : ''} À LA COTE de l'emmanchure : ${parts.join(' · ')}.`,
          'Tube posé et épinglé automatiquement · ↔ Longueur règle la longueur · Ctrl+Z retire.',
        ],
        true,
      );
    });
  });
  patternView.onMirrorPiece = (pid, axisEdge) => {
    if (!draft) return;
    const res = mirrorDuplicatePiece(draft, pid, axisEdge);
    if (import.meta.env.DEV) {
      console.debug('[toile] miroir cousu', { pid, axisEdge, ok: res.ok });
    }
    if (!res.ok) {
      showToast(res.reason);
      syncAtelierControls();
      refreshHint();
      return;
    }
    pushHistory();
    draft = res.doc;
    draftTouched = true;
    teePreset = false;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    const pieces = docPieces(draft);
    const twinLabel = draftPieceLabel(pieces[res.newPieceId] ?? null, res.newPieceId);
    void lifecycle.whenIdle().then(() => {
      showPlacementStatus(
        [
          `Pièce dupliquée en MIROIR (« ${twinLabel} ») — cousue le long de l'axe cliqué.`,
          'Lancez ▶ l’essayage : la paire se déplie le long de la couture. Ctrl+Z retire la jumelle.',
        ],
        true,
      );
    });
    syncAtelierControls();
    refreshHint();
  };
  // ⇱ OFFSET DU CONTOUR : décaler toute la pièce d'une distance uniforme —
  // aisance vers l'extérieur, doublure vers l'intérieur (offsetPieceOutline).
  const offsetChooser = document.getElementById('offset-chooser') as HTMLElement;
  const offsetTargetLabel = document.getElementById('offset-target-label') as HTMLElement;
  const closeOffsetChooser = (): void => {
    offsetChooser.hidden = true;
    document.getElementById('at-offset')?.classList.remove('active');
  };
  (document.getElementById('at-offset') as HTMLElement).addEventListener('click', (e) => {
    if (!offsetChooser.hidden) {
      closeOffsetChooser();
      refreshHint();
      return;
    }
    const ids = selectedFabricPieceIds();
    if (!draft || !ids.length) {
      showToast('Sélectionnez d’abord une pièce — un clic dessus suffit.');
      return;
    }
    deactivateEditingTools();
    const pieces = docPieces(draft);
    offsetTargetLabel.textContent =
      ids.length > 1
        ? `${ids.length} pièces sélectionnées`
        : `« ${draftPieceLabel(pieces[ids[0]!] ?? null, ids[0]!)} »`;
    offsetChooser.hidden = false;
    (e.currentTarget as HTMLElement).classList.add('active');
    refreshHint();
  });
  offsetChooser.querySelectorAll<HTMLButtonElement>('button[data-offset-cm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!draft) return;
      const cm = Number(btn.dataset.offsetCm) || 0;
      const ids = selectedFabricPieceIds();
      closeOffsetChooser();
      if (!cm || !ids.length) return;
      pushHistory();
      let applied = 0;
      let firstRefusal: string | null = null;
      for (const pid of ids) {
        const res = offsetPieceOutline(draft, pid, cm / 100);
        if (res.ok && res.doc) {
          draft = res.doc;
          applied++;
        } else if (!firstRefusal) {
          firstRefusal = res.reason ?? 'Offset impossible sur une pièce.';
        }
      }
      if (!applied) {
        draftHistory.pop();
        syncUndoButton();
        showToast(firstRefusal ?? 'Offset impossible ici.');
        syncAtelierControls();
        refreshHint();
        return;
      }
      draftTouched = true;
      teePreset = false;
      atelierDesign = true;
      simBtn().classList.remove('running');
      build();
      const shown = `${cm > 0 ? '+' : '−'}${String(Math.abs(cm)).replace('.', ',')} cm`;
      const notes = [
        `Contour décalé de ${shown} sur ${applied} pièce${applied > 1 ? 's' : ''} — coutures et repères préservés.`,
        cm > 0
          ? 'L’aisance ajoutée se voit à l’essayage ; l’embu des coutures suit les nouvelles longueurs.'
          : 'La pièce rétrécie loge sous l’originale — le geste doublure.',
      ];
      if (firstRefusal) notes.push(`Certaines pièces ont refusé : ${firstRefusal}`);
      void lifecycle.whenIdle().then(() => {
        showPlacementStatus(notes, true);
      });
      syncAtelierControls();
      refreshHint();
    });
  });
  (document.getElementById('offset-cancel') as HTMLElement).addEventListener('click', () => {
    closeOffsetChooser();
    refreshHint();
  });
  // 〰 FRONCES : cliquer une couture ouvre le choix du côté + ratio ; le bord
  // choisi est recoupé plus long (l'embu), l'essayage fronce naturellement.
  const gatherChooser = document.getElementById('gather-chooser') as HTMLElement;
  let gatherSeamIndex: number | null = null;
  const closeGatherChooser = (): void => {
    gatherChooser.hidden = true;
    gatherSeamIndex = null;
  };
  (document.getElementById('at-gather') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleGather();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    if (!on) closeGatherChooser();
    syncAtelierControls();
    refreshHint();
  });
  patternView.onGatherSeam = (seamIndex) => {
    if (!draft?.seams?.[seamIndex]) return;
    const seam = draft.seams[seamIndex]!;
    if (seam.kind === 'zipper') {
      showToast('On ne fronce pas une fermeture éclair.');
      return;
    }
    gatherSeamIndex = seamIndex;
    const pieces = docPieces(draft);
    const labelOf = (run: { pieceId?: number; face?: 'front' | 'back' }): string => {
      const pid = pieceIdOf(run as Parameters<typeof pieceIdOf>[0]);
      return draftPieceLabel(pieces[pid] ?? null, pid);
    };
    (document.getElementById('gather-side-a-label') as HTMLElement).textContent = labelOf(seam.a);
    (document.getElementById('gather-side-b-label') as HTMLElement).textContent = labelOf(seam.b);
    gatherChooser.hidden = false;
  };
  gatherChooser.querySelectorAll<HTMLButtonElement>('button[data-gather-side]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (gatherSeamIndex === null || !draft) return;
      const side = btn.dataset.gatherSide === 'b' ? 'b' : 'a';
      const ratio = Number(btn.dataset.gatherRatio) || 1.5;
      const seamIndex = gatherSeamIndex;
      closeGatherChooser();
      if (patternView.gathering) patternView.toggleGather();
      pushHistory();
      const res = gatherSeamSide(draft, seamIndex, side, ratio);
      if (import.meta.env.DEV) {
        console.debug('[toile] fronces', { seamIndex, side, ratio, ok: res.ok, achieved: res.achievedRatio, reason: res.reason });
      }
      if (!res.ok || !res.doc) {
        draftHistory.pop();
        syncUndoButton();
        showToast(res.reason ?? 'Fronces impossibles ici.');
        syncAtelierControls();
        refreshHint();
        return;
      }
      draft = res.doc;
      draftTouched = true;
      teePreset = false;
      atelierDesign = true;
      simBtn().classList.remove('running');
      build();
      const shown = (res.achievedRatio ?? ratio).toFixed(2).replace('.', ',');
      // Le build est asynchrone et repeint le statut à sa fin — poser le
      // message APRÈS la stabilisation pour qu'il reste lisible.
      void lifecycle.whenIdle().then(() => {
        showPlacementStatus(
          [
            `Fronces ×${shown} posées — le bord a été recoupé plus long (l’embu du tailleur).`,
            'Lancez ▶ l’essayage : le tissu fronce le long de cette couture.',
          ],
          true,
        );
      });
      syncAtelierControls();
      refreshHint();
    });
  });
  (document.getElementById('gather-cancel') as HTMLElement).addEventListener('click', () => {
    closeGatherChooser();
    if (patternView.gathering) patternView.toggleGather();
    syncAtelierControls();
    refreshHint();
  });
  // ⌁ DISTANCE ENTRE PARTICULES : le pas du maillage d'essayage, en mm réels.
  (document.getElementById('at-particles') as HTMLSelectElement).addEventListener('change', (e) => {
    applyResolution(Number((e.currentTarget as HTMLSelectElement).value));
  });
  // − PIÈCE : supprime la pièce active (cliquer d'abord sa colonne) — Ctrl+Z annule.
  (document.getElementById('at-del') as HTMLElement).addEventListener('click', () => {
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // les indices bougent : le placement en attente saute
    patternView.deleteActiveFreePiece();
  });
  (document.getElementById('at-pen') as HTMLElement).addEventListener('click', () => patternView.finishPen());
  // ⋈ MIROIR AU TRACÉ : préférence collante de la plume — le 1er point pose
  // l'axe vertical, la moitié dessinée s'échoit en direct, la fermeture donne
  // la pièce symétrique ENTIÈRE. L'armer hors tracé arme aussi la plume.
  // ⛶ CROQUIS SUR LE CORPS : bouton du panneau VUE 3D — exclusif avec tous.
  (document.getElementById('at-sketch3d') as HTMLElement | null)?.addEventListener('click', (e) => {
    sketch3dMode = !sketch3dMode;
    if (!sketch3dMode) clearSketch3d();
    if (sketch3dMode) {
      // Fonctionne depuis la PAGE BLANCHE : le doc devient le socle vide dès
      // l'armement (l'aperçu du tracé vit sur l'overlay, qui exige un draft) —
      // sans draftTouched, le mannequin nu reste la toile de fond.
      if (!atelierEmptyState.hidden || !draft) {
        draft = blankBaseDraft(resolution as 32 | 64 | 128);
        patternView.setDraft(draft.piece, draft.back ?? null, []);
        patternView.setAssembly([]);
        patternView.setSegmentLinks([]);
      }
      move3DEnabled = false;
      gizmoPick = null;
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
      draw3dMode = false;
      clearDraw3d();
      edit3dMode = false;
      clearEdit3d();
      pieceHoverDirty = true;
      setPieceHover(null);
    }
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(sketch3dMode));
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    setPressed('at-draw3d', draw3dMode);
    setPressed('at-edit3d', edit3dMode);
    setPressed('at-sketch3d', sketch3dMode);
    showPlacementStatus(
      sketch3dMode
        ? [
            'Croquis SUR LE CORPS : placez-vous de face et cliquez des points sur le mannequin — la zone fermée deviendra une pièce du patron.',
            `Re-clic sur le 1er point = fermer et placer · sur le dernier = retirer le point · ⋈ Miroir au tracé ${patternView.penMirroring ? 'ACTIF : dessinez une moitié, l’axe du corps symétrise' : 'peut symétriser sur l’axe du corps'} · Échap annule.`,
          ]
        : ['Croquis sur le corps désactivé.'],
      true,
    );
    refreshHint();
  });
  // ⬦ ÉDITER LE CONTOUR : bouton du panneau VUE 3D — exclusif avec ✥/⊹/✎.
  (document.getElementById('at-edit3d') as HTMLElement | null)?.addEventListener('click', (e) => {
    edit3dMode = !edit3dMode;
    if (!edit3dMode) clearEdit3d();
    if (edit3dMode) {
      if (!atelierDesign) enterDesign();
      move3DEnabled = false;
      gizmoPick = null;
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
      draw3dMode = false;
      clearDraw3d();
      sketch3dMode = false;
      clearSketch3d();
      setPressed('at-sketch3d', false);
      pieceHoverDirty = true;
      setPieceHover(null);
    }
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(edit3dMode));
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    setPressed('at-draw3d', draw3dMode);
    setPressed('at-edit3d', edit3dMode);
    showPlacementStatus(
      edit3dMode
        ? [
            'Édition du contour EN 3D : les sommets du patron s’allument sur le tissu — tirez-en un, il suit sur le plan de sa pièce.',
            'Relâchez : le patron 2D suit, les coutures recousent aux nouvelles longueurs · Ctrl+Z annule.',
          ]
        : ['Édition du contour 3D désactivée.'],
      true,
    );
    refreshHint();
  });
  // ✎3D : bouton du panneau VUE 3D — exclusif avec ✥ et ⊹.
  (document.getElementById('at-draw3d') as HTMLElement | null)?.addEventListener('click', (e) => {
    draw3dMode = !draw3dMode;
    if (!draw3dMode) clearDraw3d();
    if (draw3dMode) {
      if (!atelierDesign) enterDesign();
      move3DEnabled = false;
      gizmoPick = null;
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
      edit3dMode = false;
      clearEdit3d();
      setPressed('at-edit3d', false);
      sketch3dMode = false;
      clearSketch3d();
      setPressed('at-sketch3d', false);
      pieceHoverDirty = true;
      setPieceHover(null);
    }
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(draw3dMode));
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-arrange', arrangeMode);
    setPressed('at-draw3d', draw3dMode);
    showPlacementStatus(
      draw3dMode
        ? [
            'Dessin SUR LE TISSU actif : cliquez des points sur une pièce de la préparation 3D.',
            'Re-clic sur le 1er point = polygone fermé · sur le dernier = polyligne · le tracé retombe en ligne interne du patron, scindable au ✂.',
          ]
        : ['Dessin sur le tissu désactivé.'],
      true,
    );
    refreshHint();
  });
  (document.getElementById('at-mirror-draw') as HTMLElement | null)?.addEventListener('click', (e) => {
    const on = patternView.togglePenMirror();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
    if (on && !patternView.drawing) document.getElementById('at-piece')?.click();
    showToast(
      on
        ? 'Miroir au tracé ACTIF : le 1er point pose l’axe — dessinez UNE moitié, l’autre s’écrit toute seule.'
        : 'Miroir au tracé désactivé : la plume redevient libre.',
    );
    syncAtelierControls();
    refreshHint();
  });
  // ⌖ RANGER : réinitialiser l'arrangement 2D — les pièces déplacées dans le
  // plan retrouvent leurs colonnes (état de vue pur, rien d'autre ne bouge).
  (document.getElementById('at-reset2d') as HTMLElement | null)?.addEventListener('click', () => {
    const moved = patternView.resetLayoutArrangement();
    showToast(
      moved
        ? `Arrangement 2D réinitialisé — ${moved} pièce${moved > 1 ? 's' : ''} rangée${moved > 1 ? 's' : ''} dans ${moved > 1 ? 'leurs colonnes' : 'sa colonne'}.`
        : 'Le plan est déjà rangé.',
    );
  });
  (document.getElementById('at-sim') as HTMLElement).addEventListener('click', () => {
    if (atelierDesign) {
      // La VÉRITÉ, pas son miroir : `atelierEmptyState.hidden` n'est
      // resynchronisé (refreshHint) qu'à l'atterrissage du rebuild ASYNCHRONE.
      // Au boot vierge, le Brief charge un archétype PUIS clique ici dans la
      // même rafale — le miroir disait encore « vide » et l'essayage était
      // avalé avec un toast (course observée sur les validations v193/v194).
      // On recalcule donc la formule de refreshHint sur l'état vivant.
      const emptyAtelier =
        sceneMode === 'atelier' && !draftTouched && !patternView.drawing;
      if (emptyAtelier) {
        showToast('Commencez par choisir un modèle ou tracer une pièce.');
        return;
      }
      // Le hoodie s'enfile bras baissés (v218). En pose T native, ses panneaux
      // s'échouent SUR les bras horizontaux et les coutures d'épaules ne se
      // ferment jamais — cause trouvée par bissection : le « vrai T » de Mia
      // (v187-v190) n'a jamais été re-réglé pour le hoodie (v137). Vérifié en
      // live : le même code s'assemble correctement en « Bras 45° ». On habille
      // donc à 45° automatiquement — comme on enfile une veste — uniquement si
      // la pose est réellement disponible ; sinon, comportement inchangé.
      const scanForPose = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
      const hoodieInT =
        draft?.preset === 'lucas-hoodie' &&
        bodyPose === 'native' &&
        isNeutral(morphs) &&
        scanForPose !== null &&
        scanHasCollisionPose(scanForPose, 'a-pose');
      if (hoodieInT) {
        showToast('Hoodie : habillage bras à 45° — les coutures d’épaules se ferment mieux bras baissés.');
        void applyPose('a-pose').then(() => simulate());
        return;
      }
      simulate();
    } else {
      if (!bigPanel) setBig(true);
      enterDesign();
    }
  });
  const profiler = new GpuProfiler(device);

  // Fabric params kept across rebuilds (a resolution change recreates the sim).
  const initialFabric = FABRIC_PHYSICS.Jersey!;
  let compliance: FabricCompliance = {
    stretch: initialFabric.stretch,
    stretchWarp: initialFabric.stretchWarp,
    shear: initialFabric.shear,
    bend: initialFabric.bend,
    bendWarp: initialFabric.bendWarp,
    stretchLimit: initialFabric.stretchLimit,
    shearLimit: initialFabric.shearLimit,
  };
  let fabricDynamics: FabricDynamics = {
    arealDensity: initialFabric.arealDensity,
    collisionThickness: initialFabric.collisionThickness,
    damping: initialFabric.damping,
    airDrag: initialFabric.airDrag,
    frictionStatic: initialFabric.frictionStatic,
    frictionDynamic: initialFabric.frictionDynamic,
    creaseYieldDeg: initialFabric.creaseYieldDeg,
    creaseMemory: initialFabric.creaseMemory,
    creaseRecovery: initialFabric.creaseRecovery,
  };
  let fabricStyle = DEFAULT_FABRIC;
  let globalFabricPreset: GlobalFabricPreset = 'Jersey';
  let fitMap = false; // tension view: survives rebuilds so it isn't lost on a slider (M29)
  // L'ATELIER est le visage du logiciel : TOILE ouvre directement sur l'espace
  // de conception (Conception 2D), pas sur une démo physique. Les scènes moteur
  // (drapé, couture, robe…) restent joignables via le sélecteur de scène du
  // panneau Réglages. Boot atelier câblé plus bas (setBig avant buildNow).
  let sceneMode: SceneMode = 'atelier';
  // Bitmaps des graphiques de pièce, décodés une fois par data URL (les
  // rebuilds réutilisent ; un décodage raté est mémorisé null, sans re-tenter).
  const graphicBitmapCache = new Map<string, ImageBitmap | null>();
  const graphicBitmap = async (dataUrl: string): Promise<ImageBitmap | null> => {
    const cached = graphicBitmapCache.get(dataUrl);
    if (cached !== undefined) return cached;
    let bitmap: ImageBitmap | null = null;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      bitmap = await createImageBitmap(blob);
    } catch {
      bitmap = null;
    }
    graphicBitmapCache.set(dataUrl, bitmap);
    return bitmap;
  };
  let resolution: SupportedResolution = DEFAULT_RESOLUTION;
  // « Distance entre particules » (le Particle Distance de Clo) : la face
  // atelier de `resolution`. Les étiquettes affichent le pas RÉEL du maillage,
  // calculé depuis la largeur physique de la pièce de devant.
  const syncParticleSelect = (): void => {
    const select = document.getElementById('at-particles') as HTMLSelectElement | null;
    if (!select) return;
    const width = draft?.piece?.width ?? 0.95;
    const names: Record<string, string> = { '32': 'rapide', '64': 'équilibré', '128': 'fin' };
    for (const opt of Array.from(select.options)) {
      const n = Number(opt.value);
      if (!Number.isFinite(n) || n <= 1) continue;
      const mm = (width / (n - 1)) * 1000;
      const shown = mm < 10 ? mm.toFixed(1).replace('.', ',') : String(Math.round(mm));
      opt.textContent = `≈ ${shown} mm — ${names[opt.value] ?? ''}`;
    }
    select.value = String(resolution);
  };
  /** Changer de MANNEQUIN (femme/homme) : même transaction que le panneau
   * Réglages — mensurations naturelles du nouveau corps, rebuild. Utilisé par
   * le panneau ET par le choix d'avatar de la page blanche. */
  const applyBody = (kind: 'femme' | 'homme' | 'scan homme' | 'scan femme' | 'scan import'): void => {
    collisionAuditAnalyticTPose = false;
    bodyKind = kind;
    morphs = { ...NO_MORPH }; // a new body starts at ITS natural measurements
    bodyPose = 'native'; // v189 : un nouveau corps arrive en pose couture (T)
    bodyPoseCollision = null;
    syncPoseButtons();
    const naturalCm = baseCm(
      kind,
      kind.startsWith('scan') ? (scans[kind] ?? null) : null,
    );
    panel.syncMorphCm(naturalCm);
    syncAvatarStature(naturalCm.stature!);
    syncAtelierMeasures(); // v182 : les curseurs suivent le nouveau corps
    // Only rebuild where a body is actually on stage; drapé/couture keep
    // their cloth instead of resetting for an invisible change.
    if (sceneMode !== 'drapé' && sceneMode !== 'couture') {
      build();
    }
    syncEmptyAvatarButtons();
    syncGabaritButtons(); // v183 : les boutons gabarit de l'atelier suivent aussi
  };
  /** État pressé des boutons mannequin de la page blanche. */
  const syncEmptyAvatarButtons = (): void => {
    const femme = document.getElementById('at-empty-femme');
    const homme = document.getElementById('at-empty-homme');
    femme?.setAttribute('aria-pressed', String(bodyKind.includes('femme')));
    femme?.classList.toggle('active', bodyKind.includes('femme'));
    homme?.setAttribute('aria-pressed', String(bodyKind.includes('homme')));
    homme?.classList.toggle('active', bodyKind.includes('homme'));
  };
  /** Appliquer un nouveau pas de maillage : même transaction que le panneau
   * Réglages (statut de reconstruction, gridN du draft, rebuild). */
  const applyResolution = (r: number): void => {
    const nextResolution = normalizeResolution(r, resolution);
    resolution = nextResolution;
    resolutionStatus.dataset.pendingResolution = String(nextResolution);
    resolutionStatus.textContent = resolutionRebuildMessage(nextResolution);
    resolutionStatus.hidden = false;
    // Keep the persisted draft grid in sync with the sim resolution (the
    // atelier cuts on `resolution`, so a stale gridN would lie in the file).
    if (draft) draft.gridN = nextResolution;
    syncParticleSelect();
    // An option change is a real lifecycle request, even when the target
    // scene itself did not change. This starts teardown synchronously; the
    // status above remains visible until that transaction reaches idle.
    build();
  };
  let selfCollision = true;
  let wind = 0;
  let seamAllowanceM = 0.01; // seam allowance drawn on the pattern (meters)
  let liveParticleCount = 0; // kept (non-cut) particles, for the HUD (M33)
  // Import batching (M26): while an import replays its callback cascade, every
  // build() is suppressed so the ~8-9 intermediate GPU teardowns collapse into
  // a single rebuild at the end (onImportEnd).
  let buildSuspended = false;
  const linearProfile = (flare: number): number[] =>
    Array.from({ length: 6 }, (_, k) => 0.21 + (flare - 0.21) * (k / 5));
  let dressPattern = { length: 1.3, flare: 0.5, neck: 0.1, profile: linearProfile(0.5) };
  let shirtPattern = { sleeve: 0.47, profile: [0.22, 0.22, 0.22] }; // stations v=0.57/0.79/1
  const fabricSel = document.getElementById('at-fabric') as HTMLSelectElement | null;
  const gsmInput = document.getElementById('at-gsm') as HTMLInputElement | null;
  const gsmReset = document.getElementById('at-gsm-reset') as HTMLButtonElement | null;
  const gsmHelp = document.getElementById('at-gsm-help') as HTMLElement | null;
  const selectionName = document.getElementById(
    'atelier-selection-name',
  ) as HTMLElement;
  const draftPieceAt = (pid: number): DraftPiece | null => {
    if (!draft) return null;
    if (pid === 0) return draft.piece;
    if (pid === 1) return draft.back ?? draft.piece;
    return draft.pieces?.[pid - 2] ?? null;
  };
  const selectedFabricPieceIds = (): number[] => {
    const active = patternView.activeDraftPieceId;
    const selected = patternView.selectedDraftPieceIds;
    const requested = selected.includes(active) ? selected : [active];
    // Jamais le socle vide : les outils de panneau (offset, couleur, grammage)
    // ne doivent pas viser une face sentinelle invisible (audit v150-158).
    return [...new Set(requested)].filter((pieceId) => {
      const piece = draftPieceAt(pieceId);
      return !!piece && !piece.blank;
    });
  };
  const effectivePieceGsm = (piece: DraftPiece): number =>
    piece.arealDensityGsm ??
    (piece.fabricPreset
      ? FABRIC_PHYSICS[piece.fabricPreset].arealDensity
      : fabricDynamics.arealDensity) *
      1000;
  const formatGsm = (value: number): string =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value);
  const colorInput = document.getElementById('at-color') as HTMLInputElement | null;
  const colorReset = document.getElementById('at-color-reset') as HTMLButtonElement | null;
  const colorHelp = document.getElementById('at-color-help') as HTMLElement | null;
  /** Pastille du sélecteur quand aucune couleur n'est posée : la teinte 2D du
   * tissu de la pièce (mêmes valeurs que le remplissage du plan). */
  const FABRIC_SWATCH: Record<string, string> = {
    Jersey: '#ded1b8',
    Maille: '#b8736b',
    Popeline: '#edede6',
    Denim: '#3b4a73',
    Lin: '#d9ccad',
    Laine: '#858085',
    Soie: '#eddec7',
    Molleton: '#8f9490',
    Cuir: '#5a3d2b',
    Satin: '#e8ddc0',
    Twill: '#8a7d5c',
    Mousseline: '#f0ece1',
  };
  const graphicAddBtn = document.getElementById('at-graphic-add') as HTMLButtonElement | null;
  const graphicRemoveBtn = document.getElementById('at-graphic-remove') as HTMLButtonElement | null;
  const graphicFileInput = document.getElementById('at-graphic-file') as HTMLInputElement | null;
  const graphicHelp = document.getElementById('at-graphic-help') as HTMLElement | null;
  const syncPieceGraphicControl = (): void => {
    if (!graphicAddBtn || !graphicRemoveBtn || !graphicHelp) return;
    const activeId = patternView.activeDraftPieceId;
    const piece = draftPieceAt(activeId);
    const enabled = !!piece && pieceFabricSelectEnabled(sceneMode, !!piece);
    graphicAddBtn.disabled = !enabled;
    graphicRemoveBtn.disabled = !enabled || !piece?.graphic;
    graphicAddBtn.textContent = piece?.graphic ? '🖼 Remplacer le graphique' : '🖼 Poser un graphique';
    if (!piece) {
      graphicHelp.textContent = 'Sélectionnez une pièce pour poser une image.';
    } else if (piece.graphic?.repeat) {
      const wCm = Math.round(piece.graphic.widthM * 100);
      graphicHelp.textContent = `Motif répété · ${wCm} cm — glisser = phase · coin = taille · poignée haute = direction.`;
    } else if (piece.graphic) {
      const wCm = Math.round(piece.graphic.widthM * 100);
      const hCm = Math.round(piece.graphic.widthM * piece.graphic.aspect * 100);
      graphicHelp.textContent = `Graphique ${wCm} × ${hCm} cm — glissez-le sur le plan · coin = taille · poignée haute = rotation.`;
    } else {
      graphicHelp.textContent = 'PNG ou JPEG — il se drape avec le tissu à l’essayage.';
    }
  };
  /** Poser / remplacer / retirer (undefined) le graphique de la pièce `pid`. */
  const applyPieceGraphic = (pid: number, graphic: PieceGraphic | undefined, note?: string): void => {
    if (!draft || !draftPieceAt(pid)) return;
    pushHistory();
    if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
    const next = structuredClone(draftPieceAt(pid)!);
    if (graphic) next.graphic = graphic;
    else delete next.graphic;
    replaceDraftPiece(pid, next);
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    if (note) {
      showPlacementStatus([note, 'Lancez ▶ l’essayage : le graphique se drape avec le tissu.'], true);
    }
    syncPieceGraphicControl();
  };
  /** Tuile de motif 512² PÉRIODIQUE, fond transparent, dessinée dans l'encre
   * donnée — rayures, vichy, pois (en quinconce), damier. */
  const motifTile = (kind: string, ink: string): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d')!;
    g.fillStyle = ink;
    if (kind === 'rayures') {
      g.fillRect(0, 0, 256, 512);
    } else if (kind === 'vichy') {
      g.globalAlpha = 0.45;
      g.fillRect(0, 0, 256, 512);
      g.fillRect(0, 0, 512, 256);
      g.globalAlpha = 1;
    } else if (kind === 'pois') {
      for (const [cx, cy] of [[128, 128], [384, 384]] as const) {
        g.beginPath();
        g.arc(cx, cy, 88, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      g.fillRect(0, 0, 256, 256);
      g.fillRect(256, 256, 256, 256);
    }
    return c;
  };
  /** Poser un MOTIF intégré (répété) sur la pièce active, encre = nuancier. */
  const applyBuiltinMotif = (kind: string): void => {
    const pid = patternView.activeDraftPieceId;
    const piece = draftPieceAt(pid);
    if (!draft || !piece) return;
    if (piece.blank) {
      showToast('Dessinez d’abord une pièce — le motif se pose sur une pièce du patron.');
      return;
    }
    const ink = colorInput && /^#[0-9a-f]{6}$/i.test(colorInput.value) ? colorInput.value : '#2b2b33';
    const image = motifTile(kind, ink).toDataURL('image/png');
    if (image.length > GRAPHIC_IMAGE_MAX_CHARS) {
      showToast('Motif trop lourd — réessayez.');
      return;
    }
    const existing = piece.graphic;
    const graphic: PieceGraphic = {
      image,
      anchor: existing?.repeat ? [existing.anchor[0], existing.anchor[1]] : [0.5, 0.5],
      widthM: existing?.repeat ? existing.widthM : 0.05,
      aspect: 1,
      rotationRad: existing?.repeat ? existing.rotationRad : 0,
      repeat: true,
    };
    applyPieceGraphic(
      pid,
      graphic,
      `Motif « ${kind} » posé sur « ${draftPieceLabel(piece, pid)} » (répétition ${Math.round(graphic.widthM * 100)} cm, encre ${ink}) — poignées : phase, taille, direction.`,
    );
  };
  /** Le prochain fichier importé devient un MOTIF répété (panneau ▦). */
  let importAsRepeat = false;
  const importGraphicFile = async (file: File): Promise<void> => {
    const pid = patternView.activeDraftPieceId;
    const piece = draftPieceAt(pid);
    if (!draft || !piece) return;
    if (piece.blank) {
      showToast('Dessinez d’abord une pièce — le graphique se pose sur une pièce du patron.');
      return;
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      showToast('Image illisible — un PNG ou un JPEG.');
      return;
    }
    // Réduction : ≤512 px de côté, puis 256 si le data URL dépasse le budget
    // du document (l'image voyage DANS le patron sauvegardé).
    const encode = (maxSide: number): string => {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    };
    let image = encode(512);
    if (image.length > GRAPHIC_IMAGE_MAX_CHARS) image = encode(256);
    if (image.length > GRAPHIC_IMAGE_MAX_CHARS) {
      showToast('Image trop lourde même réduite — simplifiez-la (PNG à fonds transparents).');
      return;
    }
    const aspect = bitmap.height / Math.max(1, bitmap.width);
    const existing = piece.graphic;
    const asRepeat = importAsRepeat;
    importAsRepeat = false;
    const graphic: PieceGraphic = {
      image,
      // Remplacement : l'image change, la pose (ancre/taille/rotation) reste.
      anchor: existing ? [existing.anchor[0], existing.anchor[1]] : asRepeat ? [0.5, 0.5] : [0.5, 0.4],
      widthM: existing?.widthM ?? (asRepeat ? 0.08 : Math.min(0.18, piece.width * 0.45)),
      aspect,
      rotationRad: existing?.rotationRad ?? 0,
      ...(asRepeat ? { repeat: true } : {}),
    };
    const wCm = Math.round(graphic.widthM * 100);
    applyPieceGraphic(
      pid,
      graphic,
      asRepeat
        ? `Motif répété posé (répétition ${wCm} cm) sur « ${draftPieceLabel(piece, pid)} » — poignées : phase, taille, direction.`
        : `Graphique posé (${wCm} cm de large) sur « ${draftPieceLabel(piece, pid)} » — glissez-le sur le plan 2D pour l'ajuster.`,
    );
  };
  graphicAddBtn?.addEventListener('click', () => graphicFileInput?.click());
  graphicFileInput?.addEventListener('change', () => {
    const file = graphicFileInput.files?.[0];
    graphicFileInput.value = '';
    if (file) void importGraphicFile(file);
  });
  graphicRemoveBtn?.addEventListener('click', () => {
    const pid = patternView.activeDraftPieceId;
    if (draftPieceAt(pid)?.graphic) {
      applyPieceGraphic(pid, undefined, 'Graphique retiré — la pièce revient au tissu nu.');
    }
  });
  patternView.onGraphicChange = (pid, graphic) => {
    if (draftPieceAt(pid)?.graphic) applyPieceGraphic(pid, graphic);
  };
  // ▦ MOTIF DE LA PIÈCE : bibliothèque intégrée (encre = nuancier) ou image
  // répétée — même pipeline que le graphique, avec repeat: true.
  const motifChooser = document.getElementById('motif-chooser') as HTMLElement | null;
  const closeMotifChooser = (): void => {
    if (motifChooser) motifChooser.hidden = true;
    document.getElementById('at-motif')?.classList.remove('active');
  };
  (document.getElementById('at-motif') as HTMLElement | null)?.addEventListener('click', (e) => {
    if (!motifChooser) return;
    if (!motifChooser.hidden) {
      closeMotifChooser();
      return;
    }
    const piece = draftPieceAt(patternView.activeDraftPieceId);
    if (!draft || !piece) {
      showToast('Sélectionnez d’abord une pièce — un clic dessus suffit.');
      return;
    }
    motifChooser.hidden = false;
    (e.currentTarget as HTMLElement).classList.add('active');
  });
  motifChooser?.querySelectorAll<HTMLButtonElement>('button[data-motif]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeMotifChooser();
      applyBuiltinMotif(btn.dataset.motif ?? 'rayures');
    });
  });
  (document.getElementById('motif-image') as HTMLElement | null)?.addEventListener('click', () => {
    closeMotifChooser();
    importAsRepeat = true;
    graphicFileInput?.click();
  });
  (document.getElementById('motif-cancel') as HTMLElement | null)?.addEventListener('click', closeMotifChooser);
  const syncPieceColorControl = (): void => {
    if (!colorInput || !colorReset || !colorHelp) return;
    const activeId = patternView.activeDraftPieceId;
    const activePiece = draftPieceAt(activeId);
    const ids = selectedFabricPieceIds();
    const pieces = ids.map((pid) => draftPieceAt(pid)!).filter(Boolean);
    const enabled = pieces.length > 0 && pieceFabricSelectEnabled(sceneMode, !!activePiece);
    colorInput.disabled = !enabled;
    colorReset.disabled = !enabled || pieces.every((piece) => !piece.color);
    const colors = pieces.map((piece) => piece.color);
    const first = colors[0];
    const mixed = colors.some((value) => value !== first);
    colorInput.value =
      !mixed && first
        ? first
        : (activePiece?.fabricPreset && FABRIC_SWATCH[activePiece.fabricPreset]) || '#ded1b8';
    colorHelp.textContent = !pieces.length
      ? 'Sélectionnez une pièce pour la colorer.'
      : mixed
        ? `Couleurs différentes · ${ids.length} pièces — en choisir une l'applique à toutes.`
        : first
          ? `Couleur posée · ${first}${ids.length > 1 ? ` · ${ids.length} pièces` : ''}`
          : 'Le tissu décide de la couleur.';
  };
  const applyPieceColor = (color: string | undefined): void => {
    if (!draft) return;
    const ids = selectedFabricPieceIds();
    if (!ids.length) return;
    const already = ids.every((pid) => draftPieceAt(pid)?.color === color);
    if (already) {
      syncPieceColorControl();
      return;
    }
    pushHistory();
    if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
    for (const pid of ids) {
      const next = structuredClone(draftPieceAt(pid)!);
      if (color) next.color = color;
      else delete next.color;
      replaceDraftPiece(pid, next);
    }
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    showPlacementStatus(
      [
        color
          ? `${ids.length} pièce${ids.length > 1 ? 's' : ''} habillée${ids.length > 1 ? 's' : ''} en ${color} — le tissu garde sa physique et son grain.`
          : `Couleur retirée sur ${ids.length} pièce${ids.length > 1 ? 's' : ''} : le tissu décide à nouveau du rendu.`,
        'Le plan 2D teinte la pièce ; lancez ▶ l’essayage pour le colorblock en 3D.',
      ],
      true,
    );
    syncPieceColorControl();
  };
  const syncPieceFabricSelect = (): void => {
    syncPieceColorControl();
    syncPieceGraphicControl();
    if (!fabricSel) return;
    const activeId = patternView.activeDraftPieceId;
    const piece = draftPieceAt(activeId);
    const selected = selectedFabricPieceIds();
    const inheritOption = Array.from(fabricSel.options).find(
      (option) => option.value === GLOBAL_FABRIC_INHERIT_VALUE,
    );
    if (inheritOption) {
      inheritOption.textContent = inheritedFabricLabel(globalFabricPreset);
    }
    fabricSel.dataset.globalPreset = globalFabricPreset;
    // A draft can persist while another scene is mounted. Keep its hidden
    // toolbar select non-interactive so no orphan control can mutate that draft.
    fabricSel.disabled = !pieceFabricSelectEnabled(sceneMode, !!piece && !piece.blank);
    selectionName.textContent =
      selected.length > 1
        ? `${selected.length} pièces sélectionnées`
        : draftPieceLabel(piece, activeId);
    fabricSel.value = piece?.fabricPreset ?? GLOBAL_FABRIC_INHERIT_VALUE;
    fabricSel.title = piece
      ? `${draftPieceLabel(piece, activeId)} · ${piece.fabricPreset ?? 'tissu global'}`
      : 'Sélectionnez une pièce du patron';
    if (!gsmInput || !gsmReset || !gsmHelp) return;
    const pieces = selected.map((pieceId) => draftPieceAt(pieceId)!).filter(Boolean);
    const values = pieces.map(effectivePieceGsm);
    const first = values[0];
    const mixed = first !== undefined && values.some((value) => Math.abs(value - first) > 0.05);
    const customCount = pieces.filter((item) => item.arealDensityGsm !== undefined).length;
    gsmInput.disabled = !pieces.length;
    gsmInput.value = first === undefined || mixed ? '' : String(Math.round(first * 10) / 10).replace('.', ',');
    gsmInput.placeholder = mixed ? 'Valeurs différentes' : 'ex. 240';
    gsmInput.setAttribute('aria-invalid', 'false');
    gsmInput.setCustomValidity('');
    gsmReset.disabled = customCount === 0;
    if (!pieces.length) {
      gsmHelp.textContent = 'Sélectionnez une pièce pour régler son grammage.';
    } else if (mixed) {
      gsmHelp.textContent = `Valeurs différentes · ${formatGsm(Math.min(...values))}–${formatGsm(Math.max(...values))} g/m²`;
    } else if (customCount > 0) {
      gsmHelp.textContent = `Personnalisé · ${formatGsm(first!)} g/m²${pieces.length > 1 ? ` · ${pieces.length} pièces` : ''}`;
    } else {
      const source = piece?.fabricPreset ?? 'tissu global';
      gsmHelp.textContent = `Hérité de ${source} · ${formatGsm(first!)} g/m²`;
    }
  };
  fabricSel?.addEventListener('change', () => {
    if (!draft) return;
    const chosen = fabricSel.value;
    const inheritsGlobal = chosen === GLOBAL_FABRIC_INHERIT_VALUE;
    const preset = isFabricPresetName(chosen) ? chosen : undefined;
    if (!inheritsGlobal && !preset) return;
    const selected = patternView.selectedDraftPieceIds;
    const active = patternView.activeDraftPieceId;
    const ids = selected.includes(active) ? selected : [active];
    const valid = ids.filter((pid) => {
      const piece = draftPieceAt(pid);
      return !!piece && !piece.blank;
    });
    if (!valid.length) return;
    pushHistory();
    if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
    for (const pid of valid) {
      const next = structuredClone(draftPieceAt(pid)!);
      if (preset) next.fabricPreset = preset;
      else delete next.fabricPreset;
      replaceDraftPiece(pid, next);
    }
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    showPlacementStatus(
      [
        `${valid.length} pièce${valid.length > 1 ? 's' : ''} · ${preset ?? `tissu global (${globalFabricPreset})`} appliqué.`,
        valid.some((pid) => draftPieceAt(pid)?.arealDensityGsm !== undefined)
          ? 'Le grammage personnalisé est conservé ; les autres propriétés viennent du tissu choisi.'
          : preset
            ? `Grammage estimé : ${formatGsm(FABRIC_PHYSICS[preset!].arealDensity * 1000)} g/m². Il peut être précisé juste dessous.`
            : 'La pièce suivra désormais les réglages du panneau tissu global.',
      ],
      true,
    );
  });
  colorInput?.addEventListener('change', () => {
    const value = colorInput.value;
    if (/^#[0-9a-f]{6}$/i.test(value)) applyPieceColor(value.toLowerCase());
  });
  colorReset?.addEventListener('click', () => applyPieceColor(undefined));
  const applyPieceGsm = (gsm: number | undefined): void => {
    if (!draft) return;
    const ids = selectedFabricPieceIds();
    if (!ids.length) return;
    const alreadyApplied = ids.every((pid) => {
      const current = draftPieceAt(pid)?.arealDensityGsm;
      return gsm === undefined ? current === undefined : current !== undefined && Math.abs(current - gsm) < 0.001;
    });
    if (alreadyApplied) {
      syncPieceFabricSelect();
      return;
    }
    pushHistory();
    if (draft.preset === 'lucas-hoodie') hoodieFitPristine = false;
    for (const pid of ids) {
      const next = structuredClone(draftPieceAt(pid)!);
      if (gsm === undefined) delete next.arealDensityGsm;
      else next.arealDensityGsm = gsm;
      replaceDraftPiece(pid, next);
    }
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
    showPlacementStatus(
      gsm === undefined
        ? [
            `${ids.length} pièce${ids.length > 1 ? 's' : ''} · grammage hérité restauré.`,
            'Chaque pièce reprend le GSM de son tissu ou du réglage global.',
          ]
        : [
            `${ids.length} pièce${ids.length > 1 ? 's' : ''} · ${formatGsm(gsm)} g/m² appliqué.`,
            'La masse et l’inertie sont recalculées. Élasticité, flexion, friction et épaisseur restent celles du tissu.',
          ],
      true,
    );
  };
  const commitGsmInput = (): void => {
    if (!gsmInput || gsmInput.disabled) return;
    const normalized = gsmInput.value.trim().replace(/\s+/g, '').replace(',', '.');
    const gsm = Number(normalized);
    if (!normalized || !Number.isFinite(gsm) || gsm < MIN_FABRIC_GSM || gsm > MAX_FABRIC_GSM) {
      const message = `Entrez un grammage entre ${MIN_FABRIC_GSM} et ${MAX_FABRIC_GSM} g/m².`;
      gsmInput.setAttribute('aria-invalid', 'true');
      gsmInput.setCustomValidity(message);
      gsmInput.reportValidity();
      if (gsmHelp) gsmHelp.textContent = `${message} Le patron n’a pas été modifié.`;
      return;
    }
    gsmInput.setAttribute('aria-invalid', 'false');
    gsmInput.setCustomValidity('');
    applyPieceGsm(Math.round(gsm * 10) / 10);
  };
  gsmInput?.addEventListener('input', () => {
    gsmInput.setAttribute('aria-invalid', 'false');
    gsmInput.setCustomValidity('');
  });
  gsmInput?.addEventListener('change', commitGsmInput);
  gsmInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    commitGsmInput();
  });
  gsmReset?.addEventListener('click', () => applyPieceGsm(undefined));
  (document.getElementById('pattern') as HTMLCanvasElement).addEventListener(
    'patternpiecechange',
    syncPieceFabricSelect,
  );
  const skirtLinear = (flare: number): number[] =>
    Array.from({ length: 4 }, (_, k) => 0.22 + (flare - 0.22) * (k / 3));
  let skirtPattern = { length: 0.6, flare: 0.46, profile: skirtLinear(0.46) };
  let bodyKind: 'femme' | 'homme' | 'scan homme' | 'scan femme' | 'scan import' = 'scan femme';
  // DEV acceptance path only: analytic mannequins are staged in a true T-pose
  // so the canonical scan-style sleeve wrapper sees horizontal arm sections.
  let collisionAuditAnalyticTPose = false;
  let morphs: Morphs = { ...NO_MORPH };
  // v189 : pose d'essayage — colliders cuits hors-ligne par pose (CLO → bake).
  // L'ARRANGEMENT, le préhabillage et la MESURE restent toujours sur le corps
  // natif T (leçon v188 : on ne coud pas sur des bras baissés) ; seuls le
  // solveur et le rendu voient le corps posé. Poses réservées au corps aux
  // mensurations naturelles (les colliders sont cuits pour le canonique).
  let bodyPose: 'native' | 'a-pose' | 'debout' = 'native';
  let bodyPoseCollision: ScanCollisionPose | null = null;
  let syncPoseButtons: () => void = () => {};
  let podium = 0; // tours/minute
  let podiumAngle = 0;
  let animate = false;
  let animT = 0;
  // Articulated-animation state, prepared by build() for ARMS prim bodies.
  let animPrims: SdfPrim[] | null = null;
  let animSkin: Skin | null = null;
  let animRest: Float32Array | null = null;
  let animOut: Float32Array | null = null;
  // Scanned avatars — rendered as real meshes, felt by the cloth as baked SDF
  // grids. Both in parallel — serial awaits held the first paint hostage
  // to several MB of downloads nobody sees on the default (sculpted) scene.
  // v186 : le mannequin femme est « Mia », exportée de CLO (OBJ corps seul,
  // réparée étanche) puis cuite par tools/bake.py comme les scans historiques
  // — 60 000 tris, grille 7 mm, stature CLO 1,752 m. Asset propriétaire CLO :
  // usage local/démo, droits à confirmer avant toute publication. L'historique
  // femme-scan (MakeHuman CC0) reste livré à côté en repli.
  // v188 : le mannequin homme est « Leo » (MV2.1, l'homme phare de CLO),
  // exporté et cuit par le même pipeline que Mia — corps seul réparé étanche,
  // tools/bake.py à sa stature CLO de 1,8796 m. Asset propriétaire CLO :
  // usage local/démo, droits à confirmer avant toute publication. En repli :
  // jericho (le neutre riggé, poses A/couture committées) et homme-scan (CC0).
  // v189-190 : Leo et Mia embarquent leurs poses d'essayage cuites hors-ligne
  // (chargement paresseux au premier clic — collisionPoseLoaders, ScanAvatar).
  // v190 : le natif de Mia est désormais sa vraie T-pose (FV2_T, pieds au
  // sol) — la chip « T » dit vrai, et l'habillage a les bras dégagés.
  const [scanHomme, scanFemme] = await Promise.all([
    loadScanAvatar(`${import.meta.env.BASE_URL}avatars/leo`, {
      collisionPoses: { 'a-pose': 'apose', 'debout': 'attention' },
    }),
    loadScanAvatar(`${import.meta.env.BASE_URL}avatars/mia`, {
      collisionPoses: { 'a-pose': 'apose', 'debout': 'attention' },
    }),
  ]);
  const scans: Record<string, ScanAvatar | null> = {
    'scan homme': scanHomme,
    'scan femme': scanFemme,
  };

  // The tailor: measurements of the reference form the patterns were cut on,
  // then lazy per-mannequin measurements (analytic field or scan grid).
  const REF = measureBody((x, y, z) => sdBody(x, y, z, BODY_FORM, BODY_BLEND), 1.755);
  const measureCache: Record<string, BodyMeasure> = {};
  // Cache key over ALL the measurement sliders — dropping one serves a stale
  // body (frozen grading, stale morphed scan) as soon as it moves alone.
  const morphKey = (): string =>
    `${morphs.stature}|${morphs.carrure}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}|${morphs.cuisse}`;
  const measureFor = (kind: string, prims: SdfPrim[] | null, scan: ScanAvatar['grid'] | null): BodyMeasure => {
    const poseKey = collisionAuditAnalyticTPose ? 'T' : 'A';
    const key = `${kind}|${poseKey}|${morphKey()}`;
    if (prims) {
      // The anthropometric bands scale with the body: a stature-morphed form
      // is measured at ITS height, or the shoulder band floats above the head.
      measureCache[key] ??= measureBody(
        (x, y, z) => sdBody(x, y, z, prims, BODY_BLEND),
        (kind === 'homme' ? 1.765 : 1.755) * morphs.stature,
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
  const primsCache: Record<string, SdfPrim[]> = {};

  // Stashed by build() so the pattern-view handles use the graded dimensions.
  let lastGrade = { topScale: 1, dressScale: 1, skirtScale: 1, dyShoulder: 0, dyWaist: 0 };
  let lastMeasure: BodyMeasure = REF; // dernière mensuration mesurée par build()
  let lastAvatarBounds: CameraBounds | null = null;
  // Liens SYSTÈME du dernier build (manche↔emmanchure, col↔encolure) — les
  // épingles réelles converties en cellules (u,v), pour l'affichage 2D/3D.
  let systemLinks: SystemLink[] = [];

  let currentMesh: ReturnType<typeof generateClothGrid> | null = null;
  let currentScene: SceneMesh | null = null;
  let system!: ParticleSystem;
  let renderer!: ClothRenderer;
  let visibleBodyAuditCache: {
    scene: SceneMesh;
    proximity: MeshProximity;
    vertexCount: number;
    triangleCount: number;
  } | null = null;

  const visibleBodyProximity = (
    scene: SceneMesh,
    animatedInterleaved: Float32Array | null,
  ): {
    proximity: MeshProximity;
    vertexCount: number;
    triangleCount: number;
  } => {
    // Scans and rigid dress forms are cached by their immutable SceneMesh.
    // A skinned arms mesh is copied and rebuilt only when an explicit audit is
    // requested; the ordinary render/simulation path pays no BVH cost.
    if (!animatedInterleaved && visibleBodyAuditCache?.scene === scene) {
      return visibleBodyAuditCache;
    }
    const indices = scene.indices.slice(0, scene.bodyIndexCount);
    let highestIndex = -1;
    for (const index of indices) highestIndex = Math.max(highestIndex, index);
    const source = animatedInterleaved ?? scene.vertices;
    const result = {
      proximity: new MeshProximity({
        positions: source,
        normals: source,
        indices,
        positionStride: SCENE_VERTEX_FLOATS,
        normalStride: SCENE_VERTEX_FLOATS,
        normalOffset: 3,
      }),
      vertexCount: highestIndex + 1,
      triangleCount: indices.length / 3,
    };
    if (!animatedInterleaved) {
      visibleBodyAuditCache = { scene, ...result };
    }
    return result;
  };

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
  // Le TRANSITOIRE d'assemblage (les premières secondes après un réveil : le
  // drop-close des panneaux + le zip des coutures) exige la pleine précision :
  // si le gouverneur de perf a bradé les substeps (onglet lent), les coutures
  // claquent trop fort par pas et l'assemblage rate son départ — vérifié :
  // tous les drapés à ~55 fps/8 substeps tombaient, tous ceux à pleine
  // précision tenaient. Pendant cette fenêtre, plancher = les substeps demandés.
  let wakeUntil = 0;
  const wake = (): void => {
    asleep = false;
    stillCount = 0;
    sleepSnapshot = null;
    driftBase = null;
    snapshotCount = 0;
    wakeUntil = performance.now() + 12000; // fenêtre de précision pleine (ms) — couvre le drop + le zip complet, même sur un onglet lent
  };
  let dragIndex: number | null = null;
  let dragDepth = 0;
  type PieceParticleRange = { first: number; count: number; instance: number };
  type StagingPieceIdentity = { pid: number; instance: number };
  // Physical instances generated for each draft piece. Repeated cutting
  // pieces keep the same pid (and therefore the same editable 2D pattern), but
  // receive distinct instance numbers so either copy can be arranged alone.
  let pieceParticleRanges = new Map<number, PieceParticleRange[]>();
  let taggedPieceRanges: TaggedParticleRange<StagingPieceIdentity>[] = [];
  let pieceBoundaryIndexCache = new Map<
    string,
    Array<{ first: number; indices: number[] }>
  >();
  const registerPieceRange = (
    pid: number,
    first: number,
    count: number,
    instance = 0,
  ): void => {
    const ranges = pieceParticleRanges.get(pid) ?? [];
    ranges.push({ first, count, instance });
    pieceParticleRanges.set(pid, ranges);
    taggedPieceRanges.push({
      first,
      count,
      tag: { pid, instance },
    });
  };
  // ORGANISER DANS LA 3D (mode conception, pièces gelées) : the grabbed piece
  // follows the pointer as a rigid whole. On release only its preparation
  // offset is stored; its pattern geometry and seams are untouched.
  // ⌖ GIZMO XYZ (mode ✥) : un clic SÉLECTIONNE une pièce — un trièdre X/Y/Z
  // apparaît à son centroïde ; tirer une flèche contraint le déplacement à CET
  // axe monde, avec les centimètres en direct. La précision de profondeur que
  // le drag libre en plan d'écran ne donnait pas (douleur M2 de l'audit).
  // ✎3D DESSINER SUR LE VÊTEMENT (le « 3D Pen (Garment) » de Clo) : cliquer
  // des points SUR le tissu de la préparation ; la polyligne retombe en LIGNE
  // INTERNE de la pièce touchée (scindable au ✂, imprimée aux exports). En
  // conception, chaque pièce plate est AFFINE (uvWorldOf) : le clic s'inverse
  // exactement en (u, v) — pas de quantification de cellule.
  let draw3dMode = false;
  let draw3dTarget: number | null = null; // pid verrouillé au 1er point
  let draw3dPoints: UV[] = [];
  const clearDraw3d = (): boolean => {
    const active = draw3dMode || draw3dPoints.length > 0;
    draw3dTarget = null;
    draw3dPoints = [];
    return active;
  };
  /** Inverse le clic 3D en (pièce, UV) sur les pièces PLATES de la
   * préparation : intersection rayon-plan par pièce (repère affine de
   * uvWorldOf), la plus PROCHE de la caméra qui tombe dans le contour. */
  /** (u, v) brut du rayon sur le PLAN AFFINE d'une pièce plate — sans test
   * d'intérieur ni de bornes (l'édition de contour sort du contour !). */
  const planeUVAt = (
    ray: { origin: readonly [number, number, number]; dir: readonly [number, number, number] },
    pid: number,
  ): { uv: UV; s: number } | null => {
    const piece = draft ? docPieces(draft)[pid] : null;
    if (!piece || piece.blank || piece.wrap) return null;
    const map = uvWorldOf(pid);
    if (!map) return null;
    const p0 = map(0, 0);
    const pu = map(1, 0);
    const pv = map(0, 1);
    const U: [number, number, number] = [pu[0] - p0[0], pu[1] - p0[1], pu[2] - p0[2]];
    const V: [number, number, number] = [pv[0] - p0[0], pv[1] - p0[1], pv[2] - p0[2]];
    const nx = U[1] * V[2] - U[2] * V[1];
    const ny = U[2] * V[0] - U[0] * V[2];
    const nz = U[0] * V[1] - U[1] * V[0];
    const denom = nx * ray.dir[0] + ny * ray.dir[1] + nz * ray.dir[2];
    if (Math.abs(denom) < 1e-9) return null;
    const sHit =
      (nx * (p0[0] - ray.origin[0]) + ny * (p0[1] - ray.origin[1]) + nz * (p0[2] - ray.origin[2])) / denom;
    if (sHit < 0.01) return null;
    const hit: [number, number, number] = [
      ray.origin[0] + ray.dir[0] * sHit,
      ray.origin[1] + ray.dir[1] * sHit,
      ray.origin[2] + ray.dir[2] * sHit,
    ];
    const w: [number, number, number] = [hit[0] - p0[0], hit[1] - p0[1], hit[2] - p0[2]];
    const uu = U[0] * U[0] + U[1] * U[1] + U[2] * U[2];
    const uvd = U[0] * V[0] + U[1] * V[1] + U[2] * V[2];
    const vv = V[0] * V[0] + V[1] * V[1] + V[2] * V[2];
    const wu = w[0] * U[0] + w[1] * U[1] + w[2] * U[2];
    const wv = w[0] * V[0] + w[1] * V[1] + w[2] * V[2];
    const det = uu * vv - uvd * uvd;
    if (Math.abs(det) < 1e-12) return null;
    return { uv: [(wu * vv - wv * uvd) / det, (wv * uu - wu * uvd) / det], s: sHit };
  };
  const pickDraw3dPoint = (
    ray: { origin: readonly [number, number, number]; dir: readonly [number, number, number] },
    lockPid: number | null,
  ): { pid: number; uv: UV } | null => {
    if (!draft) return null;
    const all = docPieces(draft);
    let best: { pid: number; uv: UV; s: number } | null = null;
    for (let pid = 0; pid < all.length; pid++) {
      if (lockPid !== null && pid !== lockPid) continue;
      const piece = all[pid];
      if (!piece) continue;
      const hit = planeUVAt(ray, pid);
      if (!hit) continue;
      const [u, v] = hit.uv;
      if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue;
      if (!pointInPolygon([u, v], piece.outline)) continue;
      if (!best || hit.s < best.s) best = { pid, uv: [u, v], s: hit.s };
    }
    return best ? { pid: best.pid, uv: best.uv } : null;
  };
  // ⬦ ÉDITER LE CONTOUR EN 3D (l'« Edit 3D Garment » de Clo, allégé) : les
  // sommets du patron deviennent des poignées SUR le tissu de la préparation ;
  // tirer déplace le sommet sur le plan de sa pièce, relâcher committe dans le
  // circuit 2D (build — les coutures recousent aux nouvelles longueurs).
  let edit3dMode = false;
  let edit3dDrag: { pid: number; vertex: number; uv: UV; moved: boolean } | null = null;
  const clearEdit3d = (): boolean => {
    const active = edit3dMode || edit3dDrag !== null;
    edit3dDrag = null;
    return active;
  };
  // ⛶ CROQUIS SUR LE CORPS (le « Flatten » de Clo, v1 par projection frontale)
  // — dessiner une ZONE FERMÉE directement sur le mannequin, page blanche
  // comprise : les clics tombent sur le plan frontal du corps (le plan de
  // repos du Devant), l'écho miroir suit l'axe du corps si ⋈ est armé, et la
  // fermeture crée la pièce dans le CADRE CORPS — le contrat exact de la
  // plume 2D — puis ouvre le place-chooser (Devant, Dos, Bras…).
  let sketch3dMode = false;
  let sketch3dPoints: [number, number][] = []; // points MONDE (x, y)
  const clearSketch3d = (): boolean => {
    const active = sketch3dMode || sketch3dPoints.length > 0;
    sketch3dPoints = [];
    return active;
  };
  /** Ferme le croquis en zone symétrique sur l'axe du corps (x = 0). */
  const closeSketchMirror = (pts: readonly [number, number][]): [number, number][] => {
    const out = pts.map((q) => [q[0], q[1]] as [number, number]);
    if (out.length < 2) return out;
    for (const idx of [0, out.length - 1]) {
      if (Math.abs(out[idx]![0]) < 0.008) out[idx]![0] = 0; // aimanté à l'axe
    }
    const mirrored = out
      .filter((q) => q[0] !== 0)
      .map((q) => [-q[0], q[1]] as [number, number])
      .reverse();
    return [...out, ...mirrored];
  };
  let gizmoPick: { pid: number; instance: number } | null = null;
  const GIZMO_AXES: readonly {
    dir: readonly [number, number, number];
    color: string;
    label: string;
  }[] = [
    { dir: [1, 0, 0], color: 'rgba(255, 106, 106, 0.95)', label: 'X' },
    { dir: [0, 1, 0], color: 'rgba(122, 226, 154, 0.95)', label: 'Y' },
    { dir: [0, 0, 1], color: 'rgba(112, 184, 255, 0.95)', label: 'Z' },
  ];
  const GIZMO_LEN_M = 0.22;
  const gizmoRangesOf = (pid: number, instance: number): PieceParticleRange[] =>
    (pieceParticleRanges.get(pid) ?? []).filter((range) => range.instance === instance);
  /** L'axe du trièdre sous le pointeur (px canvas), ou null. */
  const gizmoAxisAt = (px: number, py: number): 0 | 1 | 2 | null => {
    if (!gizmoPick) return null;
    const c = stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance);
    if (!c) return null;
    const rect = canvas.getBoundingClientRect();
    const toPx = (ndc: readonly [number, number]): [number, number] => [
      ((ndc[0] + 1) / 2) * rect.width,
      ((1 - ndc[1]) / 2) * rect.height,
    ];
    const n0 = arrangeNdcOf(c);
    if (!n0) return null;
    const s0 = toPx(n0);
    let best: 0 | 1 | 2 | null = null;
    let bestD = 12; // tolérance px
    for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
      const a = GIZMO_AXES[k]!.dir;
      const n1 = arrangeNdcOf([
        c[0] + a[0] * GIZMO_LEN_M,
        c[1] + a[1] * GIZMO_LEN_M,
        c[2] + a[2] * GIZMO_LEN_M,
      ]);
      if (!n1) continue;
      const s1 = toPx(n1);
      const vx = s1[0] - s0[0];
      const vy = s1[1] - s0[1];
      const wx = px - s0[0];
      const wy = py - s0[1];
      const len2 = vx * vx + vy * vy || 1e-6;
      const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
      const d = Math.hypot(px - (s0[0] + t * vx), py - (s0[1] + t * vy));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const GIZMO_RING_PX = 46; // rayon écran de l'anneau de rotation
  /** Centre écran (px canvas) de la pièce sélectionnée, ou null. */
  const gizmoCenterPx = (): [number, number] | null => {
    if (!gizmoPick) return null;
    const c = stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance);
    if (!c) return null;
    const ndc = arrangeNdcOf(c);
    if (!ndc) return null;
    const rect = canvas.getBoundingClientRect();
    return [((ndc[0] + 1) / 2) * rect.width, ((1 - ndc[1]) / 2) * rect.height];
  };
  /** (px,py) est-il SUR l'anneau de rotation (près du cercle, pas au centre) ? */
  const gizmoRingAt = (px: number, py: number): boolean => {
    const c = gizmoCenterPx();
    if (!c) return false;
    return Math.abs(Math.hypot(px - c[0], py - c[1]) - GIZMO_RING_PX) <= 14;
  };
  const GIZMO_ROT_R = GIZMO_LEN_M * 0.72; // rayon MONDE des 3 anneaux X/Y/Z
  // Base (u,v) du plan de l'anneau de l'axe k, main droite (u×v = axe).
  const ROT_RING_BASIS: readonly {
    u: readonly [number, number, number];
    v: readonly [number, number, number];
  }[] = [
    { u: [0, 1, 0], v: [0, 0, 1] },
    { u: [0, 0, 1], v: [1, 0, 0] },
    { u: [1, 0, 0], v: [0, 1, 0] },
  ];
  /** Intersection rayon ∩ plan (normale `nrm`, passant par `pt`), ou null. */
  const rayHitPlane = (
    ray: { origin: readonly [number, number, number]; dir: readonly [number, number, number] },
    nrm: readonly [number, number, number],
    pt: readonly [number, number, number],
  ): [number, number, number] | null => {
    const denom = ray.dir[0] * nrm[0] + ray.dir[1] * nrm[1] + ray.dir[2] * nrm[2];
    if (Math.abs(denom) < 1e-6) return null;
    const t =
      ((pt[0] - ray.origin[0]) * nrm[0] +
        (pt[1] - ray.origin[1]) * nrm[1] +
        (pt[2] - ray.origin[2]) * nrm[2]) /
      denom;
    if (t <= 0) return null;
    return [
      ray.origin[0] + ray.dir[0] * t,
      ray.origin[1] + ray.dir[1] * t,
      ray.origin[2] + ray.dir[2] * t,
    ];
  };
  /** Points MONDE d'un anneau d'axe (centre c, base k). */
  const rotRingPoints = (
    c: readonly [number, number, number],
    k: 0 | 1 | 2,
    segs = 48,
  ): [number, number, number][] => {
    const b = ROT_RING_BASIS[k]!;
    const out: [number, number, number][] = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const cu = Math.cos(a) * GIZMO_ROT_R;
      const sv = Math.sin(a) * GIZMO_ROT_R;
      out.push([
        c[0] + b.u[0] * cu + b.v[0] * sv,
        c[1] + b.u[1] * cu + b.v[1] * sv,
        c[2] + b.u[2] * cu + b.v[2] * sv,
      ]);
    }
    return out;
  };
  /** L'axe (0..2) dont l'anneau MONDE passe sous (px,py) canvas, ou null. */
  const gizmoWorldRingAt = (px: number, py: number): 0 | 1 | 2 | null => {
    if (!gizmoPick) return null;
    const c = stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance);
    if (!c) return null;
    const rect = canvas.getBoundingClientRect();
    let best: 0 | 1 | 2 | null = null;
    let bestD = 10;
    for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
      for (const pt of rotRingPoints(c, k, 64)) {
        const ndc = arrangeNdcOf(pt);
        if (!ndc) continue;
        const sx = ((ndc[0] + 1) / 2) * rect.width;
        const sy = ((1 - ndc[1]) / 2) * rect.height;
        const dd = Math.hypot(px - sx, py - sy);
        if (dd < bestD) { bestD = dd; best = k; }
      }
    }
    return best;
  };
  let pieceDrag: {
    pid: number;
    instance: number;
    ranges: PieceParticleRange[];
    depth: number; // profondeur de saisie le long du rayon (le drag reste dans ce plan)
    start: [number, number, number]; // point monde saisi
    delta: [number, number, number];
    pointerId: number;
    positions: Float32Array; // immutable CPU snapshot from the instant of grab
    /** Drag contraint : l'index de l'axe monde du trièdre (X/Y/Z). */
    axis?: 0 | 1 | 2;
    grabNdc?: [number, number];
    /** Drag de l'anneau de rotation : roll autour de l'axe caméra. */
    rot?: {
      axis: readonly [number, number, number];
      pivot: readonly [number, number, number];
      lastAngle: number;
      angle: number;
      /** Anneau d'axe MONDE : base (u,v) du plan ⇒ angle via rayon∩plan, +
       *  index d'axe pour le surlignage. Absent = anneau écran (roll caméra). */
      plane?: { u: readonly [number, number, number]; v: readonly [number, number, number] };
      axisIdx?: 0 | 1 | 2;
    };
  } | null = null;
  if (import.meta.env.DEV) {
    (window as unknown as { __toileGizmo?: unknown }).__toileGizmo = {
      get pick() {
        return gizmoPick;
      },
      get drag() {
        return pieceDrag
          ? {
              pid: pieceDrag.pid,
              instance: pieceDrag.instance,
              axis: pieceDrag.axis ?? null,
              depth: pieceDrag.depth,
              start: [...pieceDrag.start],
              delta: [...pieceDrag.delta],
              grabNdc: pieceDrag.grabNdc ? [...pieceDrag.grabNdc] : null,
            }
          : null;
      },
      get ndc() {
        return [mouse.ndcX, mouse.ndcY, mouse.leftDown];
      },
      axisAt(px: number, py: number) {
        return gizmoAxisAt(px, py);
      },
      get draw3d() {
        return { mode: draw3dMode, target: draw3dTarget, points: draw3dPoints.map((q) => [...q]) };
      },
      pickAt(ndcX: number, ndcY: number, lock: number | null) {
        const ray = camera.pickRay(ndcX, ndcY, canvas.width / canvas.height);
        return pickDraw3dPoint(ray, lock);
      },
    };
  }
  type StagingPiecePick = StagingPieceIdentity & {
    index: number;
    depth: number;
    ranges: PieceParticleRange[];
  };
  let pieceHover: StagingPieceIdentity | null = null;
  let pointerInside3D = false;
  let pointerButtons3D = 0;
  let pieceHoverDirty = true;
  let nextPieceHoverAt = 0;
  const setPieceHover = (next: StagingPieceIdentity | null): void => {
    const same =
      pieceHover?.pid === next?.pid &&
      pieceHover?.instance === next?.instance;
    if (same) return;
    pieceHover = next;
    canvas.classList.toggle('piece-hover', !!next && !pieceDrag);
  };
  const releasePiecePointer = (pointerId: number): void => {
    try {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser can release capture itself during pointercancel/teardown.
    }
  };
  /**
   * A native cancellation (lost focus, OS gesture, pointercancel) is not a
   * pointerup: restore the immutable grab snapshot and never persist the
   * partial staging delta.
   */
  const cancelPieceDrag = (pointerId?: number): boolean => {
    const cancelled = pieceDrag;
    if (
      !cancelled ||
      (pointerId !== undefined && cancelled.pointerId !== pointerId)
    ) {
      return false;
    }
    for (const range of cancelled.ranges) {
      system.translateRange(range.first, range.count, [0, 0, 0]);
    }
    releasePiecePointer(cancelled.pointerId);
    pieceDrag = null;
    posCache = cancelled.positions;
    pointerInside3D = false;
    pointerButtons3D = 0;
    pieceHoverDirty = true;
    setPieceHover(null);
    canvas.classList.remove('piece-dragging');
    return true;
  };
  canvas.addEventListener('pointerenter', (event) => {
    pointerInside3D = true;
    pointerButtons3D = event.buttons;
    pieceHoverDirty = true;
  });
  canvas.addEventListener('pointermove', (event) => {
    pointerInside3D = true;
    pointerButtons3D = event.buttons;
    pieceHoverDirty = true;
  });
  canvas.addEventListener(
    'wheel',
    () => {
      pieceHoverDirty = true;
    },
    { passive: true },
  );
  canvas.addEventListener('pointerdown', (event) => {
    pointerButtons3D = event.buttons;
    pieceHoverDirty = true;
    if (event.button !== 0 || event.shiftKey) setPieceHover(null);
  });
  const finishPointerState = (event: PointerEvent): void => {
    pointerButtons3D = event.buttons;
    pieceHoverDirty = true;
  };
  const cancelPointerState = (event: PointerEvent): void => {
    finishPointerState(event);
    cancelPieceDrag(event.pointerId);
  };
  canvas.addEventListener('pointerup', finishPointerState);
  canvas.addEventListener('pointercancel', cancelPointerState);
  window.addEventListener('pointerup', finishPointerState);
  window.addEventListener('pointercancel', cancelPointerState);
  window.addEventListener('blur', () => {
    pointerButtons3D = 0;
    cancelPieceDrag();
  });
  canvas.addEventListener('lostpointercapture', () => {
    pieceHoverDirty = true;
  });
  canvas.addEventListener('pointerleave', (event) => {
    pointerInside3D = false;
    pointerButtons3D = event.buttons;
    pieceHoverDirty = true;
    if (!pieceDrag) setPieceHover(null);
  });

  const buildNow = async (
    target: SceneMode,
    context?: Pick<SceneBuildContext, 'checkpoint'>,
  ): Promise<void> => {
    const checkpoint = context?.checkpoint ?? (async (): Promise<void> => {});
    pieceParticleRanges = new Map();
    taggedPieceRanges = [];
    pieceBoundaryIndexCache = new Map();
    // 'drapé': one sheet falling onto the sphere. 'couture': two pattern pieces
    // stitched around the sphere. 'robe': the same seamed pieces closing around
    // a dress form (stacked-sphere bust), falling to the floor.
    const bodyScene =
      target === 'robe' ||
      target === 'robe froncée' ||
      target === 't-shirt' ||
      target === 'chemise' ||
      target === 'ensemble' ||
      target === 'tenue' ||
      target === 'pantalon' ||
      target === 'atelier';
    const scanAvatar = bodyKind.startsWith('scan') ? scans[bodyKind] : null;
    const useScan = bodyScene && scanAvatar !== null;
    const basePrims =
      !bodyScene || useScan
        ? null
        : // Sleeveless dresses have no armholes: on an ARMS body the arms end
          // up trapped INSIDE the garment. Dress scenes use the dress form.
          target === 'robe' || target === 'robe froncée' || target === 'tenue' || target === 'atelier'
          ? (bodyKind === 'homme' ? BODY_MALE : BODY_FORM)
          : bodyKind === 'homme'
            ? BODY_MALE_ARMS
            : BODY_FORM_ARMS;
    // Morphology: warp the selected body by the measurement sliders, then let
    // the tailor measure the WARPED figure so garments re-grade themselves.
    const neutral = isNeutral(morphs);
    const marks = bodyScene && !neutral ? marksFor(bodyKind, scanAvatar ?? null) : null;
    // Memoized per (body, arms-variant, morph values): morphPrims returns a
    // FRESH array each call, and the surface-nets mesh cache downstream is
    // keyed by prim-array identity — without this, every slider release paid
    // a full ~1 s re-mesh even back at settings already meshed.
    const morphedBodyPrims =
      basePrims && marks
        ? (primsCache[
            `${bodyKind}|${basePrims === BODY_FORM_ARMS || basePrims === BODY_MALE_ARMS ? 'A' : 'F'}|${morphKey()}`
          ] ??= morphPrims(basePrims, morphs, marks))
        : basePrims;
    const bodyPrims =
      collisionAuditAnalyticTPose &&
      morphedBodyPrims &&
      (basePrims === BODY_FORM_ARMS || basePrims === BODY_MALE_ARMS)
        ? horizontalizeArmChains(morphedBodyPrims)
        : morphedBodyPrims;
    let effScan = useScan ? scanAvatar! : null;
    if (effScan && marks) {
      const key = `${bodyKind}|${morphKey()}`;
      morphCache[key] ??= {
        grid: morphGrid(effScan.grid, morphs, marks),
        mesh: morphMesh(effScan.mesh, morphs, marks),
      };
      effScan = morphCache[key]! as ScanAvatar;
    }
    // v189 : le corps POSÉ ne remplace que ce que le solveur touche et ce que
    // l'œil voit ; mesure, regradage, arrangement et préhabillage restent sur
    // le corps natif T. Un corps remodelé (morphs) redevient natif : les
    // colliders de pose sont cuits pour le canonique uniquement.
    if (!neutral && bodyPose !== 'native') {
      bodyPose = 'native';
      bodyPoseCollision = null;
      syncPoseButtons();
    }
    const posedBody: ScanCollisionPose | null =
      useScan && neutral && bodyPose !== 'native' ? bodyPoseCollision : null;
    const shownScan = posedBody ?? effScan;
    lastAvatarBounds = shownScan ? avatarBounds(shownScan.mesh.positions) : null;
    const colliders = bodyPrims ? toColliders(bodyPrims) : useScan ? [] : SPHERE;
    // Automatic made-to-measure: measure the selected body's field like a
    // tailor (chest, waist, hips, shoulder line) and cut every garment from
    // RATIOS against the reference form the patterns were designed on.
    const m = measureFor(bodyKind, bodyScene ? bodyPrims : null, effScan ? effScan.grid : null);
    const bodyCollisionSd: Sd | undefined = effScan
      ? gridSd(effScan.grid)
      : bodyPrims
        ? (x, y, z) => sdBody(x, y, z, bodyPrims, BODY_BLEND)
        : undefined;
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
    lastMeasure = m; // les préréglages hors-build (bouton 👕) gradent sur la dernière mesure
    // Canonical dressing planes: just outside the deepest measured section.
    // A one-metre front/back gap makes shoulder stitches pull straight through
    // the avatar and strand both rims on opposite sides. This gap is independent
    // of the 2D layout and remains generous enough to start outside the body.
    const bodyWrapGap = Math.max(
      0.24,
      2 * Math.max(m.chest.halfD, m.waist.halfD, m.hip.halfD) + 0.08,
    );
    if (
      target === 'atelier' &&
      draft?.preset === 'lucas-hoodie' &&
      hoodieFitMode === 'avatar' &&
      hoodieFitPristine
    ) {
      const bodyKey = hoodieBodyKey(m);
      if (bodyKey !== hoodieFitBodyKey) {
        const fit = lucasHoodieFit(m);
        const gridN = draft.gridN;
        draft = lucasHoodieAdjusted(m);
        draft.gridN = gridN;
        hoodieFitBodyKey = bodyKey;
        if (loadedPattern === 'hoodie') showSizes('hoodie');
        showPlacementStatus(
          [
            `Hoodie réajusté au mannequin · base A0 ${fit.sourceSize}.`,
            `Poitrine finie ${fit.targetFinishedChestCm.toFixed(1).replace('.', ',')} cm · longueur ${fit.targetFinishedLengthCm.toFixed(1).replace('.', ',')} cm · manches ${fit.targetFinishedSleeveCm.toFixed(1).replace('.', ',')} cm.`,
          ],
          true,
        );
      }
    }
    // v242 — sur-mesure EN LIVE : le T-shirt composable coupe aux cotes du
    // mannequin epouse le corps courant des qu'une mensuration bouge, sans
    // re-selection ni reset de vue. Comme le hoodie ci-dessus, on ne regrade
    // QUE si le corps a change (les rebuilds tissu/resolution laissent le
    // patron intact). Le design par-piece (« mets ton design » : imprime,
    // couleur, grammage) est reporte sur le patron regrade — un coup de
    // curseur ne l'efface pas. Les pid sont stables tant que les blocs ne
    // changent pas (un changement de bloc passe par loadBoxyTee, pas ici).
    if (target === 'atelier' && loadedPattern === 'boxy' && boxySurMesure) {
      const boxyKey = hoodieBodyKey(m) + '|e' + boxyEase;
      if (boxyKey !== boxyFitBodyKey) {
        const carried = new Map<
          number,
          Pick<DraftPiece, 'graphic' | 'color' | 'arealDensityGsm'>
        >();
        const nPrev = 2 + (draft?.pieces?.length ?? 0);
        for (let pid = 0; pid < nPrev; pid++) {
          const prev = draftPieceAt(pid);
          if (prev && (prev.graphic || prev.color || prev.arealDensityGsm !== undefined)) {
            carried.set(pid, {
              graphic: prev.graphic,
              color: prev.color,
              arealDensityGsm: prev.arealDensityGsm,
            });
          }
        }
        draft = boxyTee(boxySize, m, REF, boxySleeves, boxyCollar, boxyNeck, boxyLen, true, boxyEase);
        boxyFitBodyKey = boxyKey;
        for (const [pid, d] of carried) {
          const next = draftPieceAt(pid);
          if (!next) continue;
          if (d.graphic) next.graphic = d.graphic;
          if (d.color) next.color = d.color;
          if (d.arealDensityGsm !== undefined) next.arealDensityGsm = d.arealDensityGsm;
        }
        showSizes('boxy'); // l'etiquette « poitrine XX cm » suit la cote vive
      }
    }
    await checkpoint();
    const canonicalDressingClearance = (
      garment: ClothMeshData,
      layer = 0,
    ): number =>
      Math.max(
        0.012,
        2 * fabricDynamics.collisionThickness,
        1.5 * Math.max(garment.spacing, garment.spacingV),
      ) + Math.max(0, layer) * fabricDynamics.collisionThickness;
    const prepareCanonicalMirrorSeams = (
      garment: ClothMeshData,
      layer = 0,
    ): ClothMeshData => {
      if (bodyCollisionSd) {
        preCloseBodySafeMirrorSeams(garment, {
          bodyDistance: bodyCollisionSd,
          clearance: canonicalDressingClearance(garment, layer),
        });
      }
      return garment;
    };
    const prepareCanonicalTube = (
      garment: ClothMeshData,
      layer = 0,
    ): ClothMeshData => {
      if (bodyCollisionSd) {
        preWrapTwoPanelTube(garment, {
          bodyDistance: bodyCollisionSd,
          clearance: canonicalDressingClearance(garment, layer),
        });
      }
      return prepareCanonicalMirrorSeams(garment, layer);
    };
    const tee = () => {
      const garment = generateSeamedPanels({
        resolution,
        width: 1.15 * topScale, // sleeve tip to sleeve tip
        height: 0.75,
        gap: bodyWrapGap,
        topY: 1.52 + dyShoulder,
        shape: 'tshirt', // kimono tee: body + sleeves in one piece
      });
      if (bodyCollisionSd) {
        preWrapKimonoSleeves(garment, {
          bodyDistance: bodyCollisionSd,
          clearance: canonicalDressingClearance(garment),
        });
      }
      return prepareCanonicalMirrorSeams(garment);
    };
    const robe = () =>
      prepareCanonicalMirrorSeams(generateSeamedPanels({
        resolution,
        width: 0.95 * dressScale,
        height: dressPattern.length,
        gap: bodyWrapGap,
        topY: 1.6 + dyShoulder,
        shape: 'aline', // real pattern piece: fitted, flared, scooped neckline
        shapeParams: { profile: dressPattern.profile, scoop: dressPattern.neck },
      }));
    const mesh =
      target === 'atelier'
        ? (() => {
            // T-SHIRT preset: an OVERSIZED, drop-shoulder tee (matching the real
            // K.Kose oversized pattern — boxy body, straight sides, deep armhole,
            // wide short sleeves), built with the proven set-in construction (body
            // + 2 sleeves on one sheet, armholes stitched island-to-island on both
            // panels → a clean drape), and SIZED from the avatar's chest so it
            // scales with the mannequin. Ref proportions (size chart): chest flat
            // ≈ length·0.79, boxy (bottom = chest), armhole ≈ 0.45·chest.
            if (teePreset) {
              const OVERSIZE = 1.35; // garment chest ≈ 1.35× the body chest (oversized boxy)
              const chestFlat = (m.chest.circ * OVERSIZE) / 2; // pit-to-pit (front width); the kimono body spans 0.48·width
              const w = chestFlat / 0.48;
              // Neckline: a NARROW crew neck (~18 cm across, snug like the reference size
              // chart), sized in metres then converted to the piece-width fraction — so the
              // oversized-wide body keeps a neck that grips the shoulders instead of sliding
              // off (the body scales up, the neck does not).
              const neckHalf = 0.088 / w;
              const sleeveEnd = 0.24 + 0.2 / w; // ~20 cm short sleeve (ref chart), from the body edge (0.24)
              // Kimono / drop-shoulder cut: the sleeve is INTEGRAL to the body (not a
              // separate island), so front+back sew into a tube around the arm and the
              // sleeve drapes DOWN instead of flapping — the real construction of an
              // oversized drop-shoulder tee (matching the K.Kose reference pattern).
              return prepareCanonicalMirrorSeams(generateSeamedPanels({
                resolution,
                width: w,
                height: 0.66, // shoulder → hem (a long, oversized body)
                gap: 0.9,
                topY: 1.52 + dyShoulder,
                shape: 'tshirt',
                shapeParams: { neck: neckHalf, sleeve: sleeveEnd },
              }));
            }
            // Freeform piece: the user's drawn outline + darts + hand-seams
            // compiled straight to the mask / seam machinery (the atelier editor).
            const doc = (draft ??= defaultDraft(resolution as 32 | 64 | 128));
            const simulationDoc =
              !atelierDesign && simulationExcludedPieceIds.size
                ? draftForSimulationExcluding(
                    doc,
                    simulationExcludedPieceIds,
                  )
                : doc;
            // Lucas Hoodie: the editable document contains the seven unique
            // cutting pieces, while this specialised compiler materialises
            // their true quantities (two fronts, sleeves, hood sides, pockets
            // and cuffs), unfolds the fold pieces and mounts the separable zip.
            if (simulationDoc.preset === 'lucas-hoodie' && simulationDoc.back) {
              systemLinks = [];
              const hoodie = buildLucasHoodieMesh(
                simulationDoc,
                resolution,
                m,
                bodyCollisionSd,
              );
              for (const range of hoodie.ranges) {
                registerPieceRange(
                  range.pieceId,
                  range.first,
                  range.count,
                  range.instance,
                );
              }
              if (atelierDesign || respectArrangement) {
                for (const range of hoodie.ranges) {
                  const piece = draftPieceAt(range.pieceId);
                  if (!piece) continue;
                  applyStagingOrient(
                    hoodie.mesh,
                    stagingOrientOf(piece, range.instance),
                    range.first,
                    range.count,
                  );
                  applyStagingOffset(
                    hoodie.mesh,
                    stagingOffsetOf(piece, range.instance),
                    range.first,
                    range.count,
                  );
                }
              }
              return hoodie.mesh;
            }
            // Trousers are four independent panels (two mirrored legs), not the
            // generic single front/back tube. Their exact editable pieces stay
            // in the same DraftDoc; only the assembly topology is specialised.
            if (doc.preset === 'loose-pants' && doc.back) {
              systemLinks = [];
              const pants = buildLoosePantsMesh(doc, resolution, m.hip.circ);
              const panelSize = resolution * resolution;
              registerPieceRange(0, 0, panelSize, 0);
              registerPieceRange(1, panelSize, panelSize, 0);
              registerPieceRange(0, panelSize * 2, panelSize, 1);
              registerPieceRange(1, panelSize * 3, panelSize, 1);
              if (atelierDesign || respectArrangement) {
                for (const range of pieceParticleRanges.get(0) ?? []) {
                  applyStagingOrient(
                    pants,
                    stagingOrientOf(doc.piece, range.instance),
                    range.first,
                    range.count,
                  );
                  applyStagingOffset(
                    pants,
                    stagingOffsetOf(doc.piece, range.instance),
                    range.first,
                    range.count,
                  );
                }
                for (const range of pieceParticleRanges.get(1) ?? []) {
                  applyStagingOrient(
                    pants,
                    stagingOrientOf(doc.back, range.instance),
                    range.first,
                    range.count,
                  );
                  applyStagingOffset(
                    pants,
                    stagingOffsetOf(doc.back, range.instance),
                    range.first,
                    range.count,
                  );
                }
              }
              return pants;
            }
            const d = simulationDoc.piece;
            const { extraSeams, openCells } = compileDraft(d, resolution);
            const rN = resolution;
            const cellOpen =
              (set: Set<number>) =>
              (uu: number, vv: number): boolean =>
                set.has(Math.round(vv * (rN - 1)) * rN + Math.round(uu * (rN - 1)));
            // Independent back face (côte-à-côte), if the user drew one.
            const back =
              simulationDoc.back && simulationDoc.back.outline.length >= 3
                ? simulationDoc.back
                : null;
            const bc = back ? compileDraft(back, resolution) : null;
            // Manual assembly: nothing auto-sews; the user's seams hold it.
            const manual = simulationDoc.manual === true;
            const body = generateSeamedPanels({
              resolution,
              width: d.width,
              height: d.height,
              gap: atelierDesign ? d.gap : Math.min(d.gap, bodyWrapGap),
              topY: d.topY,
              shape: 'freeform',
              mask: { outline: d.outline, darts: d.darts, holes: pieceHolePolygons(d) },
              extraSeams,
              extraOpenings: cellOpen(openCells),
              ...(back && bc
                ? {
                    maskBack: { outline: back.outline, darts: back.darts, holes: pieceHolePolygons(back) },
                    extraSeamsBack: bc.extraSeams,
                    extraOpeningsBack: cellOpen(bc.openCells),
                  }
                : {}),
              ...(manual
                ? {
                    manualAssembly: true,
                    assemblySeams: compileAssembly(simulationDoc, resolution),
                  }
                : {}),
              ...(simulationDoc.preset === 'jupe'
                ? {
                    // Jupe : une taille sans bretelles glisse le long d'un corps
                    // qui s'affine sous elle PENDANT que pinces et côtés se
                    // cousent — le piège documenté du pantalon (LoosePantsAssembly).
                    // La ceinture est donc RETENUE à sa hauteur le temps du
                    // montage, puis l'aide s'efface (anchorReleaseSeconds).
                    anchorTop: true,
                    // Léger embu de ceinture : la couture veut être un peu plus
                    // courte que la coupe et agrippe le creux de la taille.
                    elasticTop: 0.97,
                    // Ceinture entoilée : sa longueur est celle de la couture,
                    // pas celle du tissu du preset (un jersey ne la détend pas).
                    reinforceTop: true,
                  }
                : simulationDoc.preset === 'veste' || simulationDoc.preset === 'doudoune'
                  ? {
                      // Veste et doudoune : la LIGNE D'ÉPAULE (rangs hauts,
                      // épaules + hauts de manches kimono) est retenue le
                      // temps du montage — FERMETURE OUVERTE, rien ne joint
                      // les devants pendant que épaules et côtés se cousent,
                      // et le vêtement entier glissait du corps (observé
                      // v197). Pas d'élastique ni d'entoilage : une épaule
                      // n'est pas une ceinture.
                      anchorTop: true,
                    }
                  : {}),
            });
            if (!atelierDesign && loadedPattern === 'boxy') {
              prepareCanonicalMirrorSeams(body);
            }
            const panelSize = resolution * resolution;
            registerPieceRange(0, 0, panelSize);
            registerPieceRange(1, panelSize, panelSize);
            if (atelierDesign || respectArrangement) {
              applyStagingOrient(body, stagingOrientOf(d), 0, panelSize);
              applyStagingOffset(body, stagingOffsetOf(d), 0, panelSize);
              applyStagingOrient(body, stagingOrientOf(back ?? d), panelSize, panelSize);
              applyStagingOffset(body, stagingOffsetOf(back ?? d), panelSize, panelSize);
            }
            let garment = body;
            // FREE pieces (multi-piece editor): each user-drawn extra piece
            // (pieceId ≥ 2) becomes its OWN 2-panel mesh, combined onto the
            // garment and sewn where the user's assembly seams say
            // (compileCrossSeams). Empty ⇒ this loop is skipped and `garment`
            // stays exactly `body` — byte-identical to v97.
            const freePieces = simulationDoc.pieces ?? [];
            const offsets: number[] = [0, resolution * resolution]; // global base index per pieceId
            // Authoritative placement graph. Unlike the mesh constraint buffer,
            // this contains only joins that say WHERE pieces belong; automatic
            // front/back rim stitches merely close a piece and are excluded.
            const automaticPlacementSeams: CrossSeam[] = [];
            const rigidFixedPanels = new Set<number>([0, 1]);
            systemLinks = [];
            for (let k = 0; k < freePieces.length; k++) {
              const pid = 2 + k;
              const fp = freePieces[k];
              offsets[pid] = garment.count; // where this piece's cells will land in the combined mesh
              if (!fp || fp.outline.length < 3 || fp.patternOnly) continue;
              const fpc = compileDraft(fp, resolution);
              const surfacePiece = fp.placement?.role === 'pocket';
              // UNE FEUILLE : pièce de surface (poche/doublure) OU pièce plate
              // qui renonce à son jumeau (singlePanel — sinon le panneau
              // arrière d'un demi-devant, ouvert ou cousu ailleurs sur tous
              // ses bords, n'est retenu par rien et tombe en fantôme).
              const soloSheet = surfacePiece || fp.singlePanel === true;
              const firstPhysicalPanel = Math.floor(garment.count / panelSize);
              if (fp.wrap || fp.placement?.role === 'free') {
                rigidFixedPanels.add(firstPhysicalPanel);
                rigidFixedPanels.add(firstPhysicalPanel + 1);
              }
              // A cross-sewn edge is no longer a free rim: exclude its cells
              // from this piece's own front↔back rim stitching, so a both-faces
              // assembly seam can't transitively weld the body's open edge shut
              // THROUGH the body (see crossSewnOpenCells).
              const openAll = new Set([
                ...fpc.openCells,
                ...crossSewnOpenCells(simulationDoc, pid, resolution),
              ]);
              if (fp.wrap) {
                // WRAP piece = a TUBE by construction: its mouth (first kept
                // cell of each column — pinned to the armhole/neckline) AND
                // its far edge (last kept cell) stay OPEN like the proven v96
                // tube (« side seams only, top open, bottom open ») — a welded
                // rim fights the pins and flattens the tube shut.
                const rN = resolution;
                const insidePiece = (uu: number, vv: number): boolean => {
                  if (!pointInPolygon([uu, vv], fp.outline)) return false;
                  for (const dart of fp.darts) if (pointInTriangle([uu, vv], dart.apex, dart.legA, dart.legB)) return false;
                  return true;
                };
                for (let u = 0; u < rN; u++) {
                  let first = -1;
                  let last = -1;
                  for (let v = 0; v < rN; v++) {
                    if (insidePiece(u / (rN - 1), v / (rN - 1))) {
                      if (first < 0) first = v;
                      last = v;
                    }
                  }
                  if (first >= 0) {
                    openAll.add(first * rN + u);
                    openAll.add(last * rN + u);
                  }
                }
              }
              const pieceMesh = generateSeamedPanels({
                resolution,
                width: fp.width,
                height: fp.height,
                gap: fp.gap,
                topY: fp.topY,
                shape: 'freeform',
                mask: { outline: fp.outline, darts: fp.darts, holes: pieceHolePolygons(fp) },
                extraSeams: fpc.extraSeams,
                extraOpenings: cellOpen(openAll),
                maskBack: soloSheet
                  ? { outline: [], darts: [] }
                  : { outline: fp.outline, darts: fp.darts },
                extraSeamsBack: soloSheet ? [] : fpc.extraSeams,
                extraOpeningsBack: soloSheet ? undefined : cellOpen(openAll),
                // A wrap piece is a TUBE: its side seams must fold freely
                // around the arm — the flatten rings would pin it shut.
                flattenSeams: fp.wrap ? false : undefined,
                // Bande asymétrique (col V) : le panneau dos se resserre.
                backWeaveScale: fp.backWeaveScale,
              });
              // Every editable piece owns the same n×n grid. Scale its base
              // inverse masses by physical cell area before material density is
              // applied, otherwise a tiny pocket weighs as much as a body panel
              // and tows the whole shirt through its stitches.
              scaleMeshInverseMassesToReferenceCellArea(
                pieceMesh,
                body.spacing * body.spacingV,
              );
              if (fp.wrap === 'armL' || fp.wrap === 'armR') {
                // SLEEVE MODE: wrap the piece around the arm — both panels
                // straddle it in z, pivoted at the piece's own top edge and
                // tilted to the A-pose (the proven v96 tube placement) — but on
                // an EDITABLE draft piece. Its rim stitching closes it into a
                // tube; its cap run cross-sewn to the two independent armhole
                // rims makes a real sleeve. The tube spawns SNUG (±fp.gap/2,
                // the arm between the panels) — v96's proven spawn; the long
                // armhole↔cap pins to the still-wide body panels are survivable
                // (v102-104 lived with the exact same distances). Unlike the
                // former four-rims-on-one-line lock, this manifold join leaves
                // an actual passage from torso to sleeve.
                // T-POSE (scans re-cuits) : le bras est HORIZONTAL — le tube
                // pivote de 90° et se centre sur l'AXE MESURÉ du bras (m.arm) :
                // un bras naturel s'arque en z (jusqu'à −12 cm au coude sur les
                // corps MakeHuman) et supposer z=0 fait naître le panneau
                // arrière DANS le bras → le SDF éjecte le tube.
                const tPose = useScan;
                placeWrapSleeve(pieceMesh, fp, fp.wrap === 'armR' ? 'R' : 'L', m, tPose);
              } else if (fp.wrap === 'neck') {
                // NECKBAND: form the two flat panels into a real tube BEFORE
                // physics. Otherwise each lateral stitch crosses the neck and
                // body collision reopens it by projecting its endpoints onto
                // opposite surfaces. The bottom row remains centred and is
                // then pinned to the authored neckline below.
                // Préparation à plat : on laisse la bande de col PLATE (comme les
                // autres pièces). On ne la pré-enroule en tube (pour un drapé net
                // sans réouverture de couture) qu'au moment de l'essayage — build()
                // est relancé par Simuler avec atelierDesign=false.
                if (!atelierDesign) preWrapCollarTube(pieceMesh);
              } else if (!surfacePiece) {
                // Spawn it in FRONT of the body (at the body's front-panel plane),
                // clear of the avatar SDF collider — spawning inside would eject it
                // violently (as with the sleeves). Its assembly seam then pulls it
                // onto the body and it drapes.
                const spawnZ = d.gap / 2;
                for (let q = 0; q < pieceMesh.count; q++) {
                  pieceMesh.positions[q * 4 + 2] = pieceMesh.positions[q * 4 + 2]! + spawnZ;
                }
              }
              // Wrap pieces pin to the explicit pattern openings (sleeves) or
              // the neckline scan (neckband); flat pieces keep the drawn seams.
              const surfacePins = surfacePiece
                ? compileSurfaceSeams(simulationDoc, resolution, offsets, pid)
                : [];
              // MATELASSAGE (v199) : les épingles de canal doublure↔support.
              // Coutures BILATÉRALES ordinaires (le support se laisse
              // comprimer — le boudinage vit là), jamais des surpiqûres de
              // surface ; elles n'entrent pas dans le placement (le pourtour
              // suffit à poser la pièce, les canaux créent l'embu ensuite).
              const quiltPins = surfacePiece
                ? compileQuiltSeams(simulationDoc, resolution, offsets, pid)
                : [];
              const pins =
                fp.wrap === 'armL' || fp.wrap === 'armR'
                  ? sleeveCrossSeams(
                      garment,
                      pieceMesh,
                      simulationDoc.piece,
                      simulationDoc.back ?? simulationDoc.piece,
                      fp.wrap === 'armR' ? 'R' : 'L',
                      resolution,
                      useScan,
                    )
                  : fp.wrap === 'neck'
                    ? collarCrossSeams(garment, resolution, {
                        front: neckOpeningCells(d, resolution),
                        back: neckOpeningCells(back ?? d, resolution),
                      })
                    : [
                        ...compileCrossSeams(
                          simulationDoc,
                          resolution,
                          offsets,
                          pid,
                        ),
                        ...surfacePins,
                      ];
              const surfaceContacts = surfacePiece
                ? compileSurfaceContacts(
                    simulationDoc,
                    resolution,
                    offsets,
                    pid,
                  )
                : [];
              if (fp.wrap === 'neck' && !atelierDesign) {
                fitCollarTubeToNeckline(garment, pieceMesh, pins);
              }
              if (!surfacePiece && fp.placement?.role !== 'free') {
                automaticPlacementSeams.push(...pins);
              }
              if (
                surfacePiece &&
                fp.placement?.surface &&
                pins.length
              ) {
                placeMeshOnSurface(
                  garment,
                  pieceMesh,
                  pins,
                  garment.count,
                  (((fp.placement.surface.supportPieceId === 1 ? -1 : 1) *
                    (fp.placement.surface.side === 'under' ? -1 : 1)) as 1 | -1),
                );
              } else if (
                !fp.wrap &&
                fp.placement?.role !== 'free' &&
                fp.placement?.autoAlign !== false &&
                pins.length
              ) {
                // User-drawn flat pieces no longer spawn at an arbitrary
                // drawing coordinate: their sewn cells define one rigid best
                // fit (translation + rotation) before physics is released.
                autoPlaceMeshFromCrossSeams(garment, pieceMesh, pins, garment.count);
              }
              registerPieceRange(pid, garment.count, pieceMesh.count);
              if (atelierDesign || respectArrangement) {
                applyStagingOrient(pieceMesh, stagingOrientOf(fp));
                applyStagingOffset(pieceMesh, stagingOffsetOf(fp));
              }
              if (fp.wrap) {
                // Lien SYSTÈME visible : les épingles réelles → cellules (u,v)
                // par pièce (corps devant/dos + bouche), dédoublonnées en
                // séquence, pour surligner le montage dans le plan et en 3D.
                const ps2 = resolution * resolution;
                const cell = (local: number): [number, number] => [
                  ((local % resolution) + 0.5) / resolution,
                  (Math.floor(local / resolution) + 0.5) / resolution,
                ];
                const push = (arr: [number, number][], c: [number, number]): void => {
                  const last = arr[arr.length - 1];
                  if (!last || last[0] !== c[0] || last[1] !== c[1]) arr.push(c);
                };
                const link: SystemLink = { pid, body0: [], body1: [], piece: [] };
                for (const pr of pins) {
                  const bp = Math.floor(pr.i / ps2);
                  if (bp === 0) push(link.body0, cell(pr.i % ps2));
                  else if (bp === 1) push(link.body1, cell(pr.i - ps2));
                  const rel = pr.j - garment.count;
                  if (rel >= 0 && rel < ps2) push(link.piece, cell(rel)); // panneau avant seulement
                }
                systemLinks.push(link);
              }
              garment = combineClothMeshes(
                garment,
                pieceMesh,
                [...pins, ...quiltPins],
                // Une POCHE (side 'over') reste au MÊME niveau que son support —
                // elle est posée dessus, fine. Mais une DOUBLURE (side 'under')
                // doit vivre SOUS la coque : au même niveau, le décalage de
                // couche du corps (thick = épaisseur + niveau × gap) ne les
                // sépare jamais, et la doublure perce la coque dans le gonflant
                // libre (v201 — les grandes plaques bordeaux de la doudoune).
                // La mettre au niveau −1 fait que le corps la garde une épaisseur
                // DEDANS la coque : l'ordre est ancré au contact du corps et
                // tient jusque dans le boudin.
                fp.placement?.surface?.side === 'under' ? -1 : 0,
                surfaceContacts,
                surfacePins,
              );
            }
            if (!atelierDesign && automaticPlacementSeams.length) {
              // Solve the COMPLETE user seam graph at once. This second pass is
              // what makes chains and cycles independent of creation order;
              // each n×n panel moves rigidly, so no yarn or triangle is warped
              // before the physical solver starts.
              rigidlyPlaceGarmentPanels(garment, {
                panelSize,
                fixedPanels: [...rigidFixedPanels],
                placementSeams: automaticPlacementSeams,
                iterations: 32,
                damping: 0.72,
                orientationRegularization: 0.025,
                balancePanelNeighbours: true,
                longResidualBias: 0.8,
              });
            }
            // Multi-piece (stage 1): sew a rectangular sleeve to each armhole,
            // via the SAME combineClothMeshes cross-seaming the gathered dress
            // uses. Gated on the button — without it the mesh is exactly the body.
            if (atelierSleeves) {
              const sL = sleeveMesh(resolution, 'L', m.shoulderHalfW, m.shoulderY, atelierSleeveLen, useScan, m.arm);
              garment = combineClothMeshes(
                garment,
                sL,
                sleeveCrossSeams(garment, sL, doc.piece, doc.back ?? doc.piece, 'L', resolution, useScan),
              );
              const sR = sleeveMesh(resolution, 'R', m.shoulderHalfW, m.shoulderY, atelierSleeveLen, useScan, m.arm);
              garment = combineClothMeshes(
                garment,
                sR,
                sleeveCrossSeams(garment, sR, doc.piece, doc.back ?? doc.piece, 'R', resolution, useScan),
              );
            }
            if (atelierCollar) {
              const col = collarMesh(resolution, 0.42, m.shoulderY);
              const seams = collarCrossSeams(garment, resolution, {
                front: neckOpeningCells(d, resolution),
                back: neckOpeningCells(back ?? d, resolution),
              });
              fitCollarTubeToNeckline(garment, col, seams);
              garment = combineClothMeshes(
                garment,
                col,
                seams,
              );
            }
            // v198 — un zip OUVERT dans le document : l'habillage se fait
            // quand même FERMÉ (les épingles ZipperSeam existent toujours),
            // puis le solveur les débraye une fois le montage posé.
            const zipOpenDoc = (simulationDoc.seams ?? []).some(
              (s) => s.kind === 'zipper' && s.closed === false,
            );
            const anchoredPreset =
              simulationDoc.preset === 'jupe' ||
              simulationDoc.preset === 'veste' ||
              simulationDoc.preset === 'doudoune';
            if (anchoredPreset || zipOpenDoc) {
              // La jupe tient ensuite PAR LE PATRON (taille cousue < hanches),
              // la veste et la doudoune PAR LES ÉPAULES (kimono cousu au dos)
              // — l'aide au montage s'efface après la même durée que le
              // pantalon.
              return {
                ...garment,
                ...(anchoredPreset ? { anchorReleaseSeconds: 3 } : {}),
                ...(zipOpenDoc ? { zipperInitiallyOpen: true } : {}),
              };
            }
            return garment;
          })()
        : target === 'couture'
        ? generateSeamedPanels({ resolution, width: 1.2, height: 1.2, gap: 1.3, topY: 1.9 })
        : target === 'robe'
          ? robe()
          : target === 'tenue'
            ? // Layered outfit: the dress is WORN OVER the tee — its particles
              // carry layer 1, so the body pushes it out one gap further and it
              // drapes on the tee instead of fighting it for the same surface.
              // Dressing order via the initial drop: the dress starts higher
              // and wider, arriving once the tee already hugs the body —
              // simultaneous falls interleave (tunneling locks wrong-side).
              combineClothMeshes(
                tee(),
                prepareCanonicalMirrorSeams(generateSeamedPanels({
                  resolution,
                  width: 0.95 * dressScale,
                  height: dressPattern.length,
                  gap: bodyWrapGap + 0.06,
                  topY: 1.78 + dyShoulder,
                  shape: 'aline',
                  shapeParams: { profile: dressPattern.profile, scoop: dressPattern.neck },
                })),
                [],
                1,
              )
          : target === 't-shirt'
            ? tee()
            : target === 'chemise'
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
            : target === 'ensemble'
              ? // Outfit: tee + flared skirt, one simulation — self-collision
                // keeps the layers apart where they overlap.
                combineClothMeshes(
                  tee(),
                  prepareCanonicalTube(generateSeamedPanels({
                    resolution,
                    // Waist ring smaller than the hip bulge holds on the female
                    // form; on the male (waist ≈ hips) it would slide with
                    // nothing to catch on — the anchor is the belt that holds it.
                    width: 0.85 * skirtScale,
                    height: skirtPattern.length,
                    gap: 0.75,
                    topY: 1.14 + (m.waist.y - REF.waist.y), // sits at the waist
                    shape: 'skirt',
                    shapeParams: { profile: skirtPattern.profile },
                    elasticTop: 0.75, // taille élastiquée : fronce et agrippe le corps
                    anchorTop: true, // ceinture : la taille est RETENUE (sinon glisse, surtout sur l'homme)
                  }), 1),
                  [],
                  1, // la jupe se porte SUR le t-shirt (couche 1)
                )
              : target === 'robe froncée'
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
                      elasticTop: 0.78, // bustier : le haut fronce
                      anchorTop: true, // ceinture : le haut est RETENU à sa hauteur (sinon glisse aux hanches)
                    });
                    const jupe = generateSeamedPanels({
                      resolution,
                      width: Wb * 1.6, // l'embu : 60 % de tissu en plus à froncer
                      height: 0.55,
                      gap: 0.9,
                      topY: topB - Hb,
                    });
                    // These are closed tubes, not two independent sheets.
                    // Spawn their front/back halves on matching semicircles so
                    // a side seam never takes the forbidden shortcut through
                    // the torso and gets reopened by the final body contact.
                    // The wider skirt keeps its full arc length: its 60 % ease
                    // is still consumed by the waist stitches as real gathers.
                    const tubeClearance = Math.max(
                      0.012,
                      2 * fabricDynamics.collisionThickness,
                      3 * Math.max(
                        bod.spacing,
                        bod.spacingV,
                        jupe.spacing,
                        jupe.spacingV,
                      ),
                    );
                    const tubeWrap = {
                      bodyDistance: bodyCollisionSd,
                      clearance: tubeClearance,
                    };
                    preWrapTwoPanelTube(bod, tubeWrap);
                    preWrapTwoPanelTube(jupe, tubeWrap);
                    prepareCanonicalMirrorSeams(bod);
                    prepareCanonicalMirrorSeams(jupe);
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
              : target === 'pantalon'
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
                    anchorTop: true, // ceinture : retenue à la taille (sinon glisse sur l'homme)
                  })
                : generateClothGrid({ resolution, size: CLOTH_SIZE, topY: CLOTH_TOP_Y, pin: 'none' });
    await checkpoint();
    const globalPhysics = { ...compliance, ...fabricDynamics };
    const materialPieceIds =
      target === 'atelier' && draft && !teePreset
        ? [...pieceParticleRanges.keys()]
        : [];
    const materialLibrary = fabricMaterialLibrary(
      globalPhysics,
      materialPieceIds.map((pid) => {
        const piece = draftPieceAt(pid);
        return {
          preset: piece?.fabricPreset,
          arealDensityGsm: piece?.arealDensityGsm,
        };
      }),
    );
    const materialIds = new Uint32Array(mesh.count);
    const visualMaterialIds = new Uint32Array(mesh.count);
    if (materialPieceIds.length) {
      materialPieceIds.forEach((pid, index) => {
        const materialId = materialLibrary.ids[index]!;
        // Mot visuel : id de tissu (octet bas) + couleur d'EMPIÈCEMENT de la
        // pièce (24 bits hauts) — le shader déballe, zéro plomberie GPU en plus.
        const visualWord = packVisualMaterial(
          materialLibrary.baseIds[index]!,
          draftPieceAt(pid)?.color,
        );
        const ranges = pieceParticleRanges.get(pid) ?? [];
        for (const range of ranges) {
          materialIds.fill(materialId, range.first, range.first + range.count);
          visualMaterialIds.fill(visualWord, range.first, range.first + range.count);
        }
      });
    }
    const materialMesh: ClothMeshData = { ...mesh, materialIds };
    // GRAPHIQUES de pièce : composer l'atlas (4 tuiles 512², bord transparent)
    // et précalculer l'UV atlas de chaque particule des pièces décorées.
    // Par particule : xy = UV graphique CONTINUE (le shader borne les posés,
    // répète les motifs), z = tuile d'atlas (-8 = aucune), w = drapeau motif.
    const graphicUVs = new Float32Array(mesh.count * 4);
    for (let i = 0; i < mesh.count; i++) graphicUVs[i * 4 + 2] = -8;
    let graphicAtlas: HTMLCanvasElement | null = null;
    if (materialPieceIds.length) {
      const decorated = materialPieceIds.filter((pid) => draftPieceAt(pid)?.graphic).slice(0, 4);
      if (decorated.length) {
        const TILE = 512;
        const MARGIN = 4; // marge transparente des tuiles POSÉES (le shader la connaît)
        graphicAtlas = document.createElement('canvas');
        graphicAtlas.width = TILE * 2;
        graphicAtlas.height = TILE * 2;
        const gctx = graphicAtlas.getContext('2d');
        for (let slot = 0; slot < decorated.length && gctx; slot++) {
          const pid = decorated[slot]!;
          const piece = draftPieceAt(pid)!;
          const graphic = piece.graphic!;
          const bitmap = await graphicBitmap(graphic.image);
          if (!bitmap) continue;
          const tx = (slot % 2) * TILE;
          const ty = Math.floor(slot / 2) * TILE;
          if (graphic.repeat) {
            // Motif : la tuile ENTIÈRE est une répétition, périodique plein bord.
            gctx.drawImage(bitmap, tx, ty, TILE, TILE);
          } else {
            gctx.drawImage(bitmap, tx + MARGIN, ty + MARGIN, TILE - 2 * MARGIN, TILE - 2 * MARGIN);
          }
          const n = resolution;
          const panelSize = n * n;
          const rep = graphic.repeat ? 1 : 0;
          for (const range of pieceParticleRanges.get(pid) ?? []) {
            for (let k = 0; k < range.count; k++) {
              const particle = range.first + k;
              const local = particle % panelSize;
              const u = (local % n) / (n - 1);
              const v = Math.floor(local / n) / (n - 1);
              const [gu, gv] = graphicLocalUV(graphic, piece.width, piece.height, u, v);
              graphicUVs[particle * 4] = gu;
              graphicUVs[particle * 4 + 1] = gv;
              graphicUVs[particle * 4 + 2] = slot;
              graphicUVs[particle * 4 + 3] = rep;
            }
          }
        }
      }
    }
    await checkpoint();
    // A rebuild is a transaction: the live globals are only replaced after
    // every allocation and the final cancellation checkpoint succeed. A
    // superseded/timed-out build therefore cannot publish a half-created GPU
    // generation that the recovery transition would then try to render.
    let nextSystem: ParticleSystem | null = null;
    let nextRenderer: ClothRenderer | null = null;
    let sceneMesh: SceneMesh;
    try {
      nextSystem = new ParticleSystem(device, materialMesh, {
        colliders,
        colliderBlend: bodyPrims ? BODY_BLEND : 0,
        sdfGrid: shownScan ? shownScan.grid : undefined, // v189 : le tissu sent le corps POSÉ
        groundY: GROUND_Y,
        frictionStatic: fabricDynamics.frictionStatic,
        frictionDynamic: fabricDynamics.frictionDynamic,
        arealDensity: fabricDynamics.arealDensity,
        clothThickness: fabricDynamics.collisionThickness,
        damping: fabricDynamics.damping,
        airDrag: fabricDynamics.airDrag,
        creaseYieldDeg: fabricDynamics.creaseYieldDeg,
        creaseMemory: fabricDynamics.creaseMemory,
        creaseRecovery: fabricDynamics.creaseRecovery,
        complianceStretch: compliance.stretch,
        complianceStretchWarp: compliance.stretchWarp,
        complianceShear: compliance.shear,
        complianceBend: compliance.bend,
        complianceBendWarp: compliance.bendWarp,
        stretchLimit: compliance.stretchLimit,
        shearLimit: compliance.shearLimit,
        selfCollision,
        materials: materialLibrary.materials,
        globalMaterialVariantIds: materialLibrary.globalVariantIds,
      });
      nextSystem.setWind(wind); // keep the breeze across rebuilds
      sceneMesh = buildSceneMesh({
        colliders: bodyPrims || useScan ? [] : colliders,
        body: bodyPrims ? { prims: bodyPrims, blend: BODY_BLEND } : undefined,
        rawBody: shownScan ? shownScan.mesh : undefined, // v189 : l'œil voit le corps POSÉ
        groundY: GROUND_Y,
      });
      nextRenderer = new ClothRenderer(
        device,
        canvas,
        nextSystem.positionBuffer,
        nextSystem.count,
        mesh.resolution,
        mesh.spacing,
        mesh.spacingV,
        mesh.triangleIndices,
        sceneMesh,
        mesh.spacing2,
        mesh.spacingV2,
        visualMaterialIds,
        mesh.layers,
        fabricDynamics.collisionThickness,
        graphicUVs,
        graphicAtlas,
      );
      nextRenderer.setFabric(fabricStyle); // keep the preset's look across rebuilds
      nextRenderer.setFitMap(fitMap); // the tension view is a rebuild-surviving setting (M29)
      nextRenderer.resize(canvas.width, canvas.height);
      await checkpoint();
    } catch (error) {
      nextRenderer?.dispose();
      if (nextSystem) await nextSystem.dispose();
      throw error;
    }
    system = nextSystem;
    // v181 ⑥ : les liserés de coutures posés sur le tissu — pièces de base
    // (Devant/Dos) en v1, les pièces libres suivront avec compileCrossSeams.
    nextRenderer.setSeamLines(
      sceneMode === 'atelier' && draft ? seamOverlayVerts(draft, mesh.resolution) : null,
    );
    nextRenderer.setSeamsVisible(seams3dOn);
    nextRenderer.setPreparationMode(sceneMode === 'atelier' && atelierDesign);
    renderer = nextRenderer;
    posCache = null; // stale cache belongs to the previous system
    dragIndex = null;
    wake();
    // Arm animation applies to sculpted ARMS bodies only (the arms ARE the
    // last 8 primitives; scans are rigid grids — podium only for them).
    // Decide by the SOURCE body: a morphed dress form is a fresh array, so an
    // identity test against BODY_FORM would pass it and swing its LEGS.
    if (bodyPrims && (basePrims === BODY_FORM_ARMS || basePrims === BODY_MALE_ARMS)) {
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
    currentMesh = materialMesh;
    currentScene = sceneMesh;
    // HUD count = SIMULATED fabric (cut-away particles are parked dead at
    // invMass 0), not the full 2·n² grid (audit M33).
    liveParticleCount = 0;
    for (let i = 0; i < mesh.invMasses.length; i++) if (mesh.invMasses[i]! > 0) liveParticleCount++;
    patternView.draw(materialMesh, patternHandles()); // refresh the 2D cutting-layout inset
    // Freeform editing: hand the atelier piece to the 2D view so its outline
    // vertices become draggable; other scenes leave draft mode.
    if (!(target === 'atelier' && patternView.drawing))
      patternView.setDraft(
        target === 'atelier' && draft ? draft.piece : null,
        target === 'atelier' && draft?.back ? draft.back : null,
        target === 'atelier' && draft?.pieces ? draft.pieces : [],
      );
    // Show the EXACT avatar silhouette (projected from the rendered scan mesh)
    // behind the 2D plan, so pieces are drawn over the real body shown in 3D.
    patternView.setBodySilhouette(
      target === 'atelier' && effScan ? avatarSilhouette(effScan.mesh.positions, effScan.mesh.indices) : null,
    );
    // Manual-assembly seams (red free edges / blue sewn links) for the 2D editor.
    patternView.setAssembly(target === 'atelier' && draft ? draft.seams ?? [] : []);
    // Editing marriages: visible/synchronised in 2D, never sent to the solver.
    patternView.setSegmentLinks(target === 'atelier' && draft ? draft.segmentLinks ?? [] : []);
    // Liens système (manches/col) surlignés comme les coutures manuelles.
    patternView.setSystemLinks(target === 'atelier' && draft && !teePreset ? systemLinks : []);
    if (target === 'atelier') syncPieceFabricSelect();
    updateAtelierBar();
    refreshHint();
  };

  let committedSceneMode: SceneMode = sceneMode;
  let committedSceneRevision = 0;
  let transitionRecoveryInFlight = false;
  let transitionFailureCount = 0;
  let transitionRecoveryCount = 0;
  type TransitionFailure = {
    phase: 'teardown' | 'build' | 'watchdog';
    target: SceneMode;
    message: string;
  };
  let lastTransitionFailure: TransitionFailure | null = null;
  let autosave: AutosaveController | null = null;
  const lifecycle = new SceneLifecycle<SceneMode>({
    selectorDebounceMs: 200,
    teardownTimeoutMs: 15_000,
    buildTimeoutMs: 15_000,
    teardown: async () => {
      // TOILE-22 : quitter l'atelier annule toute interaction en cours —
      // tracé de pièce, dialogue de placement, fantôme « poche / applique ».
      // Sans cette purge, bannière et gestes armés survivaient sur une scène
      // détruite (état hybride visible dans toutes les autres scènes) et
      // gardaient des références vers un patternView à reconstruire. Les
      // rebuilds atelier→atelier, eux, doivent préserver l'outil actif :
      // le flux normal « poche » enchaîne build() puis startSurfacePlacement.
      if (sceneMode !== 'atelier') {
        // Révertir un commit de poche avant de désarmer (sans rebuild : on est
        // déjà dans le teardown), sinon une colonne « poche » orpheline
        // survivrait au changement de scène.
        revertPendingPocket({ rebuild: false });
        patternView.cancelInteractions();
        resetPlacement();
      }
      // Stop every producer before waiting for submitted work. In particular,
      // retire() makes a delayed GLTF/pick retry fail closed before it can encode.
      system.retire();
      posCache = null;
      dragIndex = null;
      if (pieceDrag) releasePiecePointer(pieceDrag.pointerId);
      pieceDrag = null;
      mouse.cancelGesture();
      camera.cancelGesture();
      pointerButtons3D = 0;
      pieceHoverDirty = true;
      setPieceHover(null);
      canvas.classList.remove('piece-dragging');
      await system.prepareDispose();
      renderer.dispose();
      await system.dispose();
    },
    build: async (target, context) => {
      await buildNow(target, context);
      committedSceneMode = target;
      committedSceneRevision = context.revision;
      panel.syncEngineSelects({
        scene: target,
        body: bodyKind,
        resolution,
        fabricPreset: globalFabricPreset,
      });
      syncPieceFabricSelect();
      syncParticleSelect();
      if (transitionRecoveryInFlight) {
        console.info(`[toile] scène ${target} restaurée après une transition interrompue`);
      }
      transitionRecoveryInFlight = false;
    },
    getLiveBufferCount: () => {
      const live = liveSceneGpuResources();
      if (import.meta.env.DEV) {
        console.debug(
          `[toile] teardown GPU : ${live.buffers} buffer(s), ${live.textures} texture(s) vivants`,
        );
      }
      return live.buffers;
    },
    onStateChange: (state) => {
      const idle = state === 'idle';
      document.body.classList.toggle('scene-transitioning', !idle);
      canvas.setAttribute('aria-busy', String(!idle));
      patternView.setInteractionEnabled(idle);
      if (idle) {
        if (resolutionStatus.dataset.pendingResolution === String(resolution)) {
          resolutionStatus.hidden = true;
          delete resolutionStatus.dataset.pendingResolution;
        }
        autosave?.notifyIdle();
      }
    },
    onError: (error, context) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      if (context.phase === 'liveBuffers') {
        console.warn('[toile] métrique de ressources GPU indisponible :', error);
        return;
      }

      transitionFailureCount++;
      lastTransitionFailure = {
        phase: context.phase,
        target: context.target,
        message: error instanceof Error ? error.message : String(error),
      };
      const phaseLabel = context.phase === 'watchdog'
        ? 'bloquée (watchdog)'
        : `${context.phase} interrompue`;
      console.error(
        `[toile] transition ${phaseLabel} pour ${context.target} :`,
        error,
      );

      // A first failure rolls back to the last fully committed scene. Retire /
      // dispose are idempotent, so this also safely resumes a teardown whose
      // browser promise only settled after the 15 s deadline. A second failure
      // during that rollback means the GPU generation itself is unhealthy and
      // must use the explicit reload path rather than loop forever.
      if (!transitionRecoveryInFlight) {
        transitionRecoveryInFlight = true;
        transitionRecoveryCount++;
        sceneMode = committedSceneMode;
        panel?.syncScene(committedSceneMode);
        guidanceEl.textContent =
          `Transition vers « ${context.target} » interrompue · restauration de « ${committedSceneMode} »…`;
        lifecycle.request(committedSceneMode);
        return;
      }

      const timeout =
        error instanceof SceneTeardownTimeoutError
        || error instanceof SceneBuildTimeoutError
        || error instanceof SceneTransitionStallError
        || error instanceof SceneTransitionChurnError;
      showFatal(
        timeout ? 'Le moteur 3D ne répond plus' : 'La scène 3D n’a pas pu être restaurée',
        `${detail}\n\nLa restauration automatique de « ${committedSceneMode} » a également échoué.`,
      );
    },
  });
  const sceneTransitionBusy = (): boolean =>
    lifecycle.isTransitioning || lifecycle.pendingTarget !== undefined;

  // Carte d'ajustement (fit map) : bascule la vue TENSION du tissu porté et
  // synchronise le bouton visible. Chemin unique appelé par le bouton ET par
  // la case « carte de tension » des Réglages avancés.
  const fitmapButton = document.getElementById('at-fitmap3d') as HTMLButtonElement | null;
  const applyFitMap = (on: boolean): void => {
    fitMap = on;
    document.body.classList.toggle('fitmap-on', on); // affiche la légende
    if (fitmapButton) {
      fitmapButton.classList.toggle('active', on);
      fitmapButton.setAttribute('aria-pressed', String(on));
    }
    if (sceneTransitionBusy()) {
      build();
      return;
    }
    renderer.setFitMap(on);
  };
  fitmapButton?.addEventListener('click', () => applyFitMap(!fitMap));

  /** Queue a rebuild; import batching collapses all requests to its final call. */
  const build = (fromSceneSelector = false): void => {
    if (buildSuspended) return;
    if (fromSceneSelector) {
      lifecycle.requestFromSelector(sceneMode);
      // The debounce window is intentionally still reported as `idle` by the
      // phase machine, but the latest target is already pending. Freeze pattern
      // mutations immediately so autosave/render cannot observe a mixed target.
      document.body.classList.add('scene-transitioning');
      canvas.setAttribute('aria-busy', 'true');
      patternView.setInteractionEnabled(false);
    } else lifecycle.request(sceneMode);
  };

  // Scene-aware hint: the atelier needs its drawing gestures spelled out — and
  // pendant que 🪡 est armé, l'aide GUIDE la couture pas à pas (les contours
  // s'allument en 3D ; le pied du plan 2D guide aussi).
  const refreshHint = (): void => {
    const hintEl = document.getElementById('hint');
    if (!hintEl) return;
    const emptyAtelier = (
      sceneMode === 'atelier' &&
      atelierDesign &&
      !draftTouched &&
      !patternView.drawing
    );
    atelierEmptyState.hidden = !emptyAtelier;
    // PAGE BLANCHE : fenêtres vierges — le plan ne montre que grille et
    // silhouette, la 3D ne montre que le mannequin. Tout réapparaît au premier
    // vrai geste (modèle chargé, tracé, import).
    patternView.setPristine(emptyAtelier);
    const clothless =
      emptyAtelier || (!!draft?.piece.blank && !(draft.pieces?.length ?? 0));
    renderer?.setClothVisible(!clothless);
    syncEmptyAvatarButtons();
    // Loading/importing/drawing flips draftTouched after the preset selector
    // was first populated. Re-assert its enabled state and honest M4 wording
    // with the same transaction that refreshes the workspace guidance.
    syncAvatarStatureHelp();
    // La bascule de fermeture suit le document courant (chargement, undo,
    // restauration) dans la même transaction de resynchronisation.
    syncZipToggle();
    let message: string;
    if (sceneMode !== 'atelier') {
      message =
        'glisser sur le tissu : le tirer · glisser à côté : tourner · clic droit + glisser : se déplacer · molette : zoom visuel · R : réinitialiser le tissu';
    } else if (patternView.drawing) {
      message = patternView.penMirroring
        ? '✎ tracé MIROIR : le 1er point pose l’axe vertical — dessinez UNE moitié, l’autre s’écrit en direct · re-clic au 1er point ou ✓ Fermer le tracé = la pièce entière, symétrique'
        : '✎ tracé : cliquez point par point dans la zone de dessin · re-clic sur le 1er point ou ✓ Fermer le tracé referme la pièce · ⋈ Miroir au tracé = ne dessiner qu’une moitié';
    } else if (patternView.linkingSegments || patternView.segmentLinkPick) {
      message = patternView.segmentLinkPick
        ? '🔗 1er segment retenu — cliquez maintenant le second, sur la même pièce ou une autre · re-cliquer le même bord annule'
        : '🔗 mariage : cliquez deux segments non adjacents · leurs longueurs évolueront ensemble · cliquez un segment déjà lié pour le dissocier';
    } else if (patternView.zippering || patternView.zipperPick) {
      message = patternView.zipperPick
        ? '⚡ 1er ruban retenu (en jaune) — cliquez maintenant le bord opposé de la fermeture · re-cliquer le même bord annule'
        : '⚡ fermeture éclair : cliquez les deux bords à joindre, du bas vers le haut · elle sera fermée pour le premier essayage 3D';
    } else if (patternView.sewing || patternView.seamPick) {
      message = patternView.seamPick
        ? '🪡 1er bord retenu (en orange) — cliquez maintenant le 2e bord, celui à assembler · re-cliquer le même bord = annuler'
        : '🪡 couture : cliquez près d’un bord de pièce — en 3D sur l’avatar (contours allumés) ou dans le plan 2D';
    } else if (patternView.freeSewing) {
      message = patternView.freeSewTracing
        ? '🧵 tracé en cours — suivez le contour (coins et demi-tour permis), cliquez la fin · re-clic au départ = annuler'
        : patternView.freeSewHasRunA
          ? '🧵 1er tracé retenu (en orange) — cliquez le DÉPART du bord à assembler, sur une autre pièce ou le même contour'
          : '🧵 couture libre : cliquez un DÉPART n’importe où sur un contour — milieu de bord et coins permis · Échap annule';
    } else if (patternView.mirroring) {
      message =
        '⧎ miroir cousu : cliquez le bord-AXE d’une pièce (le milieu-devant d’un demi-panneau) — la jumelle symétrique apparaît, cousue le long de cet axe · Échap annule';
    } else if (patternView.fullnessing) {
      message = patternView.fullnessArmed
        ? '⧢ pivot posé (point vert) — cliquez maintenant le bord qui doit S’OUVRIR (l’ourlet pour un évasé), puis choisissez les cm · Échap annule'
        : '⧢ évasement : cliquez le PIVOT sur le contour (le bord qui reste fermé), puis le bord qui gagne l’ampleur — couper-pivoter du patronage · Échap désarme';
    } else if (patternView.precisioning) {
      message = precisionAlign
        ? '⌗ alignement — cliquez le sommet de RÉFÉRENCE (même pièce) : le premier sommet prendra sa verticale ou son horizontale'
        : '⌖ précision : un SOMMET = équerre ou alignement · un BORD = diviser en N parts égales · un BOUT de ligne interne = prolonger au contour · un MILIEU = scinder en deux · Échap désarme';
    } else if (patternView.holing) {
      message =
        '⌾ évider : cliquez une ligne interne FERMÉE (dessinée au ▱) — elle devient un TROU, découpé du maillage 3D et imprimé en trait plein · re-clic dessus = rebouchée · Échap désarme';
    } else if (patternView.merging) {
      message =
        '⧉ fusionner : cliquez le LIEN d’une couture — ses deux pièces se fondent en une seule, décor compris · seuls des bords superposables à plat fusionnent (refus motivé sinon) · Échap désarme';
    } else if (patternView.notching) {
      message =
        '⌵ crans : clic près d’un bord = cran posé (re-clic dessus = retiré) · clic sur le LIEN d’une couture = crans d’accord appariés des deux côtés · imprimés sur le patron · Échap désarme';
    } else if (patternView.curvePointing) {
      message =
        '∿ point courbe : saisissez un SOMMET du contour et glissez — le rayon de l’arrondi suit en cm ; un clic simple = 40 % du bord voisin · le coin devient un arc, coutures préservées · Échap désarme';
    } else if (patternView.fisheyeDrawing) {
      message = patternView.fisheyeArmed
        ? '◆ pince losange — 2e clic = la pointe basse, 3e clic à côté de l’axe = la largeur de taille (cm en direct) · Échap annule'
        : '◆ pince losange : cliquez la POINTE HAUTE dans une pièce (taille, poitrine), puis la pointe basse, puis la largeur · pince de bord = Alt + glisser un bord · Échap désarme';
    } else if (patternView.internalDrawing) {
      message = patternView.internalTraceArmed
        ? '▱ ligne interne en cours — cliquez point par point DANS la pièce · re-clic au 1er point = polygone fermé · re-clic au dernier = polyligne · Échap annule'
        : '▱ ligne interne : cliquez DANS une pièce pour poser le 1er point (style, pliure, repère) · cliquer une ligne existante = la supprimer · Échap désarme';
    } else if (patternView.cutting) {
      message = patternView.cutPickArmed
        ? '✂ 1er point posé (en orange) — cliquez le 2e point sur le contour de la MÊME pièce : elle se scinde et la couture se pose seule · Échap annule'
        : '✂ découper : deux clics sur le contour = corde droite · un clic sur une LIGNE INTERNE (▱) = scinder le long de son tracé, courbes comprises · Échap annule';
    } else if (!(document.getElementById('offset-chooser') as HTMLElement | null)?.hidden) {
      message =
        '⇱ offset : choisissez la distance — vers l’extérieur pour l’aisance, vers l’intérieur pour une doublure · les coutures restent posées';
    } else if (patternView.gathering) {
      message =
        '〰 fronces : cliquez le lien d’une couture (le trait entre deux bords cousus), puis choisissez le côté qui fronce et le ratio · Échap annule';
    } else if (patternView.lengthEditing) {
      message = patternView.lengthSnapping
        ? '🧲 ajustement auto : glissez près de la bonne valeur — priorité à la couture, puis même longueur/parallèle et angle droit · hors de la zone proche, le bord reste libre · Ctrl+Z annule'
        : '↔ longueur : ligne droite = tirer une extrémité · courbe jaune = longueur totale, tirer près d’une extrémité · violet = même longueur, vert = angle droit · aucun maximum · Ctrl+Z annule';
    } else if (!atelierDesign) {
      message =
        'Essayage 3D actif : tournez la vue dans le vide, tirez le tissu pour tester son retour et utilisez ← Revenir au patron pour modifier les pièces.';
    } else if (arrangeMode) {
      message = arrangePick
        ? '⊹ pièce saisie — cliquez une pastille autour du corps pour l’y ranger · re-cliquer une autre pièce change la saisie · Échap annule'
        : '⊹ arrangement : cliquez une pièce dans la vue 3D, puis une pastille (Devant, Dos, Bras…) — préparation seulement, coutures inchangées · Échap annule';
    } else if (sketch3dMode) {
      message = sketch3dPoints.length
        ? '⛶ croquis en cours sur le corps — re-clic au 1er point = fermer et PLACER la zone · au dernier = retirer le point · Échap annule'
        : '⛶ croquis sur le corps : de FACE, cliquez des points sur le mannequin — la zone fermée devient une pièce du patron, placée où vous voulez · ⋈ la symétrise sur l’axe · Échap désarme';
    } else if (edit3dMode) {
      message = edit3dDrag
        ? '⬦ sommet saisi — il suit votre main sur le plan de sa pièce · relâchez pour committer (cm affichés), Échap annule'
        : '⬦ contour en 3D : les sommets du patron s’allument sur le tissu — tirez-en un directement · le 2D suit, les coutures recousent · Échap désarme';
    } else if (draw3dMode) {
      message = draw3dPoints.length
        ? '✎ tracé sur le tissu en cours — cliquez la suite sur la MÊME pièce · re-clic au 1er point = polygone fermé · au dernier = polyligne · Échap annule'
        : '✎ dessin sur le tissu : cliquez des points sur une pièce plate de la préparation 3D — le tracé retombe en ligne interne du patron, scindable au ✂ · Échap désarme';
    } else if (move3DEnabled) {
      message =
        '✥ déplacement 3D : glissez l’exemplaire voulu, ou cliquez-le — trièdre X·Y·Z, tirer une flèche = déplacement précis sur cet axe, en cm · Échap range le trièdre · patron et coutures inchangés · ▶ Simuler recale automatiquement';
    } else {
      message =
        'atelier : un clic pièce 2D = sélectionner (gauche ou droit) · Cmd/Ctrl + clic = groupe · tirer un coin = taille commune · Poche / applique = cliquer son support puis retirer les × voulus';
    }
    hintEl.textContent = message;
    guidanceEl.textContent = message;
    syncAtelierControls();
  };

  // The editable measurements of the current scene, pinned to their cut edges.
  const patternHandles = (): PatternHandleSpec[] => {
    if (sceneMode === 'robe' || sceneMode === 'tenue') {
      // 'tenue' renders the same dressPattern (dress over tee) at a higher cut,
      // so it gets the same silhouette handles — matching the build's tenue
      // topY (1.78 + dyShoulder) so the handles land on the piece (M34).
      const grid = {
        width: 0.95 * lastGrade.dressScale,
        topY: (sceneMode === 'tenue' ? 1.78 : 1.6) + lastGrade.dyShoulder,
        height: dressPattern.length,
      };
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
  // The first scene has nothing to tear down. Build it synchronously from the
  // caller's perspective before constructing controls whose preset callbacks
  // write into the live system.
  // Boot atelier : l'atelier ouvre en espace partagé 2D/3D. buildNow lève déjà
  // `atelier-active` (via updateAtelierBar) et l'état vide, mais pas la scission
  // du panneau — on l'arme ici pour que la Conception 2D s'affiche d'emblée.
  if (sceneMode === 'atelier') setBig(true);
  await buildNow(sceneMode);

  // DEV: inject a dart into the current atelier piece (test the cup before the
  // placement UI lands).
  if (import.meta.env.DEV) {
    (window as unknown as { __toileDart?: (a: [number, number], la: [number, number], lb: [number, number]) => void }).__toileDart =
      (apex, legA, legB) => {
        if (draft) {
          draft.piece.darts.push({ apex, legA, legB });
          draftTouched = true;
          build();
        }
      };
  }

  // ORGANISER EN 3D — particle → draft piece, based on the ranges registered
  // by the actual builder. A repeated cutting piece keeps one shared pattern
  // pid but returns only the physical instance that was actually clicked.
  const pieceRangeAt = (
    i: number,
  ): { pid: number; instance: number; ranges: PieceParticleRange[] } | null => {
    if (!draft) return null;
    for (const [pid, ranges] of pieceParticleRanges) {
      const hit = ranges.find(
        (range) => i >= range.first && i < range.first + range.count,
      );
      if (!hit) continue;
      return {
        pid,
        instance: hit.instance,
        ranges: ranges.filter((range) => range.instance === hit.instance),
      };
    }
    return null;
  };
  /**
   * Picker unique de préparation 3D : il ne considère que les plages qui
   * appartiennent réellement à une pièce du patron. Le survol et le clic
   * partagent donc exactement la même cible, même si un tube système ou une
   * pièce cachée est plus près du rayon.
   */
  const pickStagingPiece = (
    ray: {
      origin: readonly [number, number, number];
      dir: readonly [number, number, number];
    },
  ): StagingPiecePick | null => {
    if (!posCache) return null;
    const hit = pickFrontmostInRanges(
      posCache,
      system.count,
      taggedPieceRanges,
      ray.origin,
      ray.dir,
      STAGING_PICK_RADIUS,
      (index) => system.isMovable(index),
      camera.pickSlopeForPixels(
        STAGING_PICK_RADIUS_PX,
        canvas.clientHeight,
      ),
    );
    if (!hit) return null;
    const ranges = (pieceParticleRanges.get(hit.tag.pid) ?? []).filter(
      (range) => range.instance === hit.tag.instance,
    );
    if (!ranges.length) return null;
    return {
      ...hit.tag,
      index: hit.index,
      depth: hit.depth,
      ranges,
    };
  };
  const draftPieceOf = (pid: number): DraftPiece | null => {
    if (!draft) return null;
    if (pid === 0) return draft.piece;
    if (pid === 1) return draft.back ?? draft.piece; // dos absent = miroir du devant
    return draft.pieces?.[pid - 2] ?? null;
  };
  // Saisie « ce qu'on voit » : parmi les particules proches du rayon, prendre
  // la plus EN AVANT (profondeur minimale) — pickParticle prend la plus proche
  // du rayon, ce qui peut attraper le DOS à travers le corps quand on vise une
  // manche (les pièces à plat s'empilent en profondeur, contrairement au drapé).
  const pickFrontmost = (
    ray: { origin: readonly [number, number, number]; dir: readonly [number, number, number] },
    maxPerp = 0.07,
  ): { index: number; depth: number } | null => {
    if (!posCache) return null;
    const count = Math.min(system.count, posCache.length / 4);
    let best: { index: number; depth: number } | null = null;
    const maxPerp2 = maxPerp * maxPerp;
    for (let i = 0; i < count; i++) {
      if (!system.isMovable(i)) continue;
      const vx = posCache[i * 4]! - ray.origin[0];
      const vy = posCache[i * 4 + 1]! - ray.origin[1];
      const vz = posCache[i * 4 + 2]! - ray.origin[2];
      const t = vx * ray.dir[0] + vy * ray.dir[1] + vz * ray.dir[2];
      if (t <= 0) continue;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 <= maxPerp2 && (!best || t < best.depth)) best = { index: i, depth: t };
    }
    return best;
  };
  // Clic 3D près d'un BORD de pièce → (pièce, bord de contour) pour la couture.
  const pieceEdgeAt = (i: number): { pid: number; edge: number } | null => {
    const pr = pieceRangeAt(i);
    if (!pr) return null;
    const piece = draftPieceOf(pr.pid);
    if (!piece) return null;
    const r2 = resolution * resolution;
    const local = i % r2; // cellule dans son panneau (les 2 panneaux partagent la grille UV)
    const u = ((local % resolution) + 0.5) / resolution;
    const v = (Math.floor(local / resolution) + 0.5) / resolution;
    const ne = nearestOutlineEdgeInfo([u, v], piece.outline);
    if (ne.dist > 2.5 / resolution) return null; // trop loin du bord : pas un choix de couture
    return { pid: pr.pid, edge: ne.edge };
  };
  // SURLIGNAGE 3D — le contour d'une pièce en coordonnées MONDE (la même
  // géométrie que son spawn : faces à ±gap/2, pièce libre devant le corps,
  // manche inclinée sur son bras, col autour du cou). `delta` = translation
  // vivante pendant une saisie.
  const outlineWorld = (
    pid: number,
    delta: readonly [number, number, number] = [0, 0, 0],
    instance = 0,
  ): [number, number, number][] | null => {
    if (!draft) return null;
    const piece = draftPieceOf(pid);
    if (!piece) return null;
    const staged = atelierDesign
      ? stagingOffsetOf(piece, instance)
      : ([0, 0, 0] as const);
    const shift: [number, number, number] = [
      staged[0] + delta[0],
      staged[1] + delta[1],
      staged[2] + delta[2],
    ];
    const base = draft.piece;
    const w = piece.width;
    const h = piece.height;
    const pts: [number, number, number][] = [];
    if (draft.preset === 'loose-pants' && (pid === 0 || pid === 1)) {
      const legCenter = Math.min(
        0.12,
        Math.max(0.075, lastMeasure.hip.circ * 0.1),
      );
      const z = pid === 0 ? base.gap / 2 : -base.gap / 2;
      for (const [u, v] of piece.outline) {
        const sourceX = (u - 0.5) * w;
        pts.push([
          (instance === 0 ? -sourceX - legCenter : sourceX + legCenter) +
            shift[0],
          piece.topY - v * h + shift[1],
          z + shift[2],
        ]);
      }
    } else if (pid >= 2 && (piece.wrap === 'armL' || piece.wrap === 'armR')) {
      const sign = piece.wrap === 'armR' ? 1 : -1;
      // Même géométrie que le spawn : T-pose (scans) = tube horizontal,
      // centré sur l'axe mesuré du bras quand il existe.
      const tPose = bodyKind.startsWith('scan');
      const theta = tPose ? sign * (Math.PI / 2) : Math.atan2(0.11 * (h / 0.5) * sign, h);
      const marm = lastMeasure.arm;
      const pivotY = tPose ? (marm ? marm.y : piece.topY - 0.06) : piece.topY;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const armX = (tPose && marm ? marm.rootX + 0.06 : lastMeasure.shoulderHalfW) * sign;
      const armZ = tPose && marm ? marm.z : 0;
      for (const [u, v] of piece.outline) {
        const px = (u - 0.5) * w;
        const py = -v * h; // relatif au pivot
        pts.push([px * cosT - py * sinT + armX + shift[0], px * sinT + py * cosT + pivotY + shift[1], piece.gap / 2 + armZ + shift[2]]);
      }
    } else {
      const z = pid === 0 ? base.gap / 2 : pid === 1 ? -base.gap / 2 : piece.wrap === 'neck' ? piece.gap / 2 : piece.gap / 2 + base.gap / 2;
      for (const [u, v] of piece.outline) {
        pts.push([(u - 0.5) * w + shift[0], piece.topY - v * h + shift[1], z + shift[2]]);
      }
    }
    return pts;
  };
  /**
   * Topological boundary particles for one physical cutting instance.
   * The result is cached for the current build: camera motion and staging
   * translation change positions, never this grid topology.
   */
  const physicalPieceBoundaries = (
    pid: number,
    instance: number,
  ): Array<{ first: number; indices: number[] }> => {
    const key = `${pid}:${instance}`;
    const cached = pieceBoundaryIndexCache.get(key);
    if (cached) return cached;

    const panelSize = resolution * resolution;
    const boundaries: Array<{ first: number; indices: number[] }> = [];
    const ranges = (pieceParticleRanges.get(pid) ?? []).filter(
      (range) => range.instance === instance,
    );
    for (const range of ranges) {
      for (
        let panelOffset = 0;
        panelOffset < range.count;
        panelOffset += panelSize
      ) {
        const first = range.first + panelOffset;
        const count = Math.min(panelSize, range.count - panelOffset);
        const live = (local: number): boolean =>
          local >= 0 &&
          local < count &&
          first + local < system.count &&
          (currentMesh?.invMasses[first + local] ?? 0) !== 0;
        const boundary: number[] = [];
        for (let local = 0; local < count; local++) {
          if (!live(local)) continue;
          const x = local % resolution;
          const y = Math.floor(local / resolution);
          if (
            x === 0 ||
            y === 0 ||
            x === resolution - 1 ||
            y === resolution - 1 ||
            !live(local - 1) ||
            !live(local + 1) ||
            !live(local - resolution) ||
            !live(local + resolution)
          ) {
            boundary.push(first + local);
          }
        }
        if (boundary.length) boundaries.push({ first, indices: boundary });
      }
    }
    pieceBoundaryIndexCache.set(key, boundaries);
    return boundaries;
  };
  // Mappeur (u,v) → monde pour une CELLULE quelconque d'une pièce (pas
  // seulement le contour) — même géométrie de spawn qu'outlineWorld ; sert au
  // surlignage 3D des liens système (cellules intérieures épinglées).
  const uvWorldOf = (pid: number): ((u: number, v: number) => [number, number, number]) | null => {
    if (!draft) return null;
    const piece = draftPieceOf(pid);
    if (!piece) return null;
    const staged = atelierDesign ? stagingOffsetOf(piece) : ([0, 0, 0] as const);
    const base = draft.piece;
    const w = piece.width;
    const h = piece.height;
    if (pid >= 2 && (piece.wrap === 'armL' || piece.wrap === 'armR')) {
      const sign = piece.wrap === 'armR' ? 1 : -1;
      const tPose = bodyKind.startsWith('scan');
      const theta = tPose ? sign * (Math.PI / 2) : Math.atan2(0.11 * (h / 0.5) * sign, h);
      const marm = lastMeasure.arm;
      const pivotY = tPose ? (marm ? marm.y : piece.topY - 0.06) : piece.topY;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const armX = (tPose && marm ? marm.rootX + 0.06 : lastMeasure.shoulderHalfW) * sign;
      const armZ = tPose && marm ? marm.z : 0;
      return (u, v) => {
        const px = (u - 0.5) * w;
        const py = -v * h;
        return [
          px * cosT - py * sinT + armX + staged[0],
          px * sinT + py * cosT + pivotY + staged[1],
          piece.gap / 2 + armZ + staged[2],
        ];
      };
    }
    const z = pid === 0 ? base.gap / 2 : pid === 1 ? -base.gap / 2 : piece.wrap === 'neck' ? piece.gap / 2 : piece.gap / 2 + base.gap / 2;
    return (u, v) => [
      (u - 0.5) * w + staged[0],
      piece.topY - v * h + staged[1],
      z + staged[2],
    ];
  };
  // Par-dessus le rendu 3D (canvas miroir) : 🪡 armé → les contours de TOUTES
  // les pièces s'allument (voilà ce qui se clique) ; le 1er bord retenu =
  // trait ORANGE épais ; une pièce saisie = contour orange qui suit la main.
  const drawAtelierOverlay = (): void => {
    if (!mirrorCtx) return;
    // ⊹ Pastilles d'arrangement — dessinées même sur un modèle intégré tout
    // frais (le gate teePreset ne concerne que le surlignage patronnage).
    if (arrangeMode && sceneMode === 'atelier' && atelierDesign) {
      const W = mirror.width;
      const H = mirror.height;
      const toScreen = (pos: readonly [number, number, number]): [number, number] | null => {
        const ndc = arrangeNdcOf(pos);
        if (!ndc) return null;
        return [(ndc[0] * 0.5 + 0.5) * W, (1 - (ndc[1] * 0.5 + 0.5)) * H];
      };
      mirrorCtx.font = '600 11px Inter, ui-sans-serif, sans-serif';
      mirrorCtx.textAlign = 'center';
      for (const point of currentArrangePoints()) {
        const sp = toScreen(point.pos);
        if (!sp) continue;
        const hovered = arrangeHoverId === point.id;
        mirrorCtx.beginPath();
        mirrorCtx.arc(sp[0], sp[1], hovered ? 11 : 8, 0, Math.PI * 2);
        mirrorCtx.fillStyle = hovered ? 'rgba(255, 159, 107, 0.95)' : 'rgba(112, 184, 255, 0.85)';
        mirrorCtx.fill();
        mirrorCtx.lineWidth = 2;
        mirrorCtx.strokeStyle = 'rgba(14, 15, 18, 0.9)';
        mirrorCtx.stroke();
        mirrorCtx.beginPath();
        mirrorCtx.arc(sp[0], sp[1], 2.6, 0, Math.PI * 2);
        mirrorCtx.fillStyle = 'rgba(14, 15, 18, 0.95)';
        mirrorCtx.fill();
        if (hovered || arrangePick) {
          mirrorCtx.fillStyle = hovered ? 'rgba(255, 214, 184, 1)' : 'rgba(203, 224, 244, 0.85)';
          mirrorCtx.fillText(point.labelFr, sp[0], sp[1] - 14);
        }
      }
      // La pièce saisie : anneau orange sur son centre + rappel du geste.
      if (arrangePick) {
        const centroid = stagingInstanceCentroid(arrangePick.pid, arrangePick.instance);
        const sp = centroid ? toScreen(centroid) : null;
        if (sp) {
          mirrorCtx.beginPath();
          mirrorCtx.arc(sp[0], sp[1], 14, 0, Math.PI * 2);
          mirrorCtx.lineWidth = 2.5;
          mirrorCtx.strokeStyle = 'rgba(255, 159, 107, 0.95)';
          mirrorCtx.stroke();
        }
      }
      mirrorCtx.textAlign = 'start';
    }
    if (sceneMode !== 'atelier' || !draft || teePreset) return;
    const sewing = patternView.sewing;
    const zippering = patternView.zippering;
    const pick = patternView.zipperPick ?? patternView.seamPick;
    const surfacePieces = (draft.pieces ?? [])
      .map((piece, index) => ({ piece, pieceId: index + 2 }))
      .filter(({ piece }) => !!piece.placement?.surface);
    const triad =
      gizmoPick && move3DEnabled && atelierDesign && !arrangeMode
        ? gizmoPick
        : null;
    const anyInternal =
      (atelierDesign &&
        (docPieces(draft).some((piece) => !!piece?.internalLines?.length) ||
          (draw3dMode && draw3dPoints.length > 0) ||
          edit3dMode)) ||
      (sketch3dMode && sketch3dPoints.length > 0);
    if (
      !sewing &&
      !zippering &&
      !pick &&
      !pieceHover &&
      !pieceDrag &&
      !triad &&
      !anyInternal &&
      !surfacePieces.length
    ) {
      return;
    }
    const m = camera.matrix(canvas.width / Math.max(1, canvas.height));
    const W = mirror.width;
    const H = mirror.height;
    const proj = (p: [number, number, number]): [number, number] | null => {
      const cw = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
      if (cw <= 1e-6) return null; // derrière la caméra
      const cx = (m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / cw;
      const cy = (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / cw;
      return [(cx * 0.5 + 0.5) * W, (1 - (cy * 0.5 + 0.5)) * H];
    };
    const stroke = (
      pid: number,
      style: string,
      width: number,
      delta?: readonly [number, number, number],
      instance = 0,
    ): void => {
      const pts = outlineWorld(pid, delta, instance);
      if (!pts) return;
      mirrorCtx.strokeStyle = style;
      mirrorCtx.lineWidth = width;
      mirrorCtx.beginPath();
      let started = false;
      for (const p of pts) {
        const s = proj(p);
        if (!s) continue;
        if (started) mirrorCtx.lineTo(s[0], s[1]);
        else {
          mirrorCtx.moveTo(s[0], s[1]);
          started = true;
        }
      }
      if (started) {
        mirrorCtx.closePath();
        mirrorCtx.stroke();
      }
    };
    type ScreenPoint = [number, number];
    const convexHull = (points: ScreenPoint[]): ScreenPoint[] => {
      if (points.length <= 2) return points;
      points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (
        o: ScreenPoint,
        a: ScreenPoint,
        b: ScreenPoint,
      ): number =>
        (a[0] - o[0]) * (b[1] - o[1]) -
        (a[1] - o[1]) * (b[0] - o[0]);
      const lower: ScreenPoint[] = [];
      for (const point of points) {
        while (
          lower.length >= 2 &&
          cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
        ) {
          lower.pop();
        }
        lower.push(point);
      }
      const upper: ScreenPoint[] = [];
      for (let index = points.length - 1; index >= 0; index--) {
        const point = points[index]!;
        while (
          upper.length >= 2 &&
          cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
        ) {
          upper.pop();
        }
        upper.push(point);
      }
      lower.pop();
      upper.pop();
      return [...lower, ...upper];
    };
    const physicalContours = (
      pid: number,
      instance: number,
      positions: Float32Array,
      delta: readonly [number, number, number] = [0, 0, 0],
    ): ScreenPoint[][] => {
      const contours: ScreenPoint[][] = [];
      const piece = draftPieceOf(pid);
      for (const boundaryGroup of physicalPieceBoundaries(pid, instance)) {
        const { first, indices: boundary } = boundaryGroup;
        let ordered = boundary;
        if (piece && piece.outline.length >= 3) {
          const sampled: number[] = [];
          const seen = new Set<number>();
          for (let edge = 0; edge < piece.outline.length; edge++) {
            const a = piece.outline[edge]!;
            const b = piece.outline[(edge + 1) % piece.outline.length]!;
            const steps = Math.max(
              1,
              Math.ceil(
                Math.hypot(
                  (b[0] - a[0]) * (resolution - 1),
                  (b[1] - a[1]) * (resolution - 1),
                ) * 1.25,
              ),
            );
            for (let step = 0; step < steps; step++) {
              const t = step / steps;
              const tx =
                Math.min(1, Math.max(0, a[0] + (b[0] - a[0]) * t)) *
                (resolution - 1);
              const ty =
                Math.min(1, Math.max(0, a[1] + (b[1] - a[1]) * t)) *
                (resolution - 1);
              let nearest = -1;
              let nearestD2 = Number.POSITIVE_INFINITY;
              for (const index of boundary) {
                const local = index - first;
                const dx = (local % resolution) - tx;
                const dy = Math.floor(local / resolution) - ty;
                const d2 = dx * dx + dy * dy;
                if (d2 < nearestD2) {
                  nearestD2 = d2;
                  nearest = index;
                }
              }
              if (nearest >= 0 && sampled.at(-1) !== nearest) {
                sampled.push(nearest);
                seen.add(nearest);
              }
            }
          }
          // An ordered UV contour preserves armholes, necklines and trouser
          // forks. If a specialised folded panel cannot be mapped reliably,
          // retain the topology-only convex fallback below.
          if (seen.size >= Math.max(3, Math.ceil(boundary.length * 0.35))) {
            if (sampled.length > 1 && sampled.at(-1) === sampled[0]) {
              sampled.pop();
            }
            ordered = sampled;
          }
        }
        const points: ScreenPoint[] = [];
        for (const index of ordered) {
          if (index * 4 + 2 >= positions.length) continue;
          const x = positions[index * 4]! + delta[0];
          const y = positions[index * 4 + 1]! + delta[1];
          const z = positions[index * 4 + 2]! + delta[2];
          if (![x, y, z].every(Number.isFinite)) continue;
          const point = proj([x, y, z]);
          if (point) points.push(point);
        }
        const contour = ordered === boundary ? convexHull(points) : points;
        if (contour.length >= 2) contours.push(contour);
      }
      return contours;
    };
    const strokeContours = (
      contours: readonly ScreenPoint[][],
      style: string,
      width: number,
    ): void => {
      mirrorCtx.strokeStyle = style;
      mirrorCtx.lineWidth = width;
      mirrorCtx.lineJoin = 'round';
      for (const contour of contours) {
        mirrorCtx.beginPath();
        mirrorCtx.moveTo(contour[0]![0], contour[0]![1]);
        for (let index = 1; index < contour.length; index++) {
          mirrorCtx.lineTo(contour[index]![0], contour[index]![1]);
        }
        mirrorCtx.closePath();
        mirrorCtx.stroke();
      }
      mirrorCtx.lineJoin = 'miter';
    };
    const nPieces = 2 + (draft.pieces?.length ?? 0);
    if (sewing || zippering || pick) {
      const guideColor = zippering
        ? 'rgba(255, 211, 77, 0.7)'
        : 'rgba(150, 195, 255, 0.55)';
      for (let pid = 0; pid < nPieces; pid++) {
        stroke(pid, guideColor, 1.5);
      }
      // Les bords DÉJÀ cousus, chacun dans la couleur de sa couture (la même
      // qu'au plan 2D) : on voit sur l'avatar quel bord est lié à quel bord.
      const strokeRun3D = (fr: { from: number; to: number; face?: 'front' | 'back'; pieceId?: number }, color: string): void => {
        const pid = pieceIdOf(fr);
        const piece = draftPieceOf(pid);
        const pts = outlineWorld(pid);
        if (!piece || !pts) return;
        const N = piece.outline.length;
        const steps = ((fr.to - fr.from + N) % N) || 1;
        mirrorCtx.strokeStyle = color;
        mirrorCtx.lineWidth = 3;
        mirrorCtx.beginPath();
        let started = false;
        for (let i = 0; i <= steps; i++) {
          const s = proj(pts[(fr.from + i) % N]!);
          if (!s) continue;
          if (started) mirrorCtx.lineTo(s[0], s[1]);
          else {
            mirrorCtx.moveTo(s[0], s[1]);
            started = true;
          }
        }
        if (started) mirrorCtx.stroke();
      };
      (draft.seams ?? []).forEach((s, k) => {
        const color =
          s.kind === 'zipper'
            ? 'rgba(255, 211, 77, 0.98)'
            : SEAM_COLORS[k % SEAM_COLORS.length]!;
        strokeRun3D(s.a, color);
        strokeRun3D(s.b, color);
      });
      // Liens SYSTÈME (manche↔emmanchure, col↔encolure) : mêmes couleurs
      // qu'au plan 2D (suite du cycle après les coutures manuelles).
      const nSeams = (draft.seams ?? []).length;
      systemLinks.forEach((sl, k) => {
        const color = SEAM_COLORS[(nSeams + k) % SEAM_COLORS.length]!;
        const drawCells = (pid: number, cells: [number, number][]): void => {
          const map = uvWorldOf(pid);
          if (!map || cells.length < 2) return;
          mirrorCtx.strokeStyle = color;
          mirrorCtx.lineWidth = 3;
          mirrorCtx.beginPath();
          let started = false;
          for (const [u, v] of cells) {
            const s = proj(map(u, v));
            if (!s) continue;
            if (started) mirrorCtx.lineTo(s[0], s[1]);
            else mirrorCtx.moveTo(s[0], s[1]);
            started = true;
          }
          if (started) mirrorCtx.stroke();
        };
        drawCells(0, sl.body0);
        drawCells(1, sl.body1);
        drawCells(sl.pid, sl.piece);
      });
    }
    // Pockets/appliqués: the stitch path lives inside the chosen support, not
    // on its outer cutting edge. Draw each retained segment at that exact
    // surface position, matching the orange removable stitches in the 2D plan.
    for (const { piece, pieceId } of surfacePieces) {
      const surface = piece.placement!.surface!;
      const support = draftPieceOf(surface.supportPieceId);
      const map = uvWorldOf(surface.supportPieceId);
      if (!support || !map) continue;
      const liveRange = pieceParticleRanges.get(surface.supportPieceId)?.[0];
      const surfaceWorld = (uv: readonly [number, number]): [number, number, number] => {
        if (!atelierDesign && posCache && liveRange) {
          const u = Math.min(resolution - 1, Math.max(0, Math.round(uv[0] * (resolution - 1))));
          const v = Math.min(resolution - 1, Math.max(0, Math.round(uv[1] * (resolution - 1))));
          const index = liveRange.first + v * resolution + u;
          if (index < posCache.length / 4 && system.isMovable(index)) {
            return [
              posCache[index * 4]!,
              posCache[index * 4 + 1]!,
              posCache[index * 4 + 2]!,
            ];
          }
        }
        return map(uv[0], uv[1]);
      };
      mirrorCtx.strokeStyle = 'rgba(255, 184, 84, 0.96)';
      mirrorCtx.lineWidth = 3;
      mirrorCtx.setLineDash([3, 3]);
      for (const edge of surface.stitchedEdges) {
        const a = piece.outline[edge % piece.outline.length];
        const b = piece.outline[(edge + 1) % piece.outline.length];
        if (!a || !b) continue;
        const wa = surfaceAttachmentUV(piece, support, surface, a);
        const wb = surfaceAttachmentUV(piece, support, surface, b);
        const pa = proj(surfaceWorld(wa));
        const pb = proj(surfaceWorld(wb));
        if (!pa || !pb) continue;
        mirrorCtx.beginPath();
        mirrorCtx.moveTo(pa[0], pa[1]);
        mirrorCtx.lineTo(pb[0], pb[1]);
        mirrorCtx.stroke();
      }
      mirrorCtx.setLineDash([]);
      // Keep the selected pocket itself identifiable while its stitches are
      // shown on the support.
      if (patternView.activeDraftPieceId === pieceId) {
        for (const edge of surface.stitchedEdges) {
          const a = piece.outline[edge % piece.outline.length];
          const b = piece.outline[(edge + 1) % piece.outline.length];
          if (!a || !b) continue;
          const wa = surfaceAttachmentUV(piece, support, surface, a);
          const wb = surfaceAttachmentUV(piece, support, surface, b);
          const pa = proj(surfaceWorld(wa));
          const pb = proj(surfaceWorld(wb));
          if (!pa || !pb) continue;
          mirrorCtx.strokeStyle = 'rgba(255, 220, 170, 0.95)';
          mirrorCtx.lineWidth = 1;
          mirrorCtx.beginPath();
          mirrorCtx.moveTo(pa[0], pa[1]);
          mirrorCtx.lineTo(pb[0], pb[1]);
          mirrorCtx.stroke();
        }
      }
    }
    if (pick) {
      const pts = outlineWorld(pick.pieceId);
      if (pts) {
        const a = proj(pts[pick.edge % pts.length]!);
        const b = proj(pts[(pick.edge + 1) % pts.length]!);
        if (a && b) {
          mirrorCtx.strokeStyle = patternView.zipperPick
            ? 'rgba(255, 211, 77, 0.98)'
            : 'rgba(255, 159, 107, 0.98)';
          mirrorCtx.lineWidth = 5;
          mirrorCtx.lineCap = 'round';
          mirrorCtx.beginPath();
          mirrorCtx.moveTo(a[0], a[1]);
          mirrorCtx.lineTo(b[0], b[1]);
          mirrorCtx.stroke();
          mirrorCtx.lineCap = 'butt';
        }
      }
    }
    if (pieceHover && !pieceDrag) {
      const contours = posCache
        ? physicalContours(
            pieceHover.pid,
            pieceHover.instance,
            posCache,
        )
        : [];
      if (contours.length) {
        strokeContours(contours, 'rgba(112, 202, 255, 0.24)', 6);
        strokeContours(contours, 'rgba(160, 225, 255, 0.98)', 2.5);
      } else {
        stroke(
          pieceHover.pid,
          'rgba(112, 202, 255, 0.24)',
          6,
          undefined,
          pieceHover.instance,
        );
        stroke(
          pieceHover.pid,
          'rgba(160, 225, 255, 0.98)',
          2.5,
          undefined,
          pieceHover.instance,
        );
      }
    }
    if (pieceDrag) {
      const contours = physicalContours(
        pieceDrag.pid,
        pieceDrag.instance,
        pieceDrag.positions,
        pieceDrag.delta,
      );
      if (contours.length) {
        strokeContours(contours, 'rgba(255, 159, 107, 0.9)', 2.5);
      } else {
        stroke(
          pieceDrag.pid,
          'rgba(255, 159, 107, 0.9)',
          2.5,
          pieceDrag.delta,
          pieceDrag.instance,
        );
      }
    }
    // ⛶ Croquis sur le corps : points + fil sur le plan frontal, écho miroir
    // en pointillé quand ⋈ est armé, 1er point allumé dès que fermable.
    if (sketch3dMode && sketch3dPoints.length) {
      const dimsS = draft.piece;
      const zS = dimsS.gap / 2;
      const sp = sketch3dPoints
        .map((q) => proj([q[0], q[1], zS]))
        .filter((q): q is [number, number] => q !== null);
      if (sp.length) {
        if (patternView.penMirroring) {
          const echo = sketch3dPoints
            .filter((q) => Math.abs(q[0]) > 1e-9)
            .map((q) => proj([-q[0], q[1], zS]))
            .filter((q): q is [number, number] => q !== null)
            .reverse();
          if (echo.length) {
            mirrorCtx.strokeStyle = 'rgba(127, 178, 255, 0.5)';
            mirrorCtx.lineWidth = 1.4;
            mirrorCtx.setLineDash([4, 4]);
            mirrorCtx.beginPath();
            mirrorCtx.moveTo(sp[sp.length - 1]![0], sp[sp.length - 1]![1]);
            for (const q of echo) mirrorCtx.lineTo(q[0], q[1]);
            mirrorCtx.lineTo(sp[0]![0], sp[0]![1]);
            mirrorCtx.stroke();
            mirrorCtx.setLineDash([]);
          }
        }
        mirrorCtx.strokeStyle = 'rgba(122, 226, 154, 0.95)';
        mirrorCtx.lineWidth = 1.7;
        mirrorCtx.setLineDash([6, 4]);
        mirrorCtx.beginPath();
        sp.forEach((q, i) => (i === 0 ? mirrorCtx.moveTo(q[0], q[1]) : mirrorCtx.lineTo(q[0], q[1])));
        mirrorCtx.stroke();
        mirrorCtx.setLineDash([]);
        for (let i = 0; i < sp.length; i++) {
          const closable = i === 0 && sp.length >= 3;
          mirrorCtx.beginPath();
          mirrorCtx.arc(sp[i]![0], sp[i]![1], closable ? 6 : 3.5, 0, Math.PI * 2);
          mirrorCtx.fillStyle = closable ? 'rgba(255, 159, 107, 0.95)' : 'rgba(255, 255, 255, 0.92)';
          mirrorCtx.fill();
        }
      }
    }
    // ⬦ Édition de contour : toutes les poignées de sommets + le fantôme du
    // contour pendant un drag (le sommet déplacé substitué, en orange).
    if (edit3dMode && atelierDesign) {
      const allP = docPieces(draft);
      for (let pid = 0; pid < allP.length; pid++) {
        const piece = allP[pid];
        if (!piece || piece.blank || piece.wrap) continue;
        const map = uvWorldOf(pid);
        if (!map) continue;
        const dragging = edit3dDrag && edit3dDrag.pid === pid ? edit3dDrag : null;
        if (dragging) {
          mirrorCtx.strokeStyle = 'rgba(255, 159, 107, 0.9)';
          mirrorCtx.lineWidth = 1.6;
          mirrorCtx.setLineDash([5, 4]);
          mirrorCtx.beginPath();
          let started = false;
          for (let k = 0; k <= piece.outline.length; k++) {
            const idx = k % piece.outline.length;
            const src = idx === dragging.vertex ? dragging.uv : piece.outline[idx]!;
            const q = proj(map(src[0], src[1]));
            if (!q) continue;
            if (started) mirrorCtx.lineTo(q[0], q[1]);
            else {
              mirrorCtx.moveTo(q[0], q[1]);
              started = true;
            }
          }
          mirrorCtx.stroke();
          mirrorCtx.setLineDash([]);
        }
        for (let k = 0; k < piece.outline.length; k++) {
          const src = dragging && k === dragging.vertex ? dragging.uv : piece.outline[k]!;
          const q = proj(map(src[0], src[1]));
          if (!q) continue;
          const hot = dragging && k === dragging.vertex;
          mirrorCtx.beginPath();
          mirrorCtx.arc(q[0], q[1], hot ? 6 : 3.5, 0, Math.PI * 2);
          mirrorCtx.fillStyle = hot ? 'rgba(255, 159, 107, 0.95)' : 'rgba(236, 240, 246, 0.9)';
          mirrorCtx.fill();
          if (!hot) {
            mirrorCtx.lineWidth = 1;
            mirrorCtx.strokeStyle = 'rgba(14, 15, 18, 0.8)';
            mirrorCtx.stroke();
          }
        }
      }
    }
    // ✎3D : le tracé en cours sur le tissu — points + fil, 1er/dernier allumés.
    if (draw3dMode && draw3dTarget !== null && draw3dPoints.length && atelierDesign) {
      const map = uvWorldOf(draw3dTarget);
      if (map) {
        const sp = draw3dPoints
          .map(([u, v]) => proj(map(u, v)))
          .filter((q): q is [number, number] => q !== null);
        if (sp.length) {
          mirrorCtx.strokeStyle = 'rgba(255, 214, 170, 0.95)';
          mirrorCtx.lineWidth = 1.6;
          mirrorCtx.setLineDash([6, 4]);
          mirrorCtx.beginPath();
          sp.forEach((q, i) => (i === 0 ? mirrorCtx.moveTo(q[0], q[1]) : mirrorCtx.lineTo(q[0], q[1])));
          mirrorCtx.stroke();
          mirrorCtx.setLineDash([]);
          for (let i = 0; i < sp.length; i++) {
            const closable = i === 0 && sp.length >= 3;
            const endable = i === sp.length - 1 && sp.length >= 2 && i !== 0;
            mirrorCtx.beginPath();
            mirrorCtx.arc(sp[i]![0], sp[i]![1], closable || endable ? 6 : 3.5, 0, Math.PI * 2);
            mirrorCtx.fillStyle = closable
              ? 'rgba(255, 159, 107, 0.95)'
              : endable
                ? 'rgba(122, 226, 154, 0.95)'
                : 'rgba(255, 255, 255, 0.92)';
            mirrorCtx.fill();
          }
        }
      }
    }
    // ▱ Lignes internes sur la préparation 3D : la géométrie plate de chaque
    // pièce est affine (uvWorldOf) — les sommets suffisent, en pointillé fin.
    if (atelierDesign) {
      const allPieces = docPieces(draft);
      for (let pid = 0; pid < allPieces.length; pid++) {
        const piece = allPieces[pid];
        if (!piece?.internalLines?.length || piece.blank) continue;
        const map = uvWorldOf(pid);
        if (!map) continue;
        mirrorCtx.strokeStyle = 'rgba(222, 230, 240, 0.7)';
        mirrorCtx.lineWidth = 1.5;
        mirrorCtx.setLineDash([5, 4]);
        for (const line of piece.internalLines) {
          const sp = line.points
            .map(([u, v]) => proj(map(u, v)))
            .filter((q): q is [number, number] => q !== null);
          if (sp.length < 2) continue;
          mirrorCtx.beginPath();
          sp.forEach((q, i) => (i === 0 ? mirrorCtx.moveTo(q[0], q[1]) : mirrorCtx.lineTo(q[0], q[1])));
          if (line.closed) mirrorCtx.closePath();
          mirrorCtx.stroke();
        }
        mirrorCtx.setLineDash([]);
      }
    }
    // ⌖ Trièdre XYZ au centroïde de l'exemplaire sélectionné (✥). Pendant un
    // drag il suit la pièce ; drag de flèche → l'axe actif seul + cm signés.
    if (triad) {
      const dragging =
        pieceDrag &&
        pieceDrag.pid === triad.pid &&
        pieceDrag.instance === triad.instance
          ? pieceDrag
          : null;
      let base: [number, number, number] | null;
      if (dragging) {
        // Snapshot de saisie + delta : posCache peut déjà refléter la
        // translation en cours, le relire doublerait le déplacement.
        let n = 0;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const range of dragging.ranges) {
          for (let i = range.first; i < range.first + range.count; i++) {
            if (!system.isMovable(i)) continue;
            cx += dragging.positions[i * 4]!;
            cy += dragging.positions[i * 4 + 1]!;
            cz += dragging.positions[i * 4 + 2]!;
            n++;
          }
        }
        base = n
          ? [
              cx / n + dragging.delta[0],
              cy / n + dragging.delta[1],
              cz / n + dragging.delta[2],
            ]
          : null;
      } else {
        base = stagingInstanceCentroid(triad.pid, triad.instance);
      }
      const s0 = base ? proj(base) : null;
      if (base && s0) {
        const active = dragging && dragging.axis !== undefined ? dragging : null;
        mirrorCtx.save();
        mirrorCtx.lineCap = 'round';
        mirrorCtx.font = '700 12px Inter, ui-sans-serif, sans-serif';
        mirrorCtx.textAlign = 'center';
        mirrorCtx.textBaseline = 'middle';
        for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
          if (active && active.axis !== k) continue; // l'axe tiré seul
          const axe = GIZMO_AXES[k]!;
          const s1 = proj([
            base[0] + axe.dir[0] * GIZMO_LEN_M,
            base[1] + axe.dir[1] * GIZMO_LEN_M,
            base[2] + axe.dir[2] * GIZMO_LEN_M,
          ]);
          if (!s1) continue;
          const vx = s1[0] - s0[0];
          const vy = s1[1] - s0[1];
          const len = Math.hypot(vx, vy);
          if (len < 6) continue; // axe quasi perpendiculaire à l'écran
          const ux = vx / len;
          const uy = vy / len;
          mirrorCtx.strokeStyle = axe.color;
          mirrorCtx.lineWidth = active ? 4 : 3;
          mirrorCtx.beginPath();
          mirrorCtx.moveTo(s0[0], s0[1]);
          mirrorCtx.lineTo(s1[0], s1[1]);
          mirrorCtx.stroke();
          mirrorCtx.beginPath();
          mirrorCtx.moveTo(s1[0], s1[1]);
          mirrorCtx.lineTo(s1[0] - ux * 10 - uy * 5, s1[1] - uy * 10 + ux * 5);
          mirrorCtx.moveTo(s1[0], s1[1]);
          mirrorCtx.lineTo(s1[0] - ux * 10 + uy * 5, s1[1] - uy * 10 - ux * 5);
          mirrorCtx.stroke();
          mirrorCtx.fillStyle = axe.color;
          mirrorCtx.fillText(axe.label, s1[0] + ux * 15, s1[1] + uy * 15);
        }
        // ⟳ Anneau de rotation (roll autour de l'axe caméra) — cercle écran fixe
        // autour du centroïde ; masqué pendant un drag d'axe (translation).
        if (!active) {
          const rotting = dragging && dragging.rot ? dragging.rot : null;
          const worldRot = rotting && rotting.plane ? rotting : null;
          // 3 anneaux X/Y/Z (rotation autour d'un axe MONDE). Pendant un drag
          // d'axe, seul l'anneau tiré est tracé (surligné).
          for (let k = 0 as 0 | 1 | 2; k < 3; k = (k + 1) as 0 | 1 | 2) {
            if (worldRot && worldRot.axisIdx !== k) continue;
            mirrorCtx.strokeStyle = GIZMO_AXES[k]!.color;
            mirrorCtx.lineWidth = worldRot && worldRot.axisIdx === k ? 3.5 : 2;
            mirrorCtx.beginPath();
            let started = false;
            for (const pt of rotRingPoints(base, k)) {
              const sp = proj(pt);
              if (!sp) {
                started = false;
                continue;
              }
              if (!started) {
                mirrorCtx.moveTo(sp[0], sp[1]);
                started = true;
              } else {
                mirrorCtx.lineTo(sp[0], sp[1]);
              }
            }
            if (started) mirrorCtx.closePath();
            mirrorCtx.stroke();
          }
          // Anneau ÉCRAN (roll libre autour de l'axe caméra). Rayon dessiné mis
          // à l'échelle du DPR pour coïncider avec la zone d'attrape ; masqué
          // pendant un drag d'axe monde pour ne pas encombrer.
          const ringScale = mirror.clientWidth > 0 ? mirror.width / mirror.clientWidth : 1;
          const ringR = GIZMO_RING_PX * ringScale;
          if (!worldRot) {
            mirrorCtx.beginPath();
            mirrorCtx.arc(s0[0], s0[1], ringR, 0, Math.PI * 2);
            mirrorCtx.strokeStyle = rotting
              ? 'rgba(236, 240, 246, 0.95)'
              : 'rgba(236, 240, 246, 0.5)';
            mirrorCtx.lineWidth = rotting ? 3 : 2;
            mirrorCtx.stroke();
          }
          if (rotting) {
            const deg = (rotting.angle * 180) / Math.PI;
            const label = `${deg >= 0 ? '+' : '−'}${Math.abs(deg).toFixed(0)}°`;
            mirrorCtx.font = '700 13px Inter, ui-sans-serif, sans-serif';
            const w = mirrorCtx.measureText(label).width;
            mirrorCtx.fillStyle = 'rgba(14, 15, 18, 0.85)';
            mirrorCtx.fillRect(s0[0] - w / 2 - 7, s0[1] + ringR + 6, w + 14, 22);
            mirrorCtx.fillStyle = 'rgba(236, 240, 246, 0.95)';
            mirrorCtx.fillText(label, s0[0], s0[1] + ringR + 17);
          }
        }
        mirrorCtx.beginPath();
        mirrorCtx.arc(s0[0], s0[1], active ? 3 : 4.5, 0, Math.PI * 2);
        mirrorCtx.fillStyle = 'rgba(236, 240, 246, 0.95)';
        mirrorCtx.fill();
        mirrorCtx.lineWidth = 1.5;
        mirrorCtx.strokeStyle = 'rgba(14, 15, 18, 0.9)';
        mirrorCtx.stroke();
        if (active && active.axis !== undefined) {
          const t = active.delta[active.axis]!;
          const label = `${t >= 0 ? '+' : '−'}${Math.abs(t * 100)
            .toFixed(1)
            .replace('.', ',')} cm`;
          mirrorCtx.font = '700 13px Inter, ui-sans-serif, sans-serif';
          const w = mirrorCtx.measureText(label).width;
          mirrorCtx.fillStyle = 'rgba(14, 15, 18, 0.85)';
          mirrorCtx.fillRect(s0[0] - w / 2 - 7, s0[1] - 36, w + 14, 22);
          mirrorCtx.fillStyle = GIZMO_AXES[active.axis]!.color;
          mirrorCtx.fillText(label, s0[0], s0[1] - 25);
        }
        mirrorCtx.restore();
      }
    }
  };
  // CLO3D-style pointer model: a left press ON the fabric grabs it; a left
  // press on empty space orbits the camera. Returns true when orbit is allowed.
  const tryOrbit = (e: PointerEvent): boolean => {
    if (sceneTransitionBusy()) return true;
    if (!posCache) return true; // no cache yet → just orbit
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const ray = camera.pickRay(ndcX, ndcY, canvas.width / canvas.height);
    const count = Math.min(system.count, posCache.length / 4);
    // ⊹ Points d'arrangement : 1er clic = la pièce, 2e clic = l'ancre. Un clic
    // dans le vide (ni pièce ni pastille) rend la main à l'orbite caméra.
    // ⛶ Croquis sur le corps : clics sur le plan frontal ; re-clic au 1er
    // (≥3) = zone fermée → pièce + place-chooser ; re-clic au dernier =
    // retirer le point (retouche).
    if (sceneMode === 'atelier' && sketch3dMode) {
      const dims = (draft ?? defaultDraft(resolution as 32 | 64 | 128)).piece;
      const zPlane = dims.gap / 2;
      if (Math.abs(ray.dir[2]) < 1e-6) return false;
      const t = (zPlane - ray.origin[2]) / ray.dir[2];
      if (t < 0.01) return false;
      const wx = ray.origin[0] + ray.dir[0] * t;
      const wy = ray.origin[1] + ray.dir[1] * t;
      const toPx = (q: readonly [number, number]): [number, number] | null => {
        const n0 = arrangeNdcOf([q[0], q[1], zPlane]);
        if (!n0) return null;
        const rect3 = canvas.getBoundingClientRect();
        return [((n0[0] + 1) / 2) * rect3.width, ((1 - n0[1]) / 2) * rect3.height];
      };
      const clickPx: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      const near = (q: readonly [number, number]): boolean => {
        const s0 = toPx(q);
        return !!s0 && (clickPx[0] - s0[0]) ** 2 + (clickPx[1] - s0[1]) ** 2 <= 12 ** 2;
      };
      if (sketch3dPoints.length >= 3 && near(sketch3dPoints[0]!)) {
        commitSketch3d();
        return false;
      }
      if (sketch3dPoints.length >= 1 && near(sketch3dPoints[sketch3dPoints.length - 1]!)) {
        sketch3dPoints.pop(); // retouche : le dernier point s'efface
        return false;
      }
      sketch3dPoints.push([wx, wy]);
      return false;
    }
    // ⬦ Édition de contour : saisir la poignée de sommet la plus proche.
    if (sceneMode === 'atelier' && atelierDesign && edit3dMode) {
      if (!draft) return true;
      const all = docPieces(draft);
      const rect3 = canvas.getBoundingClientRect();
      const px = e.clientX - rect3.left;
      const py = e.clientY - rect3.top;
      let bestPick: { pid: number; vertex: number } | null = null;
      let bestD = 14 ** 2;
      for (let pid = 0; pid < all.length; pid++) {
        const piece = all[pid];
        if (!piece || piece.blank || piece.wrap) continue;
        const map = uvWorldOf(pid);
        if (!map) continue;
        for (let k = 0; k < piece.outline.length; k++) {
          const [u, v] = piece.outline[k]!;
          const n0 = arrangeNdcOf(map(u, v));
          if (!n0) continue;
          const sx = ((n0[0] + 1) / 2) * rect3.width;
          const sy = ((1 - n0[1]) / 2) * rect3.height;
          const d2 = (px - sx) ** 2 + (py - sy) ** 2;
          if (d2 < bestD) {
            bestD = d2;
            bestPick = { pid, vertex: k };
          }
        }
      }
      if (!bestPick) return false; // clic dans le vide : consommé, pas d'orbite
      const piece = all[bestPick.pid]!;
      edit3dDrag = {
        pid: bestPick.pid,
        vertex: bestPick.vertex,
        uv: [...piece.outline[bestPick.vertex]!] as UV,
        moved: false,
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // pointeur synthétique : capture impossible, sans gravité
      }
      return false;
    }
    // ✎3D : chaque clic sur le tissu pose un point ; re-clic au 1er (≥3) =
    // polygone fermé, re-clic au dernier (≥2) = polyligne — comme au ▱ 2D.
    if (sceneMode === 'atelier' && atelierDesign && draw3dMode) {
      const hit = pickDraw3dPoint(ray, draw3dTarget);
      if (!hit) {
        if (draw3dTarget !== null) showToast('Cliquez sur le tissu de la MÊME pièce (les tubes viendront plus tard).');
        return false; // le mode consomme le clic — pas d'orbite surprise
      }
      const toPx = (uv: UV): [number, number] | null => {
        const map = uvWorldOf(hit.pid);
        if (!map) return null;
        const n0 = arrangeNdcOf(map(uv[0], uv[1]));
        if (!n0) return null;
        const rect2 = canvas.getBoundingClientRect();
        return [((n0[0] + 1) / 2) * rect2.width, ((1 - n0[1]) / 2) * rect2.height];
      };
      const clickPx: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      const near = (uv: UV): boolean => {
        const s0 = toPx(uv);
        return !!s0 && (clickPx[0] - s0[0]) ** 2 + (clickPx[1] - s0[1]) ** 2 <= 12 ** 2;
      };
      if (draw3dTarget === null) {
        draw3dTarget = hit.pid;
        draw3dPoints = [hit.uv];
        return false;
      }
      if (draw3dPoints.length >= 3 && near(draw3dPoints[0]!)) {
        commitDraw3d(true);
        return false;
      }
      if (draw3dPoints.length >= 2 && near(draw3dPoints[draw3dPoints.length - 1]!)) {
        commitDraw3d(false);
        return false;
      }
      draw3dPoints.push(hit.uv);
      return false;
    }
    if (sceneMode === 'atelier' && atelierDesign && arrangeMode) {
      const anchor = arrangePointNear(ndcX, ndcY);
      if (anchor && arrangePick) {
        applyArrangement(arrangePick, anchor);
        return false;
      }
      const target = pickStagingPiece(ray);
      if (target) {
        arrangePick = { pid: target.pid, instance: target.instance };
        activeStagingInstance = { pid: target.pid, instance: target.instance };
        patternView.selectPiece(target.pid);
        const label = draftPieceLabel(draftPieceOf(target.pid), target.pid);
        showToast(`Pièce saisie : « ${label} » — cliquez une pastille pour la ranger.`);
        return false;
      }
      if (anchor) {
        showToast('Cliquez d’abord la pièce à ranger, puis la pastille.');
        return false;
      }
      return true; // vide → orbite
    }
    // En préparation, ne lancer la recherche que dans les plages de pièces
    // enregistrées. C'est le même picker que le survol : ce qui s'allume est
    // exactement ce qui sera saisi, avec une zone généreuse près du contour.
    if (
      sceneMode === 'atelier' &&
      atelierDesign &&
      move3DEnabled &&
      !patternView.sewing &&
      !patternView.zippering
    ) {
      // ⌖ Une flèche du trièdre sous le pointeur : drag CONTRAINT sur cet axe.
      if (gizmoPick) {
        const axis = gizmoAxisAt(e.clientX - rect.left, e.clientY - rect.top);
        if (axis !== null) {
          const ranges = gizmoRangesOf(gizmoPick.pid, gizmoPick.instance);
          const centroid = stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance);
          if (ranges.length && centroid) {
            pieceDrag = {
              pid: gizmoPick.pid,
              instance: gizmoPick.instance,
              ranges,
              depth: 0,
              start: [centroid[0], centroid[1], centroid[2]],
              delta: [0, 0, 0],
              pointerId: e.pointerId,
              positions: posCache,
              axis,
              grabNdc: [ndcX, ndcY],
            };
            try {
              canvas.setPointerCapture(e.pointerId);
            } catch {
              // A synthetic or already-cancelled pointer cannot be captured.
            }
            canvas.classList.add('piece-dragging');
            return false;
          }
        }
      }
      // ⟳ Anneaux X/Y/Z (rotation autour d'un axe MONDE) — priorité sur
      // l'anneau écran ; drag = rotation autour de cet axe, pivot = centroïde.
      if (gizmoPick) {
        const rk = gizmoWorldRingAt(e.clientX - rect.left, e.clientY - rect.top);
        const ranges = rk !== null ? gizmoRangesOf(gizmoPick.pid, gizmoPick.instance) : [];
        const centroid = rk !== null ? stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance) : null;
        if (rk !== null && ranges.length && centroid) {
          const axis = GIZMO_AXES[rk]!.dir;
          const b = ROT_RING_BASIS[rk]!;
          const hit = rayHitPlane(ray, axis, centroid);
          const ang = hit
            ? Math.atan2(
                (hit[0] - centroid[0]) * b.v[0] + (hit[1] - centroid[1]) * b.v[1] + (hit[2] - centroid[2]) * b.v[2],
                (hit[0] - centroid[0]) * b.u[0] + (hit[1] - centroid[1]) * b.u[1] + (hit[2] - centroid[2]) * b.u[2],
              )
            : 0;
          pieceDrag = {
            pid: gizmoPick.pid,
            instance: gizmoPick.instance,
            ranges,
            depth: 0,
            start: [centroid[0], centroid[1], centroid[2]],
            delta: [0, 0, 0],
            pointerId: e.pointerId,
            positions: posCache,
            rot: {
              axis: [axis[0], axis[1], axis[2]],
              pivot: [centroid[0], centroid[1], centroid[2]],
              lastAngle: ang,
              angle: 0,
              plane: { u: b.u, v: b.v },
              axisIdx: rk,
            },
          };
          try {
            canvas.setPointerCapture(e.pointerId);
          } catch {
            // A synthetic or already-cancelled pointer cannot be captured.
          }
          canvas.classList.add('piece-dragging');
          return false;
        }
      }
      // ⟳ Anneau de rotation ÉCRAN sous le pointeur : roll autour de l'axe
      // caméra, autour du centroïde de la pièce sélectionnée.
      if (gizmoPick && gizmoRingAt(e.clientX - rect.left, e.clientY - rect.top)) {
        const ranges = gizmoRangesOf(gizmoPick.pid, gizmoPick.instance);
        const centroid = stagingInstanceCentroid(gizmoPick.pid, gizmoPick.instance);
        const cpx = gizmoCenterPx();
        if (ranges.length && centroid && cpx) {
          const viewAxis = camera.pickRay(ndcX, ndcY, canvas.width / canvas.height).dir;
          pieceDrag = {
            pid: gizmoPick.pid,
            instance: gizmoPick.instance,
            ranges,
            depth: 0,
            start: [centroid[0], centroid[1], centroid[2]],
            delta: [0, 0, 0],
            pointerId: e.pointerId,
            positions: posCache,
            rot: {
              axis: [viewAxis[0], viewAxis[1], viewAxis[2]],
              pivot: [centroid[0], centroid[1], centroid[2]],
              lastAngle: Math.atan2(
                e.clientY - rect.top - cpx[1],
                e.clientX - rect.left - cpx[0],
              ),
              angle: 0,
            },
          };
          try {
            canvas.setPointerCapture(e.pointerId);
          } catch {
            // A synthetic or already-cancelled pointer cannot be captured.
          }
          canvas.classList.add('piece-dragging');
          return false;
        }
      }
      const target = pickStagingPiece(ray);
      if (!target) {
        setPieceHover(null);
        gizmoPick = null; // clic dans le vide : le trièdre se range
        return true;
      }
      setPieceHover(null);
      pieceDrag = {
        pid: target.pid,
        instance: target.instance,
        ranges: target.ranges,
        depth: target.depth,
        start: [
          ray.origin[0] + ray.dir[0] * target.depth,
          ray.origin[1] + ray.dir[1] * target.depth,
          ray.origin[2] + ray.dir[2] * target.depth,
        ],
        delta: [0, 0, 0],
        pointerId: e.pointerId,
        positions: posCache,
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic or already-cancelled pointer cannot be captured.
      }
      canvas.classList.add('piece-dragging');
      activeStagingInstance = {
        pid: target.pid,
        instance: target.instance,
      };
      patternView.selectPiece(target.pid);
      return false;
    }
    // Skip immovable particles (pinned/tacked/cut) so a press on one falls
    // through to camera orbit instead of a dead click (audit M37); the dblclick
    // tack picker below stays unfiltered so tacks remain removable.
    const hit = pickParticle(posCache, count, ray.origin, ray.dir, 0.15, (i) => system.isMovable(i));
    if (!hit) return true;
    // 🪡 armé : le clic 3D près d'un bord choisit le bord à coudre (même
    // machine que le plan 2D — 1er bord, 2e bord, couture). Marche à plat ET
    // sur le vêtement drapé (la correspondance cellule→bord est topologique).
    if (
      sceneMode === 'atelier' &&
      (patternView.sewing || patternView.zippering)
    ) {
      const front = pickFrontmost(ray) ?? hit; // la pièce VISIBLE, pas celle cachée derrière
      const pe = pieceEdgeAt(front.index);
      if (pe) {
        patternView.selectPiece(pe.pid);
        if (patternView.zippering) {
          patternView.pickEdgeForZipper(pe.pid, pe.edge);
        } else {
          patternView.pickEdgeForSeam(pe.pid, pe.edge);
        }
        return false;
      }
      return true; // armé mais loin d'un bord → orbite
    }
    if (sceneMode === 'atelier' && atelierDesign) return true;
    dragIndex = hit.index;
    dragDepth = hit.depth;
    return false; // fabric grabbed — the camera stays put
  };
  camera.attach(canvas, tryOrbit);
  // Le corps du geste Échap, partagé avec les touches A/Z du clavier Clo
  // (v176) : « revenir au geste de base ». Retourne true si quelque chose a
  // été fermé/annulé (→ preventDefault chez l'appelant clavier).
  const atelierEscapeGesture = (): boolean => {
    const helpWasOpen = !atelierHelpPanel.hidden;
    if (helpWasOpen) setAtelierHelpOpen(false);

    const chooserWasOpen = !placeChooser.hidden;
    const gatherWasOpen = !gatherChooser.hidden;
    if (gatherWasOpen) closeGatherChooser();
    closePrecisionChoosers();
    precisionAlign = null;
    // Une poche en cours de placement doit être RÉVERTIE (commit annulé), pas
    // seulement désarmée — avant que cancelInteractions ne nettoie l'état.
    const pocketReverted = revertPendingPocket({ rebuild: true });
    const placementWasPending =
      placePending !== null ||
      penPlacement ||
      patternView.placingSurfacePiece;
    const patternCancel = patternView.cancelInteractions();
    let cancelled3D = false;
    if (cancelPieceDrag()) cancelled3D = true;
    if (gizmoPick) {
      gizmoPick = null; // Échap range le trièdre
      cancelled3D = true;
    }
    if (draw3dMode || draw3dPoints.length) {
      draw3dMode = false;
      clearDraw3d();
      setPressed('at-draw3d', false);
      cancelled3D = true;
    }
    if (edit3dMode || edit3dDrag) {
      edit3dMode = false;
      clearEdit3d();
      setPressed('at-edit3d', false);
      cancelled3D = true;
    }
    if (sketch3dMode || sketch3dPoints.length) {
      sketch3dMode = false;
      clearSketch3d();
      setPressed('at-sketch3d', false);
      cancelled3D = true;
    }
    if (draw3dSplitChooser && !draw3dSplitChooser.hidden) {
      closeDraw3dChooser();
      cancelled3D = true;
    }
    if (dragIndex !== null) {
      system.setDrag(null, [0, 0, 0]);
      dragIndex = null;
      cancelled3D = true;
    }
    if (mouse.cancelGesture()) cancelled3D = true;
    if (camera.cancelGesture()) cancelled3D = true;
    pointerButtons3D = 0;
    if (move3DEnabled) {
      move3DEnabled = false;
      cancelled3D = true;
    }
    if (arrangeMode || arrangePick) {
      arrangeMode = false;
      arrangePick = null;
      arrangeHoverId = null;
      cancelled3D = true;
    }
    setPieceHover(null);
    activeStagingInstance = null;
    if (chooserWasOpen || placementWasPending) {
      resetPlacement();
    }

    const cancelled =
      patternCancel.cancelledTool ||
      patternCancel.cancelledGesture ||
      cancelled3D ||
      chooserWasOpen ||
      gatherWasOpen ||
      placementWasPending ||
      pocketReverted;
    if (!cancelled) return helpWasOpen;
    syncAtelierControls();
    refreshHint();
    showToast('Outil annulé · navigation libre');
    return true;
  };
  window.addEventListener('keydown', (event) => {
    if (sceneMode !== 'atelier' || event.key !== 'Escape') return;
    if (atelierEscapeGesture()) event.preventDefault();
  });
  // ————— Le clavier Clo (v176). Les lettres de CLO posées sur nos outils, à
  // sens égal — correspondance par LETTRE (event.key), donc identique en
  // AZERTY. Jamais de combinaison : un modificateur rend la touche au
  // navigateur ; un champ de saisie garde ses lettres. Espace = leur Simuler.
  const CLO_KEY_TOOLS: Readonly<Record<string, string>> = {
    x: 'at-precision', // Ajouter un point / Diviser la ligne -> l'établi
    g: 'at-internal', // Polygone / Ligne interne
    b: 'at-sew', // Modifier la couture (le lien se re-clique)
    n: 'at-sew', // Couture de segment
    m: 'at-sew-free', // Couture libre
    c: 'at-curvepoint', // Modifier la courbure
    v: 'at-curvepoint', // Modifier un point de courbe
  };
  window.addEventListener('keydown', (event) => {
    if (sceneMode !== 'atelier') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    if (event.key === ' ') {
      // Espace = Simuler, le geste le plus ancré de Clo. preventDefault :
      // sinon Espace « clique » aussi le bouton encore focalisé, et le plan
      // défilerait. Le bouton at-sim porte déjà les deux sens du toggle.
      event.preventDefault();
      if (event.repeat) return;
      if (target instanceof HTMLElement) target.blur();
      if (!sceneTransitionBusy()) simBtn().click();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'a' || key === 'z') {
      // A (Transformer) et Z (Modifier) de Clo = revenir au geste de base —
      // chez nous, éditer le contour n'a pas besoin d'outil.
      event.preventDefault();
      atelierEscapeGesture();
      return;
    }
    const toolId = CLO_KEY_TOOLS[key];
    if (toolId === undefined) return;
    event.preventDefault();
    if (event.repeat) return;
    document.getElementById(toolId)?.click();
  });
  // Double-click: tack the fabric in place right where you aim (pin/unpin).
  canvas.addEventListener('dblclick', (e) => {
    if (sceneTransitionBusy()) return;
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

  let panel!: ControlPanel;
  const requestScene = (
    mode: SceneMode,
    options: { selector?: boolean; syncPanel?: boolean } = {},
  ): void => {
    sceneMode = mode;
    if (options.syncPanel) panel.syncScene(mode);
    // The atelier opens in DESIGN mode: the piece hangs flat/frozen until
    // the user starts the 3D fitting. Open directly in the split workspace.
    if (mode === 'atelier') {
      atelierDesign = true;
      canvas.focus({ preventScroll: true });
      document.body.classList.remove('atelier-advanced-open');
      advancedButton.classList.remove('active');
      advancedButton.setAttribute('aria-pressed', 'false');
      if (!bigPanel) setBig(true);
    }
    build(options.selector ?? false);
  };
  // (Le bouton « ↩ Quitter l'atelier → démo tissu » a été retiré : l'atelier est
  // désormais la maison. Les scènes moteur se rejoignent via Réglages ⚙ →
  // sélecteur de scène. Plus de bascule surprise vers la démo physique.)

  panel = new ControlPanel(
    {
      onScene: (m) => {
        requestScene(m, { selector: true });
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
        syncAvatarStature(cm.stature);
        syncAtelierMeasures(); // l'atelier reflète le panneau avancé (v182)
        if (sceneMode !== 'drapé' && sceneMode !== 'couture') {
          build();
        }
      },
      onBody: (kind) => applyBody(kind),
      onResolution: (r) => applyResolution(r),
      onFabricPreset: (preset) => {
        globalFabricPreset = preset;
        // The atelier selector's inherit option is a view of this canonical
        // global state, never an independent second preset setting.
        syncPieceFabricSelect();
      },
      onCompliance: (c) => {
        compliance = c;
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        system.setCompliance(c);
        wake(); // a different fabric settles into a different shape
      },
      onFriction: (staticMu, dynamicMu) => {
        fabricDynamics = { ...fabricDynamics, frictionStatic: staticMu, frictionDynamic: dynamicMu };
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        system.setFriction(staticMu, dynamicMu);
        wake();
      },
      onDynamics: (dynamics) => {
        fabricDynamics = { ...dynamics };
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        system.setDynamics(dynamics);
        renderer.setCollisionThickness(dynamics.collisionThickness);
        if (sceneMode === 'atelier') syncPieceFabricSelect();
        wake();
      },
      onStyle: (style) => {
        fabricStyle = style;
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        renderer.setFabric(style);
      },
      onSelfCollision: (enabled) => {
        selfCollision = enabled;
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        system.setSelfCollision(enabled);
        wake(); // toggling contact resolution must re-settle a sleeping scene (M36)
      },
      onWind: (v) => {
        wind = v;
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        system.setWind(v);
      },
      onSeamAllowance: (cm) => {
        seamAllowanceM = cm / 100; // utilisée par le patron imprimé (PDF/SVG) — l'éditeur reste épuré
      },
      onPodium: (v) => {
        podium = v;
      },
      onAnimate: (v) => {
        animate = v;
        // Turning arm animation OFF must NOT rebuild the cloth (that re-drops
        // the settled garment from the spawn cylinder). Restore the rest pose
        // IN PLACE — un-posed colliders + rest body mesh — and let the drape
        // relax onto it (audit M35).
        if (!sceneTransitionBusy() && !v && animPrims && animRest && animOut) {
          animT = 0;
          animOut.set(animRest);
          system.setColliders(toColliders(animPrims));
          renderer.updateBodyVertices(animRest);
          wake();
        }
      },
      onPattern: (p) => {
        // The FLARE slider resets the draft (straight grade); length/neck keep it.
        dressPattern = { ...p, profile: p.flare === dressPattern.flare ? dressPattern.profile : linearProfile(p.flare) };
        panel.setProfiles({ robe: dressPattern.profile });
        // The pattern sliders describe the dress: jump to the dress scene so
        // the adjustment is always visible, then re-cut and re-sew. 'tenue'
        // ALSO renders this dressPattern (dress over tee), so don't teleport a
        // user out of their outfit into the lone dress (audit M34).
        if (sceneMode !== 'robe' && sceneMode !== 'tenue') {
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
      onFitMap: (v) => applyFitMap(v),
      onTechPack: () => {
        if (!draft) return;
        const garment =
          loadedPattern === 'boxy' ? 'T-shirt'
          : loadedPattern === 'clo-tee' ? 'T-shirt CLO'
          : loadedPattern === 'pants' || loadedPattern === 'clo-pants' ? 'Pantalon'
          : loadedPattern === 'hoodie' ? 'Hoodie'
          : loadedPattern === 'jupe' ? 'Jupe'
          : loadedPattern === 'robe' ? 'Robe'
          : loadedPattern === 'veste' ? 'Veste'
          : loadedPattern === 'doudoune' ? 'Doudoune'
          : 'Vetement';
        const size =
          loadedPattern === 'boxy'
            ? boxySurMesure ? 'sur-mesure (mannequin)' : boxySize
            : 'ajuste au mannequin';
        const m = lastMeasure;
        const res = exportTechPack(draft, {
          garment,
          size,
          fabric: String(globalFabricPreset),
          measureCm: {
            poitrine: Math.round(m.chest.circ * 100),
            taille: Math.round(m.waist.circ * 100),
            bassin: Math.round(m.hip.circ * 100),
            stature: Math.round(m.height * 100),
          },
          seamAllowanceCm: +(seamAllowanceM * 100).toFixed(1),
        });
        showToast(`Fiche de production exportee - ${res.pieces} pieces - ~${res.yardageM} m de tissu`);
      },
      onMarker: () => {
        if (!draft) return;
        const res = exportMarker(draft, +(seamAllowanceM * 100).toFixed(1));
        showToast(`Plan de decoupe - ${res.pieces} pieces - ~${res.lengthM} m sur laize 150 cm`);
      },
      onDxf: () => {
        if (!draft) return;
        const res = exportDxf(draft, +(seamAllowanceM * 100).toFixed(1));
        showToast(`DXF de decoupe exporte - ${res.pieces} pieces (mm, calque CUT)`);
      },
      onDxfGraded: () => {
        // DXF GRADÉ : le patron dans toutes les tailles standard, une taille
        // par calque (nid de gradation). Toujours la gradation standard.
        if (loadedPattern !== 'boxy') {
          showToast('DXF grade : charge le T-shirt composable');
          return;
        }
        const entries = BOXY_SIZES.map((size) => ({
          size,
          draft: boxyTee(size, lastMeasure, REF, boxySleeves, boxyCollar, boxyNeck, boxyLen, false),
        }));
        const res = exportGradedDxf(entries);
        showToast(`DXF grade - ${res.sizes} tailles (${res.pieces} pieces) - un calque par taille`);
      },
      onMaterialReport: (sizeCurve: string) => {
        // Bilan matiere multi-tailles : le metrage de placement pour TOUTE la
        // gradation standard (XS-XXL) du tee, avec les blocs courants. Toujours
        // les tailles standard (le sur-mesure est propre a un corps).
        if (loadedPattern !== 'boxy') {
          showToast('Bilan multi-tailles : charge le T-shirt composable');
          return;
        }
        const cfg = [
          teeSleevesSel && `Manches: ${teeSleevesSel.selectedOptions[0]?.text ?? boxySleeves}`,
          teeNeckSel && `Encolure: ${teeNeckSel.selectedOptions[0]?.text ?? boxyNeck}`,
          teeCollarSel && `Col: ${teeCollarSel.selectedOptions[0]?.text ?? boxyCollar}`,
          teeLengthSel && `Longueur: ${teeLengthSel.selectedOptions[0]?.text ?? boxyLen}`,
        ].filter(Boolean).join(' - ');
        const qty = parseSizeCurve(sizeCurve, BOXY_SIZES);
        const entries = BOXY_SIZES.map((size) => ({
          size,
          qty: qty[size] ?? 0,
          draft: boxyTee(size, lastMeasure, REF, boxySleeves, boxyCollar, boxyNeck, boxyLen, false),
        }));
        const res = exportMaterialReport(entries, {
          garment: 'T-shirt',
          fabric: String(globalFabricPreset),
          config: cfg,
          seamAllowanceCm: +(seamAllowanceM * 100).toFixed(1),
        });
        showToast(
          `Bilan matiere - ${res.units} pieces - placement melange ${res.mixed_m} m` +
            (res.estimated ? ' (estime)' : '') +
            ` (economie ${res.saved_m} m vs separe)`,
        );
      },
      onMultiMarker: (sizeCurve: string) => {
        // Plan de decoupe visuel du matelas MELANGE (vraies positions). Borne
        // en nombre de pieces : le SVG doit rester lisible/telechargeable.
        if (loadedPattern !== 'boxy') {
          showToast('Plan multi-tailles : charge le T-shirt composable');
          return;
        }
        const qtyMap = parseSizeCurve(sizeCurve, BOXY_SIZES);
        const entries = BOXY_SIZES.map((size) => ({
          size,
          qty: qtyMap[size] ?? 0,
          draft: boxyTee(size, lastMeasure, REF, boxySleeves, boxyCollar, boxyNeck, boxyLen, false),
        }));
        const res = exportMultiSizeMarker(entries, +(seamAllowanceM * 100).toFixed(1));
        if (res.capped) {
          showToast(`Plan multi-tailles : ${res.pieces} pieces, trop pour un SVG lisible - reduis la commande (le bilan chiffre les grosses)`);
        } else if (res.pieces === 0) {
          showToast('Plan multi-tailles : renseigne des quantites (courbe de tailles)');
        } else {
          showToast(`Plan de decoupe multi-tailles - ${res.pieces} pieces - ${res.lengthM} m sur laize 150 cm`);
        }
      },
      onPatternPdf: () => {
        // Le pantalon importé est déjà un patron vectoriel coté, marge de
        // couture de 1,25 cm comprise. Exporter les DraftPieces originales
        // conserve l'échelle et inclut les poches, braguette et ceinture que
        // le maillage de simulation ignore volontairement.
        if (draft?.preset === 'loose-pants') {
          exportDraftPatternPdf(
            draft,
            `pantalon-large-taille-${draft.presetSize ?? pantsSize}`,
            1.25,
          );
          return;
        }
        if (draft?.preset === 'lucas-hoodie') {
          exportDraftPatternPdf(
            draft,
            `lucas-hoodie-taille-${draft.presetSize ?? hoodieSize}`,
            1,
          );
          return;
        }
        // A drawn côte-à-côte back is NOT identical to the front — don't tell
        // the tailor to cut it "the same" when the user shaped it differently.
        const hasBack = sceneMode === 'atelier' && !!(draft?.back && draft.back.outline.length >= 3);
        if (currentMesh) exportPatternPdf(currentMesh, sceneMode, hasBack, seamAllowanceM);
      },
      onPatternSvg: () => {
        if (draft?.preset === 'loose-pants') {
          return exportDraftPatternSvg(
            draft,
            `pantalon-large-taille-${draft.presetSize ?? pantsSize}`,
            1.25,
          );
        }
        if (draft?.preset === 'lucas-hoodie') {
          return exportDraftPatternSvg(
            draft,
            `lucas-hoodie-taille-${draft.presetSize ?? hoodieSize}`,
            1,
          );
        }
        const hasBack = sceneMode === 'atelier' && !!(draft?.back && draft.back.outline.length >= 3);
        return currentMesh
          ? exportPatternSvg(
              currentMesh,
              sceneMode,
              hasBack,
              seamAllowanceM,
            )
          : null;
      },
      // Atelier draft persistence: only hand out a draft the user actually drew
      // (draftTouched) — never the lazy build() default. On import, null clears
      // it so a draftless file wipes the previous session instead of leaking it.
      onGetDraft: () => (draftTouched ? draft ?? undefined : undefined),
      onDraft: (raw) => {
        resetPlacement(); // l'import remplace le patron : placement en attente caduc
        pushHistory(); // l'import remplace le patron : un cran d'annulation
        if (raw == null) {
          draft = null;
          draftTouched = false;
          showSizes('boxy');
        } else {
          draft = sanitizeDraft(raw); // validates/clamps both faces
          draftTouched = true;
          // Imported geometry belongs to the user. Never silently replace it
          // on the next avatar change, even when it originated from "fit-".
          if (
            !syncPatternContextFromDraft(draft, {
              pristine: false,
              bodyKey: '',
            })
          ) {
            syncAvatarStatureHelp();
          }
        }
      },
      onGltf: () => {
        if (sceneTransitionBusy()) return null;
        // Snapshot the CURRENT drape: garment positions read back from the
        // GPU, mannequin in its current pose and podium angle — what you see
        // is what Blender gets.
        const mesh = currentMesh;
        const scene = currentScene;
        if (!mesh || !scene) return null;
        // Freeze pose and podium angle to match the CLOTH copy, not the click:
        // readPositions() encodes its GPU copy synchronously before its first
        // await, so sampling the pose on the SAME tick as the attempt that wins
        // keeps the mannequin and the garment on the same frame — freezing only
        // at click would still let the pose drift over the retry window (M23).
        const sys = system;
        let cSpin = Math.cos(podiumAngle);
        let sSpin = Math.sin(podiumAngle);
        let bodySnap = animOut ? new Float32Array(animOut) : null;
        // The pick cache refreshes every 300 ms through the same readback
        // gate — a click landing in its busy window gets null. Retry a few
        // frames instead of silently doing nothing.
        const read = async (): Promise<Float32Array | null> => {
          for (let attempt = 0; attempt < 10; attempt++) {
            if (sceneTransitionBusy() || sys !== system) return null;
            // Sample the pose in the same tick readPositions encodes its copy.
            cSpin = Math.cos(podiumAngle);
            sSpin = Math.sin(podiumAngle);
            bodySnap = animOut ? new Float32Array(animOut) : null;
            const p = await sys.readPositions();
            if (sceneTransitionBusy() || sys !== system) return null;
            if (p) return p;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };
        return read().then((raw) => {
          if (
            sceneTransitionBusy() ||
            sys !== system ||
            !raw ||
            raw.length < mesh.count * 4
          ) {
            return null;
          }
          const pieces: GltfPiece[] = [];
          // Our UI colors are sRGB values; glTF baseColorFactor is linear.
          const lin = (c: [number, number, number]): [number, number, number] =>
            [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

          const clothPos = new Float32Array(mesh.count * 3);
          const uvs = new Float32Array(mesh.count * 2);
          const panelSize = mesh.resolution * mesh.resolution;
          for (let i = 0; i < mesh.count; i++) {
            const localX = raw[i * 4]!;
            const localZ = raw[i * 4 + 2]!;
            clothPos[i * 3] = cSpin * localX - sSpin * localZ;
            clothPos[i * 3 + 1] = raw[i * 4 + 1]!;
            clothPos[i * 3 + 2] = sSpin * localX + cSpin * localZ;
            const local = i % panelSize; // rest-pose UVs in meters, same map as the print shader
            // Garment index (front+back = 2 panels): the second piece of a
            // combined outfit prints at its OWN spacing, or the motif scale
            // is wrong on one of the two garments (M24).
            const garment = Math.floor(i / panelSize) >> 1;
            const sp = garment >= 1 ? mesh.spacing2 ?? mesh.spacing : mesh.spacing;
            const spV = garment >= 1 ? mesh.spacingV2 ?? mesh.spacingV : mesh.spacingV;
            uvs[i * 2] = (local % mesh.resolution) * sp;
            uvs[i * 2 + 1] = Math.floor(local / mesh.resolution) * spV;
          }
          // Both panels of a garment share the same index winding, so the
          // back panel's faces (and thus its computed normals) point INTO
          // the body. Flip odd panels' winding: every normal faces outward.
          const clothIdx = new Uint32Array(mesh.triangleIndices);
          for (let t = 0; t < clothIdx.length; t += 3) {
            if (Math.floor(clothIdx[t]! / panelSize) % 2 === 1) {
              const tmp = clothIdx[t + 1]!;
              clothIdx[t + 1] = clothIdx[t + 2]!;
              clothIdx[t + 2] = tmp;
            }
          }
          pieces.push({
            name: 'vetement',
            positions: clothPos,
            normals: computeNormals(clothPos, clothIdx),
            uvs,
            indices: clothIdx,
            color: [...lin(fabricStyle.face), 1],
            doubleSided: true,
          });

          // Mannequin = the scene's body block (indices [0, bodyIndexCount)),
          // skinned vertices if the arms are animating, spun to the podium
          // angle (stored body-space, drawn world-space — export world).
          if (scene.bodyIndexCount > 0) {
            let vcount = 0;
            for (let i = 0; i < scene.bodyIndexCount; i++) {
              if (scene.indices[i]! >= vcount) vcount = scene.indices[i]! + 1;
            }
            const src = bodySnap && bodySnap.length >= vcount * SCENE_VERTEX_FLOATS ? bodySnap : scene.vertices;
            const bodyPos = new Float32Array(vcount * 3);
            const bodyNrm = new Float32Array(vcount * 3);
            const c = cSpin;
            const s = sSpin;
            for (let v = 0; v < vcount; v++) {
              const o = v * SCENE_VERTEX_FLOATS;
              bodyPos[v * 3] = c * src[o]! - s * src[o + 2]!;
              bodyPos[v * 3 + 1] = src[o + 1]!;
              bodyPos[v * 3 + 2] = s * src[o]! + c * src[o + 2]!;
              bodyNrm[v * 3] = c * src[o + 3]! - s * src[o + 5]!;
              bodyNrm[v * 3 + 1] = src[o + 4]!;
              bodyNrm[v * 3 + 2] = s * src[o + 3]! + c * src[o + 5]!;
            }
            pieces.push({
              name: 'mannequin',
              positions: bodyPos,
              normals: bodyNrm,
              indices: scene.indices.slice(0, scene.bodyIndexCount),
              color: [...lin([0.62, 0.53, 0.47]), 1],
              roughness: 0.95,
            });
          }
          return downloadGlb(pieces, sceneMode);
        });
      },
      onPins: (held) => {
        if (sceneTransitionBusy()) return;
        system.setCornerPins(held);
        wake();
      },
      onReset: () => {
        if (sceneTransitionBusy()) return;
        system.reset();
        panel.syncPins(false);
        wake();
      },
      // Import batching (M26): suppress the cascade's intermediate rebuilds,
      // then rebuild once with the final imported state.
      onImportBegin: () => {
        buildSuspended = true;
      },
      onImportEnd: () => {
        buildSuspended = false;
        build();
      },
    },
    { resolution: DEFAULT_RESOLUTION, substeps: DEFAULT_SUBSTEPS },
  );
  // Open the measurement sliders on the default mannequin's own values.
  const initialBodyCm = baseCm(bodyKind, scans[bodyKind] ?? null);
  panel.syncMorphCm(initialBodyCm);
  syncAtelierMeasures(); // v182 : ouvre les curseurs sur le corps de départ
  panel.syncEngineSelects({
    scene: sceneMode,
    body: bodyKind,
    resolution,
    fabricPreset: globalFabricPreset,
  });
  syncPieceFabricSelect();
  syncParticleSelect();
  syncAvatarStature(initialBodyCm.stature!);

  // Canonical garment autosave. A lightweight change detector also catches
  // live controls (fabric, wind, seam allowance) that do not rebuild a scene.
  const autosaveStore = new IndexedDbAutosaveStore();
  autosave = new AutosaveController({
    store: autosaveStore,
    snapshot: () => panel.snapshotGarment(),
    isIdle: () => !sceneTransitionBusy() && !buildSuspended,
    debounceMs: 2000,
  });
  let observedGarmentJson = JSON.stringify(panel.snapshotGarment());
  const autosavePoll = window.setInterval(() => {
    let next: string;
    try {
      next = JSON.stringify(panel.snapshotGarment());
    } catch {
      return;
    }
    if (next === observedGarmentJson) return;
    observedGarmentJson = next;
    autosave?.markDirty();
  }, 400);

  const dismissRecovery = (snapshot: AutosaveSnapshot, banner: HTMLElement): void => {
    markRecoveryHandled(snapshot, localStorage, 'dismissed');
    banner.remove();
  };
  const offerRecovery = (snapshot: AutosaveSnapshot): void => {
    const banner = document.createElement('aside');
    banner.id = 'toile-recovery';
    banner.setAttribute('role', 'status');
    banner.style.cssText =
      'position:fixed;left:50%;bottom:22px;z-index:80;transform:translateX(-50%);' +
      'display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:11px 13px;' +
      'border:1px solid rgba(127,178,255,.65);border-radius:9px;background:rgba(12,14,18,.96);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.45);color:#f4f1e9;font:13px system-ui,sans-serif';
    const label = document.createElement('span');
    label.textContent = 'Une session interrompue est disponible.';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restaurer la dernière session';
    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.textContent = 'Ignorer';
    for (const button of [restore, ignore]) {
      button.style.cssText =
        'border:1px solid rgba(255,255,255,.24);border-radius:6px;padding:6px 9px;' +
        'background:#252a34;color:inherit;font:inherit;cursor:pointer;white-space:nowrap';
    }
    ignore.addEventListener('click', () => dismissRecovery(snapshot, banner));
    restore.addEventListener('click', () => {
      restore.disabled = true;
      ignore.disabled = true;
      let documentValue: unknown;
      try {
        documentValue = JSON.parse(snapshot.payloadJson);
      } catch {
        dismissRecovery(snapshot, banner);
        return;
      }
      if (!panel.applyGarment(documentValue)) {
        dismissRecovery(snapshot, banner);
        return;
      }
      void lifecycle.whenIdle().then(() => {
        observedGarmentJson = JSON.stringify(panel.snapshotGarment());
        dismissRecovery(snapshot, banner);
      });
    });
    banner.append(label, restore, ignore);
    document.body.appendChild(banner);
  };
  void autosaveStore.latest().then((snapshot) => {
    if (snapshot && shouldOfferRecovery(snapshot, localStorage)) offerRecovery(snapshot);
  }).catch((error) => {
    console.warn('[toile] restauration autosave indisponible :', error);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void autosave?.flushNow();
  });
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) {
      const clean = autosave?.cleanCloseSnapshot;
      if (clean) markRecoveryHandled(clean, localStorage, 'clean');
    }
    window.clearInterval(autosavePoll);
  });

  // DEV collision telemetry. Capture the system identity around the GPU
  // readback: a scene switch may retire the old generation while mapAsync is
  // pending, and an audit must never mix its samples with the new metadata.
  if (import.meta.env.DEV) {
    type RuntimeClothOverlapReport = ClothOverlapAuditReport & { id: string };
    type RuntimeCollisionAuditReport = VisualCollisionAuditReport & {
      scene: SceneMode;
      body: string;
      resolution: number;
      colliderModel: 'scan-grid' | 'analytic-primitives' | 'sphere';
      animationRequested: boolean;
      animationActive: boolean;
      podiumRpm: number;
      lifecycleRevision: number;
      bodyVisual: {
        vertexCount: number;
        triangleCount: number;
        closed: boolean;
      };
      /** Legacy SDF/contact-band diagnostic, kept for solver self-control only. */
      solverProjection: CollisionAuditReport;
      clothCloth: {
        expectedSeparationMm: number;
        dangerThresholdMm: number;
        /** Exact live distance of every declared assembly/attachment/surface stitch. */
        declaredSeams: DeclaredSeamAuditReport;
        groups: RuntimeClothOverlapReport[];
      };
      timingsMs: {
        gpuReadback: number;
        bodyBvh: number;
        summarize: number;
        total: number;
      };
    };
    const collisionAuditWindow = window as unknown as {
      __toileCollisionAudit?: () => Promise<RuntimeCollisionAuditReport>;
      __toileCollisionPrepareAnalyticArms?: () => Promise<void>;
      __toileWhenIdle?: () => Promise<void>;
    };
    collisionAuditWindow.__toileWhenIdle = () => lifecycle.whenIdle();
    collisionAuditWindow.__toileCollisionPrepareAnalyticArms = async (): Promise<void> => {
      // The public body picker intentionally exposes only the scan avatars,
      // whose collider is rigid. Keep this deterministic analytic-body path
      // DEV-only so the articulated collision acceptance test exercises a
      // genuinely moving arm collider without changing the product UI.
      const analyticBodyKind: 'femme' | 'homme' = bodyKind.includes('homme') ? 'homme' : 'femme';
      collisionAuditAnalyticTPose = true;
      animate = false;
      animT = 0;
      panel.syncAnimate(false);
      bodyKind = analyticBodyKind;
      morphs = { ...NO_MORPH };
      const naturalCm = baseCm(analyticBodyKind, null);
      panel.syncMorphCm(naturalCm);
      syncAvatarStature(naturalCm.stature!);
      requestScene('t-shirt', { selector: true, syncPanel: true });
      await lifecycle.whenIdle();
    };
    collisionAuditWindow.__toileCollisionAudit = async (): Promise<RuntimeCollisionAuditReport> => {
      await lifecycle.whenIdle();
      for (let attempt = 0; attempt < 2; attempt++) {
        const auditStartedAt = performance.now();
        const auditedSystem = system;
        const auditedMesh = currentMesh;
        const auditedScene = currentScene;
        const auditedRevision = committedSceneRevision;
        // Podium rotation is a shared render transform for body + cloth.
        // Their mutual distances are rotation-invariant, so audit the local
        // solver snapshot against the local visible-body mesh.
        const auditedPodiumAngle = 0;
        const surfaceSampleMinY = lastMeasure.chest.y - 0.12;
        // readCollisionDistances submits synchronously before its first await.
        // Copy the skinned visible body immediately afterwards so the cloth
        // and mannequin snapshots belong to the same render interval.
        const readbackStartedAt = performance.now();
        const snapshotPromise = auditedSystem.readCollisionDistances();
        const auditedAnimatedBody = animOut ? new Float32Array(animOut) : null;
        const snapshot = await snapshotPromise;
        const readbackFinishedAt = performance.now();
        if (
          snapshot &&
          auditedMesh &&
          auditedScene &&
          auditedSystem === system &&
          auditedMesh === currentMesh &&
          auditedScene === currentScene &&
          auditedRevision === committedSceneRevision
        ) {
          const visibleTriangleIndices = auditedMesh.triangleIndices;
          const bvhStartedAt = performance.now();
          const bodyMesh = visibleBodyProximity(
            auditedScene,
            auditedAnimatedBody,
          );
          const bvhFinishedAt = performance.now();
          const signedVisibleDistance = (x: number, y: number, z: number): number => {
            const bodyPoint = inverseRotateY(
              [x, y, z],
              auditedPodiumAngle,
            );
            return bodyMesh.proximity.signedDistance(bodyPoint);
          };
          const summarizeStartedAt = performance.now();
          const visible = summarizeVisualCollisionAudit(snapshot, {
            triangleIndices: visibleTriangleIndices,
            signedDistance: signedVisibleDistance,
            sampleTriangle: (_triangle, a, b, c) => {
              const positions = snapshot.positions;
              return (
                positions[a * 3 + 1]! +
                positions[b * 3 + 1]! +
                positions[c * 3 + 1]!
              ) / 3 >= surfaceSampleMinY;
            },
          });
          const solverProjection = summarizeCollisionAudit(snapshot);
          const declaredSeams = summarizeDeclaredSeamAudit({
            positions: snapshot.positions,
            constraintData: auditedMesh.constraintData,
            constraintCount: auditedMesh.constraintCount,
            effectiveThicknessM: fabricDynamics.collisionThickness,
          });

          const panelSize = auditedMesh.resolution * auditedMesh.resolution;
          const allPositions = snapshot.positions;
          const indicesInRanges = (
            ranges: readonly ClothAuditParticleRange[],
            keep: (index: number) => boolean = () => true,
          ): Uint32Array => {
            const indices: number[] = [];
            for (const range of ranges) {
              const end = Math.min(auditedMesh.count, range.first + range.count);
              for (let index = Math.max(0, range.first); index < end; index++) {
                if (keep(index)) indices.push(index);
              }
            }
            return Uint32Array.from(indices);
          };
          const baseFrontRanges: ClothAuditParticleRange[] =
            pieceParticleRanges.get(0)?.map(({ first, count }) => ({ first, count }))
            ?? (auditedMesh.count >= panelSize * 2
              ? [{ first: 0, count: panelSize }]
              : []);
          const baseBackRanges: ClothAuditParticleRange[] =
            pieceParticleRanges.get(1)?.map(({ first, count }) => ({ first, count }))
            ?? (auditedMesh.count >= panelSize * 2
              ? [{ first: panelSize, count: panelSize }]
              : []);
          const positionFilter = (
            side: 'left' | 'right' | 'centre',
            minY: number,
          ) => (index: number): boolean => {
            const offset = index * 3;
            const x = allPositions[offset]!;
            const y = allPositions[offset + 1]!;
            if (y < minY) return false;
            if (side === 'left') return x < 0;
            if (side === 'right') return x >= 0;
            return Math.abs(x) <= Math.max(0.12, lastMeasure.shoulderHalfW * 0.8);
          };
          const overlap = (
            id: string,
            groupA: Uint32Array,
            groupB: Uint32Array,
          ): RuntimeClothOverlapReport => ({
            id,
            ...summarizeClothOverlapAudit({
              positions: allPositions,
              triangleIndices: visibleTriangleIndices,
              groupA: { label: `${id}:a`, indices: groupA },
              groupB: { label: `${id}:b`, indices: groupB },
              thicknessM: fabricDynamics.collisionThickness,
              closeThresholdM: fabricDynamics.collisionThickness * 0.5,
              seamDist: auditedMesh.seamDist,
              seamFree: auditedMesh.seamFree,
            }),
          });
          const shoulderMinY = lastMeasure.chest.y - 0.05;
          const groups: RuntimeClothOverlapReport[] = [
            overlap(
              'left-shoulder-front-back',
              indicesInRanges(baseFrontRanges, positionFilter('left', shoulderMinY)),
              indicesInRanges(baseBackRanges, positionFilter('left', shoulderMinY)),
            ),
            overlap(
              'right-shoulder-front-back',
              indicesInRanges(baseFrontRanges, positionFilter('right', shoulderMinY)),
              indicesInRanges(baseBackRanges, positionFilter('right', shoulderMinY)),
            ),
          ];

          const collarOffset = committedSceneMode === 'atelier'
            ? (draft?.pieces ?? []).findIndex((piece) => piece.wrap === 'neck')
            : -1;
          const collarRanges = collarOffset >= 0
            ? pieceParticleRanges.get(collarOffset + 2) ?? []
            : [];
          const collarFrontRanges: ClothAuditParticleRange[] = [];
          const collarBackRanges: ClothAuditParticleRange[] = [];
          for (const range of collarRanges) {
            const faceCount = Math.min(panelSize, Math.floor(range.count / 2));
            if (faceCount <= 0) continue;
            collarFrontRanges.push({ first: range.first, count: faceCount });
            collarBackRanges.push({ first: range.first + faceCount, count: faceCount });
          }
          const collarMinY = lastMeasure.shoulderY - 0.18;
          groups.push(
            overlap(
              'collar-front-neckline',
              indicesInRanges(collarFrontRanges),
              indicesInRanges(baseFrontRanges, positionFilter('centre', collarMinY)),
            ),
            overlap(
              'collar-back-neckline',
              indicesInRanges(collarBackRanges),
              indicesInRanges(baseBackRanges, positionFilter('centre', collarMinY)),
            ),
          );
          const summarizedAt = performance.now();
          return {
            ...visible,
            scene: committedSceneMode,
            body: bodyKind,
            resolution,
            colliderModel:
              committedSceneMode === 'drapé' || committedSceneMode === 'couture'
                ? 'sphere'
                : bodyKind.startsWith('scan')
                  ? 'scan-grid'
                  : 'analytic-primitives',
            animationRequested: animate,
            animationActive: animate && animPrims !== null,
            podiumRpm: podium,
            lifecycleRevision: auditedRevision,
            bodyVisual: {
              vertexCount: bodyMesh.vertexCount,
              triangleCount: bodyMesh.triangleCount,
              closed: bodyMesh.proximity.closed,
            },
            solverProjection,
            clothCloth: {
              expectedSeparationMm: fabricDynamics.collisionThickness * 1000,
              dangerThresholdMm: fabricDynamics.collisionThickness * 500,
              declaredSeams,
              groups,
            },
            timingsMs: {
              gpuReadback: readbackFinishedAt - readbackStartedAt,
              bodyBvh: bvhFinishedAt - bvhStartedAt,
              summarize: summarizedAt - summarizeStartedAt,
              total: summarizedAt - auditStartedAt,
            },
          };
        }
        await lifecycle.whenIdle();
      }
      throw new Error('Audit collision annulé : la scène a changé pendant le readback GPU.');
    };

    // Browser-QA bridge. It only exists behind an explicit DEV query and
    // publishes the public hook's JSON in the DOM; no production or ordinary
    // atelier UI is changed. This lets end-to-end tests trigger a real GPU
    // readback without privileged page-script evaluation.
    const collisionAuditQuery = new URLSearchParams(window.location.search);
    if (collisionAuditQuery.has('toileCollisionAudit')) {
      const auditOutput = document.createElement('output');
      auditOutput.id = 'toile-collision-audit-report';
      auditOutput.setAttribute('role', 'status');
      auditOutput.style.cssText =
        'position:fixed;inset:auto 12px 12px 12px;z-index:101;max-height:42vh;overflow:auto;' +
        'white-space:pre-wrap;padding:10px 124px 10px 10px;border:1px solid #7af;' +
        'background:#10141a;color:#dfe;font:11px/1.35 ui-monospace,monospace;pointer-events:none';
      auditOutput.textContent = 'audit collision prêt';
      const auditButton = document.createElement('button');
      auditButton.id = 'toile-collision-audit-run';
      auditButton.type = 'button';
      auditButton.textContent = 'Mesurer collision';
      auditButton.style.cssText =
        'position:fixed;right:22px;bottom:22px;z-index:102;padding:7px 10px;' +
        'border:1px solid #7af;background:#182435;color:#fff';
      auditButton.addEventListener('click', () => {
        auditButton.disabled = true;
        auditOutput.textContent = 'audit collision GPU en cours…';
        void collisionAuditWindow.__toileCollisionAudit!()
          .then((report) => {
            auditOutput.textContent = JSON.stringify(
              { status: 'complete', measuredAt: new Date().toISOString(), report },
              null,
              2,
            );
          })
          .catch((error) => {
            auditOutput.textContent = JSON.stringify(
              { status: 'error', error: String(error) },
              null,
              2,
            );
          })
          .finally(() => {
            auditButton.disabled = false;
          });
      });
      const analyticArmsButton = document.createElement('button');
      analyticArmsButton.id = 'toile-collision-analytic-arms';
      analyticArmsButton.type = 'button';
      analyticArmsButton.textContent = 'Préparer bras articulés';
      analyticArmsButton.style.cssText =
        'position:fixed;right:22px;bottom:62px;z-index:102;padding:7px 10px;' +
        'border:1px solid #7af;background:#182435;color:#fff';
      analyticArmsButton.addEventListener('click', () => {
        analyticArmsButton.disabled = true;
        auditOutput.textContent = 'préparation du mannequin articulé…';
        void collisionAuditWindow.__toileCollisionPrepareAnalyticArms!()
          .then(() => {
            auditOutput.textContent = JSON.stringify(
              { status: 'prepared', scene: committedSceneMode, body: bodyKind, animationActive: false },
              null,
              2,
            );
          })
          .catch((error) => {
            auditOutput.textContent = JSON.stringify(
              { status: 'error', error: String(error) },
              null,
              2,
            );
          })
          .finally(() => {
            analyticArmsButton.disabled = false;
          });
      });
      document.body.append(auditOutput, analyticArmsButton, auditButton);
    }

    // Deterministic dev stress harness used by the lifecycle acceptance tests.
    const stressScenes: SceneMode[] = [
      'drapé',
      'couture',
      'robe',
      'robe froncée',
      't-shirt',
      'chemise',
      'ensemble',
      'tenue',
      'pantalon',
      'atelier',
    ];
    let stressRunning = false;
    type StressOptions = {
      switches?: number;
      minMs?: number;
      maxMs?: number;
      hover?: boolean;
      seed?: number;
    };
    type StressReport = {
      crashes: number;
      frozenOver2s: number;
      timedOut: boolean;
      transitionFailures: number;
      automaticRecoveries: number;
      lastTransitionFailure: TransitionFailure | null;
      buildTimesMs: number[];
      liveBuffersAfterEach: number[];
      finalSceneConsistent: boolean;
      requestedSwitches: number;
      finalRequestedScene: SceneMode;
      finalCommittedScene: SceneMode;
      performanceRatio: number | null;
      seed: number;
    };
    const stressWindow = window as unknown as {
      __toileStress?: (options?: StressOptions) => Promise<StressReport>;
    };
    stressWindow.__toileStress = async (options = {}): Promise<StressReport> => {
      if (stressRunning) throw new Error('Un stress TOILE est déjà en cours.');
      stressRunning = true;
      const switches = Math.max(0, Math.floor(options.switches ?? 50));
      const minMs = Math.max(0, options.minMs ?? 300);
      const maxMs = Math.max(minMs, options.maxMs ?? 3000);
      const seed = (options.seed ?? 0x544f494c) >>> 0;
      let randomState = seed || 1;
      const random = (): number => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 0x1_0000_0000;
      };
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const buildStart = lifecycle.metrics.buildTimesMs.length;
      const bufferStart = lifecycle.metrics.liveBuffersAfterEach.length;
      const fatalStart = fatalCount;
      const transitionFailureStart = transitionFailureCount;
      const transitionRecoveryStart = transitionRecoveryCount;
      let capturedCrashes = 0;
      let frozenOver2s = 0;
      let timedOut = false;
      let lastRaf = performance.now();
      let watchdogRaf = 0;
      let hoverTimer = 0;
      let finalTarget = sceneMode;
      let runFailed = false;
      const captureCrash = (): void => { capturedCrashes++; };
      const watchdog = (now: number): void => {
        if (document.visibilityState === 'visible' && now - lastRaf > 2000) frozenOver2s++;
        lastRaf = now;
        watchdogRaf = requestAnimationFrame(watchdog);
      };
      window.addEventListener('error', captureCrash);
      window.addEventListener('unhandledrejection', captureCrash);
      watchdogRaf = requestAnimationFrame(watchdog);
      if (options.hover) {
        hoverTimer = window.setInterval(() => {
          const rect = canvas.getBoundingClientRect();
          const x = rect.left + rect.width * (0.2 + random() * 0.6);
          const y = rect.top + rect.height * (0.2 + random() * 0.6);
          canvas.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            clientX: x,
            clientY: y,
            pointerId: 91,
            pointerType: 'mouse',
          }));
        }, 24);
      }
      try {
        for (let index = 0; index < switches; index++) {
          const choices = stressScenes.filter((mode) => mode !== finalTarget);
          finalTarget = choices[Math.floor(random() * choices.length)] ?? 'drapé';
          requestScene(finalTarget, { selector: true, syncPanel: true });
          await wait(minMs + random() * (maxMs - minMs));
        }
        await Promise.race([
          lifecycle.whenIdle(),
          new Promise<never>((_resolve, reject) => {
            window.setTimeout(
              () => reject(new Error('Le stress a dépassé 35 s en attente de la scène finale.')),
              35_000,
            );
          }),
        ]);
      } catch (error) {
        runFailed = true;
        timedOut = error instanceof Error && error.message.includes('dépassé 35 s');
        capturedCrashes++;
        console.error('[toile] stress interrompu :', error);
      } finally {
        cancelAnimationFrame(watchdogRaf);
        if (hoverTimer) window.clearInterval(hoverTimer);
        window.removeEventListener('error', captureCrash);
        window.removeEventListener('unhandledrejection', captureCrash);
        stressRunning = false;
      }
      const buildTimesMs = lifecycle.metrics.buildTimesMs.slice(buildStart);
      const liveBuffersAfterEach = lifecycle.metrics.liveBuffersAfterEach.slice(bufferStart);
      const expectedLive = currentMesh
        ? currentMesh.invMasses.reduce((count, invMass) => count + (invMass > 0 ? 1 : 0), 0)
        : -1;
      const panelScene = panel.snapshotGarment().scene;
      const finalSceneConsistent =
        !runFailed &&
        !sceneTransitionBusy() &&
        lifecycle.latestRevision === committedSceneRevision &&
        sceneMode === finalTarget &&
        committedSceneMode === finalTarget &&
        panelScene === finalTarget &&
        !!currentMesh &&
        system.count === currentMesh.count &&
        expectedLive === liveParticleCount;
      const mean = (values: number[]): number =>
        values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const performanceRatio = buildTimesMs.length >= 20
        ? mean(buildTimesMs.slice(-10)) / Math.max(0.001, mean(buildTimesMs.slice(0, 10)))
        : null;
      return {
        crashes: capturedCrashes + Math.max(0, fatalCount - fatalStart),
        frozenOver2s,
        timedOut,
        transitionFailures: Math.max(0, transitionFailureCount - transitionFailureStart),
        automaticRecoveries: Math.max(0, transitionRecoveryCount - transitionRecoveryStart),
        lastTransitionFailure,
        buildTimesMs,
        liveBuffersAfterEach,
        finalSceneConsistent,
        requestedSwitches: switches,
        finalRequestedScene: finalTarget,
        finalCommittedScene: committedSceneMode,
        performanceRatio,
        seed,
      };
    };

    // Headless/manual QA entry point for long runs. It invokes the exact same
    // public hook and only exists in Vite DEV builds:
    // ?toileStress=50&runs=2&hover=1&minMs=300&maxMs=3000
    const stressQuery = new URLSearchParams(window.location.search);
    if (stressQuery.has('toileStress')) {
      const output = document.createElement('output');
      output.id = 'toile-stress-report';
      output.setAttribute('role', 'status');
      output.style.cssText =
        'position:fixed;inset:auto 12px 12px 12px;z-index:100;max-height:45vh;overflow:auto;' +
        'white-space:pre-wrap;padding:10px;border:1px solid #5f7;background:#10141a;color:#dfe;' +
        'font:11px/1.35 ui-monospace,monospace';
      output.textContent = 'stress TOILE en cours…';
      document.body.appendChild(output);
      window.setTimeout(() => {
        const runs = Math.max(1, Math.floor(Number(stressQuery.get('runs')) || 1));
        const queryOptions: StressOptions = {
          switches: Number(stressQuery.get('toileStress')) || 50,
          minMs: Number(stressQuery.get('minMs')) || 300,
          maxMs: Number(stressQuery.get('maxMs')) || 3000,
          hover: stressQuery.get('hover') === '1',
          seed: Number(stressQuery.get('seed')) || undefined,
        };
        void (async () => {
          const reports: StressReport[] = [];
          for (let run = 0; run < runs; run++) {
            reports.push(await stressWindow.__toileStress!(queryOptions));
            output.textContent = JSON.stringify({ status: 'running', reports }, null, 2);
          }
          output.textContent = JSON.stringify({ status: 'complete', reports }, null, 2);
        })().catch((error) => {
          output.textContent = JSON.stringify({ status: 'error', error: String(error) }, null, 2);
        });
      }, 0);
    }
  }

  // Preview the number while dragging, then rebuild once on release. Rebuilding
  // every pointer pixel would repeatedly resample the avatar SDF and feel sticky.
  avatarStatureInput.addEventListener('input', () => {
    syncAvatarStature(avatarStatureInput.valueAsNumber);
  });
  avatarStatureInput.addEventListener('change', () => {
    panel.setStatureCm(avatarStatureInput.valueAsNumber);
    guidanceEl.textContent = `Mannequin réglé à ${fmtNum(avatarStatureInput.valueAsNumber)} cm · corps et collisions recalculés.`;
  });
  // v184 : la stature aussi se tape au chiffre.
  const applyStatureNum = (): void => {
    const raw = avatarStatureNum.valueAsNumber;
    if (!Number.isFinite(raw)) { avatarStatureNum.value = fmtNum(avatarStatureInput.valueAsNumber); return; }
    const clamped = round2(Math.min(AVATAR_STATURE_MAX_CM, Math.max(AVATAR_STATURE_MIN_CM, raw)));
    syncAvatarStature(clamped);
    panel.setStatureCm(clamped);
    guidanceEl.textContent = `Mannequin réglé à ${fmtNum(clamped)} cm · corps et collisions recalculés.`;
  };
  avatarStatureNum.addEventListener('change', applyStatureNum);
  avatarStatureNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') avatarStatureNum.blur(); });
  // v182 : les 5 curseurs de mensuration de l'atelier.
  const measureLabel = (id: string): string =>
    measureInput(id)?.previousElementSibling?.querySelector('span')?.textContent ?? id;
  for (const { field, id } of ATELIER_MEASURES) {
    const input = measureInput(id);
    const num = measureNum(id);
    if (!input || !num) continue;
    // Le curseur : suit en direct dans le champ, applique au relâcher.
    input.addEventListener('input', () => {
      num.value = fmtNum(input.valueAsNumber);
    });
    input.addEventListener('change', () => {
      panel.setMeasurementCm(field, input.valueAsNumber); // → onMorph → morphs + build
      guidanceEl.textContent = `Mannequin remodelé (${measureLabel(id)} ${fmtNum(input.valueAsNumber)} cm) · l'essayage épousera le nouveau corps.`;
    });
    // Le champ NUMÉRIQUE : tape ta cote exacte (v184). Borné aux mêmes limites
    // que le curseur ; Entrée valide (blur).
    const applyNum = (): void => {
      const raw = num.valueAsNumber;
      if (!Number.isFinite(raw)) { num.value = fmtNum(input.valueAsNumber); return; }
      const min = Number(input.min) || raw;
      const max = Number(input.max) || raw;
      const clamped = round2(Math.min(max, Math.max(min, raw)));
      num.value = fmtNum(clamped);
      input.value = String(clamped);
      panel.setMeasurementCm(field, clamped);
      guidanceEl.textContent = `Mannequin remodelé (${measureLabel(id)} ${fmtNum(clamped)} cm) · l'essayage épousera le nouveau corps.`;
    };
    num.addEventListener('change', applyNum);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
  }
  document.getElementById('at-measures-reset')?.addEventListener('click', () => {
    (document.activeElement as HTMLElement | null)?.blur?.(); // v184 : reprendre la main sur les champs
    const scan = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
    const natural = baseCm(bodyKind, scan);
    panel.syncMorphCm(natural); // recale les 6 réglages du panel
    morphs = { ...NO_MORPH }; // corps à ses mensurations naturelles
    syncAvatarStature(natural.stature!);
    syncAtelierMeasures();
    if (sceneMode !== 'drapé' && sceneMode !== 'couture') build();
    guidanceEl.textContent = 'Mannequin rendu à ses mensurations naturelles.';
  });
  // v183 ② « avatar » — GABARITS nommés dans l'atelier : les deux corps réels
  // (Femme/Homme), toujours à portée — pas seulement à la page blanche qui
  // disparaît dès qu'un patron est chargé.
  const syncGabaritButtons = (): void => {
    const f = document.getElementById('at-gab-femme');
    const h = document.getElementById('at-gab-homme');
    const isF = bodyKind.includes('femme');
    f?.setAttribute('aria-pressed', String(isF));
    f?.classList.toggle('active', isF);
    h?.setAttribute('aria-pressed', String(!isF && bodyKind !== 'scan import'));
    h?.classList.toggle('active', !isF && bodyKind !== 'scan import');
    const imp = document.getElementById('at-import-body');
    imp?.classList.toggle('active', bodyKind === 'scan import');
  };
  document.getElementById('at-gab-femme')?.addEventListener('click', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!bodyKind.includes('femme')) applyBody('scan femme');
  });
  document.getElementById('at-gab-homme')?.addEventListener('click', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!bodyKind.includes('homme')) applyBody('scan homme');
  });
  syncGabaritButtons();
  // v189 ⑤ « poses » — l'essayage se recale sur un corps POSÉ, aux colliders
  // cuits hors-ligne pose par pose (CLO → bake.py, comme le corps lui-même).
  // On coud, mesure et arrange toujours en T ; la pose n'échange que ce que
  // le tissu sent et ce que l'œil voit, puis le vêtement se re-drape.
  syncPoseButtons = (): void => {
    const scan = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.avatar-pose [data-pose]')) {
      const pose = btn.dataset.pose ?? 'native';
      const available = pose === 'native' || (scan !== null && scanHasCollisionPose(scan, pose));
      btn.disabled = !available;
      btn.classList.toggle('active', pose === bodyPose);
      btn.setAttribute('aria-pressed', String(pose === bodyPose));
    }
  };
  const applyPose = async (pose: 'native' | 'a-pose' | 'debout'): Promise<void> => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (pose === bodyPose) return;
    const scan = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
    if (pose !== 'native') {
      if (!scan || !scanHasCollisionPose(scan, pose)) return;
      if (!isNeutral(morphs)) {
        guidanceEl.textContent =
          'Les poses s’appliquent au corps à ses mensurations naturelles — remettez les cotes par défaut d’abord.';
        return;
      }
      guidanceEl.textContent = 'Chargement de la pose…';
      const collision = await ensureScanCollisionForPose(scan, pose);
      if (!collision) {
        guidanceEl.textContent = 'Pose indisponible (collision de pose non trouvée).';
        return;
      }
      bodyPoseCollision = collision;
    } else {
      bodyPoseCollision = null;
    }
    bodyPose = pose;
    syncPoseButtons();
    if (sceneMode !== 'drapé' && sceneMode !== 'couture') build();
    guidanceEl.textContent =
      pose === 'native'
        ? 'Pose couture (T) — le mannequin est revenu à la pose de travail.'
        : 'Essayage recalé sur le corps posé — patron, cotes et coutures inchangés.';
  };
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.avatar-pose [data-pose]')) {
    btn.addEventListener('click', () => {
      void applyPose((btn.dataset.pose ?? 'native') as 'native' | 'a-pose' | 'debout');
    });
  }
  syncPoseButtons();
  // SILHOUETTES préréglées : un jeu de morphs relatif aux mensurations
  // NATURELLES du corps courant (un « corps de départ » d'un clic). Bornées
  // par le panel ; une seule reconstruction via applyMeasurementsCm.
  const SILHOUETTES: Record<string, Record<string, number>> = {
    menue: { carrure: 0.96, poitrine: 0.92, taille: 0.9, hanches: 0.93, cuisse: 0.92 },
    ronde: { carrure: 1.03, poitrine: 1.15, taille: 1.22, hanches: 1.15, cuisse: 1.12 },
    athletique: { carrure: 1.12, poitrine: 1.05, taille: 0.9, hanches: 0.98, cuisse: 1.05 },
  };
  const SIL_LABEL: Record<string, string> = { menue: 'menue', ronde: 'ronde', athletique: 'athlétique' };
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.avatar-silhouette')) {
    btn.addEventListener('click', () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      const sil = btn.dataset.sil ?? '';
      const f = SILHOUETTES[sil];
      if (!f) return;
      const scan = bodyKind.startsWith('scan') ? (scans[bodyKind] ?? null) : null;
      const base = baseCm(bodyKind, scan);
      panel.applyMeasurementsCm({
        carrure: base.carrure! * (f.carrure ?? 1),
        poitrine: base.poitrine! * (f.poitrine ?? 1),
        taille: base.taille! * (f.taille ?? 1),
        hanches: base.hanches! * (f.hanches ?? 1),
        cuisse: base.cuisse! * (f.cuisse ?? 1),
      }); // → onMorph → morphs + build + resync des curseurs
      guidanceEl.textContent = `Silhouette ${SIL_LABEL[sil] ?? sil} appliquée · l'essayage épousera le nouveau corps.`;
    });
  }
  // v185 ④ « avatar » — IMPORTER un corps (OBJ) : le mesh se voxelise en SDF
  // (MeshProximity) et devient un mannequin scan à part entière — mesuré,
  // morphable (v182-184), senti par le tissu. Normalisé debout, 1,70 m ; règle
  // ensuite sa taille et ses tours au panneau.
  const importBodyFile = document.getElementById('at-import-body-file') as HTMLInputElement;
  document.getElementById('at-import-body')?.addEventListener('click', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    importBodyFile.click();
  });
  importBodyFile.addEventListener('change', async () => {
    const file = importBodyFile.files?.[0];
    importBodyFile.value = ''; // réarme pour un ré-import du même fichier
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      showToast('Fichier trop lourd (40 Mo max) — simplifie le maillage avant l\'import.');
      return;
    }
    guidanceEl.textContent = `Import de « ${file.name} » — lecture du maillage…`;
    try {
      const text = await file.text();
      guidanceEl.textContent = `Calcul du corps « ${file.name} » — voxelisation en cours…`;
      await new Promise((r) => requestAnimationFrame(() => r(null))); // laisser le message se peindre
      const mesh = parseObj(text);
      const built = buildImportedBody(mesh);
      scans['scan import'] = built;
      applyBody('scan import');
      const tris = mesh.indices.length / 3;
      showToast(`Corps importé (${tris.toLocaleString('fr-FR')} triangles) — règle sa taille et ses tours dans « Mannequin ».`);
      guidanceEl.textContent = `Corps « ${file.name} » importé · ${tris.toLocaleString('fr-FR')} triangles, mesuré et prêt à l'essayage.`;
    } catch (e) {
      showToast(`Import impossible : ${e instanceof Error ? e.message : 'fichier illisible'}`);
      guidanceEl.textContent = 'Import du corps abandonné.';
    }
  });
  document.getElementById('at-frame-avatar')?.addEventListener('click', () => {
    const aspect = canvas.width / Math.max(1, canvas.height);
    if (lastAvatarBounds) camera.frameBounds(lastAvatarBounds, aspect);
    else camera.frameAvatar(lastMeasure.height, aspect);
    pieceHoverDirty = true;
    guidanceEl.textContent = 'Vue cadrée sur le mannequin · ses dimensions physiques restent inchangées.';
  });

  // ---- Brief (étape 0) : du texte au vêtement préparé -----------------------
  // L'interpréteur (règles locales, ou endpoint distant via
  // localStorage['toile.brief.endpoint']) produit un BriefResult validé ;
  // l'exécuteur le rejoue par les MÊMES chemins que les gestes utilisateur
  // (boutons et sélecteurs de l'atelier), donc tout reste annulable (Cmd+Z).
  {
    // Backend mutable : règles locales immédiatement, Claude dès que la sonde
    // trouve un proxy (localStorage prioritaire, sinon /api/brief même origine).
    let briefBackend: BriefBackend = new RulesBackend();
    /** URL du proxy Studio IA quand il est détecté (briefs ET bilan du tombé). */
    let briefEndpointUrl: string | null = null;
    const briefInput = document.getElementById('at-brief-input') as HTMLTextAreaElement | null;
    const briefGo = document.getElementById('at-brief-go') as HTMLButtonElement | null;
    const briefStatus = document.getElementById('at-brief-status') as HTMLElement | null;
    const briefSay = (message: string, ok: boolean): void => {
      if (briefStatus) {
        briefStatus.hidden = false;
        briefStatus.textContent = message;
        briefStatus.classList.toggle('brief-status-err', !ok);
      }
      showToast(message, ok);
    };
    const setSelectValue = (sel: HTMLSelectElement | null, value: string): boolean => {
      if (!sel) return false;
      if (![...sel.options].some((o) => o.value === value)) return false;
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    /** Sélecteurs du panneau (lil) retrouvés par leur vocabulaire, jamais par index. */
    const panelSelect = (probeValue: string, exclude?: (sel: HTMLSelectElement) => boolean): HTMLSelectElement | null => {
      const all = [...document.querySelectorAll<HTMLSelectElement>('select')].filter(
        (sel) => [...sel.options].some((o) => o.value === probeValue) && !(exclude?.(sel) ?? false),
      );
      return all.length ? all[all.length - 1]! : null;
    };
    /** Provenance du dernier résultat, affichée avec chaque réponse du Brief. */
    const backendTag = (): string => {
      if (!(briefBackend instanceof RemoteBackend)) return ' · règles locales';
      if (briefBackend.lastUsed === 'assistant') return ' · ✨ Claude';
      if (briefBackend.lastUsed === 'règles') return ' · règles locales (IA en repli)';
      return '';
    };
    const briefHooks: BriefHooks = {
      loadArchetype: (archetype) => {
        const id =
          archetype === 'tshirt_boxy'
            ? 'at-tshirt'
            : archetype === 'pantalon'
              ? 'at-pants'
              : archetype === 'jupe'
                ? 'at-jupe'
                : archetype === 'robe'
                  ? 'at-robe'
                  : archetype === 'veste'
                    ? 'at-veste'
                    : archetype === 'doudoune'
                      ? 'at-doudoune'
                      : 'at-hoodie';
        const btn = document.getElementById(id);
        if (!(btn instanceof HTMLElement)) return false;
        btn.click();
        return true;
      },
      setSize: (size) => setSelectValue(sizeSel, size),
      setFabric: (preset) =>
        setSelectValue(
          // Le preset GLOBAL du panneau — pas at-fabric (tissu de la pièce active),
          // qu'on exclut via son option d'héritage « Tissu global ».
          panelSelect('Soie', (sel) => [...sel.options].some((o) => /Tissu global/.test(o.textContent ?? ''))),
          preset,
        ),
      setMotif: (motif) => setSelectValue(panelSelect('vichy'), motif),
      setBody: (kind) => setSelectValue(panelSelect('scan homme'), kind),
      setStature: (cm) => {
        avatarStatureInput.value = String(cm);
        avatarStatureInput.dispatchEvent(new Event('input', { bubbles: true }));
        avatarStatureInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      setSleeves: (on) => {
        const btn = document.getElementById('at-sleeves');
        if (!(btn instanceof HTMLElement)) return false;
        const pressed = btn.getAttribute('aria-pressed') === 'true';
        if (pressed !== on) btn.click();
        return true;
      },
      tryOn: () => {
        // Essayage déjà actif : les retouches s'appliquent en direct, recliquer
        // at-sim basculerait l'état à l'aveugle — on ne fait rien. (TOILE-24)
        // Signal fiable = la classe `atelier-simulating` (posée depuis
        // !atelierDesign), au lieu de la visibilité d'un bouton.
        if (document.body.classList.contains('atelier-simulating')) return true;
        const btn = document.getElementById('at-sim');
        if (!(btn instanceof HTMLElement)) return false;
        btn.click();
        return true;
      },
      say: (message, ok) => briefSay(`${message}${backendTag()}`, ok),
    };
    // ---- Brief visuel (IA 2) : une image accompagne ou remplace le texte ----
    // Compressée côté client (≤ 1024 px, JPEG) : les photos de téléphone font
    // plusieurs Mo, l'API n'a besoin que de la silhouette et de la matière.
    let briefImage: (BriefImageAttachment & { name: string; dataUrl: string }) | null = null;
    const briefPhotoBtn = document.getElementById('at-brief-photo') as HTMLButtonElement | null;
    const briefImageRow = document.getElementById('at-brief-image-row') as HTMLElement | null;
    const briefImageThumb = document.getElementById('at-brief-image-thumb') as HTMLImageElement | null;
    const briefImageName = document.getElementById('at-brief-image-name') as HTMLElement | null;
    const briefImageClear = document.getElementById('at-brief-image-clear') as HTMLButtonElement | null;
    const syncBriefImageRow = (): void => {
      if (!briefImageRow) return;
      briefImageRow.hidden = !briefImage;
      if (briefImage) {
        if (briefImageThumb) briefImageThumb.src = briefImage.dataUrl;
        if (briefImageName) briefImageName.textContent = briefImage.name;
      }
    };
    const clearBriefImage = (): void => {
      briefImage = null;
      syncBriefImageRow();
    };
    briefImageClear?.addEventListener('click', clearBriefImage);
    const attachBriefImage = async (file: File): Promise<void> => {
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) throw new Error('canvas 2d indisponible');
        ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const comma = dataUrl.indexOf(',');
        briefImage = {
          mediaType: 'image/jpeg',
          dataBase64: dataUrl.slice(comma + 1),
          dataUrl,
          name: file.name || 'image collée',
        };
        syncBriefImageRow();
        briefSay(`📷 « ${briefImage.name} » jointe au brief — décris (ou pas) et lance.`, true);
      } catch (error) {
        console.error('[toile] brief visuel — image illisible :', error);
        briefSay('Image illisible (format non décodable par le navigateur — essaie JPEG/PNG).', false);
      }
    };
    briefPhotoBtn?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void attachBriefImage(file);
      };
      input.click();
    });
    // Coller (Cmd+V) une image dans le champ du brief.
    briefInput?.addEventListener('paste', (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            void attachBriefImage(file);
            return;
          }
        }
      }
    });
    // Glisser-déposer une image sur le champ du brief.
    briefInput?.addEventListener('dragover', (event) => {
      if ([...(event.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) event.preventDefault();
    });
    briefInput?.addEventListener('drop', (event) => {
      const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        event.preventDefault();
        void attachBriefImage(file);
      }
    });
    const briefImageProvider = (): BriefImageAttachment | null =>
      briefImage ? { mediaType: briefImage.mediaType, dataBase64: briefImage.dataBase64 } : null;
    // ---- Studio IA : état atelier joint aux briefs + détection du proxy ----
    const BRIEF_PATTERN_LABEL: Record<string, string> = {
      boxy: 'tshirt_boxy',
      pants: 'pantalon',
      hoodie: 'hoodie_zip',
      jupe: 'jupe',
      robe: 'robe',
      veste: 'veste',
      doudoune: 'doudoune',
      'clo-tee': 'import CLO (tee, hors catalogue)',
      'clo-pants': 'import CLO (pantalon, hors catalogue)',
    };
    const briefContext = (): Record<string, unknown> => {
      const ctx: Record<string, unknown> = {};
      ctx.patron = BRIEF_PATTERN_LABEL[loadedPattern] ?? loadedPattern;
      if (sizeSel?.value) ctx.taille = sizeSel.value;
      const fabricSel = panelSelect('Soie', (sel) =>
        [...sel.options].some((o) => /Tissu global/.test(o.textContent ?? '')),
      );
      if (fabricSel?.value) ctx.tissu = fabricSel.value;
      const motifSel = panelSelect('vichy');
      if (motifSel?.value) ctx.motif = motifSel.value;
      const bodySel = panelSelect('scan homme');
      if (bodySel?.value) ctx.mannequin = bodySel.value;
      const stature = Number(avatarStatureInput.value);
      if (Number.isFinite(stature) && stature > 0) ctx.statureCm = Math.round(stature);
      const sleevesBtn = document.getElementById('at-sleeves');
      if (sleevesBtn instanceof HTMLElement) {
        ctx.manchesAuto = sleevesBtn.getAttribute('aria-pressed') === 'true';
      }
      ctx.essayage = document.body.classList.contains('atelier-simulating');
      return ctx;
    };
    {
      let explicit: string | null = null;
      try {
        const stored = localStorage.getItem(BRIEF_ENDPOINT_STORAGE_KEY)?.trim();
        explicit = stored && /^https?:\/\//.test(stored) ? stored : null;
      } catch {
        explicit = null; // storage interdit (webview privée) : sonde même origine.
      }
      if (explicit) {
        briefBackend = new RemoteBackend(explicit, undefined, undefined, undefined, briefContext, briefImageProvider);
        briefEndpointUrl = explicit;
      } else {
        void probeBriefEndpoint('/api/brief').then((ready) => {
          if (!ready) return;
          briefBackend = new RemoteBackend('/api/brief', undefined, undefined, undefined, briefContext, briefImageProvider);
          briefEndpointUrl = '/api/brief';
          briefSay('✨ Studio IA actif — Claude interprète les briefs (règles locales en secours).', true);
        });
      }
    }
    // ---- IA 1 : Bilan du tombé — le conseiller de bien-aller ----------------
    // Le solveur mesure (aisance tissu-corps, étirement du tissage, coutures),
    // Claude interprète en modéliste et propose des retouches en ops du contrat.
    const fitCheckBtn = document.getElementById('at-fit-check') as HTMLButtonElement | null;
    const collectFitReport = async (): Promise<Record<string, unknown> | null> => {
      const mesh = currentMesh;
      if (!mesh || !system) return null;
      const snap = await system.readCollisionDistances();
      if (!snap) return null;
      const m = lastMeasure;
      interface ZoneAcc {
        n: number;
        easeSum: number;
        easeMin: number;
        strains: number[];
      }
      const zones = new Map<string, ZoneAcc>();
      const zoneAcc = (name: string): ZoneAcc => {
        let a = zones.get(name);
        if (!a) {
          a = { n: 0, easeSum: 0, easeMin: Infinity, strains: [] };
          zones.set(name, a);
        }
        return a;
      };
      const midChestShoulder = (m.chest.y + m.shoulderY) / 2;
      const midChestWaist = (m.chest.y + m.waist.y) / 2;
      const midWaistHip = (m.waist.y + m.hip.y) / 2;
      const hemCut = m.hip.y - Math.max(0.04, (m.waist.y - m.hip.y) / 2);
      const zoneOf = (x: number, y: number): string => {
        if (Math.abs(x) > m.shoulderHalfW * 1.05) return 'manches';
        if (y >= midChestShoulder) return 'épaules/col';
        if (y >= midChestWaist) return 'poitrine';
        if (y >= midWaistHip) return 'taille';
        if (y >= hemCut) return 'hanches';
        return 'bas/ourlet';
      };
      const positions = snap.positions; // xyz par particule (stride 3)
      const live = (index: number): boolean =>
        (mesh.invMasses[index] ?? 0) > 0 && positions[index * 3 + 1]! > -1;
      // Aisance : distance signée au corps moins l'épaisseur de contact.
      for (let index = 0; index < mesh.count; index++) {
        if (!live(index)) continue;
        const distance = snap.distances[index]!;
        if (!Number.isFinite(distance) || distance > 0.5) continue; // hors domaine
        const easeMm = (distance - snap.contactOffsets[index]!) * 1000;
        const zone = zoneAcc(zoneOf(positions[index * 3]!, positions[index * 3 + 1]!));
        zone.n++;
        zone.easeSum += easeMm;
        if (easeMm < zone.easeMin) zone.easeMin = easeMm;
      }
      // Étirement du tissage + sur-tension des coutures, depuis les contraintes.
      const cu = new Uint32Array(mesh.constraintData);
      const cf = new Float32Array(mesh.constraintData);
      // Bords découpés : l'accrochage des particules sur la courbe exacte du
      // patron laisse des contraintes-échardes à repos minuscule, dont le
      // moindre écart absolu se lit en pourcentage énorme (faux « +170 % »).
      // On ne mesure l'étirement que sur le tissage à repos plein.
      const sliverRest =
        0.4 * Math.min(mesh.spacing, mesh.spacingV ?? mesh.spacing, mesh.spacing2 ?? mesh.spacing);
      let seamOverMaxMm = 0;
      let seamOverSumMm = 0;
      let seamCount = 0;
      for (let c = 0; c < mesh.constraintCount; c++) {
        const base = c * 4;
        const kind = cu[base + 3]!;
        if (kind !== 0 && kind !== 1 && kind !== 3 && kind !== 4) continue;
        const i = cu[base]!;
        const j = cu[base + 1]!;
        if (!live(i) || !live(j)) continue;
        const rest = cf[base + 2]!;
        if (!(rest > 1e-6)) continue;
        if (kind !== 3 && rest < sliverRest) continue; // écharde de bord découpé
        const dx = positions[i * 3]! - positions[j * 3]!;
        const dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!;
        const dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
        const len = Math.hypot(dx, dy, dz);
        if (kind === 3) {
          const overMm = Math.max(0, len - rest) * 1000;
          seamCount++;
          seamOverSumMm += overMm;
          if (overMm > seamOverMaxMm) seamOverMaxMm = overMm;
          continue;
        }
        const strainPct =
          kind === 1 ? (Math.abs(len - rest) / rest) * 100 : (Math.max(0, len - rest) / rest) * 100;
        zoneAcc(zoneOf((positions[i * 3]! + positions[j * 3]!) / 2, (positions[i * 3 + 1]! + positions[j * 3 + 1]!) / 2))
          .strains.push(strainPct);
      }
      const r1 = (v: number): number => Math.round(v * 10) / 10;
      const zoneReports: Array<Record<string, unknown>> = [];
      for (const [name, a] of zones) {
        if (a.n < 12 && a.strains.length < 12) continue; // zone anecdotique
        const sorted = a.strains.sort((u, v) => u - v);
        const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0;
        const mean = sorted.length ? sorted.reduce((s2, v) => s2 + v, 0) / sorted.length : 0;
        zoneReports.push({
          zone: name,
          aisanceMm: a.n ? { min: r1(a.easeMin), moy: r1(a.easeSum / a.n) } : undefined,
          etirementPct: { moy: r1(mean), p95: r1(p95) },
        });
      }
      const ctx = briefContext();
      const garment: Record<string, unknown> = {
        patron: ctx.patron,
        taille: ctx.taille,
        tissu: ctx.tissu,
        motif: ctx.motif,
      };
      const fabricSnapshot = (panel.snapshotGarment() as { fabric?: { densityGsm?: unknown } }).fabric;
      if (typeof fabricSnapshot?.densityGsm === 'number') garment.grammageGsm = fabricSnapshot.densityGsm;
      return {
        garment,
        body: {
          mannequin: ctx.mannequin,
          statureCm: ctx.statureCm,
          poitrineCm: r1(m.chest.circ * 100),
          tailleCm: r1(m.waist.circ * 100),
          hanchesCm: r1(m.hip.circ * 100),
        },
        zones: zoneReports,
        coutures: seamCount
          ? { surTensionMaxMm: r1(seamOverMaxMm), surTensionMoyMm: r1(seamOverSumMm / seamCount) }
          : undefined,
      };
    };
    const showFitCard = (advice: FitAdviceResult): void => {
      let card = document.getElementById('toile-fit-card');
      if (!card) {
        card = document.createElement('section');
        card.id = 'toile-fit-card';
        card.style.cssText =
          'position:fixed;left:18px;bottom:18px;z-index:22;width:min(430px,calc(100vw - 36px));' +
          'padding:14px 16px;border-radius:8px;font:12px/1.5 system-ui,sans-serif;color:#ede9df;' +
          'background:rgba(10,11,14,0.96);border:1px solid rgba(151,222,180,.55);box-shadow:0 12px 40px rgba(0,0,0,.35)';
        document.body.appendChild(card);
      }
      card.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = '🩺 Bilan du tombé — ✨ Claude';
      title.style.cssText = 'display:block;margin-right:28px;margin-bottom:6px;font-size:13px';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'fermer le bilan du tombé');
      close.style.cssText =
        'position:absolute;right:10px;top:7px;border:0;background:transparent;color:#ede9df;font:22px sans-serif;cursor:pointer';
      close.onclick = () => card!.remove();
      const resume = document.createElement('p');
      resume.textContent = advice.resumeFr;
      resume.style.cssText = 'margin:0 0 8px;color:#cfe8d8';
      card.append(title, close, resume);
      const ICON: Record<string, string> = { ok: '🟢', tendu: '🔴', 'serré': '🟠', ample: '🔵' };
      for (const finding of advice.findings) {
        const line = document.createElement('div');
        line.style.marginTop = '4px';
        line.textContent = `${ICON[finding.etat] ?? '·'} ${finding.zone} — ${finding.detailFr}`;
        card.appendChild(line);
      }
      if (advice.suggestions.length) {
        const actions = document.createElement('div');
        actions.style.cssText = 'margin-top:10px;display:flex;flex-wrap:wrap;gap:6px';
        for (const suggestion of advice.suggestions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = suggestion.labelFr;
          btn.style.cssText =
            'padding:5px 10px;border-radius:6px;border:1px solid rgba(151,222,180,.5);' +
            'background:rgba(151,222,180,.12);color:#dff3e6;cursor:pointer;font:12px system-ui';
          btn.onclick = () => {
            executeBrief(
              { intent: 'modify', ops: suggestion.ops, tryOn: false, resumeFr: suggestion.labelFr },
              briefHooks,
            );
          };
          actions.appendChild(btn);
        }
        card.appendChild(actions);
      }
    };
    const runFitCheck = async (): Promise<void> => {
      if (!document.body.classList.contains('atelier-simulating')) {
        briefSay('Lance d’abord l’essayage 3D — le bilan lit le drapé réel, pas le patron à plat.', false);
        return;
      }
      // Mesurer un vêtement en mouvement (assemblage, chute) donne des chiffres
      // faux (coutures encore ouvertes lues comme « sur-tension »). La veille du
      // moteur EST le certificat d'équilibre : on ne mesure qu'un tissu posé.
      if (!asleep) {
        briefSay('Le tissu bouge encore — attends qu’il se pose (veille 💤), puis relance le bilan.', false);
        return;
      }
      if (!briefEndpointUrl) {
        briefSay('Le bilan du tombé demande le Studio IA (proxy Claude non détecté).', false);
        return;
      }
      if (fitCheckBtn) fitCheckBtn.disabled = true;
      briefSay('🩺 Claude examine le tombé…', true);
      try {
        const report = await collectFitReport();
        if (!report) {
          briefSay('Mesures indisponibles — attends la fin de la mise en place de l’essayage.', false);
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000);
        let advice: FitAdviceResult | null = null;
        let failureFr = 'conseiller injoignable';
        // Le rapport en console : pour diagnostiquer un bilan refusé sans deviner.
        console.debug('[toile] bilan du tombé — rapport envoyé :', report);
        try {
          const response = await fetch(briefEndpointUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ format: 'toile-fit', version: 1, report }),
            signal: controller.signal,
          });
          const raw: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            const serverError = (raw as { error?: unknown } | null)?.error;
            failureFr = `HTTP ${response.status}${typeof serverError === 'string' ? ` — ${serverError}` : ''}`;
            console.error('[toile] bilan refusé par le proxy :', response.status, raw);
          } else {
            advice = validateFitAdvice(raw);
            if (!advice) {
              failureFr = 'réponse du conseiller hors contrat';
              console.error('[toile] bilan hors contrat :', raw);
            }
          }
        } catch (error) {
          failureFr = controller.signal.aborted ? 'délai dépassé (25 s)' : `réseau : ${String(error)}`;
          console.error('[toile] bilan — échec réseau :', error);
        } finally {
          clearTimeout(timer);
        }
        if (!advice) {
          briefSay(`Bilan indisponible — ${failureFr}. Réessaie ; le détail est en console.`, false);
          return;
        }
        showFitCard(advice);
        briefSay(`${advice.resumeFr} · ✨ Claude`, true);
      } finally {
        if (fitCheckBtn) fitCheckBtn.disabled = false;
      }
    };
    fitCheckBtn?.addEventListener('click', () => void runFitCheck());
    const runBrief = async (): Promise<void> => {
      const text = briefInput?.value ?? '';
      if (!text.trim() && !briefImage) {
        briefSay('Décris le vêtement (« hoodie en maille, taille L ») — ou joins une photo 📷.', false);
        return;
      }
      if (briefImage && !(briefBackend instanceof RemoteBackend)) {
        briefSay('Le brief visuel demande le Studio IA (proxy Claude non détecté) — les règles locales ne lisent pas les images.', false);
        return;
      }
      if (briefGo) briefGo.disabled = true;
      if (briefBackend instanceof RemoteBackend) {
        briefSay(briefImage ? '✨ Claude regarde la photo…' : '✨ Claude interprète le brief…', true);
      }
      try {
        const result = await briefBackend.interpret(text);
        const execution = executeBrief(result, briefHooks);
        // Image consommée une fois le vêtement appliqué : les briefs suivants
        // (« une taille au-dessus ») ne doivent pas re-payer ni re-lire la photo.
        if (execution.ok && briefImage) clearBriefImage();
      } finally {
        if (briefGo) briefGo.disabled = false;
      }
    };
    briefGo?.addEventListener('click', () => void runBrief());
    // Entrée lance le brief ; Maj+Entrée garde le retour à la ligne.
    briefInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void runBrief();
      }
    });
  }

  // Keyboard shortcuts mirror the panel (brief §3.3 release flow). Each must
  // wake() like its panel button — otherwise pressing R or P on a settled
  // (asleep) garment does nothing visible: the reset/pin lands but the solver
  // never steps to show it.
  window.addEventListener('keydown', (e) => {
    if (sceneTransitionBusy()) return;
    const rpTarget = e.target;
    if (
      rpTarget instanceof HTMLInputElement ||
      rpTarget instanceof HTMLSelectElement ||
      rpTarget instanceof HTMLTextAreaElement ||
      (rpTarget instanceof HTMLElement && rpTarget.isContentEditable)
    ) {
      return; // v176 : taper « r » dans le brief ne réinitialise plus le tissu
    }
    if (e.key === 'r' || e.key === 'R') {
      system.reset();
      panel.syncPins(false);
      wake();
    } else if (e.key === 'p' || e.key === 'P') {
      const held = !system.pinsHeld;
      system.setCornerPins(held);
      panel.syncPins(held);
      wake();
    }
  });

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 2);
    // Clamp to the GPU's max texture size (audit — HiDPI robustness): a 5K/6K
    // display at dpr 2 exceeds the guaranteed 8192 limit, and an over-size
    // swapchain texture fails to create → blank canvas. The depth texture in
    // renderer.resize() gets the same clamped dims, so colour/depth stay matched.
    const maxDim = device.limits.maxTextureDimension2D;
    canvas.width = Math.min(maxDim, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.min(maxDim, Math.floor(canvas.clientHeight * dpr));
    mirror.width = canvas.width;
    mirror.height = canvas.height;
    // The saved NDC was computed against the old CSS rectangle. Until the
    // pointer moves again, showing that old target would make hover and click
    // disagree because pointerdown recomputes its ray from the new rectangle.
    pointerInside3D = false;
    pieceHoverDirty = true;
    setPieceHover(null);
    if (!sceneTransitionBusy()) renderer.resize(canvas.width, canvas.height);
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
  let rawAccum = 0; // real wall-clock frame time (unclamped), for the substep governor
  // Adaptive substep governor (audit — runs well on most machines): the slider
  // is the CEILING; on a weak GPU the effective substep count is scaled down to
  // keep the frame rate playable, floored at 8 for physics quality. Driven by
  // REAL frame time, not the clamped dt or the GPU timestamp (which reads 0 on
  // the very machines that need this).
  let govSubsteps = DEFAULT_SUBSTEPS;

  const frame = (now: number): void => {
    const t0 = performance.now();
    const rawMs = now - last; // before the dt clamp below
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp tab-switch spikes
    last = now;
    // A transition owns the device until its old queue is drained and its new
    // generation is committed. Do not encode render, simulation or pick work.
    if (sceneTransitionBusy()) {
      schedule();
      return;
    }
    rawAccum += Math.min(rawMs, 200); // ignore tab-switch spikes in the governor's average

    // Skip while the canvas has no size (some webviews report a 0×0 viewport
    // until laid out) — rendering into a 0-sized surface errors.
    if (canvas.width === 0 || canvas.height === 0) {
      schedule();
      return;
    }

    const aspect = canvas.width / canvas.height;
    const ray = camera.pickRay(mouse.ndcX, mouse.ndcY, aspect);
    // ⊹ pastille survolée (10 points max : négligeable par frame).
    if (arrangeMode && sceneMode === 'atelier' && atelierDesign && pointerInside3D) {
      arrangeHoverId = arrangePointNear(mouse.ndcX, mouse.ndcY)?.id ?? null;
    } else if (arrangeHoverId !== null) {
      arrangeHoverId = null;
    }
    const canHoverPiece =
      pointerInside3D &&
      pointerButtons3D === 0 &&
      sceneMode === 'atelier' &&
      atelierDesign &&
      move3DEnabled &&
      !mouse.leftDown &&
      !pieceDrag &&
      !patternView.sewing &&
      !patternView.zippering;
    if (!canHoverPiece) {
      setPieceHover(null);
    } else if (pieceHoverDirty && now >= nextPieceHoverAt) {
      pieceHoverDirty = false;
      nextPieceHoverAt = now + 45;
      const hovered = pickStagingPiece(ray);
      setPieceHover(
        hovered
          ? { pid: hovered.pid, instance: hovered.instance }
          : null,
      );
    }

    // Anything that keeps the cloth alive also keeps the solver awake.
    // Gate on animate && animPrims: checking 'animation bras' on a scan/drapé/
    // dress-form scene (animPrims null) moves nothing, so it must not block
    // sleep forever (audit M35).
    const sleepEligible =
      wind === 0 && podium === 0 && !(animate && animPrims) && dragIndex === null && !mouse.leftDown;
    if (!sleepEligible && asleep) wake();

    // Refresh the CPU position cache used by the instant grab test (time-based
    // ~3 Hz — frame counters mislead when rAF throttles); consecutive
    // snapshots double as the stillness detector for sleep.
    // Gate the poll on !asleep (M9): a sleeping sim's positions are frozen and
    // posCache stays valid for picking, so the staging-buffer create + copy +
    // map every 300 ms is pure waste on a page whose point is to idle at ~0.
    // Any wake() path re-arms it. Capture the system identity (M28): if build()
    // swaps the ParticleSystem while this read is in flight, the resolved
    // positions belong to the OLD garment — bail rather than clobber posCache /
    // the sleep-detector references with stale geometry.
    if (!asleep && now - lastSnapReqT > 300) {
      lastSnapReqT = now;
      const sys = system;
      void sys.readPositions().then((p) => {
        if (!p || sys !== system) return;
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
        pieceHoverDirty = true;
      });
    }

    // ⬦ Édition de contour : le sommet saisi suit le rayon sur le plan de SA
    // pièce ; au relâcher, commit dans le circuit 2D (refus si auto-croisé).
    if (edit3dDrag) {
      if (mouse.leftDown && sceneMode === 'atelier' && atelierDesign) {
        const hit = planeUVAt(ray, edit3dDrag.pid);
        if (hit) {
          const u = Math.min(1, Math.max(0, hit.uv[0]));
          const v = Math.min(1, Math.max(0, hit.uv[1]));
          if (Math.hypot(u - edit3dDrag.uv[0], v - edit3dDrag.uv[1]) > 1e-6) {
            edit3dDrag.uv = [u, v];
            edit3dDrag.moved = true;
          }
        }
      } else {
        const d = edit3dDrag;
        edit3dDrag = null;
        const piece = draft ? docPieces(draft)[d.pid] : null;
        if (piece && d.moved && draft) {
          const prev = piece.outline[d.vertex]!;
          const distM = Math.hypot((d.uv[0] - prev[0]) * piece.width, (d.uv[1] - prev[1]) * piece.height);
          if (distM >= 0.002) {
            const outline = piece.outline.map((pt, i) => (i === d.vertex ? ([d.uv[0], d.uv[1]] as UV) : pt));
            const linked3d =
              linkedEditPref && draft
                ? linkedVertexEdit(draft, d.pid, d.vertex, [d.uv[0], d.uv[1]] as UV)
                : null;
            if (isSelfIntersecting(outline)) {
              showToast('Ce déplacement croiserait le contour — geste abandonné.');
            } else if (linked3d && !linked3d.ok) {
              showToast(linked3d.reason);
            } else {
              pushHistory();
              if (linked3d && linked3d.ok && linked3d.followed.length) draft = linked3d.doc;
              else replaceDraftPiece(d.pid, { ...piece, outline });
              draftTouched = true;
              teePreset = false;
              atelierDesign = true;
              simBtn().classList.remove('running');
              build();
              void lifecycle.whenIdle().then(() => {
                showPlacementStatus(
                  [
                    `Sommet du contour DÉPLACÉ depuis la 3D sur « ${draftPieceLabel(draftPieceOf(d.pid), d.pid)} » — ${(distM * 100).toFixed(1).replace('.', ',')} cm.`,
                    `${linked3d && linked3d.ok && linked3d.followed.length ? '⛓ le vis-à-vis a suivi, forme comprise · ' : ''}Le patron 2D a suivi · les coutures recousent aux nouvelles longueurs · Ctrl+Z annule.`,
                  ],
                  true,
                );
              });
            }
          }
        }
      }
    }
    // ORGANISER EN 3D : la pièce saisie suit la souris dans le plan d'écran
    // passant par le point saisi. Selon l'angle de caméra, ce plan déplace en
    // X/Y/Z. The solver buffers move live, then only the preparation offset is
    // committed; pattern dimensions and seam topology remain byte-identical.
    if (pieceDrag) {
      if (mouse.leftDown && sceneMode === 'atelier' && atelierDesign) {
        const d = pieceDrag;
        if (d.rot) {
          const r = d.rot;
          let ang = r.lastAngle;
          if (r.plane) {
            // Anneau d'axe MONDE : angle dans le plan de l'anneau (rayon∩plan).
            const hit = rayHitPlane(ray, r.axis, r.pivot);
            if (hit) {
              const du = (hit[0] - r.pivot[0]) * r.plane.u[0] + (hit[1] - r.pivot[1]) * r.plane.u[1] + (hit[2] - r.pivot[2]) * r.plane.u[2];
              const dv = (hit[0] - r.pivot[0]) * r.plane.v[0] + (hit[1] - r.pivot[1]) * r.plane.v[1] + (hit[2] - r.pivot[2]) * r.plane.v[2];
              ang = Math.atan2(dv, du);
            }
          } else {
            // Anneau ÉCRAN : angle du pointeur autour du centre projeté.
            const cpx = gizmoCenterPx();
            if (cpx) {
              const ringRect = canvas.getBoundingClientRect();
              const rpx = ((mouse.ndcX + 1) / 2) * ringRect.width;
              const rpy = ((1 - mouse.ndcY) / 2) * ringRect.height;
              ang = Math.atan2(rpy - cpx[1], rpx - cpx[0]);
            }
          }
          let dA = ang - r.lastAngle;
          while (dA > Math.PI) dA -= 2 * Math.PI;
          while (dA < -Math.PI) dA += 2 * Math.PI;
          r.angle += dA;
          r.lastAngle = ang;
          const q = quatFromAxisAngle(r.axis, r.angle);
          for (const range of d.ranges) {
            system.rotateRange(range.first, range.count, q, r.pivot);
          }
        } else if (d.axis !== undefined && d.grabNdc) {
          // ⌖ Drag de flèche : le paramètre d'axe qui suit au mieux le curseur
          // à l'écran (projection du delta souris sur l'axe projeté, en px).
          const a = GIZMO_AXES[d.axis]!.dir;
          // Base de projection = le segment de flèche DESSINÉ (0,22 m), pas
          // 1 m : pour un axe pointant vers la caméra, la perspective tord ou
          // retourne le segment lointain (Z restait alors figé à zéro).
          const n0 = arrangeNdcOf(d.start);
          const n1 = arrangeNdcOf([
            d.start[0] + a[0] * GIZMO_LEN_M,
            d.start[1] + a[1] * GIZMO_LEN_M,
            d.start[2] + a[2] * GIZMO_LEN_M,
          ]);
          if (n0 && n1) {
            const rect2 = canvas.getBoundingClientRect();
            const vx = ((n1[0] - n0[0]) * rect2.width) / 2;
            const vy = (-(n1[1] - n0[1]) * rect2.height) / 2;
            const wx = ((mouse.ndcX - d.grabNdc[0]) * rect2.width) / 2;
            const wy = (-(mouse.ndcY - d.grabNdc[1]) * rect2.height) / 2;
            const len2 = vx * vx + vy * vy;
            // ≥ 6 px de flèche projetée — même seuil que le dessin, sinon la
            // précision du geste n'existe pas.
            if (len2 > 36) {
              const t = Math.max(
                -2,
                Math.min(2, ((wx * vx + wy * vy) / len2) * GIZMO_LEN_M),
              );
              d.delta = [a[0] * t, a[1] * t, a[2] * t];
            }
          }
        } else {
          d.delta = [
            ray.origin[0] + ray.dir[0] * d.depth - d.start[0],
            ray.origin[1] + ray.dir[1] * d.depth - d.start[1],
            ray.origin[2] + ray.dir[2] * d.depth - d.start[2],
          ];
        }
        if (!d.rot) {
          for (const range of d.ranges) {
            system.translateRange(range.first, range.count, d.delta);
          }
        }
      } else {
        const d = pieceDrag;
        releasePiecePointer(d.pointerId);
        pieceDrag = null;
        pieceHoverDirty = true;
        canvas.classList.remove('piece-dragging');
        const rotated = !!draft && !!d.rot && Math.abs(d.rot.angle) >= 0.0087;
        const moved = !rotated && !!draft && Math.hypot(...d.delta) >= 0.005;
        // Sélection du trièdre : le clic simple sélectionne, un drag la garde.
        gizmoPick = { pid: d.pid, instance: d.instance };
        if (rotated && draft && d.rot) {
          pushHistory();
          let piece = draftPieceOf(d.pid);
          if (piece) {
            if (d.pid === 1 && !draft.back) piece = structuredClone(draft.piece);
            replaceDraftPiece(
              d.pid,
              rotatePieceInstanceInStaging(
                piece,
                d.instance,
                quatFromAxisAngle(d.rot.axis, d.rot.angle),
              ),
            );
          }
          draftTouched = true;
          atelierDesign = true;
          build();
        } else if (moved && draft) {
          pushHistory();
          let piece = draftPieceOf(d.pid);
          if (piece) {
            // Materialise a mirrored back before giving it an independent
            // staging transform; the front pattern itself is not modified.
            if (d.pid === 1 && !draft.back) piece = structuredClone(draft.piece);
            replaceDraftPiece(
              d.pid,
              movePieceInstanceInStaging(piece, d.instance, d.delta),
            );
          }
          draftTouched = true;
          atelierDesign = true;
          build(); // reconstruct the preparation preview from canonical + offset
        } else {
          // A click is also how a user selects a piece. Do not pay for a full
          // hoodie rebuild when the pointer never crossed the drag threshold.
          for (const range of d.ranges) {
            system.translateRange(range.first, range.count, [0, 0, 0]);
          }
          posCache = d.positions;
        }
      }
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

    // Fenêtre post-réveil : pleine précision (le transitoire d'assemblage ne
    // doit pas dépendre du framerate de l'onglet) ; ensuite, le gouverneur.
    const substeps = performance.now() < wakeUntil ? panel.substeps : Math.min(panel.substeps, govSubsteps);
    // Podium = presentation turn of the dressed mannequin as one assembly.
    // Physics stays in the mannequin's local frame; rotating only the collider
    // made it travel through an almost stationary garment and eventually
    // stripped dresses off the shoulders. The renderer applies this same angle
    // to body and cloth, preserving their measured clearance exactly.
    const omega = (podium * 2 * Math.PI) / 60;
    if (omega !== 0) podiumAngle = (podiumAngle + omega * dt) % (2 * Math.PI);
    system.setSpin(0, 0);
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
    // Atelier design mode freezes the drawn piece flat (weightless) where it was
    // drawn, until the user presses Simuler — like arranging 2D pieces in CLO.
    const frozen = sceneMode === 'atelier' && atelierDesign;
    const sleeping = (asleep && sleepEligible) || frozen;
    if (!sleeping) system.step(dt, substeps, profiler.simSpan());
    renderer.render(camera.matrix(aspect), profiler.renderSpan());
    blit();
    drawAtelierOverlay(); // surlignage patronnage (couture 3D, pièce saisie)
    profiler.resolve();

    frames++;
    fpsAccum += dt;
    cpuAccum += performance.now() - t0;
    if (fpsAccum >= 0.5) {
      const fps = Math.round(frames / fpsAccum);
      // Governor: adapt only while actually stepping (a sleeping sim's frames
      // are cheap and would wrongly ramp up). Real frame time = rawAccum/frames.
      if (!asleep && !frozen && frames > 0) {
        const realFrameMs = rawAccum / frames;
        if (realFrameMs > 38) govSubsteps = Math.max(8, govSubsteps - 2); // < ~26 fps: shed load
        else if (realFrameMs < 22) govSubsteps = Math.min(panel.substeps, govSubsteps + 1); // > ~45 fps: restore
      }
      const timing = frozen
        ? 'conception · à plat, en apesanteur ✎ — ▶ Simuler pour draper'
        : asleep
          ? `sim en veille 💤 · rendu ${profiler.enabled ? profiler.renderMs.toFixed(2) : '—'} ms (GPU)`
          : profiler.enabled
            ? `sim ${profiler.simMs.toFixed(2)} ms · rendu ${profiler.renderMs.toFixed(2)} ms (GPU)`
            : `${(cpuAccum / frames).toFixed(2)} ms/frame (CPU)`;
      hud.textContent =
        `${fps} fps · ${timing} · ${liveParticleCount.toLocaleString('fr-FR')} part. · ` +
        `${system.constraintCount.toLocaleString('fr-FR')} contr. · ${substeps} substeps${substeps < panel.substeps ? ' (auto)' : ''}`;
      if (sceneMode === 'atelier') refreshHint(); // suit l'état de la couture (1er bord retenu, etc.)
      frames = 0;
      fpsAccum = 0;
      cpuAccum = 0;
      rawAccum = 0;
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
  // A throwing frame (a WebGPU validation error, a lost device mid-render)
  // would otherwise break the rAF chain while the 50 ms watchdog keeps
  // re-firing the same broken frame — a silent freeze with a console flood.
  // Catch it once, stop the loop, and show the banner.
  const guardedFrame = (now: number): void => {
    try {
      frame(now);
    } catch (e) {
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
      showFatal('Erreur de rendu', (e as Error)?.stack ?? String(e));
    }
  };
  const schedule = (): void => {
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
    rafId = requestAnimationFrame(guardedFrame);
    timeoutId = window.setTimeout(() => guardedFrame(performance.now()), 50);
  };

  // Draw the initial state once so the scene shows immediately, before the loop.
  renderer.render(camera.matrix(canvas.width / canvas.height));
  blit();
  schedule();
}

main().catch((e) => showFatal('Erreur au démarrage', e?.stack ?? e?.message ?? String(e)));
