"""Re-bake a TOILE scan SDF directly from its shipped render mesh.

Diagnostic/asset tool, not a runtime dependency. It needs numpy + libigl:

  PYTHONPATH=/path/to/libigl python3 tools/refine_avatar_sdf.py \
    public/avatars/femme-scan.mesh.bin /tmp/femme-scan-7mm.sdf.bin 0.007 \
    --surface-padding 0.0015

Distance and sign come from libigl's fast winding-number signed distance, the
same robust method as the original bake. The full query grid is evaluated in a
single call so its acceleration/winding hierarchy is built only once.
"""

from __future__ import annotations

import argparse
import pathlib
import struct

import igl
import numpy as np


def read_mesh(path: pathlib.Path) -> tuple[np.ndarray, np.ndarray]:
    payload = path.read_bytes()
    vertex_count, triangle_count = struct.unpack_from("<II", payload, 0)
    positions = np.frombuffer(
        payload,
        dtype="<f4",
        count=vertex_count * 3,
        offset=8,
    ).reshape((-1, 3)).astype(np.float64)
    index_offset = 8 + vertex_count * 3 * 4 * 2
    triangles = np.frombuffer(
        payload,
        dtype="<u4",
        count=triangle_count * 3,
        offset=index_offset,
    ).reshape((-1, 3)).astype(np.int64)
    return positions, triangles


def read_grid(path: pathlib.Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    payload = path.read_bytes()
    dims = np.array(struct.unpack_from("<III", payload, 0), dtype=np.int64)
    minimum = np.array(struct.unpack_from("<fff", payload, 12), dtype=np.float64)
    maximum = np.array(struct.unpack_from("<fff", payload, 24), dtype=np.float64)
    values = np.frombuffer(
        payload,
        dtype="<i2",
        count=int(np.prod(dims)),
        offset=36,
    ).reshape((dims[2], dims[1], dims[0])).astype(np.float64) / 1000.0
    return minimum, maximum, values


def sample_grid(
    points: np.ndarray,
    minimum: np.ndarray,
    maximum: np.ndarray,
    grid: np.ndarray,
) -> np.ndarray:
    nz, ny, nx = grid.shape
    dims = np.array([nx, ny, nz], dtype=np.int64)
    cell = (maximum - minimum) / (dims - 1)
    coordinates = (points - minimum) / cell
    base = np.clip(np.floor(coordinates).astype(np.int64), 0, dims - 2)
    fraction = np.clip(coordinates - base, 0.0, 1.0)
    i, j, k = base[:, 0], base[:, 1], base[:, 2]
    fx, fy, fz = fraction[:, 0], fraction[:, 1], fraction[:, 2]
    x00 = grid[k, j, i] * (1 - fx) + grid[k, j, i + 1] * fx
    x10 = grid[k, j + 1, i] * (1 - fx) + grid[k, j + 1, i + 1] * fx
    x01 = grid[k + 1, j, i] * (1 - fx) + grid[k + 1, j, i + 1] * fx
    x11 = grid[k + 1, j + 1, i] * (1 - fx) + grid[k + 1, j + 1, i + 1] * fx
    return (x00 * (1 - fy) + x10 * fy) * (1 - fz) + (
        x01 * (1 - fy) + x11 * fy
    ) * fz


def bake(
    mesh_path: pathlib.Path,
    output_path: pathlib.Path,
    spacing: float,
    source_sdf: pathlib.Path,
    max_dimension: int,
    surface_padding: float,
) -> None:
    vertices, faces = read_mesh(mesh_path)
    minimum, maximum, _coarse_grid = read_grid(source_sdf)
    dims = np.minimum(
        max_dimension,
        np.ceil((maximum - minimum) / spacing).astype(np.int64) + 1,
    )
    axes = [
        np.linspace(minimum[axis], maximum[axis], int(dims[axis]))
        for axis in range(3)
    ]
    z_grid, y_grid, x_grid = np.meshgrid(
        axes[2],
        axes[1],
        axes[0],
        indexing="ij",
    )
    points = np.column_stack((x_grid.ravel(), y_grid.ravel(), z_grid.ravel()))
    print(f"signed-distance queries: {points.shape[0]:,}", flush=True)
    signed_distance = igl.signed_distance(
        points,
        vertices,
        faces,
        igl.SIGNED_DISTANCE_TYPE_FAST_WINDING_NUMBER,
    )[0]
    # A 1.5-millimetre conservative envelope absorbs int16 quantisation and
    # keeps even the thinnest 2.5 mm fabric in front of the render mesh.
    millimetres = np.clip(
        (signed_distance - surface_padding) * 1000.0,
        -32000,
        32000,
    )
    encoded = np.rint(millimetres).astype("<i2").reshape(
        (dims[2], dims[1], dims[0]),
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as output:
        output.write(struct.pack("<III", *(int(value) for value in dims)))
        output.write(np.asarray(minimum, dtype="<f4").tobytes())
        output.write(np.asarray(maximum, dtype="<f4").tobytes())
        output.write(encoded.tobytes())
    cell_mm = (maximum - minimum) * 1000 / (dims - 1)
    mesh_distance_mm = sample_grid(
        vertices,
        minimum,
        maximum,
        encoded.astype(np.float64) / 1000.0,
    ) * 1000.0
    percentiles = np.percentile(mesh_distance_mm, [1, 50, 95, 99, 100])
    print(
        f"wrote {output_path}: {tuple(int(value) for value in dims)}, "
        f"cell={tuple(round(float(value), 3) for value in cell_mm)} mm",
    )
    print(
        "mesh interpolation error mm "
        f"p01={percentiles[0]:.3f} p50={percentiles[1]:.3f} "
        f"p95={percentiles[2]:.3f} p99={percentiles[3]:.3f} "
        f"max={percentiles[4]:.3f} over2.5="
        f"{100 * np.mean(mesh_distance_mm > 2.5):.3f}%",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mesh", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("spacing", type=float)
    parser.add_argument("--source-sdf", type=pathlib.Path)
    parser.add_argument(
        "--max-dimension",
        type=int,
        default=256,
        help="stay within WebGPU's guaranteed maxTextureDimension3D",
    )
    parser.add_argument(
        "--surface-padding",
        type=float,
        default=0.0015,
        help="conservative outward envelope in metres (default: 1.5 mm)",
    )
    arguments = parser.parse_args()
    source_sdf = arguments.source_sdf or arguments.mesh.with_suffix("").with_suffix(".sdf.bin")
    bake(
        arguments.mesh,
        arguments.output,
        arguments.spacing,
        source_sdf,
        max(8, arguments.max_dimension),
        max(0.0, arguments.surface_padding),
    )


if __name__ == "__main__":
    main()
