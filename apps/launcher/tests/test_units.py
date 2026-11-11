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
  3. game_flow: build_game_args (nick SIEMPRE forzado con +set name y
      +dumpPlayerData al final con export_classes; sin él con false).
  4. classes_export: detección del dump del cliente (sección customClasses
      con contenido real, descarte de logs '-dedicated', mtime más reciente),
      cap de 800k chars, decisión de subida por hash, store persistente y el
      flujo completo contra un STUB de API con el fixture real
      (tests/fixtures/console-dump.log, generado por el builder de apps/api).
  5. app_config: DEFAULT_CONFIG y el merge de claves (propiedades con
      defaults, acotes y limpieza de servers inválidos).
  6. app_config: normalize_api_url (esquema http:// faltante, barra final,
      espacios, vacío → default; JAMÁS inventa/corrige puertos).
  7. ui/theme: META (identidad central, DERIVADA del CTHLG.pro del repo:
      marca CTHLG MW2 Ranking) y los copys de créditos derivados (línea de
      la franja inferior del home + bloque ACERCA DE de Ajustes).
  8. app_config + CTHLG.pro: parser KEY = VALUE (read_pro_meta), fallback
      con defaults iguales (merge_pro_meta) y el archivo real del repo
      (find_pro_file / launcher_pro_meta).

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
    PRO_META_DEFAULTS,
    AppConfig,
    DEFAULT_CONFIG,
    default_server_after_delete,
    find_pro_file,
    launcher_pro_meta,
    merge_pro_meta,
    normalize_api_url,
    normalize_server_address,
    read_pro_meta,
    sanitize_servers,
)
import game_flow as gf  # noqa: E402
from game_flow import GameFlow, build_game_args  # noqa: E402
from server_status import (  # noqa: E402
    SOURCE_API,
    SOURCE_TCP,
    STATE_CHECKING,
    STATE_OFFLINE,
    STATE_ONLINE,
    STATE_UNKNOWN,
    ServerStatus,
    format_status_text,
    match_sala,
    parse_salas_response,
    parse_status_response,
    pretty_map,
    probe_server,
    sala_dropdown_label,
    sala_to_status,
    split_address,
    status_color_key,
)
import save_sync as ss  # noqa: E402
from save_sync import (  # noqa: E402
    MIN_SIZE_CONFIG,
    MIN_SIZE_GUID,
    MIN_SIZE_STAT,
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
    verify_restore_complete,
)
from ui.stats_panel import medal_detail_parts  # noqa: E402
from ui.theme import (  # noqa: E402
    META,
    credits_acerca_de,
    credits_compact,
    descripcion_acerca_de,
    marca_visible,
    version_tag,
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
# 3. build_game_args: armado del comando (nick SIEMPRE + dump de clases).
def phase_command_args() -> None:
    print("\n=== Units: comando de arranque (+set name + dumpPlayerData) ===")

    args = build_game_args(r"D:\Games\Call of Duty 6\iw4x.exe",
                           "192.168.2.251:28960", "Mandango ProMax")
    check("comando: exe primero y +dumpPlayerData ÚLTIMO (tras +connect)",
          args[0] == r"D:\Games\Call of Duty 6\iw4x.exe"
          and args[-1] == "+dumpPlayerData", str(args))
    check("comando: +set name <nick> (con espacios) y +connect ANTES del dump",
          args[1:6] == ["+set", "name", "Mandango ProMax", "+connect",
                        "192.168.2.251:28960"], str(args))
    check("comando: lista plana de 7 argumentos (sin shell)",
          len(args) == 7 and all(isinstance(a, str) for a in args), str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "  Spam Bot  ")
    check("nick con espacios en extremos se recorta",
          args == ["iw4x.exe", "+set", "name", "Spam Bot", "+connect",
                   "1.2.3.4:28960", "+dumpPlayerData"], str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "")
    check("sin nick la función no emite +set (GameFlow bloquea antes)",
          args == ["iw4x.exe", "+connect", "1.2.3.4:28960", "+dumpPlayerData"],
          str(args))

    # export_classes=False → SIN el dump (checkbox de Ajustes desmarcado).
    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "Nick",
                           export_classes=False)
    check("export_classes=false → sin +dumpPlayerData (+connect queda último)",
          args == ["iw4x.exe", "+set", "name", "Nick", "+connect",
                   "1.2.3.4:28960"], str(args))
    check("export_classes=true explícito → con +dumpPlayerData al final",
          build_game_args("iw4x.exe", "1.2.3.4:28960", "Nick",
                          export_classes=True)[-1] == "+dumpPlayerData")

    # fs_game (fix doble conexión): +set fs_game ANTES de +connect, SOLO
    # cuando el server define su mod; sin fs_game → sin el +set.
    args = build_game_args("iw4x.exe", "192.168.2.251:28960", "Nick",
                           fs_game="mods/mp_bots")
    check("fs_game: +set fs_game entre el +set name y el +connect (orden exacto)",
          args == ["iw4x.exe", "+set", "name", "Nick",
                   "+set", "fs_game", "mods/mp_bots",
                   "+connect", "192.168.2.251:28960", "+dumpPlayerData"],
          str(args))
    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "Nick",
                           fs_game="mods/mp_bots", export_classes=False)
    check("fs_game: sin dump → +connect queda último tras el +set fs_game",
          args == ["iw4x.exe", "+set", "name", "Nick",
                   "+set", "fs_game", "mods/mp_bots",
                   "+connect", "1.2.3.4:28960"], str(args))
    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "Nick", fs_game="  ")
    check("fs_game solo espacios → sin +set fs_game (server sin mod)",
          args == ["iw4x.exe", "+set", "name", "Nick",
                   "+connect", "1.2.3.4:28960", "+dumpPlayerData"], str(args))


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
    check("DEFAULT_CONFIG: api_url del LXC de producción y cloud_save activado",
          DEFAULT_CONFIG["api_url"] == "http://192.168.2.251:3000"
          and DEFAULT_CONFIG["cloud_save"] is True
          and DEFAULT_CONFIG["simulate_game"] is False, str(DEFAULT_CONFIG["api_url"]))
    check("DEFAULT_CONFIG: sin claves del polling de candidatos (eliminado)",
          not ({"link_poll_interval", "link_poll_max_seconds"} & set(DEFAULT_CONFIG)),
          str(sorted(DEFAULT_CONFIG)))
    check("DEFAULT_CONFIG: servers por defecto = Sala 1/Sala 2/Local "
          "(salas del LXC de producción + local), default Sala 1",
          DEFAULT_CONFIG["servers"] == [
              {"name": "Sala 1",  "address": "192.168.2.251:28960",
               "fsGame": "mods/mp_bots"},
              {"name": "Sala 2",  "address": "192.168.2.251:28961",
               "fsGame": "mods/mp_bots"},
              {"name": "Local",   "address": "127.0.0.1:28961"},
          ]
          and DEFAULT_CONFIG["default_server"] == 0,
          str(DEFAULT_CONFIG["servers"]))

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

    # --- web_url (nueva): default DERIVADO del api_url (mismo host, :4173) ----
    check("web_url: clave nueva en DEFAULT_CONFIG, derivada del api_url del contrato",
          DEFAULT_CONFIG.get("web_url") == "http://192.168.2.251:4173",
          str(DEFAULT_CONFIG.get("web_url")))
    check("web_url: dict vacío → derivada del api_url default (host 192.168.2.251)",
          AppConfig({}).web_url == "http://192.168.2.251:4173",
          AppConfig({}).web_url)
    check("web_url: api_url distinta → misma regla (host de la API, puerto 4173)",
          AppConfig({"api_url": "http://10.0.0.5:3000"}).web_url
          == "http://10.0.0.5:4173",
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
# 5d. server_status: parser getstatus Q3 + formato/color del estado (puras).
# Estado REAL de los servers (pedido del dueño): ● ONLINE · N jugadores /
# OFFLINE / verificando… — la heurística es TCP connect + UN datagrama UDP
# getstatus (protocolo Q3).
GETSTATUS_IW4X = (
    b"\xff\xff\xff\xffstatusResponse\n"
    b"\\sv_maxclients\\18\\gamename\\iw4x\\shortversion\\0.7.5"
    b"\\pswrd\\0\\protocol\\1830\\mapname\\mp_rust\\players\\6"
    b"\\sv_hostname\\Sala 1 IW4x\\clients\\6\\g_gametype\\war\n"
    b'16 25 "Mandango"\n'
    b'21 43 "Krlos_77"\n'
)
# Variante clásica Q3/MW2: SIN clave players, SOLO clients (fallback).
GETSTATUS_MW2 = (
    b"\xff\xff\xff\xffstatusResponse\n"
    b"\\sv_maxclients\\18\\gamename\\IW4x\\clients\\3\\mapname\\mp_terminal\n"
    b'8 41 "Test"\n'
)


def phase_server_status_parser() -> None:
    print("\n=== Units: server_status (parser getstatus + texto/color) ===")

    # --- parse_status_response: fixture real → jugadores --------------------
    check("parser: getstatus IW4x real → players=6 (gana sobre clients)",
          parse_status_response(GETSTATUS_IW4X) == 6,
          str(parse_status_response(GETSTATUS_IW4X)))
    check("parser: variante MW2 sin 'players' → fallback clients=3",
          parse_status_response(GETSTATUS_MW2) == 3,
          str(parse_status_response(GETSTATUS_MW2)))
    check("parser: 'players' al final del infostring (sin \\ de cierre) → 2",
          parse_status_response(b"\xff\xff\xff\xffstatusResponse\n"
                                b"\\gamename\\iw4x\\players\\2") == 2)
    check("parser: statusResponse SIN contador → None (ONLINE sin cifra)",
          parse_status_response(b"\xff\xff\xff\xffstatusResponse\n"
                                b"\\gamename\\iw4x\\mapname\\mp_rust") is None)
    # Basura: la QUERY no es una RESPONSE; texto suelto; vacío.
    check("parser: la query getstatus NO es una respuesta → None",
          parse_status_response(b"\xff\xff\xff\xffgetstatus") is None)
    check("parser: texto suelto → None",
          parse_status_response(b"HTTP/1.1 200 OK") is None)
    check("parser: vacío → None", parse_status_response(b"") is None)

    # --- split_address: misma validación del config --------------------------
    check("split: '192.168.2.251:28960' → (host, 28960)",
          split_address("192.168.2.251:28960") == ("192.168.2.251", 28960),
          str(split_address("192.168.2.251:28960")))
    check("split: '127.0.0.1:28961' → (127.0.0.1, 28961)",
          split_address("127.0.0.1:28961") == ("127.0.0.1", 28961),
          str(split_address("127.0.0.1:28961")))
    check("split: 'hola' (sin puerto) → None", split_address("hola") is None)
    check("split: 'host:abc' (puerto no numérico) → None",
          split_address("host:abc") is None)
    check("split: 'host:80' (puerto privilegiado) → None (igual que config)",
          split_address("host:80") is None)
    check("split: vacío → None", split_address("") is None)
    check("probe: dirección inválida → None SIN tocar sockets (pura)",
          probe_server("no-es-una-direccion") is None)

    # --- format_status_text: el copy exacto del HUD --------------------------
    check("texto: online con 6 → 'ONLINE · 6 jugadores'",
          format_status_text(ServerStatus(STATE_ONLINE, 6))
          == "ONLINE · 6 jugadores",
          format_status_text(ServerStatus(STATE_ONLINE, 6)))
    check("texto: online con 1 → 'ONLINE · 1 jugador' (singular)",
          format_status_text(ServerStatus(STATE_ONLINE, 1))
          == "ONLINE · 1 jugador",
          format_status_text(ServerStatus(STATE_ONLINE, 1)))
    check("texto: online con 0 → 'ONLINE · 0 jugadores'",
          format_status_text(ServerStatus(STATE_ONLINE, 0))
          == "ONLINE · 0 jugadores",
          format_status_text(ServerStatus(STATE_ONLINE, 0)))
    check("texto: online SIN cifra → 'ONLINE'",
          format_status_text(ServerStatus(STATE_ONLINE)) == "ONLINE")
    check("texto: offline → 'OFFLINE'",
          format_status_text(ServerStatus(STATE_OFFLINE)) == "OFFLINE")
    check("texto: checking → 'verificando…'",
          format_status_text(ServerStatus(STATE_CHECKING)) == "verificando…")
    check("texto: None (fila inválida/vacía) → ''",
          format_status_text(None) == "")

    # --- status_color_key: verde SOLO ok, dim offline, ámbar verificando -----
    check("color: online → 'ok' (verde señal #8FD429 del tema)",
          status_color_key(ServerStatus(STATE_ONLINE, 6)) == "ok")
    check("color: offline → 'dim' (gris apagado, NUNCA rojo)",
          status_color_key(ServerStatus(STATE_OFFLINE)) == "dim")
    check("color: verificando → 'accent' (ámbar del tema)",
          status_color_key(ServerStatus(STATE_CHECKING)) == "accent")
    check("color: None → 'dim'", status_color_key(None) == "dim")


# ---------------------------------------------------------------------------
# 5e. server_status: FUENTE APROBADA GET /api/salas (parser + match + copy).
# El backend (en el LXC junto a las salas) reporta por RCON el estado real;
# fallback a TCP directo con API caída / configured:false / salas vacías.
SALAS_FIXTURE = {
    "configured": True,
    "salas": [
        {"id": "sala1", "name": "CTHolguin Sala 1",
         "address": "192.168.2.251:28960", "online": True,
         "hostname": "CTHolguin Sala 1", "map": "mp_terminal",
         "players": 2, "bots": 14, "maxClients": 18},
        {"id": "sala2", "name": "CTHolguin Sala 2",
         "address": "192.168.2.251:28961", "online": False,
         "hostname": "CTHolguin Sala 2", "map": "mp_rust",
         "players": 0, "bots": 0, "maxClients": 18},
    ],
}


def phase_salas_endpoint() -> None:
    print("\n=== Units: /api/salas (parser + match por address + copy) ===")

    # --- parse_salas_response: contrato del backend ---------------------------
    salas = parse_salas_response(SALAS_FIXTURE)
    check("salas: fixture del contrato → 2 salas parseadas",
          len(salas) == 2, str(salas))
    check("salas: sala1 online con players=2 bots=14 max=18 map=mp_terminal",
          salas and salas[0]["online"] is True
          and salas[0]["players"] == 2 and salas[0]["bots"] == 14
          and salas[0]["max_clients"] == 18
          and salas[0]["map"] == "mp_terminal",
          str(salas[0] if salas else None))
    check("salas: sala2 offline", bool(salas) and salas[1]["online"] is False)
    check("salas: configured:false → [] (FALLBACK a TCP, sin inventar)",
          parse_salas_response({"configured": False,
                                "salas": SALAS_FIXTURE["salas"]}) == [])
    check("salas: sin clave configured → []",
          parse_salas_response({"salas": SALAS_FIXTURE["salas"]}) == [])
    check("salas: salas vacías → []", parse_salas_response(
        {"configured": True, "salas": []}) == [])
    check("salas: salas no es lista → []",
          parse_salas_response({"configured": True, "salas": "basura"}) == [])
    check("salas: payload no-dict (None/texto) → []",
          parse_salas_response(None) == []
          and parse_salas_response("texto") == [])
    check("salas: sala SIN address se descarta (inusable para match)",
          parse_salas_response({"configured": True, "salas": [
              {"id": "x", "online": True}]}) == [])
    check("salas: players como texto '3' → 3; basura → None (sin inventar)",
          (parse_salas_response({"configured": True, "salas": [
              {"address": "1.2.3.4:28000", "online": True, "players": "3"}]})
           [0]["players"] == 3)
          and (parse_salas_response({"configured": True, "salas": [
              {"address": "1.2.3.4:28000", "online": True,
               "players": "muchos"}]})
           [0]["players"] is None))

    # --- match_sala: por address, tolerando formatos distintos ----------------
    check("match: address exacta → sala1",
          (match_sala(salas, "192.168.2.251:28960") or {}).get("name")
          == "CTHolguin Sala 1",
          str(match_sala(salas, "192.168.2.251:28960")))
    check("match: formato distinto (espacios de más) → misma sala",
          (match_sala(salas, " 192.168.2.251:28960 ") or {}).get("name")
          == "CTHolguin Sala 1")
    check("match: server NO presente en la respuesta → None (desconocido)",
          match_sala(salas, "10.9.9.9:28000") is None)
    check("match: address inválida → None",
          match_sala(salas, "no-es-una-direccion") is None)
    una_sin_puerto = parse_salas_response({"configured": True, "salas": [
        {"id": "unica", "address": "192.168.2.251", "online": True}]})
    check("match: sala del API SIN puerto (única de ese host) → matchea",
          match_sala(una_sin_puerto, "192.168.2.251:28960")
          is una_sin_puerto[0])
    dos_sin_puerto = parse_salas_response({"configured": True, "salas": [
        {"id": "a", "address": "192.168.2.251", "online": True},
        {"id": "b", "address": "192.168.2.251", "online": False}]})
    check("match: DOS salas mismo host sin puerto → None (ambiguo: no se "
          "adivina)", match_sala(dos_sin_puerto, "192.168.2.251:28960") is None)

    # --- sala_to_status + copy aprobado ---------------------------------------
    st1 = sala_to_status(match_sala(salas, "192.168.2.251:28960"))
    check("status: sala1 → online fuente API",
          st1 is not None and st1.state == STATE_ONLINE
          and st1.source == SOURCE_API and st1.players == 2, str(st1))
    check("copy: 'EN LÍNEA · mapa: Terminal · 2/18 · 2 humanos · 14 bots'",
          format_status_text(st1)
          == "EN LÍNEA · mapa: Terminal · 2/18 · 2 humanos · 14 bots",
          format_status_text(st1))
    st1_sin_bots = sala_to_status({**salas[0], "bots": None})
    check("copy: sin bots → 'EN LÍNEA · mapa: Terminal · 2/18'",
          format_status_text(st1_sin_bots)
          == "EN LÍNEA · mapa: Terminal · 2/18",
          format_status_text(st1_sin_bots))
    st1_sin_max = sala_to_status({**salas[0], "max_clients": None,
                                  "bots": None})
    check("copy: sin maxClients → 'EN LÍNEA · mapa: Terminal · 2 jugadores'",
          format_status_text(st1_sin_max)
          == "EN LÍNEA · mapa: Terminal · 2 jugadores",
          format_status_text(st1_sin_max))
    st1_solo = sala_to_status({**salas[0], "players": 1, "bots": 1,
                               "map": "mp_rust"})
    check("copy: singular → 'EN LÍNEA · mapa: Rust · 1/18 · 1 humano · 1 bot'",
          format_status_text(st1_solo)
          == "EN LÍNEA · mapa: Rust · 1/18 · 1 humano · 1 bot",
          format_status_text(st1_solo))
    st1_min = sala_to_status({"address": "1.2.3.4:28000", "online": True})
    check("copy: online sin datos del API → 'EN LÍNEA' solo",
          format_status_text(st1_min) == "EN LÍNEA",
          format_status_text(st1_min))
    st2 = sala_to_status(match_sala(salas, "192.168.2.251:28961"))
    check("copy: sala2 offline → 'OFFLINE'",
          st2 is not None and st2.state == STATE_OFFLINE
          and format_status_text(st2) == "OFFLINE")
    check("copy: server no listado → DESCONOCIDO 'SIN DATOS' (sin inventar)",
          format_status_text(ServerStatus(state=STATE_UNKNOWN,
                                          source=SOURCE_API)) == "SIN DATOS")
    check("copy: TCP online sigue siendo 'ONLINE · N jugadores' (fallback)",
          format_status_text(ServerStatus(state=STATE_ONLINE, players=3,
                                          source=SOURCE_TCP))
          == "ONLINE · 3 jugadores")

    # --- pretty_map ------------------------------------------------------------
    check("mapa: 'mp_terminal' → 'Terminal'", pretty_map("mp_terminal")
          == "Terminal")
    check("mapa: 'mp_rust' → 'Rust'", pretty_map("mp_rust") == "Rust")
    check("mapa: 'Terminal' queda igual", pretty_map("Terminal") == "Terminal")
    check("mapa: vacío/None → None", pretty_map("") is None
          and pretty_map(None) is None)

    # --- color: desconocido → dim (jamás rojo) ---------------------------------
    check("color: desconocido → 'dim'",
          status_color_key(ServerStatus(state=STATE_UNKNOWN,
                                        source=SOURCE_API)) == "dim")
    check("color: API online → 'ok'",
          status_color_key(st1) == "ok")

    # --- dropdown: warning SOLO con offline confirmado por el API --------------
    check("dropdown: sala2 (offline API) → '● Sala 2 — OFFLINE'",
          sala_dropdown_label("Sala 2", "192.168.2.251:28961", st2)
          == "● Sala 2 — OFFLINE",
          sala_dropdown_label("Sala 2", "192.168.2.251:28961", st2))
    check("dropdown: offline SOLO por TCP NO decora (señal débil del probe)",
          sala_dropdown_label(
              "Sala 2", "192.168.2.251:28961",
              ServerStatus(state=STATE_OFFLINE, source=SOURCE_TCP))
          == "Sala 2  (192.168.2.251:28961)")
    check("dropdown: online/None → label canónico 'Nombre  (host:puerto)'",
          sala_dropdown_label("Sala 1", "192.168.2.251:28960", st1)
          == "Sala 1  (192.168.2.251:28960)"
          and sala_dropdown_label("Local", "127.0.0.1:28961", None)
          == "Local  (127.0.0.1:28961)")
    check("dropdown: desconocido NO decora (canónico)",
          sala_dropdown_label(
              "Local", "127.0.0.1:28961",
              ServerStatus(state=STATE_UNKNOWN, source=SOURCE_API))
          == "Local  (127.0.0.1:28961)")


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
# 9. classes_export: detección del dump del cliente + subida al perfil web.
def phase_classes_export() -> None:
    print("\n=== Units: classes_export (dump del cliente → POST /players/classes) ===")
    import os
    import tempfile
    from typing import List, Optional

    from api_client import ApiError, NetworkError
    import classes_export as ce
    from classes_export import (
        candidate_log_paths,
        decide_classes_upload,
        dump_hash,
        export_player_classes,
        find_client_dump_log,
        has_classes_dump,
        is_server_log,
        load_classes_hash,
        read_dump_text,
        save_classes_hash,
    )

    fixture_path = Path(__file__).resolve().parent / "fixtures" / "console-dump.log"
    fixture_text = fixture_path.read_text(encoding="utf-8")

    # --- Config: export_classes (default True) -------------------------------
    check("classes config: clave nueva en DEFAULT_CONFIG (default True)",
          DEFAULT_CONFIG.get("export_classes") is True,
          str(DEFAULT_CONFIG.get("export_classes")))
    check("classes config: dict vacío → True; false explícito → False",
          AppConfig({}).export_classes is True
          and AppConfig({"export_classes": False}).export_classes is False)

    # --- Detección de la sección con contenido real ---------------------------
    check("dump: fixture REAL (builder de la API, 15 clases) → sección detectada",
          has_classes_dump(fixture_text))
    check("dump: línea 'customClasses' sola SIN contenido → no es un dump",
          not has_classes_dump("customClasses\notra_seccion = 1\n"))
    check("dump: 'customClasses' mencionada en otra línea (chat) → no cuenta",
          not has_classes_dump('[  1] say_team: mira mi customClasses\n'))
    sin_ts = fixture_text.replace("[  18215383]", "").replace("[  18215001]", "")
    check("dump: detección idéntica con y sin timestamps de consola",
          has_classes_dump(sin_ts))
    check("dump: log de CLIENTE sin sección (el real del 11/5) → False",
          not has_classes_dump(
              "[      5883] ''\n[      5883] Build 37a alterIWnet.\n"
              "Current search path:\n"))

    # --- Regla anti-server: cabecera '-dedicated' -----------------------------
    server_text = ("[      2462] '-dedicated +set fs_game  +set sv_lanonly 1 "
                   "+set net_port 28961 +exec server.cfg +set logfile 2'\n"
                   "[      2462] Build r5318. Logfile opened on 11/08/26\n")
    check("server log: cabecera '-dedicated' (userraw real) → es de server",
          is_server_log(server_text))
    check("server log: el log real del server NO trae sección customClasses",
          not has_classes_dump(server_text))
    check("server log: cabecera de CLIENTE (comando vacío '') → no es server",
          not is_server_log("[      5883] ''\nBuild 37a alterIWnet.\n"))
    server_con_dump = server_text + fixture_text
    check("server log: aunque contuviera un dump, '-dedicated' lo excluye",
          has_classes_dump(server_con_dump) and is_server_log(server_con_dump))

    # --- find_client_dump_log con archivos reales (%TEMP%, rutas inyectadas) --
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-classes-"))
    gd = tmp / "game"
    (gd / "main").mkdir(parents=True)
    (gd / "userraw").mkdir(parents=True)
    (gd / "mods" / "mp_bots").mkdir(parents=True)
    cliente = gd / "main" / "console_mp.log"        # hallazgo real del cliente
    server = gd / "userraw" / "console_mp.log"      # server dedicado (hoy)
    server_mod = gd / "mods" / "mp_bots" / "console_mp.log"  # server viejo
    cliente.write_text(fixture_text, encoding="utf-8")
    server.write_text(server_text, encoding="utf-8")
    server_mod.write_text(server_text, encoding="utf-8")
    pasado = time.time() - 3600
    os.utime(cliente, (pasado, pasado))  # el server queda MÁS NUEVO
    found = find_client_dump_log(
        [str(server), str(server_mod), str(cliente)])
    check("detección: el server MÁS NUEVO se descarta y gana el cliente "
          "(main\\) con dump",
          found is not None and Path(found) == cliente, str(found))
    check("detección: solo logs de server → None (nada usable)",
          find_client_dump_log([str(server), str(server_mod)]) is None)
    check("detección: candidato inexistente → None sin explotar",
          find_client_dump_log([str(gd / "nope.log")]) is None)
    check("detección: lista vacía → None", find_client_dump_log([]) is None)

    # Dos clientes con dump: gana el de mtime MÁS RECIENTE.
    viejo = gd / "console_mp.log"  # raíz del juego (candidato normativo)
    viejo.write_text(fixture_text.replace("THE NOOB2", "RAIZ-VIEJA"),
                     encoding="utf-8")
    os.utime(viejo, (pasado - 7200, pasado - 7200))
    found2 = find_client_dump_log([str(viejo), str(cliente)])
    check("detección: dos clientes con dump → el MÁS RECIENTE (main\\)",
          found2 is not None and Path(found2) == cliente, str(found2))

    # --- read_dump_text: cap de 800k chars (contrato ≤900k del body) ----------
    grande = "PREFIX-" + "a" * (ce.MAX_DUMP_CHARS + 50)
    cola = read_dump_text(str(_escribir(tmp / "grande.log", grande)))
    check("dump text: log enorme → últimos 800k chars (cap del contrato)",
          cola is not None and len(cola) == ce.MAX_DUMP_CHARS
          and not cola.startswith("PREFIX"), len(cola or ""))
    check("dump text: log pequeño → texto completo sin recortar",
          read_dump_text(str(_escribir(tmp / "chico.log", fixture_text)))
          == fixture_text)
    check("dump text: archivo ilegible → None",
          read_dump_text(str(tmp / "nope.log")) is None)

    # --- decide_classes_upload (pura): matriz ----------------------------------
    check("decide: sin dump → nunca sube (aunque el hash difiera)",
          not decide_classes_upload(False, "h1", None))
    check("decide: dump nuevo y sin hash previo → sube",
          decide_classes_upload(True, "h1", None))
    check("decide: mismo hash que la última subida → NO repite",
          not decide_classes_upload(True, "h1", "h1"))
    check("decide: hash distinto al último → sube",
          decide_classes_upload(True, "h2", "h1"))
    check("decide: hash vacío → no sube (defensa)",
          not decide_classes_upload(True, "", None))
    check("dump_hash: determinista y sensible al contenido",
          dump_hash("abc") == dump_hash("abc") and dump_hash("abc") != dump_hash("abd"))

    # --- Store del hash: roundtrip, roto → None -------------------------------
    store = tmp / "store" / "classes-export.json"
    check("store: sin archivo → None", load_classes_hash(store) is None)
    check("store: save → load devuelve el hash",
          save_classes_hash("abc123", store) and load_classes_hash(store) == "abc123")
    store.write_text("{roto", encoding="utf-8")
    check("store: JSON roto → None sin explotar", load_classes_hash(store) is None)
    store.write_text('{"otro": 1}', encoding="utf-8")
    check("store: dict sin sha256 → None", load_classes_hash(store) is None)

    # --- Flujo de subida con STUB de API + fixture real -----------------------
    class StubClassesApi:
        def __init__(self, error: Optional[Exception] = None) -> None:
            self.calls = 0
            self.last_text: Optional[str] = None
            self.error = error

        def upload_classes(self, token, dump_text):
            self.calls += 1
            self.last_text = dump_text
            if self.error is not None:
                raise self.error
            return {"guid": "g1", "classesUpdatedAt": "2026-11-08T00:00:00.000Z",
                    "count": 15, "classes": []}

    gd_live = tmp / "live"
    (gd_live / "main").mkdir(parents=True)
    live_log = gd_live / "main" / "console_mp.log"
    live_log.write_text(fixture_text, encoding="utf-8")
    live_store = tmp / "live-store.json"

    stub = StubClassesApi()
    logs: List[str] = []
    r = export_player_classes(stub, "tok", str(gd_live), log_cb=logs.append,
                              store_path=live_store)
    check("flujo: dump nuevo → sube ('uploaded') una vez",
          r == "uploaded" and stub.calls == 1, f"r={r} calls={stub.calls}")
    check("flujo: el body trae el texto del log con la sección (tail ≤800k)",
          stub.last_text is not None
          and "customClasses" in stub.last_text
          and len(stub.last_text) <= ce.MAX_DUMP_CHARS,
          f"chars={len(stub.last_text or '')}")
    check("flujo: log exacto 'Clases exportadas a tu perfil web ✓'",
          "Clases exportadas a tu perfil web ✓" in logs, str(logs))
    check("flujo: hash persistido tras subir",
          load_classes_hash(live_store) == dump_hash(stub.last_text or ""))

    logs.clear()
    r = export_player_classes(stub, "tok", str(gd_live), log_cb=logs.append,
                              store_path=live_store)
    check("flujo: mismo dump → 'noop' SIN repetir el POST",
          r == "noop" and stub.calls == 1, f"r={r} calls={stub.calls}")
    check("flujo: 'noop' es silencioso para la consola (sin logs)",
          logs == [], str(logs))

    live_log.write_text(fixture_text + "\n[  99] experience = 424242",
                        encoding="utf-8")
    r = export_player_classes(stub, "tok", str(gd_live), log_cb=logs.append,
                              store_path=live_store)
    check("flujo: dump cambió (hash distinto) → sube de nuevo",
          r == "uploaded" and stub.calls == 2
          and stub.last_text.endswith("[  99] experience = 424242"),
          f"r={r} calls={stub.calls}")

    # Error de la API → WARNING visible sin bloquear y SIN actualizar hash.
    # El dump CAMBIA primero (como una sesión nueva): el guard de hash decide
    # subir, y ahí la API falla.
    live_log.write_text(fixture_text + "\n[ 100] experience = 555",
                        encoding="utf-8")
    stub_err = StubClassesApi(error=ApiError(400, "CLASSES_NOT_FOUND",
                                             "sin sección customClasses"))
    logs.clear()
    r = export_player_classes(stub_err, "tok", str(gd_live),
                              log_cb=logs.append, store_path=live_store)
    check("API 400 → 'error' con WARNING sin bloquear",
          r == "error" and stub_err.calls == 1, f"r={r} calls={stub_err.calls}")
    check("API 400 → WARNING exacto '⚠ Exportación de clases omitida: …'",
          any(x.startswith("⚠ Exportación de clases omitida") and "400" in x
              for x in logs), str(logs))
    check("API 400 → el hash NO se marca como subido (reintento próximo turno)",
          load_classes_hash(live_store) != dump_hash(
              read_dump_text(str(live_log)) or ""))

    # API caída → skip silencioso dim (nada a la consola; solo al archivo).
    # Otro dump nuevo: mismo camino del guard de hash con red rota.
    live_log.write_text(fixture_text + "\n[ 101] experience = 777",
                        encoding="utf-8")
    stub_down = StubClassesApi(error=NetworkError("No se pudo conectar."))
    logs.clear()
    r = export_player_classes(stub_down, "tok", str(gd_live),
                              log_cb=logs.append, store_path=live_store)
    check("API caída → 'error' skip silencioso (cero logs a la consola)",
          r == "error" and stub_down.calls == 1 and logs == [],
          f"r={r} logs={logs}")

    # Sin dump de cliente → no-dump sin tocar la API.
    gd_vacio = tmp / "vacio"
    gd_vacio.mkdir()
    stub2 = StubClassesApi()
    r = export_player_classes(stub2, "tok", str(gd_vacio),
                              log_cb=logs.append, store_path=live_store)
    check("sin console_mp.log de cliente → 'no-dump' sin llamada",
          r == "no-dump" and stub2.calls == 0, f"r={r} calls={stub2.calls}")

    gd_server = tmp / "solo-server"
    (gd_server / "userraw").mkdir(parents=True)
    (gd_server / "userraw" / "console_mp.log").write_text(
        server_text, encoding="utf-8")
    r = export_player_classes(stub2, "tok", str(gd_server),
                              log_cb=logs.append, store_path=live_store)
    check("solo log de SERVER (userraw) → 'no-dump' (jamás se usa)",
          r == "no-dump" and stub2.calls == 0, f"r={r} calls={stub2.calls}")

    # Candidatos por defecto de un game_dir (los del hallazgo real).
    cands = candidate_log_paths(str(gd))
    check("candidatos: main\\, userraw\\, raíz, %LOCALAPPDATA% y mods\\*",
          str(Path(str(gd)) / "main" / "console_mp.log") in cands
          and str(Path(str(gd)) / "userraw" / "console_mp.log") in cands
          and str(Path(str(gd)) / "console_mp.log") in cands
          and any("mp_bots" in c for c in cands)
          and any(c.lower().endswith("iw4x\\console_mp.log") for c in cands),
          str(cands))


def _escribir(path: Path, texto: str) -> Path:
    """Helper del phase: escribe un fixture temporal y devuelve su ruta."""
    path.write_text(texto, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 7b. Verificación post-restore (PASO 1 del flujo) + orden del flujo JUGAR.
def phase_verify_restore() -> None:
    """Units de verify_restore_complete y del ORDEN del flujo JUGAR.

    El flujo (decisión del dueño): PASO 1/2 cargar save → verificar que se
    cargó todo (reintento + WARNING sin bloquear) → PASO 2/2 abrir juego.
    SIN check previo de server: si está caído, el juego abre y falla dentro
    del juego. El orden se prueba con simulate=True (sin red ni GUI).
    """
    print("\n=== Units: verify_restore_complete + orden del flujo JUGAR ===")
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-verify-"))

    # verify_restore_complete: OK / corto / ausente, con las constantes.
    stat = tmp / "iw4x.stat"
    stat.write_bytes(b"X" * 150)
    cfg = tmp / "iw4x_config.cfg"
    cfg.write_bytes(b"cfg")  # 3 bytes < MIN_SIZE_CONFIG
    guid_fantasma = tmp / "guid.dat"  # no existe
    missing = verify_restore_complete({
        str(stat): MIN_SIZE_STAT,
        str(cfg): MIN_SIZE_CONFIG,
        str(guid_fantasma): MIN_SIZE_GUID,
    })
    check("verify_restore: solo faltan el corto y el ausente (orden estable)",
          missing == sorted([str(cfg), str(guid_fantasma)]), str(missing))
    check("verify_restore: todo cargado → lista vacía",
          verify_restore_complete({str(stat): MIN_SIZE_STAT}) == [],
          str(verify_restore_complete({str(stat): MIN_SIZE_STAT})))
    check("verify_restore: constantes de tamaño mínimo (stat 100 · guid 64 · "
          "config 10)",
          (MIN_SIZE_STAT, MIN_SIZE_GUID, MIN_SIZE_CONFIG) == (100, 64, 10),
          f"{MIN_SIZE_STAT}/{MIN_SIZE_GUID}/{MIN_SIZE_CONFIG}")

    # ORDEN del flujo (simulate=True: sin red ni GUI, api no se toca).
    evs: list = []
    flow = GameFlow(None, "tok", r"C:\no\existe\iw4x.exe", "127.0.0.1:28961",
                    evs.append, simulate=True, display_name="Tester")
    flow.run()
    logs = [str(e.get("msg", "")) for e in evs if e.get("t") == "log"]
    want = ["Paso 1/2: Cargando tu progreso…",
            "Verificando que se cargó todo…",
            "Todo cargado ✓",
            "Paso 2/2: Abriendo juego…"]
    idx = [logs.index(w) if w in logs else -1 for w in want]
    check("flujo: logs PASO 1/2 → verificar → Todo cargado ✓ → PASO 2/2 "
          "en orden exacto",
          all(i >= 0 for i in idx) and idx == sorted(idx), str(logs))
    check("flujo: éxito y SIN rastro del check de server eliminado",
          any(e.get("t") == "success" for e in evs)
          and not any("server no responde" in x for x in logs)
          and not any("Verificando server" in x for x in logs)
          and not any("check_game_server" in x for x in logs),
          str([e.get("t") for e in evs]))
    check("flujo: sin cancelación por server caído (failed solo si hay fallo "
          "real)",
          not any(e.get("t") == "failed" for e in evs),
          str([e.get("t") for e in evs]))


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
# 10. theme.META: identidad central (title + créditos home + ACERCA DE),
#     derivada del CTHLG.pro (marca CTHLG MW2 Ranking).
def phase_meta() -> None:
    print("\n=== Units: theme.META (identidad CTHLG MW2 Ranking + copys) ===")

    check("META: claves exactas del contrato (identidad .pro + juego/engine)",
          set(META) == {"nombre", "version", "anio", "autor", "contacto",
                        "descripcion", "juego", "game_short", "engine",
                        "pro_short", "pro_full"},
          str(sorted(META)))
    check("META: nombre = producto CTHLG MW2 Ranking + versión 0.1.5",
          META["nombre"] == "CTHLG MW2 Ranking"
          and META["version"] == "0.1.5",
          f'{META["nombre"]} v{META["version"]}')
    check("META: juego y engine del contrato (MW2 2009 · IW4x AlterWare)",
          META["juego"] == "Call of Duty: Modern Warfare 2 (2009)"
          and META["game_short"] == "MW2"
          and META["engine"] == "IW4x - AlterWare r5318",
          f'{META["juego"]} / {META["engine"]}')
    check("META: año 2026 y autoría con los DOS créditos",
          META["anio"] == 2026
          and META["autor"].startswith("Desarrollado por ")
          and "José Domínguez Ramírez" in META["autor"]
          and "Rafael Font Rojas" in META["autor"],
          str(META["autor"]))
    check("META: contacto vacío hoy (la línea NO se renderiza en ACERCA DE)",
          META["contacto"] == "", repr(META["contacto"]))
    check("marca_visible: marca en MAYÚSCULAS para ventana/header",
          marca_visible() == "CTHLG MW2 RANKING", marca_visible())
    check("credits_compact: copy EXACTO de la franja inferior del home",
          credits_compact() == "CTHLG MW2 RANKING v0.1.5 · 2026 · "
          "José Domínguez Ramírez · Rafael Font Rojas", credits_compact())
    check("credits_acerca_de: copy EXACTO de la autoría en Ajustes",
          credits_acerca_de() == "2026 · Desarrollado por José Domínguez "
          "Ramírez · Rafael Font Rojas", credits_acerca_de())
    check("descripcion_acerca_de: copy EXACTO de la descripción en Ajustes",
          descripcion_acerca_de() == "Sistema de ranking, ELO y cloud-save "
          "para Call of Duty: Modern Warfare 2 (2009) — CTHolguin · "
          "IW4x AlterWare r5318", descripcion_acerca_de())
    check("version_tag: 'v' + META.version (title del launcher)",
          version_tag() == "v0.1.5", version_tag())


# ---------------------------------------------------------------------------
# 11. CTHLG.pro: parser (read_pro_meta), fallback (merge_pro_meta) y el
#     archivo real del repo (find_pro_file / launcher_pro_meta).
def phase_pro_meta() -> None:
    print("\n=== Units: CTHLG.pro (parser KEY = VALUE + fallback defaults) ===")

    # --- read_pro_meta: parseo puro sobre un .pro temporal -----------------
    with tempfile.TemporaryDirectory() as tmp:
        pro = Path(tmp) / "CTHLG.pro"
        pro.write_text(
            "# comentario del proyecto\n"
            "\n"
            "PRO_NAME      = CTHLG MW2 Ranking\n"
            "VERSION   =0.1.5\n"
            "ANIO          = 2026\n"
            "CONTACTO      =\n"
            "DESCRIPCION   = Sistema de ranking, ELO y cloud-save para "
            "Call of Duty: Modern Warfare 2 (2009) - CTHolguin\n"
            "   =valor sin clave se descarta\n"
            "linea rota sin igual se descarta\n"
            "SALA1 = CTHolguin Sala 1 - 192.168.2.251:28960\n",
            encoding="utf-8",
        )
        meta = read_pro_meta(pro)
        check("read_pro_meta: KEY = VALUE con trim de ambos lados",
              meta.get("PRO_NAME") == "CTHLG MW2 Ranking"
              and meta.get("VERSION") == "0.1.5"
              and meta.get("ANIO") == "2026",
              str(meta.get("PRO_NAME")))
        check("read_pro_meta: valor con espacios internos se conserva intacto",
              meta.get("DESCRIPCION") == "Sistema de ranking, ELO y "
              "cloud-save para Call of Duty: Modern Warfare 2 (2009) - "
              "CTHolguin", str(meta.get("DESCRIPCION")))
        check("read_pro_meta: valor con host:puerto no se parte (solo 1er '=')",
              meta.get("SALA1") == "CTHolguin Sala 1 - 192.168.2.251:28960",
              str(meta.get("SALA1")))
        check("read_pro_meta: comentarios (#) y líneas vacías ignorados",
              "#" not in str(meta) and len(meta) == 6, str(sorted(meta)))
        check("read_pro_meta: línea sin clave (o valor vacío) se descarta/sin romper",
              "" not in meta and meta.get("CONTACTO") == "",
              repr(meta.get("CONTACTO")))
        vacio = read_pro_meta(Path(tmp) / "NO_EXISTE.pro")
        check("read_pro_meta: archivo ausente → {} (fallback en el llamador)",
              vacio == {}, str(vacio))

    # --- merge_pro_meta: defaults + valores (fallback idéntico) ------------
    base = merge_pro_meta({})
    check("merge_pro_meta({}) → defaults IGUALES al CTHLG.pro del repo",
          base == dict(PRO_META_DEFAULTS), str(base.get("PRO_NAME")))
    check("defaults: identidad CTHLG MW2 Ranking (juego + engine)",
          PRO_META_DEFAULTS["PRO_NAME"] == "CTHLG MW2 Ranking"
          and PRO_META_DEFAULTS["GAME"] == "Call of Duty: Modern Warfare 2 (2009)"
          and PRO_META_DEFAULTS["GAME_ENGINE"] == "IW4x - AlterWare r5318"
          and PRO_META_DEFAULTS["GAME_SHORT"] == "MW2",
          PRO_META_DEFAULTS["PRO_NAME"])
    mezcla = merge_pro_meta({"VERSION": "9.9.9", "ANIO": "2030",
                             "CONTACTO": ""})
    check("merge_pro_meta: clave presente en el .pro MANDA sobre el default",
          mezcla["VERSION"] == "9.9.9" and mezcla["ANIO"] == "2030",
          f'{mezcla["VERSION"]}/{mezcla["ANIO"]}')
    check("merge_pro_meta: clave vacía (CONTACTO=) NO pisa el default",
          mezcla["CONTACTO"] == PRO_META_DEFAULTS["CONTACTO"],
          repr(mezcla["CONTACTO"]))
    basura = merge_pro_meta({"ANIO": "dos-mil-veintiséis"})
    check("merge_pro_meta: ANIO con basura → default (la UI lo pinta como int)",
          basura["ANIO"] == PRO_META_DEFAULTS["ANIO"], basura["ANIO"])

    # --- archivo real del repo + launcher_pro_meta --------------------------
    real = find_pro_file()
    check("find_pro_file: CTHLG.pro existe en la raíz del repo (../../)",
          real is not None and real.name == "CTHLG.pro" and real.is_file(),
          str(real))
    if real is not None:
        del_pro = read_pro_meta(real)
        check("CTHLG.pro real: PRO_NAME/GAME/VERSION del contrato",
              del_pro.get("PRO_NAME") == "CTHLG MW2 Ranking"
              and del_pro.get("GAME") == "Call of Duty: Modern Warfare 2 (2009)"
              and del_pro.get("GAME_ENGINE") == "IW4x - AlterWare r5318"
              and del_pro.get("VERSION") == "0.1.5"
              and del_pro.get("ANIO") == "2026",
              str(del_pro.get("PRO_NAME")))
    vivo = launcher_pro_meta()
    check("launcher_pro_meta: la identidad viva es CTHLG MW2 Ranking v0.1.5 "
          "(con o sin archivo)",
          vivo["PRO_NAME"] == "CTHLG MW2 Ranking"
          and vivo["VERSION"] == "0.1.5"
          and vivo["ANIO"] == "2026",
          f'{vivo["PRO_NAME"]} v{vivo["VERSION"]}')
    check("launcher_pro_meta: coincide con los defaults (UI idéntica sin .pro)",
          vivo == merge_pro_meta(read_pro_meta(real)) if real is not None
          else vivo == dict(PRO_META_DEFAULTS), "")


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
    phase_classes_export()
    phase_app_config()
    phase_servers_validation()
    phase_normalize_api_url()
    phase_server_status_parser()
    phase_salas_endpoint()
    phase_kill_tree()
    phase_wait_process_exit()
    phase_verify_restore()
    phase_autosave()
    phase_medal_parts()
    phase_meta()
    phase_pro_meta()

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
