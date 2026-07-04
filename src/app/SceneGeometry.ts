/**
 * SceneGeometry — static collider meshes (sphere + ground) for the milestone 5-6
 * scene. Purely visual: the solver has its own analytic sphere/ground in the
 * collide pass; this just lets the viewer SEE what the cloth drapes onto.
 *
 * One interleaved vertex buffer, 9 floats/vertex: position(3), normal(3),
 * color(3), consumed by the lit pass in PointsRenderer. Baked in world space
 * (the colliders don't move), so no per-object model matrix is needed.
 */
export const SCENE_VERTEX_FLOATS = 9;

export interface SceneMesh {
  vertices: Float32Array; // interleaved pos3, normal3, color3
  indices: Uint32Array;
}

export interface SceneParams {
  /** Capsule/sphere colliders to visualize (a mannequin is a handful of them). */
  colliders: { a: [number, number, number]; b?: [number, number, number]; radius: number }[];
  groundY: number;
  groundHalfSize?: number;
}

export function buildSceneMesh(p: SceneParams): SceneMesh {
  const vertices: number[] = [];
  const indices: number[] = [];

  const push = (
    pos: [number, number, number],
    nrm: [number, number, number],
    col: [number, number, number],
  ): number => {
    const idx = vertices.length / SCENE_VERTEX_FLOATS;
    vertices.push(pos[0], pos[1], pos[2], nrm[0], nrm[1], nrm[2], col[0], col[1], col[2]);
    return idx;
  };

  // --- Capsules (split-sphere technique: the unit sphere's upper hemisphere
  // anchors to endpoint b, the lower one to a, normals unchanged). A sphere is
  // just the degenerate case a = b. Local frame: "up" = the capsule axis.
  const rings = 32;
  const sectors = 48;
  const bodyColor: [number, number, number] = [0.45, 0.49, 0.58];
  for (const col of p.colliders) {
    const a = col.a;
    const b = col.b ?? col.a;
    const r = col.radius;
    // Orthonormal frame with `up` along the capsule axis (fallback +Y).
    let up: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(up[0], up[1], up[2]);
    up = len > 1e-6 ? [up[0] / len, up[1] / len, up[2] / len] : [0, 1, 0];
    const ref: [number, number, number] = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let side: [number, number, number] = [
      up[1] * ref[2] - up[2] * ref[1],
      up[2] * ref[0] - up[0] * ref[2],
      up[0] * ref[1] - up[1] * ref[0],
    ];
    const sl = Math.hypot(side[0], side[1], side[2]);
    side = [side[0] / sl, side[1] / sl, side[2] / sl];
    const fwd: [number, number, number] = [
      up[1] * side[2] - up[2] * side[1],
      up[2] * side[0] - up[0] * side[2],
      up[0] * side[1] - up[1] * side[0],
    ];

    const base = vertices.length / SCENE_VERTEX_FLOATS;
    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI; // 0..π (pole to pole)
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      for (let sec = 0; sec <= sectors; sec++) {
        const theta = (sec / sectors) * Math.PI * 2;
        const lx = sinP * Math.cos(theta);
        const ly = cosP;
        const lz = sinP * Math.sin(theta);
        // Local normal → world via the frame.
        const n: [number, number, number] = [
          side[0] * lx + up[0] * ly + fwd[0] * lz,
          side[1] * lx + up[1] * ly + fwd[1] * lz,
          side[2] * lx + up[2] * ly + fwd[2] * lz,
        ];
        const c = ly >= 0 ? b : a; // upper half on b, lower half on a
        push([c[0] + r * n[0], c[1] + r * n[1], c[2] + r * n[2]], n, bodyColor);
      }
    }
    const stride = sectors + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let sec = 0; sec < sectors; sec++) {
        const i0 = base + ring * stride + sec;
        const i1 = i0 + stride;
        indices.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
      }
    }
  }

  // --- Ground quad (y = groundY, facing up) ---
  const h = p.groundHalfSize ?? 4.0;
  const g = p.groundY;
  const up: [number, number, number] = [0, 1, 0];
  const groundColor: [number, number, number] = [0.18, 0.19, 0.22];
  const g0 = push([-h, g, -h], up, groundColor);
  const g1 = push([h, g, -h], up, groundColor);
  const g2 = push([h, g, h], up, groundColor);
  const g3 = push([-h, g, h], up, groundColor);
  indices.push(g0, g2, g1, g0, g3, g2);

  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
