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
// 1 = stitched across garments (cross-seam ring): never repel two of these.
@group(0) @binding(5) var<storage, read> seam_free: array<u32>;
// Grid hops to the nearest sewn boundary (clamped to 3). The cross-panel
// mirror exclusion applies only where BOTH particles are ≤ 2 hops from a seam.
@group(0) @binding(6) var<storage, read> seam_dist: array<u32>;

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
            // and cross-panel cells within ONE grid cell of the mirror (they
            // may be seamed together — repelling them, or their immediate
            // neighbours, would push every seam open into a ladder of gaps).
            let pj = j / sp.panel_size;
            let lj = i32(j % sp.panel_size);
            let dl = abs(lj - li);
            let ni = i32(sp.n);
            // Panels pair up two-by-two into garments (front/back); the seam
            // exclusion must never apply BETWEEN garments, or layered outfits
            // stop separating in mirror-aligned patches.
            let same_garment = (pi / 2u) == (pj / 2u);
            // Same panel: exclude only the 2-ring the distance/shear/bending
            // constraints already govern — in GRID coordinates. Linear index
            // distance would conflate rows with columns and blind the pass to
            // every same-row contact: a vertical fold bringing (u=5, v) onto
            // (u=50, v) must repel like any other cloth-on-cloth touch.
            let du = abs((lj % ni) - (li % ni));
            let dv = abs((lj / ni) - (li / ni));
            let near_weave =
              (pj == pi && du <= 2 && dv <= 2) ||
              // Cross-panel (front↔back) mirror exclusion, but ONLY within ~2
              // hops of a sewn edge — otherwise an interior mirror pair (a
              // body-free tube collapsing flat) gets no repulsion and the
              // panels tunnel through each other (audit M3). Near a seam the
              // exclusion stays so the sewn edge can still close.
              (pj != pi && same_garment && seam_dist[i] <= 2u && seam_dist[j] <= 2u &&
                (dl <= 2 || (dl >= ni - 2 && dl <= ni + 2) || (dl >= 2 * ni - 2 && dl <= 2 * ni + 2))) ||
              // A waist seam sewing two garments together holds its rows at
              // seam distance ON PURPOSE — repelling them shakes the garment
              // loose (the gathered bodice slid off its bust this way).
              (seam_free[i] == 1u && seam_free[j] == 1u);
            if (!near_weave) {
              let d = x - positions[j].xyz;
              let dist = length(d);
              // A panel folded onto ITSELF packs tighter than two garments
              // resting on each other: gathers (elastic tops, embu) stack
              // distant columns at a fabric-thickness distance. Same-panel
              // contacts get a slimmer radius — still a tunneling barrier,
              // no longer a bellows that puffs every gather open.
              let md = select(sp.min_dist, sp.min_dist * 0.5, pj == pi);
              if (dist < md && dist > 1e-6) {
                // Gentle relaxation (0.3, not the full half-correction): layered
                // garments resting on each other settle smoothly instead of
                // locking into stepped patches.
                corr += d * ((md - dist) / dist) * 0.3;
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
