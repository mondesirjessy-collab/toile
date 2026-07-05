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

export interface PanelCallbacks {
  onScene(mode: SceneMode): void;
  onResolution(resolution: number): void;
  onCompliance(c: { stretch: number; shear: number; bend: number }): void;
  onFriction(mu: number): void;
  onStyle(style: FabricStyle): void;
  onSelfCollision(enabled: boolean): void;
  onWind(strength: number): void;
  onPins(held: boolean): void;
  onReset(): void;
}

interface Settings {
  scene: SceneMode;
  resolution: number;
  substeps: number;
  selfCollision: boolean;
  wind: number;
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
