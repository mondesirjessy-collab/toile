#!/usr/bin/env python3
"""
tpose.py — re-pose un avatar scanné (bras le long du corps) en T-POSE et
re-cuit ses assets TOILE (mesh de rendu + grille SDF), au format de bake.py.

Pourquoi : un vêtement tombe mal sur des bras collés au corps (les manches
n'ont pas la place de draper) — les ateliers pro posent l'avatar en T-pose.

Méthode (les scans n'ont pas de squelette) :
1. DÉTECTION par la grille SDF originale : à chaque tranche horizontale,
   composantes connexes de l'occupation (x,z) — le bras est la composante
   séparée du torse (même si leurs x se chevauchent). Le sommet de cette
   séparation = l'aisselle ; la coupe passe au milieu de l'écart bras/torse.
2. POSE : rotation rigide du bras entier autour du pivot d'épaule jusqu'à
   l'horizontale (pivot → poignet aligné sur ±x), fondu de 6 cm au raccord
   de l'épaule.
3. RE-CUISSON : normales + grille SDF exacte depuis le mesh posé (igl,
   fast winding number — les mêmes règles que bake.py).

Usage : venv/bin/python tools/tpose.py public/avatars/femme-scan [dest-base]
"""
import numpy as np
import struct
import sys
import igl
from scipy import ndimage

SRC = sys.argv[1]
DST = sys.argv[2] if len(sys.argv) > 2 else SRC

# --- assets originaux ---
with open(f"{SRC}.mesh.bin", "rb") as f:
    buf = f.read()
vcount, tcount = struct.unpack_from("<II", buf, 0)
off = 8
V = np.frombuffer(buf, "<f4", vcount * 3, off).reshape(-1, 3).astype(np.float64).copy()
off += vcount * 12 * 2  # positions + normales (recalculées)
F = np.frombuffer(buf, "<u4", tcount * 3, off).reshape(-1, 3).astype(np.int64).copy()
H = V[:, 1].max()

with open(f"{SRC}.sdf.bin", "rb") as f:
    sbuf = f.read()
nx, ny, nz = struct.unpack_from("<III", sbuf, 0)
gmin = np.frombuffer(sbuf, "<f4", 3, 12).astype(np.float64)
gmax = np.frombuffer(sbuf, "<f4", 3, 24).astype(np.float64)
sdf = np.frombuffer(sbuf, "<i2", nx * ny * nz, 36).astype(np.float64).reshape(nz, ny, nx) / 1000.0
xs = np.linspace(gmin[0], gmax[0], nx)
ys = np.linspace(gmin[1], gmax[1], ny)
occ = sdf <= 0.004  # occupation (≈ un demi-voxel de marge)
print(f"{SRC}: {vcount} verts, H={H:.3f} m, grille {nx}×{ny}×{nz}")

# --- 1. détection des bras par tranches (composantes connexes en x,z) ---
def slabs_analysis():
    """Pour chaque côté : la plus haute tranche où le bras est SÉPARÉ du torse,
    et la coupe x au milieu de l'écart à cette hauteur."""
    res = {}
    for side in (+1, -1):
        topJ = -1
        cut = None
        for j in range(ny - 1, -1, -1):
            sl = occ[:, j, :]  # (z, x)
            if not sl.any():
                continue
            lab, n = ndimage.label(sl)
            if n < 2:
                continue
            # composante du torse = celle qui contient x≈0
            i0 = int(np.argmin(np.abs(xs)))
            torso_ids = set(lab[:, i0][lab[:, i0] > 0])
            if not torso_ids:
                continue
            # composante bras du bon côté : centroïde x·side max, hors torse
            best = None
            for c in range(1, n + 1):
                if c in torso_ids:
                    continue
                zz, xx = np.nonzero(lab == c)
                if len(xx) < 3:
                    continue
                cx = xs[xx].mean()
                if cx * side > 0.08 and (best is None or cx * side > best[0]):
                    best = (cx * side, c, xx)
            if best is None:
                continue
            if topJ < 0:
                topJ = j
                # coupe : milieu de l'écart entre le bord du torse et le bras
                torso_x = []
                for c in torso_ids:
                    _, xxT = np.nonzero(lab == c)
                    torso_x.append((xs[xxT] * side).max())
                torso_out = max(torso_x)
                arm_in = (xs[best[2]] * side).min()
                cut = (torso_out + arm_in) / 2
                res[side] = {"topJ": topJ, "topY": float(ys[topJ]), "cut": float(cut)}
                break
    return res

