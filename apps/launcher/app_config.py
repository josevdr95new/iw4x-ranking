"""Carga y guardado de launcher.config.json (junto al script o al .exe).

Si el archivo no existe se crea con los valores por defecto. Las claves que
falten en un archivo existente se rellenan desde los defaults (merge).
"""
from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

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
    # Exportación de clases al perfil web: el launcher inyecta
    # +dumpPlayerData al arrancar el juego y al cerrarlo sube el dump del
    # console_mp.log del CLIENTE a POST /api/players/classes (sin pasos
    # manuales). Editable en Ajustes.
    "export_classes": True,
    # Auto-guardado periódico del progreso en la nube (pedido del dueño:
    # evitar pérdida de progreso si la PC muere a mitad de sesión).
    # 0 = desactivado. Editable en Ajustes.
    "autosave_minutes": 10,
    # Recordar sesión (cyber-café): FALSE por defecto — al CERRAR el launcher
    # se borra el token guardado y al ABRIR cada quien hace LOGIN (nada de
    # auto-login con sesiones de otros). true = auto-login como siempre.
    # Editable en Ajustes ("Mantener mi sesión abierta al cerrar el launcher").
    "remember_session": False,
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


# Puerto de la web de ranking (Vite, apps/web): el launcher la abre en el
# navegador con los enlaces "RANKING WEB ↗" / "WEB ↗".
WEB_PORT = 5173


def default_web_url(api_url: str = DEFAULT_CONFIG["api_url"]) -> str:
    """Web del ranking derivada de la API (pura): MISMO host, puerto WEB_PORT.

    ``http://192.168.3.99:3000`` → ``http://192.168.3.99:5173``. Del api_url
    solo se toma el host (se descartan puerto y posible path); esquema y
    barra los recompone ``normalize_api_url``. Si el api_url no tiene host
    utilizable → ``""``.

    El dueño puede fijar ``web_url`` a mano en launcher.config.json (otro
    host/puerto); un ``""`` explícito oculta los enlaces WEB de la UI.
    """
    rest = normalize_api_url(api_url, default="")
    if not rest:
        return ""
    after = rest.split("://", 1)[1] if "://" in rest else rest
    host = after.split("/", 1)[0].split(":", 1)[0].strip()
    if not host:
        return ""
    return normalize_api_url(f"http://{host}:{WEB_PORT}")


# La web del ranking vive en el MISMO host que la API, en el puerto de Vite:
# el default se DERIVA del api_url del contrato (nunca a mano aquí).
DEFAULT_CONFIG["web_url"] = default_web_url(DEFAULT_CONFIG["api_url"])


# --- Servers de juego: validación de la lista editable (Ajustes) -----------
# host: hostname/IP v4 (letras, dígitos, puntos, guiones; sin esquema) +
# puerto de 4-5 dígitos. El rango fino lo pone la función (1024..65535).
SERVER_ADDR_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?:\d{4,5}$"
)


def normalize_server_address(address: str) -> str:
    """Valida/normaliza la dirección 'host:puerto' de un server (pura).

    - host: hostname (``localhost``, ``mi-server.lan``) o IP v4, SIN esquema.
    - puerto: entero **1024..65535** (los ≤1023 son privilegiados y el 80
      tipifica el error de pegar una URL web — se rechaza).
    - Trim de espacios (normalización documentada). Devuelve ``host:puerto``
      tal cual, o ``""`` si es inválida.
    """
    addr = str(address or "").strip()
    if not SERVER_ADDR_RE.match(addr):
        return ""
    port = int(addr.rsplit(":", 1)[1])
    if not (1024 <= port <= 65535):
        return ""
    return addr


