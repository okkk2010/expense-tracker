"""Generate the app's geometric M mark without external assets."""
from pathlib import Path
import math
import struct
import zlib

OUT = Path(__file__).resolve().parents[1] / 'frontend' / 'public'

def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

def distance(x, y, ax, ay, bx, by):
    dx, dy = bx-ax, by-ay
    t = max(0, min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-(ax+t*dx), y-(ay+t*dy))

for size in (192, 512):
    raw = bytearray()
    for py in range(size):
        raw.append(0)
        for px in range(size):
            x, y = px*192/size, py*192/size
            rounded = abs(x-96) <= 52 or abs(y-96) <= 52 or math.hypot(max(44-x, 0, x-148), max(44-y, 0, y-148)) <= 44
            color = (33,76,59,255) if rounded else (0,0,0,0)
            mark = min(distance(x,y,*a,*b) for a,b in [((46,119),(46,73)),((46,73),(96,99)),((96,99),(146,73)),((146,73),(146,119))]) < 8.5
            if mark or math.hypot(x-96,y-132) < 10:
                color = (216,238,138,255)
            raw.extend(color)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size,size,8,6,0,0,0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    (OUT / f'icon-{size}.png').write_bytes(png)
print('App icons generated: 192, 512')
