"""Render one interior part on its own for quick iteration.

Usage: uv run python render_part.py seat [--out file.png] [--samples N]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_b36 as B  # noqa: E402
import build_interior as BI  # noqa: E402

PARTS = {
    "seat": (lambda: BI.build_seat("Seat_T", "test", 0.0, 6.0, 0.0), Vector((1.1, 1.7, 0.6)), Vector((0, 0, 0.1))),
    "pedestal": (lambda: BI.build_pedestal(UV), Vector((0.9, -1.0, 1.5)), Vector((0, 0, 0.6))),
}
UV = None


def main():
    global UV
    ap = argparse.ArgumentParser()
    ap.add_argument("part")
    ap.add_argument("--out", default=None)
    ap.add_argument("--samples", type=int, default=24)
    args = ap.parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    UV = BI.init_materials()
    B.ROOT = None
    fn, cam_off, tgt_off = PARTS[args.part]
    fn()
    BI.apply_box_uvs()
    obs = [o for o in bpy.data.objects if o.type == "MESH"]
    lo = Vector((min(o.matrix_world @ Vector(c) for o in obs for c in o.bound_box)[i] for i in range(3))) if False else None
    center = sum((o.matrix_world @ (sum((Vector(c) for c in o.bound_box), Vector()) / 8) for o in obs), Vector()) / len(obs)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = args.samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 900, 900
    sc.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("W")
    sc.world = world
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(55), 0, math.radians(150))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = center + cam_off
    cam.rotation_euler = (center + tgt_off - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 40
    sc.render.filepath = os.path.abspath(args.out or f"renders/part_{args.part}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", sc.render.filepath)


if __name__ == "__main__":
    main()
