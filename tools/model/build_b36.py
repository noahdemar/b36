"""Generate the B-36 exterior and export GLB.

Usage: uv run python build_b36.py [--out path.glb] [--blend path.blend]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "../../web/public/models/b36.glb"))


# ---------------------------------------------------------------- materials

def make_material(name, color, metallic=0.0, roughness=0.5, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


MATS = {}


def init_materials():
    MATS["alu"] = make_material("Aluminum", (0.72, 0.73, 0.75), 1.0, 0.36)
    MATS["alu_dark"] = make_material("AluminumDull", (0.55, 0.56, 0.58), 1.0, 0.48)
    MATS["glass"] = make_material("Glass", (0.03, 0.045, 0.06), 0.0, 0.03, alpha=0.78)
    MATS["black"] = make_material("AntiGlare", (0.015, 0.015, 0.015), 0.0, 0.7)
    MATS["intake"] = make_material("Intake", (0.02, 0.02, 0.022), 0.3, 0.6)
    MATS["exhaust"] = make_material("Exhaust", (0.10, 0.08, 0.07), 0.8, 0.55)
    MATS["prop"] = make_material("PropBlack", (0.02, 0.02, 0.02), 0.2, 0.45)
    MATS["prop_tip"] = make_material("PropTip", (0.85, 0.62, 0.02), 0.0, 0.45)
    MATS["rubber"] = make_material("Rubber", (0.025, 0.025, 0.025), 0.0, 0.85)
    MATS["gear"] = make_material("GearGray", (0.45, 0.46, 0.47), 0.8, 0.45)
    MATS["gun"] = make_material("Gunmetal", (0.08, 0.08, 0.09), 0.9, 0.4)
    MATS["radome"] = make_material("Radome", (0.18, 0.17, 0.15), 0.0, 0.6)


# ---------------------------------------------------------------- mesh helpers

class MeshBuilder:
    """Accumulates verts/faces/material slots in world space."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.face_mats = []
        self.mat_names = []

    def mat_index(self, key):
        if key not in self.mat_names:
            self.mat_names.append(key)
        return self.mat_names.index(key)

    def add_vert(self, v):
        self.verts.append(Vector(v))
        return len(self.verts) - 1

    def add_face(self, idx, mat="alu"):
        self.faces.append(list(idx))
        self.face_mats.append(self.mat_index(mat))

    def loft(self, rings, closed=True, mat_fn=None, cap_start=False, cap_end=False, mat="alu"):
        """rings: list of lists of points (equal length). mat_fn(i, j) -> mat key for quad
        between ring i..i+1, point j..j+1."""
        base = len(self.verts)
        n = len(rings[0])
        for ring in rings:
            for p in ring:
                self.add_vert(p)
        segs = n if closed else n - 1
        for i in range(len(rings) - 1):
            for j in range(segs):
                j2 = (j + 1) % n
                a = base + i * n + j
                b = base + i * n + j2
                c = base + (i + 1) * n + j2
                d = base + (i + 1) * n + j
                key = mat_fn(i, j) if mat_fn else mat
                if key is None:
                    continue
                self.add_face((a, b, c, d), key)
        if cap_start:
            self._cap(rings[0], base, reverse=True, mat=mat)
        if cap_end:
            self._cap(rings[-1], base + (len(rings) - 1) * n, reverse=False, mat=mat)

    def _cap(self, ring, start, reverse, mat):
        c = sum((Vector(p) for p in ring), Vector()) / len(ring)
        ci = self.add_vert(c)
        n = len(ring)
        for j in range(n):
            a, b = start + j, start + (j + 1) % n
            self.add_face((ci, b, a) if reverse else (ci, a, b), mat)

    def mirrored(self):
        m = MeshBuilder()
        m.verts = [Vector((-v.x, v.y, v.z)) for v in self.verts]
        m.faces = [list(reversed(f)) for f in self.faces]
        m.face_mats = list(self.face_mats)
        m.mat_names = list(self.mat_names)
        return m

    def extend(self, other):
        off = len(self.verts)
        self.verts += [v.copy() for v in other.verts]
        for f, mi in zip(other.faces, other.face_mats):
            self.add_face([i + off for i in f], other.mat_names[mi])


ROOT = None


def to_object(name, mb, frame=None, parent=None, smooth_angle=35.0, extras=None):
    frame = frame or Matrix.Identity(4)
    inv = frame.inverted()
    me = bpy.data.meshes.new(name)
    me.from_pydata([inv @ v for v in mb.verts], [], mb.faces)
    for key in mb.mat_names:
        me.materials.append(MATS[key])
    for poly, mi in zip(me.polygons, mb.face_mats):
        poly.material_index = mi
    me.validate()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = frame
    par = parent or ROOT
    if par is not None:
        ob.parent = par
        ob.matrix_parent_inverse = par.matrix_world.inverted()
    if extras:
        for k, v in extras.items():
            ob[k] = v
    return ob


def empty(name, frame=None, parent=None, extras=None):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = frame or Matrix.Identity(4)
    par = parent or ROOT
    if par is not None and par is not ob:
        ob.parent = par
        ob.matrix_parent_inverse = par.matrix_world.inverted()
    if extras:
        for k, v in extras.items():
            ob[k] = v
    return ob


def hinge_frame(p0, p1, up=Vector((0, 0, 1))):
    """Frame with origin p0, local X along p0->p1, local Z closest to `up`."""
    x = (p1 - p0).normalized()
    z = (up - up.dot(x) * x).normalized()
    y = z.cross(x)
    m = Matrix((
        (x.x, y.x, z.x, p0.x),
        (x.y, y.y, z.y, p0.y),
        (x.z, y.z, z.z, p0.z),
        (0, 0, 0, 1),
    ))
    return m


