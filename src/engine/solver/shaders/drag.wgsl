// drag.wgsl — Milestone 7-8, mouse drag constraint (brief §4 interaction).
// A single grabbed particle (drag_index) is pulled toward the projected cursor
// point (drag_target) each substep. Runs after the constraint solve so the
// grabbed particle leads and the sheet follows via its distance constraints on
// the next substep. Inactive when drag_index == 0xffffffff.

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
@group(0) @binding(2) var<storage, read> inv_masses: array<f32>;

@compute @workgroup_size(1)
fn main() {
  let idx = params.drag_index;
  if (idx == 0xffffffffu) { return; }
  if (inv_masses[idx] == 0.0) { return; } // don't fight a pinned particle

  let x = positions[idx].xyz;
  positions[idx] = vec4f(mix(x, params.drag_target, params.drag_stiffness), 0.0);
}
