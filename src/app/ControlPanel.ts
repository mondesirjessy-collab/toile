/**
 * ControlPanel — real-time lil-gui panel (brief §4). Exposes the knobs the brief
 * lists: mesh resolution (rebuilds), substeps, compliance stretch/shear/bend (as
 * log/exponent sliders), friction μ, corner pins + reset, and fabric presets.
 * Everything but resolution applies live via the callbacks; resolution triggers
 * a rebuild.
 */
import GUI from 'lil-gui';
import type { FabricStyle } from './ClothRenderer';

export type SceneMode = 'drapé' | 'couture' | 'robe' | 't-shirt' | 'chemise' | 'ensemble';

/** Parametric pattern measurements (grading) for the dress. */
export interface PatternParams {
  length: number; // meters
  flare: number; // hem half-width, pattern units
  neck: number; // neckline half-width, pattern units
}

export interface PanelCallbacks {
  onScene(mode: SceneMode): void;
  onResolution(resolution: number): void;
  onCompliance(c: { stretch: number; shear: number; bend: number }): void;
  onFriction(mu: number): void;
  onStyle(style: FabricStyle): void;
  onSelfCollision(enabled: boolean): void;
  onWind(strength: number): void;
  onPattern(p: PatternParams): void;
  onPins(held: boolean): void;
  onReset(): void;
}

interface Settings {
  scene: SceneMode;
  resolution: number;
  substeps: number;
  selfCollision: boolean;
  wind: number;
  dressLength: number;
  dressFlare: number;
  dressNeck: number;
  stretchExp: number; // compliance = 10^exp (log slider); -8 ≈ rigid
  shearExp: number;
  bendExp: number;
  friction: number;
  pinCorners: boolean;
  preset: string;
}

// Fabric presets (brief §4: Jersey/Denim/Soie — the seed of the fabric library).
// Physics: compliance (stretch/shear/bend) + Coulomb friction. Look: face/back
// colors + shading response, so switching presets is instantly recognizable.
interface FabricPreset {
  stretch: number;
  shear: number;
  bend: number;
  friction: number;
  style: FabricStyle;
}

const PRESETS: Record<string, FabricPreset> = {
  // Knit: stretches a little, floppy, matte ecru.
  Jersey: {
    stretch: 1e-6,
    shear: 3e-6,
    bend: 3e-5,
    friction: 0.55,
    style: { face: [0.87, 0.82, 0.72], back: [0.66, 0.55, 0.47], exponent: 2.0, ambient: 0.22 },
  },
  // Stiff heavy twill: inextensible, holds big folds, grippy; indigo with the
  // washed-out lighter reverse denim is known for.
  Denim: {
    stretch: 1e-8,
    shear: 5e-8,
    bend: 5e-7,
    friction: 0.7,
    style: { face: [0.23, 0.29, 0.45], back: [0.52, 0.58, 0.7], exponent: 1.4, ambient: 0.3 },
  },
  // Silk: inextensible but extremely floppy (fine wrinkles), slippery, sheeny.
  // (μ 0.25: slippery enough to read as silk, grippy enough to stay dressed.)
  Soie: {
    stretch: 1e-8,
    shear: 8e-7,
    bend: 1e-4,
    friction: 0.25,
    style: { face: [0.93, 0.87, 0.78], back: [0.8, 0.68, 0.58], exponent: 3.5, ambient: 0.12 },
  },
};

export class ControlPanel {
  private readonly gui: GUI;
  private readonly cb: PanelCallbacks;
  private readonly settings: Settings;
  private readonly controllers: { updateDisplay(): void }[] = [];