def translation(p):
    return Matrix.Translation(Vector(p))


# glTF export maps Blender (x, y, z) -> (x, z, -y)
def gltf_axis(v):
    return [float(v[0]), float(v[2]), float(-v[1])]


# ---------------------------------------------------------------- math helpers

def pchip(xs, ys):
    """Monotone cubic interpolator."""
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = max(k for k in range(n - 1) if xs[k] <= x)
        t = (x - xs[i]) / h[i]
        h00 = 2 * t**3 - 3 * t**2 + 1
        h10 = t**3 - 2 * t**2 + t
        h01 = -2 * t**3 + 3 * t**2
        h11 = t**3 - t**2
        return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]

    return f


def lerp(a, b, t):
    return a + (b - a) * t


def naca_thickness(x, tc):
    return 5 * tc * (0.2969 * math.sqrt(max(x, 0)) - 0.1260 * x - 0.3516 * x**2
                     + 0.2843 * x**3 - 0.1036 * x**4)


def camber_line(x, m, p=0.4):
    if m == 0:
        return 0.0
    if x < p:
        return m / p**2 * (2 * p * x - x * x)
    return m / (1 - p)**2 * ((1 - 2 * p) + 2 * p * x - x * x)


def cos_space(a, b, n):
    """n+1 points from a to b, clustered at both ends."""
    return [a + (b - a) * 0.5 * (1 - math.cos(math.pi * i / n)) for i in range(n + 1)]


def airfoil_loop(f0, f1, tc, camber, n=36):
    """Closed loop of (s, z) chord-normalized points: upper f1->f0, lower f0->f1.
    Always returns 2n+1 points when f0 == 0, 2n+2 otherwise."""
    xs = cos_space(f0, f1, n)
    upper = [(x, camber_line(x, camber) + naca_thickness(x, tc)) for x in reversed(xs)]
    lower = [(x, camber_line(x, camber) - naca_thickness(x, tc)) for x in xs]
    if f0 == 0:
        lower = lower[1:]
    return upper + lower


class Section:
    """A lifting-surface section: LE point, chord direction, thickness direction."""

    def __init__(self, le, chord_dir, thick_dir, chord, tc, camber=0.0):
        self.le = Vector(le)
        self.cd = Vector(chord_dir).normalized()
        self.td = Vector(thick_dir).normalized()
        self.chord = chord
        self.tc = tc
        self.camber = camber

    def point(self, s, z):
        return self.le + self.cd * (s * self.chord) + self.td * (z * self.chord)

    def ring(self, f0, f1, n):
        return [self.point(s, z) for s, z in airfoil_loop(f0, f1, self.tc, self.camber, n)]

    def hinge_point(self, f):
        return self.point(f, camber_line(f, self.camber))


def surface(mb, sections, ranges, n=36, mat_fn=None, cap_end=True, cap_start=True):
    """Loft sections. ranges[i] = (f0, f1) chord extent for section i."""
    rings = [sec.ring(f0, f1, n) for sec, (f0, f1) in zip(sections, ranges)]
    mb.loft(rings, closed=True, mat_fn=mat_fn, cap_start=cap_start, cap_end=cap_end)
    return rings


def revolve(mb, center_fn, profile, seg=32, axis="y", scale=(1.0, 1.0), mat="alu",
            mat_fn=None, cap_start=False, cap_end=False):
    """Body of revolution along an axis. profile: [(t, r)], center_fn(t) -> Vector."""
    rings = []
    for t, r in profile:
        c = center_fn(t)
        ring = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            u, w = math.sin(a) * r * scale[0], math.cos(a) * r * scale[1]
            if axis == "y":
                ring.append(c + Vector((u, 0, w)))
            elif axis == "x":
                ring.append(c + Vector((0, u, w)))
            else:
                ring.append(c + Vector((u, w, 0)))
        rings.append(ring)
    mb.loft(rings, closed=True, mat=mat, mat_fn=mat_fn, cap_start=cap_start, cap_end=cap_end)
    return rings


def tube(mb, p0, p1, r, seg=16, mat="gear", r1=None):
    p0, p1 = Vector(p0), Vector(p1)
    ax = (p1 - p0).normalized()
    ref = Vector((0, 0, 1)) if abs(ax.z) < 0.9 else Vector((1, 0, 0))
    u = ax.cross(ref).normalized()
    v = ax.cross(u)
    r1 = r if r1 is None else r1
    rings = []
    for p, rr in ((p0, r), (p1, r1)):
        rings.append([p + (u * math.cos(2 * math.pi * k / seg) + v * math.sin(2 * math.pi * k / seg)) * rr
                      for k in range(seg)])
    mb.loft(rings, closed=True, mat=mat, cap_start=True, cap_end=True)


def ellipsoid(mb, c, axes, seg=32, rings_n=16, mat="glass", zmin=None):
    c = Vector(c)
    rings = []
    for i in range(1, rings_n):
        th = math.pi * i / rings_n
        ring = []
        for k in range(seg):
            ph = 2 * math.pi * k / seg
            ring.append(c + Vector((axes[0] * math.sin(th) * math.cos(ph),
                                    axes[1] * math.cos(th),
                                    axes[2] * math.sin(th) * math.sin(ph))))
        rings.append(ring)
    mb.loft(rings, closed=True, mat=mat, cap_start=True, cap_end=True)


