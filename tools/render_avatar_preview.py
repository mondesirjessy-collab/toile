#!/usr/bin/env python3

"""Render a quick front/side diagnostic from a TOILE avatar mesh.bin."""

from pathlib import Path
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont


if len(sys.argv) != 3:
    raise SystemExit("usage: render_avatar_preview.py avatar.mesh.bin preview.png")

source = Path(sys.argv[1])
target = Path(sys.argv[2])
with source.open("rb") as handle:
    vertex_count, triangle_count = struct.unpack("<II", handle.read(8))
    positions = np.frombuffer(handle.read(vertex_count * 12), dtype="<f4").reshape(-1, 3)
    normals = np.frombuffer(handle.read(vertex_count * 12), dtype="<f4").reshape(-1, 3)
    triangles = np.frombuffer(handle.read(triangle_count * 12), dtype="<u4").reshape(-1, 3)
    packed_colors = handle.read(vertex_count * 3)
    colors = (
        np.frombuffer(packed_colors, dtype=np.uint8).reshape(-1, 3)
        if len(packed_colors) == vertex_count * 3
        else None
    )


def project_values(values, basis):
    return (
        values[:, 0] * basis[0]
        + values[:, 1] * basis[1]
        + values[:, 2] * basis[2]
    )


def panel(basis_u, basis_v, basis_depth):
    width, height = 620, 900
    image = Image.new("RGB", (width, height), (239, 237, 231))
    draw = ImageDraw.Draw(image)
    uv = np.column_stack((project_values(positions, basis_u), project_values(positions, basis_v)))
    lo = uv.min(axis=0)
    hi = uv.max(axis=0)
    scale = min((width - 48) / max(1e-9, hi[0] - lo[0]), (height - 64) / max(1e-9, hi[1] - lo[1]))
    projected = np.empty_like(uv)
    projected[:, 0] = 24 + (uv[:, 0] - lo[0]) * scale
    projected[:, 1] = height - 28 - (uv[:, 1] - lo[1]) * scale
    triangle_centres = positions[triangles].mean(axis=1)
    depth = project_values(triangle_centres, basis_depth)
    order = np.argsort(depth)
    light = np.array([0.35, 0.7, 0.62], dtype=np.float64)
    light /= np.linalg.norm(light)
    face_points = positions[triangles].astype(np.float64)
    ab = face_points[:, 1] - face_points[:, 0]
    ac = face_points[:, 2] - face_points[:, 0]
    face_normals = np.cross(ab, ac)
    lengths = np.linalg.norm(face_normals, axis=1)
    face_normals /= np.maximum(lengths[:, None], 1e-9)
    diffuse = (
        face_normals[:, 0] * light[0]
        + face_normals[:, 1] * light[1]
        + face_normals[:, 2] * light[2]
    )
    shades = np.clip(0.48 + 0.42 * np.abs(diffuse), 0, 1)
    triangle_colors = (
        colors[triangles].mean(axis=1)
        if colors is not None
        else np.broadcast_to(np.array([181, 145, 122], dtype=np.float64), (len(triangles), 3))
    )
    for triangle_index in order:
        polygon = [tuple(projected[index]) for index in triangles[triangle_index]]
        color = tuple(
            np.clip(triangle_colors[triangle_index] * (0.25 + 0.75 * shades[triangle_index]), 0, 255)
            .astype(int)
        )
        draw.polygon(polygon, fill=color)
    return image


front = panel((1, 0, 0), (0, 1, 0), (0, 0, 1))
side = panel((0, 0, 1), (0, 1, 0), (-1, 0, 0))
oblique = panel((0.82, 0, -0.57), (0, 1, 0), (0.57, 0, 0.82))
canvas = Image.new("RGB", (front.width + side.width + oblique.width, front.height + 54), "white")
canvas.paste(front, (0, 54))
canvas.paste(side, (front.width, 54))
canvas.paste(oblique, (front.width + side.width, 54))
draw = ImageDraw.Draw(canvas)
font = ImageFont.load_default(size=20)
draw.text((front.width // 2, 26), "JERICHO — FACE (+Z)", fill=(25, 28, 32), anchor="mm", font=font)
draw.text((front.width + side.width // 2, 26), "JERICHO — PROFIL", fill=(25, 28, 32), anchor="mm", font=font)
draw.text((front.width + side.width + oblique.width // 2, 26), "JERICHO — 3/4", fill=(25, 28, 32), anchor="mm", font=font)
draw.line((front.width, 0, front.width, canvas.height), fill=(205, 205, 205), width=2)
draw.line((front.width + side.width, 0, front.width + side.width, canvas.height), fill=(205, 205, 205), width=2)
canvas.save(target)
print(f"{target}: {vertex_count} vertices, {triangle_count} triangles")
