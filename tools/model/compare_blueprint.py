"""Overlay the General Dynamics three-view on orthographic renders of the model.

Usage: uv run python compare_blueprint.py [--out DIR]
Writes overlay_top.png and overlay_side.png. Red = drawing, gray = model.
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_b36  # noqa: E402
import params as P  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "../../reference/raw/ref04.png")
M_PER_PX = 0.06
# Drawing calibration (reference/MEASUREMENTS.md): m/px horizontal, m/px vertical,
# plan view centerline col and nose row, side view fuselage-axis col and nose row.
DRAW_SX, DRAW_SY = 0.10702, 0.1044
PLAN_CX, PLAN_NOSE_ROW = 331.5, 493
SIDE_AXIS_COL, SIDE_NOSE_ROW = 700.5, 493
PLAN_BOX = (0, 0, 665, 492)
SIDE_BOX = (595, 0, 760, 493)


def setup():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 4
    sc.cycles.use_denoising = False
    sc.render.film_transparent = True
    world = bpy.data.worlds.new("W")
    sc.world = world
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.6, 0.6, 1)
    cam = bpy.data.cameras.new("Cam")
    cam.type = "ORTHO"
    co = bpy.data.objects.new("Cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    return sc, co


def render(sc, co, w_m, h_m, loc, rot, path):
    sc.render.resolution_x = int(w_m / M_PER_PX)
    sc.render.resolution_y = int(h_m / M_PER_PX)
    co.data.ortho_scale = max(w_m, h_m)
    co.location = loc
    co.rotation_euler = rot
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return Image.open(path).convert("RGBA")


def drawing_layer(box, size_px, origin_px, cx_draw, row0_draw, flip_y=False):
    """Scale a drawing crop to M_PER_PX and place it so (cx_draw, row0_draw) lands on origin_px."""
    im = Image.open(REF).convert("L").crop(box)
    sx, sy = DRAW_SX / M_PER_PX, DRAW_SY / M_PER_PX
    im = im.resize((int(im.width * sx), int(im.height * sy)), Image.LANCZOS)
    a = np.array(im) < 140
    if flip_y:
        a = a[::-1]
        row0 = (box[3] - row0_draw) * sy
    else:
        row0 = (row0_draw - box[1]) * sy
    col0 = (cx_draw - box[0]) * sx
    layer = np.zeros((size_px[1], size_px[0], 4), np.uint8)
    ox, oy = int(origin_px[0] - col0), int(origin_px[1] - row0)
    h, w = a.shape
    ys, xs = np.nonzero(a)
    ys, xs = ys + oy, xs + ox
    ok = (ys >= 0) & (ys < size_px[1]) & (xs >= 0) & (xs < size_px[0])
    layer[ys[ok], xs[ok]] = (220, 20, 20, 255)
    return Image.fromarray(layer)


def compose(model, layer, path):
    bg = Image.new("RGBA", model.size, (255, 255, 255, 255))
    bg.alpha_composite(model)
    bg.alpha_composite(layer)
    bg.convert("RGB").save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "renders"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    build_b36.build()
    sc, co = setup()

    # Top view: camera above, image up = nose (+Y). Drawing has nose down -> flip.
    W, H = 74.0, 53.0
    model = render(sc, co, W, H, (0, 0, 100), (0, 0, 0), os.path.join(args.out, "_top.png"))
    # world (0, NOSE_Y) -> pixel
    origin = (model.width / 2, model.height / 2 - P.NOSE_Y / M_PER_PX)
    layer = drawing_layer(PLAN_BOX, model.size, origin, PLAN_CX, PLAN_NOSE_ROW, flip_y=True)
    compose(model, layer, os.path.join(args.out, "overlay_top.png"))

    # Side view from left: camera at -X looking +X, image right = nose? Looking +X with Z up,
    # image right = -Y (tail). Drawing side view is rotated: rows = length (nose at bottom),
    # cols = height (up = smaller col). Rotate drawing crop to match.
    W, H = 54.0, 18.0
    model = render(sc, co, W, H, (-100, 0, 2.5), (math.radians(90), 0, math.radians(-90)),
                   os.path.join(args.out, "_side.png"))
    im = Image.open(REF).convert("L").crop(SIDE_BOX)
    # rotate so nose points left and up is up: transpose then flip
    rot = im.transpose(Image.Transpose.ROTATE_270)  # nose (bottom) -> left, small col (up) -> top
    sx, sy = DRAW_SY / M_PER_PX, DRAW_SX / M_PER_PX
    rot = rot.resize((int(rot.width * sx), int(rot.height * sy)), Image.LANCZOS)
    a = np.array(rot) < 140
    # after ROTATE_270: new_x = (box_h - 1 - row), new_y = col
    nose_x = (SIDE_BOX[3] - SIDE_BOX[1] - 1 - (SIDE_NOSE_ROW - SIDE_BOX[1])) * sx
    axis_y = (SIDE_AXIS_COL - SIDE_BOX[0]) * sy
    # model: nose at world y=NOSE_Y; camera image right = -Y? determine from render: nose on left.
    px_nose = model.width / 2 - P.NOSE_Y / M_PER_PX
    px_axis = model.height / 2 + 2.5 / M_PER_PX
    layer = np.zeros((model.height, model.width, 4), np.uint8)
    ys, xs = np.nonzero(a)
    ys = ys + int(px_axis - axis_y)
    xs = xs + int(px_nose - nose_x)
    ok = (ys >= 0) & (ys < model.height) & (xs >= 0) & (xs < model.width)
    layer[ys[ok], xs[ok]] = (220, 20, 20, 255)
    compose(model, Image.fromarray(layer), os.path.join(args.out, "overlay_side.png"))
    print("done")


if __name__ == "__main__":
    main()
