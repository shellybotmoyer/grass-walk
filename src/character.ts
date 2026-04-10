import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  capsule,
  kcc,
  filter as ccFilter,
  type KCC,
  type Filter,
  type World,
} from 'crashcat';

// ─── Physics constants ────────────────────────────────────────────────────────

export const CAPSULE_RADIUS           = 0.3;
export const CAPSULE_HALF_HEIGHT_CYL  = 0.55;  // cylinder-only portion half-height
// Total capsule height = 2×halfHeightOfCylinder + 2×radius = 1.1 + 0.6 = 1.7 m
export const CAPSULE_FEET_OFFSET      = CAPSULE_HALF_HEIGHT_CYL + CAPSULE_RADIUS;

const MOVE_SPEED  = 4.5;   // m/s
const GRAVITY_VEC: [number, number, number] = [0, -22, 0];
const JUMP_SPEED  = 9;     // m/s

// ─── Walk animation constants ─────────────────────────────────────────────────

const SWING_LEG  = 0.55;
const SWING_ARM  = 0.35;
const KNEE_BEND  = 0.65;
const HIP_SWAY   = 0.04;
const LEAN_FWD   = 0.08;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBone(vrm: VRM, name: VRMHumanBoneName): THREE.Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name);
}

// ─── Character ────────────────────────────────────────────────────────────────

export class Character {
  /** World-space feet position — updated every physics step. */
  readonly position = new THREE.Vector3();

  private readonly controller: KCC;
  private readonly world: World;
  private readonly queryFilter: Filter;

  private vrm: VRM | null = null;
  private readonly placeholder: THREE.Mesh;

  private vy = 0;
  private phase = 0;
  private faceAngle = 0;
  private isMoving = false;

  private readonly updateSettings = kcc.createDefaultUpdateSettings();

  constructor(
    world: World,
    scene: THREE.Scene,
    startPos: THREE.Vector3,
  ) {
    this.world = world;
    this.queryFilter = ccFilter.forWorld(world);

    // Stair / floor-stick distances
    this.updateSettings.stickToFloorStepDown = [0, -0.45, 0];
    this.updateSettings.walkStairsStepUp     = [0,  0.35, 0];

    // Placeholder capsule mesh (shown until VRM is loaded)
    const geo = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT_CYL * 2, 4, 8);
    const mat = new THREE.MeshLambertMaterial({ color: 0x88aaff });
    this.placeholder = new THREE.Mesh(geo, mat);
    // CapsuleGeometry is centred at origin → lift so feet sit at y=0
    this.placeholder.position.copy(startPos).y += CAPSULE_FEET_OFFSET;
    scene.add(this.placeholder);

    // KCC — purely virtual (no innerRigidBody)
    const shape = capsule.create({
      halfHeightOfCylinder: CAPSULE_HALF_HEIGHT_CYL,
      radius: CAPSULE_RADIUS,
    });

