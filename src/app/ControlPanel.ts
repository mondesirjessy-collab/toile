/**
 * ControlPanel — real-time lil-gui panel (brief §4). Exposes the knobs the brief
 * lists: mesh resolution (rebuilds), substeps, compliance stretch/shear/bend (as
 * log/exponent sliders), friction μ, corner pins + reset, and fabric presets.
 * Everything but resolution applies live via the callbacks; resolution triggers
 * a rebuild.
 */
import GUI from 'lil-gui';
import type { FabricStyle } from './ClothRenderer';
import {
  FABRIC_PRESET_NAMES,
  FABRIC_PHYSICS,
  MAX_FABRIC_GSM,
  MIN_FABRIC_GSM,
  makeFabricProfile,
  sanitizeFabricProfile,
  type FabricCompliance,
  type FabricDynamics,
  type FabricPhysics,
  type FabricPresetName,
} from '../engine/solver/FabricMaterial';
import {
  makeFabricMeasurementTemplate,
  parseFabricMeasurementText,
} from '../engine/solver/FabricMeasurement';
import {
  fabricProfileReport,
  normalizeResolution,
  normalizeSelectValue,
} from './ControlStateSync';
import { showToast } from './ToastQueue';

export type SceneMode =
  | 'drapé'
  | 'couture'
  | 'robe'
  | 'robe froncée'
  | 't-shirt'
  | 'chemise'
  | 'ensemble'
  | 'tenue'
  | 'pantalon'
  | 'atelier';