det = slabs_analysis()
for side in (+1, -1):
    d = det[side]
    print(f"  côté {'D' if side>0 else 'G'} : aisselle/séparation jusqu'à y={d['topY']:.3f}, coupe x={d['cut']*side:+.3f}")

# --- masque 3D « bras » : la CHAÎNE de composantes reliées verticalement
# depuis l'aisselle vers le bas (les jambes, jamais raccordées à cette chaîne,
# restent dehors) + la bande d'épaule au-delà de la coupe. ---
armMask = {+1: np.zeros_like(occ, bool), -1: np.zeros_like(occ, bool)}
for side in (+1, -1):
    topJ = det[side]["topJ"]
    cut = det[side]["cut"]
    # graine : la composante bras à la tranche de séparation la plus haute
    sl = occ[:, topJ, :]
    lab, n = ndimage.label(sl)
    i0 = int(np.argmin(np.abs(xs)))
    torso_ids = set(lab[:, i0][lab[:, i0] > 0])
    seed = None
    bestcx = -1
    for c in range(1, n + 1):
        if c in torso_ids:
            continue
        zz, xx = np.nonzero(lab == c)
        if len(xx) < 3:
            continue
        cx = xs[xx].mean() * side
        if cx > 0.08 and cx > bestcx:
            bestcx = cx
            seed = lab == c
    assert seed is not None, f"pas de graine de bras côté {side}"
    armMask[side][:, topJ, :] = seed
    prev = ndimage.binary_dilation(seed, iterations=2)
    # descente : ne suivre que les composantes qui touchent la tranche du dessus
    for j in range(topJ - 1, -1, -1):
        sl = occ[:, j, :]
        if not sl.any():
            break
        lab, n = ndimage.label(sl)
        i0 = int(np.argmin(np.abs(xs)))
        torso_ids = set(lab[:, i0][lab[:, i0] > 0])
        cur = np.zeros_like(sl)
        for c in range(1, n + 1):
            if c in torso_ids:
                continue
            comp = lab == c
            if (comp & prev).any():
                cur |= comp
        if not cur.any():
            break  # fin du bras (la main s'arrête ici)
        armMask[side][:, j, :] = cur
        prev = ndimage.binary_dilation(cur, iterations=2)
    # bande d'épaule : au-delà de la coupe, au-dessus de la séparation
    for j in range(topJ + 1, ny):
        sl = occ[:, j, :]
        if not sl.any():
            continue
        xxsel = np.nonzero(xs * side > cut)[0]
        armMask[side][:, j, xxsel] |= sl[:, xxsel]

def grid_idx(P):
    i = np.clip(np.rint((P[:, 0] - gmin[0]) / (gmax[0] - gmin[0]) * (nx - 1)), 0, nx - 1).astype(int)
    j = np.clip(np.rint((P[:, 1] - gmin[1]) / (gmax[1] - gmin[1]) * (ny - 1)), 0, ny - 1).astype(int)
    k = np.clip(np.rint((P[:, 2] - gmin[2]) / (gmax[2] - gmin[2]) * (nz - 1)), 0, nz - 1).astype(int)
    return i, j, k

