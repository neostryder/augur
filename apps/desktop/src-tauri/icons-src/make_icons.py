"""Builds every app icon from app-icon-master.png.

Run from the repository root: python apps/desktop/src-tauri/icons-src/make_icons.py
Desktop and 'any' web icons get rounded corners with transparency; the Apple and maskable icons stay full-bleed (the maskable one is padded into the safe area) so the platform can crop them.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TAURI = os.path.join(HERE, '..', 'icons')
WEB = os.path.join(HERE, '..', '..', '..', 'ui', 'public')
master = Image.open(os.path.join(HERE, 'app-icon-master.png')).convert('RGB')
side = min(master.size)
square = master.crop(((master.width - side) // 2, (master.height - side) // 2, (master.width - side) // 2 + side, (master.height - side) // 2 + side))


def sized(px, src=None):
    return (src or square).resize((px, px), Image.LANCZOS)


def rounded(px, ratio=0.22):
    img = sized(px).convert('RGBA')
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, px * 4 - 1, px * 4 - 1), radius=int(px * 4 * ratio), fill=255)
    img.putalpha(mask.resize((px, px), Image.LANCZOS))
    return img


def maskable(px, scale=0.74):
    corners = [square.getpixel(q) for q in ((4, 4), (side - 5, 4), (4, side - 5), (side - 5, side - 5))]
    ground = Image.new('RGB', (px, px), tuple(sum(c[i] for c in corners) // 4 for i in range(3)))
    inner = int(px * scale)
    feather = Image.new('L', (inner, inner), 0)
    ImageDraw.Draw(feather).rectangle((inner // 10, inner // 10, inner - inner // 10, inner - inner // 10), fill=255)
    feather = feather.filter(ImageFilter.GaussianBlur(inner / 16))
    ground.paste(sized(inner), ((px - inner) // 2, (px - inner) // 2), feather)
    return ground


for name, px in {'32x32.png': 32, '64x64.png': 64, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512, 'StoreLogo.png': 50,
                 **{f'Square{n}x{n}Logo.png': n for n in (30, 44, 71, 89, 107, 142, 150, 284, 310)}}.items():
    rounded(px).save(os.path.join(TAURI, name), optimize=True)
rounded(256).save(os.path.join(TAURI, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (256, 256)])
rounded(1024).save(os.path.join(TAURI, 'icon.icns'))
rounded(192).save(os.path.join(WEB, 'icon-192.png'), optimize=True)
rounded(512).save(os.path.join(WEB, 'icon-512.png'), optimize=True)
maskable(512).save(os.path.join(WEB, 'icon-maskable-512.png'), optimize=True)
sized(180).save(os.path.join(WEB, 'apple-touch-icon.png'), optimize=True)
