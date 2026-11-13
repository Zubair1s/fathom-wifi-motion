"""Draws Fathom's app icon (cobalt square, white wave) as icon.ico."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(35, 55, 255, 255))

pts = []
x0, x1 = S * 0.18, S * 0.82
for i in range(400):
    u = i / 399
    x = x0 + (x1 - x0) * u
    y = S / 2 - math.sin(u * math.pi * 3) * S * 0.14 * math.sin(math.pi * u) ** 0.6
    pts.append((x, y))
w = int(S * 0.075)
d.line(pts, fill="white", width=w, joint="curve")
for p in (pts[0], pts[-1]):
    d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill="white")

out = Path(__file__).with_name("icon.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
