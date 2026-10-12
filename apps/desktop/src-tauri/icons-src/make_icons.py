"""Builds every app icon from app-icon-master.png.

Run from the repository root: python apps/desktop/src-tauri/icons-src/make_icons.py
Desktop and 'any' web icons get rounded corners with transparency; the Apple and maskable icons stay full-bleed (the maskable one is padded into the safe area) so the platform can crop them.
The web app also gets a favicon and the root touch-icon paths a phone requests by name. The page carries the favicon and the Apple touch icon inline, since a phone fetches linked home-screen icons in a separate process.
"""
from PIL import Image, ImageDraw, ImageFilter
import base64, io, os, re

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
sized(180).save(os.path.join(WEB, 'apple-touch-icon-precomposed.png'), optimize=True)
rounded(32).save(os.path.join(WEB, 'favicon-32.png'), optimize=True)
rounded(48).save(os.path.join(WEB, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])


def data_uri(img, fmt, mime, **opts):
    buf = io.BytesIO()
    img.save(buf, fmt, **opts)
    return f'data:{mime};base64,' + base64.b64encode(buf.getvalue()).decode()


index_path = os.path.join(WEB, '..', 'index.html')
index = open(index_path, encoding='utf-8', newline='').read()
marker = re.compile(r'<!-- inline-icons -->[\s\S]*?<!-- /inline-icons -->')
if not marker.search(index):
    raise SystemExit('index.html has no inline-icons markers')
eol = '\r\n' if '\r\n' in index else '\n'
links = ['<!-- inline-icons -->',
         f'  <link rel="icon" type="image/png" sizes="32x32" href="{data_uri(rounded(32), "PNG", "image/png", optimize=True)}">',
         f'  <link rel="apple-touch-icon" href="{data_uri(sized(180), "JPEG", "image/jpeg", quality=90)}">',
         '  <!-- /inline-icons -->']
open(index_path, 'w', encoding='utf-8', newline='').write(marker.sub(lambda m: eol.join(links), index, count=1))
