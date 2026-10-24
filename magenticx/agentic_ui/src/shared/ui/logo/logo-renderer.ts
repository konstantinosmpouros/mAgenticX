/**
 * Draws one artwork on a canvas with WebGL and moves its pixels: the artwork is
 * the texture, and the fragment shader displaces and relights it (interior
 * flow and swirl, a light sweep, whole-mark float, breath and turns). Nothing
 * is redrawn, so it looks exactly like the image; with every amplitude at zero,
 * it is the image. Sampled with mipmaps at the canvas's device pixels, so it
 * stays smooth at any size and screen density.
 *
 * Ported from the thesis app's logo renderer. Framework-free:
 * `animated-logo.tsx` owns the loop and the React side.
 */
import type { MotionPreset } from "./motion";

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform float uMix;
uniform float uPhase;
uniform float uAmp;
uniform float uFlow;
uniform float uSwirl;
uniform float uSweep;
uniform float uSweepAngle;
uniform float uSweepSpin;
uniform float uFloat;
uniform float uBreath;
uniform float uTurn;
uniform float uScale;

const float TAU = 6.28318531;

vec4 tex(vec2 uv) {
  return mix(texture2D(uTex0, uv), texture2D(uTex1, uv), uMix);
}

// 1 well inside the artwork, falling to 0 near its outline: the interior
// moves, the outline stays.
float inside(vec2 uv) {
  float r = 0.035;
  float d = r * 0.7071;
  float m = min(tex(uv + vec2(r, 0.0)).a, tex(uv - vec2(r, 0.0)).a);
  m = min(m, min(tex(uv + vec2(0.0, r)).a, tex(uv - vec2(0.0, r)).a));
  m = min(m, min(tex(uv + vec2(d, d)).a, tex(uv - vec2(d, d)).a));
  m = min(m, min(tex(uv + vec2(d, -d)).a, tex(uv - vec2(d, -d)).a));
  return smoothstep(0.5, 1.0, m);
}

// A smooth flow field, periodic in the phase (integer harmonics only).
vec2 field(vec2 q, float p) {
  return vec2(
    sin(q.y * 7.0 + 1.6 * sin(q.x * 5.0 + p) + p),
    sin(q.x * 6.0 + 1.4 * sin(q.y * 4.0 - p) - 2.0 * p)
  );
}