# ---------------------------------------------------------------- fuselage

def fus_y(d):
    return P.NOSE_Y - d


FUS_D = [s[0] for s in P.FUS_STATIONS]
FUS_R_FN = pchip(FUS_D, [s[1] for s in P.FUS_STATIONS])
FUS_Z_FN = pchip(FUS_D, [s[2] for s in P.FUS_STATIONS])


def fus_radius(d):
    return FUS_R_FN(d)


def fus_center_z(d):
    return FUS_Z_FN(d)


def build_fuselage():
    end = FUS_D[-1]
    ds = set()
    d = 0.0
    while d < end:
        step = 0.06 if d < 1.5 else (0.15 if d < 6 else (0.25 if d > 30 else 0.6))
        ds.add(round(d, 4))
        d += step
    ds.add(end)
    for a, b in P.BOMB_BAYS:
        ds.add(a)
        ds.add(b)
    ds = sorted(ds)
    n = P.FUS_SEGMENTS
    thetas = [2 * math.pi * k / n for k in range(n)]
    rings = []
    for d in ds:
        r, zc = fus_radius(d), fus_center_z(d)
        rings.append([Vector((r * math.sin(t), fus_y(d), zc + r * math.cos(t))) for t in thetas])

    hull = MeshBuilder()
    doors = {}

    def classify(i, j):
        dm = 0.5 * (ds[i] + ds[i + 1])
        tm = (j + 0.5) / n * 2 * math.pi  # 0 = top, pi = bottom
        from_bottom = abs(tm - math.pi)
        for bi, (a, b) in enumerate(P.BOMB_BAYS):
            if a <= dm <= b and from_bottom < P.BOMB_DOOR_HALF_ANGLE:
                return ("door", bi, "R" if tm < math.pi else "L")
        from_top = min(tm, 2 * math.pi - tm)
        if dm < 1.45 and from_top > math.radians(58):
            return "glass"
        if dm < 1.45:
            return "black"
        if dm < 2.45 and from_top < math.radians(72):
            return "black"
        return "alu"

    def mat_fn(i, j):
        c = classify(i, j)
        if isinstance(c, tuple):
            doors.setdefault((c[1], c[2]), []).append((i, j))
            return None
        return c

    hull.loft(rings, closed=True, mat_fn=mat_fn, cap_start=True, cap_end=True)
    to_object("Fuselage", hull)

    # Bomb bay doors: same skin patches, slightly inset so seams read.
    for (bi, side), quads in sorted(doors.items()):
        mb = MeshBuilder()
        vid = {}

        def v(i, j):
            j %= n
            if (i, j) not in vid:
                p = rings[i][j]
                c = Vector((0, p.y, fus_center_z(ds[i])))
                vid[(i, j)] = mb.add_vert(c + (p - c) * 0.997)
            return vid[(i, j)]

        for i, j in quads:
            mb.add_face((v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i + 1, j)), "alu_dark")
        a, b = P.BOMB_BAYS[bi]
        pivot = Vector((0, fus_y(0.5 * (a + b)), 0.0))
        to_object(f"BombDoor_B{bi + 1}_{side}", mb, frame=translation(pivot),
                  extras={"part": "bombdoor", "bay": bi + 1, "side": side,
                          "axis": gltf_axis((0, 1, 0)), "open_angle": math.radians(75) * (-1 if side == "R" else 1)})

    # Canopy blister
    mb = MeshBuilder()
    cy = fus_y(P.CANOPY_D)
    ellipsoid(mb, (0, cy, P.CANOPY_Z), P.CANOPY_AXES, seg=40, rings_n=24)
    to_object("Canopy", mb)
    # Canopy frames: arches + spine
    mb = MeshBuilder()
    ax, ay, az = P.CANOPY_AXES
    for t in (-0.7, -0.45, -0.2, 0.05, 0.3, 0.55, 0.78):
        y = cy + ay * t
        k = math.sqrt(max(1 - t * t, 0))
        pts = []
        for a in range(0, 181, 12):
            ang = math.radians(a)
            pts.append(Vector((ax * k * math.cos(ang) * 1.01, y, P.CANOPY_Z + az * k * math.sin(ang) * 1.01)))
        rr = fus_radius(P.CANOPY_D)
        pts = [p for p in pts if p.z > math.sqrt(max(rr * rr - p.x * p.x, 0)) - 0.05]
        for p0, p1 in zip(pts, pts[1:]):
            tube(mb, p0, p1, 0.03, seg=6, mat="alu_dark")
    spine = []
    for t in [x / 10 for x in range(-8, 9)]:
        spine.append(Vector((0, cy + ay * t, P.CANOPY_Z + az * math.sqrt(1 - t * t) * 1.01)))
    for p0, p1 in zip(spine, spine[1:]):
        tube(mb, p0, p1, 0.035, seg=6, mat="alu_dark")
    for phi in (32, 62, 118, 148):
        a = math.radians(phi)
        line = []
        for t in [x / 12 for x in range(-11, 12)]:
            k = math.sqrt(1 - t * t)
            line.append(Vector((ax * k * math.cos(a) * 1.01, cy + ay * t, P.CANOPY_Z + az * k * math.sin(a) * 1.01)))
        rr = fus_radius(P.CANOPY_D)
        line = [p for p in line if p.z > math.sqrt(max(rr * rr - p.x * p.x, 0)) - 0.05]
        for p0, p1 in zip(line, line[1:]):
            tube(mb, p0, p1, 0.028, seg=6, mat="alu_dark")
    to_object("CanopyFrame", mb)

    # Nose glazing frames
    mb = MeshBuilder()
    for dd in (0.45, 0.95, 1.45):
        r, zc = fus_radius(dd) * 1.01, fus_center_z(dd)
        pts = [Vector((r * math.sin(t), fus_y(dd), zc + r * math.cos(t)))
               for t in [math.radians(a) for a in range(58, 303, 7)]]
        for p0, p1 in zip(pts, pts[1:]):
            tube(mb, p0, p1, 0.025, seg=6, mat="alu_dark")
    for a in range(60, 301, 30):
        t = math.radians(a)
        pts = []
        for dd in [x * 0.06 for x in range(1, 25)]:
            r, zc = fus_radius(dd) * 1.01, fus_center_z(dd)
            pts.append(Vector((r * math.sin(t), fus_y(dd), zc + r * math.cos(t))))
        for p0, p1 in zip(pts, pts[1:]):
            tube(mb, p0, p1, 0.025, seg=6, mat="alu_dark")
    to_object("NoseFrame", mb)

    # Side windows and sighting blisters (glass)
    mb = MeshBuilder()
    for d, z, s in ((6.4, 0.55, 0.34), (8.3, 0.55, 0.30), (36.8, 0.85, 0.45), (38.6, -0.25, 0.42)):
        r = fus_radius(d)
        zc = fus_center_z(d)
        x = math.sqrt(max(r * r - (z) ** 2, 0.01))
        for sx in (1, -1):
            ellipsoid(mb, (sx * (x - s * 0.55), fus_y(d), zc + z), (s * 0.75, s, s), seg=20, rings_n=10)
    to_object("Blisters", mb)

    # Antennas: dorsal masts
    mb = MeshBuilder()
    for d, h in ((14.0, 0.9), (27.0, 0.7)):
        top = fus_center_z(d) + fus_radius(d)
        tube(mb, (0, fus_y(d), top - 0.1), (0, fus_y(d) - 0.35, top + h), 0.05, seg=8, mat="alu_dark", r1=0.02)
    to_object("Antennas", mb)


