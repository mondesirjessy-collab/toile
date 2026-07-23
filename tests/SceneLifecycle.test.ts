import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SceneBuildTimeoutError,
  SceneBuildSupersededError,
  SceneLifecycle,
  SceneTeardownTimeoutError,
  type SceneLifecycleState,
} from '../src/app/SceneLifecycle';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const flushUntil = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 20 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SceneLifecycle', () => {
  it('sérialise les transitions et ne construit que la dernière cible du teardown', async () => {
    const teardownA = deferred();
    const buildC = deferred();
    const buildD = deferred();
    const states: SceneLifecycleState[] = [];
    const built: string[] = [];
    let teardownCalls = 0;
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;

    const lifecycle = new SceneLifecycle<string>({
      teardown: async () => {
        activeCallbacks++;
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
        teardownCalls++;
        if (teardownCalls === 1) await teardownA.promise;
        activeCallbacks--;
      },
      build: async (target) => {
        activeCallbacks++;
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
        built.push(target);
        if (target === 'C') await buildC.promise;
        if (target === 'D') await buildD.promise;
        activeCallbacks--;
      },
      onStateChange: (state) => states.push(state),
    });

    lifecycle.request('A');
    expect(lifecycle.state).toBe('tearingDown');
    lifecycle.request('B');
    lifecycle.request('C');
    expect(teardownCalls).toBe(1);

    teardownA.resolve();
    await flushMicrotasks();
    expect(lifecycle.state).toBe('building');
    expect(built).toEqual(['C']);

    lifecycle.request('D');
    buildC.resolve();
    await flushUntil(() => built.includes('D'));
    expect(teardownCalls).toBe(2);
    expect(built).toEqual(['C', 'D']);
    expect(lifecycle.state).toBe('building');

    buildD.resolve();
    await lifecycle.whenIdle();
    expect(lifecycle.state).toBe('idle');
    expect(maxActiveCallbacks).toBe(1);
    expect(states).toEqual([
      'tearingDown',
      'building',
      'idle',
      'tearingDown',
      'building',
      'idle',
    ]);
  });

  it('débounce le sélecteur et fait attendre whenIdle jusqu’au build', async () => {
    vi.useFakeTimers();
    const built: string[] = [];
    const lifecycle = new SceneLifecycle<string>({
      selectorDebounceMs: 200,
      teardown: () => undefined,
      build: (target) => {
        built.push(target);
      },
    });

    lifecycle.requestFromSelector('robe');
    let settled = false;
    const idle = lifecycle.whenIdle().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(150);
    lifecycle.requestFromSelector('t-shirt');
    await vi.advanceTimersByTimeAsync(199);
    expect(built).toEqual([]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await idle;
    expect(built).toEqual(['t-shirt']);
    expect(lifecycle.state).toBe('idle');
  });

  it('annule un build au checkpoint puis enchaîne sur la dernière demande', async () => {
    const buildGate = deferred();
    const completed: string[] = [];
    const errors: unknown[] = [];
    let firstSignal: AbortSignal | undefined;

    const lifecycle = new SceneLifecycle<string>({
      teardown: () => undefined,
      build: async (target, context) => {
        if (target === 'ancienne') {
          firstSignal = context.signal;
          await buildGate.promise;
          await context.checkpoint();
        }
        completed.push(target);
      },
      onError: (error) => errors.push(error),
    });

    lifecycle.request('ancienne');
    await flushMicrotasks();
    expect(lifecycle.state).toBe('building');
    lifecycle.request('nouvelle');
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBeInstanceOf(SceneBuildSupersededError);

    buildGate.resolve();
    await lifecycle.whenIdle();
    expect(completed).toEqual(['nouvelle']);
    expect(errors).toEqual([]);
    expect(lifecycle.state).toBe('idle');
  });

  it('collecte les métriques après teardown et pour chaque tentative de build', async () => {
    const clock = [10, 25, 40, 49];
    let liveBuffers = 8;
    const lifecycle = new SceneLifecycle<string>({
      teardown: () => undefined,
      build: () => undefined,
      getLiveBufferCount: () => liveBuffers--,
      now: () => clock.shift() ?? 49,
    });

    lifecycle.request('A');
    await lifecycle.whenIdle();
    lifecycle.request('B');
    await lifecycle.whenIdle();

    expect(lifecycle.metrics.buildTimesMs).toEqual([15, 9]);
    expect(lifecycle.metrics.liveBuffersAfterEach).toEqual([8, 7]);
    lifecycle.resetMetrics();
    expect(lifecycle.metrics).toEqual({
      buildTimesMs: [],
      liveBuffersAfterEach: [],
    });
  });

  it('revient à idle après une erreur de teardown ou de build', async () => {
    const errors: Array<{ phase: string; target: string }> = [];
    const lifecycle = new SceneLifecycle<string>({
      teardown: ({ target }) => {
        if (target === 'teardown-error') throw new Error('teardown');
      },
      build: (target) => {
        if (target === 'build-error') throw new Error('build');
      },
      onError: (_error, context) => {
        errors.push({ phase: context.phase, target: context.target });
      },
    });

    lifecycle.request('teardown-error');
    await lifecycle.whenIdle();
    expect(lifecycle.state).toBe('idle');

    lifecycle.request('build-error');
    await lifecycle.whenIdle();
    expect(lifecycle.state).toBe('idle');
    expect(errors).toEqual([
      { phase: 'teardown', target: 'teardown-error' },
      { phase: 'build', target: 'build-error' },
    ]);
  });

  it('isole les erreurs du compteur et des observateurs sans bloquer la file', async () => {
    const phases: string[] = [];
    const lifecycle = new SceneLifecycle<string>({
      teardown: () => undefined,
      build: () => undefined,
      getLiveBufferCount: () => {
        throw new Error('diagnostic indisponible');
      },
      onStateChange: () => {
        throw new Error('observer UI');
      },
      onError: (_error, context) => phases.push(context.phase),
    });

    lifecycle.request('atelier');
    await lifecycle.whenIdle();
    expect(phases).toEqual(['liveBuffers']);
    expect(lifecycle.state).toBe('idle');
  });

  it('borne un build qui ne se résout jamais, l’aborte et revient à idle', async () => {
    vi.useFakeTimers();
    const errors: Array<{ error: unknown; phase: string; target: string }> = [];
    let buildSignal: AbortSignal | undefined;
    const lifecycle = new SceneLifecycle<string>({
      teardown: () => undefined,
      build: (_target, context) => {
        buildSignal = context.signal;
        return new Promise<void>(() => {});
      },
      onError: (error, context) => errors.push({
        error,
        phase: context.phase,
        target: context.target,
      }),
    });

    lifecycle.request('tenue');
    const idle = lifecycle.whenIdle();
    await flushMicrotasks();
    expect(lifecycle.state).toBe('building');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(lifecycle.state).toBe('building');

    await vi.advanceTimersByTimeAsync(1);
    await idle;
    expect(lifecycle.state).toBe('idle');
    expect(buildSignal?.aborted).toBe(true);
    expect(buildSignal?.reason).toBeInstanceOf(SceneBuildTimeoutError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: 'build', target: 'tenue' });
    expect(errors[0]!.error).toBeInstanceOf(SceneBuildTimeoutError);
    expect((errors[0]!.error as SceneBuildTimeoutError).timeoutMs).toBe(15_000);
  });

  it('borne un teardown qui ne se résout jamais sans lancer le build', async () => {
    vi.useFakeTimers();
    const built = vi.fn();
    const errors: unknown[] = [];
    const lifecycle = new SceneLifecycle<string>({
      teardownTimeoutMs: 80,
      teardown: () => new Promise<void>(() => {}),
      build: built,
      onError: (error) => errors.push(error),
    });

    lifecycle.request('ensemble');
    const idle = lifecycle.whenIdle();
    expect(lifecycle.state).toBe('tearingDown');
    await vi.advanceTimersByTimeAsync(79);
    expect(lifecycle.state).toBe('tearingDown');

    await vi.advanceTimersByTimeAsync(1);
    await idle;
    expect(lifecycle.state).toBe('idle');
    expect(built).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SceneTeardownTimeoutError);
    expect((errors[0] as SceneTeardownTimeoutError).timeoutMs).toBe(80);
  });

  it('enchaîne la dernière demande après timeout et ignore la fin tardive de l’ancien build', async () => {
    vi.useFakeTimers();
    const lateBuild = deferred();
    const started: string[] = [];
    const completed: string[] = [];
    const errors: unknown[] = [];
    const lifecycle = new SceneLifecycle<string>({
      buildTimeoutMs: 100,
      teardown: () => undefined,
      build: async (target, context) => {
        started.push(target);
        if (target === 'ancienne') {
          await lateBuild.promise;
          await context.checkpoint();
        }
        completed.push(target);
      },
      onError: (error) => errors.push(error),
    });

    lifecycle.request('ancienne');
    await flushMicrotasks();
    lifecycle.request('nouvelle');
    const idle = lifecycle.whenIdle();
    await vi.advanceTimersByTimeAsync(100);
    await idle;

    expect(started).toEqual(['ancienne', 'nouvelle']);
    expect(completed).toEqual(['nouvelle']);
    expect(lifecycle.state).toBe('idle');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SceneBuildTimeoutError);

    lateBuild.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(completed).toEqual(['nouvelle']);
    expect(lifecycle.state).toBe('idle');
    expect(errors).toHaveLength(1);
  });
});
