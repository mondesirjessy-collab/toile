# PHASE 0 — SOLVEUR DE TISSU XPBD / WEBGPU
## Brief technique pour Claude Code — Prototype de validation

**Projet** : Alternative web-first à CLO3D (nom de code à définir)
**Objectif Phase 0** : Prouver qu'un drapé de tissu temps réel, stable et crédible est atteignable dans un navigateur via WebGPU. C'est le test de faisabilité — si cette phase échoue, le projet pivote ou s'arrête.
**Durée cible** : 8–12 semaines en side-project
**Licence** : AGPL-3.0 (moteur), repo public dès le premier commit
**Livrable final** : démo publique hébergée (Vercel) — un carré de tissu qui drape sur une sphère à 60 fps, avec contrôles interactifs

---

## 1. CRITÈRES DE SUCCÈS (mesurables)

| # | Critère | Seuil |
|---|---------|-------|
| S1 | Maillage 64×64 (4 096 particules) simulé | ≥ 60 fps sur GPU intégré récent (Apple M1, Intel Iris Xe) |
| S2 | Maillage 128×128 (16 384 particules) | ≥ 60 fps sur GPU dédié milieu de gamme |
| S3 | Stabilité | Aucune explosion numérique après 5 min de simulation continue, y compris sous interaction utilisateur (drag) |
| S4 | Collision tissu-sphère | Zéro interpénétration visible à l'œil |
| S5 | Réalisme du drapé | Plis crédibles ; comparaison visuelle côte à côte avec la cloth sim Blender sur la même scène |
| S6 | Étirement contrôlé | Étirement max ≤ 1 % sous gravité (comportement quasi-inextensible, critère clé pour du vêtement) |

Si S1 + S3 + S4 sont atteints → GO Phase 1 (couture). S2, S5, S6 sont des cibles d'excellence.

---

## 2. STACK TECHNIQUE

- **Langage** : TypeScript strict
- **Rendu** : Three.js (r170+) avec `WebGPURenderer`
- **Compute** : WGSL compute shaders natifs (pas de TSL pour le solveur — contrôle total sur la mémoire)
- **Build** : Vite
- **Tests** : Vitest (tests unitaires sur la logique CPU : construction des contraintes, topologie du maillage)
- **Déploiement** : Vercel (static)
- **Fallback** : détection WebGPU au chargement ; si absent → message clair + lien navigateurs compatibles. PAS de fallback WebGL en Phase 0 (perte de temps).

### Structure du repo

```
/
├── src/
│   ├── engine/               # LE CŒUR — futur package npm autonome
│   │   ├── solver/
│   │   │   ├── XPBDSolver.ts          # orchestration CPU des passes GPU
│   │   │   ├── shaders/
│   │   │   │   ├── integrate.wgsl     # prédiction positions (semi-implicite)
│   │   │   │   ├── distance.wgsl      # contraintes de distance (stretch/shear)
│   │   │   │   ├── bending.wgsl       # contraintes de flexion (dihédrales)
│   │   │   │   ├── collideSphere.wgsl # collision + friction sphère
│   │   │   │   ├── collideGround.wgsl # collision plan sol
│   │   │   │   └── updateVelocity.wgsl
│   │   │   └── ConstraintGraph.ts     # coloration de graphe (voir §4.3)
│   │   ├── cloth/
│   │   │   ├── ClothMesh.ts           # génération grille + topologie contraintes
│   │   │   └── Material.ts            # paramètres physiques (compliance)
│   │   └── index.ts
│   ├── app/                  # la démo (séparée du moteur)
│   │   ├── Scene.ts          # Three.js : sphère, sol, éclairage, tissu
│   │   ├── Interaction.ts    # drag de particules (raycast + contrainte souris)
│   │   └── ui/Panel.ts       # contrôles temps réel
│   └── main.ts
├── tests/
├── bench/                    # scènes de benchmark reproductibles
└── README.md                 # EN, avec GIF de démo — c'est la vitrine NGI
```

**Règle d'architecture** : `engine/` ne doit JAMAIS importer Three.js. Il expose des buffers de positions bruts (`Float32Array` / `GPUBuffer`). L'app fait le pont. C'est ce qui rend le moteur publiable en package indépendant.

