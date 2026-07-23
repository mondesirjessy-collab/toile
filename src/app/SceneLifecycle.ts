export type SceneLifecycleState = 'idle' | 'tearingDown' | 'building';

export type SceneLifecycleErrorPhase = 'teardown' | 'build' | 'liveBuffers';

export interface SceneTransitionRequestOptions {
  /**
   * Delay the transition so rapid selector changes collapse into one request.
   * `true` uses `selectorDebounceMs`; a number overrides it for this request.
   */
  debounce?: boolean | number;
}

export interface SceneTeardownContext<TTarget> {
  readonly revision: number;
  readonly target: TTarget;
}

export interface SceneBuildContext {
  readonly revision: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  checkpoint(): Promise<void>;
}

export interface SceneLifecycleErrorContext<TTarget> {
  readonly phase: SceneLifecycleErrorPhase;
  readonly revision: number;
  readonly target: TTarget;
}

export interface SceneLifecycleMetrics {
  readonly buildTimesMs: number[];
  readonly liveBuffersAfterEach: number[];
}

export interface SceneLifecycleOptions<TTarget> {
  teardown(context: SceneTeardownContext<TTarget>): void | Promise<void>;
  build(target: TTarget, context: SceneBuildContext): void | Promise<void>;
  selectorDebounceMs?: number;
  /**
   * Maximum time allowed for one teardown. A non-positive value disables the
   * guard. Defaults to 15 seconds.
   */
  teardownTimeoutMs?: number;
  /**
   * Maximum time allowed for one build. A non-positive value disables the
   * guard. Defaults to 15 seconds. Timing out aborts the build context.
   */
  buildTimeoutMs?: number;
  getLiveBufferCount?: () => number | Promise<number>;
  onStateChange?: (
    state: SceneLifecycleState,
    previous: SceneLifecycleState,
  ) => void;
  onError?: (
    error: unknown,
    context: SceneLifecycleErrorContext<TTarget>,
  ) => void;
  /** Used by tests and by hosts that want a render-frame checkpoint. */
  yieldAtCheckpoint?: () => void | Promise<void>;
  now?: () => number;
}

interface PendingRequest<TTarget> {
  target: TTarget;
  revision: number;
}

/**
 * Expected control-flow signal when a newer scene supersedes an async build.
 * It is intentionally not reported through `onError`.
 */
export class SceneBuildSupersededError extends Error {
  constructor() {
    super('Scene build superseded by a newer request');
    this.name = 'SceneBuildSupersededError';
  }
}

/** A teardown did not settle within its configured lifecycle deadline. */
export class SceneTeardownTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Scene teardown timed out after ${timeoutMs} ms`);
    this.name = 'SceneTeardownTimeoutError';
  }
}

/** A build did not settle within its configured lifecycle deadline. */
export class SceneBuildTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Scene build timed out after ${timeoutMs} ms`);
    this.name = 'SceneBuildTimeoutError';
  }
}

const DEFAULT_PHASE_TIMEOUT_MS = 15_000;

const defaultNow = (): number => {
  if (typeof performance !== 'undefined') return performance.now();
  return Date.now();
};

const defaultCheckpointYield = (): Promise<void> => new Promise((resolve) => {
  globalThis.setTimeout(resolve, 0);
});

/**
 * Serialises scene teardown/build work and keeps only the latest requested target.
 *
 * A running teardown is never cancelled: it first makes the old scene safe. A
 * request received during that teardown replaces the target that will be built.
 * A request received during a build aborts its token; the build may stop at its
 * next `checkpoint()`, after which the coordinator tears down once more and builds
 * the newest target.
 */
export class SceneLifecycle<TTarget> {
  readonly metrics: SceneLifecycleMetrics = {
    buildTimesMs: [],
    liveBuffersAfterEach: [],
  };

  private currentState: SceneLifecycleState = 'idle';
  private pending: PendingRequest<TTarget> | null = null;
  private revision = 0;
  private running = false;
  private debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private activeBuild: AbortController | null = null;
  private idleWaiters = new Set<() => void>();

  constructor(private readonly options: SceneLifecycleOptions<TTarget>) {}

  get state(): SceneLifecycleState {
    return this.currentState;
  }

  get isTransitioning(): boolean {
    return this.currentState !== 'idle';
  }

  get latestRevision(): number {
    return this.revision;
  }

  get pendingTarget(): TTarget | undefined {
    return this.pending?.target;
  }

  /** Enqueue an immediate request unless a debounce is explicitly requested. */
  request(
    target: TTarget,
    requestOptions: SceneTransitionRequestOptions = {},
  ): number {
    const revision = ++this.revision;
    this.pending = { target, revision };

    // Once teardown/build has started, delaying a newer target would leave a
    // half-transitioned scene around. Coalesce it directly into the active run.
    if (this.running) {
      this.clearDebounce();
      this.activeBuild?.abort(new SceneBuildSupersededError());
      return revision;
    }

    const debounceMs = this.resolveDebounceMs(requestOptions.debounce);
    if (debounceMs > 0) {
      this.clearDebounce();
      this.debounceTimer = globalThis.setTimeout(() => {
        this.debounceTimer = null;
        this.kick();
      }, debounceMs);
    } else {
      this.clearDebounce();
      this.kick();
    }

    return revision;
  }

  /** Convenience entry point for the scene selector's default 200 ms debounce. */
  requestFromSelector(target: TTarget): number {
    return this.request(target, { debounce: true });
  }

