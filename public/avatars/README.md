# Avatars

Pour les avatars historiques, le maillage `*.mesh.bin` sert à l'affichage et
la grille `*.sdf.bin` à la collision ressentie par le tissu. Les deux fichiers
sont cuits depuis la même surface normalisée par `tools/bake.py`. Le format
reste rétrocompatible : un maillage peut se terminer par un bloc facultatif
RGB8 (trois octets par sommet). Le mannequin neutre utilise plus bas une
séparation précise entre surface visuelle et proxy physique.

## Avatars historiques MakeHuman

`femme-scan.*` et l'ancien `homme-scan.*` sont des corps **générés avec
MakeHuman** (via l'extension Blender **MPFB** 2.0.16,
<https://extensions.blender.org/add-ons/mpfb/>). Leurs maillages et cibles
morphologiques sont publiés sous **CC0 1.0** (domaine public) par le projet
MakeHuman (<https://static.makehumancommunity.org/makehuman/license.html>).

Pipeline historique reproductible :

1. `tools/mh_avatar.py` (Blender headless + MPFB) — génère le corps
   (macros : genre, âge, muscle, poids…), supprime la géométrie d'aide,
   cuit les shape keys, subdivise ×2, exporte en STL.
2. `tools/tpose_blender.py` — monte les bras à l'horizontale (T-pose)
   par armature à poids lissés.
3. `tools/bake.py` — normalisation (pieds y=0, stature réelle, face +z),
   décimation à ~60 000 triangles pour le rendu, et cuisson d'une grille
   de distances signées (int16, millimètres) pour la collision GPU. La grille
   vise 7 mm par cellule (dimensions plafonnées à 256 pour la garantie WebGPU)
   et porte une enveloppe conservatrice de 1,5 mm contre la quantification.
4. `tools/refine_avatar_sdf.py` permet de reproduire seulement la grille depuis
   le maillage rendu déjà livré ; c'est le chemin utilisé pour migrer les deux
   assets historiques 12 mm sans les STL sources.

## Mannequin neutre masculin

Le mannequin masculin affiché comme **Neutre · Homme** conserve la clé de
document `scan homme` et le basename historique `jericho.*` afin que les
projets existants restent lisibles. Sa source est conservée dans
`tools/fixtures/neutre.source.glb` :

```text
SHA-256  a107dfc848f75ecb3d5b0c2e839da70cd9b32a60daeb91e494fe2a0708738057
Taille   43 640 octets
```

La source est un maillage fermé très léger de **885 sommets** et
**1 766 triangles**, sans squelette, UV, texture, animation ou morph target.
Elle contient toutefois 18 intersections réelles entre triangles sous les
deux aisselles. `tools/rig_neutre_avatar.mjs` refuse toute source dont le hash
diffère, puis applique une relaxation déterministe à seulement 25 sommets :

- déplacement maximal à 1,83 m : **10,106 mm** ;
- déplacement RMS global : **1,087 mm** ;
- boîte englobante et topologie inchangées ;
- auto-intersections : **18 → 0** ;
- normales recalculées sur toute la surface.

Le même outil génère des UV cylindriques de compatibilité et un rig humain de
**25 articulations** avec quatre influences maximum par sommet. La transition
clavicule–bras est calibrée pour la faible densité de la source : aucune face
ne devient dégénérée ou auto-intersectée en pose A ou T basse. Le matériau
reste celui du fichier fourni : blanc, métallique 0, rugosité 0,5, simple face,
sans image ni texture.

Le GLB livré comme `jericho.visual.glb` et sa copie identique
`jericho.export.glb` sont :

```text
SHA-256  cb23e6635743328c3637c46b0ee29343de5f3a87c4279df6ff6e9a1e8ebb3263
Taille   96 128 octets
```

La stature canonique de **1,83 m** est obtenue en mémoire par une échelle
uniforme de **1,8335812133**. La source regarde vers `-Z`, donc une rotation
rigide de π autour de Y la place face à `+Z`. Les dimensions canoniques de la
pose native sont **0,504951 × 1,830000 × 0,325890 m**. L'export combiné
vêtement + mannequin réutilise ce GLB et conserve le rig ainsi que la pose
sélectionnée.

Mesures extraites de la collision native : épaules **41,63 cm**, poitrine
**76,53 cm**, taille **61,11 cm**, bassin **84,48 cm** et cuisse **49,06 cm**.
Le modèle est volontairement très fin ; ces valeurs proviennent de sa surface
et ne sont pas une reconstruction anatomique.

Les trois collisions sont cuites depuis la même surface riggée :

- native bras baissés : **885 sommets / 1 766 triangles**, grille
  **91 × 256 × 65** ;
- A à 45° : **885 / 1 766**, grille **194 × 256 × 65** ;
- T basse à 8,53° sous l'horizontale : **885 / 1 766**, grille
  **250 × 256 × 65**.

Chaque proxy est fermé, orienté, sans triangle dégénéré et sans
auto-intersection. L'écart positif maximal entre proxy et SDF est inférieur à
1 mm dans les trois poses. Les couples A et T remplacent entièrement la
collision native pendant leur utilisation ; aucun ancien volume de bras ne
reste actif.

### Reproduire les huit assets

Prérequis : Node.js, Python 3.12, `numpy`, `pillow`, `scipy` et `libigl`.
Blender n'est pas utilisé pour construire ou convertir le modèle.

```sh
SOURCE='tools/fixtures/neutre.source.glb'
BUILD='/tmp/toile-neutre'
mkdir -p "$BUILD"

node tools/rig_neutre_avatar.mjs \
  "$SOURCE" \
  "$BUILD/neutre.rigged.glb"
cp "$BUILD/neutre.rigged.glb" public/avatars/jericho.visual.glb
cp "$BUILD/neutre.rigged.glb" public/avatars/jericho.export.glb

node tools/glb_skin_to_stl.mjs \
  "$BUILD/neutre.rigged.glb" \
  "$BUILD/neutre.native.stl"
python tools/bake.py \
  "$BUILD/neutre.native.stl" public/avatars 1.83 jericho auto

node tools/build_jericho_sewing_collision.mjs \
  "$BUILD/neutre.rigged.glb" "$BUILD/neutre.apose.glb" \
  a-pose 3.141592653589793
node tools/glb_skin_to_stl.mjs \
  "$BUILD/neutre.apose.glb" "$BUILD/neutre.apose.stl"
python tools/bake.py \
  "$BUILD/neutre.apose.stl" public/avatars 1.83 jericho.apose canonical

node tools/build_jericho_sewing_collision.mjs \
  "$BUILD/neutre.rigged.glb" "$BUILD/neutre.sewing.glb" \
  sewing-preview 3.141592653589793
node tools/glb_skin_to_stl.mjs \
  "$BUILD/neutre.sewing.glb" "$BUILD/neutre.sewing.stl"
python tools/bake.py \
  "$BUILD/neutre.sewing.stl" public/avatars 1.83 jericho.sewing canonical

node tools/validate_jericho_assets.mjs
```

Les huit fichiers publiés sont `jericho.visual.glb`, `jericho.export.glb`,
`jericho.mesh.bin`, `jericho.sdf.bin`, `jericho.apose.mesh.bin`,
`jericho.apose.sdf.bin`, `jericho.sewing.mesh.bin` et
`jericho.sewing.sdf.bin`.

### Licence et redistribution

Le GLB source ne contient **aucune métadonnée de licence**. Sa provenance et
les droits de modification et de redistribution doivent être confirmés avant
toute publication du fichier source, des STL intermédiaires ou des assets
dérivés `jericho.*` hors de l'environnement de leur propriétaire. La licence
CC0 des anciens avatars MakeHuman ne s'applique pas à ce modèle.

Historique : les versions ≤ v132 utilisaient les sculpts CC0 « Body
male/female realistic » de Dan Ulrich (Blender Studio, Wikimedia Commons).

## Mannequins CLO (Mia, Leo) — v186 à v190

Les mannequins par défaut de l'atelier sont depuis v186/v188 les avatars
**Mia** (`FV2.1_Mia.avt`) et **Leo** (`MV2.1_Leo.avt`) de CLO 2026, exportés
localement depuis l'application (Fichier → Exporter → OBJ : avatars seuls,
un seul objet, soudé, mm, Y en haut), posés via la bibliothèque de poses
CLO (`FV2_*.pos` / `MV2_*.pos`, « Pose uniquement », sans chaussures).

Pipeline reproductible, pour le natif comme pour chaque pose :

1. filtre corps seul — matériaux `arm[2]`, `body[2|3]`, `leg[2]`, `face[2]`
   (préfixe `Mara:` toléré) ; cheveux, chaussures, yeux, dents, cils écartés ;
2. réparation étanche — boucles de bord refermées par éventail au centroïde
   (0 bord libre, 0 arête non-manifold, volume signé sortant) ;
3. pré-normalisation canonique — mm → m, pieds à y = 0, stature exacte,
   centrage x/z — puis `tools/bake.py <stl> public/avatars <stature> <nom>
   canonical` (le mode `auto` se fait piéger quand l'envergure en T dépasse
   la stature).

Statures canoniques : la « Hauteur totale » de l'Éditeur d'avatar CLO —
**Mia 1,7526 m**, **Leo 1,8796 m**. Poses livrées par mannequin : natif
`<nom>.*` = **T** (FV2_T/MV2_T, la pose de couture et de mesure),
`<nom>.apose.*` = bras à 45° (A_Wide), `<nom>.attention.*` = debout bras au
corps (Attention). L'atelier coud, mesure et arrange toujours sur le natif ;
les poses n'échangent que le collider du solveur et le maillage affiché.

### Licence et redistribution

Mia et Leo sont des **avatars propriétaires CLO**, exportés dans
l'environnement de leur détenteur de licence pour un usage local et de
démonstration. Comme pour la source du mannequin neutre, leurs droits de
modification et de redistribution doivent être confirmés avant toute
publication des fichiers `mia.*` / `leo.*` hors de cet environnement.
Les replis committés restent : `jericho.*` (mannequin neutre riggé) et
`femme-scan.*` / `homme-scan.*` (MakeHuman, CC0).
