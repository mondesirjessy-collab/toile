// collide.wgsl — contact resolution (brief §3.2 step 3, §3.3), phase 2 update:
// the collider list became a smooth-blended SDF of ROUND CONES (a capsule with
// two radii; spheres and capsules are degenerate cases). The whole body is one
// continuous field — shoulders flow into the chest, thighs into the hips — so
// the cloth feels a human silhouette instead of separate sausages.
// Runs after the constraint solve, before the velocity update. Handles:
//   - the body field: if sd(x) < thickness, push out along the field gradient
//     (4-tap tetrahedral), with simplified Coulomb friction
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
  body_min: vec3f,   // collider AABB (early out) / SDF grid domain
  blend_k: f32,      // smooth-min radius; 0 = hard min
  body_max: vec3f,
  use_grid: u32,     // 1 = collide against the baked SDF texture instead
  spin_cos: f32,     // podium turn: body-space rotation about +Y
  spin_sin: f32,
  spin_dtheta: f32,  // podium angle advanced THIS substep (surface velocity)
  _c4: f32,
  layer_gap: f32,    // couches : la couche L est repoussée à thickness + L × gap
  anchor_stiffness: f32, // ceinture : rappel vertical par substep vers anchor_y
  max_layer: f32,    // couche la plus profonde de l'empilement (marge de rejet sd_body, M4)
  compliance_bend_warp: f32,
  friction_dynamic: f32,
  air_drag: f32,
  stretch_limit: f32,
  shear_limit: f32,
};

/** Static friction sticks completely below μs·normal; sliding uses μd. */
fn friction_scale(tangent_len: f32, normal_push: f32, static_mu: f32, dynamic_mu: f32) -> f32 {
  if (tangent_len <= static_mu * normal_push) { return 1.0; }
  return min(1.0, dynamic_mu * normal_push / tangent_len);
}

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
  a_ra: vec4f,    // a.xyz, ra
  b_rb: vec4f,    // b.xyz, rb
  s_bound: vec4f, // s.xyz, bound
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(4) var<storage, read> colliders: array<Prim>;
// Baked SDF of a scanned avatar (meters), spanning body_min..body_max.
@group(0) @binding(5) var sdf_tex: texture_3d<f32>;
// Garment layer per particle (0 = against the body, 1 = worn over 0…).
@group(0) @binding(6) var<storage, read> layers: array<f32>;
// Waistband anchor: target world-Y per particle (sentinel ≤ -1e8 = free).
@group(0) @binding(7) var<storage, read> anchor_y: array<f32>;

struct FabricMaterial {
  in_plane: vec4f,
  limits_mass: vec4f,
  contact_motion: vec4f,
  friction_crease: vec4f,
};
@group(0) @binding(8) var<storage, read> material_ids: array<u32>;
@group(0) @binding(9) var<storage, read> materials: array<FabricMaterial>;

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

