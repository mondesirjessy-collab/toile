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
  body_min: vec3f,   // collider AABB (early out)
  blend_k: f32,      // smooth-min radius; 0 = hard min
  body_max: vec3f,
  _c3: f32,
};

// Round cone: segment a→b, radius ra at a, rb at b. Sphere when a = b.
struct Prim {
  a_ra: vec4f, // a.xyz, ra
  b_rb: vec4f, // b.xyz, rb
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(4) var<storage, read> colliders: array<Prim>;

fn sd_round_cone(p: vec3f, prim: Prim) -> f32 {
  let a = prim.a_ra.xyz;
  let b = prim.b_rb.xyz;
  let ra = prim.a_ra.w;
  let rb = prim.b_rb.w;
  let ba = b - a;
  let l2 = dot(ba, ba);
  let rr = ra - rb;
  let a2 = l2 - rr * rr;
  let pa = p - a;
  // Degenerate: zero-length segment, or one end sphere inside the other.
  if (l2 < 1e-12 || a2 <= 1e-12) {
    return min(length(pa) - ra, length(p - b) - rb);
  }
  let il2 = 1.0 / l2;
  let y = dot(pa, ba);
  let z = y - l2;
  let xv = pa * l2 - ba * y;
  let x2 = dot(xv, xv);
  let y2 = y * y * l2;
  let z2 = z * z * l2;
  let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) { return sqrt(x2 + z2) * il2 - rb; }
  if (sign(y) * a2 * y2 < k) { return sqrt(x2 + y2) * il2 - ra; }
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

// Polynomial smooth minimum; k = 0 degenerates to a hard min.
fn smin(a: f32, b: f32, k: f32) -> f32 {
  if (k < 1e-6) { return min(a, b); }
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn sd_body(p: vec3f) -> f32 {
  var d = 1e9;
  for (var s = 0u; s < params.collider_count; s++) {
    d = smin(d, sd_round_cone(p, colliders[s]), params.blend_k);
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

  // --- Body field (skip fast when outside the collider AABB) ---
  if (params.collider_count > 0u
      && all(x > params.body_min) && all(x < params.body_max)) {
    let d = sd_body(x);
    if (d < params.cloth_thickness) {
      // Field gradient, 4-tap tetrahedral.
      let e = 0.002;
      let k0 = vec3f(1.0, -1.0, -1.0);
      let k1 = vec3f(-1.0, -1.0, 1.0);
      let k2 = vec3f(-1.0, 1.0, -1.0);
      let k3 = vec3f(1.0, 1.0, 1.0);
      let g = k0 * sd_body(x + k0 * e) + k1 * sd_body(x + k1 * e)
            + k2 * sd_body(x + k2 * e) + k3 * sd_body(x + k3 * e);
      let gl = length(g);
      if (gl > 1e-6) {
        let nrm = g / gl;
        let push = params.cloth_thickness - d;
        x += nrm * push; // project onto the offset surface
        // Coulomb friction (PBD): the tangential correction is capped by
        // µ × the normal push. Slow creep dies completely (static friction) —
        // this is what keeps a strap resting on a sloped shoulder.
        let disp = x - xp;
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

  positions[i] = vec4f(x, 0.0);
}
