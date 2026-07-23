// dihedral.wgsl — Phase 1, true dihedral bending (brief §3.3).
// One constraint per pair of adjacent triangles: C = acos(n1·n2) − φ0, the
// angle between the two face normals versus its rest value. Gradients follow
// Müller et al. (Position Based Dynamics, appendix A), solved XPBD-style with
// the live `compliance_bend`. One dispatch per hinge color: hinges in a color
// share no particle, so the four position writes never race.

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
  wind_strength: f32,
  wind_time: f32,
  cloth_spacing: f32, // rest distance between grid neighbours
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
  body_min: vec3f,
  blend_k: f32,
  body_max: vec3f,
  use_grid: u32,
  spin_cos: f32,
  spin_sin: f32,
  spin_dtheta: f32,
  compliance_stretch_warp: f32,
  layer_gap: f32,
  anchor_stiffness: f32,
  max_layer: f32,
  compliance_bend_warp: f32,
  friction_dynamic: f32,
  air_drag: f32,
  stretch_limit: f32,
  shear_limit: f32,
  crease_yield: f32,
  crease_memory: f32,
  crease_recovery: f32,
  _material_pad2: f32,
};

struct BendQuad {
  e0: u32,
  e1: u32,
  w0: u32,
  w1: u32,
  rest_angle: f32,
  softness: f32, // compliance multiplier: 1 = fabric bending, >1 = softer (pressing)
  warp_weight: f32, // 0 = weft curvature, 1 = warp/grain curvature
  base_rest_angle: f32,
};

struct Batch {
  offset: u32,
  count: u32,
  _pad0: u32,
  _pad1: u32,
};

struct FabricMaterial {
  in_plane: vec4f,
  limits_mass: vec4f,
  contact_motion: vec4f,
  friction_crease: vec4f,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(3) var<storage, read_write> quads: array<BendQuad>;
@group(0) @binding(4) var<uniform> batch: Batch;
@group(0) @binding(5) var<storage, read> material_ids: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<FabricMaterial>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= batch.count) { return; }

  let quad_index = batch.offset + k;
  let q = quads[quad_index];
  let material = materials[material_ids[q.e0]];
  let w1 = inv_masses[q.e0];
  let w2 = inv_masses[q.e1];
  let w3 = inv_masses[q.w0];
  let w4 = inv_masses[q.w1];
  if (w1 + w2 + w3 + w4 == 0.0) { return; }

  let x1 = positions[q.e0].xyz;
  let p2 = positions[q.e1].xyz - x1;
  let p3 = positions[q.w0].xyz - x1;
  let p4 = positions[q.w1].xyz - x1;

  let c23 = cross(p2, p3);
  let c24 = cross(p2, p4);
  let l23 = length(c23);
  let l24 = length(c24);
  if (l23 < 1e-9 || l24 < 1e-9) { return; }
  let n1 = c23 / l23;
  let n2 = c24 / l24;

  let d = clamp(dot(n1, n2), -1.0, 1.0);
  let c = acos(d) - q.rest_angle;

  let q3 = (cross(p2, n2) + cross(n1, p2) * d) / l23;
  let q4 = (cross(p2, n1) + cross(n2, p2) * d) / l24;
  let q2 = -(cross(p3, n2) + cross(n1, p3) * d) / l23
           - (cross(p4, n1) + cross(n2, p4) * d) / l24;
  let q1 = -(q2 + q3 + q4);

  let denom = w1 * dot(q1, q1) + w2 * dot(q2, q2) + w3 * dot(q3, q3) + w4 * dot(q4, q4);
  if (denom < 1e-9) { return; }

  // The compliance slider is calibrated for DISTANCE constraints (meters);
  // this constraint is an ANGLE (radians), whose gradients scale as
  // 1/spacing. Dividing by spacing² keeps the same slider range meaningful
  // (and resolution-independent): low = leather-stiff, high = chiffon-floppy.
  let sp2 = params.cloth_spacing * params.cloth_spacing;
  let bend_compliance = mix(material.in_plane.w, material.limits_mass.x, clamp(q.warp_weight, 0.0, 1.0));
  let alpha = max(q.softness, 1.0) * bend_compliance / (params.dt * params.dt * max(sp2, 1e-8));
  // Exact XPBD for the acos formulation (audit M2): q1..q4 are gradients of
  // d = n1·n2, so ∇C = −q/√(1−d²) and Σw|∇C|² = denom/(1−d²). The compliance
  // term must therefore carry the same (1−d²) factor as the numerator —
  // dividing by (denom + alpha) alone made bending fold-angle dependent
  // (softer than the dialed compliance, worst near flat). Guard the factor with
  // the same max(…,0) as the numerator so float error can't flip alpha's sign.
  let fold = max(1.0 - d * d, 0.0);
  // Floor the compliance factor near flat (audit — rigidity fix): as d→±1 the
  // exact factor alpha·fold→0, so the projection loses ALL compliance authority
  // and the cloth resists its FIRST small fold at near-full stiffness whatever
  // the slider says — that reads as rigid. Clamp the alpha factor to ≥0.04
  // (caps the near-flat stiffening at ~25× instead of ∞) while the numerator's
  // √fold still vanishes smoothly, so flat stays the rest state and gentle
  // drape keeps the compliance the fabric was dialed to.
  let foldc = max(fold, 0.04);
  let s = -c * sqrt(fold) / (denom + alpha * foldc);

  // Bending hysteresis / crease memory. Once the fold exceeds the material's
  // yield angle, its rest angle follows the fold at a material-specific rate.
  // Recovery then pulls that memory back toward the original rest shape: fast
  // for knits, extremely slow for linen/denim. Reset rewrites the CPU-baked
  // quad buffer, so R also acts as a clean "repassage".
  var remembered = q.rest_angle;
  let yielded = abs(c) - material.friction_crease.y;
  if (yielded > 0.0 && material.friction_crease.z > 0.0) {
    remembered += sign(c) * yielded * min(1.0, material.friction_crease.z * params.dt);
  }
  remembered += (q.base_rest_angle - remembered) * min(1.0, material.friction_crease.w * params.dt);
  quads[quad_index].rest_angle = clamp(remembered, 0.0, 3.14159265);

  positions[q.e0] = vec4f(x1 + s * w1 * q1, 0.0);
  positions[q.e1] = vec4f(x1 + p2 + s * w2 * q2, 0.0);
  positions[q.w0] = vec4f(x1 + p3 + s * w3 * q3, 0.0);
  positions[q.w1] = vec4f(x1 + p4 + s * w4 * q4, 0.0);
}
