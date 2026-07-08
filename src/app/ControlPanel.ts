/**
 * ControlPanel — real-time lil-gui panel (brief §4). Exposes the knobs the brief
 * lists: mesh resolution (rebuilds), substeps, compliance stretch/shear/bend (as
 * log/exponent sliders), friction μ, corner pins + reset, and fabric presets.
 * Everything but resolution applies live via the callbacks; resolution triggers
 * a rebuild.
 */
import GUI from 'lil-gui';
import type { FabricStyle } from './ClothRenderer';

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

/** Parametric pattern measurements (grading) for the dress. */
export interface PatternParams {
  length: number; // meters
  flare: number; // hem half-width, pattern units
  neck: number; // neckline half-width, pattern units
}

export interface PanelCallbacks {
  onScene(mode: SceneMode): void;
  onResolution(resolution: number): void;
  onCompliance(c: { stretch: number; stretchWarp: number; shear: number; bend: number }): void;
  onFriction(mu: number): void;
  onStyle(style: FabricStyle): void;
  onSelfCollision(enabled: boolean): void;
  onWind(strength: number): void;
  onPodium(rpm: number): void;
  onAnimate(on: boolean): void;
  onBody(kind: BodyKind): void;
  onMorph(cm: { stature: number; carrure: number; poitrine: number; taille: number; hanches: number; cuisse: number }): void;
  onPattern(p: PatternParams): void;
  onProfile(kind: 'robe' | 'chemise' | 'jupe', profile: number[]): void;
  onShirtPattern(p: { sleeve: number }): void;
  onSkirtPattern(p: { length: number; flare: number }): void;
  onPatternPdf(): void;
  onPatternSvg(): void;
  onGltf(): void;
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
  friction: number;
  pinCorners: boolean;
  fitMap: boolean;
  preset: string;
  motif: string;
  motifCm: number;
  motifCouleur: [number, number, number];
}

// Fabric presets (brief §4: Jersey/Denim/Soie — the seed of the fabric library).
// Physics: compliance (stretch/shear/bend) + Coulomb friction. Look: face/back
// colors + shading response, so switching presets is instantly recognizable.
interface FabricPreset {
  stretch: number; // weft (trame)
  stretchWarp: number; // warp (chaîne, le droit-fil)
  shear: number; // bias (biais)
  bend: number;
  friction: number;
  style: FabricStyle;
}

// Anisotropic fabric library: real cloth resists differently along the weft
// (horizontal), the warp/grain (vertical, always the stiffest in a woven) and
// the bias (diagonal — where wovens give, and why bias-cut dresses flow).
const PRESETS: Record<string, FabricPreset> = {
  // Knit: very stretchy across (courses), less along the wales; floppy.
  Jersey: {
    stretch: 3e-6,
    stretchWarp: 8e-7,
    shear: 1e-5,
    bend: 2e-4,
    friction: 0.55,
    style: { face: [0.87, 0.82, 0.72], back: [0.66, 0.55, 0.47], exponent: 2.0, ambient: 0.22 },
  },
  // Rib knit: the stretchiest thing on the rail, hugs everything.
  Maille: {
    stretch: 8e-6,
    stretchWarp: 2e-6,
    shear: 1.2e-5,
    bend: 2e-4,
    friction: 0.6,
    style: { face: [0.72, 0.45, 0.42], back: [0.55, 0.33, 0.31], exponent: 1.8, ambient: 0.24 },
  },
  // Crisp shirting cotton: barely stretches, crisp folds.
  Popeline: {
    stretch: 5e-8,
    stretchWarp: 2e-8,
    shear: 1.5e-6,
    bend: 3e-5,
    friction: 0.5,
    style: { face: [0.93, 0.93, 0.9], back: [0.82, 0.82, 0.78], exponent: 2.4, ambient: 0.2 },
  },
  // Stiff heavy twill: inextensible, holds big folds, grippy.
  Denim: {
    stretch: 1e-8,
    stretchWarp: 8e-9,
    shear: 1e-7,
    bend: 5e-6,
    friction: 0.7,
    style: { face: [0.23, 0.29, 0.45], back: [0.52, 0.58, 0.7], exponent: 1.4, ambient: 0.3 },
  },
  // Linen: dry hand, holds creases, matte texture.
  Lin: {
    stretch: 3e-8,
    stretchWarp: 3e-8,
    shear: 2e-6,
    bend: 8e-5,
    friction: 0.6,
    style: { face: [0.85, 0.8, 0.68], back: [0.74, 0.69, 0.57], exponent: 1.6, ambient: 0.26 },
  },
  // Wool flannel: soft, heavy drape, warm grey.
  Laine: {
    stretch: 8e-8,
    stretchWarp: 5e-8,
    shear: 3e-6,
    bend: 1.5e-4,
    friction: 0.65,
    style: { face: [0.52, 0.5, 0.52], back: [0.4, 0.38, 0.4], exponent: 1.5, ambient: 0.28 },
  },
  // Silk satin: inextensible threads but a LOOSE bias — this is where the
  // slink comes from — extremely floppy, slippery, sheeny.
  Soie: {
    stretch: 1e-8,
    stretchWarp: 1e-8,
    shear: 1.5e-5,
    bend: 5e-4,
    friction: 0.25,
    style: { face: [0.93, 0.87, 0.78], back: [0.8, 0.68, 0.58], exponent: 3.5, ambient: 0.12 },
  },
};

