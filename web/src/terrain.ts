// Procedural terrain: quadtree of height-field chunks around the camera (world coordinates, inside the
// floating-origin World group) out to 200 km, coloured per pixel in the shader (farm fields, forest,
// rivers and lakes, towns, rock and snow). The airfield and bombing range sit in a flat plain at y = 0
// (bombs, rounds and flak use y = 0); hills rise beyond about 25 km and mountains beyond 60 km.
// terrainHeight() is exported for the terrain collision check. Shapes and colours are artistic choices,
// not survey data.
import * as THREE from "three";

// ------------------------------------------------------------------------------------------- noise

function hash2(ix: number, iz: number) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
}

function fbm(x: number, z: number, oct: number) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f); f *= 2.03; a *= 0.5; }
  return s;
}

function ridged(x: number, z: number, oct: number) {
  let s = 0, a = 0.5, f = 1, w = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x * f, z * f));
    n *= n * w;
    w = Math.min(1, n * 2);
    s += a * n;
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Distance (m) from the flat plain's spine: runway (z +5 km) to beyond the bombing range (z -40 km). */
function plainDist(x: number, z: number) {
  const zc = Math.max(-40_000, Math.min(5_000, z));
  return Math.hypot(x, z - zc);
}

/** Terrain height (m) at world (x, z). Exactly 0 on the plain around the airfield and range. */
export function terrainHeight(x: number, z: number) {
  const d = plainDist(x, z);
  if (d < 24_000) return 0;
  const hills = smooth(24_000, 42_000, d) * (fbm(x / 9000, z / 9000, 5) * 0.5 + 0.5) * 520;
  const mtn = smooth(55_000, 95_000, d) * Math.pow(ridged(x / 26_000 + 7.3, z / 26_000 - 3.1, 6), 1.6) * 3600;
  return hills + mtn;
}

// ------------------------------------------------------------------------------------------- chunks

const N = 32; // quads per chunk side
const ROOT = 409_600; // m, root chunk size
const LEAF = 1_600; // m, smallest chunk
const BUILDS_PER_FRAME = 6;

