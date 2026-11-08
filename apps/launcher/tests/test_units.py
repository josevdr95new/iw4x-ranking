"""Tests UNITARIOS del launcher: solo funciones puras, sin red y sin GUI.

Uso:
    py apps\\launcher\\tests\\test_units.py

Qué verifica (mismo estilo [OK]/[FALLO] que test_smoke.py):
  1. save_sync (puras): local_save_files (mapeo base/mods/guid),
      sha256_of, decide_sync (matriz completa de decisión), build_upload_files
      (caps ≤24 archivos / ≤256KB, guid primero), detect_build.
  2. save_sync: aislamiento de identidad por cuenta (fix cyber-café):
      decide_guid_action (restore/quarantine/none + manifest None) y
      quarantine_local_guid (movimiento a cuarentena, rutas inyectadas).
  3. game_flow: build_game_args (nick SIEMPRE forzado con +set name).
  4. app_config: DEFAULT_CONFIG y el merge de claves (propiedades con
      defaults, acotes y limpieza de servers inválidos).
  5. app_config: normalize_api_url (esquema http:// faltante, barra final,
      espacios, vacío → default; JAMÁS inventa/corrige puertos).

NO es pytest: es un script secuencial que imprime [OK]/[FALLO] por paso.
Las suites E2E/GUI (API real, CustomTkinter) viven en tests/test_smoke.py
"""
from __future__ import annotations

import hashlib
import re
import sys
import tempfile
import time
import traceback
from pathlib import Path
from subprocess import TimeoutExpired

# Importa los módulos del launcher (directorio padre, sin depender del cwd).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app_config import AppConfig, DEFAULT_CONFIG, normalize_api_url  # noqa: E402
import game_flow as gf  # noqa: E402
from game_flow import build_game_args  # noqa: E402
import save_sync as ss  # noqa: E402
from save_sync import (  # noqa: E402
    build_upload_files,
    decide_guid_action,
    decide_sync,
    local_save_files,
    quarantine_local_guid,
    sha256_of,
)

RESULTS: list = []


def check(name, cond, extra=""):
    tag = "OK   " if cond else "FALLO"
    RESULTS.append(f"[{tag}] {name}" + (f" — {extra}" if extra and not cond else ""))
    print(f"[{tag}] {name}" + (f" — {extra}" if extra else ""))


