// integrate.wgsl — Milestone 1 (weeks 1–2)
// Semi-implicit Euler prediction step of the XPBD loop, plus a temporary
// ground bounce so the particle rain is visually verifiable.
// In milestone 2 the bounce is removed: ground contact becomes a proper
// collision constraint and this pass only predicts positions.

struct SimParams {
  dt: f32,           // substep duration (seconds)
  gravity: f32,      // signed Y acceleration (m/s^2), typically -9.81
  ground_y: f32,     // ground plane height
  restitution: f32,  // bounce energy kept on ground impact [0..1]
  particle_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(4) var<storage, read> inv_masses: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }

  let w = inv_masses[i];
  if (w == 0.0) { return; } // pinned particle

  var v = velocities[i].xyz;
  var x = positions[i].xyz;

  // Predict
  v.y += params.gravity * params.dt;
  prev_positions[i] = vec4f(x, 0.0);
  x += v * params.dt;

  // Temporary ground bounce (milestone 1 only)
  if (x.y < params.ground_y) {
    x.y = params.ground_y;
    v.y = -v.y * params.restitution;
    v.x *= 0.98; // crude friction so the pile settles
    v.z *= 0.98;
  }

  positions[i] = vec4f(x, 0.0);
  velocities[i] = vec4f(v, 0.0);
}
