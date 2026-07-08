/**
 * WebGPU device bootstrap.
 * The engine owns the device; the app layer receives it for rendering.
 * No framework dependency — this file must never import Three.js or DOM helpers.
 */

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
}

export class WebGPUNotSupportedError extends Error {
  constructor(reason: string) {
    super(`WebGPU is not available: ${reason}`);
    this.name = 'WebGPUNotSupportedError';
  }
}

export async function initGpu(): Promise<GpuContext> {
  if (!('gpu' in navigator)) {
    throw new WebGPUNotSupportedError('navigator.gpu is undefined (browser does not expose WebGPU)');
  }

  // Prefer the discrete GPU, but fall back to whatever the machine has: on many
  // integrated-only laptops `high-performance` returns null while the default
  // request succeeds, so requesting only high-performance would lock out a
  // perfectly capable GPU (audit — cross-machine robustness).
  const adapter =
    (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
    (await navigator.gpu.requestAdapter());
  if (!adapter) {
    throw new WebGPUNotSupportedError('no suitable GPU adapter found');
  }

  // Opt into GPU timestamp queries for the perf HUD when the adapter offers them.
  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');

  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize,
        256 * 1024 * 1024,
      ),
    },
  });

  device.lost.then((info) => {
    // Surfaced in the console for now; the app layer may subscribe later.
    console.error(`[toile] GPU device lost: ${info.reason} — ${info.message}`);
  });

  return { adapter, device };
}
