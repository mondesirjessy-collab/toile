# Avatars scannés

`homme-scan.mesh.bin` / `homme-scan.sdf.bin` sont dérivés de :

**« Body male realistic »** — Human Base Meshes, Blender Studio (Dan Ulrich
et contributions de la communauté), publié sous **CC0 1.0** (domaine public).
Fichier source : Wikimedia Commons,
<https://commons.wikimedia.org/wiki/File:Body_male_realistic_by_Dan_Ulrich_(CC0).stl>
Bundle officiel : <https://www.blender.org/download/demo-files/> (Asset Bundles).

Pipeline de conversion : `tools/bake.py` — normalisation (pieds y=0, 1,755 m,
face +z), décimation à ~60 000 triangles pour le rendu, et cuisson d'une
grille de distances signées (int16, millimètres) pour la collision GPU.
