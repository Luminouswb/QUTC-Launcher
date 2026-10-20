"""生成 QUTC Launcher 的品牌图标（PNG / ICO）。仅使用 Pillow。"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((8, 8, S - 8, S - 8), radius=64, fill=(11, 17, 22, 255), outline=(34, 48, 64, 255), width=4)
d.arc((62, 52, 198, 188), start=40, end=220, fill=(91, 240, 200, 255), width=22)
d.arc((62, 52, 198, 188), start=220, end=400, fill=(74, 125, 255, 255), width=22)
d.line((140, 135, 198, 193), fill=(120, 180, 255, 255), width=24)
d.rounded_rectangle((112, 100, 144, 132), radius=8, fill=(91, 240, 200, 230))

img.save(ROOT / "src" / "renderer" / "logo.png")
(ROOT / "build").mkdir(parents=True, exist_ok=True)
img.save(ROOT / "build" / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("图标已生成")
