"""Tileable PBR textures for the interior: worn black paint, interior green paint, olive drab canvas,
quilted black sound-proofing, floor mat.

Colours are matched by eye to the NMUSAF flight deck photo (reference/cockpit/user_flightdeck.webp)
and the radio rack walkaround photo (060830-f-1234p-005.jpg): black wrinkle-finish panels worn to bare
metal at edges, grey-green consoles, olive drab seat cushions, black fuzzy insulation above the glazing.
All textures tile (periodic noise via FFT, wrapped drawing). Each repeat covers TILE_M metres
(box-projected UVs in build_interior.py).

Outputs per material: <name>_color.jpg (sRGB), <name>_orm.jpg (G roughness, B metallic), <name>_normal.jpg.
"""
import os

import numpy as np
from PIL import Image

N = 1024
RNG = np.random.default_rng(1949)

# metres covered by one texture repeat
TILE_M = {"paint_panel": 0.5, "paint_black": 0.5, "paint_green": 0.6, "canvas": 0.35, "webbing": 0.2, "quilt": 0.8, "floor": 0.6, "metal_dark": 0.5}


def periodic_noise(n, freq_lo, freq_hi, rng, power=1.0):
    """Band-limited periodic noise in [-1, 1] (FFT filtered white noise)."""
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    r = np.sqrt(fx * fx + fy * fy)
    band = ((r >= freq_lo) & (r <= freq_hi)).astype(np.float32) / np.maximum(r, 1) ** power
    spec = np.fft.fft2(rng.standard_normal((n, n))) * band
    out = np.real(np.fft.ifft2(spec)).astype(np.float32)
    return out / (np.abs(out).max() + 1e-9)


def fbm(n, rng, lo=2, hi=200):
    return periodic_noise(n, lo, hi, rng, power=1.0)


def scratches(n, rng, count, length_px, width=1):
    """Wrapped random thin strokes (mask in [0, 1]); lengths log-normal, intensity random."""
    m = np.zeros((n, n), np.float32)
    for _ in range(count):
        x, y = rng.uniform(0, n, 2)
        a = rng.uniform(0, np.pi)
        ln = min(length_px * 3, rng.lognormal(np.log(length_px * 0.35), 0.6))
        level = rng.uniform(0.08, 0.4)
        steps = int(ln)
        bend = rng.normal(0, 0.002)
        for s in range(steps):
            a += bend
            xi, yi = int(x) % n, int(y) % n
            for w in range(width):
                m[(yi + w) % n, xi] = max(m[(yi + w) % n, xi], level * (1 - s / max(steps, 1) * 0.6))
            x += np.cos(a)
            y += np.sin(a)
    return m


def height_to_normal(h, metres_per_px, strength=1.0):
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / (2 * metres_per_px)
    gy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) / (2 * metres_per_px)
    nx, ny = -gx * strength, -gy * strength
    nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5


