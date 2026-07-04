/**
 * ControlPanel — real-time lil-gui panel (brief §4). Exposes the knobs the brief
 * lists: mesh resolution (rebuilds), substeps, compliance stretch/shear/bend (as
 * log/exponent sliders), friction μ, corner pins + reset, and fabric presets.
 * Everything but resolution applies live via the callbacks; resolution triggers
 * a rebuild.
 */
import GUI from 'lil-gui';

export interface PanelCallbacks {
  onResolution(resolution: number): void;
  onCompliance(c: { stretch: number; shear: number; bend: number }): void;
  onFriction(mu: number): void;
  onPins(held: boolean): void;
  onReset(): void;
}

interface Settings {
  resolution: number;
  substeps: number;
  stretchExp: number; // compliance = 10^exp (log slider); -8 ≈ rigid
  shearExp: number;
  bendExp: number;
  friction: number;
  pinCorners: boolean;
  preset: string;
}

// Fabric presets as real compliance values + friction (brief §4: Jersey/Denim/Soie).
const PRESETS: Record<string, { stretch: number; shear: number; bend: number; friction: number }> = {
  Jersey: { stretch: 1e-7, shear: 1e-6, bend: 2e-5, friction: 0.5 }, // soft knit, floppy
  Denim: { stretch: 1e-8, shear: 1e-8, bend: 1e-7, friction: 0.6 }, // stiff, holds folds
  Soie: { stretch: 1e-8, shear: 1e-7, bend: 3e-6, friction: 0.3 }, // fine drape, slippery
};

export class ControlPanel {
  private readonly gui: GUI;
  private readonly cb: PanelCallbacks;
  private readonly settings: Settings;
  private readonly controllers: { updateDisplay(): void }[] = [];

  constructor(cb: PanelCallbacks, initial: { resolution: number; substeps: number }) {
    this.cb = cb;
    this.settings = {
      resolution: initial.resolution,
      substeps: initial.substeps,
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
        .add(this.settings, 'resolution', [32, 64, 128])
        .name('résolution')
        .onChange((v: number) => this.cb.onResolution(v)),
    );
    this.controllers.push(
      this.gui.add(this.settings, 'substeps', 5, 40, 1).name('substeps'),
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
  }
}
