"""Sistema visual del launcher — HUD militar estilo MW2/IW4x.

Dirección (brief del dueño + disciplina de docs/DESIGN.md):
- Fondo carbón/negro verdoso, paneles elevados con hairlines de 1px.
- UN acento: ámbar militar para acción/estado activo.
- Verde señal SOLO para OK/verificado; rojo apagado SOLO para danger.
- Esquinas casi rectas, cero gradientes, cero glow.
- Espaciado en múltiplos de 4 (rejilla), tipografía de sistema:
  Segoe UI para texto, Consolas para números/GUIDs/consola.
"""
from __future__ import annotations

import sys
from pathlib import Path

import customtkinter as ctk

from app_config import launcher_pro_meta

# --- Identidad del launcher (única fuente: CTHLG.pro en la raíz del repo) ---
# La marca oficial es CTHLG MW2 Ranking (CTHolguin · MW2 2009 · engine IW4x).
# app_config.launcher_pro_meta() lee el CTHLG.pro del repo y deriva TODO de
# aquí: el title de la ventana, la línea de créditos de la franja inferior
# del home y el bloque '// ACERCA DE //' de Ajustes leen los tres de AQUÍ.
# Si el archivo no acompaña al exe → defaults IGUALES (app_config): la UI
# nunca cambia por la ausencia del archivo (es UI derivada, no config).
_PRO = launcher_pro_meta()

META = {
    "nombre": _PRO["PRO_NAME"],         # "CTHLG MW2 Ranking"
    "version": _PRO["VERSION"],         # "0.1.5"
    "anio": int(_PRO["ANIO"]),          # 2026
    "autor": _PRO["AUTOR"],             # "Desarrollado por José … · Rafael …"
    "contacto": _PRO["CONTACTO"],       # "" → sin línea de contacto en Ajustes
    "descripcion": _PRO["DESCRIPCION"],
    "juego": _PRO["GAME"],              # "Call of Duty: Modern Warfare 2 (2009)"
    "game_short": _PRO["GAME_SHORT"],   # "MW2"
    "engine": _PRO["GAME_ENGINE"],      # "IW4x - AlterWare r5318"
    "pro_short": _PRO["PRO_SHORT"],     # "CTHLG"
    "pro_full": _PRO["PRO_FULL"],
}


def version_tag() -> str:
    """Etiqueta corta de versión desde META ('v0.1.5')."""
    return f'v{META["version"]}'


def marca_visible() -> str:
    """Marca en MAYÚSCULAS para ventana/header/créditos: 'CTHLG MW2 RANKING'."""
    return META["nombre"].upper()


def autores_corto() -> str:
    """Autores SIN el prefijo 'Desarrollado por ' (línea compacta del home)."""
    return META["autor"].replace("Desarrollado por ", "", 1)


def credits_compact() -> str:
    """Copy EXACTO de la línea de créditos de la franja inferior del home:
    ``CTHLG MW2 RANKING v0.1.5 · 2026 · José Domínguez Ramírez · Rafael Font Rojas``.
    """
    return f'{marca_visible()} {version_tag()} · {META["anio"]} · {autores_corto()}'


def abreviar_nombre(nombre: str) -> str:
    """Nombre con el segundo apellido abreviado a inicial (pura):
    ``José Domínguez Ramírez`` → ``José D. Ramírez``. Con 1-2 palabras no hay
    nada que abreviar (queda tal cual). Para la franja de créditos, que
    comparte fila con el título del registro y no siempre cabe entera.
    """
    palabras = (nombre or "").strip().split()
    if len(palabras) < 3:
        return (nombre or "").strip()
    return f"{palabras[0]} {palabras[1][0]}. {palabras[-1]}"


def autores_abreviados() -> str:
    """Autores (sin prefijo) con cada nombre abreviado, unidos por ' · ':
    ``José D. Ramírez · Rafael F. Rojas``.
    """
    return " · ".join(abreviar_nombre(a)
                      for a in autores_corto().split(" · "))


def credits_short() -> str:
    """Copy CORTO de la franja del home (nombres abreviados, cabe en el
    ancho mínimo): ``CTHLG MW2 RANKING v0.1.5 · 2026 · José D. Ramírez ·
    Rafael F. Rojas``. La UI además lo recorta con '…' medido si ni este
    cupiera (ver Home._fit_credits)."""
    return f'{marca_visible()} {version_tag()} · {META["anio"]} · {autores_abreviados()}'


def credits_acerca_de() -> str:
    """Copy EXACTO de la línea de autoría del bloque ACERCA DE de Ajustes:
    ``2026 · Desarrollado por José Domínguez Ramírez · Rafael Font Rojas``.
    (Aquí SÍ vive el 'Desarrollado por'; el home lo lleva sin prefijo.)
    """
    return f'{META["anio"]} · {META["autor"]}'


