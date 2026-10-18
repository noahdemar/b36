import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import GUI from "lil-gui";
import { Aircraft, type AircraftState } from "./aircraft";

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 20000);
camera.position.set(-60, 22, -70);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;

// Lighting: sky + PMREM room environment for metal reflections, sun with shadows.
const sky = new Sky();
sky.scale.setScalar(10000);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(55), THREE.MathUtils.degToRad(140));
sky.material.uniforms.sunPosition.value.copy(sunDir);
sky.material.uniforms.turbidity.value = 6;
sky.material.uniforms.rayleigh.value = 1.5;
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.8;

const sun = new THREE.DirectionalLight(0xfff4e5, 3.0);
sun.position.copy(sunDir).multiplyScalar(120);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x55504a, 0.6));

const GROUND_Y = -4.0; // matches params.GROUND_Z
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshStandardMaterial({ color: 0x6b6a63, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = GROUND_Y;
ground.receiveShadow = true;
scene.add(ground);

const state: AircraftState = {
  aileron: 0, elevator: 0, rudder: 0, flaps: 0,
  bombDoors: [0, 0, 0, 0],
  propRpm: [0, 0, 0, 0, 0, 0],
  turretYaw: {}, turretPitch: {},
};

const ui = { rpm: 0, bombDoors: 0, turretYaw: 0, turretPitch: 0 };
const gui = new GUI({ title: "B-36 model viewer" });
gui.add(state, "aileron", -1, 1, 0.01);
gui.add(state, "elevator", -1, 1, 0.01);
gui.add(state, "rudder", -1, 1, 0.01);
gui.add(state, "flaps", 0, 1, 0.01);
gui.add(ui, "bombDoors", 0, 1, 0.01).name("bomb doors");
gui.add(ui, "rpm", 0, 2700, 10).name("prop rpm");
gui.add(ui, "turretYaw", -180, 180, 1).name("turret yaw (deg)");
gui.add(ui, "turretPitch", -10, 80, 1).name("turret pitch (deg)");

const info = document.getElementById("info")!;

Aircraft.load(`${import.meta.env.BASE_URL}models/b36.glb`).then((ac) => {
  scene.add(ac.root);
  let tris = 0;
  ac.root.traverse((o) => {
    if (o instanceof THREE.Mesh) tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
  });
  info.textContent = `B-36 | ${tris.toLocaleString()} triangles | drag to orbit, scroll to zoom`;
  const turrets = ac.partNames("turret_yaw");
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    state.bombDoors.fill(ui.bombDoors);
    state.propRpm.fill(ui.rpm);
    for (const t of turrets) {
      state.turretYaw[t] = THREE.MathUtils.degToRad(ui.turretYaw);
      state.turretPitch[t] = THREE.MathUtils.degToRad(ui.turretPitch);
    }
    ac.apply(state, dt);
    controls.update();
    renderer.render(scene, camera);
  });
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
