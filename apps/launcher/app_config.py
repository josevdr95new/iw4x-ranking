"""Carga y guardado de launcher.config.json (junto al script o al .exe).

Si el archivo no existe se crea con los valores por defecto. Las claves que
falten en un archivo existente se rellenan desde los defaults (merge).
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

log = logging.getLogger("config")

# Valores por defecto según el contrato del proyecto.
DEFAULT_CONFIG: Dict[str, Any] = {
    "api_url": "http://192.168.3.99:3000",
    "game_path": "D:\\Call of Duty 6\\iw4x.exe",
    "servers": [
        {"name": "LAN Server", "address": "192.168.2.251:28960"},
        {"name": "Test Local", "address": "127.0.0.1:28961"},
    ],
    "default_server": 0,
    # Flag de prueba: NO abre el juego real, solo simula el paso de lanzarlo
    # para poder probar el polling de vinculación contra la API.
    "simulate_game": False,
    # Ajustes finos del polling de vinculación (los valores del contrato son
    # 10s / 180s; se exponen para poder acortarlos en pruebas).
    "link_poll_interval": 10,
    "link_poll_max_seconds": 180,
}


def config_path() -> Path:
    """Ruta del config: junto al .exe si está compilado, junto a main.py si no."""
    if getattr(sys, "frozen", False):  # PyInstaller --onefile
        base = Path(sys.executable).resolve().parent
    else:
        base = Path(__file__).resolve().parent
    return base / "launcher.config.json"


class AppConfig:
    """Envoltura tipada y ligera sobre el diccionario de configuración."""

    def __init__(self, data: Dict[str, Any]) -> None:
        self.data = data

    # --- Propiedades de lectura -------------------------------------------
    @property
    def api_url(self) -> str:
        return str(self.data.get("api_url", DEFAULT_CONFIG["api_url"])).rstrip("/")

    @property
    def game_path(self) -> str:
        return str(self.data.get("game_path", "") or "")

    @property
    def servers(self) -> List[Dict[str, str]]:
        raw = self.data.get("servers") or []
        out: List[Dict[str, str]] = []
        for s in raw:
            if isinstance(s, dict) and s.get("name") and s.get("address"):
                out.append({"name": str(s["name"]), "address": str(s["address"])})
        return out

    @property
    def default_server(self) -> int:
        try:
            return max(0, int(self.data.get("default_server", 0)))
        except (TypeError, ValueError):
            return 0

    @property
    def simulate_game(self) -> bool:
        return bool(self.data.get("simulate_game", False))

    @property
    def link_poll_interval(self) -> int:
        try:
            return max(1, int(self.data.get("link_poll_interval", 10)))
        except (TypeError, ValueError):
            return 10

    @property
    def link_poll_max_seconds(self) -> int:
        try:
            return max(5, int(self.data.get("link_poll_max_seconds", 180)))
        except (TypeError, ValueError):
            return 180

    # --- Escritura ---------------------------------------------------------
    def save(self) -> None:
        """Persiste la configuración actual en disco (JSON legible)."""
        path = config_path()
        path.write_text(
            json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        log.info("Configuración guardada en %s", path)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value


def load_config() -> AppConfig:
    """Carga launcher.config.json; lo crea con defaults si no existe."""
    path = config_path()

    if not path.exists():
        cfg = AppConfig(dict(DEFAULT_CONFIG))
        cfg.save()
        log.info("Config creada con valores por defecto en %s", path)
        return cfg

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("el config no es un objeto JSON")
    except (ValueError, OSError) as exc:
        # Archivo corrupto: lo respaldamos y seguimos con defaults.
        log.error("Config inválido (%s); se usan defaults. Respaldo en %s.bak", exc, path)
        try:
            path.rename(path.with_suffix(".json.bak"))
        except OSError:
            pass
        cfg = AppConfig(dict(DEFAULT_CONFIG))
        cfg.save()
        return cfg

    # Merge: defaults para claves ausentes (el archivo puede ser viejo).
    merged = dict(DEFAULT_CONFIG)
    merged.update(raw)
    # 'force_nick' quedó obsoleto (el nick SIEMPRE se fuerza): se purga
    # silenciosamente para que no vuelva al archivo al guardar.
    merged.pop("force_nick", None)
    log.info("Config cargada desde %s", path)
    return AppConfig(merged)
