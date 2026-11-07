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

import customtkinter as ctk

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
