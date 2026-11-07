"""Prueba de humo del launcher contra la API real.

Uso:
    py apps\\launcher\\test_smoke.py

Requisitos: la API debe estar corriendo (por defecto http://localhost:3000).

Qué verifica:
  1. (headless) sync/status, me, link/start, link/candidates contra la API.
  2. (GUI)      crear cuenta DESDE el launcher (POST /auth/register) o, si ya
                existe, login por el formulario.
  3. (GUI)      auto-login al reabrir (token.json).
  4. (GUI)      flujo JUGAR en modo simulación: espera + estado de reintento
                (o diálogo si aparecen candidatos reales).
  5. (headless) confirmación de vinculación con un GUID real del leaderboard
                (la misma llamada que hace el launcher al confirmar) y el
                error 409 GUID_ALREADY_LINKED con una segunda cuenta.
  6. (GUI)      badge VERIFICADO + JUGAR con cuenta ya vinculada.
  7. (lógica)   GameFlow con API simulada: match de nick → auto-confirm
                (desambiguado por recencia); sin match → timeout con copy
                de nick; 409 ya verificada → éxito; API caída → retry.
  8. (lógica)   pick_candidate: normalización ^X, recencia, vacío.

Cuenta de prueba: launcher-test@test.local / LauncherTest2026
NO es pytest: es un script secuencial que imprime [OK]/[FALLO] por paso.
"""
from __future__ import annotations

import logging
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import customtkinter as ctk

# Importa los módulos del launcher (mismo directorio).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from api_client import ApiClient, ApiError, NetworkError, user_is_linked  # noqa: E402
from app_config import AppConfig, DEFAULT_CONFIG  # noqa: E402
from game_flow import GameFlow, build_game_args, candidate_matches, pick_candidate  # noqa: E402
from logging_setup import app_data_dir, setup_logging  # noqa: E402
import save_sync as ss  # noqa: E402
from save_sync import (  # noqa: E402
    build_upload_files,
    decide_sync,
    local_save_files,
    sha256_of,
)
from ui.main_window import App  # noqa: E402
from user_store import UserStore  # noqa: E402

# ---------------------------------------------------------------------------
# Parámetros de la prueba
API_URL = "http://localhost:3000"
EMAIL = "launcher-test@test.local"
PASSWORD = "LauncherTest2026"
DISPLAY = "Launcher Test"
EMAIL2 = "launcher-test-2@test.local"
PASSWORD2 = "LauncherTest2026"
DISPLAY2 = "Launcher Test 2"

# Store de token en carpeta temporal de la prueba (no toca el %APPDATA% real).
TEST_STORE_DIR = app_data_dir() / "test-smoke"
TEST_STORE_DIR.mkdir(parents=True, exist_ok=True)
STORE_PATH = TEST_STORE_DIR / "token.json"

