/**
 * Explicit ownership for GPU resources whose lifetime is one built scene.
 * Pipelines cached per device and borrowed buffers are deliberately excluded.
 */
export interface DestroyableGpuResource {
  destroy(): void;
}

export interface GpuResourceCounts {
  buffers: number;
  textures: number;
  total: number;
}

type ResourceKind = 'buffers' | 'textures';

const live: GpuResourceCounts = { buffers: 0, textures: 0, total: 0 };

export function liveSceneGpuResources(): GpuResourceCounts {
  return { ...live };
}

export class SceneResourceRegistry {
  private readonly owned = new Map<DestroyableGpuResource, ResourceKind>();

  trackBuffer<T extends DestroyableGpuResource>(resource: T): T {
    return this.track(resource, 'buffers');
  }

  trackTexture<T extends DestroyableGpuResource>(resource: T): T {
    return this.track(resource, 'textures');
  }

  release(resource: DestroyableGpuResource | null | undefined): void {
    if (!resource) return;
    const kind = this.owned.get(resource);
    if (!kind) return;
    this.owned.delete(resource);
    try {
      resource.destroy();
    } finally {
      live[kind] = Math.max(0, live[kind] - 1);
      live.total = Math.max(0, live.total - 1);
    }
  }

  dispose(): void {
    for (const resource of [...this.owned.keys()]) this.release(resource);
  }

  get count(): number {
    return this.owned.size;
  }

  private track<T extends DestroyableGpuResource>(resource: T, kind: ResourceKind): T {
    if (this.owned.has(resource)) return resource;
    this.owned.set(resource, kind);
    live[kind]++;
    live.total++;
    return resource;
  }
}
