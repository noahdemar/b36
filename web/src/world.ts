import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

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

function grassTexture() {
  const t = canvasTexture(512, 512, (g) => {
    g.fillStyle = "#58613f";
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      const v = 70 + Math.random() * 40;
      g.fillStyle = `rgba(${v - 10},${v + 5},${v - 35},0.35)`;
      g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 6, 2 + Math.random() * 6);
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(90,85,55,${0.08 + Math.random() * 0.1})`;
      g.beginPath();
      g.arc(Math.random() * 512, Math.random() * 512, 20 + Math.random() * 70, 0, Math.PI * 2);
      g.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
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

export class World {
  readonly group = new THREE.Group(); // moves opposite to the aircraft (floating origin)
  readonly sun: THREE.DirectionalLight;
  private ground: THREE.Mesh;
  private grass: THREE.Texture;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    const sky = new Sky();
    sky.scale.setScalar(45_000);
    const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(50), THREE.MathUtils.degToRad(150));
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = 5;
    u.rayleigh.value = 1.2;
    u.mieCoefficient.value = 0.004;
    scene.add(sky);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    scene.environment = pmrem.fromScene(envScene, 0, 1, 50_000).texture;
    scene.environmentIntensity = 0.5;
    scene.fog = new THREE.Fog(0xb8c6d4, 8_000, 40_000);

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    this.sun.position.copy(sunDir).multiplyScalar(150);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);
    scene.add(new THREE.HemisphereLight(0xc4d8ff, 0x4d4a3c, 0.25));

    this.grass = grassTexture();
    this.grass.repeat.set(400, 400); // 100 m per tile over 40 km
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40_000, 40_000),
      new THREE.MeshStandardMaterial({ map: this.grass, roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

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

  /** Floating origin: aircraft stays near (0, y, 0); the world shifts. */
  follow(aircraftWorldPos: THREE.Vector3) {
    this.group.position.set(-aircraftWorldPos.x, 0, -aircraftWorldPos.z);
    // ground follows in whole-tile steps so the texture appears fixed to the earth
    const tile = 100;
    const gx = Math.round(aircraftWorldPos.x / tile) * tile;
    const gz = Math.round(aircraftWorldPos.z / tile) * tile;
    this.ground.position.set(gx - aircraftWorldPos.x, 0, gz - aircraftWorldPos.z);
  }

  /** Keep the shadow frustum on the aircraft. */
  aimSun(target: THREE.Vector3) {
    const dir = this.sun.position.clone().sub(this.sun.target.position).normalize();
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(dir, 150);
  }
}
