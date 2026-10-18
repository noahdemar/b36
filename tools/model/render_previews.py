"""Render review images of the generated B-36 with Cycles (CPU).

Usage: uv run python render_previews.py [--out DIR] [--samples N] [--res W] [--views a,b]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_b36  # noqa: E402
import params as P  # noqa: E402

# name: (camera location, look-at target, focal length mm)
VIEWS = {
    "front34": ((-62, 70, 18), (0, 2, -0.5), 50),
    "rear34": ((58, -66, 14), (0, -2, 0), 50),
    "side": ((-120, 0, 3.0), (0, 0, 1.5), 50),
    "top": ((0, 0, 140), (0, 0, 0), 45),
    "front": ((0, 110, 3.0), (0, 0, 1.5), 50),
    "nose": ((-14, 36, 4), (0, 18, 0.5), 50),
    "engines": ((-34, -26, -2), (-14, -6, -0.5), 45),
    "tail": ((-22, -40, 6), (0, -21, 4), 50),
    "photo_port": ((-62, 26, 9), (0, -1, 1.5), 50),     # cf. reference ref03
    "photo_stbd": ((95, 4, 6), (0, -1, 2.0), 50),       # cf. reference ref01
    "photo_museum": ((-30, 44, 14), (0, 8, 0), 35),     # cf. reference ref02
}


def look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def setup(samples, res):
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
    pass
    nt = world.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    try:
        sky.sky_type = "NISHITA"
    except TypeError:
        pass
    sky.sun_elevation = math.radians(35)
    sky.sun_rotation = math.radians(140)
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.12

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 2.2
    sun.angle = math.radians(1.0)
    so = bpy.data.objects.new("Sun", sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(50), 0, math.radians(-140))

    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, P.GROUND_Z))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("Ground")
    gm.use_nodes = True
    b = gm.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.09, 0.09, 0.085, 1)
    b.inputs["Roughness"].default_value = 0.9
    ground.data.materials.append(gm)

    cam = bpy.data.cameras.new("Cam")
    cam.clip_end = 2000
    co = bpy.data.objects.new("Cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    return co


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "renders"))
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--res", type=int, default=1280)
    ap.add_argument("--views", default=",".join(VIEWS))
    args = ap.parse_args()
    build_b36.build()
    co = setup(args.samples, args.res)
    os.makedirs(args.out, exist_ok=True)
    for name in args.views.split(","):
        loc, tgt, lens = VIEWS[name]
        co.location = loc
        co.data.lens = lens
        look_at(co, tgt)
        if name == "top":
            co.data.type = "ORTHO"
            co.data.ortho_scale = 92
        elif name == "side":
            co.data.type = "ORTHO"
            co.data.ortho_scale = 56
        elif name == "front":
            co.data.type = "ORTHO"
            co.data.ortho_scale = 74
        else:
            co.data.type = "PERSP"
        bpy.context.scene.render.filepath = os.path.join(os.path.abspath(args.out), f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", name)


if __name__ == "__main__":
    main()
