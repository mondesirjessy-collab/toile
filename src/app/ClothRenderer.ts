/**
 * ClothRenderer — CLO3D-style surface visualization.
 * The cloth is drawn as a lit triangle mesh (not points): a small compute pass
 * derives per-vertex normals from the live position buffer each frame, then a
 * two-sided fabric shader renders the sheet — ecru on the face, a darker weft
 * tone on the reverse, the way garment tools distinguish fabric sides.
 * Scene colliders (sphere + ground) share the camera and depth buffer.
 *
 * The engine stays renderer-agnostic: this reads the solver's position buffer
 * directly (zero CPU copies) and owns everything visual.
 */
import { SCENE_VERTEX_FLOATS, type SceneMesh } from './SceneGeometry';
import { SceneResourceRegistry } from '../engine/gpu/SceneResourceRegistry';

const NORMALS_SHADER = /* wgsl */ `
struct GridInfo { n: u32, count: u32, spacing: f32, spacing_v: f32 };
@group(0) @binding(0) var<uniform> grid: GridInfo;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> normals: array<vec4f>;

// A neighbour much farther than the fabric spacing is not real cloth — it is a
// particle cut from the pattern and parked out of the scene. Fall back to the
// centre so shaped edges get one-sided differences instead of garbage normals.
fn valid(nb: vec3f, x: vec3f, limit: f32) -> vec3f {
  return select(x, nb, distance(nb, x) < limit);
}

// Per-vertex normal from central differences over the grid neighbours.
// Supports multiple stacked n×n panels (seamed garments): neighbour lookups
// stay inside the particle's own panel.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= grid.count) { return; }
  let n = grid.n;
  let panel_size = n * n;
  let base = (i / panel_size) * panel_size;
  let local = i - base;
  let u = local % n;
  let v = local / n;
  let up1 = min(u + 1u, n - 1u);
  let um1 = select(u - 1u, 0u, u == 0u);
  let vp1 = min(v + 1u, n - 1u);
  let vm1 = select(v - 1u, 0u, v == 0u);
  let x = positions[i].xyz;
  let limit = max(grid.spacing, grid.spacing_v) * 4.0;
  let tu = valid(positions[base + v * n + up1].xyz, x, limit)
         - valid(positions[base + v * n + um1].xyz, x, limit);
  let tv = valid(positions[base + vp1 * n + u].xyz, x, limit)
         - valid(positions[base + vm1 * n + u].xyz, x, limit);
  var nor = cross(tv, tu); // +Y for the flat rest pose
  let len = length(nor);
  if (len < 1e-8) { nor = vec3f(0.0, 1.0, 0.0); } else { nor = nor / len; }
  // Strain: mean structural-neighbour elongation vs the rest length OF THE
  // MATCHING AXIS (garment grids are anisotropic — one shared divisor would
  // bake ±(height/width − 1) of fake strain into every non-square pattern).
  // Smuggled in the normal's free w component for the fit map.
  var sum = 0.0;
  var cnt = 0.0;
  let nb1 = positions[base + v * n + up1].xyz;
  let nb2 = positions[base + v * n + um1].xyz;
  let nb3 = positions[base + vp1 * n + u].xyz;
  let nb4 = positions[base + vm1 * n + u].xyz;
  let d1 = distance(nb1, x); if (d1 > 1e-6 && d1 < limit) { sum += d1 / grid.spacing; cnt += 1.0; }
  let d2 = distance(nb2, x); if (d2 > 1e-6 && d2 < limit) { sum += d2 / grid.spacing; cnt += 1.0; }
  let d3 = distance(nb3, x); if (d3 > 1e-6 && d3 < limit) { sum += d3 / grid.spacing_v; cnt += 1.0; }
  let d4 = distance(nb4, x); if (d4 > 1e-6 && d4 < limit) { sum += d4 / grid.spacing_v; cnt += 1.0; }
  var strain = 0.0;
  if (cnt > 0.0) { strain = sum / cnt - 1.0; }
  normals[i] = vec4f(nor, strain);
}
`;

