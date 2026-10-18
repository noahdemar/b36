"""Panel markings drawn as RGBA overlays: white group outlines, labels, data plates and screw heads.

Each overlay covers a rectangle of a panel in that panel's local coordinates (metres) and is applied
as a transparent quad just in front of the panel face (build_interior.py). Layout follows the NMUSAF
flight deck photo and the flight manual pedestal drawing (reference/cockpit/b-36_pit02.jpg); exact
wording on small plates is representative, not transcribed.
"""
from PIL import Image, ImageDraw, ImageFont

WHITE = (232, 230, 220, 255)
PLATE = (210, 205, 190, 255)
INK = (20, 20, 20, 255)
SCREW = (120, 120, 118, 255)


def font(px):
    return ImageFont.load_default(size=max(6, int(px)))


class Overlay:
    def __init__(self, u0, u1, v0, v1, px_per_m=900):
        self.u0, self.u1, self.v0, self.v1 = u0, u1, v0, v1
        self.k = px_per_m
        self.w = int((u1 - u0) * px_per_m)
        self.h = int((v1 - v0) * px_per_m)
        self.im = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def px(self, u, v):
        return (u - self.u0) * self.k, (self.v1 - v) * self.k

    def rect(self, u0, v0, u1, v1, width_m=0.003, color=WHITE):
        a, b = self.px(u0, v1), self.px(u1, v0)
        self.d.rectangle([a, b], outline=color, width=max(1, int(width_m * self.k)))

    def text(self, u, v, s, h_m=0.012, color=WHITE, anchor="mm"):
        self.d.text(self.px(u, v), s, fill=color, font=font(h_m * self.k), anchor=anchor)

    def plate(self, u, v, w, h, lines, title=None):
        """Cream data plate with black text lines."""
        a, b = self.px(u - w / 2, v + h / 2), self.px(u + w / 2, v - h / 2)
        self.d.rectangle([a, b], fill=PLATE, outline=(90, 90, 85, 255), width=1)
        n = len(lines) + (1 if title else 0)
        lh = h / (n + 0.5)
        y = v + h / 2 - lh * 0.8
        if title:
            self.text(u, y, title, lh * 0.75, INK)
            y -= lh
        for ln in lines:
            self.text(u, y, ln, lh * 0.62, INK)
            y -= lh

    def screws(self, pts, r_m=0.004):
        for u, v in pts:
            x, y = self.px(u, v)
            r = r_m * self.k
            self.d.ellipse([x - r, y - r, x + r, y + r], fill=SCREW)
            self.d.line([x - r * 0.7, y, x + r * 0.7, y], fill=(40, 40, 40, 255), width=1)

    def save(self, path):
        self.im.save(path, optimize=True)
        return path


def main_panel(path, ac_cluster, p_cluster, jet_block, inst_drop, lamp_v):
    """Main instrument panel overlay. Clusters: (kind, u, v, r); jet_block: (u0, u1, v0, v1)."""
    o = Overlay(-1.40, 1.40, 0.68, 1.42)
    ju0, ju1, jv0, jv1 = jet_block
    o.rect(ju0, jv0, ju1, jv1, 0.004)  # white box around the jet engine group (photo)
    o.text((ju0 + ju1) / 2, jv1 + 0.018, "JET ENGINE INSTRUMENTS", 0.016)
    for k in range(4):
        o.text(ju0 + (ju1 - ju0) * (k + 0.5) / 4, jv1 - 0.012, str(k + 1), 0.014)
    o.text(0.0, lamp_v - inst_drop + 0.032, "PROPELLER REVERSE", 0.011)
    labels = {"asi": "AIRSPEED", "alt": "ALTIMETER", "vsi": "RATE OF CLIMB", "heading": "COURSE IND.", "att": "ATTITUDE",
              "turn": "TURN & BANK", "rpm": "TACHOMETER", "manp": "MANIFOLD", "radalt": "RADIO ALT", "clock": "CLOCK"}
    for kind, u, v, r in list(ac_cluster) + list(p_cluster):
        o.text(u, v - inst_drop - r * 1.25 - 0.008, labels.get(kind, ""), 0.009)
    # placards (photo: limitations table below the left cluster, compass correction card)
    o.plate(-0.42, 0.785, 0.16, 0.085, ["GEAR DOWN  220 MPH", "FLAPS 30   190 MPH", "FLAPS 100  165 MPH", "BOMB DOORS 300 MPH"],
            "AIRSPEED LIMITATIONS")
    o.plate(0.70, 0.765, 0.13, 0.06, ["FOR  N  030  060  090", "STR  359 028  061  092"], "COMPASS CORRECTION")
    o.plate(0.33, 1.30 - inst_drop, 0.11, 0.05, ["DO NOT REVERSE PROPS", "ABOVE 200 MPH"], "WARNING")
    # screw heads along the panel edge
    pts = [(-1.30 + 0.13 * k, 0.72) for k in range(21)] + [(u, 0.72 + 0.1 * j) for u in (-1.33, 1.33) for j in range(1, 5)]
    o.screws(pts)
    return o.save(path)


