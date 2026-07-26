export type SceneLifecycleState = 'idle' | 'tearingDown' | 'building';

export type SceneLifecycleErrorPhase =
  | 'teardown'
  | 'build'
  | 'liveBuffers'
  | 'watchdog';

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
  /**
   * Ultimate backstop against SILENT wedges (TOILE-22) : if one drain
   * iteration has not settled after this delay, a `SceneTransitionStallError`
   * is reported through `onError` (phase `watchdog`) so the host can roll
   * back; a second firing one delay later signals that even the rollback
   * cannot be drained. Defaults to teardown + build timeouts + 10 s; derived
   * default is disabled when either phase guard is disabled. Non-positive
   * disables it.
   */
  watchdogTimeoutMs?: number;
  /**
   * Maximum time allowed for `getLiveBufferCount` before the metric is
   * abandoned (reported as phase `liveBuffers`, never fatal). This was the
   * only unbounded await of the drain loop. Defaults to 5 seconds.
   */
  liveBufferTimeoutMs?: number;
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

/**
 * The transition watchdog: one drain iteration failed to settle within its
 * deadline through a path the phase timeouts do not cover. Reported via
 * `onError` (phase `watchdog`) so the host recovery ladder stays in charge.
 */
export class SceneTransitionStallError extends Error {
  constructor(
    readonly elapsedMs: number,
    readonly stuckState: SceneLifecycleState,
  ) {
    super(`Scene transition stalled for ${elapsedMs} ms (state: ${stuckState})`);
    this.name = 'SceneTransitionStallError';
  }
}

/**
 * Re-entrant requests (fired from inside lifecycle callbacks) aborted several
 * consecutive builds before they could start: the machine is spinning without
 * ever committing a scene. Detected structurally — no timer involved.
 */
export class SceneTransitionChurnError extends Error {
  constructor(readonly skippedBuilds: number) {
    super(
      `Scene transitions are churning: ${skippedBuilds} consecutive builds `
      + 'were aborted before they could start',
    );
    this.name = 'SceneTransitionChurnError';
  }
}

const DEFAULT_PHASE_TIMEOUT_MS = 15_000;
const DEFAULT_LIVE_BUFFER_TIMEOUT_MS = 5_000;
const WATCHDOG_DEFAULT_MARGIN_MS = 10_000;
const MAX_CONSECUTIVE_SKIPPED_BUILDS = 8;

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
  private stallTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private consecutiveSkippedBuilds = 0;

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
      this.clearStallWatchdog();
      this.consecutiveSkippedBuilds = 0;
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
      // Armed BEFORE any callback can run: even a hang inside an observer or
      // an unforeseen await path is converted into a visible watchdog report.
      this.armStallWatchdog(request);
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
        this.clearStallWatchdog();
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
          this.consecutiveSkippedBuilds = 0;
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
        } else {
          // Aborted between controller creation and here: only a re-entrant
          // request fired from inside a lifecycle callback can do that. One
          // occurrence is legal; a streak means the machine spins forever
          // without ever committing a scene (the silent-wedge shape of
          // TOILE-22) — surface it through the host's failure ladder.
          this.noteSkippedBuild(request);
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

      this.clearStallWatchdog();
      this.setState('idle');
    }
  }

  private armStallWatchdog(request: PendingRequest<TTarget>): void {
    this.clearStallWatchdog();
    const timeoutMs = this.resolveStallTimeout();
    if (timeoutMs <= 0) return;
    let fires = 0;
    const fire = (): void => {
      this.stallTimer = null;
      fires++;
      this.reportError(
        new SceneTransitionStallError(timeoutMs * fires, this.currentState),
        'watchdog',
        request,
      );
      // One re-arm: the first report lets the host roll back (its request
      // aborts a stuck build, which often unsticks the drain). If a full
      // deadline later NOTHING has moved, the second report tells the host
      // that even recovery cannot be drained — its ladder must go fatal
      // rather than leave a silent hybrid scene on screen.
      if (fires < 2) this.stallTimer = globalThis.setTimeout(fire, timeoutMs);
    };
    this.stallTimer = globalThis.setTimeout(fire, timeoutMs);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer === null) return;
    globalThis.clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private resolveStallTimeout(): number {
    const explicit = this.options.watchdogTimeoutMs;
    if (explicit !== undefined) {
      return Number.isFinite(explicit) ? Math.max(0, explicit) : 0;
    }
    const teardown = this.resolvePhaseTimeout(this.options.teardownTimeoutMs);
    const build = this.resolvePhaseTimeout(this.options.buildTimeoutMs);
    // A host that explicitly disabled a phase guard accepts unbounded phases;
    // deriving a watchdog there would fire during legitimate long work.
    if (teardown <= 0 || build <= 0) return 0;
    return teardown + build
      + Math.max(0, this.options.liveBufferTimeoutMs ?? DEFAULT_LIVE_BUFFER_TIMEOUT_MS)
      + WATCHDOG_DEFAULT_MARGIN_MS;
  }

  private noteSkippedBuild(request: PendingRequest<TTarget>): void {
    this.consecutiveSkippedBuilds++;
    if (this.consecutiveSkippedBuilds < MAX_CONSECUTIVE_SKIPPED_BUILDS) return;
    const skipped = this.consecutiveSkippedBuilds;
    this.consecutiveSkippedBuilds = 0; // reset so a persistent churn escalates again
    this.reportError(new SceneTransitionChurnError(skipped), 'watchdog', request);
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
      const raw = this.options.liveBufferTimeoutMs;
      const timeoutMs = raw !== undefined && Number.isFinite(raw)
        ? Math.max(0, raw)
        : DEFAULT_LIVE_BUFFER_TIMEOUT_MS;
      // Bounded: this await was the drain's only unbounded suspension point.
      // A hung diagnostic must cost a metric, never the scene machine.
      const count = await this.withTimeout(
        Promise.resolve(this.options.getLiveBufferCount()),
        timeoutMs,
        () => new Error(`getLiveBufferCount n'a pas répondu en ${timeoutMs} ms`),
      );
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
