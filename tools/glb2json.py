import base64, json, struct, sys
src, dst = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
magic, version, length = struct.unpack_from("<III", data, 0)
assert magic == 0x46546C67, "not a GLB"
off, js, binc = 12, None, None
while off < length:
    clen, ctype = struct.unpack_from("<II", data, off)
    chunk = data[off + 8: off + 8 + clen]
    if ctype == 0x4E4F534A: js = json.loads(chunk)
    elif ctype == 0x004E4942: binc = chunk
    off += 8 + clen
js["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(binc).decode()
open(dst, "w").write(json.dumps(js, separators=(",", ":")))
print(dst, len(open(dst).read()) // 1024, "KiB")
