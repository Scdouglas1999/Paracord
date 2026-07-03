// Video frame rendering to HTMLCanvasElement.
// Efficiently renders VideoFrame objects using requestAnimationFrame
// and handles dynamic resolution changes from simulcast layer switching.

/**
 * Renders decoded VideoFrame objects onto an HTML canvas.
 *
 * Uses requestAnimationFrame for efficient rendering, automatically
 * adapts the canvas size to match incoming frame resolution, and
 * properly closes frames after drawing to prevent memory leaks.
 */
export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pendingFrame: VideoFrame | null = null;
  private pendingImageData: ImageData | null = null;
  private imageBufferCanvas: HTMLCanvasElement | null = null;
  private imageBufferCtx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private destroyed = false;

  /** Tracks the current frame resolution for detecting layer switches. */
  private currentWidth = 0;
  private currentHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

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
    this.ctx.imageSmoothingQuality = 'high';

    // Start the render loop.
    this.scheduleRender();
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

    this.pendingFrame = frame;
  }

  renderImageData(imageData: ImageData): void {
    if (this.destroyed) {
      return;
    }

    this.pendingImageData = imageData;
  }

  /**
   * Render a raw planar I420 (YUV 4:2:0) frame, as produced by the native
   * desktop decoder. The frame is converted to RGBA (BT.601 limited-range) and
   * scheduled through the same path as {@link renderImageData}, so aspect-ratio
   * fitting and canvas resizing behave identically to WebCodecs frames.
   *
   * `data` must contain a full-size Y plane (width*height) followed by half-size
   * U and V planes ((width/2)*(height/2) each). Malformed or truncated buffers
   * are ignored.
   */
  drawI420(data: Uint8Array, width: number, height: number): void {
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

    const uOffset = ySize;
    const vOffset = ySize + chromaSize;
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let row = 0; row < height; row += 1) {
      const yRow = row * width;
      const chromaRow = (row >> 1) * chromaWidth;
      for (let col = 0; col < width; col += 1) {
        const y = data[yRow + col];
        const chromaIndex = chromaRow + (col >> 1);
        const u = data[uOffset + chromaIndex] - 128;
        const v = data[vOffset + chromaIndex] - 128;

        // BT.601 limited-range YUV -> RGB.
        const c = (y - 16) * 1.164;
        const r = c + 1.596 * v;
        const g = c - 0.391 * u - 0.813 * v;
        const b = c + 2.018 * u;

        const outIndex = (yRow + col) * 4;
        rgba[outIndex] = r;
        rgba[outIndex + 1] = g;
        rgba[outIndex + 2] = b;
        rgba[outIndex + 3] = 255;
      }
    }

    this.pendingImageData = new ImageData(rgba, width, height);
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

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
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

    // Clear to black on teardown.
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Whether the renderer has been destroyed. */
  get isDestroyed(): boolean {
    return this.destroyed;
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

  private scheduleRender(): void {
    if (this.destroyed) return;

    this.rafId = requestAnimationFrame(() => {
      this.drawFrame();
      this.scheduleRender();
    });
  }

  private drawFrame(): void {
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
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(
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
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this.ctx.drawImage(
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
