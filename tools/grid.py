"""Overlay a measurement grid on an image crop: grid.py SRC OUT x0 y0 x1 y1 [scale] [step]"""
import sys
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
src, out = sys.argv[1], sys.argv[2]
x0, y0, x1, y1 = map(int, sys.argv[3:7])
sc = float(sys.argv[7]) if len(sys.argv) > 7 else 2.0
step = int(sys.argv[8]) if len(sys.argv) > 8 else 10
im = Image.open(src).convert('RGB').crop((x0, y0, x1, y1))
im = im.resize((int(im.width * sc), int(im.height * sc)))
d = ImageDraw.Draw(im)
for gx in range((x0 // step) * step, x1 + 1, step):
    xx = (gx - x0) * sc
    major = gx % (step * 5) == 0
    d.line([(xx, 0), (xx, im.height)], fill=(0, 0, 255) if major else (170, 170, 255))
    if major: d.text((xx + 2, 2), str(gx), fill=(0, 0, 255))
for gy in range((y0 // step) * step, y1 + 1, step):
    yy = (gy - y0) * sc
    major = gy % (step * 5) == 0
    d.line([(0, yy), (im.width, yy)], fill=(255, 0, 0) if major else (255, 170, 170))
    if major: d.text((2, yy + 2), str(gy), fill=(255, 0, 0))
im.save(out)
