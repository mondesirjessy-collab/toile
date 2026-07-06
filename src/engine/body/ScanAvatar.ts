/**
 * ScanAvatar — loads a scanned human avatar baked by tools/bake.py:
 *   <base>.mesh.bin : uint32 vertCount, uint32 triCount, pos f32x3*V,
 *                     normal f32x3*V, idx u32x3*T   (render mesh, ~60k tris)
 *   <base>.sdf.bin  : uint32 nx,ny,nz, f32 min[3], f32 max[3],
 *                     int16 sdf_mm[nx*ny*nz]        (x fastest, then y, then z)
 * The mesh is what you see; the grid is what the cloth feels. Both were baked
 * from the same CC0 source (Blender Studio "realistic male" via Wikimedia).
 */
import type { V3 } from './BodySdf';

export interface ScanAvatar {
  mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
  grid: { dims: [number, number, number]; min: V3; max: V3; data: Float32Array };
}

export async function loadScanAvatar(base: string): Promise<ScanAvatar | null> {
  try {
    const load = async (url: string): Promise<ArrayBuffer> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.arrayBuffer();
    };
    const meshBuf = await load(`${base}.mesh.bin`);
    const sdfBuf = await load(`${base}.sdf.bin`);

    const mv = new DataView(meshBuf);
    const vertCount = mv.getUint32(0, true);
    const triCount = mv.getUint32(4, true);
    let off = 8;
    const positions = new Float32Array(meshBuf, off, vertCount * 3);
    off += vertCount * 12;
    const normals = new Float32Array(meshBuf, off, vertCount * 3);
    off += vertCount * 12;
    const indices = new Uint32Array(meshBuf, off, triCount * 3);

    const sv = new DataView(sdfBuf);
    const nx = sv.getUint32(0, true);
    const ny = sv.getUint32(4, true);
    const nz = sv.getUint32(8, true);
    const min: V3 = [sv.getFloat32(12, true), sv.getFloat32(16, true), sv.getFloat32(20, true)];
    const max: V3 = [sv.getFloat32(24, true), sv.getFloat32(28, true), sv.getFloat32(32, true)];
    const mm = new Int16Array(sdfBuf, 36, nx * ny * nz);
    const data = new Float32Array(mm.length);
    for (let i = 0; i < mm.length; i++) data[i] = mm[i]! / 1000; // mm → m

    return { mesh: { positions, normals, indices }, grid: { dims: [nx, ny, nz], min, max, data } };
  } catch (e) {
    console.warn('[toile] avatar scanné indisponible:', e);
    return null;
  }
}
