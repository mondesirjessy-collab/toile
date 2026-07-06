"""Bake the CC0 male STL into TOILE assets: render mesh + SDF grid.

Outputs (little-endian):
  homme-scan.mesh.bin : uint32 vertCount, uint32 triCount, then
                        pos f32*3*vertCount, normal f32*3*vertCount,
                        idx u32*3*triCount
  homme-scan.sdf.bin  : uint32 nx,ny,nz, f32 min[3], f32 max[3],
                        int16 sdf_mm[nx*ny*nz]  (x fastest, then y, then z)
"""
import numpy as np, struct, sys
import fast_simplification, igl

SRC = sys.argv[1]
OUT = sys.argv[2]

# --- Binary STL parse ---
with open(SRC, 'rb') as f:
    f.seek(80)
    (n,) = struct.unpack('<I', f.read(4))
    data = np.fromfile(f, dtype=np.uint8).reshape(n, 50)
tris = data[:, 12:48].copy().view('<f4').reshape(n, 3, 3)
print('tris:', n)

# Weld vertices (round to 1e-5 of bbox for dedup)
verts = tris.reshape(-1, 3)
scale0 = verts.max(0) - verts.min(0)
key = np.round(verts / (scale0.max() * 1e-6)).astype(np.int64)
_, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
V = verts[first]
F = inv.reshape(-1, 3).astype(np.int64)
# Drop degenerate faces
good = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
F = F[good]
print('welded:', V.shape[0], 'verts,', F.shape[0], 'faces')

# --- Orient: Blender exports are Z-up. Our world is Y-up, front = +z. ---
ext = V.max(0) - V.min(0)
up = int(np.argmax(ext))  # tallest axis is the height
if up == 2:  # Z-up -> Y-up: (x, y, z) -> (x, z, -y)
    V = V[:, [0, 2, 1]] * np.array([1.0, 1.0, -1.0])
elif up == 0:
    V = V[:, [1, 0, 2]]
# Normalize: feet at y=0, height 1.755 m, centered in x/z
V -= V.min(0)
h = V[:, 1].max()
HEIGHT = float(sys.argv[3]) if len(sys.argv) > 3 else 1.755
NAME = sys.argv[4] if len(sys.argv) > 4 else 'homme-scan'
FLIP = sys.argv[5] if len(sys.argv) > 5 else 'auto'  # '0' | '1' | 'auto'
V *= HEIGHT / h
V[:, 0] -= (V[:, 0].max() + V[:, 0].min()) / 2
V[:, 2] -= (V[:, 2].max() + V[:, 2].min()) / 2
ext = V.max(0) - V.min(0)
print('normalized extents:', np.round(ext, 3), '(x=larg, y=haut, z=prof)')
# Heuristic front check: the nose/toes push the +z or -z side out at foot level.
feet = V[V[:, 1] < 0.15]
zmid = (feet[:, 2].max() + feet[:, 2].min()) / 2
do_flip = (FLIP == '1') if FLIP != 'auto' else abs(feet[:, 2].min()) > abs(feet[:, 2].max())
if do_flip:
    V[:, 2] *= -1
    V[:, 0] *= -1  # keep right-handed
    print('flipped to face +z (toes forward)')

# --- Decimate for rendering (~60k tris) ---
target = 1.0 - 60000 / F.shape[0]
RV, RF = fast_simplification.simplify(V.astype(np.float32), F.astype(np.int32), target_reduction=max(0.0, target))
print('render mesh:', RV.shape[0], 'verts,', RF.shape[0], 'tris')
NR = igl.per_vertex_normals(RV.astype(np.float64), RF.astype(np.int64))
NR = np.nan_to_num(NR, nan=0.0)

with open(f'{OUT}/{NAME}.mesh.bin', 'wb') as f:
    f.write(struct.pack('<II', RV.shape[0], RF.shape[0]))
    f.write(RV.astype('<f4').tobytes())
    f.write(NR.astype('<f4').tobytes())
    f.write(RF.astype('<u4').tobytes())

# --- SDF grid (signed distance via winding number, robust) ---
pad = 0.06
mn = V.min(0) - pad
mx = V.max(0) + pad
dims = np.maximum(8, np.minimum(160, np.ceil((mx - mn) / 0.012).astype(int)))
nx, ny, nz = int(dims[0]), int(dims[1]), int(dims[2])
print('grid:', nx, ny, nz, '=', nx * ny * nz, 'cells')
xs = np.linspace(mn[0], mx[0], nx)
ys = np.linspace(mn[1], mx[1], ny)
zs = np.linspace(mn[2], mx[2], nz)
# x fastest, then y, then z  -> index = (k*ny + j)*nx + i
Z, Y, X = np.meshgrid(zs, ys, xs, indexing='ij')
P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
# Decimated proxy for distance queries keeps this fast and plenty accurate
S = igl.signed_distance(P, RV.astype(np.float64), RF.astype(np.int64),
                              sign_type=igl.SIGNED_DISTANCE_TYPE_FAST_WINDING_NUMBER)[0]
S = np.clip(S * 1000.0, -32000, 32000).astype('<i2')  # millimeters, int16
with open(f'{OUT}/{NAME}.sdf.bin', 'wb') as f:
    f.write(struct.pack('<III', nx, ny, nz))
    f.write(np.asarray(mn, '<f4').tobytes())
    f.write(np.asarray(mx, '<f4').tobytes())
    f.write(S.tobytes())
print('ok: assets written to', OUT)