# ---------------------------------------------------------------------------
# 1. save_sync: aislamiento de identidad por cuenta (fix cyber-café).
def phase_guid_isolation() -> None:
    print("\n=== Units: decide_guid_action / quarantine_local_guid ===")

    manifest_con_guid = {"exists": True, "version": 3,
                         "updatedAt": "2026-11-07T10:00:00.000Z",
                         "files": [{"path": "iw4x.stat", "sha256": "AAA"},
                                   {"path": "guid.dat", "sha256": "GGG"}]}
    manifest_sin_guid = {"exists": True, "version": 3,
                         "updatedAt": "2026-11-07T10:00:00.000Z",
                         "files": [{"path": "iw4x.stat", "sha256": "AAA"}]}

    # Regla 1: manifest con guid.dat → restore (sync ya baja la identidad).
    check("decide_guid: manifest con guid.dat → restore (con local)",
          decide_guid_action(manifest_con_guid, True) == "restore")
    check("decide_guid: manifest con guid.dat → restore (sin local)",
          decide_guid_action(manifest_con_guid, False) == "restore")

    # Regla 2: manifest sin guid.dat + local → QUARANTINE (fix cyber-café).
    check("decide_guid: manifest sin guid.dat + local → quarantine",
          decide_guid_action(manifest_sin_guid, True) == "quarantine")
    check("decide_guid: exists:false (server vacío) + local → quarantine",
          decide_guid_action({"exists": False}, True) == "quarantine")
    check("decide_guid: files con basura se ignoran con seguridad",
          decide_guid_action({"exists": True, "files": ["x", 3, None]}, True)
          == "quarantine")

    # Regla 3: manifest sin guid.dat y sin local → none (juego crea el 1º).
    check("decide_guid: manifest sin guid.dat y sin local → none",
          decide_guid_action(manifest_sin_guid, False) == "none")

    # Manifest None (pura, caso pedido): se trata como server sin identidad.
    check("decide_guid: manifest None + local → quarantine",
          decide_guid_action(None, True) == "quarantine")
    check("decide_guid: manifest None + sin local → none",
          decide_guid_action(None, False) == "none")

    # --- quarantine_local_guid: mueve el guid.dat a cuarentena (rutas
    #     inyectadas; JAMÁS toca el %LOCALAPPDATA% o %APPDATA% real) ---------
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-quarantine-"))
    guid_path = tmp / "localapp" / "iw4x" / "guid.dat"
    guid_path.parent.mkdir(parents=True)
    guid_path.write_bytes(b"GUID-DE-OTRO-JUGADOR")
    root = tmp / "quarantine"
    dest = quarantine_local_guid(str(guid_path), user_id="u-123", root=root)
    moved = root / "guid.dat" if dest is None else dest / "guid.dat"
    check("quarantine: mueve el guid.dat y devuelve la carpeta destino",
          dest is not None and moved.is_file()
          and moved.read_bytes() == b"GUID-DE-OTRO-JUGADOR", str(dest))
    check("quarantine: carpeta <userId>-<ts> dentro de la raíz inyectada",
          dest is not None and dest.parent == root
          and re.fullmatch(r"u-123-\d{8}-\d{6}", dest.name) is not None,
          dest.name if dest is not None else str(dest))
    check("quarantine: la ruta original queda SIN guid.dat",
          not guid_path.exists())
    check("quarantine: sin guid.dat local → None sin crear nada",
          quarantine_local_guid(str(guid_path), user_id="u-123", root=root)
          is None)
    guid_path.write_bytes(b"x")
    dest2 = quarantine_local_guid(str(guid_path), root=root)
    check("quarantine: sin userId → carpeta 'sin-cuenta-<ts>'",
          dest2 is not None and dest2.name.startswith("sin-cuenta-"),
          dest2.name if dest2 is not None else str(dest2))


