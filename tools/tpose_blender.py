# tpose_blender.py — pose un corps scanné/sculpté en T-POSE, PROPREMENT :
# armature minimale + poids automatiques (bone heat) → l'épaule se déforme en
# douceur (pas de pli, pas d'étirement — contrairement à une rotation rigide
# découpée au plan). Tourne DANS Blender :
#
#   blender --background --python tools/tpose_blender.py -- src.stl out.stl 1.65
#
# Le mesh est normalisé (Z-up Blender, pieds à 0, hauteur donnée), les épaules
# détectées par l'écart bras/torse à hauteur de poitrine, une chaîne d'os par
# bras (clavicule → bras → avant-bras) reçoit des poids automatiques, puis le
# bras entier pivote pour amener pivot→poignet à l'HORIZONTALE. Export STL.
import bpy
import sys
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
SRC, OUT, HEIGHT = argv[0], argv[1], float(argv[2])

# --- import + normalisation (Z-up, pieds z=0, hauteur HEIGHT, centré x/y) ---
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=SRC)
obj = bpy.context.selected_objects[0]
bpy.context.view_layer.objects.active = obj

me = obj.data
n = len(me.vertices)
V = np.empty(n * 3)
me.vertices.foreach_get("co", V)
V = V.reshape(-1, 3)
ext = V.max(0) - V.min(0)
up = int(np.argmax(ext))  # l'axe le plus long = la hauteur
if up == 1:  # Y-up → Z-up
    V = V[:, [0, 2, 1]] * np.array([1.0, -1.0, 1.0])[None, :][:, [0, 2, 1]]
    V = np.stack([V[:, 0], -V[:, 2], V[:, 1]], axis=1) if False else V
    # (simple et sûr : x, z, -y)
    Vv = np.empty_like(V)
    Vv[:, 0] = V[:, 0]
    Vv[:, 1] = -V[:, 2]
    Vv[:, 2] = V[:, 1]
    V = Vv
elif up == 0:  # X-up → Z-up
    V = V[:, [2, 1, 0]]
V -= V.min(0)
V *= HEIGHT / V[:, 2].max()
V[:, 0] -= (V[:, 0].max() + V[:, 0].min()) / 2
V[:, 1] -= (V[:, 1].max() + V[:, 1].min()) / 2
me.vertices.foreach_set("co", V.ravel())
me.update()
H = HEIGHT
print(f"[tpose] normalisé : H={H:.3f}, extents={np.round(V.max(0)-V.min(0),3)}")

# --- allège le maillage (le bake final vise 60k tris ; 5M est inutile et lent) ---
dec = obj.modifiers.new("dec", "DECIMATE")
dec.ratio = min(1.0, 400000 / max(1, len(me.polygons)))
bpy.ops.object.modifier_apply(modifier="dec")
me = obj.data
V = np.empty(len(me.vertices) * 3)
me.vertices.foreach_get("co", V)
V = V.reshape(-1, 3)
print(f"[tpose] décimé : {len(me.vertices)} sommets, {len(me.polygons)} tris")

# --- détection des épaules : PAR TRANCHES (l'histogramme groupé se fait
# piéger par les hanches). À chaque hauteur, l'écart net torse|bras au-delà de
# x=0.06 ; la plus haute tranche avec écart = l'aisselle ; le nuage du bras =
# les points au-delà de l'écart DE LEUR tranche, jusqu'à la main. ---
def detect(side):
    armpitZ = None
    cut = None
    arm_pts = []
    z_hi = None
    for z in np.arange(0.82 * H, 0.40 * H, -0.008):
        sl = V[np.abs(V[:, 2] - z) < 0.005]
        sx = np.sort(sl[:, 0] * side)
        sx = sx[sx > 0.03]
        if len(sx) < 6:
            continue
        g = np.diff(sx)
        cand = np.where((g > 0.012) & (sx[:-1] > 0.06))[0]
        if not len(cand):
            if armpitZ is not None and z < armpitZ - 0.05:
                break  # la main s'arrête ici
            continue
        k = cand[int(np.argmax(g[cand]))]
        c = (sx[k] + sx[k + 1]) / 2
        if armpitZ is None:
            armpitZ = z
            cut = c
        idx = np.nonzero(np.abs(V[:, 2] - z) < 0.005)[0]
        sel = idx[V[idx, 0] * side > c]
        if len(sel):
            arm_pts.append(sel)
    arm_idx = np.unique(np.concatenate(arm_pts))
    arm = V[arm_idx]
    lowZ = arm[:, 2].min()
    tip = arm[arm[:, 2] < lowZ + 0.03].mean(0)
    wrist = arm[(arm[:, 2] > lowZ + 0.05) & (arm[:, 2] < lowZ + 0.13)].mean(0)
    topsl = arm[arm[:, 2] > armpitZ - 0.04]
    pivot = np.array([cut * side, topsl[:, 1].mean(), armpitZ + 0.025])
    elbow = pivot + 0.55 * (wrist - pivot)
    print(f"[tpose] côté {'D' if side>0 else 'G'} : aisselle z={armpitZ:.3f}, coupe {cut*side:+.3f}, "
          f"poignet {np.round(wrist,3)}, {len(arm)} pts de bras")
    return dict(cut=cut, pivot=pivot, elbow=elbow, wrist=wrist, tip=tip, idx=arm_idx)

