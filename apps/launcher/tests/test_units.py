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

from app_config import (  # noqa: E402
    AppConfig,
    DEFAULT_CONFIG,
    default_server_after_delete,
    normalize_api_url,
    normalize_server_address,
    sanitize_servers,
)
import game_flow as gf  # noqa: E402
from game_flow import build_game_args  # noqa: E402
import save_sync as ss  # noqa: E402
from save_sync import (  # noqa: E402
    build_upload_files,
    decide_guid_action,
    decide_guid_validation,
    decide_stat_action,
    decide_sync,
    guid_file_b64,
    local_save_files,
    quarantine_local_guid,
    quarantine_stat_file,
    sha256_of,
    stat_quarantine_root,
    stat_rels,
)
from ui.stats_panel import medal_detail_parts  # noqa: E402

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
# 1b. save_sync: capa NUEVA de propiedad del guid.dat (backend /identity/*).
def phase_guid_validation() -> None:
    print("\n=== Units: decide_guid_validation / guid_file_b64 (propiedad) ===")

    # --- Ramas de la decisión pura (3 ramas + API caída) ---------------------
    # El orden interno: API caída manda (sin confirmación del server jamás se
    # cuarentena); sin guid local no hay nada que validar; con local manda
    # ownedByMe.
    check("validación: ownedByMe:true + local → 'play' (restore sano)",
          decide_guid_validation(True, True, True) == "play")
    check("validación: ownedByMe:false + local → 'quarantine+claim-fresh' "
          "(guid compartido de otro)",
          decide_guid_validation(False, True, True) == "quarantine+claim-fresh")
    check("validación: guid:null (no derivable) cuenta como NO tuyo → "
          "'quarantine+claim-fresh'",
          decide_guid_validation(False, True, True) == "quarantine+claim-fresh")
    check("validación: API caída + ownedByMe:false → 'play-offline' "
          "(sin cuarentena por incertidumbre)",
          decide_guid_validation(False, True, False) == "play-offline")
    check("validación: API caída manda aunque la respuesta diga tuyo → "
          "'play-offline'",
          decide_guid_validation(True, True, False) == "play-offline")
    check("validación: sin guid.dat local → 'play' (cuenta nueva, flujo "
          "none/fresh existente)",
          decide_guid_validation(True, False, True) == "play"
          and decide_guid_validation(False, False, True) == "play")
    check("validación: sin local y API caída → 'play-offline' (total)",
          decide_guid_validation(False, False, False) == "play-offline")

    # --- guid_file_b64: el body exacto del contrato ---------------------------
    import base64 as _b64
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="iw4x-guidval-"))
    guid = tmp / "guid.dat"
    guid.write_bytes(b"GUID-DE-ADMIN-COMPAR")
    b64 = guid_file_b64(str(guid))
    check("guid_file_b64: contenido crudo en base64 (body del contrato)",
          b64 == _b64.b64encode(b"GUID-DE-ADMIN-COMPAR").decode("ascii"),
          str(b64))
    check("guid_file_b64: sin guid.dat local → None (sin validación posible)",
          guid_file_b64(str(tmp / "nope.dat")) is None)