def save(out_dir, name, albedo, rough, metal, height, strength=1.0):
    os.makedirs(out_dir, exist_ok=True)
    srgb = np.power(np.clip(albedo, 0, 1), 1 / 2.2)
    Image.fromarray((srgb * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_color.jpg"), quality=90)
    orm = np.stack([np.ones_like(rough), np.clip(rough, 0.04, 1), np.clip(metal, 0, 1)], -1)
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_orm.jpg"), quality=92)
    nm = height_to_normal(height, TILE_M[name] / N, strength)
    Image.fromarray((nm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, f"{name}_normal.jpg"), quality=94)
    return {k: os.path.join(out_dir, f"{name}_{k}.jpg") for k in ("color", "orm", "normal")}


def worn_paint(out_dir, name, base, wear_amount, rough_base, wrinkle):
    """Painted metal: mottled paint, wrinkle finish, chips and scratches to bare aluminium."""
    rng = np.random.default_rng(abs(hash(name)) % 2**32)
    mott = fbm(N, rng, 2, 40)
    fine = periodic_noise(N, 150, 400, rng, 0.0)
    albedo = np.tile(np.array(base, np.float32), (N, N, 1)) * (1 + 0.18 * mott[..., None] + 0.05 * fine[..., None])
    rough = rough_base + 0.08 * fbm(N, rng, 3, 60)
    metal = np.zeros((N, N), np.float32)
    height = wrinkle * periodic_noise(N, 90, 260, rng, 0.0)  # wrinkle finish (m)
    # chips: thresholded noise, rarer where the paint is "protected"
    chipn = fbm(N, rng, 3, 30) + 0.25 * periodic_noise(N, 40, 140, rng, 0.0)
    thr = np.quantile(chipn, 1 - wear_amount * 0.12)  # wear_amount 0.1 -> 1.2% of the area chipped
    chip = np.clip((chipn - thr) / 0.03, 0, 1)
    scr = scratches(N, rng, int(2500 * wear_amount), 60)
    bare = np.maximum(chip, scr * 0.85)
    alu = np.array([0.30, 0.31, 0.32], np.float32)  # dull, dirty bare metal
    albedo = albedo * (1 - bare[..., None]) + alu * bare[..., None]
    rough = rough * (1 - bare) + 0.38 * bare
    metal = np.maximum(metal, bare)
    height = height - 0.00006 * bare  # paint thickness step
    # grime: darker, rougher low-frequency patches
    grime = np.clip(fbm(N, rng, 1, 12), 0, 1)
    albedo *= (1 - 0.25 * grime[..., None])
    rough += 0.06 * grime
    return save(out_dir, name, albedo, rough, metal, height, 1.0)


def canvas(out_dir, name="canvas", base=(0.105, 0.125, 0.045)):
    rng = np.random.default_rng(7 + len(name))
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    threads = 110  # threads per repeat (0.35 m -> ~3.2 mm pitch)
    wx = np.sin(2 * np.pi * x * threads / N)
    wy = np.sin(2 * np.pi * y * threads / N)
    weave = np.where(((np.floor(x * threads * 2 / N) + np.floor(y * threads * 2 / N)) % 2) == 0, wx, wy)
    base = np.array(base, np.float32)
    mott = fbm(N, rng, 2, 30)
    albedo = np.tile(base, (N, N, 1)) * (1 + 0.22 * mott[..., None] + 0.03 * weave[..., None])
    rough = 0.88 + 0.05 * mott
    metal = np.zeros((N, N), np.float32)
    height = 0.00008 * weave + 0.0008 * fbm(N, rng, 2, 10)  # weave + lumps
    return save(out_dir, name, albedo, rough, metal, height, 1.0)


def quilt(out_dir):
    """Black fuzzy sound-proofing blankets with diamond stitching (cells 0.1 m across)."""
    rng = np.random.default_rng(11)
    y, x = np.mgrid[0:N, 0:N].astype(np.float32) / N
    cells = 8
    a = (x + y) * cells
    b = (x - y) * cells
    da = np.abs(a - np.round(a))
    db = np.abs(b - np.round(b))
    seam = np.minimum(da, db)
    pillow = np.sqrt(np.clip(seam / 0.5, 0, 1))
    fuzz = periodic_noise(N, 200, 500, rng, 0.0)
    mott = fbm(N, rng, 2, 50)
    base = np.array([0.020, 0.020, 0.024], np.float32)
    albedo = np.tile(base, (N, N, 1)) * (1 + 0.5 * mott[..., None] + 0.35 * fuzz[..., None])
    albedo *= (0.55 + 0.45 * pillow)[..., None]
    rough = 0.96 + 0.03 * fuzz
    metal = np.zeros((N, N), np.float32)
    height = 0.008 * pillow + 0.0003 * fuzz
    return save(out_dir, "quilt", albedo, rough, metal, height, 1.0)


def floor(out_dir):
    """Worn dark grey non-slip floor covering with scuffs."""
    rng = np.random.default_rng(13)
    grain = periodic_noise(N, 250, 500, rng, 0.0)
    mott = fbm(N, rng, 2, 40)
    base = np.array([0.030, 0.032, 0.030], np.float32)
    scuff = scratches(N, rng, 700, 50) * 0.5
    albedo = np.tile(base, (N, N, 1)) * (1 + 0.3 * mott[..., None] + 0.15 * grain[..., None]) + 0.05 * scuff[..., None]
    rough = 0.8 + 0.05 * mott - 0.25 * scuff
    metal = np.zeros((N, N), np.float32)
    height = 0.0002 * grain - 0.00005 * scuff
    return save(out_dir, "floor", albedo, rough, metal, height, 1.0)


def build_all(out_dir):
    return {
        # instrument panel, glareshield, canopy frames: kept clean, fine scratches only
        "paint_panel": worn_paint(out_dir, "paint_panel", (0.020, 0.020, 0.022), 0.012, 0.6, 0.00004),
        # black equipment and pedestal: heavy edge wear (photo 005)
        "paint_black": worn_paint(out_dir, "paint_black", (0.022, 0.022, 0.024), 0.10, 0.55, 0.00004),
        # consoles and lower walls: grey-green, light wear
        "paint_green": worn_paint(out_dir, "paint_green", (0.055, 0.090, 0.080), 0.05, 0.62, 0.00001),
        # structure and seat frames (darker, satin)
        "metal_dark": worn_paint(out_dir, "metal_dark", (0.030, 0.036, 0.033), 0.14, 0.45, 0.00001),
        "canvas": canvas(out_dir),  # olive drab cushions
        "webbing": canvas(out_dir, "webbing", (0.16, 0.135, 0.075)),  # khaki harness webbing
        "quilt": quilt(out_dir),
        "floor": floor(out_dir),
    }


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_tex", "interior")
    for k, v in build_all(out).items():
        print(k, v["color"])