# ---------------------------------------------------------------------------
# 2. save_sync: puras de mapeo, hashes, decisión, caps y build.
def phase_save_sync_pure() -> None:
    print("\n=== Units: save_sync (puras) ===")
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-units-"))

    # --- Puras: mapeo de paths con mods dinámicos ---------------------------
    game_dir = tmp / "game"
    (game_dir / "players" / "mods" / "m1").mkdir(parents=True)
    (game_dir / "players" / "iw4x.stat").write_bytes(b"local")
    guid_path = str(tmp / "localapp" / "iw4x" / "guid.dat")
    m = local_save_files(str(game_dir), guid_path=guid_path)
    check("mapeo: guid.dat + 2 base + stat y config de mods dinámicos",
          set(m) == {"guid.dat", "iw4x.stat", "iw4x_config.cfg",
                     "mods/m1/iw4x.stat", "mods/m1/iw4x_config.cfg"},
          str(set(m)))
    check("mapeo: guid.dat apunta a la ruta inyectada",
          m["guid.dat"] == guid_path, m["guid.dat"])
    m2 = local_save_files(str(game_dir), mods=["m2"], guid_path=guid_path)
    check("mapeo: mods inyectados (stat y config, solo los pedidos)",
          "mods/m2/iw4x.stat" in m2 and "mods/m2/iw4x_config.cfg" in m2
          and "mods/m1/iw4x.stat" not in m2, str(set(m2)))
    m3 = local_save_files(str(tmp / "vacio"))
    check("mapeo: sin carpeta mods → guid + 2 base",
          set(m3) == {"guid.dat", "iw4x.stat", "iw4x_config.cfg"}, str(set(m3)))
    from save_sync import default_guid_path
    check("mapeo: guid por defecto vive en %LOCALAPPDATA%\\iw4x\\guid.dat",
          default_guid_path().lower().endswith("iw4x\\guid.dat"),
          default_guid_path())

    # --- Puras: hashes -------------------------------------------------------
    f = tmp / "f.bin"
    f.write_bytes(b"abc")
    check("sha256_of contenido conocido",
          sha256_of(str(f)) == hashlib.sha256(b"abc").hexdigest())
    check("sha256_of inexistente → None",
          sha256_of(str(tmp / "nope")) is None)

    # --- Puras: matriz de decisión -------------------------------------------
    full = {"exists": True, "version": 5,
            "updatedAt": "2026-11-07T10:00:00.000Z",
            "files": [{"path": "iw4x.stat", "sha256": "AAA"},
                      {"path": "iw4x_config.cfg", "sha256": "BBB"}]}
    a, _ = decide_sync(full, {})
    check("decide: local vacío + server → download", a == "download", a)
    a, _ = decide_sync(None, {"iw4x.stat": "AAA"})
    check("decide: server sin save + local → upload", a == "upload", a)
    a, _ = decide_sync({"exists": False}, {"iw4x.stat": "AAA"})
    check("decide: exists:false + local → upload", a == "upload", a)
    a, _ = decide_sync(full, {"iw4x.stat": "AAA", "iw4x_config.cfg": "BBB"})
    check("decide: hashes idénticos en TODOS → noop", a == "noop", a)
    # Difieren → gana el más reciente (epochs derivados del ISO del server).
    server_epoch = ss._iso_to_epoch("2026-11-07T10:00:00.000Z")
    differing = {"iw4x.stat": "ZZZ", "iw4x_config.cfg": "BBB"}
    a, _ = decide_sync(full, differing, local_mtime=server_epoch + 3600)
    check("decide: difieren + local más nuevo → upload", a == "upload", a)
    a, _ = decide_sync(full, differing, local_mtime=server_epoch - 3600)
    check("decide: difieren + server más nuevo → download", a == "download", a)

    # Empate EXACTO: usamos el mismo epoch que deriva el módulo del ISO del
    # server (10:00 UTC), sin conversiones locales ambiguas.
    tie = server_epoch
    a, _ = decide_sync(full, {"iw4x.stat": "ZZZ", "iw4x_config.cfg": "BBB"},
                       local_mtime=tie)
    check("decide: empate de fechas → noop por seguridad", a == "noop", a)

    # --- Puras: caps (guid.dat SIEMPRE tiene prioridad en la capa) -------------
    cap_dir = tmp / "caps"
    cap_dir.mkdir(parents=True)
    Path(guid_path).parent.mkdir(parents=True, exist_ok=True)
    Path(guid_path).write_bytes(b"GUID")
    (cap_dir / "iw4x.stat").write_bytes(b"s-base")
    (cap_dir / "iw4x_config.cfg").write_bytes(b"c-base")
    many = {"guid.dat": guid_path,
            "iw4x.stat": str(cap_dir / "iw4x.stat"),
            "iw4x_config.cfg": str(cap_dir / "iw4x_config.cfg")}
    for i in range(14):
        p = cap_dir / f"mod{i}.stat"
        p.write_bytes(b"s%d" % i)
        many[f"mods/m{i}/iw4x.stat"] = str(p)
    accepted, skipped = build_upload_files(many, max_files=24, max_size=256 * 1024)
    check("caps: 17 archivos (guid primero) entran en la capa de 24",
          len(accepted) == 17 and skipped == []
          and accepted[0]["path"] == "guid.dat", f"{len(accepted)}/{len(skipped)}")
    many2 = dict(many)
    for i in range(16):  # +16 mods → 33 archivos > 24: se recortan mods
        p = cap_dir / f"x{i}.stat"
        p.write_bytes(b"x")
        many2[f"mods/x{i}/iw4x.stat"] = str(p)
    accepted, skipped = build_upload_files(many2, max_files=24, max_size=256 * 1024)
    check("caps: >24 archivos → guid.dat y base nunca se recortan",
          len(accepted) == 24
          and {"guid.dat", "iw4x.stat", "iw4x_config.cfg"}
          <= {a["path"] for a in accepted}
          and all(s.startswith("mods/x") for s in skipped),
          f"{len(accepted)} aceptados, {len(skipped)} omitidos")
    big = tmp / "grande.stat"
    big.write_bytes(b"x" * (256 * 1024 + 1))
    accepted, skipped = build_upload_files({"iw4x.stat": str(big)})
    check("caps: archivo >256KB → omitido",
          accepted == [] and skipped == ["iw4x.stat"], f"{accepted} {skipped}")

    # --- detect_build (opcional, barato) ---------------------------------------
    gd_build = tmp / "conbuild"
    gd_build.mkdir()
    (gd_build / "version.txt").write_text("IW4x build 0.9.5\n", encoding="utf-8")
    check("detect_build: lee version.txt",
          ss.detect_build(str(gd_build)) == "IW4x build 0.9.5",
          str(ss.detect_build(str(gd_build))))
    gd_nob = tmp / "nobuild"
    gd_nob.mkdir()
    check("detect_build: sin archivo → None (PUT omite el campo)",
          ss.detect_build(str(gd_nob)) is None)


