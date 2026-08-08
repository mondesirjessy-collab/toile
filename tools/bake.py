"""Bake a closed binary STL into TOILE assets: render mesh + SDF grid.

Usage:
  python tools/bake.py SOURCE.stl OUTPUT_DIR [HEIGHT_M] [NAME] [FLIP] [APPEARANCE]

Arguments:
  HEIGHT_M  Canonical avatar height in metres (default: 1.755).
  NAME      Output basename (legacy default: homme-scan).
  FLIP      0, 1, auto (default), or canonical. `canonical` preserves an
            already Y-up, metre-scaled, grounded and positioned surface.
  APPEARANCE Optional TOILEA1 sidecar emitted by glb_skin_to_stl.mjs. Its
             embedded base-colour texture is sampled into compact vertex RGB.

Dependencies: Python 3, NumPy, and the libigl Python bindings.

Outputs (little-endian):
  <NAME>.mesh.bin : uint32 vertCount, uint32 triCount, then
                    pos f32*3*vertCount, normal f32*3*vertCount,
                    idx u32*3*triCount, optional color u8*3*vertCount
  <NAME>.sdf.bin  : uint32 nx,ny,nz, f32 min[3], f32 max[3],
                    int16 sdf_mm[nx*ny*nz]  (x fastest, then y, then z)
"""
from io import BytesIO
import os
import numpy as np, struct, sys
import igl

SRC = sys.argv[1]
OUT = sys.argv[2]
APPEARANCE = sys.argv[6] if len(sys.argv) > 6 else None

# --- Binary STL parse ---
with open(SRC, 'rb') as f:
    f.seek(80)
    (n,) = struct.unpack('<I', f.read(4))
    data = np.fromfile(f, dtype=np.uint8).reshape(n, 50)
tris = data[:, 12:48].copy().view('<f4').reshape(n, 3, 3)
print('tris:', n)

appearance_uv = None
appearance_image = None
if APPEARANCE:
    with open(APPEARANCE, 'rb') as f:
        header = f.read(24)
        if len(header) != 24 or header[:8] != b'TOILEA1\0':
            raise ValueError(f'{APPEARANCE}: invalid TOILEA1 appearance sidecar')
        appearance_triangles, image_bytes, _, _ = struct.unpack('<IIII', header[8:24])
        if appearance_triangles != n:
            raise ValueError(
                f'{APPEARANCE}: {appearance_triangles} UV triangles for {n} STL triangles'
            )
        uv_bytes = appearance_triangles * 3 * 2 * 4
        uv_raw = f.read(uv_bytes)
        if len(uv_raw) != uv_bytes:
            raise ValueError(f'{APPEARANCE}: truncated UV block')
        appearance_uv = np.frombuffer(uv_raw, dtype='<f4').reshape(n, 3, 2)
        appearance_image = f.read(image_bytes)
        if len(appearance_image) != image_bytes:
            raise ValueError(f'{APPEARANCE}: truncated base-colour image')

# Weld vertices (round to 1e-5 of bbox for dedup)
verts = tris.reshape(-1, 3)
scale0 = verts.max(0) - verts.min(0)
key = np.round(verts / (scale0.max() * 1e-6)).astype(np.int64)
_, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
V = verts[first]
F = inv.reshape(-1, 3).astype(np.int64)
vertex_colors = None
if appearance_uv is not None:
    # The GLB and STL triangle soups share one corner order. Sample only the
    # welded vertices selected by `first`; a 2048 px Lanczos proxy is already
    # finer than the physical proxy and avoids retaining a full source image.
    from PIL import Image
    image = Image.open(BytesIO(appearance_image)).convert('RGB')
    if max(image.size) > 2048:
        scale = 2048 / max(image.size)
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    pixels = np.asarray(image, dtype=np.uint8)
    uv = appearance_uv.reshape(-1, 2)[first]
    # glTF defines image-space (0,0) at the upper-left. REPEAT is the default
    # sampler wrap and remains correct for any out-of-range source UV.
    px = np.rint(np.mod(uv[:, 0], 1.0) * (image.width - 1)).astype(np.int64)
    py = np.rint(np.mod(uv[:, 1], 1.0) * (image.height - 1)).astype(np.int64)
    vertex_colors = pixels[py, px].copy()
    print('appearance:', image.size, '->', vertex_colors.shape[0], 'welded vertex colours')
# Drop degenerate faces
good = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])
F = F[good]
print('welded:', V.shape[0], 'verts,', F.shape[0], 'faces')

