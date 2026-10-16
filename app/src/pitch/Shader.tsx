import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { reducedMotion } from '../lib/motion'

/**
 * Full-screen WebGL2 background: contour lines of a slow fbm field, like a topographic map of
 * coiled wire. Lines bend away from the cursor and warm to orange near it; `light` cross-fades
 * between the dark board and the paper of the site, `pulse` sends a ripple on scene changes.
 */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uLight; uniform float uPulse; uniform float uHeat;
out vec4 outColor;
vec2 hash(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash(i), f), dot(hash(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash(i + vec2(0, 1)), f - vec2(0, 1)), dot(hash(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 m = (uMouse - 0.5 * uRes) / uRes.y;
  vec2 dm = p - m; float d = length(dm);
  float push = exp(-d * 5.0) * (0.10 + 0.25 * uPulse);
  vec2 q = p + normalize(dm + 1e-5) * push;
  float ring = sin(d * 38.0 - uTime * 3.0) * exp(-d * 3.0) * 0.02 * uPulse;
  float n = fbm(q * 1.35 + vec2(uTime * 0.025, -uTime * 0.018)) + ring;
  float b = n * 16.0;
  float w = fwidth(b);
  // distance to the nearest contour, in pixels: a crisp 1px line at any zoom
  float line = clamp(1.0 - abs(fract(b + 0.5) - 0.5) / max(w, 1e-4) * 0.9, 0.0, 1.0);
  vec3 dark = vec3(0.047, 0.047, 0.055);
  vec3 paper = vec3(0.957, 0.957, 0.945);
  vec3 base = mix(dark, paper, uLight);
  vec3 ink = mix(vec3(0.93, 0.93, 0.92), vec3(0.07, 0.07, 0.075), uLight);
  vec3 acc = vec3(0.969, 0.576, 0.102);
  float hot = smoothstep(0.42, 0.0, d) * (0.6 + 0.4 * uHeat);
  vec3 lc = mix(ink, acc, clamp(hot * 1.1 + uPulse * 0.25, 0.0, 1.0));
  float alpha = line * (mix(0.085, 0.11, uLight) + hot * 0.38 + uPulse * 0.05);
  vec3 col = mix(base, lc, alpha);
  float vig = smoothstep(0.35, 1.25, length(p * vec2(0.9, 1.1)));
  col = mix(col, col * mix(0.72, 0.94, uLight), vig);
  outColor = vec4(col, 1.0);
}`

const VERT = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`

export function Shader({ light, pulseKey, heat = 0 }: { light: number; pulseKey: number; heat?: number }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const u = useRef({ light, pulse: 0, heat, mx: -9999, my: -9999, tx: -9999, ty: -9999 })

  useEffect(() => { gsap.to(u.current, { light, duration: 1.4, ease: 'power2.inOut' }) }, [light])
  useEffect(() => { gsap.to(u.current, { heat, duration: 0.6 }) }, [heat])
  useEffect(() => {
    if (pulseKey === 0) return
    gsap.fromTo(u.current, { pulse: 1 }, { pulse: 0, duration: 2.2, ease: 'power2.out' })
  }, [pulseKey])

  useEffect(() => {
    const el = cv.current!
    const gl = el.getContext('webgl2', { antialias: false, premultipliedAlpha: false })
    if (!gl) return
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s))
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog); gl.useProgram(prog)
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const U = (n: string) => gl.getUniformLocation(prog, n)
    const uRes = U('uRes'), uTime = U('uTime'), uMouse = U('uMouse'), uLight = U('uLight'), uPulse = U('uPulse'), uHeat = U('uHeat')
    // Render below the screen's pixel density and adapt: the field is soft by nature, and a
    // full-res retina fbm costs far more than it shows. Scale drops if frames run long.
    let scale = Math.min(1, 1.1 / (window.devicePixelRatio || 1)) * Math.min(window.devicePixelRatio || 1, 1.25)
    const resize = () => { el.width = Math.round(innerWidth * scale); el.height = Math.round(innerHeight * scale); gl.viewport(0, 0, el.width, el.height) }
    resize()
    window.addEventListener('resize', resize)
    const move = (e: PointerEvent) => { u.current.tx = e.clientX * scale; u.current.ty = (innerHeight - e.clientY) * scale }
    window.addEventListener('pointermove', move)
    const still = reducedMotion()
    let raf = 0
    const t0 = performance.now()
    let last = t0, slow = 0, frames = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = now - last
      last = now
      frames++
      if (frames > 20 && dt > 24) slow++
      if (slow > 12 && scale > 0.45) { scale *= 0.8; slow = 0; resize() }
      const s = u.current
      if (s.mx < -9000) { s.mx = s.tx; s.my = s.ty }
      s.mx += (s.tx - s.mx) * 0.08; s.my += (s.ty - s.my) * 0.08
      gl.uniform2f(uRes, el.width, el.height)
      gl.uniform1f(uTime, still ? 0 : (now - t0) / 1000)
      gl.uniform2f(uMouse, s.mx, s.my)
      gl.uniform1f(uLight, s.light); gl.uniform1f(uPulse, s.pulse); gl.uniform1f(uHeat, s.heat)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); window.removeEventListener('pointermove', move) }
  }, [])

  return <canvas ref={cv} className="pitch__shader" aria-hidden="true" />
}