const CLOTH_SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
// Per-fabric look: face rgb + shading exponent, back rgb + ambient floor,
// plus the PRINT: motif.x = type (0 uni, 1 rayures, 2 vichy, 3 pois),
// motif.y = repeat size in METERS (the pattern is scaled in real cm),
// motif.z = grid resolution n, motif.w = particle spacing (m).
// options: x = fit map on/off, y = vertical rest spacing, z = visual layer
// count (an outfit tints its UNDER layer darker so the layers read apart).
struct Fabric {
  face: vec4f,
  back: vec4f,
  motif: vec4f,
  motifColor: vec4f,
  options: vec4f,
  grain2: vec4f, // xy = garment-1 spacing, z = live collision thickness
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> fabric: Fabric;
@group(0) @binding(2) var<uniform> spin: vec4f;
@group(0) @binding(3) var<storage, read> ribbonPositions: array<vec4f>;
@group(0) @binding(4) var<storage, read> ribbonIndices: array<u32>;
@group(0) @binding(5) var<storage, read> ribbonMaterials: array<u32>;
@group(0) @binding(6) var<storage, read> ribbonNormals: array<vec4f>;
@group(0) @binding(7) var<storage, read> ribbonWeights: array<f32>;

fn turn_cloth(v: vec3f) -> vec3f {
  return vec3f(spin.x * v.x - spin.y * v.z, v.y, spin.y * v.x + spin.x * v.z);
}

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f, // rest-cloth coordinates in METERS
  @location(2) strain: f32,
  @location(3) @interpolate(flat) garment: u32,
  @location(4) @interpolate(flat) material: u32,
  @location(5) ribbonNormal: vec3f,
};

fn cloth_vertex(vid: u32, pos: vec4f, nrm: vec4f, material: u32) -> VSOut {
  var out: VSOut;
  let worldPosition = turn_cloth(pos.xyz);
  let worldNormal = turn_cloth(nrm.xyz);
  out.clip = camera.viewProj * vec4f(worldPosition, 1.0);
  out.normal = worldNormal;
  // A cap interpolates normals from two independently parameterised panels.
  // Put every endpoint in one deterministic light hemisphere BEFORE
  // interpolation and add a small common bias. Opposite front/back normals can
  // then no longer cancel on alternating cap diagonals (the dark zipper).
  let ribbonLight = normalize(vec3f(0.4, 0.9, 0.35));
  var capNormal = worldNormal;
  if (dot(capNormal, capNormal) < 1e-8) { capNormal = ribbonLight; }
  else { capNormal = normalize(capNormal); }
  if (dot(capNormal, ribbonLight) < 0.0) { capNormal = -capNormal; }
  out.ribbonNormal = normalize(capNormal + ribbonLight * 0.12);
  // The particle index IS the grid address: uv in meters of flat cloth,
  // each axis scaled by ITS rest length (options.y = vertical spacing) so a
  // gingham stays square on a non-square pattern grid.
  let n = u32(fabric.motif.z);
  let panelSize = n * n;
  let local = vid % panelSize;
  // Panels pair front/back into garments; a triangle never spans a panel, so
  // this flat index tells the outfit's under piece from its outer one.
  out.garment = (vid / panelSize) / 2u;
  // Each garment uses ITS OWN rest spacing, so a 5 cm check reads 5 cm on both
  // the tee and the skirt of an outfit, not just the coarser one.
  let sp = select(vec2f(fabric.motif.w, fabric.options.y), fabric.grain2.xy, out.garment >= 1u);
  out.uv = vec2f(f32(local % n) * sp.x, f32(local / n) * sp.y);
  out.strain = nrm.w;
  out.material = material;
  return out;
}

@vertex
fn vs(
  @builtin(vertex_index) vid: u32,
  @location(0) pos: vec4f,
  @location(1) nrm: vec4f,
  @location(2) material: u32,
) -> VSOut {
  return cloth_vertex(vid, pos, nrm, material);
}

// Fit map: blue (slack) → green (easy) → yellow (snug) → red (tight).
fn heatmap(strain: f32) -> vec3f {
  let t = clamp(strain / 0.10, 0.0, 1.0); // 10 % elongation = full red
  if (t < 0.33) { return mix(vec3f(0.2, 0.4, 0.9), vec3f(0.2, 0.85, 0.4), t / 0.33); }
  if (t < 0.66) { return mix(vec3f(0.2, 0.85, 0.4), vec3f(0.95, 0.85, 0.2), (t - 0.33) / 0.33); }
  return mix(vec3f(0.95, 0.85, 0.2), vec3f(0.9, 0.15, 0.1), (t - 0.66) / 0.34);
}

