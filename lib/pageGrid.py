#!/usr/bin/env python3
"""Draws a labelled coordinate grid (every 100 px) over page pictures, in place,
so the agent can read pixel positions off the picture instead of guessing."""
import sys
from PIL import Image, ImageDraw, ImageFont

STEP = 100
for path in sys.argv[1:]:
    im = Image.open(path).convert('RGB')
    d = ImageDraw.Draw(im, 'RGBA')
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 11)
    except Exception:
        font = ImageFont.load_default()
    for x in range(0, im.width, STEP):
        d.line([(x, 0), (x, im.height)], fill=(255, 0, 160, 70), width=1)
    for y in range(0, im.height, STEP):
        d.line([(0, y), (im.width, y)], fill=(255, 0, 160, 70), width=1)
    for x in range(0, im.width, STEP):
        for y in range(0, im.height, STEP):
            d.text((x + 2, y + 1), f'{x},{y}', fill=(220, 0, 130, 255), font=font)
    im.save(path)
