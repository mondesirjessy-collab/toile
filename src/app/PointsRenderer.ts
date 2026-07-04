/**
 * PointsRenderer — milestone 1 visualization.
 * Pure WebGPU point rendering that reads the engine's position buffer
 * directly (zero CPU copies). Three.js integration arrives in milestone 2
 * when we need lit surfaces and shadows for the cloth mesh.
 */

const SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) height: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let p = positions[vi].xyz;
  var out: VSOut;
  out.clip = camera.viewProj * vec4f(p, 1.0);
  out.height = p.y;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  // Ecru cloth tone, slightly darker near the ground for depth reading.
  let t = clamp(in.height / 3.0, 0.0, 1.0);
  let low = vec3f(0.62, 0.58, 0.50);
  let high = vec3f(0.93, 0.90, 0.83);
  return vec4f(mix(low, high, t), 1.0);
}
`;

export class PointsRenderer {
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuffer: GPUBuffer;
  private readonly count: number;
  private depthTexture: GPUTexture;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    positionBuffer: GPUBuffer,
    count: number,
  ) {
    this.device = device;
    this.count = count;

    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Failed to acquire WebGPU canvas context');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.cameraBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ code: SHADER, label: 'points' });
    this.pipeline = device.createRenderPipeline({
      label: 'points-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'point-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: positionBuffer } },
      ],
    });

    this.depthTexture = this.createDepthTexture(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    this.depthTexture.destroy();
    this.depthTexture = this.createDepthTexture(width, height);
  }

  render(viewProj: Float32Array): void {
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
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(this.count);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private createDepthTexture(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      size: [Math.max(1, width), Math.max(1, height)],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
}