fn motif_mask(uv: vec2f) -> f32 {
  let kind = u32(fabric.motif.x);
  let s = max(fabric.motif.y, 0.002);
  if (kind == 1u) { // rayures
    return step(0.5, fract(uv.x / s));
  }
  if (kind == 2u) { // vichy: deux trames semi-transparentes qui se croisent
    let a = step(0.5, fract(uv.x / s));
    let b = step(0.5, fract(uv.y / s));
    return 0.55 * (a + b) - 0.35 * a * b;
  }
  if (kind == 3u) { // pois en quinconce
    let cell = uv / s;
    let row = floor(cell.y);
    let f = vec2f(fract(cell.x + 0.5 * (row % 2.0)), fract(cell.y)) - vec2f(0.5);
    return 1.0 - step(0.3, length(f));
  }
  return 0.0;
}

struct MaterialLook {
  face: vec3f,
  back: vec3f,
  exponent: f32,
  ambient: f32,
};

// Stable ids: 1 Jersey, 2 Maille, 3 Popeline, 4 Denim, 5 Lin, 6 Laine, 7 Soie.
fn material_look(id: u32) -> MaterialLook {
  var look = MaterialLook(vec3f(0.87, 0.82, 0.72), vec3f(0.66, 0.55, 0.47), 2.0, 0.22);
  if (id == 2u) { look = MaterialLook(vec3f(0.72, 0.45, 0.42), vec3f(0.55, 0.33, 0.31), 1.8, 0.24); }
  else if (id == 3u) { look = MaterialLook(vec3f(0.93, 0.93, 0.90), vec3f(0.82, 0.82, 0.78), 2.4, 0.20); }
  else if (id == 4u) { look = MaterialLook(vec3f(0.23, 0.29, 0.45), vec3f(0.52, 0.58, 0.70), 1.4, 0.30); }
  else if (id == 5u) { look = MaterialLook(vec3f(0.85, 0.80, 0.68), vec3f(0.74, 0.69, 0.57), 1.6, 0.26); }
  else if (id == 6u) { look = MaterialLook(vec3f(0.52, 0.50, 0.52), vec3f(0.40, 0.38, 0.40), 1.5, 0.28); }
  else if (id == 7u) { look = MaterialLook(vec3f(0.93, 0.87, 0.78), vec3f(0.80, 0.68, 0.58), 3.5, 0.12); }
  return look;
}

fn material_thickness(id: u32) -> f32 {
  var thickness = max(fabric.grain2.z, 0.002);
  if (id == 1u) { thickness = 0.005; }
  else if (id == 2u) { thickness = 0.006; }
  else if (id == 3u) { thickness = 0.0035; }
  else if (id == 4u) { thickness = 0.007; }
  else if (id == 5u) { thickness = 0.004; }
  else if (id == 6u) { thickness = 0.008; }
  else if (id == 7u) { thickness = 0.0025; }
  return thickness;
}

// Particle collision keeps the cap VERTICES outside the avatar, but the flat
// chord between them can still cut through a curved shoulder. Expand the
// duplicated one-ring seam shell by one material thickness (max 5 mm); weights
// taper its mono-panel neighbour back to the unmodified safety mesh. Topology
// and open eyelets are never filled or discarded. Direction AND magnitude are
// per particle: every occurrence of a shared vertex gets a bit-identical
// position, so adjacent overlay triangles cannot open rendering cracks.
@vertex
fn vsRibbon(@builtin(vertex_index) drawVertex: u32) -> VSOut {
  let particle = ribbonIndices[drawVertex];
  var out = cloth_vertex(
    particle,
    ribbonPositions[particle],
    ribbonNormals[particle],
    ribbonMaterials[particle]
  );
  let visualOffset =
    min(material_thickness(ribbonMaterials[particle]), 0.005) *
    ribbonWeights[drawVertex];
  let worldPosition = turn_cloth(ribbonPositions[particle].xyz);
  out.clip = camera.viewProj * vec4f(
    worldPosition + out.ribbonNormal * visualOffset,
    1.0
  );
  return out;
}

