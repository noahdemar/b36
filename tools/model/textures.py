"""Generated skin textures for the B-36 airframe.

Each surface has an analytic UV parameterisation (see build_b36.py):
  fuselage   u = d / FUS_TEX_LEN, v = theta / 2pi            (d aft of nose, theta from top, clockwise from front)
  wing       u = 0.5 + 0.5 * x / semispan (left wing 1 - u), v = perimeter (upper TE->LE 0..0.5, lower LE->TE 0.5..1)
  fin        u = (z - z0) / (z1 - z0), v = perimeter (v < 0.5 is the left side)
  stabilizer like the wing with the tail semispan
  nacelle    tiled: u along the nacelle, v around

For every texel we know its 3D position, so panel lines are laid out in real units (metres) and
decals (insignia, lettering) are projected from planes in 3D, which keeps their orientation correct
on mirrored surfaces.

Outputs per surface: <name>_color.jpg (sRGB), <name>_orm.jpg (G roughness, B metallic), <name>_normal.png.
Panel layout and marking sizes are ESTIMATED from photos and period artwork.
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import build_b36 as B
import params as P

RNG = np.random.default_rng(3036)

# Linear-space colours
ALU = np.array([0.80, 0.81, 0.83], np.float32)
BLUE = np.array([0.02, 0.06, 0.22], np.float32)    # insignia blue
RED = np.array([0.45, 0.02, 0.02], np.float32)
WHITE = np.array([0.85, 0.85, 0.83], np.float32)
BLACK = np.array([0.012, 0.012, 0.012], np.float32)


def font(px):
    return ImageFont.load_default(size=px)


class Skin:
    """Float buffers in texture space: height (m), albedo (linear RGB), roughness, metallic."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.height = np.zeros((h, w), np.float32)
        self.albedo = np.tile(ALU, (h, w, 1)).astype(np.float32)
        self.rough = np.full((h, w), 0.32, np.float32)
        self.metal = np.ones((h, w), np.float32)
        # texel centres in UV (v up: row 0 is v = 1)
        self.u = (np.arange(w, dtype=np.float32) + 0.5) / w
        self.v = 1.0 - (np.arange(h, dtype=np.float32) + 0.5) / h
        self.pos = None  # (h, w, 3) world positions (Blender coords)
        self.nrm = None

    # ---- primitive marks (pixel space) ----
    def groove_cols(self, cols, mask=None, depth=0.0006, dark=0.55, width=1):
        for c in np.unique(np.clip(np.round(cols).astype(int), 0, self.w - 1)):
            sl = slice(max(c - width // 2, 0), min(c + (width + 1) // 2, self.w))
            m = np.ones(self.h, bool) if mask is None else mask[:, c]
            self.height[m, sl] -= depth
            self.albedo[m, sl] *= dark
            self.rough[m, sl] = np.maximum(self.rough[m, sl], 0.55)

    def groove_rows(self, rows, mask=None, depth=0.0006, dark=0.55, width=1):
        for r in np.unique(np.clip(np.round(rows).astype(int), 0, self.h - 1)):
            sl = slice(max(r - width // 2, 0), min(r + (width + 1) // 2, self.h))
            m = np.ones(self.w, bool) if mask is None else mask[r, :]
            self.height[sl, m] -= depth
            self.albedo[sl, m] *= dark
            self.rough[sl, m] = np.maximum(self.rough[sl, m], 0.55)

    def rivets_along_col(self, c, pitch_px, rows_mask=None, bump=0.0004):
        c = int(round(c))
        if not 0 <= c < self.w:
            return
        rows = np.arange(0, self.h, max(pitch_px, 2.0)).astype(int)
        if rows_mask is not None:
            rows = rows[rows_mask[rows]]
        self.height[rows, c] += bump
        self.albedo[rows, c] *= 1.08

    def rivets_along_row(self, r, pitch_px, cols_mask=None, bump=0.0004):
        r = int(round(r))
        if not 0 <= r < self.h:
            return
        cols = np.arange(0, self.w, max(pitch_px, 2.0)).astype(int)
        if cols_mask is not None:
            cols = cols[cols_mask[cols]]
        self.height[r, cols] += bump
        self.albedo[r, cols] *= 1.08

    def panel_variation(self, ids, tint=0.035, rough_range=(0.26, 0.36)):
        """ids: (h, w) int panel index. Each panel gets its own shade and roughness (alclad sheets)."""
        n = int(ids.max()) + 1
        shade = 1.0 + RNG.uniform(-tint, tint, n).astype(np.float32)
        hue = RNG.uniform(-0.012, 0.012, (n, 3)).astype(np.float32)
        rough = RNG.uniform(*rough_range, n).astype(np.float32)
        self.albedo *= shade[ids][..., None]
        self.albedo += hue[ids]
        self.rough = np.maximum(self.rough, rough[ids])

    def noise(self, amount=0.03, scale=64):
        """Low-frequency smudges plus fine grain."""
        g = RNG.standard_normal((max(self.h // scale, 2), max(self.w // scale, 2))).astype(np.float32)
        big = np.array(Image.fromarray(g).resize((self.w, self.h), Image.BICUBIC))
        fine = RNG.standard_normal((self.h, self.w)).astype(np.float32)
        self.albedo *= (1 + amount * big + 0.010 * fine)[..., None]
        self.rough += 0.015 * big

    # ---- decals projected from 3D ----
    def decal(self, img, center, right, up, width_m, height_m, metallic=0.0, rough=0.45):
        """Project an RGBA PIL image onto the surface from a plane facing along right x up."""
        c = np.array(center, np.float32)
        r = np.array(right, np.float32)
        r /= np.linalg.norm(r)
        uvec = np.array(up, np.float32)
        uvec -= r * np.dot(uvec, r)
        uvec /= np.linalg.norm(uvec)
        n = np.cross(r, uvec)
        rel = self.pos - c
        x = rel @ r
        y = rel @ uvec
        depth = rel @ n
        facing = self.nrm @ n
        m = (np.abs(x) <= width_m / 2) & (np.abs(y) <= height_m / 2) & (np.abs(depth) < 0.8) & (facing > 0.25)
        if not m.any():
            return
        arr = np.asarray(img.convert("RGBA"), np.float32) / 255.0
        ih, iw = arr.shape[:2]
        px = np.clip(((x[m] / width_m) + 0.5) * (iw - 1), 0, iw - 1)
        py = np.clip((0.5 - (y[m] / height_m)) * (ih - 1), 0, ih - 1)
        x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
        x1, y1 = np.minimum(x0 + 1, iw - 1), np.minimum(y0 + 1, ih - 1)
        tx, ty = (px - x0)[:, None], (py - y0)[:, None]
        s = (arr[y0, x0] * (1 - tx) + arr[y0, x1] * tx) * (1 - ty) + (arr[y1, x0] * (1 - tx) + arr[y1, x1] * tx) * ty
        a = s[:, 3:4]
        lin = np.power(s[:, :3], 2.2)
        self.albedo[m] = self.albedo[m] * (1 - a) + lin * a
        self.metal[m] = self.metal[m] * (1 - a[:, 0]) + metallic * a[:, 0]
        self.rough[m] = self.rough[m] * (1 - a[:, 0]) + rough * a[:, 0]

    # ---- output ----
    def save(self, out_dir, name, normal_strength=1.0):
        os.makedirs(out_dir, exist_ok=True)
        srgb = np.power(np.clip(self.albedo, 0, 1), 1 / 2.2)
        Image.fromarray((srgb * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_color.jpg"), quality=90)
        orm = np.stack([np.ones_like(self.rough), np.clip(self.rough, 0.04, 1), np.clip(self.metal, 0, 1)], -1)
        Image.fromarray((orm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_orm.jpg"), quality=92)
        # texel size in metres along u and v (median over the map) to convert height slopes
        du = np.median(np.linalg.norm(np.diff(self.pos, axis=1), axis=-1))
        dv = np.median(np.linalg.norm(np.diff(self.pos, axis=0), axis=-1))
        h = self.height
        gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / (2 * max(du, 1e-4))
        gy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) / (2 * max(dv, 1e-4))  # +v is up the image
        k = 6.0 * normal_strength
        nx, ny = -gx * k, -gy * k
        nz = np.ones_like(nx)
        ln = np.sqrt(nx * nx + ny * ny + nz * nz)
        nm = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
        Image.fromarray((nm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_normal.png"), optimize=True)
        return {k2: os.path.join(out_dir, f"{name}_{k2}.{'png' if k2 == 'normal' else 'jpg'}") for k2 in ("color", "orm", "normal")}


def normals_from_pos(pos):
    du = np.gradient(pos, axis=1)
    dv = np.gradient(pos, axis=0)
    n = np.cross(du, dv)
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    return n / np.maximum(ln, 1e-9)


def orient_outward(nrm, pos, center_fn):
    """Flip normals that point inward (toward the local centre)."""
    c = center_fn(pos)
    s = np.sign(np.sum(nrm * (pos - c), axis=-1, keepdims=True))
    s[s == 0] = 1
    return nrm * s


# --------------------------------------------------------------------------- decal artwork

def insignia(px_per_m=120, radius_m=0.75):
    """USAF national insignia 1947-: blue disc and white star, white bars with red stripe, blue border."""
    R = radius_m * px_per_m
    w, h = int(R * 4.5), int(R * 2.3)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = w / 2, h / 2
    blue = (24, 56, 120, 255)
    border = R / 8
    bar_h = R * 0.5
    bar_len = R * 1.0
    # border outline: disc + bars expanded by border
    d.ellipse([cx - R - border, cy - R - border, cx + R + border, cy + R + border], fill=blue)
    d.rectangle([cx - R - bar_len - border, cy - bar_h / 2 - border + R * 0.05, cx + R + bar_len + border, cy + bar_h / 2 + border + R * 0.05], fill=blue)
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=blue)
    by = cy + R * 0.05
    d.rectangle([cx - R - bar_len, by - bar_h / 2, cx + R + bar_len, by + bar_h / 2], fill=(235, 235, 230, 255))
    d.rectangle([cx - R - bar_len, by - bar_h / 6, cx + R + bar_len, by + bar_h / 6], fill=(170, 25, 30, 255))
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=blue)
    pts = []
    for k in range(10):
        a = -math.pi / 2 + k * math.pi / 5
        rr = R if k % 2 == 0 else R * 0.382
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=(235, 235, 230, 255))
    return img, w / px_per_m, h / px_per_m


def lettering(text, height_m, px_per_m=200, color=(14, 14, 14, 255), spacing=0.12):
    f = font(int(height_m * px_per_m * 1.25))
    box = f.getbbox(text)
    tw = box[2] - box[0] + int(len(text) * spacing * height_m * px_per_m)
    th = int(height_m * px_per_m * 1.3)
    img = Image.new("RGBA", (tw + 10, th), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 5
    for ch in text:
        d.text((x, th / 2), ch, font=f, fill=color, anchor="lm", stroke_width=max(1, int(height_m * px_per_m * 0.05)), stroke_fill=color)
        x += f.getlength(ch) + spacing * height_m * px_per_m
    return img, img.width / px_per_m, img.height / px_per_m


# --------------------------------------------------------------------------- fuselage

FUS_TEX_LEN = B.FUS_D[-1]


def fuselage(out_dir, w=4096, h=1024):
    sk = Skin(w, h)
    d = sk.u * FUS_TEX_LEN
    theta = sk.v * 2 * math.pi
    r = np.array([B.fus_radius(x) for x in d], np.float32)
    zc = np.array([B.fus_center_z(x) for x in d], np.float32)
    hump = np.array([B.HUMP_FN(x) if P.CANOPY_HUMP[0][0] < x < P.CANOPY_HUMP[-1][0] else 0 for x in d], np.float32)
    t = np.minimum(theta, 2 * math.pi - theta)
    wgt = np.where(t < P.CANOPY_HALF_ANGLE, np.cos(np.clip(0.5 * math.pi * t / P.CANOPY_HALF_ANGLE, 0, math.pi / 2)) ** 1.5, 0)
    R = r[None, :] + hump[None, :] * wgt[:, None]
    sk.pos = np.stack([R * np.sin(theta)[:, None], np.broadcast_to(P.NOSE_Y - d[None, :], R.shape),
                       zc[None, :] + R * np.cos(theta)[:, None]], -1).astype(np.float32)
    sk.nrm = np.stack([np.sin(theta)[:, None] * np.ones_like(R), np.zeros_like(R), np.cos(theta)[:, None] * np.ones_like(R)], -1)

    px_u = w / FUS_TEX_LEN                    # px per metre along the fuselage
    col = lambda dd: dd * px_u                # noqa: E731
    row = lambda th: (1 - th / (2 * math.pi)) * h  # noqa: E731

    # Skin bays: circumferential joints (ESTIMATED ~1.5 m) and longitudinal seams staggered per bay
    joints = [1.45, 2.42, 3.4, 4.6, 5.6] + list(np.arange(7.0, 46.5, 1.52)) + [47.6]
    bay = np.searchsorted(joints, d)
    seams_deg = np.arange(0, 360, 22.5)
    ids = np.zeros((h, w), np.int32)
    deg = np.degrees(theta)
    for b in range(len(joints) + 1):
        cols = bay == b
        off = 11.25 if b % 2 else 0
        seg = (((deg - off) % 360) // 22.5).astype(np.int32)
        ids[:, cols] = (b * 17 + seg[:, None])
    sk.panel_variation(ids)
    sk.noise(0.015)

    # belly grime and exhaust/oil streaking aft of the wing (lower sides)
    belly = np.clip(1 - np.abs(deg - 180) / 70, 0, 1)
    sk.albedo *= (1 - 0.10 * belly)[:, None, None]
    sk.rough += (0.12 * belly)[:, None]

    sk.groove_cols([col(x) for x in joints])
    for b in range(len(joints) + 1):
        cols = bay == b
        off = 11.25 if b % 2 else 0
        m = np.zeros((h, w), bool)
        m[:, cols] = True
        sk.groove_rows([row(math.radians(a + off)) for a in seams_deg], mask=m)

    # rivets: double rows along joints, single rows along frames (every 0.508 m) and stringers (every 7.5 deg)
    pitch_v = lambda: max(0.04 / (2 * math.pi * 1.8 / h), 2)  # noqa: E731
    for x in joints:
        for o in (-0.018, 0.018):
            sk.rivets_along_col(col(x + o), pitch_v())
    for x in np.arange(2.0, 47.0, 0.508):
        sk.rivets_along_col(col(x), pitch_v())
    for a in np.arange(0, 360, 7.5):
        sk.rivets_along_row(row(math.radians(a)), 0.045 * px_u)

    # inspection panels with screws (ESTIMATED positions)
    for dd, a, wm, hm in [(6.8, 100, 0.5, 0.35), (6.8, 260, 0.5, 0.35), (16.0, 120, 0.6, 0.4), (16.0, 240, 0.6, 0.4),
                          (31.0, 95, 0.45, 0.45), (31.0, 265, 0.45, 0.45), (41.0, 110, 0.5, 0.3), (41.0, 250, 0.5, 0.3)]:
        c0, c1 = col(dd - wm / 2), col(dd + wm / 2)
        rr = math.radians(a)
        dth = hm / B.fus_radius(dd)
        r0, r1 = row(rr + dth / 2), row(rr - dth / 2)
        box = np.zeros((h, w), bool)
        box[int(r0):int(r1) + 1, int(c0):int(c1) + 1] = True
        sk.groove_cols([c0, c1], mask=box)
        sk.groove_rows([r0, r1], mask=box)
        for cc in (c0 + 3, c1 - 3):
            for rr2 in (r0 + 3, r1 - 3):
                sk.height[int(rr2), int(cc)] -= 0.0008

    # retractable turret bay doors (B-36H): upper forward, upper aft, lower aft (outlines + hinge rivets)
    T = P.TURRET_D
    for dd, a, ln, wd in [(T["upper_fwd"], 28, 2.1, 1.25), (T["upper_fwd"], 332, 2.1, 1.25),
                          (T["upper_aft"], 28, 1.9, 1.0), (T["upper_aft"], 332, 1.9, 1.0),
                          (T["lower_aft"], 152, 1.9, 1.0), (T["lower_aft"], 208, 1.9, 1.0)]:
        rr = math.radians(a)
        dth = wd / B.fus_radius(dd)
        c0, c1 = col(dd - ln / 2), col(dd + ln / 2)
        r0, r1 = row(rr + dth / 2), row(rr - dth / 2)
        box = np.zeros((h, w), bool)
        box[int(min(r0, r1)):int(max(r0, r1)) + 1, int(c0):int(c1) + 1] = True
        sk.groove_cols([c0, c1], mask=box, depth=0.001, dark=0.45, width=2)
        sk.groove_rows([r0, r1], mask=box, depth=0.001, dark=0.45, width=2)
        sk.groove_cols([(c0 + c1) / 2], mask=box, depth=0.0008, dark=0.5)

    # markings: national insignia aft fuselage both sides, lettering on the forward fuselage
    ins, iw, ih = insignia(radius_m=0.62)
    for sx in (1, -1):
        x = B.fus_radius(34.6)
        center = (sx * x, P.NOSE_Y - 34.6, B.fus_center_z(34.6) + 0.15)
        right = (0, sx * 1.0, 0)        # viewer's right: toward the nose on the right side, aft on the left
        sk.decal(ins, center, right, (0, 0, 1), iw, ih)
    txt, tw, th = lettering("UNITED STATES AIR FORCE", 0.36)
    for sx in (1, -1):
        dmid = 11.6
        z = 0.95
        x = math.sqrt(max(B.fus_radius(dmid) ** 2 - z * z, 0.1))
        sk.decal(txt, (sx * x, P.NOSE_Y - dmid, z), (0, sx * 1.0, 0), (0, 0.0, 1), tw, th)
    return sk.save(out_dir, "fuselage")


# --------------------------------------------------------------------------- lifting surfaces

def lifting_surface(out_dir, name, w, h, section_fn, span_of_u, decals=(), ribs=0.75, spars=(0.12, 0.40, 0.66),
                    hinge=None, seams_span=2.4):
    """Generic wing-type skin. section_fn(span) -> Section, span_of_u(u) -> (span coord, side sign)."""
    sk = Skin(w, h)
    spans = [span_of_u(u) for u in sk.u]
    v = sk.v
    upper = v < 0.5
    s_of_v = np.where(upper, 1 - 2 * v, 2 * v - 1).astype(np.float32)
    pos = np.zeros((h, w, 3), np.float32)
    for c, (sp, sign) in enumerate(spans):
        sec = section_fn(abs(sp))
        s = s_of_v
        cam = np.array([B.camber_line(x, sec.camber) for x in s], np.float32)
        thick = np.array([B.naca_thickness(x, sec.tc) for x in s], np.float32)
        z = np.where(upper, cam + thick, cam - thick)
        p = (np.array(sec.le)[None, :] + np.array(sec.cd)[None, :] * (s * sec.chord)[:, None]
             + np.array(sec.td)[None, :] * (z * sec.chord)[:, None])
        if sign < 0:
            p[:, 0] *= -1
        pos[:, c] = p
    sk.pos = pos
    nrm = normals_from_pos(pos)
    # outward: upper surfaces point along +thickness dir; flip by comparing with thickness side
    sk.nrm = np.where(upper[:, None, None], 1, -1) * np.sign(np.sum(nrm * np.array(section_fn(1.0).td)[None, None, :], -1, keepdims=True) + 1e-6) * nrm
    sk.nrm = np.abs(sk.nrm) * 0 + sk.nrm  # keep dtype

    span_abs = np.array([abs(sp) for sp, _ in spans], np.float32)
    side = np.array([sign for _, sign in spans])
    px_per_span = 1.0 / np.median(np.abs(np.diff(span_abs)) + 1e-9)
    # panels: span bins x chord bins x side x surface
    sbin = (span_abs // seams_span).astype(np.int32)
    cbin = np.digitize(s_of_v, list(spars)).astype(np.int32)
    ids = (sbin[None, :] * 10 + cbin[:, None]) * 4 + (side[None, :] > 0) * 2 + upper[:, None]
    sk.panel_variation(ids.astype(np.int32))
    sk.noise(0.012)
    col_at = lambda sp: [c for c in range(1, w) if (span_abs[c - 1] - sp) * (span_abs[c] - sp) <= 0 and side[c] == side[c - 1]]  # noqa: E731
    seam_cols = []
    for sp in np.arange(seams_span, span_abs.max(), seams_span):
        seam_cols += col_at(sp)
    sk.groove_cols(seam_cols)
    row_of_s = lambda s, up: (1 - (0.5 * (1 - s) if up else 0.5 + 0.5 * s)) * h  # noqa: E731
    chord_lines = list(spars) + ([hinge] if hinge else [])
    for s in chord_lines:
        for up in (True, False):
            sk.groove_rows([row_of_s(s, up)], depth=0.0005)
    # rivets: double rows on spars, single rows on ribs
    for s in spars:
        for up in (True, False):
            for o in (-0.006, 0.006):
                sk.rivets_along_row(row_of_s(s + o, up), max(px_per_span * 0.05, 2))
    rib_cols = []
    for sp in np.arange(ribs, span_abs.max(), ribs):
        rib_cols += col_at(sp)
    for c in rib_cols:
        sk.rivets_along_col(c, max(h * 0.008, 2))
    for img, center, right, up, ww, hh in decals:
        sk.decal(img, center, right, up, ww, hh)
    return sk.save(out_dir, name, normal_strength=0.8)


def wing(out_dir, w=4096, h=2048):
    semi = P.SEMISPAN

    def span_of_u(u):
        x = (u - 0.5) * 2 * semi
        return (abs(x), 1 if x >= 0 else -1)

    ins, iw, ih = insignia(radius_m=1.15)
    x = 25.5
    sec = B.wing_section(x)
    top = sec.point(0.42, B.camber_line(0.42, sec.camber) + B.naca_thickness(0.42, sec.tc))
    bot = sec.point(0.42, B.camber_line(0.42, sec.camber) - B.naca_thickness(0.42, sec.tc))
    decals = [
        (ins, (-top.x, top.y, top.z), (1, 0, 0), (0, 1, 0), iw, ih),   # upper left wing, seen from above
        (ins, (bot.x, bot.y, bot.z), (-1, 0, 0), (0, 1, 0), iw, ih),   # lower right wing, seen from below
    ]
    usaf, uw, uh = lettering("USAF", 1.6, px_per_m=60)
    ls = B.wing_section(17.0)
    lb = ls.point(0.45, B.camber_line(0.45, ls.camber) - B.naca_thickness(0.45, ls.tc))
    # lower left wing, reads from below with the leading edge up
    decals.append((usaf, (-lb.x, lb.y, lb.z), (-1, 0, 0), (0, 1, 0), uw, uh))
    return lifting_surface(out_dir, "wing", w, h, B.wing_section, span_of_u, decals, hinge=P.HINGE_FRAC)


def tail(out_dir):
    fin_sec, z0, z1 = B.FIN_SECTION_FN, P.FIN_ROOT_Z, P.FIN_LE[-1][0]

    def fin_span(u):
        return (z0 + u * (z1 - z0), 1)

    serial, sw, sh = lettering("15726", 0.62, px_per_m=160)
    usaf, uw, uh = lettering("U.S. AIR FORCE", 0.2, px_per_m=240)
    d_mid = 45.4
    decals = []
    for sx in (1, -1):
        decals.append((serial, (sx * 0.4, P.NOSE_Y - d_mid, 5.3), (0, sx * 1.0, 0), (0, 0, 1), sw, sh))
        decals.append((usaf, (sx * 0.4, P.NOSE_Y - d_mid, 6.15), (0, sx * 1.0, 0), (0, 0, 1), uw, uh))
    fin = lifting_surface(out_dir, "fin", 2048, 1024, lambda z: fin_sec(z), fin_span, decals, ribs=0.55,
                          spars=(0.15, 0.55), seams_span=1.6)
    semi = P.HT_SEMISPAN

    def stab_span(u):
        x = (u - 0.5) * 2 * semi
        return (abs(x), 1 if x >= 0 else -1)

    stab = lifting_surface(out_dir, "stab", 2048, 1024, lambda x: B.HT_SECTION_FN(x), stab_span, (), ribs=0.5,
                           spars=(0.15, 0.55), seams_span=1.8)
    return fin, stab


def nacelle(out_dir, w=1024, h=1024):
    sk = Skin(w, h)
    # tiled cylinder-ish layout: u along (0 = front, 1 = prop), v around
    U, V = np.meshgrid(sk.u, sk.v)
    sk.pos = np.stack([np.cos(V * 2 * math.pi) * 0.9, U * 9.0, np.sin(V * 2 * math.pi) * 0.9], -1).astype(np.float32)
    sk.nrm = np.stack([np.cos(V * 2 * math.pi), np.zeros_like(U), np.sin(V * 2 * math.pi)], -1)
    ids = ((U * 7).astype(int) * 13 + (V * 8).astype(int)).astype(np.int32)
    sk.panel_variation(ids, tint=0.06)
    sk.noise(0.04)
    sk.groove_cols([w * k / 7 for k in range(1, 7)])
    sk.groove_rows([h * k / 8 for k in range(8)])
    for k in range(1, 7):
        sk.rivets_along_col(w * k / 7 + 2, h * 0.012)
        sk.rivets_along_col(w * k / 7 - 2, h * 0.012)
    # heat and exhaust staining toward the aft (engine) end: bluish-brown tint, rougher
    heat = np.clip((U - 0.55) / 0.45, 0, 1)
    sk.albedo *= (1 - 0.35 * heat)[..., None]
    sk.albedo += (np.array([0.02, -0.005, -0.02]) * heat[..., None]).astype(np.float32)
    sk.rough += 0.2 * heat
    return sk.save(out_dir, "nacelle", normal_strength=0.8)


def build_all(out_dir):
    maps = {"fuselage": fuselage(out_dir), "wing": wing(out_dir), "nacelle": nacelle(out_dir)}
    maps["fin"], maps["stab"] = tail(out_dir)
    return maps
