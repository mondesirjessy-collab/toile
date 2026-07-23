import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FABRIC_PHYSICS, type FabricPhysics } from '../src/engine/solver/FabricMaterial';
import {
  fabricProfileReport,
  normalizeResolution,
  resolutionRebuildMessage,
  sameFabricPhysics,
} from '../src/app/ControlStateSync';

type ChangeHandler = (value: unknown) => void;

class FakeController {
  readonly domElement = { id: '' };
  private changeHandler: ChangeHandler | undefined;

  constructor(
    readonly object: Record<string, unknown>,
    readonly property: string,
  ) {}

  name(): this {
    return this;
  }

  onChange(handler: ChangeHandler): this {
    this.changeHandler = handler;
    return this;
  }

  onFinishChange(handler: ChangeHandler): this {
    this.changeHandler = handler;
    return this;
  }

  disable(): this {
    return this;
  }

  updateDisplay(): this {
    return this;
  }

  setValue(value: unknown): void {
    this.object[this.property] = value;
    this.changeHandler?.(value);
  }

  invoke(): void {
    const action = this.object[this.property];
    if (typeof action === 'function') action();
  }
}

const fakeControllers: FakeController[] = [];

vi.mock('lil-gui', () => {
  class FakeGui {
    add(object: Record<string, unknown>, property: string): FakeController {
      const controller = new FakeController(object, property);
      fakeControllers.push(controller);
      return controller;
    }

    addColor(object: Record<string, unknown>, property: string): FakeController {
      return this.add(object, property);
    }

    addFolder(): FakeGui {
      return this;
    }

    close(): void {}
  }

  return { default: FakeGui };
});

const makeCallbacks = () => ({
  onScene: vi.fn(),
  onResolution: vi.fn(),
  onCompliance: vi.fn(),
  onFriction: vi.fn(),
  onDynamics: vi.fn(),
  onStyle: vi.fn(),
  onSelfCollision: vi.fn(),
  onWind: vi.fn(),
  onPodium: vi.fn(),
  onAnimate: vi.fn(),
  onBody: vi.fn(),
  onMorph: vi.fn(),
  onPattern: vi.fn(),
  onProfile: vi.fn(),
  onShirtPattern: vi.fn(),
  onSkirtPattern: vi.fn(),
  onPatternPdf: vi.fn(),
  onPatternSvg: vi.fn(),
  onSeamAllowance: vi.fn(),
  onGltf: vi.fn(),
  onPins: vi.fn(),
  onFitMap: vi.fn(),
  onReset: vi.fn(),
});

describe('synchronisation de la résolution', () => {
  it('normalise les valeurs DOM vers les trois résolutions GPU supportées', () => {
    expect(normalizeResolution('128', 64)).toBe(128);
    expect(normalizeResolution(32, 64)).toBe(32);
    expect(normalizeResolution('96', 64)).toBe(64);
  });

  it('annonce explicitement la reconstruction demandée', () => {
    expect(resolutionRebuildMessage(128)).toBe(
      'Reconstruction 128 × 128 en cours…',
    );
  });
});

describe('fabric profile calibration state', () => {
  beforeEach(() => {
    fakeControllers.length = 0;
    vi.stubGlobal('window', globalThis);
  });

  it('détecte toute déviation puis reconnaît le retour numérique exact', () => {
    const jersey = FABRIC_PHYSICS.Jersey!;
    const changed: FabricPhysics = {
      ...jersey,
      stretch: jersey.stretch * 1.01,
    };

    expect(sameFabricPhysics({ ...jersey }, jersey)).toBe(true);
    expect(sameFabricPhysics(changed, jersey)).toBe(false);
    expect(
      fabricProfileReport(
        changed,
        jersey,
        'Jersey',
        'preset Jersey · calibré',
      ),
    ).toBe('modifié (base Jersey)');
    expect(
      fabricProfileReport(
        { ...jersey },
        jersey,
        'Jersey',
        'preset Jersey · calibré',
      ),
    ).toBe('preset Jersey · calibré');
  });

  it('marque immédiatement un réglage manuel comme modification du preset', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    new ControlPanel(callbacks, { resolution: 64, substeps: 20 });
    const stretch = fakeControllers.find((controller) => controller.property === 'stretchExp')!;
    const report = fakeControllers.find((controller) => controller.property === 'fabricReport')!;

    stretch.setValue(Math.log10(FABRIC_PHYSICS.Jersey!.stretch) + 0.1);
    expect(report.object.fabricReport).toBe('modifié (base Jersey)');
  });

  it('réapplique exactement le preset courant en un geste', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const stretch = fakeControllers.find(
      (controller) => controller.property === 'stretchExp',
    )!;
    const report = fakeControllers.find(
      (controller) => controller.property === 'fabricReport',
    )!;
    const reapply = fakeControllers.find(
      (controller) => controller.property === 'reapply',
    )!;

    stretch.setValue(Math.log10(FABRIC_PHYSICS.Jersey!.stretch) + 0.1);
    expect(report.object.fabricReport).toBe('modifié (base Jersey)');

    (panel as unknown as { toast: () => void }).toast = vi.fn();
    reapply.invoke();

    expect(report.object.fabricReport).toBe('preset Jersey · calibré');
    expect(panel.snapshotGarment().fabric).toMatchObject({
      preset: 'Jersey',
      stretchExp: Math.log10(FABRIC_PHYSICS.Jersey!.stretch),
    });
    expect(callbacks.onCompliance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stretch: FABRIC_PHYSICS.Jersey!.stretch,
        stretchWarp: FABRIC_PHYSICS.Jersey!.stretchWarp,
      }),
    );
    expect(reapply.domElement.id).toBe('toile-reapply-fabric-preset');
  });
});
