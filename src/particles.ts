import * as THREE from 'three';
import { TERRAIN_GLSL } from './terrain.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FIREFLY_COUNT = 180;
const FIREFLY_TILE  = 60.0;   // snapping tile radius — stays inside fog

// ─── Shaders ─────────────────────────────────────────────────────────────────

const FF_VERT = /* glsl */`
  attribute vec2  aOffset;    // XZ in [0, FIREFLY_TILE]
  attribute float aPhase;     // individual blink phase
  attribute float aBlinkSpeed;// blink Hz ×2π
  attribute float aHoverH;    // resting height above terrain (0.3–1.5 m)
  attribute float aHoverSpeed;// bob speed

  uniform float uTime;
  uniform float uTileSize;
  uniform vec3  uCamPos;
  uniform float uBrightScale; // 0=day invisible, 1=full night brightness

  varying float vBrightness;

  void main() {
    // Tile snap — fireflies follow camera like grass
    vec2 tileOrigin = floor(uCamPos.xz / uTileSize) * uTileSize;
    vec2 worldXZ    = tileOrigin + aOffset;

    // Terrain height at firefly position
    float th = terrainH(worldXZ);

    // Gentle vertical bob
    float bob = sin(uTime * aHoverSpeed + aPhase) * 0.12;

    vec3 worldPos = vec3(worldXZ.x, th + aHoverH + bob, worldXZ.y);

    // Blink: power curve so it's off most of the time, flashes brightly
    float raw = sin(uTime * aBlinkSpeed + aPhase);
    vBrightness = pow(max(0.0, raw), 6.0) * uBrightScale;

    vec4 mvPos    = modelViewMatrix * vec4(worldPos, 1.0);
    // Perspective point size; invisible when brightness ≈ 0
    gl_PointSize  = max(0.0, (80.0 / -mvPos.z) * (0.3 + vBrightness * 0.7));
    gl_Position   = projectionMatrix * mvPos;
  }
`;

const FF_FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform vec3  uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vBrightness;

  void main() {
    if (vBrightness < 0.01) discard;

    // Soft circular glow — bright centre, smooth falloff
    vec2  uv   = gl_PointCoord - 0.5;
    float dist = length(uv) * 2.0;   // 0=centre, 1=edge
    float core = 1.0 - smoothstep(0.0, 0.45, dist);
    float halo = 1.0 - smoothstep(0.2, 1.0,  dist);
    float mask = core * 0.9 + halo * 0.4;

    vec3  col     = uColor * mask * vBrightness * 4.0;
    float alpha   = mask * vBrightness;

    // Fog
    float depth = gl_FragCoord.z / gl_FragCoord.w;
    float fog   = smoothstep(uFogNear, uFogFar, depth);
    col   = mix(col, uFogColor, fog);
    alpha *= (1.0 - fog * 0.8);

    gl_FragColor = vec4(col, alpha);
  }
`;

// ─── FireflySystem ────────────────────────────────────────────────────────────

export class FireflySystem {
  private readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;

  constructor(
    scene: THREE.Scene,
    fogColor: THREE.Color,
    fogNear: number,
    fogFar: number,
  ) {
    const geo = new THREE.BufferGeometry();

    const offsets    = new Float32Array(FIREFLY_COUNT * 2);
    const phases     = new Float32Array(FIREFLY_COUNT);
    const blinkSpeeds = new Float32Array(FIREFLY_COUNT);
    const hoverHs    = new Float32Array(FIREFLY_COUNT);
    const hoverSpeeds = new Float32Array(FIREFLY_COUNT);

    for (let i = 0; i < FIREFLY_COUNT; i++) {
      offsets[i * 2    ] = Math.random() * FIREFLY_TILE;
      offsets[i * 2 + 1] = Math.random() * FIREFLY_TILE;
      phases[i]      = Math.random() * Math.PI * 2;
      blinkSpeeds[i] = (2.5 + Math.random() * 4.0) * Math.PI;  // 1.25–3.25 blinks/s
      hoverHs[i]     = 0.3 + Math.random() * 1.2;              // 0.3–1.5 m above ground
      hoverSpeeds[i] = 0.4 + Math.random() * 0.6;
    }

    geo.setAttribute('aOffset',     new THREE.BufferAttribute(offsets,     2));
    geo.setAttribute('aPhase',      new THREE.BufferAttribute(phases,      1));
    geo.setAttribute('aBlinkSpeed', new THREE.BufferAttribute(blinkSpeeds, 1));
    geo.setAttribute('aHoverH',     new THREE.BufferAttribute(hoverHs,     1));
    geo.setAttribute('aHoverSpeed', new THREE.BufferAttribute(hoverSpeeds, 1));

    // Large bounding sphere so the Points object is never frustum-culled
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIREFLY_TILE * 2);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:        { value: 0 },
        uTileSize:    { value: FIREFLY_TILE },
        uCamPos:      { value: new THREE.Vector3() },
        uColor:       { value: new THREE.Color(0xccff44) },  // yellow-green firefly glow
        uBrightScale: { value: 0.15 },                       // dim by default, night drives to 1
        uFogColor:    { value: fogColor.clone() },
        uFogNear:     { value: fogNear },
        uFogFar:      { value: fogFar },
      },
      vertexShader:   TERRAIN_GLSL + FF_VERT,
      fragmentShader: FF_FRAG,
      transparent:    true,
      depthWrite:     false,   // additive-style; don't write to depth
      blending:       THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.matrix.identity();
    scene.add(this.points);
  }

  update(dt: number, camPos: THREE.Vector3, nightFactor = 0.15): void {
    this.mat.uniforms.uTime.value    += dt;
    this.mat.uniforms.uCamPos.value.copy(camPos);
    this.mat.uniforms.uBrightScale.value = nightFactor;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