  /** Resolves only once the coordinator and any debounced request are settled. */
  whenIdle(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  resetMetrics(): void {
    this.metrics.buildTimesMs.length = 0;
    this.metrics.liveBuffersAfterEach.length = 0;
  }

  private resolveDebounceMs(value: boolean | number | undefined): number {
    if (value === undefined || value === false) return 0;
    const requested = value === true
      ? (this.options.selectorDebounceMs ?? 200)
      : value;
    return Number.isFinite(requested) ? Math.max(0, requested) : 0;
  }

  private clearDebounce(): void {
    if (this.debounceTimer === null) return;
    globalThis.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private kick(): void {
    if (this.running || this.debounceTimer !== null || this.pending === null) {
      this.resolveIdleWaitersIfSettled();
      return;
    }

    this.running = true;
    void this.drain().finally(() => {
      this.activeBuild = null;
      this.running = false;
      this.setState('idle');
      if (this.pending !== null && this.debounceTimer === null) this.kick();
      this.resolveIdleWaitersIfSettled();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending !== null) {
      let request = this.takePending();
      this.setState('tearingDown');

      let teardownSucceeded = false;
      try {
        const timeoutMs = this.resolvePhaseTimeout(this.options.teardownTimeoutMs);
        const teardown = this.options.teardown(request);
        await this.withTimeout(
          Promise.resolve(teardown),
          timeoutMs,
          () => new SceneTeardownTimeoutError(timeoutMs),
        );
        teardownSucceeded = true;
      } catch (error) {
        this.reportError(error, 'teardown', request);
      }

      await this.captureLiveBufferCount(request);

      if (!teardownSucceeded) {
        this.setState('idle');
        continue;
      }

      // Requests made while teardown awaited replace the target without causing
      // another teardown: the old scene is already gone at this checkpoint.
      if (this.pending !== null) request = this.takePending();

      const controller = new AbortController();
      this.activeBuild = controller;
      const context = this.createBuildContext(request, controller);
      this.setState('building');

      const startedAt = (this.options.now ?? defaultNow)();
      try {
        if (!controller.signal.aborted) {
          const timeoutMs = this.resolvePhaseTimeout(this.options.buildTimeoutMs);
          const build = this.options.build(request.target, context);
          await this.withTimeout(
            Promise.resolve(build),
            timeoutMs,
            () => {
              const error = new SceneBuildTimeoutError(timeoutMs);
              controller.abort(error);
              return error;
            },
          );
        }
      } catch (error) {
        if (
          error instanceof SceneBuildTimeoutError
          || (!controller.signal.aborted && !(error instanceof SceneBuildSupersededError))
        ) {
          this.reportError(error, 'build', request);
        }
      } finally {
        const finishedAt = (this.options.now ?? defaultNow)();
        this.metrics.buildTimesMs.push(Math.max(0, finishedAt - startedAt));
        if (this.activeBuild === controller) this.activeBuild = null;
      }

      this.setState('idle');
    }
  }

  private takePending(): PendingRequest<TTarget> {
    const request = this.pending;
    if (request === null) {
      throw new Error('SceneLifecycle invariant: no pending request');
    }
    this.pending = null;
    return request;
  }

  private resolvePhaseTimeout(value: number | undefined): number {
    if (value === undefined) return DEFAULT_PHASE_TIMEOUT_MS;
    if (!Number.isFinite(value)) return DEFAULT_PHASE_TIMEOUT_MS;
    return Math.max(0, value);
  }

  private withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutError: () => Error,
  ): Promise<T> {
    if (timeoutMs <= 0) return operation;

    return new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(timeoutError()), timeoutMs);
      operation.then(
        (value) => {
          globalThis.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          globalThis.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private createBuildContext(
    request: PendingRequest<TTarget>,
    controller: AbortController,
  ): SceneBuildContext {
    const isCurrent = (): boolean => (
      !controller.signal.aborted && request.revision === this.revision
    );

    return {
      revision: request.revision,
      signal: controller.signal,
      isCurrent,
      checkpoint: async () => {
        const yieldAtCheckpoint = this.options.yieldAtCheckpoint
          ?? defaultCheckpointYield;
        await yieldAtCheckpoint();
        if (!isCurrent()) throw new SceneBuildSupersededError();
      },
    };
  }

  private async captureLiveBufferCount(
    request: PendingRequest<TTarget>,
  ): Promise<void> {
    if (!this.options.getLiveBufferCount) return;
    try {
      const count = await this.options.getLiveBufferCount();
      if (Number.isFinite(count)) this.metrics.liveBuffersAfterEach.push(count);
    } catch (error) {
      this.reportError(error, 'liveBuffers', request);
    }
  }

  private reportError(
    error: unknown,
    phase: SceneLifecycleErrorPhase,
    request: PendingRequest<TTarget>,
  ): void {
    try {
      this.options.onError?.(error, {
        phase,
        revision: request.revision,
        target: request.target,
      });
    } catch {
      // Diagnostics must never strand the lifecycle outside `idle`.
    }
  }

  private setState(state: SceneLifecycleState): void {
    if (this.currentState === state) return;
    const previous = this.currentState;
    this.currentState = state;
    try {
      this.options.onStateChange?.(state, previous);
    } catch {
      // UI observers are isolated from the transition itself.
    }
  }

  private isSettled(): boolean {
    return (
      !this.running
      && this.currentState === 'idle'
      && this.pending === null
      && this.debounceTimer === null
    );
  }

  private resolveIdleWaitersIfSettled(): void {
    if (!this.isSettled()) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
