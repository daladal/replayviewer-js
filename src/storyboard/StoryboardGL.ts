/**
 * WebGL2 sprite batcher for storyboard layers. Canvas 2D needs one `drawImage` per sprite and
 * an offscreen copy per tint colour; dense storyboards draw ten thousand tinted additive
 * particles per frame, which is far beyond what per-call 2D drawing sustains. Here every
 * sprite is a premultiplied-alpha quad with its tint and alpha in the vertex data, images live
 * in shelf-packed atlas pages, and a layer pass is a few `drawElements` calls.
 *
 * Blending is a single premultiplied source-over (`ONE, ONE_MINUS_SRC_ALPHA`); an additive
 * sprite writes alpha 0 from the fragment shader, which makes the equation `src + dst` —
 * exactly Canvas 2D's `lighter`. The drawing buffer is transparent and premultiplied, so the
 * host composites it with one ordinary `drawImage`; because premultiplied compositing is
 * associative, mixed normal/additive stacks come out identical to drawing them directly.
 *
 * Works on the main thread and in workers (`OffscreenCanvas`); `create` returns null when
 * WebGL2 is unavailable so callers can keep a 2D fallback.
 */

import type { StoryboardImage } from './StoryboardAssets.js';

/** Atlas page edge (px); pages larger than this waste video memory on sparse storyboards. */
const PAGE_SIZE = 4096;
/** Transparent gutter around each packed image, filled by extruding its edge texels. */
const PAD = 2;
/** Quads per flush: 4 vertices each under a 16-bit index buffer. */
const MAX_QUADS = 16383;
const FLOATS_PER_VERTEX = 8; // x, y, u, v, r, g, b, a

/** One image's location in the atlas. */
export interface AtlasEntry {
  tex: WebGLTexture;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface AtlasPlacement { page: number; x: number; y: number }

/**
 * Shelf-pack `items` (sorted by height, then width) into `pageSize`² pages with `pad` px of
 * gutter on every side. Items that cannot fit a page even alone are returned in `dedicated`.
 * Pure, so the packing is unit-testable without a GPU.
 */
export function packAtlas(
  items: ReadonlyArray<{ key: string; w: number; h: number }>,
  pageSize: number,
  pad: number,
): { pages: number; placements: Map<string, AtlasPlacement>; dedicated: string[] } {
  const placements = new Map<string, AtlasPlacement>();
  const dedicated: string[] = [];
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : 1));
  let page = -1, shelfY = 0, shelfH = 0, x = 0;
  const openPage = (): void => { page++; shelfY = 0; shelfH = 0; x = 0; };
  for (const it of sorted) {
    const cw = it.w + 2 * pad, ch = it.h + 2 * pad;
    if (cw > pageSize || ch > pageSize) { dedicated.push(it.key); continue; }
    if (page < 0) openPage();
    if (x + cw > pageSize) {
      // New shelf below the current one; new page when it would not fit.
      shelfY += shelfH; x = 0; shelfH = 0;
      if (shelfY + ch > pageSize) openPage();
    }
    if (shelfY + ch > pageSize) openPage();
    placements.set(it.key, { page, x: x + pad, y: shelfY + pad });
    x += cw;
    if (ch > shelfH) shelfH = ch;
  }
  return { pages: page + 1, placements, dedicated };
}

