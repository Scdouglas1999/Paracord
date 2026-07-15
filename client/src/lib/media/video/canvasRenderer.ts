// Video frame rendering to HTMLCanvasElement.
// Efficiently renders VideoFrame objects using requestAnimationFrame
// and handles dynamic resolution changes from simulcast layer switching.
//
// The rendering backend is chosen once, at construction, by probing WebGL:
//   * WebGL available  -> EVERYTHING (native I420, packed RGBA/BGRA, ImageData,
//     and WebCodecs VideoFrame) is rendered through a single GL pipeline. I420
//     is uploaded as three single-channel planes and converted to RGB in the
//     fragment shader (BT.601 limited-range), so there is no per-frame CPU YUV
//     conversion at all.
//   * WebGL unavailable -> the legacy 2D-canvas + worker path is used (I420 is
//     converted to RGBA off-thread and blitted with putImageData).
// A renderer never mixes backends: obtaining a WebGL context on a canvas makes a
// 2D context impossible on that same canvas, so the choice is permanent.

import { convertI420ToRgba, YUV_COEFFS, type FrameColorSpace } from './pulledVideoFrame';
import type { I420WorkerRequest, I420WorkerResponse } from './i420Convert.worker';

type PendingI420Conversion = {
  width: number;
  height: number;
  resolve: (imageData: ImageData) => void;
};

/** A raw pixel source pending upload in WebGL mode. */
type GlPending =
  | { kind: 'i420'; data: Uint8Array; width: number; height: number; colorspace: FrameColorSpace }
  | { kind: 'rgba'; data: Uint8Array; width: number; height: number; swapRb: boolean };

interface GlResources {
  yuvProgram: WebGLProgram;
  rgbProgram: WebGLProgram;
  quadBuffer: WebGLBuffer;
  yTex: WebGLTexture;
  uTex: WebGLTexture;
  vTex: WebGLTexture;
  rgbTex: WebGLTexture;
  yuvUniforms: {
    uY: WebGLUniformLocation | null;
    uU: WebGLUniformLocation | null;
    uV: WebGLUniformLocation | null;
    uCrv: WebGLUniformLocation | null;
    uCgu: WebGLUniformLocation | null;
    uCgv: WebGLUniformLocation | null;
    uCbu: WebGLUniformLocation | null;
  };
  rgbUniforms: {
    uTex: WebGLUniformLocation | null;
    uSwapRb: WebGLUniformLocation | null;
  };
  yuvAttribs: { position: number; texCoord: number };
  rgbAttribs: { position: number; texCoord: number };
}

// A single fullscreen quad, interleaved as [clipX, clipY, texU, texV]. Texture
// v=0 is mapped to the top of the quad so top-row-first pixel data (I420,
// getImageData, VideoFrame via texImage2D) renders upright with no Y flip.
const QUAD_VERTICES = new Float32Array([
  -1, 1, 0, 0,
  1, 1, 1, 0,
  -1, -1, 0, 1,
  1, -1, 1, 1,
]);

const VERTEX_SHADER_SRC = `
attribute vec2 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Limited-range YUV -> RGB, matching convertI420ToRgba exactly. Constants are
// normalized: 16/255 = 0.0627451, 128/255 = 0.5019608. The chroma coefficients
// vary by colorspace (BT.601 vs BT.709, contract C1) and are supplied per frame
// as uniforms so a single program serves both.
const YUV_FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform float uCrv;
uniform float uCgu;
uniform float uCgv;
uniform float uCbu;
void main() {
  float y = texture2D(uY, vTexCoord).r;
  float u = texture2D(uU, vTexCoord).r;
  float v = texture2D(uV, vTexCoord).r;
  float c = (y - 0.0627451) * 1.164;
  float uu = u - 0.5019608;
  float vv = v - 0.5019608;
  float r = c + uCrv * vv;
  float g = c - uCgu * uu - uCgv * vv;
  float b = c + uCbu * uu;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

// Samples an RGBA texture; uSwapRb == 1.0 swizzles R/B for BGRA sources.
const RGB_FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uTex;
uniform float uSwapRb;
void main() {
  vec4 c = texture2D(uTex, vTexCoord);
  vec3 rgb = mix(c.rgb, c.bgr, uSwapRb);
  gl_FragColor = vec4(rgb, 1.0);
}
`;

