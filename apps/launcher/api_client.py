"""Cliente HTTP de la API del ranking IW4x.

Refleja el contrato de docs/API.md (rutas bajo /api, envelope de error
``{"error": {"code", "message"}}``). Traduce los fallos de red a mensajes
claros en español para mostrarlos directamente en la UI.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import requests

log = logging.getLogger("api")

DEFAULT_TIMEOUT = 8  # segundos


def user_is_linked(user: dict) -> bool:
    """¿El usuario tiene GUID vinculado?

    Hoy el contrato expone ``linkedGuid`` (null si no). Cuando el backend
    pase a multi-GUID por cuenta podría informar ``guid`` o ``linked``:
    las tres formas se aceptan aquí, en un único punto.
    """
    return bool(
        user.get("linkedGuid") or user.get("guid") or user.get("linked")
    )


class NetworkError(Exception):
    """API caída, timeout u otro problema de transporte."""


class ApiError(Exception):
    """Error 4xx/5xx con el envelope estándar de la API."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"[{status}] {code}: {message}")
        self.status = status
        self.code = code
        self.message = message


class ApiClient:
    """Métodos 1:1 con los endpoints que usa el launcher."""

    def __init__(self, base_url: str, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # --- Infraestructura ---------------------------------------------------
    def _url(self, path: str) -> str:
        """Construye la URL final: {base}/api{path}."""
        return f"{self.base_url}/api{path}"

    def _request(
        self,
        method: str,
        path: str,
        token: Optional[str] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Lanza la petición y devuelve el JSON de respuesta.

        Lanza NetworkError (transporte) o ApiError (4xx/5xx con envelope).
        """
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            resp = requests.request(
                method,
                self._url(path),
                headers=headers,
                json=json_body,
                timeout=self.timeout,
            )
        except requests.exceptions.ConnectionError:
            raise NetworkError(
                "No se pudo conectar con la API. ¿Está corriendo? "
                "Revisa la dirección en Ajustes."
            )
        except requests.exceptions.Timeout:
            raise NetworkError("La API tardó demasiado en responder (timeout).")
        except requests.exceptions.RequestException as exc:
            raise NetworkError(f"Error de red inesperado: {exc.__class__.__name__}")

        if resp.status_code >= 400:
            # Parseamos el envelope de error; si no se puede, uno genérico.
            code, message = "ERROR", f"La API respondió {resp.status_code}."
            try:
                err = resp.json().get("error") or {}
                code = str(err.get("code") or code)
                message = str(err.get("message") or message)
            except ValueError:
                pass
            log.warning("%s %s -> %s %s", method, path, resp.status_code, code)
            raise ApiError(resp.status_code, code, message)

        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError:
            raise NetworkError("La API devolvió una respuesta no válida (no JSON).")

    # --- Health / diagnóstico ---------------------------------------------
    def health(self) -> Dict[str, Any]:
        """GET /api/health — latido simple del servicio."""
        return self._request("GET", "/health")

    def sync_status(self) -> Dict[str, Any]:
        """GET /api/sync/status — público; sirve para 'probar conexión API'."""
        return self._request("GET", "/sync/status")

    # --- Auth ---------------------------------------------------------------
    def register(self, email: str, password: str, display_name: str) -> Dict[str, Any]:
        """POST /api/auth/register → {user, token}."""
        return self._request(
            "POST",
            "/auth/register",
            json_body={"email": email, "password": password, "displayName": display_name},
        )

    def login(self, email: str, password: str) -> Dict[str, Any]:
        """POST /api/auth/login → {user, token}."""
        return self._request(
            "POST", "/auth/login", json_body={"email": email, "password": password}
        )

    def me(self, token: str) -> Dict[str, Any]:
        """GET /api/auth/me → {user:{..., linkedGuid}}."""
        data = self._request("GET", "/auth/me", token=token)
        return data.get("user") or {}

    # --- Vinculación cuenta ↔ GUID -----------------------------------------
    def link_start(self, token: str) -> Dict[str, Any]:
        """POST /api/link/start — registra el intento de vinculación."""
        return self._request("POST", "/link/start", token=token, json_body={})

    def link_candidates(self, token: str) -> Dict[str, Any]:
        """POST /api/link/complete sin guid → {status, candidates:[...]}."""
        return self._request("POST", "/link/complete", token=token, json_body={})

    def link_confirm(self, token: str, guid: str) -> Dict[str, Any]:
        """POST /api/link/complete con {guid} → {status:'linked', ...}."""
        return self._request(
            "POST", "/link/complete", token=token, json_body={"guid": guid}
        )
