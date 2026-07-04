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

const NORMALS_SHADER = /* wgsl */ `
struct GridInfo { n: u32, count: u32, _p0: u32, _p1: u32 };
@group(0) @binding(0) var<uniform> grid: GridInfo;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> normals: array<vec4f>;

// Per-vertex normal from central differences over the grid neighbours.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= grid.count) { return; }
  let n = grid.n;
  let u = i % n;
  let v = i / n;
  let up1 = min(u + 1u, n - 1u);
  let um1 = select(u - 1u, 0u, u == 0u);
  let vp1 = min(v + 1u, n - 1u);
  let vm1 = select(v - 1u, 0u, v == 0u);
  let tu = positions[v * n + up1].xyz - positions[v * n + um1].xyz;
  let tv = positions[vp1 * n + u].xyz - positions[vm1 * n + u].xyz;
  var nor = cross(tv, tu); // +Y for the flat rest pose
  let len = length(nor);
  if (len < 1e-8) { nor = vec3f(0.0, 1.0, 0.0); } else { nor = nor / len; }
  normals[i] = vec4f(nor, 0.0);
}
`;

const CLOTH_SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
};

@vertex
fn vs(@location(0) pos: vec4f, @location(1) nrm: vec4f) -> VSOut {
  var out: VSOut;
  out.clip = camera.viewProj * vec4f(pos.xyz, 1.0);
  out.normal = nrm.xyz;
  return out;
}

@fragment
fn fs(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let L = normalize(vec3f(0.4, 0.9, 0.35));
  // Wrap ("half-lambert") diffuse keeps folds readable in the shadowed side.
  let wrap = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
  let face_col = vec3f(0.87, 0.82, 0.72); // ecru face
  let back_col = vec3f(0.66, 0.55, 0.47); // darker reverse, garment-tool style
  let base = select(back_col, face_col, front);
  let shade = 0.22 + 0.85 * wrap * wrap;
  return vec4f(base * shade, 1.0);
}
`;

const SCENE_SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) color: vec3f) -> VSOut {
  var out: VSOut;
  out.clip = camera.viewProj * vec4f(pos, 1.0);
  out.normal = normal;
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

export class ClothRenderer {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly normalsPipeline: GPUComputePipeline;
  private readonly normalsBindGroup: GPUBindGroup;
  private readonly clothPipeline: GPURenderPipeline;
  private readonly scenePipeline: GPURenderPipeline;
  private readonly clothBindGroup: GPUBindGroup;
  private readonly sceneBindGroup: GPUBindGroup;
  private readonly positionBuffer: GPUBuffer;
  private readonly normalsBuffer: GPUBuffer;
  private readonly gridInfoBuffer: GPUBuffer;
  private readonly cameraBuffer: GPUBuffer;
  private readonly clothIndexBuffer: GPUBuffer;
  private readonly clothIndexCount: number;
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
    triangleIndices: Uint32Array,
    scene: SceneMesh,
  ) {
    this.device = device;
    this.count = count;
    this.positionBuffer = positionBuffer;

    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Failed to acquire WebGPU canvas context');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.cameraBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- Normals compute pass ---
    this.normalsBuffer = device.createBuffer({
      size: count * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.gridInfoBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.gridInfoBuffer, 0, new Uint32Array([resolution, count, 0, 0]));

    const normalsModule = device.createShaderModule({ code: NORMALS_SHADER, label: 'normals' });
    this.normalsPipeline = device.createComputePipeline({
      label: 'normals-pipeline',
      layout: 'auto',
      compute: { module: normalsModule, entryPoint: 'main' },
    });
    this.normalsBindGroup = device.createBindGroup({
      layout: this.normalsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.gridInfoBuffer } },
        { binding: 1, resource: { buffer: positionBuffer } },
        { binding: 2, resource: { buffer: this.normalsBuffer } },
      ],
    });

    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };

    // --- Cloth surface pipeline (two-sided) ---
    const clothModule = device.createShaderModule({ code: CLOTH_SHADER, label: 'cloth' });
    this.clothPipeline = device.createRenderPipeline({
      label: 'cloth-pipeline',
      layout: 'auto',
      vertex: {
        module: clothModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
          { arrayStride: 16, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: { module: clothModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, // fabric is two-sided
      depthStencil,
    });
    this.clothBindGroup = device.createBindGroup({
      layout: this.clothPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.clothIndexBuffer = device.createBuffer({
      size: triangleIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.clothIndexBuffer.getMappedRange()).set(triangleIndices);
    this.clothIndexBuffer.unmap();
    this.clothIndexCount = triangleIndices.length;

    // --- Scene colliders (lit triangles) ---
    const sceneModule = device.createShaderModule({ code: SCENE_SHADER, label: 'scene' });
    this.scenePipeline = device.createRenderPipeline({
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
      fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil,
    });
    this.sceneBindGroup = device.createBindGroup({
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    this.sceneVertexBuffer = device.createBuffer({
      size: scene.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.sceneVertexBuffer.getMappedRange()).set(scene.vertices);
    this.sceneVertexBuffer.unmap();

    this.sceneIndexBuffer = device.createBuffer({
      size: scene.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.sceneIndexBuffer.getMappedRange()).set(scene.indices);
    this.sceneIndexBuffer.unmap();
    this.sceneIndexCount = scene.indices.length;

    this.depthTexture = this.createDepthTexture(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    this.depthTexture.destroy();
    this.depthTexture = this.createDepthTexture(width, height);
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
    pass.drawIndexed(this.sceneIndexCount);

    pass.setPipeline(this.clothPipeline);
    pass.setBindGroup(0, this.clothBindGroup);
    pass.setVertexBuffer(0, this.positionBuffer);
    pass.setVertexBuffer(1, this.normalsBuffer);
    pass.setIndexBuffer(this.clothIndexBuffer, 'uint32');
    pass.drawIndexed(this.clothIndexCount);

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.depthTexture.destroy();
    this.normalsBuffer.destroy();
    this.gridInfoBuffer.destroy();
    this.clothIndexBuffer.destroy();
    this.sceneVertexBuffer.destroy();
    this.sceneIndexBuffer.destroy();
    this.cameraBuffer.destroy();
  }

  private createDepthTexture(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      size: [Math.max(1, width), Math.max(1, height)],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
}
