import { initGpu, WebGPUNotSupportedError } from './engine/gpu/Device';
import { ParticleSystem } from './engine/solver/ParticleSystem';
import { generateClothGrid, generateSeamedPanels, combineClothMeshes, type CrossSeam, type ClothMeshData } from './engine/cloth/ClothMesh';
import { defaultDraft, tshirtDraft, compileDraft, compileAssembly, compileCrossSeams, crossSewnOpenCells, removeFreePiece, reboxPiece, pieceIdOf, nearestOutlineEdgeInfo, shiftOutlineUV, sanitizeDraft, pointInPolygon, pointInTriangle, type DraftDoc, type AssemblySeam, type DraftPiece } from './engine/pattern/Draft';
import { oversizeTee } from './engine/pattern/draftTee';
import type { SceneMode } from './app/ControlPanel';
import { ClothRenderer, DEFAULT_FABRIC } from './app/ClothRenderer';
import { OrbitCamera } from './app/OrbitCamera';
import { MouseForce } from './app/MouseForce';
import { buildSceneMesh, SCENE_VERTEX_FLOATS, type SceneMesh } from './app/SceneGeometry';
import { computeNormals, downloadGlb, type GltfPiece } from './app/gltfExport';
import { GpuProfiler } from './app/GpuProfiler';
import { ControlPanel } from './app/ControlPanel';
import { PatternView, type PatternHandleSpec } from './app/PatternView';
import { exportPatternPdf } from './app/patternPdf';
import { exportPatternSvg } from './app/patternSvg';
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
 * Sewn to the body's armhole by armholeCrossSeams + combineClothMeshes (the same
 * cross-garment sewing proven on the gathered dress). It hangs from the armhole
 * at this stage; wrapping the arm is a later step.
 */
function sleeveMesh(n: number, side: 'L' | 'R', shoulderX: number, shoulderY: number, armLen = 0.5): ClothMeshData {
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
  const theta = Math.atan2(outX * sign, armLen); // tilt from vertical toward the arm
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  for (let i = 0; i < mesh.count; i++) {
    const px = mesh.positions[i * 4]!;
    const py = mesh.positions[i * 4 + 1]! - SPAWN_TOP; // relative to the top-centre pivot
    mesh.positions[i * 4] = px * cos - py * sin + shoulderX * sign;
    mesh.positions[i * 4 + 1] = px * sin + py * cos + shoulderY;
    // z untouched: the tube straddles the arm (arm at z≈0 between the two panels).
  }
  return mesh;
}

/**
 * Cross-seams sewing a sleeve's top edge (row 0 of both panels) to the body's
 * upper-side boundary (the armhole, by convention until the 2D editor lets the
 * user pick the armhole edge). Every sleeve-top cell is sewn, gathering onto the
 * shorter armhole run (embu), on both front and back panels.
 */
function armholeCrossSeams(base: ClothMeshData, side: 'L' | 'R', n: number): CrossSeam[] {
  const ps = n * n;
  const kept = (local: number): boolean => base.invMasses[local]! > 0;
  const armBot = Math.max(2, Math.round(0.22 * n)); // shoulder band, top ~22% of rows
  const arm: number[] = []; // body front-panel local cells: one per row of the upper side
  for (let v = 1; v <= armBot; v++) {
    let best = -1;
    for (let u = 0; u < n; u++) {
      if (!kept(v * n + u)) continue;
      if (side === 'R') best = u; // rightmost kept
      else if (best < 0) best = u; // leftmost kept
    }
    if (best >= 0) arm.push(v * n + best);
  }
  const cross: CrossSeam[] = [];
  if (!arm.length) return cross;
  for (let p = 0; p < 2; p++) {
    for (let k = 0; k < n; k++) {
      const bodyLocal = arm[Math.min(arm.length - 1, Math.floor((k * arm.length) / n))]!;
      cross.push({ i: p * ps + bodyLocal, j: base.count + p * ps + k /* sleeve top row */ });
    }
  }
  return cross;
}

/**
 * Cross-seams sewing a WRAP piece (an editable sleeve tube around an arm) to
 * the body — the armholeCrossSeams mechanism (proven v96-104: panel-to-panel,
 * every sleeve column pinned, gathering onto the body's upper-side cells),
 * adapted to a freeform piece whose outline may CUT the top rows: each column
 * pins its FIRST KEPT cell instead of row 0.
 *
 * ÉTAT (chantier 3/3, expérimental) : avec le MÊME corps, les MÊMES épingles
 * et le MÊME placement, le tube sleeveMesh (shape 'rect') tient le bras
 * dedans, mais une pièce FREEFORM équivalente pend à côté du bras — une
 * différence structurelle rect↔freeform reste à isoler (premier geste : diff
 * numérique des deux buffers de mesh hors GPU, voir mémoire du projet). Le
 * chemin wrap n'est atteignable que par import ; l'UI « + Manches » (v111)
 * passe par sleeveMesh, le chemin éprouvé.
 */