L = detect(-1)
R = detect(+1)

# --- armature minimale (racine + buste + clavicules + bras) ---
bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
arm_obj = bpy.context.object
eb = arm_obj.data.edit_bones
root = eb[0]
root.name = "root"
root.head = (0, 0, 0.95 * 0.5 * H)  # bassin
root.tail = (0, 0, 0.78 * H)  # poitrine

def add(name, head, tail, parent):
    b = eb.new(name)
    b.head = Vector(head)
    b.tail = Vector(tail)
    b.parent = parent
    return b

neck = add("neck", root.tail, (0, 0, H * 0.94), root)
for side, det, s in (("L", L, -1), ("R", R, +1)):
    clav = add(f"clav.{side}", root.tail, det["pivot"], root)
    ua = add(f"upper.{side}", det["pivot"], det["elbow"], clav)
    fa = add(f"fore.{side}", det["elbow"], det["tip"], ua)
bpy.ops.object.mode_set(mode="OBJECT")

# --- poids MAISON lissés : 1 sur le nuage du bras, puis lissage laplacien sur
# la topologie du mesh (30 passes) → transition d'épaule douce, sans dépendre
# du bone-heat (qui échoue sur les os de bras de ce sculpt). Les sommets sans
# poids ne bougent pas (le torse reste en place). ---
me = obj.data
nV = len(me.vertices)
E = np.empty(len(me.edges) * 2, dtype=np.int64)
me.edges.foreach_get("vertices", E)
E = E.reshape(-1, 2)
deg = np.zeros(nV)
np.add.at(deg, E[:, 0], 1)
np.add.at(deg, E[:, 1], 1)
deg[deg == 0] = 1

def smooth_weights(hard_idx, iters=30, lam=0.6):
    w = np.zeros(nV)
    w[hard_idx] = 1.0
    for _ in range(iters):
        acc = np.zeros(nV)
        np.add.at(acc, E[:, 0], w[E[:, 1]])
        np.add.at(acc, E[:, 1], w[E[:, 0]])
        w = (1 - lam) * w + lam * (acc / deg)
        w[hard_idx] = 1.0  # le cœur du bras reste rigide
    return w

mod = obj.modifiers.new("Armature", "ARMATURE")
mod.object = arm_obj
BINS = 50
for side_name, det in (("L", L), ("R", R)):
    w = smooth_weights(det["idx"])
    vg = obj.vertex_groups.new(name=f"upper.{side_name}")
    for b in range(1, BINS + 1):
        lo, hi = (b - 0.5) / BINS, (b + 0.5) / BINS
        ids = np.nonzero((w >= lo) & (w < hi))[0]
        if len(ids):
            vg.add(ids.tolist(), b / BINS, "REPLACE")
    print(f"[tpose] poids {side_name} : {int((w>0.01).sum())} sommets influencés")

# --- pose : amener pivot→poignet à l'horizontale (rotation MONDE du bras) ---
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode="POSE")
for side, det, s in (("L", L, -1), ("R", R, +1)):
    pb = arm_obj.pose.bones[f"upper.{side}"]
    d = np.array(det["wrist"]) - np.array(det["pivot"])
    d /= np.linalg.norm(d)
    t = np.array([float(s), 0.0, 0.0])
    axis = np.cross(d, t)
    sn = np.linalg.norm(axis)
    ang = float(np.arctan2(sn, float(np.dot(d, t))))
    axis = axis / sn
    Rw = Matrix.Rotation(ang, 4, Vector(axis))
    piv = Vector(det["pivot"])
    M = Matrix.Translation(piv) @ Rw @ Matrix.Translation(-piv)
    pb.matrix = M @ pb.matrix
    bpy.context.view_layer.update()
    print(f"[tpose] bras {side} pivoté de {np.degrees(ang):.1f}°")
bpy.ops.object.mode_set(mode="OBJECT")

# --- applique la déformation puis exporte ---
bpy.context.view_layer.objects.active = obj
for m in list(obj.modifiers):
    if m.type == "ARMATURE":
        bpy.ops.object.modifier_apply(modifier=m.name)
bpy.ops.object.select_all(action="DESELECT")
obj.select_set(True)
bpy.ops.wm.stl_export(filepath=OUT, export_selected_objects=True)
print(f"[tpose] exporté : {OUT}")