# ---------------------------------------------------------------- wing

def tip_round(x, x_round, x_tip):
    """Elliptic planform rounding factor for x beyond x_round."""
    if x <= x_round:
        return 1.0
    u = min((x - x_round) / (x_tip - x_round), 1.0)
    return max(math.sqrt(max(1 - u * u, 0.0)), 0.06)


def wing_planform(x):
    le = P.WING_LE_D0 + x * P.WING_LE_SWEEP
    c = P.WING_TE_D0 + x * P.WING_TE_SWEEP - le
    f = tip_round(x, P.WING_TIP_ROUND_X, P.SEMISPAN)
    return le + 0.45 * c * (1 - f), c * f


def wing_chord(x):
    return wing_planform(x)[1]


def wing_le_y(x):
    return fus_y(wing_planform(x)[0])


def wing_section(x, side=1):
    c = wing_chord(x)
    t = x / P.SEMISPAN
    alpha = P.INCIDENCE - P.WASHOUT * t
    tc = lerp(P.ROOT_TC, P.TIP_TC, t)
    q = Vector((x, wing_le_y(x) - 0.25 * c, P.WING_Z + x * math.tan(P.DIHEDRAL)))
    cd = Vector((0, -math.cos(alpha), -math.sin(alpha)))
    td = Vector((0, -math.sin(alpha), math.cos(alpha)))
    le = q - cd * (0.25 * c)
    return Section(le, cd, td, c, tc, P.CAMBER)


def control_spans():
    spans = [(a, b, f"Flap_{i + 1}", "flap") for i, (a, b) in enumerate(P.FLAP_SPANS)]
    spans.append((*P.AILERON_SPAN, "Aileron", "aileron"))
    return spans


def build_wing():
    eps = 1e-4
    xs = [0.6]
    for a, b, *_ in control_spans():
        xs += [a, b]
    xs += list(P.ENGINE_X) + [P.JETPOD_X]
    xs += [P.SEMISPAN * k / 24 for k in range(1, 24)]
    xs += [lerp(P.WING_TIP_ROUND_X, P.SEMISPAN, k / 10) for k in range(1, 11)]
    xs = sorted(set(round(x, 4) for x in xs))

    def f_end(x):
        for a, b, *_ in control_spans():
            if a + eps < x < b - eps:
                return P.HINGE_FRAC
        return 1.0

    stations = []
    for x in xs:
        boundary = any(abs(x - a) < eps or abs(x - b) < eps for a, b, *_ in control_spans())
        if boundary:
            is_start = any(abs(x - a) < eps for a, b, *_ in control_spans())
            if is_start:
                stations += [(x, 1.0), (x, P.HINGE_FRAC)]
            else:
                stations += [(x, P.HINGE_FRAC), (x, 1.0)]
        else:
            stations.append((x, f_end(x)))

    n = 40
    # Tip: add a rounded cap by shrinking thickness over final stations
    secs, ranges = [], []
    for x, fe in stations:
        secs.append(wing_section(x))
        ranges.append((0.0, fe))

    def mat_fn(i, j):
        x = 0.5 * (secs[i].le.x + secs[i + 1].le.x)
        # LE intake slots in front of each engine: first/last few points around LE
        loop_len = 2 * n + 1
        jm = j if j < loop_len else loop_len - 1
        near_le = -1 <= jm - n <= 3
        if near_le and any(abs(x - ex) < 0.95 for ex in P.ENGINE_X):
            return "intake"
        return "alu"

    mb = MeshBuilder()
    surface(mb, secs, ranges, n=n, mat_fn=mat_fn)
    full = MeshBuilder()
    full.extend(mb)
    full.extend(mb.mirrored())
    to_object("Wing", full)

    # Control surfaces
    gap = 0.008
    for a, b, name, kind in control_spans():
        xs_cs = [lerp(a, b, k / 6) for k in range(7)]
        secs_cs = [wing_section(x) for x in xs_cs]
        mb = MeshBuilder()
        surface(mb, secs_cs, [(P.HINGE_FRAC + gap, 1.0)] * len(secs_cs), n=12)
        h0 = secs_cs[0].hinge_point(P.HINGE_FRAC)
        h1 = secs_cs[-1].hinge_point(P.HINGE_FRAC)
        for side, geo in (("R", mb), ("L", mb.mirrored())):
            if side == "L":
                p0, p1 = Vector((-h1.x, h1.y, h1.z)), Vector((-h0.x, h0.y, h0.z))
            else:
                p0, p1 = h0, h1
            frame = hinge_frame(p0, p1)
            to_object(f"{name}_{side}", geo, frame=frame,
                      extras={"part": kind, "side": side, "axis": [1.0, 0.0, 0.0]})


