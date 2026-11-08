"""Generador programático de medallas del sistema ELO (sin generadores externos).

Uso:
    py apps\\launcher\\assets\\make_medals.py

Exporta en assets\\medals\\:
  - medal-1-recluta.png ... medal-8-leyenda.png  8× 512×512 RGBA
    (fondo alpha 0: van sobre tarjetas oscuras, NO sobre carbón)
  - star-full.png / star-empty.png  2× 64×64 RGBA (alpha 0 en esquinas):
    estrellas de progreso I-V que pinta la UI junto al detalle
  - elite-top12.png  badge 256×96 RGBA (fondo carbón OPACO + borde ámbar
    2px + texto mono "TOP 12" ámbar) del club élite
  - medals-sheet.png  preview de los 8 en fila sobre fondo carbón
    (1 archivo para mostrar al dueño, no es asset de UI)

Sistema de 8 tiers (ELO 1000-2500), estilo Dota 2 pero militar MW2:
  RECLUTA/SOLDADO → 1 chevron, CABO/SARGENTO → 2, TENIENTE/CAPITÁN → 3,
  COMANDANTE/LEYENDA → 4 + estrella de 5 puntas arriba del escudo (tier 8).
  Las estrellas I-V de progreso NO van en la imagen: las renderiza la UI.

Estética HUD MW2 (ui/theme.py), igual que make_logo.py:
  - cero gradientes, cero glow, esquinas rectas, contraste AA
  - metal del tier como color principal, contorno gris claro #E6EAE6,
    interior oscuro #101312 semiopaco (alpha 200) para legibilidad
  - brackets de esquina en tono del metal para unificar con el logo
  - SIN texto dentro del emblema (el nombre lo pone la UI)
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Tokens EXACTOS de ui/theme.py (única fuente de color del launcher).
BG = "#101312"          # fondo de ventana / carbón del sheet
TEXT = "#E6EAE6"        # texto principal (off-white) → contorno del escudo
DIM = "#9BA69E"         # texto secundario → labels del sheet
ACCENT = "#E8930C"      # ámbar militar → estrella del tier LEYENDA
INTERIOR = (16, 19, 18, 200)  # #101312 semiopaco (alpha ~200)

FONT_CANDIDATES = [
    "consolab.ttf",                # Consolas bold (familia mono de la UI)
    "C:\\Windows\\Fonts\\consolab.ttf",
    "consola.ttf",                 # fallback Consolas regular
    "segoeuib.ttf",                # último recurso de sistema
]

HERE = Path(__file__).resolve().parent
OUT = HERE / "medals"

# (num, slug de archivo, nombre, metal hex, rango ELO)
TIERS = [
    (1, "recluta",    "RECLUTA",    "#3B443E", "1000-1149"),
    (2, "soldado",    "SOLDADO",    "#B0722F", "1150-1299"),
    (3, "cabo",       "CABO",       "#A9B2AC", "1300-1449"),
    (4, "sargento",   "SARGENTO",   "#E8930C", "1450-1599"),
    (5, "teniente",   "TENIENTE",   "#F5A430", "1600-1749"),
    (6, "capitan",    "CAPITÁN",    "#8FD429", "1750-1899"),
    (7, "comandante", "COMANDANTE", "#D2544A", "1900-2049"),
    (8, "leyenda",    "LEYENDA",    "#FFE9C4", "2050-2500"),
]

# Evolución por tier: nº de chevrons apilados y medio-ancho del chevron.
CHEVRONS_BY_TIER = {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 4}
CHEVRON_HW = {1: 84, 2: 90, 3: 96, 4: 100}  # medio-ancho por nº de chevrons
BAND = 26   # grosor vertical de la banda del chevron
RISE = 44   # altura del pico del chevron
GAP = 12    # aire entre chevrons apilados


def load_font(size: int):
    for name in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def hex_rgba(h: str, alpha: int = 255) -> tuple:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


# --- Helpers HUD (mismos patrones que make_logo.py) ---------------------------

def draw_corner_brackets(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int,
                         arm: int, width: int, color) -> None:
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


def draw_tracked_centered(draw: ImageDraw.ImageDraw, cx: int, y: int, s: str,
                          font, fill: str, tracking: int = 0) -> int:
    """Texto centrado con tracking simulado (solo para el sheet de preview)."""
    widths = [int(draw.textlength(ch, font=font)) for ch in s]
    total = sum(widths) + tracking * (len(s) - 1)
    x = cx - total // 2
    for ch, w in zip(s, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += w + tracking
    return total


# --- Geometría del emblema ----------------------------------------------------

# Escudo militar de fondo plano: top recto, laterales que afinan y punta
# inferior. Contorno gris claro (outer) + interior oscuro semiopaco (inner).
SHIELD_OUTER = [
    (108, 118), (404, 118), (404, 330), (368, 392), (256, 452), (144, 392), (108, 330),
]
SHIELD_INNER = [
    (114, 125), (398, 125), (398, 328), (363, 387), (256, 444), (149, 387), (115, 328),
]

# Ancla vertical: la banda del chevron central SIEMPRE cubre el pixel central
# (256, 256) → [244, 270], para que la verificación de color sea determinista.
CHEVRON_ANCHOR_Y = 244


def chevron_polygons(cx: int, count: int, hw: int) -> list:
    """Chevrones apuntando arriba, apilados de arriba a abajo."""
    polys = []
    a0 = CHEVRON_ANCHOR_Y - (count // 2) * (BAND + GAP)
    for i in range(count):
        a = a0 + i * (BAND + GAP)     # y del pico
        ye = a + RISE                 # y de los extremos de la banda
        polys.append([
            (cx - hw, ye), (cx, a), (cx + hw, ye),
            (cx + hw, ye + BAND), (cx, a + BAND), (cx - hw, ye + BAND),
        ])
    return polys


def star5_points(cx: int, cy: int, r_out: int, r_in: int) -> list:
    """Estrella de 5 puntas (punta hacia arriba), polígono de 10 vértices."""
    pts = []
    for i in range(10):
        ang = math.radians(-90 + 36 * i)
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


# --- Medalla 512×512 RGBA -----------------------------------------------------

def make_medal(num: int, slug: str, metal_hex: str) -> Path:
    W = H = 512
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # fondo transparente
    d = ImageDraw.Draw(img)
    cx = W // 2
    metal = hex_rgba(metal_hex)
    outline = hex_rgba(TEXT)

    # 1) Escudo: contorno gris claro + interior oscuro semiopaco (legibilidad
    #    sobre cualquier fondo de tarjeta).
    d.polygon(SHIELD_OUTER, fill=outline)
    d.polygon(SHIELD_INNER, fill=INTERIOR)

    # 2) Chevrones del tier en el metal (color principal del emblema).
    n = CHEVRONS_BY_TIER[num]
    for poly in chevron_polygons(cx, n, CHEVRON_HW[n]):
        d.polygon(poly, fill=metal)

    # 3) Estrella de 5 puntas arriba del escudo, SOLO tier 8 (LEYENDA),
    #    en el ámbar de detalle del tier.
    if num == 8:
        d.polygon(star5_points(cx, 62, 26, 10), fill=hex_rgba(ACCENT))

    # 4) Brackets de esquina en tono del metal (unifica con el logo).
    draw_corner_brackets(d, 28, 28, W - 28, H - 28, arm=72, width=2, color=metal)

    out = OUT / f"medal-{num}-{slug}.png"
    img.save(out, "PNG")
    return out


# --- Sheet de preview (fondo carbón, no es asset de UI) ------------------------

def make_sheet(paths: list) -> Path:
    PAD, GAPX, TILE = 32, 24, 512
    TOP = 84          # espacio para el caption
    LABEL_H = 72      # nombre + rango ELO bajo cada medalla
    W = PAD * 2 + len(paths) * TILE + (len(paths) - 1) * GAPX
    H = TOP + TILE + LABEL_H + PAD
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    f_cap = load_font(28)
    f_name = load_font(24)
    f_elo = load_font(18)

    draw_corner_brackets(d, 16, 16, W - 16, H - 16, arm=64, width=2, color=ACCENT)
    draw_tracked_centered(d, W // 2, 32, "MEDALLAS ELO 1000-2500", f_cap,
                          ACCENT, tracking=10)

    for i, (p, tier) in enumerate(zip(paths, TIERS)):
        num, _slug, name, _metal, elo = tier
        x = PAD + i * (TILE + GAPX)
        m = Image.open(p).convert("RGBA")
        img.paste(m, (x, TOP), m)
        cx = x + TILE // 2
        draw_tracked_centered(d, cx, TOP + TILE + 16, name, f_name, TEXT, tracking=4)
        draw_tracked_centered(d, cx, TOP + TILE + 46, elo, f_elo, DIM, tracking=2)

    out = HERE / "medals" / "medals-sheet.png"
    img.save(out, "PNG")
    return out


# --- Assets de UI: estrellas de progreso + badge élite ------------------------
# Las estrellas I-V NO van dentro del emblema (make_medal): la UI las pinta
# al lado del detalle. Aquí se generan como PNG independientes (64×64 RGBA,
# alpha 0 en esquinas) para que el bloque MEDALLA del stats panel y futuras
# vistas usen el MISMO par de glifos (llena ámbar ACCENT / vacía dim).
STAR_SIZE = 64
STAR_EMPTY_HEX = "#3B443E"   # = COLORS["border_strong"] (dim del tema)

# Badge del club élite (top 12 global): 256×96, fondo carbón OPACO (no es
# un asset alpha: se dibuja su propio fondo como el sheet) + borde ámbar.
ELITE_SIZE = (256, 96)


def make_star(fill_hex: str, filename: str) -> Path:
    """Estrella de 5 puntas 64×64 RGBA transparente (misma geometría que la
    estrella del tier 8: proporción interior ≈ 0.4 del radio exterior)."""
    img = Image.new("RGBA", (STAR_SIZE, STAR_SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = STAR_SIZE // 2, STAR_SIZE // 2 + 2  # óptico: punta arriba pesa menos
    d.polygon(star5_points(cx, cy, 30, 12), fill=hex_rgba(fill_hex))
    out = OUT / filename
    img.save(out, "PNG")
    return out


def make_elite_badge() -> Path:
    """Badge 'TOP 12' 256×96: rectángulo carbón + borde ámbar 2px + texto
    mono Consolas bold ámbar centrado (mismo patrón HUD que el sheet)."""
    W, H = ELITE_SIZE
    img = Image.new("RGBA", (W, H), hex_rgba(BG))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W - 1, H - 1], outline=hex_rgba(ACCENT), width=2)
    f = load_font(30)
    ascent, _descent = f.getmetrics()
    draw_tracked_centered(d, W // 2, (H - ascent) // 2, "TOP 12", f,
                          ACCENT, tracking=6)
    out = OUT / "elite-top12.png"
    img.save(out, "PNG")
    return out


# --- Verificación --------------------------------------------------------------

def verify() -> None:
    print(f"{'archivo':<26}{'tamano':<12}{'bytes':<9}{'alpha esq':<10}"
          f"{'pixel central':<20}{'esperado':<13}{'ok'}")
    expected = {t[0]: hex_rgba(t[3])[:3] for t in TIERS}
    paths = []
    all_ok = True
    for num, slug, _name, metal_hex, _elo in TIERS:
        p = OUT / f"medal-{num}-{slug}.png"
        paths.append(p)
        img = Image.open(p)
        rgba = img.convert("RGBA")
        size_ok = img.size == (512, 512) and img.mode == "RGBA"
        corner_a = rgba.getpixel((0, 0))[3]
        center = rgba.getpixel((256, 256))
        want = expected[num]
        color_ok = center[:3] == want and center[3] == 255
        ok = size_ok and corner_a == 0 and color_ok
        all_ok &= ok
        print(f"{p.name:<26}{f'{img.size[0]}x{img.size[1]} {img.mode}':<12}"
              f"{os.path.getsize(p):<9}{corner_a:<10}"
              f"{str(center):<20}{str(want):<13}{'SI' if ok else 'NO'}")
    sheet = OUT / "medals-sheet.png"
    simg = Image.open(sheet)
    print(f"{sheet.name:<26}{f'{simg.size[0]}x{simg.size[1]} {simg.mode}':<12}"
          f"{os.path.getsize(sheet):<9}{'-':<10}{'-':<20}{'-':<13}"
          f"{'SI' if simg.size[0] > 0 else 'NO'}")

    # Assets de UI: estrellas transparentes (alpha 0 en esquinas, cuerpo
    # opaco al color esperado) y badge élite opaco (borde ámbar en el borde,
    # fondo carbón dentro). Misma disciplina de verificación determinista.
    ui_expect = [
        ("star-full.png", (STAR_SIZE, STAR_SIZE), hex_rgba(ACCENT), 0),
        ("star-empty.png", (STAR_SIZE, STAR_SIZE), hex_rgba(STAR_EMPTY_HEX), 0),
        ("elite-top12.png", ELITE_SIZE, hex_rgba(BG), 255),
    ]
    for name, size, inner, corner_a_want in ui_expect:
        p = OUT / name
        img = Image.open(p)
        rgba = img.convert("RGBA")
        size_ok = img.size == size and img.mode == "RGBA"
        corner_a = rgba.getpixel((0, 0))[3]
        cx, cy = size[0] // 2, size[1] // 2 + (2 if name.startswith("star") else 0)
        inner_px = rgba.getpixel((cx, cy))
        if name == "elite-top12.png":
            # el centro puede caer en texto o hueco: se verifica el FONDO
            # carbón en una zona interior sin texto y el borde ámbar en (1,1)
            inner_ok = rgba.getpixel((12, size[1] - 12)) == inner
            border_ok = rgba.getpixel((1, 1))[:3] == hex_rgba(ACCENT)[:3]
            color_ok = inner_ok and border_ok
            want = f"{inner} / borde ámbar"
        else:
            color_ok = inner_px[:3] == inner[:3] and inner_px[3] == 255
            want = str(inner)
        ok = size_ok and corner_a == corner_a_want and color_ok
        all_ok &= ok
        print(f"{p.name:<26}{f'{img.size[0]}x{img.size[1]} {img.mode}':<12}"
              f"{os.path.getsize(p):<9}{corner_a:<10}"
              f"{str(inner_px):<20}{want:<13}{'SI' if ok else 'NO'}")
    if not all_ok:
        raise SystemExit("[FAIL] verificación de medallas")


def main() -> None:
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    OUT.mkdir(parents=True, exist_ok=True)
    paths = [make_medal(num, slug, metal_hex)
             for num, slug, _name, metal_hex, _elo in TIERS]
    for p in paths:
        img = Image.open(p)
        print(f"[OK] {p.name}: {img.size[0]}x{img.size[1]} {img.mode} "
              f"({os.path.getsize(p)} bytes)")
    ui_paths = [
        make_star(ACCENT, "star-full.png"),
        make_star(STAR_EMPTY_HEX, "star-empty.png"),
        make_elite_badge(),
    ]
    for p in ui_paths:
        img = Image.open(p)
        print(f"[OK] {p.name}: {img.size[0]}x{img.size[1]} {img.mode} "
              f"({os.path.getsize(p)} bytes)")
    sheet = make_sheet(paths)
    print(f"[OK] {sheet.name}: preview de {len(paths)} medallas sobre fondo carbon")
    verify()


if __name__ == "__main__":
    main()