function wrapCrossSeams(base: ClothMeshData, piece: ClothMeshData, side: 'L' | 'R', n: number): CrossSeam[] {
  const ps = n * n;
  const keptBase = (local: number): boolean => base.invMasses[local]! > 0;
  const armBot = Math.max(2, Math.round(0.22 * n)); // shoulder band, top ~22% of rows
  const arm: number[] = []; // body front-panel local cells: one per row of the upper side
  for (let v = 1; v <= armBot; v++) {
    let best = -1;
    for (let u = 0; u < n; u++) {
      if (!keptBase(v * n + u)) continue;
      if (side === 'R') best = u; // rightmost kept
      else if (best < 0) best = u; // leftmost kept
    }
    if (best >= 0) arm.push(v * n + best);
  }
  const cross: CrossSeam[] = [];
  if (!arm.length) return cross;
  // The piece's cap cells: per column, the FIRST kept cell from the top (the
  // outline may cut the top rows away). Kept mask is identical on both panels.
  const cap: number[] = [];
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      if (piece.invMasses[v * n + u]! > 0) {
        cap.push(v * n + u);
        break;
      }
    }
  }
  if (!cap.length) return cross;
  for (let p = 0; p < 2; p++) {
    for (let k = 0; k < cap.length; k++) {
      const bodyLocal = arm[Math.min(arm.length - 1, Math.floor((k * arm.length) / cap.length))]!;
      cross.push({ i: p * ps + bodyLocal, j: base.count + p * ps + cap[k]! });
    }
  }
  return cross;
}

/** A short standing band (collar) — its own 2-panel rect band, spawned at the
 * neck; its bottom edge is sewn to the body's neckline. Additive, same path. */
function collarMesh(n: number, neckWidth: number, neckY: number): ClothMeshData {
  return generateSeamedPanels({ resolution: n, width: neckWidth, height: 0.09, gap: 0.09, topY: neckY + 0.09, shape: 'rect' });
}

/** Cross-seams sewing the collar's BOTTOM edge (last row) to the body's neckline
 * — the top-boundary cells of the centre columns that DIP below the shoulders
 * (the scoop), so the band rings the neck hole rather than the whole shoulder. */
