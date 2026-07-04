/**
 * GpuProfiler — separates simulation vs render time using WebGPU timestamp
 * queries (brief §4 HUD: "ms/frame sim vs rendu via timestamps GPU"). A 4-slot
 * query set marks sim begin/end (0,1) and render begin/end (2,3); the solver and
 * renderer attach these to their first/last pass. Each frame we resolve the set
 * and map it back with a little latency (non-blocking).
 *
 * If the adapter lacks 'timestamp-query', `enabled` is false and the caller
 * falls back to CPU frame timing — reported honestly in the HUD.
 */
export class GpuProfiler {
  readonly enabled: boolean;
  private readonly device: GPUDevice;
  private querySet?: GPUQuerySet;
  private resolveBuffer?: GPUBuffer;
  private resultBuffer?: GPUBuffer;
  private mapping = false;
  private lastSimMs = 0;
  private lastRenderMs = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    this.enabled = device.features.has('timestamp-query');
    if (!this.enabled) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
    this.resolveBuffer = device.createBuffer({
      size: 4 * 8, // 4 × u64
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.resultBuffer = device.createBuffer({
      size: 4 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  simSpan(): { querySet: GPUQuerySet; beginIndex: number; endIndex: number } | undefined {
    return this.querySet ? { querySet: this.querySet, beginIndex: 0, endIndex: 1 } : undefined;
  }
  renderSpan(): { querySet: GPUQuerySet; beginIndex: number; endIndex: number } | undefined {
    return this.querySet ? { querySet: this.querySet, beginIndex: 2, endIndex: 3 } : undefined;
  }

  get simMs(): number {
    return this.lastSimMs;
  }
  get renderMs(): number {
    return this.lastRenderMs;
  }

  /** Resolve the frame's timestamps and map them back (call after sim + render submit). */
  resolve(): void {
    if (!this.enabled || !this.querySet || !this.resolveBuffer || !this.resultBuffer) return;
    if (this.mapping) return; // previous read still in flight; skip this frame
    const encoder = this.device.createCommandEncoder({ label: 'ts-resolve' });
    encoder.resolveQuerySet(this.querySet, 0, 4, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, 4 * 8);
    this.device.queue.submit([encoder.finish()]);

    this.mapping = true;
    const buf = this.resultBuffer;
    void buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        // Timestamp values are in nanoseconds.
        const simNs = Number(t[1]! - t[0]!);
        const renderNs = Number(t[3]! - t[2]!);
        if (simNs >= 0) this.lastSimMs = simNs / 1e6;
        if (renderNs >= 0) this.lastRenderMs = renderNs / 1e6;
        this.mapping = false;
      },
      () => {
        this.mapping = false;
      },
    );
  }
}
