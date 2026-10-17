// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// "Buzlu cam": the picture behind the caption, blurred, under a rounded
// panel. Dual Kawase blur (Bjørge, 2015): the frame is halved a few times
// and grown back with 5 and 8 bilinear taps per pass, which reaches a wide
// radius for very little work.
//
// The pyramid starts at a fixed size (BASE on the shorter side) whatever the
// canvas size, so the blur covers the same share of the frame in the small
// player and in a 4K export.

/** Shorter side of the pyramid's first level. */
const BASE = 540;
/** Halvings below the first level; more is wider. */
const LEVELS = 4;

const SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_full(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, (1 - p[i].y) * 0.5);
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

// Frame -> first level: a box filter over the frame pixels each texel covers
// (taps x taps bilinear samples), so a 4K frame does not alias into it.
struct Base { footprint: vec2f, taps: f32 };
@group(0) @binding(2) var<uniform> base: Base;

@fragment fn fs_base(in: VsOut) -> @location(0) vec4f {
  let n = i32(base.taps);
  var sum = vec4f(0);
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      let o = (vec2f(f32(x), f32(y)) + 0.5) / base.taps - 0.5;
      sum += textureSampleLevel(src, samp, in.uv + o * base.footprint, 0);
    }
  }
  return vec4f(sum.rgb / f32(n * n), 1);
}

// Tap distance in source texels.
const OFFSET = 1.5;

@fragment fn fs_down(in: VsOut) -> @location(0) vec4f {
  let h = OFFSET * 0.5 / vec2f(textureDimensions(src));
  var sum = textureSampleLevel(src, samp, in.uv, 0) * 4;
  sum += textureSampleLevel(src, samp, in.uv - h, 0);
  sum += textureSampleLevel(src, samp, in.uv + h, 0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, -h.y), 0);
  sum += textureSampleLevel(src, samp, in.uv - vec2f(h.x, -h.y), 0);
  return sum / 8;
}

@fragment fn fs_up(in: VsOut) -> @location(0) vec4f {
  let h = OFFSET * 0.5 / vec2f(textureDimensions(src));
  var sum = textureSampleLevel(src, samp, in.uv + vec2f(-h.x * 2, 0), 0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, h.y), 0) * 2;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(0, h.y * 2), 0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, h.y), 0) * 2;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x * 2, 0), 0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, -h.y), 0) * 2;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(0, -h.y * 2), 0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, -h.y), 0) * 2;
  return sum / 12;
}

// The panel; rect = (x0, y0, x1, y1) in clip space, size and radius in canvas pixels.
struct Panel { rect: vec4f, size: vec2f, canvas: vec2f, radius: f32 };
@group(0) @binding(3) var<uniform> panel: Panel;