/**
 * Renders decoded VideoFrame objects and raw pixel frames onto an HTML canvas.
 *
 * Uses requestAnimationFrame for efficient rendering, automatically
 * adapts the canvas size to match incoming frame resolution, and
 * properly closes frames after drawing to prevent memory leaks.
 */
export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private readonly mode: 'webgl' | '2d';

  // Shared scheduling state.
  private pendingFrame: VideoFrame | null = null;
  private rafId: number | null = null;
  private destroyed = false;
  private renderingEnabled = true;

  // 2D-mode state.
  private ctx: CanvasRenderingContext2D | null = null;
  private pendingImageData: ImageData | null = null;
  private imageBufferCanvas: HTMLCanvasElement | null = null;
  private imageBufferCtx: CanvasRenderingContext2D | null = null;
  private i420Worker: Worker | null = null;
  private i420WorkerJobId = 0;
  private pendingI420Jobs = new Map<number, PendingI420Conversion>();

  // WebGL-mode state.
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private glResources: GlResources | null = null;
  private pendingGl: GlPending | null = null;
  private lumaInternalFormat = 0;
  private lumaFormat = 0;
  private rgbaInternalFormat = 0;
  private rgbaFormat = 0;
  // Last allocated dimensions per texture. When a plane's size is unchanged we
  // texSubImage2D into the existing storage instead of reallocating it with
  // texImage2D every frame (W12). Keyed by texture so each plane tracks its own.
  private texDims = new WeakMap<WebGLTexture, { width: number; height: number }>();

  /** Tracks the current frame resolution for detecting layer switches. */
  private currentWidth = 0;
  private currentHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = this.tryCreateWebglContext(canvas);
    if (gl) {
      // Obtaining a WebGL context permanently commits this canvas to WebGL; a
      // 2D context can no longer be created on it. A setup failure here is a
      // genuinely broken GL stack, surfaced loudly rather than silently
      // downgraded (which is impossible on the same canvas anyway).
      this.mode = 'webgl';
      this.setupGl(gl);
    } else {
      this.mode = '2d';
      this.setup2d(canvas);
    }
  }

  private tryCreateWebglContext(
    canvas: HTMLCanvasElement,
  ): WebGL2RenderingContext | WebGLRenderingContext | null {
    try {
      const attributes: WebGLContextAttributes = {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        desynchronized: true,
      };
      const gl2 = canvas.getContext('webgl2', attributes);
      if (gl2) {
        return gl2 as WebGL2RenderingContext;
      }
      const gl1 =
        canvas.getContext('webgl', attributes) ??
        canvas.getContext('experimental-webgl', attributes);
      return (gl1 as WebGLRenderingContext | null) ?? null;
    } catch {
      return null;
    }
  }

  private setup2d(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d', {
      // Hint for better performance: we replace the entire canvas each frame.
      alpha: false,
      desynchronized: true,
    });
    if (!ctx) {
      throw new Error('Failed to get 2d rendering context from canvas');
    }
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'low';
    this.initI420Worker();
  }

  private setupGl(gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.gl = gl;
    const isGl2 =
      typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    // Single-channel plane textures: R8/RED on WebGL2, LUMINANCE on WebGL1.
    // Both are sampled via `.r` in the fragment shader, so the shader is shared.
    this.lumaInternalFormat = isGl2 ? (gl as WebGL2RenderingContext).R8 : gl.LUMINANCE;
    this.lumaFormat = isGl2 ? (gl as WebGL2RenderingContext).RED : gl.LUMINANCE;
    this.rgbaInternalFormat = gl.RGBA;
    this.rgbaFormat = gl.RGBA;

    const yuvProgram = this.buildProgram(VERTEX_SHADER_SRC, YUV_FRAGMENT_SHADER_SRC);
    const rgbProgram = this.buildProgram(VERTEX_SHADER_SRC, RGB_FRAGMENT_SHADER_SRC);

    const quadBuffer = gl.createBuffer();
    if (!quadBuffer) {
      throw new Error('WebGL buffer allocation failed');
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

    this.glResources = {
      yuvProgram,
      rgbProgram,
      quadBuffer,
      yTex: this.createTexture(),
      uTex: this.createTexture(),
      vTex: this.createTexture(),
      rgbTex: this.createTexture(),
      yuvUniforms: {
        uY: gl.getUniformLocation(yuvProgram, 'uY'),
        uU: gl.getUniformLocation(yuvProgram, 'uU'),
        uV: gl.getUniformLocation(yuvProgram, 'uV'),
        uCrv: gl.getUniformLocation(yuvProgram, 'uCrv'),
        uCgu: gl.getUniformLocation(yuvProgram, 'uCgu'),
        uCgv: gl.getUniformLocation(yuvProgram, 'uCgv'),
        uCbu: gl.getUniformLocation(yuvProgram, 'uCbu'),
      },
      rgbUniforms: {
        uTex: gl.getUniformLocation(rgbProgram, 'uTex'),
        uSwapRb: gl.getUniformLocation(rgbProgram, 'uSwapRb'),
      },
      yuvAttribs: {
        position: gl.getAttribLocation(yuvProgram, 'aPosition'),
        texCoord: gl.getAttribLocation(yuvProgram, 'aTexCoord'),
      },
      rgbAttribs: {
        position: gl.getAttribLocation(rgbProgram, 'aPosition'),
        texCoord: gl.getAttribLocation(rgbProgram, 'aTexCoord'),
      },
    };
    gl.clearColor(0, 0, 0, 1);
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture();
    if (!tex) {
      throw new Error('WebGL texture allocation failed');
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // MIN_FILTER stays LINEAR rather than a mipmapped filter: minification
    // aliasing when a large stream is drawn into a much smaller tile is instead
    // handled by simulcast/layer selection (selectPublishedLayer picks a layer
    // sized to the viewport), so the GPU rarely downscales by more than ~2x.
    // Mipmaps are deliberately NOT used here: the frame planes are non-power-of-2
    // (WebGL1 rejects NPOT mipmaps outright) and regenerating the pyramid every
    // frame with generateMipmap would negate the per-frame texSubImage2D reuse
    // (W12) it is paired with, for a downscale range we already avoid upstream.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('WebGL shader allocation failed');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL shader compile failed: ${log}`);
    }
    return shader;
  }

  private buildProgram(vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl!;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    if (!program) {
      throw new Error('WebGL program allocation failed');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`WebGL program link failed: ${log}`);
    }
    return program;
  }

  private initI420Worker(): void {
    if (typeof Worker === 'undefined') {
      return;
    }
    try {
      this.i420Worker = new Worker(new URL('./i420Convert.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.i420Worker.onmessage = (event: MessageEvent<I420WorkerResponse>) => {
        const { id, width, height, rgba } = event.data;
        const pending = this.pendingI420Jobs.get(id);
        if (!pending) {
          return;
        }
        this.pendingI420Jobs.delete(id);
        if (this.destroyed) {
          return;
        }
        pending.resolve(new ImageData(new Uint8ClampedArray(rgba), width, height));
        this.scheduleRender();
      };
      this.i420Worker.onerror = () => {
        this.terminateI420Worker();
      };
    } catch {
      this.i420Worker = null;
    }
  }

  private terminateI420Worker(): void {
    if (this.i420Worker) {
      this.i420Worker.terminate();
      this.i420Worker = null;
    }
    this.pendingI420Jobs.clear();
  }

  /**
   * Submit a VideoFrame for rendering.
   *
   * Only the most recent frame is kept. If a new frame arrives before
   * the previous one is drawn, the old frame is closed (freed) and
   * replaced. This ensures we always display the latest frame and
   * never accumulate a backlog.
   *
   * Ownership of the frame transfers to the renderer. The caller
   * must not close the frame after calling this method.
   */
  renderFrame(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }

    // Close the previously pending frame if it was not yet rendered.
    if (this.pendingFrame) {
      this.pendingFrame.close();
    }
    // A newer VideoFrame supersedes any pending raw frame.
    this.pendingGl = null;

    this.pendingFrame = frame;
    this.scheduleRender();
  }

  renderImageData(imageData: ImageData): void {
    if (this.destroyed) {
      return;
    }

    if (this.mode === 'webgl') {
      this.supersedeForRaw();
      this.pendingGl = {
        kind: 'rgba',
        data: new Uint8Array(
          imageData.data.buffer,
          imageData.data.byteOffset,
          imageData.data.byteLength,
        ),
        width: imageData.width,
        height: imageData.height,
        swapRb: false,
      };
      this.scheduleRender();
      return;
    }

    this.pendingImageData = imageData;
    this.scheduleRender();
  }

  /**
   * Render a raw planar I420 (YUV 4:2:0) frame, as produced by the native
   * desktop decoder. In WebGL mode the three planes are uploaded and converted
   * to RGB on the GPU; in 2D mode the frame is converted to RGBA (BT.601
   * limited-range) off-thread and scheduled through {@link renderImageData}, so
   * aspect-ratio fitting and canvas resizing behave identically to WebCodecs
   * frames.
   *
   * `data` must contain a full-size Y plane (width*height) followed by half-size
   * U and V planes ((width/2)*(height/2) each). Malformed or truncated buffers
   * are ignored.
   */
  drawI420(
    data: Uint8Array,
    width: number,
    height: number,
    colorspace: FrameColorSpace = 'bt709',
  ): void {
    if (this.destroyed) {
      return;
    }
    if (width <= 0 || height <= 0) {
      return;
    }
    const chromaWidth = width >> 1;
    const chromaHeight = height >> 1;
    const ySize = width * height;
    const chromaSize = chromaWidth * chromaHeight;
    if (data.length < ySize + chromaSize * 2) {
      return;
    }

    if (this.mode === 'webgl') {
      this.supersedeForRaw();
      this.pendingGl = { kind: 'i420', data, width, height, colorspace };
      this.scheduleRender();
      return;
    }

    if (this.i420Worker) {
      const id = this.i420WorkerJobId + 1;
      this.i420WorkerJobId = id;
      this.pendingI420Jobs.set(id, {
        width,
        height,
        resolve: (imageData) => {
          this.pendingImageData = imageData;
          this.scheduleRender();
        },
      });
      let buffer: ArrayBuffer;
      const byteOffset = 0;
      const byteLength = data.length;
      if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
        buffer = data.buffer as ArrayBuffer;
      } else {
        const copy = new Uint8Array(data.length);
        copy.set(data);
        buffer = copy.buffer;
      }
      const message: I420WorkerRequest = {
        id,
        width,
        height,
        data: buffer,
        byteOffset,
        byteLength,
        colorspace,
      };
      this.i420Worker.postMessage(message, [buffer]);
      return;
    }

    const rgba = convertI420ToRgba(data, width, height, colorspace);
    if (rgba.length === 0) {
      return;
    }
    this.pendingImageData = new ImageData(rgba as ImageData['data'], width, height);
    this.scheduleRender();
  }

  drawRgba(data: Uint8Array, width: number, height: number): void {
    if (this.destroyed || width <= 0 || height <= 0) {
      return;
    }
    const expectedSize = width * height * 4;
    if (data.length < expectedSize) {
      return;
    }

    if (this.mode === 'webgl') {
      this.supersedeForRaw();
      this.pendingGl = { kind: 'rgba', data, width, height, swapRb: false };
      this.scheduleRender();
      return;
    }

    const rgba = new Uint8ClampedArray(expectedSize);
    rgba.set(data.subarray(0, expectedSize));
    this.pendingImageData = new ImageData(rgba, width, height);
    this.scheduleRender();
  }

  drawBgra(data: Uint8Array, width: number, height: number): void {
    if (this.destroyed || width <= 0 || height <= 0) {
      return;
    }
    const expectedSize = width * height * 4;
    if (data.length < expectedSize) {
      return;
    }

    if (this.mode === 'webgl') {
      // The GPU swizzles B/R in the shader — no per-pixel CPU loop.
      this.supersedeForRaw();
      this.pendingGl = { kind: 'rgba', data, width, height, swapRb: true };
      this.scheduleRender();
      return;
    }

    const rgba = new Uint8ClampedArray(expectedSize);
    for (let i = 0; i < expectedSize; i += 4) {
      rgba[i] = data[i + 2];
      rgba[i + 1] = data[i + 1];
      rgba[i + 2] = data[i];
      rgba[i + 3] = 255;
    }
    this.pendingImageData = new ImageData(rgba, width, height);
    this.scheduleRender();
  }

  /** Drop any pending frame so a newly-submitted raw frame wins (WebGL mode). */
  private supersedeForRaw(): void {
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.pendingFrame = null;
    }
    this.pendingImageData = null;
  }

  /**
   * Clear the canvas to black and discard any pending frame.
   */
  clear(): void {
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.pendingFrame = null;
    }
    this.pendingImageData = null;
    this.pendingGl = null;
    this.pendingI420Jobs.clear();

    if (this.mode === 'webgl' && this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    this.ctx!.fillStyle = '#000';
    this.ctx!.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Destroy the renderer, stopping the render loop and releasing resources.
   * After calling destroy(), the renderer cannot be reused.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.pendingFrame = null;
    }
    this.pendingImageData = null;
    this.pendingGl = null;
    this.pendingI420Jobs.clear();
    this.terminateI420Worker();

    if (this.mode === 'webgl' && this.gl) {
      this.releaseGl();
      return;
    }

    // Clear to black on teardown.
    this.ctx!.fillStyle = '#000';
    this.ctx!.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private releaseGl(): void {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const res = this.glResources;
    if (res) {
      gl.deleteProgram(res.yuvProgram);
      gl.deleteProgram(res.rgbProgram);
      gl.deleteBuffer(res.quadBuffer);
      gl.deleteTexture(res.yTex);
      gl.deleteTexture(res.uTex);
      gl.deleteTexture(res.vTex);
      gl.deleteTexture(res.rgbTex);
    }
    this.glResources = null;
  }

  /** Whether the renderer has been destroyed. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Pause or resume canvas rendering (e.g. when the stream is off-screen). */
  setRenderingEnabled(enabled: boolean): void {
    this.renderingEnabled = enabled;
    if (!enabled && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    } else if (enabled && this.hasPending()) {
      this.scheduleRender();
    }
  }

  /** Current displayed frame resolution (width). */
  get frameWidth(): number {
    return this.currentWidth;
  }

  /** Current displayed frame resolution (height). */
  get frameHeight(): number {
    return this.currentHeight;
  }

  get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  private hasPending(): boolean {
    return !!(this.pendingFrame || this.pendingImageData || this.pendingGl);
  }

  private scheduleRender(): void {
    if (this.destroyed || this.rafId !== null || !this.renderingEnabled) {
      return;
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.drawFrame();
      if (!this.destroyed && this.hasPending()) {
        this.scheduleRender();
      }
    });
  }

  private drawFrame(): void {
    if (this.mode === 'webgl') {
      this.drawGl();
      return;
    }
    this.draw2d();
  }

  private draw2d(): void {
    if (this.pendingImageData) {
      const image = this.pendingImageData;
      this.pendingImageData = null;
      const frameWidth = image.width;
      const frameHeight = image.height;
      this.currentWidth = frameWidth;
      this.currentHeight = frameHeight;

      const bufferCanvas = this.ensureImageBuffer(frameWidth, frameHeight);
      this.imageBufferCtx?.putImageData(image, 0, 0);

      const target = this.measureRenderSize(frameWidth, frameHeight);
      if (this.canvas.width !== target.canvasWidth || this.canvas.height !== target.canvasHeight) {
        this.canvas.width = target.canvasWidth;
        this.canvas.height = target.canvasHeight;
      }
      this.ctx!.fillStyle = '#000';
      this.ctx!.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx!.drawImage(
        bufferCanvas,
        0,
        0,
        frameWidth,
        frameHeight,
        target.drawX,
        target.drawY,
        target.drawWidth,
        target.drawHeight,
      );
      return;
    }

    if (!this.pendingFrame) return;

    const frame = this.pendingFrame;
    this.pendingFrame = null;

    try {
      const frameWidth = frame.displayWidth;
      const frameHeight = frame.displayHeight;

      // If the incoming frame resolution changed (simulcast layer switch),
      // update the canvas dimensions to match.
      if (frameWidth !== this.currentWidth || frameHeight !== this.currentHeight) {
        this.currentWidth = frameWidth;
        this.currentHeight = frameHeight;
      }
      const target = this.measureRenderSize(frameWidth, frameHeight);
      if (this.canvas.width !== target.canvasWidth || this.canvas.height !== target.canvasHeight) {
        this.canvas.width = target.canvasWidth;
        this.canvas.height = target.canvasHeight;
      }
      this.ctx!.fillStyle = '#000';
      this.ctx!.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this.ctx!.drawImage(
        frame,
        0,
        0,
        frameWidth,
        frameHeight,
        target.drawX,
        target.drawY,
        target.drawWidth,
        target.drawHeight,
      );
    } finally {
      // Always close the frame to release GPU/memory resources.
      frame.close();
    }
  }

  private drawGl(): void {
    const gl = this.gl!;
    const pending = this.pendingGl;
    const frame = this.pendingFrame;

    let sourceWidth: number;
    let sourceHeight: number;
    if (pending) {
      sourceWidth = pending.width;
      sourceHeight = pending.height;
    } else if (frame) {
      sourceWidth = frame.displayWidth;
      sourceHeight = frame.displayHeight;
    } else {
      return;
    }

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      this.pendingGl = null;
      if (frame) {
        this.pendingFrame = null;
        frame.close();
      }
      return;
    }

    this.currentWidth = sourceWidth;
    this.currentHeight = sourceHeight;

    const target = this.measureRenderSize(sourceWidth, sourceHeight);
    if (this.canvas.width !== target.canvasWidth || this.canvas.height !== target.canvasHeight) {
      this.canvas.width = target.canvasWidth;
      this.canvas.height = target.canvasHeight;
    }

    // Black letterbox bars, then draw the fitted image into the centered
    // viewport. The GL viewport origin is bottom-left; measureRenderSize gives
    // drawY from the top, so flip it.
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const glDrawY = this.canvas.height - target.drawHeight - target.drawY;
    gl.viewport(target.drawX, glDrawY, target.drawWidth, target.drawHeight);

    try {
      if (pending) {
        this.pendingGl = null;
        if (pending.kind === 'i420') {
          this.uploadAndDrawI420(pending.data, pending.width, pending.height, pending.colorspace);
        } else {
          this.uploadAndDrawRgb(pending.data, pending.width, pending.height, pending.swapRb);
        }
      } else if (frame) {
        this.pendingFrame = null;
        try {
          this.uploadAndDrawFrame(frame);
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      // Loud, not a fallback: WebKitGTK is expected to accept VideoFrame as a
      // texture source. A runtime failure here is a real defect, surfaced —
      // never silently rerouted to a 2D path (impossible on this canvas anyway).
      console.error('[CanvasRenderer] WebGL draw failed', err);
    }
  }

  private uploadAndDrawI420(
    data: Uint8Array,
    width: number,
    height: number,
    colorspace: FrameColorSpace,
  ): void {
    const gl = this.gl!;
    const res = this.glResources!;
    const chromaWidth = width >> 1;
    const chromaHeight = height >> 1;
    const ySize = width * height;
    const chromaSize = chromaWidth * chromaHeight;
    if (data.length < ySize + chromaSize * 2) {
      return;
    }
    gl.useProgram(res.yuvProgram);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.uploadPlane(res.yTex, 0, data.subarray(0, ySize), width, height);
    this.uploadPlane(res.uTex, 1, data.subarray(ySize, ySize + chromaSize), chromaWidth, chromaHeight);
    this.uploadPlane(
      res.vTex,
      2,
      data.subarray(ySize + chromaSize, ySize + chromaSize * 2),
      chromaWidth,
      chromaHeight,
    );
    gl.uniform1i(res.yuvUniforms.uY, 0);
    gl.uniform1i(res.yuvUniforms.uU, 1);
    gl.uniform1i(res.yuvUniforms.uV, 2);
    const coeffs = YUV_COEFFS[colorspace];
    gl.uniform1f(res.yuvUniforms.uCrv, coeffs.rv);
    gl.uniform1f(res.yuvUniforms.uCgu, coeffs.gu);
    gl.uniform1f(res.yuvUniforms.uCgv, coeffs.gv);
    gl.uniform1f(res.yuvUniforms.uCbu, coeffs.bu);
    this.bindQuadAndDraw(res.yuvAttribs);
  }

  private uploadPlane(
    tex: WebGLTexture,
    unit: number,
    data: Uint8Array,
    width: number,
    height: number,
  ): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const prev = this.texDims.get(tex);
    if (prev && prev.width === width && prev.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, this.lumaFormat, gl.UNSIGNED_BYTE, data);
      return;
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.lumaInternalFormat,
      width,
      height,
      0,
      this.lumaFormat,
      gl.UNSIGNED_BYTE,
      data,
    );
    this.texDims.set(tex, { width, height });
  }

  private uploadAndDrawRgb(
    data: Uint8Array,
    width: number,
    height: number,
    swapRb: boolean,
  ): void {
    const gl = this.gl!;
    const res = this.glResources!;
    const expectedSize = width * height * 4;
    if (data.length < expectedSize) {
      return;
    }
    gl.useProgram(res.rgbProgram);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.rgbTex);
    const pixels = data.subarray(0, expectedSize);
    const prev = this.texDims.get(res.rgbTex);
    if (prev && prev.width === width && prev.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, this.rgbaFormat, gl.UNSIGNED_BYTE, pixels);
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        this.rgbaInternalFormat,
        width,
        height,
        0,
        this.rgbaFormat,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      this.texDims.set(res.rgbTex, { width, height });
    }
    gl.uniform1i(res.rgbUniforms.uTex, 0);
    gl.uniform1f(res.rgbUniforms.uSwapRb, swapRb ? 1 : 0);
    this.bindQuadAndDraw(res.rgbAttribs);
  }

  private uploadAndDrawFrame(frame: VideoFrame): void {
    const gl = this.gl!;
    const res = this.glResources!;
    gl.useProgram(res.rgbProgram);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.rgbTex);
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const prev = this.texDims.get(res.rgbTex);
    if (prev && prev.width === width && prev.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.rgbaFormat, gl.UNSIGNED_BYTE, frame);
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        this.rgbaInternalFormat,
        this.rgbaFormat,
        gl.UNSIGNED_BYTE,
        frame,
      );
      this.texDims.set(res.rgbTex, { width, height });
    }
    gl.uniform1i(res.rgbUniforms.uTex, 0);
    gl.uniform1f(res.rgbUniforms.uSwapRb, 0);
    this.bindQuadAndDraw(res.rgbAttribs);
  }

  private bindQuadAndDraw(attribs: { position: number; texCoord: number }): void {
    const gl = this.gl!;
    const res = this.glResources!;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.quadBuffer);
    gl.enableVertexAttribArray(attribs.position);
    gl.vertexAttribPointer(attribs.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(attribs.texCoord);
    gl.vertexAttribPointer(attribs.texCoord, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private ensureImageBuffer(width: number, height: number): HTMLCanvasElement {
    if (!this.imageBufferCanvas) {
      this.imageBufferCanvas = document.createElement('canvas');
      this.imageBufferCtx = this.imageBufferCanvas.getContext('2d', { alpha: false });
    }
    if (!this.imageBufferCtx) {
      throw new Error('Failed to get buffer rendering context');
    }
    if (this.imageBufferCanvas.width !== width || this.imageBufferCanvas.height !== height) {
      this.imageBufferCanvas.width = width;
      this.imageBufferCanvas.height = height;
    }
    return this.imageBufferCanvas;
  }

  private measureRenderSize(frameWidth: number, frameHeight: number) {
    const ratio = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;
    const cssWidth = Math.max(1, this.canvas.clientWidth || frameWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight || frameHeight);
    const canvasWidth = Math.max(1, Math.round(cssWidth * ratio));
    const canvasHeight = Math.max(1, Math.round(cssHeight * ratio));
    const scale = Math.min(canvasWidth / frameWidth, canvasHeight / frameHeight);
    const drawWidth = Math.max(1, Math.round(frameWidth * scale));
    const drawHeight = Math.max(1, Math.round(frameHeight * scale));
    const drawX = Math.floor((canvasWidth - drawWidth) / 2);
    const drawY = Math.floor((canvasHeight - drawHeight) / 2);
    return { canvasWidth, canvasHeight, drawX, drawY, drawWidth, drawHeight };
  }
}