# ---------------------------------------------------------------------------
# 3. build_game_args: armado del comando (nick SIEMPRE forzado).
def phase_command_args() -> None:
    print("\n=== Units: comando de arranque (+set name siempre) ===")

    args = build_game_args(r"D:\Games\Call of Duty 6\iw4x.exe",
                           "192.168.2.251:28960", "Mandango ProMax")
    check("comando: exe primero, +connect último",
          args[0] == r"D:\Games\Call of Duty 6\iw4x.exe"
          and args[-1] == "192.168.2.251:28960", str(args))
    check("comando: +set name <nick> (con espacios) ANTES de +connect",
          args[1:5] == ["+set", "name", "Mandango ProMax", "+connect"], str(args))
    check("comando: lista plana de 6 argumentos (sin shell)",
          len(args) == 6 and all(isinstance(a, str) for a in args), str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "  Spam Bot  ")
    check("nick con espacios en extremos se recorta",
          args == ["iw4x.exe", "+set", "name", "Spam Bot", "+connect",
                   "1.2.3.4:28960"], str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "")
    check("sin nick la función no emite +set (GameFlow bloquea antes)",
          args == ["iw4x.exe", "+connect", "1.2.3.4:28960"], str(args))


# ---------------------------------------------------------------------------
# 4. app_config: defaults del contrato y merge de claves ausentes (puras).
def phase_app_config() -> None:
    print("\n=== Units: app_config (defaults / merge) ===")

    # Defaults del contrato (tabla del README).
    check("DEFAULT_CONFIG: claves del contrato completas",
          set(DEFAULT_CONFIG) >= {"api_url", "game_path", "servers",
                                  "default_server", "simulate_game",
                                  "cloud_save", "autosave_minutes"},
          str(sorted(DEFAULT_CONFIG)))
    check("DEFAULT_CONFIG: api_url de LAN y cloud_save activado",
          DEFAULT_CONFIG["api_url"] == "http://192.168.3.99:3000"
          and DEFAULT_CONFIG["cloud_save"] is True
          and DEFAULT_CONFIG["simulate_game"] is False, str(DEFAULT_CONFIG["api_url"]))
    check("DEFAULT_CONFIG: sin claves del polling de candidatos (eliminado)",
          not ({"link_poll_interval", "link_poll_max_seconds"} & set(DEFAULT_CONFIG)),
          str(sorted(DEFAULT_CONFIG)))

    # diccionario vacío → todas las propiedades caen al default.
    cfg = AppConfig({})
    check("AppConfig: dict vacío cae al api_url del contrato",
          cfg.api_url == DEFAULT_CONFIG["api_url"], cfg.api_url)
    check("AppConfig: dict vacío → game_path vacío y sin servers",
          cfg.game_path == "" and cfg.servers == [],
          f"{cfg.game_path!r} {cfg.servers}")
    check("AppConfig: dict vacío → default_server 0 y autosave 10",
          cfg.default_server == 0 and cfg.autosave_minutes == 10)

    # Merge: config vieja con claves faltantes → defaults por clave.
    cfg = AppConfig({"api_url": "http://localhost:3000"})
    check("app_config merge: clave ausente usa default, clave nueva manda",
          cfg.api_url == "http://localhost:3000" and cfg.cloud_save is True,
          cfg.api_url)
    cfg = AppConfig({"default_server": "basura"})
    check("app_config: default_server inválido → 0",
          cfg.default_server == 0, str(cfg.default_server))
    cfg = AppConfig({"api_url": "http://localhost:3000/"})
    check("app_config: barra final del api_url se recorta",
          not cfg.api_url.endswith("/"), cfg.api_url)
    cfg = AppConfig({"servers": ["basura", {"name": "LAN", "address": "1.1.1.1:1"},
                                 {"name": "sin-addr"}]})
    check("app_config: servers inválidos se filtran (solo {name,address})",
          cfg.servers == [{"name": "LAN", "address": "1.1.1.1:1"},], str(cfg.servers))