# ---------------------------------------------------------------- engines

def wing_point(x, s, zfrac=0.0):
    sec = wing_section(x)
    return sec.point(s, camber_line(s, sec.camber) + zfrac * sec.tc)


def lower_surface_z(sec, f):
    return sec.point(f, camber_line(f, sec.camber) - naca_thickness(f, sec.tc)).z


def build_engines():
    for idx, ex in enumerate(P.ENGINE_X):
        sec = wing_section(ex)
        te = sec.point(1.0, 0.0)
        axis_z = te.z + 0.05
        prop_y = te.y - P.PROP_AFT_OF_TE
        y_front = sec.le.y - 0.04 * sec.chord
        z_front = lower_surface_z(sec, 0.06) + 0.12
        y_te = te.y
        y_end = prop_y + 0.12

        def center(t):
            # t in [0, 1] along nacelle: front .. prop. Rises from the wing underside to prop axis.
            y = lerp(y_front, y_end, t)
            z = lerp(z_front, axis_z, min(1.0, t / 0.85) ** 1.5)
            return Vector((ex, y, z))

        L = y_front - y_end
        t_te = (y_front - y_te) / L
        prof = [(0.0, 0.12), (0.03, 0.42), (0.10, 0.60), (0.25, 0.74), (0.45, 0.86), (0.65, 0.94),
                (t_te, 0.95), (t_te + 0.4 * (1 - t_te), 0.92), (t_te + 0.75 * (1 - t_te), 0.74),
                (1.0, 0.46)]
        mb = MeshBuilder()
        revolve(mb, center, prof, seg=40, scale=(P.NACELLE_W / 1.9, 1.0))
        # Chin intake under the leading edge
        ellipsoid(mb, (ex, y_front - 0.35, z_front - 0.22), (0.62, 0.32, 0.24), seg=24, rings_n=10, mat="intake")
        # Exhaust stubs either side of nacelle aft of TE
        for sx in (1, -1):
            p = Vector((ex + sx * 0.86, y_te - 0.2, axis_z - 0.45))
            tube(mb, p, p + Vector((sx * 0.08, -0.55, -0.05)), 0.12, seg=10, mat="exhaust")
        # Cooling air exit lip ring around nacelle at TE
        ring_t = (y_front - (y_te - 0.45)) / L
        c = center(ring_t)
        revolve(mb, lambda t, c=c: c + Vector((0, -t, 0)),
                [(0.0, 0.945), (0.10, 0.945)], seg=40, scale=(P.NACELLE_W / 1.9, 1.0), mat="exhaust")
        for side, geo in (("R", mb), ("L", mb.mirrored())):
            to_object(f"Nacelle_{side}{idx + 1}", geo)
        build_prop(idx, Vector((ex, prop_y, axis_z)))


def build_prop(idx, hub):
    R = P.PROP_DIAM / 2
    mb = MeshBuilder()
    # Spinner (points aft for pusher)
    revolve(mb, lambda t: hub + Vector((0, -t, 0)),
            [(-0.15, 0.46), (0.0, 0.47), (0.3, 0.42), (0.6, 0.30), (0.85, 0.15), (0.98, 0.02)],
            seg=32, mat="alu", cap_start=True)
    # Blades
    rs = [0.40 + (R - 0.40) * k / 16 for k in range(17)]
    axis = Vector((0, -1, 0))
    for b in range(3):
        phi = 2 * math.pi * b / 3 + math.radians(15)
        er = Vector((math.sin(phi), 0, math.cos(phi)))
        et = axis.cross(er).normalized()
        secs, rings_mats = [], []
        for r in rs:
            u = (r - 0.4) / (R - 0.4)
            chord = 0.30 + 0.22 * math.sin(math.pi * min(u * 1.25, 1.0)) - 0.12 * u * u
            beta = math.radians(lerp(55, 18, u))
            tc = lerp(0.32, 0.06, min(u * 1.4, 1))
            cd = (et * math.cos(beta) + axis * math.sin(beta))
            td = (-et * math.sin(beta) + axis * math.cos(beta))
            le = hub + er * r - cd * (0.35 * chord)
            secs.append(Section(le, cd, td, chord, tc))
            rings_mats.append("prop_tip" if r > R - 0.28 else "prop")
        surface(mb, secs, [(0, 1)] * len(secs), n=10,
                mat_fn=lambda i, j, m=rings_mats: m[i + 1], cap_end=True, cap_start=True)
    extras = {"part": "prop", "axis": gltf_axis((0, 1, 0)), "engine": idx + 1}
    to_object(f"Prop_R{idx + 1}", mb, frame=translation(hub), extras={**extras, "side": "R"})
    m = mb.mirrored()
    hub_l = Vector((-hub.x, hub.y, hub.z))
    to_object(f"Prop_L{idx + 1}", m, frame=translation(hub_l), extras={**extras, "side": "L"})


