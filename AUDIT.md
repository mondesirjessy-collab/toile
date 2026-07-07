# TOILE — Audit complet du moteur (v57, 06/07/2026)

## ÉTAT (07/07/2026, v59) — fait / à faire
- ✅ **C1** mailles anisotropes (v58) : spacingV partout, strain par axe, UV motifs + glTF. *Reste : spacing par vêtement dans les combinés, normalisation dihedral (volontairement non touchée — presets réglés dessus).*
- ✅ **C2** clés de cache morpho sur les 6 curseurs (v58).
- ✅ **C3** hauteur du tailleur × stature (v58).
- ✅ **M** auto-collision même-panneau : exclusion 2D Chebyshev ≤ 2 (les contacts d'une même rangée repoussent enfin) + rayon même-panneau réduit ×0,5 (le tissu replié sur lui-même se serre plus fort que deux vêtements) (v59).
- ✅ **M** poseIdle : décision par le corps SOURCE (les formes morphées n'animent plus leurs jambes) (v59).
- ✅ **M** (partiel) coutures trans-vêtement : particules cousues ±1 rangée exemptées de la répulsion (buffer seam_free, binding 5 de selfCollide) (v59).
- ✅ **RÉSOLU (v67) — robe froncée** (ancrage de ceinture) : le bustier glisse aux hanches, EN PROD DEPUIS v56 (vérifié sur le build v56 public servi en cache — antérieur aux correctifs v59). Diagnostic mené : auto-collision OFF → toute la robe tombe au sol, donc l'élastique seul (même à 0,78) n'a JAMAIS tenu ce bustier — la « tenue » d'avant venait d'un équilibre d'encombrement des fronces que la porte same_garment de v56 a déplacé. Pistes : vrai ancrage de taille (ceinture = contrainte d'ancrage au corps, déjà au backlog), ou élargir seam_free à ±3-4 rangées, ou min_dist par vêtement. Ne PAS traiter comme un réglage : c'est le chantier « tenue des vêtements sans épaules ».
- ✅ **M** encolures cousues fermées à certaines résolutions : marges d'exemption de isOpening désormais + un pas de grille (aline/tshirt/setin) ; test-vérité = balayage n=16…128, aucune couture miroir dans l'ellipse d'échancrure (v60).
- ✅ **M** avatars scannés : les 4 fetchs (2 corps × mesh+sdf) passent en PARALLÈLE (Promise.all main.ts + ScanAvatar) — le premier rendu n'attend plus ~4,7 Mo en série (v60).
- ✅ **M** import .toile.json : chaque scalaire validé fini + borné aux plages des curseurs (num() clamp), résolution sur liste blanche [32,64,128], substeps arrondi 5-40 — fini les NaN/Infinity/résolution-DoS (v60).
- ✅ **M** trou sous-bras setin : la zone d'exemption emmanchure suit EXACTEMENT les bornes de la bande manche (CAP_V0..CAP_V1, mêmes comparaisons que le masque) — plus de rangées ni cousues à la manche ni au flanc ; test balayage n=16…128 (chaque rangée sous la bande porte sa couture miroir) (v61).
- ✅ **M** poitrine mesurée au diaphragme : plancher de la bande de recherche 0,62 H → 0,695 H (au-dessus du creux sous-poitrine — la bosse des côtes s'étire jusqu'à 0,67 H et gagnait encore le max) ; le buste est trouvé à ~0,72 H, la gradation des hauts et l'ancrage du morph « poitrine » visent la bonne ligne ; test anthropométrique femme+homme (v62).
- ✅ **M** cuisse avalée par l'entrejambe : l'entrejambe est désormais LOCALISÉ (descente depuis la hanche jusqu'à ce que le plan médian sorte du corps, marge 1 cm) et la cuisse mesurée 3 cm dessous, là où les jambes sont séparées — fini les 28 cm au lieu de ~43 (le smin fusionnait les cuisses, le rayon intérieur ne sortait jamais) ; le curseur « cuisse » vise le bon endroit ; test invariant : sd(0, thigh.y, 0) > 0 (v63).
- ✅ **M** (partiel) surfaceNets par relâché de curseur : morphPrims mémoïsé par (corps|variante bras|valeurs morpho) dans main.ts (primsCache) → même réglage = même identité de tableau = cache de maillage aval touché ; bodyMeshCache plafonné à 8 entrées (éviction du plus ancien — fuite stoppée). MESURÉ : revisite 1,0 s vs réglage neuf 1,35 s — le re-maillage est évité, MAIS ~1 s de rebuild reste (génération tissu + coloriage + recompilation des 10 pipelines = la fiche « Every build() recompiles all 10 shader modules », toujours ouverte : c'est ELLE le vrai gain de confort) (v64).
- ✅ **Feature (backlog v56)** couleur par vêtement dans une tenue : le n° de vêtement se dérive de l'indice de sommet (panneaux appariés → garment = vid/n² >> 1), le renderer passe le nombre de vêtements dans options.z, le shader tissu assombrit la pièce du DESSOUS (garment 0) à ×0.68 ; vêtement seul = uni (count 1). Zéro buffer, zéro changement solveur, zéro UI. QC : tenue = t-shirt taupe qui dépasse au col/manches sous la robe crème ; robe seule = unie (v65). Suite possible : couleurs custom par pièce (UI).
- ⏸️ **Miroir 2D plein cadre chaque frame (M, différé — décision Opus 07/07)** : le blit N'EST PAS un vestige de capture — c'est un FALLBACK de compat (`#mirror` z-index 1 sous `#view`, pointer-events:none) pour les systèmes qui ne présentent jamais WebGPU à l'écran. Le retirer casserait l'affichage chez ces utilisateurs. La seule optim sûre (sauter render+blit en veille) exige un signal « vue modifiée » câblé à travers OrbitCamera + onStyle + onFitMap (qui NE réveillent PAS la sim, main.ts:673,730) — sinon un changement de tissu/carte sur un drapé posé reste invisible (le bug silencieux exact que la note mémoire « vérifier avec entrées réelles » proscrit). Gain = batterie au repos (invisible pour l'utilisateur). Verdict : faisable mais faible ROI + risque de régression silencieuse ; à faire seulement avec test entrées-réelles (orbite en veille, toggle carte en veille). NE PAS retirer le miroir.
- ✅ **Backlog v56** encart plan de coupe : pièces d'un combiné disposées CÔTE À CÔTE (offset x par vêtement en espace layout, gouttière 5 cm — même logique que patternPdf.frontOutline) ; les poignées suivent (rattachées à leur vêtement par la plage-Y de leur grille, offset ajouté à la position écran et retiré du calcul de valeur). Vêtement seul inchangé. QC ENTRÉES RÉELLES (leçon carnet) : ensemble = t-shirt+jupe séparés, poignées sur la jupe, VRAI glisser de la longueur (0,60→0,75 m) ; robe seule centrée (v66).
- ✅ **Chantier ceinture (v67)** : mécanisme d'ancrage GÉNÉRAL — `generateSeamedPanels({anchorTop:true})` retient la rangée du haut à sa hauteur de repos (ressort doux en Y dans collide, x/z libres → épouse le corps + podium OK). Buffer par-particule anchorY (collide binding 7, sentinelle ≤ -1e8 = libre), transporté par combineClothMeshes ; anchor_stiffness @164 (0,12/substep). Branché sur le bustier robe froncée → tient au buste, stable 30 s (avant : glissait aux hanches depuis v56). Suite naturelle : ceintures jupe/pantalon (même option, résout « jupe glisse sur homme »).
- ✅ **Ceintures jupe/pantalon (v68)** : anchorTop:true sur la jupe de l'ensemble et le pantalon → tiennent à la taille même sur l'HOMME (waist≈hips : sans ceinture, la jupe glissait aux cuisses — repro faite avant/après). Ensemble femme inchangé. Résout la note code « belts are future work ».
- ✅ **HUD « 4096 part. » suspect (audit) — CLASSÉ** : artefact de frame périmée pendant un micro-gel de reconstruction (timeout CDP concomitant), PAS un bug de compteur — la valeur est correcte une fois le rendu stabilisé (vérifié : ensemble 16384, pantalon 8192).
- ✅ **Perf reconstruction (v69)** : les ~12 pipelines GPU (9 solveur + 3 renderer) sont désormais compilés UNE FOIS par carte graphique (WeakMap par device) au lieu de recompilés à chaque build(). MESURÉ : glisser un curseur de mensuration (corps en cache) passe de ~1,0 s → ~80 ms (~12×). Restent au coût plein : le PREMIER build d'une mensuration jamais vue (surfaceNets du corps morphé ~1 s, coût v64) et le et le maillage surfaceNets d'un corps JAMAIS VU (≈930 ms, cache par corps ensuite) — c'est LUI le ~1,7 s au 1er passage chemise (corps À BRAS différent), PAS la génération de patron (mesurée à ~6 ms — la fiche « generateSeamedPanels coûteux » était une FAUSSE PISTE).
- ✅ **Marge de couture sur le patron PDF (v70, backlog)** : trait pointillé gris à 1 cm HORS du trait de couture plein = la ligne de coupe, tracée directement (avant : « ajouter 1 cm à la main »). Normale extérieure fiable par le 3ᵉ sommet du triangle propriétaire de chaque arête de bord → correct même à l'encolure concave (vérifié PDF : couture droite + encolure). frontOutline renvoie `seam[]` ; note page 1 réécrite ; test bbox marge ⊃ bbox coupe (~10 mm).
- ✅ **M21 (v71)** : les raccourcis clavier R (reset) et P (épingles) appellent désormais wake() comme leurs boutons — avant, sur un tissu endormi, ils ne faisaient rien de visible.
- ✅ **M19 (v71)** : l'import .toile.json restaure les MENSURATIONS sauvegardées (clampées aux plages des curseurs). Cause : onBody remettait le corps à son repère APRÈS coup → les mensurations importées doivent être appliquées après onBody. Vérifié : import femme (poitrine 115) sur corps homme → 115 restauré. Hook DEV `window.__toileImport(doc)` ajouté (rejoue applyGarment sans dialogue de fichier — utile aux prochains tests).
- ℹ️ **Doublons marqués corrigés** dans la liste détaillée : M2/M12 (coutures trans-vêtement combattues → v59 seamFree), M4/M20 (cache morpho 3/6 → v58=C2), M5/M16 (surfaceNets remesh+fuite → v64), M8 (recompil pipelines → v69), M13 (strain horizontal → v58=C1).
- ✅ **M9 (v72)** : plus de contrainte d'aplatissement contradictoire sur les paires de couture (on n'aplatit que l'anneau INTÉRIEUR, jamais les particules de bord) ; test d'invariant coutures∩aplatisseurs = ∅ sur les 5 formes ; drapé plus net.
- ✅ **M22 (v72)** : bannière d'erreur (showFatal) sur exception de boucle (guardedFrame try/catch → arrêt propre) ET sur device.lost ; vérifié en injectant une erreur dans frame(). Note : le watchdog évalue performance.now() hors du guard, mais performance.now ne lève jamais en réel — non-problème.
- ✅ **M23 (v73)** : caméra multi-touch — carte pointerId→position, pincement = zoom (ratio distance → radius) + pan (delta du milieu), 1 doigt = orbite. Bureau souris inchangé. Vérifié : orbite souris OK + pincement synthétique zoome (setPointerCapture no-opé pour le test — il ne rejette que les pointeurs synthétiques).
- Reste ouvert : **M3** (tunneling auto-collision à bas substeps — DUR, demande une détection de collision continue / CCD ; ou juste plancher les substeps ≥ ~12). Puis le **bloc mineur** (14 fiches non contre-vérifiées : readbackBuffer mort, α dihedral, min_dist par orientation de couture, validation connexité des silhouettes, etc.).
- Le reste de la liste ci-dessous est à dérouler dans l'ordre.
- **NB pour la session qui reprend** : les fiches détaillées ci-dessous décrivent l'état AU MOMENT DE L'AUDIT (v57) — les numéros de ligne ont dérivé depuis (v58-v63 ont modifié main.ts, ClothMesh.ts, measure.ts, selfCollide.wgsl, ControlPanel.ts, ClothRenderer.ts). Se repérer par NOMS de symboles/fonctions, pas par lignes. Les fiches marquées [✅ corrigé] sont soldées — détail dans cette section ÉTAT.

Audit adversarial mené par 33 agents (6 spécialistes : physique XPBD, GPU/WebGPU, patrons/topologie, corps/SDF, exports, produit — chaque trouvaille critique/majeure contre-vérifiée par un agent indépendant chargé de la réfuter).

**Mode d'emploi (session future)** : traiter dans l'ordre. Chaque entrée donne le défaut tracé (fichier, lignes, valeurs concrètes) et une piste de correctif. Re-valider visuellement après chaque lot (serveur dev + scènes concernées), badge de version à chaque changement visible, déployer.


## 🟥 CRITIQUE — 3

### C1. [✅ corrigé] Fit map strain is computed against a single isotropic rest spacing — solid red/blue on any non-square pattern
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ClothRenderer.ts`

The normals pass (line 66) computes strain = mean(4 structural-neighbour distances)/grid.spacing - 1, with grid.spacing = mesh.spacing = width/(n-1) (ClothMesh.ts:888). But vertical rest spacing is height/(n-1), which differs whenever a pattern is not square. Trace for the 'robe' scene (width 0.95·scale, height 1.3, n=64): horizontal rest ≈ 0.0151 m, vertical ≈ 0.0206 m, so at REST strain = ((2·0.0151+2·0.0206)/4)/0.0151 − 1 = +18.4 % → heatmap t = clamp(0.184/0.10) = 1 → the whole dress reads full red with zero actual tension. For the tee (1.15 × 0.75) the baseline is −17 %, clamped to 0 → the fit map stays blue until real elongation exceeds ~17 %, i.e. it never shows tightness. The one core 'fit' feature is only correct on the square drapé/couture sheets. Same root cause corrupts the print UVs (vs() line 102 scales v by the width spacing → gingham/dots vertically stretched by height/width) and the glTF UV export (main.ts:749-750). combineClothMeshes compounds it with spacing = max(a,b) (ClothMesh.ts:1024), biasing whichever garment has the smaller spacing, and skews the dihedral compliance normalization (alpha ∝ 1/spacing²) between garments of an outfit.

**Correctif proposé** : Carry both spacings: add spacingV = height/(n-1) to ClothMeshData, put it in GridInfo's free _p0 slot, and compute strain per axis (d1,d2 vs spacingU; d3,d4 vs spacingV) before averaging; use (u·spacingU, v·spacingV) for print/export UVs. For combined meshes keep per-garment spacing (a second fabric/grid uniform slot or a small per-panel lookup).

### C2. [✅ corrigé] Morph caches keyed on only 3 of 6 sliders — stature/carrure/cuisse changes reuse stale measurements and stale morphed scan grid/mesh
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

measureCache key (line 153) and morphCache key (line 276) are both `${kind}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}`, but onMorph (lines 611-619) sets six ratios including stature, carrure and cuisse. Sequence: user sets taille=110cm (cache miss, entry built), then moves carrure or stature — key is unchanged, so build() reuses the old BodyMeasure (garment grading frozen) and, for scan bodies, the old morphed SDF grid + render mesh: the avatar and its collider do not change at all when those three sliders move after any earlier morph.

**Correctif proposé** : Include all six morph values in both cache keys (e.g. JSON of the Morphs object), or a single `morphKey(morphs)` helper used at lines 153 and 276.

### C3. [✅ corrigé] measureFor measures morphed bodies with a FIXED height — stature slider breaks all anthropometric bands
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Lines 155-158 pass `kind === 'homme' ? 1.765 : 1.755` to measureBody even when `prims` are stature-scaled morphPrims. Verified: with stature=0.8 the body top is at 1.404 m but the shoulder band [0.79H, neckY] = [1.386, ~1.55] lies almost entirely above the head → measured shoulderHalfW = 0.035 instead of 0.21 (6x off), chest 61.4 cm instead of 64.7 cm. dressScale/topScale clamp to garbage and dyShoulder ≈ 0 instead of ≈ −0.28, so garments spawn at the unmorphed shoulder height, floating above the shrunken mannequin and collapsing onto its head. (The scan branch at line 162 is inconsistent-but-right: it uses the morphed grid's scaled max[1].)

**Correctif proposé** : Multiply the reference height by morphs.stature in the prims branch: `(kind === 'homme' ? 1.765 : 1.755) * morphs.stature`. Also covered only once the cache-key bug above is fixed (stature currently isn't in the key either).


## 🟧 MAJEUR — 23

### M1. [✅ corrigé] Self-collision same-panel exclusion uses LINEAR index distance — same-row and adjacent-row contacts never repel (anisotropic self-collision)
**Fichier** : `src/engine/solver/shaders/selfCollide.wgsl`

Line 82: `(pj == pi && dl < 2 * ni + 3)` where dl = |lj − li| is the difference of LINEAR in-panel indices (li = i % panelSize). The comment says 'skip same-panel particles within two grid rows', but linear distance conflates rows and columns: for n=64, any same-row pair has dl ≤ 63 < 131 → excluded; any adjacent-row pair has dl ≤ 127 < 131 → excluded; two-rows-apart pairs are excluded for most u-offsets (dl = 128+Δu ≤ 130 covers Δu ∈ [−63, 2]). Net effect: within a panel, self-collision only acts between particles ≥ ~3 grid rows apart in v. A fold along a vertical crease (warp direction) brings distant columns of the SAME row into contact — e.g. (u=5, v) touching (u=50, v) — and they pass straight through each other. Self-collision is effectively directional: horizontal folds are protected, vertical folds are not. The cross-panel branch on lines 83-84 shows the intended pattern (banded: dl ≤ 2 || |dl−n| ≤ 2 || |dl−2n| ≤ 2) — the same-panel branch just wasn't written that way.

**Correctif proposé** : Decompose to 2D coords (ui = li % n, vi = li / n; same for j) and exclude same-panel pairs only when Chebyshev distance ≤ 2: `pj == pi && abs(ui−uj) <= 2 && abs(vi−vj) <= 2` — that is exactly the neighborhood the distance/shear/bend constraints already govern. (Or reuse the banded linear test from the cross-panel branch, which is equivalent up to rare row-wrap pairs.)

### M2. [✅ corrigé v59 (seamFree)] Cross-garment seams (crossSeams / 'robe froncée') permanently fight self-collision — the gathered waist seam is repelled open every substep
**Fichier** : `src/engine/solver/shaders/selfCollide.wgsl`

Line 80: `same_garment = (pi / 2u) == (pj / 2u)` — the seam exclusion NEVER applies between garments, by design for layered outfits. But combineClothMeshes supports crossSeams that SEW two garments together (main.ts 'robe froncée': bodice panels 0-1 sewn to skirt panels 2-3 at the waist, rest = 0.15·spacing). Those seamed pairs — and every near-waist cross-garment pair — sit far below min_dist = 0.6·spacing, so `collide` pushes them apart by 0.3·(min_dist − dist) ≈ 0.14·spacing every substep, while the rigid seam constraint yanks them back to 0.15·spacing on the next distance solve. Result: sustained substep-frequency oscillation and energy injection along the entire waist band, disturbing exactly the gathering (embu) physics this scene exists to demonstrate. Compounding it, combineClothMeshes sets spacing = max(a, b) (ClothMesh.ts:1024), and the skirt is 1.6× wider — so min_dist for the finer bodice is ≈ 0.96 of the bodice's OWN weave spacing, making the repulsion band even wider than 0.6.

**Correctif proposé** : Add a small per-particle flag/group buffer (u32 per particle, uploaded once): mark particles that participate in a cross-garment seam (and optionally their 1-ring), and in `collide` skip repulsion when both i and j are seam-flagged and belong to seam-connected garments. Alternatively give combineClothMeshes a 'sewn' mode that assigns both garments the same garment id for the exclusion test. Also consider carrying per-particle spacing (or per-garment min_dist) instead of the global max.

### M3. Self-collision tunneling at low substep counts, then repulsion-only wrong-side lock
**Fichier** : `src/engine/solver/ParticleSystem.ts`

The repulsion in selfCollide.wgsl has no side information: once two cloth regions interpenetrate, the pairwise push separates them to min_dist on whichever side they ended up — locking the intersection in place (main.ts line ~329 already admits it: 'simultaneous falls interleave (tunneling locks wrong-side)'). Tunneling is easy to trigger with the current numbers: max_speed = 12 m/s, frame dt clamped at 1/30 s, and the substeps slider allows 5 (ControlPanel.ts:259) → per-substep travel up to 12·(1/30)/5 = 80 mm, versus min_dist ≈ 0.6·spacing ≈ 11 mm at resolution 64. Even at the default 20 substeps a max-speed particle moves 20 mm per substep, ~2× min_dist. Nothing in step() (ParticleSystem.ts:599) couples the substep count or max_speed to the collision thickness, so a user dragging fast or dropping a garment at 5 substeps reliably produces locked interpenetrations that never resolve.

**Correctif proposé** : Cheap and robust: enforce a CFL-style floor in step(): effectiveSubsteps = max(substeps, ceil(frameDt · maxSpeed / (0.5 · 0.6 · spacing))), or equivalently clamp per-substep displacement (|x − x_prev| ≤ 0.5·min_dist) at the end of integrate. Longer-term, make the repulsion side-aware, e.g. bias the push direction by the local cloth normal (already computed by the normals pass) so wrong-side contacts unhook instead of locking.

### M4. [✅ corrigé v58 (=C2)] Morph cache keys drop 3 of the 6 sliders — stature/carrure/cuisse changes serve stale bodies and stale grading
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

measureFor's cache key (line 153) and morphCache's key (line 276) are `${kind}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}` but Morphs has six fields (stature, carrure, cuisse as well, morph.ts:17-24). Failure: set carrure to 110 %, build caches a measurement; move carrure again (poitrine/taille/hanches unchanged) → measureFor returns the FIRST carrure's measurements, so shoulderR/dressScale/topScale (lines 290-295) grade the garment for the wrong body. Worse for scan avatars: morphCache returns the previously morphed SDF grid and render mesh, so moving the stature/carrure/cuisse sliders visibly does nothing after the first morph — the collider and the displayed body stay stale.

**Correctif proposé** : Include all six morph values in both keys (e.g. `${kind}|${Object.values(morphs).join('|')}`), or key on a serialized Morphs object. One-line fixes at main.ts:153 and main.ts:276.

### M5. [✅ corrigé v64] Surface-nets body re-meshed on every build for morphed bodies, and bodyMeshCache leaks unboundedly
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/SceneGeometry.ts`

bodyMeshCache (line 34) is a Map keyed by SdfPrim[] ARRAY IDENTITY. morphPrims (morph.ts:61) returns a fresh array on every build, and build() runs on every slider commit / pattern-handle release (main.ts:243). So with any non-neutral morph, each build (a) misses the cache and re-runs surfaceNets over ~1.3 M grid corners × ~30 smin'd round cones at cellSize 0.008 (bounds ~0.86×1.79×0.5 m → 108×192×63 cells) plus ~6 sdBody evals per output vertex for normals — a 0.5–2 s main-thread freeze per slider commit, not the '~100 ms' the comment claims; and (b) inserts a new ~2–3 MB mesh (≈40 k verts pos+nrm+indices) into the Map which is never evicted — dragging sliders for a minute leaks tens of MB. bodyRestVertices (used for skinning) hits the same path.

**Correctif proposé** : Memoize morphPrims per (kind + full morph key) in main.ts so the same array instance is reused across builds (also fixes the identity-keyed cache), and/or key bodyMeshCache by a value string with an LRU cap of ~4 entries. Optionally coarsen cellSize to 0.012 for morphed previews.

### M6. Full-resolution 2D mirror blit of the WebGPU canvas every frame, for all users
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

blit() (lines 71-78) does mirrorCtx.drawImage(webgpuCanvas) every frame into a full-viewport 2D canvas layered over #view (index.html #mirror, z-index 1), as a workaround for machines whose compositor never presents WebGPU. On the 99 % of systems where WebGPU presents fine, every frame pays: a GPU→canvas copy of the full surface (at dpr ≤ 2 that's up to ~4K×2K), a second full-screen composited layer, and ~2× the canvas memory (~33 MB extra at dpr 2). On the integrated-GPU target this is easily 1–3 ms/frame — comparable to the entire sim budget — and it runs even when the sim is asleep.

**Correctif proposé** : Make the mirror a detected fallback: after a few frames, test whether the WebGPU canvas actually presented (e.g. one-time drawImage into a 1×1 canvas + getImageData, or a user toggle/query param); hide #mirror and skip blit() when presentation works. Expected: 1–3 ms/frame back on iGPUs plus ~30 MB memory.

### M7. [✅ corrigé] Both scan avatars fetched serially and eagerly at startup, blocking first paint
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Lines 143-146: `await loadScanAvatar('homme-scan')` then `await loadScanAvatar('femme-scan')` run sequentially inside main() BEFORE build() and the first rendered frame, even for the default 'drapé' scene that uses neither. Each avatar is a ~60 k-tri mesh plus an int16 SDF grid (several MB each), and ScanAvatar.ts:44-45 converts the full grid Int16→Float32 on the main thread. On a median connection this adds seconds to time-to-first-frame for content that may never be selected.

**Correctif proposé** : Load lazily on first selection of a scan body (cache the promise in the `scans` record; onBody awaits it then build()s), or at minimum start both with Promise.all in the background and don't await before build(). Expected: startup drops to network-free time; scan selection shows a brief one-time load instead.

### M8. [✅ corrigé v69] Every build() recompiles all 10 shader modules and pipelines synchronously
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/solver/ParticleSystem.ts`

The ParticleSystem constructor (lines 310-332) creates 8 compute pipelines with fresh createShaderModule + synchronous createComputePipeline, and ClothRenderer's constructor (lines 293-370) compiles 3 more modules and 2 render pipelines — on EVERY build(), i.e. every resolution/scene/morph/pattern-handle commit (main.ts:243). The WGSL is constant and pipelines are device-lifetime objects independent of mesh size; recompiling them per rebuild adds main-thread jank (sync pipeline compilation can be tens to hundreds of ms on first-run per driver) stacked on top of the mesh regeneration cost.

**Correctif proposé** : Cache pipelines per GPUDevice in a module-level WeakMap (build once, reuse across ParticleSystem/ClothRenderer instances); bind groups already get rebuilt per instance and can keep using pipeline.getBindGroupLayout(0). Expected: rebuilds become buffer-upload-only (a few ms).

### M9. [✅ corrigé v72] Every mirror-seamed particle pair also carries a contradictory 'flattening' distance constraint (rest 2·spacing vs seam rest 0.15·spacing)
**Fichier** : `src/engine/cloth/ClothMesh.ts`

The cross-seam flattening loop (lines 711–730) adds a Bending distance constraint front↔back for every kept 4-neighbour of a seam particle, intending 'cells one ring inside a stitched edge'. But the neighbours of a seam particle ALONG the boundary are themselves seam particles, so the same (front, back) pair gets both a Seam constraint (rest = 0.15·gridSpacing, solved at compliance_stretch) and a Bending constraint (rest = 2·gridSpacing, compliance_bend) — verified empirically: at n=32 aline 66/66 mirror-seam pairs are duplicated (skirt 56/58, setin 70/70, pants 102/104, tshirt 62/78, and proportionally at 64/128). Every substep the bending constraint injects an opening impulse (C = 0.15s − 2s = −1.85s) that the seam must re-cancel: seams sit slightly open, the solver fights itself, jitter at low substeps. Bonus wrongness: opening-rim neighbours (neckline/hem particles adjacent to a seam particle) also get the 2·spacing front↔back tie, which is a spurious squeezing force on the neck opening (front rim to back rim distance should be the neck circumference chord, far more than 2·spacing).

**Correctif proposé** : Two-pass construction: first collect seamedLocal (already exists), then add flattening ties only to neighbours that are kept AND not on the boundary (i.e. interior — reuse onBoundary), which matches the stated 'one ring inside' intent and removes both the seam contradiction and the rim squeeze.

### M10. [✅ corrigé] setin: unsewn underarm rows at ALL production resolutions (32/64/128) — hole between armhole seam end and side-seam start
**Fichier** : `src/engine/cloth/ClothMesh.ts`

The sleeve band ends at CAP_V1 = 0.34 (line 372), so island-to-island armhole seams stop there, but isOpening's setin armhole-zone exclusion (line 438) suppresses mirror seams on the body side edge for all vv < 0.36. Body-edge boundary rows with vv ∈ (0.34, 0.36) get NEITHER seam. Empirically confirmed: 1 unsewn row at n=32 (v=11), n=64 (v=22); 2 unsewn rows at n=96 (v=33,34) and n=128 (v=44,45) — on both sides, both panels: a real gaping slit under each arm exactly where the armhole should meet the side seam, growing with resolution.

**Correctif proposé** : Make the two zones meet: change the isOpening armhole exclusion to vv < CAP_V1 + 0.5/(n-1) (pass n or a row-quantized threshold through), or raise CAP_V1 to 0.36 so the last armhole-stitched row abuts the first mirror-seamed side-seam row. Add a sweep test asserting every non-opening body-edge boundary particle carries at least one seam.

### M11. [✅ corrigé] Neckline sewn shut one row below the scoop at ~40% of resolutions (aline, tshirt, setin) — opening slack smaller than one grid row
**Fichier** : `src/engine/cloth/ClothMesh.ts`

isOpening uses fixed v-thresholds (aline vv < 0.13 vs scoop depth 0.12; tshirt/setin vv < 0.1 vs scoop depth 0.09, lines 426–434). The boundary particles on the scoop's BOTTOM rim sit on the first grid row with v ≥ scoop depth; whenever that row's vv lands past the threshold, those rim particles are mirror-seamed — the front of the garment is stitched to the back directly under the neck hole. Empirically confirmed at n=16,19–24,27–31,35–39,43–47 (aline), n=16–21,24–31,35–41,46–48 and n=80 (tshirt, setin: e.g. n=80 particles at x=0.006, vv=0.101 seamed). The current UI resolutions 32/64/128 pass only by rounding luck (0.12·(n−1) happens to land < 0.13 threshold); any new resolution, or tests at n=16, silently produce a pinched chest.

**Correctif proposé** : Make the opening test row-aware instead of using fixed slack: a boundary particle is a neckline opening if the CUT neighbour that made it boundary lies inside the scoop region (test the cut neighbour's (u,v) against the scoop inequality), or set the v-threshold to scoopDepth + 1.5/(n-1). Same pattern fixes the 0.01–0.02 x-slacks (e.g. tshirt x < 0.12 vs scoop 0.11, which already narrows the neck ring by one particle at n=32).

### M12. [✅ corrigé v59 (seamFree)] Cross-garment seams (robe froncée waist/embu) are fought by self-collision: gathered seam held open at 0.6·spacing
**Fichier** : `src/engine/solver/shaders/selfCollide.wgsl`

The 'robe froncée' scene (main.ts:407–417) sews bodice bottom row to skirt top row with seams of rest 0.15·spacing, passing layerB=0 ('they share a boundary, not a surface'). But selfCollide's exclusion (lines 80–84) sets same_garment = (pi/2 == pj/2), which is false between bodice panels {0,1} and skirt panels {2,3}, so every waist-seam pair (and their adjacent rows) is repelled to min_dist = 0.6·spacing (ParticleSystem.ts:523) with 0.3 relaxation each substep — a permanent tug-of-war against the rigid seams. The gathers (embu) that this scene exists to demonstrate are systematically pushed open, with jitter and wasted solver work concentrated at the waist. (min_dist here is even 0.6 of the COMBINED max spacing = the 1.6×-wider skirt's, i.e. ≈ 0.96× the bodice's own weave spacing.)

**Correctif proposé** : Exclude cross-seamed pairs from self-collision: upload a small per-particle flag or a sorted cross-seam pair list from combineClothMeshes and skip pairs where both particles carry the seam flag and are within ~2 rows of the seam row; alternatively treat the seam-adjacent row bands of cross-seamed garment pairs as same_garment. Verify live: waist gap should settle at seamRest, not min_dist.

### M13. [✅ corrigé v58 (=C1)] Fit-map strain and normals use horizontal spacing for vertical neighbours — baseline strain of −35% to +37% on every non-square panel
**Fichier** : `src/app/ClothRenderer.ts`

The normals/strain shader (line 66: strain = sum/cnt/grid.spacing − 1) averages the distances to all four grid neighbours and divides by the single spacing = width/(n−1). Vertical rest distance is height/(n−1), which differs on every real garment: tee width 1.15 vs height 0.75 → vertical neighbours read −35% 'compression' at perfect rest; robe width ≈0.95 vs height 1.3 → +37% fake elongation. The fit map (the tailor feature smuggled in normal.w) is dominated by this constant bias rather than actual fabric strain, and the motif UV scaling has the same anisotropy. Also grid.spacing for combined outfits is max(a,b), further biasing garment a.

**Correctif proposé** : Add vertical spacing (and ideally per-panel spacing for combined meshes) to GridInfo; normalize u-neighbour distances by spacingU and v-neighbour distances by spacingV before averaging. Same for the motif UV meters-per-cell.

### M14. [✅ corrigé] poseIdle animates the LEGS of morphed armless bodies — identity check `bodyPrims !== BODY_FORM` misclassifies morphed dress forms as ARMS bodies
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Line 470: `if (bodyPrims && bodyPrims !== BODY_FORM && bodyPrims !== BODY_MALE)` enables arm animation. morphPrims() returns a NEW array, so in robe/robe froncée/tenue scenes (which use the armless BODY_FORM/BODY_MALE) any non-neutral morph makes the check pass. poseIdle then swings the last 8 primitives assuming they are arms — for the 24-prim armless female form those are knee L/R, shank L/R, calf L/R, foot L/R. Verified by execution: foot prim b goes from z=0.140 to z=0.271 (feet/shanks kick ±18° about a pivot at the knee), and system.setColliders feeds these posed leg prims to the solver every frame, so the collider under a floor-length dress churns.

**Correctif proposé** : Decide animation from the BASE selection, not array identity: set a `hasArms` boolean where basePrims is chosen (line ~260, true only for the *_ARMS variants) and gate line 470 on it. Optionally make poseIdle take the arm count explicitly.

### M15. [✅ corrigé] Thigh caliper halved by the smin-fused crotch: inner ray never exits, inner=0 silently accepted — female thigh measured 28.6 cm instead of ~44 cm
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/body/measure.ts`

At thighY=0.722 on BODY_FORM, the k=0.04 smooth-min closes the gap between the thighs: sd(0, 0.722, 0) = −0.010 (verified). In legHalfW (lines 149-159) the inner march from legX toward the centerline therefore never finds sd>0 within 0.2 m, `inner` stays 0, and `(inner + outer) / 2 || 0.06` returns (0 + 0.070)/2 = 0.035 — half the true half-width (0.070, verified by profiling the field: leg spans x∈[~0, 0.158] fused). REF.thigh.circ = 28.6 cm feeds baseCm.cuisse, so the cuisse slider baseline shown to the user is ~16 cm too small and any realistic target cm rams the ratio into the 1.3 clamp, ballooning the thighs.

**Correctif proposé** : Treat an unset side as a miss: after the loop, if inner===0 use inner=outer (symmetric leg), and same for the z caliper; alternatively march inner from the crotch outward or measure where sd(0,y,0)>0 guarantees separated legs.

### M16. [✅ corrigé v64] Every morph-slider release re-runs surfaceNets (930 ms, main thread) and leaks the result into an unbounded identity-keyed cache
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/SceneGeometry.ts`

bodyMeshCache (line 34) is a Map keyed by the prims ARRAY. morphPrims returns a fresh array per build, so every slider release misses the cache, re-samples sdBody over ~1.2M grid corners × ~32 prims (measured 930 ms for BODY_FORM_ARMS at cellSize 0.008 — a hard UI freeze per adjustment) and permanently retains the old ~31k-vertex mesh (~1.5 MB/entry) plus its key. buildSkin, by contrast, is only 17 ms — startup skinning cost is a non-issue; the field sampling is the entire cost.

**Correctif proposé** : Morphed sculpted bodies should reuse the cached BASE mesh warped through morphMesh() (identical warp already used for scans) instead of re-meshing the field; keep surfaceNets only for the small set of base forms. At minimum evict non-base entries or key by kind+morphs with a size-1 LRU.

### M17. [✅ corrigé] Chest band overlaps the waist band: chestY detected at the diaphragm (1.158) instead of the bust (1.275) on BODY_FORM — poitrine and taille bells nearly coincide
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/body/measure.ts`

Chest search (line 127) starts at 0.62H, below the waist band's top (0.66H, line 134). On BODY_FORM the fullest ellipse in-band is the ribcage bottom at y=1.158 (79.4 cm), marginally beating the true bust level at 1.275 — so chestY lands 6 cm above waistY (1.098). Consequences verified: the poitrine bell (width 0.14) is centered on the diaphragm, so moving poitrine inflates the waist region (bell value 0.83 at the waist mark) and the two sliders alias almost completely; it is also the root cause of the 1.58 combined-bell overshoot above. The scan detector picks a correct bust (1.233) — only the sculpted forms are affected.

**Correctif proposé** : Raise the chest band's lower bound above the waist band, e.g. from 0.62H to 0.68H (bust anthropometry ≈ 0.72H); on BODY_FORM this moves chestY to ~1.27 and separates the bells by 17 cm.

### M18. [✅ corrigé] Imported .toile.json scalars applied with zero type/range validation — NaN/Infinity injection, DoS via resolution/substeps
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

applyGarment (lines 510-533) copies nearly every numeric field with bare `??`: `s.resolution = d.sim.resolution ?? s.resolution`, `s.substeps = d.sim.substeps ?? ...`, `s.dressLength = d.pattern.length ?? ...`, all four *Exp fields, friction, wind. `??` only filters null/undefined, so strings, negatives, and non-finite numbers pass. Concrete failure paths: (1) JSON.parse('{"sim":{"substeps":1e999}}') yields Infinity (JSON.parse maps 1e999 to Infinity — no NaN literal needed); the frame loop reads `panel.substeps` and dispatches that many substeps → tab hang. (2) `"resolution": 1024` → onResolution → generateSeamedPanels with n=1024 → 2M particles, ~12M constraints; colorConstraints runs for minutes and the constraint buffer (~192 MB) exceeds default maxStorageBufferBindingSize → device loss. Valid values are only [32, 64, 128] (ControlPanel.ts:254). (3) `"length": 1e999` or `"length": -1` → generateSeamedPanels height Infinity/negative → `topY - vAdj*height` = -Infinity/NaN positions → frontOutline's finite guard bails and the solver runs on NaN forever. (4) `"stretchExp": 400` → `10 ** 400` = Infinity compliance → NaN in distance.wgsl. (5) motifCouleur (line 520) checks Array.isArray and length===3 but not element types — `["a","b","c"]` flows into the style uniform as NaN. Note the contrast: `profile` arrays ARE validated hard (lines 571-584) and body/preset/motif are whitelisted — the scalars were simply missed. Since .toile.json is the shareable open format for a public demo aimed at a non-developer, hostile or corrupt files are the expected input class.

**Correctif proposé** : Add a `num(v, min, max, fallback)` helper (typeof number && Number.isFinite && clamp) and route every scalar through it using the same ranges as the GUI sliders (dressLength 0.9-1.55, flare 0.25-0.5, neck 0.06-0.16, sleeve 0.33-0.47, skirtLength 0.4-0.75, skirtFlare 0.3-0.46, exps -8..-3, friction 0..1, wind 0..12, substeps round+clamp 5..40). Validate resolution against the whitelist [32,64,128], and motifCouleur elements as finite numbers in [0,1].

### M19. [✅ corrigé v71] Import silently discards the saved body measurements (d.morph never applied)
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

exportGarment() writes a `morph:{stature,carrure,poitrine,taille,hanches,cuisse}` block (line ~420), but applyGarment() never reads `d.morph` — it handles d.sim, d.fabric, d.pattern, d.body, d.scene only. Worse, the call order guarantees loss even of session values: `this.cb.onBody(s.body)` (line 545) triggers main.ts onBody, which resets morphs to NO_MORPH and calls panel.syncMorphCm(baseCm(...)), synchronously overwriting settings.stature/carrure/... with the base body's cm. Then `this.cb.onMorph({stature: s.stature, ...})` (line 546) reads those overwritten base values → ratios all ≈1 → neutral morph. A user who saved a garment fitted on a 160 cm / 120 cm-hips mannequin reopens the file and gets the default figure; the garment file's whole point (reproducible fit) silently fails.

**Correctif proposé** : In applyGarment, read d.morph into local variables (validated numbers, clamped to the slider ranges), call cb.onBody first, then assign the file's cm into settings, updateDisplay, and call cb.onMorph with the file's values (not settings read after onBody).

### M20. [✅ corrigé v58 (=C2)] Tailor caches keyed on only 3 of 6 morphs — stale grading for stature/carrure/cuisse changes
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

measureFor's cache key (line 153) and morphCache's key (line 276) are `${kind}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}`, but morphScale/morphPrims/morphGrid (morph.ts) warp with all six morphs including stature (uniform scale), carrure (shoulders) and cuisse. Concrete failure: open 'robe' on femme (caches key 'femme|1|1|1' with the unmorphed measure), then set stature to 150 cm. build() computes correctly morphed bodyPrims, but measureFor returns the cached 175 cm measure → dressScale=1, dyShoulder=0 → the dress is cut for the tall body and spawned at topY 1.6 m, floating above the 150 cm mannequin's shoulders; it drops and slides off. Same for carrure, which directly drives shoulderR → dressScale/topScale (the 70/30 grade), and for scan bodies the morphed SDF grid/mesh cache returns a body morphed with stale stature/carrure/cuisse.

**Correctif proposé** : Include all six morph values in both cache keys, e.g. a helper `morphKey = (k) => `${k}|${morphs.stature}|${morphs.carrure}|${morphs.poitrine}|${morphs.taille}|${morphs.hanches}|${morphs.cuisse}``, used at lines 153 and 276.

### M21. [✅ corrigé v71] Keyboard R (reset) and P (pins) don't wake the sleeping solver — cloth freezes mid-air
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

The keydown handler (lines 823-832) calls system.reset() / setCornerPins() but never wake(), unlike the panel's onReset/onPins callbacks which do. With the scene settled and asleep=true (sim suspended), pressing R writes the rest-pose positions to the GPU: the renderer immediately draws the cloth teleported back to its initial drop cylinder, but `if (!sleeping) system.step(...)` keeps skipping the solve — the fabric hangs frozen in mid-air indefinitely (until some other interaction happens to wake it). Pressing P to release pinned corners while asleep likewise leaves the cloth pinned-looking: it should fall but stays frozen. Looks exactly like a crash to a non-developer.

**Correctif proposé** : Call wake() in both keyboard branches (R and P), mirroring the panel's onReset/onPins callbacks. Optionally also wake in onSelfCollision (see separate finding).

### M22. [✅ corrigé v72] GPU device loss and frame-loop exceptions freeze the app with no error banner
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Two silent-freeze paths escape the error surfacing that showFatal/uncapturederror otherwise provide. (1) Device.ts handles device.lost with only console.error ('the app layer may subscribe later' — it never did); after a driver reset (plausible at résolution 128 + self-collision on an iGPU) every queue.submit is a no-op and the canvas freezes with zero on-screen feedback. (2) frame() (line 854) runs from rAF/setTimeout; any exception inside it (e.g. renderer/system calls after a device loss, or a future logic bug) is not caught by main().catch — the throw skips the trailing schedule(), the previously armed 50 ms watchdog fires once, throws again, and then no timer is armed: the loop is permanently dead, silently. The startup banner only covers errors thrown before main() returns.

**Correctif proposé** : Wire device.lost to the overlay: have initGpu accept an onLost callback (or return the promise) and call showFatal('GPU perdu', ...) in main.ts. Wrap frame()'s body in try/catch and route to showFatal so the user always sees why the picture stopped.

### M23. [✅ corrigé v73] Mobile: second touch corrupts orbit (shared lastX/lastY, no pointerId), and touch has no zoom at all
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/OrbitCamera.ts`

attach() keeps a single mode/lastX/lastY for all pointers and never records which pointerId owns the gesture. On a touch screen (pointerType 'touch' always orbits), putting a second finger down re-enters the pointerdown handler: mode stays 'orbit' but lastX/lastY jump to finger 2; subsequent pointermove events arrive interleaved from both fingers, so dx/dy alternate between large opposite jumps — the camera spins violently. And the natural gesture the second finger was attempting (pinch-zoom) doesn't exist: zoom is wheel-only, so a phone/tablet visitor of the public demo can never zoom, and any accidental two-finger touch throws the view into chaos. pointerup from either finger also kills the other finger's gesture (mode='none' unconditionally).

**Correctif proposé** : Track the active pointerId and ignore events from others for orbit/pan; maintain a small Map of active touch pointers and when two are down, drive this.radius from the change in inter-finger distance (pinch zoom) and optionally pan from the midpoint delta.


## 🟨 mineur — 37

### M1. Seam constraints (kind 3) silently inherit weft stretch compliance *(non contre-vérifié)*
**Fichier** : `src/engine/solver/shaders/distance.wgsl`

Lines 79-82: the compliance lookup handles kinds 1 (shear), 2 (bend), 4 (warp) and defaults everything else — including kind 3 (Seam) — to params.compliance_stretch. ConstraintGraph.ts documents Seam as 'solved rigid, like structural'. That holds only while the stretch slider is at its 0 default: dial in a stretchy fabric (compliance_stretch > 0, e.g. a knit preset) and every sewn seam becomes as elastic as the fabric — seam joints of rest 0.15·spacing elongate, panel assemblies gape at the stitch line, and the elasticated-waist grip weakens, none of which matches real thread which is far stiffer than the cloth.

**Correctif proposé** : Add an explicit branch: `else if (c.kind == 3u) { compliance = 0.0; }` (or a dedicated tiny compliance_seam uniform if tunable seam elasticity is ever wanted).

### M2. Dihedral XPBD denominator mixes α inconsistently with the √(1−d²)-folded gradient — bend compliance becomes fold-angle dependent *(non contre-vérifié)*
**Fichier** : `src/engine/solver/shaders/dihedral.wgsl`

Lines 91-100: the paper's q-vectors are gradients of d = n1·n2, so the true constraint gradient of C = acos(d) − φ0 is ∇C_i = −q_i/√(1−d²), giving Σw|∇C|² = denom/(1−d²). Exact XPBD therefore yields Δp_i = w_i·q_i·C·√(1−d²)/(denom + α̃·(1−d²)). The code computes s = −c·√(1−d²)/(denom + α̃) — i.e. it uses α̃ where α̃·(1−d²) belongs. Since 1−d² ≤ 1, the projection is systematically SOFTER than the dialed compliance, and the error grows as the hinge approaches flat or fully folded (d → ±1), where the constraint response shrinks toward the PBD-with-extra-damping regime. The compliance_bend slider consequently doesn't mean the same stiffness at different fold angles or across garments with different rest angles. (The /spacing² normalization on line 98-99 is a fine, documented heuristic — this is specifically about the α̃ vs α̃·(1−d²) mismatch.)

**Correctif proposé** : Multiply alpha by (1−d²) in the denominator: `let s = -c * sqrt(1-d*d) / (denom + alpha * (1.0 - d * d));` — one-character-class change, restores exact XPBD compliance semantics for the acos formulation.

### M3. Cross-panel mirror exclusion applies across the entire panel interior — a flattened front/back tube interpenetrates at mirror-aligned points *(non contre-vérifié)*
**Fichier** : `src/engine/solver/shaders/selfCollide.wgsl`

Lines 83-84: within a garment, pairs with dl ≤ 2, |dl−n| ≤ 2, or |dl−2n| ≤ 2 are excluded EVERYWHERE, not just near the sewn boundary. The mirror particle (same u,v on the other panel) is exactly dl = 0. So when the front and back panels of a garment come into mirror-aligned contact away from any seam — a tube collapsing flat with no body inside, a loose hem folding front-onto-back — those exact-mirror pairs get no repulsion and the panels can pass through each other in patches (off-mirror pairs still repel, producing a mottled half-colliding contact). The exclusion only needs to protect particles within ~2 cells of a seamed boundary, where repelling the mirror would ladder the seam open.

**Correctif proposé** : Precompute per-particle distance-to-seam on the CPU (breadth-first from seamedLocal in ClothMesh.ts, clamped to e.g. 3) and upload it as a per-particle u8/f32 buffer; apply the cross-panel mirror exclusion only when BOTH particles have seam-distance ≤ 2. Reuses the existing layers-buffer pattern in ParticleSystem.

### M4. sd_body early-out margin hardcodes 2 layer gaps — contacts culled for garments at layer ≥ 4 *(non contre-vérifié)*
**Fichier** : `src/engine/solver/shaders/collide.wgsl`

Line 147: `margin = cloth_thickness + 2.0 * layer_gap + blend_k + 0.012`, but the contact test on line 172 uses `thick = cloth_thickness + layers[i] * layer_gap` with no upper bound on layers[i]. With layer_gap = cloth_thickness = 0.01 (ParticleSystem.ts:700), the +0.012 slack absorbs layer 3, but a particle at layer ≥ 4 has thick exceeding the margin, so primitives get skipped by the bounding-sphere reject on line 154 while still being within contact range — the outermost garment of a deep stack clips into the body near limb extremities where only one distant primitive matters. Silent, and only bites when someone stacks 4+ garments, which combineClothMeshes happily allows by chaining.

**Correctif proposé** : Either compute the margin from the actual per-particle thick (move the margin inside main and pass it into sd_body), or write a max_layer uniform from ParticleSystem (it already owns mesh.layers at construction: maxLayer = max(layers)) and use `maxLayer * layer_gap` in the margin.

### M5. Dead GPU allocation: readbackBuffer (count × 16 bytes) is created and destroyed but never used *(non contre-vérifié)*
**Fichier** : `src/engine/solver/ParticleSystem.ts`

Lines 290-293 allocate `this.readbackBuffer` with MAP_READ | COPY_DST, but readPositions() (lines 564-589) deliberately creates a fresh disposable staging buffer per call (per its own comment about mapAsync poisoning), and nothing else references readbackBuffer except dispose(). At resolution 128 with a two-garment outfit that is 4 × 128² × 16 ≈ 1 MB of mappable GPU memory allocated per ParticleSystem for nothing — and it's re-allocated on every resolution/scene rebuild.

**Correctif proposé** : Delete the readbackBuffer field, its creation in the constructor, and its destroy() call in dispose().

### M6. Self-collision spatial hash rebuilt every substep (2 extra dispatches × substeps) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/solver/ParticleSystem.ts`

step() (lines 642-646) dispatches clear_hash (tableSize/256 groups, e.g. 128 workgroups for a 32 k table) + insert + collide every substep — at the default 20 substeps that's 40 hash-rebuild dispatches and full table traffic per frame. Per-substep particle motion is bounded by maxSpeed·dt = 12·(1/60/20) ≈ 1 cm ≈ one cell at most, and the collide kernel already searches the 27 neighbouring cells, so a hash that is a few substeps stale still finds every pair within ±1 cell.

**Correctif proposé** : Rebuild the hash once per frame (or every 4th substep) and keep only the collide dispatch per substep. Saves ~38 dispatches + associated barriers per frame; expected several-percent sim-time win at high substep counts, more on iGPUs.

### M7. Seam constraints (kind 3) silently inherit weft stretch compliance — seams gape on stretchy fabrics *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/solver/shaders/distance.wgsl`

Lines 79-82 select compliance by kind but have no branch for kind==3 (Seam), so seams fall through to compliance_stretch. ConstraintGraph.ts:19 documents seams as 'solved rigid, like structural'. With the default 1e-7 that's near-rigid, but the panel exposes stretch compliance as a log slider up to ~1e-4 (ControlPanel stretchExp): pick a stretchy jersey and every seam thread becomes as elastic as the knit — side seams and the armhole (embu) seams open under load, gathers relax, and the 0.15·spacing rest length is no longer honored. Physically a lockstitch is far stiffer than the fabric.

**Correctif proposé** : Add `else if (c.kind == 3u) { compliance = 0.0; }` (or a small fixed seam compliance) in distance.wgsl so seams stay rigid regardless of the fabric sliders.

### M8. Dead GPU allocations and dead interaction path: unused readbackBuffer, never-called setMouse, single-thread drag dispatch *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/solver/ParticleSystem.ts`

(a) this.readbackBuffer (lines 110, 290-293, 669) is allocated per system (count×16 B, e.g. 262 KB for outfits) but readPositions() creates a disposable staging buffer instead — the field is pure dead weight recreated on every rebuild. (b) setMouse (line 448) is never called from main.ts, so mouse_force stays 0 forever: the integrate.wgsl mouse-force branch (lines 66-77), the ray_origin/ray_dir/mouse_radius uniform fields, MouseForce.repelMode and the mouseStrength/mouseRadius options are all dead code (right-drag was repurposed for camera pan per the UI hint). (c) While dragging, drag.wgsl runs as a @workgroup_size(1) single-thread dispatch once per substep (step() line 639) — 20 one-thread dispatches with full inter-dispatch barriers per frame.

**Correctif proposé** : Delete readbackBuffer; remove the dead mouse-force path (or rewire it to a real gesture); fold the drag projection into integrate.wgsl or collide.wgsl behind `if (i == params.drag_index)` to eliminate the per-substep dispatch.

### M9. Frame-loop micro-overheads: readback polling while asleep and a third submit per frame for timestamp resolve *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

(a) The 300 ms readPositions poll (lines 878-934) keeps running while the sim is asleep, although positions cannot change: each poll creates a staging buffer, encodes a copy, submits, and maps — needless GPU wakeups on a page whose whole point of sleeping is idling at ~0 cost. (b) GpuProfiler.resolve() (GpuProfiler.ts:51-57) encodes and submits a third command buffer every frame just for resolveQuerySet + copy; the resolve could be appended to the renderer's encoder before submit, dropping from 3 to 2 queue submissions per frame (plus the sim submit). Individually tiny (~50-100 µs CPU each) but they run 60×/s forever.

**Correctif proposé** : Gate the poll on !asleep (posCache is already valid for picking; any wake() path resumes polling), and pass the renderer's encoder into profiler.resolve() so the resolve rides the existing render submit.

### M10. setin cutting-gap invariant violated at n=18: sleeves weld to the body (islands 3 → 1, armhole seams silently vanish) *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

The drafted gap between the body edge (x ≤ 0.22) and the sleeve cap (x ≥ capInnerX, minimum 0.263 at mid-cap) is only 0.043 u-units — less than one grid column when spacing 1/(n−1) > 0.043. Empirically confirmed: at n=18, mid-cap rows have body column x=0.2059 directly adjacent to sleeve column x=0.2647, so structural constraints weld the islands (component count = 1 instead of 3), the runs-based armhole detector sees one run and emits no seams, and the garment is a fused, unsewn mess. n=16,17,19..128 currently pass, but nothing enforces the invariant — CAP_DEPTH/CAP_BASE edits or new low resolutions will re-trip it silently.

**Correctif proposé** : Enforce the gap in the mask: cut any column with x in (bodyEdge, max(capInnerX(v), bodyEdge + 1.5/(n−1))) — i.e. clamp the sleeve inner bound to at least one full grid column beyond the body edge (needs n passed into setinShape or a post-pass that clears kept cells bridging islands). Add an island-count assertion (setin = 3) across n=16..128 to the test suite.

### M11. Anti-diagonal shear missing on boundary cells whose (u,v) corner is cut — asymmetric boundary stiffness *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

The in-panel constraint loop (lines 641–660) starts with `if (!isKept(p,u,v)) continue;`, so for a 3-kept cell missing its top-left corner, the rendered triangle (i10,i01,i11) exists (triangulation lines 853–861 handles it) but its hypotenuse (u+1,v)-(u,v+1) never gets the ╱ shear constraint — while the mirror case (missing (u+1,v+1)) does get it. Boundary triangles along cut edges with the NW corner cut can shear/collapse freely (held only by two structural edges and soft hinges), so staircase cut edges behave asymmetrically left vs right of a garment.

**Correctif proposé** : Add the ╱ shear from a cell-scoped check independent of (u,v): for each cell, if isKept(u+1,v) && isKept(u,v+1) push the anti-diagonal (guarding against double-push by keeping it only in this cell), i.e. move the ╱ case out from under the (u,v)-kept guard.

### M12. combineClothMeshes: seamCount omits crossSeams; press-hinge doc comment contradicts the π convention *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

(a) Line 1039: seamCount = a.seamCount + b.seamCount, but the crossSeams pushed at line 970 are real Seam constraints — the HUD and any test asserting seam totals undercount by crossSeams.length (128 seams in the robe froncée scene at n=64). (b) The pressing block comment (line 733) says 'PRESSING (fold angle 180°): … rest angle 0 — once sewn, the two panels are asked to continue FLAT', while the code (line 779) correctly uses restAngle: Math.PI with the note 'π = pressed FLAT'. The stale 'rest angle 0' phrasing invites a future 'fix' that would invert every press hinge (0 rad = fully folded in this acos-of-normals convention).

**Correctif proposé** : seamCount: a.seamCount + b.seamCount + crossSeams.length. Rewrite the comment to state the convention once: dihedral measured as acos(n1·n2) with flat = π, folded = 0.

### M13. Seam rest and flattening distance use horizontal gridSpacing for all seam orientations *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

seamRest = width/(n−1) × 0.15 and the flattening rest 2·gridSpacing (lines 666–667, 727) assume square cells, but vertical spacing is height/(n−1). For the tee (1.15 × 0.75) the horizontal shoulder/underarm seams and their flat-continuation distances are ~53% too long relative to the local weave; combineClothMeshes compounds this by deriving cross-seam rest from a.spacing only (line 968) even when b is wider (robe froncée skirt is 1.6×). Effect is a mild systematic looseness/tightness of seams depending on orientation and garment pairing.

**Correctif proposé** : Derive rest lengths from the local edge direction: use min(spacingU, spacingV) (or the orientation-appropriate spacing at each seam edge) for seamRest and 2×(spacing along the seam normal direction) for flattening; in combineClothMeshes use min(a.spacing, b.spacing) for cross-seam rest.

### M14. Pattern-profile handles allow silhouettes that disconnect the garment — no island/connectivity validation after cutting *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

PatternView dress handles allow profile stations down to 0.1 with neckline scoop up to 0.16 (main.ts:498–505). At e.g. neck=0.16, station1=0.1, the strap zone at vv≈0.03 is sideHalfWidth≈0.172 minus scoop≈0.155 = 0.017 u-units — less than one grid column at n=64 (0.0159): rows with zero kept strap columns break the strap, splitting the dress into a free-falling top fragment plus body, with no error or warning (the same silent failure mode as the setin fusion, in the opposite direction). generateSeamedPanels never checks that the kept mask has the expected number of connected components.

**Correctif proposé** : After building `kept`, run a cheap flood-fill and compare component count to the shape's expectation (1, or 3 for setin); on mismatch either clamp the offending parameters or surface a warning to the panel ('patron déconnecté'). This also permanently guards findings on setin fusion and future shapes.

### M15. elasticTop band collapses to a single row of horizontal edges at n ≤ 17 *(non contre-vérifié)*
**Fichier** : `src/engine/cloth/ClothMesh.ts`

Line 647 applies the elastic ratio to horizontal edges where v/(n−1) < 0.06. At n=16–17 only row v=0 qualifies (row 1 is at 0.0667/0.0625), so the 'elasticated waist that gathers and GRIPS' is one chain of shortened edges with no vertical extent — grip strength changes discontinuously with resolution (1 row at n=16, 2 at n=32, 4 at n=64, 8 at n=128), so the same garment holds up at 64 and can slide off at 16.

**Correctif proposé** : Quantize the band to a minimum row count: apply to v < max(2, round(0.06·(n−1))) rows, and consider scaling the ratio toward 1 with fewer rows so total gathering force is resolution-independent.

### M16. Shoulder band bottom (0.79H) clips the scan's true deltoid — shoulderY pins to the band edge and width is underestimated *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/body/measure.ts`

For the femme scan (H=1.65), outerX is still rising as y decreases through the band start: 0.215 at 0.79H=1.304 vs 0.220-0.225 at 1.24-1.28 (verified). The widest in-band point is therefore the band's edge itself (shoulderY = 1.3035 = first band sample), the true deltoid lies below, and shoulderHalfW is ~4% low — dressScale (70% shoulder-weighted) and dyShoulder inherit the error. A slightly slouched future scan would clip harder.

**Correctif proposé** : Lower the band start to ~0.76H and reject arm takeover explicitly (e.g. stop when outerX starts growing faster than a deltoid slope, or require the width sample to connect to the torso at z=0), or detect the local maximum instead of a band-edge max.

### M17. thighY = hip.y − 0.17 in fixed meters ignores stature *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/body/measure.ts`

Line 147 subtracts a constant 0.17 m from hip.y. For a stature-morphed or short body (H=1.3, hip≈0.61) this lands at y≈0.44 near the knee (knee at ~0.36), so the 'mid-thigh' caliper and the cuisse morph mark drift toward the knee, where the cuisse bell (width 0.12) then fattens knees rather than thighs.

**Correctif proposé** : Scale the offset with stature: thighY = hip.y − 0.10 * H (≈0.17 m at H=1.75).

### M18. Nothing enforces the s ≤ 1 squash contract — an s > 1 primitive silently breaks the fast-reject bound and collider AABB (tunneling) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/engine/body/BodySdf.ts`

sdRoundCone's conservative rescale (multiply by min(s)) and primBoundRadius (line 32, 'scale ≤ 1 keeps this conservative'), plus the WGSL bound in collide.wgsl:152 and the AABB built from unsquashed endpoint±r in ParticleSystem.ts:248, are all only conservative for s components in (0,1]. Current body data respects this, but the SdfPrim type doesn't: one future prim with s.x=1.2 makes the world shape poke outside both the per-prim reject sphere and the body AABB — particles there skip collision entirely and the cloth tunnels with no error anywhere. Also note the distance UNDERestimate factor min(s) reaches 0.55 on hands/feet, so grid-free contacts on those parts trigger ~2x early (visible hover) — a documented trade-off, but worth knowing it is largest exactly on the terminal parts.

**Correctif proposé** : Validate at construction (in the `rc` helper or toColliders): assert every s component ∈ (0, 1], or make the bound conservative for free by multiplying primBoundRadius and the WGSL bound by max(1, s.x, s.y, s.z) and padding the AABB likewise.

### M19. Imported scene string not whitelisted — spoofed scene desyncs the GUI and silently builds the default grid *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

Line 538: `if (d.scene) s.scene = d.scene;` accepts any truthy value (arbitrary string, even an object) while `body` two lines above is properly whitelisted. The bogus value is then passed to `onScene()`, and main.ts's scene ternary (main.ts:318-432) falls through to the plain `generateClothGrid` drapé sheet — so a garment file with `"scene":"dress"` (e.g. an anglicized or future scene name) imports its pattern/fabric but shows a bare cloth square, and the lil-gui select is left displaying no valid option. Also relevant to forward compatibility: a v2 file with a renamed scene silently degrades the same way.

**Correctif proposé** : Whitelist against the SceneMode list (the same array used at ControlPanel.ts:219) exactly like the `bodies` check at line 535, keeping the current scene on mismatch; optionally add a rename map for future/legacy scene names.

### M20. Import ignores the version field and fails completely silently — no forward-compat guard, no user feedback *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

exportGarment writes `version: 1` (line 417) but applyGarment never reads d.version. A future v2 file with restructured fields will half-apply (whatever field names still match) with no warning — the worst compat mode. Backward compat is handled ad hoc (the `'scan'` body migration at line 537, the stretchWarpExp fallback at line 522) which works for v36-era files, but nothing gates a NEWER major version. Separately, both failure modes are invisible: importGarment's `catch { /* fichier invalide — ignoré */ }` (lines 473-475) and the `d?.format !== 'toile-garment'` early return (line 508) do nothing at all — for the non-developer target user, clicking 'importer', picking the wrong file, and seeing zero reaction reads as 'the app is broken'.

**Correctif proposé** : In applyGarment: if `typeof d.version === 'number' && d.version > 1`, warn ('fichier créé par une version plus récente de TOILE') and either abort or proceed best-effort with the notice. Surface parse/format failures with a simple alert or on-canvas toast in French.

### M21. PDF tiling prints an extra near-empty page when the layout exceeds a page multiple by less than the OVERLAP band *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/patternPdf.ts`

Lines 99-102: cellW = 178 mm is the page ADVANCE, but each page actually draws cellW + OVERLAP = 186 mm of pattern space (frame is PAGE_W - 2*MARGIN). So k pages cover k*cellW + OVERLAP, yet `cols = ceil(w / cellW)` sizes the grid as if a page covered only cellW. Whenever `w mod cellW` lands in (0, OVERLAP] — e.g. w = 180 mm → cols = 2 — the last column's only content is a ≤8 mm sliver that was already fully printed inside the previous page's glue band; the user gets a whole extra column of pages (an extra ROW of pages for the same condition on h, which for a 6-row dress pattern is 5 wasted sheets) showing a hairline near the left margin. Same for rows at line 102. I verified the converse is safe: with the corrected formula, content up to w ≤ (cols-1)*cellW + cellW + OVERLAP still lands inside the last frame, so nothing goes missing at exact multiples.

**Correctif proposé** : cols = Math.max(1, Math.ceil((w - OVERLAP) / cellW)) and rows = Math.max(1, Math.ceil((h - OVERLAP) / cellH)). One-line change each; add a frontOutline-based test at w = cellW + 1 mm and w = cellW + OVERLAP.

### M22. Cut lines are bbox-filtered but never clipped — segments overstrike the page label, glue guides, and page-1 instructions; calibration square sits on top of the pattern *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/patternPdf.ts`

Lines 126-135 keep any segment whose bbox touches the frame ±5 mm, then draw it FULL length with pdf.line — there is no clipping. At resolution 32 a boundary segment is ~grid-spacing long (width/(n-1) ≈ 30-40 mm; cut-cell diagonals ~55 mm), so kept segments routinely extend tens of mm past the frame: through the top margin where the page label sits (label at y = MARGIN-3 = 9 mm, line 121), across the dashed glue guides (a stray solid line in the glue band can be mistaken for a cut line when taping), and over the two instruction lines drawn INSIDE the frame at PAGE_H - MARGIN - 6/-2 (lines 146-153). On page A1 the 100 mm calibration square (line 142) and the grain arrow (155-159) are drawn in the same region the pattern occupies — with a garment wider than ~90 mm the square's solid 0.4 mm edges cross real cut lines at 1:1 scale, and its edges are themselves plausible cut lines. Related sewing-correctness gap: the 'seam allowance NOT included, add 1 cm' warning (line 153) exists only on page A1 of what is typically a 20-30 page pattern.

**Correctif proposé** : Clip segments analytically to the frame rect (Liang-Barsky, ~15 lines) before pdf.line, or wrap the cut-line pass in a jsPDF clip path on the frame. Move the calibration square, grain arrow, and instructions to a dedicated cover page (page 0) so they never collide with pattern geometry, and repeat the one-line seam-allowance warning in the top margin of every page next to the page label.

### M23. glTF snapshot: podium angle and arm pose frozen at click, cloth positions captured at readback-submit time — mannequin can lag the garment *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

onGltf (lines 719-733) snapshots cSpin/sSpin and animOut synchronously at click, then read() polls sys.readPositions() up to 10 times with 50 ms sleeps. readPositions (ParticleSystem.ts:564-589) encodes the position-buffer copy at CALL time, so the cloth data reflects the sim at whichever retry attempt won — if the click lands while the 300 ms pick-cache refresh holds readbackBusy, that is 50-150 ms after the frozen pose. At 6 rpm the podium moves 36°/s, so the exported mannequin can be rotated ~2-5° behind the garment that friction is carrying, and with 'animation bras' on the arms are mid-swing away from the sleeves that drape on them. The comment (lines 716-718) claims freezing prevents exactly this skew, but freezing at click only fixes the post-readback drift, not the pre-submit retry window.

**Correctif proposé** : Sample podiumAngle and copy animOut inside the retry loop, immediately before each readPositions() call, and use the values from the attempt that succeeded — the pose is then frozen at the same tick the GPU copy is encoded.

### M24. Combined outfits export/render UVs with one global spacing — pattern-space UVs (and motif scale) are wrong for one garment of the pair *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

combineClothMeshes returns `spacing: Math.max(a.spacing, b.spacing)` (ClothMesh.ts:1024) — the two garments generally differ (ensemble: tee width 1.15·topScale vs skirt 0.85·skirtScale over the same n → spacings differ ~25-35%). The glTF UV build (main.ts:748-750) computes `uvs = (local % n) * mesh.spacing` for ALL panels with that single max value, so the smaller garment's 'rest-pose UVs in meters' are inflated by the ratio — a texture authored at real-world scale in Blender lands visibly oversized on one garment. The same single-spacing assumption feeds the renderer's print shader, so a 5 cm vichy check is only 5 cm on one of the two garments in 'ensemble'/'tenue'.

**Correctif proposé** : Carry per-garment spacing through the merge (e.g. a `panelSpacing: number[]` on ClothMeshData indexed by panel>>1, or spacing per panel) and use `panelSpacing[Math.floor(i / panelSize) >> 1]` in the UV loop and as a per-panel uniform in the print shader.

### M25. glTF export emits invalid JSON (Infinity → null min/max) if any position is non-finite *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/gltfExport.ts`

buildGlb's POSITION min/max scan (lines 93-101) uses `<`/`>` comparisons, so a single NaN component leaves min/max at ±Infinity (or propagates NaN), and JSON.stringify serializes Infinity/NaN as null — producing a .glb whose POSITION accessor has `"min":[null,null,null]`, which Blender and the glTF validator reject outright. NaN positions are reachable: an exploded self-collision state, or the unvalidated import path (finding 1) producing NaN rest positions. The only guard is main.ts's `raw.length` check — values are never inspected. Cheap insurance for the one artifact the user hands to other tools.

**Correctif proposé** : In buildGlb, sanitize during the existing min/max loop: if !Number.isFinite(v), zero the component (positions and normals). Alternatively bail with a user-visible message ('simulation instable — réinitialiser avant l'export'), since a NaN-bearing export is garbage anyway.

### M26. Garment import triggers up to ~9 sequential full rebuilds (ParticleSystem + renderer + constraint recoloring each time) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

applyGarment (lines 544-589) drives state through the live single-change callbacks: onMorph, onPattern (jumps scene to 'robe' + build), onShirtPattern (jump + build), onSkirtPattern (jump + build), onProfile ×up-to-3 (build each, main.ts:684), onResolution (build), and the final onScene (build). Each build() (main.ts:243+) disposes and recreates the ParticleSystem (constraint graph coloring over ~10^5 edges at n=128), the ClothRenderer (pipeline creation), and scene mesh. That's roughly 8-9 full GPU teardown/setup cycles — multi-second freeze at resolution 128 — to reach a state that one build could produce. dispose() is called correctly so nothing leaks, but it is pure waste with a mechanical fix.

**Correctif proposé** : Add a batching mechanism: either a `beginApply()/endApply()` pair on the callbacks that defers build() until the end, or a dedicated `onImport(state)` callback in PanelCallbacks that sets dressPattern/shirtPattern/skirtPattern/profiles/morphs/resolution/sceneMode directly and calls build() exactly once, then applies the non-rebuilding setters (compliance, friction, wind, selfCollision, style).

### M27. Audit verification notes — items checked and confirmed CORRECT (no action needed) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

For the executing session's benefit, these suspects were traced and are NOT bugs: (1) setin island winding parity (main.ts:752-762): all islands within a panel share that panel's facing — panel 0 (body front + 2 sleeve fronts) is built at z=+gap/2 with winding (i00,i01,i10) whose cross product is +z (ClothMesh.ts:596-615, 842-864), panel 1 mirrors at -z with the SAME winding, so flipping odd panels only is exactly right even with 3 islands per panel; triangles never span panels, and combineClothMeshes offsets by a.count = 2n² (even panel multiple, ClothMesh.ts:1016-1020) so global parity survives merging. (2) sRGB direction (main.ts:737-739): canvas uses getPreferredCanvasFormat() without the -srgb suffix (ClothRenderer.ts:264), so shader outputs are display-encoded sRGB; encoding them to linear via ^2.2 for baseColorFactor is the correct direction. (3) compact() (gltfExport.ts:45-64): first-use-order remap is correct for positions/normals/uvs/indices; min/max computed after compaction. (4) GLB packing: chunk alignment, space-padded JSON, zero-padded bin, per-view pad4 offsets all spec-conformant. (5) PDF tiling loses no geometry at exact page multiples (only the extra-page waste reported separately); the pad=5 slack vs OVERLAP=8 interplay correctly duplicates glue-band segments on both pages. (6) frontOutline's XOR boundary-edge trick handles the 3-corner diagonal cells correctly, and pieces wider than a page column are handled by the tiling. (7) Profile array import validation (ControlPanel.ts:571-584) is solid: exact station count, finiteness, clamping, plus the strap/waist safety clamps.

**Correctif proposé** : None — reference notes so the follow-up session does not re-litigate these; the winding-parity and sRGB conclusions are worth pinning in a code comment or test if touched later.

### M28. In-flight position readback repopulates posCache with the previous system's positions after build() *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

The 3 Hz snapshot (line 879) calls `system.readPositions().then(p => { ... posCache = p; })` without capturing which system the read came from. build() sets posCache=null and wake(), but a readback already in flight on the OLD system resolves afterwards and sets posCache (plus sleepSnapshot/driftBase) to the previous garment's positions. For up to ~300 ms after every rebuild (scene switch, pattern-slider release, resolution change), a click hit-tests against geometry that no longer exists: pickParticle returns an index valid for the old layout, and setDrag yanks an arbitrary particle of the new garment (index guard Math.min(system.count, ...) prevents OOB but not wrongness). Since users typically click immediately after adjusting a slider, this window is hit in practice. onGltf already does the right thing (captures `const sys = system`).

**Correctif proposé** : Capture `const sys = system` before the readback and in the .then bail out early when `sys !== system`; same guard protects the sleep-detector state from cross-system contamination.

### M29. Carte de tension (fitMap) silently turns off on every rebuild while the checkbox stays checked *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

build() recreates the ClothRenderer and restores the fabric look via renderer.setFabric(fabricStyle) (line 462), but never restores fitMap — ClothRenderer initializes `private fitMap = false` (ClothRenderer.ts:234). Enable 'carte de tension', then touch any pattern slider, scene, body, morph or resolution: the tension view vanishes but the panel checkbox remains checked. The user must uncheck/recheck to get it back — a classic settings/scene desync for the exact rebuild-heavy workflow (drafting) where the tension map is most useful.

**Correctif proposé** : Keep a `let fitMap = false` in main.ts, set in onFitMap, and call renderer.setFitMap(fitMap) in build() right after renderer.setFabric(fabricStyle).

### M30. Garment import: unvalidated numeric fields can hang or NaN the sim; invalid files fail with zero feedback *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

applyGarment (line 510+) validates motif fields and profiles carefully, but assigns sim/fabric numbers raw: `s.substeps = d.sim.substeps` (a file with substeps 1e6 makes frame() dispatch a million substeps → tab hang), `s.resolution` (resolution 2048 → 8.4 M particles → buffer allocations far past limits → device loss), `stretchExp`/`bendExp` (value 50 → 10^50 compliance → NaN positions, invisible cloth), motifCouleur elements unchecked for type. Separately, importGarment() swallows JSON.parse errors (`catch { /* fichier invalide — ignoré */ }`) and applyGarment returns silently on format mismatch — a non-developer who picks the wrong file gets no reaction at all and can't tell if the import worked.

**Correctif proposé** : Clamp on import: resolution to {32,64,128}, substeps to [5,40], the four exponents to [-8,-3], friction to [0,1], wind to [0,12], and check motifCouleur elements are finite numbers in [0,1]. On parse/format failure, show a small message (reuse the overlay or a transient toast) instead of silence.

### M31. Import runs ~8 sequential full rebuilds (sim + renderer + shader pipelines each time) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/app/ControlPanel.ts`

applyGarment's callback cascade (lines 545-589) — onBody, onMorph, onPattern, onShirtPattern, onSkirtPattern, up to 3× onProfile, onResolution, final onScene — each triggers main.ts build(), and every build() constructs a new ParticleSystem + ClothRenderer, compiling ~8 WGSL shader modules and pipelines and re-baking the surface-nets body mesh. That is roughly 8 complete engine rebuilds to load one file: a multi-second UI freeze on integrated GPUs, plus 8 transient garment re-drops. Only the last build matters.

**Correctif proposé** : Add a batching guard: a `suspendRebuild` flag in main.ts (or a panel-level beginImport/endImport) that makes build() a no-op while state callbacks fire, then one explicit build() at the end (the existing final onScene(targetScene) is the natural single trigger). Independently, caching shader modules per device would cut every rebuild's cost.

### M32. Startup blocks first paint on 4.7 MB of avatar downloads, fetched serially, even for the default scene *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Lines 143-146 `await loadScanAvatar('homme-scan')` then `await loadScanAvatar('femme-scan')` inside the object literal — two sequential awaits, each itself fetching mesh.bin then sdf.bin sequentially (ScanAvatar.ts), i.e. four serial round-trips totaling ~4.7 MB — all before the GPU pipelines are built and the first frame renders. The default 'drapé' scene needs neither avatar. On the public GitHub Pages link over hotel/phone bandwidth this is many seconds staring at 'initialisation…'.

**Correctif proposé** : Cheapest: parallelize (Promise.all over both avatars and, inside loadScanAvatar, both fetches). Better: don't await at startup — store the promises, and on first selection of a scan body (or once resolved) trigger build(); until then the select can show a brief 'chargement…' state.

### M33. HUD particle count includes cut-away pattern particles (e.g. 'robe' reports 8 192 part.) *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

The HUD (line 984) prints system.count, which is the full 2×n² grid: generateSeamedPanels keeps particles outside the pattern outline in the buffers, parked at (0,-10,0) with invMass 0 (ClothMesh.ts:607-611). In 'drapé' at 64 the observed '4 096 part.' is exactly right (64²), but in every garment scene the number overstates the simulated fabric by the cut fraction (an A-line robe at 64 shows 8 192 though ~35% of particles are dead), and 'contr.'/particle ratios look wrong to anyone checking. Cut particles also still cost integrate/collide dispatch lanes (they early-return, so it's mostly a reporting issue).

**Correctif proposé** : Count kept particles once per build (mesh.invMasses.filter(m=>m>0).length — but note corner-pinnable drapé grids keep invMass 1, and cut particles are the only zero-mass ones at build time) and show that in the HUD; keep system.count for internal sizing.

### M34. Dress pattern sliders force-switch the scene out of 'tenue' where the dress is already visible *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

onPattern (line 673) jumps to 'robe' whenever sceneMode !== 'robe', but the 'tenue' scene renders the very same dressPattern (length, profile, neck — lines 330-343). A user composing the layered outfit who nudges 'longueur (m)' is teleported out of their outfit into the lone dress and must manually switch back (losing the settled tee+dress drape to a rebuild anyway, plus a second rebuild on return). Same class of trap: patternHandles() (line 487) returns [] for 'tenue', so the 2D inset loses its silhouette handles in exactly the scene where the dress is styled over the tee.

**Correctif proposé** : Treat 'tenue' as a dress-visible scene: `if (sceneMode !== 'robe' && sceneMode !== 'tenue') { jump }`; and in patternHandles(), return the dress handle set for 'tenue' too (grid topY 1.78 + dyShoulder, matching the tenue cut).

### M35. 'animation bras' silently no-ops on scans/drapé yet permanently blocks sleep; toggling it off re-drops the whole garment *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

Two edges of the animate flag. (1) sleepEligible (line 870) includes `!animate` unconditionally, but animPrims is null for scan bodies, drapé/couture and dress-form scenes (line 469): checking the box there does nothing visible while forever preventing the sim from sleeping — a settled scene burns full GPU frames indefinitely (battery/fan on a laptop demo) with no cue why. (2) onAnimate(false) (line 665) calls build() to 'reset to the rest pose cleanly', which regenerates the cloth too: the user's settled garment is destroyed and re-drops from the spawn cylinder just because they turned arm animation off.

**Correctif proposé** : Gate sleep on actual animation: use `!(animate && animPrims)` in sleepEligible. For (2), instead of build(), restore the rest colliders and body mesh in place: system.setColliders(toColliders(animPrims)), renderer.updateBodyVertices(animRest), animT=0, wake() — the garment keeps its drape and relaxes onto the rest pose.

### M36. Self-collision toggle doesn't wake a sleeping solver *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

onSelfCollision (line 652) updates the solver flag but, unlike onCompliance/onFriction/onPins, never calls wake(). With a settled multi-layer scene asleep (e.g. 'ensemble'), toggling 'auto-collision' produces no visual change until some other interaction wakes the sim — then the layers suddenly interpenetrate or pop apart. The checkbox appears broken in the meantime.

**Correctif proposé** : Call wake() in the onSelfCollision callback (one line), matching onCompliance/onFriction.

### M37. Pinned particles are grabbable: the click neither drags nor orbits — a dead spot *(non contre-vérifié)*
**Fichier** : `/Users/jessymondesir/dev/toile/src/main.ts`

pickParticle (pick.ts) scans all particles without consulting invMass; tryOrbit (line 579) treats any hit as a grab and returns false (camera locked). But drag.wgsl early-returns for inv_masses[idx]==0. So a left-press on a pinned particle (corner pins via P, or a dblclick tack — visually indistinguishable fabric) grabs nothing AND refuses to orbit: the press is completely dead until release, and since dragIndex stays set, sleepEligible is false for the whole hold. Cut-away particles parked at (0,-10,0) are also candidates when a ground-ward ray passes near the origin column, with the same dead-click result.

**Correctif proposé** : Pass currentMesh.invMasses (plus the live extraPins/corner state, or read a small invMass snapshot alongside posCache) into the pick used by tryOrbit and skip zero-mass particles so the press falls through to orbit; keep dblclick picking pinned particles so tacks remain removable.
