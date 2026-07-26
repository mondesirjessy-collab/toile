import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FABRIC_PHYSICS, type FabricPhysics } from '../src/engine/solver/FabricMaterial';
import {
  fabricProfileReport,
  fixedGarmentSizeMessage,
  GLOBAL_FABRIC_INHERIT_VALUE,
  inheritedFabricLabel,
  normalizeResolution,
  normalizeSelectValue,
  pieceFabricSelectEnabled,
  resolutionRebuildMessage,
  sameFabricPhysics,
} from '../src/app/ControlStateSync';

type ChangeHandler = (value: unknown) => void;

class FakeController {
  readonly domElement = { id: '' };
  private changeHandler: ChangeHandler | undefined;
  hidden = false;

  constructor(
    readonly object: Record<string, unknown>,
    readonly property: string,
    readonly folderName = 'root',
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

  show(show = true): this {
    this.hidden = !show;
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
const fakeFolders: Array<{ folderName: string; hidden: boolean }> = [];

vi.mock('lil-gui', () => {
  class FakeGui {
    hidden = false;

    constructor(readonly folderName = 'root') {
      fakeFolders.push(this);
    }

    add(object: Record<string, unknown>, property: string): FakeController {
      const controller = new FakeController(object, property, this.folderName);
      fakeControllers.push(controller);
      return controller;
    }

    addColor(object: Record<string, unknown>, property: string): FakeController {
      return this.add(object, property);
    }

    addFolder(name: string): FakeGui {
      return new FakeGui(name);
    }

    show(show = true): this {
      this.hidden = !show;
      return this;
    }

    close(): void {}
  }

  return { default: FakeGui };
});

const makeCallbacks = () => ({
  onScene: vi.fn(),
  onResolution: vi.fn(),
  onFabricPreset: vi.fn(),
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

describe('libellé de regradation', () => {
  it('dit explicitement qu’un patron chargé conserve sa taille fixe', () => {
    expect(fixedGarmentSizeMessage('S')).toBe(
      'Le vêtement garde sa taille (S) — changez la taille du vêtement pour le regrader.',
    );
  });
});

describe('fabric profile calibration state', () => {
  beforeEach(() => {
    fakeControllers.length = 0;
    fakeFolders.length = 0;
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
        'preset Jersey · calibration TOILE',
      ),
    ).toBe('modifié (base Jersey)');
    expect(
      fabricProfileReport(
        { ...jersey },
        jersey,
        'Jersey',
        'preset Jersey · calibration TOILE',
      ),
    ).toBe('preset Jersey · calibration TOILE');
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

    expect(report.object.fabricReport).toBe('preset Jersey · calibration TOILE');
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

describe('resynchronisation des sélecteurs', () => {
  beforeEach(() => {
    fakeControllers.length = 0;
    fakeFolders.length = 0;
    vi.stubGlobal('window', globalThis);
  });

  it('conserve une valeur valide et un libellé explicite pour le tissu hérité', () => {
    expect(GLOBAL_FABRIC_INHERIT_VALUE).not.toBe('');
    expect(inheritedFabricLabel('Denim')).toBe('🧵 Tissu global — Denim');
    expect(normalizeSelectValue('atelier', ['drapé', 'atelier'] as const, 'drapé')).toBe('atelier');
    expect(normalizeSelectValue('', ['drapé', 'atelier'] as const, 'drapé')).toBe('drapé');
    expect(pieceFabricSelectEnabled('atelier', true)).toBe(true);
    expect(pieceFabricSelectEnabled('robe', true)).toBe(false);
    expect(pieceFabricSelectEnabled('atelier', false)).toBe(false);
  });

  it('recopie systématiquement les quatre valeurs moteur après reconstruction', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, { resolution: 64, substeps: 20 });
    const byProperty = (property: string): FakeController =>
      fakeControllers.find((controller) => controller.property === property)!;

    // Reproduit le symptôme QA avant qu’une reconstruction ne republie l’état.
    byProperty('scene').object.scene = '';
    byProperty('body').object.body = '';
    byProperty('resolution').object.resolution = '';
    byProperty('preset').object.preset = '';

    panel.syncEngineSelects({
      scene: 'atelier',
      body: 'scan homme',
      resolution: 128,
      fabricPreset: 'Denim',
    });

    expect(byProperty('scene').object.scene).toBe('atelier');
    expect(byProperty('body').object.body).toBe('scan homme');
    expect(byProperty('resolution').object.resolution).toBe(128);
    expect(byProperty('preset').object.preset).toBe('Denim');
    for (const property of ['scene', 'body', 'resolution', 'preset']) {
      expect(fakeControllers.filter((controller) => controller.property === property)).toHaveLength(1);
      expect(byProperty(property).object[property]).not.toBe('');
    }
  });

  it('garde le sélecteur de scène visible dans l’atelier mais masque les patrons procéduraux', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, { resolution: 64, substeps: 20 });
    const scene = fakeControllers.find(
      (controller) => controller.property === 'scene',
    )!;
    const proceduralFolders = [
      'patron · robe',
      'patron · chemise',
      'patron · jupe',
    ].map(
      (name) => fakeFolders.find((folder) => folder.folderName === name)!,
    );

    panel.syncEngineSelects({
      scene: 'atelier',
      body: 'scan femme',
      resolution: 64,
      fabricPreset: 'Jersey',
    });

    // L'atelier étant le visage du logiciel, le sélecteur de scène reste
    // visible (c'est la porte vers les scènes moteur via Réglages) ; seuls les
    // patrons procéduraux propres aux démos sont masqués.
    expect(scene.hidden).toBe(false);
    expect(proceduralFolders.every((folder) => folder.hidden)).toBe(true);
    expect(
      fakeFolders.find((folder) => folder.folderName === 'tissu')?.hidden,
    ).toBe(false);
    expect(
      fakeFolders.find((folder) => folder.folderName === 'fichier')?.hidden,
    ).toBe(false);
    expect(
      fakeFolders.find((folder) => folder.folderName === 'épingles')?.hidden,
    ).toBe(true);

    panel.syncEngineSelects({
      scene: 'robe',
      body: 'scan femme',
      resolution: 64,
      fabricPreset: 'Jersey',
    });

    expect(scene.hidden).toBe(false);
    expect(proceduralFolders.every((folder) => !folder.hidden)).toBe(true);
    expect(
      fakeFolders.find((folder) => folder.folderName === 'épingles')?.hidden,
    ).toBe(false);
    expect(
      fakeControllers.filter((controller) => controller.property === 'scene'),
    ).toHaveLength(1);
  });

  it('filtre immédiatement les contrôles pendant un import vers l’atelier', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, { resolution: 64, substeps: 20 });
    const scene = fakeControllers.find(
      (controller) => controller.property === 'scene',
    )!;
    const proceduralFolders = [
      'patron · robe',
      'patron · chemise',
      'patron · jupe',
    ].map(
      (name) => fakeFolders.find((folder) => folder.folderName === name)!,
    );

    const imported = {
      ...panel.snapshotGarment(),
      scene: 'atelier',
    };
    expect(panel.applyGarment(imported)).toBe(true);

    // Sélecteur de scène visible dans l'atelier ; patrons procéduraux masqués.
    expect(scene.hidden).toBe(false);
    expect(proceduralFolders.every((folder) => folder.hidden)).toBe(true);
    expect(callbacks.onScene).toHaveBeenLastCalledWith('atelier');
  });

  it('publie chaque changement du preset global dans la source moteur unique', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, { resolution: 64, substeps: 20 });
    const preset = fakeControllers.find((controller) => controller.property === 'preset')!;

    preset.setValue('Denim');
    preset.setValue('Lin');
    preset.setValue('Jersey');
    panel.syncEngineSelects({
      scene: 'robe',
      body: 'scan femme',
      resolution: 64,
      fabricPreset: 'Jersey',
    });

    expect(callbacks.onFabricPreset.mock.calls.map(([value]) => value)).toEqual([
      'Jersey',
      'Denim',
      'Lin',
      'Jersey',
    ]);
    expect(panel.globalFabricPreset).toBe('Jersey');
    expect(preset.object.preset).toBe('Jersey');
  });
});

