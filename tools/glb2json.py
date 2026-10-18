"""Convert a .glb, or a .gltf with one external .bin, into glTF JSON with the buffer embedded as a
base64 data URI (for hosts that cannot serve .glb/.bin). External image URIs are kept as-is."""
import base64
import json
import os
import struct
import sys

src, dst = sys.argv[1], sys.argv[2]
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
js["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(binc).decode()
open(dst, "w").write(json.dumps(js, separators=(",", ":")))
print(dst, os.path.getsize(dst) // 1024, "KiB")
