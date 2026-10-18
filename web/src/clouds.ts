// Clouds: fair-weather cumulus built from clusters of camera-facing puffs (lit per puff: bright tops
// and sun side, grey flat bases, a bright rim looking toward the sun), placed deterministically in 8 km
// tiles around the camera; plus a thin cirrus deck. World coordinates inside the floating-origin group.
// Cloud bases, tops and coverage are scenery settings, not weather data.
import * as THREE from "three";

const TILE = 8000;
const RADIUS_TILES = 9; // about 72 km each way
const MAX_PUFFS = 9000;

function hash(a: number, b: number, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function puffTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  // a soft lumpy blob: overlapping radial gradients
  for (let k = 0; k < 26; k++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 30;
    const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
    const rad = 18 + Math.random() * 26;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, "rgba(255,255,255,0.32)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function cirrusTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  for (let k = 0; k < 260; k++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const len = 40 + Math.random() * 160, w = 2 + Math.random() * 8;
    const a = -0.35 + Math.random() * 0.2;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    const gr = g.createLinearGradient(-len, 0, len, 0);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.5, `rgba(255,255,255,${0.05 + Math.random() * 0.12})`);
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    for (const dx of [-512, 0, 512]) for (const dy of [-512, 0, 512]) {
      g.save();
      g.translate(dx, dy);
      g.beginPath();
      g.ellipse(0, 0, len, w, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class Clouds {
  readonly group = new THREE.Group();
  base = 1900; // m
  coverage = 0.45; // chance a tile slot holds a cloud
  private mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private center: Float32Array;
  private size: Float32Array;
  private shade: Float32Array;
  private count = 0;
  private puffs: { p: THREE.Vector3; s: number; shade: number }[] = [];
  private tileKey = "";
  private sortFrom = new THREE.Vector3(1e9, 0, 0);
  private cirrus: THREE.Mesh;
  readonly uniforms = {
    map: { value: puffTexture() },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    uLit: { value: new THREE.Color(1.0, 0.98, 0.94) },
    uShadow: { value: new THREE.Color(0.55, 0.6, 0.7) },
    uFog: { value: new THREE.Color(0.75, 0.82, 0.9) },
    uFogFar: { value: 150_000 },
  };

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.center = new Float32Array(MAX_PUFFS * 3);
    this.size = new Float32Array(MAX_PUFFS);
    this.shade = new Float32Array(MAX_PUFFS);
    this.geo.setAttribute("iCenter", new THREE.InstancedBufferAttribute(this.center, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("iSize", new THREE.InstancedBufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("iShade", new THREE.InstancedBufferAttribute(this.shade, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 iCenter; attribute float iSize; attribute float iShade;
        uniform vec3 uSun;
        varying vec2 vUv; varying float vShade; varying float vDist; varying float vForward;
        void main() {
          vec4 mv = modelViewMatrix * vec4(iCenter, 1.0);
          mv.xy += position.xy * iSize;
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vShade = iShade;
          vDist = -mv.z;
          vec3 toPuff = normalize((modelMatrix * vec4(iCenter, 1.0)).xyz - cameraPosition);
          vForward = max(0.0, dot(toPuff, uSun));
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D map; uniform vec3 uLit; uniform vec3 uShadow; uniform vec3 uFog; uniform float uFogFar;
        varying vec2 vUv; varying float vShade; varying float vDist; varying float vForward;
        void main() {
          #include <logdepthbuf_fragment>
          float a = texture2D(map, vUv).a;
          if (a < 0.01) discard;
          // thin edges glow when looking toward the sun (forward scattering)
          float rim = pow(vForward, 8.0) * (1.0 - a) * 1.6;
          vec3 c = mix(uShadow, uLit, vShade) + uLit * rim;
          float fog = smoothstep(uFogFar * 0.15, uFogFar, vDist);
          c = mix(c, uFog, fog);
          float near = smoothstep(30.0, 250.0, vDist); // fade puffs the camera flies through
          gl_FragColor = vec4(c, a * 0.92 * near * (1.0 - fog * 0.6));
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
    const ct = cirrusTexture();
    ct.repeat.set(30, 30);
    this.cirrus = new THREE.Mesh(new THREE.PlaneGeometry(240_000, 240_000),
      new THREE.MeshBasicMaterial({ map: ct, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, fog: true, color: 0xffffff }));
    this.cirrus.rotation.x = -Math.PI / 2;
    this.cirrus.position.y = 9800;
    this.cirrus.renderOrder = 1;
    this.group.add(this.cirrus);
  }

  /** Sun direction (world) and colours for lighting; called when the time of day changes. */
  setLight(sun: THREE.Vector3, lit: THREE.Color, shadow: THREE.Color, fog: THREE.Color) {
    this.uniforms.uSun.value.copy(sun).normalize();
    this.uniforms.uLit.value.copy(lit);
    this.uniforms.uShadow.value.copy(shadow);
    this.uniforms.uFog.value.copy(fog);
    this.tileKey = ""; // re-shade
  }

  /** camWorld: camera position in world coordinates. */
  update(camWorld: THREE.Vector3) {
    // cirrus follows the camera in whole texture tiles so it appears fixed
    const rep = 240_000 / 30;
    this.cirrus.position.x = Math.round(camWorld.x / rep) * rep;
    this.cirrus.position.z = Math.round(camWorld.z / rep) * rep;
    const tx = Math.round(camWorld.x / TILE), tz = Math.round(camWorld.z / TILE);
    const key = `${tx},${tz}`;
    if (key !== this.tileKey) { this.tileKey = key; this.generate(tx, tz); this.sortFrom.set(1e9, 0, 0); }
    if (camWorld.distanceTo(this.sortFrom) > 300) { this.sortFrom.copy(camWorld); this.sort(camWorld); }
  }

  private generate(tx: number, tz: number) {
    this.puffs = [];
    const sun = this.uniforms.uSun.value;
    for (let j = tz - RADIUS_TILES; j <= tz + RADIUS_TILES; j++) {
      for (let i = tx - RADIUS_TILES; i <= tx + RADIUS_TILES; i++) {
        for (let k = 0; k < 3; k++) {
          if (hash(i, j, k) > this.coverage) continue;
          const cx = (i + hash(i, j, k + 10) - 0.5) * TILE, cz = (j + hash(i, j, k + 20) - 0.5) * TILE;
          // keep the airfield approach clear
          if (Math.hypot(cx, cz) < 2500) continue;
          const w = 700 + hash(i, j, k + 30) * 1800; // cloud width
          const h = w * (0.45 + 0.35 * hash(i, j, k + 40));
          const n = Math.round(10 + w / 120);
          for (let m = 0; m < n && this.puffs.length < MAX_PUFFS; m++) {
            const u = hash(i * 7 + m, j * 13 + k, 1), v = hash(i * 11 + m, j * 5 + k, 2), z = hash(i + m * 3, j + k, 3);
            const a = u * Math.PI * 2, r = Math.sqrt(v) * w * 0.5;
            const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.6;
            // dome: higher in the middle, flat base
            const top = h * Math.sqrt(Math.max(0, 1 - (r / (w * 0.5)) ** 2));
            const py = this.base + z * top;
            const s = (0.35 + 0.4 * hash(m, k, 4)) * w * (0.75 - 0.3 * z);
            const p = new THREE.Vector3(cx + x, py + s * 0.25, cz + y);
            // lighting: height in the cloud and the side facing the sun
            const side = new THREE.Vector3(x, (py - this.base) - h * 0.4, y).normalize().dot(sun);
            const shade = THREE.MathUtils.clamp(0.25 + 0.55 * (py - this.base) / Math.max(h, 1) + 0.3 * side, 0.05, 1);
            this.puffs.push({ p, s, shade });
          }
        }
      }
    }
    this.count = this.puffs.length;
  }

  private sort(cam: THREE.Vector3) {
    const d = this.puffs.map((q, i) => [q.p.distanceToSquared(cam), i] as [number, number]);
    d.sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < d.length; k++) {
      const q = this.puffs[d[k][1]];
      this.center[k * 3] = q.p.x; this.center[k * 3 + 1] = q.p.y; this.center[k * 3 + 2] = q.p.z;
      this.size[k] = q.s;
      this.shade[k] = q.shade;
    }
    for (const n of ["iCenter", "iSize", "iShade"]) (this.geo.getAttribute(n) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.geo.instanceCount = this.count;
  }
}