void main() {
  float p = uPhase;

  // Whole-mark motion: float, one-third turns, breathing.
  float lift = uAmp * uFloat * sin(p);
  float angle = 0.0;
  if (uTurn > 0.5) {
    float s = p / TAU * 3.0;
    float e = smoothstep(0.72, 1.0, fract(s));
    angle = (floor(s) + e * e * (3.0 - 2.0 * e)) * TAU / 3.0;
  }
  float scale = uScale * (1.0 + uAmp * uBreath * (0.5 - 0.5 * cos(2.0 * p)));
  vec2 d = vUv - 0.5 + vec2(0.0, lift);
  float c = cos(angle);
  float s = sin(angle);
  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / scale + 0.5;

  // Interior flow and swirl.
  float inner = inside(q) * uAmp;
  vec2 r = q - 0.5;
  float twist = uSwirl * inner * sin(p + length(r) * 6.0) * (1.0 - smoothstep(0.0, 0.5, length(r)));
  r = vec2(cos(twist) * r.x - sin(twist) * r.y, sin(twist) * r.x + cos(twist) * r.y);
  vec2 uv = r + 0.5 + uFlow * inner * field(q, p);
  vec4 col = tex(uv);

  // Light: a soft band crossing the glass, or a highlight circling it.
  float light;
  if (uSweepSpin > 0.5) {
    vec2 spot = 0.5 + 0.26 * vec2(cos(p - 2.2), sin(p - 2.2));
    vec2 o = q - spot;
    light = 0.6 * exp(-dot(o, o) / 0.03) * (0.5 - 0.5 * cos(p));
  } else {
    vec2 dir = vec2(cos(uSweepAngle), sin(uSweepAngle));
    float pos = mix(-1.0, 1.0, smoothstep(0.05, 0.5, fract(p / TAU)));
    float t = (dot(q - 0.5, dir) - pos) / 0.12;
    light = exp(-t * t);
  }
  col.rgb += uAmp * uSweep * light * (col.a - col.rgb);
  gl_FragColor = col;
}`;

const UNIFORMS = [
  "uTex0", "uTex1", "uMix", "uPhase", "uAmp", "uFlow", "uSwirl", "uSweep", "uSweepAngle",
  "uSweepSpin", "uFloat", "uBreath", "uTurn", "uScale",
] as const;

type Uniform = (typeof UNIFORMS)[number];

const CROSSFADE_MS = 450;
/** The largest texture edge: plenty for the canvas, which is capped at 1024px. */
const MAX_TEXTURE_PX = 1024;

const isPowerOfTwo = (n: number) => (n & (n - 1)) === 0;

/**
 * The image as a square power-of-two source, so the texture gets mipmaps and
 * stays smooth when drawn small (an orb artwork is 1254px).
 */
function textureSource(image: HTMLImageElement): TexImageSource {
  const edge = Math.max(image.naturalWidth, image.naturalHeight);
  if (image.naturalWidth === image.naturalHeight && isPowerOfTwo(edge) && edge <= MAX_TEXTURE_PX) {
    return image;
  }
  let side = 1;
  while (side * 2 <= Math.min(edge, MAX_TEXTURE_PX)) side *= 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return image;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, side, side);
  return canvas;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("logo shader:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export class LogoRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<Uniform, WebGLUniformLocation | null>;
  private current: WebGLTexture | null = null;
  private incoming: WebGLTexture | null = null;
  private fadeStart = 0;
  private loadToken = 0;
  private disposed = false;

  static create(canvas: HTMLCanvasElement): LogoRenderer | null {
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("logo program:", gl.getProgramInfoLog(program));
      return null;
    }
    return new LogoRenderer(gl, program);
  }

  private constructor(gl: WebGLRenderingContext, program: WebGLProgram) {
    this.gl = gl;
    this.program = program;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<
      Uniform,
      WebGLUniformLocation | null
    >;
    gl.uniform1i(this.uniforms.uTex0, 0);
    gl.uniform1i(this.uniforms.uTex1, 1);
  }

  get ready(): boolean {
    return this.current !== null;
  }

  /** The GPU dropped the context (too many on the page, a GPU reset). */
  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  setMotion(motion: MotionPreset): void {
    const { gl, uniforms: u } = this;
    gl.uniform1f(u.uFlow, motion.flow);
    gl.uniform1f(u.uSwirl, motion.swirl);
    gl.uniform1f(u.uSweep, motion.sweep);
    gl.uniform1f(u.uSweepAngle, motion.sweepAngle);
    gl.uniform1f(u.uSweepSpin, motion.sweepSpin ? 1 : 0);
    gl.uniform1f(u.uFloat, motion.float);
    gl.uniform1f(u.uBreath, motion.breath);
    gl.uniform1f(u.uTurn, motion.turn ? 1 : 0);
    gl.uniform1f(u.uScale, motion.scale);
  }

  /** Amplitude of the flow and breathing, for the AI's active state. */
  setLiveliness(flow: number, breath: number): void {
    this.gl.uniform1f(this.uniforms.uFlow, flow);
    this.gl.uniform1f(this.uniforms.uBreath, breath);
  }

  /** Loads an image; the first one appears at once, later ones crossfade in. */
  async setImage(url: string): Promise<void> {
    const token = ++this.loadToken;
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    if (this.disposed || token !== this.loadToken) return;

    const { gl } = this;
    const texture = gl.createTexture();
    if (!texture) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureSource(image));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

    if (this.incoming) this.finishFade();
    if (this.current) {
      this.incoming = texture;
      this.fadeStart = performance.now();
    } else {
      this.current = texture;
    }
  }

  private finishFade(): void {
    if (!this.incoming) return;
    if (this.current) this.gl.deleteTexture(this.current);
    this.current = this.incoming;
    this.incoming = null;
  }

  resize(width: number, height: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  /**
   * Draws a frame. `phase` is the loop position in radians, `amp` scales every
   * deformation. False when there was nothing to draw yet (no texture).
   */
  draw(phase: number, amp: number): boolean {
    const { gl, uniforms: u } = this;
    if (!this.current) return false;
    let mix = 0;
    if (this.incoming) {
      mix = Math.min(1, (performance.now() - this.fadeStart) / CROSSFADE_MS);
      if (mix >= 1) {
        this.finishFade();
        mix = 0;
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.incoming ?? this.current);
    gl.uniform1f(u.uMix, mix);
    gl.uniform1f(u.uPhase, phase);
    gl.uniform1f(u.uAmp, amp);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    const { gl } = this;
    if (this.current) gl.deleteTexture(this.current);
    if (this.incoming) gl.deleteTexture(this.incoming);
    gl.deleteProgram(this.program);
    // Free the context now: browsers allow only a few at a time.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
