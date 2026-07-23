// collisionAudit.wgsl — DEV one-shot readback of the exact body field used by
// collide.wgsl. This shader never participates in step(); it is dispatched only
// when the collision QA hook explicitly asks for a snapshot.

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
  cloth_spacing: f32,
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
  _c4: f32,
  layer_gap: f32,
  anchor_stiffness: f32,
  max_layer: f32,
  compliance_bend_warp: f32,
  friction_dynamic: f32,
  air_drag: f32,
  stretch_limit: f32,
  shear_limit: f32,
};

// World → body space (inverse podium turn) and back.
fn to_body(p: vec3f) -> vec3f {
  return vec3f(params.spin_cos * p.x + params.spin_sin * p.z, p.y, -params.spin_sin * p.x + params.spin_cos * p.z);
}
fn to_world(v: vec3f) -> vec3f {
  return vec3f(params.spin_cos * v.x - params.spin_sin * v.z, v.y, params.spin_sin * v.x + params.spin_cos * v.z);
}

// Round cone: segment a→b, radius ra at a, rb at b. Sphere when a = b.
// s squashes per axis about the midpoint (components ≤ 1, ellipse sections);
// bound = world bounding-sphere radius about the midpoint (fast reject).
struct Prim {
  a_ra: vec4f,
  b_rb: vec4f,
  s_bound: vec4f,
};

struct FabricMaterial {
  in_plane: vec4f,
  limits_mass: vec4f,
  contact_motion: vec4f,
  friction_crease: vec4f,
};

struct AuditSample {
  // World-space particle position + raw signed body distance, all in metres.
  position_distance: vec4f,
  // x = exact per-particle contact offset used by collide.wgsl;
  // y = current inverse mass (zero means collision-inactive).
  contact: vec4f,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> colliders: array<Prim>;
@group(0) @binding(3) var sdf_tex: texture_3d<f32>;
@group(0) @binding(4) var<storage, read> layers: array<f32>;
@group(0) @binding(5) var<storage, read> material_ids: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<FabricMaterial>;
@group(0) @binding(7) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(8) var<storage, read_write> audit_samples: array<AuditSample>;

// Manual trilinear sample + the interpolant's exact gradient from the same
// 8 corners (no filterable-float feature needed). Returns vec4(grad, dist).
fn grid_sample(p: vec3f) -> vec4f {
  let dims = vec3f(textureDimensions(sdf_tex, 0));
  let cell = (params.body_max - params.body_min) / (dims - 1.0);
  let g = (p - params.body_min) / cell;
  let i0 = clamp(vec3i(floor(g)), vec3i(0), vec3i(dims) - vec3i(2));
  let f = clamp(g - vec3f(i0), vec3f(0.0), vec3f(1.0));
  let c000 = textureLoad(sdf_tex, i0, 0).r;
  let c100 = textureLoad(sdf_tex, i0 + vec3i(1, 0, 0), 0).r;
  let c010 = textureLoad(sdf_tex, i0 + vec3i(0, 1, 0), 0).r;
  let c110 = textureLoad(sdf_tex, i0 + vec3i(1, 1, 0), 0).r;
  let c001 = textureLoad(sdf_tex, i0 + vec3i(0, 0, 1), 0).r;
  let c101 = textureLoad(sdf_tex, i0 + vec3i(1, 0, 1), 0).r;
  let c011 = textureLoad(sdf_tex, i0 + vec3i(0, 1, 1), 0).r;
  let c111 = textureLoad(sdf_tex, i0 + vec3i(1, 1, 1), 0).r;
  let cx00 = mix(c000, c100, f.x);
  let cx10 = mix(c010, c110, f.x);
  let cx01 = mix(c001, c101, f.x);
  let cx11 = mix(c011, c111, f.x);
  let d = mix(mix(cx00, cx10, f.y), mix(cx01, cx11, f.y), f.z);
  let gx = mix(mix(c100 - c000, c110 - c010, f.y), mix(c101 - c001, c111 - c011, f.y), f.z) / cell.x;
  let gy = mix(mix(c010 - c000, c110 - c100, f.x), mix(c011 - c001, c111 - c101, f.x), f.z) / cell.y;
  let gz = mix(mix(c001 - c000, c101 - c100, f.x), mix(c011 - c010, c111 - c110, f.x), f.y) / cell.z;
  return vec4f(gx, gy, gz, d);
}

fn sd_round_cone(p0: vec3f, prim: Prim) -> f32 {
  let a = prim.a_ra.xyz;
  let b = prim.b_rb.xyz;
  let ra = prim.a_ra.w;
  let rb = prim.b_rb.w;
  // Ellipse squash: unscale the point about the midpoint, rescale the result
  // by min(s) — conservative ellipsoid distance (exact on-axis).
  let s = prim.s_bound.xyz;
  let c = (a + b) * 0.5;
  let p = c + (p0 - c) / s;
  let s_min = min(s.x, min(s.y, s.z));
  let ba = b - a;
  let l2 = dot(ba, ba);
  let rr = ra - rb;
  let a2 = l2 - rr * rr;
  let pa = p - a;
  // Degenerate: zero-length segment, or one end sphere inside the other.
  if (l2 < 1e-12 || a2 <= 1e-12) {
    return min(length(pa) - ra, length(p - b) - rb) * s_min;
  }
  let il2 = 1.0 / l2;
  let y = dot(pa, ba);
  let z = y - l2;
  let xv = pa * l2 - ba * y;
  let x2 = dot(xv, xv);
  let y2 = y * y * l2;
  let z2 = z * z * l2;
  let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) { return (sqrt(x2 + z2) * il2 - rb) * s_min; }
  if (sign(y) * a2 * y2 < k) { return (sqrt(x2 + y2) * il2 - ra) * s_min; }
  return ((sqrt(x2 * a2 * il2) + y * rr) * il2 - ra) * s_min;
}

