import * as THREE from 'three';
import { SkySystem } from './sky.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Real seconds per full day cycle. */
const DAY_DURATION_SECS = 300;   // 5 real minutes = 1 game day
const DEG_PER_SEC = 360 / DAY_DURATION_SECS;

// Sun light colours
const COL_DAY_SUN     = new THREE.Color(0xffe090);   // warm midday
const COL_GOLDEN_SUN  = new THREE.Color(0xff9944);   // golden hour

// Hemi sky/ground colours
const HEMI_SKY_DAY    = new THREE.Color(0xd4eaf8);
const HEMI_SKY_NIGHT  = new THREE.Color(0x0d1a2b);
const HEMI_GND_DAY    = new THREE.Color(0x1e3a06);
const HEMI_GND_NIGHT  = new THREE.Color(0x040a0a);

const STAR_COUNT = 2200;
const STAR_RADIUS = 190_000;
const MOON_RADIUS = 7_500;
const MOON_DIST   = 190_000;

// ─── Star shaders ─────────────────────────────────────────────────────────────

const STAR_VERT = /* glsl */`
  attribute float aMag;    // apparent magnitude scale (0.3–1.0)
  attribute float aPhase;  // individual twinkle phase

  uniform float uTime;
  uniform float uAlpha;

  varying float vBright;

  void main() {
    float twinkle = 0.55 + 0.45 * sin(uTime * 1.6 + aPhase);
    vBright = aMag * twinkle * uAlpha;

    // Fixed pixel size — stars are pinpoints regardless of distance
    gl_PointSize = aMag * 2.2;
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAG = /* glsl */`
  varying float vBright;

  void main() {
    if (vBright < 0.005) discard;

    vec2  uv   = gl_PointCoord - 0.5;
    float d    = length(uv) * 2.0;
    float disc = 1.0 - smoothstep(0.0, 1.0, d);

    // Cool white-blue star tint
    vec3 col = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 1.0, 1.0), disc);
    gl_FragColor = vec4(col * 3.0, disc * vBright);
  }
