"""Cloud-sync del progreso del juego (iw4x.stat / iw4x_config.cfg / mods).

Reglas de decisión (``decide_sync``, pura y testeable):
- local vacío/ausente y server con save → DOWNLOAD.
- hash idéntico en TODOS los archivos → NOOP.
- difieren → gana el MÁS RECIENTE (mtime local vs manifest.updatedAt);
  empate sin ganador claro → NOOP por seguridad.
- server sin save y local con progreso → UPLOAD.

Regla de oro: el juego hace flush del .stat al fin de ronda, así que la
subida solo se hace con iw4x.exe cerrado (el launcher espera al proceso).

Las funciones ``sync_before_launch`` / ``sync_after_session`` son la
orquestación (API + disco + logs); ``GameFlow`` las invoca y NUNCA deja que
un error de sync bloquee jugar.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("save_sync")

# Lock GLOBAL de subidas de saves: en TODO el launcher (post-sesión del
# GameFlow, auto-guardado periódico y cierre) hay COMO MÁXIMO UN PUT de
# progreso en vuelo — nunca dos subidas concurrentes del mismo save.
UPLOAD_LOCK = threading.Lock()

# Archivos de save reconocidos (whitelist del server).
GUID_REL = "guid.dat"          # IDENTIDAD: %LOCALAPPDATA%\iw4x\guid.dat
BASE_FILES = ("iw4x.stat", "iw4x_config.cfg")
MAX_FILES = 24
MAX_FILE_BYTES = 256 * 1024


def default_guid_path() -> str:
    """Ruta real del GUID de IW4x en esta PC (%LOCALAPPDATA%\\iw4x\\guid.dat)."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return str(Path(base) / "iw4x" / "guid.dat")


# ---------------------------------------------------------------------------
# Puras: mapeo, hashes y decisión
# ---------------------------------------------------------------------------
def local_save_files(game_dir: str, mods: Optional[List[str]] = None,
                     guid_path: Optional[str] = None) -> Dict[str, str]:
    """Mapa {relpath: absPath} de los saves locales.

    - ``guid.dat`` (IDENTIDAD): %LOCALAPPDATA%\\iw4x\\guid.dat, con path
      top-level en el manifiesto. Inyectable con ``guid_path`` para tests.
    - Base: ``iw4x.stat`` e ``iw4x_config.cfg`` en ``<game_dir>\\players\\``.
    - Mods: ``mods/<mod>/iw4x.stat`` y ``mods/<mod>/iw4x_config.cfg`` — si
      ``mods`` es None se enumeran los subdirectorios de ``players\\mods``
      dinámicamente (sin carpeta mods, solo base + guid).
    Los paths pueden no existir: el mapeo es puro. guid.dat va PRIMERO:
    en la capa de caps (≤24) la identidad nunca se recorta.
    """
    guid = guid_path or default_guid_path()
    base = Path(game_dir) / "players"
    out: Dict[str, str] = {GUID_REL: guid}
    for rel in BASE_FILES:
        out[rel] = str(base / rel)
    if mods is None:
        mods_dir = base / "mods"
        mods = (sorted(d.name for d in mods_dir.iterdir() if d.is_dir())
                if mods_dir.is_dir() else [])
    for mod in mods:
        out[f"mods/{mod}/iw4x.stat"] = str(base / "mods" / mod / "iw4x.stat")
        out[f"mods/{mod}/iw4x_config.cfg"] = str(base / "mods" / mod / "iw4x_config.cfg")
    return out


def detect_build(game_dir: str) -> Optional[str]:
    """Versión del juego si existe un archivo de versión barato de leer.

    Busca ``version.txt`` / ``build.txt`` en el dir del juego (primera línea,
    hasta 64 chars). Si no hay, devuelve None y el PUT omite el campo — el
    backend lo trata como opcional.
    """
    for name in ("version.txt", "build.txt"):
        p = Path(game_dir) / name
        if p.is_file():
            try:
                first = (p.read_text(encoding="utf-8", errors="replace")
                         .strip().splitlines() or [""])[0].strip()
                return first[:64] or None
            except OSError:
                return None
    return None