def build_jetpods():
    x = P.JETPOD_X
    sec = wing_section(x)
    wz = sec.point(0.3, 0).z
    cz = wz - P.JETPOD_DROP
    y0 = fus_y(P.JETPOD_FRONT_D)
    mb = MeshBuilder()
    for off in (-0.53, 0.53):
        def center(t, off=off):
            return Vector((x + off, y0 - t, cz))
        L = P.JET_LEN
        prof = [(0.0, 0.44), (0.05, 0.52), (0.25, 0.57), (0.8, 0.59), (0.68 * L, 0.59),
                (0.88 * L, 0.50), (L, 0.36)]
        revolve(mb, center, prof, seg=32, mat="alu")
        # Intake face and louvers
        revolve(mb, center, [(0.0, 0.44), (0.18, 0.40), (0.2, 0.0)], seg=32, mat="intake")
        for k in range(-3, 4):
            zz = cz + k * 0.11
            hw = math.sqrt(max(0.42**2 - (k * 0.11)**2, 0))
            tube(mb, (x + off - hw, y0 - 0.06, zz), (x + off + hw, y0 - 0.06, zz), 0.018, seg=6, mat="alu_dark")
        # Exhaust
        revolve(mb, center, [(P.JET_LEN, 0.36), (P.JET_LEN - 0.02, 0.30), (P.JET_LEN - 0.6, 0.0)],
                seg=32, mat="exhaust")
    # Pylon
    top_le = sec.point(0.08, 0)
    pyl_secs = []
    for t in (0.0, 1.0):
        z = lerp(cz + 0.45, wz, t)
        chord = lerp(3.2, 3.6, t)
        le = Vector((x, lerp(y0 - 0.5, top_le.y, t), z))
        pyl_secs.append(Section(le, (0, -1, 0), (1, 0, 0), chord, 0.10))
    surface(mb, pyl_secs, [(0, 1), (0, 1)], n=16)
    for side, geo in (("R", mb), ("L", mb.mirrored())):
        to_object(f"JetPod_{side}", geo)


# ---------------------------------------------------------------- tail

def split_stations(vals, a, b, inner_range, outer=(0, 1)):
    """Station list with duplicated boundaries so a cut-out spans a..b."""
    out = []
    for v in sorted(set(vals + [a, b])):
        if abs(v - a) < 1e-6:
            out += [(v, outer), (v, inner_range)]
        elif abs(v - b) < 1e-6:
            out += [(v, inner_range), (v, outer)]
        else:
            out.append((v, inner_range if a < v < b else outer))
    return out


def build_tail():
    # ---- Vertical fin: span along z, contour from the three-view
    le_fn = pchip([p[0] for p in P.FIN_LE], [p[1] for p in P.FIN_LE])
    te_fn = pchip([p[0] for p in P.FIN_TE], [p[1] for p in P.FIN_TE])
    z_top = P.FIN_LE[-1][0]

    def fin_sec(z):
        le, te = le_fn(z), te_fn(z)
        c = max(te - le, 0.02)
        tc = min(0.12, P.FIN_MAX_THICK / c)
        if z > 9.3:  # thin out into the rounded tip
            tc *= lerp(1.0, 0.4, (z - 9.3) / (z_top - 9.3))
        return Section((0, fus_y(le), z), (0, -1, 0), (-1, 0, 0), c, tc)

    def hinge_f(z):
        sec_le, sec_te = le_fn(z), te_fn(z)
        return (P.RUDDER_HINGE_D - sec_le) / (sec_te - sec_le)

    rz0, rz1 = P.RUDDER_Z
    zs = [lerp(P.FIN_ROOT_Z, 9.3, k / 24) for k in range(25)] + [lerp(9.3, z_top - 0.005, k / 8) for k in range(1, 9)]
    secs, ranges = [], []
    for z, rng in split_stations(zs, rz0, rz1, "hinge"):
        secs.append(fin_sec(z))
        ranges.append((0, hinge_f(z)) if rng == "hinge" else rng)
    mb = MeshBuilder()
    surface(mb, secs, ranges, n=32)
    to_object("Fin", mb)

    rzs = [lerp(rz0, rz1, k / 10) for k in range(11)]
    rsecs = [fin_sec(z) for z in rzs]
    mb = MeshBuilder()
    surface(mb, rsecs, [(hinge_f(z) + 0.01, 1) for z in rzs], n=12)
    p0 = Vector((0, fus_y(P.RUDDER_HINGE_D), rz0))
    p1 = Vector((0, fus_y(P.RUDDER_HINGE_D), rz1))
    to_object("Rudder", mb, frame=hinge_frame(p0, p1, up=Vector((-1, 0, 0))),
              extras={"part": "rudder", "axis": [1.0, 0.0, 0.0]})

    # ---- Horizontal tail: planform from the three-view, rounded tips
    semi = P.HT_SEMISPAN

    def ht_planform(x):
        le = P.HT_LE_D0 + x * P.HT_LE_SWEEP
        c = P.HT_TE_D0 + x * P.HT_TE_SWEEP - le
        f = tip_round(x, P.HT_TIP_ROUND_X, semi)
        return le + 0.5 * c * (1 - f), c * f

    def ht_sec(x):
        le, c = ht_planform(x)
        tc = lerp(0.13, 0.10, x / semi)
        return Section((x, fus_y(le), P.HT_Z), (0, -1, 0), (0, 0, 1), c, tc)

    def ht_hinge_f(x):
        le0 = P.HT_LE_D0 + x * P.HT_LE_SWEEP
        c0 = P.HT_TE_D0 + x * P.HT_TE_SWEEP - le0
        hinge_d = le0 + P.ELEVATOR_FRAC * c0
        le, c = ht_planform(x)
        return (hinge_d - le) / c

    e0, e1 = 0.95, P.HT_TIP_ROUND_X + 0.6
    xs = [semi * k / 14 for k in range(14)] + [lerp(P.HT_TIP_ROUND_X, semi - 0.005, k / 8) for k in range(1, 9)]
    secs, ranges = [], []
    for x, rng in split_stations(xs, e0, e1, "hinge"):
        secs.append(ht_sec(x))
        ranges.append((0, ht_hinge_f(x)) if rng == "hinge" else rng)
    mb = MeshBuilder()
    surface(mb, secs, ranges, n=28)
    full = MeshBuilder()
    full.extend(mb)
    full.extend(mb.mirrored())
    to_object("Stabilizer", full)

    exs = [lerp(e0, e1, k / 10) for k in range(11)]
    esecs = [ht_sec(x) for x in exs]
    mb = MeshBuilder()
    surface(mb, esecs, [(ht_hinge_f(x) + 0.01, 1) for x in exs], n=10)
    h0 = esecs[0].hinge_point(ht_hinge_f(e0))
    h1 = esecs[-1].hinge_point(ht_hinge_f(e1))
    to_object("Elevator_R", mb, frame=hinge_frame(h0, h1),
              extras={"part": "elevator", "side": "R", "axis": [1.0, 0.0, 0.0]})
    to_object("Elevator_L", mb.mirrored(),
              frame=hinge_frame(Vector((-h1.x, h1.y, h1.z)), Vector((-h0.x, h0.y, h0.z))),
              extras={"part": "elevator", "side": "L", "axis": [1.0, 0.0, 0.0]})