function collarCrossSeams(base: ClothMeshData, n: number): CrossSeam[] {
  const ps = n * n;
  const kept = (local: number): boolean => base.invMasses[local]! > 0;
  const neck: number[] = []; // body front-panel neckline cells, left→right
  for (let u = Math.floor(0.24 * n); u <= Math.ceil(0.76 * n) && u < n; u++) {
    for (let v = 0; v < n; v++) {
      if (kept(v * n + u)) {
        if (v >= 1) neck.push(v * n + u); // dipped below the shoulder row = the scoop
        break;
      }
    }
  }
  const cross: CrossSeam[] = [];
  if (!neck.length) return cross;
  for (let p = 0; p < 2; p++) {
    for (let k = 0; k < n; k++) {
      const bodyLocal = neck[Math.min(neck.length - 1, Math.floor((k * neck.length) / n))]!;
      cross.push({ i: p * ps + bodyLocal, j: base.count + p * ps + (n - 1) * n + k /* collar bottom row */ });
    }
  }
  return cross;
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
  // Dragging a handle in the 2D layout edits the measurement: update the
  // pattern state, mirror it into the panel sliders, then re-cut and re-sew.
  const patternView = new PatternView(
    document.getElementById('pattern') as HTMLCanvasElement,
    (id, value) => applyHandle(id, value),
    (piece, pieceId, seams) => {
      // A piece changed (vertex moved / added / deleted / drawn). Commit it into
      // the current draft — front (0), the côte-à-côte back (1), or a FREE piece
      // (≥ 2) — and re-cut. Editing returns to the flat design view (physics
      // paused) so the change shows without the piece draping away.
      pushHistory(); // un cran d'annulation par geste
      teePreset = false; // a manual edit ⇒ freeform mode; keep the edit (stop re-drafting)
      const gridN = resolution as 32 | 64 | 128;
      if (!draft) draft = { format: 'toile-draft', version: 1, gridN, piece: defaultDraft(gridN).piece };
      draft.gridN = gridN;
      if (pieceId >= 2) {
        (draft.pieces ??= [])[pieceId - 2] = piece;
        // ZONE DE CONFECTION LIBRE : une pièce fraîchement fermée à la plume
        // (armée par « ✎ Pièce ») demande son PLACEMENT — l'utilisateur dit
        // quel endroit du corps elle couvrira (ou la laisse libre). Une seule
        // fois : les retouches suivantes ne redemandent rien.
        if (penPlacement) {
          penPlacement = false;
          placePending = pieceId;
          showChooser(true);
        }
      } else if (pieceId === 1) draft.back = piece;
      else draft.piece = piece;
      // Adding/removing an outline point shifts the edge indices; the editor
      // re-indexes the assembly seams so they keep pointing at the same edges.
      if (seams) draft.seams = seams;
      draftTouched = true; // a real edit — this draft is now worth saving
      atelierDesign = true;
      document.getElementById('at-sim')?.classList.remove('running');
      build();
    },
    // Manual assembly: the user sewed edge A ↔ edge B (Shift+click).
    (seam: AssemblySeam) => {
      document.getElementById('at-sew')?.classList.remove('active'); // le mode guidé se referme après la couture
      pushHistory();
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
    },
    // Delete assembly seam #i (clicked its link).
    (index: number) => {
      if (!draft?.seams) return;
      pushHistory();
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
      const { pieces, seams } = removeFreePiece(draft.pieces, draft.seams ?? [], pieceId);
      draft.pieces = pieces.length ? pieces : undefined;
      draft.seams = seams;
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
  );

  // --- Atelier CAD toolbar (freeform 2D drawing) ---
  const atelierBar = document.getElementById('atelier-bar') as HTMLElement;
  const patternBox = document.getElementById('patternBox') as HTMLElement;
  let bigPanel = false;
  // Atelier "design vs simulate" (CLO-style): in DESIGN the drawn piece hangs
  // FLAT and FROZEN where it was drawn (weightless), so it can be reshaped;
  // pressing Simuler drops it onto the mannequin. Opening the 2D plan / editing
  // returns to design. Only meaningful in the 'atelier' scene.
  let atelierDesign = true;
  let atelierSleeves = location.hash.startsWith('#v96'); // multi-piece stage 1: add system sleeves to the atelier garment (debug hash: #v96 = proven rect tubes, #v96b = same via the freeform generator)
  let atelierSleeveLen = 0.5; // sleeve length (shoulder→cuff, m): 0.5 long, ~0.22 short (t-shirt)
  let atelierCollar = false; // multi-piece: add a system collar band at the neckline
  let teePreset = false; // T-shirt preset: build a real set-in-sleeve tee instead of the draft
  // ZONE DE CONFECTION LIBRE : « ✎ Pièce » arme la plume ; à la fermeture du
  // tracé, le choix de placement (#place-chooser) s'ouvre pour CETTE pièce.
  let penPlacement = false; // la prochaine pièce fermée demandera son placement
  let placePending: number | null = null; // pieceId en attente de placement
  const placeChooser = document.getElementById('place-chooser') as HTMLElement;
  const showChooser = (on: boolean): void => {
    placeChooser.hidden = !on;
  };
  const resetPlacement = (): void => {
    penPlacement = false;
    placePending = null;
    showChooser(false);
  };
  // ANNULER (Ctrl/Cmd+Z) : historique par instantanés du patron — un cran par
  // geste (déplacement de point, couture, suppression de pièce, chargement).
  const draftHistory: { draft: DraftDoc | null; touched: boolean }[] = [];
  const pushHistory = (): void => {
    draftHistory.push({ draft: draft ? structuredClone(draft) : null, touched: draftTouched });
    if (draftHistory.length > 40) draftHistory.shift();
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
    build();
  };
  window.addEventListener('keydown', (e) => {
    if (sceneMode !== 'atelier') return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoDraft();
    }
  });
  const simBtn = (): HTMLElement => document.getElementById('at-sim') as HTMLElement;
  const setBig = (on: boolean): void => {
    bigPanel = on;
    patternBox.classList.toggle('big', on);
    // Fit the big panel to the window (leave room for the toolbar/label/padding).
    const w = on ? Math.min(760, Math.round(window.innerWidth * 0.7)) : 250;
    const h = on ? Math.min(720, window.innerHeight - 96) : 290;
    patternView.resize(w, h);
  };
  // Back to the drawing board: re-freeze flat (a rebuild re-spawns the piece at
  // its flat rest pose) so it can be edited without physics moving it.
  const enterDesign = (): void => {
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
  };
  // "The assembly is done" — let the solver drape the piece onto the body.
  const simulate = (): void => {
    atelierDesign = false;
    setBig(false); // reveal the 3D drape
    simBtn().classList.add('running');
    wake();
  };
  const updateAtelierBar = (): void => {
    atelierBar.classList.toggle('on', sceneMode === 'atelier');
    if (sceneMode !== 'atelier' && bigPanel) setBig(false);
  };
  (document.getElementById('at-big') as HTMLElement).addEventListener('click', () => {
    const on = !bigPanel;
    setBig(on);
    if (on) enterDesign(); // opening the 2D plan returns to the flat design view
  });
  // ✎ PIÈCE — la zone de confection LIBRE : la plume s'ouvre dans une NOUVELLE
  // colonne, avec la silhouette de l'avatar en fond (le gabarit grandeur
  // nature). L'utilisateur trace sa pièce dessus, aux bonnes dimensions ; à la
  // fermeture, le choix de placement s'ouvre : quel endroit du corps la pièce
  // couvrira (devant, dos, bras, cou) — ou libre, posée là où elle est dessinée.
  (document.getElementById('at-piece') as HTMLElement).addEventListener('click', () => {
    if (!bigPanel) setBig(true);
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
  });
  // Application du PLACEMENT choisi pour la pièce en attente.
  const placePiece = (place: string): void => {
    const pid = placePending;
    resetPlacement();
    if (pid === null || !draft?.pieces) return;
    const idx = pid - 2;
    const piece = draft.pieces[idx];
    if (!piece) return;
    if (place === 'free') return; // déjà là où elle a été dessinée (devant le corps)
    pushHistory();
    if (place === 'front' || place === 'back') {
      // La pièce devient la face du torse (l'ancienne est remplacée — Ctrl+Z la rend).
      const { pieces, seams } = removeFreePiece(draft.pieces, draft.seams ?? [], pid);
      draft.pieces = pieces.length ? pieces : undefined;
      const fid = place === 'front' ? 0 : 1;
      // Les coutures de la face REMPLACÉE pointaient sur les bords d'un contour
      // qui n'existe plus : les garder produirait des fronces absurdes vers des
      // bords arbitraires. On les laisse tomber — 🪡 Coudre refait l'assemblage
      // proprement sur la nouvelle pièce.
      draft.seams = seams.filter((s) => pieceIdOf(s.a) !== fid && pieceIdOf(s.b) !== fid);
      if (place === 'front') draft.piece = piece;
      else draft.back = piece;
    } else if (place === 'armR' || place === 'armL' || place === 'neck') {
      // Bras / cou : la pièce est re-boîtée sur l'emprise de son tracé (contour
      // plein bord — la famille éprouvée pour les tubes), puis le placement
      // wrap l'enroule et l'épingle (emmanchure / encolure).
      const wrapped = reboxPiece(piece, place === 'neck' ? 0.15 : 0.18);
      wrapped.wrap = place;
      draft.pieces[idx] = wrapped;
    }
    draftTouched = true;
    atelierDesign = true;
    simBtn().classList.remove('running');
    build();
  };
  placeChooser.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => placePiece((b as HTMLElement).dataset.place ?? 'free'));
  });
  // Préréglage 👕 : le VRAI patron 4 pièces (le patron oversize drop-shoulder
  // de référence fourni par l'utilisateur — DEVANT, DOS, 2 MANCHES), gradé sur
  // les mensurations de l'avatar. ÉDITABLE (c'est un draft) et imprimable en
  // pièces numérotées. Remplace le préréglage kimono d'un seul tenant (v108),
  // qui n'était ni un vrai patron ni éditable.
  (document.getElementById('at-tshirt') as HTMLElement).addEventListener('click', () => {
    if (!bigPanel) setBig(true);
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // le patron chargé remplace tout : placement en attente caduc
    pushHistory();
    teePreset = false;
    draft = oversizeTee(lastMeasure, REF);
    draftTouched = true; // un vrai draft : éditable, exportable
    atelierSleeves = false; // les manches sont DES PIÈCES du patron
    atelierCollar = false;
    document.getElementById('at-sleeves')?.classList.remove('active');
    build();
  });
  // (✎ Devant / ✎ Dos / ✎ Manche retirés en v124 : la confection est LIBRE —
  // une seule plume « ✎ Pièce », le placement se choisit à la fermeture.)
  // « + Pièce / − Pièce / + Col » : boutons retirés (v109) — le moteur ne cousait
  // une pièce rapportée que sur la face avant (pièces ouvertes). Le machinery
  // (startPen(pid), deleteActiveFreePiece, atelierCollar dans build()) reste en
  // place pour la fin du chantier « pièces qui s'enroulent ».
  // « + Manches » (v111) : REVENU sur le chemin éprouvé v96-104 — des tubes
  // sleeveMesh autour des bras, épinglés au corps par armholeCrossSeams (les
  // deux panneaux du tube sur la même ligne du corps : la pince qui verrouille).
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
    build();
  });
  // 🪡 COUDRE guidé : bascule le mode « deux clics = une couture ». Les deux
  // clics marchent en 2D (le pied du plan guide) ET en 3D (près des bords,
  // directement sur les pièces autour de l'avatar) — le grand plan ne s'ouvre
  // plus d'office pour laisser la 3D visible. Maj+clic reste le raccourci 2D.
  (document.getElementById('at-sew') as HTMLElement).addEventListener('click', (e) => {
    const on = patternView.toggleSew();
    (e.currentTarget as HTMLElement).classList.toggle('active', on);
  });
  // − PIÈCE : supprime la pièce active (cliquer d'abord sa colonne) — Ctrl+Z annule.
  (document.getElementById('at-del') as HTMLElement).addEventListener('click', () => {
    atelierDesign = true;
    simBtn().classList.remove('running');
    resetPlacement(); // les indices bougent : le placement en attente saute
    patternView.deleteActiveFreePiece();
  });
  (document.getElementById('at-pen') as HTMLElement).addEventListener('click', () => patternView.finishPen());
  (document.getElementById('at-sim') as HTMLElement).addEventListener('click', () => simulate());
  const profiler = new GpuProfiler(device);

  // Fabric params kept across rebuilds (a resolution change recreates the sim).
  let compliance = { stretch: 1e-7, stretchWarp: 1e-7, shear: 1e-5, bend: 2e-4 };
  let friction = 0.5;
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
  const skirtLinear = (flare: number): number[] =>
    Array.from({ length: 4 }, (_, k) => 0.22 + (flare - 0.22) * (k / 3));
  let skirtPattern = { length: 0.6, flare: 0.46, profile: skirtLinear(0.46) };
  let bodyKind: 'femme' | 'homme' | 'scan homme' | 'scan femme' = 'scan femme';
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
    const key = `${kind}|${morphKey()}`;
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

  let currentMesh: ReturnType<typeof generateClothGrid> | null = null;
  let currentScene: SceneMesh | null = null;
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
  // PATRONNER DANS LA 3D (mode conception, pièces gelées à plat) : la pièce
  // saisie sur l'avatar se déplace en direct (translation GPU de sa plage de
  // particules) ; au relâchement, le déplacement se grave dans le patron.
  let pieceDrag: {
    pid: number;
    first: number; // première particule de la pièce dans le mesh combiné
    count: number;
    depth: number; // profondeur de saisie le long du rayon (le drag reste dans ce plan)
    start: [number, number, number]; // point monde saisi
    delta: [number, number, number];
  } | null = null;

  const build = (): void => {
    if (buildSuspended) return; // an import is batching; the final build wins (M26)
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
      sceneMode === 'tenue' ||
      sceneMode === 'pantalon' ||
      sceneMode === 'atelier';
    const scanAvatar = bodyKind.startsWith('scan') ? scans[bodyKind] : null;
    const useScan = bodyScene && scanAvatar !== null;
    const basePrims =
      !bodyScene || useScan
        ? null
        : // Sleeveless dresses have no armholes: on an ARMS body the arms end
          // up trapped INSIDE the garment. Dress scenes use the dress form.
          sceneMode === 'robe' || sceneMode === 'robe froncée' || sceneMode === 'tenue' || sceneMode === 'atelier'
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
    const bodyPrims =
      basePrims && marks
        ? (primsCache[
            `${bodyKind}|${basePrims === BODY_FORM_ARMS || basePrims === BODY_MALE_ARMS ? 'A' : 'F'}|${morphKey()}`
          ] ??= morphPrims(basePrims, morphs, marks))
        : basePrims;
    let effScan = useScan ? scanAvatar! : null;
    if (effScan && marks) {
      const key = `${bodyKind}|${morphKey()}`;
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
    lastMeasure = m; // les préréglages hors-build (bouton 👕) gradent sur la dernière mesure
    const tee = () =>
      generateSeamedPanels({
        resolution,
        width: 1.15 * topScale, // sleeve tip to sleeve tip
        height: 0.75,
        gap: 0.9,
        topY: 1.52 + dyShoulder,
        shape: 'tshirt', // kimono tee: body + sleeves in one piece
      });
    const robe = () =>
      generateSeamedPanels({
        resolution,
        width: 0.95 * dressScale,
        height: dressPattern.length,
        gap: 1.0,
        topY: 1.6 + dyShoulder,
        shape: 'aline', // real pattern piece: fitted, flared, scooped neckline
        shapeParams: { profile: dressPattern.profile, scoop: dressPattern.neck },
      });
    const mesh =
      sceneMode === 'atelier'
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
              return generateSeamedPanels({
                resolution,
                width: w,
                height: 0.66, // shoulder → hem (a long, oversized body)
                gap: 0.9,
                topY: 1.52 + dyShoulder,
                shape: 'tshirt',
                shapeParams: { neck: neckHalf, sleeve: sleeveEnd },
              });
            }
            // Freeform piece: the user's drawn outline + darts + hand-seams
            // compiled straight to the mask / seam machinery (the atelier editor).
            const doc = (draft ??= defaultDraft(resolution as 32 | 64 | 128));
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
              gap: d.gap,
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
            let garment = body;
            // FREE pieces (multi-piece editor): each user-drawn extra piece
            // (pieceId ≥ 2) becomes its OWN 2-panel mesh, combined onto the
            // garment and sewn where the user's assembly seams say
            // (compileCrossSeams). Empty ⇒ this loop is skipped and `garment`
            // stays exactly `body` — byte-identical to v97.
            const freePieces = doc.pieces ?? [];
            const offsets: number[] = [0, resolution * resolution]; // global base index per pieceId
            for (let k = 0; k < freePieces.length; k++) {
              const pid = 2 + k;
              const fp = freePieces[k];
              offsets[pid] = garment.count; // where this piece's cells will land in the combined mesh
              if (!fp || fp.outline.length < 3) continue;
              const fpc = compileDraft(fp, resolution);
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
                maskBack: { outline: fp.outline, darts: fp.darts },
                extraSeamsBack: fpc.extraSeams,
                extraOpeningsBack: cellOpen(openAll),
                // A wrap piece is a TUBE: its side seams must fold freely
                // around the arm — the flatten rings would pin it shut.
                flattenSeams: fp.wrap ? false : undefined,
              });
              if (fp.wrap === 'armL' || fp.wrap === 'armR') {
                // SLEEVE MODE: wrap the piece around the arm — both panels
                // straddle it in z, pivoted at the piece's own top edge and
                // tilted to the A-pose (the proven v96 tube placement) — but on
                // an EDITABLE draft piece. Its rim stitching closes it into a
                // tube; its cap run cross-sewn to the armhole (both faces,
                // v110) makes a real sleeve. The tube spawns SNUG (±fp.gap/2,
                // the arm between the panels) — v96's proven spawn; the long
                // armhole↔cap pins to the still-wide body panels are survivable
                // (v102-104 lived with the exact same distances). THE holding
                // condition (git-archaeology verdict): the body's armhole run
                // must itself be SEWN front↔back, so the pins converge the four
                // rims (body front/back + sleeve front/back) into ONE quasi-
                // rigid line that cinches the tube mouth around the arm root —
                // a mechanical lock the arm cannot slide out of. An armhole
                // run left open leaves the mouth agape and the tube slides.
                const sign = fp.wrap === 'armR' ? 1 : -1;
                const theta = Math.atan2(0.11 * (fp.height / 0.5) * sign, fp.height);
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);
                const armX = m.shoulderHalfW * sign;
                for (let q = 0; q < pieceMesh.count; q++) {
                  const px = pieceMesh.positions[q * 4]!;
                  const py = pieceMesh.positions[q * 4 + 1]! - fp.topY;
                  pieceMesh.positions[q * 4] = px * cosT - py * sinT + armX;
                  pieceMesh.positions[q * 4 + 1] = px * sinT + py * cosT + fp.topY;
                }
              } else if (fp.wrap === 'neck') {
                // NECKBAND: the tube spawns already centred on the neck axis
                // (x = 0, panels at ±fp.gap/2 straddling the neck) — no
                // transform needed; its bottom row is pinned to the neckline.
              } else {
                // Spawn it in FRONT of the body (at the body's front-panel plane),
                // clear of the avatar SDF collider — spawning inside would eject it
                // violently (as with the sleeves). Its assembly seam then pulls it
                // onto the body and it drapes.
                const spawnZ = d.gap / 2;
                for (let q = 0; q < pieceMesh.count; q++) {
                  pieceMesh.positions[q * 4 + 2] = pieceMesh.positions[q * 4 + 2]! + spawnZ;
                }
              }
              // Wrap pieces pin through the PROVEN mesh scans (wrapCrossSeams
              // for sleeves, collarCrossSeams for the neckband — its bottom row
              // rings the neckline scoop); flat pieces keep the drawn seams.
              const pins =
                fp.wrap === 'armL' || fp.wrap === 'armR'
                  ? wrapCrossSeams(garment, pieceMesh, fp.wrap === 'armR' ? 'R' : 'L', resolution)
                  : fp.wrap === 'neck'
                    ? collarCrossSeams(garment, resolution)
                    : compileCrossSeams(doc, resolution, offsets, pid);
              garment = combineClothMeshes(garment, pieceMesh, pins);
            }
            // Multi-piece (stage 1): sew a rectangular sleeve to each armhole,
            // via the SAME combineClothMeshes cross-seaming the gathered dress
            // uses. Gated on the button — without it the mesh is exactly the body.
            if (atelierSleeves) {
              const sL = sleeveMesh(resolution, 'L', m.shoulderHalfW, m.shoulderY, atelierSleeveLen);
              garment = combineClothMeshes(garment, sL, armholeCrossSeams(garment, 'L', resolution));
              const sR = sleeveMesh(resolution, 'R', m.shoulderHalfW, m.shoulderY, atelierSleeveLen);
              garment = combineClothMeshes(garment, sR, armholeCrossSeams(garment, 'R', resolution));
            }
            if (atelierCollar) {
              const col = collarMesh(resolution, 0.42, m.shoulderY);
              garment = combineClothMeshes(garment, col, collarCrossSeams(garment, resolution));
            }
            return garment;
          })()
        : sceneMode === 'couture'
        ? generateSeamedPanels({ resolution, width: 1.2, height: 1.2, gap: 1.3, topY: 1.9 })
        : sceneMode === 'robe'
          ? robe()
          : sceneMode === 'tenue'
            ? // Layered outfit: the dress is WORN OVER the tee — its particles
              // carry layer 1, so the body pushes it out one gap further and it
              // drapes on the tee instead of fighting it for the same surface.
              // Dressing order via the initial drop: the dress starts higher
              // and wider, arriving once the tee already hugs the body —
              // simultaneous falls interleave (tunneling locks wrong-side).
              combineClothMeshes(
                tee(),
                generateSeamedPanels({
                  resolution,
                  width: 0.95 * dressScale,
                  height: dressPattern.length,
                  gap: 1.2,
                  topY: 1.78 + dyShoulder,
                  shape: 'aline',
                  shapeParams: { profile: dressPattern.profile, scoop: dressPattern.neck },
                }),
                [],
                1,
              )
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
                  }),
                  [],
                  1, // la jupe se porte SUR le t-shirt (couche 1)
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
                    anchorTop: true, // ceinture : retenue à la taille (sinon glisse sur l'homme)
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
      mesh.spacingV,
      mesh.triangleIndices,
      sceneMesh,
      mesh.spacing2,
      mesh.spacingV2,
    );
    renderer.setFabric(fabricStyle); // keep the preset's look across rebuilds
    renderer.setFitMap(fitMap); // the tension view is a rebuild-surviving setting (M29)
    renderer.resize(canvas.width, canvas.height);
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
    currentMesh = mesh;
    currentScene = sceneMesh;
    // HUD count = SIMULATED fabric (cut-away particles are parked dead at
    // invMass 0), not the full 2·n² grid (audit M33).
    liveParticleCount = 0;
    for (let i = 0; i < mesh.invMasses.length; i++) if (mesh.invMasses[i]! > 0) liveParticleCount++;
    patternView.draw(mesh, patternHandles()); // refresh the 2D cutting-layout inset
    // Freeform editing: hand the atelier piece to the 2D view so its outline
    // vertices become draggable; other scenes leave draft mode.
    if (!(sceneMode === 'atelier' && patternView.drawing))
      patternView.setDraft(
        sceneMode === 'atelier' && draft ? draft.piece : null,
        sceneMode === 'atelier' && draft?.back ? draft.back : null,
        sceneMode === 'atelier' && draft?.pieces ? draft.pieces : [],
      );
    // Show the EXACT avatar silhouette (projected from the rendered scan mesh)
    // behind the 2D plan, so pieces are drawn over the real body shown in 3D.
    patternView.setBodySilhouette(
      sceneMode === 'atelier' && effScan ? avatarSilhouette(effScan.mesh.positions, effScan.mesh.indices) : null,
    );
    // Manual-assembly seams (red free edges / blue sewn links) for the 2D editor.
    patternView.setAssembly(sceneMode === 'atelier' && draft ? draft.seams ?? [] : []);
    updateAtelierBar();
    // Scene-aware hint: the atelier needs its drawing gestures spelled out.
    const hintEl = document.getElementById('hint');
    if (hintEl)
      hintEl.textContent =
        sceneMode === 'atelier'
          ? 'atelier : ✎ Pièce = tracer puis placer · 3D : glisser une pièce = la déplacer · 🪡 + 2 clics sur les bords (2D ou 3D) = coudre · 2D : points/bords = déformer/courber (Alt = pince) · Ctrl+Z · ▶ Simuler'
          : 'glisser sur le tissu : le tirer · glisser à côté : tourner · clic droit + glisser : se déplacer · molette : zoom · R : reset';
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
  build();

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

  // PATRONNER EN 3D — correspondance particule → pièce du patron. Le mesh
  // combiné empile des blocs UNIFORMES de 2·R² particules (les cellules
  // coupées restent parquées) : bloc 0 = la base (panneau 0 = DEVANT, panneau
  // 1 = DOS), puis un bloc par pièce libre. Au-delà : les tubes système
  // (Manches auto / col), qui ne sont pas des pièces du patron.
  const pieceRangeAt = (i: number): { pid: number; first: number; count: number } | null => {
    if (!draft || teePreset) return null;
    const r2 = resolution * resolution;
    const span = 2 * r2;
    const meshIdx = Math.floor(i / span);
    if (meshIdx === 0) {
      const panel = Math.floor(i / r2); // 0 = devant, 1 = dos — chaque face bouge seule
      return { pid: panel, first: panel * r2, count: r2 };
    }
    const nFree = draft.pieces?.length ?? 0;
    if (meshIdx <= nFree) return { pid: 1 + meshIdx, first: meshIdx * span, count: span };
    return null;
  };
  const draftPieceOf = (pid: number): DraftPiece | null => {
    if (!draft) return null;
    if (pid === 0) return draft.piece;
    if (pid === 1) return draft.back ?? draft.piece; // dos absent = miroir du devant
    return draft.pieces?.[pid - 2] ?? null;
  };
  // Déplacement 3D (mètres) → glissement du contour DANS sa boîte, borné [0,1]².
  // u suit +x ; v grandit vers le BAS (y = topY − v·height), d'où le signe.
  const shiftPieceInBox = (piece: DraftPiece, dx: number, dy: number): void => {
    const s = shiftOutlineUV(piece, dx / piece.width, -dy / piece.height);
    piece.outline = s.outline;
    piece.darts = s.darts;
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
  // CLO3D-style pointer model: a left press ON the fabric grabs it; a left
  // press on empty space orbits the camera. Returns true when orbit is allowed.
  const tryOrbit = (e: PointerEvent): boolean => {
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
    if (sceneMode === 'atelier' && patternView.sewing) {
      const front = pickFrontmost(ray) ?? hit; // la pièce VISIBLE, pas celle cachée derrière
      const pe = pieceEdgeAt(front.index);
      if (pe) {
        patternView.selectPiece(pe.pid);
        patternView.pickEdgeForSeam(pe.pid, pe.edge);
        return false;
      }
      return true; // armé mais loin d'un bord → orbite
    }
    // Mode conception (pièces gelées à plat) : saisir une pièce = la DÉPLACER
    // (le drag physique n'aurait aucun effet, la simulation est figée).
    if (sceneMode === 'atelier' && atelierDesign) {
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
      patternView.selectPiece(pr.pid); // le plan 2D suit la sélection 3D
      return false;
    }
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
        // The atelier opens in DESIGN mode: the piece hangs flat/frozen until
        // the user presses Simuler.
        if (m === 'atelier') atelierDesign = true;
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
        if (sceneMode !== 'drapé' && sceneMode !== 'couture') {
          build();
        }
      },
      onBody: (kind) => {
        bodyKind = kind;
        morphs = { ...NO_MORPH }; // a new body starts at ITS natural measurements
        panel.syncMorphCm(baseCm(kind, kind.startsWith('scan') ? (scans[kind] ?? null) : null));
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
        wake(); // toggling contact resolution must re-settle a sleeping scene (M36)
      },
      onWind: (v) => {
        wind = v;
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
        if (!v && animPrims && animRest && animOut) {
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
        renderer.setFitMap(v);
      },
      onPatternPdf: () => {
        // A drawn côte-à-côte back is NOT identical to the front — don't tell
        // the tailor to cut it "the same" when the user shaped it differently.
        const hasBack = sceneMode === 'atelier' && !!(draft?.back && draft.back.outline.length >= 3);
        if (currentMesh) exportPatternPdf(currentMesh, sceneMode, hasBack, seamAllowanceM);
      },
      onPatternSvg: () => {
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
        }
      },
      onGltf: () => {
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
            // Sample the pose in the same tick readPositions encodes its copy.
            cSpin = Math.cos(podiumAngle);
            sSpin = Math.sin(podiumAngle);
            bodySnap = animOut ? new Float32Array(animOut) : null;
            const p = await sys.readPositions();
            if (p) return p;
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };
        void read().then((raw) => {
          if (!raw || raw.length < mesh.count * 4) return;
          const pieces: GltfPiece[] = [];
          // Our UI colors are sRGB values; glTF baseColorFactor is linear.
          const lin = (c: [number, number, number]): [number, number, number] =>
            [c[0] ** 2.2, c[1] ** 2.2, c[2] ** 2.2];

          const clothPos = new Float32Array(mesh.count * 3);
          const uvs = new Float32Array(mesh.count * 2);
          const panelSize = mesh.resolution * mesh.resolution;
          for (let i = 0; i < mesh.count; i++) {
            clothPos[i * 3] = raw[i * 4]!;
            clothPos[i * 3 + 1] = raw[i * 4 + 1]!;
            clothPos[i * 3 + 2] = raw[i * 4 + 2]!;
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
        system.setCornerPins(held);
        wake();
      },
      onReset: () => {
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
  panel.syncMorphCm(baseCm(bodyKind, null));

  // Keyboard shortcuts mirror the panel (brief §3.3 release flow). Each must
  // wake() like its panel button — otherwise pressing R or P on a settled
  // (asleep) garment does nothing visible: the reset/pin lands but the solver
  // never steps to show it.
  window.addEventListener('keydown', (e) => {
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

    // PATRONNER EN 3D : la pièce saisie suit la souris dans son plan de saisie
    // (translation rigide, écrite directement dans les buffers GPU — la sim est
    // figée en conception). Au relâchement, le déplacement se grave dans le
    // patron (glissement du contour dans sa boîte / topY pour une pièce
    // enroulée) puis build() reconstruit à l'identique.
    if (pieceDrag) {
      if (mouse.leftDown && sceneMode === 'atelier' && atelierDesign) {
        const d = pieceDrag;
        // Plan x/y seulement (patronner de face) : l'aperçu montre exactement
        // ce qui sera gravé dans le patron au relâchement.
        d.delta = [
          ray.origin[0] + ray.dir[0] * d.depth - d.start[0],
          ray.origin[1] + ray.dir[1] * d.depth - d.start[1],
          0,
        ];
        system.translateRange(d.first, d.count, d.delta);
      } else {
        const d = pieceDrag;
        pieceDrag = null;
        const [dx, dy] = d.delta;
        if (draft && Math.hypot(dx, dy) >= 0.005) {
          pushHistory();
          const piece = draftPieceOf(d.pid);
          if (piece && d.pid >= 2 && piece.wrap) {
            // Une pièce ENROULÉE (manche, col) est tenue par son support : le
            // déplacement utile est vertical — elle glisse le long du bras/cou.
            piece.topY += dy;
          } else if (piece) {
            if (d.pid === 1 && !draft.back) {
              draft.back = structuredClone(draft.piece); // matérialiser le dos avant de le décaler seul
              shiftPieceInBox(draft.back, dx, dy);
            } else {
              shiftPieceInBox(piece, dx, dy);
            }
          }
          draftTouched = true;
          atelierDesign = true;
        }
        build(); // reconstruit (ou repose la pièce si le geste était trop petit)
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
    // Atelier design mode freezes the drawn piece flat (weightless) where it was
    // drawn, until the user presses Simuler — like arranging 2D pieces in CLO.
    const frozen = sceneMode === 'atelier' && atelierDesign;
    const sleeping = (asleep && sleepEligible) || frozen;
    if (!sleeping) system.step(dt, substeps, profiler.simSpan());
    renderer.render(camera.matrix(aspect), profiler.renderSpan());
    blit();
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