// Polynomial smooth minimum; k = 0 degenerates to a hard min.
fn smin(a: f32, b: f32, k: f32) -> f32 {
  if (k < 1e-6) { return min(a, b); }
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn sd_body(p: vec3f) -> f32 {
  // Beyond this distance a primitive cannot influence the contact test (its
  // smin contribution stays above the largest layered offset), so skip it. The
  // margin must cover the DEEPEST layer's contact offset (thickness + L·gap);
  // max(2, max_layer) keeps the historical 2-gap slack for shallow stacks
  // (identical drape ≤ layer 1) and grows it for a 4+ garment stack (M4).
  let margin = params.cloth_thickness + max(2.0, params.max_layer) * params.layer_gap + params.blend_k + 0.012;
  var d = 1e9;
  for (var s = 0u; s < params.collider_count; s++) {
    let prim = colliders[s];
    let c = (prim.a_ra.xyz + prim.b_rb.xyz) * 0.5;
    let reach = prim.s_bound.w + margin;
    let pc = p - c;
    if (dot(pc, pc) > reach * reach) { continue; }
    d = smin(d, sd_round_cone(p, prim), params.blend_k);
  }
  return d;
}

fn body_distance(p: vec3f) -> f32 {
  if (params.use_grid == 1u) {
    if (all(p > params.body_min) && all(p < params.body_max)) {
      return grid_sample(p).w;
    }
    return 1e9;
  }
  if (params.collider_count > 0u
      && all(p > params.body_min) && all(p < params.body_max)) {
    return sd_body(p);
  }
  return 1e9;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  let position = positions[i].xyz;
  let distance = body_distance(to_body(position));
  let material = materials[material_ids[i]];
  let contact_offset = material.contact_motion.x + layers[i] * params.layer_gap;
  audit_samples[i].position_distance = vec4f(position, distance);
  audit_samples[i].contact = vec4f(contact_offset, inv_masses[i], 0.0, 0.0);
}
