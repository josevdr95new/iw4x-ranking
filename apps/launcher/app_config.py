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
        {"name": "Test Local", "address": "127.0.0.1:5174"},
    ],
    "default_server": 0,
    # Flag de prueba: NO abre el juego real, solo simula el paso de lanzarlo
    # para poder probar el polling de vinculación contra la API.
    "simulate_game": False,
    # Cloud-sync del progreso (iw4x.stat/config/mods) antes de jugar y al
    # cerrar el juego. Descargable/subible con la cuenta del ranking.
    "cloud_save": True,
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


def normalize_api_url(url: str, default: str = DEFAULT_CONFIG["api_url"]) -> str:
    """Normaliza la dirección de la API (pura, defensiva).

    Reglas:
    - Trim de espacios en los extremos y de la(s) barra(s) final(es).
    - Sin esquema (``http://``/``https://``) → se antepone ``http://``. Esto
      cubre el error real del dueño (``"127.0.0.1:5173"`` en el config):
      el puerto NO se toca jamás — solo se añade esquema, nunca se inventa.
    - ``https://`` explícito se respeta tal cual (mayúsculas incluidas).
    - Vacío o sin host tras normalizar (p.ej. ``"http://"``) → default.

    Devuelve SIEMPRE una URL con esquema y sin barra final.
    """
    cleaned = str(url or "").strip()
    if not cleaned:
        return default
    # Separar esquema (si lo hay) del host+puerto antes de recortar barras:
    # así "http://" (solo esquema) no se convierte en "http:" por el rstrip.
    lower = cleaned.lower()
    if lower.startswith("http://"):
        scheme, rest = cleaned[:7], cleaned[7:]
    elif lower.startswith("https://"):
        scheme, rest = cleaned[:8], cleaned[8:]
    else:
        scheme, rest = "", cleaned
    rest = rest.rstrip("/")
    if not rest:
        return default
    return (scheme or "http://") + rest


class AppConfig:
    """Envoltura tipada y ligera sobre el diccionario de configuración."""

    def __init__(self, data: Dict[str, Any]) -> None:
        self.data = data

    # --- Propiedades de lectura -------------------------------------------
    @property
    def api_url(self) -> str:
        # normalize_api_url añade esquema si falta y recorta la barra final:
        # un config escrito a mano ("127.0.0.1:3000") nunca rompe el cliente.
        return normalize_api_url(
            str(self.data.get("api_url") or ""), DEFAULT_CONFIG["api_url"]
        )

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
    def cloud_save(self) -> bool:
        return bool(self.data.get("cloud_save", True))

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
    # api_url normalizado también en carga (esquema garantizado, sin barra):
    # la propiedad ya normaliza al leer, aquí lo dejamos consistente en el dict.
    merged["api_url"] = normalize_api_url(merged.get("api_url"))
    # 'force_nick' quedó obsoleto (el nick SIEMPRE se fuerza): se purga
    # silenciosamente para que no vuelva al archivo al guardar.
    merged.pop("force_nick", None)
    log.info("Config cargada desde %s (api_url=%s)", path, merged["api_url"])
    return AppConfig(merged)