# ---------------------------------------------------------------------------
# 5. normalize_api_url: defensa contra configs escritos a mano (pura).
def phase_normalize_api_url() -> None:
    print("\n=== Units: normalize_api_url (esquema/barra; JAMÁS inventa puertos) ===")

    # Caso REAL del dueño: escribió "127.0.0.1:5173" (¡puerto de la WEB!) sin
    # esquema. La normalización solo añade http:// — el puerto se queda tal
    # cual está (el puerto es el que es; no se corrige ni se adivina).
    check("caso del dueño: '127.0.0.1:5173' → esquema añadido, puerto intacto",
          normalize_api_url("127.0.0.1:5173") == "http://127.0.0.1:5173",
          normalize_api_url("127.0.0.1:5173"))
    check("host:puerto sin esquema antepone http://",
          normalize_api_url("192.168.3.99:3000") == "http://192.168.3.99:3000",
          normalize_api_url("192.168.3.99:3000"))
    check("localhost:puerto sin esquema antepone http://",
          normalize_api_url("localhost:3000") == "http://localhost:3000",
          normalize_api_url("localhost:3000"))

    # Barra final: trim.
    check("barra final se recorta",
          normalize_api_url("http://127.0.0.1:3000/") == "http://127.0.0.1:3000",
          normalize_api_url("http://127.0.0.1:3000/"))
    check("múltiples barras finales se recortan",
          normalize_api_url("http://localhost:3000///") == "http://localhost:3000",
          normalize_api_url("http://localhost:3000///"))

    # Espacios y https explícito se respeta.
    check("espacios en extremos se recortan",
          normalize_api_url("  http://localhost:3000  ") == "http://localhost:3000",
          normalize_api_url("  http://localhost:3000  "))
    check("https:// explícito se respeta",
          normalize_api_url("https://api.midominio.com/")
          == "https://api.midominio.com",
          normalize_api_url("https://api.midominio.com/"))
    check("esquema en mayúsculas no se duplica",
          normalize_api_url("HTTP://localhost:3000") == "HTTP://localhost:3000",
          normalize_api_url("HTTP://localhost:3000"))

    # Vacío (o solo esquema) → default del contrato.
    default = DEFAULT_CONFIG["api_url"]
    check("vacío → default del contrato", normalize_api_url("") == default,
          normalize_api_url(""))
    check("solo espacios → default", normalize_api_url("   ") == default,
          normalize_api_url("   "))
    check("None → default", normalize_api_url(None) == default,
          normalize_api_url(None))
    check("esquema sin host ('http://') → default",
          normalize_api_url("http://") == default, normalize_api_url("http://"))

    # A través de AppConfig (lo que lee el launcher al arrancar).
    cfg = AppConfig({"api_url": "127.0.0.1:5173"})
    check("AppConfig: api_url sin esquema se normaliza al leer",
          cfg.api_url == "http://127.0.0.1:5173", cfg.api_url)
    cfg = AppConfig({"api_url": "http://localhost:3000/"})
    check("AppConfig: barra final se recorta al leer",
          not cfg.api_url.endswith("/"), cfg.api_url)
    cfg = AppConfig({"api_url": None})
    check("AppConfig: api_url None → default",
          cfg.api_url == default, cfg.api_url)


