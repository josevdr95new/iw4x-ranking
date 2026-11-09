"""Exportación de clases de loadout (customClasses) al perfil web.

Idea aprobada del dueño: el launcher inyecta el comando nativo
``+dumpPlayerData`` al arrancar el juego (igual que ``+unlockstats`` y
``+connect``) y al terminar la sesión LEE el ``console_mp.log`` del CLIENTE,
extrae el dump de clases y lo sube a ``POST /api/players/classes`` → las 15
clases del jugador aparecen en su perfil web SIN pasos manuales.

Ubicación del log del CLIENTE (hallazgo real en la PC del dueño, por mtimes y
cabecera de cada archivo):
- ``<game>\\main\\console_mp.log``     → log del CLIENTE: lo escribe el cliente
  al arrancar sin ``fs_game`` (cabecera con el comando vacío, SIN
  ``-dedicated``). Es donde cae el dump del ``+dumpPlayerData`` inyectado.
- ``<game>\\userraw\\console_mp.log``  → log del SERVER dedicado (su primera
  línea trae ``-dedicated``): JAMÁS se usa.
- ``<game>\\mods\\<mod>\\console_mp.log`` → logs de servers dedicados con mod
  (también ``-dedicated`` en la cabecera): descartados por la misma regla.
- ``<game>\\console_mp.log`` y ``%LOCALAPPDATA%\\iw4x\\console_mp.log`` →
  candidatos normativos (raíz del juego / homepath de cliente); hoy no existen
  en la PC del dueño pero se escanea por si el engine los crea en otra build.

Regla de detección (``find_client_dump_log``): un candidato cuenta SOLO si su
texto contiene una sección ``customClasses`` con contenido real (``name = "`/
``_deathstreak`` / ``weaponSetups`` / ``specialGrenade``) y su cabecera NO es
de server (``-dedicated``); de los válidos gana el de mtime más reciente.

Filosofía cloud-sync: la exportación es best-effort — un error de la API es un
WARNING sin bloquear, la API caída es un skip silencioso dim (solo al archivo
de log) y NUNCA se impide jugar ni cerrar. El hash del texto subido se
persiste (``classes-export.json``) para no repetir la subida si el dump no
cambió desde la última vez.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Callable, Iterable, List, Optional

from api_client import ApiError, NetworkError
from logging_setup import app_data_dir

log = logging.getLogger("classes_export")

# Cap del body (contrato API: 1..900_000 chars): enviamos los ÚLTIMOS 800k.
MAX_DUMP_CHARS = 800_000

# Marcador de la sección que imprime /dumpPlayerData en el console_mp.log.
DUMP_MARKER = "customClasses"

# Líneas que prueban contenido REAL de la sección (árbol DDL de clases):
# el nombre entre comillas, el deathstreak y los subtítulos weaponSetups /
# specialGrenade solo existen dentro del dump (un log sin ellos no es un dump).
_DUMP_CONTENT_RE = re.compile(
    r'(name\s*=\s*"|_deathstreak\s*=|weaponSetups|specialGrenade\s*=)'
)

# Cabecera de log de SERVER dedicado (solo se mira el inicio del archivo).
_SERVER_HEADER_RE = re.compile(r"-dedicated")

# Línea EXACTA del marcador dentro del log, con o sin timestamp de consola
# ("customClasses" o "[  18215383]     customClasses").
_MARKER_LINE_RE = re.compile(
    r"^\s*(?:\[\s*\d+\])?\s*" + DUMP_MARKER + r"\s*$", re.M,
)


def is_server_log(text: str) -> bool:
    """¿El texto parece log de SERVER dedicado? (cabecera ``-dedicated``).

    El server dedicado también escribe console_mp.log (y ejecutaría el dump
    de SU playerdata local, vacío): la cabecera lo delata y lo excluye.
    """
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    return bool(_SERVER_HEADER_RE.search(text[:2000]))


def has_classes_dump(text: str) -> bool:
    """¿El texto contiene una sección customClasses CON contenido real?

    Requiere la línea del marcador (con o sin timestamp) y, DESPUÉS de ella,
    alguna línea propia del árbol de clases. Un "customClasses" suelto en
    otra línea de chat/consola NO cuenta.
    """
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    m = _MARKER_LINE_RE.search(text)
    if m is None:
        return False
    return _DUMP_CONTENT_RE.search(text[m.end():]) is not None


def candidate_log_paths(game_dir: str = "") -> List[str]:
    """Candidatos de console_mp.log del CLIENTE (existentes o no).

    El orden no importa: la decisión de ``find_client_dump_log`` es por
    contenido + mtime. Se incluyen la raíz del juego, ``main\\`` (el hallazgo
    real del cliente), ``userraw\\`` (server; la regla lo descarta), cada
    ``mods\\<mod>\\`` (servers con mod) y ``%LOCALAPPDATA%\\iw4x\\``.
    """
    out: List[str] = []
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    out.append(str(Path(base) / "iw4x" / "console_mp.log"))
    if game_dir:
        gd = Path(game_dir)
        out.append(str(gd / "console_mp.log"))
        out.append(str(gd / "main" / "console_mp.log"))
        out.append(str(gd / "userraw" / "console_mp.log"))
        mods = gd / "mods"
        try:
            if mods.is_dir():
                for d in sorted(mods.iterdir()):
                    if d.is_dir():
                        out.append(str(d / "console_mp.log"))
        except OSError:
            pass  # best-effort: sin listar mods, quedan los candidatos fijos
    return out


def find_client_dump_log(paths: Iterable[str]) -> Optional[str]:
    """El log del CLIENTE con dump de clases más RECIENTE (str o None).

    Descarta: inexistentes/ilegibles, logs de server (``-dedicated`` en la
    cabecera — aunque sean los más nuevos) y textos sin la sección con
    contenido real. De los válidos gana el mayor mtime.
    """
    best: Optional[Path] = None
    best_mtime = -1.0
    seen: set = set()
    for p in paths:
        try:
            path = Path(p)
        except (TypeError, ValueError):
            continue
        key = str(path)
        if key in seen or not path.is_file():
            continue
        seen.add(key)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not has_classes_dump(text) or is_server_log(text):
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime > best_mtime:
            best, best_mtime = path, mtime
    return str(best) if best is not None else None


def read_dump_text(path: str, max_chars: int = MAX_DUMP_CHARS) -> Optional[str]:
    """Últimos ``max_chars`` caracteres del log (cap del contrato del body).

    El dump se imprime al INICIALIZAR el juego, así que el tail del log
    contiene la sección aunque la sesión haya seguido escribiendo después.
    None si el archivo es ilegible.
    """
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text[-max_chars:] if len(text) > max_chars else text


def dump_hash(dump_text: str) -> str:
    """SHA-256 hex del texto a subir — la clave anti-repetición."""
    return hashlib.sha256(
        dump_text.encode("utf-8", errors="replace")).hexdigest()


def decide_classes_upload(has_dump: bool, text_hash: str,
                          last_hash: Optional[str]) -> bool:
    """Decisión pura de subida (misma filosofía del resto del sync).

    Sube SOLO si hay dump real (``has_dump``) con hash válido y su hash es
    DISTINTO al último subido (``last_hash`` None = nunca subió).
    """
    if not has_dump or not text_hash:
        return False
    return text_hash != last_hash


# --- Store persistente del último hash subido -------------------------------
def default_store_path() -> Path:
    """%APPDATA%\\iw4x-ranking-launcher\\classes-export.json."""
    return app_data_dir() / "classes-export.json"


def load_classes_hash(store_path: Optional[Path] = None) -> Optional[str]:
    """Último hash subido (None si no hay store, está roto o ilegible)."""
    path = Path(store_path) if store_path is not None else default_store_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict):
        h = data.get("sha256")
        if isinstance(h, str) and h:
            return h
    return None


def save_classes_hash(text_hash: str, store_path: Optional[Path] = None) -> bool:
    """Persiste el hash del dump recién subido (best-effort; True si pudo)."""
    path = Path(store_path) if store_path is not None else default_store_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"sha256": text_hash}, ensure_ascii=False),
            encoding="utf-8",
        )
        return True
    except OSError:
        log.warning("No se pudo guardar el hash de clases en %s", path,
                    exc_info=True)
        return False


def export_player_classes(api, token: str, game_dir: str,
                          log_cb: Optional[Callable[[str], None]] = None,
                          store_path: Optional[Path] = None,
                          paths: Optional[Iterable[str]] = None) -> str:
    """Orquestación: localizar log → ¿dump nuevo? → POST /players/classes.

    Devuelve ``"uploaded" | "noop" | "no-dump" | "error"``. NUNCA lanza por
    red/API/disco: un ApiError es un WARNING visible (log_cb) sin bloquear; la
    API caída (NetworkError) es un skip silencioso dim (solo al archivo de
    log); sin dump ni log de cliente → ``"no-dump"`` sin tocar la API.
    ``paths`` permite inyectar los candidatos (tests); por defecto se derivan
    de ``game_dir`` + %LOCALAPPDATA%.
    """

    def say(msg: str) -> None:
        if log_cb is not None:
            log_cb(msg)

    candidates = list(paths) if paths is not None \
        else candidate_log_paths(game_dir)
    dump_log = find_client_dump_log(candidates)
    if dump_log is None:
        log.info("classes: sin console_mp.log de cliente con dump (nada que subir)")
        return "no-dump"
    dump_text = read_dump_text(dump_log)
    if not dump_text or not has_classes_dump(dump_text):
        log.info("classes: el log %s no trae la sección legible", dump_log)
        return "no-dump"
    text_hash = dump_hash(dump_text)
    if not decide_classes_upload(True, text_hash, load_classes_hash(store_path)):
        log.info("classes: dump sin cambios desde la última subida (skip)")
        return "noop"
    try:
        api.upload_classes(token, dump_text)
    except NetworkError as exc:
        # API caída: skip silencioso dim (solo al archivo de log), como el
        # cloud-sync — no ensucia la consola del launcher.
        log.info("classes: API caída — subida de clases omitida (%s)", exc)
        return "error"
    except ApiError as exc:
        say(f"⚠ Exportación de clases omitida: la API respondió "
            f"{exc.status}: {exc.message}")
        return "error"
    except OSError as exc:
        say(f"⚠ Exportación de clases omitida: {exc}")
        return "error"
    save_classes_hash(text_hash, store_path)
    log.info("classes: dump subido desde %s (%d chars)", dump_log, len(dump_text))
    say("Clases exportadas a tu perfil web ✓")
    return "uploaded"
