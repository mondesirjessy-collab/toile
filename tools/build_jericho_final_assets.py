import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
import sys


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            'Construit les GLB visuel/export et le STL physique de Jericho '
            'depuis le GLB original. À lancer avec Blender en mode headless.'
        ),
    )
    parser.add_argument(
        '--source',
        required=True,
        type=Path,
        help='GLB source original (riggé et texturé).',
    )
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('/private/tmp/jericho-build'),
        help='Dossier des GLB, du STL, du rapport JSON et des rendus de contrôle.',
    )
    script_arguments = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    arguments = parser.parse_args(script_arguments)
    arguments.source = arguments.source.expanduser().resolve()
    arguments.output_dir = arguments.output_dir.expanduser().resolve()
    if not arguments.source.is_file():
        parser.error(f'GLB source introuvable : {arguments.source}')
    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    return arguments


ARGUMENTS = parse_arguments()
SOURCE = ARGUMENTS.source
OUTPUT_DIR = ARGUMENTS.output_dir
MASTER_GLB = OUTPUT_DIR / 'jericho.export.glb'
RUNTIME_GLB = OUTPUT_DIR / 'jericho.visual.glb'
PROXY_STL = OUTPUT_DIR / 'jericho.proxy.stl'
REPORT_OUT = OUTPUT_DIR / 'jericho.final.report.json'
MASTER_FRONT = OUTPUT_DIR / 'jericho.final.master-front.png'
MASTER_THREE_QUARTER = OUTPUT_DIR / 'jericho.final.master-3q.png'
MASTER_BACK = OUTPUT_DIR / 'jericho.final.master-back.png'
RUNTIME_FRONT = OUTPUT_DIR / 'jericho.final.visual-front.png'
RUNTIME_THREE_QUARTER = OUTPUT_DIR / 'jericho.final.visual-3q.png'
RUNTIME_BACK = OUTPUT_DIR / 'jericho.final.visual-back.png'

# Keep Blender-only imports after argument parsing so the script's `--help`
# remains usable on a machine where Blender is not on PYTHONPATH.
import bpy
import bmesh
import numpy as np
from mathutils import Vector

TARGET_HEIGHT_M = 1.83
TARGET_RUNTIME_TRIANGLES = 500_000
ARM_SLOPE_DEG = 55.0
FOREARM_EXTRA_SLOPE_DEG = 5.0
FOREARM_FORWARD_DEG = 3.0


