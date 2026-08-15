// smoothVelocity.wgsl — lissage de vitesse voisin-a-voisin (type XSPH).
//
// Le fremissement residuel du solveur est spatialement INCOHERENT : deux
// particules voisines portent des vitesses quasi opposees qui s'inversent
// d'une frame a l'autre (col, aisselles, ourlet — les zones les moins
// contraintes). Un vrai mouvement de tissu (chute, balancement d'ourlet,
// rafale) est au contraire COHERENT : les voisines bougent ensemble.
//
// Plutot que d'amortir vers zero (ce qui fait tirailler les particules
// traitees par leurs voisines vivantes — teste, ca empire), chaque particule
// tire sa vitesse vers la MOYENNE de ses voisines du tissage (contraintes
// trame/chaine/biais/coutures) :
//     v_i <- mix(v_i, moyenne(v_j), s)
// Filtre passe-bas SPATIAL : le bruit incoherent s'eteint, le mouvement
// d'ensemble (moyenne locale ~ v_i) traverse quasi intact. Combinaison
// convexe -> inconditionnellement stable, aucune energie ajoutee, quantite de
// mouvement quasi conservee. Nul a l'equilibre -> le drape final ne change pas.
//
// params.friction (slot recycle) = force du melange s dans [0,1], pilotee cote
// CPU (reglable en direct via __veloSmooth). Applique en fin de frame (dernier
// substep) ; __veloSmoothAll = true l'applique a chaque substep.
//
// Deux points d'entree sur les MEMES declarations : `smooth_pass` lit velocities_in
// (le buffer de vitesses) et ecrit velocities_out (le scratch) ; `copyback`
// est redispatch avec les buffers echanges pour recopier le resultat. Les
// dispatchs d'une meme passe sont ordonnes -> pas de course.
//
// `temporal_pass` (fin de frame uniquement) complete le filtre SPATIAL par un
// filtre TEMPOREL : v <- (v + v_frame_precedente) / 2. Ce que le lissage
// spatial laisse passer — un petit GROUPE de particules oscillant ENSEMBLE
// (moyenne locale ~ lui-meme) — s'inverse d'une frame a l'autre : la moyenne
// sur deux frames l'annule EXACTEMENT ((+a - a)/2 = 0), tandis qu'une vitesse
// constante traverse EXACTEMENT ((v + v)/2 = v). Cout : un demi-frame de
// retard de groupe (~16 ms), invisible. Ses bindings 1/2 designent d'autres
// buffers que ceux de smooth_pass (autorise : jamais utilises par la meme
// entree). Reglable : __veloTemporal (defaut actif).

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
  compliance_stretch_warp: f32,
  layer_gap: f32,
  anchor_stiffness: f32,
  max_layer: f32,
  compliance_bend_warp: f32,
  friction_dynamic: f32,
  air_drag: f32,
  stretch_limit: f32,
  shear_limit: f32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> velocities_in: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> velocities_out: array<vec4f>;
@group(0) @binding(3) var<storage, read> inv_masses: array<f32>;
// Adjacence CSR du tissage : voisines de i = nb_indices[nb_offsets[i] .. nb_offsets[i+1][.
@group(0) @binding(4) var<storage, read> nb_offsets: array<u32>;
@group(0) @binding(5) var<storage, read> nb_indices: array<u32>;

@compute @workgroup_size(256)
fn smooth_pass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  let vi = velocities_in[i].xyz;
  let s = clamp(params.friction, 0.0, 1.0);
  let first = nb_offsets[i];
  let last = nb_offsets[i + 1u];
  // Epinglee (v deja nulle), sans voisine, ou lissage coupe : copie telle quelle.
  if (inv_masses[i] == 0.0 || s <= 0.0 || last <= first) {
    velocities_out[i] = vec4f(vi, 0.0);
    return;
  }
  var acc = vec3f(0.0);
  for (var k = first; k < last; k++) {
    // Une voisine epinglee (v = 0) compte : le tissu tenu par une pince est
    // retenu — c'est physique, pas un artefact.
    acc += velocities_in[nb_indices[k]].xyz;
  }
  let vbar = acc / f32(last - first);
  velocities_out[i] = vec4f(mix(vi, vbar, s), 0.0);
}

@compute @workgroup_size(256)
fn copyback(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  velocities_out[i] = velocities_in[i];
}

// --- Filtre temporel (fin de frame) ---
// Memes numeros de binding que smooth_pass mais d'autres variables : WGSL
// l'autorise tant qu'une meme entree n'utilise pas les deux.
@group(0) @binding(1) var<storage, read_write> velocities_rw: array<vec4f>;
// Historique : vitesse de la frame precedente (xyz) + drapeau de validite (w).
@group(0) @binding(2) var<storage, read_write> v_hist: array<vec4f>;

@compute @workgroup_size(256)
fn temporal_pass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.particle_count) { return; }
  let v = velocities_rw[i].xyz;
  if (inv_masses[i] == 0.0) {
    v_hist[i] = vec4f(0.0, 0.0, 0.0, 0.0);
    return;
  }
  let h = v_hist[i];
  v_hist[i] = vec4f(v, 1.0); // memorise la vitesse BRUTE de cette frame
  if (h.w > 0.5) {
    velocities_rw[i] = vec4f((v + h.xyz) * 0.5, 0.0);
  }
}
