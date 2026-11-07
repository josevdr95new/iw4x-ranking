"""Tests UNITARIOS del launcher: solo funciones puras, sin red y sin GUI.

Uso:
    py apps\\launcher\\tests\\test_units.py

Qué verifica (mismo estilo [OK]/[FALLO] que test_smoke.py):
  1. game_flow: candidate_matches (normalización de nicks ^X, trim, lower)
     y pick_candidate (match único, sin match → None, recencia).
  2. save_sync (puras): local_save_files (mapeo base/mods/guid),
     sha256_of, decide_sync (matriz completa de decisión), build_upload_files
     (caps ≤24 archivos / ≤256KB, guid primero), detect_build.
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
import sys
import tempfile
import traceback
from pathlib import Path

# Importa los módulos del launcher (directorio padre, sin depender del cwd).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app_config import AppConfig, DEFAULT_CONFIG, normalize_api_url  # noqa: E402
from game_flow import build_game_args, candidate_matches, pick_candidate  # noqa: E402
import save_sync as ss  # noqa: E402
from save_sync import (  # noqa: E402
    build_upload_files,
    decide_sync,
    local_save_files,
    sha256_of,
)

RESULTS: list = []


def check(name, cond, extra=""):
    tag = "OK   " if cond else "FALLO"
    RESULTS.append(f"[{tag}] {name}" + (f" — {extra}" if extra and not cond else ""))
    print(f"[{tag}] {name}" + (f" — {extra}" if extra else ""))


# ---------------------------------------------------------------------------
# 1. game_flow: comparación de nicks y elección de candidato (puras).
def phase_candidate_matching() -> None:
    print("\n=== Units: comparación de nicks / pick_candidate (puras) ===")

    check("match exacto de nick", candidate_matches("El Tester", "El Tester"))
    check("match trim + lower", candidate_matches("  el tester ", "EL TESTER"))
    check("códigos ^X del server se stripean",
          candidate_matches("^7El^1 Tester", "El Tester"))
    check("nick distinto → False",
          not candidate_matches("ZombieSlayer69", "El Tester"))
    check("displayName vacío → False",
          not candidate_matches("Alguien", ""))

    # pick_candidate (pura): filtrado por nick + desambiguación por recencia.
    bots = [{"guid": str(100 + i), "name": f"Bot_{i}",
             "lastConnection": "2026-11-06T09:00:00.000Z"} for i in range(14)]
    bots.append({"guid": "777", "name": "^7El^1 Tester",
                 "lastConnection": "2026-11-06T10:00:00.000Z"})
    picked = pick_candidate(bots, "El Tester")
    check("pick_candidate: encuentra el único match entre bots",
          picked is not None and picked["guid"] == "777", str(picked))
    check("pick_candidate: sin match → None", pick_candidate(bots, "Nadie") is None)
    check("pick_candidate: display vacío → None", pick_candidate(bots, "") is None)
    two = [{"guid": "A", "name": "el tester",
            "lastConnection": "2026-11-06T09:00:00.000Z"},
           {"guid": "B", "name": "^7El^1 Tester",
            "lastConnection": "2026-11-06T11:30:00.000Z"}]
    check("pick_candidate: recencia gana con nick duplicado",
          (pick_candidate(two, "El Tester") or {}).get("guid") == "B")


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
                                  "cloud_save", "link_poll_interval",
                                  "link_poll_max_seconds"}, str(sorted(DEFAULT_CONFIG)))
    check("DEFAULT_CONFIG: api_url de LAN y cloud_save activado",
          DEFAULT_CONFIG["api_url"] == "http://192.168.3.99:3000"
          and DEFAULT_CONFIG["cloud_save"] is True
          and DEFAULT_CONFIG["simulate_game"] is False, str(DEFAULT_CONFIG["api_url"]))

    # diccionario vacío → todas las propiedades caen al default.
    cfg = AppConfig({})
    check("AppConfig: dict vacío cae al api_url del contrato",
          cfg.api_url == DEFAULT_CONFIG["api_url"], cfg.api_url)
    check("AppConfig: dict vacío → game_path vacío y sin servers",
          cfg.game_path == "" and cfg.servers == [],
          f"{cfg.game_path!r} {cfg.servers}")
    check("AppConfig: dict vacío → poll por defecto (10s / 180s)",
          cfg.link_poll_interval == 10
          and cfg.link_poll_max_seconds == 180
          and cfg.default_server == 0)

    # Merge: config vieja con claves faltantes → defaults por clave.
    cfg = AppConfig({"api_url": "http://localhost:3000"})
    check("app_config merge: clave ausente usa default, clave nueva manda",
          cfg.api_url == "http://localhost:3000" and cfg.cloud_save is True,
          cfg.api_url)
    cfg = AppConfig({"link_poll_interval": 0, "link_poll_max_seconds": 1})
    check("app_config: poll se acota a mínimo 1s / 5s",
          cfg.link_poll_interval == 1 and cfg.link_poll_max_seconds == 5,
          f"{cfg.link_poll_interval}/{cfg.link_poll_max_seconds}")
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
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print("Tests unitarios del launcher IW4x Ranking (puras, sin red/GUI)")

    phase_candidate_matching()
    phase_save_sync_pure()
    phase_command_args()
    phase_app_config()
    phase_normalize_api_url()

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
