import { describe, expect, it } from 'vitest';
import {
  SceneResourceRegistry,
  liveSceneGpuResources,
} from '../src/engine/gpu/SceneResourceRegistry';

describe('registre des ressources GPU par scène', () => {
  it('détruit chaque ressource exactement une fois et garde un compteur stable', () => {
    const before = liveSceneGpuResources();
    const registry = new SceneResourceRegistry();
    let bufferDestroy = 0;
    let textureDestroy = 0;
    const buffer = { destroy: () => bufferDestroy++ };
    const texture = { destroy: () => textureDestroy++ };

    registry.trackBuffer(buffer);
    registry.trackBuffer(buffer); // une même ressource ne se compte pas deux fois
    registry.trackTexture(texture);
    expect(registry.count).toBe(2);
    expect(liveSceneGpuResources()).toEqual({
      buffers: before.buffers + 1,
      textures: before.textures + 1,
      total: before.total + 2,
    });

    registry.release(buffer);
    registry.release(buffer);
    registry.dispose();
    registry.dispose();
    expect(bufferDestroy).toBe(1);
    expect(textureDestroy).toBe(1);
    expect(registry.count).toBe(0);
    expect(liveSceneGpuResources()).toEqual(before);
  });
});