# A scan may contain two closed sheets touching along the same geometric edge.
# Split those topological fans before simplification: the visible mesh remains
# closed/manifold and MeshProximity can use its robust containment sign.
if not igl.is_edge_manifold(F.astype(np.int64))[0]:
    V, F, split_from = igl.split_nonmanifold(
        V.astype(np.float64),
        F.astype(np.int64),
    )
    if vertex_colors is not None:
        vertex_colors = vertex_colors[split_from]
    print('split non-manifold fans:', V.shape[0], 'verts,', F.shape[0], 'faces')
    # Splitting a four-face fan makes its coincident sheets orientable but
    # leaves a few tiny boundary loops. Close each loop with a local fan before
    # decimation so the final visible body still has exactly two faces/edge.
    loops = igl.boundary_loop_all(F.astype(np.int64))
    caps = []
    vertices = [row for row in V]
    colors = [row for row in vertex_colors] if vertex_colors is not None else None
    for loop in loops:
        if len(loop) < 3:
            continue
        center = len(vertices)
        vertices.append(V[np.asarray(loop, dtype=np.int64)].mean(axis=0))
        if colors is not None:
            colors.append(
                np.rint(vertex_colors[np.asarray(loop, dtype=np.int64)].mean(axis=0))
                .clip(0, 255)
                .astype(np.uint8)
            )
        for index, current in enumerate(loop):
            following = loop[(index + 1) % len(loop)]
            # boundary_loop_all follows the existing face orientation; the cap
            # must consume each boundary edge in the opposite direction.
            caps.append([following, current, center])
    if caps:
        V = np.asarray(vertices, dtype=np.float64)
        F = np.vstack([F, np.asarray(caps, dtype=np.int64)])
        if colors is not None:
            vertex_colors = np.asarray(colors, dtype=np.uint8)
        print('capped boundary loops:', len(loops), 'loops,', len(caps), 'faces')

# --- Orient: Blender exports are Z-up. Our world is Y-up, front = +z. ---
HEIGHT = float(sys.argv[3]) if len(sys.argv) > 3 else 1.755
NAME = sys.argv[4] if len(sys.argv) > 4 else 'homme-scan'
FLIP = sys.argv[5] if len(sys.argv) > 5 else 'auto'  # '0' | '1' | 'auto' | 'canonical'
if not np.isfinite(HEIGHT) or HEIGHT <= 0:
    raise ValueError('HEIGHT_M must be a finite positive number')
if FLIP not in ('0', '1', 'auto', 'canonical'):
    raise ValueError("FLIP must be '0', '1', 'auto', or 'canonical'")

ext = V.max(0) - V.min(0)
up = int(np.argmax(ext))  # tallest axis is the height
if FLIP == 'canonical':
    source_height = V[:, 1].max() - V[:, 1].min()
    if abs(source_height - HEIGHT) > 2e-4 or abs(V[:, 1].min()) > 2e-4:
        raise ValueError(
            f'canonical input must already be grounded at {HEIGHT:g} m '
            f'(got minY={V[:, 1].min():.6g}, height={source_height:.6g})'
        )
    print('canonical input: preserving authored x/y/z placement')
else:
    if up == 2:  # Z-up -> Y-up: (x, y, z) -> (x, z, -y)
        V = V[:, [0, 2, 1]] * np.array([1.0, 1.0, -1.0])
    elif up == 0:
        V = V[:, [1, 0, 2]]
    # Normalize: feet at y=0, requested height, centered in x/z.
    V -= V.min(0)
    h = V[:, 1].max()
    V *= HEIGHT / h
    V[:, 0] -= (V[:, 0].max() + V[:, 0].min()) / 2
    V[:, 2] -= (V[:, 2].max() + V[:, 2].min()) / 2
ext = V.max(0) - V.min(0)
print('normalized extents:', np.round(ext, 3), '(x=larg, y=haut, z=prof)')
# Heuristic front check: the nose/toes push the +z or -z side out at foot level.
if FLIP != 'canonical':
    feet = V[V[:, 1] < 0.15]
    zmid = (feet[:, 2].max() + feet[:, 2].min()) / 2
    do_flip = (FLIP == '1') if FLIP != 'auto' else abs(feet[:, 2].min()) > abs(feet[:, 2].max())
    if do_flip:
        V[:, 2] *= -1
        V[:, 0] *= -1  # keep right-handed
        print('flipped to face +z (toes forward)')

# --- Decimate for rendering (~60k tris), preserving manifold topology ---
target_faces = min(60000, F.shape[0])
if F.shape[0] > target_faces:
    RV, RF, _, birth_vertices = igl.decimate(
        V.astype(np.float64),
        F.astype(np.int32),
        target_faces,
    )
    render_colors = vertex_colors[birth_vertices] if vertex_colors is not None else None
