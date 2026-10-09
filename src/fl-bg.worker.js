/*
 * Fluid Lyrics — living album-art background (runs in a dedicated Worker).
 *
 * The page hands us an OffscreenCanvas; we render two slowly rotating, stretched copies of
 * the album cover bent by a smooth sine flow (long liquid streaks) with WebGL2. Nothing here
 * touches the UI thread: even if Spotify's React tree is busy re-rendering, the background
 * keeps flowing.
 *
 * Cost control:
 *  - the canvas is rendered at ~1/4 of the CSS size and upscaled by the compositor
 *  - the cover is uploaded as a pre-blurred 96×96 texture, so there is no blur pass at all
 *  - 30 fps cap (motion is slow; 60 fps would be indistinguishable)
 *  - the loop fully stops when the viewer is hidden
 */
'use strict';

let gl, prog, canvas, U = {};
let texA, texB, mix = 1, mixFrom = 0, mixStart = 0;
let running = false, last = 0, t0 = performance.now(), timeAcc = 0;
let reduce = false;
let pendingArt = null, artSeq = 0;
const FRAME_MS = 1000 / 30;
const FADE_MS = 1400;

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D uA, uB; uniform float uMix, uT; uniform vec2 uRes;

vec2 rot(vec2 p, float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c)*p; }
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

// smooth low-frequency flow (stacked sine shears): bends the cover into long liquid
// streaks without the fine-grained noise that turned it into mush
vec2 flow(vec2 p, float t){
  for (int i = 1; i < 4; i++) {
    float f = float(i);
    p.x += .30 / f * sin(f * 1.2 * p.y + t * .07 * f + 1.7 * f);
    p.y += .24 / f * cos(f * 1.0 * p.x - t * .06 * f + .6 * f);
  }
  return p;
}

// two big rotating copies of the cover, each stretched along a slowly turning axis so its
// shapes smear into streaks, blended by a soft moving field (not averaged → stays vivid)
vec3 layers(sampler2D tex, vec2 w, float t){
  vec2 a = rot(w, t * .018); a.x *= .42;
  vec2 b = rot(w + vec2(.15, -.1), -t * .014 + 2.2); b.y *= .5;
  vec3 c1 = texture(tex, rot(a, -t * .018) * .9 + .5).rgb;
  vec3 c2 = texture(tex, rot(b, t * .011 + 1.1) * 1.1 + .5).rgb;
  float k = smoothstep(.15, .85, .5 + .5 * sin(w.x * 1.3 + w.y * .8 + t * .045));
  return mix(c1, c2, k);
}

void main(){
  float t = uT;
  vec2 p = uv - .5; p.x *= uRes.x / uRes.y;
  vec2 w = flow(p * 1.1, t) * .9;
  vec3 c = layers(uB, w, t);
  if (uMix < 1.) c = mix(layers(uA, w, t), c, smoothstep(0.,1.,uMix));
  // vibrancy: boost saturation, compress highlights so white text always reads
  float l = dot(c, vec3(.2126,.7152,.0722));
  c = mix(vec3(l), c, 1.3);
  c = c * .78 / (1. + c * .35);
  c *= 1. - .28 * dot(p, p);                 // soft vignette
  c += (h(uv*uRes + fract(t)) - .5) / 255.;  // dither against 8-bit banding
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

self.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      canvas = m.canvas;
      reduce = !!m.reduce;
      try {
        setup();
        resize(m.w, m.h);
        self.postMessage({ type: 'ready' });
      } catch (err) {
        self.postMessage({ type: 'fail', error: String(err && err.message || err) });
      }
      break;
    case 'resize':
      resize(m.w, m.h);
      break;
    case 'art':
      loadArt(m.url);
      break;
    case 'run':
      if (!running && gl) {
        running = true;
        last = 0;
        requestAnimationFrame(frame);
      }
      break;
    case 'stop':
      running = false;
      break;
    case 'reduce':
      reduce = !!m.reduce;
      break;
  }
};

function setup() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', desynchronized: true, preserveDrawingBuffer: false });
  if (!gl) throw new Error('webgl2 unavailable');
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one oversized triangle
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const k of ['uA', 'uB', 'uMix', 'uT', 'uRes']) U[k] = gl.getUniformLocation(prog, k);
  gl.uniform1i(U.uA, 0);
  gl.uniform1i(U.uB, 1);
  texA = makeTex();
  texB = makeTex();
  // neutral dark placeholder until the first cover arrives
  const px = new Uint8Array([24, 24, 32, 255]);
  for (const t of [texA, texB]) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
}

function makeTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  return t;
}

function resize(w, h) {
  if (!gl) return;
  // ~1/4 resolution: the field is smooth, so the compositor's bilinear upscale hides it
  canvas.width = Math.max(32, Math.round(w / 4));
  canvas.height = Math.max(32, Math.round(h / 4));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  if (!running) draw(performance.now());
}

async function loadArt(url) {
  if (!gl || !url) return;
  const seq = ++artSeq;
  try {
    const r = await fetch(url);
    const blob = await r.blob();
    // decode straight to 96×96 — enough to keep the cover's shapes, small enough to be cheap
    const bmp = await createImageBitmap(blob, { resizeWidth: 96, resizeHeight: 96, resizeQuality: 'high' });
    if (seq !== artSeq) return bmp.close();
    // softening pass on a small 2D canvas: shapes keep soft edges instead of hard texel steps
    const oc = new OffscreenCanvas(96, 96);
    const cx = oc.getContext('2d');
    cx.filter = 'blur(3px) saturate(1.15)';
    cx.drawImage(bmp, -8, -8, 112, 112);
    bmp.close();
    // swap: current B becomes A, new cover goes into B and cross-fades in
    [texA, texB] = [texB, texA];
    gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, oc);
    mixFrom = 0;
    mixStart = performance.now();
    mix = 0;
    if (!running) draw(performance.now());
  } catch {
    /* keep previous art */
  }
}

function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  if (last && now - last < FRAME_MS - 2) return; // 30 fps cap
  draw(now);
}

function draw(now) {
  const dt = last ? Math.min(100, now - last) : 0;
  last = now;
  timeAcc += reduce ? 0 : dt / 1000;
  if (mix < 1) mix = Math.min(1, mixFrom + (now - mixStart) / FADE_MS);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.uniform1f(U.uMix, mix);
  gl.uniform1f(U.uT, timeAcc + 37.0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