  constructor(cb: PanelCallbacks, initial: { resolution: number; substeps: number }) {
    this.cb = cb;
    this.settings = {
      scene: 'drapé' as SceneMode,
      resolution: initial.resolution,
      substeps: initial.substeps,
      selfCollision: true,
      wind: 0,
      dressLength: 1.3,
      dressFlare: 0.5,
      dressNeck: 0.1,
      stretchExp: -8,
      shearExp: -8,
      bendExp: Math.log10(2e-6),
      friction: 0.5,
      pinCorners: false,
      preset: 'Jersey',
    };

    this.gui = new GUI({ title: 'TOILE — solveur' });

    this.controllers.push(
      this.gui
        .add(this.settings, 'scene', ['drapé', 'couture', 'robe', 't-shirt', 'chemise', 'ensemble'])
        .name('scène')
        .onChange((m: SceneMode) => this.cb.onScene(m)),
    );
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

    const fabric = this.gui.addFolder('tissu');
    const pushCompliance = (): void =>
      this.cb.onCompliance({
        stretch: 10 ** this.settings.stretchExp,
        shear: 10 ** this.settings.shearExp,
        bend: 10 ** this.settings.bendExp,
      });
    this.controllers.push(
      fabric.add(this.settings, 'stretchExp', -8, -3, 0.1).name('compliance étirement (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'shearExp', -8, -3, 0.1).name('compliance cisaillement (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'bendExp', -8, -3, 0.1).name('compliance flexion (log)').onChange(pushCompliance),
      fabric.add(this.settings, 'friction', 0, 1, 0.01).name('friction μ').onChange((v: number) => this.cb.onFriction(v)),
      fabric.add(this.settings, 'preset', ['Jersey', 'Denim', 'Soie']).name('preset').onChange((name: string) => this.applyPreset(name)),
    );

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

    // Open garment format: save/load the whole garment as JSON.
    const file = this.gui.addFolder('fichier');
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

  /** Serialize the current garment to the open TOILE format and download it. */
  private exportGarment(): void {
    const s = this.settings;
    const doc = {
      format: 'toile-garment',
      version: 1,
      scene: s.scene,
      pattern: { length: s.dressLength, flare: s.dressFlare, neck: s.dressNeck },
      fabric: {
        preset: s.preset,
        stretchExp: s.stretchExp,
        shearExp: s.shearExp,
        bendExp: s.bendExp,
        friction: s.friction,
      },
      sim: { resolution: s.resolution, substeps: s.substeps, selfCollision: s.selfCollision, wind: s.wind },
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
        try {
          this.applyGarment(JSON.parse(txt));
        } catch {
          /* fichier invalide — ignoré */
        }
      });
    };
    input.click();
  }

  private applyGarment(doc: unknown): void {
    const d = doc as {
      format?: string;
      scene?: SceneMode;
      pattern?: Partial<PatternParams>;
      fabric?: { preset?: string; stretchExp?: number; shearExp?: number; bendExp?: number; friction?: number };
      sim?: { resolution?: number; substeps?: number; selfCollision?: boolean; wind?: number };
    };
    if (d?.format !== 'toile-garment') return;
    const s = this.settings;
    if (d.sim) {
      s.resolution = d.sim.resolution ?? s.resolution;
      s.substeps = d.sim.substeps ?? s.substeps;
      s.selfCollision = d.sim.selfCollision ?? s.selfCollision;
      s.wind = d.sim.wind ?? s.wind;
    }
    if (d.fabric) {
      if (d.fabric.preset && PRESETS[d.fabric.preset]) s.preset = d.fabric.preset;
      s.stretchExp = d.fabric.stretchExp ?? s.stretchExp;
      s.shearExp = d.fabric.shearExp ?? s.shearExp;
      s.bendExp = d.fabric.bendExp ?? s.bendExp;
      s.friction = d.fabric.friction ?? s.friction;
    }
    if (d.pattern) {
      s.dressLength = d.pattern.length ?? s.dressLength;
      s.dressFlare = d.pattern.flare ?? s.dressFlare;
      s.dressNeck = d.pattern.neck ?? s.dressNeck;
    }
    if (d.scene) s.scene = d.scene;
    for (const c of this.controllers) c.updateDisplay();

    // Apply through the live callbacks; the scene change rebuilds last.
    const preset = PRESETS[s.preset];
    if (preset) this.cb.onStyle(preset.style);
    this.cb.onCompliance({ stretch: 10 ** s.stretchExp, shear: 10 ** s.shearExp, bend: 10 ** s.bendExp });
    this.cb.onFriction(s.friction);
    this.cb.onSelfCollision(s.selfCollision);
    this.cb.onWind(s.wind);
    this.cb.onPattern({ length: s.dressLength, flare: s.dressFlare, neck: s.dressNeck });
    this.cb.onResolution(s.resolution);
    this.cb.onScene(s.scene);
  }

  private applyPreset(name: string): void {
    const p = PRESETS[name];
    if (!p) return;
    this.settings.stretchExp = Math.log10(p.stretch);
    this.settings.shearExp = Math.log10(p.shear);
    this.settings.bendExp = Math.log10(p.bend);
    this.settings.friction = p.friction;
    this.settings.preset = name;
    for (const c of this.controllers) c.updateDisplay();
    this.cb.onCompliance({ stretch: p.stretch, shear: p.shear, bend: p.bend });
    this.cb.onFriction(p.friction);
    this.cb.onStyle(p.style);
  }
}
