import * as THREE from 'three';
import {
  triangleMesh,
  rigidBody,
  MotionType,
  type World,
} from 'crashcat';
// Note: triangleMesh.create expects { positions: number[], indices: number[] }

// ─── Height function ──────────────────────────────────────────────────────────
// Three sine/cosine octaves — same formula in TypeScript AND GLSL so the
// visual ground, physics collider, and grass shader are always in sync.

export function terrainHeight(x: number, z: number): number {
  return Math.sin(x * 0.040) * Math.cos(z * 0.030) * 2.5   // large gentle swells
       + Math.sin(x * 0.120 + 0.50) * Math.sin(z * 0.090) * 0.80  // medium bumps
       + Math.cos(x * 0.250 + z * 0.180) * 0.30;             // fine ripples
}

/** GLSL snippet — prepend to any vertex shader that needs terrain sampling. */
export const TERRAIN_GLSL = /* glsl */`
  float terrainH(vec2 p) {
    return sin(p.x * 0.040) * cos(p.y * 0.030) * 2.5
         + sin(p.x * 0.120 + 0.50) * sin(p.y * 0.090) * 0.80
         + cos(p.x * 0.250 + p.y * 0.180) * 0.30;
  }
`;

// ─── Visual ground mesh ───────────────────────────────────────────────────────

const MESH_SEGS  = 200;   // 200×200 quads — smooth enough for 6 m grid spacing
const MESH_HALF  = 600;   // ±600 m — well beyond any fog distance

export function buildGroundMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(
    MESH_HALF * 2, MESH_HALF * 2,
    MESH_SEGS, MESH_SEGS,
  );
  geo.rotateX(-Math.PI / 2);

  const pos    = geo.attributes.position;
  const vCount = pos.count;
  const colors = new Float32Array(vCount * 3);

  // Seeded hash for colour variation (same idea as before, extended to 3D)
  const hash2 = (x: number, z: number) => {
    let h = Math.sin(x * 0.071 + z * 0.113) * 43758.5;
    h += Math.sin(x * 0.193 + z * 0.231) * 13578.3;
    return h - Math.floor(h);
  };

  for (let i = 0; i < vCount; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    // Apply terrain height
    pos.setY(i, terrainHeight(x, z));

    // Vertex colour: dark soil-green ↔ bright meadow-green
    const t = hash2(x, z) * 0.6 + hash2(x * 0.37, z * 0.53) * 0.4;
    colors[i * 3    ] = THREE.MathUtils.lerp(0.09, 0.22, t);
    colors[i * 3 + 1] = THREE.MathUtils.lerp(0.23, 0.43, t);
    colors[i * 3 + 2] = THREE.MathUtils.lerp(0.02, 0.08, t);
  }

  pos.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();   // smooth normals after height displacement

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness:    0.95,
      metalness:    0.0,
    }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

// ─── Physics collision mesh ───────────────────────────────────────────────────
// Coarser grid than the visual mesh — saves memory while still being accurate
// enough for the character capsule (max step ≈ 6 m between sample points).

const PHYS_SEGS = 100;   // 100×100 quads, 6 m step
const PHYS_HALF = 300;   // ±300 m

export function buildTerrainBody(world: World, staticLayer: number): void {
  const N        = PHYS_SEGS + 1;   // vertices per side
  const step     = (PHYS_HALF * 2) / PHYS_SEGS;
  const positions: number[] = [];
  const indices:   number[] = [];

  // Vertices
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const x = -PHYS_HALF + col * step;
      const z = -PHYS_HALF + row * step;
      positions.push(x, terrainHeight(x, z), z);
    }
  }

  // Indices (two triangles per quad)
  for (let row = 0; row < PHYS_SEGS; row++) {
    for (let col = 0; col < PHYS_SEGS; col++) {
      const a = row * N + col;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices.push(a, c, b,  b, c, d);
    }
  }

  const shape = triangleMesh.create({ positions, indices });
  rigidBody.create(world, {
    shape,
    motionType:  MotionType.STATIC,
    objectLayer: staticLayer,
    position:    [0, 0, 0],
  });
}