---

## 3. LE SOLVEUR XPBD — SPÉCIFICATION

### 3.1 Références de base (à lire avant d'implémenter)

- Macklin, Müller, Chentanez — *XPBD: Position-Based Simulation of Compliant Constrained Dynamics* (2016)
- Müller et al. — *Small Steps in Physics Simulation* (2019) → l'approche "substeps nombreux, 1 itération" qui est l'état de l'art
- Ten Minute Physics (Matthias Müller, YouTube) — épisodes cloth simulation : implémentations de référence lisibles

### 3.2 Boucle de simulation (par frame)

```
dt_frame = 1/60
n_substeps = 20            # paramètre exposé dans l'UI, plage 5–40
dt = dt_frame / n_substeps

pour chaque substep:
  1. INTEGRATE   : v += g·dt ; x_prev = x ; x += v·dt
  2. SOLVE       : pour chaque batch de contraintes (couleur):
                     - contraintes de distance (compliance α_stretch)
                     - contraintes de flexion  (compliance α_bend)
  3. COLLIDE     : projection hors sphère + sol, friction Coulomb
  4. VELOCITY    : v = (x − x_prev) / dt ; damping léger
```

Points clés :
- **Small steps** : beaucoup de substeps avec 1 itération de solve chacun > peu de substeps avec beaucoup d'itérations. C'est contre-intuitif mais démontré (Müller 2019).
- **Compliance α** : c'est l'inverse de la raideur, indépendante du pas de temps — l'avantage central de XPBD sur PBD. `α_stretch ≈ 0` pour du tissu quasi-inextensible ; `α_bend` élevé = tissu souple type jersey, faible = tissu rigide type denim. Ces deux paramètres sont la future "bibliothèque de tissus".

### 3.3 Contraintes

**Distance (stretch + shear)** : sur chaque arête de la grille — arêtes structurelles (horizontales/verticales) + arêtes de cisaillement (diagonales). Contrainte : `C = |x_i − x_j| − rest_length`.

**Flexion** : contrainte dihédrale entre paires de triangles adjacents. Alternative acceptable en Phase 0 : contraintes de distance "saut de 2" (particule i ↔ i+2), plus simples et suffisantes pour valider. La dihédrale vraie devient nécessaire en Phase 1.

**Collision sphère** : pour chaque particule, si `|x − c| < r + épaisseur` → projeter sur la surface. Friction : décomposer le déplacement tangentiel, l'atténuer par coefficient μ (statique simplifiée acceptable).

**Attache** : particules épinglables (masse inverse w = 0). La démo démarre avec les deux coins supérieurs épinglés, puis un bouton "lâcher".

### 3.4 Parallélisation GPU — le vrai problème dur

Deux contraintes partageant une particule ne peuvent pas être résolues en parallèle (race condition). Deux solutions valides, à trancher par un spike de 2-3 jours :