# ---------------------------------------------------------------------------
# 6. game_flow.kill_tree: taskkill /T /F del árbol SOLO por PID (stub).
def phase_kill_tree() -> None:
    print("\n=== Units: kill_tree (taskkill /T /F con stub de subprocess) ===")

    calls: list = []

    class FakeResult:
        def __init__(self, code: int) -> None:
            self.returncode = code

    def fake_run(cmd, **kwargs):
        calls.append((list(cmd), dict(kwargs)))
        return FakeResult(0)

    orig_run = gf.subprocess.run

    # Éxito: taskkill con /T /F y el PID correcto, sin shell y con timeout.
    gf.subprocess.run = fake_run
    try:
        ok = gf.kill_tree(4242)
        check("kill_tree: llama a taskkill con /T /F y el PID correcto",
              ok is True and len(calls) == 1
              and calls[0][0] == ["taskkill", "/PID", "4242", "/T", "/F"],
              str(calls))
        kw = calls[0][1]
        check("kill_tree: sin shell y con timeout corto (best-effort acotado)",
              not kw.get("shell") and isinstance(kw.get("timeout"), (int, float)),
              str(kw))
    finally:
        gf.subprocess.run = orig_run

    # taskkill falla (PID inexistente → returncode 128): False sin explotar.
    gf.subprocess.run = lambda cmd, **kw: FakeResult(128)
    try:
        check("kill_tree: taskkill con error (128) → False sin explotar",
              gf.kill_tree(4242) is False)
    finally:
        gf.subprocess.run = orig_run

    # taskkill lanza excepción (TimeoutExpired/OSError): False sin explotar.
    def boom(cmd, **kw):
        raise TimeoutExpired(cmd, 5)

    gf.subprocess.run = boom
    try:
        check("kill_tree: excepción de taskkill → False sin explotar",
              gf.kill_tree(4242) is False)
    finally:
        gf.subprocess.run = orig_run

    # PIDs basura: NUNCA se invoca taskkill (guard de argumento).
    calls.clear()
    gf.subprocess.run = fake_run
    try:
        check("kill_tree: pid inválido (0/None/'x'/negativo) → False sin llamar",
              gf.kill_tree(0) is False and gf.kill_tree(None) is False
              and gf.kill_tree("x") is False and gf.kill_tree(-3) is False
              and calls == [])
    finally:
        gf.subprocess.run = orig_run


# ---------------------------------------------------------------------------
# 7. game_flow.wait_process_exit: poll acotado a la muerte del proceso.
def phase_wait_process_exit() -> None:
    print("\n=== Units: wait_process_exit (poll ≤ timeout) ===")

    class FakeProc:
        """poll() devuelve None las primeras N veces y luego el código 0."""
        def __init__(self, alive_polls: int) -> None:
            self._left = alive_polls

        def poll(self):
            if self._left > 0:
                self._left -= 1
                return None
            return 0

    check("wait_process_exit: proceso que muere → True",
          gf.wait_process_exit(FakeProc(2), timeout=5, poll=0.01) is True)

    class Zombie:
        def poll(self):
            return None  # nunca muere

    t0 = time.monotonic()
    died = gf.wait_process_exit(Zombie(), timeout=0.2, poll=0.02)
    check("wait_process_exit: proceso que no muere → False dentro del plazo",
          died is False and (time.monotonic() - t0) < 2.0,
          f"{time.monotonic() - t0:.2f}s")

    class Broken:
        def poll(self):
            raise OSError("handle roto")

    check("wait_process_exit: poll() que explota → True (asume muerto)",
          gf.wait_process_exit(Broken(), timeout=5, poll=0.01) is True)


