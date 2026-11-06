"""Logging rotativo del launcher en %APPDATA%\\iw4x-ranking-launcher\\logs.

Todo el diagnóstico de la app va aquí; nunca a consola (la app es de ventana).
"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Nombre de la carpeta de datos de la app dentro de %APPDATA%.
APP_DIR_NAME = "iw4x-ranking-launcher"


def app_data_dir() -> Path:
    """Devuelve (y crea si falta) %APPDATA%\\iw4x-ranking-launcher."""
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    d = Path(base) / APP_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def setup_logging() -> Path:
    """Configura el logger raíz con un handler rotativo y devuelve la ruta del log."""
    logs_dir = app_data_dir() / "logs"
    logs_dir.mkdir(exist_ok=True)
    log_path = logs_dir / "launcher.log"

    handler = RotatingFileHandler(
        log_path, maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # Evita duplicados si setup_logging se llama dos veces (tests).
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        root.addHandler(handler)

    # Ruido de bajo nivel fuera.
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    return log_path