export class ControlPanel {
  private readonly gui: GUI;
  private readonly cb: PanelCallbacks;
  private readonly settings: Settings;
  private readonly controllers: { updateDisplay(): void }[] = [];
  private morphControllers: Record<string, { updateDisplay(): void }> = {};

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
      friction: 0.5,
      pinCorners: false,
      fitMap: false,
      preset: 'Jersey',
      motif: 'uni',
      motifCm: 5,
      motifCouleur: [1, 1, 1] as [number, number, number],
    };

    this.gui = new GUI({ title: 'TOILE — solveur' });
    // Accès de test en dev : piloter les contrôleurs sans dépendre de clics pixel.
    // __toileImport rejoue un .toile.json sans passer par le dialogue de fichier.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __toileGui?: GUI; __toileImport?: (doc: unknown) => void };
      w.__toileGui = this.gui;
      w.__toileImport = (doc: unknown) => this.applyGarment(doc);
    }

    this.controllers.push(
      this.gui
        .add(this.settings, 'scene', ['drapé', 'couture', 'robe', 'robe froncée', 't-shirt', 'chemise', 'ensemble', 'tenue', 'pantalon', 'atelier'])
        .name('scène')
        .onChange((m: SceneMode) => this.cb.onScene(m)),
    );
    this.controllers.push(
      this.gui
        .add(this.settings, 'body', ['scan femme', 'scan homme'])
        .name('mannequin')
        .onChange((k: BodyKind) => this.cb.onBody(k)),
    );
    // Prêt-à-porter measurements, in centimeters. The sliders open on the
    // selected mannequin's OWN measured values (syncMorphCm).
    const morphFolder = this.gui.addFolder('mannequin · mensurations (cm)');
    const pushMorph = (): void =>
      this.cb.onMorph({
        stature: this.settings.stature,
        carrure: this.settings.carrure,
        poitrine: this.settings.poitrine,
        taille: this.settings.taille,
        hanches: this.settings.hanches,
        cuisse: this.settings.cuisse,
      });
    this.morphControllers = {
      stature: morphFolder.add(this.settings, 'stature', 145, 195, 0.5).name('stature').onFinishChange(pushMorph),
      carrure: morphFolder.add(this.settings, 'carrure', 34, 60, 0.5).name('carrure (épaules)').onFinishChange(pushMorph),
      poitrine: morphFolder.add(this.settings, 'poitrine', 65, 130, 0.5).name('tour de poitrine').onFinishChange(pushMorph),
      taille: morphFolder.add(this.settings, 'taille', 55, 125, 0.5).name('tour de taille').onFinishChange(pushMorph),
      hanches: morphFolder.add(this.settings, 'hanches', 75, 140, 0.5).name('tour de hanches').onFinishChange(pushMorph),
      cuisse: morphFolder.add(this.settings, 'cuisse', 40, 78, 0.5).name('tour de cuisse').onFinishChange(pushMorph),
    };
    this.controllers.push(...Object.values(this.morphControllers));
    morphFolder.close();

    this.controllers.push(
      this.gui
        .add(this.settings, 'resolution', [32, 64, 128])
        .name('résolution')
        .onChange((v: number) => this.cb.onResolution(v)),
    );
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
    const pushCompliance = (): void =>
      this.cb.onCompliance({
        stretch: 10 ** this.settings.stretchExp,
        stretchWarp: 10 ** this.settings.stretchWarpExp,
        shear: 10 ** this.settings.shearExp,
        bend: 10 ** this.settings.bendExp,
      });
    this.controllers.push(
      fabric.add(this.settings, 'stretchExp', -8, -3, 0.1).name('étirement trame (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'stretchWarpExp', -8, -3, 0.1).name('étirement chaîne (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'shearExp', -8, -3, 0.1).name('biais / cisaillement (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'bendExp', -8, -3, 0.1).name('compliance flexion (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'friction', 0, 1, 0.01).name('friction μ').onChange((v: number) => this.cb.onFriction(v)),
      fabric.add(this.settings, 'preset', ['Jersey', 'Maille', 'Popeline', 'Denim', 'Lin', 'Laine', 'Soie']).name('preset').onChange((name: string) => this.applyPreset(name)),
      fabric
        .add(this.settings, 'fitMap')
        .name('carte de tension')
        .onChange((v: boolean) => this.cb.onFitMap(v)),
    );

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

    // Open garment format: save/load the whole garment as JSON.
    const file = this.gui.addFolder('fichier');
    file.add({ pdf: () => this.cb.onPatternPdf() }, 'pdf').name('imprimer le patron (PDF 1:1)');
    file.add({ svg: () => this.cb.onPatternSvg() }, 'svg').name('exporter le patron (SVG)');
    file.add({ glb: () => this.cb.onGltf() }, 'glb').name('exporter en 3D (.glb)');
    file.add({ exporter: () => this.exportGarment() }, 'exporter').name('exporter le vêtement (.json)');
    file.add({ importer: () => this.importGarment() }, 'importer').name('importer un vêtement');

    const pins = this.gui.addFolder('épingles');
    this.controllers.push(
      pins.add(this.settings, 'pinCorners').name('coins épinglés').onChange((v: boolean) => this.cb.onPins(v)),
    );
    pins.add({ reset: () => this.cb.onReset() }, 'reset').name('reset (relâcher)');

    // Apply the initial preset so the sim starts in a defined fabric state.
    this.applyPreset(this.settings.preset);
  }

  /** Current substep count, read by the frame loop. */
  get substeps(): number {
    return this.settings.substeps;
  }

  /** Keep the pin checkbox in sync when pins are toggled elsewhere (P key / reset). */
  syncPins(held: boolean): void {
    this.settings.pinCorners = held;
    for (const c of this.controllers) c.updateDisplay();
  }

  /** Keep the scene select in sync when the scene changes elsewhere. */
  syncScene(mode: SceneMode): void {
    this.settings.scene = mode;
    for (const c of this.controllers) c.updateDisplay();
  }

  /** Open the measurement sliders on the selected body's own values (cm). */
  syncMorphCm(cm: Record<string, number>): void {
    const s = this.settings as unknown as Record<string, number>;
    for (const k of ['stature', 'carrure', 'poitrine', 'taille', 'hanches', 'cuisse']) {
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

  /** Serialize the current garment to the open TOILE format and download it. */
  private exportGarment(): void {
    const s = this.settings;
    const doc = {
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
        friction: s.friction,
      },
      sim: { resolution: s.resolution, substeps: s.substeps, selfCollision: s.selfCollision, wind: s.wind },
      // Atelier draft (freeform pattern): only present once the user has drawn
      // one — so a plain archetype file stays small and unchanged.
      ...((): object => {
        const draft = this.cb.onGetDraft?.();
        return draft ? { draft } : {};
      })(),
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vetement.toile.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
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

  private applyGarment(doc: unknown): boolean {
    const d = doc as {
      format?: string;
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
        friction?: number;
        motif?: string;
        motifCm?: number;
        motifCouleur?: [number, number, number];
      };
      sim?: { resolution?: number; substeps?: number; selfCollision?: boolean; wind?: number };
      draft?: unknown;
    };
    if (d?.format !== 'toile-garment') return false;
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
    if (d.fabric) {
      if (d.fabric.preset && PRESETS[d.fabric.preset]) s.preset = d.fabric.preset;
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
      s.stretchExp = num(d.fabric.stretchExp, -8, -3, s.stretchExp);
      s.stretchWarpExp = num(d.fabric.stretchWarpExp ?? d.fabric.stretchExp, -8, -3, s.stretchWarpExp);
      s.shearExp = num(d.fabric.shearExp, -8, -3, s.shearExp);
      s.bendExp = num(d.fabric.bendExp, -8, -3, s.bendExp);
      s.friction = num(d.fabric.friction, 0, 1, s.friction);
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
    this.cb.onBody(s.body);
    // onBody resets the measurements to the new body's baseline, so the saved
    // ones must be restored AFTER it — otherwise the import silently drops the
    // figure it was cut for and reverts to the default body.
    if (d.morph) {
      s.stature = num(d.morph.stature, 145, 195, s.stature);
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
    if (PRESETS[s.preset]) this.pushStyle();
    this.cb.onCompliance({
      stretch: 10 ** s.stretchExp,
      stretchWarp: 10 ** s.stretchWarpExp,
      shear: 10 ** s.shearExp,
      bend: 10 ** s.bendExp,
    });
    this.cb.onFriction(s.friction);
    this.cb.onSelfCollision(s.selfCollision);
    this.cb.onWind(s.wind);
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
    for (const c of this.controllers) c.updateDisplay();
    this.cb.onScene(targetScene); // sets sceneMode (its build is still deferred)
    this.cb.onImportEnd?.(); // release the batch → exactly one rebuild
    return true;
  }

  private toastTimer = 0;
  /** Brief bottom-centre status message — the only feedback the import has. */
  private toast(msg: string, ok = true): void {
    let el = document.getElementById('toile-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toile-toast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:20;' +
        'padding:8px 16px;border-radius:6px;font:13px ui-monospace,Menlo,monospace;' +
        'color:#ede9df;background:rgba(10,11,14,0.9);border:1px solid;pointer-events:none;' +
        'transition:opacity 0.3s;opacity:0';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderColor = ok ? 'rgba(127,178,255,0.55)' : 'rgba(255,120,120,0.65)';
    el.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el!.style.opacity = '0';
    }, 3200);
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

  private applyPreset(name: string): void {
    const p = PRESETS[name];
    if (!p) return;
    this.settings.stretchExp = Math.log10(p.stretch);
    this.settings.stretchWarpExp = Math.log10(p.stretchWarp);
    this.settings.shearExp = Math.log10(p.shear);
    this.settings.bendExp = Math.log10(p.bend);
    this.settings.friction = p.friction;
    this.settings.preset = name;
    for (const c of this.controllers) c.updateDisplay();
    this.cb.onCompliance({ stretch: p.stretch, stretchWarp: p.stretchWarp, shear: p.shear, bend: p.bend });
    this.cb.onFriction(p.friction);
    this.pushStyle();
  }
}
