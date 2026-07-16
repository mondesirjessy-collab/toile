# mh_avatar.py — génère un avatar ANATOMIQUE via MakeHuman (extension Blender
# MPFB, assets CC0) : corps entier en T-pose, morphologie réglée par macros
# (genre, âge, muscle, poids…), géométrie d'aide supprimée (le basemesh
# MakeHuman embarque des « helpers » invisibles pour les vêtements), maillage
# subdivisé pour un SDF lisse, export STL prêt pour tools/bake.py.
#
#   blender --background --python tools/mh_avatar.py -- out.stl f|m
#
# Prérequis (une fois) : blender --command extension install-file -e mpfb.zip
import bpy
import sys

argv = sys.argv[sys.argv.index("--") + 1 :]
OUT, GENDER = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

macro = TargetService.get_default_macro_info_dict()
print("[mh] macros par défaut :", macro)
# Corps adultes moyens, ni bodybuildés ni maigres — des mannequins d'atelier.
if GENDER == "f":
    macro.update(gender=0.0, age=0.45, muscle=0.45, weight=0.5, height=0.5, proportions=0.55)
    for k, v in (("cupsize", 0.55), ("firmness", 0.65)):
        if k in macro:
            macro[k] = v
else:
    macro.update(gender=1.0, age=0.5, muscle=0.55, weight=0.5, height=0.55, proportions=0.55)

obj = HumanService.create_human(macro_detail_dict=macro)
bpy.context.view_layer.objects.active = obj
print(f"[mh] basemesh : {len(obj.data.vertices)} sommets, groupes = {[g.name for g in obj.vertex_groups][:12]}…")

# --- cuire les macros : MPFB les pose en shape keys, qui interdisent
# d'appliquer un modificateur — on fige le mélange dans les sommets. ---
if obj.data.shape_keys:
    mix = obj.shape_key_add(name="mix", from_mix=True)
    for i, v in enumerate(obj.data.vertices):
        v.co = mix.data[i].co
    for k in list(obj.data.shape_keys.key_blocks):
        obj.shape_key_remove(k)
    print("[mh] shape keys cuites dans le maillage")

# --- ne garder que le CORPS : le basemesh porte des helpers (gabarits de
# vêtements) que MPFB masque à l'écran mais qui sortiraient dans le STL. ---
body = obj.vertex_groups.get("body")
if body is None:
    raise RuntimeError("groupe 'body' introuvable")
bi = body.index
keep = set()
for v in obj.data.vertices:
    for g in v.groups:
        if g.group == bi and g.weight > 0.5:
            keep.add(v.index)
            break
import bmesh

bm = bmesh.new()
bm.from_mesh(obj.data)
bm.verts.ensure_lookup_table()
doomed = [v for v in bm.verts if v.index not in keep]
bmesh.ops.delete(bm, geom=doomed, context="VERTS")
bm.to_mesh(obj.data)
bm.free()
obj.modifiers.clear()  # le modificateur Mask des helpers ne sert plus
print(f"[mh] corps seul : {len(obj.data.vertices)} sommets, {len(obj.data.polygons)} faces")

# --- subdivision : le basemesh est un cage basse résolution ; 2 niveaux
# donnent la surface lisse que MakeHuman affiche (et un SDF propre). ---
sub = obj.modifiers.new("sub", "SUBSURF")
sub.levels = 2
sub.render_levels = 2
bpy.ops.object.modifier_apply(modifier="sub")
print(f"[mh] subdivisé : {len(obj.data.vertices)} sommets, {len(obj.data.polygons)} faces")

mn = [min(v.co[i] for v in obj.data.vertices) for i in range(3)]
mx = [max(v.co[i] for v in obj.data.vertices) for i in range(3)]
print(f"[mh] bbox : x {mn[0]:.3f}..{mx[0]:.3f}  y {mn[1]:.3f}..{mx[1]:.3f}  z {mn[2]:.3f}..{mx[2]:.3f}")

bpy.ops.object.select_all(action="DESELECT")
obj.select_set(True)
bpy.ops.wm.stl_export(filepath=OUT, export_selected_objects=True)
print(f"[mh] exporté : {OUT}")
