// integrate.wgsl — Milestone 3, XPBD predict step (brief §3.2 step 1).
// v += g·dt (+ optional mouse force); x_prev = x; x += v·dt.
// Velocity is NOT written here — it is recomputed from the position delta in
// updateVelocity.wgsl after the constraint solve, which is what makes this XPBD
// (position-based) rather than an explicit integrator.

struct SimParams {
  dt: f32,
  gravity: f32,
  ground_y: f32,
  friction: f32,
  ray_origin: vec3f, // cursor pick ray origin (camera eye), world space
  mouse_force: f32,  // signed peak accel: >0 attract, <0 repel, 0 idle
  ray_dir: vec3f,    // cursor pick ray direction (normalized), world space
  mouse_radius: f32, // radial falloff radius (world units)
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
@group(0) @binding(2) var<storage, read_write> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> velocities: array<vec4f>;
@group(0) @binding(4) var<storage, read> inv_masses: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }

  let x = positions[i].xyz;

  // Pinned particle: frozen. prev = current so its derived velocity is zero.
  if (inv_masses[i] == 0.0) {
    prev_positions[i] = vec4f(x, 0.0);
    return;
  }

  var v = velocities[i].xyz;

  // Gravity
  v.y += params.gravity * params.dt;

  // Radial mouse force toward the closest point on the cursor ray (milestone 2).
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

  // Predict
  prev_positions[i] = vec4f(x, 0.0);
  positions[i] = vec4f(x + v * params.dt, 0.0);
}