def mesh_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def mesh_stats(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    minimum, maximum = mesh_bounds(obj)
    return {
        'vertices': len(mesh.vertices),
        'polygons': len(mesh.polygons),
        'triangles': len(mesh.loop_triangles),
        'all_triangles': all(len(poly.vertices) == 3 for poly in mesh.polygons),
        'surface_area_m2': sum(poly.area for poly in mesh.polygons),
        'bounds_blender_z_up_min': list(minimum),
        'bounds_blender_z_up_max': list(maximum),
        'dimensions_m': list(maximum - minimum),
        'uv_layers': [layer.name for layer in mesh.uv_layers],
        'uv_corner_count': len(mesh.uv_layers.active.data) if mesh.uv_layers.active else 0,
        'material_slots': [slot.material.name if slot.material else None for slot in obj.material_slots],
    }


def texture_report():
    return [
        {
            'name': image.name,
            'width': image.size[0],
            'height': image.size[1],
            'channels': image.channels,
            'packed': image.packed_file is not None,
            'file_format': image.file_format,
        }
        for image in bpy.data.images
    ]


def local_pose_rotation(pose_bone, armature_space_rotation):
    """Compose a desired armature-space delta into rotation_quaternion."""
    if pose_bone.parent:
        parent_rest_inverse = pose_bone.parent.bone.matrix_local.inverted()
        basis_to_armature = (
            pose_bone.parent.matrix
            @ parent_rest_inverse
            @ pose_bone.bone.matrix_local
        )
    else:
        basis_to_armature = pose_bone.bone.matrix_local
    basis_rotation = basis_to_armature.to_quaternion()
    local_delta = (
        basis_rotation.inverted()
        @ armature_space_rotation
        @ basis_rotation
    )
    pose_bone.rotation_mode = 'QUATERNION'
    pose_bone.rotation_quaternion = local_delta @ pose_bone.rotation_quaternion
    bpy.context.view_layer.update()


def arm_target(sign, forearm=False):
    slope = ARM_SLOPE_DEG + (FOREARM_EXTRA_SLOPE_DEG if forearm else 0.0)
    angle = math.radians(slope)
    forward = -math.sin(math.radians(FOREARM_FORWARD_DEG)) if forearm else 0.0
    return Vector((sign * math.cos(angle), forward, -math.sin(angle))).normalized()


def pose_arm(armature, side, sign):
    bones = armature.pose.bones
    upper = bones[f'{side}_Upperarm']
    forearm = bones[f'{side}_Forearm']
    hand = bones[f'{side}_Hand']
    upper_target = arm_target(sign)
    forearm_target = arm_target(sign, forearm=True)

    current_upper = (forearm.head - upper.head).normalized()
    local_pose_rotation(upper, current_upper.rotation_difference(upper_target))
    current_forearm = (hand.head - forearm.head).normalized()
    local_pose_rotation(forearm, current_forearm.rotation_difference(forearm_target))

    shoulder = upper.head.copy()
    elbow = forearm.head.copy()
    wrist = hand.head.copy()
    upper_direction = (elbow - shoulder).normalized()
    forearm_direction = (wrist - elbow).normalized()
    return {
        'shoulder_blender': list(shoulder),
        'elbow_blender': list(elbow),
        'wrist_blender': list(wrist),
        'upper_direction_blender': list(upper_direction),
        'forearm_direction_blender': list(forearm_direction),
        'upper_target_error_deg': math.degrees(upper_direction.angle(upper_target)),
        'forearm_target_error_deg': math.degrees(forearm_direction.angle(forearm_target)),
    }


def canonicalize_z_up(obj):
    """Feet Z=0, centered X/Y, exact 1.83 m before glTF Y-up conversion."""
    minimum, maximum = mesh_bounds(obj)
    scale = TARGET_HEIGHT_M / (maximum.z - minimum.z)
    center_x = (minimum.x + maximum.x) * 0.5
    center_y = (minimum.y + maximum.y) * 0.5
    for vertex in obj.data.vertices:
        vertex.co.x = (vertex.co.x - center_x) * scale
        vertex.co.y = (vertex.co.y - center_y) * scale
        vertex.co.z = (vertex.co.z - minimum.z) * scale
    obj.data.update()
    bpy.context.view_layer.update()
    return {'scale': scale, 'source_min': list(minimum), 'source_max': list(maximum)}


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def add_area(name, location, energy, size, target):
    data = bpy.data.lights.new(name=name, type='AREA')
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = location
    look_at(light, target)


def prepare_studio(scene, obj):
    minimum, maximum = mesh_bounds(obj)
    center = (minimum + maximum) * 0.5
    width = maximum.x - minimum.x
    height = maximum.z - minimum.z
    camera_data = bpy.data.cameras.new('Validation Camera')
    camera_data.lens = 58
    camera = bpy.data.objects.new('Validation Camera', camera_data)
    bpy.context.collection.objects.link(camera)
    half_fov = math.atan((camera_data.sensor_width * 0.5) / camera_data.lens)
    distance = max(width, height) * 0.58 / math.tan(half_fov)
    camera.location = (center.x, minimum.y - distance, center.z)
    look_at(camera, center)
    scene.camera = camera

    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new('Validation World')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get('Background')
    background.inputs['Color'].default_value = (0.025, 0.03, 0.04, 1.0)
    background.inputs['Strength'].default_value = 0.22
    scene.view_settings.exposure = -0.35

    target = center + Vector((0.0, 0.0, height * 0.03))
    add_area('Key', (center.x - 1.4, minimum.y - 1.8, center.z + 1.5), 270, 1.8, target)
    add_area('Fill', (center.x + 1.2, minimum.y - 1.0, center.z + 0.5), 130, 1.5, target)
    add_area('Rim', (center.x, maximum.y + 1.2, center.z + 1.2), 360, 1.4, target)
    return camera.matrix_world.copy()


def move_camera_three_quarter(scene, obj):
    minimum, maximum = mesh_bounds(obj)
    center = (minimum + maximum) * 0.5
    camera = scene.camera
    radial = math.hypot(camera.location.x - center.x, camera.location.y - center.y)
    camera.location = (center.x + radial * 0.62, center.y - radial * 0.785, center.z)
    look_at(camera, center)


def move_camera_back(scene, obj):
    minimum, maximum = mesh_bounds(obj)
    center = (minimum + maximum) * 0.5
    camera = scene.camera
    radial = math.hypot(camera.location.x - center.x, camera.location.y - center.y)
    camera.location = (center.x, center.y + radial, center.z)
    look_at(camera, center)


def render(scene, path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def render_glb_in_fresh_scene(path, front_path, three_quarter_path, back_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    obj = max(
        (item for item in bpy.context.scene.objects if item.type == 'MESH'),
        key=lambda item: len(item.data.polygons),
    )
    prepare_studio(bpy.context.scene, obj)
    render(bpy.context.scene, front_path)
    move_camera_three_quarter(bpy.context.scene, obj)
    render(bpy.context.scene, three_quarter_path)
    move_camera_back(bpy.context.scene, obj)
    render(bpy.context.scene, back_path)


def select_only(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def export_glb(obj, path):
    select_only(obj)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        use_selection=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
        export_image_quality=100,
        export_skins=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
    )


def glb_float_accessor(document, binary_offset, binary_length, accessor_index,
                       semantic, expected_components):
    accessor = document['accessors'][accessor_index]
    expected_type = f'VEC{expected_components}'
    if accessor.get('componentType') != 5126 or accessor.get('type') != expected_type:
        raise RuntimeError(f'{semantic} must be FLOAT {expected_type}')
    if 'sparse' in accessor:
        raise RuntimeError(f'{semantic} sparse accessors are not supported')
    if 'bufferView' not in accessor:
        raise RuntimeError(f'{semantic} has no bufferView')

    view = document['bufferViews'][accessor['bufferView']]
    if view.get('buffer', 0) != 0:
        raise RuntimeError(f'{semantic} does not reference the GLB BIN chunk')
    element_bytes = expected_components * 4
    stride = view.get('byteStride', element_bytes)
    if stride < element_bytes or stride % 4 != 0:
        raise RuntimeError(f'{semantic} has an invalid byteStride: {stride}')

    view_offset = view.get('byteOffset', 0)
    accessor_offset = accessor.get('byteOffset', 0)
    relative_start = view_offset + accessor_offset
    count = accessor['count']
    relative_end = relative_start
    if count:
        relative_end += (count - 1) * stride + element_bytes
    view_end = view_offset + view['byteLength']
    if relative_start < view_offset or relative_end > view_end or relative_end > binary_length:
        raise RuntimeError(f'{semantic} accessor exceeds its GLB bufferView')
    return count, binary_offset + relative_start, stride


def repair_glb_tangents(path):
    """Repair invalid glTF tangents in place without changing GLB structure."""
    payload = bytearray(path.read_bytes())
    if len(payload) < 28:
        raise RuntimeError(f'{path}: truncated GLB')
    magic, version, total_length = struct.unpack_from('<4sII', payload, 0)
    if magic != b'glTF' or version != 2 or total_length != len(payload):
        raise RuntimeError(f'{path}: invalid GLB header')

    json_length, json_type = struct.unpack_from('<II', payload, 12)
    if json_type != 0x4E4F534A:
        raise RuntimeError(f'{path}: missing JSON chunk')
    json_start = 20
    json_end = json_start + json_length
    document = json.loads(bytes(payload[json_start:json_end]).rstrip(b'\x00 ').decode('utf-8'))

    binary_header = json_end
    if binary_header + 8 > len(payload):
        raise RuntimeError(f'{path}: missing BIN chunk header')
    binary_length, binary_type = struct.unpack_from('<II', payload, binary_header)
    if binary_type != 0x004E4942:
        raise RuntimeError(f'{path}: missing BIN chunk')
    binary_offset = binary_header + 8
    if binary_offset + binary_length > len(payload):
        raise RuntimeError(f'{path}: truncated BIN chunk')

    repaired_count = 0
    normalized_count = 0
    tangent_count = 0
    accessor_count = 0
    processed_accessors = {}
    cardinal_axes = (
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
    )

    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            attributes = primitive.get('attributes', {})
            tangent_index = attributes.get('TANGENT')
            if tangent_index is None:
                continue
            normal_index = attributes.get('NORMAL')
            if normal_index is None:
                raise RuntimeError(f'{path}: TANGENT accessor has no matching NORMAL')
            previous_normal = processed_accessors.get(tangent_index)
            if previous_normal is not None:
                if previous_normal != normal_index:
                    raise RuntimeError(f'{path}: one TANGENT accessor uses multiple NORMAL accessors')
                continue
            processed_accessors[tangent_index] = normal_index

            tangents = glb_float_accessor(
                document, binary_offset, binary_length, tangent_index, 'TANGENT', 4,
            )
            normals = glb_float_accessor(
                document, binary_offset, binary_length, normal_index, 'NORMAL', 3,
            )
            tangent_items, tangent_start, tangent_stride = tangents
            normal_items, normal_start, normal_stride = normals
            if tangent_items != normal_items:
                raise RuntimeError(f'{path}: TANGENT/NORMAL count mismatch')
            accessor_count += 1
            tangent_count += tangent_items

            for index in range(tangent_items):
                tangent_offset = tangent_start + index * tangent_stride
                x, y, z = struct.unpack_from('<3f', payload, tangent_offset)
                length = math.sqrt(x * x + y * y + z * z)
                if not math.isfinite(length):
                    raise RuntimeError(f'{path}: non-finite tangent at {index}')

                if length < 0.9 or length > 1.1:
                    normal_offset = normal_start + index * normal_stride
                    nx, ny, nz = struct.unpack_from('<3f', payload, normal_offset)
                    normal_length = math.sqrt(nx * nx + ny * ny + nz * nz)
                    if not math.isfinite(normal_length) or normal_length <= 1e-8:
                        raise RuntimeError(f'{path}: cannot repair tangent {index}: invalid normal')
                    nx, ny, nz = nx / normal_length, ny / normal_length, nz / normal_length
                    ax, ay, az = min(
                        cardinal_axes,
                        key=lambda axis: abs(
                            nx * axis[0] + ny * axis[1] + nz * axis[2]
                        ),
                    )
                    x, y, z = (
                        ny * az - nz * ay,
                        nz * ax - nx * az,
                        nx * ay - ny * ax,
                    )
                    length = math.sqrt(x * x + y * y + z * z)
                    repaired_count += 1
                elif abs(length - 1.0) <= 1e-6:
                    continue
                else:
                    normalized_count += 1

                # Write xyz only: tangent handedness (w) remains byte-identical.
                struct.pack_into(
                    '<3f', payload, tangent_offset, x / length, y / length, z / length,
                )

    changed_count = repaired_count + normalized_count
    if changed_count:
        temporary = path.with_name(f'.{path.name}.tangent-fix.tmp')
        temporary.write_bytes(payload)
        temporary.replace(path)
    return {
        'repaired_count': repaired_count,
        'normalized_count': normalized_count,
        'tangents_checked': tangent_count,
        'accessors_checked': accessor_count,
        'file_bytes': len(payload),
    }


def read_glb(path):
    with path.open('rb') as stream:
        magic, version, total_length = struct.unpack('<4sII', stream.read(12))
        json_length, json_type = struct.unpack('<II', stream.read(8))
        document = json.loads(stream.read(json_length).rstrip(b'\x00 '))
        bin_length, bin_type = struct.unpack('<II', stream.read(8))
        binary = stream.read(bin_length)
    image_rows = []
    for image in document.get('images', []):
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        payload = binary[start:start + view['byteLength']]
        image_rows.append({
            'name': image.get('name'),
            'mime_type': image.get('mimeType'),
            'bytes': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(),
        })
    primitive = document['meshes'][0]['primitives'][0]
    position_accessor = document['accessors'][primitive['attributes']['POSITION']]
    mesh_node_transforms = []
    for node in document.get('nodes', []):
        if 'mesh' in node:
            mesh_node_transforms.append({
                key: node[key]
                for key in ('name', 'matrix', 'translation', 'rotation', 'scale')
                if key in node
            })
    return {
        'bytes': path.stat().st_size,
        'magic': magic.decode('ascii'),
        'version': version,
        'declared_bytes': total_length,
        'mesh_count': len(document.get('meshes', [])),
        'primitive_counts': [len(mesh['primitives']) for mesh in document.get('meshes', [])],
        'material_count': len(document.get('materials', [])),
        'attributes': sorted(primitive['attributes'].keys()),
        'position_accessor_count': position_accessor['count'],
        'position_bounds_y_up_min': position_accessor.get('min'),
        'position_bounds_y_up_max': position_accessor.get('max'),
        'images': image_rows,
        'textures': len(document.get('textures', [])),
        'skins': len(document.get('skins', [])),
        'animations': len(document.get('animations', [])),
        'mesh_node_transforms': mesh_node_transforms,
        'extensions_used': document.get('extensionsUsed', []),
    }


def raw_stl_report(path):
    record_type = np.dtype([
        ('normal', '<f4', (3,)),
        ('vertices', '<f4', (3, 3)),
        ('attribute', '<u2'),
    ])
    with path.open('rb') as stream:
        header = stream.read(80)
        (triangle_count,) = struct.unpack('<I', stream.read(4))
        records = np.fromfile(stream, dtype=record_type, count=triangle_count)
    vertices = records['vertices'].reshape(-1, 3)
    minimum = vertices.min(axis=0)
    maximum = vertices.max(axis=0)
    feet = vertices[vertices[:, 1] < 0.15]
    return {
        'bytes': path.stat().st_size,
        'header': header.rstrip(b'\0').decode('ascii', errors='replace'),
        'triangles': int(triangle_count),
        'records_read': int(len(records)),
        'bounds_y_up_min': minimum.tolist(),
        'bounds_y_up_max': maximum.tolist(),
        'dimensions_m': (maximum - minimum).tolist(),
        'feet_z_min': float(feet[:, 2].min()),
        'feet_z_max': float(feet[:, 2].max()),
    }


# Import and keep only the visible human surface.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE), import_pack_images=True)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
body = max(meshes, key=lambda obj: len(obj.data.polygons))
for obj in meshes:
    if obj != body:
        bpy.data.objects.remove(obj, do_unlink=True)
armature = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
source_textures = texture_report()
source_mesh_before_pose = mesh_stats(body)


def repair_fused_hand_thigh_contacts(mesh_object):
    """Detach accidental Tripo hand/thigh welds before lifting the arms.

    Some arms-down scans contain a few triangles whose vertices jump directly
    from a Hand-dominant skin region to a Thigh-dominant region. They are
    invisible in the supplied pose because the hands touch the boxer, but they
    become metre-wide membranes in a sewing A-pose. Remove only those bridge
    triangles and make the mixed boundary weights follow their dominant limb.
    The source UVs and every unrelated face remain untouched.
    """
    mesh = mesh_object.data
    groups = {group.index: group.name for group in mesh_object.vertex_groups}
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    deform = bm.verts.layers.deform.verify()

    coordinates = np.empty((len(mesh.vertices), 3), dtype=np.float64)
    mesh.vertices.foreach_get('co', coordinates.ravel())
    minimum = coordinates.min(axis=0)
    maximum = coordinates.max(axis=0)
    height = maximum[2] - minimum[2]
    contact_bottom = minimum[2] + 0.34 * height
    contact_top = minimum[2] + 0.66 * height

    def dominant_name(vertex):
        weights = vertex[deform]
        entries = list(weights.items())
        if not entries:
            return ''
        group_index = max(entries, key=lambda entry: entry[1])[0]
        return groups.get(group_index, '')

    bridge_faces = []
    bridge_vertices = set()
    for face in bm.faces:
        centre_height = sum(vertex.co.z for vertex in face.verts) / len(face.verts)
        if centre_height < contact_bottom or centre_height > contact_top:
            continue
        names = [dominant_name(vertex) for vertex in face.verts]
        for side in ('L', 'R'):
            if (
                f'{side}_Hand' in names
                and any(name.startswith(f'{side}_Thigh') for name in names)
            ):
                bridge_faces.append(face)
                bridge_vertices.update(face.verts)
                break

    if not bridge_faces:
        bm.free()
        return {
            'detected': False,
            'bridge_faces_removed': 0,
            'vertices_reweighted': 0,
            'reason': 'no Hand/Thigh dominant bridge in the source mesh',
        }

    arm_prefixes = {
        side: tuple(
            f'{side}_{part}'
            for part in ('Clavicle', 'Upperarm', 'Forearm', 'Hand')
        )
        for side in ('L', 'R')
    }
    leg_prefixes = {
        side: (f'{side}_Thigh',)
        for side in ('L', 'R')
    }
    changed_vertices = 0
    stripped_weight = 0.0
    for vertex in bm.verts:
        if vertex.co.z < contact_bottom or vertex.co.z > contact_top:
            continue
        weights = vertex[deform]
        entries = list(weights.items())
        if not entries:
            continue
        dominant = dominant_name(vertex)
        side = 'L' if dominant.startswith('L_') else 'R' if dominant.startswith('R_') else None
        if side is None:
            continue
        dominant_is_arm = dominant.startswith(arm_prefixes[side])
        dominant_is_leg = dominant.startswith(leg_prefixes[side])
        if not dominant_is_arm and not dominant_is_leg:
            continue
        remove_prefixes = leg_prefixes[side] if dominant_is_arm else arm_prefixes[side]
        to_remove = [
            index for index, _weight in entries
            if groups.get(index, '').startswith(remove_prefixes)
        ]
        if not to_remove:
            continue
        for index in to_remove:
            stripped_weight += weights[index]
            del weights[index]
        total = sum(weight for _index, weight in weights.items())
        if total <= 1e-9:
            # The dominant group is necessarily still present in normal input;
            # this is only a defensive fallback for malformed skin weights.
            dominant_index = next(
                index for index, name in groups.items() if name == dominant
            )
            weights[dominant_index] = 1.0
        else:
            for index, _weight in list(weights.items()):
                weights[index] /= total
        changed_vertices += 1

    bridge_face_count = len(bridge_faces)
    bridge_vertex_count = len(bridge_vertices)
    bmesh.ops.delete(bm, geom=bridge_faces, context='FACES')
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return {
        'detected': True,
        'method': 'remove Hand-dominant/Thigh-dominant bridge faces; renormalize mixed boundary weights to the dominant limb',
        'bridge_faces_removed': bridge_face_count,
        'bridge_vertices': bridge_vertex_count,
        'vertices_reweighted': changed_vertices,
        'stripped_cross_limb_weight': stripped_weight,
        'contact_height_fraction': [0.34, 0.66],
        'uv_policy': 'all retained source loops untouched; no replacement faces invented',
    }


CONTACT_REPAIR = repair_fused_hand_thigh_contacts(body)


def create_runtime_boundary_protection(mesh_object, ring_count=1):
    """Protect open/non-manifold contours from the runtime decimator.

    Tripo's boxer hem and a few small scan seams are real geometric borders.
    Unconstrained quadric collapse turns those contours into dark saw teeth.
    A narrow one-ring guard keeps their source silhouette while still allowing strong
    simplification over the large, smooth body surfaces.
    """
    bm = bmesh.new()
    bm.from_mesh(mesh_object.data)
    bm.verts.ensure_lookup_table()
    minimum_z = min(vertex.co.z for vertex in bm.verts)
    maximum_z = max(vertex.co.z for vertex in bm.verts)
    height = maximum_z - minimum_z
    hem_bottom = minimum_z + 0.30 * height
    hem_top = minimum_z + 0.46 * height
    central_half_width = 0.14 * height
    protected = set()
    for edge in bm.edges:
        if len(edge.link_faces) == 2:
            continue
        midpoint_x = sum(vertex.co.x for vertex in edge.verts) / len(edge.verts)
        midpoint_z = sum(vertex.co.z for vertex in edge.verts) / len(edge.verts)
        if hem_bottom <= midpoint_z <= hem_top and abs(midpoint_x) <= central_half_width:
            protected.update(edge.verts)
    contour_vertex_count = len(protected)
    frontier = set(protected)
    for _ring in range(ring_count):
        neighbours = {
            other
            for vertex in frontier
            for edge in vertex.link_edges
            for other in edge.verts
            if other not in protected
        }
        protected.update(neighbours)
        frontier = neighbours
    indices = sorted(vertex.index for vertex in protected)
    bm.free()

    group = mesh_object.vertex_groups.new(name='TOILE_RuntimeBoundaryGuard')
    if indices:
        group.add(indices, 1.0, 'REPLACE')
    return group, {
        'contour_vertices': contour_vertex_count,
        'protected_vertices': len(indices),
        'neighbour_rings': ring_count,
        'height_fraction': [0.30, 0.46],
        'central_half_width_height_fraction': 0.14,
        'decimator_policy': 'invert vertex-group influence around the boxer hem only',
    }


def slim_smoothstep(edge0, edge1, value):
    if edge0 == edge1:
        return np.where(value < edge0, 0.0, 1.0)
    t = np.clip((value - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def posed_axis_in_mesh(body_object, rig, bone_name):
    bone = rig.pose.bones[bone_name]
    armature_to_mesh = body_object.matrix_world.inverted() @ rig.matrix_world
    return (
        np.array(armature_to_mesh @ bone.head, dtype=np.float64),
        np.array(armature_to_mesh @ bone.tail, dtype=np.float64),
    )


def regional_weights(mesh_object):
    count = len(mesh_object.data.vertices)
    weights = {
        name: np.zeros(count, dtype=np.float32)
        for name in ('torso', 'upper_l', 'upper_r', 'fore_l', 'fore_r',
                     'thigh_l', 'thigh_r', 'calf_l', 'calf_r')
    }
    group_to_region = {}
    for group in mesh_object.vertex_groups:
        name = group.name
        region = None
        if name in {'Hip', 'Pelvis', 'Waist', 'Spine01', 'Spine02',
                    'L_Clavicle', 'R_Clavicle'}:
            region = 'torso'
        elif name.startswith('L_Upperarm'):
            region = 'upper_l'
        elif name.startswith('R_Upperarm'):
            region = 'upper_r'
        elif name.startswith('L_Forearm'):
            region = 'fore_l'
        elif name.startswith('R_Forearm'):
            region = 'fore_r'
        elif name.startswith('L_Thigh'):
            region = 'thigh_l'
        elif name.startswith('R_Thigh'):
            region = 'thigh_r'
        elif name.startswith('L_Calf'):
            region = 'calf_l'
        elif name.startswith('R_Calf'):
            region = 'calf_r'
        if region:
            group_to_region[group.index] = region

    for vertex in mesh_object.data.vertices:
        for membership in vertex.groups:
            region = group_to_region.get(membership.group)
            if region:
                weights[region][vertex.index] += membership.weight
    for values in weights.values():
        np.clip(values, 0.0, 1.0, out=values)
    return weights


def radial_values(points, start, end):
    axis = end - start
    axis_length_squared = float(np.dot(axis, axis))
    relative = points - start
    along = (relative @ axis) / axis_length_squared
    centers = start + along[:, None] * axis
    radii = np.linalg.norm(points - centers, axis=1)
    return along, centers, radii


def contract_about_bone(points, weights, start, end, knots, scales):
    along, centers, _ = radial_values(points, start, end)
    scale = np.interp(along, knots, scales)
    target = centers + (points - centers) * scale[:, None]
    # Smooth skin weights are the transition field. Squaring their smoothstep
    # keeps tiny incidental influences from denting neighboring body regions.
    blend = slim_smoothstep(0.03, 0.92, weights.astype(np.float64))
    points += (target - points) * blend[:, None]


def weighted_radius_metric(points, weights, start, end):
    mask = weights >= 0.25
    if not np.any(mask):
        return None
    _, _, radii = radial_values(points[mask], start, end)
    selected_weights = weights[mask].astype(np.float64)
    return {
        'vertices': int(np.count_nonzero(mask)),
        'weighted_mean_radius': float(np.average(radii, weights=selected_weights)),
        'p95_radius': float(np.percentile(radii, 95.0)),
    }


def apply_slim_morph(mesh_object, rig):
    mesh = mesh_object.data
    coordinates = np.empty((len(mesh.vertices), 3), dtype=np.float64)
    mesh.vertices.foreach_get('co', coordinates.ravel())
    original = coordinates.copy()
    weights = regional_weights(mesh_object)

    minimum = coordinates.min(axis=0)
    maximum = coordinates.max(axis=0)
    source_height = maximum[2] - minimum[2]
    normalized_height = (coordinates[:, 2] - minimum[2]) / source_height
    center_x = float(rig.pose.bones['Hip'].head.x)
    center_y = float(rig.pose.bones['Spine01'].head.y)

    # Classic male profile: a calmer shoulder/back line than the athletic
    # source, paired with a straighter waist transition. The low-pass envelope
    # applied immediately before this morph removes sculpted muscle relief;
    # these scales control the broad anthropometric silhouette.
    x_scale = np.interp(
        normalized_height,
        [0.47, 0.515, 0.57, 0.61, 0.65, 0.70, 0.76, 0.80, 0.84],
        [1.00, 0.960, 0.970, 1.030, 1.020, 0.760, 0.760, 0.800, 1.00],
    )
    depth_scale = np.interp(
        normalized_height,
        [0.47, 0.515, 0.57, 0.61, 0.65, 0.70, 0.76, 0.80, 0.84],
        [1.00, 0.970, 0.970, 1.015, 1.020, 0.930, 0.930, 0.950, 1.00],
    )
    torso_blend = slim_smoothstep(0.03, 0.92, weights['torso'].astype(np.float64))
    coordinates[:, 0] += (
        center_x + (coordinates[:, 0] - center_x) * x_scale - coordinates[:, 0]
    ) * torso_blend
    coordinates[:, 1] += (
        center_y + (coordinates[:, 1] - center_y) * depth_scale - coordinates[:, 1]
    ) * torso_blend

    axes = {}
    for side, suffix in (('l', 'L'), ('r', 'R')):
        axes[f'upper_{side}'] = posed_axis_in_mesh(mesh_object, rig, f'{suffix}_Upperarm')
        axes[f'fore_{side}'] = posed_axis_in_mesh(mesh_object, rig, f'{suffix}_Forearm')
        axes[f'thigh_{side}'] = posed_axis_in_mesh(mesh_object, rig, f'{suffix}_Thigh')
        axes[f'calf_{side}'] = posed_axis_in_mesh(mesh_object, rig, f'{suffix}_Calf')

    before_metrics = {
        region: weighted_radius_metric(original, weights[region], *axis)
        for region, axis in axes.items()
    }

    for side in ('l', 'r'):
        # A tighter proximal easing prevents the deltoid from extending the
        # wide source back; the arm itself retains an ordinary thickness.
        contract_about_bone(
            coordinates, weights[f'upper_{side}'], *axes[f'upper_{side}'],
            [-0.15, 0.00, 0.16, 0.38, 0.78, 1.00, 1.18],
            [0.94, 0.75, 0.78, 0.84, 0.88, 0.93, 0.98],
        )
        # Forearm 10%, then a long easing zone that leaves the hand untouched.
        contract_about_bone(
            coordinates, weights[f'fore_{side}'], *axes[f'fore_{side}'],
            [-0.12, 0.00, 0.18, 0.68, 0.86, 1.00, 1.15],
            [0.95, 0.90, 0.90, 0.90, 0.945, 1.00, 1.00],
        )
        # Long, narrow mannequin thigh; ease at hip/knee to avoid joint dents.
        contract_about_bone(
            coordinates, weights[f'thigh_{side}'], *axes[f'thigh_{side}'],
            [-0.12, 0.00, 0.14, 0.62, 0.88, 1.00, 1.14],
            [0.99, 0.94, 0.875, 0.855, 0.885, 0.96, 1.00],
        )
        # Calf 5%, tapered completely into ankle/foot.
        contract_about_bone(
            coordinates, weights[f'calf_{side}'], *axes[f'calf_{side}'],
            [-0.12, 0.00, 0.15, 0.68, 0.88, 1.00, 1.14],
            [0.99, 0.97, 0.95, 0.95, 0.975, 1.00, 1.00],
        )

    mesh.vertices.foreach_set('co', coordinates.astype(np.float32).ravel())
    mesh.update()

    after_metrics = {
        region: weighted_radius_metric(coordinates, weights[region], *axis)
        for region, axis in axes.items()
    }
    ratios = {}
    for region in axes:
        before = before_metrics[region]
        after = after_metrics[region]
        ratios[region] = {
            key: after[key] / before[key]
            for key in ('weighted_mean_radius', 'p95_radius')
        }

    # Lowering normal strength softens baked muscle definition without touching
    # the source normal image bytes. glTF exports this as normalTexture.scale.
    normal_nodes = []
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == 'NORMAL_MAP':
                node.inputs['Strength'].default_value = 0.12
                normal_nodes.append(f'{material.name}:{node.name}')

    return {
        'method': 'pre-skinning bone-weighted radial morph; smoothstep transitions; DQ pose bake afterwards',
        'target_profile': {
            'stature_m': 1.83,
            'chest_width': -0.20,
            'chest_depth': -0.10,
            'deltoids': -0.18,
            'upperarm_radius': -0.12,
            'forearm_radius': -0.10,
            'hip_radius': -0.045,
            'thigh_radius': -0.145,
            'calf_radius': -0.05,
            'waist': 'classic straight transition; approximately source size',
            'normal_texture_scale': 0.12,
        },
        'bone_weighted_radius_before': before_metrics,
        'bone_weighted_radius_after': after_metrics,
        'measured_radius_ratios': ratios,
        'normal_map_nodes': normal_nodes,
        'preserved_regions': ['head/face', 'hands/fingers', 'feet/toes'],
        'topology': 'vertex and polygon connectivity unchanged by morph',
    }


def protected_weight_field(mesh_object):
    protected_names = {
        'Head', 'NeckTwist01', 'NeckTwist02',
        'L_Hand', 'R_Hand',
        'L_Foot', 'R_Foot', 'L_ToeBase', 'R_ToeBase',
    }
    protected_groups = {
        group.index for group in mesh_object.vertex_groups
        if group.name in protected_names
    }
    values = np.zeros(len(mesh_object.data.vertices), dtype=np.float32)
    for vertex in mesh_object.data.vertices:
        values[vertex.index] = sum(
            membership.weight for membership in vertex.groups
            if membership.group in protected_groups
        )
    np.clip(values, 0.0, 1.0, out=values)
    return values


def remove_all_modifiers(obj):
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)


def apply_mannequin_envelope(mesh_object):
    """Attenuate sculpted muscle relief through a disposable voxel cage.

    The million-vertex master itself is never remeshed: topology, UV corners,
    vertex groups and rig correspondence remain byte-for-byte addressable.
    Only a clamped displacement along each original normal is copied back.
    """
    mesh = mesh_object.data
    count = len(mesh.vertices)
    original = np.empty((count, 3), dtype=np.float64)
    normals = np.empty((count, 3), dtype=np.float64)
    mesh.vertices.foreach_get('co', original.ravel())
    mesh.update()
    mesh.vertices.foreach_get('normal', normals.ravel())
    lengths = np.linalg.norm(normals, axis=1)
    valid = lengths > 1e-12
    normals[valid] /= lengths[valid, None]

    regions = regional_weights(mesh_object)
    active = np.zeros(count, dtype=np.float32)
    for values in regions.values():
        active += values
    np.clip(active, 0.0, 1.0, out=active)
    protected = protected_weight_field(mesh_object)
    mask = slim_smoothstep(0.04, 0.88, active.astype(np.float64))
    mask *= 1.0 - slim_smoothstep(0.01, 0.52, protected.astype(np.float64))
    mask[protected >= 0.55] = 0.0

    source_height = float(np.ptp(original[:, 2]))
    final_scale = TARGET_HEIGHT_M / source_height
    voxel_size = 0.016 / final_scale
    max_normal_displacement = 0.012 / final_scale

    cage = mesh_object.copy()
    cage.data = mesh.copy()
    cage.name = 'JerichoMannequinVoxelCage'
    bpy.context.collection.objects.link(cage)
    remove_all_modifiers(cage)
    cage.data.remesh_voxel_size = voxel_size
    cage.data.remesh_voxel_adaptivity = 0.0
    select_only(cage)
    bpy.ops.object.voxel_remesh()

    # A 16 mm cage is deliberately coarser than abdominal/pectoral lobes. The
    # master remains high-resolution; this only provides its low-pass target.
    smooth = cage.modifiers.new(name='TOILE_Mannequin_Cage_Smooth', type='SMOOTH')
    smooth.factor = 0.50
    smooth.iterations = 20
    select_only(cage)
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    probe = mesh_object.copy()
    probe.data = mesh.copy()
    probe.name = 'JerichoMannequinProjectionProbe'
    bpy.context.collection.objects.link(probe)
    remove_all_modifiers(probe)
    shrink = probe.modifiers.new(name='TOILE_Mannequin_Envelope', type='SHRINKWRAP')
    shrink.target = cage
    shrink.wrap_method = 'NEAREST_SURFACEPOINT'
    shrink.wrap_mode = 'ON_SURFACE'
    select_only(probe)
    bpy.ops.object.modifier_apply(modifier=shrink.name)

    projected = np.empty((count, 3), dtype=np.float64)
    probe.data.vertices.foreach_get('co', projected.ravel())
    signed = np.einsum('ij,ij->i', projected - original, normals)
    np.clip(signed, -max_normal_displacement, max_normal_displacement, out=signed)
    strength = 0.88
    raw_displacement = normals * (mask * strength * signed)[:, None]

    # The source uses duplicated vertices along UV/material seams. Their
    # normals can differ, so applying the normal displacement independently
    # opens microscopic cracks that become real boundaries when the STL is
    # welded. Quantize only at sub-micrometric source scale, then give every
    # coincident duplicate the exact same mean displacement. If any member is
    # identity-critical, lock the complete seam cluster.
    weld_tolerance = float(np.ptp(original, axis=0).max()) * 1e-7
    weld_keys = np.rint(original / weld_tolerance).astype(np.int64)
    _, weld_inverse, weld_counts = np.unique(
        weld_keys, axis=0, return_inverse=True, return_counts=True,
    )
    cluster_count = len(weld_counts)
    cluster_original = np.column_stack([
        np.bincount(weld_inverse, weights=original[:, axis], minlength=cluster_count)
        / weld_counts
        for axis in range(3)
    ])
    cluster_displacement = np.column_stack([
        np.bincount(
            weld_inverse,
            weights=raw_displacement[:, axis],
            minlength=cluster_count,
        ) / weld_counts
        for axis in range(3)
    ])
    cluster_locked = np.zeros(cluster_count, dtype=np.uint8)
    np.maximum.at(cluster_locked, weld_inverse, (protected >= 0.55).astype(np.uint8))
    cluster_displacement[cluster_locked != 0] = 0.0
    final = cluster_original[weld_inverse] + cluster_displacement[weld_inverse]
    mesh.vertices.foreach_set('co', final.astype(np.float32).ravel())
    mesh.update()

    bpy.data.objects.remove(probe, do_unlink=True)
    bpy.data.objects.remove(cage, do_unlink=True)
    signed_mm = signed * final_scale * 1000.0
    applied_mm = signed_mm * mask * strength
    active_mask = mask >= 0.25
    return {
        'method': '16 mm disposable voxel cage + 20 smooth passes; nearest-surface sampled; normal-only clamped transfer',
        'topology_changed': False,
        'voxel_size_final_mm': 16.0,
        'maximum_normal_displacement_final_mm': 12.0,
        'transfer_strength': strength,
        'active_vertices': int(np.count_nonzero(active_mask)),
        'hard_preserved_vertices': int(np.count_nonzero(mask == 0.0)),
        'weld_tolerance_source_units': weld_tolerance,
        'coincident_clusters': int(np.count_nonzero(weld_counts > 1)),
        'coincident_duplicate_vertices': int(count - cluster_count),
        'locked_clusters': int(np.count_nonzero(cluster_locked)),
        'maximum_cluster_spread_after_transfer': float(np.max(np.linalg.norm(
            final - cluster_original[weld_inverse] - cluster_displacement[weld_inverse],
            axis=1,
        ))),
        'protected_regions': ['head/face/neck', 'hands/fingers', 'feet/toes'],
        'applied_displacement_mm_percentiles': {
            str(q): float(np.percentile(np.abs(applied_mm[active_mask]), q))
            for q in (50, 90, 95, 99, 100)
        },
    }


def apply_classic_shoulder_warp(mesh_object):
    """Replace the source swimmer V with a restrained everyday shoulder line.

    Torso skin weights alone do not cover the lateral deltoid/lat seam on this
    scan. A gentle height field is therefore applied after posing: it moves
    the complete shoulder girdle coherently, fades before the forearms and
    neck, and leaves the head, hands, pelvis, legs and feet unchanged.
    """
    mesh = mesh_object.data
    coordinates = np.empty((len(mesh.vertices), 3), dtype=np.float64)
    mesh.vertices.foreach_get('co', coordinates.ravel())
    minimum = coordinates.min(axis=0)
    maximum = coordinates.max(axis=0)
    source_height = maximum[2] - minimum[2]
    normalized_height = (coordinates[:, 2] - minimum[2]) / source_height
    scale = np.interp(
        normalized_height,
        [0.56, 0.61, 0.66, 0.71, 0.77, 0.81, 0.85],
        [1.00, 0.985, 0.940, 0.905, 0.895, 0.930, 1.00],
    )
    center_x = 0.5 * (minimum[0] + maximum[0])
    original_x = coordinates[:, 0].copy()
    coordinates[:, 0] = center_x + (coordinates[:, 0] - center_x) * scale
    mesh.vertices.foreach_set('co', coordinates.astype(np.float32).ravel())
    mesh.update()
    inward = np.abs(coordinates[:, 0] - original_x)
    return {
        'method': 'post-pose height-field X contraction of complete shoulder girdle',
        'minimum_scale': float(scale.min()),
        'maximum_inward_shift_final_mm': float(
            inward.max() * TARGET_HEIGHT_M / source_height * 1000.0
        ),
        'active_height_fraction': [0.56, 0.85],
        'full_strength_height_fraction': [0.71, 0.77],
        'preserved_regions': ['head/face/neck', 'hands/fingers', 'pelvis/legs', 'feet/toes'],
        'topology': 'vertex and polygon connectivity unchanged; coincident UV vertices share the same affine warp',
    }


# Preserve the supplied anatomy and materials. Jericho's authoring pipeline may
# articulate the source rig and apply one uniform stature scale, but it must
# never sculpt, smooth, contract or otherwise reinterpret the user's model.
# The one exception is the documented removal of accidental hand/boxer contact
# faces and their cross-limb weights, required because the source scan welded
# those two surfaces together while the arms were down.
# This deliberately bypasses apply_mannequin_envelope(), apply_slim_morph()
# and apply_classic_shoulder_warp().
SOURCE_SURFACE_POLICY = {
    'variant': 'supplied replacement model with documented contact repair',
    'shape_edits': [],
    'contact_topology_repair': CONTACT_REPAIR,
    'material_edits': [],
    'allowed_operations': [
        'source-rig articulation into the garment A-pose',
        'uniform scale to 1.83 m',
        'translation to feet y=0 and horizontal centring',
        'runtime-only high-fidelity visual LOD derived from the repaired master',
    ],
    'source_vertices': source_mesh_before_pose['vertices'],
    'source_triangles': source_mesh_before_pose['triangles'],
}

# Low, garment-friendly A-pose: local hierarchical rotations only. This is a
# change of pose, not a change of anatomy or proportions.
pose = {
    'left': pose_arm(armature, 'L', 1.0),
    'right': pose_arm(armature, 'R', -1.0),
}
armature_modifiers = [modifier for modifier in body.modifiers if modifier.type == 'ARMATURE']
if len(armature_modifiers) != 1:
    raise RuntimeError(f'expected one Armature modifier, got {len(armature_modifiers)}')
armature_modifier = armature_modifiers[0]
# glTF skinning is linear blend skinning. Keep that source-compatible method
# instead of introducing Blender's optional dual-quaternion volume correction.
armature_modifier.use_deform_preserve_volume = False
select_only(body)
bpy.ops.object.modifier_apply(modifier=armature_modifier.name)

world = body.matrix_world.copy()
body.parent = None
body.matrix_world = world
bpy.data.objects.remove(armature, do_unlink=True)
if not body.matrix_world.is_identity:
    select_only(body)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
body.name = 'Jericho'
body.data.name = 'JerichoMaster'
for polygon in body.data.polygons:
    polygon.use_smooth = True
body.data.update()

master_canonicalization = canonicalize_z_up(body)
master_stats = mesh_stats(body)

# Export full-detail master and a Y-up STL from this exact frozen surface.
export_glb(body, MASTER_GLB)
master_tangent_repair = repair_glb_tangents(MASTER_GLB)
select_only(body)
bpy.ops.wm.stl_export(
    filepath=str(PROXY_STL),
    ascii_format=False,
    export_selected_objects=True,
    global_scale=1.0,
    use_scene_unit=False,
    forward_axis='NEGATIVE_Z',
    up_axis='Y',
    apply_modifiers=True,
)

# Runtime mesh is derived from the already-posed master, never re-skinned.
master_reference = body.copy()
master_reference.data = body.data.copy()
master_reference.name = 'JerichoMasterNormalReference'
master_reference.hide_render = True
bpy.context.collection.objects.link(master_reference)

runtime_boundary_group, runtime_boundary_protection = create_runtime_boundary_protection(body)
runtime_boundary_group_name = runtime_boundary_group.name
decimate = body.modifiers.new(name='TOILE_Runtime_500k', type='DECIMATE')
decimate.decimate_type = 'COLLAPSE'
decimate.ratio = min(1.0, TARGET_RUNTIME_TRIANGLES / master_stats['triangles'])
decimate.use_collapse_triangulate = True
decimate.vertex_group = runtime_boundary_group_name
decimate.invert_vertex_group = True
select_only(body)
bpy.ops.object.modifier_apply(modifier=decimate.name)
remaining_boundary_group = body.vertex_groups.get(runtime_boundary_group_name)
if remaining_boundary_group is not None:
    body.vertex_groups.remove(remaining_boundary_group)

# Restore the master shading frame onto the simplified surface. Geometry stays
# at 500k triangles; only split-loop normals are interpolated from the posed
# master before tangents are regenerated by the glTF exporter.
normal_transfer = body.modifiers.new(name='TOILE_Master_Normals', type='DATA_TRANSFER')
normal_transfer.object = master_reference
normal_transfer.use_loop_data = True
normal_transfer.data_types_loops = {'CUSTOM_NORMAL'}
normal_transfer.loop_mapping = 'POLYINTERP_NEAREST'
select_only(body)
bpy.ops.object.modifier_apply(modifier=normal_transfer.name)
bpy.data.objects.remove(master_reference, do_unlink=True)

runtime_canonicalization = canonicalize_z_up(body)
for polygon in body.data.polygons:
    polygon.use_smooth = True
body.data.update()
bpy.context.view_layer.update()
runtime_stats = mesh_stats(body)

body.data.name = 'JerichoVisual500k'
export_glb(body, RUNTIME_GLB)
runtime_tangent_repair = repair_glb_tangents(RUNTIME_GLB)

source_manifest = read_glb(SOURCE)
master_manifest = read_glb(MASTER_GLB)
runtime_manifest = read_glb(RUNTIME_GLB)
stl_manifest = raw_stl_report(PROXY_STL)

# Never reuse the build scene/camera for acceptance images: each GLB is
# reimported independently and framed from its own verified bounds.
render_glb_in_fresh_scene(MASTER_GLB, MASTER_FRONT, MASTER_THREE_QUARTER, MASTER_BACK)
render_glb_in_fresh_scene(RUNTIME_GLB, RUNTIME_FRONT, RUNTIME_THREE_QUARTER, RUNTIME_BACK)

report = {
    'blender': bpy.app.version_string,
    'variant': 'Jericho — modèle fourni réparé, pose couture',
    'source_surface_policy': SOURCE_SURFACE_POLICY,
    'source': str(SOURCE),
    'outputs': {
        'master_glb': str(MASTER_GLB),
        'runtime_glb': str(RUNTIME_GLB),
        'proxy_stl': str(PROXY_STL),
    },
    'pose': {
        'upperarm_slope_deg_below_horizontal': ARM_SLOPE_DEG,
        'forearm_slope_deg_below_horizontal': ARM_SLOPE_DEG + FOREARM_EXTRA_SLOPE_DEG,
        'forearm_forward_deg': FOREARM_FORWARD_DEG,
        'skinning': 'source weights; glTF-compatible linear blend skinning; static pose bake',
        'hierarchy': 'local rotation_quaternion Upperarm then Forearm',
        'joints_before_normalization': pose,
    },
    'source_textures': source_textures,
    'source_contact_repair': CONTACT_REPAIR,
    'master_canonicalization': master_canonicalization,
    'runtime_canonicalization': runtime_canonicalization,
    'master_mesh': master_stats,
    'runtime_mesh': runtime_stats,
    'runtime_boundary_protection': runtime_boundary_protection,
    'runtime_normal_transfer': 'CUSTOM_NORMAL from posed master, POLYINTERP_NEAREST',
    'glb_tangent_repair': {
        'master': master_tangent_repair,
        'runtime': runtime_tangent_repair,
    },
    'runtime_surface_area_relative_delta': (
        runtime_stats['surface_area_m2'] - master_stats['surface_area_m2']
    ) / master_stats['surface_area_m2'],
    'source_glb': source_manifest,
    'master_glb': master_manifest,
    'runtime_glb': runtime_manifest,
    'proxy_stl': stl_manifest,
    'texture_payloads_bit_identical': {
        row['name']: row['sha256'] == next(
            output['sha256'] for output in master_manifest['images'] if output['name'] == row['name']
        ) == next(
            output['sha256'] for output in runtime_manifest['images'] if output['name'] == row['name']
        )
        for row in source_manifest['images']
    },
    'renders': {
        'master_front': str(MASTER_FRONT),
        'master_three_quarter': str(MASTER_THREE_QUARTER),
        'master_back': str(MASTER_BACK),
        'runtime_front': str(RUNTIME_FRONT),
        'runtime_three_quarter': str(RUNTIME_THREE_QUARTER),
        'runtime_back': str(RUNTIME_BACK),
    },
}
REPORT_OUT.write_text(json.dumps(report, indent=2), encoding='utf-8')
print('JERICHO_FINAL_REPORT_BEGIN')
print(json.dumps(report, indent=2))
print('JERICHO_FINAL_REPORT_END')