describe('retour utilisateur des exports', () => {
  beforeEach(() => {
    fakeControllers.length = 0;
    fakeFolders.length = 0;
    vi.stubGlobal('window', globalThis);
  });

  it('annonce le nom SVG réellement retourné par l’exporteur', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    callbacks.onPatternSvg.mockReturnValue('patron-lucas-hoodie-M.svg');
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const svg = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' && controller.property === 'svg',
    )!;

    svg.invoke();

    expect(callbacks.onPatternSvg).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(
      'Patron exporté — patron-lucas-hoodie-M.svg',
    );
  });

  it('signale une erreur lorsqu’aucun SVG n’a pu être produit', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    callbacks.onPatternSvg.mockReturnValue(null);
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const svg = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' && controller.property === 'svg',
    )!;

    svg.invoke();

    expect(toast).toHaveBeenCalledWith('Échec de l’export SVG.', false);
  });

  it('signale aussi une exception levée pendant l’export SVG', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    callbacks.onPatternSvg.mockImplementation(() => {
      throw new Error('SVG indisponible');
    });
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const svg = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' && controller.property === 'svg',
    )!;

    svg.invoke();

    expect(toast).toHaveBeenCalledWith('Échec de l’export SVG.', false);
  });

  it('attend le snapshot 3D puis annonce le nom GLB téléchargé', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    callbacks.onGltf.mockResolvedValue('toile-atelier.glb');
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const glb = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' && controller.property === 'glb',
    )!;

    glb.invoke();

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Modèle 3D exporté — toile-atelier.glb',
      ),
    );
  });

  it('signale un GLB absent ou une erreur asynchrone', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    callbacks.onGltf.mockResolvedValueOnce(null);
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const glb = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' && controller.property === 'glb',
    )!;

    glb.invoke();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Échec de l’export GLB.', false),
    );

    callbacks.onGltf.mockRejectedValueOnce(new Error('lecture GPU impossible'));
    glb.invoke();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenLastCalledWith('Échec de l’export GLB.', false);
  });

  it('annonce le nom du vêtement JSON téléchargé', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:garment'),
      revokeObjectURL,
    });
    const exporter = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' &&
        controller.property === 'exporter',
    )!;

    vi.useFakeTimers();
    try {
      exporter.invoke();

      expect(anchor.download).toBe('vetement.toile.json');
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(appendChild).toHaveBeenCalledWith(anchor);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(
        'Vêtement exporté — vetement.toile.json',
      );

      vi.advanceTimersByTime(30_000);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:garment');
    } finally {
      vi.useRealTimers();
    }
  });

  it('signale une erreur si le téléchargement JSON ne peut pas démarrer', async () => {
    const { ControlPanel } = await import('../src/app/ControlPanel');
    const callbacks = makeCallbacks();
    const panel = new ControlPanel(callbacks, {
      resolution: 64,
      substeps: 20,
    });
    const toast = vi.fn();
    (panel as unknown as { toast: typeof toast }).toast = toast;
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        href: '',
        download: '',
        click: vi.fn(),
        remove: vi.fn(),
      })),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        throw new Error('quota navigateur');
      }),
      revokeObjectURL: vi.fn(),
    });
    const exporter = fakeControllers.find(
      (controller) =>
        controller.folderName === 'fichier' &&
        controller.property === 'exporter',
    )!;

    exporter.invoke();

    expect(toast).toHaveBeenCalledWith('Échec de l’export JSON.', false);
  });
});