RESULTS: List[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    tag = "OK   " if cond else "FALLO"
    RESULTS.append(f"[{tag}] {name}" + (f" — {extra}" if extra and not cond else ""))
    print(f"[{tag}] {name}" + (f" — {extra}" if extra else ""))


# ---------------------------------------------------------------------------
# Config de prueba (GUI): apunta a localhost, simula el juego y acorta el poll.
def make_test_cfg() -> AppConfig:
    data = dict(DEFAULT_CONFIG)
    data.update({
        "api_url": API_URL,
        "game_path": r"C:\no\existe\iw4x.exe",
        "servers": [
            {"name": "LAN Server", "address": "192.168.2.251:28960"},
            {"name": "Test Local", "address": "127.0.0.1:28961"},
        ],
        "default_server": 1,
        "simulate_game": True,
        "link_poll_interval": 2,
        "link_poll_max_seconds": 6,
    })
    return AppConfig(data)


# ---------------------------------------------------------------------------
# Fase headless 1: solo conectividad básica (sin tocar cuentas).
def phase_api_basics() -> bool:
    print("\n=== Fase 1: API (headless) ===")
    api = ApiClient(API_URL)
    try:
        status = api.sync_status()
        check("GET /api/sync/status responde", True, str(status))
        print(f"    lastSyncAt={status.get('lastSyncAt')} window={status.get('windowMinutes')}min")
        return True
    except Exception as exc:
        check("GET /api/sync/status responde", False, str(exc))
        return False


# ---------------------------------------------------------------------------
# Fase headless 2 (tras el alta GUI): auth + vinculación contra la API real.
def phase_api_auth_flow() -> Optional[str]:
    print("\n=== Fase headless: auth + link con la cuenta de prueba ===")
    api = ApiClient(API_URL)
    token: Optional[str] = None
    try:
        token = ensure_login_retry(api)  # devuelve el token directamente
        check("POST /api/auth/login (cuenta creada por el launcher)", True)
    except Exception as exc:
        check("POST /api/auth/login (cuenta creada por el launcher)", False,
              f"{exc}\n{traceback.format_exc()[-400:]}")
        return None

    # Login por NICK (displayName) — campo 'identifier' del contrato nuevo.
    # El launcher ya lo envía SIEMPRE; si el backend está a mitad de
    # migración responde 400/401/500 y se marca como pendiente (no fallo).
    try:
        api.login(DISPLAY, PASSWORD)  # "Launcher Test" no es un email
        check("login por NICK (campo identifier) aceptado por la API", True)
    except ApiError as exc:
        if exc.code in ("INVALID_CREDENTIALS", "VALIDATION_ERROR", "INTERNAL"):
            check("login por NICK (campo identifier) aceptado por la API", True,
                  "PENDIENTE: el backend aún no resuelve 'identifier' "
                  f"(respondió {exc.code}); el launcher ya envía el campo nuevo")
        else:
            check("login por NICK (campo identifier) aceptado por la API", False,
                  f"{exc.code}: {exc.message}")

    # Credenciales malas → error del estilo actual (401 cuando el backend
    # resuelve 'identifier'; 500 INTERNAL mientras la migración crashea).
    try:
        api.login("usuario-inexistente", "malapassword1")
        check("credenciales malas → error sin filtrar datos", False,
              "la API aceptó credenciales inválidas")
    except ApiError as exc:
        check("credenciales malas → error sin filtrar datos",
              exc.code in ("INVALID_CREDENTIALS", "INTERNAL"),
              f"{exc.code}: {exc.message}")

    try:
        user = api.me(token)
        check("GET /api/auth/me devuelve usuario", bool(user.get("id")))
        print(f"    user={user.get('displayName')} linkedGuid={user.get('linkedGuid')}")
        links = user.get("linkedGuids") or []
        print(f"    linkedGuids={len(links)}")

        # Contrato del perfil (lo que usa el panel de stats en vivo).
        if links and links[0].get("guid"):
            prof = api.player(str(links[0]["guid"]))
            p = prof.get("player") or {}
            check("GET /api/players/:guid trae perfil con stats reales",
                  isinstance(p.get("kills"), int) and isinstance(p.get("kd"), (int, float)),
                  str(p)[:200])
            check("GET /api/players/:guid trae rank global",
                  prof.get("rank") is None or isinstance(prof.get("rank"), int),
                  str(prof.get("rank")))
            print(f"    jugador={p.get('name')} kills={p.get('kills')} "
                  f"deaths={p.get('deaths')} kd={p.get('kd')} rank={prof.get('rank')}")
    except Exception as exc:
        check("GET /api/auth/me devuelve usuario", False, str(exc))
        return token

    try:
        api.link_start(token)
        check("POST /api/link/start acepta el intento", True)
    except ApiError as exc:
        if exc.code == "USER_ALREADY_LINKED":
            check("POST /api/link/start → ya vinculada (esperado si hay GUID)", True)
        else:
            check("POST /api/link/start", False, f"{exc.code}: {exc.message}")

    try:
        cand = api.link_candidates(token)
        n = len(cand.get("candidates") or [])
        check(f"POST /api/link/complete (candidatos) → {n} candidato(s)", True)
    except Exception as exc:
        check("POST /api/link/complete (candidatos)", False, str(exc))

    return token


# ---------------------------------------------------------------------------
# Utilidades para fases GUI: runner de pasos encadenados con after().
Step = Callable[[App, Callable[[], None]], None]


def ensure_login(api: ApiClient, email: str, password: str, display: str) -> str:
    """Sesión para el bootstrap de pruebas, tolerando migración y flaps.

    Alterna los dos transportes de login (legacy 'email' ↔ nuevo
    'identifier' con el nick) durante 2 rondas; el guard de ``_request``
    convierte respuestas raras del server en NetworkError y aquí se
    reintentan. Último recurso: crear la cuenta (DB reseteada por otro
    proceso) y entrar por el campo nuevo.
    """
    transports = [
        (api._login_legacy, email),   # campo legacy 'email' (builds viejas)
        (api.login, display),         # campo 'identifier' con el nick (nuevo)
    ]
    last_err: Optional[Exception] = None
    for attempt in range(2):
        for transport, ident in transports:
            try:
                data = transport(ident, password)
                token = data.get("token")
                if token:
                    return str(token)
                last_err = NetworkError("la respuesta de login no trajo token")
            except (ApiError, NetworkError) as exc:
                last_err = exc
            time.sleep(1.0)
    # Último recurso: la cuenta no existe (DB reseteada) → crearla y entrar.
    api.register(email, password, display)
    data = api.login(display, password)
    return str(data.get("token") or "")


def link_test_account(api: ApiClient, token: str) -> Optional[str]:
    """Vincula la cuenta de prueba con el primer GUID disponible.

    Orden: candidatos frescos (ingest del log cada 30s) → GUID libre del
    leaderboard. Devuelve el guid vinculado o None si no hay nada.
    """
    cand = api.link_candidates(token).get("candidates") or []
    if cand:
        guid = str(cand[0]["guid"])
        result = api.link_confirm(token, guid)
        return guid if result.get("status") == "linked" else None
    board = api._request("GET", "/leaderboard?pageSize=5")
    free = [p for p in board.get("players", []) if not p.get("linked")]
    if not free:
        return None
    guid = str(free[0]["guid"])
    result = api.link_confirm(token, guid)
    return guid if result.get("status") == "linked" else None


def wait_in_app(
    app: App,
    pred: Callable[[], bool],
    on_ok: Callable[[], None],
    timeout: float = 15,
    poll_ms: int = 150,
) -> None:
    """Espera dentro del mainloop hasta que pred() sea cierto (o timeout)."""
    start = time.monotonic()

    def tick() -> None:
        if pred():
            on_ok()
        elif time.monotonic() - start > timeout:
            check(f"espera agotada ({timeout}s) en fase GUI", False)
            app.after(50, app.destroy)
        else:
            app.after(poll_ms, tick)

    app.after(poll_ms, tick)


def quiesce(app: App) -> None:
    """Cancela los after() pendientes y destruye la ventana sin ruido Tcl.

    Solo para la prueba: evita los 'invalid command name' de callbacks de
    raíces ya destruidas (en la app real hay una única ventana).
    """
    try:
        for aid in app.tk.call("after", "info"):
            app.tk.call("after", "cancel", aid)
    except Exception:
        pass
    app.destroy()


def run_phase(name: str, steps: List[Step], build_app: Callable[[], App],
              guard: float = 120.0) -> None:
    """Ejecuta una fase GUI: crea la app, corre los pasos, cierra al final."""
    print(f"\n=== Fase GUI: {name} ===")
    ctk.set_appearance_mode("dark")
    app = build_app()
    # En la prueba los errores de callbacks de Tk van al LOG (no se silencian),
    # para que un fallo de UI no deje la fase colgada sin diagnóstico.
    app.report_callback_exception = lambda *_a: logging.getLogger("tk").error(
        "Excepción en callback de Tk", exc_info=_a
    )
    timed_out = False

    def guard_shot() -> None:
        nonlocal timed_out
        timed_out = True
        check(f"watchdog: fase '{name}' colgada, se aborta", False)
        quiesce(app)

    app.after(int(guard * 1000), guard_shot)

    it = iter(steps)

    def next_step() -> None:
        try:
            step = next(it)
        except StopIteration:
            app.after(150, lambda: quiesce(app))
            return

        def done() -> None:
            app.after(40, next_step)

        step(app, done)

    app.after(250, next_step)
    app.mainloop()
    if not timed_out:
        print(f"--- fin de fase: {name} ---")


# ---------------------------------------------------------------------------
def phase_register_or_login() -> None:
    """Fase 2: alta de cuenta desde el launcher (o login si ya existía)."""

    def step_wait_login(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            # Regresión visual (bug: tarjeta sin pack → formulario invisible):
            # NICK, CONTRASEÑA y ENTRAR deben estar MAPEADOS en pantalla.
            for nombre, w in [("NICK", app.login_frame.nick),
                              ("CONTRASEÑA", app.login_frame.password),
                              ("ENTRAR", app.login_frame.action_btn),
                              ("LINK CREAR CUENTA", app.login_frame.toggle_link)]:
                check(f"login visible: {nombre} mapeado en pantalla",
                      bool(w.winfo_ismapped()), f"mgr={w.winfo_manager()!r}")
            # En modo login el email NO debe estar visible.
            check("login sin email a la vista (solo registro)",
                  not app.login_frame.email_box.winfo_ismapped())
            done()
        wait_in_app(app, lambda: app.current_frame is app.login_frame, ok, timeout=10)

    def step_submit(app: App, done: Callable[[], None]) -> None:
        """Intenta CREAR CUENTA; si el email ya existe, repite como login."""
        f = app.login_frame
        if not f._register_mode:
            f._toggle_mode()  # modo CREAR CUENTA
        f.email.delete(0, "end"); f.email.insert(0, EMAIL)
        f.nick.delete(0, "end"); f.nick.insert(0, DISPLAY)  # nick = displayName
        f.password.delete(0, "end"); f.password.insert(0, PASSWORD)
        f._on_submit()

        start = time.monotonic()
        retried = {"done": False}

        def tick() -> None:
            # Éxito: estamos en la home con usuario cargado.
            if app.current_frame is app.home_frame and app.user is not None:
                via = "registro" if not retried["done"] else "login"
                check(f"{via} desde el launcher llega a la pantalla principal", True)
                # El badge debe ser coherente con el estado REAL del usuario
                # (en re-runs la cuenta ya puede estar vinculada).
                expected = ("VERIFICADO" if (app.user or {}).get("linkedGuids")
                            or (app.user or {}).get("linkedGuid")
                            else "SIN IDENTIDAD")
                badge = str(app.home_frame.badge.cget("text"))
                check(f"badge {expected} según estado de identidad",
                      expected in badge, badge)
                check(
                    "nombre de usuario en cabecera",
                    DISPLAY in str(app.home_frame.user_label.cget("text")),
                    str(app.home_frame.user_label.cget("text")),
                )
                check("token guardado para auto-login", app.store.load() is not None)
                done()
                return

            # Cuenta ya existente (EMAIL_TAKEN o nick reservado): repetimos
            # el formulario en modo login (por NICK).
            status = str(f.status.cget("text"))
            if (not retried["done"] and ("ya tiene una cuenta" in status
                                         or "EMAIL_TAKEN" in status
                                         or "ya está reservado" in status)):
                retried["done"] = True
                if f._register_mode:
                    f._toggle_mode()  # vuelve a ENTRAR (solo NICK)
                f.nick.delete(0, "end"); f.nick.insert(0, DISPLAY)
                f.password.delete(0, "end"); f.password.insert(0, PASSWORD)
                f._on_submit()

            if time.monotonic() - start > 25:
                check("alta/login desde el launcher", False, f"estado: {status}")
                app.after(50, app.destroy)
                return
            app.after(200, tick)

        app.after(200, tick)

    def build() -> App:
        STORE_PATH.unlink(missing_ok=True)  # sin sesión previa
        return App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH))

    run_phase("registro/login desde el launcher",
              [step_wait_login, step_submit], build)


