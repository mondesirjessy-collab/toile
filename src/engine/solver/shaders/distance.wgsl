// distance.wgsl — XPBD distance projection for structural/shear (stretch) and
// skip-2 (bending) constraints (brief §3.2 step 2, §3.3). One dispatch per graph
// color: constraints in a color are vertex-disjoint, so writes never race.
//
// Compliance is looked up live from SimParams by the constraint's kind, so the
// control panel can retune stretch/shear/bend without rebuilding the buffer.
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
  body_min: vec3f,
  blend_k: f32,
  body_max: vec3f,
  use_grid: u32,
  spin_cos: f32,
  spin_sin: f32,
  spin_dtheta: f32,
  compliance_stretch_warp: f32, // anisotropy: the grain line's own stiffness
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
  seam_dressing_progress: f32,
  // v198 — extension au-delà des 208 octets historiques : seuls les shaders
  // qui lisent ces champs déclarent la struct longue (le buffer, plus grand,
  // reste liable aux structs courtes des autres passes).
  zip_open: f32, // 1 = les coutures ZipperSeam sont débrayées (fermeture ouverte)
  _z1: f32,
  _z2: f32,
  _z3: f32,
};

struct Constraint {
  i: u32,
  j: u32,
  rest: f32,
  kind: u32, // 0 weft, 1 shear, 2 bending, 3 seam, 4 warp, 5 surface, 6 attachment, 7 zipper
};

struct Batch {
  offset: u32,
  count: u32,
  _pad0: u32,
  _pad1: u32,
};

struct FabricMaterial {
  in_plane: vec4f, // stretch weft, stretch warp, shear, bend weft
  limits_mass: vec4f, // bend warp, stretch limit, shear limit, areal density
  contact_motion: vec4f, // thickness, damping, air drag, static friction
  friction_crease: vec4f, // dynamic friction, crease yield, memory, recovery
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(3) var<storage, read> constraints: array<Constraint>;
@group(0) @binding(4) var<uniform> batch: Batch;
@group(0) @binding(5) var<storage, read> material_ids: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<FabricMaterial>;

// A patch pocket is light and locally top-stitched onto a much larger panel.
// Giving its seam the same two-way authority as an assembly seam lets the open
// top act as a lever and visibly pulls the whole shirt forward. Keep a small
// support response for local realism while making the overlay absorb almost
// all of the constraint correction.
const SURFACE_SUPPORT_RESPONSE: f32 = 0.02;
// A collar/neck attachment starts from a trustworthy anatomical support rim.
// Let the separately spawned part absorb the dressing correction instead of
// pulling that rim through the avatar before the final body collision pass.
const ATTACHMENT_SUPPORT_RESPONSE: f32 = 0.02;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= batch.count) { return; }

  let c = constraints[batch.offset + k];
  // v198 — fermeture éclair débrayée : la couture existe dans le buffer mais
  // ne projette rien tant que le zip est ouvert. Refermer réactive les mêmes
  // épingles : les rubans se rejoignent depuis l'état porté, sans rebuild.
  if (c.kind == 7u && params.zip_open > 0.5) { return; }
  let material = materials[material_ids[c.i]];
  let wi = inv_masses[c.i];
  let wj = inv_masses[c.j];
  var solve_wi = wi;
  if (c.kind == 5u) { solve_wi *= SURFACE_SUPPORT_RESPONSE; }
  else if (c.kind == 6u) { solve_wi *= ATTACHMENT_SUPPORT_RESPONSE; }
  let wsum = solve_wi + wj;
  if (wsum == 0.0) { return; } // both endpoints pinned

  let xi = positions[c.i].xyz;
  let xj = positions[c.j].xyz;
  let d = xi - xj;
  let len = length(d);
  if (len < 1e-8) { return; }

  var compliance = material.in_plane.x; // kind 0: weft
  if (c.kind == 1u) { compliance = material.in_plane.z; }
  else if (c.kind == 2u) { compliance = material.in_plane.w; }
  else if (c.kind == 4u) { compliance = material.in_plane.y; }
  // kind 3 (Seam): a lockstitch is far stiffer than the cloth. Hold it near-
  // rigid rather than letting it inherit the fabric's stretch — otherwise a
  // knit preset makes every seam elastic and the panels gape at the stitch
    // line. Stiffer than the stiffest fabric setting (min stretch slider = 1e-8).
  else if (c.kind == 3u || c.kind == 7u) {
    // Multi-piece garments start in a collision-safe dressing pose, but a
    // rigid panel fit cannot make every curved seam coincident. Tighten the
    // stitch over its requested dressing interval instead of converting that
    // residual into a violent first-frame impulse. The final lockstitch is
    // byte-for-byte as rigid as before once progress reaches one. A zipper
    // (kind 7) is the same lockstitch — just switchable via zip_open above.
    let p = smoothstep(0.0, 1.0, params.seam_dressing_progress);
    compliance = mix(5e-4, 1e-9, p);
  }
  else if (c.kind == 5u) { compliance = 1e-9; }
  else if (c.kind == 6u) { compliance = 1e-9; }

  let n = d / len;
  let cval = len - c.rest;
  // Yarn/loop straightening is nonlinear. Below the material's limit the
  // dialled compliance governs the soft "toe" region; above it the weave locks
  // progressively instead of stretching like rubber forever. Shear can lock
  // in either diagonal direction, while warp/weft locking is tension-only.
  var strain = 0.0;
  var strain_limit = material.limits_mass.y;
  if (c.kind == 1u) {
    strain = abs(cval) / max(c.rest, 1e-6);
    strain_limit = material.limits_mass.z;
  } else if (c.kind == 0u || c.kind == 4u) {
    strain = max(cval, 0.0) / max(c.rest, 1e-6);
  }
  if (strain > strain_limit && (c.kind == 0u || c.kind == 1u || c.kind == 4u)) {
    let over = (strain - strain_limit) / max(strain_limit, 0.01);
    compliance /= 1.0 + 40.0 * over * over;
  }
  let alpha = compliance / (params.dt * params.dt);
  let dlambda = -cval / (wsum + alpha);
  let corr = dlambda * n;

  positions[c.i] = vec4f(xi + solve_wi * corr, 0.0);
  positions[c.j] = vec4f(xj - wj * corr, 0.0);
}
