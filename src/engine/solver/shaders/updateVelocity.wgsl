// updateVelocity.wgsl — Milestone 3, XPBD velocity update (brief §3.2 step 4).
// After the constraint solve has moved positions, derive velocity from the net
// displacement over the substep, apply light damping, and clamp speed for
// stability (S3). A minimal ground clamp stands in for the real collision pass
// (brief §3.2 step 3), which lands with sphere/ground collision in weeks 5-6.

struct SimParams {
  dt: f32,
  gravity: f32,
  ground_y: f32,
  compliance: f32,
  ray_origin: vec3f,
  mouse_force: f32,
  ray_dir: vec3f,
  mouse_radius: f32,
  particle_count: u32,
  damping: f32,
  max_speed: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
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

  var x = positions[i].xyz;

  // Minimal ground collision (temporary until the weeks 5-6 collide pass).
  if (x.y < params.ground_y) {
    x.y = params.ground_y;
    positions[i] = vec4f(x, 0.0);
  }

  var v = (x - prev_positions[i].xyz) / params.dt;

  // Light damping then hard speed clamp for stability.
  v *= max(0.0, 1.0 - params.damping * params.dt);
  let speed = length(v);
  if (speed > params.max_speed) { v *= params.max_speed / speed; }

  velocities[i] = vec4f(v, 0.0);
}
