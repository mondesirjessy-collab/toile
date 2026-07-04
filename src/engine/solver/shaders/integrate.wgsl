// integrate.wgsl — Milestone 2 (mouse interaction)
// Semi-implicit Euler prediction step of the XPBD loop: gravity + a radial
// mouse force, with velocity drag and a speed clamp for stability, plus a
// temporary ground bounce so the particle rain stays visually verifiable.
// In a later milestone the bounce becomes a proper collision constraint and
// this pass only predicts positions.

struct SimParams {
  dt: f32,           // substep duration (seconds)
  gravity: f32,      // signed Y acceleration (m/s^2), typically -9.81
  ground_y: f32,     // ground plane height
  restitution: f32,  // bounce energy kept on ground impact [0..1]
  ray_origin: vec3f, // cursor pick ray origin (camera eye), world space
  mouse_force: f32,  // signed peak accel: >0 attract, <0 repel, 0 idle
  ray_dir: vec3f,    // cursor pick ray direction (normalized), world space
  mouse_radius: f32, // radial falloff radius (world units)
  particle_count: u32,
  damping: f32,      // linear velocity drag rate (1/s)
  max_speed: f32,    // hard speed cap (m/s)
  _pad: f32,
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

  // Gravity
  v.y += params.gravity * params.dt;

  // Radial mouse force toward the closest point on the cursor ray.
  // Attraction (mouse_force > 0) pulls particles onto the ray line; the
  // magnitude falls off with distance so far particles barely feel it.
  if (params.mouse_force != 0.0) {
    let op = x - params.ray_origin;
    let t = max(dot(op, params.ray_dir), 0.0); // clamp: only in front of camera
    let closest = params.ray_origin + params.ray_dir * t;
    let d = closest - x;
    let dist2 = dot(d, d);
    let dist = sqrt(max(dist2, 1e-8));
    let dir = d / dist;
    let r = params.mouse_radius;
    let falloff = (r * r) / (dist2 + r * r * 0.25); // bounded, ~inverse-square
    v += dir * (params.mouse_force * falloff) * params.dt;
  }

  // Stability: linear drag then hard speed clamp.
  v *= max(0.0, 1.0 - params.damping * params.dt);
  let speed = length(v);
  if (speed > params.max_speed) { v *= params.max_speed / speed; }

  // Predict
  prev_positions[i] = vec4f(x, 0.0);
  x += v * params.dt;

  // Temporary ground bounce (removed once collision constraints land)
  if (x.y < params.ground_y) {
    x.y = params.ground_y;
    v.y = -v.y * params.restitution;
    v.x *= 0.98; // crude friction so the pile settles
    v.z *= 0.98;
  }

  positions[i] = vec4f(x, 0.0);
  velocities[i] = vec4f(v, 0.0);
}