def sha256_of(path: str) -> Optional[str]:
    """SHA-256 hex del contenido; None si el archivo no existe/ilegible."""
    p = Path(path)
    if not p.is_file():
        return None
    try:
        digest = hashlib.sha256()
        with p.open("rb") as fh:
            for chunk in iter(lambda: fh.read(64 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def newest_mtime(paths: List[str]) -> Optional[float]:
    """mtime (epoch float) del archivo más nuevo; None si ninguno existe."""
    mtimes = [p.stat().st_mtime for p in map(Path, paths) if p.is_file()]
    return max(mtimes) if mtimes else None


def _iso_to_epoch(iso: Optional[str]) -> Optional[float]:
    """ISO-8601 UTC → epoch segundos; None si no parsea."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def decide_sync(manifest: Optional[Dict[str, Any]],
                local_hashes: Dict[str, str],
                local_mtime: Optional[float] = None) -> Tuple[str, Dict[str, Any]]:
    """Decide la acción de sync (pura). Devuelve (acción, detalle).

    Acciones: "download" | "upload" | "noop". ``local_hashes`` contiene SOLO
    los archivos que existen localmente (rel → sha256); ``local_mtime`` es el
    mtime más nuevo local (epoch) para el desempate por recencia.
    """
    data = manifest if isinstance(manifest, dict) else {}
    server_files = [f for f in (data.get("files") or []) if isinstance(f, dict)]
    server_hashes = {f.get("path"): f.get("sha256") for f in server_files}
    server_exists = bool(data.get("exists")) and bool(server_hashes)
    has_local = any(local_hashes.values())

    union = sorted(set(server_hashes) | set(local_hashes.keys()))
    diff = [p for p in union
            if (server_hashes.get(p) or None) != (local_hashes.get(p) or None)]

    if not server_exists:
        if has_local:
            return "upload", {"why": "el server no tenía save y tu PC sí tiene progreso",
                              "diff_paths": sorted(local_hashes.keys())}
        return "noop", {"why": "no hay progreso local ni en el server"}

    if not has_local:
        return "download", {"why": "tu PC no tiene progreso y el server sí",
                            "diff_paths": diff}

    if not diff:
        return "noop", {"why": "tu progreso ya está al día"}

    server_epoch = _iso_to_epoch(data.get("updatedAt"))
    if local_mtime is not None and server_epoch is not None:
        if local_mtime > server_epoch:
            return "upload", {"why": "tu progreso local es más nuevo que el del server",
                              "diff_paths": diff}
        if server_epoch > local_mtime:
            return "download", {"why": "el progreso del server es más nuevo que el de tu PC",
                                "diff_paths": diff}

    return "noop", {"why": "hay diferencias pero las fechas no dan ganador "
                           "claro; no se toca nada por seguridad",
                    "diff_paths": diff}


def build_upload_files(local_paths: Dict[str, str],
                       max_files: int = MAX_FILES,
                       max_size: int = MAX_FILE_BYTES
                       ) -> Tuple[List[Dict[str, str]], List[str]]:
    """Construye el payload PUT ({path, dataBase64, sha256}) desde disco.

    Respeta las caps del contrato (≤12 archivos, ≤256KB c/u): los archivos
    que excedan se devuelven en ``skipped`` para loggearlos. El orden de
    ``local_paths`` define la prioridad (base primero, mods después).
    """
    payloads: List[Dict[str, str]] = []
    skipped: List[str] = []
    for rel, path in local_paths.items():
        p = Path(path)
        if not p.is_file():
            continue
        data = p.read_bytes()
        if len(payloads) >= max_files:
            skipped.append(rel)
            continue
        if len(data) > max_size:
            skipped.append(rel)
            continue
        payloads.append({
            "path": rel,
            "dataBase64": base64.b64encode(data).decode("ascii"),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    return payloads, skipped


def backup_local_files(local_paths: Dict[str, str],
                       backup_root: Optional[Path]) -> Optional[Path]:
    """Copia los saves existentes a ``backup_root`` (antes de sobreescribir).

    Devuelve el directorio de backup creado, o None si no había nada que
    copiar / no se indicó raíz. Los archivos faltantes se ignoran.
    """
    if backup_root is None:
        return None
    existing = {rel: p for rel, p in local_paths.items() if Path(p).is_file()}
    if not existing:
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = Path(backup_root) / stamp
    dest.mkdir(parents=True, exist_ok=True)
    for rel, src in existing.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    return dest


# ---------------------------------------------------------------------------
# Orquestación (API + disco + logs). Errores: los propaga; GameFlow envuelve.
# ---------------------------------------------------------------------------
def _local_hashes_and_mtime(game_dir: str,
                            guid_path: Optional[str] = None
                            ) -> Tuple[Dict[str, str], Optional[float]]:
    paths = local_save_files(game_dir, guid_path=guid_path)
    local_hashes = {rel: h for rel, p in paths.items()
                    if (h := sha256_of(p))}
    local_mtime = newest_mtime([p for p in paths.values() if Path(p).exists()])
    return local_hashes, local_mtime


def sync_before_launch(api, token: str, game_dir: str,
                       log: Callable[[str], None],
                       backup_root: Optional[Path] = None,
                       guid_path: Optional[str] = None) -> str:
    """PRE-lanzamiento: deja el progreso del server listo en disco.

    Descarga tb el guid.dat si el server lo tiene (identidad IW4x: mismo
    GUID en cualquier PC). Devuelve la acción realizada
    ("download" | "upload" | "noop"). Los errores (red/API/disco) propagan:
    el caller los trata como WARNING.
    """
    paths = local_save_files(game_dir, guid_path=guid_path)
    local_hashes, local_mtime = _local_hashes_and_mtime(game_dir, guid_path)
    manifest = api.save_manifest(token)
    action, detail = decide_sync(manifest, local_hashes, local_mtime)
    log(f"Sincronizando tu progreso con la cuenta… ({detail['why']})")

    if action == "download":
        log("Bajando tu progreso del server…")
        version = manifest.get("version")
        backup_local_files(
            {rel: p for rel, p in paths.items() if Path(p).exists()},
            backup_root,
        )
        written = 0
        guid_restored = False
        for f in manifest.get("files") or []:
            rel = str(f.get("path") or "")
            if not rel:
                continue
            data = api.save_download(token, rel, version=str(version) if version else None)
            target = Path(paths.get(rel) or (Path(game_dir) / "players" / rel))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            written += 1
            if rel == GUID_REL:
                guid_restored = True
        log("Progreso listo (nivel y armas de tu cuenta) ✓")
        if guid_restored:
            log("Identidad IW4x (GUID) restaurada de tu cuenta ✓")
        log(f"[detalle] {written} archivo(s) restaurados desde el server.")
        return "download"

    if action == "upload":
        log("Subiendo progreso local más nuevo…")
        payloads, skipped = build_upload_files(
            {rel: paths[rel] for rel in local_hashes.keys()}
        )
        if skipped:
            log(f"⚠ Se omitieron {len(skipped)} archivo(s) fuera de límites: "
                f"{', '.join(skipped)}")
        result = api.save_upload(token, payloads, build=detect_build(game_dir))
        if result.get("saved"):
            log("Progreso subido a tu cuenta ✓")
        else:
            log("Sin cambios en tu progreso.")
        return "upload"

    log("Tu progreso ya está al día ✓")
    return "noop"


def sync_after_session(api, token: str, game_dir: str,
                       log: Callable[[str], None],
                       guid_path: Optional[str] = None) -> str:
    """POST-sesión (iw4x.exe cerrado): sube el progreso generado al jugar.

    NUNCA descarga aquí: el server no puede ser más nuevo que lo que el
    jugador acaba de generar; si lo estuviera, se respeta en el próximo
    arranque y se avisa por log.
    """
    local_paths = local_save_files(game_dir, guid_path=guid_path)
    local_hashes, local_mtime = _local_hashes_and_mtime(game_dir, guid_path)
    if not local_hashes:
        log("Sin cambios en tu progreso.")
        return "noop"

    manifest = api.save_manifest(token)
    action, detail = decide_sync(manifest, local_hashes, local_mtime)

    if action == "upload":
        log("Subiendo tu progreso a la cuenta…")
        payloads, skipped = build_upload_files(
            {rel: local_paths[rel] for rel in local_hashes.keys()}
        )
        if skipped:
            log(f"⚠ Se omitieron {len(skipped)} archivo(s) fuera de límites: "
                f"{', '.join(skipped)}")
        result = api.save_upload(token, payloads, build=detect_build(game_dir))
        if result.get("saved"):
            log("Progreso guardado en tu cuenta ✓")
        else:
            log("Sin cambios en tu progreso.")
        return "upload"

    if action == "download":
        log("⚠ El server tenía un progreso más nuevo que esta sesión; "
            "se respetará en el próximo arranque.")
        return "download"

    log("Sin cambios en tu progreso.")
    return "noop"
