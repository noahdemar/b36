"""Generate the B-36 flight deck interior (forward compartment, upper deck) and export GLB.

Usage: uv run python build_interior.py [--out path.glb]

Same coordinate system as build_b36.py. Layout from the flight manual's Fig 1-3 "Forward Cabin
Arrangement" and USAF walkaround photos (reference/cockpit/). Positions are ESTIMATED from those
images unless noted.

Exported node conventions (read by web/src/cockpit.ts):
  extras.instrument + extras.needle   needle node, rotates about extras.axis; angle (deg, clockwise
                                      as seen by the pilot) from extras.scale [v0, a0, v1, a1, ...]
                                      or extras.period (deg = 360 * (value mod period) / period)
  extras.card                         rotating dial card (heading)
  extras.att                          attitude ball: "roll" node > "pitch" node
  extras.control                      clickable control; extras.axis, extras.min/max (rad)
  extras.seat                         eye point empty for a crew seat
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_b36 as B  # noqa: E402
import dials  # noqa: E402
import params as P  # noqa: E402
from build_b36 import MeshBuilder, gltf_axis, revolve, to_object, tube  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "../../web/public/models/b36_interior.glb"))
TEX_DIR = os.path.join(HERE, "build_tex")

# ------------------------------------------------------------------ layout (ESTIMATED)
FLOOR_Z = 0.25            # flight deck floor
LOWER_FLOOR_Z = -1.55     # lower deck floor
PANEL_D = 3.62            # main instrument panel (distance aft of nose)
PANEL_TILT = math.radians(8)
PANEL_HALF_W = 1.15
PANEL_BOTTOM = 0.70
INST_DROP = 0.16          # instruments lowered with the panel so the crew sees over the glareshield
SEAT_X = 0.62             # seat centerline offset (left seat = aircraft commander)
SEAT_D = 4.62             # seat back position
EYE = (SEAT_X, 4.52, 1.52)  # (|x|, d, z) design eye point
DECK_END_D = 12.4         # aft bulkhead of forward compartment


# Collision / navigation registry, exported to b36_nav.json (see export_nav).
OBSTACLES = []   # (name, x0, x1, d0, d1, z0, z1) in build coordinates
SEATS = []       # dicts: name, station, eye (x, d, z), yaw (rad, 0 = forward), stand (x, d, z), deck, flies


def obstacle(name, x0, x1, d0, d1, z0, z1):
    OBSTACLES.append((name, min(x0, x1), max(x0, x1), min(d0, d1), max(d0, d1), min(z0, z1), max(z0, z1)))


def W(x, d, z):
    return Vector((x, B.fus_y(d), z))


def frame_from(origin, x_axis, y_axis):
    x = Vector(x_axis).normalized()
    y = Vector(y_axis)
    y = (y - y.dot(x) * x).normalized()
    z = x.cross(y)
    o = Vector(origin)
    return Matrix(((x.x, y.x, z.x, o.x), (x.y, y.y, z.y, o.y), (x.z, y.z, z.z, o.z), (0, 0, 0, 1)))


def upframe(origin, fwd=(0, 1, 0)):
    """Control frame: local X right, Y forward, Z up (so +rotation about X moves the top aft)."""
    return frame_from(origin, (1, 0, 0), fwd)


def box(mb, frame, x0, x1, y0, y1, z0, z1, mat):
    """Box in a local frame (Matrix), outward normals."""
    c = [frame @ Vector((x, y, z)) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    idx = [mb.add_vert(p) for p in c]
    q = lambda a, b, cc, d: mb.add_face((idx[a], idx[b], idx[cc], idx[d]), mat)  # noqa: E731
    q(0, 2, 3, 1)  # bottom
    q(4, 5, 7, 6)  # top
    q(0, 1, 5, 4)
    q(2, 6, 7, 3)
    q(0, 4, 6, 2)
    q(1, 3, 7, 5)


WORLD = Matrix.Identity(4)


def wbox(mb, x0, x1, d0, d1, z0, z1, mat):
    """World-aligned box given x, d (aft distance) and z ranges."""
    box(mb, WORLD, x0, x1, B.fus_y(d1), B.fus_y(d0), z0, z1, mat)


def polygon_plate(mb, frame, pts, thick, mat_front, mat_side=None):
    """Extrude a convex-ish outline (local XY, CCW seen from +Z) along -Z by thick."""
    mat_side = mat_side or mat_front
    front = [mb.add_vert(frame @ Vector((x, y, 0))) for x, y in pts]
    back = [mb.add_vert(frame @ Vector((x, y, -thick))) for x, y in pts]
    c_f = mb.add_vert(frame @ Vector((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 0)))
    c_b = mb.add_vert(frame @ Vector((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), -thick)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        mb.add_face((c_f, front[i], front[j]), mat_front)
        mb.add_face((c_b, back[j], back[i]), mat_side)
        mb.add_face((front[i], back[i], back[j], front[j]), mat_side)


def disc(mb, frame, r, z, uv_rect=None, mat="dial", seg=40):
    """Disc in local XY plane at height z facing +Z, optional UV mapping into an atlas cell."""
    c = mb.add_vert(frame @ Vector((0, 0, z)))
    ring = [mb.add_vert(frame @ Vector((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z)))
            for k in range(seg)]
    for k in range(seg):
        a0, a1 = 2 * math.pi * k / seg, 2 * math.pi * (k + 1) / seg
        uv = None
        if uv_rect:
            u0, v0, u1, v1 = uv_rect
            cu, cv, hu, hv = (u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2
            uv = [(cu, cv), (cu + hu * math.cos(a0), cv + hv * math.sin(a0)),
                  (cu + hu * math.cos(a1), cv + hv * math.sin(a1))]
        mb.add_face((c, ring[k], ring[(k + 1) % seg]), mat, uv)


def annulus(mb, frame, r0, r1, z, mat, seg=40):
    inner = [frame @ Vector((r0 * math.cos(2 * math.pi * k / seg), r0 * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)]
    outer = [frame @ Vector((r1 * math.cos(2 * math.pi * k / seg), r1 * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)]
    mb.loft([outer, inner], closed=True, mat=mat)


def local_tube(mb, frame, p0, p1, r, mat, seg=12, r1=None):
    tube(mb, frame @ Vector(p0), frame @ Vector(p1), r, seg=seg, mat=mat, r1=r1)


# ------------------------------------------------------------------ materials

def init_materials():
    B.init_materials()
    mk = B.make_material
    M = B.MATS
    M["interior"] = mk("InteriorGreen", (0.10, 0.13, 0.11), 0.0, 0.75)
    M["insulation"] = mk("Insulation", (0.035, 0.04, 0.045), 0.0, 0.95)
    M["panel"] = mk("PanelBlack", (0.018, 0.018, 0.02), 0.1, 0.55)
    M["console"] = mk("ConsoleGreen", (0.16, 0.22, 0.20), 0.0, 0.7)
    M["cushion"] = mk("CushionGreen", (0.22, 0.28, 0.12), 0.0, 0.95)
    M["seatframe"] = mk("SeatFrame", (0.10, 0.12, 0.10), 0.6, 0.5)
    M["floor"] = mk("Floor", (0.06, 0.065, 0.06), 0.2, 0.8)
    M["needle"] = mk("Needle", (0.95, 0.93, 0.85), 0.0, 0.4)
    M["needle_orange"] = mk("NeedleOrange", (0.95, 0.45, 0.05), 0.0, 0.4)
    M["knob"] = mk("Knob", (0.03, 0.03, 0.03), 0.0, 0.45)
    M["knob_red"] = mk("KnobRed", (0.55, 0.04, 0.03), 0.0, 0.45)
    M["lamp_red"] = mk("LampRed", (0.6, 0.05, 0.03), 0.0, 0.2)
    M["chrome"] = mk("Chrome", (0.8, 0.8, 0.8), 1.0, 0.2)
    M["placard"] = mk("Placard", (0.75, 0.72, 0.62), 0.0, 0.8)
    os.makedirs(TEX_DIR, exist_ok=True)
    atlas_path = os.path.join(TEX_DIR, "dials.png")
    uv = dials.build_atlas(atlas_path)
    M["dial"] = B.make_texture_material("Dials", atlas_path, roughness=0.5)
    ball_path = os.path.join(TEX_DIR, "attitude_ball.png")
    dials.draw_attitude_ball().save(ball_path)
    M["ball"] = B.make_texture_material("AttitudeBall", ball_path, roughness=0.4)
    return uv


# ------------------------------------------------------------------ shell, floors, bulkheads

def build_canopy_frames_inner():
    to_object("Int_CanopyFrame", B.canopy_frames(0.04, inset=0.05, mat="black"))


def build_shell():
    """Inner skin of the forward and aft compartments, open under glazing and blisters."""
    for name, ds in (
        ("Int_Shell", [0.4 + 0.1 * k for k in range(12)] + [1.6 + (DECK_END_D - 1.6) * k / 80 for k in range(81)]
         + list(P.CANOPY_ARCHES_D)),
        ("Int_ShellAft", [P.AFT_COMP_D[0] + (P.AFT_COMP_D[1] - P.AFT_COMP_D[0]) * k / 40 for k in range(41)]),
    ):
        shell_section(name, sorted(set(round(d, 4) for d in ds)))


def shell_section(name, ds):
    n = 96
    thetas = [2 * math.pi * k / n for k in range(n)]
    rings = [[B.hull_point(d, t, inset=0.06) for t in thetas] for d in ds]

    def mat_fn(i, j):
        dm = 0.5 * (ds[i] + ds[i + 1])
        tm = (j + 0.5) / n * 2 * math.pi
        from_top = min(tm, 2 * math.pi - tm)
        if B.is_glazed(dm, tm) or (dm < 1.45 and from_top > math.radians(58)) or B.under_blister(dm, tm, 0.06):
            return None
        return "insulation" if from_top < math.radians(110) else "interior"

    mb = MeshBuilder()
    mb.loft(rings, closed=True, mat_fn=mat_fn)
    to_object(name, mb.flipped(), smooth_angle=50)


def hull_half_width(d, z, inset=0.06):
    r = B.fus_radius(d) - inset
    dz = z - B.fus_center_z(d)
    return math.sqrt(max(r * r - dz * dz, 0.0))


def build_floors():
    mb = MeshBuilder()
    t = 0.05
    hw = hull_half_width(6.0, FLOOR_Z - t) - 0.01
    fwd_w = hull_half_width(2.6, FLOOR_Z - t) - 0.01
    wbox(mb, -fwd_w, fwd_w, 2.6, PANEL_D, FLOOR_Z - t, FLOOR_Z, "floor")   # structure under the panel
    wbox(mb, -hw, hw, PANEL_D, 7.6, FLOOR_Z - t, FLOOR_Z, "floor")
    wbox(mb, -0.35, hw, 7.6, 8.6, FLOOR_Z - t, FLOOR_Z, "floor")       # ladder opening on the left
    wbox(mb, -hw, -1.25, 7.6, 8.6, FLOOR_Z - t, FLOOR_Z, "floor")
    wbox(mb, -hw, hw, 8.6, DECK_END_D, FLOOR_Z - t, FLOOR_Z, "floor")
    lw = hull_half_width(6.0, LOWER_FLOOR_Z) - 0.02
    lw_f = hull_half_width(2.7, LOWER_FLOOR_Z) - 0.02
    wbox(mb, -lw_f, lw_f, 2.7, 4.2, LOWER_FLOOR_Z - t, LOWER_FLOOR_Z, "floor")
    wbox(mb, -lw, lw, 4.2, DECK_END_D, LOWER_FLOOR_Z - t, LOWER_FLOOR_Z, "floor")
    to_object("Int_Floors", mb)
    # Ladder down to the lower deck (separate node so it can be clicked)
    mb = MeshBuilder()
    for x in (-1.15, -0.45):
        tube(mb, W(x, 8.35, LOWER_FLOOR_Z), W(x, 8.0, FLOOR_Z + 0.9), 0.025, seg=8, mat="seatframe")
    for k in range(1, 7):
        f = k / 7
        z = LOWER_FLOOR_Z + (FLOOR_Z - LOWER_FLOOR_Z) * f
        dd = 8.35 - 0.35 * f * (FLOOR_Z + 0.9 - LOWER_FLOOR_Z) / (FLOOR_Z + 0.9 - LOWER_FLOOR_Z)
        tube(mb, W(-1.15, dd, z), W(-0.45, dd, z), 0.018, seg=8, mat="seatframe")
    to_object("Int_Ladder", mb, extras={"ladder": "fwd"})

    # Aft bulkhead with tunnel hatch (tunnel runs aft over the bomb bays)
    mb = MeshBuilder()
    d = DECK_END_D
    frame = frame_from(W(0, d, B.fus_center_z(d)), (1, 0, 0), (0, 0, 1))
    r = B.fus_radius(d) - 0.06
    pts = [(r * math.cos(2 * math.pi * k / 48), r * math.sin(2 * math.pi * k / 48)) for k in range(48)]
    polygon_plate(mb, frame, pts, 0.04, "interior")
    hatch = frame_from(W(P.TUNNEL["x"], d - 0.005, P.TUNNEL["z"]), (1, 0, 0), (0, 0, 1))
    disc(mb, hatch, P.TUNNEL["r"], 0.0, mat="insulation", seg=32)
    annulus(mb, hatch, P.TUNNEL["r"], P.TUNNEL["r"] + 0.07, 0.005, "seatframe", seg=32)
    to_object("Int_AftBulkhead", mb)


# ------------------------------------------------------------------ main panel and instruments

def panel_frame():
    """Panel local frame: X right, Y up the panel face, Z toward the crew."""
    up = Vector((0, math.sin(PANEL_TILT), math.cos(PANEL_TILT)))
    return frame_from(W(0, PANEL_D, 0), (1, 0, 0), up)


def panel_top(u):
    return 1.16 + 0.24 * math.sqrt(max(0.0, 1 - (u / (PANEL_HALF_W + 0.23)) ** 2))


AC_CLUSTER = [  # (kind, u, v, r)  aircraft commander (left)
    ("vsi", -1.02, 1.22, 0.050), ("asi", -0.80, 1.25, 0.062), ("radalt", -0.58, 1.27, 0.050),
    ("manp", -0.40, 1.27, 0.045), ("alt", -1.02, 1.06, 0.052), ("heading", -0.80, 1.06, 0.072),
    ("att", -0.58, 1.07, 0.068), ("rpm", -0.40, 1.12, 0.045), ("clock", -1.02, 0.93, 0.040),
    ("turn", -0.66, 0.925, 0.045),
]
P_CLUSTER = [  # pilot (right)
    ("asi", 0.46, 1.25, 0.055), ("heading", 0.70, 1.22, 0.068), ("att", 0.94, 1.18, 0.062),
    ("alt", 0.46, 1.06, 0.052), ("turn", 0.70, 1.03, 0.045), ("vsi", 0.94, 1.02, 0.048),
]
JET_ROWS = ["jet_rpm", "jet_egt", "jet_fuel", "jet_oil"]

# value sources (client sim variable names) per dial kind; list = one entry per needle
SOURCES = {
    "asi": [("ias_mph", None)], "vsi": [("vs_fpm", None)], "turn": [("turn_rate", None)],
    "rpm": [("rpm_avg", None)], "manp": [("map_avg", None)], "radalt": [("agl_ft", None)],
    "alt": [("alt_ft", 1000), ("alt_ft", 10000)], "clock": [("clock_h", 12), ("clock_m", 60)],
}


def flat_scale(kind):
    return [float(x) for pair in dials.DIALS[kind]["scale"] for x in pair]


def needle_mesh(length, width, tail, z, mat="needle"):
    mb = MeshBuilder()
    pts = [(0, length), (-width, 0), (-width * 0.7, -tail), (width * 0.7, -tail), (width, 0)]
    vs = [mb.add_vert(Vector((x, y, z))) for x, y in pts]
    vb = [mb.add_vert(Vector((x, y, z - 0.002))) for x, y in pts]
    mb.add_face(vs, mat)
    mb.add_face(list(reversed(vb)), mat)
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        mb.add_face((vs[i], vb[i], vb[j], vs[j]), mat)
    return mb


def transformed(mb, m):
    mb.verts = [m @ v for v in mb.verts]
    return mb


def build_instrument(name, kind, frame_at, r, uv, depth=0.035):
    """frame_at: Matrix at the instrument center on the panel face (Z toward the crew)."""
    mb = MeshBuilder()
    rings = []
    for z in (0.0, depth):
        rings.append([frame_at @ Vector((r * 1.18 * math.cos(2 * math.pi * k / 32), r * 1.18 * math.sin(2 * math.pi * k / 32), z))
                      for k in range(32)])
    mb.loft(rings, closed=True, mat="panel")
    annulus(mb, frame_at, r, r * 1.18, depth, "panel", seg=32)
    face_z = depth - 0.012
    if kind == "att":
        to_object(name + "_Case", mb)
        build_attitude(name, frame_at, r, depth)
        return
    if kind == "heading":
        # lubber line
        local_tube(mb, frame_at, (0, r * 0.98, depth - 0.004), (0, r * 0.80, depth - 0.004), 0.004, "needle_orange", seg=6)
        to_object(name + "_Case", mb)
        card = MeshBuilder()
        disc(card, Matrix.Identity(4), r, face_z, uv_rect=uv["heading"], mat="dial")
        to_object(name + "_Card", transformed(card, frame_at), frame=frame_at,
                  extras={"instrument": name, "card": "heading", "source": "heading_deg",
                          "axis": gltf_axis((0, 0, 1))})
        return
    disc(mb, frame_at, r, face_z, uv_rect=uv[kind], mat="dial")
    # hub
    disc(mb, frame_at, r * 0.08, face_z + 0.006, mat="knob", seg=16)
    to_object(name + "_Case", mb)
    srcs = SOURCES.get(kind, [(None, None)])
    if kind.startswith("jet_"):
        srcs = [(None, None)]
    for k, (src, period) in enumerate(srcs):
        length = r * (0.85 if k == 0 else 0.6)
        nm = needle_mesh(length, r * 0.05, r * 0.2, face_z + 0.003 + 0.003 * k)
        extras = {"instrument": name, "kind": kind, "needle": k, "axis": gltf_axis((0, 0, 1))}
        if period:
            extras["period"] = float(period)
        else:
            extras["scale"] = flat_scale(kind)
        if src:
            extras["source"] = src
        to_object(f"{name}_Needle{k}", transformed(nm, frame_at), frame=frame_at, extras=extras)


def build_attitude(name, frame_at, r, depth):
    R = r * 1.02
    center = frame_at @ Vector((0, 0, depth - 0.85 * R))
    f = frame_at.copy()
    f.translation = center
    roll = B.empty(f"{name}_Roll", frame=f, extras={"instrument": name, "att": "roll", "axis": gltf_axis((0, 0, 1))})
    # ball: equirect UV sphere, front (u = 0.25) facing +Z
    mb = MeshBuilder()
    nlon, nlat = 32, 16
    grid = []
    for i in range(nlat + 1):
        th = -math.pi / 2 + math.pi * i / nlat
        row = []
        for j in range(nlon + 1):
            ph = 2 * math.pi * j / nlon
            p = Vector((-math.cos(ph) * math.cos(th), math.sin(th), math.sin(ph) * math.cos(th))) * R
            row.append((mb.add_vert(p), (j / nlon, 0.5 + th / math.pi)))
        grid.append(row)
    for i in range(nlat):
        for j in range(nlon):
            a, b, c, d = grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]
            mb.add_face((a[0], d[0], c[0], b[0]), "ball", uv=[a[1], d[1], c[1], b[1]])
    to_object(f"{name}_Ball", transformed(mb, f), frame=f, parent=roll,
                     extras={"instrument": name, "att": "pitch", "axis": gltf_axis((1, 0, 0))})
    # mask ring and miniature airplane (fixed)
    mm = MeshBuilder()
    annulus(mm, frame_at, r * 0.92, r * 1.18, depth + 0.001, "panel", seg=40)
    z = depth + 0.004
    local_tube(mm, frame_at, (-r * 0.55, 0, z), (-r * 0.15, 0, z), 0.003, "needle_orange", seg=6)
    local_tube(mm, frame_at, (r * 0.15, 0, z), (r * 0.55, 0, z), 0.003, "needle_orange", seg=6)
    local_tube(mm, frame_at, (-r * 0.15, 0, z), (0, -r * 0.1, z), 0.003, "needle_orange", seg=6)
    local_tube(mm, frame_at, (0, -r * 0.1, z), (r * 0.15, 0, z), 0.003, "needle_orange", seg=6)
    to_object(f"{name}_Mask", mm)


def build_panel(uv):
    F = panel_frame()
    mb = MeshBuilder()
    hw = PANEL_HALF_W
    pts = [(-hw, PANEL_BOTTOM), (hw, PANEL_BOTTOM)]
    pts += [(u, panel_top(u)) for u in [hw - 2 * hw * k / 30 for k in range(31)]]
    polygon_plate(mb, F, pts, 0.03, "panel")
    # Glareshield: padded tube following the panel top, plus a hood
    arc = [F @ Vector((u, panel_top(u) + 0.03, 0.05)) for u in [-hw + 2 * hw * k / 40 for k in range(41)]]
    for p0, p1 in zip(arc, arc[1:]):
        tube(mb, p0, p1, 0.045, seg=12, mat="panel")
    hood = [[F @ Vector((u, panel_top(u) + 0.02, z)) for u in [-hw + 2 * hw * k / 40 for k in range(41)]]
            for z in (0.0, -0.32)]
    mb.loft(hood, closed=False, mat="panel")
    # Reversed-prop warning lights above the jet block
    for k in range(6):
        u = -0.25 + 0.1 * k
        disc(mb, F @ Matrix.Translation((u, 1.405 - INST_DROP, 0)), 0.014, 0.012, mat="lamp_red", seg=16)
        annulus(mb, F @ Matrix.Translation((u, 1.405 - INST_DROP, 0)), 0.014, 0.022, 0.012, "chrome", seg=16)
    # Placards
    for u, v in ((0.30, 1.17), (-0.30, 0.74)):
        polygon_plate(mb, F @ Matrix.Translation((u, v, 0.004)), [(-0.07, -0.03), (0.07, -0.03), (0.07, 0.03), (-0.07, 0.03)],
                      0.002, "placard")
    to_object("Int_Panel", mb)
    obstacle("main_panel", -1.7, 1.7, 3.30, PANEL_D + 0.06, FLOOR_Z, 1.65)

    for side, cluster in (("L", AC_CLUSTER), ("R", P_CLUSTER)):
        for kind, u, v, r in cluster:
            build_instrument(f"Inst_{side}_{kind}", kind, F @ Matrix.Translation((u, v - INST_DROP, 0)), r, uv)
    # 4 x 4 jet engine block (engines 1-4 left to right)
    for row, kind in enumerate(JET_ROWS):
        for col in range(4):
            u = -0.195 + 0.13 * col
            v = 1.30 - 0.13 * row - INST_DROP
            name = f"Inst_C_{kind}{col + 1}"
            build_instrument(name, kind, F @ Matrix.Translation((u, v, 0)), 0.05, uv)
            nm = bpy.data.objects[f"{name}_Needle0"]
            nm["source"] = f"jet{col + 1}_{kind[4:]}"

    # Magnetic compass at the top of the windshield
    mb = MeshBuilder()
    c = W(0, 2.98, 2.18)
    cf = frame_from(c, (1, 0, 0), (0, 0, 1))
    box(mb, cf, -0.07, 0.07, -0.06, 0.06, -0.07, 0.06, "panel")
    tube(mb, c + Vector((0, 0, 0.06)), W(0, 2.98, 2.42), 0.015, seg=8, mat="panel")
    to_object("Int_Compass", mb)


# ------------------------------------------------------------------ controls

def ctl(name, mb, frame, control, axis_local, lo, hi, **kw):
    extras = {"control": control, "axis": gltf_axis(axis_local), "min": float(lo), "max": float(hi)}
    extras.update(kw)
    return to_object(name, transformed(mb, frame), frame=frame, extras=extras)


def build_yoke(side, sx):
    x = sx * SEAT_X
    pivot = W(x, 4.0, FLOOR_Z + 0.02)
    hub = W(x, 4.12, 1.04)
    col_frame = frame_from(pivot, (1, 0, 0), (0, 0, 1))
    mb = MeshBuilder()
    tube(mb, Vector((0, 0, 0)), col_frame.inverted() @ hub, 0.045, seg=14, mat="panel")
    box(mb, Matrix.Identity(4), -0.09, 0.09, -0.12, 0.12, -0.02, 0.06, "panel")  # floor boot
    column = ctl(f"Yoke_{side}_Column", mb, col_frame, "yoke_pitch", (1, 0, 0), -0.16, 0.16, seat=side)
    obstacle(f"yoke_{side}", x - 0.22, x + 0.22, 3.92, 4.22, FLOOR_Z, 1.18)
    # Wheel: ram's-horn handle, local X right, Y up, Z aft toward the pilot
    wf = frame_from(hub, (1, 0, 0), (0, 0, 1))
    wm = MeshBuilder()
    tube(wm, Vector((0, 0, -0.06)), Vector((0, 0, 0.05)), 0.05, seg=16, mat="panel")
    disc(wm, Matrix.Identity(4), 0.035, 0.051, mat="chrome", seg=16)
    horn = [(-0.20, 0.10), (-0.20, 0.03), (-0.17, -0.04), (-0.08, -0.06), (0.08, -0.06), (0.17, -0.04),
            (0.20, 0.03), (0.20, 0.10)]
    pts = [Vector((u, v, 0.02)) for u, v in horn]
    for p0, p1 in zip(pts, pts[1:]):
        tube(wm, p0, p1, 0.022, seg=10, mat="panel")
    tube(wm, Vector((0, 0, 0.02)), Vector((0, -0.06, 0.02)), 0.025, seg=10, mat="panel")
    for u in (-0.20, 0.20):  # grips
        tube(wm, Vector((u, 0.0, 0.02)), Vector((u, 0.12, 0.02)), 0.028, seg=10, mat="knob")
    to_object(f"Yoke_{side}_Wheel", transformed(wm, wf), frame=wf, parent=column,
                      extras={"control": "yoke_roll", "axis": gltf_axis((0, 0, 1)), "min": -1.2, "max": 1.2, "seat": side})


def build_pedals(side, sx):
    for ps, off in (("L", -0.16), ("R", 0.16)):
        x = sx * SEAT_X + off
        pivot = W(x, 3.72, 0.62)
        f = upframe(pivot)
        mb = MeshBuilder()
        tube(mb, Vector((0, 0, 0)), Vector((0, -0.04, -0.26)), 0.015, seg=8, mat="seatframe")
        box(mb, frame_from(Vector((0, -0.06, -0.25)), (1, 0, 0), (0, 1, 0.45)), -0.06, 0.06, -0.012, 0.012, -0.11, 0.05, "panel")
        ctl(f"Pedal_{side}_{ps}", mb, f, "pedal", (1, 0, 0), -0.25, 0.25, seat=side, side=ps)


def build_pedestal(uv):
    mb = MeshBuilder()
    d0, d1 = PANEL_D, 4.78
    # sloped top: z 0.84 at front, 0.76 at back; width +-0.24
    top_front, top_back = 0.70, 0.66
    corners = []
    for x in (-0.24, 0.24):
        for dd, z in ((d0, FLOOR_Z), (d1, FLOOR_Z), (d1, top_back), (d0, top_front)):
            corners.append(mb.add_vert(W(x, dd, z)))
    a = corners[:4]
    b = corners[4:]
    mb.add_face((a[0], a[3], a[2], a[1]), "panel")      # left side (normal -x)
    mb.add_face((b[0], b[1], b[2], b[3]), "panel")      # right side
    mb.add_face((a[3], b[3], b[2], a[2]), "panel")      # top
    mb.add_face((a[1], a[2], b[2], b[1]), "panel")      # back
    mb.add_face((a[0], b[0], b[3], a[3]), "panel")      # front
    # quadrant slots
    for k in range(6):
        x = -0.15 + 0.06 * k
        wbox(mb, x - 0.008, x + 0.008, 3.92, 4.20, 0.675, 0.69, "knob")
    to_object("Int_Pedestal", mb)
    obstacle("pedestal", -0.24, 0.24, PANEL_D, 4.78, FLOOR_Z, 0.72)

    # Piston throttles T1..T6 (pivot below the quadrant top; forward = more power)
    for k in range(6):
        x = -0.15 + 0.06 * k
        pivot = W(x, 4.06, 0.58)
        fr = upframe(pivot)
        lm = MeshBuilder()
        tube(lm, Vector((0, 0, 0)), Vector((0, 0, 0.30)), 0.010, seg=8, mat="chrome")
        tube(lm, Vector((-0.022, 0, 0.30)), Vector((0.022, 0, 0.30)), 0.014, seg=10, mat="knob")  # T handle
        tube(lm, Vector((0, 0, 0.28)), Vector((0, 0, 0.33)), 0.012, seg=10, mat="knob")
        ctl(f"Throttle_{k + 1}", lm, fr, "throttle", (1, 0, 0), -0.40, 0.40, engine=k + 1)

    # Landing gear lever (wheel-shaped knob), flap switch, parking brake, nose wheel steering switch
    gm = MeshBuilder()
    tube(gm, Vector((0, 0, 0)), Vector((0, 0, 0.12)), 0.008, seg=8, mat="chrome")
    revolve(gm, lambda t: Vector((0, t, 0.13)), [(-0.012, 0.025), (0.012, 0.025)], seg=16, axis="y", mat="knob", cap_start=True, cap_end=True)
    ctl("Gear_Lever", gm, upframe(W(0.19, 3.80, 0.70)), "gear", (1, 0, 0), -0.5, 0.5, kind="toggle")
    fm = MeshBuilder()
    tube(fm, Vector((0, 0, 0)), Vector((0, 0, 0.06)), 0.006, seg=8, mat="chrome")
    tube(fm, Vector((0, 0, 0.055)), Vector((0, 0, 0.075)), 0.011, seg=10, mat="knob")
    ctl("Flap_Switch", fm, upframe(W(0.19, 4.0, 0.685)), "flaps", (1, 0, 0), -0.4, 0.4, kind="switch3")
    bm = MeshBuilder()
    tube(bm, Vector((0, 0, 0)), Vector((0, 0, 0.07)), 0.007, seg=8, mat="chrome")
    tube(bm, Vector((-0.02, 0, 0.07)), Vector((0.02, 0, 0.07)), 0.012, seg=10, mat="knob_red")
    ctl("Brake_Handle", bm, upframe(W(-0.19, 3.80, 0.70)), "parking_brake", (1, 0, 0), -0.5, 0.5, kind="toggle")
    # Elevator trim wheel on the pedestal's left side
    tm = MeshBuilder()
    revolve(tm, lambda t: Vector((t, 0, 0)), [(-0.015, 0.10), (0.015, 0.10)], seg=32, axis="x", mat="knob", cap_start=True, cap_end=True)
    ctl("Trim_Elevator", tm, upframe(W(-0.255, 4.35, 0.52)), "trim_elevator", (1, 0, 0), -6.0, 6.0, kind="wheel")


def build_overhead():
    """Jet engine control panel overhead between the pilots, with 4 jet throttles."""
    mb = MeshBuilder()
    wbox(mb, -0.33, 0.33, 3.95, 4.75, 2.02, 2.30, "panel")
    for k in range(5):
        for j in range(3):
            x = -0.24 + 0.12 * k
            disc(mb, frame_from(W(x, 4.3 + 0.13 * j, 2.019), (1, 0, 0), (0, 1, 0)), 0.012, 0.0, mat="chrome", seg=12)
    to_object("Int_Overhead", mb)
    obstacle("overhead", -0.33, 0.33, 3.95, 4.75, 2.02, 2.30)
    for k in range(4):
        x = -0.15 + 0.10 * k
        pivot = W(x, 4.0, 2.06)
        fr = upframe(pivot)
        lm = MeshBuilder()
        tube(lm, Vector((0, 0, 0)), Vector((0, 0, -0.17)), 0.009, seg=8, mat="chrome")
        tube(lm, Vector((-0.02, 0, -0.17)), Vector((0.02, 0, -0.17)), 0.013, seg=10, mat="knob")
        ctl(f"JetThrottle_{k + 1}", lm, fr, "jet_throttle", (1, 0, 0), -0.45, 0.45, engine=k + 1)


def build_seat(name, station, x, d, yaw, floor=None, eye_up=1.27, stand=None, flies=False):
    """Crew seat centred at (x, d) on a deck, facing yaw (0 = forward, +pi/2 = left, pi = aft).
    Registers collision, the sit eye point and the stand-up point."""
    floor = FLOOR_Z if floor is None else floor
    fwd = Vector((-math.sin(yaw), math.cos(yaw), 0))   # build coords: +y is forward
    f = frame_from(W(x, d, floor), (fwd.y, -fwd.x, 0), fwd)  # local X right, Y facing, Z up
    mb = MeshBuilder()
    cz = 0.47
    box(mb, f, -0.20, 0.20, -0.18, 0.18, 0.0, cz - 0.10, "seatframe")
    box(mb, f, -0.25, 0.25, -0.24, 0.24, cz - 0.10, cz, "cushion")
    box(mb, f, -0.25, 0.25, -0.34, -0.24, cz, cz + 0.70, "cushion")
    box(mb, f, -0.12, 0.12, -0.34, -0.22, cz + 0.74, cz + 0.96, "cushion")  # headrest
    box(mb, f, -0.02, 0.02, -0.31, -0.27, cz + 0.70, cz + 0.74, "seatframe")
    for ax in (-0.29, 0.29):  # armrests
        box(mb, f, ax - 0.035, ax + 0.035, -0.20, 0.20, cz + 0.20, cz + 0.25, "seatframe")
    to_object(name, mb, extras={"sit": name})
    corners = [f @ Vector((u, v, 0)) for u in (-0.30, 0.30) for v in (-0.36, 0.26)]
    obstacle(name.lower(), min(c.x for c in corners), max(c.x for c in corners),
             min(P.NOSE_Y - c.y for c in corners), max(P.NOSE_Y - c.y for c in corners), floor, floor + cz + 0.96)
    eye = f @ Vector((0, -0.14, eye_up))  # head just ahead of the headrest
    sx, sd = stand if stand else (x + 0.7 * math.sin(yaw), d + 0.7 * math.cos(yaw))  # behind the seat
    deck = "upper" if floor == FLOOR_Z else "lower" if floor == LOWER_FLOOR_Z else "aft"
    stand_floor = FLOOR_Z if deck == "upper" else LOWER_FLOOR_Z if deck == "lower" else P.AFT_FLOOR_Z
    SEATS.append({"name": name, "station": station, "eye": (eye.x, P.NOSE_Y - eye.y, eye.z), "yaw": yaw,
                  "stand": (sx, sd, stand_floor), "deck": deck, "flies": flies})


def build_forward_gunners():
    """Forward upper turret sighting stations at the upper-deck blisters (one each side)."""
    for c, nrm, sz, role, side in B.blister_centers():
        if role != "upper_fwd":
            continue
        sx = 1 if side == "R" else -1
        d = P.NOSE_Y - c.y
        build_seat(f"Seat_GUF_{side}", f"gunner_upper_fwd_{side}", sx * 0.85, d, -sx * math.pi / 2, eye_up=0.95,
                   stand=(sx * 0.25, d))
        SEATS[-1]["sight"] = {"eye": [c.x - sx * 0.12, c.z, d - P.NOSE_Y], "turrets": ["Turret_UpperFwd_L", "Turret_UpperFwd_R"]}


def bulkhead(name, d, holes, mat="interior"):
    """Pressure bulkhead plate at station d with dark openings: list of (x, z, r)."""
    mb = MeshBuilder()
    frame = frame_from(W(0, d, B.fus_center_z(d)), (1, 0, 0), (0, 0, 1))
    r = B.fus_radius(d) - 0.06
    pts = [(r * math.cos(2 * math.pi * k / 48), r * math.sin(2 * math.pi * k / 48)) for k in range(48)]
    polygon_plate(mb, frame, pts, 0.04, mat)
    for x, z, hr in holes:
        hf = frame_from(W(x, d - 0.005, z), (1, 0, 0), (0, 0, 1))
        disc(mb, hf, hr, 0.0, mat="insulation", seg=32)
        annulus(mb, hf, hr, hr + 0.07, 0.005, "seatframe", seg=32)
        hb = frame_from(W(x, d + 0.045, z), (1, 0, 0), (0, 0, -1))
        disc(mb, hb, hr, 0.0, mat="insulation", seg=32)
    to_object(name, mb)


def build_tunnel():
    """85 ft pressurized crawl tunnel over the bomb bays, with the crew trolley."""
    T = P.TUNNEL
    d0, d1 = T["d"]
    mb = MeshBuilder()
    rings = []
    ds = [d0 + (d1 - d0) * k / 60 for k in range(61)]
    for d in ds:
        rings.append([W(T["x"] + T["r"] * math.cos(2 * math.pi * k / 24), d, T["z"] + T["r"] * math.sin(2 * math.pi * k / 24))
                      for k in range(24)])
    mb.loft(rings, closed=True, mat="insulation")
    tm = mb.flipped()
    # floor rails and frames every 0.9 m
    for x in (-0.12, 0.12):
        tube(tm, W(T["x"] + x, d0, T["z"] - T["r"] + 0.04), W(T["x"] + x, d1, T["z"] - T["r"] + 0.04), 0.012, seg=6, mat="chrome")
    for d in [d0 + 0.9 * k for k in range(int((d1 - d0) / 0.9) + 1)]:
        ring = [W(T["x"] + (T["r"] - 0.01) * math.cos(2 * math.pi * k / 24), d, T["z"] + (T["r"] - 0.01) * math.sin(2 * math.pi * k / 24))
                for k in range(25)]
        for p0, p1 in zip(ring, ring[1:]):
            tube(tm, p0, p1, 0.012, seg=5, mat="seatframe")
    for d in [d0 + 3.0 * k + 1.5 for k in range(int((d1 - d0) / 3.0))]:  # dome lights
        disc(tm, frame_from(W(T["x"], d, T["z"] + T["r"] - 0.02), (1, 0, 0), (0, 1, 0)) @ Matrix.Rotation(math.pi, 4, "X"),
             0.04, 0.0, mat="lamp_white", seg=12)
    to_object("Int_Tunnel", tm)
    # trolley: flat board on four wheels, moved by the client with the crew member
    trm = MeshBuilder()
    zf = T["z"] - T["r"] + 0.06
    box(trm, Matrix.Identity(4), -0.20, 0.20, -0.75, 0.75, 0.0, 0.04, "cushion")
    for sx in (-0.12, 0.12):
        for sy in (-0.6, 0.6):
            revolve(trm, lambda t, sx=sx, sy=sy: Vector((sx + t, sy, -0.02)), [(-0.015, 0.03), (0.015, 0.03)], axis="x",
                    seg=10, mat="knob", cap_start=True, cap_end=True)
    f = frame_from(W(T["x"], d0 + 1.0, zf), (1, 0, 0), (0, 1, 0))
    to_object("Tunnel_Trolley", transformed(trm, f), frame=f, extras={"trolley": "tunnel"})


def build_aft_compartment(uv):
    """Aft pressurized compartment: bunks, galley, upper and lower sighting stations, tail gunner."""
    d0, d1 = P.AFT_COMP_D
    fz = P.AFT_FLOOR_Z
    T = P.TUNNEL
    bulkhead("Int_AftFwdBulkhead", d0, [(T["x"], T["z"], T["r"])])
    bulkhead("Int_AftRearBulkhead", d1 - 0.04, [(0.0, fz + 0.95, 0.38)])
    mb = MeshBuilder()
    t = 0.05
    for a, b in ((d0, 37.2), (37.2, d1)):
        hw = min(hull_half_width(a, fz - t), hull_half_width(b, fz - t)) - 0.01
        wbox(mb, -hw, hw, a, b, fz - t, fz, "floor")
    # ladder from the tunnel mouth down to the floor
    for x in (T["x"] - 0.2, T["x"] + 0.2):
        tube(mb, W(x, d0 + 0.08, fz), W(x, d0 + 0.08, T["z"] - T["r"]), 0.02, seg=8, mat="seatframe")
    for k in range(1, 6):
        z = fz + (T["z"] - T["r"] - fz) * k / 6
        tube(mb, W(T["x"] - 0.2, d0 + 0.08, z), W(T["x"] + 0.2, d0 + 0.08, z), 0.016, seg=8, mat="seatframe")
    # bunks (right side, two tiers) and galley table (left)
    for tier in (0, 1):
        z = fz + 0.45 + tier * 0.75
        wbox(mb, 0.75, 1.42, 34.75, 36.55, z, z + 0.12, "cushion")
        wbox(mb, 0.75, 1.42, 34.75, 36.55, z - 0.04, z, "seatframe")
    obstacle("bunks", 0.75, 1.6, 34.75, 36.55, fz, fz + 1.4)
    wbox(mb, -1.40, -0.90, 35.15, 36.0, fz + 0.72, fz + 0.77, "floor")
    wbox(mb, -1.40, -1.35, 35.15, 36.0, fz, fz + 0.72, "seatframe")
    obstacle("galley", -1.6, -0.90, 35.15, 36.0, fz, fz + 0.77)
    # tail gunner's APG-41 radar console against the rear bulkhead
    wbox(mb, -0.50, 0.50, d1 - 0.55, d1 - 0.05, fz, fz + 1.05, "panel")
    disc(mb, frame_from(W(0, d1 - 0.551, fz + 0.80), (1, 0, 0), (0, 0, 1)) @ Matrix.Rotation(math.pi / 2, 4, "X")
         @ Matrix.Rotation(math.pi, 4, "Y"), 0.14, 0.0, mat="radome", seg=32)
    obstacle("tail_console", -0.50, 0.50, d1 - 0.55, d1, fz, fz + 1.05)
    to_object("Int_AftCompartment", mb)
    build_seat("Seat_TAIL", "tail_gunner", 0.0, d1 - 1.05, math.pi, floor=fz, eye_up=1.15, stand=(0.0, d1 - 1.75))
    SEATS[-1]["sight"] = {"eye": [0.0, B.fus_center_z(48.3) - 0.15, 48.3 + 0.2 - P.NOSE_Y], "turrets": ["Turret_Tail"],
                          "aft": True}
    for c, nrm, sz, role, side in B.blister_centers():
        if role not in ("upper_aft", "lower_aft"):
            continue
        sx = 1 if side == "R" else -1
        d = P.NOSE_Y - c.y
        upper = role == "upper_aft"
        name = f"Seat_G{'UA' if upper else 'LA'}_{side}"
        # upper gunners sit on a raised platform to reach the high blister
        floor = fz + (0.55 if upper else 0.0)
        if upper:
            wbox(mb2 := MeshBuilder(), sx * 0.55, sx * 1.25, d - 0.45, d + 0.45, fz, floor, "floor")
            to_object(f"Int_Platform_{side}", mb2)
        build_seat(name, f"gunner_{'upper' if upper else 'lower'}_aft_{side}", sx * 0.85, d, -sx * math.pi / 2,
                   floor=floor, eye_up=c.z - floor - 0.02, stand=(sx * 0.15, d))
        SEATS[-1]["deck"] = "aft"
        pair = ["Turret_UpperAft_L", "Turret_UpperAft_R"] if upper else ["Turret_LowerAft_L", "Turret_LowerAft_R"]
        SEATS[-1]["sight"] = {"eye": [c.x - sx * 0.12, c.z, d - P.NOSE_Y], "turrets": pair}
    for st in SEATS:
        if st["name"] == "Seat_TAIL":
            st["deck"] = "aft"


def build_lower_deck():
    """Placeholder lower-deck stations (manual Fig 1-3): radar observer forward, navigator to the left."""
    lf = LOWER_FLOOR_Z
    mb = MeshBuilder()
    # Radar observer / bombing console with scope, facing aft toward the seat
    wbox(mb, -0.55, 0.55, 3.55, 4.10, lf, lf + 1.05, "panel")
    disc(mb, frame_from(W(0, 4.101, lf + 0.80), (1, 0, 0), (0, 0, 1)) @ Matrix.Rotation(math.pi / 2, 4, "X"), 0.16, 0.0,
         mat="radome", seg=32)
    wbox(mb, -0.50, 0.50, 4.10, 4.35, lf + 0.62, lf + 0.66, "panel")   # desk lip
    obstacle("radar_console", -0.55, 0.55, 3.55, 4.35, lf, lf + 1.05)
    # Navigator's table on the left wall
    wbox(mb, -1.45, -1.00, 5.30, 6.70, lf + 0.70, lf + 0.75, "floor")
    wbox(mb, -1.45, -1.40, 5.30, 6.70, lf, lf + 0.70, "panel")
    wbox(mb, -1.40, -1.05, 5.40, 6.60, lf + 0.751, lf + 0.755, "placard")  # chart
    obstacle("nav_table", -1.6, -1.00, 5.30, 6.70, lf, lf + 0.75)
    # K-system equipment rack on the right
    wbox(mb, 1.00, 1.45, 5.0, 6.4, lf, lf + 1.40, "panel")
    obstacle("k_rack", 1.00, 1.6, 5.0, 6.4, lf, lf + 1.40)
    to_object("Int_LowerDeck", mb)
    build_seat("Seat_RADAR", "radar_observer", 0.0, 4.80, 0.0, floor=lf, eye_up=1.20)
    SEATS[-1]["sight"] = {"eye": [0.0, B.fus_center_z(0.9) - 0.15, 0.6 - P.NOSE_Y], "turrets": ["Turret_Nose"], "nose": True}
    build_seat("Seat_NAV", "navigator", -0.55, 6.0, math.pi / 2, floor=lf, eye_up=1.20, stand=(0.05, 6.0))


def build_consoles():
    for sx in (-1, 1):
        mb = MeshBuilder()
        x_out = sx * (hull_half_width(4.6, 0.95) - 0.02)
        x_in = sx * 1.10
        wbox(mb, min(x_in, x_out), max(x_in, x_out), 3.70, 5.70, FLOOR_Z, 0.95, "console")
        for k in range(6):
            for j in range(2):
                disc(mb, frame_from(W(sx * (1.17 + 0.14 * j), 3.9 + 0.3 * k, 0.951), (1, 0, 0), (0, 1, 0)),
                     0.018, 0.0, mat="knob", seg=12)
        to_object(f"Int_Console_{'L' if sx < 0 else 'R'}", mb)
        obstacle(f"console_{'L' if sx < 0 else 'R'}", x_in, x_out, 3.70, 5.70, FLOOR_Z, 0.95)
    # Nose wheel steering tiller on the left console
    tm = MeshBuilder()
    rings = []
    for k in range(25):
        a = 2 * math.pi * k / 24
        rings.append(Vector((0.11 * math.cos(a), 0.11 * math.sin(a), 0.06)))
    for p0, p1 in zip(rings, rings[1:]):
        tube(tm, p0, p1, 0.012, seg=8, mat="knob")
    tube(tm, Vector((0, 0, 0)), Vector((0, 0, 0.06)), 0.02, seg=10, mat="panel")
    for a in (0, 2 * math.pi / 3, 4 * math.pi / 3):
        tube(tm, Vector((0, 0, 0.06)), Vector((0.11 * math.cos(a), 0.11 * math.sin(a), 0.06)), 0.007, seg=6, mat="panel")
    f = upframe(W(-1.30, 3.95, 0.96), fwd=(0, 1, -0.3))
    ctl("Tiller", tm, f, "tiller", (0, 0, 1), -1.5, 1.5)


def build_engineer(uv):
    """Flight engineer station behind the right seat: panel facing forward, seat facing aft."""
    d = 7.25
    f = frame_from(W(0.05, d, 0), (1, 0, 0), (0, 0, 1))
    f = f @ Matrix.Rotation(math.pi, 4, "Y")   # face +Y (forward)
    f.translation = W(0.05, d, 0)
    # outline follows the hull cross-section
    x_max = 1.30
    pts = [(0.0, 0.80), (-x_max, 0.80)]
    for k in range(15):
        x = x_max * (1 - k / 14)
        top = min(1.95, B.fus_center_z(d) + math.sqrt(max((B.fus_radius(d) - 0.12) ** 2 - (x + 0.05) ** 2, 0)))
        pts.append((-x, top))
    mb = MeshBuilder()
    polygon_plate(mb, f, pts, 0.04, "panel")
    to_object("Int_FE_Panel", mb)
    gauges = ["rpm", "manp", "jet_oil", "jet_fuel", "jet_egt", "rpm"]
    n = 0
    for row in range(5):
        for col in range(6):
            x = 0.12 + 0.17 * col
            z = 1.72 - 0.17 * row
            top = B.fus_center_z(d) + math.sqrt(max((B.fus_radius(d) - 0.2) ** 2 - (x + 0.05) ** 2, 0))
            if z + 0.07 > top:
                continue
            kind = gauges[(row + col) % len(gauges)]
            fa = f @ Matrix.Translation((-x, z, 0))
            build_instrument(f"FE_{n:02d}", kind, fa, 0.055, uv, depth=0.03)
            n += 1
    mb = MeshBuilder()
    wbox(mb, 0.05, 1.35, d - 0.45, d, 0.74, 0.79, "panel")   # desk
    to_object("Int_FE_Desk", mb)
    obstacle("fe_panel", 0.05, 1.7, d - 0.45, d + 0.05, FLOOR_Z, 2.0)
    build_seat("Seat_FE", "flight_engineer", 0.70, 6.45, math.pi, eye_up=1.25, stand=(0.70, 5.55))


def build_radio_rack():
    mb = MeshBuilder()
    wbox(mb, -1.45, -0.80, 9.3, 10.4, FLOOR_Z, 1.35, "panel")
    for k in range(4):
        for j in range(3):
            disc(mb, frame_from(W(-0.80 + 0.001, 9.5 + 0.28 * k, 0.6 + 0.25 * j), (0, -1, 0), (0, 0, 1)),
                 0.03, 0.0, mat="knob", seg=12)
    to_object("Int_RadioRack", mb)
    obstacle("radio_rack", -1.6, -0.80, 9.3, 10.4, FLOOR_Z, 1.35)
    build_seat("Seat_RO", "radio_operator", -0.30, 9.85, math.pi / 2, eye_up=1.25, stand=(0.25, 9.85))


def build_eyepoints():
    for st in SEATS:
        x, d, z = st["eye"]
        B.empty(f"Eye_{st['name']}", frame=Matrix.Translation(W(x, d, z)),
                extras={"seat": st["name"], "station": st["station"], "yaw": st["yaw"]})


def hull_top(d, x, inset=0.06, n=256):
    """Inner skin height above station d at lateral offset x (upper half), build coordinates."""
    pts = [B.hull_point(d, math.pi / 2 * k / n, inset) for k in range(n + 1)]  # top -> side
    ax = abs(x)
    if ax >= pts[-1].x:
        return pts[-1].z
    for a, b in zip(pts, pts[1:]):
        if a.x <= ax <= b.x:
            t = (ax - a.x) / max(b.x - a.x, 1e-9)
            return a.z + (b.z - a.z) * t
    return pts[0].z


def export_nav(path):
    """Walkable decks, obstacles, ceilings, ladders and seats in model (three.js) coordinates:
    x right, y up, z aft = d - NOSE_Y."""
    zc = lambda d: d - P.NOSE_Y  # noqa: E731
    r = 0.24  # crew capsule radius, kept off the hull side

    def wall(d, floor):
        return min(hull_half_width(d0, floor + 0.55) for d0 in (d,)) - r

    def rects(spans, floor):
        out = []
        for d0, d1, x0, x1 in spans:
            hw = min(wall(d0, floor), wall(d1, floor))
            out.append({"x0": max(x0, -hw), "x1": min(x1, hw), "z0": zc(d0), "z1": zc(d1)})
        return out

    big = 9.0
    upper = rects([(3.66, 7.6, -big, big), (7.6, 8.6, -0.35 + r, big), (8.6, DECK_END_D - 0.05, -big, big)], FLOOR_Z)
    lower = rects([(2.9, 4.2, -big, big), (4.2, DECK_END_D - 0.05, -big, big)], LOWER_FLOOR_Z)

    def ceiling_grid(d0, d1, ceil_fn):
        dx = 0.1
        xs = [-1.9 + dx * i for i in range(int(3.8 / dx) + 1)]
        ds = [d0 + dx * j for j in range(int((d1 - d0) / dx) + 1)]
        return {"x0": xs[0], "z0": zc(ds[0]), "step": dx, "nx": len(xs), "nz": len(ds),
                "y": [round(ceil_fn(d, x), 3) for d in ds for x in xs]}

    fz = P.AFT_FLOOR_Z
    a0, a1 = P.AFT_COMP_D
    aft = rects([(a0 + 0.06, 37.2, -big, big), (37.2, a1 - 0.08, -big, big)], fz)
    decks = [
        {"id": "aft", "y": fz, "rects": aft, "ceiling": ceiling_grid(a0, a1, lambda d, x: hull_top(d, x))},
        {"id": "upper", "y": FLOOR_Z, "rects": upper,
         "ceiling": ceiling_grid(3.6, DECK_END_D, lambda d, x: hull_top(d, x))},
        {"id": "lower", "y": LOWER_FLOOR_Z, "rects": lower,
         "ceiling": ceiling_grid(2.8, DECK_END_D, lambda d, x: FLOOR_Z - 0.05 if d >= 2.6 else hull_top(d, x))},
    ]
    obstacles = [{"name": n, "min": [x0, z0, zc(d0)], "max": [x1, z1, zc(d1)]} for n, x0, x1, d0, d1, z0, z1 in OBSTACLES]
    ladders = [{
        "name": "fwd", "x": -0.80,
        # path waypoints [x, y, z]: lower stand -> foot -> top -> upper stand
        "path": [[-0.80, LOWER_FLOOR_Z, zc(8.80)], [-0.80, LOWER_FLOOR_Z, zc(8.45)],
                 [-0.80, FLOOR_Z, zc(8.05)], [-0.80, FLOOR_Z, zc(7.35)]],
        "lower": "lower", "upper": "upper",
    }]
    T = P.TUNNEL
    tunnels = [{
        "name": "tunnel",
        # eye path (lying prone on the trolley): upper-deck hatch -> tunnel -> aft ladder foot
        "path": [[T["x"], FLOOR_Z + 1.0, zc(12.12)], [T["x"], T["z"], zc(T["d"][0] + 0.3)],
                 [T["x"], T["z"], zc(T["d"][1] - 0.3)], [T["x"], T["z"] - 0.1, zc(T["d"][1] + 0.25)],
                 [T["x"], fz + 1.5, zc(T["d"][1] + 0.6)]],
        "trolley": [zc(T["d"][0] + 1.0), zc(T["d"][1] - 1.0)],
        "ends": [{"deck": "upper", "stand": [T["x"], FLOOR_Z, zc(12.08)]},
                 {"deck": "aft", "stand": [T["x"], fz, zc(T["d"][1] + 0.75)]}],
    }]
    seats = [{**st, "eye": [st["eye"][0], st["eye"][2], zc(st["eye"][1])],
              "stand": [st["stand"][0], st["stand"][2], zc(st["stand"][1])]} for st in SEATS]
    nav = {"units": "m", "frame": "model (x right, y up, z aft)", "radius": r, "eyeStand": 1.62,
           "eyeCrouch": 1.05, "decks": decks, "obstacles": obstacles, "ladders": ladders, "tunnels": tunnels,
           "seats": seats}
    with open(path, "w") as fh:
        json.dump(nav, fh, separators=(",", ":"))
    print("nav:", path, len(obstacles), "obstacles", len(seats), "seats")


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    OBSTACLES.clear()
    SEATS.clear()
    uv = init_materials()
    B.ROOT = None
    B.ROOT = B.empty("B36_Interior", extras={"generator": "build_interior.py", "units": "m"})
    build_shell()
    build_canopy_frames_inner()
    build_floors()
    build_panel(uv)
    for side, sx in (("L", -1), ("R", 1)):
        build_yoke(side, sx)
        build_pedals(side, sx)
    build_pedestal(uv)
    build_overhead()
    for name, station, sx in (("Seat_AC", "aircraft_commander", -1), ("Seat_P", "pilot", 1)):
        build_seat(name, station, sx * SEAT_X, SEAT_D - 0.24, 0.0, eye_up=EYE[2] - FLOOR_Z,
                   stand=(sx * SEAT_X, SEAT_D + 0.45), flies=True)
    build_consoles()
    build_engineer(uv)
    build_radio_rack()
    build_forward_gunners()
    build_lower_deck()
    build_tunnel()
    build_aft_compartment(uv)
    build_eyepoints()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"objects={len(bpy.data.objects)} triangles={tris}")
    B.export(args.out)
    export_nav(os.path.join(os.path.dirname(args.out), "b36_nav.json"))
    print("exported", args.out, os.path.getsize(args.out) // 1024, "KiB")


if __name__ == "__main__":
    main()
