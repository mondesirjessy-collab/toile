// collide.wgsl — contact resolution (brief §3.2 step 3, §3.3), phase 1 update:
// the single analytic sphere became a LIST of sphere colliders so the scene can
// host a dress form (stacked spheres) or any prop. Runs after the constraint
// solve, before the velocity update. Handles:
//   - spheres: if |x - c| < r + thickness, project onto the surface (S4),
//     with simplified Coulomb friction
//   - ground: collision plane with friction
// Friction: decompose the substep displacement (x - x_prev) into normal +
// tangential and damp the tangential part by `friction` ∈ [0,1].

struct SimParams {
  dt: f32,
  gravity: f32,
  ground_y: f32,
  friction: f32,
  ray_origin: vec3f,
  mouse_force: f32,
  ray_dir: vec3f,
  mouse_radius: f32,
  collider_count: u32,
  _c0: f32,
  _c1: f32,
  _c2: f32,
  drag_target: vec3f,
  drag_stiffness: f32,
  compliance_stretch: f32,
  compliance_shear: f32,
  compliance_bend: f32,
  cloth_thickness: f32,
  particle_count: u32,
  damping: f32,
  max_speed: f32,
  drag_index: u32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(4) var<storage, read> colliders: array<vec4f>; // xyz center, w radius

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  if (inv_masses[i] == 0.0) { return; } // pinned

  var x = positions[i].xyz;
  let xp = prev_positions[i].xyz;

  // --- Sphere colliders ---
  for (var s = 0u; s < params.collider_count; s++) {
    let c = colliders[s];
    let dc = x - c.xyz;
    let dist = length(dc);
    let minDist = c.w + params.cloth_thickness;
    if (dist < minDist && dist > 1e-6) {
      let nrm = dc / dist;
      x = c.xyz + nrm * minDist; // project onto surface
      // Friction: damp tangential part of this substep's motion.
      let disp = x - xp;
      let dispN = dot(disp, nrm) * nrm;
      let dispT = disp - dispN;
      x -= dispT * params.friction;
    }
  }

  // --- Ground contact (plane y = ground_y) ---
  let floorY = params.ground_y + params.cloth_thickness;
  if (x.y < floorY) {
    x.y = floorY;
    let disp = x - xp;
    x.x -= disp.x * params.friction;
    x.z -= disp.z * params.friction;
  }

  positions[i] = vec4f(x, 0.0);
}
