import * as THREE from 'three';
import { TERRAIN_GLSL } from './terrain.js';

// ─── Tuning constants ─────────────────────────────────────────────────────────

const CHUNK_SIZE        = 20;        // world-metres per chunk side
const BLADES_PER_CHUNK  = 10_000;    // instances per chunk
const CULL_CHUNKS       = 4;         // active chunk radius (4 × 20 m = 80 m)
const POOL_SIZE         = 121;       // 11 × 11 — large enough for any camera angle

// Character is 1.7 m tall; blades at 40 % = ~0.68 m
const BLADE_H_MIN = 0.50;
const BLADE_H_MAX = 0.78;

const PUSH_RADIUS   = 2.8;   // metres — grass parts around character
const PUSH_STRENGTH = 0.65;  // metres of max tip displacement

// ─── Blade geometry: 5-vertex tapered ribbon ─────────────────────────────────
//   v4 (tip)
//   v2 v3 (midpoint)
//   v0 v1 (base)
// position.y = normalised height [0..1]

const BLADE_VERTS = new Float32Array([
  -0.05,  0.0,  0.0,   // v0 base-left
   0.05,  0.0,  0.0,   // v1 base-right
  -0.025, 0.5,  0.0,   // v2 mid-left
   0.025, 0.5,  0.0,   // v3 mid-right
   0.0,   1.0,  0.0,   // v4 tip
]);
const BLADE_IDX = new Uint16Array([0,1,3, 0,3,2, 2,3,4]);

// ─── Shaders ─────────────────────────────────────────────────────────────────

