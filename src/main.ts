import * as THREE from 'three';
import {
  registerAll,
  createWorldSettings,
  createWorld,
  updateWorld,
  addBroadphaseLayer,
  addObjectLayer,
  enableCollision,
} from 'crashcat';

import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

import { InputHandler }      from './input.js';
import { ThirdPersonCamera } from './thirdPersonCamera.js';
import { SkySystem }         from './sky.js';
import { GrassField }        from './grass.js';
import { FloraField }        from './flora.js';
import { FireflySystem }     from './particles.js';
import { Trees }             from './trees.js';
import { Character }         from './character.js';
import { FireballSystem }    from './fireballs.js';
import { DayNightCycle }    from './daynight.js';
import { buildGroundMesh, buildTerrainBody, terrainHeight } from './terrain.js';

// ─── Physics timestep ────────────────────────────────────────────────────────

const PHYSICS_DT = 1 / 60;

// ─── Renderer ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled   = true;
renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
// OutputPass handles colour-space & tone mapping — keep renderer in linear space
renderer.outputColorSpace    = THREE.LinearSRGBColorSpace;
renderer.toneMapping         = THREE.NoToneMapping;

// ─── Scene ────────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();

// ─── Sky (sets background; also derives sun direction + horizon colour) ────────
// DayNightCycle drives the sky each frame — no static config needed here.

const sky = new SkySystem(scene, { elevation: 14, azimuth: 210 });

// Fog — DayNightCycle updates fog.color each frame to match the sky horizon
const FOG_NEAR  = 40;
const FOG_FAR   = 95;
scene.fog = new THREE.Fog(sky.horizonColor.clone(), FOG_NEAR, FOG_FAR);

// ─── Camera ───────────────────────────────────────────────────────────────────

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, 4, 6);

// ─── Post-processing ──────────────────────────────────────────────────────────

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Bloom: only pixels above threshold bloom — catches the sun disc + bright tips
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45,   // strength  — subtle, not overwhelming
  0.55,   // radius    — how far glow spreads
  0.88,   // threshold — only very bright pixels (sun, bright sky)
);
composer.addPass(bloomPass);

// OutputPass: applies tone mapping (ACES) + sRGB conversion
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ─── Lighting ─────────────────────────────────────────────────────────────────

// Hemisphere: DayNightCycle adjusts intensity + colours each frame
const hemi = new THREE.HemisphereLight(0xd4eaf8, 0x1e3a06, 0.9);
scene.add(hemi);

// Primary sun — DayNightCycle repositions + dims this each frame
const sunLight = new THREE.DirectionalLight(0xffe090, 3.2);
sunLight.position.copy(sky.sunDir).multiplyScalar(80);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near   = 1;
sunLight.shadow.camera.far    = 200;
sunLight.shadow.camera.left   = -55;
sunLight.shadow.camera.right  =  55;
sunLight.shadow.camera.top    =  55;
sunLight.shadow.camera.bottom = -55;
sunLight.shadow.bias          = -0.0012;
scene.add(sunLight);
scene.add(sunLight.target);

// Soft fill from opposite direction (static — stays as sky-bounce ambient)
const fillLight = new THREE.DirectionalLight(0x8ab8d8, 0.45);
fillLight.position.set(-sky.sunDir.x * 40, sky.sunDir.y * 20 + 10, -sky.sunDir.z * 40);
scene.add(fillLight);

// ─── Ground (terrain) ────────────────────────────────────────────────────────
// buildGroundMesh() returns a subdivided PlaneGeometry with terrain heights
// and vertex-colour variation baked in — same formula as the physics collider.

const groundMesh = buildGroundMesh();
scene.add(groundMesh);

// ─── Physics world ────────────────────────────────────────────────────────────

registerAll();

const ws = createWorldSettings();
ws.gravity = [0, -22, 0];

const BP_MOVING     = addBroadphaseLayer(ws);
const BP_NOT_MOVING = addBroadphaseLayer(ws);
const OBJ_MOVING     = addObjectLayer(ws, BP_MOVING);
const OBJ_NOT_MOVING = addObjectLayer(ws, BP_NOT_MOVING);
enableCollision(ws, OBJ_MOVING,     OBJ_MOVING);
enableCollision(ws, OBJ_MOVING,     OBJ_NOT_MOVING);

const world = createWorld(ws);