interface Node { x: number; z: number; size: number; mesh: THREE.Mesh | null; kids: Node[] | null }

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private root: Node = { x: 0, z: 0, size: ROOT, mesh: null, kids: null };
  private built = 0;
  private uniforms = { uSun: { value: new THREE.Vector3(0, 1, 0) }, uSnow: { value: 2300 } };

  constructor() {
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    this.material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vTer;\nvarying vec3 vTerN;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTer = position;\nvTerN = normal;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vTer;\nvarying vec3 vTerN;\nuniform float uSnow;\n" + GLSL_NOISE + GLSL_ALBEDO)
        .replace("#include <map_fragment>", "#include <map_fragment>\n{ float wet; float rough; diffuseColor.rgb = terrainAlbedo(vTer, normalize(vTerN), wet, rough); roughnessFactorT = rough; }")
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = roughness;\n#ifdef USE_ROUGHNESSMAP\n#endif\nroughnessFactor = roughnessFactorT;")
        .replace("void main() {", "float roughnessFactorT = 0.95;\nvoid main() {");
    };
    this.material.customProgramCacheKey = () => "terrain-v1";
    this.build(this.root);
  }

  /** Select chunks for the camera (world coordinates). */
  update(camWorld: THREE.Vector3) {
    this.built = 0;
    const show = new Set<THREE.Mesh>();
    this.select(this.root, camWorld, show);
    for (const m of this.group.children as THREE.Mesh[]) m.visible = show.has(m);
  }

  private select(n: Node, cam: THREE.Vector3, show: Set<THREE.Mesh>) {
    const dx = Math.max(Math.abs(cam.x - n.x) - n.size / 2, 0);
    const dz = Math.max(Math.abs(cam.z - n.z) - n.size / 2, 0);
    const h = Math.max(0, cam.y - 3000);
    const dist = Math.hypot(dx, dz, h);
    const split = n.size > LEAF && dist < n.size * 1.25;
    if (split) {
      if (!n.kids) {
        const q = n.size / 4;
        n.kids = [[-q, -q], [q, -q], [-q, q], [q, q]].map(([ox, oz]) => ({ x: n.x + ox, z: n.z + oz, size: n.size / 2, mesh: null, kids: null }));
      }
      // all four children must exist before the parent is replaced
      let ready = true;
      for (const k of n.kids) if (!k.mesh) { if (this.built < BUILDS_PER_FRAME) this.build(k); else ready = false; }
      if (ready) { for (const k of n.kids) this.select(k, cam, show); return; }
    }
    if (n.mesh) show.add(n.mesh);
  }

  private build(n: Node) {
    this.built++;
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    const step = n.size / N;
    const x0 = n.x - n.size / 2, z0 = n.z - n.size / 2;
    const e = Math.max(step * 0.5, 5);
    const vid = (i: number, j: number) => j * (N + 1) + i;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const y = terrainHeight(x, z);
      pos.push(x, y, z);
      const nx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
      const nz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
      const l = Math.hypot(nx, 2 * e, nz);
      nor.push(nx / l, (2 * e) / l, nz / l);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i, j + 1), d = vid(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
    // skirts hide cracks against coarser neighbours
    const drop = n.size * 0.02;
    const edge = (list: number[]) => {
      const base = pos.length / 3;
      for (const v of list) { pos.push(pos[v * 3], pos[v * 3 + 1] - drop, pos[v * 3 + 2]); nor.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]); }
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k], b = list[k + 1], c = base + k, d = base + k + 1;
        idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // both windings: the skirt faces either way
      }
    };
    const r = [...Array(N + 1).keys()];
    edge(r.map((i) => vid(i, 0)));
    edge(r.map((i) => vid(i, N)));
    edge(r.map((j) => vid(0, j)));
    edge(r.map((j) => vid(N, j)));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.material);
    m.receiveShadow = true;
    m.frustumCulled = true;
    m.visible = false;
    n.mesh = m;
    this.group.add(m);
  }
}

// ------------------------------------------------------------------------------------------- shader

