"""Measure a reference shape so the AI doesn't have to guess coordinates.

Usage: python3 traceShape.py <image>  ->  JSON on stdout:
  {width, height, d, gradient: {angle, stops}, shadow}
`d` is a closed cubic-Bézier SVG path in the shape's own box (0,0 = top-left
of the shape, width x height in pixels), ready to scale into a document.
The shape is the largest coloured (saturated or opaque) region; grey shadow
and white/transparent background are left out.
"""
import json
import sys

import cv2
import numpy as np


def shape_mask(img):
    if img.shape[2] == 4:
        alpha = img[:, :, 3]
        bgr = img[:, :, :3]
    else:
        alpha = np.full(img.shape[:2], 255, np.uint8)
        bgr = img
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    # Coloured and opaque: drops white paper, transparent areas and grey shadow.
    mask = ((hsv[:, :, 1] > 60) & (alpha > 200)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return mask, bgr, alpha


def to_bezier(points, w, h):
    # Catmull-Rom through the simplified outline -> smooth closed cubic path.
    n = len(points)
    p = points.astype(float)
    parts = [f"M {p[0][0]:.1f} {p[0][1]:.1f}"]
    for i in range(n):
        p0, p1, p2, p3 = p[i - 1], p[i], p[(i + 1) % n], p[(i + 2) % n]
        # Clamp handles to the box so sharp corners don't overshoot.
        c1 = np.clip(p1 + (p2 - p0) / 6, [0, 0], [w, h])
        c2 = np.clip(p2 - (p3 - p1) / 6, [0, 0], [w, h])
        parts.append(f"C {c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}")
    return " ".join(parts) + " Z"


def main(path):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit("cannot read image")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    mask, bgr, alpha = shape_mask(img)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise SystemExit("no coloured shape found")
    contour = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(contour)
    # Enough points to keep the corners, few enough to stay smooth.
    approx = cv2.approxPolyDP(contour, 0.003 * cv2.arcLength(contour, True), True)[:, 0, :]
    if len(approx) < 6:
        approx = contour[:: max(1, len(contour) // 24), 0, :]
    local = approx - np.array([x, y])

    # Gradient: average colour of each vertical slice inside the shape.
    region = np.zeros(mask.shape, np.uint8)
    cv2.drawContours(region, [contour], -1, 255, -1)
    stops = []
    for t in (0, 0.12, 0.25, 0.4, 0.6, 0.8, 1):
        cx = int(x + t * (w - 1))
        cols = slice(max(x, cx - 3), min(x + w, cx + 4))
        pick = region[y:y + h, cols] > 0
        if pick.sum() < 5:
            continue
        b, g, r = (bgr[y:y + h, cols][pick]).mean(axis=0)
        stops.append({"offset": round(t, 2), "color": f"#{int(r):02X}{int(g):02X}{int(b):02X}"})

    # Shadow: darker, desaturated pixels just outside the shape's lower edge.
    ring = cv2.dilate(region, np.ones((25, 25), np.uint8)) & ~region
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    outside = gray[(ring > 0) & (alpha > 0)]
    shadow = bool(outside.size and np.percentile(outside, 20) < 225)

    print(json.dumps({
        "width": int(w), "height": int(h), "d": to_bezier(local, w, h),
        "gradient": {"kind": "linear", "angle": 0, "stops": stops},
        "shadow": shadow,
    }))


if __name__ == "__main__":
    main(sys.argv[1])
