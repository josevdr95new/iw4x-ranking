"""Generador programático del logo IW4x Ranking (sin generadores externos).

Uso:
    py apps\\launcher\\assets\\make_logo.py

Exporta 2 PNGs junto a este script:
  - logo-icon.png   512×512   (cuadrado: icono de ventana / app)
  - logo-banner.png 1536×512  (3:1: cabecera de README / web)

Estética HUD MW2 (ui/theme.py):
  - fondo bg #101312, texto #E6EAE6, dim #9BA69E, accent ámbar #E8930C
  - cero gradientes, cero glow, esquinas rectas, contraste AA
  - tipografía Consolas bold (la mono de la UI), mayúsculas + tracking
    simulado (el launcher hace lo mismo con U+2009 en Tk).
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Tokens EXACTOS de ui/theme.py (única fuente de color del launcher).
BG = "#101312"        # fondo de ventana
TEXT = "#E6EAE6"      # texto principal (off-white)
DIM = "#9BA69E"       # texto secundario
ACCENT = "#E8930C"    # ámbar militar
HAIRLINE = "#6B4A12"  # hairline ámbar (accent_border)

FONT_CANDIDATES = [
    "consolab.ttf",                # Consolas bold (familia mono de la UI)
    "C:\\Windows\\Fonts\\consolab.ttf",
    "consola.ttf",                 # fallback Consolas regular
    "segoeuib.ttf",                # último recurso de sistema
]

HERE = Path(__file__).resolve().parent


def load_font(size: int):
    for name in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def text_width(draw: ImageDraw.ImageDraw, s: str, font) -> int:
    return int(draw.textlength(s, font=font))


# --- Helpers HUD -------------------------------------------------------------

def draw_corner_brackets(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int,
                         arm: int, width: int, color: str) -> None:
    """4 brackets de esquina en forma de L (rectos, sin redondeo)."""
    # esquina sup-izq
    draw.rectangle([x0, y0, x0 + arm, y0 + width], fill=color)
    draw.rectangle([x0, y0, x0 + width, y0 + arm], fill=color)
    # sup-der
    draw.rectangle([x1 - arm, y0, x1, y0 + width], fill=color)
    draw.rectangle([x1 - width, y0, x1, y0 + arm], fill=color)
    # inf-izq
    draw.rectangle([x0, y1 - width, x0 + arm, y1], fill=color)
    draw.rectangle([x0, y1 - arm, x0 + width, y1], fill=color)
    # inf-der
    draw.rectangle([x1 - arm, y1 - width, x1, y1], fill=color)
    draw.rectangle([x1 - width, y1 - arm, x1, y1], fill=color)


def draw_crosshair(draw: ImageDraw.ImageDraw, cx: int, cy: int, radius: int,
                   tick: int, width: int, color: str) -> None:
    """Crosshair minimalista: anillo + 4 ticks cardinales (sin puntos internos)."""
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
                 outline=color, width=width)
    gap = 6  # respiro entre el anillo y el tick
    draw.rectangle([cx - width // 2, cy - radius - gap - tick,
                    cx + width // 2, cy - radius - gap], fill=color)
    draw.rectangle([cx - width // 2, cy + radius + gap,
                    cx + width // 2, cy + radius + gap + tick], fill=color)
    draw.rectangle([cx - radius - gap - tick, cy - width // 2,
                    cx - radius - gap, cy + width // 2], fill=color)
    draw.rectangle([cx + radius + gap, cy - width // 2,
                    cx + radius + gap + tick, cy + width // 2], fill=color)


def draw_tracked_centered(draw: ImageDraw.ImageDraw, cx: int, y: int, s: str,
                          font, fill: str, tracking: int = 0) -> int:
    """Texto centrado con tracking simulado. Devuelve el ancho total."""
    widths = [text_width(draw, ch, font) for ch in s]
    total = sum(widths) + tracking * (len(s) - 1)
    x = cx - total // 2
    for ch, w in zip(s, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += w + tracking
    return total


# --- Icono 512×512 -----------------------------------------------------------

def make_icon() -> Path:
    W = H = 512
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 1) Brackets de esquina ámbar 2px enmarcando el lienzo.
    draw_corner_brackets(d, 28, 28, W - 28, H - 28, arm=72, width=2, color=ACCENT)

    # 2) Crosshair minimalista ámbar centrado-arriba (ring + ticks).
    draw_crosshair(d, W // 2, 104, radius=30, tick=14, width=2, color=ACCENT)

    # 3) "IW4X" grande, bold, off-white, centrado.
    f_big = load_font(132)
    bbox = d.textbbox((0, 0), "IW4X", font=f_big)
    big_h = bbox[3] - bbox[1]
    d.text((W // 2 - text_width(d, "IW4X", f_big) // 2, 172 - 8), "IW4X",
           font=f_big, fill=TEXT)

    # 4) "RANKING" debajo, ámbar, tracking amplio.
    f_rank = load_font(44)
    draw_tracked_centered(d, W // 2, 172 + big_h + 34, "RANKING", f_rank,
                          ACCENT, tracking=22)

    # 5) Caption del autor: "JOSEVDR95" pequeño mono dim, abajo.
    f_cap = load_font(24)
    draw_tracked_centered(d, W // 2, H - 78, "JOSEVDR95", f_cap, DIM, tracking=8)

    out = HERE / "logo-icon.png"
    img.save(out, "PNG")
    return out


# --- Banner 1536×512 ---------------------------------------------------------

def make_banner() -> Path:
    W, H = 1536, 512
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 1) Motivo HUD a la izquierda: brackets + crosshair centrado en su marco.
    draw_corner_brackets(d, 64, 116, 336, 396, arm=56, width=2, color=ACCENT)
    draw_crosshair(d, 200, 256, radius=52, tick=22, width=2, color=ACCENT)

    # 2) "IW4X RANKING" a la derecha, grande, con hairline ámbar debajo.
    f_big = load_font(96)
    text = "IW4X RANKING"
    tracking = 6
    widths = [text_width(d, ch, f_big) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = 440
    y = 176
    for ch, w in zip(text, widths):
        d.text((x, y), ch, font=f_big, fill=TEXT if ch != " " else ACCENT)
        x += w + tracking

    # Hairline ámbar bajo el texto (span del texto).
    line_y = y + 120
    d.rectangle([440, line_y, 440 + total, line_y + 2], fill=HAIRLINE)

    # 3) "by JOSEVDR95" en dim mono (con tracking leve).
    f_by = load_font(26)
    d.text((442, line_y + 34), "by JOSEVDR95", font=f_by, fill=DIM)

    out = HERE / "logo-banner.png"
    img.save(out, "PNG")
    return out


# --- ICO multi-resolución (icono del exe / titlebar / taskbar) ---------------

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def make_ico() -> Path:
    """Exporta assets/logo-icon.ico multi-resolución desde un máster de 256px.

    PIL a veces deriva mal los tamaños al guardar un solo frame con ``sizes=``:
    generamos CADA resolución explícitamente con resize LANCZOS desde el
    máster 256px y las compone con append_images.
    """
    # Máster: el icono 512 redesignado a 256 (LANCZOS) en lugar de re-render,
    # para que el .ico y el .png sean exactamente el mismo dibujo.
    master = Image.open(HERE / "logo-icon.png").resize((256, 256), Image.LANCZOS)
    frames = [master.resize(size, Image.LANCZOS) for size in ICO_SIZES]
    out = HERE / "logo-icon.ico"
    frames[-1].save(out, format="ICO", append_images=frames[:-1], sizes=ICO_SIZES)
    return out


def verify_ico(path: Path) -> list:
    """Lee el header del ICO y devuelve las resoluciones que realmente contiene."""
    data = path.read_bytes()
    if data[0:4] != b"\x00\x00\x01\x00":
        raise ValueError(f"{path} no es un ICO válido")
    n = int.from_bytes(data[4:6], "little")
    sizes = []
    for i in range(n):
        off = 6 + i * 16
        w = data[off] or 256
        h = data[off + 1] or 256
        sizes.append((w, h))
    return sizes


def main() -> None:
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    icon = make_icon()
    banner = make_banner()
    for p in (icon, banner):
        img = Image.open(p)
        print(f"[OK] {p.name}: {img.size[0]}x{img.size[1]} ({os.path.getsize(p)} bytes)")
    ico = make_ico()
    sizes = verify_ico(ico)
    print(f"[OK] {ico.name}: {os.path.getsize(ico)} bytes, "
          f"{len(sizes)} resoluciones: {sizes}")


if __name__ == "__main__":
    main()