fn shade_fabric(in: VSOut, n: vec3f, visualFront: bool, minimumShade: f32) -> vec4f {
  let L = normalize(vec3f(0.4, 0.9, 0.35));
  // Wrap ("half-lambert") diffuse keeps folds readable in the shadowed side.
  let wrap = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
  var base = select(fabric.back.rgb, fabric.face.rgb, visualFront);
  var exponent = fabric.face.a;
  var ambient = fabric.back.a;
  if (in.material > 0u) {
    let look = material_look(in.material);
    base = select(look.back, look.face, visualFront);
    exponent = look.exponent;
    ambient = look.ambient;
    // A fine weave cue keeps small appliqués readable without faking a print.
    let weave = 0.025 * sin(in.uv.x * 900.0) * sin(in.uv.y * 900.0);
    base *= 1.0 + weave;
  } else if (visualFront) {
    base = mix(base, fabric.motifColor.rgb, motif_mask(in.uv) * fabric.motifColor.a);
  }
  // Outfit (2+ garments): the under piece (garment 0 — the tee, the bodice)
  // reads in a deeper shade so its collar and sleeves peek apart from the
  // outer garment instead of melting into one beige mass.
  if (fabric.options.z > 1.5 && in.garment == 0u) { base *= 0.68; }
  if (fabric.options.x > 0.5) { base = heatmap(max(in.strain, 0.0)); }
  let shade = max(minimumShade, ambient + (1.0 - ambient) * pow(wrap, exponent));
  return vec4f(base * shade, 1.0);
}

@fragment
fn fs(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  return shade_fabric(in, n, front, 0.0);
}

@fragment
fn fsRibbon(in: VSOut) -> @location(0) vec4f {
  var n = in.ribbonNormal;
  if (dot(n, n) < 1e-8) { n = normalize(vec3f(0.4, 0.9, 0.35)); }
  else { n = normalize(n); }
  // A closed seam allowance is narrower than one cloth cell. The shared,
  // continuously interpolated normal keeps it readable without revealing the
  // internal cap triangulation.
  return shade_fabric(in, n, true, 0.45);
}
`;

const SCENE_SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;
// Podium turn: x = cos, y = sin (identity when 1,0). Applied per draw range.
@group(0) @binding(1) var<uniform> spin: vec4f;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
};

fn turn(v: vec3f) -> vec3f {
  return vec3f(spin.x * v.x - spin.y * v.z, v.y, spin.y * v.x + spin.x * v.z);
}

@vertex
fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) color: vec3f) -> VSOut {
  var out: VSOut;
  out.clip = camera.viewProj * vec4f(turn(pos), 1.0);
  out.normal = turn(normal);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let L = normalize(vec3f(0.4, 0.9, 0.35));
  let diff = max(dot(normalize(in.normal), L), 0.0);
  let shade = 0.3 + 0.7 * diff;
  return vec4f(in.color * shade, 1.0);
}
`;

interface TimestampSpan {
  querySet: GPUQuerySet;
  beginIndex: number;
  endIndex: number;
}

/** Visual identity of a fabric preset (colors + shading response). */
export interface FabricStyle {
  face: [number, number, number];
  back: [number, number, number];
  /** Shading exponent: high = sheen (silk), low = matte weave (denim). */
  exponent: number;
  /** Ambient floor [0,1]: how bright the shadowed side stays. */
  ambient: number;
  /** Print: 0 uni, 1 rayures, 2 vichy, 3 pois. */
  motif?: number;
  /** Print repeat, in METERS (the UI speaks cm). */
  motifScale?: number;
  /** Print color; alpha = opacity of the print over the base. */
  motifColor?: [number, number, number, number];
}

export const DEFAULT_FABRIC: FabricStyle = {
  face: [0.87, 0.82, 0.72], // ecru jersey
  back: [0.66, 0.55, 0.47],
  exponent: 2.0,
  ambient: 0.22,
};

export function clampCollisionThickness(value: number): number {
  return Number.isFinite(value) ? Math.max(0.002, Math.min(0.02, value)) : 0.005;
}

/** One-ring seam shell lift, tapered by the parallel per-vertex weight. */
export function ribbonVisualOffset(collisionThickness: number, weight = 1): number {
  return (
    Math.min(clampCollisionThickness(collisionThickness), 0.005) *
    Math.max(0, Math.min(1, weight))
  );
}

/**
 * Number of real dressing layers carried by the solver mesh.
 *
 * A garment may contain several independently generated two-panel pieces
 * (body, sleeves, collar) while every particle still belongs to layer 0. The
 * renderer must therefore derive layering from the explicit particle field,
 * never from the number of n×n panel pairs in the combined mesh.
 */
