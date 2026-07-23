// Applies the support-side reaction accumulated by surfaceContact.wgsl.
//
// Contact triangles share vertices, so the contact pass stores fixed-point
// atomic corrections instead of racing on the position buffer. This separate
// dispatch converts, applies and clears each particle's reaction exactly once.

struct SurfaceParams {
  contact_count: u32,
  slop: f32,
  max_step: f32,
  max_separation: f32,
  particle_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> prev_positions: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> reactions: array<atomic<i32>>;

const REACTION_SCALE: f32 = 10000000.0;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.particle_count) { return; }

  let base = index * 4u;
  let correction = vec3f(
    f32(atomicExchange(&reactions[base], 0)) / REACTION_SCALE,
    f32(atomicExchange(&reactions[base + 1u], 0)) / REACTION_SCALE,
    f32(atomicExchange(&reactions[base + 2u], 0)) / REACTION_SCALE,
  );
  if (dot(correction, correction) == 0.0) { return; }

  // Move previous and current positions together: this is a positional contact
  // reaction, not a new velocity or a source of oscillation.
  positions[index] = vec4f(positions[index].xyz + correction, positions[index].w);
  prev_positions[index] = vec4f(
    prev_positions[index].xyz + correction,
    prev_positions[index].w,
  );
}
