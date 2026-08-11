// surfaceContact.wgsl — one-sided pocket/appliqué anti-penetration.
//
// Each overlay particle is authored over one live triangle of its support.
// This pass is deliberately NOT an attachment constraint:
//   - it does nothing while the pocket is on/outside the support;
//   - it never corrects tangential position or pulls an open edge inward;
//   - it only projects penetration toward the support's outward normal.
//
// The previous position is reconstructed after a projection so the correction
// cannot become an artificial outward velocity on the next velocity update.

struct SurfaceParams {
  count: u32,
  slop: f32,
  max_step: f32,
  max_separation: f32,
};

struct SurfaceContact {
  support: u32,
  tangent_a: u32,
  tangent_b: u32,
  overlay: u32,
  weights: vec4f,
};

struct FabricMaterial {
  in_plane: vec4f,
  limits_mass: vec4f,
  contact_motion: vec4f,
  friction_crease: vec4f,
};

@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(4) var<storage, read> contacts: array<SurfaceContact>;
@group(0) @binding(5) var<storage, read> material_ids: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<FabricMaterial>;
// Support triangles are shared by several contacts, so writing their positions
// directly here would be a GPU data race. Accumulate the equal-and-opposite
// reaction as fixed-point atomics; surfaceReaction.wgsl applies and clears it
// once all contacts have completed.
@group(0) @binding(7) var<storage, read_write> reactions: array<atomic<i32>>;

const REACTION_SCALE: f32 = 10000000.0;
// A pocket is a light overlay on a much larger panel. The support must react a
// little so contact stays physically coherent, but giving it equal authority
// makes collision corrections shake or tow the whole shirt. This matches the
// dedicated surface-seam response in distance.wgsl.
const SURFACE_SUPPORT_RESPONSE: f32 = 0.02;

fn accumulate_reaction(index: u32, correction: vec3f) {
  let base = index * 4u;
  atomicAdd(&reactions[base], i32(round(correction.x * REACTION_SCALE)));
  atomicAdd(&reactions[base + 1u], i32(round(correction.y * REACTION_SCALE)));
  atomicAdd(&reactions[base + 2u], i32(round(correction.z * REACTION_SCALE)));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= params.count) { return; }

  let contact = contacts[k];
  // weights.w selects the sparse physical manifold (one interior sample per
  // support triangle plus the open boundary). Other entries still contribute
  // collision masks without multiplying the positional pressure.
  if (contact.weights.w < 0.5) { return; }
  let overlay = contact.overlay;
  let overlay_inv_mass = inv_masses[overlay];
  if (overlay_inv_mass == 0.0) { return; }

  let p0 = positions[contact.support].xyz;
  let pa = positions[contact.tangent_a].xyz;
  let pb = positions[contact.tangent_b].xyz;
  var raw_normal = cross(pa - p0, pb - p0);
  let normal_length = length(raw_normal);
  if (normal_length < 1e-7) { return; }

  // Keep the current material side coherent across one substep. A highly
  // sheared support triangle can pass close to degeneracy and reverse its raw
  // cross-product for one solve; blindly accepting that sign projects the
  // pocket THROUGH the shirt. The previous triangle is the continuous frame.
  let pp0 = prev_positions[contact.support].xyz;
  let ppa = prev_positions[contact.tangent_a].xyz;
  let ppb = prev_positions[contact.tangent_b].xyz;
  let previous_raw_normal = cross(ppa - pp0, ppb - pp0);
  if (
    length(previous_raw_normal) >= 1e-7 &&
    dot(raw_normal, previous_raw_normal) < 0.0
  ) {
    raw_normal = -raw_normal;
  }
  // weights.w : 0 = inactif, 1 = par-dessus, 2 = par-dessous (doublure) — la
  // même contrainte unilatérale, orientée vers l'intérieur du support.
  let side = select(1.0, -1.0, contact.weights.w > 1.5);
  let normal = normalize(raw_normal) * side;

  let support_point =
    p0 * contact.weights.x +
    pa * contact.weights.y +
    pb * contact.weights.z;
  let x = positions[overlay].xyz;

  // Effective collision thickness is a centre-line distance in the solver.
  // Half the two materials is physically symmetric. max_separation is a
  // deliberately thin numerical barrier: body contact already offsets each
  // material, while this pass only prevents pocket/support interpenetration.
  let support_thickness = materials[material_ids[contact.support]].contact_motion.x;
  let overlay_thickness = materials[material_ids[overlay]].contact_motion.x;
  // v199 — plancher relevé (1,5 → 2,5 mm) : deux tissus fins (soie sous
  // laine) ne laissaient qu'une barrière symbolique, et le sandwich comprimé
  // par le corps ou pincé par le matelassage perçait par intermittence.
  let separation = clamp(
    0.5 * (support_thickness + overlay_thickness),
    0.0025,
    params.max_separation,
  );
  let signed_distance = dot(x - support_point, normal);

  // Unilateral contact: never attract a pocket that lifts away. A small slop
  // prevents contact chatter at the boundary.
  if (signed_distance >= separation - params.slop) { return; }

  let push = min(separation - signed_distance, params.max_step);

  // Mass-weighted point/triangle contact with a deliberately heavy support.
  // The relative separation still changes by exactly `push`, but nearly all
  // correction stays on the overlay instead of moving the garment beneath it.
  let support_inv_mass =
    inv_masses[contact.support] * SURFACE_SUPPORT_RESPONSE;
  let tangent_a_inv_mass =
    inv_masses[contact.tangent_a] * SURFACE_SUPPORT_RESPONSE;
  let tangent_b_inv_mass =
    inv_masses[contact.tangent_b] * SURFACE_SUPPORT_RESPONSE;
  let denominator =
    overlay_inv_mass +
    support_inv_mass * contact.weights.x * contact.weights.x +
    tangent_a_inv_mass * contact.weights.y * contact.weights.y +
    tangent_b_inv_mass * contact.weights.z * contact.weights.z;
  if (denominator < 1e-9) { return; }
  let multiplier = push / denominator;
  let overlay_correction = normal * (overlay_inv_mass * multiplier);
  let corrected = x + overlay_correction;

  accumulate_reaction(
    contact.support,
    -normal * (support_inv_mass * contact.weights.x * multiplier),
  );
  accumulate_reaction(
    contact.tangent_a,
    -normal * (tangent_a_inv_mass * contact.weights.y * multiplier),
  );
  accumulate_reaction(
    contact.tangent_b,
    -normal * (tangent_b_inv_mass * contact.weights.z * multiplier),
  );

  // Preserve tangential and outward motion, but remove motion INTO the moving
  // support. Moving the previous position with the projection prevents the
  // positional correction from becoming a catapulting velocity.
  let previous_support_point =
    pp0 * contact.weights.x +
    ppa * contact.weights.y +
    ppb * contact.weights.z;
  let support_motion = support_point - previous_support_point;
  let overlay_motion = x - prev_positions[overlay].xyz;
  let relative_motion = overlay_motion - support_motion;
  let inward_motion = min(dot(relative_motion, normal), 0.0);
  let preserved_motion =
    support_motion + relative_motion - normal * inward_motion;

  positions[overlay] = vec4f(corrected, 0.0);
  prev_positions[overlay] = vec4f(corrected - preserved_motion, 0.0);
}
