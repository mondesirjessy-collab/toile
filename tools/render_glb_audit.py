"""Render front, side and back diagnostics for a GLB without modifying it."""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


source = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output = Path(sys.argv[sys.argv.index("--") + 2]).resolve()
output.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source), import_pack_images=True)
objects = [item for item in bpy.context.scene.objects if item.type == "MESH"]
if not objects:
    raise RuntimeError(f"No mesh in {source}")

points = [item.matrix_world @ Vector(corner) for item in objects for corner in item.bound_box]
minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
center = (minimum + maximum) * 0.5
height = maximum.z - minimum.z
width = maximum.x - minimum.x


def look_at(item, target):
    item.rotation_euler = (Vector(target) - item.location).to_track_quat("-Z", "Y").to_euler()


scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 700
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("Audit World")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.025, 0.03, 0.04, 1)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.25

camera_data = bpy.data.cameras.new("Audit Camera")
camera_data.lens = 65
camera = bpy.data.objects.new("Audit Camera", camera_data)
bpy.context.collection.objects.link(camera)
scene.camera = camera

for name, location, energy, size in (
    ("Key", (-2.3, -3.0, 2.8), 900, 3.0),
    ("Fill", (2.0, -1.8, 1.3), 500, 2.4),
    ("Rim", (0.0, 2.0, 2.5), 750, 2.5),
):
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = location
    look_at(light, center)

distance = max(height, width) * 2.45
views = {
    "front": Vector((center.x, minimum.y - distance, center.z)),
    "side": Vector((maximum.x + distance, center.y, center.z)),
    "back": Vector((center.x, maximum.y + distance, center.z)),
}
for name, location in views.items():
    camera.location = location
    look_at(camera, center)
    scene.render.filepath = str(output / f"{name}.png")
    bpy.ops.render.render(write_still=True)

print({"source": str(source), "output": str(output), "bounds": [list(minimum), list(maximum)]})