const GLSL_NOISE = /* glsl */ `
float th(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i), th(i + vec2(1, 0)), u.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), u.x), u.y);
}
float tf(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * tn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

// Albedo by land use. Field patchwork: jittered cells about 350-700 m in rotated regional grids;
// forest where a low-frequency mask is high; rivers along a noise isoline; towns in some 6 km cells.
const GLSL_ALBEDO = /* glsl */ `
vec3 terrainAlbedo(vec3 w, vec3 nrm, out float wet, out float rough) {
  vec2 p = w.xz;
  float dist = length(vViewPosition);
  wet = 0.0; rough = 0.95;
  // regional rotation of the field grid
  // each 7 km region has its own field orientation and size (a constant rotation about the region's
  // corner; a rotation varying with position would warp the grid)
  vec2 rc = floor(p / 7000.0 + 0.5 * tn(p / 2500.0));
  float ang = (th(rc + 3.1) - 0.5) * 1.4;
  float fsz = 330.0 + 330.0 * th(rc + 8.7);
  mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 q = R * (p - rc * 7000.0) / fsz + rc * 17.0;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float r = th(cell);
  vec3 crops[6];
  crops[0] = vec3(0.24, 0.33, 0.12); crops[1] = vec3(0.40, 0.40, 0.17); crops[2] = vec3(0.55, 0.47, 0.26);
  crops[3] = vec3(0.18, 0.27, 0.10); crops[4] = vec3(0.36, 0.29, 0.19); crops[5] = vec3(0.45, 0.50, 0.22);
  vec3 col = crops[int(r * 5.99)];
  // furrows and texture inside a field, hedgerows between fields
  // fine detail fades out with distance before it can alias into moire
  float nearF = smoothstep(7000.0, 1500.0, dist);
  col *= 0.94 + nearF * (0.12 * tn(q * vec2(1.0, 30.0) + r * 10.0) - 0.06) + 0.08 * tn(p / 37.0) * smoothstep(20000.0, 4000.0, dist);
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  float hedge = 1.0 - smoothstep(0.0, 0.035, edge);
  col = mix(col, vec3(0.13, 0.17, 0.09), hedge * 0.75 * smoothstep(40000.0, 4000.0, dist));
  // forest
  float fm = tf(p / 6000.0 + 3.7) + 0.15 * tn(p / 400.0);
  float forest = smoothstep(0.57, 0.62, fm);
  vec3 fcol = vec3(0.10, 0.15, 0.08) * (0.75 + 0.5 * mix(0.5, tn(p / 60.0), smoothstep(15000.0, 3000.0, dist)));
  col = mix(col, fcol, forest);
  // towns
  vec2 tc = floor(p / 6000.0);
  float tr = th(tc + 31.0);
  if (tr > 0.72) {
    vec2 c = (tc + 0.3 + 0.4 * vec2(th(tc + 5.0), th(tc + 9.0))) * 6000.0;
    float rad = 500.0 + 900.0 * th(tc + 13.0);
    float t = 1.0 - smoothstep(rad * 0.6, rad, length(p - c) + 120.0 * tn(p / 150.0));
    vec2 b = fract(p / 70.0);
    float street = step(0.86, max(b.x, b.y)) * smoothstep(14000.0, 3000.0, dist);
    vec3 roofs = mix(vec3(0.45, 0.38, 0.33), vec3(0.55, 0.53, 0.5), tn(floor(p / 18.0)));
    vec3 town = mix(roofs * (0.8 + 0.3 * th(floor(p / 14.0))), vec3(0.42, 0.42, 0.4), street);
    col = mix(col, town, t);
  }
  // roads along some field lines
  float road = (1.0 - smoothstep(0.0, 0.012, abs(f.y - 0.5) * (th(vec2(cell.y, 7.0)) > 0.9 ? 1.0 : 100.0)));
  col = mix(col, vec3(0.5, 0.48, 0.44), road * smoothstep(30000.0, 3000.0, dist));
  // rivers and lakes (on the lowlands)
  float riv = abs(tf(p / 22000.0 + 1.3) - 0.5);
  float low = smoothstep(250.0, 60.0, w.y);
  float river = (1.0 - smoothstep(0.004, 0.0075, riv)) * low;
  float lake = smoothstep(0.66, 0.67, tf(p / 5000.0 - 8.0)) * low * (1.0 - forest);
  float water = max(river, lake);
  col = mix(col, vec3(0.05, 0.09, 0.11), water);
  wet = water;
  rough = mix(0.95, 0.12, water);
  // hills and mountains: grass, rock on slopes, snow above the line
  float slope = 1.0 - nrm.y;
  float hill = smoothstep(150.0, 900.0, w.y);
  col = mix(col, mix(vec3(0.25, 0.30, 0.17), vec3(0.20, 0.25, 0.13), forest), hill * 0.7);
  float rock = smoothstep(0.25, 0.45, slope) * smoothstep(300.0, 900.0, w.y);
  col = mix(col, vec3(0.36, 0.34, 0.31) * (0.8 + 0.4 * tn(p / 90.0)), rock);
  float snow = smoothstep(uSnow - 200.0, uSnow + 300.0, w.y + 300.0 * tn(p / 700.0)) * (1.0 - smoothstep(0.55, 0.75, slope));
  col = mix(col, vec3(0.86, 0.88, 0.92), snow);
  // airfield grass around the runway
  float af = (1.0 - smoothstep(500.0, 800.0, abs(p.x))) * (1.0 - smoothstep(0.0, 400.0, max(p.y - 600.0, -4600.0 - p.y)));
  col = mix(col, vec3(0.33, 0.39, 0.20) * (0.9 + 0.15 * tn(p / 12.0)), af);
  return col;
}
`;
