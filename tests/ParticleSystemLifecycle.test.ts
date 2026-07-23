import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SceneResourceRegistry } from '../src/engine/gpu/SceneResourceRegistry';
import { ParticleSystem } from '../src/engine/solver/ParticleSystem';

const usageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const mapModeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');

beforeAll(() => {
  Object.defineProperty(globalThis, 'GPUBufferUsage', {
    configurable: true,
    value: { COPY_DST: 1, MAP_READ: 2 },
  });
  Object.defineProperty(globalThis, 'GPUMapMode', {
    configurable: true,
    value: { READ: 1 },
  });
});

afterAll(() => {
  if (usageDescriptor) Object.defineProperty(globalThis, 'GPUBufferUsage', usageDescriptor);
  else delete (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage;
  if (mapModeDescriptor) Object.defineProperty(globalThis, 'GPUMapMode', mapModeDescriptor);
  else delete (globalThis as { GPUMapMode?: unknown }).GPUMapMode;
});

interface FakeBuffer {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly mapAsync: ReturnType<typeof vi.fn>;
  readonly getMappedRange: ReturnType<typeof vi.fn>;
}

function fakeBuffer(mapAsync: () => Promise<void> = async () => {}): FakeBuffer {
  const values = new Float32Array([1, 2, 3, 4]);
  return {
    destroy: vi.fn(),
    mapAsync: vi.fn(mapAsync),
    getMappedRange: vi.fn(() => values.buffer),
  };
}

function harness(options: {
  mapAsync?: () => Promise<void>;
  validationError?: { message: string } | null;
  workDone?: () => Promise<void>;
  createEncoderError?: Error;
  popErrorScope?: () => Promise<{ message: string } | null>;
} = {}) {
  const position = fakeBuffer();
  const staging = fakeBuffer(options.mapAsync);
  const resources = new SceneResourceRegistry();
  resources.trackBuffer(position);
  const encoder = {
    copyBufferToBuffer: vi.fn(),
    finish: vi.fn(() => ({})),
  };
  const queue = {
    submit: vi.fn(),
    onSubmittedWorkDone: vi.fn(options.workDone ?? (async () => {})),
  };
  const device = {
    createBuffer: vi.fn(() => staging),
    createCommandEncoder: vi.fn(() => {
      if (options.createEncoderError) throw options.createEncoderError;
      return encoder;
    }),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(
      options.popErrorScope ?? (async () => options.validationError ?? null),
    ),
    queue,
  };

  // Lifecycle/readback methods do not need the heavy GPU constructor. Building
  // the instance from its prototype keeps this a focused state-machine test.
  const system = Object.create(ParticleSystem.prototype) as ParticleSystem;
  Object.assign(system as unknown as Record<string, unknown>, {
    device,
    resources,
    positionBuffer: position,
    count: 1,
    readbackBusy: false,
    pendingReadbacks: new Set<Promise<void>>(),
    retired: false,
    disposed: false,
    pickingDisabled: false,
    prepareDisposePromise: null,
    disposePromise: null,
    dragIndex: 0xffffffff,
    mouseForce: 0,
  });

  return { system, position, staging, resources, device, queue, encoder };
}

describe('ParticleSystem — cycle de vie GPU', () => {
  it('garde le contact corps après la phase distance terminale des coutures', () => {
    const order: string[] = [];
    const pipeline = (name: string): object => ({ name });
    const integrate = pipeline('integrate');
    const dihedral = pipeline('dihedral');
    const distance = pipeline('distance');
    const hashClear = pipeline('hash-clear');
    const hashInsert = pipeline('hash-insert');
    const selfCollide = pipeline('self-collide');
    const surfaceContact = pipeline('surface-contact');
    const surfaceReaction = pipeline('surface-reaction');
    const collide = pipeline('collide');
    const velocity = pipeline('velocity');
    const pass = {
      setPipeline: vi.fn((value: { name: string }) => order.push(value.name)),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
    const encoder = {
      beginComputePass: vi.fn(() => pass),
      finish: vi.fn(() => ({})),
    };
    const queue = { submit: vi.fn() };
    const system = Object.create(ParticleSystem.prototype) as ParticleSystem;
    Object.assign(system as unknown as Record<string, unknown>, {
      retired: false,
      disposed: false,
      count: 1,
      windTime: 0,
      simulatedSeconds: 0,
      writeUniforms: vi.fn(),
      device: { createCommandEncoder: vi.fn(() => encoder), queue },
      integratePipeline: integrate,
      integrateBindGroup: {},
      dihedralPipeline: dihedral,
      dihedralBindGroups: [{}],
      quadColorCounts: [1],
      solvePipeline: distance,
      solveBindGroups: [
        { phase: 'ordinary' },
        { phase: 'seam' },
        { phase: 'surface-seam' },
      ],
      colorCounts: [1, 1, 1],
      regularSeamColorFirst: 1,
      regularSeamColorCount: 1,
      dragIndex: 0xffffffff,
      selfEnabled: true,
      tableSize: 1,
      hashClearPipeline: hashClear,
      hashClearBindGroup: {},
      hashInsertPipeline: hashInsert,
      hashInsertBindGroup: {},
      selfCollidePipeline: selfCollide,
      selfCollideBindGroup: {},
      surfaceContactCount: 1,
      surfaceContactPipeline: surfaceContact,
      surfaceContactBindGroup: {},
      surfaceReactionPipeline: surfaceReaction,
      surfaceReactionBindGroup: {},
      collidePipeline: collide,
      collideBindGroup: {},
      velocityPipeline: velocity,
      velocityBindGroup: {},
    });

    system.step(1 / 60, 1);

    expect(order).toEqual([
      'integrate',
      'dihedral',
      'distance',
      'distance',
      'distance',
      'hash-clear',
      'hash-insert',
      'self-collide',
      'surface-contact',
      'surface-reaction',
      'distance',
      'distance',
      'collide',
      'velocity',
    ]);
    const solveGroups = pass.setBindGroup.mock.calls
      .map(([, group]) => group as { phase?: string })
      .filter((group) => group.phase)
      .map((group) => group.phase);
    expect(solveGroups).toEqual([
      'ordinary',
      'seam',
      'surface-seam',
      'seam',
      'seam',
    ]);
    expect(solveGroups.filter((phase) => phase === 'ordinary')).toHaveLength(1);
    expect(solveGroups.filter((phase) => phase === 'seam')).toHaveLength(3);
    expect(solveGroups.filter((phase) => phase === 'surface-seam')).toHaveLength(1);
    expect(order.lastIndexOf('distance')).toBeLessThan(order.indexOf('collide'));
    expect(order.indexOf('collide')).toBeLessThan(order.indexOf('velocity'));
    expect(queue.submit).toHaveBeenCalledTimes(1);
  });

  it('retire immédiatement la génération et refuse tout nouveau readback', async () => {
    const h = harness();
    expect(h.system.lifecycleState).toBe('active');
    h.system.retire();

    await expect(h.system.readPositions()).resolves.toBeNull();
    expect(h.system.lifecycleState).toBe('retired');
    expect(h.system.pickingEnabled).toBe(false);
    expect(h.device.createBuffer).not.toHaveBeenCalled();
    expect(h.queue.submit).not.toHaveBeenCalled();

    await h.system.dispose();
    expect(h.system.lifecycleState).toBe('disposed');
    expect(h.position.destroy).toHaveBeenCalledTimes(1);
    expect(h.resources.count).toBe(0);
  });

  it('attend le readback puis la file GPU avant une destruction idempotente', async () => {
    let finishMap!: () => void;
    const mapDone = new Promise<void>((resolve) => {
      finishMap = resolve;
    });
    const h = harness({ mapAsync: () => mapDone });

    const read = h.system.readPositions();
    const prepared = h.system.prepareDispose();
    expect(h.system.pickingEnabled).toBe(false);
    expect(h.position.destroy).not.toHaveBeenCalled();
    expect(h.queue.onSubmittedWorkDone).not.toHaveBeenCalled();

    finishMap();
    await expect(read).resolves.toBeNull(); // retired results never reach the new scene
    await prepared;
    expect(h.staging.destroy).toHaveBeenCalledTimes(1);
    expect(h.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    expect(h.position.destroy).not.toHaveBeenCalled();

    await Promise.all([h.system.dispose(), h.system.dispose()]);
    expect(h.position.destroy).toHaveBeenCalledTimes(1);
    expect(h.resources.count).toBe(0);
  });

  it('capture une erreur de validation, désactive le picking et reste non fatal', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness({ validationError: { message: 'buffer détruit' } });

    await expect(h.system.readPositions()).resolves.toBeNull();
    expect(h.device.pushErrorScope).toHaveBeenCalledWith('validation');
    expect(h.device.popErrorScope).toHaveBeenCalledTimes(1);
    expect(h.queue.submit).toHaveBeenCalledTimes(1);
    expect(h.staging.mapAsync).not.toHaveBeenCalled();
    expect(h.staging.destroy).toHaveBeenCalledTimes(1);
    expect(h.system.pickingEnabled).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('picking GPU désactivé'),
    );

    await expect(h.system.readPositions()).resolves.toBeNull();
    expect(h.device.createBuffer).toHaveBeenCalledTimes(1);
    await h.system.dispose();
    expect(h.resources.count).toBe(0);
    warning.mockRestore();
  });

  it('un dispose direct attend onSubmittedWorkDone avant de détruire', async () => {
    let finishGpu!: () => void;
    const gpuDone = new Promise<void>((resolve) => {
      finishGpu = resolve;
    });
    const h = harness({ workDone: () => gpuDone });

    const disposing = h.system.dispose();
    await Promise.resolve();
    expect(h.position.destroy).not.toHaveBeenCalled();
    finishGpu();
    await disposing;
    expect(h.position.destroy).toHaveBeenCalledTimes(1);
    expect(h.resources.count).toBe(0);
  });

  it('borne un mapAsync suspendu afin que le teardown ne reste jamais coincé', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = harness({ mapAsync: () => new Promise<void>(() => {}) });
      const read = h.system.readPositions();
      await Promise.resolve();
      await Promise.resolve();
      const disposing = h.system.dispose();

      await vi.advanceTimersByTimeAsync(5_001);

      await expect(read).resolves.toBeNull();
      await expect(disposing).resolves.toBeUndefined();
      expect(h.staging.destroy).toHaveBeenCalledTimes(1);
      expect(h.position.destroy).toHaveBeenCalledTimes(1);
      expect(h.resources.count).toBe(0);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('picking GPU désactivé'),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('borne aussi la fermeture de portée après une erreur d’encodage synchrone', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = harness({
        createEncoderError: new Error('encodeur indisponible'),
        popErrorScope: () => new Promise(() => {}),
      });
      const read = h.system.readPositions();
      const disposing = h.system.dispose();

      await vi.advanceTimersByTimeAsync(5_001);

      await expect(read).resolves.toBeNull();
      await expect(disposing).resolves.toBeUndefined();
      expect(h.device.popErrorScope).toHaveBeenCalledTimes(1);
      expect(h.staging.destroy).toHaveBeenCalledTimes(1);
      expect(h.position.destroy).toHaveBeenCalledTimes(1);
      expect(h.resources.count).toBe(0);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('picking GPU désactivé'),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('force la libération si onSubmittedWorkDone ne répond jamais', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = harness({ workDone: () => new Promise<void>(() => {}) });
      const disposing = h.system.dispose();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(12_001);

      await expect(disposing).resolves.toBeUndefined();
      expect(h.position.destroy).toHaveBeenCalledTimes(1);
      expect(h.resources.count).toBe(0);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('attente GPU interrompue'),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
});
