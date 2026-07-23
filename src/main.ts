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
import { defaultDraft, tshirtDraft, compileDraft, compileAssembly, compileCrossSeams, compileSurfaceContacts, compileSurfaceSeams, crossSewnOpenCells, neckOpeningCells, removeFreePiece, reboxPiece, pieceIdOf, nearestOutlineEdgeInfo, syncPieceFrames, sanitizeDraft, pointInPolygon, pointInTriangle, surfaceAttachmentUV, type DraftDoc, type AssemblySeam, type DraftPiece } from './engine/pattern/Draft';
import {
  applyStagingOffset,
  autoPlaceMeshFromCrossSeams,
  hasStagingOffset,
  movePieceInstanceInStaging,
  placeMeshOnSurface,
  placementIssues,
  placementRoleLabel,
  resetPieceInstanceStaging,
  resetPieceStaging,
  stagingOffsetOf,
} from './engine/pattern/PatternPlacement';
import { boxyTee, boxyChestCm, BOXY_SIZES, type BoxySize } from './engine/pattern/draftTee';
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
import { ClothRenderer, DEFAULT_FABRIC } from './app/ClothRenderer';
import { OrbitCamera, type CameraBounds } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh, SCENE_VERTEX_FLOATS, type SceneMesh } from './app/SceneGeometry';
import { computeNormals, downloadGlb, type GltfPiece } from './app/gltfExport';
import { GpuProfiler } from './app/GpuProfiler';
import {
  AVATAR_STATURE_MAX_CM,
  AVATAR_STATURE_MIN_CM,
  ControlPanel,
  type SceneMode,
} from './app/ControlPanel';
import { PatternView, SEAM_COLORS, type PatternHandleSpec, type SystemLink } from './app/PatternView';
import { exportDraftPatternPdf, exportDraftPatternSvg } from './app/draftPatternExport';
import { exportPatternPdf } from './app/patternPdf';
import { exportPatternSvg } from './app/patternSvg';
import { pickParticle } from './app/pick';
import {
  SceneBuildTimeoutError,
  SceneLifecycle,
  SceneTeardownTimeoutError,
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
import { loadScanAvatar, type ScanAvatar } from './engine/body/ScanAvatar';
import { gridSd, measureBody, type BodyMeasure, type Sd } from './engine/body/measure';
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
  const patternView = new PatternView(
    document.getElementById('pattern') as HTMLCanvasElement,
    (id, value) => applyHandle(id, value),
    (piece, pieceId, seams, segmentLinks, linkedPieces) => {
      // A piece changed (vertex moved / added / deleted / drawn). Commit it into
      // the current draft — front (0), the côte-à-côte back (1), or a FREE piece
      // (≥ 2) — and re-cut. Editing returns to the flat design view (physics
      // paused) so the change shows without the piece draping away.
      pushHistory(); // un cran d'annulation par geste
      if (draft?.preset === 'lucas-hoodie') hoodieFitPristine = false;
      teePreset = false; // a manual edit ⇒ freeform mode; keep the edit (stop re-drafting)
      const gridN = resolution as 32 | 64 | 128;
      if (!draft) draft = { format: 'toile-draft', version: 1, gridN, piece: defaultDraft(gridN).piece };
      draft.gridN = gridN;
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
      const surface = piece.placement?.role === 'pocket' ? piece.placement.surface : null;
      if (surface) {
        const support =
          surface.supportPieceId === 0
            ? draft.piece
            : surface.supportPieceId === 1
              ? draft.back
              : draft.pieces?.[surface.supportPieceId - 2];
        showPlacementStatus(
          surface.stitchedEdges.length
            ? [
                `${piece.name ?? 'Poche'} posée sur ${support?.name ?? `pièce ${surface.supportPieceId + 1}`} · ${surface.stitchedEdges.length}/${piece.outline.length} segments cousus.`,
                'Cliquez un × orange pour retirer cette couture · 🪡 Coudre puis un bord pointillé pour la remettre.',
              ]
            : [
                `${piece.name ?? 'Poche'} n’a plus aucune couture : remettez-en une avec 🪡 Coudre puis cliquez un bord pointillé.`,
              ],
          surface.stitchedEdges.length > 0,
        );
      }
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
      const remaining =
        draft.preset === 'lucas-hoodie'
          ? []
          : placementIssues(draft).filter((issue) => issue.severity === 'error');
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
  const avatarStatureValue = document.getElementById('at-avatar-stature-value') as HTMLOutputElement;
  avatarStatureInput.min = String(AVATAR_STATURE_MIN_CM);
  avatarStatureInput.max = String(AVATAR_STATURE_MAX_CM);
  const syncAvatarStature = (cm: number): void => {
    const clamped = Math.min(AVATAR_STATURE_MAX_CM, Math.max(AVATAR_STATURE_MIN_CM, cm));
    const rounded = Math.round(clamped * 2) / 2;
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    avatarStatureInput.value = String(rounded);
    avatarStatureInput.setAttribute('aria-valuetext', `${label} centimètres`);
    avatarStatureValue.value = `${label} cm`;
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
  let atelierSleeves = location.hash.startsWith('#v96'); // multi-piece stage 1: add system sleeves to the atelier garment (debug hash: #v96 = proven rect tubes, #v96b = same via the freeform generator)
  let atelierSleeveLen = 0.5; // sleeve length (shoulder→cuff, m): 0.5 long, ~0.22 short (t-shirt)
  let atelierCollar = false; // multi-piece: add a system collar band at the neckline
  let teePreset = false; // T-shirt preset: build a real set-in-sleeve tee instead of the draft
  // ZONE DE CONFECTION LIBRE : « ✎ Pièce » arme la plume ; à la fermeture du
  // tracé, le choix de placement (#place-chooser) s'ouvre pour CETTE pièce.
  let penPlacement = false; // la prochaine pièce fermée demandera son placement
  let placePending: number | null = null; // pieceId en attente de placement
  const placeChooser = document.getElementById('place-chooser') as HTMLElement;
  const placementStatus = document.getElementById('placement-status') as HTMLElement;
  const showChooser = (on: boolean): void => {
    placeChooser.hidden = !on;
    if (bigPanel) requestAnimationFrame(applySplit);
  };
  const showPlacementStatus = (messages: string[], ok = false): void => {
    placementStatus.hidden = messages.length === 0;
    placementStatus.classList.toggle('ok', ok);
    placementStatus.textContent = messages.join(' · ');
    if (bigPanel) requestAnimationFrame(applySplit);
  };
  const resetPlacement = (): void => {
    penPlacement = false;
    placePending = null;
    showChooser(false);
    showPlacementStatus([]);
  };
  // ANNULER (Ctrl/Cmd+Z) : historique par instantanés du patron — un cran par
  // geste (déplacement de point, couture, suppression de pièce, chargement).
  const draftHistory: { draft: DraftDoc | null; touched: boolean }[] = [];
  const undoButton = document.getElementById('at-undo') as HTMLButtonElement;
  const syncUndoButton = (): void => {
    undoButton.disabled = draftHistory.length === 0;
  };
  const pushHistory = (): void => {
    draftHistory.push({ draft: draft ? structuredClone(draft) : null, touched: draftTouched });
    if (draftHistory.length > 40) draftHistory.shift();
    syncUndoButton();
  };
  const replaceDraftPiece = (pid: number, piece: DraftPiece): void => {
    if (!draft) return;
    if (pid === 0) draft.piece = piece;
    else if (pid === 1) draft.back = piece;
    else if (draft.pieces?.[pid - 2]) draft.pieces[pid - 2] = piece;
  };
  const undoDraft = (): void => {
    const h = draftHistory.pop();
    if (!h) return;
    draft = h.draft;
    draftTouched = h.touched;
    teePreset = false;
    atelierDesign = true;
    resetPlacement(); // un placement en attente ne survit pas à l'annulation
    document.getElementById('at-sim')?.classList.remove('running');
    syncUndoButton();
    build();
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
    setPressed('at-length', patternView.lengthEditing);
    setPressed('at-snap', patternView.lengthSnapping);
    setPressed('at-link', patternView.linkingSegments);
    setPressed('at-sew', patternView.sewing || !!patternView.seamPick);
    setPressed(
      'at-zipper',
      patternView.zippering || !!patternView.zipperPick,
    );
    setPressed('at-move3d', move3DEnabled);
    setPressed('at-sleeves', atelierSleeves);
  };
  const deactivateEditingTools = (): void => {
    if (patternView.lengthEditing) patternView.toggleLength();
    if (patternView.linkingSegments) patternView.toggleSegmentLink();
    if (patternView.sewing || patternView.seamPick) patternView.toggleSew();
    if (patternView.zippering || patternView.zipperPick) {
      patternView.toggleZipper();
    }
    syncAtelierControls();
  };
  const syncAtelierPhase = (): void => {
    const mode = atelierDesign ? 'design' : 'simulation';
    atelierBar.dataset.mode = mode;
    patternBox.dataset.mode = mode;
    document.body.classList.toggle('atelier-simulating', !atelierDesign);
    patternView.setInteractionEnabled(atelierDesign);
    simBtn().classList.toggle('running', !atelierDesign);
    simBtn().setAttribute('aria-pressed', String(!atelierDesign));
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
      splitPx = e.clientX - atelierRailWidth();
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
  // Back to the drawing board: re-freeze flat (a rebuild re-spawns the piece at
  // its flat rest pose) so it can be edited without physics moving it.
  const enterDesign = (): void => {
    atelierDesign = true;
    syncAtelierPhase();
    build();
  };
  // "The assembly is done" — let the solver drape the piece onto the body.
  const simulate = (): void => {
    const issues =
      draft?.preset === 'lucas-hoodie'
        ? []
        : draft
          ? placementIssues(draft)
          : [];
    const blocking = issues.filter((issue) => issue.severity === 'error');
    if (placePending !== null || blocking.length) {
      const first = blocking[0];
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
      showPlacementStatus([
        'Simulation en attente',
        ...blocking.map((issue) => issue.message),
        blocking.some((issue) => issue.code === 'missing-support')
          ? 'Sélectionnez Poche / applique, puis cliquez sa position exacte sur la pièce support'
          : blocking.some((issue) => issue.code === 'missing-seam')
          ? 'Utilisez 🪡 Coudre : bord de la nouvelle pièce, puis bord correspondant du vêtement'
          : blocking.some((issue) => issue.code === 'unanchored-component')
          ? 'Reliez un bord de cet ensemble au devant, au dos, à une manche ou au col'
          : 'Choisissez d’abord la destination de la pièce',
      ]);
      return;
    }
    const warnings = issues.filter((issue) => issue.severity === 'warning');
    const staged =
      !!draft &&
      [draft.piece, ...(draft.back ? [draft.back] : []), ...(draft.pieces ?? [])].some(
        hasStagingOffset,
      );
    showPlacementStatus(
      [
        ...warnings.map((issue) => `Attention : ${issue.message}`),
        ...(staged
          ? ['Recalage automatique : les déplacements 3D de préparation sont ignorés pour garantir l’assemblage.']
          : []),
      ],
      warnings.length === 0,
    );
    deactivateEditingTools();
    atelierDesign = false;
    if (!bigPanel) setBig(true);
    syncAtelierPhase();
    build(); // canonical spawn: staging offsets are design-only
    if (draft && (draft.seams?.length ?? 0) > 0) {
      showPlacementStatus(
        [
          ...warnings.map((issue) => `Attention : ${issue.message}`),
          `Placement automatique terminé : la pose 3D a été reconstruite depuis ${draft.seams!.length} couture${draft.seams!.length > 1 ? 's' : ''}, indépendamment du plan de coupe.`,
        ],
        warnings.length === 0,
      );
    }
    wake();
  };
  const updateAtelierBar = (): void => {
    const active = sceneMode === 'atelier';
    atelierBar.classList.toggle('on', active);
    document.body.classList.toggle('atelier-active', active);
    if (active) {
      syncAtelierPhase();
      requestAnimationFrame(applySplit);
    } else {
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
      `${draft.pieces[pid - 2]!.name ?? `Pièce ${pid + 1}`} : choisissez sa destination corporelle.`,
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
    setPressed('at-move3d', move3DEnabled);
    showPlacementStatus(
      move3DEnabled
        ? [
            'Déplacement 3D actif : glissez une pièce ou l’un de ses exemplaires sans entraîner sa jumelle.',
            'Le patron 2D, les tailles communes et les coutures restent inchangés.',
            '▶ Simuler la recalera automatiquement avant de libérer la physique.',
          ]
        : ['Déplacement 3D désactivé : glissez dans la vue pour tourner la caméra.'],
      true,
    );
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
      showPlacementStatus([`${current.name ?? `Pièce ${pid + 1}`} est déjà à sa position 3D de référence.`], true);
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
        `${current.name ?? `Pièce ${pid + 1}`}${
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
      const wrapped = reboxPiece(piece, place === 'neck' ? 0.15 : 0.18);
      wrapped.wrap = place;
      wrapped.placement = { role: place, autoAlign: true };
      if (!wrapped.name) wrapped.name = placementRoleLabel(place);
      draft.pieces[idx] = wrapped;
    } else if (place === 'pocket') {
      // A pocket/appliqué is a single, tightly boxed layer. Its cutting shape
      // stays in its own column; the next click chooses the support and exact
      // centre point without baking that placement into the patron.
      const placed = reboxPiece(piece, 0.02);
      delete placed.wrap;
      placed.placement = { role: 'pocket', autoAlign: true };
      if (!placed.name) placed.name = placementRoleLabel('pocket');
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
    if (place === 'pocket') {
      patternView.startSurfacePlacement(pid);
      showPlacementStatus([
        'Poche / applique : survolez la pièce support de votre choix dans le plan.',
        'Le fantôme cyan suit la souris; cliquez au centre de la position exacte. Tous les côtés seront cousus, puis retirables séparément.',
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
      showPlacementStatus([`${placementRoleLabel(role)} : pré-placement corporel automatique prêt.`], true);
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
  // The bundled male scan measures about 70.5 cm at the waist; size 26 is the
  // closest supplied pattern. Starting on 32 made an intentionally oversized
  // waistband look as though it needed an invisible suspension.
  let pantsSize: LoosePantsSize = '26';
  let hoodieSize: LucasHoodieSize = 'S';
  let loadedPattern: 'boxy' | 'pants' | 'hoodie' = 'boxy';
  const sizeSel = document.getElementById('at-size') as HTMLSelectElement | null;
  const showSizes = (kind: 'boxy' | 'pants' | 'hoodie'): void => {
    if (!sizeSel) return;
    loadedPattern = kind;
    if (kind === 'boxy') {
      sizeSel.innerHTML = BOXY_SIZES.map((s) => `<option value="${s}">${s} · poitrine ${boxyChestCm(s)} cm</option>`).join('');
      sizeSel.value = boxySize;
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
  };
  const loadBoxyTee = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    showSizes('boxy');
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // le patron chargé remplace tout : placement en attente caduc
    pushHistory();
    teePreset = false;
    draft = boxyTee(boxySize, lastMeasure, REF);
    draftTouched = true; // un vrai draft : éditable, exportable
    atelierSleeves = false; // les manches sont DES PIÈCES du patron
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-tshirt') as HTMLElement).addEventListener('click', loadBoxyTee);

  const loadLoosePants = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    showSizes('pants');
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    teePreset = false;
    draft = loosePants(pantsSize, lastMeasure);
    draftTouched = true;
    atelierSleeves = false;
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  };
  (document.getElementById('at-pants') as HTMLElement).addEventListener('click', loadLoosePants);

  const loadLucasHoodie = (): void => {
    if (!bigPanel) setBig(true);
    patternView.resetView();
    showSizes('hoodie');
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement();
    pushHistory();
    teePreset = false;
    const fit = lucasHoodieFit(lastMeasure);
    draft =
      hoodieFitMode === 'avatar'
        ? lucasHoodieAdjusted(lastMeasure)
        : lucasHoodie(hoodieSize, lastMeasure);
    hoodieFitPristine = true;
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
      } else if (loadedPattern === 'hoodie') {
        if (sizeSel.value === 'avatar') {
          hoodieFitMode = 'avatar';
        } else {
          hoodieFitMode = 'standard';
          hoodieSize = sizeSel.value as LucasHoodieSize;
        }
        if (sceneMode === 'atelier') loadLucasHoodie();
      } else {
        boxySize = sizeSel.value as BoxySize;
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
  // − PIÈCE : supprime la pièce active (cliquer d'abord sa colonne) — Ctrl+Z annule.
  (document.getElementById('at-del') as HTMLElement).addEventListener('click', () => {
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // les indices bougent : le placement en attente saute
    patternView.deleteActiveFreePiece();
  });
  (document.getElementById('at-pen') as HTMLElement).addEventListener('click', () => patternView.finishPen());
  (document.getElementById('at-sim') as HTMLElement).addEventListener('click', () => {
    if (atelierDesign) {
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
  let fitMap = false; // tension view: survives rebuilds so it isn't lost on a slider (M29)
  let sceneMode: SceneMode = 'drapé';
  let resolution = DEFAULT_RESOLUTION;
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
  // Freeform "atelier" pattern (draw-your-own piece). Lazily created; a peer of
  // the archetype patterns, reached only by sceneMode 'atelier'.
  let draft: DraftDoc | null = null;
  // Did the user ACTUALLY draw/import a draft? `draft` alone can't tell: build()
  // lazily fills it with defaultDraft on the first atelier visit (a render
  // fallback), so a plain atelier peek must NOT make archetype exports carry a
  // parasitic draft. Only real edits + import set this.
  let draftTouched = false;
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
    return [...new Set(requested)].filter((pieceId) => !!draftPieceAt(pieceId));
  };
  const effectivePieceGsm = (piece: DraftPiece): number =>
    piece.arealDensityGsm ??
    (piece.fabricPreset
      ? FABRIC_PHYSICS[piece.fabricPreset].arealDensity
      : fabricDynamics.arealDensity) *
      1000;
  const formatGsm = (value: number): string =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(value);
  const syncPieceFabricSelect = (): void => {
    if (!fabricSel) return;
    const activeId = patternView.activeDraftPieceId;
    const piece = draftPieceAt(activeId);
    const selected = selectedFabricPieceIds();
    selectionName.textContent =
      selected.length > 1
        ? `${selected.length} pièces sélectionnées`
        : piece?.name ?? `Pièce ${activeId + 1}`;
    fabricSel.value = piece?.fabricPreset ?? '';
    fabricSel.title = piece
      ? `${piece.name ?? `Pièce ${activeId + 1}`} · ${piece.fabricPreset ?? 'tissu global'}`
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
    const preset = isFabricPresetName(chosen) ? chosen : undefined;
    if (chosen && !preset) return;
    const selected = patternView.selectedDraftPieceIds;
    const active = patternView.activeDraftPieceId;
    const ids = selected.includes(active) ? selected : [active];
    const valid = ids.filter((pid) => !!draftPieceAt(pid));
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
        `${valid.length} pièce${valid.length > 1 ? 's' : ''} · ${chosen || 'tissu global'} appliqué.`,
        valid.some((pid) => draftPieceAt(pid)?.arealDensityGsm !== undefined)
          ? 'Le grammage personnalisé est conservé ; les autres propriétés viennent du tissu choisi.'
          : chosen
            ? `Grammage estimé : ${formatGsm(FABRIC_PHYSICS[preset!].arealDensity * 1000)} g/m². Il peut être précisé juste dessous.`
            : 'La pièce suivra désormais les réglages du panneau tissu global.',
      ],
      true,
    );
  });
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
  let bodyKind: 'femme' | 'homme' | 'scan homme' | 'scan femme' = 'scan femme';
  // DEV acceptance path only: analytic mannequins are staged in a true T-pose
  // so the canonical scan-style sleeve wrapper sees horizontal arm sections.
  let collisionAuditAnalyticTPose = false;
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
  // Both avatars in parallel — serial awaits held the first paint hostage
  // to ~4.7 MB of downloads nobody sees on the default (sculpted) scene.
  const [scanHomme, scanFemme] = await Promise.all([
    loadScanAvatar(`${import.meta.env.BASE_URL}avatars/homme-scan`),
    loadScanAvatar(`${import.meta.env.BASE_URL}avatars/femme-scan`),
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
  // Physical instances generated for each draft piece. Repeated cutting
  // pieces keep the same pid (and therefore the same editable 2D pattern), but
  // receive distinct instance numbers so either copy can be arranged alone.
  let pieceParticleRanges = new Map<number, PieceParticleRange[]>();
  const registerPieceRange = (
    pid: number,
    first: number,
    count: number,
    instance = 0,
  ): void => {
    const ranges = pieceParticleRanges.get(pid) ?? [];
    ranges.push({ first, count, instance });
    pieceParticleRanges.set(pid, ranges);
  };
  // ORGANISER DANS LA 3D (mode conception, pièces gelées) : the grabbed piece
  // follows the pointer as a rigid whole. On release only its preparation
  // offset is stored; its pattern geometry and seams are untouched.
  let pieceDrag: {
    pid: number;
    instance: number;
    ranges: PieceParticleRange[];
    depth: number; // profondeur de saisie le long du rayon (le drag reste dans ce plan)
    start: [number, number, number]; // point monde saisi
    delta: [number, number, number];
  } | null = null;

  const buildNow = async (
    target: SceneMode,
    context?: Pick<SceneBuildContext, 'checkpoint'>,
  ): Promise<void> => {
    const checkpoint = context?.checkpoint ?? (async (): Promise<void> => {});
    pieceParticleRanges = new Map();
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
    lastAvatarBounds = effScan ? avatarBounds(effScan.mesh.positions) : null;
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
            // Lucas Hoodie: the editable document contains the seven unique
            // cutting pieces, while this specialised compiler materialises
            // their true quantities (two fronts, sleeves, hood sides, pockets
            // and cuffs), unfolds the fold pieces and mounts the separable zip.
            if (doc.preset === 'lucas-hoodie' && doc.back) {
              systemLinks = [];
              const hoodie = buildLucasHoodieMesh(
                doc,
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
              if (atelierDesign) {
                for (const range of hoodie.ranges) {
                  const piece = draftPieceAt(range.pieceId);
                  if (!piece) continue;
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
              if (atelierDesign) {
                for (const range of pieceParticleRanges.get(0) ?? []) {
                  applyStagingOffset(
                    pants,
                    stagingOffsetOf(doc.piece, range.instance),
                    range.first,
                    range.count,
                  );
                }
                for (const range of pieceParticleRanges.get(1) ?? []) {
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
            const d = doc.piece;
            const { extraSeams, openCells } = compileDraft(d, resolution);
            const rN = resolution;
            const cellOpen =
              (set: Set<number>) =>
              (uu: number, vv: number): boolean =>
                set.has(Math.round(vv * (rN - 1)) * rN + Math.round(uu * (rN - 1)));
            // Independent back face (côte-à-côte), if the user drew one.
            const back = doc.back && doc.back.outline.length >= 3 ? doc.back : null;
            const bc = back ? compileDraft(back, resolution) : null;
            // Manual assembly: nothing auto-sews; the user's seams hold it.
            const manual = doc.manual === true;
            const body = generateSeamedPanels({
              resolution,
              width: d.width,
              height: d.height,
              gap: atelierDesign ? d.gap : Math.min(d.gap, bodyWrapGap),
              topY: d.topY,
              shape: 'freeform',
              mask: { outline: d.outline, darts: d.darts },
              extraSeams,
              extraOpenings: cellOpen(openCells),
              ...(back && bc
                ? {
                    maskBack: { outline: back.outline, darts: back.darts },
                    extraSeamsBack: bc.extraSeams,
                    extraOpeningsBack: cellOpen(bc.openCells),
                  }
                : {}),
              ...(manual ? { manualAssembly: true, assemblySeams: compileAssembly(doc, resolution) } : {}),
            });
            if (!atelierDesign && loadedPattern === 'boxy') {
              prepareCanonicalMirrorSeams(body);
            }
            const panelSize = resolution * resolution;
            registerPieceRange(0, 0, panelSize);
            registerPieceRange(1, panelSize, panelSize);
            if (atelierDesign) {
              applyStagingOffset(body, stagingOffsetOf(d), 0, panelSize);
              applyStagingOffset(body, stagingOffsetOf(back ?? d), panelSize, panelSize);
            }
            let garment = body;
            // FREE pieces (multi-piece editor): each user-drawn extra piece
            // (pieceId ≥ 2) becomes its OWN 2-panel mesh, combined onto the
            // garment and sewn where the user's assembly seams say
            // (compileCrossSeams). Empty ⇒ this loop is skipped and `garment`
            // stays exactly `body` — byte-identical to v97.
            const freePieces = doc.pieces ?? [];
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
              const firstPhysicalPanel = Math.floor(garment.count / panelSize);
              if (fp.wrap || fp.placement?.role === 'free') {
                rigidFixedPanels.add(firstPhysicalPanel);
                rigidFixedPanels.add(firstPhysicalPanel + 1);
              }
              // A cross-sewn edge is no longer a free rim: exclude its cells
              // from this piece's own front↔back rim stitching, so a both-faces
              // assembly seam can't transitively weld the body's open edge shut
              // THROUGH the body (see crossSewnOpenCells).
              const openAll = new Set([...fpc.openCells, ...crossSewnOpenCells(doc, pid, resolution)]);
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
                mask: { outline: fp.outline, darts: fp.darts },
                extraSeams: fpc.extraSeams,
                extraOpenings: cellOpen(openAll),
                maskBack: surfacePiece
                  ? { outline: [], darts: [] }
                  : { outline: fp.outline, darts: fp.darts },
                extraSeamsBack: surfacePiece ? [] : fpc.extraSeams,
                extraOpeningsBack: surfacePiece ? undefined : cellOpen(openAll),
                // A wrap piece is a TUBE: its side seams must fold freely
                // around the arm — the flatten rings would pin it shut.
                flattenSeams: fp.wrap ? false : undefined,
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
                preWrapCollarTube(pieceMesh);
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
                ? compileSurfaceSeams(doc, resolution, offsets, pid)
                : [];
              const pins =
                fp.wrap === 'armL' || fp.wrap === 'armR'
                  ? sleeveCrossSeams(
                      garment,
                      pieceMesh,
                      doc.piece,
                      doc.back ?? doc.piece,
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
                        ...compileCrossSeams(doc, resolution, offsets, pid),
                        ...surfacePins,
                      ];
              const surfaceContacts = surfacePiece
                ? compileSurfaceContacts(doc, resolution, offsets, pid)
                : [];
              if (fp.wrap === 'neck') {
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
                  fp.placement.surface.supportPieceId === 1 ? -1 : 1,
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
              if (atelierDesign) {
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
                pins,
                // A pocket is part of the SAME garment layer as its support.
                // Its triangle-aware one-sided pass blocks penetration without
                // tethering an open edge; treating it as a second outfit layer
                // makes body collision push it farther out than its stitches.
                0,
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
        const visualMaterialId = materialLibrary.baseIds[index]!;
        const ranges = pieceParticleRanges.get(pid) ?? [];
        for (const range of ranges) {
          materialIds.fill(materialId, range.first, range.first + range.count);
          visualMaterialIds.fill(visualMaterialId, range.first, range.first + range.count);
        }
      });
    }
    const materialMesh: ClothMeshData = { ...mesh, materialIds };
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
        sdfGrid: effScan ? effScan.grid : undefined,
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
        rawBody: effScan ? effScan.mesh : undefined,
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
    phase: 'teardown' | 'build';
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
      // Stop every producer before waiting for submitted work. In particular,
      // retire() makes a delayed GLTF/pick retry fail closed before it can encode.
      system.retire();
      posCache = null;
      dragIndex = null;
      pieceDrag = null;
      await system.prepareDispose();
      renderer.dispose();
      await system.dispose();
    },
    build: async (target, context) => {
      await buildNow(target, context);
      committedSceneMode = target;
      committedSceneRevision = context.revision;
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
      if (idle) autosave?.notifyIdle();
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
      console.error(
        `[toile] transition ${context.phase} interrompue pour ${context.target} :`,
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
        error instanceof SceneTeardownTimeoutError || error instanceof SceneBuildTimeoutError;
      showFatal(
        timeout ? 'Le moteur 3D ne répond plus' : 'La scène 3D n’a pas pu être restaurée',
        `${detail}\n\nLa restauration automatique de « ${committedSceneMode} » a également échoué.`,
      );
    },
  });
  const sceneTransitionBusy = (): boolean =>
    lifecycle.isTransitioning || lifecycle.pendingTarget !== undefined;

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
    let message: string;
    if (sceneMode !== 'atelier') {
      message =
        'glisser sur le tissu : le tirer · glisser à côté : tourner · clic droit + glisser : se déplacer · molette : zoom visuel · R : réinitialiser le tissu';
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
    } else if (patternView.lengthEditing) {
      message = patternView.lengthSnapping
        ? '🧲 ajustement auto : glissez près de la bonne valeur — priorité à la couture, puis même longueur/parallèle et angle droit · hors de la zone proche, le bord reste libre · Ctrl+Z annule'
        : '↔ longueur : ligne droite = tirer une extrémité · courbe jaune = longueur totale, tirer près d’une extrémité · violet = même longueur, vert = angle droit · aucun maximum · Ctrl+Z annule';
    } else if (!atelierDesign) {
      message =
        'Essayage 3D actif : tournez la vue dans le vide, tirez le tissu pour tester son retour et utilisez ← Revenir au patron pour modifier les pièces.';
    } else if (move3DEnabled) {
      message =
        '✥ déplacement 3D : glissez l’exemplaire voulu sans entraîner sa jumelle · plan 2D : Cmd/Ctrl + clic droit = sélection multiple · patron et coutures inchangés · ▶ Simuler recale automatiquement';
    } else {
      message =
        'atelier : clic droit pièce 2D = sélectionner · Cmd/Ctrl + clic droit = groupe · tirer un coin = taille commune · Poche / applique = cliquer son support puis retirer les × voulus';
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
    if (!mirrorCtx || sceneMode !== 'atelier' || !draft || teePreset) return;
    const sewing = patternView.sewing;
    const zippering = patternView.zippering;
    const pick = patternView.zipperPick ?? patternView.seamPick;
    const surfacePieces = (draft.pieces ?? [])
      .map((piece, index) => ({ piece, pieceId: index + 2 }))
      .filter(({ piece }) => !!piece.placement?.surface);
    if (
      !sewing &&
      !zippering &&
      !pick &&
      !pieceDrag &&
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
    if (pieceDrag) {
      stroke(
        pieceDrag.pid,
        'rgba(255, 159, 107, 0.9)',
        2.5,
        pieceDrag.delta,
        pieceDrag.instance,
      );
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
    // Mode conception + outil ✥ : saisir une pièce la déplace comme un objet
    // rigide de préparation. Outil coupé = le même geste orbite la caméra.
    if (sceneMode === 'atelier' && atelierDesign && move3DEnabled) {
      const front = pickFrontmost(ray) ?? hit; // saisir CE QU'ON VOIT (les pièces à plat s'empilent en profondeur)
      const pr = pieceRangeAt(front.index);
      if (!pr) return true; // tube système ou hors patron → orbite
      pieceDrag = {
        ...pr,
        depth: front.depth,
        start: [
          ray.origin[0] + ray.dir[0] * front.depth,
          ray.origin[1] + ray.dir[1] * front.depth,
          ray.origin[2] + ray.dir[2] * front.depth,
        ],
        delta: [0, 0, 0],
      };
      activeStagingInstance = { pid: pr.pid, instance: pr.instance };
      patternView.selectPiece(pr.pid); // le plan 2D suit la sélection 3D
      return false;
    }
    if (sceneMode === 'atelier' && atelierDesign) return true;
    dragIndex = hit.index;
    dragDepth = hit.depth;
    return false; // fabric grabbed — the camera stays put
  };
  camera.attach(canvas, tryOrbit);
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
      document.body.classList.remove('atelier-advanced-open');
      advancedButton.classList.remove('active');
      advancedButton.setAttribute('aria-pressed', 'false');
      if (!bigPanel) setBig(true);
    }
    build(options.selector ?? false);
  };

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
        if (sceneMode !== 'drapé' && sceneMode !== 'couture') {
          build();
        }
      },
      onBody: (kind) => {
        collisionAuditAnalyticTPose = false;
        bodyKind = kind;
        morphs = { ...NO_MORPH }; // a new body starts at ITS natural measurements
        const naturalCm = baseCm(
          kind,
          kind.startsWith('scan') ? (scans[kind] ?? null) : null,
        );
        panel.syncMorphCm(naturalCm);
        syncAvatarStature(naturalCm.stature!);
        // Only rebuild where a body is actually on stage; drapé/couture keep
        // their cloth instead of resetting for an invisible change.
        if (sceneMode !== 'drapé' && sceneMode !== 'couture') {
          build();
        }
      },
      onResolution: (r) => {
        resolution = r;
        // Keep the persisted draft grid in sync with the sim resolution (the
        // atelier cuts on `resolution`, so a stale gridN would lie in the file).
        if (draft) draft.gridN = r as 32 | 64 | 128;
        build();
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
      onFitMap: (v) => {
        fitMap = v;
        if (sceneTransitionBusy()) {
          build();
          return;
        }
        renderer.setFitMap(v);
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
          exportDraftPatternSvg(
            draft,
            `pantalon-large-taille-${draft.presetSize ?? pantsSize}`,
            1.25,
          );
          return;
        }
        if (draft?.preset === 'lucas-hoodie') {
          exportDraftPatternSvg(
            draft,
            `lucas-hoodie-taille-${draft.presetSize ?? hoodieSize}`,
            1,
          );
          return;
        }
        const hasBack = sceneMode === 'atelier' && !!(draft?.back && draft.back.outline.length >= 3);
        if (currentMesh) exportPatternSvg(currentMesh, sceneMode, hasBack, seamAllowanceM);
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
        } else {
          draft = sanitizeDraft(raw); // validates/clamps both faces
          draftTouched = true;
          if (draft.preset === 'lucas-hoodie') {
            const sourceSize = lucasHoodieSourceSize(draft);
            hoodieFitMode = draft.presetSize?.startsWith('fit-')
              ? 'avatar'
              : 'standard';
            if (sourceSize) hoodieSize = sourceSize;
            // Imported geometry belongs to the user. Never silently replace it
            // on the next avatar change, even when it originated from "fit-".
            hoodieFitPristine = false;
            hoodieFitBodyKey = '';
            showSizes('hoodie');
          }
        }
      },
      onGltf: () => {
        if (sceneTransitionBusy()) return;
        // Snapshot the CURRENT drape: garment positions read back from the
        // GPU, mannequin in its current pose and podium angle — what you see
        // is what Blender gets.
        const mesh = currentMesh;
        const scene = currentScene;
        if (!mesh || !scene) return;
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
        void read().then((raw) => {
          if (sceneTransitionBusy() || sys !== system || !raw || raw.length < mesh.count * 4) return;
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
          downloadGlb(pieces, sceneMode);
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
    guidanceEl.textContent = `Mannequin réglé à ${avatarStatureValue.value} · corps et collisions recalculés.`;
  });
  document.getElementById('at-frame-avatar')?.addEventListener('click', () => {
    const aspect = canvas.width / Math.max(1, canvas.height);
    if (lastAvatarBounds) camera.frameBounds(lastAvatarBounds, aspect);
    else camera.frameAvatar(lastMeasure.height, aspect);
    guidanceEl.textContent = 'Vue cadrée sur le mannequin · ses dimensions physiques restent inchangées.';
  });

  // Keyboard shortcuts mirror the panel (brief §3.3 release flow). Each must
  // wake() like its panel button — otherwise pressing R or P on a settled
  // (asleep) garment does nothing visible: the reset/pin lands but the solver
  // never steps to show it.
  window.addEventListener('keydown', (e) => {
    if (sceneTransitionBusy()) return;
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
      });
    }

    // ORGANISER EN 3D : la pièce saisie suit la souris dans le plan d'écran
    // passant par le point saisi. Selon l'angle de caméra, ce plan déplace en
    // X/Y/Z. The solver buffers move live, then only the preparation offset is
    // committed; pattern dimensions and seam topology remain byte-identical.
    if (pieceDrag) {
      if (mouse.leftDown && sceneMode === 'atelier' && atelierDesign) {
        const d = pieceDrag;
        d.delta = [
          ray.origin[0] + ray.dir[0] * d.depth - d.start[0],
          ray.origin[1] + ray.dir[1] * d.depth - d.start[1],
          ray.origin[2] + ray.dir[2] * d.depth - d.start[2],
        ];
        for (const range of d.ranges) {
          system.translateRange(range.first, range.count, d.delta);
        }
      } else {
        const d = pieceDrag;
        pieceDrag = null;
        if (draft && Math.hypot(...d.delta) >= 0.005) {
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
        }
        build(); // reconstruct the preparation preview from canonical + offset
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
