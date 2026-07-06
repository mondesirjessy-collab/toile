/**
 * SurfaceNets — dual contouring of a signed distance field, the simple way.
 *
 * One vertex per sign-crossing cell (at the mean of its edge crossings), one
 * quad per sign-crossing grid edge. No marching-cubes tables; normals come
 * from the field gradient, so even a modest grid shades smoothly. Runs once
 * per collider set on the CPU (~100 ms at 96³), then the mesh is cached.
 */
import type { V3 } from '../engine/body/BodySdf';

export interface NetsMesh {
  positions: Float32Array; // xyz per vertex
  normals: Float32Array; // xyz per vertex (unit)
  indices: Uint32Array;
}

export function surfaceNets(
  sdf: (x: number, y: number, z: number) => number,
  normal: (x: number, y: number, z: number) => V3,
  min: V3,
  max: V3,
  cellSize: number,
): NetsMesh {
  const n: [number, number, number] = [0, 0, 0];
  const step: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    n[i] = Math.min(192, Math.max(4, Math.ceil((max[i]! - min[i]!) / cellSize)));
    step[i] = (max[i]! - min[i]!) / n[i]!;
  }
  const [nx, ny, nz] = n;
  const sx = ny + 1;
  const sy = 1;
  const szr = (nx + 1) * (ny + 1); // corner grid strides: idx = k*szr + i*sx + j

  // Sample the field at every grid corner.
  const field = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let k = 0; k <= nz; k++) {
    const z = min[2] + k * step[2];
    for (let i = 0; i <= nx; i++) {
      const x = min[0] + i * step[0];
      for (let j = 0; j <= ny; j++) {
        field[k * szr + i * sx + j] = sdf(x, min[1] + j * step[1], z);
      }
    }
  }
  const F = (i: number, j: number, k: number): number => field[k * szr + i * sx + j * sy]!;

  // One vertex per cell that crosses the surface.
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const cellIdx = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  const positions: number[] = [];
  const normals: number[] = [];

  const CORNERS: [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x edges
    [0, 2], [1, 3], [4, 6], [5, 7], // y edges
    [0, 4], [1, 5], [2, 6], [3, 7], // z edges
  ];

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = CORNERS.map(([ci, cj, ck]) => F(i + ci, j + cj, k + ck));
        let inside = 0;
        for (const v of d) if (v < 0) inside++;
        if (inside === 0 || inside === 8) continue;
        // Vertex = mean of the edge crossings (linear interpolation).
        let px = 0, py = 0, pz = 0, cnt = 0;
        for (const [e0, e1] of EDGES) {
          const d0 = d[e0]!;
          const d1 = d[e1]!;
          if ((d0 < 0) === (d1 < 0)) continue;
          const t = d0 / (d0 - d1);
          const c0 = CORNERS[e0]!;
          const c1 = CORNERS[e1]!;
          px += i + c0[0] + (c1[0] - c0[0]) * t;
          py += j + c0[1] + (c1[1] - c0[1]) * t;
          pz += k + c0[2] + (c1[2] - c0[2]) * t;
          cnt++;
        }
        const wx = min[0] + (px / cnt) * step[0];
        const wy = min[1] + (py / cnt) * step[1];
        const wz = min[2] + (pz / cnt) * step[2];
        cellVert[cellIdx(i, j, k)] = positions.length / 3;
        positions.push(wx, wy, wz);
        const nn = normal(wx, wy, wz);
        normals.push(nn[0], nn[1], nn[2]);
      }
    }
  }

  // One quad per sign-crossing grid edge, joining the 4 cells that share it.
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, dd: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || dd < 0) return;
    if (flip) indices.push(a, b, c, a, c, dd);
    else indices.push(a, c, b, a, dd, c);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d0 = F(i, j, k);
        // Edge along +x from corner (i,j,k): shared by cells (i, j-1..j, k-1..k).
        if (i < nx && j > 0 && k > 0 && (F(i + 1, j, k) < 0) !== (d0 < 0)) {
          quad(
            cellVert[cellIdx(i, j, k)]!, cellVert[cellIdx(i, j - 1, k)]!,
            cellVert[cellIdx(i, j - 1, k - 1)]!, cellVert[cellIdx(i, j, k - 1)]!,
            d0 < 0,
          );
        }
        // Edge along +y: shared by cells (i-1..i, j, k-1..k).
        if (j < ny && i > 0 && k > 0 && (F(i, j + 1, k) < 0) !== (d0 < 0)) {
          quad(
            cellVert[cellIdx(i, j, k)]!, cellVert[cellIdx(i, j, k - 1)]!,
            cellVert[cellIdx(i - 1, j, k - 1)]!, cellVert[cellIdx(i - 1, j, k)]!,
            d0 < 0,
          );
        }
        // Edge along +z: shared by cells (i-1..i, j-1..j, k).
        if (k < nz && i > 0 && j > 0 && (F(i, j, k + 1) < 0) !== (d0 < 0)) {
          quad(
            cellVert[cellIdx(i, j, k)]!, cellVert[cellIdx(i - 1, j, k)]!,
            cellVert[cellIdx(i - 1, j - 1, k)]!, cellVert[cellIdx(i, j - 1, k)]!,
            d0 < 0,
          );
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