**Option A — Coloration de graphe (recommandée pour démarrer)** : partitionner les contraintes en "couleurs" indépendantes (calculé une fois sur CPU à l'init, algorithme glouton suffit). Un dispatch GPU par couleur. Grille régulière → ~8 couleurs (4 distance + shear + bending). Déterministe, convergence propre.

**Option B — Jacobi + atomics** : toutes les contraintes en parallèle, accumulation des deltas via `atomicAdd` (astuce : encoder en i32 fixed-point, WGSL n'a pas d'atomics float), puis moyenne pondérée. Plus simple à écrire, converge moins vite (compenser avec +30 % de substeps).

Commencer par A. Si le nombre de dispatches par frame devient le goulot (à mesurer), tester B.

### 3.5 Layout mémoire GPU

- `positions: array<vec4f>` (w inutilisé, alignement 16 bytes)
- `prevPositions: array<vec4f>`
- `velocities: array<vec4f>`
- `invMasses: array<f32>`
- `constraints: array<Constraint>` triées par couleur, offsets par couleur dans un uniform
- Tout reste sur GPU ; le rendu lit directement le buffer de positions (interop compute → render de Three.js WebGPU). **Aucun round-trip CPU par frame.**

---

## 4. LA DÉMO (l'app autour du moteur)

Scène : sol + sphère centrale, tissu 1m×1m tombant dessus. Esthétique sobre — fond sombre, tissu clair, une lumière directionnelle + ombres. (L'identité visuelle brutaliste attendra ; ici la sobriété sert la lisibilité du drapé.)

**Panneau de contrôle (temps réel, sans reload)** :
- Résolution maillage : 32 / 64 / 128 (reconstruit la scène)
- Substeps : slider 5–40
- Compliance stretch / bending : sliders log
- Friction μ : slider
- Épingles coins : toggle + bouton "reset"
- Presets tissus : « Jersey », « Denim », « Soie » (3 jeux de paramètres — préfiguration de la bibliothèque)

**HUD performance** : fps, ms/frame (simulation vs rendu séparés via timestamps GPU), nombre de particules/contraintes.

**Interaction** : drag d'une particule à la souris (raycast → contrainte temporaire vers le point projeté). C'est ce qui rend la démo virale et teste la stabilité (S3).

---

## 5. JALONS

| Semaine | Jalon | Validation |
|---------|-------|------------|
| 1–2 | Setup + spike WebGPU : buffer de particules qui tombe sous gravité, rendu points | Triangle de vérification WebGPU + 4k particules à 60 fps |
| 3–4 | Contraintes de distance, coloration CPU, tissu épinglé qui pend | Le tissu pend sans s'étirer visiblement |
| 5–6 | Bending + collision sphère + friction + sol | Le drapé sur sphère tient (S3, S4) |
| 7–8 | Interaction drag + panneau UI + HUD perf | Démo manipulable |
| 9–10 | Optimisation (S1/S2), presets tissus, comparaison Blender (S5, S6) | Benchmarks documentés dans /bench |
| 11–12 | Polish, README EN avec GIFs, déploiement public | **Lien de démo partageable = pièce maîtresse du dossier NGI** |

---

## 6. HORS PÉRIMÈTRE PHASE 0 (discipline)

- ❌ Auto-collision tissu-tissu (Phase 1, c'est le sujet dur suivant)
- ❌ Couture / patrons 2D (Phase 1)
- ❌ Avatar SMPL (Phase 2)
- ❌ Éditeur de patrons (Phase 2)
- ❌ Backend, comptes, Supabase (Phase 2+)
- ❌ Fallback WebGL / mobile
- ❌ Identité visuelle poussée

Toute tentation d'anticiper une de ces features = la noter dans `ROADMAP.md` et revenir au solveur.

---

## 7. CONNEXION AU DOSSIER NGI ZERO

Ce prototype alimente directement la candidature :
- Le **repo public AGPL** avec commits réguliers = preuve de sérieux technique
- La **démo live** = l'argument qui remplace un CV de chercheur
- Le **README** doit cadrer le projet en "commun numérique" : *moteur de simulation textile open source + format de vêtement ouvert, comme alternative aux formats propriétaires qui verrouillent l'industrie de la mode*
- La demande NGI porte sur les **Phases 1–2** (couture, patronnage, auto-collision), budget 30–50 k€, avec la Phase 0 présentée comme travail préparatoire autofinancé

---

## 8. INSTRUCTIONS DE DÉMARRAGE CLAUDE CODE

Prompt initial suggéré :

> Lis PHASE0-BRIEF.md en entier. Initialise le projet : Vite + TypeScript strict + Three.js WebGPU, structure de dossiers du §2, CI GitHub Actions (lint + tests), licence AGPL-3.0. Puis implémente le jalon Semaines 1–2 : un système de particules WebGPU (compute shader integrate.wgsl) rendu en points via Three.js, 4 096 particules sous gravité rebondissant sur un plan. Critère : 60 fps, zéro copie CPU par frame. Ne commence AUCUNE contrainte avant que ce socle tourne.

Règles de travail :
- Un jalon = une branche = une PR (même en solo, ça documente pour NGI)
- Chaque jalon se termine par une entrée dans `/bench` (scène + mesures)
- Commits en anglais (repo public international)
