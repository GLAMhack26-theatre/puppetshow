"""Blend the orthographic check renders over the reference photos (proportion check).
    python3 tools/overlay_check.py [/tmp]
"""
import os
import sys
from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
PAIRS = {"front": "assets/reference/tpose_front.png", "side": "assets/reference/views_front_side_top.png",
         "front_hang": "assets/reference/views_front_side_top.png"}
for view, ref in PAIRS.items():
    photo = Image.open(os.path.join(ROOT, ref)).convert("RGBA")
    rend = Image.open(os.path.join(D, f"marionette_check_{view}.png")).convert("RGBA").resize(photo.size)
    # model silhouette outline in green over the photo, plus a 50% ghost
    alpha = rend.split()[3]
    edge = ImageChops.subtract(alpha, alpha.filter(__import__("PIL.ImageFilter").ImageFilter.MinFilter(3)))
    ghost = Image.blend(photo, Image.alpha_composite(photo, rend), 0.5)
    green = Image.new("RGBA", photo.size, (0, 255, 0, 255))
    ghost.paste(green, (0, 0), edge.point(lambda v: 255 if v > 60 else 0))
    out = os.path.join(D, f"marionette_overlay_{view}.png")
    ghost.convert("RGB").save(out)
    print(out)