BLEND = 0.06
posed = V.copy()
for side in (+1, -1):
    d = det[side]
    cut, topY = d["cut"], d["topY"]
    i, j, k = grid_idx(V)
    # dilate le masque bras pour couvrir les sommets de surface (1 voxel autour)
    m = ndimage.binary_dilation(armMask[side], iterations=2)
    isArm = m[k, j, i]
    arm = V[isArm]
    if len(arm) < 100:
        raise SystemExit(f"bras {'D' if side>0 else 'G'} : étiquetage trop maigre ({len(arm)} pts)")
    # pivot d'épaule : à la coupe, au sommet de la séparation (+3 cm), z = centre du bras haut
    pivotY = topY + 0.03
    hi = arm[arm[:, 1] > topY - 0.10]
    pivot = np.array([cut * side, pivotY, float(hi[:, 2].mean())])
    # direction pivot → poignet (bas du bras, au-dessus de la main)
    lowY = arm[:, 1].min()
    wrist = arm[(arm[:, 1] > lowY + 0.06) & (arm[:, 1] < lowY + 0.14)]
    dvec = wrist.mean(0) - pivot
    dvec /= np.linalg.norm(dvec)
    t = np.array([float(side), 0.0, 0.0])
    axis = np.cross(dvec, t)
    s = np.linalg.norm(axis)
    axis /= s
    ang = float(np.arctan2(s, np.dot(dvec, t)))
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    R = np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * (K @ K)
    print(f"  côté {'D' if side>0 else 'G'} : pivot {np.round(pivot,3)}, rotation {np.degrees(ang):.1f}°, {len(arm)} sommets de bras")
    # poids : 1 sur le bras étiqueté, fondu le long du bord de coupe dans la bande d'épaule
    w = np.zeros(len(V))
    w[isArm] = 1.0
    band = (~isArm) & (V[:, 1] > topY - 0.02) & (V[:, 0] * side > cut - BLEND)
    w[band] = np.clip((V[band, 0] * side - (cut - BLEND)) / BLEND, 0, 1)
    w = np.where(w > 0, w * w * (3 - 2 * w), 0.0)
    rot = (V - pivot) @ R.T + pivot
    posed = (1 - w)[:, None] * posed + w[:, None] * rot

ext = posed.max(0) - posed.min(0)
print(f"  posé : envergure x={ext[0]:.3f} m (avant {V[:,0].max()-V[:,0].min():.3f})")

# --- 2. normales + mesh.bin ---
N = igl.per_vertex_normals(posed, F)
N = np.nan_to_num(N, nan=0.0)
with open(f"{DST}.mesh.bin", "wb") as f:
    f.write(struct.pack("<II", posed.shape[0], F.shape[0]))
    f.write(posed.astype("<f4").tobytes())
    f.write(N.astype("<f4").tobytes())
    f.write(F.astype("<u4").tobytes())

# --- 3. grille SDF re-cuite depuis le mesh posé (mêmes règles que bake.py) ---
pad = 0.06
mn = posed.min(0) - pad
mx = posed.max(0) + pad
dims = np.maximum(8, np.minimum(160, np.ceil((mx - mn) / 0.012).astype(int)))
gx, gy, gz = int(dims[0]), int(dims[1]), int(dims[2])
print(f"  grille : {gx}×{gy}×{gz} = {gx*gy*gz} cellules")
X = np.linspace(mn[0], mx[0], gx)
Y = np.linspace(mn[1], mx[1], gy)
Z = np.linspace(mn[2], mx[2], gz)
ZZ, YY, XX = np.meshgrid(Z, Y, X, indexing="ij")  # x le plus rapide, puis y, puis z
P = np.stack([XX.ravel(), YY.ravel(), ZZ.ravel()], axis=1)
S = igl.signed_distance(P, posed, F, sign_type=igl.SIGNED_DISTANCE_TYPE_FAST_WINDING_NUMBER)[0]
S = np.clip(S * 1000.0, -32000, 32000).astype("<i2")
with open(f"{DST}.sdf.bin", "wb") as f:
    f.write(struct.pack("<III", gx, gy, gz))
    f.write(np.asarray(mn, "<f4").tobytes())
    f.write(np.asarray(mx, "<f4").tobytes())
    f.write(S.tobytes())
print(f"ok : {DST}.mesh.bin / .sdf.bin (T-pose)")
