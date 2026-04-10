import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

export class ThirdPersonCamera {
  yaw   = Math.PI;  // start behind character
  pitch = 0.35;     // slight downward angle
  radius = 4.5;

  private readonly smoothPos = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();

  /** Camera look height offset above character feet. */
  readonly lookHeight = 1.4;
  /** Extra height added to camera position. */
  readonly camHeight = 0.2;

  /** Sensitivity in radians per pixel. */
  sensitivity = 0.0022;

  /** Spring constant for position follow. */
  spring = 12;

  constructor(startPosition: THREE.Vector3) {
    this.smoothPos.copy(startPosition);
  }

  /**
   * Update camera transform.
   * Call once per render frame (not per physics step).
   */
  update(
    camera: THREE.Camera,
    targetPos: THREE.Vector3,
    dx: number,
    dy: number,
    dt: number,
  ): void {
    // Mouse look
    this.yaw   = (this.yaw   - dx * this.sensitivity + TWO_PI) % TWO_PI;
    this.pitch = Math.max(-0.05, Math.min(Math.PI / 2.2, this.pitch + dy * this.sensitivity));

    // Spring follow
    const k = Math.min(1, this.spring * dt);
    this.smoothPos.lerp(targetPos, k);

    // Spherical offset
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);

    camera.position.set(
      this.smoothPos.x + this.radius * cp * sy,
      this.smoothPos.y + this.lookHeight + this.camHeight + this.radius * sp,
      this.smoothPos.z + this.radius * cp * cy,
    );

    this._lookTarget.set(
      this.smoothPos.x,
      this.smoothPos.y + this.lookHeight,
      this.smoothPos.z,
    );
    camera.lookAt(this._lookTarget);
  }

  /** Horizontal forward direction in world space (Y=0). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Horizontal right direction in world space (Y=0). */
  getRight(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
}