else:
    RV, RF = V.astype(np.float64), F.astype(np.int64)
    render_colors = vertex_colors
print('render mesh:', RV.shape[0], 'verts,', RF.shape[0], 'tris')
NR = igl.per_vertex_normals(RV.astype(np.float64), RF.astype(np.int64))
NR = np.nan_to_num(NR, nan=0.0)
# Tiny capped scan fissures can have perfectly cancelling incident faces. They
# are valid closed collision components but libigl then returns a zero display
# normal at their fan centre. Give those rare vertices a deterministic outward
# fallback and normalize every result before writing the runtime proxy.
normal_lengths = np.linalg.norm(NR, axis=1)
invalid_normals = normal_lengths < 1e-8
if np.any(invalid_normals):
    centre = (RV.min(axis=0) + RV.max(axis=0)) * 0.5
    fallback = RV[invalid_normals] - centre
    fallback_lengths = np.linalg.norm(fallback, axis=1)
    fallback[fallback_lengths < 1e-8] = np.array([0.0, 1.0, 0.0])
    fallback_lengths = np.linalg.norm(fallback, axis=1)
    NR[invalid_normals] = fallback / fallback_lengths[:, None]
    normal_lengths = np.linalg.norm(NR, axis=1)
NR /= np.maximum(normal_lengths[:, None], 1e-12)

mesh_final = f'{OUT}/{NAME}.mesh.bin'
sdf_final = f'{OUT}/{NAME}.sdf.bin'
mesh_tmp = f'{mesh_final}.{os.getpid()}.tmp'
sdf_tmp = f'{sdf_final}.{os.getpid()}.tmp'
with open(mesh_tmp, 'wb') as f:
    f.write(struct.pack('<II', RV.shape[0], RF.shape[0]))
    f.write(RV.astype('<f4').tobytes())
    f.write(NR.astype('<f4').tobytes())
    f.write(RF.astype('<u4').tobytes())
    if render_colors is not None:
        f.write(render_colors.astype('u1').tobytes())

# --- SDF grid (signed distance via winding number, robust) ---
pad = 0.06
mn = V.min(0) - pad
mx = V.max(0) + pad
# 7 mm resolves the neck/shoulder/armpit curvature while the 256 cap stays
# within WebGPU's guaranteed maxTextureDimension3D on every adapter.
dims = np.maximum(8, np.minimum(256, np.ceil((mx - mn) / 0.007).astype(int) + 1))
nx, ny, nz = int(dims[0]), int(dims[1]), int(dims[2])
print('grid:', nx, ny, nz, '=', nx * ny * nz, 'cells')
xs = np.linspace(mn[0], mx[0], nx)
ys = np.linspace(mn[1], mx[1], ny)
zs = np.linspace(mn[2], mx[2], nz)
# x fastest, then y, then z  -> index = (k*ny + j)*nx + i
Z, Y, X = np.meshgrid(zs, ys, xs, indexing='ij')
P = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
# A 60k render proxy can deviate by 5–10 mm at fingers/armpits. Build the SDF
# against a denser 250k surface from the SAME master pose so the textured body
# never appears outside the collision field.
sdf_target_faces = min(250000, F.shape[0])
if F.shape[0] > sdf_target_faces:
    SV, SF, _, _ = igl.decimate(
        V.astype(np.float64),
        F.astype(np.int32),
        sdf_target_faces,
    )
else:
    SV, SF = V.astype(np.float64), F.astype(np.int64)
print('sdf surface:', SV.shape[0], 'verts,', SF.shape[0], 'tris')
S = igl.signed_distance(P, SV.astype(np.float64), SF.astype(np.int64),
                              sign_type=igl.SIGNED_DISTANCE_TYPE_FAST_WINDING_NUMBER)[0]
# Conservative 3 mm envelope: sub-cell interpolation, int16 quantisation and
# the independent 60k collision proxy must never leave a visible extremity
# outside the field. The extra 1.5 mm is smaller than one half grid cell and
# prevents isolated fingers/scan seams from tunnelling through 2.5 mm silk.
S = np.clip((S - 0.003) * 1000.0, -32000, 32000).astype('<i2')  # millimeters, int16
with open(sdf_tmp, 'wb') as f:
    f.write(struct.pack('<III', nx, ny, nz))
    f.write(np.asarray(mn, '<f4').tobytes())
    f.write(np.asarray(mx, '<f4').tobytes())
    f.write(S.tobytes())
# Publish only complete files. A crash/OOM during the expensive SDF query now
# leaves the previous coherent avatar generation untouched.
os.replace(sdf_tmp, sdf_final)
os.replace(mesh_tmp, mesh_final)
print('ok: assets written to', OUT)