# ---------------------------------------------------------------- gear

def wheel(mb, center, r, width, axis=Vector((1, 0, 0))):
    c = Vector(center)
    h = axis * (width / 2)
    revolve(mb, lambda t: c + axis * t,
            [(-width / 2, r * 0.55), (-width / 2 + 0.02, r * 0.92), (-width / 4, r), (width / 4, r),
             (width / 2 - 0.02, r * 0.92), (width / 2, r * 0.55)],
            seg=28, axis="x", mat="rubber")
    for s in (-1, 1):
        revolve(mb, lambda t, s=s: c + h * s * (1 + t), [(0.0, r * 0.55), (0.0, 0.0)], seg=28, axis="x",
                mat="gear")


def build_gear():
    g = P.GROUND_Z
    for side, sx in (("R", 1), ("L", -1)):
        mb = MeshBuilder()
        x = sx * P.MAIN_GEAR_X
        top = Vector((x, fus_y(P.MAIN_GEAR_D), wing_section(P.MAIN_GEAR_X).point(0.5, 0).z - 0.6))
        bogie_z = g + P.MAIN_WHEEL_R
        tube(mb, top, (x, fus_y(P.MAIN_GEAR_D), bogie_z + 0.25), 0.2, seg=16)
        tube(mb, (x, fus_y(P.MAIN_GEAR_D), bogie_z + 0.25), (x, fus_y(P.MAIN_GEAR_D), bogie_z), 0.15, seg=16)
        # drag brace
        tube(mb, (x, fus_y(P.MAIN_GEAR_D) + 2.2, top.z + 0.2), (x, fus_y(P.MAIN_GEAR_D), bogie_z + 1.4), 0.09, seg=10)
        tube(mb, (x, fus_y(P.MAIN_GEAR_D) + 0.9, bogie_z), (x, fus_y(P.MAIN_GEAR_D) - 0.9, bogie_z), 0.12, seg=12)
        for dy in (0.9, -0.9):
            tube(mb, (x - 0.65, fus_y(P.MAIN_GEAR_D) + dy, bogie_z), (x + 0.65, fus_y(P.MAIN_GEAR_D) + dy, bogie_z), 0.08, seg=10)
            for dx in (-0.42, 0.42):
                wheel(mb, (x + dx, fus_y(P.MAIN_GEAR_D) + dy, bogie_z), P.MAIN_WHEEL_R, 0.42)
        to_object(f"Gear_Main_{side}", mb, frame=translation(top),
                  extras={"part": "gear", "side": side, "axis": [0.0, 0.0, 1.0]})

    mb = MeshBuilder()
    y = fus_y(P.NOSE_GEAR_D)
    top = Vector((0, y, fus_center_z(P.NOSE_Y - y) - fus_radius(P.NOSE_Y - y) + 0.3))
    wz = g + P.NOSE_WHEEL_R
    tube(mb, top, (0, y - 0.25, wz + 0.2), 0.16, seg=14)
    tube(mb, (-0.45, y - 0.25, wz), (0.45, y - 0.25, wz), 0.07, seg=10)
    for dx in (-0.3, 0.3):
        wheel(mb, (dx, y - 0.25, wz), P.NOSE_WHEEL_R, 0.32)
    tube(mb, (0, y + 1.6, top.z + 0.05), (0, y - 0.15, wz + 1.0), 0.07, seg=10)
    to_object("Gear_Nose", mb, frame=translation(top),
              extras={"part": "gear", "side": "C", "axis": [1.0, 0.0, 0.0]})