    const startCentreY = startPos.y + CAPSULE_FEET_OFFSET + 0.01;
    this.controller = kcc.create(
      {
        shape,
        maxSlopeAngle: Math.PI * 0.4,
        characterPadding: 0.02,
        mass: 70,
      },
      [startPos.x, startCentreY, startPos.z],
      [0, 0, 0, 1],
    );
  }

  // ── VRM loading ─────────────────────────────────────────────────────────────

  async loadVRM(url: string, scene: THREE.Scene): Promise<void> {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url);
    const nextVrm = gltf.userData.vrm as VRM | undefined;
    if (!nextVrm) throw new Error('No VRM data found in file');

    if (this.vrm) {
      scene.remove(this.vrm.scene);
      this.vrm.scene.traverse(obj => {
        const m = obj as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          (Array.isArray(m.material) ? m.material : [m.material])
            .forEach(mat => (mat as THREE.Material)?.dispose());
        }
      });
    }

    this.vrm = nextVrm;
    scene.add(nextVrm.scene);
    this.placeholder.visible = false;
    this.syncVRMPosition();
  }

  // ── Fixed-rate physics step ──────────────────────────────────────────────────

  physicsStep(dt: number, moveX: number, moveZ: number): void {
    const onGround = kcc.isSupported(this.controller);

    if (onGround) {
      if (this.vy < 0) this.vy = 0;
    } else {
      this.vy = Math.max(this.vy + GRAVITY_VEC[1] * dt, -40);
    }

    const speed = Math.hypot(moveX, moveZ);
    this.isMoving = speed > 0.01;

    const nx = speed > 0.01 ? moveX / speed : 0;
    const nz = speed > 0.01 ? moveZ / speed : 0;

    this.controller.linearVelocity[0] = nx * MOVE_SPEED;
    this.controller.linearVelocity[1] = this.vy;
    this.controller.linearVelocity[2] = nz * MOVE_SPEED;

    kcc.update(
      this.world,
      this.controller,
      dt,
      GRAVITY_VEC,
      this.updateSettings,
      undefined,
      this.queryFilter,
    );

    // Sync feet position from capsule centre
    const p = this.controller.position;
    this.position.set(p[0], p[1] - CAPSULE_FEET_OFFSET, p[2]);

    // Smooth face-direction toward movement
    if (this.isMoving) {
      const target = Math.atan2(nx, nz);
      let delta = target - this.faceAngle;
      while (delta >  Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.faceAngle += delta * Math.min(1, 10 * dt);
    }

    // Advance walk phase
    if (this.isMoving) {
      this.phase += speed * MOVE_SPEED * dt * 2.8;
    } else {
      this.phase *= (1 - Math.min(1, 8 * dt));
    }
  }

  jump(): void {
    if (kcc.isSupported(this.controller)) {
      this.vy = JUMP_SPEED;
    }
  }

  // ── Render-rate visual update ─────────────────────────────────────────────────

  visualUpdate(dt: number): void {
    this.syncPlaceholder();
    if (this.vrm) {
      this.syncVRMPosition();
      this.animateVRM();
      this.vrm.update(dt);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private syncPlaceholder(): void {
    if (this.placeholder.visible) {
      this.placeholder.position.set(
        this.position.x,
        this.position.y + CAPSULE_FEET_OFFSET,
        this.position.z,
      );
    }
  }

  private syncVRMPosition(): void {
    if (!this.vrm) return;
    this.vrm.scene.position.set(this.position.x, this.position.y, this.position.z);
    this.vrm.scene.rotation.y = this.faceAngle;
  }

  private animateVRM(): void {
    const v = this.vrm!;
    const p = this.phase;

    const blend = this.isMoving ? Math.min(1, Math.abs(Math.sin(p)) + 0.3) : 0;
    const bs = blend * blend * (3 - 2 * blend); // smoothstep

    // Legs
    const lul = getBone(v, VRMHumanBoneName.LeftUpperLeg);
    const rul = getBone(v, VRMHumanBoneName.RightUpperLeg);
    const lll = getBone(v, VRMHumanBoneName.LeftLowerLeg);
    const rll = getBone(v, VRMHumanBoneName.RightLowerLeg);

    if (lul) lul.rotation.x = Math.cos(p)           * SWING_LEG * bs;
    if (rul) rul.rotation.x = Math.cos(p + Math.PI) * SWING_LEG * bs;
    if (lll) lll.rotation.x = Math.max(0, -Math.cos(p))           * KNEE_BEND * bs;
    if (rll) rll.rotation.x = Math.max(0, -Math.cos(p + Math.PI)) * KNEE_BEND * bs;

    // Arms (opposite to legs)
    const lua = getBone(v, VRMHumanBoneName.LeftUpperArm);
    const rua = getBone(v, VRMHumanBoneName.RightUpperArm);

    if (lua) { lua.rotation.x = Math.cos(p + Math.PI) * SWING_ARM * bs; lua.rotation.z =  0.2; }
    if (rua) { rua.rotation.x = Math.cos(p)            * SWING_ARM * bs; rua.rotation.z = -0.2; }

    // Hips sway
    const hips = getBone(v, VRMHumanBoneName.Hips);
    if (hips) hips.rotation.z = Math.sin(p * 2) * HIP_SWAY * bs;

    // Spine lean
    const spine = getBone(v, VRMHumanBoneName.Spine);
    if (spine) { spine.rotation.x = LEAN_FWD * bs; spine.rotation.z = -Math.sin(p * 2) * HIP_SWAY * 0.5 * bs; }

    // Head compensation
    const head = getBone(v, VRMHumanBoneName.Head);
    if (head) head.rotation.x = -LEAN_FWD * 0.5 * bs;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.placeholder);
    if (this.vrm) scene.remove(this.vrm.scene);
  }
}