`;

// ─── DayNightCycle ────────────────────────────────────────────────────────────

export class DayNightCycle {
  /**
   * Time of day in degrees.
   * 0 = dawn (sun on horizon rising), 90 = noon, 180 = dusk, 270 = midnight.
   */
  private _time = 50;   // start at early morning golden hour

  private readonly sky:      SkySystem;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemi:     THREE.HemisphereLight;
  private readonly scene:    THREE.Scene;

  // Stars
  private readonly starPoints: THREE.Points;
  private readonly starMat:    THREE.ShaderMaterial;

  // Moon
  private readonly moonMesh: THREE.Mesh;
  private readonly moonMat:  THREE.MeshStandardMaterial;
  private readonly _moonPos  = new THREE.Vector3();

  constructor(
    sky:       SkySystem,
    sunLight:  THREE.DirectionalLight,
    hemi:      THREE.HemisphereLight,
    scene:     THREE.Scene,
  ) {
    this.sky      = sky;
    this.sunLight = sunLight;
    this.hemi     = hemi;
    this.scene    = scene;

    this.starPoints = this._buildStars();
    this.starMat    = this.starPoints.material as THREE.ShaderMaterial;
    scene.add(this.starPoints);

    ({ mesh: this.moonMesh, mat: this.moonMat } = this._buildMoon());
    scene.add(this.moonMesh);

    // Initial sky position
    this.sky.setTime(this.elevation, this._azimuth);
  }

  update(dt: number, fog: THREE.Fog | THREE.FogExp2): void {
    this._time = (this._time + DEG_PER_SEC * dt) % 360;

    const elev  = this.elevation;
    const azim  = this._azimuth;
    const eRad  = THREE.MathUtils.degToRad(elev);

    // ── Sky ────────────────────────────────────────────────────────────────
    this.sky.setTime(elev, azim);

    // ── Sun light ──────────────────────────────────────────────────────────
    const sunFactor = Math.max(0, Math.sin(eRad));
    // Colour: warm golden at low angle, whiter at zenith
    const colT = Math.max(0, Math.min(1, (elev - 4) / 30));
    this.sunLight.color.lerpColors(COL_GOLDEN_SUN, COL_DAY_SUN, colT);
    this.sunLight.intensity = sunFactor * 3.2;

    // ── Hemisphere light ───────────────────────────────────────────────────
    const hemiT = Math.max(0, Math.min(1, (elev + 10) / 20));
    this.hemi.color.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, hemiT);
    this.hemi.groundColor.lerpColors(HEMI_GND_NIGHT, HEMI_GND_DAY, hemiT);
    this.hemi.intensity = 0.12 + sunFactor * 0.78;

    // ── Fog colour ─────────────────────────────────────────────────────────
    fog.color.copy(this.sky.horizonColor);

    // ── Stars ──────────────────────────────────────────────────────────────
    // Fade in below elevation 8°, full at -3°
    const starAlpha = Math.max(0, Math.min(1, -(elev - 8) / 11));
    this.starMat.uniforms.uTime.value  += dt;
    this.starMat.uniforms.uAlpha.value  = starAlpha;
    this.starPoints.visible = starAlpha > 0.01;

    // ── Moon ───────────────────────────────────────────────────────────────
    // Moon is opposite the sun in azimuth, mirrored in elevation
    const moonElev = -elev;
    const moonAzim = (azim + 180) % 360;
    const mPhi     = THREE.MathUtils.degToRad(90 - moonElev);
    const mTheta   = THREE.MathUtils.degToRad(moonAzim);
    this._moonPos.setFromSphericalCoords(MOON_DIST, mPhi, mTheta);
    this.moonMesh.position.copy(this._moonPos);
    this.moonMesh.visible = moonElev > -8;
    if (this.moonMesh.visible) {
      const moonVis = Math.max(0, Math.min(1, (moonElev + 8) / 15));
      this.moonMat.emissiveIntensity = moonVis * 2.5;
    }
  }

  /** Sun elevation in degrees (positive = above horizon, negative = below). */
  get elevation(): number {
    // Sinusoidal arc: peaks at 90° (noon) and troughs at -90° (midnight)
    return Math.sin(THREE.MathUtils.degToRad(this._time)) * 86;
  }

  /** 0 = full day, 1 = full night. */
  get nightFactor(): number {
    return Math.max(0, Math.min(1, -this.elevation / 25 + 0.1));
  }

  /** Azimuth follows the sun's path east→south→west. */
  private get _azimuth(): number {
    return (180 + this._time * 0.35) % 360;
  }

  // ── Private builders ────────────────────────────────────────────────────────

  private _buildStars(): THREE.Points {
    const positions = new Float32Array(STAR_COUNT * 3);
    const mags      = new Float32Array(STAR_COUNT);
    const phases    = new Float32Array(STAR_COUNT);

    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform sphere distribution
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      positions[i * 3    ] = Math.sin(phi) * Math.cos(theta) * STAR_RADIUS;
      positions[i * 3 + 1] = Math.cos(phi)                   * STAR_RADIUS;
      positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * STAR_RADIUS;

      // 80% dim stars, 20% brighter ones
      mags[i]   = Math.random() < 0.8 ? 0.25 + Math.random() * 0.35
                                      : 0.65 + Math.random() * 0.35;
      phases[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aMag',     new THREE.BufferAttribute(mags,      1));
    geo.setAttribute('aPhase',   new THREE.BufferAttribute(phases,    1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:  { value: 0 },
        uAlpha: { value: 0 },
      },
      vertexShader:   STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent:    true,
      depthTest:      false,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder   = 1;   // draw after the sky dome
    pts.visible       = false;
    return pts;
  }

  private _buildMoon(): { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial } {
    const geo = new THREE.SphereGeometry(MOON_RADIUS, 14, 10);
    const mat = new THREE.MeshStandardMaterial({
      color:             new THREE.Color(0xd8dde8),
      emissive:          new THREE.Color(0xd0d8e8),
      emissiveIntensity: 0,
      roughness:         1.0,
      metalness:         0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    return { mesh, mat };
  }

  dispose(): void {
    this.scene.remove(this.starPoints);
    this.starPoints.geometry.dispose();
    this.starMat.dispose();
    this.scene.remove(this.moonMesh);
    this.moonMesh.geometry.dispose();
    this.moonMat.dispose();
  }
}