const VERT = `
attribute vec2 aPos; attribute vec2 aUV; attribute vec4 aCol;
uniform vec2 uInvHalf;
varying vec2 vUV; varying vec4 vCol;
void main() {
  vUV = aUV; vCol = aCol;
  gl_Position = vec4(aPos.x * uInvHalf.x - 1.0, 1.0 - aPos.y * uInvHalf.y, 0.0, 1.0);
}`;
const FRAG = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV; varying vec4 vCol;
void main() {
  vec4 t = texture2D(uTex, vUV);
  gl_FragColor = vec4(t.rgb * vCol.rgb, t.a * vCol.a);
}`;

export class StoryboardGL {
  /** Transparent, premultiplied drawing buffer sized to the host canvas's backing store. */
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly verts = new Float32Array(MAX_QUADS * 4 * FLOATS_PER_VERTEX);
  private readonly textures: WebGLTexture[] = [];
  private readonly entries = new Map<string, AtlasEntry>();
  private quads = 0;
  private boundTex: WebGLTexture | null = null;
  private lost = false;

  /**
   * Build the atlas for `images` (keyed by resolved archive path) on a `width`×`height` buffer.
   * Null when WebGL2 or `OffscreenCanvas` is unavailable, or when the context cannot be created.
   */
  static create(images: ReadonlyMap<string, StoryboardImage>, width: number, height: number): StoryboardGL | null {
    if (typeof OffscreenCanvas !== 'function') return null;
    try {
      const canvas = new OffscreenCanvas(width, height);
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, depth: false, stencil: false });
      if (gl === null) return null;
      return new StoryboardGL(canvas, gl, images);
    } catch {
      return null;
    }
  }

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext, images: ReadonlyMap<string, StoryboardImage>) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', () => { this.lost = true; });

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (sh === null) throw new Error('createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? ''}`);
      return sh;
    };
    const program = gl.createProgram();
    if (program === null) throw new Error('createProgram failed');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.bindAttribLocation(program, 1, 'aUV');
    gl.bindAttribLocation(program, 2, 'aCol');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program) ?? ''}`);
    this.program = program;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);

    const vbo = gl.createBuffer(), ibo = gl.createBuffer();
    if (vbo === null || ibo === null) throw new Error('createBuffer failed');
    this.vbo = vbo; this.ibo = ibo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    const indices = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4, i = q * 6;
      indices[i] = v; indices[i + 1] = v + 1; indices[i + 2] = v + 2;
      indices[i + 3] = v + 2; indices[i + 4] = v + 1; indices[i + 5] = v + 3;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    this.buildAtlas(images);
  }

  private buildAtlas(images: ReadonlyMap<string, StoryboardImage>): void {
    const gl = this.gl;
    const pageSize = Math.min(PAGE_SIZE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const items = [...images].map(([key, img]) => ({ key, w: img.bitmap.width, h: img.bitmap.height }));
    const { pages, placements, dedicated } = packAtlas(items, pageSize, PAD);

    const makeTexture = (): WebGLTexture => {
      const tex = gl.createTexture();
      if (tex === null) throw new Error('createTexture failed');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.textures.push(tex);
      return tex;
    };

    // Pages are composed on a 2D scratch canvas (image + extruded edges) and uploaded whole;
    // the scratch canvas is released afterwards.
    if (pages > 0) {
      const scratch = new OffscreenCanvas(pageSize, pageSize);
      const c = scratch.getContext('2d');
      if (c === null) throw new Error('2D scratch context failed');
      c.imageSmoothingEnabled = false;
      for (let p = 0; p < pages; p++) {
        c.clearRect(0, 0, pageSize, pageSize);
        for (const [key, pl] of placements) {
          if (pl.page !== p) continue;
          const b = images.get(key)!.bitmap;
          const w = b.width, h = b.height, x = pl.x, y = pl.y;
          c.drawImage(b, x, y);
          // Edge extrusion so linear filtering / mip levels never sample the transparent gutter.
          c.drawImage(b, 0, 0, 1, h, x - PAD, y, PAD, h);
          c.drawImage(b, w - 1, 0, 1, h, x + w, y, PAD, h);
          c.drawImage(b, 0, 0, w, 1, x, y - PAD, w, PAD);
          c.drawImage(b, 0, h - 1, w, 1, x, y + h, w, PAD);
          c.drawImage(b, 0, 0, 1, 1, x - PAD, y - PAD, PAD, PAD);
          c.drawImage(b, w - 1, 0, 1, 1, x + w, y - PAD, PAD, PAD);
          c.drawImage(b, 0, h - 1, 1, 1, x - PAD, y + h, PAD, PAD);
          c.drawImage(b, w - 1, h - 1, 1, 1, x + w, y + h, PAD, PAD);
        }
        const tex = makeTexture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
        gl.generateMipmap(gl.TEXTURE_2D);
        for (const [key, pl] of placements) {
          if (pl.page !== p) continue;
          const b = images.get(key)!.bitmap;
          this.entries.set(key, { tex, u0: pl.x / pageSize, v0: pl.y / pageSize, u1: (pl.x + b.width) / pageSize, v1: (pl.y + b.height) / pageSize });
        }
      }
      scratch.width = 0; scratch.height = 0;
    }
    for (const key of dedicated) {
      const b = images.get(key)!.bitmap;
      const tex = makeTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.entries.set(key, { tex, u0: 0, v0: 0, u1: 1, v1: 1 });
    }
  }

  /** True once the context was lost; the caller should fall back to 2D drawing. */
  get unusable(): boolean { return this.lost || this.gl.isContextLost(); }

  /** Atlas location of a decoded image, by its archive key. */
  entry(key: string): AtlasEntry | undefined { return this.entries.get(key); }

  /**
   * Start a pass: clear the buffer and set the scissor to `mask` (logical px; null = none).
   * `quality` is the backing-store scale of the host canvas (logical px → buffer px).
   */
  begin(mask: { x: number; y: number; w: number; h: number } | null, quality: number): void {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (mask !== null) {
      const x0 = Math.round(mask.x * quality), x1 = Math.round((mask.x + mask.w) * quality);
      const yTop = Math.round(mask.y * quality), yBot = Math.round((mask.y + mask.h) * quality);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, H - yBot, x1 - x0, yBot - yTop);
    }
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uInvHalf'), 2 * quality / W, 2 * quality / H);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.activeTexture(gl.TEXTURE0);
    this.quads = 0;
    this.boundTex = null;
  }

  /**
   * Append one sprite. `c` holds its four corners in logical px, in texture order
   * (top-left, top-right, bottom-left, bottom-right). `r g b` are the tint already multiplied
   * by the sprite alpha; `a` is the sprite alpha, or 0 for an additive sprite.
   */
  quad(e: AtlasEntry, c: Float32Array, r: number, g: number, b: number, a: number): void {
    if (e.tex !== this.boundTex) {
      this.flush();
      this.gl.bindTexture(this.gl.TEXTURE_2D, e.tex);
      this.boundTex = e.tex;
    } else if (this.quads === MAX_QUADS) {
      this.flush();
    }
    const v = this.verts;
    let o = this.quads * 4 * FLOATS_PER_VERTEX;
    for (let i = 0; i < 4; i++) {
      v[o++] = c[i * 2]!; v[o++] = c[i * 2 + 1]!;
      v[o++] = (i & 1) ? e.u1 : e.u0; v[o++] = (i & 2) ? e.v1 : e.v0;
      v[o++] = r; v[o++] = g; v[o++] = b; v[o++] = a;
    }
    this.quads++;
  }

  /** Draw whatever is pending. */
  end(): void { this.flush(); }

  private flush(): void {
    if (this.quads === 0) return;
    const gl = this.gl;
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.quads * 4 * FLOATS_PER_VERTEX));
    gl.drawElements(gl.TRIANGLES, this.quads * 6, gl.UNSIGNED_SHORT, 0);
    this.quads = 0;
  }

  /** Release GPU resources and the context (browsers cap live WebGL contexts). */
  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = 0; this.canvas.height = 0;
  }
}
