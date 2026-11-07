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
  7. (lógica)   GameFlow con API simulada: 1 candidato → auto-confirmar;
                varios → diálogo; ninguno → timeout; 409 ya vinculada → éxito.
  8. (GUI)      CandidateDialog: selección y cancelación.

Cuenta de prueba: launcher-test@test.local / LauncherTest2026
NO es pytest: es un script secuencial que imprime [OK]/[FALLO] por paso.
"""
from __future__ import annotations

import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import customtkinter as ctk

# Importa los módulos del launcher (mismo directorio).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from api_client import ApiClient, ApiError, NetworkError  # noqa: E402
from app_config import AppConfig, DEFAULT_CONFIG  # noqa: E402
from game_flow import GameFlow, build_game_args  # noqa: E402
from logging_setup import app_data_dir, setup_logging  # noqa: E402
from ui.dialogs import CandidateDialog  # noqa: E402
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
        data = api.login(EMAIL, PASSWORD)
        token = data["token"]
        check("POST /api/auth/login (cuenta creada por el launcher)", True)
    except Exception as exc:
        check("POST /api/auth/login (cuenta creada por el launcher)", False, str(exc))
        return None

    try:
        user = api.me(token)
        check("GET /api/auth/me devuelve usuario", bool(user.get("id")))
        print(f"    user={user.get('displayName')} linkedGuid={user.get('linkedGuid')}")
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
    # En la prueba no queremos tracebacks de callbacks tras el destroy.
    app.report_callback_exception = lambda *_a, **_k: None
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
        wait_in_app(app, lambda: app.current_frame is app.login_frame, done, timeout=10)

    def step_submit(app: App, done: Callable[[], None]) -> None:
        """Intenta CREAR CUENTA; si el email ya existe, repite como login."""
        f = app.login_frame
        if not f._register_mode:
            f._toggle_mode()  # modo CREAR CUENTA
        f.email.delete(0, "end"); f.email.insert(0, EMAIL)
        f.password.delete(0, "end"); f.password.insert(0, PASSWORD)
        f.display_name.delete(0, "end"); f.display_name.insert(0, DISPLAY)
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
                expected = ("VERIFICADO" if (app.user or {}).get("linkedGuid")
                            else "SIN VINCULAR")
                badge = str(app.home_frame.badge.cget("text"))
                check(f"badge {expected} según estado de vinculación",
                      expected in badge, badge)
                check(
                    "nombre de usuario en cabecera",
                    DISPLAY in str(app.home_frame.user_label.cget("text")),
                    str(app.home_frame.user_label.cget("text")),
                )
                check("token guardado para auto-login", app.store.load() is not None)
                done()
                return

            # EMAIL_TAKEN: repetimos el formulario en modo login.
            status = str(f.status.cget("text"))
            if (not retried["done"] and ("ya tiene una cuenta" in status
                                         or "EMAIL_TAKEN" in status)):
                retried["done"] = True
                if f._register_mode:
                    f._toggle_mode()  # vuelve a ENTRAR
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


def phase_play_unlinked() -> None:
    """Fase 4: JUGAR simulado con cuenta SIN vincular → espera y reintento."""

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
        def finished() -> bool:
            if app.flow is not None:
                return False
            txt = str(app.home_frame.status.cget("text"))
            btn = str(app.home_frame.play_btn.cget("text"))
            return ("No detectamos" in txt or "cancelada" in txt or
                    "vinculada" in txt or "Juego abierto" in txt or
                    btn in ("REINTENTAR", "JUGAR"))

        def ok() -> None:
            console = app.home_frame.console.get("1.0", "end")
            status = str(app.home_frame.status.cget("text"))
            btn = str(app.home_frame.play_btn.cget("text"))
            check("JUGAR simulado: log de 'SIMULACIÓN' presente",
                  "SIMULACIÓN" in console)
            check(
                "JUGAR simulado: flujo de vinculación o partida directa",
                ("Esperando tu conexión" in console)          # camino sin vincular
                or ("solo abrimos el juego" in console)       # re-run con GUID ya vinculado
                or ("GUID detectado" in console),
                console[-400:],
            )
            check(
                "JUGAR simulado: termina con estado claro",
                ("No detectamos" in status) or ("cancelada" in status)
                or ("vinculada" in status) or ("Juego abierto" in status),
                status,
            )
            check(
                "botón operable al terminar (JUGAR/REINTENTAR)",
                btn in ("REINTENTAR", "JUGAR"),
                btn,
            )
            # Si el flujo auto-confirmó el único candidato real, la cuenta
            # queda vinculada: el badge debe refrescarse a VERIFICADO.
            if "Cuenta vinculada" in console:
                badge = str(app.home_frame.badge.cget("text"))
                check("badge VERIFICADO tras auto-confirmar candidato",
                      "VERIFICADO" in badge, badge)
            done()

        # 40s de margen (poll de prueba dura ~7s).
        wait_in_app(app, finished, ok, timeout=40)

    run_phase(
        "JUGAR simulado sin vincular",
        [step_wait_home, step_play, step_wait_result],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


# ---------------------------------------------------------------------------
# Fase headless: vincular la cuenta de prueba con un GUID real del leaderboard
# (la misma confirmación que lanza el flujo JUGAR al detectar el candidato).
def phase_link_real() -> None:
    print("\n=== Fase headless: vinculación real con GUID del leaderboard ===")
    api = ApiClient(API_URL)
    guid: Optional[str] = None

    try:
        token = api.login(EMAIL, PASSWORD)["token"]
        user = api.me(token)
        guid = str(user.get("linkedGuid") or "") or None

        if guid:
            print(f"    la cuenta ya está vinculada a {guid}")
            check("cuenta de prueba vinculada (previa)", True)
        else:
            board = api._request("GET", "/leaderboard?sort=kills&order=desc&pageSize=5")
            free = [p for p in board.get("players", []) if not p.get("linked")]
            if not free:
                check("hay GUIDs sin vincular en el leaderboard", False, str(board)[:200])
                return

            guid = str(free[0]["guid"])
            print(f"    confirmando GUID {guid} ({free[0].get('name')})…")
            result = api.link_confirm(token, guid)
            check(
                "POST /api/link/complete {guid} vincula",
                result.get("status") == "linked",
                str(result)[:200],
            )

            user2 = api.me(token)
            check(
                "GET /auth/me refleja linkedGuid",
                str(user2.get("linkedGuid")) == guid,
                str(user2.get("linkedGuid")),
            )
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
            if exc.code != "EMAIL_TAKEN":
                raise
        tok2 = api.login(EMAIL2, PASSWORD2)["token"]
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
    """Dobles de los 3 endpoints que usa GameFlow."""

    def __init__(self, candidate_pages=None, confirm_results=None) -> None:
        self.link_start_calls = 0
        self._pages = list(candidate_pages or [])
        self._confirm = list(confirm_results or [])
        self.confirmed: List[str] = []

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


def flow_once(stub: StubApi, respond: Optional[Callable[[GameFlow], None]] = None,
              poll_interval: float = 0.4, poll_max: float = 1.2):
    events: List[Dict[str, Any]] = []
    flow = GameFlow(
        stub, "tok", r"C:\no\existe\iw4x.exe", "127.0.0.1:28961",
        events.append, simulate=True,
        poll_interval=poll_interval, poll_max_seconds=poll_max,
    )
    if respond is not None:
        def responder() -> None:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if any(e.get("t") == "ask" for e in events):
                    respond(flow)
                    return
                time.sleep(0.05)
        threading.Thread(target=responder, daemon=True).start()
    flow.run()
    return events


def phase_flow_logic() -> None:
    print("\n=== Fase lógica: GameFlow con API simulada ===")

    # 1 candidato → auto-confirmación.
    stub = StubApi(candidate_pages=[{"candidates": [
        {"guid": "111", "name": "Uno", "lastConnection": "2026-11-06T10:00:00.000Z"},
    ]}])
    evs = flow_once(stub)
    kinds = [e["t"] for e in evs]
    check("1 candidato → confirma automáticamente",
          stub.confirmed == ["111"] and "success" in kinds, f"{stub.confirmed} {kinds}")
    check("log 'GUID detectado' presente",
          any(e.get("t") == "log" and "GUID detectado: 111" in e.get("msg", "")
              for e in evs))

    # Varios candidatos → diálogo y confirmación del elegido.
    stub = StubApi(candidate_pages=[{"candidates": [
        {"guid": "111", "name": "Uno", "lastConnection": "2026-11-06T10:00:00.000Z"},
        {"guid": "222", "name": "Dos", "lastConnection": "2026-11-06T09:00:00.000Z"},
    ]}])
    evs = flow_once(stub, respond=lambda f: f.respond_choice("222"))
    asked = next((e for e in evs if e["t"] == "ask"), None)
    check("varios candidatos → pide elección al usuario",
          asked is not None and len(asked.get("candidates", [])) == 2)
    check("elige el GUID 222 confirmándolo", stub.confirmed == ["222"],
          str(stub.confirmed))

    # Ningún candidato → timeout con reintento.
    stub = StubApi()
    evs = flow_once(stub, poll_interval=0.4, poll_max=1.0)
    failed = next((e for e in evs if e["t"] == "failed"), None)
    check("sin candidatos → 'No detectamos tu entrada al server' + retry",
          failed is not None and failed.get("retry") is True
          and "No detectamos" in failed.get("msg", ""),
          str(failed))

    # 409 USER_ALREADY_LINKED al confirmar → éxito para el jugador.
    stub = StubApi(
        candidate_pages=[{"candidates": [
            {"guid": "333", "name": "Tres", "lastConnection": "2026-11-06T10:00:00.000Z"},
        ]}],
        confirm_results=[ApiError(409, "USER_ALREADY_LINKED", "ya vinculada")],
    )
    evs = flow_once(stub)
    ok = next((e for e in evs if e["t"] == "success"), None)
    check("409 ya vinculada → se trata como éxito",
          ok is not None and "ya está vinculada" in ok.get("msg", ""), str(ok))

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

    # Ya vinculado → sin link/start y éxito inmediato (+ nick forzado).
    stub = StubApi()
    evs: List[Dict[str, Any]] = []
    flow = GameFlow(stub, "tok", r"D:\Games\iw4x.exe", "127.0.0.1:28961",
                    evs.append, already_linked=True, simulate=True,
                    force_nick=True, display_name="El Tester")
    flow.run()
    check("cuenta ya vinculada → no llama a link/start",
          stub.link_start_calls == 0 and any(e["t"] == "success" for e in evs))
    check("flujo simulado registra comando con +set name y +connect",
          any(e.get("t") == "log"
              and '+set name "El Tester"' in e.get("msg", "")
              and "+connect" in e.get("msg", "") for e in evs),
          str(evs)[:300])

    # force_nick sin displayName → arranca sin forzar, con motivo en el log.
    stub = StubApi()
    evs = []
    flow = GameFlow(stub, "tok", r"D:\Games\iw4x.exe", "127.0.0.1:28961",
                    evs.append, already_linked=True, simulate=True,
                    force_nick=True, display_name="")
    flow.run()
    check("sin displayName → avisa y no fuerza nick",
          any("no se fuerza el nick" in e.get("msg", "")
              for e in evs if e.get("t") == "log")
          and not any("+set" in e.get("msg", "")
                      for e in evs if e.get("t") == "log"),
          str(evs)[:300])


def phase_command_args() -> None:
    """Fase lógica: armado del comando de arranque (función pura, sin juego)."""
    print("\n=== Fase lógica: comando de arranque (+set name) ===")

    args = build_game_args(r"D:\Games\Call of Duty 6\iw4x.exe",
                           "192.168.2.251:28960", "Mandango ProMax", force_nick=True)
    check("comando: exe primero, +connect último",
          args[0] == r"D:\Games\Call of Duty 6\iw4x.exe"
          and args[-1] == "192.168.2.251:28960", str(args))
    check("comando: +set name <nick> (con espacios) ANTES de +connect",
          args[1:5] == ["+set", "name", "Mandango ProMax", "+connect"], str(args))
    check("comando: lista plana de 6 argumentos (sin shell)",
          len(args) == 6 and all(isinstance(a, str) for a in args), str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "", force_nick=True)
    check("sin displayName → no fuerza nick",
          args == ["iw4x.exe", "+connect", "1.2.3.4:28960"], str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "Tag", force_nick=False)
    check("force_nick desactivado → no fuerza nick",
          args == ["iw4x.exe", "+connect", "1.2.3.4:28960"], str(args))

    args = build_game_args("iw4x.exe", "1.2.3.4:28960", "  Spam Bot  ",
                           force_nick=True)
    check("nick con espacios en extremos se recorta",
          args == ["iw4x.exe", "+set", "name", "Spam Bot", "+connect",
                   "1.2.3.4:28960"], str(args))


# ---------------------------------------------------------------------------
# Fase 7 GUI: CandidateDialog con candidatos falsos.
def phase_dialog() -> None:
    picked: List[Optional[str]] = []

    def step(app: App, done: Callable[[], None]) -> None:
        candidates = [
            {"guid": "111", "name": "Uno", "lastConnection": "2026-11-06T10:00:00.000Z"},
            {"guid": "222", "name": "Dos", "lastConnection": "2026-11-06T09:00:00.000Z"},
        ]

        def step2() -> None:
            # Cancelación: cerrar sin elegir → None.
            d2 = CandidateDialog(app, candidates, lambda g: picked.append(g))
            app.after(400, d2._cancel)
            app.after(900, finish)

        def finish() -> None:
            check("diálogo multi-candidato: confirmación devuelve el GUID elegido",
                  bool(picked) and picked[0] == "222", str(picked))
            check("diálogo multi-candidato: cancelar devuelve None",
                  len(picked) > 1 and picked[1] is None, str(picked))
            done()

        d1 = CandidateDialog(app, candidates, lambda g: picked.append(g))
        app.after(400, lambda: (d1._var.set("222"), d1._confirm()))
        app.after(900, step2)

    run_phase("diálogo de candidatos", [step],
              lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)))


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
    phase_play_linked()
    phase_flow_logic()
    phase_command_args()
    phase_dialog()

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