const SCENE_OPTIONS: readonly SceneMode[] = [
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

const SELECTABLE_BODY_OPTIONS = ['scan femme', 'scan homme'] as const;
export type GlobalFabricPreset = FabricPresetName | 'Mesuré';
const GLOBAL_FABRIC_OPTIONS: readonly GlobalFabricPreset[] = [
  ...FABRIC_PRESET_NAMES,
  'Mesuré',
];

/** Parametric pattern measurements (grading) for the dress. */
export interface PatternParams {
  length: number; // meters
  flare: number; // hem half-width, pattern units
  neck: number; // neckline half-width, pattern units
}

/** Public range shared by the simple atelier control and the advanced panel. */
export const AVATAR_STATURE_MIN_CM = 140;
export const AVATAR_STATURE_MAX_CM = 210;

export interface BodyMeasurementsCm {
  stature: number;
  carrure: number;
  poitrine: number;
  taille: number;
  hanches: number;
  cuisse: number;
}

export interface PanelCallbacks {
  onScene(mode: SceneMode): void;
  onResolution(resolution: number): void;
  onFabricPreset(preset: GlobalFabricPreset): void;
  onCompliance(c: FabricCompliance): void;
  onFriction(staticMu: number, dynamicMu: number): void;
  onDynamics(dynamics: FabricDynamics): void;
  onStyle(style: FabricStyle): void;
  onSelfCollision(enabled: boolean): void;
  onWind(strength: number): void;
  onPodium(rpm: number): void;
  onAnimate(on: boolean): void;
  onBody(kind: BodyKind): void;
  onMorph(cm: BodyMeasurementsCm): void;
  onPattern(p: PatternParams): void;
  onProfile(kind: 'robe' | 'chemise' | 'jupe', profile: number[]): void;
  onShirtPattern(p: { sleeve: number }): void;
  onSkirtPattern(p: { length: number; flare: number }): void;
  onPatternPdf(): void;
  onPatternSvg(): string | null;
  onSeamAllowance(cm: number): void;
  onGltf(): string | null | Promise<string | null>;
  onPins(held: boolean): void;
  onFitMap(on: boolean): void;
  onReset(): void;
  // Freeform atelier draft (dessin libre, pinces, coutures, dos) — persisted in
  // the .toile.json: the panel ASKS main for the current draft on export, and
  // HANDS it back on import. Optional so tests/other hosts can omit them.
  onGetDraft?(): unknown;
  onDraft?(raw: unknown): void;
  // Import batching (M26): suspend rebuilds while a .toile.json replays its
  // callback cascade, then rebuild exactly once. Optional so tests/other hosts
  // can omit them (import falls back to per-callback rebuilds).
  onImportBegin?(): void;
  onImportEnd?(): void;
}

export type BodyKind = 'femme' | 'homme' | 'scan homme' | 'scan femme';

export interface EngineSelectState {
  scene: SceneMode;
  body: BodyKind;
  resolution: number;
  fabricPreset: GlobalFabricPreset;
}

interface Settings {
  scene: SceneMode;
  body: BodyKind;
  stature: number;
  carrure: number;
  poitrine: number;
  taille: number;
  hanches: number;
  cuisse: number;
  resolution: number;
  substeps: number;
  selfCollision: boolean;
  wind: number;
  podium: number;
  animate: boolean;
  dressLength: number;
  dressFlare: number;
  dressNeck: number;
  sleeveLen: number;
  skirtLength: number;
  skirtFlare: number;
  stretchExp: number; // compliance = 10^exp (log slider); -8 ≈ rigid
  stretchWarpExp: number;
  shearExp: number;
  bendExp: number;
  bendWarpExp: number;
  stretchLimitPct: number;
  shearLimitPct: number;
  friction: number;
  frictionDynamic: number;
  densityGsm: number;
  thicknessMm: number;
  damping: number;
  airDrag: number;
  creaseYieldDeg: number;
  creaseMemory: number;
  creaseRecovery: number;
  pinCorners: boolean;
  fitMap: boolean;
  preset: GlobalFabricPreset;
  fabricReport: string;
  motif: string;
  motifCm: number;
  motifCouleur: [number, number, number];
  seamAllowance: number;
}

// Fabric presets (brief §4: Jersey/Denim/Soie — the seed of the fabric library).
// Physics: compliance (stretch/shear/bend) + Coulomb friction. Look: face/back
// colors + shading response, so switching presets is instantly recognizable.
interface FabricPreset extends FabricPhysics {
  style: FabricStyle;
}

// Anisotropic fabric library: real cloth resists differently along the weft
// (horizontal), the warp/grain (vertical, always the stiffest in a woven) and
// the bias (diagonal — where wovens give, and why bias-cut dresses flow).
const PRESETS: Record<string, FabricPreset> = {
  // Knit: very stretchy across (courses), less along the wales; floppy.
  Jersey: {
    ...FABRIC_PHYSICS.Jersey!,
    style: { face: [0.87, 0.82, 0.72], back: [0.66, 0.55, 0.47], exponent: 2.0, ambient: 0.22 },
  },
  // Rib knit: the stretchiest thing on the rail, hugs everything.
  Maille: {
    ...FABRIC_PHYSICS.Maille!,
    style: { face: [0.72, 0.45, 0.42], back: [0.55, 0.33, 0.31], exponent: 1.8, ambient: 0.24 },
  },
  // Crisp shirting cotton: barely stretches, crisp folds.
  Popeline: {
    ...FABRIC_PHYSICS.Popeline!,
    style: { face: [0.93, 0.93, 0.9], back: [0.82, 0.82, 0.78], exponent: 2.4, ambient: 0.2 },
  },
  // Stiff heavy twill: inextensible, holds big folds, grippy.
  Denim: {
    ...FABRIC_PHYSICS.Denim!,
    style: { face: [0.23, 0.29, 0.45], back: [0.52, 0.58, 0.7], exponent: 1.4, ambient: 0.3 },
  },
  // Linen: dry hand, holds creases, matte texture.
  Lin: {
    ...FABRIC_PHYSICS.Lin!,
    style: { face: [0.85, 0.8, 0.68], back: [0.74, 0.69, 0.57], exponent: 1.6, ambient: 0.26 },
  },
  // Wool flannel: soft, heavy drape, warm grey.
  Laine: {
    ...FABRIC_PHYSICS.Laine!,
    style: { face: [0.52, 0.5, 0.52], back: [0.4, 0.38, 0.4], exponent: 1.5, ambient: 0.28 },
  },
  // Silk satin: inextensible threads but a LOOSE bias — this is where the
  // slink comes from — extremely floppy, slippery, sheeny.
  Soie: {
    ...FABRIC_PHYSICS.Soie!,
    style: { face: [0.93, 0.87, 0.78], back: [0.8, 0.68, 0.58], exponent: 3.5, ambient: 0.12 },
  },
};

export class ControlPanel {
  private readonly gui: GUI;
  private readonly cb: PanelCallbacks;
  private readonly settings: Settings;
  private readonly controllers: { updateDisplay(): void }[] = [];
  private readonly selectControllers: Partial<
    Record<
      'scene' | 'body' | 'resolution' | 'preset',
      { updateDisplay(): void; show(show?: boolean): unknown }
    >
  > = {};
  private readonly nonAtelierControls: Array<{
    show(show?: boolean): unknown;
  }> = [];
  private morphControllers: Record<string, { updateDisplay(): void }> = {};
  private fabricProfileName = 'Tissu mesuré';
  private fabricProfileSource: string | undefined;
  private fabricDiagnosticTitle = 'Profil tissu';
  private fabricDiagnosticLines: string[] = [];
  private fabricBaseline: FabricPhysics = { ...FABRIC_PHYSICS.Jersey! };
  private fabricBaselineName = 'Jersey';
  private fabricCalibratedReport = 'preset Jersey · calibration TOILE';

  constructor(cb: PanelCallbacks, initial: { resolution: number; substeps: number }) {
    this.cb = cb;
    this.settings = {
      scene: 'drapé' as SceneMode,
      body: 'scan femme' as BodyKind,
      stature: 175,
      carrure: 52,
      poitrine: 79,
      taille: 76,
      hanches: 106,
      cuisse: 55,
      resolution: initial.resolution,
      substeps: initial.substeps,
      selfCollision: true,
      wind: 0,
      podium: 0,
      animate: false,
      dressLength: 1.3,
      dressFlare: 0.5,
      dressNeck: 0.1,
      sleeveLen: 0.47,
      skirtLength: 0.6,
      skirtFlare: 0.46,
      stretchExp: -8,
      stretchWarpExp: -8,
      shearExp: -8,
      bendExp: Math.log10(2e-6),
      bendWarpExp: Math.log10(2e-6),
      stretchLimitPct: 20,
      shearLimitPct: 30,
      friction: 0.5,
      frictionDynamic: 0.35,
      densityGsm: 200,
      thicknessMm: 5,
      damping: 0.5,
      airDrag: 1,
      creaseYieldDeg: 45,
      creaseMemory: 0.2,
      creaseRecovery: 0.3,
      pinCorners: false,
      fitMap: false,
      preset: 'Jersey',
      fabricReport: 'preset Jersey · calibration TOILE',
      motif: 'uni',
      motifCm: 5,
      motifCouleur: [1, 1, 1] as [number, number, number],
      seamAllowance: 1.0, // seam allowance printed on the pattern, cm
    };

    this.gui = new GUI({ title: 'TOILE — solveur' });
    // Accès de test en dev : piloter les contrôleurs sans dépendre de clics pixel.
    // __toileImport rejoue un .toile.json sans passer par le dialogue de fichier.
    if (import.meta.env.DEV) {
      const w = window as unknown as {
        __toileGui?: GUI;
        __toileImport?: (doc: unknown) => void;
        __toileFabricImport?: (doc: unknown) => boolean;
        __toileFabricMeasurementImport?: (text: string, filename?: string) => boolean;
      };
      w.__toileGui = this.gui;
      w.__toileImport = (doc: unknown) => this.applyGarment(doc);
      w.__toileFabricImport = (doc: unknown) => this.applyFabricProfile(doc);
      w.__toileFabricMeasurementImport = (text: string, filename?: string) =>
        this.applyFabricMeasurement(text, filename ?? 'mesure-labo.json');
    }

    this.selectControllers.scene = this.gui
      .add(this.settings, 'scene', [...SCENE_OPTIONS])
      .name('scène')
      .onChange((m: SceneMode) => {
        this.syncContextControls(m);
        this.cb.onScene(m);
      });
    this.controllers.push(this.selectControllers.scene);
    // Le sélecteur de scène reste visible DANS l'atelier : l'atelier étant le
    // visage du logiciel, c'est par Réglages qu'on rejoint les scènes moteur
    // (drapé, couture, robe…). Il n'est donc PAS dans nonAtelierControls — seuls
    // les contrôles procéduraux propres aux scènes de démo y restent masqués.
    // (Le wedge historique de bascule depuis l'atelier — TOILE-22 — est corrigé,
    // donc ré-exposer ce sélecteur est sûr.)
    this.selectControllers.body = this.gui
      .add(this.settings, 'body', [...SELECTABLE_BODY_OPTIONS])
      .name('mannequin')
      .onChange((k: BodyKind) => this.cb.onBody(k));
    this.controllers.push(this.selectControllers.body);
    // Prêt-à-porter measurements, in centimeters. The sliders open on the
    // selected mannequin's OWN measured values (syncMorphCm).
    const morphFolder = this.gui.addFolder('mannequin · mensurations (cm)');
    const pushMorph = (): void => this.emitMorph();
    this.morphControllers = {
      stature: morphFolder
        .add(this.settings, 'stature', AVATAR_STATURE_MIN_CM, AVATAR_STATURE_MAX_CM, 0.5)
        .name('taille globale')
        .onFinishChange(pushMorph),
      carrure: morphFolder.add(this.settings, 'carrure', 34, 60, 0.5).name('carrure (épaules)').onFinishChange(pushMorph),
      poitrine: morphFolder.add(this.settings, 'poitrine', 65, 130, 0.5).name('tour de poitrine').onFinishChange(pushMorph),
      taille: morphFolder.add(this.settings, 'taille', 55, 125, 0.5).name('tour de taille').onFinishChange(pushMorph),
      hanches: morphFolder.add(this.settings, 'hanches', 75, 140, 0.5).name('tour de hanches').onFinishChange(pushMorph),
      cuisse: morphFolder.add(this.settings, 'cuisse', 40, 78, 0.5).name('tour de cuisse').onFinishChange(pushMorph),
    };
    this.controllers.push(...Object.values(this.morphControllers));
    morphFolder.close();

    this.selectControllers.resolution = this.gui
      .add(this.settings, 'resolution', [32, 64, 128])
      .name('résolution')
      .onChange((v: number) => this.cb.onResolution(v));
    this.controllers.push(this.selectControllers.resolution);
    this.controllers.push(
      this.gui.add(this.settings, 'substeps', 5, 40, 1).name('substeps'),
    );
    this.controllers.push(
      this.gui
        .add(this.settings, 'selfCollision')
        .name('auto-collision')
        .onChange((v: boolean) => this.cb.onSelfCollision(v)),
    );
    this.controllers.push(
      this.gui
        .add(this.settings, 'wind', 0, 12, 0.1)
        .name('vent 🌬')
        .onChange((v: number) => this.cb.onWind(v)),
    );
    this.controllers.push(
      this.gui
        .add(this.settings, 'podium', 0, 6, 0.1)
        .name('podium (tr/min)')
        .onChange((v: number) => this.cb.onPodium(v)),
    );
    this.controllers.push(
      this.gui
        .add(this.settings, 'animate')
        .name('animation bras')
        .onChange((v: boolean) => this.cb.onAnimate(v)),
    );

    const fabric = this.gui.addFolder('tissu');
    const pushCompliance = (): void => {
      this.refreshFabricReport();
      this.cb.onCompliance({
        stretch: 10 ** this.settings.stretchExp,
        stretchWarp: 10 ** this.settings.stretchWarpExp,
        shear: 10 ** this.settings.shearExp,
        bend: 10 ** this.settings.bendExp,
        bendWarp: 10 ** this.settings.bendWarpExp,
        stretchLimit: this.settings.stretchLimitPct / 100,
        shearLimit: this.settings.shearLimitPct / 100,
      });
    };
    const pushFriction = (): void => {
      const s = this.settings;
      if (s.frictionDynamic > s.friction) {
        s.frictionDynamic = s.friction;
        for (const c of this.controllers) c.updateDisplay();
      }
      this.refreshFabricReport();
      this.cb.onFriction(s.friction, s.frictionDynamic);
    };
    const pushDynamics = (): void => {
      this.refreshFabricReport();
      this.cb.onDynamics({
        arealDensity: this.settings.densityGsm / 1000,
        collisionThickness: this.settings.thicknessMm / 1000,
        damping: this.settings.damping,
        airDrag: this.settings.airDrag,
        frictionStatic: this.settings.friction,
        frictionDynamic: this.settings.frictionDynamic,
        creaseYieldDeg: this.settings.creaseYieldDeg,
        creaseMemory: this.settings.creaseMemory,
        creaseRecovery: this.settings.creaseRecovery,
      });
    };
    this.controllers.push(
      fabric.add(this.settings, 'stretchExp', -9, -3, 0.1).name('étirement trame (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'stretchWarpExp', -9, -3, 0.1).name('étirement chaîne (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'shearExp', -9, -3, 0.1).name('biais / cisaillement (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'bendExp', -9, -3, 0.1).name('flexion trame (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'bendWarpExp', -9, -3, 0.1).name('flexion chaîne (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'stretchLimitPct', 1, 70, 1).name('verrouillage tension (%)').onChange(pushCompliance),
      fabric.add(this.settings, 'shearLimitPct', 3, 70, 1).name('verrouillage biais (%)').onChange(pushCompliance),
      fabric.add(this.settings, 'densityGsm', MIN_FABRIC_GSM, MAX_FABRIC_GSM, 5).name('grammage (g/m²)').onChange(pushDynamics),
      fabric.add(this.settings, 'thicknessMm', 2, 10, 0.1).name('épaisseur effective (mm)').onChange(pushDynamics),
      fabric.add(this.settings, 'damping', 0.1, 2, 0.05).name('amortissement').onChange(pushDynamics),
      fabric.add(this.settings, 'airDrag', 0.2, 2, 0.05).name('prise au vent').onChange(pushDynamics),
      fabric.add(this.settings, 'creaseYieldDeg', 5, 85, 1).name('seuil de pli (°)').onChange(pushDynamics),
      fabric.add(this.settings, 'creaseMemory', 0, 2, 0.05).name('mémoire du pli').onChange(pushDynamics),
      fabric.add(this.settings, 'creaseRecovery', 0, 2, 0.05).name('récupération du pli').onChange(pushDynamics),
      fabric.add(this.settings, 'friction', 0, 1, 0.01).name('friction statique μs').onChange(pushFriction),
      fabric.add(this.settings, 'frictionDynamic', 0, 1, 0.01).name('friction dynamique μd').onChange(pushFriction),
    );
    this.selectControllers.preset = fabric
      .add(this.settings, 'preset', [...GLOBAL_FABRIC_OPTIONS])
      .name('preset')
      .onChange((name: GlobalFabricPreset) => this.applyPreset(name));
    this.controllers.push(this.selectControllers.preset);
    this.controllers.push(
      fabric
        .add(this.settings, 'fitMap')
        .name('carte de tension')
        .onChange((v: boolean) => this.cb.onFitMap(v)),
    );
    const reapplyPresetController = fabric
      .add({ reapply: () => this.reapplyFabricBase() }, 'reapply')
      .name('↻ réappliquer le preset');
    reapplyPresetController.domElement.id = 'toile-reapply-fabric-preset';
    this.controllers.push(
      fabric.add(this.settings, 'fabricReport').name('qualité du profil').disable(),
    );
    fabric.add({ exporter: () => this.exportFabricProfile() }, 'exporter').name('exporter le profil tissu');
    fabric.add({ importer: () => this.importFabricProfile() }, 'importer').name('importer KES / FAST / profil');
    fabric.add({ modele: () => this.exportFabricMeasurementTemplate() }, 'modele').name('modèle de relevé labo');
    fabric.add({ diagnostic: () => this.showFabricDiagnostic() }, 'diagnostic').name('voir le diagnostic');

    // Prints: procedural, crisp at any zoom, scaled in real centimeters.
    const MOTIFS = ['uni', 'rayures', 'vichy', 'pois'];
    const motifFolder = this.gui.addFolder('motif');
    const pushMotif = (): void => this.pushStyle();
    this.controllers.push(
      motifFolder.add(this.settings, 'motif', MOTIFS).name('imprimé').onChange(pushMotif),
      motifFolder.add(this.settings, 'motifCm', 1, 30, 0.5).name('échelle (cm)').onChange(pushMotif),
      motifFolder.addColor(this.settings, 'motifCouleur').name('couleur').onChange(pushMotif),
    );
    motifFolder.close();

    // Parametric pattern (grading) — applies to the dress scene.
    const pattern = this.gui.addFolder('patron · robe');
    const pushPattern = (): void =>
      this.cb.onPattern({
        length: this.settings.dressLength,
        flare: this.settings.dressFlare,
        neck: this.settings.dressNeck,
      });
    // onFinishChange: re-cutting the pattern on every drag tick would restart
    // the sim dozens of times mid-drag — apply once, when the slider settles.
    this.controllers.push(
      pattern.add(this.settings, 'dressLength', 0.9, 1.55, 0.01).name('longueur (m)').onFinishChange(pushPattern),
      pattern.add(this.settings, 'dressFlare', 0.25, 0.5, 0.01).name('évasement').onFinishChange(pushPattern),
      pattern.add(this.settings, 'dressNeck', 0.06, 0.16, 0.005).name('encolure').onFinishChange(pushPattern),
    );

    const shirtPattern = this.gui.addFolder('patron · chemise');
    this.controllers.push(
      shirtPattern
        .add(this.settings, 'sleeveLen', 0.33, 0.47, 0.005)
        .name('longueur manches')
        .onFinishChange(() => this.cb.onShirtPattern({ sleeve: this.settings.sleeveLen })),
    );

    const skirtPattern = this.gui.addFolder('patron · jupe');
    const pushSkirt = (): void =>
      this.cb.onSkirtPattern({ length: this.settings.skirtLength, flare: this.settings.skirtFlare });
    this.controllers.push(
      skirtPattern.add(this.settings, 'skirtLength', 0.4, 0.75, 0.01).name('longueur (m)').onFinishChange(pushSkirt),
      skirtPattern.add(this.settings, 'skirtFlare', 0.3, 0.46, 0.005).name('évasement').onFinishChange(pushSkirt),
    );
    shirtPattern.close();
    skirtPattern.close();
    this.nonAtelierControls.push(pattern, shirtPattern, skirtPattern);

    // Open garment format: save/load the whole garment as JSON.
    const file = this.gui.addFolder('fichier');
    file.add({ pdf: () => this.cb.onPatternPdf() }, 'pdf').name('imprimer le patron (PDF 1:1)');
    file.add({ svg: () => this.exportPatternSvg() }, 'svg').name('exporter le patron (SVG)');
    this.controllers.push(
      file
        .add(this.settings, 'seamAllowance', 0, 4, 0.5)
        .name('marge de couture (cm)')
        .onChange((v: number) => this.cb.onSeamAllowance(v)),
    );
    file.add({ glb: () => void this.exportGltf() }, 'glb').name('exporter en 3D (.glb)');
    file.add({ exporter: () => this.exportGarment() }, 'exporter').name('exporter le vêtement (.json)');
    file.add({ importer: () => this.importGarment() }, 'importer').name('importer un vêtement');

    const pins = this.gui.addFolder('épingles');
    this.controllers.push(
      pins.add(this.settings, 'pinCorners').name('coins épinglés').onChange((v: boolean) => this.cb.onPins(v)),
    );
    pins.add({ reset: () => this.cb.onReset() }, 'reset').name('reset (relâcher)');
    // The atelier already exposes contextual reset and direct pin gestures.
    // Keep this procedural/demo folder out of the reduced creation workspace.
    this.nonAtelierControls.push(pins);

    // Apply the initial preset so the sim starts in a defined fabric state.
    this.applyPreset(this.settings.preset);
  }

  /** Current substep count, read by the frame loop. */
  get substeps(): number {
    return this.settings.substeps;
  }

  get globalFabricPreset(): GlobalFabricPreset {
    return this.settings.preset;
  }

  /** Keep the pin checkbox in sync when pins are toggled elsewhere (P key / reset). */
  syncPins(held: boolean): void {
    this.settings.pinCorners = held;
    for (const c of this.controllers) c.updateDisplay();
  }

  /** Keep the arm-animation checkbox in sync with programmatic audit setup. */
  syncAnimate(on: boolean): void {
    this.settings.animate = on;
    for (const c of this.controllers) c.updateDisplay();
  }

  /** Keep the scene select in sync when the scene changes elsewhere. */
  syncScene(mode: SceneMode): void {
    this.settings.scene = normalizeSelectValue(mode, SCENE_OPTIONS, this.settings.scene);
    this.selectControllers.scene?.updateDisplay();
    this.syncContextControls(this.settings.scene);
  }

  /** Hide controls that can only mutate non-atelier procedural scenes. */
  private syncContextControls(scene: SceneMode): void {
    const showProceduralScenes = scene !== 'atelier';
    for (const control of this.nonAtelierControls) {
      control.show(showProceduralScenes);
    }
  }

  /**
   * Re-assert every option control after a scene transaction. lil-gui keeps its
   * own native select nodes, so rebuilding the simulation must explicitly copy
   * the committed engine state back into those stable controllers.
   */
  syncEngineSelects(state: EngineSelectState): void {
    this.settings.scene = normalizeSelectValue(
      state.scene,
      SCENE_OPTIONS,
      this.settings.scene,
    );
    const visibleBody: (typeof SELECTABLE_BODY_OPTIONS)[number] =
      state.body.includes('homme') ? 'scan homme' : 'scan femme';
    this.settings.body = normalizeSelectValue(
      visibleBody,
      SELECTABLE_BODY_OPTIONS,
      'scan femme',
    );
    this.settings.resolution = normalizeResolution(
      state.resolution,
      normalizeResolution(this.settings.resolution, 64),
    );
    this.settings.preset = normalizeSelectValue(
      state.fabricPreset,
      GLOBAL_FABRIC_OPTIONS,
      this.settings.preset,
    );
    this.syncContextControls(this.settings.scene);
    for (const controller of Object.values(this.selectControllers)) {
      controller?.updateDisplay();
    }
  }

  private morphCm(): BodyMeasurementsCm {
    return {
      stature: this.settings.stature,
      carrure: this.settings.carrure,
      poitrine: this.settings.poitrine,
      taille: this.settings.taille,
      hanches: this.settings.hanches,
      cuisse: this.settings.cuisse,
    };
  }

  private emitMorph(): void {
    this.cb.onMorph(this.morphCm());
  }

  /**
   * Change the physical mannequin scale from the simple atelier control.
   * The advanced field and exported .toile state share this exact setting.
   */
  setStatureCm(cm: number): void {
    if (!Number.isFinite(cm)) return;
    const clamped = Math.min(AVATAR_STATURE_MAX_CM, Math.max(AVATAR_STATURE_MIN_CM, cm));
    this.settings.stature = Math.round(clamped * 2) / 2;
    this.morphControllers.stature?.updateDisplay();
    this.emitMorph();
  }

  /** Open the measurement sliders on the selected body's own values (cm). */
  syncMorphCm(cm: Partial<BodyMeasurementsCm>): void {
    const s = this.settings as unknown as Record<string, number>;
    const keys: Array<keyof BodyMeasurementsCm> = [
      'stature',
      'carrure',
      'poitrine',
      'taille',
      'hanches',
      'cuisse',
    ];
    for (const k of keys) {
      if (typeof cm[k] === 'number') s[k] = Math.round(cm[k]! * 2) / 2;
    }
    for (const c of Object.values(this.morphControllers)) c.updateDisplay();
  }

  /** Drafted silhouettes per garment (exported with the garment). */
  private profiles: { robe?: number[]; chemise?: number[]; jupe?: number[] } = {};

  setProfiles(p: { robe?: number[]; chemise?: number[]; jupe?: number[] }): void {
    if (p.robe) this.profiles.robe = p.robe.slice();
    if (p.chemise) this.profiles.chemise = p.chemise.slice();
    if (p.jupe) this.profiles.jupe = p.jupe.slice();
  }

  /** Mirror a measurement edited in the 2D layout into the pattern sliders. */
  syncPattern(
    p: Partial<Pick<Settings, 'dressLength' | 'dressFlare' | 'dressNeck' | 'sleeveLen' | 'skirtLength' | 'skirtFlare'>>,
  ): void {
    Object.assign(this.settings, p);
    for (const c of this.controllers) c.updateDisplay();
  }

  /** Snapshot the live controls in the portable material-profile units. */
  private currentFabricPhysics(): FabricPhysics {
    const s = this.settings;
    return {
      stretch: 10 ** s.stretchExp,
      stretchWarp: 10 ** s.stretchWarpExp,
      shear: 10 ** s.shearExp,
      bend: 10 ** s.bendExp,
      bendWarp: 10 ** s.bendWarpExp,
      stretchLimit: s.stretchLimitPct / 100,
      shearLimit: s.shearLimitPct / 100,
      arealDensity: s.densityGsm / 1000,
      collisionThickness: s.thicknessMm / 1000,
      damping: s.damping,
      airDrag: s.airDrag,
      frictionStatic: s.friction,
      frictionDynamic: Math.min(s.friction, s.frictionDynamic),
      creaseYieldDeg: s.creaseYieldDeg,
      creaseMemory: s.creaseMemory,
      creaseRecovery: s.creaseRecovery,
    };
  }

  private setFabricBaseline(
    name: string,
    physics: FabricPhysics,
    calibratedReport: string,
  ): void {
    this.fabricBaselineName = name;
    this.fabricBaseline = { ...physics };
    this.fabricCalibratedReport = calibratedReport;
    this.refreshFabricReport();
  }

  /** Derive the badge from the live numbers; it is never a sticky preset label. */
  private refreshFabricReport(): void {
    this.settings.fabricReport = fabricProfileReport(
      this.currentFabricPhysics(),
      this.fabricBaseline,
      this.fabricBaselineName,
      this.fabricCalibratedReport,
    );
    for (const c of this.controllers) c.updateDisplay();
  }

  private writeFabricPhysics(physics: FabricPhysics): void {
    const s = this.settings;
    s.stretchExp = Math.log10(physics.stretch);
    s.stretchWarpExp = Math.log10(physics.stretchWarp);
    s.shearExp = Math.log10(physics.shear);
    s.bendExp = Math.log10(physics.bend);
    s.bendWarpExp = Math.log10(physics.bendWarp);
    s.stretchLimitPct = physics.stretchLimit * 100;
    s.shearLimitPct = physics.shearLimit * 100;
    s.friction = physics.frictionStatic;
    s.frictionDynamic = physics.frictionDynamic;
    s.densityGsm = physics.arealDensity * 1000;
    s.thicknessMm = physics.collisionThickness * 1000;
    s.damping = physics.damping;
    s.airDrag = physics.airDrag;
    s.creaseYieldDeg = physics.creaseYieldDeg;
    s.creaseMemory = physics.creaseMemory;
    s.creaseRecovery = physics.creaseRecovery;
  }

  private emitFabricPhysics(physics: FabricPhysics): void {
    this.cb.onCompliance(physics);
    this.cb.onFriction(physics.frictionStatic, physics.frictionDynamic);
    this.cb.onDynamics(physics);
  }

  /**
   * Reapply stays actionable when the select already displays the current
   * preset, unlike choosing the same native option a second time.
   */
  private reapplyFabricBase(): void {
    const preset = PRESETS[this.settings.preset];
    if (preset) {
      this.applyPreset(this.settings.preset);
      this.toast(`preset ${this.settings.preset} réappliqué`);
      return;
    }
    this.writeFabricPhysics(this.fabricBaseline);
    this.refreshFabricReport();
    this.emitFabricPhysics(this.fabricBaseline);
    this.toast(`profil ${this.fabricBaselineName} réappliqué`);
  }

  /** Validate and apply a calibrated .toile-fabric.json profile live. */
  private applyFabricProfile(raw: unknown): boolean {
    const doc = sanitizeFabricProfile(raw);
    if (!doc) return false;
    const p = doc.physics;
    const s = this.settings;
    s.preset = 'Mesuré';
    this.writeFabricPhysics(p);
    this.fabricProfileName = doc.name;
    this.fabricProfileSource = doc.source;
    this.setFabricBaseline(doc.name, p, 'profil solveur · validé');
    this.fabricDiagnosticTitle = doc.name;
    this.fabricDiagnosticLines = [
      `Source : ${doc.source ?? 'profil TOILE'}`,
      'Paramètres : déjà calibrés pour le solveur',
      'Validation : complète',
    ];
    this.cb.onFabricPreset('Mesuré');
    this.emitFabricPhysics(p);
    return true;
  }

  /** Convert and apply raw KES/FAST laboratory measurements. */
  private applyFabricMeasurement(text: string, filename: string): boolean {
    const result = parseFabricMeasurementText(text, filename);
    if (!result.ok) {
      this.settings.fabricReport = 'relevé refusé · incomplet';
      this.fabricDiagnosticTitle = 'Import KES / FAST impossible';
      this.fabricDiagnosticLines = [result.error];
      for (const c of this.controllers) c.updateDisplay();
      this.showFabricDiagnostic(false);
      return false;
    }
    const conversion = result.conversion;
    if (!this.applyFabricProfile(conversion.profile)) return false;
    this.settings.fabricReport =
      `${conversion.system} · confiance ${conversion.confidence} · ${conversion.estimated.length} estimés`;
    this.fabricCalibratedReport = this.settings.fabricReport;
    this.fabricDiagnosticTitle = `${conversion.profile.name} · ${conversion.system}`;
    this.fabricDiagnosticLines = [
      `Confiance : ${conversion.confidence}`,
      `Mesuré : ${conversion.measured.join(', ')}`,
      `Estimé : ${conversion.estimated.join(', ') || 'aucun'}`,
      ...conversion.warnings.map((warning) => `Attention : ${warning}`),
    ];
    for (const c of this.controllers) c.updateDisplay();
    this.showFabricDiagnostic(true);
    return true;
  }

  /** Download the current physics as a reusable, versioned fabric profile. */
  private exportFabricProfile(): void {
    const s = this.settings;
    const name = s.preset === 'Mesuré' ? this.fabricProfileName : s.preset;
    const source = s.preset === 'Mesuré' ? this.fabricProfileSource : undefined;
    const doc = makeFabricProfile(name, this.currentFabricPhysics(), source);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safeName = doc.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    a.download = `${safeName || 'tissu-mesure'}.toile-fabric.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    this.toast('profil tissu exporté');
  }

  /** Download the documented neutral JSON form a laboratory can fill. */
  private exportFabricMeasurementTemplate(): void {
    const blob = new Blob([JSON.stringify(makeFabricMeasurementTemplate(), null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'modele.toile-fabric-measurement.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    this.toast('modèle de relevé KES/FAST exporté');
  }

  /** Open a solver profile or convert a raw KES/FAST JSON/CSV report. */
  private importFabricProfile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,.tsv,.txt,.toile-fabric.json,application/json,text/csv,text/tab-separated-values';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        let ok = false;
        try {
          if (file.name.toLowerCase().endsWith('.json')) {
            ok = this.applyFabricProfile(JSON.parse(text));
          }
        } catch {
          ok = false;
        }
        if (!ok) ok = this.applyFabricMeasurement(text, file.name);
        this.toast(ok ? 'profil KES/FAST converti et appliqué' : 'relevé KES/FAST non reconnu', ok);
      });
    };
    input.click();
  }

  /** Persistent, readable distinction between measured and estimated fields. */
  private showFabricDiagnostic(ok = true): void {
    let el = document.getElementById('toile-fabric-diagnostic');
    if (!el) {
      el = document.createElement('section');
      el.id = 'toile-fabric-diagnostic';
      el.style.cssText =
        'position:fixed;left:18px;bottom:18px;z-index:21;width:min(470px,calc(100vw - 36px));' +
        'padding:14px 16px;border-radius:8px;font:12px/1.5 ui-monospace,Menlo,monospace;' +
        'color:#ede9df;background:rgba(10,11,14,0.96);border:1px solid rgba(127,178,255,.55);' +
        'box-shadow:0 12px 40px rgba(0,0,0,.35)';
      document.body.appendChild(el);
    }
    el.replaceChildren();
    el.style.borderColor = ok ? 'rgba(127,178,255,.55)' : 'rgba(255,120,120,.7)';
    const title = document.createElement('strong');
    title.textContent = this.fabricDiagnosticTitle;
    title.style.cssText = 'display:block;margin-right:28px;margin-bottom:8px;font-size:13px';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'fermer le diagnostic tissu');
    close.style.cssText =
      'position:absolute;right:10px;top:7px;border:0;background:transparent;color:#ede9df;' +
      'font:22px sans-serif;cursor:pointer';
    close.onclick = () => el!.remove();
    el.append(title, close);
    for (const line of this.fabricDiagnosticLines) {
      const p = document.createElement('div');
      p.textContent = line;
      p.style.marginTop = '4px';
      el.appendChild(p);
    }
  }

  /**
   * Snapshot the current garment in the same open format used by manual export.
   * Keeping this public gives autosave and recovery one canonical serializer.
   */
  snapshotGarment(): Record<string, unknown> {
    const s = this.settings;
    return {
      format: 'toile-garment',
      version: 1,
      scene: s.scene,
      body: s.body,
      morph: {
        stature: s.stature,
        carrure: s.carrure,
        poitrine: s.poitrine,
        taille: s.taille,
        hanches: s.hanches,
        cuisse: s.cuisse,
      },
      pattern: {
        profile: this.profiles.robe,
        profileChemise: this.profiles.chemise,
        profileJupe: this.profiles.jupe,
        length: s.dressLength,
        flare: s.dressFlare,
        neck: s.dressNeck,
        sleeve: s.sleeveLen,
        skirtLength: s.skirtLength,
        skirtFlare: s.skirtFlare,
      },
      fabric: {
        preset: s.preset,
        motif: s.motif,
        motifCm: s.motifCm,
        motifCouleur: s.motifCouleur,
        stretchExp: s.stretchExp,
        stretchWarpExp: s.stretchWarpExp,
        shearExp: s.shearExp,
        bendExp: s.bendExp,
        bendWarpExp: s.bendWarpExp,
        stretchLimitPct: s.stretchLimitPct,
        shearLimitPct: s.shearLimitPct,
        friction: s.friction,
        frictionDynamic: s.frictionDynamic,
        densityGsm: s.densityGsm,
        thicknessMm: s.thicknessMm,
        damping: s.damping,
        airDrag: s.airDrag,
        creaseYieldDeg: s.creaseYieldDeg,
        creaseMemory: s.creaseMemory,
        creaseRecovery: s.creaseRecovery,
      },
      sim: { resolution: s.resolution, substeps: s.substeps, selfCollision: s.selfCollision, wind: s.wind },
      seamAllowance: s.seamAllowance,
      // Atelier draft (freeform pattern): only present once the user has drawn
      // one — so a plain archetype file stays small and unchanged.
      ...((): object => {
        const draft = this.cb.onGetDraft?.();
        return draft ? { draft } : {};
      })(),
    };
  }

  /** Serialize the current garment to the open TOILE format and download it. */
  private exportGarment(): void {
    let anchor: HTMLAnchorElement | null = null;
    let objectUrl: string | null = null;
    try {
      const doc = this.snapshotGarment();
      const blob = new Blob([JSON.stringify(doc, null, 2)], {
        type: 'application/json',
      });
      anchor = document.createElement('a');
      objectUrl = URL.createObjectURL(blob);
      anchor.href = objectUrl;
      anchor.download = 'vetement.toile.json';
      document.body.appendChild(anchor);
      anchor.click();
      const filename = anchor.download;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      this.toast(`Vêtement exporté — ${filename}`);
    } catch {
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // The failure toast remains more useful than a second URL error.
        }
      }
      this.toast('Échec de l’export JSON.', false);
    } finally {
      anchor?.remove();
    }
  }

  /** Report the exact file selected by whichever SVG exporter the host uses. */
  private exportPatternSvg(): void {
    try {
      const filename = this.cb.onPatternSvg();
      if (filename) {
        this.toast(`Patron exporté — ${filename}`);
      } else {
        this.toast('Échec de l’export SVG.', false);
      }
    } catch {
      this.toast('Échec de l’export SVG.', false);
    }
  }

  /** Await the GPU snapshot so success means a .glb was actually downloaded. */
  private async exportGltf(): Promise<void> {
    try {
      const filename = await this.cb.onGltf();
      if (filename) {
        this.toast(`Modèle 3D exporté — ${filename}`);
      } else {
        this.toast('Échec de l’export GLB.', false);
      }
    } catch {
      this.toast('Échec de l’export GLB.', false);
    }
  }

  /** Load a garment file and apply it end-to-end (pattern, fabric, sim). */
  private importGarment(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.text().then((txt) => {
        let ok = false;
        try {
          ok = this.applyGarment(JSON.parse(txt));
        } catch {
          ok = false;
        }
        this.toast(ok ? 'vêtement importé' : 'fichier .toile.json non reconnu', ok);
      });
    };
    input.click();
  }

  /** Apply a serialized garment through the same validation path as file import. */
  applyGarment(doc: unknown): boolean {
    const d = doc as {
      format?: string;
      version?: number;
      scene?: SceneMode;
      body?: BodyKind;
      morph?: Record<string, number>;
      pattern?: Partial<PatternParams> & {
        sleeve?: number;
        skirtLength?: number;
        skirtFlare?: number;
        profile?: number[];
        profileChemise?: number[];
        profileJupe?: number[];
      };
      fabric?: {
        preset?: string;
        stretchExp?: number;
        stretchWarpExp?: number;
        shearExp?: number;
        bendExp?: number;
        bendWarpExp?: number;
        stretchLimitPct?: number;
        shearLimitPct?: number;
        friction?: number;
        frictionDynamic?: number;
        densityGsm?: number;
        thicknessMm?: number;
        damping?: number;
        airDrag?: number;
        creaseYieldDeg?: number;
        creaseMemory?: number;
        creaseRecovery?: number;
        motif?: string;
        motifCm?: number;
        motifCouleur?: [number, number, number];
      };
      sim?: { resolution?: number; substeps?: number; selfCollision?: boolean; wind?: number };
      seamAllowance?: number;
      draft?: unknown;
    };
    if (d?.format !== 'toile-garment' || (d.version !== undefined && d.version !== 1)) return false;
    const s = this.settings;
    // A .toile.json is USER INPUT: every scalar is clamped to its slider's
    // range and rejected unless finite — JSON happily parses 1e999 (Infinity)
    // and a resolution of a million is a GPU allocation, not a garment.
    const num = (v: unknown, min: number, max: number, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    if (d.sim) {
      s.resolution = [32, 64, 128].includes(d.sim.resolution as number) ? d.sim.resolution! : s.resolution;
      s.substeps = Math.round(num(d.sim.substeps, 5, 40, s.substeps));
      s.selfCollision = typeof d.sim.selfCollision === 'boolean' ? d.sim.selfCollision : s.selfCollision;
      s.wind = num(d.sim.wind, 0, 12, s.wind);
    }
    s.seamAllowance = num(d.seamAllowance, 0, 4, s.seamAllowance);
    if (d.fabric) {
      s.preset = normalizeSelectValue(
        d.fabric.preset,
        GLOBAL_FABRIC_OPTIONS,
        s.preset,
      );
      const preset = PRESETS[s.preset] ?? PRESETS.Jersey!;
      if (s.preset === 'Mesuré') {
        this.fabricProfileName = 'Tissu mesuré importé';
        this.fabricProfileSource = undefined;
      }
      if (typeof d.fabric.motif === 'string' && ['uni', 'rayures', 'vichy', 'pois'].includes(d.fabric.motif)) s.motif = d.fabric.motif;
      if (typeof d.fabric.motifCm === 'number' && d.fabric.motifCm >= 1 && d.fabric.motifCm <= 30) s.motifCm = d.fabric.motifCm;
      // Validate each element finite ∈ [0,1] (audit M30 residual): a raw array
      // like ["x", NaN, 1e99] would coerce to NaN/Infinity in the fabric
      // uniform (a garbled print tint — not a solver input, but still wrong).
      if (
        Array.isArray(d.fabric.motifCouleur) &&
        d.fabric.motifCouleur.length === 3 &&
        d.fabric.motifCouleur.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        s.motifCouleur = d.fabric.motifCouleur.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
      }
      s.stretchExp = num(d.fabric.stretchExp, -9, -3, s.stretchExp);
      s.stretchWarpExp = num(d.fabric.stretchWarpExp ?? d.fabric.stretchExp, -9, -3, s.stretchWarpExp);
      s.shearExp = num(d.fabric.shearExp, -9, -3, s.shearExp);
      s.bendExp = num(d.fabric.bendExp, -9, -3, s.bendExp);
      s.bendWarpExp = num(d.fabric.bendWarpExp ?? d.fabric.bendExp, -9, -3, Math.log10(preset.bendWarp));
      s.stretchLimitPct = num(d.fabric.stretchLimitPct, 1, 70, preset.stretchLimit * 100);
      s.shearLimitPct = num(d.fabric.shearLimitPct, 3, 70, preset.shearLimit * 100);
      s.friction = num(d.fabric.friction, 0, 1, s.friction);
      s.frictionDynamic = Math.min(
        s.friction,
        num(d.fabric.frictionDynamic, 0, 1, Math.min(preset.frictionDynamic, s.friction)),
      );
      s.densityGsm = num(
        d.fabric.densityGsm,
        MIN_FABRIC_GSM,
        MAX_FABRIC_GSM,
        preset.arealDensity * 1000,
      );
      s.thicknessMm = num(d.fabric.thicknessMm, 2, 10, preset.collisionThickness * 1000);
      s.damping = num(d.fabric.damping, 0.1, 2, preset.damping);
      s.airDrag = num(d.fabric.airDrag, 0.2, 2, preset.airDrag);
      s.creaseYieldDeg = num(d.fabric.creaseYieldDeg, 5, 85, preset.creaseYieldDeg);
      s.creaseMemory = num(d.fabric.creaseMemory, 0, 2, preset.creaseMemory);
      s.creaseRecovery = num(d.fabric.creaseRecovery, 0, 2, preset.creaseRecovery);
      const namedPreset = PRESETS[s.preset];
      if (namedPreset) {
        this.setFabricBaseline(
          s.preset,
          namedPreset,
          `preset ${s.preset} · calibration TOILE`,
        );
      } else {
        this.setFabricBaseline(
          this.fabricProfileName,
          this.currentFabricPhysics(),
          'profil importé · mesuré',
        );
      }
    }
    if (d.pattern) {
      s.dressLength = num(d.pattern.length, 0.9, 1.55, s.dressLength);
      s.dressFlare = num(d.pattern.flare, 0.25, 0.5, s.dressFlare);
      s.dressNeck = num(d.pattern.neck, 0.06, 0.16, s.dressNeck);
      s.sleeveLen = num(d.pattern.sleeve, 0.33, 0.47, s.sleeveLen);
      s.skirtLength = num(d.pattern.skirtLength, 0.4, 0.75, s.skirtLength);
      s.skirtFlare = num(d.pattern.skirtFlare, 0.3, 0.46, s.skirtFlare);
    }
    // Only the scanned (realistic) mannequins remain selectable; map any legacy
    // sculpted/older value onto its closest scan so old files still open.
    const bodies = ['scan homme', 'scan femme'];
    if (d.body && bodies.includes(d.body)) s.body = d.body;
    else if ((d.body as string) === 'femme') s.body = 'scan femme';
    else if ((d.body as string) === 'homme' || (d.body as string) === 'scan') s.body = 'scan homme'; // sculpted / format v36
    // Whitelist the scene like the body — a bogus/renamed value would else
    // fall through to a bare cloth grid while the pattern/fabric still import.
    const scenes = ['drapé', 'couture', 'robe', 'robe froncée', 't-shirt', 'chemise', 'ensemble', 'tenue', 'pantalon', 'atelier'];
    if (d.scene && scenes.includes(d.scene)) s.scene = d.scene;
    for (const c of this.controllers) c.updateDisplay();

    // Apply through the live callbacks; the scene change rebuilds last.
    // The pattern callbacks auto-jump to their own scene (and sync it back
    // into settings), so remember the file's scene and restore it at the end.
    const targetScene = s.scene;
    // Batch the rebuilds (audit M26): the callback cascade below would trigger
    // build() ~8-9 times (each a full ParticleSystem + renderer teardown). Defer
    // them so only the final onScene rebuilds — same end state, one rebuild.
    this.cb.onImportBegin?.();
    try {
      this.cb.onBody(s.body);
    // onBody resets the measurements to the new body's baseline, so the saved
    // ones must be restored AFTER it — otherwise the import silently drops the
    // figure it was cut for and reverts to the default body.
    if (d.morph) {
      s.stature = num(
        d.morph.stature,
        AVATAR_STATURE_MIN_CM,
        AVATAR_STATURE_MAX_CM,
        s.stature,
      );
      s.carrure = num(d.morph.carrure, 34, 60, s.carrure);
      s.poitrine = num(d.morph.poitrine, 65, 130, s.poitrine);
      s.taille = num(d.morph.taille, 55, 125, s.taille);
      s.hanches = num(d.morph.hanches, 75, 140, s.hanches);
      s.cuisse = num(d.morph.cuisse, 40, 78, s.cuisse);
      for (const c of Object.values(this.morphControllers)) c.updateDisplay();
    }
    this.cb.onMorph({
      stature: s.stature,
      carrure: s.carrure,
      poitrine: s.poitrine,
      taille: s.taille,
      hanches: s.hanches,
      cuisse: s.cuisse,
    });
    this.cb.onFabricPreset(s.preset);
    if (PRESETS[s.preset]) this.pushStyle();
    this.cb.onCompliance({
      stretch: 10 ** s.stretchExp,
      stretchWarp: 10 ** s.stretchWarpExp,
      shear: 10 ** s.shearExp,
      bend: 10 ** s.bendExp,
      bendWarp: 10 ** s.bendWarpExp,
      stretchLimit: s.stretchLimitPct / 100,
      shearLimit: s.shearLimitPct / 100,
    });
    this.cb.onFriction(s.friction, s.frictionDynamic);
    this.cb.onDynamics({
      arealDensity: s.densityGsm / 1000,
      collisionThickness: s.thicknessMm / 1000,
      damping: s.damping,
      airDrag: s.airDrag,
      frictionStatic: s.friction,
      frictionDynamic: s.frictionDynamic,
      creaseYieldDeg: s.creaseYieldDeg,
      creaseMemory: s.creaseMemory,
      creaseRecovery: s.creaseRecovery,
    });
    this.cb.onSelfCollision(s.selfCollision);
    this.cb.onWind(s.wind);
    this.cb.onSeamAllowance(s.seamAllowance);
    this.cb.onPattern({ length: s.dressLength, flare: s.dressFlare, neck: s.dressNeck });
    this.cb.onShirtPattern({ sleeve: s.sleeveLen });
    this.cb.onSkirtPattern({ length: s.skirtLength, flare: s.skirtFlare });
    // Drafted silhouettes AFTER the slider callbacks (those reset to straight
    // grades — the file's draft must win). Validate hard: exact station count,
    // finite numbers, clamped to the handle bounds. The chemise always gets a
    // call so a stale session draft can't leak into a file that has none.
    const prof = (arr: unknown, len: number, min: number, max: number): number[] | null =>
      Array.isArray(arr) && arr.length === len && arr.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? (arr as number[]).map((v) => Math.min(max, Math.max(min, v)))
        : null;
    const pr = prof(d.pattern?.profile, 6, 0.1, 0.5);
    if (pr) {
      pr[0] = Math.max(0.18, pr[0]!); // straps must clear the neckline scoop
      this.cb.onProfile('robe', pr);
    }
    this.cb.onProfile('chemise', prof(d.pattern?.profileChemise, 3, 0.12, 0.26) ?? [0.22, 0.22, 0.22]);
    const pj = prof(d.pattern?.profileJupe, 4, 0.1, 0.5);
    if (pj) {
      pj[0] = Math.min(0.3, Math.max(0.2, pj[0]!)); // waist ring must close AND stay under the hips
      this.cb.onProfile('jupe', pj);
    }
    // Freeform draft BEFORE the scene rebuilds (onScene 'atelier' cuts from it):
    // main sanitizes and stores it, so the atelier scene shows the saved piece.
    // ALWAYS called (like the chemise profile): a draftless file must clear any
    // leftover session draft (null) instead of leaking it into the next export.
    this.cb.onDraft?.(d.draft ?? null);
    this.cb.onResolution(s.resolution);
    s.scene = targetScene;
    this.syncContextControls(targetScene);
    for (const c of this.controllers) c.updateDisplay();
      this.cb.onScene(targetScene); // sets sceneMode (its build is still deferred)
      return true;
    } finally {
      // Always release import batching: a malformed extension callback must not
      // leave every later rebuild and autosave permanently suspended.
      this.cb.onImportEnd?.();
    }
  }

  /** Brief bottom-centre status message — the only feedback the import has. */
  private toast(msg: string, ok = true): void {
    showToast(msg, ok);
  }

  /** Current preset look + the print settings, merged. */
  private pushStyle(): void {
    const p = PRESETS[this.settings.preset];
    if (!p) return;
    const MOTIFS = ['uni', 'rayures', 'vichy', 'pois'];
    this.cb.onStyle({
      ...p.style,
      motif: Math.max(0, MOTIFS.indexOf(this.settings.motif)),
      motifScale: this.settings.motifCm / 100,
      motifColor: [...this.settings.motifCouleur, 0.9],
    });
  }

  private applyPreset(name: GlobalFabricPreset): void {
    const p = PRESETS[name];
    if (!p) {
      // “Mesuré” is a display state populated by an import, not an empty
      // factory preset. Reject selecting it by hand unless the active baseline
      // is genuinely a measured profile.
      this.settings.preset = PRESETS[this.fabricBaselineName]
        ? (this.fabricBaselineName as FabricPresetName)
        : 'Mesuré';
      this.selectControllers.preset?.updateDisplay();
      this.cb.onFabricPreset(this.settings.preset);
      return;
    }
    this.writeFabricPhysics(p);
    this.settings.preset = name;
    this.setFabricBaseline(name, p, `preset ${name} · calibration TOILE`);
    this.cb.onFabricPreset(name);
    this.fabricDiagnosticTitle = `Preset ${name}`;
    this.fabricDiagnosticLines = [
      'Source : calibration qualitative TOILE',
      'Mesures de laboratoire : aucune',
      'Utilisez « importer KES / FAST / profil » pour un échantillon réel.',
    ];
    this.emitFabricPhysics(p);
    this.pushStyle();
  }
}
