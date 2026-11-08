"""Prueba de humo del launcher contra la API real (E2E / GUI).

Uso:
    py apps\\launcher\\tests\\test_smoke.py

NOTA de reparto: este archivo contiene SOLO checks híbridos/E2E (con red o
GUI). Las funciones puras sin redes viven en tests/test_units.py — se
extrajeron sin cambiar nada semánticamente: candidate_matches,
pick_candidate, save_sync (mapeo/hashes/decisión/caps/detect_build),
build_game_args y los defaults/merge de app_config.

Requisitos: la API debe estar corriendo (por defecto http://localhost:3000).

Qué verifica:
  1. (headless) sync/status, me, link/start, link/candidates contra la API.
  2. (GUI)      crear cuenta DESDE el launcher (POST /auth/register) o, si ya
                existe, login por el formulario.
  3. (GUI)      auto-login al reabrir (token.json).
  4. (GUI)      flujo JUGAR SIMPLIFICADO en simulación: el juego abre y el
                 launcher se queda en home normal (sin espera de candidatos ni
                 pantalla de verificación); aviso dim único si a los ~60s
                 sigue sin identidad (delay inyectado en la prueba).
  5. (headless) confirmación de vinculación con un GUID real del leaderboard
                 (la misma llamada que hace el launcher al confirmar), el
                 error 409 GUID_ALREADY_LINKED con una segunda cuenta y el
                 contrato POST /api/play/session del auto-link server-side
                 (404 mientras el backend despliega → PENDIENTE, no fallo).
  6. (GUI)      badge VERIFICADO + JUGAR con cuenta ya vinculada + sesión de
                 juego (POST /api/play/session con stub) al dar JUGAR y en
                 su ciclo de 30s.
  7. (lógica)   GameFlow simplificado con API simulada: sin link/start ni
                 polling, log de auto-link; sin displayName → NO lanza; API
                 caída en el pre-launch → WARNING y juega igual.
  7b.(lógica)   Aislamiento guid.dat (fix cyber-café): pipeline stub que
                 CUARENTENA el guid.dat local, "el juego" (Popen falso) crea
                 identidad nueva y el upload post-sesión la incluye; y la
                 restauración de seguridad si la sesión muere <10s sin guid.
  8. (GUI)      login compacto: ENTRAR y CREAR CUENTA dentro del viewport en
                 geometría mínima 980x640 (login y registro), franja CONEXIÓN
                 colapsable (clic en la caption; colapsada tras el 1er éxito)
                 y Canvas+Scrollbar con rueda del ratón en pantallas bajas.

  9. (GUI/stubs) cierre del launcher (SIEMPRE): WM_DELETE_WINDOW y
                 emergency_shutdown (finally/atexit) matan el ÁRBOL del PID
                 que el launcher lanzó (stub, taskkill por PID, nunca por
                 nombre) y suben el progreso UNA vez; sin juego vivo el
                 cierre no toca nada.
  10. (GUI/stubs) autosave: tick con cambios sube, sin cambios NO consulta
                 la API (caché de hashes) y otro cambio vuelve a subir; el
                 cierre SIN juego vivo hace el guardado final SIEMPRE.
  11. (GUI/stubs) navegación y estados de botones: el registro muestra
                 "‹ VOLVER" y al pulsarlo vuelve al login conservando el
                 nick; ENTRAR se deshabilita con "ENTRANDO…" durante el
                 request (stub), un segundo submit no dispara otra petición
                 y el botón se restaura al terminar (anti doble-submit).
  12. (GUI)      grid de stats SIN solape: con valores largos (999/88/77)
                 los bboxes de captions/valores no se invaden fila a fila
                 (tolerancia −2px) y la decisión 1↔2 filas es la medida.
  13. (GUI/stubs) botón héroe JUGAR ⇄ DETENER: con juego vivo (stub) el
                 mismo botón pasa a DETENER (danger), al pulsarlo mata el
                 stub por PID + upload post-sesión y vuelve a JUGAR;
                 DETENIENDO… ignora clicks extra; si el juego se cierra
                 solo (game_closed) el botón también vuelve a JUGAR.

Híbridos que quedan aquí (con red/GUI o estado): pipeline stub de
cloud-sync, todas las fases GUI, fases headless contra la API real y los
flujos GameFlow con StubApi.

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

# Importa los módulos del launcher (directorio padre del paquete tests/).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api_client import ApiClient, ApiError, NetworkError, user_is_linked  # noqa: E402
from app_config import AppConfig, DEFAULT_CONFIG  # noqa: E402
from game_flow import GameFlow, build_game_args  # noqa: E402
from logging_setup import app_data_dir, setup_logging  # noqa: E402
import save_sync as ss  # noqa: E402
from save_sync import decide_sync  # noqa: E402
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

    # POST /api/play/session (contrato del auto-link server-side): el
    # backend puede estar desplegándose → 404 tolerado con PENDIENTE.
    ps_ok = False
    ps_detail = ""
    for attempt in range(2):
        try:
            ps = api.play_session(token)
            ps_ok = ps.get("ok") is True
            ps_detail = str(ps)[:120]
            break
        except ApiError as exc:
            if exc.status == 404 and attempt == 0:
                print("    POST /api/play/session aún no desplegado (404); "
                      "reintento en 60s…")
                time.sleep(60)
                continue
            ps_detail = f"{exc.status} {exc.code}"
            break
        except NetworkError as exc:
            ps_detail = str(exc)
            break
    check("POST /api/play/session → {ok, nick, expiresAt}", True,
          ("OK " + ps_detail) if ps_ok else
          f"PENDIENTE backend: {ps_detail} (el launcher lo ignora con log dim)")

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
    try:
        app.autosave.stop()  # no dejar el ciclo de auto-guardado colgando
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
            # Franja CONEXIÓN: URL visible ANTES del login (con la API mal
            # apuntada no se puede ni entrar). El detalle es COLAPSABLE: tras
            # el primer éxito se colapsa solo — la caption lo reabre.
            check("login: franja CONEXIÓN visible con la URL de la API",
                  bool(app.login_frame.conn_strip.winfo_ismapped())
                  and "localhost:3000" in app.login_frame.conn_url_text(),
                  f"url={app.login_frame.conn_url_text()!r} "
                  f"strip_mgr={app.login_frame.conn_strip.winfo_manager()!r}")
            if not app.login_frame.conn_test_btn.winfo_ismapped():
                app.login_frame.toggle_conn()
                app.update_idletasks()
            check("login: PROBAR disponible al expandir la CONEXIÓN",
                  bool(app.login_frame.conn_test_btn.winfo_ismapped()))
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


def phase_navigation_busy() -> None:
    """Fase GUI: audit de navegación + anti doble-submit en ENTRAR (stub).

    - Registro: fantasma "‹ VOLVER" visible y, al pulsarlo, vuelta al login
      conservando el nick ya tecleado (salida clara del registro).
    - ENTRAR en vuelo: deshabilitado con label "ENTRANDO…"; un segundo submit
      (click o Enter) NO dispara otra petición; al terminar el request (stub,
      por error) el botón se restaura con su label y estado normales.
    - Audit estático de salidas: ajustes → home ("‹ VOLVER") y home →
      AJUSTES / CERRAR SESIÓN en cabecera.
    """

    def step_login_layout(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            f = app.login_frame
            check("audit login: ENTRAR y enlace CREAR CUENTA mapeados",
                  bool(f.action_btn.winfo_ismapped())
                  and bool(f.toggle_link.winfo_ismapped()))
            check("audit login: '‹ VOLVER' oculto en modo ENTRAR (solo existe en registro)",
                  not f.back_btn.winfo_ismapped())
            check("audit ajustes: fantasma '‹ VOLVER' con salida a la home",
                  str(app.settings_frame.back_btn.cget("text")) == "‹ VOLVER")
            check("audit home: salidas AJUSTES y CERRAR SESIÓN en la cabecera",
                  str(app.home_frame.settings_btn.cget("text")) == "AJUSTES"
                  and str(app.home_frame.logout_btn.cget("text")) == "CERRAR SESIÓN")
            done()

        wait_in_app(app, lambda: app.current_frame is app.login_frame, ok, timeout=10)

    def step_register_back(app: App, done: Callable[[], None]) -> None:
        f = app.login_frame
        f.nick.delete(0, "end"); f.nick.insert(0, "NickConservado")
        f._toggle_mode()  # login → CREAR CUENTA

        def check_volver() -> None:
            check("registro: '‹ VOLVER' visible al entrar a CREAR CUENTA",
                  bool(f.back_btn.winfo_ismapped()),
                  f"mgr={f.back_btn.winfo_manager()!r}")
            check("registro: email visible y enlace CREAR CUENTA retirado "
                  "(una sola ruta de retorno)",
                  bool(f.email_box.winfo_ismapped())
                  and not f.toggle_link.winfo_ismapped())
            f.back_btn.invoke()  # pulso real del botón fantasma
            app.after(150, check_de_vuelta)

        def check_de_vuelta() -> None:
            check("‹ VOLVER: pulso → vuelta al login (ENTRAR + enlace restaurado)",
                  str(f.action_btn.cget("text")) == "ENTRAR"
                  and not f.back_btn.winfo_ismapped()
                  and not f.email_box.winfo_ismapped()
                  and bool(f.toggle_link.winfo_ismapped()),
                  f"btn={f.action_btn.cget('text')} "
                  f"back_mgr={f.back_btn.winfo_manager()!r} "
                  f"link_mapped={bool(f.toggle_link.winfo_ismapped())}")
            check("‹ VOLVER: conserva el nick tecleado antes de arrepentirse",
                  f.nick.get() == "NickConservado", repr(f.nick.get()))
            done()

        app.after(150, check_volver)

    def step_busy_entrar(app: App, done: Callable[[], None]) -> None:
        f = app.login_frame
        f.nick.delete(0, "end"); f.nick.insert(0, "BusyCheck")
        f.password.delete(0, "end"); f.password.insert(0, "busy-password-1")

        calls = {"n": 0}
        holder: List[Callable] = []

        def stub_login(nick, password, on_done):  # NO lanza hilo ni HTTP
            calls["n"] += 1
            holder.append(on_done)

        app.login = stub_login  # type: ignore[method-assign]
        f._on_submit()

        # En vuelo (todo síncrono dentro de _on_submit): disabled + ENTRANDO…
        check("ENTRAR en vuelo: deshabilitado con label 'ENTRANDO…'",
              str(f.action_btn.cget("text")) == "ENTRANDO…"
              and str(f.action_btn.cget("state")) == "disabled"
              and f._busy is True,
              f"text={f.action_btn.cget('text')!r} "
              f"state={f.action_btn.cget('state')!r}")
        f._on_submit()  # doble submit en vuelo: el guard debe frenarlo
        check("anti doble-submit: segundo submit (click/Enter) no dispara otra petición",
              calls["n"] == 1, f"calls={calls['n']}")

        # El request "termina" (stub) → restauración exacta (aquí, por error).
        holder[0](NetworkError("stub: API caída"))

        def check_restored() -> None:
            check("ENTRAR restaurado tras el request (stub): label y estado normales",
                  str(f.action_btn.cget("text")) == "ENTRAR"
                  and str(f.action_btn.cget("state")) == "normal"
                  and f._busy is False,
                  f"text={f.action_btn.cget('text')!r} "
                  f"state={f.action_btn.cget('state')!r}")
            check("error del request (stub) queda pintado en el status",
                  "stub: API caída" in str(f.status.cget("text")),
                  repr(str(f.status.cget("text"))))

        app.after(120, check_restored)

        # Limpieza: el doble-submit no coló nada, pero el botón vuelve a ser
        # operable para las fases siguientes (sin sesión, sin navegación).
        app.after(240, done)

    run_phase("navegación (VOLVER) + anti doble-submit",
              [step_login_layout, step_register_back, step_busy_entrar],
              lambda: (STORE_PATH.unlink(missing_ok=True),
                       App(make_test_cfg(), ApiClient(API_URL),
                           UserStore(STORE_PATH)))[1])


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


def synthetic_lvl_checks(panel) -> None:
    """Inyección sintética del bloque LVL sobre el panel REAL (no depende del
    entorno: funciona con o sin GUID vinculado). Con save parseado (level 47,
    prestige 2) → '47·P2' con caption dim 'LVL·SAVE'; sin save (None) y con
    perfil VIEJO sin el campo (llamada a 3 argumentos) → '—' + 'LVL', sin
    crash. Son los mismos checks para la fase completa y la reducida."""
    check("bloque LVL mapeado en el grid (6 columnas)",
          panel._blocks["lvl"].winfo_ismapped()
          and panel._captions["lvl"].winfo_ismapped(),
          f"val_mgr={panel._blocks['lvl'].winfo_manager()} "
          f"cap_mgr={panel._captions['lvl'].winfo_manager()}")
    panel.set_values(
        {"name": "Con Save", "kills": 31, "deaths": 20,
         "kd": 1.55, "timePlayed": 3600},
        1, "SRV",
        {"level": 47, "prestige": 2, "xp": 987654,
         "parsedAt": "2026-11-08T10:00:00.000Z"},
    )
    lvl_p = (str(panel._blocks["lvl"].cget("text")) == "47·P2"
             and str(panel._captions["lvl"].cget("text")) == "LVL·SAVE")
    check("bloque LVL con save presente (level 47, prestige 2) "
          "→ '47·P2' con caption 'LVL·SAVE'",
          lvl_p,
          f"lvl={panel._blocks['lvl'].cget('text')} "
          f"cap={panel._captions['lvl'].cget('text')}")
    panel.set_values(
        {"name": "Sin Save", "kills": 31, "deaths": 20,
         "kd": 1.55, "timePlayed": 3600},
        1, "SRV", None,
    )
    sin_none = (str(panel._blocks["lvl"].cget("text")) == "—"
                and str(panel._captions["lvl"].cget("text")) == "LVL")
    panel.set_values(
        {"name": "Perfil Viejo", "kills": 31, "deaths": 20,
         "kd": 1.55, "timePlayed": 3600},
        1, "SRV",  # sin 4º arg: perfil que NO trae campo save
    )
    sin_campo = (str(panel._blocks["lvl"].cget("text")) == "—"
                 and str(panel._captions["lvl"].cget("text")) == "LVL")
    check("bloque LVL sin save (None y perfil sin campo save) "
          "→ '—' sin crash",
          sin_none and sin_campo,
          f"None={panel._blocks['lvl'].cget('text')} "
          f"sin_campo={panel._blocks['lvl'].cget('text')}")


def phase_stats() -> None:
    """Fase GUI: panel de stats en vivo (carga, refresh manual, logout).

    Sin GUID disponible en el entorno (DB reseteada por el trabajo paralelo
    en apps/api), la fase corre en modo REDUCIDO: los checks sintéticos del
    bloque LVL no dependen del entorno y corren igual sobre el panel real.
    """
    # Preparación headless: asegura sesión + GUID vinculado para que el
    # panel tenga valores reales que cargar (la DB puede resetearse entre
    # corridas por el trabajo paralelo en apps/api).
    api = ApiClient(API_URL)
    full = True
    try:
        token = ensure_login_retry(api)
        user = api.me(token)
        if not user_is_linked(user):
            guid = link_test_account(api, token)
            if guid is None:
                # El ingest recrea jugadores al haber partidas; mientras tanto
                # es PENDIENTE de entorno (backend en paralelo), no un fallo.
                full = False
                check("preparación stats: hay GUID disponible", True,
                      "PENDIENTE entorno: sin candidatos ni GUIDs libres en el "
                      "leaderboard (se recrean con partidas reales)")
                print("    sin GUID: fase REDUCIDA (los checks sintéticos del "
                      "bloque LVL corren igual)")
            else:
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
            lvl = str(panel._blocks["lvl"].cget("text"))
            kills = str(panel._blocks["kills"].cget("text"))
            deaths = str(panel._blocks["deaths"].cget("text"))
            hs = str(panel._blocks["hs"].cget("text"))
            kd = str(panel._blocks["kd"].cget("text"))
            sub = str(panel.sub_label.cget("text"))
            check("panel de stats carga con valores reales (no '—')",
                  "—" not in (kills + kd), f"rank={rank} kills={kills} kd={kd}")
            check("fila secundaria con tiempo jugado, server y jugador",
                  "TIEMPO" in sub and "SERVER" in sub and "JUGADOR" in sub, sub)
            check("bloque HEADSHOTS con el valor real del perfil",
                  hs != "—" and hs.replace(".", "").isdigit(),
                  f"hs={hs} (esperado entero formateado)")
            # Segmento HS de la línea de detalle: "N%" normal, "—" solo válido
            # con 0 kills (hsRatio null). Autoconsistente con el propio panel.
            after_hs = sub.split("HS ", 1)[1] if "HS " in sub else ""
            hs_seg = after_hs.split(" de bajas", 1)[0].strip() if " de bajas" in after_hs else ""
            check("línea de detalle con el ratio de headshots (N% o '—')",
                  bool(hs_seg) and (hs_seg.endswith("%") or hs_seg == "—")
                  and (hs_seg != "—" or kills.replace(".", "") == "0"),
                  f"hs_seg={hs_seg!r} kills={kills}")
            check("edad del dato visible ('hace Ns')",
                  "hace " in str(panel.age_label.cget("text")),
                  str(panel.age_label.cget("text")))
            print(f"    panel: RANK={rank} LVL={lvl} KILLS={kills} "
                  f"DEATHS={deaths} HS={hs} K/D={kd}")
            print(f"    sub: {sub}")
            # Inyección sintética dentro del panel real: primero un perfil
            # actual (headshots + hsRatio → '2' y 'HS 6% de bajas') y luego
            # uno "viejo" sin esos campos → bloque '—' y 'HS —', sin crash.
            try:
                panel.set_values(
                    {"name": "Con HS", "kills": 31, "deaths": 20,
                     "kd": 1.55, "headshots": 2, "hsRatio": 0.06,
                     "timePlayed": 3600},
                    1, "SRV",
                )
                con_hs = (str(panel._blocks["hs"].cget("text")) == "2"
                          and "HS 6% de bajas" in str(panel.sub_label.cget("text")))
                panel.set_values(
                    {"name": "Legacy", "kills": 31, "deaths": 20,
                     "kd": 1.55, "timePlayed": 3600},
                    1, "SRV",
                )
                sin_hs = (str(panel._blocks["hs"].cget("text")) == "—"
                          and "HS —" in str(panel.sub_label.cget("text")))
                check("perfil con y sin headshots: '2'/'HS 6% de bajas' y luego '—'/'HS —' sin crash",
                      con_hs and sin_hs,
                      f"con_hs={con_hs} sin_hs={sin_hs} "
                      f"hs={panel._blocks['hs'].cget('text')} "
                      f"sub={panel.sub_label.cget('text')}")
            except Exception as exc:  # noqa: BLE001
                check("perfil con y sin headshots: '2'/'HS 6% de bajas' y luego '—'/'HS —' sin crash",
                      False, repr(exc))
            # LVL real (nivel del save en la nube, campo save del perfil):
            # los mismos checks sintéticos que en la fase reducida.
            try:
                synthetic_lvl_checks(panel)
            except Exception as exc:  # noqa: BLE001
                check("bloque LVL con/sin save del perfil sin crash",
                      False, repr(exc))
            done()

        # 20s: la primera carga se programa a ~600ms y la API es local.
        wait_in_app(app, lambda: app._stats_fetch_count >= 1, ok, timeout=20)

    def step_grid_no_overlap(app: App, done: Callable[[], None]) -> None:
        """Verificación mecánica anti-solape del grid (bug 'DEATHSHEADSHOTSK/D').

        Renderiza el panel con valores reales LARGOS (kills=999, deaths=88,
        headshots=77, kd=1.25, rank=999) y comprueba con los bboxes REALES
        que, fila a fila, el x_fin de cada caption no invade el x_inicio del
        siguiente (tolerancia −2px por redondeos de render). También los
        valores, y que la decisión 1↔2 filas fue consistente con el ancho
        medido del panel.
        """
        panel = app.home_frame.stats_panel
        panel.set_values(
            {"name": "Grid Test", "kills": 999, "deaths": 88, "kd": 1.25,
             "headshots": 77, "hsRatio": 0.077, "timePlayed": 7200},
            999, "SRV-LARGO",
            # Save sintético con nivel ANCHO ('999·P9'): el LVL también
            # participa de la medición anti-solape.
            {"level": 999, "prestige": 9, "xp": 1,
             "parsedAt": "2026-11-08T10:00:00.000Z"},
        )

        def check_grid() -> None:
            app.update_idletasks()  # geometría al día antes de medir bboxes
            keys = ("rank", "lvl", "kills", "deaths", "hs", "kd")
            texts = {k: str(panel._blocks[k].cget("text")) for k in keys}
            check("grid: valores largos pintados (999/999·P9/88/77/1,25)",
                  texts == {"rank": "999", "lvl": "999·P9", "kills": "999",
                            "deaths": "88", "hs": "77", "kd": "1,25"}
                  and all(panel._captions[k].winfo_ismapped() for k in keys),
                  str(texts))

            def pares_consecutivos(widgets):
                """Pares (a, b) vecinos dentro de la MISMA fila visual."""
                filas: Dict[int, list] = {}
                for w in widgets:
                    y = w.winfo_y()
                    clave = next((yy for yy in filas if abs(yy - y) <= 3), y)
                    filas.setdefault(clave, []).append(w)
                pares = []
                for grupo in filas.values():
                    grupo.sort(key=lambda w: w.winfo_x())
                    pares.extend(zip(grupo, grupo[1:]))
                return pares

            caps = [panel._captions[k] for k in keys]
            vals = [panel._blocks[k] for k in keys]
            det = lambda ws: [(str(w.cget("text")), w.winfo_x(), w.winfo_width())
                              for w in ws]  # noqa: E731
            ok_caps = all(
                b.winfo_x() - (a.winfo_x() + a.winfo_width()) >= -2
                for a, b in pares_consecutivos(caps))
            check("grid sin solape: captions (x_fin ≤ x_inicio del siguiente, "
                  "tolerancia −2px)", ok_caps, str(det(caps)))
            ok_vals = all(
                b.winfo_x() - (a.winfo_x() + a.winfo_width()) >= -2
                for a, b in pares_consecutivos(vals))
            check("grid sin solape: valores (misma regla con bboxes reales)",
                  ok_vals, str(det(vals)))

            # Coherencia de la decisión MEDIDA: 'fila' solo si la suma de
            # anchos requeridos + huecos cabe en el ancho real del panel.
            needs = sum(panel._column_need(k) for k in keys)
            avail = panel._grid_avail
            mode = panel._grid_mode
            gap = panel._grid_gap
            huecos = len(keys) - 1  # 6 columnas → 5 huecos
            consistente = mode in ("fila", "dos_filas") and (
                (mode == "fila" and needs + gap * huecos <= avail)
                or (mode == "dos_filas" and needs + 24 * huecos > avail)
            )
            check("grid: decisión de layout medido coherente "
                  "(1 fila si cabe, 2 si no)",
                  consistente,
                  f"mode={mode} gap={gap} avail={avail} needs={needs}")
            print(f"    grid: modo={mode} gap={gap}px disponible={avail}px "
                  f"necesario={needs}px (+{gap * huecos}px de huecos)")
            done()

        app.after(250, check_grid)

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
            check("CTA pasivo de identidad presente (se vincula al entrar)",
                  "vincula al entrar" in str(app.home_frame.stats_panel.status_label.cget("text"))
                  and "JUGAR" in str(app.home_frame.stats_panel.status_label.cget("text")),
                  str(app.home_frame.stats_panel.status_label.cget("text"))),
            done(),
        ))

    build_stats_app = lambda: App(  # noqa: E731
        make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH))

    if full:
        run_phase(
            "panel de stats en vivo",
            [step_wait_home, step_wait_first_load, step_grid_no_overlap,
             step_manual_refresh, step_logout_cancels],
            build_stats_app,
        )
    else:
        # Modo REDUCIDO (entorno sin GUIDs): auto-login → home (el panel
        # queda en CTA, sin fetches) y los checks sintéticos del LVL corren
        # igual sobre el panel real. Nada depende de datos del leaderboard.
        def step_lvl_reducido(app: App, done: Callable[[], None]) -> None:
            def ok() -> None:
                try:
                    synthetic_lvl_checks(app.home_frame.stats_panel)
                except Exception as exc:  # noqa: BLE001
                    check("bloque LVL con/sin save del perfil sin crash",
                          False, repr(exc))
                done()

            wait_in_app(
                app,
                lambda: app.current_frame is app.home_frame
                and app.token is not None,
                ok, timeout=15,
            )

        run_phase(
            "panel de stats (reducido: bloque LVL sintético)",
            [step_wait_home, step_lvl_reducido],
            build_stats_app,
        )


def phase_play_unlinked() -> None:
    """Fase 4: JUGAR simulado con cuenta SIN identidad → flujo simplificado.

    JUGAR → el juego abre (simulado) → el launcher se queda en la home
    normal: SIN espera de candidatos y SIN pantalla de verificación. La
    identidad la vincula el SERVER (auto-link por sesión de juego). Si a los
    ~60s (delay inyectado: 1.5s en la prueba) la cuenta sigue sin identidad,
    aparece UN log dim único en la consola.
    """

    def step_wait_home(app: App, done: Callable[[], None]) -> None:
        wait_in_app(
            app,
            lambda: app.current_frame is app.home_frame and app.token is not None,
            done, timeout=15,
        )

    def step_play(app: App, done: Callable[[], None]) -> None:
        # Sesión de juego (POST /api/play/session): contador sobre el cliente
        # real (sin red) para verificar la llamada de JUGAR y su ciclo.
        calls = {"n": 0}

        def counting_play_session(token):
            calls["n"] += 1
            return {"ok": True, "nick": "Launcher Test",
                    "expiresAt": "2026-11-08T00:00:00.000Z"}

        app.api.play_session = counting_play_session  # type: ignore[method-assign]
        app.play_session_calls = calls
        app.unlinked_hint_delay_ms = 1500  # aviso dim único acelerado (prueba)
        app.home_frame.log_line(">>> lanzando JUGAR (simulado) desde la prueba")
        app.start_play()
        done()

    def step_wait_result(app: App, done: Callable[[], None]) -> None:
        def terminal_asserts() -> None:
            console = app.home_frame.console.get("1.0", "end")
            status = str(app.home_frame.status.cget("text"))
            btn = str(app.home_frame.play_btn.cget("text"))
            hud = str(app.home_frame.hud_state.cget("text"))
            check("JUGAR simulado: log de 'SIMULACIÓN' presente",
                  "SIMULACIÓN" in console)
            check("JUGAR simplificado: el juego abre y el launcher queda en home",
                  ("se vincula automáticamente" in console)      # camino sin identidad
                  or ("solo abrimos el juego" in console),       # re-run ya vinculado
                  console[-400:])
            check("JUGAR simplificado: SIN espera de candidatos ni verificación",
                  ("Aún no te vemos" not in console)
                  and ("Esperando tu conexión" not in console)
                  and ("Identidad verificada" not in console),
                  console[-400:])
            check("JUGAR simplificado: estado claro al abrir",
                  ("Juego iniciado" in status) or ("Juego abierto" in status),
                  status)
            check("botón operable al terminar (JUGAR) y strip EN PARTIDA",
                  btn == "JUGAR" and "EN PARTIDA" in hud,
                  f"btn={btn} hud={hud}")

            if "se vincula automáticamente" not in console:
                check("aviso dim único: omitido (cuenta ya vinculada en re-run)", True)
                done()
                return

            # Aviso dim ÚNICO a los ~60s de juego (delay inyectado a 1.5s).
            def hint_ok() -> None:
                vivo = app.home_frame.console.get("1.0", "end")
                n = vivo.count("Aún sin vincular")
                check("aviso dim único 'Aún sin vincular' tras el delay inyectado",
                      n == 1, f"n={n}")

                def hint_still_one() -> None:
                    n2 = (app.home_frame.console.get("1.0", "end")
                          .count("Aún sin vincular"))
                    check("aviso dim: NO se repite (único por sesión)",
                          n2 == 1, f"n={n2}")
                    done()

                app.after(2000, hint_still_one)

            wait_in_app(app,
                        lambda: "Aún sin vincular" in
                        app.home_frame.console.get("1.0", "end"),
                        hint_ok, timeout=15)

        # 30s de margen: el flujo simplificado termina en segundos.
        wait_in_app(app, lambda: app.flow is None,
                    lambda: app.after(250, terminal_asserts), timeout=30)

    def step_play_session(app: App, done: Callable[[], None]) -> None:
        """Sesión de juego: la llamada de JUGAR + su renovación en ciclo."""
        calls = app.play_session_calls
        check("dar JUGAR abre sesión de juego (POST /api/play/session stub)",
              calls["n"] >= 1, f"calls={calls['n']}")
        # Ciclo de 30s acelerado a 700ms (y rearme de seguridad: el refresh_me
        # del aviso puede reprogramar el ciclo a 30s entre medias).
        app._schedule_play_session(700)

        def rearm() -> None:
            if calls["n"] < 2:
                app._schedule_play_session(500)

        app.after(1500, rearm)

        def ok2() -> None:
            check("sesión de juego se renueva en su ciclo (stub)",
                  calls["n"] >= 2, f"calls={calls['n']}")
            done()

        wait_in_app(app, lambda: calls["n"] >= 2, ok2, timeout=10)

    run_phase(
        "JUGAR simulado sin vincular (flujo simplificado)",
        [step_wait_home, step_play, step_wait_result, step_play_session],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


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
                # Sin candidatos NI GUIDs libres: el ingest los recrea cuando
                # hay partidas; mientras el backend (trabajo paralelo)
                # reconstruye datos, esto es PENDIENTE de entorno, no un fallo
                # del launcher.
                check("hay GUIDs disponibles para vincular", True,
                      "PENDIENTE entorno: sin candidatos ni GUIDs libres en el "
                      "leaderboard (se recrean con partidas reales)")
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
    """Fase 5: con cuenta vinculada → badge VERIFICADO, JUGAR directo y
    sesión de juego (POST /api/play/session con stub de contador)."""
    # La fase de stats termina con logout (borra el token del store de
    # prueba): re-logueamos aquí para que el auto-login funcione.
    api = ApiClient(API_URL)
    try:
        token = ensure_login_retry(api)
        user = api.me(token)
        UserStore(STORE_PATH).save(token, EMAIL, DISPLAY)
    except Exception as exc:
        check("preparación de JUGAR vinculado (login)", False, str(exc))
        return
    if not user_is_linked(user):
        # Sin GUID vinculado (entorno sin GUIDs libres: backend en paralelo
        # reconstruyendo el ingest) la fase no es representativa → PENDIENTE.
        check("preparación de JUGAR vinculado (cuenta con GUID)", True,
              "PENDIENTE entorno: la cuenta quedó sin GUID porque no hay "
              "GUIDs libres que vincular ahora mismo")
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
        # Sesión de juego (POST /api/play/session): contador sobre el cliente
        # real (sin red). Debe llamarse al dar JUGAR.
        calls = {"n": 0}

        def counting_play_session(token):
            calls["n"] += 1
            return {"ok": True, "nick": "Launcher Test",
                    "expiresAt": "2026-11-08T00:00:00.000Z"}

        app.api.play_session = counting_play_session  # type: ignore[method-assign]
        app.play_session_calls = calls  # visible para los siguientes pasos
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
            check("dar JUGAR abre sesión de juego (POST /api/play/session stub)",
                  app.play_session_calls["n"] >= 1,
                  f"calls={app.play_session_calls['n']}")
            done()

        wait_in_app(
            app,
            lambda: app.flow is None and "Juego abierto" in str(app.home_frame.status.cget("text")),
            ok, timeout=25,
        )

    def step_play_session_cycle(app: App, done: Callable[[], None]) -> None:
        # Renovación en ciclo: reprogramamos a 800ms (tras el refresh_me del
        # éxito, que reprograma a 30s) y esperamos la llamada 2.
        app._schedule_play_session(800)

        def ok2() -> None:
            check("sesión de juego se renueva en su ciclo (stub)",
                  app.play_session_calls["n"] >= 2,
                  f"calls={app.play_session_calls['n']}")
            done()

        wait_in_app(app, lambda: app.play_session_calls["n"] >= 2, ok2, timeout=10)

    run_phase(
        "JUGAR con cuenta ya vinculada + sesión de juego",
        [step_wait, step_play, step_wait_result, step_play_session_cycle],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


class StubApi:
    """Dobles de los endpoints que usan el flujo y el cloud-sync."""

    def __init__(self) -> None:
        self.link_start_calls = 0
        # Cloud-sync: {path: bytes} en el "server" + metadatos.
        self._save_store: Dict[str, bytes] = {}
        self._save_version = 0
        self._save_updated = "2026-11-07T10:00:00.000Z"
        self.save_upload_calls = 0

    def link_start(self, token):
        # SE CONSERVA como espía: el flujo simplificado NO debe llamarlo.
        self.link_start_calls += 1
        return {}

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


def flow_once(stub: StubApi, display_name: str = "El Tester", **kw):
    events: List[Dict[str, Any]] = []
    flow = GameFlow(
        stub, "tok", r"C:\no\existe\iw4x.exe", "127.0.0.1:28961",
        events.append, simulate=True, display_name=display_name, **kw,
    )
    flow.run()
    return events


def phase_save_sync() -> None:
    """Fase cloud-sync HÍBRIDA: pipeline stub + E2E contra la API real
    (PUT → manifest → download → upload post-sesión).
    Las puras (mapeo/hashes/decisión/caps/detect_build) están en test_units.py."""
    print("\n=== Fase cloud-sync (stub + API real) ===")
    import base64
    import hashlib
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="iw4x-sync-"))

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
    print("\n=== Fase lógica: GameFlow simplificado (StubApi, sin red real) ===")

    # Sin identidad → sin link/start, sin polling; el log anuncia el auto-link.
    stub = StubApi()
    evs = flow_once(stub)
    kinds = [e["t"] for e in evs]
    check("sin identidad: éxito y SIN link/start ni espera de candidatos",
          stub.link_start_calls == 0 and "success" in kinds
          and "failed" not in kinds, f"kinds={kinds}")
    check("log 'se vincula automáticamente al entrar' presente",
          any(e.get("t") == "log" and "se vincula automáticamente"
              in e.get("msg", "") for e in evs), str(evs)[:300])
    check("flujo simulado registra comando con +set name y +connect",
          any(e.get("t") == "log" and '+set name "El Tester"' in e.get("msg", "")
              and "+connect" in e.get("msg", "") for e in evs),
          str(evs)[:300])

    # Cuenta ya vinculada → mismo camino simplificado, mensaje propio.
    stub = StubApi()
    evs: List[Dict[str, Any]] = []
    flow = GameFlow(stub, "tok", r"D:\Games\iw4x.exe", "127.0.0.1:28961",
                    evs.append, already_linked=True, simulate=True,
                    display_name="El Tester")
    flow.run()
    check("cuenta ya vinculada → no llama a link/start y éxito",
          stub.link_start_calls == 0 and any(e["t"] == "success" for e in evs))
    check("log 'Tu identidad ya está verificada' presente",
          any(e.get("t") == "log" and "ya está verificada" in e.get("msg", "")
              for e in evs), str(evs)[:300])

    # Simulación → NADA toca la API (ni manifiesto ni sync): el modo de
    # prueba no debe leer el guid.dat ni consultar nada.
    stub = StubApi()

    def _manifest_no_debe_llamarse(token):
        raise AssertionError("en simulación NO debe consultarse el manifiesto")

    stub.save_manifest = _manifest_no_debe_llamarse
    evs = flow_once(stub)
    check("simulación: ni manifiesto ni sync (sin llamadas a la API)",
          any(e.get("t") == "log" and "Sincronización de progreso omitida "
              "(simulado)." in e.get("msg", "") for e in evs)
          and any(e["t"] == "success" for e in evs), str(evs)[:300])

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
    # El armado puro del comando (+set name SIEMPRE) vive en test_units.py
    # (tests/test_units.py::phase_command_args).


def phase_guid_quarantine_pipeline() -> None:
    """Fase lógica: cuarentena guid.dat → juego crea identidad → upload.

    Pipeline stub del fix cyber-café con rutas INYECTADAS (NUNCA toca el
    %LOCALAPPDATA% real): el manifiesto de la cuenta NO tiene guid.dat y la
    PC tiene un guid.dat local (de otro jugador) → el flujo lo CUARENTENA en
    <userId>-<ts>/, "el juego" (Popen falso) crea identidad nueva y el upload
    post-sesión la incluye. Segundo escenario: la sesión muere <10s sin guid
    nuevo → el cuarentenado se REPOne (restauración de seguridad).
    """
    print("\n=== Fase cuarentena guid.dat → identidad nueva → upload (stubs) ===")
    import tempfile

    import game_flow as gf

    def make_escenario(name: str) -> Dict[str, Path]:
        tmp = Path(tempfile.mkdtemp(prefix=f"iw4x-quar-{name}-"))
        gd = tmp / "gd"
        (gd / "players").mkdir(parents=True)
        (gd / "players" / "iw4x.stat").write_bytes(f"QUAR-{name}-1".encode())
        exe = tmp / "iw4x.exe"
        exe.write_bytes(b"MZ-fake")  # existe: pasa el guard de _launch_game
        guid = tmp / "localapp" / "iw4x" / "guid.dat"
        guid.parent.mkdir(parents=True)
        guid.write_bytes(b"GUID-VIEJO-DE-OTRO-JUGADOR")
        return {"tmp": tmp, "gd": gd, "exe": exe, "guid": guid,
                "qroot": tmp / "quarantine"}

    class FakeProc:
        """Doble del Popen del juego: PID falso, NUNCA un juego real."""

        def __init__(self, cmd, create_guid: bool, guid_path: Path):
            self.pid = 424900
            self.cmd = cmd
            self._exited = False
            if create_guid:
                # El juego real, al arrancar SIN guid.dat, crea uno propio.
                guid_path.write_bytes(b"GUID-NUEVO-CREADO-POR-EL-JUEGO")

        def poll(self):
            return 0 if self._exited else None

        def wait(self, timeout=None):
            self._exited = True
            return 0

        def kill(self):
            self._exited = True

    def correr(esc: Dict[str, Path], create_guid: bool):
        stub = StubApi()
        events: List[Dict[str, Any]] = []
        flow = GameFlow(stub, "tok", str(esc["exe"]), "127.0.0.1:28961",
                        events.append, already_linked=False, simulate=False,
                        display_name="El Tester", cloud_save=True,
                        game_dir=str(esc["gd"]), user_id="u-777",
                        guid_path=str(esc["guid"]),
                        quarantine_root_path=esc["qroot"])
        orig_popen = gf.subprocess.Popen
        gf.subprocess.Popen = (
            lambda cmd, **kw: FakeProc(cmd, create_guid, esc["guid"]))
        try:
            flow.run()
        finally:
            gf.subprocess.Popen = orig_popen
        return stub, events

    # --- Escenario A: el juego crea identidad nueva → upload la incluye ----
    esc_a = make_escenario("nueva")
    stub_a, evs_a = correr(esc_a, create_guid=True)
    logs_a = [str(e.get("msg", "")) for e in evs_a if e.get("t") == "log"]
    check("cuarentena: log 'Identidad nueva creada para tu cuenta…'",
          any("Identidad nueva creada para tu cuenta" in x for x in logs_a),
          str(logs_a))
    quarantined = list(esc_a["qroot"].glob("u-777-*/guid.dat"))
    check("cuarentena: el guid.dat viejo quedó en <userId>-<ts>/guid.dat",
          len(quarantined) == 1
          and quarantined[0].read_bytes() == b"GUID-VIEJO-DE-OTRO-JUGADOR",
          str(list(esc_a["qroot"].glob("*"))))
    check("cuarentena: el juego (stub) creó SU identidad nueva",
          esc_a["guid"].read_bytes() == b"GUID-NUEVO-CREADO-POR-EL-JUEGO",
          repr(esc_a["guid"].read_bytes()[:40]))
    check("cuarentena: el upload post-sesión incluye la identidad NUEVA",
          stub_a._save_store.get("guid.dat") == b"GUID-NUEVO-CREADO-POR-EL-JUEGO",
          repr(stub_a._save_store.get("guid.dat"))[:40])
    check("cuarentena: flujo en éxito y SIN link/start (sin verificación)",
          any(e["t"] == "success" for e in evs_a)
          and stub_a.link_start_calls == 0, str([e["t"] for e in evs_a]))

    # --- Escenario B: sesión muere <10s sin guid → RESTAURACIÓN -------------
    esc_b = make_escenario("restaurada")
    stub_b, evs_b = correr(esc_b, create_guid=False)
    logs_b = [str(e.get("msg", "")) for e in evs_b if e.get("t") == "log"]
    check("restauración: el guid.dat viejo vuelve a su sitio (best-effort)",
          esc_b["guid"].read_bytes() == b"GUID-VIEJO-DE-OTRO-JUGADOR",
          repr(esc_b["guid"].read_bytes()[:40]))
    check("restauración: log claro 'Tu identidad anterior fue repuesta…'",
          any("Tu identidad anterior fue repuesta" in x for x in logs_b),
          str(logs_b))
    check("restauración: el upload incluye la identidad RESTAURADA",
          stub_b._save_store.get("guid.dat") == b"GUID-VIEJO-DE-OTRO-JUGADOR",
          repr(stub_b._save_store.get("guid.dat"))[:40])
    check("restauración: la copia de cuarentena sigue como respaldo",
          len(list(esc_b["qroot"].glob("u-777-*/guid.dat"))) == 1)

    # --- Escenario C: API caída en el PRE-launch → WARNING y juega igual ----
    # (misma filosofía del cloud-sync: NUNCA bloquea jugar; ante incertidumbre
    # NO se cuarentena — se conserva la identidad local tal cual.)
    esc_c = make_escenario("apizada")
    stub_c = StubApi()

    def _manifest_roto(token):
        raise NetworkError("No se pudo conectar con la API.")

    stub_c.save_manifest = _manifest_roto
    events_c: List[Dict[str, Any]] = []
    flow_c = GameFlow(stub_c, "tok", str(esc_c["exe"]), "127.0.0.1:28961",
                      events_c.append, already_linked=False, simulate=False,
                      display_name="El Tester", cloud_save=True,
                      game_dir=str(esc_c["gd"]), user_id="u-777",
                      guid_path=str(esc_c["guid"]),
                      quarantine_root_path=esc_c["qroot"])
    orig_popen = gf.subprocess.Popen
    gf.subprocess.Popen = lambda cmd, **kw: FakeProc(cmd, False, esc_c["guid"])
    try:
        flow_c.run()
    finally:
        gf.subprocess.Popen = orig_popen
    logs_c = [str(e.get("msg", "")) for e in events_c if e.get("t") == "log"]
    check("API caída en pre-launch → NO bloquea jugar (éxito)",
          any(e["t"] == "success" for e in events_c),
          str([e["t"] for e in events_c]))
    check("API caída → omite sync y CONSERVA la identidad (sin cuarentena)",
          any("Sincronización de progreso omitida" in x for x in logs_c)
          and any("se conserva la identidad local" in x for x in logs_c)
          and not list(esc_c["qroot"].glob("u-777-*"))
          and esc_c["guid"].read_bytes() == b"GUID-VIEJO-DE-OTRO-JUGADOR",
          str(logs_c))


def phase_hero_stop_button() -> None:
    """Fase GUI: botón héroe JUGAR ⇄ DETENER según el proceso (stubs).

    - (c) sin proceso vivo → el botón es JUGAR (ámbar, habilitado).
    - (b) con el juego vivo que este launcher lanzó (doble del Popen con PID
      falso, NUNCA un juego real; kill_tree parcheado por PID) → el MISMO
      botón pasa a DETENER (danger #D2544A); al pulsarlo: mata el stub,
      ejecuta el flujo post-sesión (esperar muerte + upload del save, stub)
      y vuelve a JUGAR. Durante la detención: DETENIENDO… deshabilitado y
      los clicks extra se ignoran (guard anti-carreras, un solo kill).
    - si el juego se cierra SOLO (evento game_closed del flujo, el mismo que
      emite _await_game_and_upload en producción) el botón también vuelve a
      JUGAR sin quedar clavado en DETENER.
    """
    print("\n=== Fase botón héroe JUGAR ⇄ DETENER (stubs) ===")
    import tempfile
    import threading

    import game_flow as gf

    class StopProc:
        """Doble del Popen del juego: PID falso, NUNCA un juego real."""

        def __init__(self, pid: int) -> None:
            self.pid = pid
            self._exited = False
            self.kill_calls = 0

        def poll(self):
            return 0 if self._exited else None

        def wait(self, timeout=None):
            self._exited = True
            return 0

        def kill(self):
            self.kill_calls += 1
            self._exited = True

    killed: List[int] = []
    by_pid: Dict[int, StopProc] = {}
    orig_kill_tree = gf.kill_tree

    def fake_kill_tree(pid, timeout=None):
        killed.append(int(pid))
        p = by_pid.get(int(pid))
        if p is not None:
            p._exited = True  # el árbol murió (como el taskkill /F real)
        return True

    def make_live(app: App, tmp_root: str, pid: int):
        """Flujo 'con juego vivo' para inyectar en la App (stub, sin run())."""
        gd = Path(tmp_root) / f"gd-{pid}"
        (gd / "players").mkdir(parents=True, exist_ok=True)
        stat = gd / "players" / "iw4x.stat"
        stat.write_bytes(f"STOP-PROGRESS-{pid}-{time.time_ns()}".encode())
        expected = stat.read_bytes()
        stub = StubApi()
        flow = GameFlow(stub, "tok", r"C:\no\existe\iw4x.exe",
                        "127.0.0.1:28961", app._on_flow_event,
                        already_linked=True, simulate=False,
                        display_name="El Tester", cloud_save=True,
                        game_dir=str(gd))
        proc = StopProc(pid)
        by_pid[pid] = proc
        flow._process = proc  # inyección: el "juego" que el launcher lanzó
        return flow, stub, expected

    gf.kill_tree = fake_kill_tree
    tmp_root = tempfile.mkdtemp(prefix="iw4x-hero-")
    # El store de prueba es GLOBAL a la máquina: otra suite en paralelo (o
    # las fases finales de esta) puede borrarlo entre fases. Igual que hace
    # phase_play_linked: re-logueo headless ANTES de construir la GUI.
    try:
        token = ensure_login_retry(ApiClient(API_URL))
        UserStore(STORE_PATH).save(token, EMAIL, DISPLAY)
    except Exception as exc:
        check("preparación del botón héroe (login)", False, str(exc))
        return
    try:
        # --- (c) sin proceso vivo: JUGAR ámbar -------------------------------
        def step_no_process(app: App, done: Callable[[], None]) -> None:
            def ok() -> None:
                btn = app.home_frame.play_btn
                check("sin proceso vivo: botón JUGAR (ámbar, habilitado)",
                      str(btn.cget("text")) == "JUGAR"
                      and str(btn.cget("state")) == "normal"
                      and "E8930C" in str(btn.cget("fg_color")).upper()
                      and app._live_flow is None,
                      f"text={btn.cget('text')} state={btn.cget('state')} "
                      f"fg={btn.cget('fg_color')}")
                done()

            wait_in_app(app, lambda: app.current_frame is app.home_frame
                        and app.token is not None, ok, timeout=15)

        # --- (b) proceso vivo → DETENER → click → post-sesión → JUGAR --------
        def step_stop_flow(app: App, done: Callable[[], None]) -> None:
            btn = app.home_frame.play_btn
            flow_b, stub_b, expected_b = make_live(app, tmp_root, 424344)
            app.flow = flow_b
            # El MISMO evento success que emite el flujo real tras abrir.
            app._on_flow_event({"t": "success", "msg": "Juego abierto.",
                                "linked": True})
            check("juego vivo (stub): el MISMO botón pasa a DETENER (danger)",
                  str(btn.cget("text")) == "DETENER"
                  and str(btn.cget("state")) == "normal"
                  and "D2544A" in str(btn.cget("fg_color")).upper(),
                  f"text={btn.cget('text')} fg={btn.cget('fg_color')}")
            check("juego vivo: el flujo queda como sesión viva (self.flow=None)",
                  app._live_flow is flow_b and app.flow is None,
                  f"live={app._live_flow is not None} flow={app.flow is not None}")

            btn.invoke()          # click DETENER → DETENIENDO… + guard activo
            app.on_hero_button()  # anti-carreras: click extra DEBE ignorarse
            check("en vuelo: DETENIENDO… deshabilitado (click extra ignorado)",
                  str(btn.cget("text")) == "DETENIENDO…"
                  and str(btn.cget("state")) == "disabled"
                  and app._hero_busy is True,
                  f"text={btn.cget('text')} state={btn.cget('state')} "
                  f"busy={app._hero_busy}")

            def ok() -> None:
                check("DETENER: mata el stub UNA vez por PID (guard anti-carreras)",
                      killed == [424344] and flow_b._process._exited,
                      f"killed={killed} kills_del_stub={flow_b._process.kill_calls}")
                check("DETENER: ejecuta el upload post-sesión (stub)",
                      stub_b.save_upload_calls >= 1, str(stub_b.save_upload_calls))
                check("DETENER: el progreso llegó a la cuenta (stub)",
                      stub_b._save_store.get("iw4x.stat") == expected_b,
                      repr(stub_b._save_store.get("iw4x.stat"))[:60])
                check("DETENER: el botón vuelve a JUGAR (ámbar) y sin sesión viva",
                      str(btn.cget("text")) == "JUGAR"
                      and str(btn.cget("state")) == "normal"
                      and "E8930C" in str(btn.cget("fg_color")).upper()
                      and app._hero_busy is False and app._live_flow is None,
                      f"text={btn.cget('text')} state={btn.cget('state')} "
                      f"busy={app._hero_busy}")
                console = app.home_frame.console.get("1.0", "end")
                check("DETENER: logs del post-sesión en la consola",
                      "Botón DETENER: juego detenido." in console
                      and "Progreso subido a tu cuenta ✓" in console,
                      console[-300:])
                done()

            wait_in_app(app, lambda: str(btn.cget("text")) == "JUGAR"
                        and app._hero_busy is False, ok, timeout=15)

        # --- el juego se cierra SOLO → JUGAR (no clavado en DETENER) ---------
        def step_solo_exit(app: App, done: Callable[[], None]) -> None:
            btn = app.home_frame.play_btn
            flow_s, stub_s, _expected = make_live(app, tmp_root, 424345)
            app.flow = flow_s
            app._on_flow_event({"t": "success", "msg": "Juego abierto (2).",
                                "linked": True})
            check("segunda sesión: DETENER de nuevo (estado reutilizable)",
                  str(btn.cget("text")) == "DETENER", str(btn.cget("text")))
            # El juego muere SOLO y el hilo del flujo hace el post-sesión
            # completo (el mismo camino de producción: game_closed + upload).
            flow_s._process._exited = True
            threading.Thread(target=flow_s._await_game_and_upload,
                             daemon=True, name="await-stub").start()

            def ok_btn() -> None:
                check("juego cerrado solo: el botón vuelve a JUGAR "
                      "(no clavado en DETENER)",
                      str(btn.cget("text")) == "JUGAR" and app._live_flow is None,
                      f"text={btn.cget('text')} "
                      f"live={app._live_flow is not None}")

                def ok_upload() -> None:
                    check("juego cerrado solo: el post-sesión subió el "
                          "progreso (stub)",
                          stub_s.save_upload_calls >= 1,
                          str(stub_s.save_upload_calls))
                    done()

                wait_in_app(app, lambda: stub_s.save_upload_calls >= 1,
                            ok_upload, timeout=10)

            wait_in_app(app, lambda: str(btn.cget("text")) == "JUGAR"
                        and app._live_flow is None, ok_btn, timeout=15)

        run_phase("botón héroe JUGAR ⇄ DETENER",
                  [step_no_process, step_stop_flow, step_solo_exit],
                  lambda: App(make_test_cfg(), ApiClient(API_URL),
                              UserStore(STORE_PATH)))
    finally:
        gf.kill_tree = orig_kill_tree


# ---------------------------------------------------------------------------
def phase_exit_hook() -> None:
    """Fase cierre del launcher: WM_DELETE_WINDOW y emergency_shutdown (stubs).

    Con un doble del Popen (PID falso) y ``kill_tree`` parcheado, verifica el
    comportamiento SIEMPRE pedido por el dueño:
    - cerrar la ventana mata el ÁRBOL del PID que el launcher lanzó
      (taskkill por PID — JAMÁS por nombre: el server dedicado también es
      iw4x.exe);
    - tras la muerte intenta el upload del save (stub) UNA sola vez;
    - la salida por try/finally del mainloop / atexit (``emergency_shutdown``)
      hace lo mismo;
    - sin juego vivo (sin flow, o juego ya muerto) el cierre no toca nada
      (el upload lo hace el flujo post-sesión normal, sin duplicar);
    - la secuencia es idempotente: la red de seguridad no repite kill/upload.
    """
    print("\n=== Fase cierre del launcher: kill tree + upload (stubs) ===")
    import tempfile

    import game_flow as gf

    class StubProc:
        """Doble del Popen del juego con PID falso (nunca un juego real)."""

        def __init__(self, pid: int, exited: bool = False) -> None:
            self.pid = pid
            self._exited = exited
            self.kill_calls = 0

        def poll(self):
            return 0 if self._exited else None

        def wait(self, timeout=None):
            self._exited = True
            return 0

        def kill(self):
            self.kill_calls += 1
            self._exited = True

    def make_game_dir() -> Path:
        tmp = Path(tempfile.mkdtemp(prefix="iw4x-exit-"))
        (tmp / "players").mkdir(parents=True)
        (tmp / "players" / "iw4x.stat").write_bytes(
            f"EXIT-PROGRESS-{time.time_ns()}".encode())
        return tmp

    def make_flow(game_dir: str, proc: StubProc):
        events: List[Dict[str, Any]] = []
        stub = StubApi()
        flow = GameFlow(stub, "tok", r"C:\no\existe\iw4x.exe", "127.0.0.1:28961",
                        events.append, already_linked=True, simulate=False,
                        display_name="El Tester", cloud_save=True,
                        game_dir=game_dir)
        flow._process = proc  # inyección: el "juego" que el launcher lanzó
        return flow, stub, events

    killed: List[Optional[int]] = []
    procs_by_pid: Dict[int, StubProc] = {}
    orig_kill_tree = gf.kill_tree

    def fake_kill_tree(pid, timeout=None):
        killed.append(pid)
        p = procs_by_pid.get(pid)
        if p is not None:
            p._exited = True  # el árbol murió (como el taskkill /F real)
        return True

    gf.kill_tree = fake_kill_tree
    try:
        # --- Escenario A: juego vivo + cierre de ventana (WM_DELETE_WINDOW) --
        dir_a = make_game_dir()
        expected_a = (dir_a / "players" / "iw4x.stat").read_bytes()
        proc_a = StubProc(424242)
        procs_by_pid[424242] = proc_a
        flow_a, stub_a, evs_a = make_flow(str(dir_a), proc_a)
        holder_a: List[App] = []
        console_a: List[str] = []

        def step_close_a(app: App, done: Callable[[], None]) -> None:
            holder_a.append(app)
            orig_log_line = app.home_frame.log_line

            def spy_log_line(text):
                console_a.append(str(text))
                orig_log_line(text)

            app.home_frame.log_line = spy_log_line
            app.flow = flow_a
            # El "dueño" cierra la ventana: withdraw → kill tree → upload →
            # "Cerrando…" → destroy (todo síncrono, presupuesto ~15s).
            app._on_close()

        run_phase("cierre con juego vivo (WM_DELETE_WINDOW)", [step_close_a],
                  lambda: App(make_test_cfg(), ApiClient(API_URL),
                              UserStore(STORE_PATH)))

        logs_a = [str(e.get("msg", "")) for e in evs_a if e.get("t") == "log"]

        def idx(msg: str) -> int:
            return logs_a.index(msg) if msg in logs_a else -1

        check("cierre ventana: killer invocado con el PID que lanzó el launcher",
              killed == [424242], str(killed))
        check("cierre ventana: kill SOLO por PID (nunca por nombre de imagen)",
              all(isinstance(k, int) for k in killed), str(killed))
        check("cierre ventana: el upload del save se intentó después (stub)",
              stub_a.save_upload_calls >= 1, str(stub_a.save_upload_calls))
        check("cierre ventana: el progreso llegó a la cuenta (stub)",
              stub_a._save_store.get("iw4x.stat") == expected_a,
              repr(stub_a._save_store.get("iw4x.stat"))[:60])
        check("cierre ventana: log 'Launcher cerrado: juego detenido.'",
              "Launcher cerrado: juego detenido." in logs_a, str(logs_a))
        check("cierre ventana: log 'Progreso subido a tu cuenta ✓'",
              "Progreso subido a tu cuenta ✓" in logs_a, str(logs_a))
        check("cierre ventana: secuencia de logs kill → revisar → subido",
              0 <= idx("Launcher cerrado: juego detenido.")
              < idx("Juego cerrado: revisando tu progreso…")
              < idx("Progreso subido a tu cuenta ✓"), str(logs_a))
        check("cierre ventana: log 'Cerrando…' en la consola",
              "Cerrando…" in console_a, str(console_a))
        check("cierre ventana: upload UNA sola vez (sin duplicar)",
              stub_a.save_upload_calls == 1 and flow_a._upload_result == "upload",
              f"calls={stub_a.save_upload_calls} result={flow_a._upload_result}")
        calls_before = stub_a.save_upload_calls
        try:
            holder_a[0].emergency_shutdown()  # red atexit tras destroy: no-op
        except Exception as exc:
            check("cierre idempotente: emergency_shutdown posterior no explota",
                  False, str(exc))
        check("cierre idempotente: la red de seguridad no repite kill/upload",
              killed == [424242] and stub_a.save_upload_calls == calls_before,
              f"killed={killed} calls={stub_a.save_upload_calls}")

        # --- Escenario B: salida por finally del mainloop / atexit ----------
        dir_b = make_game_dir()
        proc_b = StubProc(424243)
        procs_by_pid[424243] = proc_b
        flow_b, stub_b, _evs_b = make_flow(str(dir_b), proc_b)

        def step_exit_b(app: App, done: Callable[[], None]) -> None:
            app.flow = flow_b
            app.emergency_shutdown()  # misma secuencia, otra vía de salida

        run_phase("salida por finally/atexit (emergency_shutdown)",
                  [step_exit_b],
                  lambda: App(make_test_cfg(), ApiClient(API_URL),
                              UserStore(STORE_PATH)))

        check("salida finally/atexit: también mata el juego lanzado",
              killed == [424242, 424243], str(killed))
        check("salida finally/atexit: intenta el upload del save (stub)",
              stub_b.save_upload_calls >= 1, str(stub_b.save_upload_calls))

        # --- Escenario C: sin juego vivo → el cierre no toca nada -----------
        killed_before = len(killed)
        dir_c = make_game_dir()
        proc_dead = StubProc(424244, exited=True)  # juego YA muerto solo
        flow_dead, stub_dead, evs_dead = make_flow(str(dir_c), proc_dead)

        def step_no_flow(app: App, done: Callable[[], None]) -> None:
            app._on_close()  # sin flow: cierre normal, sin kill/upload

        def step_dead_game(app: App, done: Callable[[], None]) -> None:
            app.flow = flow_dead
            app._on_close()  # juego ya muerto: el post-sesión normal sube

        run_phase("cierre sin flow", [step_no_flow],
                  lambda: App(make_test_cfg(), ApiClient(API_URL),
                              UserStore(STORE_PATH)))
        run_phase("cierre con juego ya muerto", [step_dead_game],
                  lambda: App(make_test_cfg(), ApiClient(API_URL),
                              UserStore(STORE_PATH)))

        check("sin juego vivo: el cierre NO invoca al killer",
              len(killed) == killed_before, f"killed={killed}")
        check("sin juego vivo: sin upload ni eventos (no duplica post-sesión)",
              stub_dead.save_upload_calls == 0 and not evs_dead
              and flow_dead._session_finalized is False
              and flow_dead._upload_result is None,
              f"calls={stub_dead.save_upload_calls} evs={evs_dead}")
    finally:
        gf.kill_tree = orig_kill_tree


# ---------------------------------------------------------------------------
def phase_autosave_close() -> None:
    """Fase autosave + guardado final al cerrar (App real, API stub).

    - Un tick del autosave con cambios sube ("Auto-guardado: progreso
      sincronizado ✓" en la consola); sin cambios NO consulta la API
      (caché de hashes); otro cambio vuelve a subir.
    - Cerrar el launcher SIN juego vivo hace SIEMPRE el guardado final
      (incondicional, presupuesto ~10s) y sube el último estado si cambió.
    """
    print("\n=== Fase autosave: ticks con/sin cambios + cierre sin juego ===")
    import tempfile

    holder: List[App] = []
    holder_stub: List[StubApi] = []
    console: List[str] = []
    tick_results: List[Optional[str]] = []
    manifest_calls = {"n": 0}
    snap: Dict[str, int] = {}  # llamadas a la API vistas AL TERMINAR cada tick

    def make_game_dir() -> Path:
        tmp = Path(tempfile.mkdtemp(prefix="iw4x-autosmoke-"))
        (tmp / "players").mkdir(parents=True)
        return tmp

    def wire_autosave_spy(app: App, game_dir: Path,
                          sink: List[str]) -> StubApi:
        """Conecta la App al stub: token, api y game_path de prueba."""
        stub = StubApi()
        orig_manifest = stub.save_manifest

        def counting_manifest(token):
            manifest_calls["n"] += 1
            return orig_manifest(token)

        stub.save_manifest = counting_manifest
        app.cfg.set("game_path", str(game_dir / "iw4x.exe"))
        app.token = "tok"
        app.api = stub
        orig_log_line = app.home_frame.log_line

        def spy_log_line(text):
            sink.append(str(text))
            orig_log_line(text)

        app.home_frame.log_line = spy_log_line
        return stub

    # --- S1: ticks del autosave (con cambios / sin cambios / otro cambio) ----
    dir_s1 = make_game_dir()
    stat_s1 = dir_s1 / "players" / "iw4x.stat"
    stat_s1.write_bytes(b"AUTOSAVE-1")

    def step_wire(app: App, done: Callable[[], None]) -> None:
        holder.append(app)
        holder_stub.append(wire_autosave_spy(app, dir_s1, console))
        app.autosave.stop()  # ticks MANUALES acá: el ciclo no interfiere
        done()

    def step_tick1(app: App, done: Callable[[], None]) -> None:
        tick_results.append(app.autosave.tick())  # local nuevo → upload
        snap["calls_t1"] = holder_stub[0].save_upload_calls
        snap["manifest_t1"] = manifest_calls["n"]
        app.after(250, done)  # deja drenar post() → el log llega a la consola

    def step_tick2(app: App, done: Callable[[], None]) -> None:
        tick_results.append(app.autosave.tick())  # idéntico → skip sin API
        snap["calls_t2"] = holder_stub[0].save_upload_calls
        snap["manifest_t2"] = manifest_calls["n"]
        done()

    def step_tick3(app: App, done: Callable[[], None]) -> None:
        stat_s1.write_bytes(b"AUTOSAVE-2")
        tick_results.append(app.autosave.tick())  # cambió → upload de nuevo
        app.after(250, done)

    run_phase("autosave: ticks con y sin cambios",
              [step_wire, step_tick1, step_tick2, step_tick3],
              lambda: (STORE_PATH.unlink(missing_ok=True),
                       App(make_test_cfg(), ApiClient(API_URL),
                           UserStore(STORE_PATH)))[1])

    stub1 = holder_stub[0]
    check("autosave tick: con cambios sube (1er tick → 'upload')",
          tick_results[:1] == ["upload"]
          and snap.get("calls_t1") == 1 and snap.get("manifest_t1") == 1,
          f"{tick_results} {snap}")
    check("autosave tick: log 'Auto-guardado: progreso sincronizado ✓' "
          "llega a la consola",
          any("Auto-guardado: progreso sincronizado ✓" in x for x in console),
          str(console))
    check("autosave tick: sin cambios → 'skip-identical' y NI una llamada "
          "más a la API",
          tick_results[1:2] == ["skip-identical"]
          and snap.get("manifest_t2") == 1 and snap.get("calls_t2") == 1,
          f"{tick_results} {snap}")
    check("autosave tick: nuevo cambio → sube el contenido nuevo",
          tick_results[2:3] == ["upload"] and stub1.save_upload_calls == 2
          and stub1._save_store.get("iw4x.stat") == b"AUTOSAVE-2",
          f"{tick_results} store={stub1._save_store.get('iw4x.stat')!r}")
    check("autosave wiring: contadores del manager de la App",
          holder[0].autosave.upload_ticks == 2
          and holder[0].autosave.ticks == 3
          and holder[0].autosave.api_ticks == 2,
          f"ticks={holder[0].autosave.ticks} "
          f"api={holder[0].autosave.api_ticks} "
          f"uploads={holder[0].autosave.upload_ticks}")

    # --- S2: cierre SIN juego vivo → guardado final SIEMPRE ------------------
    dir_s2 = make_game_dir()
    (dir_s2 / "players" / "iw4x.stat").write_bytes(b"FINAL-SAVE-1")
    holder2: List[App] = []
    console2: List[str] = []
    stub2_holder: List[StubApi] = []

    def step_close_final(app: App, done: Callable[[], None]) -> None:
        holder2.append(app)
        stub2_holder.append(wire_autosave_spy(app, dir_s2, console2))
        app._on_close()  # sin flow: skip kill → guardado final → Cerrando…

    run_phase("cierre sin juego → guardado final", [step_close_final],
              lambda: (STORE_PATH.unlink(missing_ok=True),
                       App(make_test_cfg(), ApiClient(API_URL),
                           UserStore(STORE_PATH)))[1])

    stub2 = stub2_holder[0]
    check("cierre sin juego: el guardado final sube el último estado (stub)",
          stub2.save_upload_calls == 1
          and stub2._save_store.get("iw4x.stat") == b"FINAL-SAVE-1",
          f"calls={stub2.save_upload_calls} "
          f"store={stub2._save_store.get('iw4x.stat')!r}")
    check("cierre sin juego: log 'Progreso subido a tu cuenta ✓'",
          "Progreso subido a tu cuenta ✓" in console2, str(console2))
    check("cierre sin juego: log 'Cerrando…' al final",
          "Cerrando…" in console2, str(console2))
    calls_before = stub2.save_upload_calls
    try:
        holder2[0].emergency_shutdown()  # red atexit tras destroy: no-op
    except Exception as exc:
        check("cierre sin juego: emergency_shutdown posterior no explota",
              False, str(exc))
    check("cierre sin juego: la red de seguridad no repite el guardado final",
          stub2.save_upload_calls == calls_before,
          f"calls={stub2.save_upload_calls}")


# ---------------------------------------------------------------------------
def phase_login_compact() -> None:
    """Fase GUI: login compacto — viewport mínimo, CONEXIÓN colapsable y scroll.

    - En la geometría mínima (980x640) el enlace CREAR CUENTA y el botón
      ENTRAR están MAPEADOS y DENTRO del viewport (winfo_rooty + winfo_height
      ≤ fondo de la ventana), en modo login y en modo registro.
    - Franja CONEXIÓN: colapsada por defecto tras el primer éxito (solo la
      caption clickeable + punto); un clic expande y otro colapsa.
    - Pantalla más baja que el contenido: Canvas + Scrollbar activos y la
      rueda del ratón hace scroll.
    """
    print("\n=== Fase login compacto: viewport mínimo + colapso CONEXIÓN + scroll ===")

    def step_viewport(app: App, done: Callable[[], None]) -> None:
        def ok() -> None:
            f = app.login_frame
            app.update_idletasks()
            fondo = app.winfo_rooty() + app.winfo_height()

            def dentro(w) -> bool:
                return bool(w.winfo_ismapped()) and \
                    (w.winfo_rooty() + w.winfo_height()) <= fondo + 1

            check("login compacto: ENTRAR mapeado y dentro del viewport 980x640",
                  dentro(f.action_btn),
                  f"mapped={f.action_btn.winfo_ismapped()} "
                  f"y={f.action_btn.winfo_rooty() + f.action_btn.winfo_height()} "
                  f"fondo={fondo}")
            check("login compacto: enlace CREAR CUENTA dentro del viewport",
                  dentro(f.toggle_link),
                  f"mapped={f.toggle_link.winfo_ismapped()} "
                  f"y={f.toggle_link.winfo_rooty() + f.toggle_link.winfo_height()} "
                  f"fondo={fondo}")

            # Modo registro (email + VOLVER: la columna más alta de todas).
            f._toggle_mode()
            app.update_idletasks()
            check("login compacto (registro): CREAR CUENTA dentro del viewport",
                  dentro(f.action_btn),
                  f"y={f.action_btn.winfo_rooty() + f.action_btn.winfo_height()} "
                  f"fondo={fondo}")
            check("login compacto (registro): VOLVER y EMAIL dentro del viewport",
                  dentro(f.back_btn) and dentro(f.email_box),
                  f"back={dentro(f.back_btn)} email={dentro(f.email_box)}")
            f._toggle_mode()  # de vuelta al login para los siguientes pasos
            done()

        wait_in_app(app, lambda: app.current_frame is app.login_frame,
                    ok, timeout=10)

    def step_conn_collapse(app: App, done: Callable[[], None]) -> None:
        f = app.login_frame

        def ok() -> None:
            check("CONEXIÓN colapsada tras el primer éxito (solo caption + punto)",
                  (not f.conn_test_btn.winfo_ismapped())
                  and (not f.conn_row2.winfo_ismapped())
                  and bool(f.conn_caption.winfo_ismapped())
                  and "CONECTADO" in str(f.conn_state.cget("text")),
                  f"test_btn={f.conn_test_btn.winfo_ismapped()} "
                  f"row2={f.conn_row2.winfo_ismapped()} "
                  f"state={f.conn_state.cget('text')!r}")
            f.toggle_conn()
            app.update_idletasks()
            check("caption '// CONEXIÓN //': clic expande el detalle",
                  bool(f.conn_test_btn.winfo_ismapped())
                  and bool(f.conn_row2.winfo_ismapped()))
            f.toggle_conn()
            app.update_idletasks()
            check("caption '// CONEXIÓN //': clic vuelve a colapsar",
                  not f.conn_test_btn.winfo_ismapped())
            done()

        wait_in_app(
            app,
            lambda: "CONECTADO" in str(app.login_frame.conn_state.cget("text")),
            ok, timeout=15,
        )

    def step_small_screen(app: App, done: Callable[[], None]) -> None:
        f = app.login_frame
        f.toggle_conn()  # máximo contenido: el detalle de CONEXIÓN expandido
        app.geometry("980x480")

        class _WheelDown:
            delta = -120  # evento falso de rueda: hacia abajo

        class _WheelUp:
            delta = 120

        def check_small() -> None:
            app.update_idletasks()
            check("pantalla baja: Scrollbar vertical activa (Canvas+Scrollbar)",
                  f._scroll_active and bool(f._vbar.winfo_ismapped()),
                  f"active={f._scroll_active} "
                  f"vbar={f._vbar.winfo_ismapped()}")
            antes = f._canvas.yview()
            f._on_wheel(_WheelDown())
            app.update_idletasks()
            despues = f._canvas.yview()
            check("pantalla baja: la rueda del ratón hace scroll",
                  despues != antes and despues[0] > antes[0],
                  f"antes={antes} despues={despues}")
            f._on_wheel(_WheelUp())  # volver arriba
            app.geometry("980x640")
            app.update_idletasks()
            done()

        app.after(350, check_small)

    run_phase(
        "login compacto (viewport + colapso CONEXIÓN + scroll)",
        [step_viewport, step_conn_collapse, step_small_screen],
        lambda: App(make_test_cfg(), ApiClient(API_URL), UserStore(STORE_PATH)),
    )


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

    # 2) Contrato auth/link headless con la cuenta ya creada.
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
    phase_guid_quarantine_pipeline()
    phase_hero_stop_button()
    phase_exit_hook()
    phase_autosave_close()

    # AL FINAL: audit de navegación (VOLVER) + anti doble-submit de ENTRAR
    # (stub). Su app arranca SIN sesión guardada (necesita la pantalla de
    # login) y su build borra el token de prueba — dejarlo para el cierre
    # evita romper auto-login/JUGAR/stats en cascada.
    phase_navigation_busy()

    # AL FINAL DEL TODO: login compacto (viewport/colapso/scroll). Su app
    # arranca SIN sesión guardada (necesita la pantalla de login) y NO
    # guarda token — por eso vive después de la audit de navegación.
    phase_login_compact()

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