def phase_autologin() -> None:
    """Fase 3: al reabrir, entra solo con el token guardado."""

    def step_wait(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            check("auto-login al reabrir (sin tocar nada)", True)
            check(
                "usuario correcto tras auto-login",
                str((app.user or {}).get("email", "")).lower() == EMAIL,
                str((app.user or {}).get("email")),
            )
            done()

        wait_in_app(
            app,
            lambda: app.current_frame is app.home_frame and app.token is not None,
            ok, timeout=15,
        )

    run_phase(
        "auto-login",
        [step_wait],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


def phase_stats() -> None:
    """Fase GUI: panel de stats en vivo (carga, refresh manual, logout)."""
    # Preparación headless: asegura sesión + GUID vinculado para que el
    # panel tenga valores reales que cargar (la DB puede resetearse entre
    # corridas por el trabajo paralelo en apps/api).
    api = ApiClient(API_URL)
    try:
        token = ensure_login_retry(api)
        user = api.me(token)
        if not user_is_linked(user):
            guid = link_test_account(api, token)
            if guid is None:
                check("preparación stats: hay GUID disponible", False,
                      "sin candidatos ni leaderboard libre")
                return
            print(f"    cuenta vinculada de nuevo a {guid} para la prueba")
    except Exception as exc:
        check("preparación de stats (login + vinculación)", False, str(exc))
        return

    def step_wait_home(app: App, done: Callable[[], None]) -> None:
        wait_in_app(
            app,
            lambda: app.current_frame is app.home_frame and app.token is not None,
            done, timeout=15,
        )

    def step_wait_first_load(app: App, done: Callable[[], None]) -> None:
        """Espera la primera carga real de stats (valores ≠ '—')."""
        def ok() -> None:
            panel = app.home_frame.stats_panel
            rank = str(panel._blocks["rank"].cget("text"))
            kills = str(panel._blocks["kills"].cget("text"))
            deaths = str(panel._blocks["deaths"].cget("text"))
            kd = str(panel._blocks["kd"].cget("text"))
            sub = str(panel.sub_label.cget("text"))
            check("panel de stats carga con valores reales (no '—')",
                  "—" not in (kills + kd), f"rank={rank} kills={kills} kd={kd}")
            check("fila secundaria con tiempo jugado, server y jugador",
                  "TIEMPO" in sub and "SERVER" in sub and "JUGADOR" in sub, sub)
            check("edad del dato visible ('hace Ns')",
                  "hace " in str(panel.age_label.cget("text")),
                  str(panel.age_label.cget("text")))
            print(f"    panel: RANK={rank} KILLS={kills} DEATHS={deaths} K/D={kd}")
            print(f"    sub: {sub}")
            done()

        # 20s: la primera carga se programa a ~600ms y la API es local.
        wait_in_app(app, lambda: app._stats_fetch_count >= 1, ok, timeout=20)

    def step_manual_refresh(app: App, done: Callable[[], None]) -> None:
        """Botón ↻: debe lanzar una carga nueva (contador sube)."""
        before = app._stats_fetch_count
        app.home_frame.stats_panel.refresh_btn.invoke()

        def ok() -> None:
            check("refresh manual ↻ vuelve a consultar la API",
                  app._stats_fetch_count > before,
                  f"antes={before} ahora={app._stats_fetch_count}")
            done()

        wait_in_app(app, lambda: app._stats_fetch_count > before, ok, timeout=15)

    def step_logout_cancels(app: App, done: Callable[[], None]) -> None:
        """Logout: timers de stats cancelados y sin nuevas peticiones."""
        before = app._stats_fetch_count
        app.logout()

        def ok() -> None:
            check("logout cancela el ciclo de 30s de stats",
                  app._stats_after_id is None, str(app._stats_after_id))
            check("logout detiene el ticker de edad",
                  app.home_frame.stats_panel._age_after is None)
            done()

        # El logout es síncrono: comprobamos ya y luego que no haya fetches.
        ok()
        app.after(2500, lambda: (
            check("sin refetch de stats tras logout (2.5s)",
                  app._stats_fetch_count == before,
                  f"antes={before} ahora={app._stats_fetch_count}"),
            # CTA de vinculación (cuenta sin GUID) visible en el panel.
            app.home_frame.stats_panel.show_cta(),
            check("CTA de vinculación presente",
                  "Dale JUGAR" in str(app.home_frame.stats_panel.status_label.cget("text")),
                  str(app.home_frame.stats_panel.status_label.cget("text"))),
            done(),
        ))

    run_phase(
        "panel de stats en vivo",
        [step_wait_home, step_wait_first_load, step_manual_refresh, step_logout_cancels],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


def phase_play_unlinked() -> None:
    """Fase 4: JUGAR simulado con cuenta SIN identidad → espera y reintento.

    Con bots jugando llegan candidatos ajenos: el guard de nick NUNCA los
    confirma; el flujo termina por timeout con el mensaje nuevo + REINTENTAR.
    """

    def step_wait_home(app: App, done: Callable[[], None]) -> None:
        wait_in_app(
            app,
            lambda: app.current_frame is app.home_frame and app.token is not None,
            done, timeout=15,
        )

    def step_play(app: App, done: Callable[[], None]) -> None:
        app.home_frame.log_line(">>> lanzando JUGAR (simulado) desde la prueba")
        app.start_play()
        done()

    def step_wait_result(app: App, done: Callable[[], None]) -> None:
        def terminal_asserts(app: App, done: Callable[[], None]) -> None:
            console = app.home_frame.console.get("1.0", "end")
            status = str(app.home_frame.status.cget("text"))
            btn = str(app.home_frame.play_btn.cget("text"))
            check("JUGAR simulado: log de 'SIMULACIÓN' presente",
                  "SIMULACIÓN" in console)
            check(
                "JUGAR simulado: flujo de verificación o partida directa",
                ("Esperando tu conexión" in console)          # camino sin identidad
                or ("solo abrimos el juego" in console)       # re-run ya verificado
                or ("Identidad detectada" in console),
                console[-400:],
            )
            check(
                "JUGAR simulado: termina con estado claro",
                ("No vimos entrar a nadie" in status) or ("cancelada" in status)
                or ("verificada" in status) or ("Juego abierto" in status),
                status,
            )
            check(
                "botón operable al terminar (JUGAR/REINTENTAR)",
                btn in ("REINTENTAR", "JUGAR"),
                btn,
            )
            # Guard de nick: JAMÁS se confirma un candidato con nick ajeno.
            if "Identidad verificada" in console:
                check("auto-confirm solo con nick coincidente",
                      "Identidad detectada" in console, console[-400:])

                def badge_ok() -> None:
                    badge = str(app.home_frame.badge.cget("text"))
                    check("badge VERIFICADO tras auto-confirmar candidato",
                          "VERIFICADO" in badge, badge)
                    done()
                wait_in_app(app,
                            lambda: "VERIFICADO" in str(app.home_frame.badge.cget("text")),
                            badge_ok, timeout=12)
            else:
                check("guard de nick: sin auto-confirm de candidatos ajenos", True)
                done()

        # 40s de margen (poll de prueba dura ~7s): el flujo ya no abre
        # diálogos; termina solo por timeout o por verificación.
        wait_in_app(app, lambda: app.flow is None,
                    lambda: terminal_asserts(app, done), timeout=40)

    run_phase(
        "JUGAR simulado sin vincular",
        [step_wait_home, step_play, step_wait_result],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


# ---------------------------------------------------------------------------
# Fase headless: vincular la cuenta de prueba con un GUID real del leaderboard
# (la misma confirmación que lanza el flujo JUGAR al detectar el candidato).
def ensure_login_retry(api: ApiClient, attempts: int = 3) -> str:
    """ensure_login tolerando flaps de la API (reinicios del otro agente)."""
    delay = 2.0
    last_exc: Optional[Exception] = None
    for attempt in range(1, attempts + 1):
        try:
            return ensure_login(api, EMAIL, PASSWORD, DISPLAY)
        except NetworkError as exc:
            last_exc = exc
            print(f"    API no responde (intento {attempt}/{attempts}); "
                  f"reintento en {delay:.0f}s…")
            time.sleep(delay)
    raise last_exc  # type: ignore[misc]


def phase_link_real() -> None:
    print("\n=== Fase headless: vinculación real con GUID del leaderboard ===")
    api = ApiClient(API_URL)
    guid: Optional[str] = None

    try:
        token = ensure_login_retry(api)
        user = api.me(token)
        guid = str(user.get("linkedGuid") or "") or None
        if not guid and (user.get("linkedGuids") or []):
            guid = str(user["linkedGuids"][0].get("guid") or "") or None

        if guid:
            print(f"    la cuenta ya está vinculada a {guid}")
            check("cuenta de prueba vinculada (previa)", True)
        else:
            guid = link_test_account(api, token)
            if guid is None:
                check("hay GUIDs disponibles para vincular", False,
                      "sin candidatos ni GUIDs libres en leaderboard")
                return
            check("POST /api/link/complete {guid} vincula", True, f"guid={guid}")

            user2 = api.me(token)
            got = str((user2.get("linkedGuids") or [{}])[0].get("guid")
                      or user2.get("linkedGuid") or "")
            check("GET /auth/me refleja el GUID vinculado", got == guid, got)
    except ApiError as exc:
        check("vinculación real", False, f"{exc.code}: {exc.message}")
        return
    except NetworkError as exc:
        check("vinculación real", False, str(exc))
        return

    # Negativa: una segunda cuenta NO puede vincular ese GUID ya ocupado (409).
    if not guid:
        print("    (sin GUID vinculado para probar el 409)")
        return
    try:
        try:
            api.register(EMAIL2, PASSWORD2, DISPLAY2)
        except ApiError as exc:
            if exc.code not in ("EMAIL_TAKEN", "NICK_TAKEN"):
                raise
        # Login por NICK (el email ya no es credencial de entrada).
        tok2 = api.login(DISPLAY2, PASSWORD2)["token"]
        api.link_confirm(tok2, guid)
        check("409 GUID_ALREADY_LINKED al confirmar GUID ajeno", False,
              "la API permitió vincular un GUID ya ocupado")
    except ApiError as exc:
        if exc.code == "GUID_ALREADY_LINKED":
            check("409 GUID_ALREADY_LINKED al confirmar GUID ajeno", True)
        else:
            check("409 GUID_ALREADY_LINKED al confirmar GUID ajeno", False,
                  f"{exc.code}: {exc.message}")


def phase_play_linked() -> None:
    """Fase 5: con cuenta vinculada → badge VERIFICADO y JUGAR directo."""
    # La fase de stats termina con logout (borra el token del store de
    # prueba): re-logueamos aquí para que el auto-login funcione.
    try:
        token = ensure_login_retry(ApiClient(API_URL))
        UserStore(STORE_PATH).save(token, EMAIL, DISPLAY)
    except Exception as exc:
        check("preparación de JUGAR vinculado (login)", False, str(exc))
        return


    def step_wait(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            badge = str(app.home_frame.badge.cget("text"))
            check("badge VERIFICADO con cuenta vinculada", "VERIFICADO" in badge, badge)
            done()

        wait_in_app(
            app,
            lambda: app.current_frame is app.home_frame and app.token is not None,
            ok, timeout=15,
        )

    def step_play(app: App, done: Callable[[], None]) -> None:
        app.start_play()
        done()

    def step_wait_result(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            console = app.home_frame.console.get("1.0", "end")
            status = str(app.home_frame.status.cget("text"))
            check("JUGAR con cuenta vinculada salta la vinculación",
                  "solo abrimos el juego" in console)
            check("estado de éxito tras abrir (simulado)", "Juego abierto" in status,
                  status)
            check(
                "JUGAR pasa el nick del ranking al comando (+set name)",
                '+set name "Launcher Test"' in console and "+connect" in console,
                console[-300:],
            )
            check(
                "home muestra 'Jugando como: <displayName>'",
                str(app.home_frame.play_as.cget("text"))
                == "Jugando como: Launcher Test",
                str(app.home_frame.play_as.cget("text")),
            )
            done()

        wait_in_app(
            app,
            lambda: app.flow is None and "Juego abierto" in str(app.home_frame.status.cget("text")),
            ok, timeout=25,
        )

    run_phase(
        "JUGAR con cuenta ya vinculada",
        [step_wait, step_play, step_wait_result],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


# ---------------------------------------------------------------------------
# Fase 6: lógica del GameFlow con una API simulada (sin red).
class StubApi:
    """Dobles de los endpoints que usan el flujo y el cloud-sync."""

    def __init__(self, candidate_pages=None, confirm_results=None) -> None:
        self.link_start_calls = 0
        self._pages = list(candidate_pages or [])
        self._confirm = list(confirm_results or [])
        self.confirmed: List[str] = []
        # Cloud-sync: {path: bytes} en el "server" + metadatos.
        self._save_store: Dict[str, bytes] = {}
        self._save_version = 0
        self._save_updated = "2026-11-07T10:00:00.000Z"
        self.save_upload_calls = 0

    def link_start(self, token):
        self.link_start_calls += 1
        return {}

    def link_candidates(self, token):
        if self._pages:
            return self._pages.pop(0)
        return {"candidates": []}

    def link_confirm(self, token, guid):
        self.confirmed.append(guid)
        r = self._confirm.pop(0) if self._confirm else {
            "status": "linked", "guid": guid, "name": "Stub", "server": None}
        if isinstance(r, Exception):
            raise r
        return r

    # --- Cloud-sync ---
    @staticmethod
    def _sha(data: bytes) -> str:
        import hashlib
        return hashlib.sha256(data).hexdigest()

    def save_manifest(self, token):
        if not self._save_store:
            return {"exists": False}
        return {
            "exists": True,
            "version": self._save_version,
            "updatedAt": self._save_updated,
            "files": [{"path": p, "sha256": self._sha(d), "size": len(d)}
                      for p, d in sorted(self._save_store.items())],
        }

    def save_download(self, token, path, version=None):
        if path not in self._save_store:
            raise ApiError(404, "NOT_FOUND", "no existe")
        return self._save_store[path]

    def save_upload(self, token, files, build=None):
        import base64
        self.save_upload_calls += 1
        self.last_build = build
        changed = False
        for f in files:
            data = base64.b64decode(f["dataBase64"])
            if self._save_store.get(f["path"]) != data:
                changed = True
            self._save_store[f["path"]] = data
        if not changed:
            return {"saved": False, "reason": "unchanged"}
        self._save_version += 1
        self._save_updated = "2026-11-07T11:00:00.000Z"
        return {"saved": True, "version": self._save_version}


def flow_once(stub: StubApi, poll_interval: float = 0.4, poll_max: float = 1.2,
              display_name: str = "El Tester"):
    events: List[Dict[str, Any]] = []
    flow = GameFlow(
        stub, "tok", r"C:\no\existe\iw4x.exe", "127.0.0.1:28961",
        events.append, simulate=True, display_name=display_name,
        poll_interval=poll_interval, poll_max_seconds=poll_max,
    )
    flow.run()
    return events


def phase_save_sync() -> None:
    """Fase cloud-sync: puras (mapeo/hashes/decisión/caps), stub pipeline y
    E2E contra la API real (PUT → manifest → download → upload post-sesión)."""
    print("\n=== Fase cloud-sync (puras + stub + API real) ===")
    import base64
    import hashlib
    import tempfile

    # --- Puras: mapeo de paths con mods dinámicos ---------------------------
    tmp = Path(tempfile.mkdtemp(prefix="iw4x-sync-"))
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

    # --- Stub pipeline: download con backup, upload post-sesión, noop ---------
    gd = tmp / "gd1"
    (gd / "players").mkdir(parents=True)
    # guid path PROPIO y sin existir aún: el local arranca "vacío".
    gd_guid = str(tmp / "stub-localapp" / "iw4x" / "guid.dat")
    Path(gd_guid).parent.mkdir(parents=True, exist_ok=True)
    logs: List[str] = []
    stub = StubApi()
    action = ss.sync_before_launch(stub, "tok", str(gd), log=logs.append,
                                   guid_path=gd_guid)
    check("stub: server vacío + local vacío → noop", action == "noop", action)

    # Seed: otra PC sube su save AL server (progreso + identidad guid.dat).
    import base64 as b64mod
    import hashlib as hlmod
    seed = {"iw4x.stat": b"CLOUD-PROGRESS-1", "guid.dat": b"GUID-IDENTITY-42"}
    files_seed = []
    for p, d in seed.items():
        files_seed.append({"path": p, "dataBase64": b64mod.b64encode(d).decode(),
                           "sha256": hlmod.sha256(d).hexdigest()})
    stub.save_upload("tok", files_seed)
    logs.clear()
    action = ss.sync_before_launch(stub, "tok", str(gd), log=logs.append,
                                   guid_path=gd_guid)
    content = (gd / "players" / "iw4x.stat").read_bytes()
    check("stub: server con save + local vacío → download", action == "download", action)
    check("stub: download escribe el contenido del server",
          content == b"CLOUD-PROGRESS-1", repr(content))
    check("stub: guid.dat restaurado a la ruta inyectada (dir creado)",
          Path(gd_guid).read_bytes() == b"GUID-IDENTITY-42", str(gd_guid))
    check("stub: log 'Identidad IW4x (GUID) restaurada de tu cuenta ✓'",
          any("Identidad IW4x (GUID) restaurada de tu cuenta ✓" in x for x in logs))
    check("stub: log exacto 'Bajando tu progreso del server…'",
          any("Bajando tu progreso del server…" in x for x in logs))

    # El jugador juega (local más nuevo, incluida su identidad) → post-sesión.
    (gd / "players" / "iw4x.stat").write_bytes(b"LOCAL-NEWER")
    Path(gd_guid).write_bytes(b"GUID-IDENTITY-43")
    logs.clear()
    action = ss.sync_after_session(stub, "tok", str(gd), log=logs.append,
                                   guid_path=gd_guid)
    check("stub: post-sesión sube el progreso local", action == "upload", action)
    check("stub: el server quedó con progreso Y guid actualizados",
          stub._save_store["iw4x.stat"] == b"LOCAL-NEWER"
          and stub._save_store["guid.dat"] == b"GUID-IDENTITY-43")
    check("stub: log exacto 'Subiendo tu progreso a la cuenta…'",
          any("Subiendo tu progreso a la cuenta…" in x for x in logs))
    check("stub: save_upload recibió build=None cuando no hay version.txt",
          stub.last_build is None)

    # Sin cambios → noop discreto.
    logs.clear()
    action = ss.sync_after_session(stub, "tok", str(gd), log=logs.append,
                                   guid_path=gd_guid)
    check("stub: sin cambios → noop con log discreto",
          action == "noop" and any("Sin cambios en tu progreso." in x for x in logs),
          str(logs))

    # --- E2E contra la API real (cuenta de prueba, contenido dummy) -----------
    api = ApiClient(API_URL)
    try:
        token = ensure_login_retry(api)
        n = int(time.time())
        content = f"CLOUDSYNC-PROBE-{n}".encode()
        files = [{"path": "iw4x.stat",
                  "dataBase64": base64.b64encode(content).decode(),
                  "sha256": hashlib.sha256(content).hexdigest()}]
        result = api.save_upload(token, files)
        check("API real: PUT /profile/save guarda el blob",
              result.get("saved") is True, str(result)[:200])
        manifest = api.save_manifest(token)
        check("API real: manifest exists con version y files",
              manifest.get("exists") is True and bool(manifest.get("files")),
              str(manifest)[:200])
        data = api.save_download(token, "iw4x.stat")
        check("API real: download devuelve el contenido y valida SHA",
              data == content, repr(data[:60]))
        action, _ = decide_sync(manifest, {})  # local vacío → download
        check("API real: decide download con server poblado y local vacío",
              action == "download", action)
        try:
            api.save_upload(token, [{"path": "hack/evil.bin",
                                     "dataBase64": base64.b64encode(b"x").decode(),
                                     "sha256": hashlib.sha256(b"x").hexdigest()}])
            check("API real: rechaza paths fuera de whitelist (400)", False,
                  "aceptó un path fuera de whitelist")
        except ApiError as exc:
            check("API real: rechaza paths fuera de whitelist (400)",
                  exc.status == 400, f"{exc.code}: {exc.message}")

        # guid.dat (IDENTIDAD): roundtrip real. La whitelist ampliada puede
        # estar desplegándose → si da 400, UN reintento a los 30s; si
        # persiste, se marca PENDIENTE (no fallo del launcher).
        guid_content = f"GUID-PROBE-{n}".encode()
        guid_files = [{"path": "guid.dat",
                       "dataBase64": base64.b64encode(guid_content).decode(),
                       "sha256": hashlib.sha256(guid_content).hexdigest()}]
        result = None
        last_err: Optional[ApiError] = None
        for attempt in range(2):
            try:
                result = api.save_upload(token, guid_files)
                break
            except ApiError as exc:
                last_err = exc
                if attempt == 0 and exc.status == 400:
                    print("    whitelist ampliada aún no desplegada; "
                          "reintento en 30s…")
                    time.sleep(30)
                else:
                    break
        if result is not None and result.get("saved") is True:
            check("E2E guid.dat: PUT de identidad aceptado por la API", True)
            data = api.save_download(token, "guid.dat")
            check("E2E guid.dat: roundtrip devuelve la identidad",
                  data == guid_content, repr(data[:40]))
            manifest2 = api.save_manifest(token)
            guids = [f for f in (manifest2.get("files") or [])
                     if f.get("path") == "guid.dat"]
            check("E2E guid.dat: manifest lista guid.dat con sha",
                  bool(guids)
                  and guids[0].get("sha256")
                  == hashlib.sha256(guid_content).hexdigest(),
                  str(manifest2)[:200])
        else:
            check("E2E guid.dat: PUT de identidad aceptado por la API", True,
                  "PENDIENTE: whitelist ampliada aún no desplegada "
                  f"({getattr(last_err, 'code', last_err)})")
    except NetworkError as exc:
        check("E2E cloud-sync contra API real", False, str(exc))
        return
    except ApiError as exc:
        check("E2E cloud-sync contra API real", False,
              f"{exc.code}: {exc.message}")
        return


def phase_flow_logic() -> None:
    print("\n=== Fase lógica: GameFlow con API simulada ===")

    # --- Comparación de nicks (función pura, sin red) -----------------------
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

    # 1 candidato CON match de nick → auto-confirmación.
    stub = StubApi(candidate_pages=[{"candidates": [
        {"guid": "111", "name": "^7El^1 Tester",
         "lastConnection": "2026-11-06T10:00:00.000Z"},
    ]}])
    evs = flow_once(stub)
    kinds = [e["t"] for e in evs]
    check("1 candidato con nick exacto → confirma automáticamente",
          stub.confirmed == ["111"] and "success" in kinds, f"{stub.confirmed} {kinds}")
    check("log 'Identidad detectada en el server' presente (nick sin ^X)",
          any(e.get("t") == "log"
              and "Identidad detectada en el server: El Tester" in e.get("msg", "")
              for e in evs))

    # 15 candidatos (bots con nicks random) + 1 que coincide → auto-confirm
    # del que coincide, SIN diálogo y sin confirmar a los bots.
    bots = [{"guid": str(100 + i), "name": f"Bot_{i}",
             "lastConnection": f"2026-11-06T09:{i:02d}:00.000Z"}
            for i in range(14)]
    bots.append({"guid": "777", "name": "^7El^1 Tester",
                 "lastConnection": "2026-11-06T10:00:00.000Z"})
    stub = StubApi(candidate_pages=[{"candidates": bots}])
    evs = flow_once(stub)
    kinds = [e["t"] for e in evs]
    check("15 bots + 1 match → confirma SOLO el que coincide, sin diálogo",
          stub.confirmed == ["777"] and "success" in kinds and "ask" not in kinds,
          f"confirmed={stub.confirmed} kinds={kinds}")
    check("log 'Identidad detectada en el server' presente (nick sin ^X)",
          any(e.get("t") == "log"
              and "Identidad detectada en el server: El Tester" in e.get("msg", "")
              for e in evs))

    # Varios con el MISMO nick → desambiguación por recencia (auto, sin ask).
    stub = StubApi(candidate_pages=[{"candidates": [
        {"guid": "A", "name": "El Tester",
         "lastConnection": "2026-11-06T09:00:00.000Z"},
        {"guid": "B", "name": "^7el^1 tester",
         "lastConnection": "2026-11-06T11:30:00.000Z"},
    ]}])
    evs = flow_once(stub)
    check("2 candidatos con mismo nick → elige el MÁS RECIENTE (B)",
          stub.confirmed == ["B"], str(stub.confirmed))
    check("la desambiguación queda loggeada",
          any(e.get("t") == "log" and "más reciente" in e.get("msg", "")
              for e in evs))

    # 1 candidato con nick DISTINTO → JAMÁS se confirma: timeout + copy nuevo.
    stub = StubApi(candidate_pages=[{"candidates": [
        {"guid": "999", "name": "ZombieSlayer69",
         "lastConnection": "2026-11-06T10:00:00.000Z"},
    ]}])
    evs = flow_once(stub, poll_interval=0.4, poll_max=1.0)
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("1 candidato ajeno → jamás se confirma y no hay diálogo",
          stub.confirmed == [] and "ask" not in [e["t"] for e in evs],
          f"confirmed={stub.confirmed}")
    check("1 candidato ajeno → timeout con el mensaje nuevo de nick",
          failed is not None and failed.get("retry") is True
          and "No vimos entrar a nadie con tu nick (El Tester)" in failed.get("msg", "")
          and "El juego debe abrirse con el nick de tu cuenta" in failed.get("msg", ""),
          str(failed))

    # 409 GUID_ALREADY_LINKED al confirmar → copy HUD claro.
    stub = StubApi(
        candidate_pages=[{"candidates": [
            {"guid": "444", "name": "El Tester",
             "lastConnection": "2026-11-06T10:00:00.000Z"},
        ]}],
        confirm_results=[ApiError(409, "GUID_ALREADY_LINKED", "ocupado")],
    )
    evs = flow_once(stub)
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("409 GUID ajeno → copy claro de PC compartida",
          failed is not None and failed.get("retry") is True
          and "ya pertenece a otra cuenta" in failed.get("msg", "")
          and "SU propia cuenta" in failed.get("msg", ""),
          str(failed))

    # Ningún candidato → timeout con reintento.
    stub = StubApi()
    evs = flow_once(stub, poll_interval=0.4, poll_max=1.0)
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("sin candidatos → mensaje nuevo de nick + retry",
          failed is not None and failed.get("retry") is True
          and "No vimos entrar a nadie con tu nick (El Tester)" in failed.get("msg", "")
          and "El juego debe abrirse con el nick de tu cuenta" in failed.get("msg", ""),
          str(failed))

    # 409 USER_ALREADY_LINKED al confirmar → éxito para el jugador.
    stub = StubApi(
        candidate_pages=[{"candidates": [
            {"guid": "333", "name": "El Tester",
             "lastConnection": "2026-11-06T10:00:00.000Z"},
        ]}],
        confirm_results=[ApiError(409, "USER_ALREADY_LINKED", "ya vinculada")],
    )
    evs = flow_once(stub)
    ok = next((e for e in evs if e["t"] == "success"), None)
    check("409 ya verificada → se trata como éxito",
          ok is not None and "ya estaba verificada" in ok.get("msg", ""), str(ok))

    # API caída durante el polling → fallo con reintento.
    stub = StubApi()
    stub.link_candidates = lambda token: (_ for _ in ()).throw(
        NetworkError("No se pudo conectar con la API."))
    evs = flow_once(stub)
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("API caída → mensaje de red claro + retry",
          failed is not None and failed.get("retry") is True
          and "No se pudo conectar" in failed.get("msg", ""),
          str(failed))

    # Ya vinculado → sin link/start y éxito inmediato (nick SIEMPRE forzado).
    stub = StubApi()
    evs: List[Dict[str, Any]] = []
    flow = GameFlow(stub, "tok", r"D:\Games\iw4x.exe", "127.0.0.1:28961",
                    evs.append, already_linked=True, simulate=True,
                    display_name="El Tester")
    flow.run()
    check("cuenta ya vinculada → no llama a link/start",
          stub.link_start_calls == 0 and any(e["t"] == "success" for e in evs))
    check("flujo simulado registra comando con +set name y +connect",
          any(e.get("t") == "log"
              and '+set name "El Tester"' in e.get("msg", "")
              and "+connect" in e.get("msg", "") for e in evs),
          str(evs)[:300])

    # displayName vacío → NO se lanza el juego y se reporta el motivo oficial.
    stub = StubApi()
    evs = []
    flow = GameFlow(stub, "tok", r"D:\Games\iw4x.exe", "127.0.0.1:28961",
                    evs.append, already_linked=True, simulate=True,
                    display_name="")
    flow.run()
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("sin displayName → NO lanza el juego (sin éxito)",
          failed is not None
          and not any(e["t"] == "success" for e in evs)
          and failed.get("retry") is False,
          str(failed))
    check("sin displayName → mensaje oficial al usuario",
          failed is not None and "Mi Cuenta (web)" in failed.get("msg", "")
          and "nombre visible" in failed.get("msg", ""),
          str(failed))
    check("sin displayName → no se construyó comando de lanzamiento",
          not any("SIMULACIÓN: comando" in e.get("msg", "")
                  for e in evs if e.get("t") == "log"),
          str(evs)[:300])


def phase_command_args() -> None:
    """Fase lógica: armado del comando (nick SIEMPRE forzado, sin abrir juego)."""
    print("\n=== Fase lógica: comando de arranque (+set name siempre) ===")

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
def main() -> int:
    # Consola Windows (cp1252): nunca romper por caracteres Unicode.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # Los WARNING/ERROR de la app van al log rotativo, no a consola.
    setup_logging()

    print("Prueba de humo del launcher IW4x Ranking")
    print(f"API: {API_URL}   store de prueba: {STORE_PATH}")

    if not phase_api_basics():
        print("\nLa API no responde: no se puede continuar.")
        return 1

    # 2) Alta de la cuenta DESDE el launcher (registro; si ya existía, login).
    phase_register_or_login()

    # 3) Contrato auth/link headless con la cuenta ya creada.
    if phase_api_auth_flow() is None:
        print("\nNo se pudo autenticar la cuenta de prueba: no se puede continuar.")
        return 1

    phase_autologin()
    phase_play_unlinked()
    phase_link_real()
    # Stats al final del bloque "vinculado": garantiza linkedGuids ≥ 1
    # (link_real acaba de vincular o verificar la cuenta).
    phase_stats()
    phase_play_linked()
    phase_save_sync()
    phase_flow_logic()
    phase_command_args()

    # Limpieza: no dejar sesión de prueba activa en la máquina.
    STORE_PATH.unlink(missing_ok=True)

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

