import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

export interface SkyConfig {
  /** Sun elevation above horizon in degrees.  10–20 = golden hour, 30–50 = midday. */
  elevation?: number;
  /** Sun azimuth in degrees (0 = N, 90 = E, 180 = S, 270 = W). */
  azimuth?: number;
  /** Atmospheric haze (1 = clear, 10 = heavy haze). */
  turbidity?: number;
  /** Sky blueness / Rayleigh scattering (1 = pale, 4 = rich). */
  rayleigh?: number;
}

/**
 * Wraps Three.js Sky (Preetham model) and exposes the derived sun direction
 * so the rest of the scene (directional light, grass shader) can stay in sync.
 */
export class SkySystem {
  /** Normalised world-space direction *toward* the sun. */
  readonly sunDir = new THREE.Vector3();

  /** Approximate horizon sky colour — use to tint fog and shader uniforms. */
  readonly horizonColor = new THREE.Color();

  private readonly sky: Sky;

  constructor(scene: THREE.Scene, cfg: SkyConfig = {}) {
    const {
      elevation  = 14,    // golden-hour angle
      azimuth    = 210,   // south-west for long dramatic shadows
      turbidity  = 3.5,
      rayleigh   = 2.4,
    } = cfg;

    this.sky = new Sky();
    this.sky.scale.setScalar(450_000);
    scene.add(this.sky);

    const u = this.sky.material.uniforms as Record<string, THREE.IUniform>;
    u['turbidity'].value        = turbidity;
    u['rayleigh'].value         = rayleigh;
    u['mieCoefficient'].value   = 0.006;   // glow radius around sun
    u['mieDirectionalG'].value  = 0.88;    // sun disc sharpness

    // Convert spherical to Cartesian
    const phi   = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u['sunPosition'].value.copy(this.sunDir);

    // Empirical horizon colour for turbidity ~3.5, elevation ~14°
    // (warm hazy blue — used to tint fog and shader uniforms)
    this.horizonColor.setHex(0xbbd8ee);
  }

  /**
   * Reposition the sun. Called every frame by DayNightCycle.
   * Updates the Sky shader uniform and recalculates sunDir + horizonColor.
   */
  setTime(elevationDeg: number, azimuthDeg: number): void {
    const phi   = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const u = this.sky.material.uniforms as Record<string, THREE.IUniform>;
    u['sunPosition'].value.copy(this.sunDir);

    // Derive horizon fog colour from elevation
    const e = elevationDeg;
    if (e >= 20) {
      this.horizonColor.setHex(0xbbd8ee);               // clear midday blue
    } else if (e >= 4) {
      this.horizonColor.lerpColors(
        new THREE.Color(0xe8804a), new THREE.Color(0xbbd8ee), (e - 4) / 16,
      );                                                 // golden hour blend
    } else if (e >= -4) {
      this.horizonColor.lerpColors(
        new THREE.Color(0x1a1a3a), new THREE.Color(0xe8804a), (e + 4) / 8,
      );                                                 // dusk-to-night
    } else {
      this.horizonColor.setHex(0x0c1020);               // night
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.sky);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}
