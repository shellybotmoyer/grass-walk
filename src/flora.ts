import * as THREE from 'three';
import { TERRAIN_GLSL } from './terrain.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Side of the repeating flora tile.  Must be > 2× fog far so the snap is hidden. */
const TILE_SIZE     = 200.0;
const FLOWER_COUNT  = 3_000;   // wildflowers per tile
const POPPY_COUNT   = 800;     // red poppies per tile

// ─── Flower geometry: two crossed vertical quads (billboard cross) ─────────────
//
//   Each "petal" is a thin upright rect:  (−w, 0, 0) → (w, h, 0)
//   Two quads rotated 90° form a cross visible from all angles.
//
//   12 vertices: 4 per face × 3 faces (cross + one diagonal = a bit richer)
//   Using 2 faces only for perf: 8 verts, 4 triangles

function buildCrossGeometry(width: number, height: number): THREE.BufferGeometry {
  const hw = width * 0.5;
  // Quad 1: in XY plane (faces Z)
  // Quad 2: in ZY plane (faces X)
  const verts = new Float32Array([
    // Quad 1 — blade along X axis
    -hw, 0,      0,   // 0
     hw, 0,      0,   // 1
     hw, height, 0,   // 2
    -hw, height, 0,   // 3
    // Quad 2 — blade along Z axis
     0,  0,     -hw,  // 4
     0,  0,      hw,  // 5
     0,  height, hw,  // 6
     0,  height,-hw,  // 7
  ]);
  const uvs = new Float32Array([
    0,0, 1,0, 1,1, 0,1,
    0,0, 1,0, 1,1, 0,1,
  ]);
  const idx = new Uint16Array([
    0,1,2, 0,2,3,   // quad 1 front
    3,2,1, 3,1,0,   // quad 1 back
    4,5,6, 4,6,7,   // quad 2 front
    7,6,5, 7,5,4,   // quad 2 back
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,   2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// ─── Shared vertex shader ─────────────────────────────────────────────────────

const VERT_BODY = /* glsl */`
  attribute vec2  aOffset;   // XZ in [0, TILE_SIZE]
  attribute float aRot;      // random Y rotation
  attribute float aScale;    // height scale [0..1]

  uniform float uTime;
  uniform float uTileSize;
  uniform vec3  uCamPos;

  varying float vY;  // normalised 0-1 height for colour blend

  void main() {
    float h = position.y;  // 0=base, 1=top of cross

    // Tile snap to camera (same trick as grass)
    vec2 tileOrigin = floor(uCamPos.xz / uTileSize) * uTileSize;
    vec2 worldXZ    = tileOrigin + aOffset;

    // Random Y rotation of the cross
    float c = cos(aRot), s = sin(aRot);
    float rx = position.x * c - position.z * s;
    float rz = position.x * s + position.z * c;

    // Height scale: 0.25 – 0.55 m
    float stemH = 0.25 + aScale * 0.30;

    // Gentle sway at the top only
    float sway  = sin(worldXZ.x * 0.15 + worldXZ.y * 0.11 + uTime * 1.2) * 0.06;
    float swayX = sway * h * h;
    float swayZ = cos(worldXZ.x * 0.13 + uTime * 1.5) * 0.04 * h * h;

    vec3 worldPos = vec3(
      worldXZ.x + rx + swayX,
      h * stemH + terrainH(worldXZ),
      worldXZ.y + rz + swayZ
    );

    vY = h;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

// ─── Per-species fragment shader ──────────────────────────────────────────────

function buildFrag(stemColor: string, petalColor: string): string {
  return /* glsl */`
    uniform vec3  uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;

    varying float vY;

    void main() {
      vec3 stem  = vec3(${stemColor});
      vec3 petal = vec3(${petalColor});

      // Bottom 30 % = stem, rest = petal
      float t   = smoothstep(0.25, 0.55, vY);
      vec3  col = mix(stem, petal, t);

      // Slight AO at base
      col *= 0.55 + vY * 0.45;

      // Fog
      float depth = gl_FragCoord.z / gl_FragCoord.w;
      float fog   = smoothstep(uFogNear, uFogFar, depth);
      col = mix(col, uFogColor, fog);

      gl_FragColor = vec4(col, 1.0);
    }
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMaterial(
  fragSrc: string,
  fogColor: THREE.Color,
  fogNear: number,
  fogFar: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:     { value: 0 },
      uTileSize: { value: TILE_SIZE },
      uCamPos:   { value: new THREE.Vector3() },
      uFogColor: { value: fogColor.clone() },
      uFogNear:  { value: fogNear },
      uFogFar:   { value: fogFar },
    },
    vertexShader:   TERRAIN_GLSL + VERT_BODY,
    fragmentShader: fragSrc,
    side: THREE.DoubleSide,
  });
}

