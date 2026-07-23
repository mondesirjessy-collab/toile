# Avatars

`femme-scan.*` et `homme-scan.*` sont des corps **générés avec MakeHuman**
(via l'extension Blender **MPFB** 2.0.16, <https://extensions.blender.org/add-ons/mpfb/>),
dont les maillages et cibles morphologiques sont publiés sous **CC0 1.0**
(domaine public) par le projet MakeHuman
(<https://static.makehumancommunity.org/makehuman/license.html>).

Pipeline (reproductible) :

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

Historique : les versions ≤ v132 utilisaient les sculpts CC0 « Body
male/female realistic » de Dan Ulrich (Blender Studio, Wikimedia Commons).
