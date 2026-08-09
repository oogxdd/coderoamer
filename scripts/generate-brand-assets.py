#!/usr/bin/env python3
"""Generate CodeRoamer platform assets from the production icon master.

Requires Pillow (`python3 -m pip install Pillow`).
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "assets" / "branding" / "app-icon-master.png"
IMAGES = ROOT / "assets" / "images"
PUBLIC = ROOT / "public"
ICON_COMPOSER_ASSETS = ROOT / "assets" / "expo.icon" / "Assets"


def resized(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def extract_white_mark(image: Image.Image) -> Image.Image:
    """Extract the white glyph while preserving its antialiased edge."""
    rgb = image.convert("RGB")
    alpha = Image.new("L", rgb.size)
    source_pixels = rgb.load()
    alpha_pixels = alpha.load()

    # The blue background has a very low red channel while the mark is neutral
    # white. Mapping the minimum channel keeps the soft edge without retaining
    # blue background pixels in the transparent layer.
    transparent_at = 28
    opaque_at = 232
    scale = 255 / (opaque_at - transparent_at)
    for y in range(rgb.height):
        for x in range(rgb.width):
            whiteness = min(source_pixels[x, y])
            opacity = round((whiteness - transparent_at) * scale)
            alpha_pixels[x, y] = max(0, min(255, opacity))

    mark = Image.new("RGBA", rgb.size, (255, 255, 255, 0))
    mark.putalpha(alpha)
    return mark


def save_png(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resized(image, size).save(path, format="PNG", optimize=True)


def main() -> None:
    master = Image.open(MASTER).convert("RGB")
    if master.width != master.height:
        raise ValueError(f"Master icon must be square, got {master.size}")

    mark = extract_white_mark(master)

    # Expo / Apple source assets.
    save_png(master, IMAGES / "icon.png", 1024)
    save_png(mark, IMAGES / "brand-mark.png", 1024)
    save_png(mark, IMAGES / "splash-icon.png", 512)
    save_png(mark, ICON_COMPOSER_ASSETS / "coderoamer-mark.png", 1024)

    # Browser and installable desktop-web assets.
    save_png(master, IMAGES / "favicon.png", 48)
    save_png(master, PUBLIC / "favicon-16x16.png", 16)
    save_png(master, PUBLIC / "favicon-32x32.png", 32)
    save_png(master, PUBLIC / "favicon-48x48.png", 48)
    save_png(master, PUBLIC / "apple-touch-icon.png", 180)
    save_png(master, PUBLIC / "web-app-icon-192.png", 192)
    save_png(master, PUBLIC / "web-app-icon-512.png", 512)
    save_png(master, PUBLIC / "web-app-icon-maskable-512.png", 512)
    save_png(master, PUBLIC / "mstile-150x150.png", 150)

    resized(master, 256).save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
