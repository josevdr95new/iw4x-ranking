"""IW4x Ranking — Launcher de escritorio.

Punto de entrada. Ejecutar con:
    py apps\\launcher\\main.py

Configuración en launcher.config.json (se crea con defaults si no existe).
"""
from __future__ import annotations

import logging

import customtkinter as ctk

from api_client import ApiClient
from app_config import load_config
from logging_setup import setup_logging
from ui.main_window import App
from user_store import UserStore


def main() -> None:
    log_path = setup_logging()
    logging.getLogger("main").info("Launcher iniciado (log: %s)", log_path)

    # Taskbar propia en Windows: agrupa el launcher bajo su propio AppUserModelID
    # en vez de heredar el de Python. DEBE ejecutarse ANTES de crear la Tk root.
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "iw4xranking.launcher")
    except Exception:
        logging.getLogger("main").debug(
            "AppUserModelID no disponible (¿no Windows?)", exc_info=True)

    cfg = load_config()

    # Tema oscuro moderno.
    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("dark-blue")

    app = App(cfg, ApiClient(cfg.api_url), UserStore())
    app.mainloop()

    logging.getLogger("main").info("Launcher terminado")


if __name__ == "__main__":
    main()