def sanitize_servers(rows: Any, default_index: int = 0
                     ) -> Tuple[List[Dict[str, str]], int]:
    """Valida y normaliza la lista editable de servers (pura, para GUARDAR).

    ``rows``: lo que hay en la UI, ``[{"name": str, "address": str}, ...]``.
    - Fila TOTALMENTE vacía (sin nombre y sin dirección) → se descarta (es
      una fila "AÑADIR" que nunca se rellenó; no es un error).
    - Dirección inválida → ``ValueError`` con mensaje claro: la UI lo
      muestra y NO se guarda nada (jamás se persiste una lista rota).
    - Nombre vacío → ``"Server N"`` (N = posición 1-based en la lista final).
    Devuelve ``([{name, address}, ...], default_server)`` con el índice
    acotado a la lista final (0 si queda vacía).
    """
    clean: List[Dict[str, str]] = []
    for row in (rows or []):
        name = str((row or {}).get("name") or "").strip()
        addr = str((row or {}).get("address") or "").strip()
        if not name and not addr:
            continue  # fila añadida y nunca rellenada: fuera, sin drama
        addr_ok = normalize_server_address(addr)
        if not addr_ok:
            raise ValueError(
                f"Dirección de server no válida: '{addr or '(vacía)'}' "
                "(formato host:puerto — ej. 192.168.1.50:28961, puerto "
                "1024-65535)"
            )
        clean.append({"name": name, "address": addr_ok})
    out = [{"name": (row["name"] or f"Server {i + 1}"), "address": row["address"]}
           for i, row in enumerate(clean)]
    idx = default_index if 0 <= default_index < len(out) else 0
    return out, idx


def default_server_after_delete(default_index: int, removed_index: int) -> int:
    """``default_server`` tras BORRAR una fila de la lista (pura).

    - Se borró el default → recae en el PRIMERO (0), decisión del dueño.
    - Se borró una fila ANTES del default → el default se corre una posición.
    - Se borró una fila después → el default no cambia.
    """
    if removed_index == default_index:
        return 0
    if removed_index < default_index:
        return default_index - 1
    return default_index


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
    def export_classes(self) -> bool:
        """¿Inyectar +dumpPlayerData y subir el dump de clases al perfil web?

        Default True (decisión del dueño): las 15 clases aparecen en el
        perfil sin pasos manuales. false → no se añade el arg ni se sube.
        """
        return bool(self.data.get("export_classes", True))

    @property
    def autosave_minutes(self) -> int:
        """Minutos entre auto-guardados del progreso (0 = desactivado)."""
        try:
            return max(0, int(self.data.get("autosave_minutes", 10)))
        except (TypeError, ValueError):
            return 10

    @property
    def remember_session(self) -> bool:
        """¿Conservar el token al cerrar el launcher (auto-login al abrir)?

        Default **False** (cyber-café): al CERRAR se borra el token guardado
        y al ABRIR cada quien hace LOGIN. ``true`` → auto-login como siempre.
        Lectura ESTRICTA (fallar en seguro): solo un booleano True, el número
        1 o los textos "true"/"1"/"yes"/"on"/"si" activan el recuerdo —
        cualquier otra basura → False (jamás se recuerda una sesión por
        un valor ambiguo escrito a mano en el config).
        """
        value = self.data.get("remember_session", False)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value == 1
        return str(value).strip().lower() in ("true", "1", "yes", "on", "si")

    @property
    def web_url(self) -> str:
        """URL de la web del ranking (enlaces RANKING WEB ↗ / WEB ↗).

        - Clave ausente (config viejo) → derivada del api_url VIGENTE
          (mismo host, puerto WEB_PORT de la web Vite).
        - Clave propia: manda y se normaliza (esquema garantizado, sin
          barra final; el puerto no se toca jamás).
        - ``""`` explícito → ``""``: los enlaces WEB se ocultan en la UI.
        """
        if "web_url" not in self.data or self.data.get("web_url") is None:
            return default_web_url(self.api_url)
        raw = str(self.data.get("web_url") or "").strip()
        if not raw:
            return ""  # vacío a propósito: el dueño oculta los enlaces
        return normalize_api_url(raw, default=default_web_url(self.api_url))

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
    # web_url: si el config es viejo (sin la clave) se DERIVA del api_url
    # vigente (mismo host, puerto de la web); si viene, se respeta tal cual
    # ('' explícito = enlaces ocultos; la propiedad normaliza al leer).
    if "web_url" not in raw:
        merged["web_url"] = default_web_url(merged["api_url"])
    # 'force_nick' quedó obsoleto (el nick SIEMPRE se fuerza) y el polling
    # de candidatos desapareció (auto-link server-side): se purgan en
    # silencio para que no vuelvan al archivo al guardar.
    merged.pop("force_nick", None)
    merged.pop("link_poll_interval", None)
    merged.pop("link_poll_max_seconds", None)
    log.info("Config cargada desde %s (api_url=%s)", path, merged["api_url"])
    return AppConfig(merged)
