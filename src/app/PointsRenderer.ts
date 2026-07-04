/**
 * PointsRenderer — milestone 5-6 visualization.
 * Two pipelines sharing one camera uniform + depth buffer, drawn in a single
 * render pass:
 *   - a lit triangle pass for the static scene colliders (sphere + ground),
 *     so the drape is readable against what it lands on
 *   - the cloth point pass, reading the engine's live position buffer directly
 *     (zero CPU copies)
 * Three.js integration (lit cloth surface + shadows) is still deferred; points
 * are enough to validate the solver.
 */
import { SCENE_VERTEX_FLOATS, type SceneMesh } from './SceneGeometry';

const CLOTH_SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) height: f32,
};

// Positions come in as a plain vertex buffer (the solver's position buffer,
// vec4 per particle) rather than a storage buffer read in the vertex stage —
// the latter isn't portable (Safari/Metal may expose 0 vertex-stage storage
// buffers by default).
@vertex
fn vs(@location(0) pos: vec4f) -> VSOut {
  let p = pos.xyz;
  var out: VSOut;
  out.clip = camera.viewProj * vec4f(p, 1.0);
  out.height = p.y;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  // Ecru cloth tone, slightly darker lower down for depth reading.
  let t = clamp(in.height / 2.0, 0.0, 1.0);
  let low = vec3f(0.62, 0.58, 0.50);
  let high = vec3f(0.95, 0.92, 0.85);
  return vec4f(mix(low, high, t), 1.0);
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
  let shade = 0.25 + 0.75 * diff; // ambient + directional
  return vec4f(in.color * shade, 1.0);
}
`;

export class PointsRenderer {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly clothPipeline: GPURenderPipeline;
  private readonly scenePipeline: GPURenderPipeline;
  private readonly clothBindGroup: GPUBindGroup;
  private readonly sceneBindGroup: GPUBindGroup;
  private readonly positionBuffer: GPUBuffer;
  private readonly cameraBuffer: GPUBuffer;
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

    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };

    // Cloth points — positions fed as a vertex buffer (vec4 stride 16).
    const clothModule = device.createShaderModule({ code: CLOTH_SHADER, label: 'cloth' });
    this.clothPipeline = device.createRenderPipeline({
      label: 'cloth-pipeline',
      layout: 'auto',
      vertex: {
        module: clothModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 16,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
          },
        ],
      },
      fragment: { module: clothModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'point-list' },
      depthStencil,
    });
    this.clothBindGroup = device.createBindGroup({
      layout: this.clothPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    // Scene colliders (lit triangles).
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

  render(viewProj: Float32Array, ts?: { querySet: GPUQuerySet; beginIndex: number; endIndex: number }): void {
    this.device.queue.writeBuffer(this.cameraBuffer, 0, viewProj.buffer, viewProj.byteOffset, 64);

    const encoder = this.device.createCommandEncoder({ label: 'render-frame' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.055, g: 0.06, b: 0.07, a: 1 },
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
        ? {
            timestampWrites: {
              querySet: ts.querySet,
              beginningOfPassWriteIndex: ts.beginIndex,
              endOfPassWriteIndex: ts.endIndex,
            },
          }
        : {}),
    });

    // Scene colliders first, then cloth points (shared depth buffer).
    pass.setPipeline(this.scenePipeline);
    pass.setBindGroup(0, this.sceneBindGroup);
    pass.setVertexBuffer(0, this.sceneVertexBuffer);
    pass.setIndexBuffer(this.sceneIndexBuffer, 'uint32');
    pass.drawIndexed(this.sceneIndexCount);

    pass.setPipeline(this.clothPipeline);
    pass.setBindGroup(0, this.clothBindGroup);
    pass.setVertexBuffer(0, this.positionBuffer);
    pass.draw(this.count);

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  dispose(): void {
    this.depthTexture.destroy();
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
