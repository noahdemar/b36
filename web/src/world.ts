import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Clouds } from "./clouds";
import { Terrain } from "./terrain";

export const RUNWAY = { length: 4000, width: 90 }; // m. Runway starts at z = +40, runs north (-z).

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function runwayTexture() {
  // 1 px = 0.5 m across, texture covers 90 m x 360 m and repeats along the length
  const t = canvasTexture(180, 720, (g) => {
    g.fillStyle = "#4b4b48";
    g.fillRect(0, 0, 180, 720);
    for (let i = 0; i < 4000; i++) {
      const v = 60 + Math.random() * 30;
      g.fillStyle = `rgba(${v},${v},${v - 3},0.25)`;
      g.fillRect(Math.random() * 180, Math.random() * 720, 1, 1);
    }
    g.fillStyle = "#d8d6cc";
    g.fillRect(4, 0, 2, 720); // edge lines
    g.fillRect(174, 0, 2, 720);
    for (let y = 0; y < 720; y += 120) g.fillRect(88, y, 4, 60); // centerline dashes 30 m / 30 m gaps
  });
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Times of day the Shift+T key cycles through (local solar hours). */
export const TIMES = [7.5, 10, 13, 16.5, 18.6];

export class World {
  readonly group = new THREE.Group(); // moves opposite to the aircraft (floating origin)
  readonly sun: THREE.DirectionalLight;
  readonly terrain = new Terrain();
  readonly clouds = new Clouds();
  hours = 10;
  private sky: Sky;
  private hemi: THREE.HemisphereLight;
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private sunDir = new THREE.Vector3();
  /** 0 in daylight .. 1 once the sun is well below the horizon (visual effects only). */
  get darkness() {
    return 1 - THREE.MathUtils.smoothstep(this.sunDir.y, -0.1, 0.12);
  }

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = new Sky();
    this.sky.scale.setScalar(220_000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.3;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    scene.add(this.sky);
    scene.fog = new THREE.Fog(0xb8c6d4, 25_000, 210_000);

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xc4d8ff, 0x4d4a3c, 0.25);
    scene.add(this.hemi);

    this.group.add(this.terrain.group, this.clouds.group);
    this.setTime(this.hours);

    const rwTex = runwayTexture();
    rwTex.repeat.set(1, RUNWAY.length / 360);
    const runway = new THREE.Mesh(
      new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length),
      new THREE.MeshStandardMaterial({ map: rwTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, 0.02, 40 - RUNWAY.length / 2);
    runway.receiveShadow = true;
    this.group.add(runway);
    // threshold bars
    const bars = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 45),
      new THREE.MeshStandardMaterial({ color: 0xdedbd0, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    for (let i = -6; i <= 6; i++) {
      if (i === 0) continue;
      const b = bars.clone();
      b.rotation.x = -Math.PI / 2;
      b.position.set(i * 6, 0.03, 40 - 30);
      this.group.add(b);
    }
    scene.add(this.group);
  }

  /** Sun position, light colours, sky, fog and the environment map for a local solar time. */
  setTime(hours: number) {
    this.hours = hours;
    // sun for latitude 35 N, declination +20 deg (early summer): a scenery choice, not the mission date
    const lat = THREE.MathUtils.degToRad(35), dec = THREE.MathUtils.degToRad(20);
    const ha = ((hours - 12) / 12) * Math.PI;
    const sinE = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    const elev = Math.asin(sinE);
    const cosAz = THREE.MathUtils.clamp((Math.sin(dec) - sinE * Math.sin(lat)) / (Math.cos(elev) * Math.cos(lat)), -1, 1);
    const az = ha < 0 ? Math.acos(cosAz) : 2 * Math.PI - Math.acos(cosAz); // from north, east positive
    this.sunDir.set(Math.cos(elev) * Math.sin(az), sinE, -Math.cos(elev) * Math.cos(az)).normalize();
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    const low = 1 - THREE.MathUtils.smoothstep(this.sunDir.y, 0.03, 0.45); // 1 near the horizon
    u.turbidity.value = 3.5 + 4 * low;
    u.rayleigh.value = 1.2 + 1.3 * low;
    const sunCol = new THREE.Color(1.0, 0.95, 0.88).lerp(new THREE.Color(1.0, 0.62, 0.32), low);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 3.3 * THREE.MathUtils.smoothstep(this.sunDir.y, -0.02, 0.15);
    this.hemi.intensity = 0.18 + 0.12 * (1 - low);
    const fog = new THREE.Color(0.66, 0.75, 0.86).lerp(new THREE.Color(0.86, 0.70, 0.58), low * 0.8);
    (this.scene.fog as THREE.Fog).color.copy(fog);
    this.clouds.setLight(this.sunDir, sunCol.clone().multiplyScalar(1.05), new THREE.Color(0.52, 0.57, 0.68).lerp(new THREE.Color(0.45, 0.38, 0.42), low), fog);
    this.terrain.material.needsUpdate = false;
    // environment map from the sky
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(50_000);
    for (const k of Object.keys(u)) (sky2.material.uniforms[k].value as unknown) = u[k].value;
    envScene.add(sky2);
    this.scene.environment?.dispose();
    this.scene.environment = pmrem.fromScene(envScene, 0, 1, 60_000).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
  }

  get sunDirection() {
    return this.sunDir;
  }

  /** Floating origin: aircraft stays near (0, y, 0); the world shifts. camWorld: camera, world coords. */
  follow(aircraftWorldPos: THREE.Vector3, camWorld?: THREE.Vector3) {
    this.group.position.set(-aircraftWorldPos.x, 0, -aircraftWorldPos.z);
    const c = camWorld ?? aircraftWorldPos;
    this.terrain.update(c);
    this.clouds.update(c);
  }

  /** Keep the shadow frustum on the aircraft. */
  aimSun(target: THREE.Vector3, halfSize = 60) {
    const sc = this.sun.shadow.camera;
    if (sc.right !== halfSize) {
      sc.left = sc.bottom = -halfSize;
      sc.right = sc.top = halfSize;
      sc.updateProjectionMatrix();
      this.sun.shadow.normalBias = halfSize < 20 ? 0.01 : 0.05;
    }
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 150);
  }
}
