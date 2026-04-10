export class InputHandler {
  forward  = false;
  backward = false;
  left     = false;
  right    = false;
  jump     = false;

  private _dx     = 0;
  private _dy     = 0;
  private _locked = false;
  private _shoot  = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Listen on document so any click anywhere triggers lock
    document.addEventListener('click', this.onDocumentClick);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
  }

  private onMouseDown = (e: MouseEvent) => {
    // Left-click while locked → fire
    if (this._locked && e.button === 0) this._shoot = true;
  };

  private onDocumentClick = () => {
    if (!this._locked) {
      // requestPointerLock returns a Promise in modern browsers — must catch rejections
      const result = (this.canvas.requestPointerLock as () => Promise<void> | undefined)();
      if (result && typeof result.catch === 'function') {
        result.catch((err: unknown) => {
          console.warn('Pointer lock request failed:', err);
        });
      }
    }
  };

  private onLockError = () => {
    console.warn('Pointer lock error event fired.');
  };

  private onLockChange = () => {
    this._locked = document.pointerLockElement === this.canvas;
    const hint = document.getElementById('hint');
    if (hint) hint.classList.toggle('hidden', this._locked);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW':     this.forward  = true;  break;
      case 'KeyS':     this.backward = true;  break;
      case 'KeyA':     this.left     = true;  break;
      case 'KeyD':     this.right    = true;  break;
      case 'Space':    this.jump     = true;  e.preventDefault(); break;
      case 'ArrowUp':  this.forward  = true;  break;
      case 'ArrowDown': this.backward = true; break;
      case 'ArrowLeft': this.left    = true;  break;
      case 'ArrowRight': this.right  = true;  break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW':     this.forward  = false; break;
      case 'KeyS':     this.backward = false; break;
      case 'KeyA':     this.left     = false; break;
      case 'KeyD':     this.right    = false; break;
      case 'Space':    this.jump     = false; break;
      case 'ArrowUp':  this.forward  = false; break;
      case 'ArrowDown': this.backward = false; break;
      case 'ArrowLeft': this.left    = false; break;
      case 'ArrowRight': this.right  = false; break;
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this._locked) return;
    this._dx += e.movementX;
    this._dy += e.movementY;
  };

  /** Returns true (and resets) if a shoot event occurred since last call. */
  consumeShoot(): boolean {
    const s = this._shoot;
    this._shoot = false;
    return s;
  }

  /** Returns accumulated mouse delta since last call and resets it. */
  consumeDelta(): { dx: number; dy: number } {
    const dx = this._dx;
    const dy = this._dy;
    this._dx = 0;
    this._dy = 0;
    return { dx, dy };
  }

  get isLocked(): boolean { return this._locked; }

  /** True if any horizontal movement key is held. */
  get isMoving(): boolean {
    return this.forward || this.backward || this.left || this.right;
  }

  dispose(): void {
    document.removeEventListener('click', this.onDocumentClick);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
  }
}