@vertex fn vs_panel(@builtin(vertex_index) i: u32) -> VsOut {
  var c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let t = c[i];
  var o: VsOut;
  o.pos = vec4f(mix(panel.rect.x, panel.rect.z, t.x), mix(panel.rect.y, panel.rect.w, t.y), 0, 1);
  o.uv = t;
  return o;
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment fn fs_panel(in: VsOut) -> @location(0) vec4f {
  // Rounded box, anti-aliased over one pixel.
  let p = (in.uv - 0.5) * panel.size;
  let q = abs(p) - panel.size * 0.5 + panel.radius;
  let d = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - panel.radius;
  let a = clamp(0.5 - d, 0, 1);

  var c = textureSampleLevel(src, samp, in.pos.xy / panel.canvas, 0).rgb;
  // A little more colour, then darker, so white text reads on any footage.
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(l), c, 1.2);
  c = mix(c, vec3f(0), 0.3);
  // Faint light rim.
  let rim = max(1.0, panel.radius * 0.05);
  c += vec3f(0.12) * (1 - smoothstep(0, rim, -d));
  // Dither: a smooth blur bands in 8-bit video.
  c += (hash(in.pos.xy) - 0.5) / 255;
  return vec4f(clamp(c, vec3f(0), vec3f(1)) * a, a); // premultiplied alpha
}
`;

const LEVEL_FORMAT: GPUTextureFormat = "rgba8unorm";

export class GlassBlur {
  private sampler: GPUSampler;
  private basePipeline: GPURenderPipeline;
  private downPipeline: GPURenderPipeline;
  private upPipeline: GPURenderPipeline;
  private panelPipeline: GPURenderPipeline;
  private baseBuffer: GPUBuffer;
  private panelBuffer: GPUBuffer;
  /** Per canvas size: the pyramid and the bind groups that read it. */
  private sized: {
    key: string;
    levels: GPUTexture[];
    down: GPUBindGroup[];
    up: GPUBindGroup[];
    panel: GPUBindGroup;
  } | null = null;

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ code: SHADER });
    const full = (entryPoint: string) =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_full" },
        fragment: { module, entryPoint, targets: [{ format: LEVEL_FORMAT }] },
      });
    this.basePipeline = full("fs_base");
    this.downPipeline = full("fs_down");
    this.upPipeline = full("fs_up");
    this.panelPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_panel" },
      fragment: {
        module,
        entryPoint: "fs_panel",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.baseBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.panelBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /**
   * Blurs `frame` (the picture drawn so far, W x H) and draws the panel onto
   * it. rect is the panel in clip space; w, h and radius in canvas pixels.
   */
  draw(
    enc: GPUCommandEncoder,
    frame: GPUTextureView,
    W: number,
    H: number,
    rect: Float32Array,
    w: number,
    h: number,
    radius: number,
  ) {
    const d = this.device;
    const s = this.resize(W, H);
    const pass = (view: GPUTextureView, pipeline: GPURenderPipeline, bind: GPUBindGroup, draw: number, load = false) => {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: load ? "load" : "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      });
      p.setPipeline(pipeline);
      p.setBindGroup(0, bind);
      p.draw(draw);
      p.end();
    };

    // The canvas texture is new every frame, so its bind group is too.
    const baseBind = d.createBindGroup({
      layout: this.basePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: frame },
        { binding: 2, resource: { buffer: this.baseBuffer } },
      ],
    });
    const views = s.levels.map((t) => t.createView());
    pass(views[0], this.basePipeline, baseBind, 3);
    for (let i = 1; i <= LEVELS; i++) pass(views[i], this.downPipeline, s.down[i - 1], 3);
    for (let i = LEVELS - 1; i >= 0; i--) pass(views[i], this.upPipeline, s.up[i], 3);

    d.queue.writeBuffer(this.panelBuffer, 0, new Float32Array([...rect, w, h, W, H, radius, 0, 0, 0]));
    pass(frame, this.panelPipeline, s.panel, 6, true);
  }

  private resize(W: number, H: number) {
    const key = `${W}x${H}`;
    if (this.sized?.key === key) return this.sized;
    this.sized?.levels.forEach((t) => t.destroy());

    const d = this.device;
    const k = BASE / Math.min(W, H);
    const sizes: [number, number][] = [[Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k))]];
    for (let i = 1; i <= LEVELS; i++) {
      const [w, h] = sizes[i - 1];
      sizes.push([Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2))]);
    }
    const levels = sizes.map((size) =>
      d.createTexture({
        size,
        format: LEVEL_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    const read = (pipeline: GPURenderPipeline, t: GPUTexture) =>
      d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: t.createView() },
        ],
      });
    // down[i] reads level i (into i + 1); up[i] reads level i + 1 (into i).
    const down = levels.slice(0, LEVELS).map((t) => read(this.downPipeline, t));
    const up = levels.slice(1).map((t) => read(this.upPipeline, t));
    const panel = d.createBindGroup({
      layout: this.panelPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: levels[0].createView() },
        { binding: 3, resource: { buffer: this.panelBuffer } },
      ],
    });

    // Each first-level texel averages the frame pixels under it.
    const [bw, bh] = sizes[0];
    const taps = Math.max(1, Math.ceil(W / bw / 2));
    d.queue.writeBuffer(this.baseBuffer, 0, new Float32Array([1 / bw, 1 / bh, taps, 0]));

    this.sized = { key, levels, down, up, panel };
    return this.sized;
  }

  destroy() {
    this.sized?.levels.forEach((t) => t.destroy());
    this.baseBuffer.destroy();
    this.panelBuffer.destroy();
  }
}