function buildInstancedMesh(
  count: number,
  geo: THREE.BufferGeometry,
  mat: THREE.ShaderMaterial,
  seed: number,
): THREE.Mesh {
  const offsets = new Float32Array(count * 2);
  const rots    = new Float32Array(count);
  const scales  = new Float32Array(count);

  // Simple seeded LCG so flowers stay in consistent spots
  let s = seed | 0;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };

  for (let i = 0; i < count; i++) {
    offsets[i * 2    ] = rng() * TILE_SIZE;
    offsets[i * 2 + 1] = rng() * TILE_SIZE;
    rots[i]   = rng() * Math.PI * 2;
    scales[i] = rng();
  }

  const instancedGeo = new THREE.InstancedBufferGeometry();
  instancedGeo.instanceCount = count;

  // Copy base geometry attributes
  for (const [name, attr] of Object.entries(geo.attributes)) {
    instancedGeo.setAttribute(name, attr);
  }
  if (geo.index) instancedGeo.setIndex(geo.index);

  instancedGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
  instancedGeo.setAttribute('aRot',    new THREE.InstancedBufferAttribute(rots,    1));
  instancedGeo.setAttribute('aScale',  new THREE.InstancedBufferAttribute(scales,  1));

  // Fixed bounding sphere — large enough to cover the tile (culling off is fine for tiles)
  instancedGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), TILE_SIZE * 1.5);

  const mesh = new THREE.Mesh(instancedGeo, mat);
  mesh.frustumCulled = false;  // tile follows camera; always visible
  mesh.matrixAutoUpdate = false;
  mesh.matrix.identity();
  return mesh;
}

// ─── Species definitions ──────────────────────────────────────────────────────

const SPECIES = [
  // [stemColor, petalColor, seed]
  ['0.15,0.40,0.05', '0.95,0.88,0.10', 0xaabbcc],  // yellow daisy
  ['0.12,0.38,0.04', '0.92,0.92,0.92', 0x112233],  // white daisy
  ['0.10,0.35,0.05', '0.25,0.40,0.90', 0x445566],  // blue cornflower
] as const;

// ─── FloraField ───────────────────────────────────────────────────────────────

export class FloraField {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly mats:   THREE.ShaderMaterial[] = [];

  constructor(
    scene: THREE.Scene,
    fogColor: THREE.Color,
    fogNear: number,
    fogFar: number,
  ) {
    const crossGeo = buildCrossGeometry(0.18, 1.0);  // normalised; shader scales by aScale

    // Wildflower species
    const perSpecies = Math.floor(FLOWER_COUNT / SPECIES.length);
    for (const [i, [stem, petal, seed]] of SPECIES.entries()) {
      const mat  = buildMaterial(buildFrag(stem, petal), fogColor, fogNear, fogFar);
      const mesh = buildInstancedMesh(perSpecies, crossGeo, mat, seed + i);
      this.meshes.push(mesh);
      this.mats.push(mat);
      scene.add(mesh);
    }

    // Poppies — red, slightly taller cross geometry
    const poppyGeo = buildCrossGeometry(0.20, 1.0);
    const poppyMat = buildMaterial(
      buildFrag('0.10,0.35,0.02', '0.90,0.10,0.05'),  // deep red
      fogColor, fogNear, fogFar,
    );
    const poppyMesh = buildInstancedMesh(POPPY_COUNT, poppyGeo, poppyMat, 0xdeadbeef);
    this.meshes.push(poppyMesh);
    this.mats.push(poppyMat);
    scene.add(poppyMesh);
  }

  update(dt: number, camPos: THREE.Vector3): void {
    for (const mat of this.mats) {
      mat.uniforms.uTime.value    += dt;
      mat.uniforms.uCamPos.value.copy(camPos);
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      scene.remove(mesh);
    }
    for (const mat of this.mats) mat.dispose();
  }
}
