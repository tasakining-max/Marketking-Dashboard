#!/usr/bin/env python3
"""Draws red circles (ellipses) around edited spots on a page picture.
usage: circleMarks.py page.png dpi out.png '[[x0,y0,x1,y1],...]'   (rects in PDF points, top-left origin)
Nearby rects are merged so one line edited in pieces gets one circle."""
import json
import sys
from PIL import Image, ImageDraw

page, dpi, out, rects = sys.argv[1], float(sys.argv[2]), sys.argv[3], json.loads(sys.argv[4])
k = dpi / 72.0
im = Image.open(page).convert('RGB')
boxes = [[x0 * k, y0 * k, x1 * k, y1 * k] for x0, y0, x1, y1 in rects]
merged = []
for b in sorted(boxes):
    for m in merged:
        if b[0] <= m[2] + 25 and b[2] >= m[0] - 25 and b[1] <= m[3] + 25 and b[3] >= m[1] - 25:
            m[0], m[1], m[2], m[3] = min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3])
            break
    else:
        merged.append(b[:])
d = ImageDraw.Draw(im)
w = max(3, int(dpi / 30))
for x0, y0, x1, y1 in merged:
    px, py = max(14, (x1 - x0) * 0.18), max(10, (y1 - y0) * 0.6)
    d.ellipse([x0 - px, y0 - py, x1 + px, y1 + py], outline=(230, 0, 0), width=w)
im.save(out)
