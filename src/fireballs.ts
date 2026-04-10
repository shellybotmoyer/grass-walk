import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FIREBALL_SPEED    = 26;      // m/s launch speed
const FIREBALL_GRAVITY  = -20;     // m/s² (stronger than world gravity for satisfying arc)
const FIREBALL_RADIUS   = 0.14;    // metres, visual size
const MAX_FIREBALLS     = 6;       // cap simultaneous projectiles
const MAX_LIFETIME      = 8;       // auto-despawn after this many seconds
const SPARK_COUNT       = 120;     // particles per explosion
const EXPLOSION_MAX_AGE = 1.6;     // seconds the spark burst lives

// ─── Spark shaders ────────────────────────────────────────────────────────────

const SPARK_VERT = /* glsl */`
  attribute vec3 aVelocity;

  uniform float uAge;

  varying float vLife;

  void main() {
    // Ballistic integration: p = origin + v*t + 0.5*g*t²
    float t      = uAge;
    vec3 worldPos = position
                  + aVelocity * t
                  + vec3(0.0, -12.0 * t * t, 0.0);

    vLife = clamp(1.0 - t / ${EXPLOSION_MAX_AGE.toFixed(1)}, 0.0, 1.0);
    vLife = vLife * vLife;   // quadratic fade

    vec4 mvPos   = modelViewMatrix * vec4(worldPos, 1.0);
    gl_PointSize = max(0.0, (90.0 / -mvPos.z) * (0.35 + vLife * 0.65));
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const SPARK_FRAG = /* glsl */`
  varying float vLife;

  void main() {
    if (vLife < 0.005) discard;

    vec2  uv   = gl_PointCoord - 0.5;
    float dist = length(uv) * 2.0;

    float core = 1.0 - smoothstep(0.0, 0.45, dist);
    float halo = 1.0 - smoothstep(0.3,  1.0,  dist);

    // White-hot centre → orange → dark red at edge
    vec3 col = mix(
      vec3(0.95, 0.35, 0.0),   // orange outer
      vec3(1.0,  0.95, 0.5),   // near-white hot core
      core
    );
    col *= 3.2;   // overbright for bloom

    float alpha   = (core * 0.9 + halo * 0.35) * vLife;
    gl_FragColor  = vec4(col, alpha);
  }
