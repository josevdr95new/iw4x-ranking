"""Guardado del JWT del usuario en %APPDATA%\\iw4x-ranking-launcher\\token.json.

Permite el auto-login: al abrir el launcher se intenta GET /auth/me con el
token guardado; si está expirado (401) se descarta y se pide login de nuevo.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Dict, Optional

from logging_setup import app_data_dir

log = logging.getLogger("user_store")


class UserStore:
    """Persistencia mínima de la sesión (token + datos básicos del usuario)."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or (app_data_dir() / "token.json")

    def load(self) -> Optional[Dict[str, str]]:
        """Devuelve {'token', 'email', 'displayName'} o None si no hay sesión."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            token = data.get("token")
            if token:
                return {
                    "token": str(token),
                    "email": str(data.get("email", "")),
                    "displayName": str(data.get("displayName", "")),
                }
        except (OSError, ValueError) as exc:
            log.info("No hay sesión guardada o es ilegible: %s", exc)
        return None

    def save(self, token: str, email: str, display_name: str) -> None:
        """Guarda el token tras un login/registro correcto."""
        payload = {
            "token": token,
            "email": email,
            "displayName": display_name,
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        try:
            self.path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            log.info("Sesión guardada para %s", email)
        except OSError as exc:
            # No es fatal: el usuario podrá volver a hacer login.
            log.warning("No se pudo guardar la sesión: %s", exc)

    def clear(self) -> None:
        """Borra el token (logout o sesión expirada)."""
        try:
            self.path.unlink(missing_ok=True)
            log.info("Sesión borrada")
        except OSError as exc:
            log.warning("No se pudo borrar la sesión: %s", exc)