// Triangle-mesh terrain collider — same height function as the visual mesh
buildTerrainBody(world, OBJ_NOT_MOVING);

// ─── World objects ────────────────────────────────────────────────────────────

const grass      = new GrassField(scene, sky.horizonColor, FOG_NEAR, FOG_FAR, sky.sunDir);
const flora      = new FloraField(scene, sky.horizonColor, FOG_NEAR, FOG_FAR);
const fireflies  = new FireflySystem(scene, sky.horizonColor, FOG_NEAR, FOG_FAR);
const trees     = new Trees(scene);
// Spawn on terrain surface — find height at origin and start slightly above it
const spawnY    = terrainHeight(0, 0);
const character  = new Character(world, scene, new THREE.Vector3(0, spawnY + 0.05, 0));
const input      = new InputHandler(canvas);
const camCtrl    = new ThirdPersonCamera(new THREE.Vector3(0, 0, 0));
const fireballs  = new FireballSystem(scene);
const daynight   = new DayNightCycle(sky, sunLight, hemi, scene);

// ─── Reused vectors ───────────────────────────────────────────────────────────

const _fwd      = new THREE.Vector3();
const _right    = new THREE.Vector3();
const _shootDir = new THREE.Vector3();

// ─── VRM drag-and-drop ────────────────────────────────────────────────────────

document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', async e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (!file?.name.endsWith('.vrm')) return;
  const url = URL.createObjectURL(file);
  try   { await character.loadVRM(url, scene); }
  catch (err) { console.error('VRM load error:', err); }
  finally     { URL.revokeObjectURL(url); }
});

// ─── Resize ───────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloomPass.resolution.set(w, h);
});

// ─── Physics accumulator ──────────────────────────────────────────────────────

let accumulator = 0;
let lastTime    = performance.now();
let _pendingDX  = 0;
let _pendingDY  = 0;

function physicsStep(dt: number): void {
  const { dx, dy } = input.consumeDelta();
  _pendingDX += dx;
  _pendingDY += dy;

  camCtrl.getForward(_fwd);
  camCtrl.getRight(_right);

  const fwdScale   = (input.forward  ? 1 : 0) - (input.backward ? 1 : 0);
  const rightScale = (input.right    ? 1 : 0) - (input.left     ? 1 : 0);

  character.physicsStep(
    dt,
    _fwd.x * fwdScale + _right.x * rightScale,
    _fwd.z * fwdScale + _right.z * rightScale,
  );
  if (input.jump && input.isLocked) character.jump();

  updateWorld(world, undefined, dt);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function animate(): void {
  requestAnimationFrame(animate);

  const now       = performance.now();
  const frameTime = Math.min((now - lastTime) / 1000, 1 / 20);
  lastTime = now;

  accumulator += frameTime;
  while (accumulator >= PHYSICS_DT) {
    physicsStep(PHYSICS_DT);
    accumulator -= PHYSICS_DT;
  }

  character.visualUpdate(frameTime);

  camCtrl.update(camera, character.position, _pendingDX, _pendingDY, frameTime);
  _pendingDX = 0;
  _pendingDY = 0;

  // ── Fireball launch ───────────────────────────────────────────────────────
  if (input.consumeShoot() && input.isLocked) {
    // Direction = camera forward (includes pitch so it follows aim)
    _shootDir.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    // Spawn from character eye level, slightly in front
    const origin = character.position.clone();
    origin.y += 1.5;
    origin.addScaledVector(_shootDir, 0.6);
    fireballs.shoot(origin, _shootDir);
  }

  fireballs.update(frameTime);

  // ── Day/night cycle ───────────────────────────────────────────────────────
  daynight.update(frameTime, scene.fog as THREE.Fog);

  // Shadow frustum tracks the player — sun direction changes with the cycle
  const px = character.position.x;
  const pz = character.position.z;
  sunLight.position.set(
    px + sky.sunDir.x * 80,
    sky.sunDir.y * 80,
    pz + sky.sunDir.z * 80,
  );
  sunLight.target.position.set(px, 0, pz);
  sunLight.target.updateMatrixWorld();

  grass.update(frameTime, camera.position, character.position);
  flora.update(frameTime, camera.position);
  fireflies.update(frameTime, camera.position, daynight.nightFactor);
  trees.update(frameTime);

  composer.render();
}

animate();
