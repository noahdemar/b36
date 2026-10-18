// Third-person views (War Thunder style). Pilot: the mouse sets an aim direction in the world, the
// camera looks along it from behind the aircraft and the instructor flies toward it; a cross marks
// where the nose points. Gunner: the camera looks along the gunner's line of sight from above and
// behind the aircraft; the station's sight computer still lays the guns.
import * as THREE from "three";

export class ChaseCam {
  /** Pilot aim: heading (rad, 0 = north, + = east) and elevation (rad), world frame. */
  yaw = 0;
  pitch = 0;
  dist = 95; // m behind the centre of gravity
  readonly canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;

  constructor() {
    this.canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;display:none;";
    document.body.appendChild(this.canvas);
    this.g = this.canvas.getContext("2d")!;
  }

  aimDir(out = new THREE.Vector3()) {
    const c = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c);
  }

  /** Start aiming where the aircraft points. */
  resetTo(quat: THREE.Quaternion) {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    this.yaw = Math.atan2(f.x, -f.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
  }

  mouse(dx: number, dy: number, fov: number) {
    const k = 0.0022 * (fov / 60);
    this.yaw += dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.2, 1.2);
  }

  wheel(deltaY: number) {
    this.dist = THREE.MathUtils.clamp(this.dist * (deltaY > 0 ? 1.1 : 1 / 1.1), 55, 260);
  }

  /** Camera behind the CG along `dir` (scene coords, unit), lifted a little so the aircraft sits low. */
  place(camera: THREE.PerspectiveCamera, cg: THREE.Vector3, dir: THREE.Vector3, dist = this.dist, lift = 0.16) {
    camera.position.copy(cg).addScaledVector(dir, -dist).add(new THREE.Vector3(0, dist * lift, 0));
    camera.up.set(0, 1, 0);
    camera.lookAt(camera.position.clone().add(dir));
  }

  /** Pilot overlay: aim circle at the screen centre, nose cross where the aircraft points. */
  drawPilot(camera: THREE.PerspectiveCamera, cg: THREE.Vector3, fwd: THREE.Vector3, instructorOn: boolean) {
    const g = this.begin();
    const W = window.innerWidth, H = window.innerHeight;
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1.5;
    g.shadowColor = "rgba(0,0,0,0.8)";
    g.shadowBlur = 3;
    g.beginPath();
    g.arc(W / 2, H / 2, 9, 0, Math.PI * 2);
    g.stroke();
    const v = cg.clone().addScaledVector(fwd, 3000).project(camera);
    if (v.z < 1) {
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      g.strokeStyle = instructorOn ? "rgba(140,255,150,0.9)" : "rgba(255,200,120,0.9)";
      g.beginPath();
      g.moveTo(x - 11, y); g.lineTo(x - 4, y); g.moveTo(x + 4, y); g.lineTo(x + 11, y);
      g.moveTo(x, y - 11); g.lineTo(x, y - 4); g.moveTo(x, y + 4); g.lineTo(x, y + 11);
      g.stroke();
      // dashed line from the nose to the aim
      g.setLineDash([3, 6]);
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(W / 2, H / 2);
      g.stroke();
      g.setLineDash([]);
    }
  }

  hide() {
    this.canvas.style.display = "none";
  }

  private begin() {
    const c = this.canvas;
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    c.style.display = "block";
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.g.clearRect(0, 0, W, H);
    return this.g;
  }
}