// TERRAIN_GLSL is prepended at shader construction time (see buildMaterial below)
const VERT_BODY = /* glsl */`
  // Per-instance attributes
  attribute vec2  aOffset;    // blade root XZ in chunk-local [0, CHUNK_SIZE]
  attribute float aRot;       // random Y-axis rotation (radians)
  attribute float aScale;     // height scale [0..1]
  attribute float aLean;      // lean seed [0..1]
  attribute float aColorVar;  // colour variation [-1..1]

  uniform float uTime;
  uniform vec3  uSunDir;      // normalised direction toward sun
  uniform vec3  uCharPos;     // character world-space position
  uniform float uPushRadius;

  varying float vHeight;
  varying float vColorVar;
  varying float vAo;
  varying float vDiffuse;
  varying float vSSS;

  void main() {
    float h = position.y;  // 0 = base, 1 = tip

    // ── Blade height ─────────────────────────────────────────────────────────
    float bladeH = ${BLADE_H_MIN.toFixed(2)} + aScale * ${(BLADE_H_MAX - BLADE_H_MIN).toFixed(2)};

    // ── Rotate blade around Y ──────────────────────────────────────────────────
    float c = cos(aRot);
    float s = sin(aRot);
    float bx = position.x * c;
    float bz = position.x * s;

    // ── Chunk-local position of vertex ─────────────────────────────────────────
    // ── Terrain height at blade root ──────────────────────────────────────────
    // Compute world XZ of the blade base (before any wind/lean) to sample terrain.
    vec2 baseWorld = (modelMatrix * vec4(aOffset.x, 0.0, aOffset.y, 1.0)).xz;
    float tH = terrainH(baseWorld);

    vec3 lp = vec3(aOffset.x + bx, h * bladeH + tH, aOffset.y + bz);

    // ── World XZ for wind & interaction sampling ──────────────────────────────
    vec2 worldXZ = (modelMatrix * vec4(lp, 1.0)).xz;

    // ── Pre-baked lean (per-blade random tilt) ────────────────────────────────
    float leanAngle = aLean * 6.2832;
    float leanAmt   = fract(aLean * 9.73) * 0.16 * h * h;
    lp.x += cos(leanAngle) * leanAmt;
    lp.z += sin(leanAngle) * leanAmt;

    // ── Forward curve: blade arches toward its face direction ─────────────────
    float curve = h * h * 0.11;
    lp.x += (-s) * curve;
    lp.z += ( c) * curve;

    // ── Multi-octave wind ──────────────────────────────────────────────────────
    float t   = uTime;
    float wx  = worldXZ.x;
    float wz  = worldXZ.y;
    float wind = sin( wx * 0.07  + t * 1.30) * 0.90
               + cos( wz * 0.09  + t * 1.75) * 0.70
               + sin( wx * 0.20  + wz * 0.14 + t * 2.60) * 0.35
               + cos( wx * 0.31  + t * 3.30  + aRot)      * 0.20;
    wind *= h * h * 0.12;
    lp.x += wind * c;
    lp.z += wind * s;

    // ── Character push + spring-ripple wiggle ─────────────────────────────────
    vec2  toChar   = worldXZ - uCharPos.xz;
    float charDist = length(toChar);
    float proximity = smoothstep(uPushRadius, 0.0, charDist);
    vec2  pushDir   = charDist > 0.01 ? toChar / charDist : vec2(1.0, 0.0);

    // Outward ripple decays exponentially with distance — gives spring-back feel
    float bladeSeed  = fract(worldXZ.x * 0.374 + worldXZ.y * 0.657);
    float ripplePhase = charDist * 3.5 - t * 9.0 + bladeSeed * 6.2832;
    float ripple      = sin(ripplePhase) * proximity * exp(-charDist * 0.14);

    vec2 charDisp = pushDir * (proximity * ${PUSH_STRENGTH.toFixed(2)} + ripple * 0.28);
    lp.x += charDisp.x * h * h;
    lp.z += charDisp.y * h * h;

    // ── Lighting varyings ──────────────────────────────────────────────────────
    // Approximate normal: perpendicular to blade face after Y rotation
    vec3 N = normalize(vec3(-s, 0.25 + h * 0.25, c));
    vDiffuse = max(0.0, dot(N, normalize(uSunDir)));

    // Fake SSS: backlit glow (sun → viewer through thin blade)
    // cameraPosition is a Three.js built-in
    vec4 worldPos4 = modelMatrix * vec4(lp, 1.0);
    vec3 toView    = normalize(cameraPosition - worldPos4.xyz);
    float backlit  = max(0.0, dot(normalize(uSunDir), toView));
    vSSS           = pow(backlit, 5.0) * h * 0.55;

    // Fake AO: smoothstep darkening at base
    vAo       = smoothstep(0.0, 0.45, h);
    vHeight   = h;
    vColorVar = aColorVar;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(lp, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uColorTip;
  uniform vec3  uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3  uSunColor;

  varying float vHeight;
  varying float vColorVar;
  varying float vAo;
  varying float vDiffuse;
  varying float vSSS;

  void main() {
    // Colour gradient: dark soil-tinted base → bright green tip with variation
    vec3 base = vec3(0.04, 0.13, 0.01);
    vec3 tip  = uColorTip * (1.0 + vColorVar * 0.22);
    vec3 col  = mix(base, tip, vHeight);

    // Fake AO at base (smoothstep from black)
    col *= 0.30 + vAo * 0.70;

    // Lambert diffuse + ambient fill
    col *= 0.35 + vDiffuse * 0.65;

    // Subsurface scattering: warm yellow-green glow when backlit
    col += vSSS * vec3(0.55, 0.95, 0.25) * uSunColor;

    // Fog
    float depth = gl_FragCoord.z / gl_FragCoord.w;
    float fog   = smoothstep(uFogNear, uFogFar, depth);
    col = mix(col, uFogColor, fog);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ─── Seeded RNG ───────────────────────────────────────────────────────────────

function seededRandom(seed: number): () => number {
  let s = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) | 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) | 0;
    s = Math.imul(s ^ (s >>> 11), 0x27d4eb2f) | 0;
    return (s >>> 0) / 0xffffffff;
  };
}

// ─── GrassChunk ───────────────────────────────────────────────────────────────

class GrassChunk {
  readonly mesh: THREE.Mesh;

  private readonly offsets:   Float32Array;
  private readonly rotations: Float32Array;
  private readonly scales:    Float32Array;
  private readonly leans:     Float32Array;
  private readonly colorVars: Float32Array;

  assignedCX = NaN;
  assignedCZ = NaN;

  constructor(material: THREE.ShaderMaterial) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = BLADES_PER_CHUNK;

    geo.setAttribute('position', new THREE.BufferAttribute(BLADE_VERTS.slice(), 3));
    geo.setIndex(new THREE.BufferAttribute(BLADE_IDX.slice(), 1));

    this.offsets   = new Float32Array(BLADES_PER_CHUNK * 2);
    this.rotations = new Float32Array(BLADES_PER_CHUNK);
    this.scales    = new Float32Array(BLADES_PER_CHUNK);
    this.leans     = new Float32Array(BLADES_PER_CHUNK);
    this.colorVars = new Float32Array(BLADES_PER_CHUNK);

    geo.setAttribute('aOffset',   new THREE.InstancedBufferAttribute(this.offsets,   2));
    geo.setAttribute('aRot',      new THREE.InstancedBufferAttribute(this.rotations, 1));
    geo.setAttribute('aScale',    new THREE.InstancedBufferAttribute(this.scales,    1));
    geo.setAttribute('aLean',     new THREE.InstancedBufferAttribute(this.leans,     1));
    geo.setAttribute('aColorVar', new THREE.InstancedBufferAttribute(this.colorVars, 1));

    // Fixed local bounding sphere: covers the whole chunk + max displacement
    const r = Math.sqrt(2) * CHUNK_SIZE / 2 + BLADE_H_MAX + 1.5;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK_SIZE / 2, BLADE_H_MAX / 2, CHUNK_SIZE / 2), r,
    );

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = true;
    this.mesh.visible = false;
  }

  /** Activate this chunk at world chunk coordinates (cx, cz). */
  assign(cx: number, cz: number): void {
    if (cx === this.assignedCX && cz === this.assignedCZ) {
      this.mesh.visible = true;
      return;
    }
    this.assignedCX = cx;
    this.assignedCZ = cz;

    // Seed instance data from chunk coordinate — deterministic, no popping
    const rng = seededRandom(cx * 73856093 ^ cz * 19349663);
    for (let i = 0; i < BLADES_PER_CHUNK; i++) {
      this.offsets[i * 2    ] = rng() * CHUNK_SIZE;
      this.offsets[i * 2 + 1] = rng() * CHUNK_SIZE;
      this.rotations[i] = rng() * Math.PI * 2;
      this.scales[i]    = rng();
      this.leans[i]     = rng();
      this.colorVars[i] = rng() * 2 - 1;
    }

    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    for (const name of ['aOffset','aRot','aScale','aLean','aColorVar']) {
      (geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }

    this.mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.mesh.visible = true;
  }

  deactivate(): void {
    this.mesh.visible = false;
  }
}

// ─── GrassField ───────────────────────────────────────────────────────────────

export class GrassField {
  private readonly mat: THREE.ShaderMaterial;
  private readonly pool: GrassChunk[] = [];
  private readonly active = new Map<string, GrassChunk>();   // "cx,cz" → chunk

  private lastCamCX = NaN;
  private lastCamCZ = NaN;

  constructor(
    scene: THREE.Scene,
    fogColor: THREE.Color,
    fogNear: number,
    fogFar: number,
    sunDir: THREE.Vector3,
  ) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:       { value: 0 },
        uSunDir:     { value: sunDir.clone() },
        uCharPos:    { value: new THREE.Vector3() },
        uPushRadius: { value: PUSH_RADIUS },
        uColorTip:   { value: new THREE.Color(0x4aaa18) },
        uFogColor:   { value: fogColor.clone() },
        uFogNear:    { value: fogNear },
        uFogFar:     { value: fogFar },
        uSunColor:   { value: new THREE.Color(0xfff5cc) },
      },
      vertexShader:   TERRAIN_GLSL + VERT_BODY,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });

    // Pre-allocate pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const chunk = new GrassChunk(this.mat);
      scene.add(chunk.mesh);
      this.pool.push(chunk);
    }
  }

  update(dt: number, camPos: THREE.Vector3, charPos: THREE.Vector3): void {
    this.mat.uniforms.uTime.value    += dt;
    this.mat.uniforms.uCharPos.value.copy(charPos);

    const camCX = Math.floor(camPos.x / CHUNK_SIZE);
    const camCZ = Math.floor(camPos.z / CHUNK_SIZE);

    if (camCX === this.lastCamCX && camCZ === this.lastCamCZ) return;
    this.lastCamCX = camCX;
    this.lastCamCZ = camCZ;

    // Build desired set of chunk keys (circle)
    const desired = new Set<string>();
    const R = CULL_CHUNKS;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dz * dz <= R * R) {
          desired.add(`${camCX + dx},${camCZ + dz}`);
        }
      }
    }

    // Return out-of-range chunks to pool
    for (const [key, chunk] of this.active) {
      if (!desired.has(key)) {
        chunk.deactivate();
        this.pool.push(chunk);
        this.active.delete(key);
      }
    }

    // Activate newly visible chunks
    for (const key of desired) {
      if (this.active.has(key)) continue;
      const chunk = this.pool.pop();
      if (!chunk) break;   // pool exhausted (shouldn't happen with correct POOL_SIZE)
      const [cx, cz] = key.split(',').map(Number);
      chunk.assign(cx, cz);
      this.active.set(key, chunk);
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const chunk of [...this.pool, ...this.active.values()]) {
      chunk.deactivate();
      chunk.mesh.geometry.dispose();
      scene.remove(chunk.mesh);
    }
    this.mat.dispose();
  }
}