export function countVisualLayers(layers?: ArrayLike<number>): number {
  let maxLayer = 0;
  if (layers) {
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index]!;
      if (Number.isFinite(layer) && layer > maxLayer) {
        maxLayer = Math.floor(layer);
      }
    }
  }
  return maxLayer + 1;
}

export interface ClothTrianglePartition {
  readonly surface: Uint32Array;
  readonly ribbons: Uint32Array;
  readonly ribbonWeights: Float32Array;
}

/**
 * Keep a complete safety surface and identify the narrow sewn band.
 *
 * Every original triangle stays in `surface`, so a secondary seam pass can
 * never punch skin-visible holes into the garment. `ribbons` duplicates each
 * mixed-panel cap plus its complete mono-panel vertex star. Per-vertex weights
 * keep cap vertices at 1 and every outer vertex at 0, so whole boundary cells
 * taper into the untouched surface without a hard step or half-cell sawtooth.
 */
export function partitionClothTriangles(
  triangleIndices: ArrayLike<number>,
  resolution: number,
): ClothTrianglePartition {
  const panelSize = resolution * resolution;
  const surface: number[] = [];
  const ribbons: number[] = [];
  const ribbonWeights: number[] = [];
  const triangles: Array<{
    indices: readonly [number, number, number];
    mixed: boolean;
  }> = [];
  const capVertices = new Set<number>();
  for (let offset = 0; offset + 2 < triangleIndices.length; offset += 3) {
    const a = triangleIndices[offset]!;
    const b = triangleIndices[offset + 1]!;
    const c = triangleIndices[offset + 2]!;
    surface.push(a, b, c);
    const panel = Math.floor(a / panelSize);
    const mixed =
      Math.floor(b / panelSize) !== panel || Math.floor(c / panelSize) !== panel;
    const indices = [a, b, c] as const;
    triangles.push({ indices, mixed });
    if (!mixed) continue;
    ribbons.push(a, b, c);
    ribbonWeights.push(1, 1, 1);
    capVertices.add(a);
    capVertices.add(b);
    capVertices.add(c);
  }
  for (const triangle of triangles) {
    if (triangle.mixed) continue;
    const [a, b, c] = triangle.indices;
    if (!capVertices.has(a) && !capVertices.has(b) && !capVertices.has(c)) continue;
    ribbons.push(a, b, c);
    ribbonWeights.push(
      capVertices.has(a) ? 1 : 0,
      capVertices.has(b) ? 1 : 0,
      capVertices.has(c) ? 1 : 0,
    );
  }
  return {
    surface: Uint32Array.from(surface),
    ribbons: Uint32Array.from(ribbons),
    ribbonWeights: Float32Array.from(ribbonWeights),
  };
}

/**
 * Render/normals pipelines are pure functions of their (constant) WGSL and the
 * canvas format — nothing per-instance — but a new ClothRenderer is built on
 * every scene switch. Compiling the three shaders each time cost the other
 * half of the ~1 s rebuild freeze. Compile once per device and reuse; bind
 * groups and vertex/index buffers stay per-instance.
 */
interface RendererPipelines {
  normals: GPUComputePipeline;
  cloth: GPURenderPipeline;
  clothRibbon: GPURenderPipeline;
  scene: GPURenderPipeline;
}
const rendererPipelineCache = new WeakMap<GPUDevice, RendererPipelines>();
function rendererPipelines(device: GPUDevice, format: GPUTextureFormat): RendererPipelines {
  const cached = rendererPipelineCache.get(device);
  if (cached) return cached;
  const depthStencil: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
  const normals = device.createComputePipeline({
    label: 'normals-pipeline',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: NORMALS_SHADER, label: 'normals' }), entryPoint: 'main' },
  });
  const clothModule = device.createShaderModule({ code: CLOTH_SHADER, label: 'cloth' });
  const cloth = device.createRenderPipeline({
    label: 'cloth-pipeline',
    layout: 'auto',
    vertex: {
      module: clothModule,
      entryPoint: 'vs',
      buffers: [
        { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'uint32' }] },
      ],
    },
    fragment: { module: clothModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' }, // fabric is two-sided
    depthStencil,
  });
  const clothRibbon = device.createRenderPipeline({
    label: 'cloth-ribbon-pipeline',
    layout: 'auto',
    vertex: {
      module: clothModule,
      entryPoint: 'vsRibbon',
      buffers: [],
    },
    fragment: { module: clothModule, entryPoint: 'fsRibbon', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    // The complete safety surface is drawn first. Equal/closer depth lets the
    // half-thickness cap replace its ordinary shading, while disabling writes
    // leaves the established garment depth untouched.
    depthStencil: {
      format: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'less-equal',
    },
  });
  const sceneModule = device.createShaderModule({ code: SCENE_SHADER, label: 'scene' });
  const scene = device.createRenderPipeline({
    label: 'scene-pipeline',
    layout: 'auto',
    vertex: {
      module: sceneModule,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: SCENE_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
            { shaderLocation: 2, offset: 24, format: 'float32x3' }, // color
          ],
        },
      ],
    },
    fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil,
  });
  const pipelines: RendererPipelines = { normals, cloth, clothRibbon, scene };
  rendererPipelineCache.set(device, pipelines);
  return pipelines;
}