# ---------------------------------------------------------------------------
# 1c. save_sync: aislamiento del SAVE DE PROGRESIÓN (fix unlockstats).
def phase_stat_isolation() -> None:
    print("\n=== Units: decide_stat_action / quarantine_stat_file (unlockstats) ===")

    # --- Ramas puras (los checks de decide_guid_action siguen arriba, intactos)
    check("stat: manifest CON stat + local → 'restore' (lo de tu nube es tuyo)",
          decide_stat_action(True, True) == "restore")
    check("stat: manifest CON stat SIN local → 'restore' (el sync lo baja)",
          decide_stat_action(True, False) == "restore")
    check("stat: manifest SIN stat + local → 'quarantine' (NO heredes "
          "unlockstats ajeno)",
          decide_stat_action(False, True) == "quarantine")
    check("stat: manifest SIN stat y sin local → 'none' (el juego crea el "
          "primero)",
          decide_stat_action(False, False) == "none")

    # --- stat_rels: base + mods del manifiesto + mods locales; configs fuera --
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-stat-iso-"))
    gd = tmp / "gd"
    (gd / "players" / "mods" / "m1").mkdir(parents=True)
    (gd / "players" / "iw4x.stat").write_bytes(b"S-BASE")
    (gd / "players" / "mods" / "m1" / "iw4x.stat").write_bytes(b"S-M1")
    rels = stat_rels([{"path": "iw4x.stat"},
                      {"path": "mods/m2/iw4x.stat"},   # en nube, sin local
                      {"path": "iw4x_config.cfg"},      # NO es progresión
                      {"path": "guid.dat"}],            # NO es progresión
                     str(gd))
    check("stat_rels: base + mod local + mod de nube (configs y guid fuera)",
          rels == ["iw4x.stat", "mods/m1/iw4x.stat", "mods/m2/iw4x.stat"],
          str(rels))

    # --- quarantine_stat_file: mueve preservando la estructura del rel --------
    root = tmp / "stat-q"
    dest = quarantine_stat_file(str(gd / "players" / "iw4x.stat"), "iw4x.stat",
                                user_id="u-9", root=root)
    check("quarantine_stat: mueve el stat base a <userId>-<ts>/iw4x.stat",
          dest is not None
          and (dest / "iw4x.stat").read_bytes() == b"S-BASE"
          and not (gd / "players" / "iw4x.stat").exists(),
          str(dest))
    dest2 = quarantine_stat_file(
        str(gd / "players" / "mods" / "m1" / "iw4x.stat"),
        "mods/m1/iw4x.stat", user_id="u-9", root=root)
    check("quarantine_stat: el mod stat conserva su estructura mods/<mod>/",
          dest2 is not None
          and (dest2 / "mods" / "m1" / "iw4x.stat").read_bytes() == b"S-M1",
          str(dest2))
    check("quarantine_stat: sin archivo → None sin crear nada",
          quarantine_stat_file(str(gd / "players" / "nope.stat"), "iw4x.stat",
                               user_id="u-9", root=root) is None)
    check("stat_quarantine_root: default bajo stat-quarantine",
          str(stat_quarantine_root()).replace("/", "\\")
          .endswith("stat-quarantine"),
          str(stat_quarantine_root()))


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

    # --- web_url (nueva): default DERIVADO del api_url (mismo host, :5173) ----
    check("web_url: clave nueva en DEFAULT_CONFIG, derivada del api_url del contrato",
          DEFAULT_CONFIG.get("web_url") == "http://192.168.3.99:5173",
          str(DEFAULT_CONFIG.get("web_url")))
    check("web_url: dict vacío → derivada del api_url default (host 192.168.3.99)",
          AppConfig({}).web_url == "http://192.168.3.99:5173",
          AppConfig({}).web_url)
    check("web_url: api_url distinta → misma regla (host de la API, puerto 5173)",
          AppConfig({"api_url": "http://10.0.0.5:3000"}).web_url
          == "http://10.0.0.5:5173",
          AppConfig({"api_url": "http://10.0.0.5:3000"}).web_url)
    check("web_url: clave propia manda y se normaliza (esquema/barra, puerto intacto)",
          AppConfig({"web_url": "miweb.lan:5173/"}).web_url
          == "http://miweb.lan:5173",
          AppConfig({"web_url": "miweb.lan:5173/"}).web_url)
    check("web_url: '' explícito → vacía (los enlaces WEB se ocultan en la UI)",
          AppConfig({"web_url": ""}).web_url == "",
          repr(AppConfig({"web_url": ""}).web_url))

    # --- remember_session (cyber-café): default FALSE = cerrar cierra sesión --
    check("remember_session: clave nueva en DEFAULT_CONFIG (default False)",
          DEFAULT_CONFIG.get("remember_session") is False,
          str(DEFAULT_CONFIG.get("remember_session")))
    check("remember_session: dict vacío → False (cada quien hace login)",
          AppConfig({}).remember_session is False)
    check("remember_session: true explícito → True (auto-login como siempre)",
          AppConfig({"remember_session": True}).remember_session is True)
    check("remember_session: basura ('x') → False (defensivo)",
          AppConfig({"remember_session": "x"}).remember_session is False)


