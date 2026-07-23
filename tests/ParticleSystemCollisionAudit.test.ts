import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import collideWGSL from '../src/engine/solver/shaders/collide.wgsl?raw';
import collisionAuditWGSL from '../src/engine/solver/shaders/collisionAudit.wgsl?raw';
import { SceneResourceRegistry } from '../src/engine/gpu/SceneResourceRegistry';
import { ParticleSystem } from '../src/engine/solver/ParticleSystem';

const usageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const mapModeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');

beforeAll(() => {
  Object.defineProperty(globalThis, 'GPUBufferUsage', {
    configurable: true,
    value: { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 },
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

/** Extract one WGSL function/struct including nested braces. */
function shaderBlock(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`bloc WGSL absent : ${signature}`);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let cursor = opening; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++;
    else if (source[cursor] === '}' && --depth === 0) {
      return source
        .slice(start, cursor + 1)
        .replace(/\/\/.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  throw new Error(`bloc WGSL incomplet : ${signature}`);
}

function shaderFunction(source: string, name: string): string {
  return shaderBlock(source, `fn ${name}(`);
}

describe('ParticleSystem — audit collision GPU', () => {
  it('réutilise byte pour byte les fonctions de distance du solveur', () => {
    for (const name of ['SimParams', 'Prim', 'FabricMaterial']) {
      expect(shaderBlock(collisionAuditWGSL, `struct ${name} {`)).toBe(
        shaderBlock(collideWGSL, `struct ${name} {`),
      );
    }
    for (const name of [
      'to_body',
      'to_world',
      'grid_sample',
      'sd_round_cone',
      'smin',
      'sd_body',
      'body_distance',
    ]) {
      expect(shaderFunction(collisionAuditWGSL, name)).toBe(shaderFunction(collideWGSL, name));
    }
  });

  it('retourne position, distance et offset du même snapshot avec des sentinelles stables', async () => {
    // Three packed AuditSample values: position_distance vec4 + contact vec4.
    const packed = new Float32Array([
      1, 2, 3, -0.0015, 0.005, 1, 0, 0,
      4, 5, 6, 1e9, 0.007, 1, 0, 0,
      7, 8, 9, -0.02, 0.004, 0, 0, 0,
    ]);
    const output = { destroy: vi.fn() };
    const staging = {
      destroy: vi.fn(),
      mapAsync: vi.fn(async () => {}),
      getMappedRange: vi.fn(() => packed.buffer),
      unmap: vi.fn(),
    };
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
    const encoder = {
      beginComputePass: vi.fn(() => pass),
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn(() => ({})),
    };
    const pipeline = { getBindGroupLayout: vi.fn(() => ({})) };
    const queue = {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      onSubmittedWorkDone: vi.fn(async () => {}),
    };
    const device = {
      createShaderModule: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => pipeline),
      createBuffer: vi.fn((descriptor: { label?: string }) =>
        descriptor.label === 'collision-audit-output' ? output : staging),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => encoder),
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn(async () => null),
      queue,
    };
    const resources = new SceneResourceRegistry();
    const writeUniforms = vi.fn();
    const system = Object.create(ParticleSystem.prototype) as ParticleSystem;
    Object.assign(system as unknown as Record<string, unknown>, {
      device,
      resources,
      count: 3,
      uniformBuffer: {},
      positionBuffer: {},
      colliderBuffer: {},
      sdfTexture: { createView: vi.fn(() => ({})) },
      layerBuffer: {},
      materialIdBuffer: {},
      materialBuffer: {},
      invMassBuffer: {},
      pendingReadbacks: new Set<Promise<void>>(),
      retired: false,
      disposed: false,
      collisionAuditPromise: null,
      collisionAuditDisabled: false,
      writeUniforms,
    });

    const snapshot = await system.readCollisionDistances();

    expect(snapshot).not.toBeNull();
    expect([...snapshot!.positions]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(snapshot!.distances[0]).toBeCloseTo(-0.0015);
    expect(snapshot!.distances[1]).toBe(Number.POSITIVE_INFINITY); // outside SDF/AABB
    expect(snapshot!.distances[2]).toBeNaN(); // cut/inactive particle
    expect(snapshot!.contactOffsets[0]).toBeCloseTo(0.005);
    expect(snapshot!.contactOffsets[1]).toBeCloseTo(0.007);
    expect(snapshot!.contactOffsets[2]).toBeNaN();
    expect(writeUniforms).toHaveBeenCalledWith(0);
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledWith(output, 0, staging, 0, packed.byteLength);
    expect(queue.submit).toHaveBeenCalledTimes(1);
    expect(staging.mapAsync).toHaveBeenCalledWith(1);
    expect(staging.unmap).toHaveBeenCalledTimes(1);
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(staging.destroy).toHaveBeenCalledTimes(1);
    expect(resources.count).toBe(0);
  });

  it('borne la fermeture de portée si la création du pipeline échoue puis WebGPU se tait', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const queue = {
        writeBuffer: vi.fn(),
        onSubmittedWorkDone: vi.fn(async () => {}),
      };
      const device = {
        createShaderModule: vi.fn(() => ({})),
        createComputePipeline: vi.fn(() => {
          throw new Error('pipeline indisponible');
        }),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(() => new Promise<null>(() => {})),
        queue,
      };
      const resources = new SceneResourceRegistry();
      const system = Object.create(ParticleSystem.prototype) as ParticleSystem;
      Object.assign(system as unknown as Record<string, unknown>, {
        device,
        resources,
        count: 1,
        pendingReadbacks: new Set<Promise<void>>(),
        retired: false,
        disposed: false,
        collisionAuditPromise: null,
        collisionAuditDisabled: false,
        prepareDisposePromise: null,
        disposePromise: null,
        dragIndex: 0xffffffff,
        mouseForce: 0,
        writeUniforms: vi.fn(),
      });

      const audit = system.readCollisionDistances();
      const disposing = system.dispose();
      await vi.advanceTimersByTimeAsync(5_001);

      await expect(audit).resolves.toBeNull();
      await expect(disposing).resolves.toBeUndefined();
      expect(device.popErrorScope).toHaveBeenCalledTimes(1);
      expect(queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
      expect(resources.count).toBe(0);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('audit collision GPU désactivé'),
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });
});
