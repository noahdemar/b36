"""Render cockpit views by importing the exported GLBs (tests the actual exported files).

Usage: uv run python render_cockpit.py [--views ac_forward,...] [--samples N] [--res W]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.normpath(os.path.join(HERE, "../../web/public/models"))


def W(x, d, z):
    return Vector((x, P.NOSE_Y - d, z))


# name: (eye, target, lens mm)
VIEWS = {
    "ac_forward": (W(-0.62, 4.52, 1.52), W(-0.55, 2.0, 1.15), 22),
    "ac_panel": (W(-0.62, 4.52, 1.52), W(-0.35, 3.6, 1.08), 26),
    "ac_left": (W(-0.62, 4.52, 1.52), W(-2.5, 4.0, 1.2), 20),
    "ac_overhead": (W(-0.62, 4.52, 1.52), W(0.0, 4.1, 2.1), 20),
    "deck_rear": (W(0.3, 3.9, 1.7), W(0.0, 9.0, 0.9), 18),
    "wide": (W(-1.2, 6.3, 1.85), W(0.0, 3.6, 1.0), 16),
    "tunnel": (W(-0.60, 13.0, 1.25), W(-0.60, 30.0, 1.25), 30),
    "aft_comp": (W(-0.3, 35.3, 0.95), W(0.2, 39.4, 0.0), 18),
    "aft_gunner_ua": (W(-0.95, 36.8, 0.95), W(-6.0, 38.0, 1.6), 30),
    "fwd_gunner": (W(1.25, 11.3, 1.15), W(6.0, 13.0, 2.0), 30),
}


def setup(samples, res):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for f in ("b36.gltf", "b36_interior.glb"):
        bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, f))
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x = res
    sc.render.resolution_y = int(res * 9 / 16)
    sc.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("World")
    sc.world = world
    nt = world.node_tree
    sky = nt.nodes.new("ShaderNodeTexSky")
    nt.links.new(sky.outputs["Color"], nt.nodes["Background"].inputs["Color"])
    nt.nodes["Background"].inputs["Strength"].default_value = 0.25
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.0
    so = bpy.data.objects.new("Sun", sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(40), 0, math.radians(200))
    # dim cabin fill light so the deck is readable
    pl = bpy.data.lights.new("Fill", "POINT")
    pl.energy = 60
    pl.shadow_soft_size = 0.5
    po = bpy.data.objects.new("Fill", pl)
    sc.collection.objects.link(po)
    po.location = W(0, 5.2, 2.0)
    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, P.GROUND_Z))
    cam = bpy.data.cameras.new("Cam")
    cam.clip_start = 0.02
    co = bpy.data.objects.new("Cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    return co


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "renders"))
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--res", type=int, default=1280)
    ap.add_argument("--views", default=",".join(VIEWS))
    args = ap.parse_args()
    co = setup(args.samples, args.res)
    os.makedirs(args.out, exist_ok=True)
    for name in args.views.split(","):
        eye, tgt, lens = VIEWS[name]
        co.location = eye
        co.rotation_euler = (tgt - eye).to_track_quat("-Z", "Y").to_euler()
        co.data.lens = lens
        bpy.context.scene.render.filepath = os.path.join(os.path.abspath(args.out), f"cockpit_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", name)


if __name__ == "__main__":
    main()
