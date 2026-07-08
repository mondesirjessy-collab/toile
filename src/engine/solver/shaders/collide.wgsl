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
  _c7: f32,
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

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  if (inv_masses[i] == 0.0) { return; } // pinned

  var x = positions[i].xyz;
  let xp = prev_positions[i].xyz;

  // Dressing order: each garment layer keeps its own distance to the body —
  // the outer one is pushed past where the inner one rests, so stacked
  // garments settle instead of fighting for the same offset surface.
  let thick = params.cloth_thickness + layers[i] * params.layer_gap;

  // Podium: query the body in ITS rotating frame; the surface under the
  // particle moved by dtheta this substep — friction is measured relative
  // to that motion, so the turning mannequin carries its garment along.
  let xb = to_body(x);
  let surf_du = vec3f(-params.spin_dtheta * x.z, 0.0, params.spin_dtheta * x.x);

  // --- Scanned-avatar SDF grid (trilinear texture) ---
  if (params.use_grid == 1u
      && all(xb > params.body_min) && all(xb < params.body_max)) {
    let s = grid_sample(xb);
    if (s.w < thick) {
      let gl = length(s.xyz);
      if (gl > 1e-6) {
        let nrm = to_world(s.xyz / gl);
        let push = thick - s.w;
        x += nrm * push;
        let disp = x - xp - surf_du;
        let dispT = disp - dot(disp, nrm) * nrm;
        let tl = length(dispT);
        if (tl > 1e-9) {
          x -= dispT * min(1.0, params.friction * push / tl);
        }
      }
    }
  }

  // --- Body field (skip fast when outside the collider AABB) ---
  if (params.collider_count > 0u
      && all(xb > params.body_min) && all(xb < params.body_max)) {
    let d = sd_body(xb);
    if (d < thick) {
      // Field gradient, 4-tap tetrahedral.
      let e = 0.002;
      let k0 = vec3f(1.0, -1.0, -1.0);
      let k1 = vec3f(-1.0, -1.0, 1.0);
      let k2 = vec3f(-1.0, 1.0, -1.0);
      let k3 = vec3f(1.0, 1.0, 1.0);
      let g = k0 * sd_body(xb + k0 * e) + k1 * sd_body(xb + k1 * e)
            + k2 * sd_body(xb + k2 * e) + k3 * sd_body(xb + k3 * e);
      let gl = length(g);
      if (gl > 1e-6) {
        let nrm = to_world(g / gl);
        let push = thick - d;
        x += nrm * push; // project onto the offset surface
        // Coulomb friction (PBD): the tangential correction is capped by
        // µ × the normal push. Slow creep dies completely (static friction) —
        // this is what keeps a strap resting on a sloped shoulder.
        let disp = x - xp - surf_du;
        let dispT = disp - dot(disp, nrm) * nrm;
        let tl = length(dispT);
        if (tl > 1e-9) {
          x -= dispT * min(1.0, params.friction * push / tl);
        }
      }
    }
  }

  // --- Ground contact (plane y = ground_y), same Coulomb model ---
  let floorY = params.ground_y + params.cloth_thickness;
  if (x.y < floorY) {
    let push = floorY - x.y;
    x.y = floorY;
    let disp = x - xp;
    let tl = length(disp.xz);
    if (tl > 1e-9) {
      let s = min(1.0, params.friction * push / tl);
      x.x -= disp.x * s;
      x.z -= disp.z * s;
    }
  }

  // --- Waistband anchor (the belt) ---
  // A strapless or elastic top slides down a body that narrows below it. The
  // anchored top band is softly pulled back to its rest HEIGHT each substep,
  // x/z left free so the fabric still settles and turns with the podium.
  let ay = anchor_y[i];
  if (ay > -1.0e8) {
    x.y += (ay - x.y) * params.anchor_stiffness;
  }

  positions[i] = vec4f(x, 0.0);
}