# ---------------------------------------------------------------- turrets

def build_turret(name, pivot, up, fwd, dome=(0.62, 0.62, 0.38), barrel_len=2.0, retract=0.0):
    """Turret: yaw node (dome) with child pitch node (twin 20 mm). up/fwd are world vectors."""
    pivot, up = Vector(pivot), Vector(up).normalized()
    fwd = Vector(fwd)
    fwd = (fwd - fwd.dot(up) * up).normalized()
    side = fwd.cross(up).normalized()
    frame = Matrix((
        (side.x, fwd.x, up.x, pivot.x),
        (side.y, fwd.y, up.y, pivot.y),
        (side.z, fwd.z, up.z, pivot.z),
        (0, 0, 0, 1),
    ))
    # build in local space then transform
    mb = MeshBuilder()
    ellipsoid(mb, (0, 0, 0), dome, seg=28, rings_n=14, mat="alu_dark")
    revolve(mb, lambda t: Vector((0, 0, t)), [(-0.05, dome[0] * 1.05), (0.05, dome[0] * 1.05)],
            axis="z", seg=28, mat="alu_dark")
    mb.verts = [frame @ v for v in mb.verts]
    yaw = to_object(name, mb, frame=frame,
                    extras={"part": "turret_yaw", "axis": gltf_axis((0, 0, 1)), "retract": retract})
    gmb = MeshBuilder()
    for sx in (-0.2, 0.2):
        tube(gmb, (sx, 0.1, 0.12), (sx, barrel_len, 0.12), 0.055, seg=10, mat="gun", r1=0.045)
        tube(gmb, (sx, barrel_len - 0.25, 0.12), (sx, barrel_len, 0.12), 0.07, seg=10, mat="gun")
    tube(gmb, (-0.3, 0.0, 0.12), (0.3, 0.0, 0.12), 0.14, seg=12, mat="gun")
    gframe = frame @ translation((0, 0, 0))
    gmb.verts = [gframe @ v for v in gmb.verts]
    to_object(name + "_Guns", gmb, frame=gframe, parent=yaw,
              extras={"part": "turret_pitch", "axis": [1.0, 0.0, 0.0]})


def build_turrets():
    def top(d):
        return fus_center_z(d) + fus_radius(d)

    def bot(d):
        return fus_center_z(d) - fus_radius(d)

    for d, label in ((10.6, "UpperFwd"), (35.6, "UpperAft")):
        for sx, s in ((1, "R"), (-1, "L")):
            a = math.radians(28)
            r = fus_radius(d)
            pivot = (sx * r * math.sin(a) * 0.98, fus_y(d), fus_center_z(d) + r * math.cos(a) * 0.98)
            up = Vector((sx * math.sin(a), 0, math.cos(a)))
            build_turret(f"Turret_{label}_{s}", Vector(pivot) - up * 0.95, up, (0, 1, 0), retract=0.95)
    for sx, s in ((1, "R"), (-1, "L")):
        d = 36.0
        a = math.radians(152)
        r = fus_radius(d)
        pivot = (sx * r * math.sin(a) * 0.98, fus_y(d), fus_center_z(d) + r * math.cos(a) * 0.98)
        up = Vector((sx * math.sin(a), 0, math.cos(a)))
        build_turret(f"Turret_LowerAft_{s}", Vector(pivot) - up * 0.95, up, (0, -1, 0), retract=0.95)
    # Nose turret (chin) and tail turret
    build_turret("Turret_Nose", (0, fus_y(0.9), fus_center_z(0.9) - 0.55), (0, 0.6, -1), (0, 1, 0),
                 dome=(0.42, 0.42, 0.36), barrel_len=1.4)
    d_end = FUS_D[-1]
    build_turret("Turret_Tail", (0, fus_y(d_end) - 0.3, fus_center_z(d_end) - 0.15), (0, 0, 1),
                 (0, -1, 0), dome=(0.62, 0.62, 0.62), barrel_len=1.8)
    # Tail radome above tail turret
    mb = MeshBuilder()
    ellipsoid(mb, (0, fus_y(d_end) + 0.1, fus_center_z(d_end) + 0.55), (0.42, 0.75, 0.36), mat="radome")
    to_object("TailRadome", mb)
    # Ventral search radar radome (APS-23) forward of bomb bays
    mb = MeshBuilder()
    ellipsoid(mb, (0, fus_y(P.RADOME_D), bot(P.RADOME_D) + 0.08), (1.1, 1.6, 0.42), mat="radome")
    to_object("BellyRadome", mb)


# ---------------------------------------------------------------- main

def build():
    global ROOT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    init_materials()
    ROOT = None
    ROOT = empty("B36", extras={"generator": "build_b36.py", "units": "m"})
    build_fuselage()
    build_wing()
    build_engines()
    build_jetpods()
    build_tail()
    build_gear()
    build_turrets()


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True,
                              export_extras=True, export_apply=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--blend", default=None)
    args = ap.parse_args()
    build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons)
               for o in bpy.data.objects if o.type == "MESH")
    print(f"objects={len(bpy.data.objects)} triangles={tris}")
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend))
    export(args.out)
    print("exported", args.out, os.path.getsize(args.out) // 1024, "KiB")


if __name__ == "__main__":
    main()
