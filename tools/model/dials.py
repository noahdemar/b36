"""Instrument dial faces drawn with PIL into one texture atlas.

Each dial spec maps values to clockwise angles (degrees from 12 o'clock). The same mapping is
exported to glTF extras so the client can drive needles.
"""
import math

from PIL import Image, ImageDraw, ImageFont

CELL = 256
GRID = 8
ATLAS = CELL * GRID

WHITE = (235, 232, 220)
FACE = (14, 14, 15)
RED = (200, 40, 30)
GREEN = (40, 160, 70)
YELLOW = (220, 180, 40)


def font(size):
    return ImageFont.load_default(size=size)


# --- dial specs -------------------------------------------------------------------------------
# scale: list of (value, angle_deg_cw). label: text on face. majors: values with numbers.
# minors: values with small ticks. text_fn: label formatting. arcs: colored range arcs.

def lin(v0, a0, v1, a1):
    return [(v0, a0), (v1, a1)]


DIALS = {
    "asi": dict(label="AIRSPEED", sub="MPH", scale=[(0, -150), (50, -150), (100, -100), (200, 0),
                                                      (300, 80), (400, 130), (450, 150)],
                majors=[50, 100, 150, 200, 250, 300, 350, 400, 450], minors=range(50, 451, 10),
                arcs=[(150, 160, YELLOW)]),
    "alt": dict(label="ALT", sub="FEET", scale=lin(0, 0, 1000, 360),
                majors=[0, 100, 200, 300, 400, 500, 600, 700, 800, 900], minors=range(0, 1000, 20),
                text_fn=lambda v: str(v // 100)),
    "vsi": dict(label="CLIMB", sub="1000 FT PER MIN", scale=[(-6000, -255), (0, -90), (6000, 75)],
                majors=[-6000, -4000, -2000, 0, 2000, 4000, 6000], minors=range(-6000, 6001, 500),
                text_fn=lambda v: str(abs(v) // 1000)),
    "turn": dict(label="TURN", sub="4 MIN", scale=lin(-1, -40, 1, 40), majors=[], minors=[-1, -0.5, 0, 0.5, 1],
                 text_fn=lambda v: ""),
    "rpm": dict(label="R.P.M.", sub="X 100", scale=lin(0, -150, 3000, 150),
                majors=list(range(0, 3001, 500)), minors=range(0, 3001, 100), text_fn=lambda v: str(v // 100),
                arcs=[(2300, 2700, GREEN)]),
    "manp": dict(label="MAN PRESS", sub="IN HG", scale=lin(10, -150, 70, 150),
                 majors=list(range(10, 71, 10)), minors=range(10, 71, 2), arcs=[(25, 52, GREEN)]),
    "radalt": dict(label="RADIO ALTITUDE", sub="FEET X 100", scale=lin(0, -150, 4000, 150),
                   majors=list(range(0, 4001, 1000)), minors=range(0, 4001, 200), text_fn=lambda v: str(v // 100)),
    "clock": dict(label="", sub="", scale=lin(0, 0, 12, 360), majors=list(range(1, 13)), minors=[x / 5 for x in range(60)]),
    "jet_rpm": dict(label="TACH", sub="% RPM", scale=lin(0, -150, 110, 150), majors=list(range(0, 111, 20)),
                    minors=range(0, 111, 5), arcs=[(90, 100, GREEN), (100, 103, RED)]),
    "jet_egt": dict(label="EXH TEMP", sub="C X 100", scale=lin(0, -150, 1000, 150), majors=list(range(0, 1001, 200)),
                    minors=range(0, 1001, 50), text_fn=lambda v: str(v // 100), arcs=[(300, 690, GREEN), (690, 720, RED)]),
    "jet_fuel": dict(label="FUEL PRESS", sub="PSI", scale=lin(0, -150, 1000, 150), majors=list(range(0, 1001, 200)),
                     minors=range(0, 1001, 50)),
    "jet_oil": dict(label="OIL PRESS", sub="PSI", scale=lin(0, -150, 100, 150), majors=list(range(0, 101, 20)),
                    minors=range(0, 101, 5), arcs=[(12, 50, GREEN)]),
    # Flight engineer's engine gauges. Ranges ESTIMATED (R-4360 class), red lines match web/src/sim/powerplant.ts.
    "cht": dict(label="CYL TEMP", sub="DEG C", scale=lin(0, -150, 350, 150), majors=list(range(0, 351, 50)),
                minors=range(0, 351, 10), arcs=[(150, 232, GREEN), (232, 260, YELLOW), (260, 350, RED)]),
    "oilt": dict(label="OIL TEMP", sub="DEG C", scale=lin(-50, -150, 150, 150), majors=list(range(-50, 151, 50)),
                 minors=range(-50, 151, 10), arcs=[(40, 85, GREEN), (95, 150, RED)]),
    "ff": dict(label="FUEL FLOW", sub="LB/HR X 100", scale=lin(0, -150, 3000, 150), majors=list(range(0, 3001, 500)),
               minors=range(0, 3001, 100), text_fn=lambda v: str(v // 100)),
    "fuelq": dict(label="FUEL QTY", sub="LB X 1000", scale=lin(0, -150, 100_000, 150), majors=list(range(0, 100_001, 20_000)),
                  minors=range(0, 100_001, 5_000), text_fn=lambda v: str(v // 1000)),
}

# Rotating cards (whole face turns): heading card (value = heading deg, card rotates -heading)
CARDS = ["heading"]


def angle_of(scale, v):
    if v <= scale[0][0]:
        return scale[0][1]
    for (v0, a0), (v1, a1) in zip(scale, scale[1:]):
        if v <= v1:
            return a0 + (a1 - a0) * (v - v0) / (v1 - v0)
    return scale[-1][1]


def polar(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.sin(a), cy - r * math.cos(a)


def draw_dial(spec):
    im = Image.new("RGB", (CELL, CELL), FACE)
    d = ImageDraw.Draw(im)
    c = CELL / 2
    R = CELL / 2 - 6
    sc = spec["scale"]
    for v0, v1, col in spec.get("arcs", []):
        a0, a1 = angle_of(sc, v0), angle_of(sc, v1)
        d.arc([c - R + 6, c - R + 6, c + R - 6, c + R - 6], a0 - 90, a1 - 90, fill=col, width=9)
    for v in spec.get("minors", []):
        a = angle_of(sc, v)
        d.line([polar(c, c, R - 4, a), polar(c, c, R - 16, a)], fill=WHITE, width=2)
    text_fn = spec.get("text_fn", lambda v: str(v))
    f = font(26)
    for v in spec.get("majors", []):
        a = angle_of(sc, v)
        d.line([polar(c, c, R - 2, a), polar(c, c, R - 26, a)], fill=WHITE, width=5)
        t = text_fn(v)
        if t:
            x, y = polar(c, c, R - 48, a)
            d.text((x, y), t, fill=WHITE, font=f, anchor="mm")
    if spec.get("label"):
        d.text((c, c + 28), spec["label"], fill=WHITE, font=font(16), anchor="mm")
    if spec.get("sub"):
        d.text((c, c - 30), spec["sub"], fill=WHITE, font=font(13), anchor="mm")
    return im


def draw_heading_card():
    im = Image.new("RGB", (CELL, CELL), FACE)
    d = ImageDraw.Draw(im)
    c = CELL / 2
    R = CELL / 2 - 6
    for deg in range(0, 360, 5):
        ln = 22 if deg % 30 == 0 else (14 if deg % 10 == 0 else 8)
        d.line([polar(c, c, R - 2, deg), polar(c, c, R - 2 - ln, deg)], fill=WHITE, width=3 if deg % 10 == 0 else 2)
    labels = {0: "N", 90: "E", 180: "S", 270: "W"}
    for deg in range(0, 360, 30):
        t = labels.get(deg, str(deg // 10))
        x, y = polar(c, c, R - 44, deg)
        d.text((x, y), t, fill=WHITE if deg not in labels else YELLOW, font=font(28), anchor="mm")
    return im


def draw_attitude_ball():
    """Equirectangular ball texture: u = longitude, v = latitude. Sky above, earth below."""
    w, h = 512, 256
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w, h / 2], fill=(70, 120, 190))
    d.rectangle([0, h / 2, w, h], fill=(25, 20, 18))
    d.line([0, h / 2, w, h / 2], fill=WHITE, width=4)
    for p in range(-60, 61, 10):
        if p == 0:
            continue
        y = h / 2 - p / 180 * h
        for uc in (0.25, 0.75):  # ladder on front (u=0.25) and back
            hw = 30 if p % 20 == 0 else 18
            d.line([uc * w - hw, y, uc * w + hw, y], fill=WHITE, width=2)
    return im


def build_atlas(path):
    """Returns {name: (u0, v0, u1, v1)} in glTF UV space (v up)."""
    atlas = Image.new("RGB", (ATLAS, ATLAS), (0, 0, 0))
    uv = {}
    items = [(k, draw_dial(v)) for k, v in DIALS.items()] + [("heading", draw_heading_card())]
    for i, (name, im) in enumerate(items):
        gx, gy = i % GRID, i // GRID
        atlas.paste(im, (gx * CELL, gy * CELL))
        u0, u1 = gx / GRID, (gx + 1) / GRID
        v1, v0 = 1 - gy / GRID, 1 - (gy + 1) / GRID
        uv[name] = (u0, v0, u1, v1)
    atlas.save(path)
    return uv
