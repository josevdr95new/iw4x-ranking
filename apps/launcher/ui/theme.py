"""Paleta y tipografías compartidas (tema oscuro del launcher)."""
from __future__ import annotations

import customtkinter as ctk

COLORS = {
    "bg": "#181820",          # fondo de la ventana
    "panel": "#20202c",       # paneles/tarjetas
    "panel2": "#262634",      # elementos sobre panel
    "accent": "#3d8bfd",      # azul de acción
    "accent_hover": "#3a7dd8",
    "play": "#2f9e44",        # verde del botón JUGAR
    "play_hover": "#28853a",
    "ok": "#69db7c",
    "warn": "#ffa94d",
    "error": "#ff6b6b",
    "text": "#e9eaef",
    "text_dim": "#9aa0b4",
}


def font(size: int = 13, weight: str = "normal", mono: bool = False):
    """Tipografía Segoe UI (o Consolas para la consola mini)."""
    family = "Consolas" if mono else "Segoe UI"
    return ctk.CTkFont(family=family, size=size, weight=weight)