def descripcion_acerca_de() -> str:
    """Copy EXACTO de la línea de descripción del bloque ACERCA DE:
    la DESCRIPCION del .pro con guion largo antes de CTHolguin + el engine
    detrás: ``Sistema de ranking, ELO y cloud-save para Call of Duty: Modern
    Warfare 2 (2009) — CTHolguin · IW4x AlterWare r5318``.
    """
    base = META["descripcion"].replace("- CTHolguin", "— CTHolguin")
    engine = META["engine"].replace(" - ", " ")
    return f"{base} · {engine}"


# --- Paleta (única fuente de color del launcher) --------------------------
COLORS = {
    # Superficies (carbón verdoso, nunca gris puro)
    "bg": "#101312",            # fondo de ventana
    "bg_deep": "#0B0D0C",       # fondo más profundo (consola, login)
    "panel": "#171B19",         # paneles/tarjetas
    "panel2": "#1E2320",        # inputs, hover, elementos sobre panel
    "console": "#0D100E",       # consola mini
    # Hairlines
    "border": "#2A302C",        # hairline estándar (1px)
    "border_strong": "#3B443E", # hairline interactiva (hover/foco)
    # Texto
    "text": "#E6EAE6",          # principal (≈13:1 sobre panel)
    "text_dim": "#9BA69E",      # secundario (≈7:1 sobre bg)
    "text_faint": "#6F7B73",    # metadatos discretos
    # Acento ÚNICO: ámbar militar (acción, activo, advertencia suave)
    "accent": "#E8930C",
    "accent_hover": "#F5A430",
    "accent_active": "#C77E0A",
    "on_accent": "#171208",     # texto SIEMPRE sobre relleno ámbar
    "accent_subtle": "#241D10", # fondo sutil ámbar (badges)
    "accent_border": "#6B4A12", # hairline ámbar
    # Verde señal: SOLO OK/verificado
    "ok": "#8FD429",
    "ok_dim": "#26320F",        # fondo sutil verde
    # Rojo apagado: SOLO peligro/error
    "danger": "#D2544A",
    "danger_hover": "#E06A5F",
    "danger_dim": "#2B1B19",
    # Alias de compatibilidad con el código existente
    "warn": "#E8930C",          # advertencia = familia del acento
    "error": "#D2544A",         # = danger
    "play": "#E8930C",          # botón JUGAR = acento
    "play_hover": "#F5A430",
}

# --- Metales por tier de medalla ELO ----------------------------------------
# Valores EXACTOS de assets/make_medals.py · TIERS (única fuente del dibujo).
# La UI pinta el nombre del tier en SU metal para que la medalla se lea de
# un vistazo. Clave = tierId 1-8 del contrato player["medal"].
MEDAL_TIER_COLORS = {
    1: "#3B443E",  # RECLUTA    (gris acero dim — el tier base es intencionalmente apagado)
    2: "#B0722F",  # SOLDADO    (bronce)
    3: "#A9B2AC",  # CABO       (plata)
    4: "#E8930C",  # SARGENTO   (ámbar militar = accent)
    5: "#F5A430",  # TENIENTE   (ámbar claro = accent_hover)
    6: "#8FD429",  # CAPITÁN    (verde señal = ok)
    7: "#D2544A",  # COMANDANTE (rojo apagado = danger)
    8: "#FFE9C4",  # LEYENDA    (blanco cálido)
}

# --- Rejilla de espaciado (múltiplos de 4) ---------------------------------
SP = {"xs": 4, "s": 8, "m": 12, "l": 16, "xl": 24, "xxl": 32}

# --- Radios (sistema afilado: nada por encima de 6) ------------------------
RADIUS = {"btn": 3, "input": 3, "panel": 4, "card": 6}

# --- Tipografías de sistema -------------------------------------------------
SANS = "Segoe UI"
MONO = "Consolas"

# Peso disponibles en Segoe UI vía CTkFont weight ("bold" o "normal").


def font(size: int = 13, weight: str = "normal", mono: bool = False):
    """Fuente del sistema: Segoe UI (texto) o Consolas (datos/HUD)."""
    family = MONO if mono else SANS
    return ctk.CTkFont(family=family, size=size, weight=weight)


def tracked(text: str) -> str:
    """Mayúsculas con tracking simulado (espacio fino entre letras).

    Solo para display corto (títulos de sección, botón héroe): Tk no soporta
    letter-spacing real, compensamos con U+2009. En fuentes sin glifo fino
    degrada a espacio normal — sigue legible.
    """
    return "\u2009".join(text.upper())


def section_text(text: str) -> str:
    """Marcador de sección estilo militar: '// SECCIÓN //'."""
    return f"// {text.upper()} //"


# --- Assets (iconos, imágenes) ----------------------------------------------

def asset_path(name: str) -> Path:
    """Ruta absoluta a un asset (p.ej. ``logo-icon.png``), congelado o en dev.

    En el exe de PyInstaller los datos van a ``sys._MEIPASS`` (--add-data):
    resolvemos ahí; en dev, al assets/ real del proyecto. El archivo puede no
    existir — el llamador decide (los assets son siempre decorativos).
    """
    base = Path(__file__).resolve().parent.parent
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        base = Path(sys._MEIPASS)
    return base / "assets" / name