// The smooth analytic field is a distance ESTIMATOR after ellipse scaling and
// blending, so its gradient length is not guaranteed to be one either. Return
// a metric gradient for the same bounded Newton projection as the scan grid.
fn analytic_sample(p: vec3f) -> vec4f {
  let e = 0.002;
  let k0 = vec3f(1.0, -1.0, -1.0);
  let k1 = vec3f(-1.0, -1.0, 1.0);
  let k2 = vec3f(-1.0, 1.0, -1.0);
  let k3 = vec3f(1.0, 1.0, 1.0);
  let g = (k0 * sd_body(p + k0 * e) + k1 * sd_body(p + k1 * e)
          + k2 * sd_body(p + k2 * e) + k3 * sd_body(p + k3 * e)) / (4.0 * e);
  return vec4f(g, sd_body(p));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  if (inv_masses[i] == 0.0) { return; } // pinned

  var x = positions[i].xyz;
  let xp = prev_positions[i].xyz;
  let material = materials[material_ids[i]];
  let static_mu = material.contact_motion.w;
  let dynamic_mu = material.friction_crease.x;

  // Dressing order: each garment layer keeps its own distance to the body —
  // the outer one is pushed past where the inner one rests, so stacked
  // garments settle instead of fighting for the same offset surface.
  let thick = material.contact_motion.x + layers[i] * params.layer_gap;

  // Anchors are a dressing force, not a contact. Apply them BEFORE the body
  // query so no positional operator can put a sleeve back inside an arm after
  // the last collision projection of the substep.
  let ay = anchor_y[i];
  if (ay > -1.0e8) {
    x.y += (ay - x.y) * params.anchor_stiffness;
  }

  // Podium: query the body in ITS rotating frame; the surface under the
  // particle moved by dtheta this substep — friction is measured relative
  // to that motion, so the turning mannequin carries its garment along.
  var xb = to_body(x);

  // Continuous body collision for the large corrections made by seams and
  // other PBD constraints. integrate.wgsl limits velocity displacement, but
  // a stitch can still move a vertex several centimetres and finish outside
  // the opposite side of an arm. Sample the swept segment, then bisect the
  // FIRST entry so the vertex stays on its original side. The branch is cold
  // for ordinary drape motion and therefore does not tax settled cloth.
  let travel = distance(x, xp);
  if (travel > 0.45 * params.cloth_spacing) {
    let xTarget = x;
    let xpb = to_body(xp);
    let deltaBody = xb - xpb;
    if (body_distance(xpb) >= thick) {
      let sampleCount = u32(clamp(
        ceil(travel / max(params.cloth_spacing, 0.003)),
        4.0,
        24.0,
      ));
      var outsideFraction = 0.0;
      var insideFraction = -1.0;
      for (var sampleIndex = 1u; sampleIndex <= 24u; sampleIndex++) {
        if (sampleIndex > sampleCount) { break; }
        let fraction = f32(sampleIndex) / f32(sampleCount);
        let samplePoint = xpb + deltaBody * fraction;
        if (body_distance(samplePoint) < thick) {
          insideFraction = fraction;
          break;
        }
        outsideFraction = fraction;
      }
      if (insideFraction > 0.0) {
        var outside = outsideFraction;
        var inside = insideFraction;
        for (var iteration = 0u; iteration < 7u; iteration++) {
          let middle = (outside + inside) * 0.5;
          if (body_distance(xpb + deltaBody * middle) >= thick) {
            outside = middle;
          } else {
            inside = middle;
          }
        }
        x = mix(xp, xTarget, outside);
        xb = to_body(x);
      }
    }
  }
  let surf_du = vec3f(-params.spin_dtheta * x.z, 0.0, params.spin_dtheta * x.x);

  // --- Scanned-avatar SDF grid (trilinear texture) ---
  if (params.use_grid == 1u
      && all(xb > params.body_min) && all(xb < params.body_max)) {
    var touched = false;
    var contact_normal = vec3f(0.0, 1.0, 0.0);
    var normal_push = 0.0;
    let max_correction = max(0.02, 2.0 * params.cloth_spacing);
    // A trilinearly interpolated 3D texture is no longer a true SDF at strong
    // curvature: |grad| measured 0.2–0.9 around neck/shoulders. The old
    // normalize(g)*(thick-d) therefore corrected only that fraction. Two
    // bounded Newton steps land on d=thick without exploding at a flat cell.
    for (var projection = 0u; projection < 2u; projection++) {
      let s = grid_sample(xb);
      if (s.w >= thick) { break; }
      let gl = length(s.xyz);
      if (gl <= 1e-6) { break; }
      let n_body = s.xyz / gl;
      let correction = min((thick - s.w) / max(gl, 0.35), max_correction);
      xb += n_body * correction;
      x = to_world(xb);
      contact_normal = to_world(n_body);
      normal_push += correction;
      touched = true;
    }
    if (touched) {
      let disp = x - xp - surf_du;
      let dispT = disp - dot(disp, contact_normal) * contact_normal;
      let tl = length(dispT);
      if (tl > 1e-9) {
        x -= dispT * friction_scale(tl, normal_push, static_mu, dynamic_mu);
      }
      // Tangential friction on a curved neck can itself re-enter the body.
      // Re-sample once after friction so collision remains the final positional
      // authority of the substep, including against a quasi-rigid collar seam.
      xb = to_body(x);
      let final_sample = grid_sample(xb);
      let final_gl = length(final_sample.xyz);
      if (final_sample.w < thick && final_gl > 1e-6) {
        let final_correction = min(
          (thick - final_sample.w) / max(final_gl, 0.35),
          max_correction,
        );
        xb += (final_sample.xyz / final_gl) * final_correction;
        x = to_world(xb);
      }
    }
  }

  // --- Body field (skip fast when outside the collider AABB) ---
  if (params.collider_count > 0u
      && all(xb > params.body_min) && all(xb < params.body_max)) {
    var touched = false;
    var contact_normal = vec3f(0.0, 1.0, 0.0);
    var normal_push = 0.0;
    let max_correction = max(0.02, 2.0 * params.cloth_spacing);
    for (var projection = 0u; projection < 2u; projection++) {
      let sample = analytic_sample(xb);
      if (sample.w >= thick) { break; }
      let gl = length(sample.xyz);
      if (gl <= 1e-6) { break; }
      let n_body = sample.xyz / gl;
      let correction = min((thick - sample.w) / max(gl, 0.35), max_correction);
      xb += n_body * correction;
      x = to_world(xb);
      contact_normal = to_world(n_body);
      normal_push += correction;
      touched = true;
    }
    if (touched) {
      // Coulomb friction (PBD): slow creep dies completely under the static
      // threshold; sliding stays capped by µd times the actual normal move.
      let disp = x - xp - surf_du;
      let dispT = disp - dot(disp, contact_normal) * contact_normal;
      let tl = length(dispT);
      if (tl > 1e-9) {
        x -= dispT * friction_scale(tl, normal_push, static_mu, dynamic_mu);
      }
      xb = to_body(x);
      let final_sample = analytic_sample(xb);
      let final_gl = length(final_sample.xyz);
      if (final_sample.w < thick && final_gl > 1e-6) {
        let final_correction = min(
          (thick - final_sample.w) / max(final_gl, 0.35),
          max_correction,
        );
        xb += (final_sample.xyz / final_gl) * final_correction;
        x = to_world(xb);
      }
    }
  }

  // --- Ground contact (plane y = ground_y), same Coulomb model ---
  let floorY = params.ground_y + material.contact_motion.x;
  if (x.y < floorY) {
    let push = floorY - x.y;
    x.y = floorY;
    let disp = x - xp;
    let tl = length(disp.xz);
    if (tl > 1e-9) {
      let s = friction_scale(tl, push, static_mu, dynamic_mu);
      x.x -= disp.x * s;
      x.z -= disp.z * s;
    }
  }

  positions[i] = vec4f(x, 0.0);
}
