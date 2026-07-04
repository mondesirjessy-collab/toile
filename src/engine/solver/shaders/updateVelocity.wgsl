// updateVelocity.wgsl — Milestone 5-6, XPBD velocity update (brief §3.2 step 4).
// Runs after the constraint solve AND the collide pass, so the displacement it
// reads already reflects contacts: a particle stopped on the sphere/ground gets
// its velocity killed automatically. Applies light damping + a speed clamp for
// stability (S3). Ground/sphere projection now lives in collide.wgsl.

struct SimParams {
  dt: f32,
  gravity: f32,
  ground_y: f32,
  friction: f32,
  ray_origin: vec3f,
  mouse_force: f32,
  ray_dir: vec3f,
  mouse_radius: f32,
  sphere_center: vec3f,
  sphere_radius: f32,
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
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(4) var<storage, read> inv_masses: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }

  if (inv_masses[i] == 0.0) {
    velocities[i] = vec4f(0.0, 0.0, 0.0, 0.0); // pinned
    return;
  }

  var v = (positions[i].xyz - prev_positions[i].xyz) / params.dt;

  // Light damping then hard speed clamp for stability.
  v *= max(0.0, 1.0 - params.damping * params.dt);
  let speed = length(v);
  if (speed > params.max_speed) { v *= params.max_speed / speed; }

  velocities[i] = vec4f(v, 0.0);
}