# ---------------------------------------------------------------------------
# 5b. servers de juego: validación de la lista editable (Ajustes).
def phase_servers_validation() -> None:
    print("\n=== Units: normalize_server_address / sanitize_servers (Ajustes) ===")

    # --- normalize_server_address: VÁLIDAS (devuelve host:puerto canónico) ---
    check("server: ip:puerto válida",
          normalize_server_address("192.168.1.50:28961") == "192.168.1.50:28961",
          normalize_server_address("192.168.1.50:28961"))
    check("server: hostname:puerto válido",
          normalize_server_address("mi-server.lan:28961") == "mi-server.lan:28961",
          normalize_server_address("mi-server.lan:28961"))
    check("server: host local (localhost) válido",
          normalize_server_address("localhost:28961") == "localhost:28961",
          normalize_server_address("localhost:28961"))
    check("server: espacios en extremos se recortan (normalización documentada)",
          normalize_server_address("  192.168.1.50:28961 ")
          == "192.168.1.50:28961",
          normalize_server_address("  192.168.1.50:28961 "))

    # --- INVÁLIDAS → '' (la UI muestra el error y no guarda nada) ------------
    check("server: sin puerto → inválida",
          normalize_server_address("192.168.1.50") == "",
          repr(normalize_server_address("192.168.1.50")))
    check("server: puerto 80 (privilegiado/URL web) → inválida",
          normalize_server_address("192.168.1.50:80") == "",
          repr(normalize_server_address("192.168.1.50:80")))
    check("server: puerto por debajo del rango (1023) → inválida",
          normalize_server_address("host:1023") == "",
          repr(normalize_server_address("host:1023")))
    check("server: puerto por encima del rango (65536) → inválida",
          normalize_server_address("host:65536") == "",
          repr(normalize_server_address("host:65536")))
    check("server: texto basura sin host:puerto → inválida",
          normalize_server_address("hola") == "",
          repr(normalize_server_address("hola")))
    check("server: host vacío (':28961') → inválida",
          normalize_server_address(":28961") == "",
          repr(normalize_server_address(":28961")))
    check("server: puerto no numérico ('host:puerto') → inválida",
          normalize_server_address("host:puerto") == "",
          repr(normalize_server_address("host:puerto")))

    # --- sanitize_servers: la lista que persiste GUARDAR ----------------------
    servers, idx = sanitize_servers(
        [{"name": "LAN", "address": "192.168.1.50:28961"},
         {"name": "", "address": "localhost:28961"}],
        1,
    )
    check("sanitize: lista válida pasa y el nombre vacío → 'Server N'",
          servers == [{"name": "LAN", "address": "192.168.1.50:28961"},
                      {"name": "Server 2", "address": "localhost:28961"}]
          and idx == 1, f"{servers} idx={idx}")
    dropped, idx_d = sanitize_servers(
        [{"name": "", "address": ""},                    # fila nunca rellenada
         {"name": "Test", "address": "127.0.0.1:28961"}], 0)
    check("sanitize: fila totalmente vacía se descarta sin error",
          dropped == [{"name": "Test", "address": "127.0.0.1:28961"}]
          and idx_d == 0, f"{dropped}")
    try:
        sanitize_servers([{"name": "Roto", "address": "192.168.1.50:80"}], 0)
        roto = False
    except ValueError as exc:
        roto = "no válida" in str(exc)
    check("sanitize: dirección inválida → ValueError con mensaje claro",
          roto, "esperaba ValueError")
    vacia, idx_v = sanitize_servers([{"name": "", "address": ""}], 3)
    check("sanitize: lista vacía final → [] con default 0 (fuera de rango cae a 0)",
          vacia == [] and idx_v == 0, f"{vacia} idx={idx_v}")

    # --- default_server_after_delete: el default borrado recae en el primero --
    check("delete: borrar el DEFAULT → recae en el primero (0)",
          default_server_after_delete(2, 2) == 0)
    check("delete: borrar UNA FILA ANTES del default → el default se corre",
          default_server_after_delete(2, 0) == 1)
    check("delete: borrar UNA FILA DESPUÉS del default → no cambia",
          default_server_after_delete(1, 2) == 1)


