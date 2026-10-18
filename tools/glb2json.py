"""Convert a .glb, or a .gltf with one external .bin, into glTF JSON with the buffer embedded as a
base64 data URI (for hosts that cannot serve .glb/.bin). External image URIs are kept as-is.
With --images DIR, embedded images are written as files in DIR (next to the JSON) and the buffer is
repacked without them, keeping the JSON under a host's per-file size limit."""
import base64
import json
import os
import struct
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
src, dst = args[0], args[1]
img_dir = sys.argv[sys.argv.index("--images") + 1] if "--images" in sys.argv else None
if img_dir:
    args.remove(img_dir)
if src.endswith(".glb"):
    data = open(src, "rb").read()
    magic, _version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    off, js, binc = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
else:
    js = json.load(open(src))
    assert len(js["buffers"]) == 1, "expected a single buffer"
    binc = open(os.path.join(os.path.dirname(src), js["buffers"][0]["uri"]), "rb").read()
if img_dir:
    os.makedirs(os.path.join(os.path.dirname(dst), img_dir), exist_ok=True)
    img_views = set()
    for i, im in enumerate(js.get("images", [])):
        if "bufferView" not in im:
            continue
        bv = js["bufferViews"][im["bufferView"]]
        raw = binc[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        ext = ".jpg" if im.get("mimeType") == "image/jpeg" else ".png"
        name = f"{i:02d}_{im.get('name', 'image')}{ext}"
        open(os.path.join(os.path.dirname(dst), img_dir, name), "wb").write(raw)
        img_views.add(im.pop("bufferView"))
        im.pop("mimeType", None)
        im["uri"] = f"{img_dir}/{name}"
    # repack the remaining views (4-byte aligned); the image views shrink to a 4-byte stub
    out = bytearray()
    for k, bv in enumerate(js["bufferViews"]):
        if k in img_views:
            raw = b"\0\0\0\0"
            bv.pop("byteStride", None)
        else:
            raw = binc[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
        while len(out) % 4:
            out.append(0)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(raw)
        out += raw
    binc = bytes(out)
    js["buffers"][0]["byteLength"] = len(binc)
js["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(binc).decode()
open(dst, "w").write(json.dumps(js, separators=(",", ":")))
print(dst, os.path.getsize(dst) // 1024, "KiB")