export class ClothRenderer {
  private readonly device: GPUDevice;
  private readonly resources = new SceneResourceRegistry();
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly normalsPipeline: GPUComputePipeline;
  private readonly normalsBindGroup: GPUBindGroup;
  private readonly clothPipeline: GPURenderPipeline;
  private readonly clothRibbonPipeline: GPURenderPipeline;
  private readonly clothRibbonBindGroup: GPUBindGroup;
  private readonly scenePipeline: GPURenderPipeline;
  private spinBuffer!: GPUBuffer;
  private spinIdentityBuffer!: GPUBuffer;
  private sceneStaticBindGroup!: GPUBindGroup;
  private sceneBodyIndexCount = 0;
  private readonly clothBindGroup: GPUBindGroup;
  private readonly sceneBindGroup: GPUBindGroup;
  private readonly positionBuffer: GPUBuffer;
  private readonly normalsBuffer: GPUBuffer;
  private readonly gridInfoBuffer: GPUBuffer;
  private readonly cameraBuffer: GPUBuffer;
  private readonly fabricBuffer: GPUBuffer;
  private readonly materialIdBuffer: GPUBuffer;
  private readonly clothResolution: number;
  private collisionThickness: number;
  private fitMap = false;
  private lastStyle: FabricStyle | null = null;
  private readonly clothSpacing: number;
  private readonly clothSpacingV: number;
  private readonly clothSpacing2: number;
  private readonly clothSpacingV2: number;
  private readonly visualLayerCount: number;
  private readonly clothIndexBuffer: GPUBuffer;
  private readonly clothIndexCount: number;
  private readonly clothRibbonTriangleBuffer: GPUBuffer;
  private readonly clothRibbonWeightBuffer: GPUBuffer;
  private readonly clothRibbonIndexCount: number;
  private readonly sceneVertexBuffer: GPUBuffer;
  private readonly sceneIndexBuffer: GPUBuffer;
  private readonly sceneIndexCount: number;
  private readonly count: number;
  private depthTexture: GPUTexture;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    positionBuffer: GPUBuffer,
    count: number,
    resolution: number,
    spacing: number,
    spacingV: number,
    triangleIndices: Uint32Array,
    scene: SceneMesh,
    spacing2 = spacing,
    spacingV2 = spacingV,
    materialIds: Uint32Array = new Uint32Array(count),
    layers?: ArrayLike<number>,
    collisionThickness = 0.005,
  ) {
    this.device = device;
    const createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer =>
      this.resources.trackBuffer(device.createBuffer(descriptor));
    this.count = count;
    this.clothResolution = resolution;
    this.clothSpacing = spacing;
    this.clothSpacingV = spacingV;
    this.clothSpacing2 = spacing2;
    this.clothSpacingV2 = spacingV2;
    this.collisionThickness = clampCollisionThickness(collisionThickness);
    this.visualLayerCount = countVisualLayers(layers);
    this.positionBuffer = positionBuffer;

    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Failed to acquire WebGPU canvas context');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.cameraBuffer = createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.fabricBuffer = createBuffer({
      size: 96, // Fabric: 6 × vec4f (look + print + options + garment-1 spacing)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.setFabric(DEFAULT_FABRIC);
    this.materialIdBuffer = createBuffer({
      size: Math.max(4, materialIds.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.materialIdBuffer.getMappedRange()).set(materialIds);
    this.materialIdBuffer.unmap();
    // One presentation transform shared by the visual body and every cloth
    // pass. The solver remains in the mannequin's local frame, so a podium
    // turn cannot make the collider travel through a stationary garment.
    this.spinBuffer = createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.spinBuffer, 0, new Float32Array([1, 0, 0, 0]));

    // --- Normals compute pass ---
    this.normalsBuffer = createBuffer({
      size: count * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.gridInfoBuffer = createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const gridInfo = new ArrayBuffer(16);
    const gi = new DataView(gridInfo);
    gi.setUint32(0, resolution, true);
    gi.setUint32(4, count, true);
    gi.setFloat32(8, spacing, true);
    gi.setFloat32(12, spacingV, true);
    device.queue.writeBuffer(this.gridInfoBuffer, 0, gridInfo);

    // Pipelines compiled once per device, reused across every rebuild.
    const rp = rendererPipelines(device, this.format);
    this.normalsPipeline = rp.normals;
    this.normalsBindGroup = device.createBindGroup({
      layout: this.normalsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.gridInfoBuffer } },
        { binding: 1, resource: { buffer: positionBuffer } },
        { binding: 2, resource: { buffer: this.normalsBuffer } },
      ],
    });

    // --- Cloth surface pipeline (two-sided) ---
    this.clothPipeline = rp.cloth;
    this.clothRibbonPipeline = rp.clothRibbon;
    this.clothBindGroup = device.createBindGroup({
      layout: this.clothPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.fabricBuffer } },
        { binding: 2, resource: { buffer: this.spinBuffer } },
      ],
    });
    const partition = partitionClothTriangles(triangleIndices, resolution);
    this.clothIndexBuffer = createBuffer({
      size: Math.max(4, partition.surface.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.clothIndexBuffer.getMappedRange()).set(partition.surface);
    this.clothIndexBuffer.unmap();
    this.clothIndexCount = partition.surface.length;
    this.clothRibbonTriangleBuffer = createBuffer({
      size: Math.max(4, partition.ribbons.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.clothRibbonTriangleBuffer.getMappedRange()).set(
      partition.ribbons,
    );
    this.clothRibbonTriangleBuffer.unmap();
    this.clothRibbonWeightBuffer = createBuffer({
      size: Math.max(4, partition.ribbonWeights.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.clothRibbonWeightBuffer.getMappedRange()).set(
      partition.ribbonWeights,
    );
    this.clothRibbonWeightBuffer.unmap();
    this.clothRibbonIndexCount = partition.ribbons.length;
    this.clothRibbonBindGroup = device.createBindGroup({
      layout: this.clothRibbonPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.fabricBuffer } },
        { binding: 2, resource: { buffer: this.spinBuffer } },
        { binding: 3, resource: { buffer: this.positionBuffer } },
        { binding: 4, resource: { buffer: this.clothRibbonTriangleBuffer } },
        { binding: 5, resource: { buffer: this.materialIdBuffer } },
        { binding: 6, resource: { buffer: this.normalsBuffer } },
        { binding: 7, resource: { buffer: this.clothRibbonWeightBuffer } },
      ],
    });

    // --- Scene colliders (lit triangles) ---
    this.scenePipeline = rp.scene;
    this.spinIdentityBuffer = createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.spinIdentityBuffer, 0, new Float32Array([1, 0, 0, 0]));
    this.sceneBindGroup = device.createBindGroup({
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.spinBuffer } },
      ],
    });
    this.sceneStaticBindGroup = device.createBindGroup({
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.spinIdentityBuffer } },
      ],
    });

    this.sceneVertexBuffer = createBuffer({
      size: scene.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.sceneVertexBuffer.getMappedRange()).set(scene.vertices);
    this.sceneVertexBuffer.unmap();

    this.sceneIndexBuffer = createBuffer({
      size: scene.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.sceneIndexBuffer.getMappedRange()).set(scene.indices);
    this.sceneIndexBuffer.unmap();
    this.sceneIndexCount = scene.indices.length;
    this.sceneBodyIndexCount = scene.bodyIndexCount;

    this.depthTexture = this.createDepthTexture(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    this.resources.release(this.depthTexture);
    this.depthTexture = this.createDepthTexture(width, height);
  }

  /** Apply a fabric preset's visual identity (live, no rebuild). */
  /** Podium angle (radians) — rotates the mannequin's visual mesh. */
  setSpin(angle: number): void {
    this.device.queue.writeBuffer(this.spinBuffer, 0, new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]));
  }

  /** Live update of the body's interleaved vertices (skinned animation). */
  updateBodyVertices(data: Float32Array): void {
    this.device.queue.writeBuffer(this.sceneVertexBuffer, 0, data as unknown as BufferSource);
  }

  setFabric(style: FabricStyle): void {
    const mc = style.motifColor ?? [1, 1, 1, 0.85];
    this.device.queue.writeBuffer(
      this.fabricBuffer,
      0,
      new Float32Array([
        style.face[0],
        style.face[1],
        style.face[2],
        style.exponent,
        style.back[0],
        style.back[1],
        style.back[2],
        style.ambient,
        style.motif ?? 0,
        style.motifScale ?? 0.05,
        this.clothResolution,
        this.clothSpacing,
        mc[0],
        mc[1],
        mc[2],
        mc[3],
        this.fitMap ? 1 : 0,
        this.clothSpacingV, // options.y: vertical rest length for the print UVs
        // options.z: REAL dressing-layer count. A multi-piece tee can own four
        // panel pairs and still remain one uniformly coloured layer.
        this.visualLayerCount,
        0,
        // grain2 (6th vec4f): the SECOND garment's spacing, so an outfit's
        // print stays true to cm on the piece worn under it too.
        this.clothSpacing2,
        this.clothSpacingV2,
        this.collisionThickness,
        0,
      ]),
    );
    this.lastStyle = style;
  }

  /** Keep the visual seam-closure threshold aligned with live physics. */
  setCollisionThickness(thickness: number): void {
    const next = clampCollisionThickness(thickness);
    if (next === this.collisionThickness) return;
    this.collisionThickness = next;
    if (this.lastStyle) this.setFabric(this.lastStyle);
  }

  /** Fit map: color the cloth by strain instead of fabric. */
  setFitMap(on: boolean): void {
    this.fitMap = on;
    if (this.lastStyle) this.setFabric(this.lastStyle);
  }

  render(viewProj: Float32Array, ts?: TimestampSpan): void {
    this.device.queue.writeBuffer(this.cameraBuffer, 0, viewProj.buffer, viewProj.byteOffset, 64);

    const encoder = this.device.createCommandEncoder({ label: 'render-frame' });

    // 1. Refresh per-vertex normals from the live positions.
    const normalsPass = encoder.beginComputePass(
      ts
        ? { timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.beginIndex } }
        : undefined,
    );
    normalsPass.setPipeline(this.normalsPipeline);
    normalsPass.setBindGroup(0, this.normalsBindGroup);
    normalsPass.dispatchWorkgroups(Math.ceil(this.count / 256));
    normalsPass.end();

    // 2. Scene + cloth surface, shared depth buffer.
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.075, g: 0.08, b: 0.095, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
      ...(ts
        ? { timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.endIndex } }
        : {}),
    });

    pass.setPipeline(this.scenePipeline);
    pass.setBindGroup(0, this.sceneBindGroup);
    pass.setVertexBuffer(0, this.sceneVertexBuffer);
    pass.setIndexBuffer(this.sceneIndexBuffer, 'uint32');
    // Body first (podium spin), then the static remainder (ground, props).
    if (this.sceneBodyIndexCount > 0) pass.drawIndexed(this.sceneBodyIndexCount);
    if (this.sceneIndexCount > this.sceneBodyIndexCount) {
      pass.setBindGroup(0, this.sceneStaticBindGroup);
      pass.drawIndexed(this.sceneIndexCount - this.sceneBodyIndexCount, 1, this.sceneBodyIndexCount);
    }

    pass.setPipeline(this.clothPipeline);
    pass.setBindGroup(0, this.clothBindGroup);
    pass.setVertexBuffer(0, this.positionBuffer);
    pass.setVertexBuffer(1, this.normalsBuffer);
    pass.setVertexBuffer(2, this.materialIdBuffer);
    pass.setIndexBuffer(this.clothIndexBuffer, 'uint32');
    pass.drawIndexed(this.clothIndexCount);
    if (this.clothRibbonIndexCount > 0) {
      pass.setPipeline(this.clothRibbonPipeline);
      pass.setBindGroup(0, this.clothRibbonBindGroup);
      pass.draw(this.clothRibbonIndexCount);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.resources.dispose();
  }

  get ownedResourceCount(): number {
    return this.resources.count;
  }

  private createDepthTexture(width: number, height: number): GPUTexture {
    return this.resources.trackTexture(this.device.createTexture({
      size: [Math.max(1, width), Math.max(1, height)],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    }));
  }
}