# ---------------------------------------------------------------------------
# 5c. normalize_api_url: defensa contra configs escritos a mano (pura).
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
# Units: medalla (contrato player["medal"]) — partes del segmento del panel.
def phase_medal_parts() -> None:
    print("\n=== Units: medal_detail_parts (segmento MEDALLA del detalle) ===")
    full, empty, text, kind = medal_detail_parts(
        {"tierId": 4, "name": "SARGENTO", "assetId": "medal-4-sargento",
         "stars": 3, "globalRank": 12, "eliteTop12": False})
    check("medalla tier 4 con 3 estrellas → '★★★' llenas + '☆☆' vacías",
          (full, empty, text, kind) == ("★★★", "☆☆", "", "estrellas"),
          f"{full!r}/{empty!r}/{text!r}/{kind}")
    full, empty, text, kind = medal_detail_parts(
        {"tierId": 2, "name": "SOLDADO", "assetId": "medal-2-soldado",
         "stars": 5, "globalRank": None, "eliteTop12": True})
    check("medalla 5/5 con élite → '★★★★★' + '· TOP 12' tras las vacías",
          (full, empty, text, kind) == ("★★★★★", "· TOP 12", "", "estrellas"),
          f"{full!r}/{empty!r}/{text!r}/{kind}")
    full, empty, text, kind = medal_detail_parts(
        {"tierId": 8, "name": "LEYENDA", "assetId": "medal-8-leyenda",
         "stars": None, "globalRank": 3, "eliteTop12": True})
    check("tier 8 (stars null) → 'LEYENDA #3 · TOP 12' tipo leyenda",
          (full, empty, text, kind) == ("", "", "LEYENDA #3 · TOP 12", "leyenda"),
          f"{text!r}/{kind}")
    _f, _e, text, kind = medal_detail_parts(
        {"tierId": 8, "name": "LEYENDA", "assetId": "medal-8-leyenda",
         "stars": None, "globalRank": None, "eliteTop12": False})
    check("tier 8 sin globalRank → solo 'LEYENDA' (sin '#')",
          text == "LEYENDA" and kind == "leyenda", f"{text!r}/{kind}")
    p_none = medal_detail_parts(None)
    p_ilegible = medal_detail_parts({"name": "Rara"})  # sin tierId legible
    check("medal null/ausente o ilegible → '—' tipo vacio (convención)",
          p_none == ("", "", "—", "vacio")
          and p_ilegible == ("", "", "—", "vacio"),
          f"{p_none}/{p_ilegible}")
    full_hi, empty_hi, _, _ = medal_detail_parts(
        {"tierId": 5, "name": "TENIENTE", "assetId": "x", "stars": 99,
         "globalRank": 1, "eliteTop12": False})
    full_lo, empty_lo, _, _ = medal_detail_parts(
        {"tierId": 5, "name": "TENIENTE", "assetId": "x", "stars": -2,
         "globalRank": 1, "eliteTop12": False})
    check("stars fuera de rango se acota a 0..5 (99→5 llenas, -2→5 vacías)",
          full_hi == "★★★★★" and empty_hi == ""
          and full_lo == "" and empty_lo == "☆☆☆☆☆",
          f"hi={full_hi!r}/{empty_hi!r} lo={full_lo!r}/{empty_lo!r}")


# ---------------------------------------------------------------------------
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("Tests unitarios del launcher IW4x Ranking (puras, sin red/GUI)")

    phase_guid_isolation()
    phase_guid_validation()
    phase_stat_isolation()
    phase_save_sync_pure()
    phase_command_args()
    phase_app_config()
    phase_servers_validation()
    phase_normalize_api_url()
    phase_kill_tree()
    phase_wait_process_exit()
    phase_autosave()
    phase_medal_parts()

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
