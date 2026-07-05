// selfCollide.wgsl — Phase 1, cloth self-collision.
// Spatial hash grid rebuilt every substep: `clear_hash` resets the table,
// `insert` links every free particle into its cell's list (atomicExchange),
// `collide` walks the 27 neighbouring cells and pushes apart any two particles
// closer than min_dist — excluding topological neighbours (the weave itself).
// Gather-style: each thread only writes its own particle, so no write races;
// reads of a neighbour mid-update are acceptable Jacobi-style jitter.

struct SelfParams {
  cell_size: f32,
  min_dist: f32,
  table_size: u32, // power of two
  count: u32,
  n: u32,          // particles per panel side (for weave-neighbour exclusion)
  panel_size: u32, // n × n
  enabled: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> sp: SelfParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> inv_masses: array<f32>;
@group(0) @binding(3) var<storage, read_write> heads: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> nexts: array<u32>;

const NIL: u32 = 0xffffffffu;

fn cell_hash(c: vec3i) -> u32 {
  let h = (u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u);
  return h & (sp.table_size - 1u);
}

@compute @workgroup_size(256)
fn clear_hash(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.table_size) { return; }
  atomicStore(&heads[gid.x], NIL);
}

@compute @workgroup_size(256)
fn insert(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sp.count || sp.enabled == 0u) { return; }
  if (inv_masses[i] == 0.0) { return; } // pinned or cut from the pattern
  let c = vec3i(floor(positions[i].xyz / sp.cell_size));
  nexts[i] = atomicExchange(&heads[cell_hash(c)], i);
}

@compute @workgroup_size(256)
fn collide(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sp.count || sp.enabled == 0u) { return; }
  if (inv_masses[i] == 0.0) { return; }

  let x = positions[i].xyz;
  let c = vec3i(floor(x / sp.cell_size));
  let pi = i / sp.panel_size;
  let li = i32(i % sp.panel_size);
  var corr = vec3f(0.0);

  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var j = atomicLoad(&heads[cell_hash(c + vec3i(dx, dy, dz))]);
        var guard = 0u;
        while (j != NIL && guard < 64u) {
          guard++;
          if (j != i) {
            // The weave handles its own spacing: skip same-panel particles
            // within two grid rows (their distance constraints already act),
            // and cross-panel mirror cells (they may be seamed together —
            // repelling them would hold every seam open).
            let lj = i32(j % sp.panel_size);
            let near_weave =
              ((j / sp.panel_size) == pi && abs(lj - li) < i32(2u * sp.n + 3u)) || lj == li;
            if (!near_weave) {
              let d = x - positions[j].xyz;
              let dist = length(d);
              if (dist < sp.min_dist && dist > 1e-6) {
                corr += d * ((sp.min_dist - dist) / dist) * 0.5;
              }
            }
          }
          j = nexts[j];
        }
      }
    }
  }

  // Clamp so a crowded cell can't catapult the particle.
  let cl = length(corr);
  if (cl > sp.min_dist) { corr *= sp.min_dist / cl; }
  positions[i] = vec4f(x + corr, 0.0);
}
