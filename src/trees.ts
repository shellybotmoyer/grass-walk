import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

// ─── Tree placement ───────────────────────────────────────────────────────────

const TREE_DEFS: Array<{ x: number; z: number; scale: number; type: 'pine' | 'oak' }> = [
  { x: -28, z:  22, scale: 1.00, type: 'pine' },
  { x:  35, z: -18, scale: 1.15, type: 'pine' },
  { x: -45, z: -28, scale: 0.90, type: 'pine' },
  { x:  50, z:  38, scale: 1.25, type: 'oak'  },
  { x: -55, z:  14, scale: 1.05, type: 'pine' },
  { x:  30, z:  55, scale: 0.95, type: 'oak'  },
  { x: -22, z:  48, scale: 1.10, type: 'pine' },
  { x:  58, z: -32, scale: 0.85, type: 'pine' },
  { x: -50, z: -45, scale: 1.20, type: 'oak'  },
  { x:  18, z: -58, scale: 1.00, type: 'pine' },
  { x:  42, z: -55, scale: 0.90, type: 'pine' },
  { x: -65, z:  32, scale: 1.30, type: 'oak'  },
  { x:  68, z:  18, scale: 1.05, type: 'pine' },
  { x: -12, z:  68, scale: 0.95, type: 'oak'  },
  { x:  52, z:  65, scale: 1.10, type: 'pine' },
  { x: -58, z: -12, scale: 1.00, type: 'pine' },
  { x:  38, z: -70, scale: 1.15, type: 'oak'  },
  { x: -32, z: -65, scale: 0.88, type: 'pine' },
];

// ─── Shared materials ─────────────────────────────────────────────────────────

const TRUNK_MAT = new THREE.MeshLambertMaterial({ color: 0x5c3d1e });
const PINE_MATS = [
  new THREE.MeshLambertMaterial({ color: 0x1a4a08 }),
  new THREE.MeshLambertMaterial({ color: 0x1e5a09 }),
  new THREE.MeshLambertMaterial({ color: 0x22650a }),
];
const OAK_MAT = new THREE.MeshLambertMaterial({ color: 0x2a6010 });

// ─── Per-tree state for wind sway ─────────────────────────────────────────────

interface TreeEntry {
  group:    THREE.Group;
  foliage:  THREE.Object3D[];  // meshes that sway
  phase:    number;             // random phase offset so trees don't sync
  speed:    number;             // individual sway speed
  maxAngle: number;             // max sway rotation (radians)
}

// ─── Builders ─────────────────────────────────────────────────────────────────

function buildPine(scale: number, entry: TreeEntry): void {
  const g = entry.group;

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15 * scale, 0.28 * scale, 2.2 * scale, 6),
    TRUNK_MAT,
  );
  trunk.position.y    = 1.1 * scale;
  trunk.castShadow    = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  const layers = [
    { r: 2.8, h: 3.2, y: 2.4 },
    { r: 2.1, h: 2.6, y: 4.6 },
    { r: 1.3, h: 2.2, y: 6.2 },
  ];
  layers.forEach(({ r, h, y }, i) => {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r * scale, h * scale, 7),
      PINE_MATS[i],
    );
    cone.position.y    = y * scale;
    cone.castShadow    = true;
    cone.receiveShadow = true;
    g.add(cone);
    entry.foliage.push(cone);   // all cone layers sway
  });
}

function buildOak(scale: number, entry: TreeEntry): void {
  const g = entry.group;

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.20 * scale, 0.35 * scale, 3.5 * scale, 7),
    TRUNK_MAT,
  );
  trunk.position.y    = 1.75 * scale;
  trunk.castShadow    = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(2.8 * scale, 7, 6),
    OAK_MAT,
  );
  canopy.position.y    = 5.5 * scale;
  canopy.castShadow    = true;
  canopy.receiveShadow = true;
  g.add(canopy);
  entry.foliage.push(canopy);

  const offsets: Array<[number, number, number]> = [[-1.2, 4.2, 0.8], [1.0, 4.8, -0.9]];
  for (const [ox, oy, oz] of offsets) {
    const lobe = new THREE.Mesh(
      new THREE.SphereGeometry(1.8 * scale, 6, 5),
      OAK_MAT,
    );
    lobe.position.set(ox * scale, oy * scale, oz * scale);
    lobe.castShadow    = true;
    lobe.receiveShadow = true;
    g.add(lobe);
    entry.foliage.push(lobe);
  }
}

// ─── Trees ────────────────────────────────────────────────────────────────────

export class Trees {
  private readonly entries: TreeEntry[] = [];
  private windTime = 0;

  constructor(scene: THREE.Scene) {
    for (const { x, z, scale, type } of TREE_DEFS) {
      const entry: TreeEntry = {
        group:    new THREE.Group(),
        foliage:  [],
        phase:    Math.random() * Math.PI * 2,
        speed:    0.6 + Math.random() * 0.5,
        maxAngle: (0.04 + Math.random() * 0.04) / scale,  // smaller trees sway more
      };

      if (type === 'pine') buildPine(scale, entry);
      else                 buildOak(scale,  entry);

      // Place at correct terrain height so trees sit on hills
      entry.group.position.set(x, terrainHeight(x, z), z);
      scene.add(entry.group);
      this.entries.push(entry);
    }
  }

  /** Call once per render frame (not per physics step). */
  update(dt: number): void {
    this.windTime += dt;
    const t = this.windTime;

    for (const { foliage, phase, speed, maxAngle } of this.entries) {
      // Two-axis gentle sway — main low-freq + slight high-freq shimmer
      const swayX = Math.sin(t * speed       + phase) * maxAngle
                  + Math.sin(t * speed * 2.3 + phase) * maxAngle * 0.2;
      const swayZ = Math.cos(t * speed * 0.7 + phase + 1.0) * maxAngle * 0.6;

      for (const mesh of foliage) {
        mesh.rotation.x = swayX;
        mesh.rotation.z = swayZ;
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const { group } of this.entries) {
      group.traverse(obj => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      scene.remove(group);
    }
  }
}