`;

// ─── Internal types ───────────────────────────────────────────────────────────

interface FireballEntry {
  mesh:     THREE.Mesh;
  light:    THREE.PointLight;
  velocity: THREE.Vector3;
  age:      number;
}

interface ExplosionEntry {
  points: THREE.Points;
  mat:    THREE.ShaderMaterial;
  age:    number;
}

// ─── FireballSystem ───────────────────────────────────────────────────────────

export class FireballSystem {
  private readonly scene:      THREE.Scene;
  private readonly fireballs:  FireballEntry[]  = [];
  private readonly explosions: ExplosionEntry[] = [];

  // Shared fireball material — bright emissive so bloom catches it
  private readonly fbMat: THREE.MeshStandardMaterial;
  private readonly fbGeo: THREE.SphereGeometry;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.fbGeo = new THREE.SphereGeometry(FIREBALL_RADIUS, 8, 6);
    this.fbMat = new THREE.MeshStandardMaterial({
      color:             new THREE.Color(1.0, 0.45, 0.0),
      emissive:          new THREE.Color(1.0, 0.30, 0.0),
      emissiveIntensity: 5.0,
      roughness:         1.0,
      metalness:         0.0,
    });
  }

  /**
   * Launch a fireball from `origin` traveling in direction `dir` (normalised).
   * Call this from main.ts when the player fires.
   */
  shoot(origin: THREE.Vector3, dir: THREE.Vector3): void {
    // Evict the oldest fireball when at cap
    if (this.fireballs.length >= MAX_FIREBALLS) {
      const oldest = this.fireballs.shift()!;
      this._despawnFireball(oldest);
    }

    const mesh  = new THREE.Mesh(this.fbGeo, this.fbMat);
    mesh.position.copy(origin);

    // Dynamic light travels with the mesh — illuminates nearby grass
    const light = new THREE.PointLight(0xff6600, 12, 14, 2);
    mesh.add(light);

    this.scene.add(mesh);

    this.fireballs.push({
      mesh,
      light,
      velocity: dir.clone().multiplyScalar(FIREBALL_SPEED),
      age: 0,
    });
  }

  update(dt: number): void {
    // ── Fireballs ─────────────────────────────────────────────────────────
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const fb = this.fireballs[i];

      fb.age += dt;
      fb.velocity.y += FIREBALL_GRAVITY * dt;
      fb.mesh.position.addScaledVector(fb.velocity, dt);

      // Dim the light as it ages (flicker effect)
      fb.light.intensity = 12 * (0.8 + Math.sin(fb.age * 40) * 0.2);

      const th = terrainHeight(fb.mesh.position.x, fb.mesh.position.z);
      const hitGround = fb.mesh.position.y <= th + FIREBALL_RADIUS;
      const expired   = fb.age > MAX_LIFETIME;

      if (hitGround || expired) {
        if (hitGround) {
          fb.mesh.position.y = th + FIREBALL_RADIUS;
          this._spawnExplosion(fb.mesh.position);
        }
        this._despawnFireball(fb);
        this.fireballs.splice(i, 1);
      }
    }

    // ── Explosions ────────────────────────────────────────────────────────
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i];
      ex.age += dt;
      ex.mat.uniforms.uAge.value = ex.age;

      if (ex.age >= EXPLOSION_MAX_AGE) {
        this.scene.remove(ex.points);
        ex.points.geometry.dispose();
        ex.mat.dispose();
        this.explosions.splice(i, 1);
      }
    }
  }

  private _despawnFireball(fb: FireballEntry): void {
    this.scene.remove(fb.mesh);
    // geometry and material are shared — don't dispose them here
  }

  private _spawnExplosion(pos: THREE.Vector3): void {
    const origins    = new Float32Array(SPARK_COUNT * 3);
    const velocities = new Float32Array(SPARK_COUNT * 3);

    for (let i = 0; i < SPARK_COUNT; i++) {
      // All sparks originate at the impact point
      origins[i * 3    ] = pos.x;
      origins[i * 3 + 1] = pos.y;
      origins[i * 3 + 2] = pos.z;

      // Hemispherical burst — bias upward so sparks arc visibly
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.random() * Math.PI * 0.72;   // 0=straight up, 0.72π≈130° spread
      const speed = 4 + Math.random() * 11;
      velocities[i * 3    ] = Math.sin(phi) * Math.cos(theta) * speed;
      velocities[i * 3 + 1] = Math.cos(phi) * speed;
      velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',  new THREE.BufferAttribute(origins,    3));
    geo.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    geo.boundingSphere = new THREE.Sphere(pos.clone(), 25);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uAge: { value: 0 },
      },
      vertexShader:   SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;   // bounding sphere shifts as sparks spread
    this.scene.add(points);

    // Brief flash PointLight at impact
    const flash = new THREE.PointLight(0xff8800, 40, 20, 2);
    flash.position.copy(pos);
    this.scene.add(flash);
    // Remove flash after two frames
    let frames = 0;
    const removeFlash = () => {
      if (++frames >= 3) this.scene.remove(flash);
      else requestAnimationFrame(removeFlash);
    };
    requestAnimationFrame(removeFlash);

    this.explosions.push({ points, mat, age: 0 });
  }

  dispose(): void {
    for (const fb of this.fireballs) this._despawnFireball(fb);
    for (const ex of this.explosions) {
      this.scene.remove(ex.points);
      ex.points.geometry.dispose();
      ex.mat.dispose();
    }
    this.fbGeo.dispose();
    this.fbMat.dispose();
  }
}
