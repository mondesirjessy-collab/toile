// distance.wgsl — Milestone 5-6, XPBD distance projection for BOTH the
// structural/shear (stretch) and skip-2 (bending) constraints (brief §3.2 step 2,
// §3.3). One dispatch per graph color: all constraints in a color are
// vertex-disjoint, so their position writes never race.
//
// Compliance is per-constraint (packed in the Constraint struct): structural/shear
// use α ≈ 0 (quasi-inextensible), bending uses a larger α_bend so the sheet folds.
//   Δλ = -C / (w_i + w_j + α̃),   α̃ = compliance / dt².

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
  particle_count: u32,
  damping: f32,
  max_speed: f32,
  cloth_thickness: f32,
};

struct Constraint {
  i: u32,
  j: u32,
  rest: f32,
  compliance: f32,
};

struct Batch {
  offset: u32,
  count: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(3) var<storage, read> constraints: array<Constraint>;
@group(0) @binding(4) var<uniform> batch: Batch;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= batch.count) { return; }

  let c = constraints[batch.offset + k];
  let wi = inv_masses[c.i];
  let wj = inv_masses[c.j];
  let wsum = wi + wj;
  if (wsum == 0.0) { return; } // both endpoints pinned

  let xi = positions[c.i].xyz;
  let xj = positions[c.j].xyz;
  let d = xi - xj;
  let len = length(d);
  if (len < 1e-8) { return; }

  let n = d / len;
  let cval = len - c.rest;
  let alpha = c.compliance / (params.dt * params.dt);
  let dlambda = -cval / (wsum + alpha);
  let corr = dlambda * n;

  positions[c.i] = vec4f(xi + wi * corr, 0.0);
  positions[c.j] = vec4f(xj - wj * corr, 0.0);
}
