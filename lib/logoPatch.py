#!/usr/bin/env python3
"""Builds the picture that covers another maker's logo in a catalog page.

usage: logoPatch.py page.png dpi x0 y0 x1 y1 logo_blue.png logo_white.png out.png logo_gray.png
Logo colour follows the background (her rule): dark -> white, light -> blue, mid grey / photo -> grey.
  page.png : the page rendered at `dpi`
  x0..y1   : the logo's rough box in PDF points (origin top-left)
The rough box is tightened to the logo itself (pixels that differ from the
dominant background inside it). The output is an opaque patch for that tight
box: the box's own background colour with the Tasaki logo centred on it,
keeping the logo's proportions. Prints JSON {"bg": "#rrggbb", "rect": [x0,y0,x1,y1]}
(points) -- the rect to place the patch in. Exit 3 when the box is blank paper.
"""
import json
import sys
from PIL import Image, ImageFilter, ImageStat

page_png, dpi, x0, y0, x1, y1, logo_light, logo_dark, out_png, logo_gray = sys.argv[1:11]
k = float(dpi) / 72.0
x0, y0, x1, y1 = (float(v) * k for v in (x0, y0, x1, y1))
page = Image.open(page_png).convert('RGB')
W, H = page.size
x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(W, int(x1)), min(H, int(y1))
if x1 - x0 < 4 or y1 - y0 < 4:
    sys.stderr.write('blank')
    sys.exit(3)

region = page.crop((x0, y0, x1, y1))
gray = region.convert('L')
if ImageStat.Stat(gray).stddev[0] < 8:
    sys.stderr.write('blank')
    sys.exit(3)

# Dominant background = median colour of the box; logo = what differs from it.
px = list(region.getdata())
bg = tuple(sorted(p[i] for p in px)[len(px) // 2] for i in range(3))
bg_luma = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
w, h = region.size
mask = Image.new('L', (w, h), 0)
mp = mask.load()
gp = gray.load()
for yy in range(h):
    for xx in range(w):
        if abs(gp[xx, yy] - bg_luma) > 40:
            mp[xx, yy] = 255
bbox = mask.filter(ImageFilter.MaxFilter(3)).getbbox()
if bbox and (bbox[2] - bbox[0]) >= 4 and (bbox[3] - bbox[1]) >= 4:
    padx, pady = int((bbox[2] - bbox[0]) * 0.12) + 1, int((bbox[3] - bbox[1]) * 0.12) + 1
    bx0, by0 = max(0, bbox[0] - padx), max(0, bbox[1] - pady)
    bx1, by1 = min(w, bbox[2] + padx), min(h, bbox[3] + pady)
else:
    bx0, by0, bx1, by1 = 0, 0, w, h

# Background for the patch: pixels inside the box that are NOT the logo.
inner = region.crop((bx0, by0, bx1, by1))
imask = mask.crop((bx0, by0, bx1, by1))
ip, im_ = list(inner.getdata()), list(imask.getdata())
bgpx = [p for p, m in zip(ip, im_) if m == 0] or ip
bg = tuple(sorted(p[i] for p in bgpx)[len(bgpx) // 2] for i in range(3))

pw, ph = max(2, bx1 - bx0), max(2, by1 - by0)
S = 4
patch = Image.new('RGB', (pw * S, ph * S), bg)
luma = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
which = 'white' if luma < 90 else ('blue' if luma > 175 else 'gray')
logo = Image.open({'white': logo_dark, 'blue': logo_light, 'gray': logo_gray}[which]).convert('RGBA')
scale = min(pw * S * 0.9 / logo.width, ph * S * 0.9 / logo.height)
logo = logo.resize((max(1, int(logo.width * scale)), max(1, int(logo.height * scale))), Image.LANCZOS)
patch.paste(logo, ((pw * S - logo.width) // 2, (ph * S - logo.height) // 2), logo)
patch.save(out_png)
rect = [round((x0 + bx0) / k, 1), round((y0 + by0) / k, 1), round((x0 + bx1) / k, 1), round((y0 + by1) / k, 1)]
print(json.dumps({'bg': '#%02x%02x%02x' % bg, 'rect': rect, 'logo': which}))