# ---------------------------------------------------------------------------
# 8. autosave: decisión de subida, caché, server más nuevo, lectura rota.
def phase_autosave() -> None:
    print("\n=== Units: autosave (decide_sync upload-only, caché, server nuevo) ===")
    import base64
    import tempfile

    from app_config import AppConfig
    from autosave import Autosave, collect_local_hashes

    # --- Config: autosave_minutes (default 10, 0 = off, acotado ≥0) ----------
    check("autosave config: clave nueva en DEFAULT_CONFIG (default 10)",
          DEFAULT_CONFIG.get("autosave_minutes") == 10,
          str(DEFAULT_CONFIG.get("autosave_minutes")))
    check("autosave config: dict vacío → 10; 'x' → 10",
          AppConfig({}).autosave_minutes == 10
          and AppConfig({"autosave_minutes": "x"}).autosave_minutes == 10)
    check("autosave config: 0 → 0 (off); negativo → acotado a 0",
          AppConfig({"autosave_minutes": 0}).autosave_minutes == 0
          and AppConfig({"autosave_minutes": -5}).autosave_minutes == 0)

    # --- Stub de API de saves con contadores (sin red) -----------------------
    from datetime import datetime, timedelta, timezone

    def iso_utc(offset_hours: float) -> str:
        """ISO-8601 UTC desplazado del reloj actual (tests sin depender del
        día: el manifiesto puede ser pasado o futuro a voluntad)."""
        dt = datetime.now(timezone.utc) + timedelta(hours=offset_hours)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    class StubSaveApi:
        def __init__(self, upload_offset_hours: float = 1.0) -> None:
            self.manifest_calls = 0
            self.upload_calls = 0
            self.store: dict = {}
            self.updated = "2026-11-07T10:00:00.000Z"
            # Cada PUT que cambia algo 'fresca' el manifiesto N horas al
            # futuro (o al pasado, con offset negativo, para simular server
            # viejo). Así la decisión nunca depende de la hora del día.
            self.upload_offset_hours = upload_offset_hours

        def save_manifest(self, token):
            self.manifest_calls += 1
            if not self.store:
                return {"exists": False}
            return {"exists": True, "version": 1, "updatedAt": self.updated,
                    "files": [{"path": p, "sha256": sha256_local(d)}
                              for p, d in sorted(self.store.items())]}

        def save_download(self, token, path, version=None):
            return self.store[path]

        def save_upload(self, token, files, build=None):
            self.upload_calls += 1
            changed = False
            for f in files:
                data = base64.b64decode(f["dataBase64"])
                if self.store.get(f["path"]) != data:
                    changed = True
                self.store[f["path"]] = data
            if changed:
                self.updated = iso_utc(self.upload_offset_hours)
            return {"saved": changed}

    def sha256_local(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    tmp = Path(tempfile.mkdtemp(prefix="iw4x-autosave-"))
    (tmp / "players").mkdir(parents=True)
    stat = tmp / "players" / "iw4x.stat"
    guid_tmp = str(tmp / "localapp" / "iw4x" / "guid.dat")

    def make(stub, minutes=10):
        logs: list = []
        a = Autosave(period_provider=lambda: minutes,
                     token_provider=lambda: "tok",
                     game_dir_provider=lambda: str(tmp),
                     cloud_provider=lambda: True,
                     api_provider=lambda: stub,
                     log_cb=logs.append, guid_path=guid_tmp)
        return a, logs

    # collect_local_hashes: hash correcto; ausente → fuera, SIN fallo.
    stat.write_bytes(b"PROGRESS-1")
    hashes, failed = collect_local_hashes(str(tmp), guid_path=guid_tmp)
    check("collect_local_hashes: hash del .stat correcto y sin fallos",
          hashes.get("iw4x.stat") == sha256_local(b"PROGRESS-1")
          and failed == [], f"{hashes} {failed}")
    hashes_missing, failed_missing = collect_local_hashes(
        str(tmp / "vacio"), guid_path=guid_tmp)
    check("collect_local_hashes: carpeta sin saves → sin hashes y sin fallos",
          hashes_missing == {} and failed_missing == [],
          f"{hashes_missing} {failed_missing}")

    # 1) local nuevo + server vacío → sube, log discreto exacto.
    stub = StubSaveApi(upload_offset_hours=1.0)
    a, logs = make(stub)
    r = a.tick()
    check("autosave: local nuevo + server vacío → sube",
          r == "upload" and stub.upload_calls == 1,
          f"{r} upload_calls={stub.upload_calls}")
    check("autosave: log 'Auto-guardado: progreso sincronizado ✓'",
          any("Auto-guardado: progreso sincronizado ✓" in x for x in logs),
          str(logs))
    # El server 'subió' hace 1h al futuro → para el tick 3 lo envejecemos.
    stub.updated = iso_utc(-2.0)

    # 2) sin cambios → NI consulta la API (caché de hashes).
    calls = (stub.manifest_calls, stub.upload_calls)
    logs.clear()
    r = a.tick()
    check("autosave: sin cambios → 'skip-identical' SIN llamada a la API",
          r == "skip-identical"
          and (stub.manifest_calls, stub.upload_calls) == calls and logs == [],
          f"{r} manifest={stub.manifest_calls} upload={stub.upload_calls} {logs}")

    # 2b) forzado (cierre): consulta, pero idéntico → NO repite el PUT.
    r = a.tick(force=True)
    check("autosave forzado (cierre): idéntico → consulta y NO repite PUT",
          r == "noop" and stub.upload_calls == 1,
          f"{r} upload_calls={stub.upload_calls}")

    # 3) el progreso local cambió → sube de nuevo.
    stat.write_bytes(b"PROGRESS-2")
    logs.clear()
    r = a.tick()
    check("autosave: progreso local cambió → sube de nuevo",
          r == "upload" and stub.upload_calls == 2,
          f"{r} upload_calls={stub.upload_calls}")

    # 4) server más nuevo → NO pisa desde el autosave (se respeta al arrancar).
    stub2 = StubSaveApi(upload_offset_hours=2.0)  # PUT 'fresca' +2h al futuro
    seed = [{"path": "iw4x.stat",
             "dataBase64": base64.b64encode(b"SERVER-NEWER").decode(),
             "sha256": sha256_local(b"SERVER-NEWER")}]
    stub2.save_upload("tok", seed)
    a2, logs2 = make(stub2)
    r = a2.tick()
    check("autosave: server más nuevo → omitido, sin sobrescribir",
          r == "download" and stub2.upload_calls == 1
          and stub2.store["iw4x.stat"] == b"SERVER-NEWER",
          f"{r} upload_calls={stub2.upload_calls}")
    check("autosave: log 'versión más nueva' al omitir",
          any("versión más nueva" in x for x in logs2), str(logs2))

    # 5) save en escritura (ilegible) → skip del tick sin crash + log dim.
    stat.unlink()
    stat.mkdir()  # abrir un directorio da PermissionError en Windows
    a3, logs3 = make(stub)
    try:
        r = a3.tick()
        crashed = False
    except Exception as exc:  # pragma: no cover
        r, crashed = f"EXC:{exc}", True
    check("autosave: save ilegible (a medias) → 'busy-read' sin crash",
          crashed is False and r == "busy-read", f"r={r}")
    check("autosave: log dim 'archivo en escritura… reintentando'",
          any("archivo en escritura" in x and "reintentando" in x for x in logs3),
          str(logs3))
    stat.rmdir()
    stat.write_bytes(b"PROGRESS-2")

    # 6) autosave_minutes=0 → desactivado, sin API.
    a4, _logs4 = make(stub, minutes=0)
    calls = (stub.manifest_calls, stub.upload_calls)
    r = a4.tick()
    check("autosave: minutos=0 → 'disabled' sin llamada a la API",
          r == "disabled"
          and (stub.manifest_calls, stub.upload_calls) == calls,
          f"{r} manifest={stub.manifest_calls} upload={stub.upload_calls}")

    # 7) cloud_save off → desactivado (aunque haya cambios y force).
    stat.write_bytes(b"PROGRESS-3")
    a5, _logs5 = make(stub)
    a5.cloud_provider = lambda: False
    calls = (stub.manifest_calls, stub.upload_calls)
    r = a5.tick(force=True)
    check("autosave: cloud_save off → 'disabled' incluso forzado",
          r == "disabled"
          and (stub.manifest_calls, stub.upload_calls) == calls,
          f"{r} manifest={stub.manifest_calls} upload={stub.upload_calls}")


# ---------------------------------------------------------------------------
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("Tests unitarios del launcher IW4x Ranking (puras, sin red/GUI)")

    phase_guid_isolation()
    phase_save_sync_pure()
    phase_command_args()
    phase_app_config()
    phase_normalize_api_url()
    phase_kill_tree()
    phase_wait_process_exit()
    phase_autosave()

    fails = sum(1 for r in RESULTS if r.startswith("[FALLO"))
    print("\n================ RESUMEN ================")
    print(f"Pasos: {len(RESULTS)}   Fallos: {fails}")
    for r in RESULTS:
        if r.startswith("[FALLO"):
            print(r)
    return 0 if fails == 0 else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(3)
