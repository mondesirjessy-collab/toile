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
  /** Sphere colliders to visualize (a dress form is a stack of them). */
  spheres: { center: [number, number, number]; radius: number }[];
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

  // --- UV spheres (one per collider) ---
  const rings = 32;
  const sectors = 48;
  const sphereColor: [number, number, number] = [0.45, 0.49, 0.58];
  for (const sphere of p.spheres) {
    const [cx, cy, cz] = sphere.center;
    const r = sphere.radius;
    const base = vertices.length / SCENE_VERTEX_FLOATS;
    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI; // 0..π (pole to pole)
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      for (let sec = 0; sec <= sectors; sec++) {
        const theta = (sec / sectors) * Math.PI * 2;
        const nx = sinP * Math.cos(theta);
        const ny = cosP;
        const nz = sinP * Math.sin(theta);
        push([cx + r * nx, cy + r * ny, cz + r * nz], [nx, ny, nz], sphereColor);
      }
    }
    const stride = sectors + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let sec = 0; sec < sectors; sec++) {
        const a = base + ring * stride + sec;
        const b = a + stride;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
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