def pedestal_top(path):
    """Pedestal top overlay, local u across (-0.24..0.24), v fore-aft (0 = front edge, negative aft).
    Layout matches build_pedestal: autopilot -0.02..-0.26, throttles -0.29..-0.60, rudder trim -0.68,
    aileron trim -0.80, prop reverse -0.89, radios -0.93..-1.15."""
    o = Overlay(-0.24, 0.24, -1.16, 0.0, px_per_m=1400)
    o.rect(-0.22, -0.25, 0.22, -0.02, 0.002)
    o.text(-0.20, -0.035, "AUTOPILOT CONTROL", 0.010, anchor="lm")
    for k, t in enumerate(("TURN", "PITCH", "SENS", "TRIM")):
        o.text(-0.15 + 0.10 * k, -0.115, t, 0.008)
    for k, t in enumerate(("SERVO", "AIL", "ELEV", "RUD", "MASTER")):
        o.text(-0.16 + 0.08 * k, -0.215, t, 0.007)
    o.text(0.0, -0.275, "THROTTLES", 0.012)
    for k in range(6):
        o.text(-0.15 + 0.06 * k, -0.62, str(k + 1), 0.014)
    o.text(-0.205, -0.36, "LOCK", 0.008)
    o.text(0.0, -0.735, "RUDDER TRIM TAB", 0.011)
    o.plate(0.16, -0.52, 0.10, 0.06, ["BRAKE ON", "", "BRAKE OFF"], "PARKING BRAKE")
    o.text(0.0, -0.775, "AILERON TRIM TAB", 0.009)
    o.text(-0.12, -0.80, "LEFT WING DOWN", 0.007)
    o.text(0.12, -0.80, "RIGHT WING DOWN", 0.007)
    o.plate(0.0, -0.865, 0.24, 0.045, ["DO NOT READY UNTIL GROUND CONTACT"], "PROPELLER REVERSE SELECTION  WARNING")
    for k, t in enumerate(("OUTBD", "CENTER", "INBD")):
        o.text(-0.07 + 0.07 * k, -0.905, t, 0.007)
    for v0, v1, title in ((-0.93, -1.00, "VHF COMMAND"), (-1.00, -1.085, "LIAISON TRANSMITTER"), (-1.085, -1.15, "RADIO COMPASS")):
        o.rect(-0.22, v1, 0.22, v0, 0.002)
        o.text(-0.20, v0 - 0.01, title, 0.008, anchor="lm")
    o.screws([(u, v) for u in (-0.228, 0.228) for v in (-0.02, -0.27, -0.64, -0.92, -1.14)], 0.003)
    return o.save(path)


def overhead(path):
    """Overhead jet control panel overlay (u across, v fore-aft: 0 = front edge, negative aft)."""
    o = Overlay(-0.33, 0.33, -0.80, 0.0, px_per_m=1400)
    o.text(0.0, -0.03, "JET ENGINE CONTROL", 0.016)
    for k in range(4):
        o.text(-0.15 + 0.10 * k, -0.11, f"JET {k + 1}", 0.011)
    for j, title in enumerate(("FUEL SHUTOFF", "IGNITION", "STARTER")):
        v = -0.35 - 0.13 * j
        o.text(-0.31, v + 0.05, title, 0.010, anchor="lm")
        for k in range(5):
            o.text(-0.24 + 0.12 * k, v - 0.03, "ON  OFF", 0.007)
    o.rect(-0.31, -0.78, 0.31, -0.24, 0.003)
    return o.save(path)


def console(path, width, panels, sx):
    """Side console top overlay: u across (-w/2..w/2), v fore-aft (-1..1, + forward)."""
    o = Overlay(-width / 2, width / 2, -1.0, 1.0, px_per_m=900)
    titles = (["ENGINE FIRE EXTINGUISHER", "LIGHTS", "INTERPHONE"] if sx > 0 else ["LIGHTS", "INTERPHONE"])
    for (cy, ln), t in zip(panels, titles):
        o.rect(-width / 2 + 0.03, cy - ln / 2 + 0.01, width / 2 - 0.03, cy + ln / 2 - 0.01, 0.002)
        o.text(0.0, cy + ln / 2 - 0.025, t, 0.012)
        for j in range(int(ln / 0.11)):
            v = cy - ln / 2 + 0.06 + 0.11 * j
            o.text(0.0, v - 0.03, "OFF        ON", 0.008)
    return o.save(path)
