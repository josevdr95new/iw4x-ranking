"""Ventana principal del launcher: pantallas, hilos de red y flujo JUGAR.

Patrón de concurrencia: toda petición HTTP corre en un hilo daemon y se
comunica con la UI a través de una cola de callables que el mainloop drena
con ``after()``. Así nunca se bloquea el hilo de Tk.
"""
from __future__ import annotations

import logging
import os
import queue
import threading
import webbrowser
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import customtkinter as ctk

from api_client import ApiClient, ApiError, NetworkError, user_is_linked
from app_config import AppConfig
from autosave import Autosave
from game_flow import GameFlow
from ui.home import HomeFrame
from ui.login import LoginFrame
from ui.settings import SettingsFrame
from ui.theme import COLORS, asset_path
from user_store import UserStore

log = logging.getLogger("app")

# Periodo de renovación de la sesión de juego (contrato: POST /api/play/session)
# y demora del aviso único "aún sin vincular" tras lanzar el juego.
PLAY_SESSION_PERIOD_MS = 30_000
UNLINKED_HINT_DELAY_MS = 60_000
UNLINKED_HINT_MSG = (
    "Aún sin vincular: se vinculará automáticamente "
    "(necesitas sesión activa de launcher, ya la tienes)."
)


class App(ctk.CTk):
    """Ventana única con tres pantallas: login, principal y ajustes."""

    def __init__(self, cfg: AppConfig, api: ApiClient, store: UserStore) -> None:
        super().__init__()
        # NOTA: se llama `cfg` a propósito para no sombrear el método
        # `config()` que tkinter define en todos los widgets.
        self.cfg = cfg
        self.api = api
        self.store = store

        # Sesión actual.
        self.token: Optional[str] = None
        self.user: Optional[Dict[str, Any]] = None

        # Flujo JUGAR en curso (o None).
        self.flow: Optional[GameFlow] = None

        # Sesión viva: flujo cuyo juego (lanzado por este launcher) sigue
        # abierto. Mientras exista, el botón héroe es DETENER; al morir el
        # juego (solo o por DETENER) vuelve a JUGAR.
        self._live_flow: Optional[GameFlow] = None
        # Guard anti-carreras del héroe: una transición (detener) en vuelo
        # ignora cualquier click extra.
        self._hero_busy = False

        # Panel de stats en vivo: id del after() del ciclo de 30s + contadores.
        self._stats_after_id: Optional[str] = None
        self._stats_fetching = False
        self._stats_fetch_count = 0

        # Sesión de juego (auto-link server-side): ciclo propio de 30s que
        # renueva POST /api/play/session mientras hay sesión iniciada.
        self._play_session_after_id: Optional[str] = None

        # Aviso único "aún sin vincular" a los 60s de juego (solo log dim).
        self._unlinked_hint_after: Optional[str] = None
        self._unlinked_hint_shown = False
        self.unlinked_hint_delay_ms = UNLINKED_HINT_DELAY_MS  # inyectable (tests)

        # Cola de tareas para el hilo de UI.
        self._tasks: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self.after(60, self._drain_tasks)

        # Cierre: secuencia ÚNICA e idempotente (WM_DELETE_WINDOW + try/finally
        # del mainloop + atexit pasan todos por _shutdown_sequence).
        self._shutdown_done = False
        self._shutdown_lock = threading.Lock()

        # Auto-guardado periódico del progreso (pedido del dueño, SIEMPRE):
        # cada cfg.autosave_minutes sube el progreso si cambió (0 = off).
        # Providers en caliente: login/logout, URL de API y config editada en
        # Ajustes aplican al siguiente tick sin reiniciar nada.
        self.autosave = Autosave(
            period_provider=lambda: self.cfg.autosave_minutes,
            token_provider=lambda: self.token,
            game_dir_provider=lambda: (os.path.dirname(self.cfg.game_path)
                                       if self.cfg.game_path else ""),
            cloud_provider=lambda: self.cfg.cloud_save,
            api_provider=lambda: self.api,
            log_cb=self._autosave_log,
        )
        self.autosave.start()

        # --- Ventana ---------------------------------------------------------
        self.title("IW4X RANKING // TERMINAL DE JUGADOR")
        self.geometry("980x640")
        self.minsize(760, 500)
        self.configure(fg_color=COLORS["bg"])
        self._center()
        self._set_window_icon()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # --- Pantallas (se crean una vez) -------------------------------------
        self.login_frame = LoginFrame(self, self)
        self.home_frame = HomeFrame(self, self)
        self.settings_frame = SettingsFrame(self, self)
        self.current_frame: Optional[ctk.CTkFrame] = None

        self.refresh_home_servers()

        # --- Arranque: auto-login con la sesión guardada ----------------------
        self._bootstrap_session()

    # ================== Infraestructura de hilos ==================
    def post(self, fn: Callable[[], None]) -> None:
        """Encola un callable para ejecutarlo en el hilo de la UI."""
        self._tasks.put(fn)

    def _set_window_icon(self) -> None:
        """Logo programático como icono de ventana (assets/logo-icon.ico/.png).

        En Windows prefiere ``iconbitmap`` con el .ico multi-resolución (nítido
        en titlebar + taskbar + alt-tab); fallback a ``iconphoto`` con el PNG
        (que además propaga el icono a futuros Toplevels). Solo decorativo: si
        el asset no existe (deploy sin assets/) o Tk no acepta el icono, se
        ignora en silencio — NUNCA impide abrir la app.
        """
        try:
            import tkinter as tk

            if os.name == "nt":
                ico_path = asset_path("logo-icon.ico")
                if ico_path.is_file():
                    self.iconbitmap(str(ico_path))
                    return
            png_path = asset_path("logo-icon.png")
            if not png_path.is_file():
                return
            img = tk.PhotoImage(file=str(png_path))
            self.iconphoto(True, img)
            self._icon_ref = img  # referencia viva: Tk/GC no la puede recolectar
        except Exception:
            log.debug("Icono de ventana no disponible", exc_info=True)

    def _drain_tasks(self) -> None:
        """Ejecuta las tareas pendientes y reprograma el drenaje."""
        while True:
            try:
                fn = self._tasks.get_nowait()
            except queue.Empty:
                break
            try:
                fn()
            except Exception:  # un error de UI no debe tumbar el launcher
                log.exception("Error ejecutando tarea de UI")
        self.after(60, self._drain_tasks)

    def run_bg(
        self,
        fn: Callable[[], Any],
        on_ok: Optional[Callable[[Any], None]] = None,
        on_err: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        """Ejecuta fn() en un hilo daemon y entrega el resultado en la UI."""

        def worker() -> None:
            try:
                result = fn()
            except Exception as exc:
                log.exception("Petición en segundo plano falló: %s", exc)
                if on_err is not None:
                    self.post(lambda e=exc: on_err(e))
            else:
                if on_ok is not None:
                    self.post(lambda r=result: on_ok(r))

        threading.Thread(target=worker, daemon=True, name="api-call").start()

    # ================== Arranque / sesión ==================
    def _bootstrap_session(self) -> None:
        """Intenta auto-login con el token guardado; si no, muestra login.

        Cyber-café (decisión del dueño): con ``remember_session`` false
        (DEFAULT) NADIE hereda sesiones — cualquier token residual (incluso
        de una corrida vieja con la config anterior) se DESCARTA al abrir y
        se muestra el LOGIN directamente.
        """
        if not self.cfg.remember_session:
            try:
                self.store.clear()  # token residual fuera, sea de quien sea
            except Exception:
                pass
            log.info("Sesión no recordada (remember_session=false): login.")
            self.show_login()
            return
        saved = self.store.load()
        if not saved:
            self.show_login()
            return

        token = saved["token"]
        self._show_home_basic(saved["displayName"], saved["email"], linked=False)
        log.info("Auto-login: validando sesión guardada…")

        self.run_bg(
            lambda: self.api.me(token),
            on_ok=lambda user: self._bootstrap_ok(token, user),
            on_err=lambda exc: self._bootstrap_fail(token, exc),
        )

    def _bootstrap_ok(self, token: str, user: Dict[str, Any]) -> None:
        self.token = token
        self.user = user
        self._apply_user_to_home()
        log.info("Auto-login OK: %s", user.get("email"))

    def _bootstrap_fail(self, token: str, exc: Exception) -> None:
        if isinstance(exc, ApiError) and exc.status == 401:
            # Token expirado/inválido: borrar y pedir login.
            self.store.clear()
            self.token = None
            self.user = None
            self.show_login("Tu sesión expiró. Inicia sesión de nuevo.")
            return
        # API caída: dejamos el token y avisamos en la consola.
        msg = (
            str(exc) if isinstance(exc, NetworkError)
            else f"Error validando la sesión: {getattr(exc, 'message', exc)}"
        )
        self.show_home()
        self.home_frame.log_line(f"⚠ {msg}")
        self.home_frame.set_status("Sin conexión con la API", "warn")

    # ================== Navegación de pantallas ==================
    def _swap(self, frame: ctk.CTkFrame) -> None:
        if self.current_frame is not None:
            self.current_frame.pack_forget()
        self.current_frame = frame
        frame.pack(fill="both", expand=True)

    def show_login(self, message: str = "") -> None:
        self._swap(self.login_frame)
        self.login_frame.reset_scroll()
        if message:
            self.login_frame.status.configure(text=message, text_color=COLORS["warn"])

    def show_home(self) -> None:
        self._swap(self.home_frame)

    def _show_home_basic(self, name: str, email: str, linked: bool) -> None:
        """Muestra la home con datos mínimos mientras se valida la sesión."""
        self.show_home()
        self.home_frame.set_user(
            {"displayName": name, "email": email, "linkedGuid": "x" if linked else None}
        )

    def show_settings(self) -> None:
        self.settings_frame.load_from_config()
        self._swap(self.settings_frame)

    def open_web(self) -> None:
        """Abre la web del ranking en el navegador por defecto (stdlib).

        ``webbrowser.open`` no bloquea la UI de forma perceptible: llamada
        directa en el hilo de Tk es suficiente (no hay red propia del
        launcher en la llamada). Sin ``web_url`` en el config → no-op (los
        enlaces ni siquiera se pintan; este guard es por seguridad).
        """
        url = self.cfg.web_url
        if not url:
            return
        log.info("Abriendo la web del ranking: %s", url)
        webbrowser.open(url)

    def _center(self) -> None:
        """Centra la ventana en la pantalla (geometría mínima 980x640)."""
        self.update_idletasks()
        w, h = 980, 640
        x = (self.winfo_screenwidth() - w) // 2
        y = (self.winfo_screenheight() - h) // 3
        self.geometry(f"{w}x{h}+{x}+{y}")

    # ================== Autenticación ==================
    def login(self, email: str, password: str, on_done: Callable) -> None:
        """POST /auth/login en segundo plano; on_done(error|None) en la UI."""
        self.run_bg(
            lambda: self.api.login(email, password),
            on_ok=lambda data: self._on_auth_success(data, on_done),
            on_err=lambda exc: on_done(exc),
        )

    def register(self, email: str, password: str, display: str, on_done: Callable) -> None:
        """POST /auth/register en segundo plano."""
        self.run_bg(
            lambda: self.api.register(email, password, display),
            on_ok=lambda data: self._on_auth_success(data, on_done),
            on_err=lambda exc: on_done(exc),
        )

    def _on_auth_success(self, data: Dict[str, Any], on_done: Callable) -> None:
        """Login/registro correcto: guarda token, va a la home."""
        user = data.get("user") or {}
        token = str(data.get("token") or "")
        self.token = token
        self.user = user
        self.store.save(token, str(user.get("email", "")), str(user.get("displayName", "")))
        on_done(None)
        self._apply_user_to_home()
        log.info("Sesión iniciada: %s", user.get("email"))

    def logout(self) -> None:
        """Cierra sesión: guarda el progreso (si no hay partida) y vuelve al
        login.

        Pedido del dueño: al dar CERRAR SESIÓN el launcher SINCRONIZA los
        saves antes de borrar el token (el mismo tick final del cierre,
        presupuesto ~10s). Con una PARTIDA EN CURSO el logout NO procede:
        el post-sesión conserva el token para subir el save al cerrar el
        juego (aviso 5s en el héroe, nada se interrumpe). Si la API está
        caída, avisa y cierra sesión igualmente (resiliente).
        """
        log.info("Cierre de sesión solicitado")
        # Partida EN CURSO: NO cerrar sesión — el upload post-sesión del
        # propio flujo necesita que nada se interrumpa. El juego sigue.
        live = self._live_flow
        if live is not None and live.game_running():
            msg = ("Tienes una partida en curso: termina y cierra el juego "
                   "antes de cerrar sesión.")
            log.info("Logout bloqueado: partida en curso")
            self.home_frame.log_line(f"⚠ {msg}")
            self.home_frame.set_status(msg, "warn")
            self._schedule_hero_notice()
            return
        if self.flow is not None:
            self.flow.cancel()
            self.flow = None
        live = self._live_flow
        self._live_flow = None
        if live is not None:
            live.cancel()
        # SIN partida: guardado final del save ANTES de borrar el token
        # (mismo tick forzado del cierre, presupuesto ~10s). Solo promete
        # guardar cuando el cloud-sync está activo y hay dir de juego.
        game_dir = (os.path.dirname(self.cfg.game_path)
                    if self.cfg.game_path else "")
        if self.cfg.cloud_save and game_dir:
            self._log_line_safe("Guardando tu progreso antes de cerrar sesión…")
            try:
                result = self.autosave.tick(force=True, budget=10.0)
                if result == "upload":
                    self._log_line_safe("Progreso guardado ✓")
                elif result in ("skip-identical", "noop", "download"):
                    # Nada que subir: lo de tu nube ya es lo más nuevo.
                    self._log_line_safe("Tu progreso ya está en la nube ✓")
                elif result == "busy-read":
                    self._log_line_safe("⚠ El juego estaba escribiendo el "
                                        "save; se subirá en el próximo "
                                        "arranque.")
                # "disabled" u otro resultado: sin promesa, sin log.
            except (NetworkError, ApiError, OSError):
                self._log_line_safe("No se pudo guardar (sin conexión) — "
                                    "cerrando sesión igualmente")
            except Exception:
                log.exception("Guardado antes de cerrar sesión falló")
                self._log_line_safe("⚠ No se pudo guardar tu progreso — "
                                    "cerrando sesión igualmente")
        self._hero_busy = False
        self.store.clear()
        self.token = None
        self.user = None
        # Detiene el ciclo de stats, la sesión de juego y animaciones.
        self._cancel_stats_timer()
        self._cancel_play_session_timer()
        self._cancel_unlinked_hint()
        self._stats_fetching = False
        self.home_frame.stats_panel.stop_timers()
        self.home_frame.reset_hud()
        self.home_frame.set_status("Todo listo.", "dim")
        self.show_login()

    def _schedule_hero_notice(self, seconds: float = 5.0) -> None:
        """Aviso temporal en el héroe (logout con partida viva): la barra de
        estado muestra el aviso en ámbar ``seconds`` y vuelve sola al estado
        de partida. El juego y la sesión siguen EXACTAMENTE igual."""
        def restore() -> None:
            if self._live_flow is not None and self._live_flow.game_running():
                self.home_frame.set_status("Partida en curso.", "dim")

        try:
            self.after(int(seconds * 1000), restore)
        except Exception:  # ventana cerrada mientras tanto: nada que hacer
            pass

    # ================== Usuario / vinculación ==================
    def _apply_user_to_home(self) -> None:
        """Pinta el usuario en la home y muestra esa pantalla."""
        if self.user is None:
            return
        self.home_frame.set_user(self.user)
        self._update_play_as()
        self._update_stats_panel_state()
        self.show_home()
        self._schedule_play_session()  # ciclo de sesión de juego (auto-link)

    def _update_play_as(self) -> None:
        """Refresca 'Jugando como: <nick>' — siempre visible (obligatorio)."""
        name = str((self.user or {}).get("displayName") or "")
        self.home_frame.set_play_as(name)

    # ================== Sesión de juego (auto-link server-side) ==========
    def _touch_play_session(self, announce: bool = False) -> None:
        """POST /api/play/session (best-effort) — NUNCA bloquea jugar.

        Es la señal con la que el server puede auto-vincular la identidad del
        jugador al entrar (sin polling de candidatos en la UI). Fallos (404
        mientras el backend despliega, red, 401): log dim y se sigue; con
        ``announce`` (llamada al dar JUGAR) el aviso llega a la consola.
        """
        token = self.token
        if not token:
            return

        def ok(data: Dict[str, Any]) -> None:
            log.info("[play-session] activa: %s", data)

        def err(exc: Exception) -> None:
            msg = (str(exc) if isinstance(exc, NetworkError)
                   else getattr(exc, "message", str(exc)))
            log.info("[play-session] ignorada: %s", msg)
            if announce:
                self._log_line_safe(
                    f"Sesión de juego no disponible ({msg}); el juego "
                    "continúa igual.")

        self.run_bg(lambda: self.api.play_session(token), on_ok=ok, on_err=err)

    def _schedule_play_session(self, delay_ms: int = PLAY_SESSION_PERIOD_MS) -> None:
        """Ciclo de 30s de la sesión de juego (mientras haya sesión iniciada)."""
        self._cancel_play_session_timer()
        if not self.token:
            return
        self._play_session_after_id = self.after(delay_ms, self._play_session_tick)

    def _play_session_tick(self) -> None:
        self._play_session_after_id = None
        self._touch_play_session()
        self._schedule_play_session()

    def _cancel_play_session_timer(self) -> None:
        if self._play_session_after_id is not None:
            try:
                self.after_cancel(self._play_session_after_id)
            except Exception:
                pass
            self._play_session_after_id = None

    # ================== Aviso único "aún sin vincular" ==================
    def _schedule_unlinked_hint(self) -> None:
        """Programa el aviso único a los 60s de juego (identidad por server).

        Se cancela si el juego se cierra antes; al dispararse reconsulta
        /auth/me y SOLO loggea si la cuenta sigue sin identidad (una vez).
        """
        self._cancel_unlinked_hint()
        self._unlinked_hint_shown = False
        delay = max(500, int(self.unlinked_hint_delay_ms))
        self._unlinked_hint_after = self.after(delay, self._unlinked_hint_tick)

    def _unlinked_hint_tick(self) -> None:
        self._unlinked_hint_after = None
        if self.user is None or not self.token:
            return
        if user_is_linked(self.user):
            return
        token = self.token

        def ok(user: Dict[str, Any]) -> None:
            self.user = user
            self._apply_user_to_home()
            if not user_is_linked(user) and not self._unlinked_hint_shown:
                self._unlinked_hint_shown = True
                self._log_line_safe(UNLINKED_HINT_MSG)

        def err(_exc: Exception) -> None:
            pass  # red caída: el aviso simplemente no se muestra

        self.run_bg(lambda: self.api.me(token), on_ok=ok, on_err=err)

    def _cancel_unlinked_hint(self) -> None:
        if self._unlinked_hint_after is not None:
            try:
                self.after_cancel(self._unlinked_hint_after)
            except Exception:
                pass
            self._unlinked_hint_after = None

    # ================== Stats en vivo ==================
    def _update_stats_panel_state(self) -> None:
        """CTA o panel vivo según el usuario; gestiona el ciclo de 30s."""
        if self.user is None:
            return
        if user_is_linked(self.user):
            self.home_frame.stats_panel.show_linked()
            self._schedule_stats_refresh(delay_ms=600)  # primera carga rápida
        else:
            self.home_frame.stats_panel.show_cta()
            self._cancel_stats_timer()

    def _pick_guid_and_server(self):
        """Elige el GUID para el panel y su último server conocido.

        La API no expone mérito agregado multi-GUID: usamos el del GUID con
        la última conexión más reciente (empata con lo que ve el jugador).
        """
        links = (self.user or {}).get("linkedGuids") or []
        best = None
        for link in links:
            if not isinstance(link, dict) or not link.get("guid"):
                continue
            if best is None or \
                    str(link.get("lastConnection") or "") > str(best.get("lastConnection") or ""):
                best = link
        if best is None:
            legacy = (self.user or {}).get("linkedGuid")
            if legacy:
                return str(legacy), None
            return None, None
        return str(best["guid"]), best.get("lastServer")

    def _schedule_stats_refresh(self, delay_ms: int = 30_000) -> None:
        """Reprograma el ciclo (cancelando el pendiente para no duplicar)."""
        self._cancel_stats_timer()
        if not self.token:
            return
        self._stats_after_id = self.after(delay_ms, self.refresh_stats)

    def _cancel_stats_timer(self) -> None:
        if self._stats_after_id is not None:
            try:
                self.after_cancel(self._stats_after_id)
            except Exception:
                pass
            self._stats_after_id = None

    def refresh_stats_manual(self) -> None:
        """Botón ↻ del panel."""
        self.refresh_stats(manual=True)

    def refresh_stats(self, manual: bool = False) -> None:
        """GET /api/players/:guid y pinta el panel; reprograma el ciclo."""
        self._cancel_stats_timer()
        if not self.token or self.user is None:
            return
        panel = self.home_frame.stats_panel

        # No competir con el polling de vinculación durante JUGAR.
        if self.flow is not None:
            if manual:
                self.home_frame.log_line("Stats en pausa: hay una conexión en curso.")
            panel.set_error("— Stats en pausa durante la conexión —")
            self._schedule_stats_refresh()
            return

        guid, last_server = self._pick_guid_and_server()
        if not guid:
            panel.show_cta()
            return
        if manual:
            panel.set_loading()
        if self._stats_fetching:
            self._schedule_stats_refresh()
            return

        self._stats_fetching = True
        token = self.token

        def do() -> Dict[str, Any]:
            return self.api.player(guid)

        def ok(data: Dict[str, Any]) -> None:
            self._stats_fetching = False
            self._stats_fetch_count += 1
            # Contrato REAL de GET /api/players/:guid: la MEDALLA viaja en la
            # RAÍZ de la respuesta (data["medal"]) y el save parseado dentro
            # de player (player["save"]); el panel espera player["medal"] y el
            # save como 4º argumento. Fix del bug "la medalla no sale en el
            # launcher": el perfil llegaba al panel SIN medal → bloque '—'
            # SIEMPRE aunque la API la sirviera (la web la leía de la raíz,
            # por eso ahí sí se veía SOLDADO/RECLUTA). setdefault: si una API
            # futura mueve medal dentro de player, manda la del perfil.
            player = dict(data.get("player") or {})
            player.setdefault("medal", data.get("medal"))
            panel.set_values(player, data.get("rank"),
                             last_server, data.get("save") or player.get("save"))
            self._schedule_stats_refresh()

        def err(exc: Exception) -> None:
            self._stats_fetching = False
            if isinstance(exc, ApiError) and exc.status == 401:
                self.store.clear()
                self.token = None
                self.show_login("Tu sesión expiró. Inicia sesión de nuevo.")
                return
            if isinstance(exc, ApiError) and exc.code == "PLAYER_NOT_FOUND":
                panel.set_no_data()
            elif isinstance(exc, NetworkError):
                panel.set_error("— API sin conexión, reintentando —")
            else:
                panel.set_error(
                    f"— Error de la API: {getattr(exc, 'message', exc)} — reintentando —"
                )
            self._schedule_stats_refresh()

        self.run_bg(do, on_ok=ok, on_err=err)

    def refresh_me(self) -> None:
        """GET /auth/me para refrescar el badge tras vincular (o al volver)."""
        if not self.token:
            return
        token = self.token
        self.run_bg(
            lambda: self.api.me(token),
            on_ok=self._refresh_me_ok,
            on_err=self._refresh_me_err,
        )

    def _refresh_me_ok(self, user: Dict[str, Any]) -> None:
        self.user = user
        self._apply_user_to_home()

    def _refresh_me_err(self, exc: Exception) -> None:
        if isinstance(exc, ApiError) and exc.status == 401:
            self.store.clear()
            self.token = None
            self.show_login("Tu sesión expiró. Inicia sesión de nuevo.")
            return
        msg = str(exc) if isinstance(exc, NetworkError) else getattr(exc, "message", str(exc))
        self.home_frame.log_line(f"⚠ No se pudo refrescar el perfil: {msg}")

    # ================== Configuración ==================
    def refresh_home_servers(self) -> None:
        """Recarga el dropdown de servers de la home desde la config."""
        self.home_frame.set_servers(self.cfg.servers, self.cfg.default_server)
        self._update_play_as()  # el displayName puede haber cambiado en la web

    def apply_api_url(self, base_url: str) -> None:
        """Cambia el cliente de API (tras editar ajustes)."""
        self.api = ApiClient(base_url, timeout=self.api.timeout)

    def test_api_connection(
        self,
        base_url: str,
        on_ok: Callable[[Dict[str, Any]], None],
        on_err: Callable[[Exception], None],
    ) -> None:
        """Prueba la API con GET /api/sync/status (público, sin token)."""
        client = ApiClient(base_url, timeout=self.api.timeout)
        self.run_bg(client.sync_status, on_ok=on_ok, on_err=on_err)

    # ================== Flujo JUGAR ==================
    def on_hero_button(self) -> None:
        """ÚNICO handler del botón héroe: JUGAR o DETENER según el proceso.

        Anti-carreras: mientras haya una transición en vuelo (_hero_busy) o
        una conexión en curso (self.flow), los clicks extra se ignoran. Sin
        transición, la decisión se toma consultando game_running() del flujo
        vivo EN EL MOMENTO del click.
        """
        if self._hero_busy or self.flow is not None:
            return  # transición en vuelo: ignorar clicks extra
        live = self._live_flow
        if live is not None and live.game_running():
            self._stop_live_session()
            return
        self.start_play()

    def start_play(self) -> None:
        """Arranca el flujo JUGAR en un hilo de fondo."""
        if self.flow is not None or self._hero_busy:
            return
        # Con una partida viva NO se abre una segunda instancia del juego.
        if self._live_flow is not None and self._live_flow.game_running():
            return
        if not self.token or self.user is None:
            return

        server = self.home_frame.selected_server()
        if server is None:
            self.home_frame.set_status("Configura al menos un server en Ajustes", "warn")
            return

        linked = user_is_linked(self.user)
        display_name = str((self.user or {}).get("displayName") or "")
        home = self.home_frame
        home.set_playing(True)
        home.set_status("Conectando…", "warn")
        home.log_line("— Nueva partida —")

        # Sesión de juego (auto-link server-side): al dar JUGAR, best-effort.
        self._touch_play_session(announce=True)

        self.flow = GameFlow(
            self.api,
            self.token,
            self.cfg.game_path,
            server["address"],
            self._on_flow_event,
            already_linked=linked,
            simulate=self.cfg.simulate_game,
            display_name=display_name,
            cloud_save=self.cfg.cloud_save,
            export_classes=self.cfg.export_classes,
            game_dir=os.path.dirname(self.cfg.game_path) if self.cfg.game_path else "",
            user_id=str((self.user or {}).get("id") or ""),
        )
        threading.Thread(target=self.flow.run, daemon=True, name="game-flow").start()

    def _stop_live_session(self) -> None:
        """DETENER: mata el árbol del juego y ejecuta el post-sesión normal.

        Reusa ``GameFlow.stop_game_for_exit`` (kill tree por PID → esperar
        muerte → upload del save, con el guard anti-duplicado) SIN cerrar el
        launcher. El trabajo corre en un hilo daemon; el botón queda en
        DETENIENDO… (deshabilitado) hasta que la sesión termina.
        """
        flow = self._live_flow
        if flow is None or not flow.game_running():
            return
        self._hero_busy = True  # guard: los clicks extra se ignoran
        home = self.home_frame
        home.set_deteniendo()
        home.set_status("Deteniendo el juego…", "warn")
        home.log_line("— Deteniendo la partida…")

        def work() -> None:
            try:
                flow.stop_game_for_exit(reason="Botón DETENER")
            except Exception:
                log.exception("No se pudo detener el juego desde el botón")
            finally:
                self.post(self._stop_live_done)

        threading.Thread(target=work, daemon=True, name="game-stop").start()

    def _stop_live_done(self) -> None:
        """Fin de la detención (hilo de UI): el héroe vuelve a JUGAR."""
        self._hero_busy = False
        self._live_flow = None
        self.flow = None
        self._cancel_unlinked_hint()
        home = self.home_frame
        home.set_playing(False)  # JUGAR ámbar + strip ● LISTO
        home.set_status("Partida detenida.", "ok")
        home.log_line("Partida detenida.")
        self.refresh_me()      # el server pudo auto-vincular durante la sesión
        self.refresh_stats()  # los stats de la sesión ya están en la API

    def _on_flow_event(self, event: Dict[str, Any]) -> None:
        """Recibe eventos del hilo del flujo (ya está en el hilo de UI)."""
        kind = event.get("t")
        home = self.home_frame

        if kind == "log":
            home.log_line(str(event.get("msg", "")))

        elif kind == "success":
            msg = str(event.get("msg", ""))
            home.log_line(msg)
            home.set_status(msg, "ok")
            home.set_playing(False)
            if event.get("linked"):
                # Refresca /auth/me para el badge VERIFICADO.
                self.refresh_me()
            else:
                # Flujo simplificado: sin pantalla de verificación. Si a los
                # 60s de juego la cuenta sigue sin identidad, aviso dim único.
                self._schedule_unlinked_hint()
            flow_obj = self.flow
            self.flow = None
            if flow_obj is not None and flow_obj.game_running():
                # Juego REAL vivo: la sesión queda abierta y el héroe pasa a
                # DETENER (mismo botón, familia danger del tema).
                self._live_flow = flow_obj
                home.set_stoppable()
            else:
                # Simulación (sin proceso): botón JUGAR y strip EN PARTIDA.
                home.set_deployed()

        elif kind == "failed":
            msg = str(event.get("msg", ""))
            home.log_line(f"✘ {msg}")
            home.set_status(msg, "error")
            self._cancel_unlinked_hint()
            if event.get("retry"):
                home.set_retry()  # el botón grande pasa a REINTENTAR
            else:
                home.set_playing(False)
            self.flow = None

        elif kind == "game_closed":
            # El juego se cerró SOLO (no lo mató el botón DETENER, que ignora
            # este evento por el guard _hero_busy y la identidad del flow).
            if event.get("flow") is not self._live_flow:
                return
            self._live_flow = None
            self._cancel_unlinked_hint()
            home.set_playing(False)  # héroe → JUGAR (nunca clavado en DETENER)
            home.set_status("Partida terminada.", "dim")
            home.log_line("El juego se cerró. Fin de la partida.")
            self.refresh_me()     # recoge el auto-link que hizo el server
            self.refresh_stats()

    # ================== Cierre ==================
    def _on_close(self) -> None:
        """WM_DELETE_WINDOW: oculta la ventana y ejecuta la secuencia de salida.

        Comportamiento SIEMPRE (decisión del dueño): si este launcher dejó un
        juego vivo, la secuencia mata su ÁRBOL completo, espera su muerte y
        sube el progreso (presupuesto ~15s) antes de cerrar de verdad.
        """
        log.info("Cierre de ventana solicitado")
        try:
            self.withdraw()  # feedback inmediato: la ventana "ya se cerró"
        except Exception:
            pass
        self._shutdown_sequence()

    def emergency_shutdown(self) -> None:
        """Red de seguridad para salidas que NO pasan por WM_DELETE_WINDOW
        (try/finally del mainloop en main.py y atexit). Idempotente: si la
        secuencia ya corrió, no hace nada. NUNCA explota en el cierre.
        """
        try:
            self._shutdown_sequence()
        except Exception:
            log.exception("Secuencia de cierre best-effort falló")

    def _shutdown_sequence(self) -> None:
        """Secuencia única de cierre: detener juego → guardar → salir."""
        with self._shutdown_lock:
            if self._shutdown_done:
                return
            self._shutdown_done = True

        # Para el ciclo de auto-guardado antes de subir el estado final
        # (un tick en vuelo seguiría con el lock; el force de abajo espera).
        try:
            self.autosave.stop()
        except Exception:
            pass

        flow = self.flow
        self.flow = None
        if flow is not None:
            flow.cancel()  # aborta polling/vinculación lo antes posible
            try:
                # Mata SOLO el árbol del PID que este launcher lanzó y sube
                # el progreso una vez (presupuesto ~15s dentro del flow).
                flow.stop_game_for_exit()
            except Exception:
                log.exception("No se pudo detener el juego / subir el progreso")

        # Sesión viva (juego abierto tras un JUGAR exitoso): misma secuencia.
        # Si es el mismo flujo ya parado arriba, stop_game_for_exit no repite
        # nada (game_running False + guard anti-doble-upload).
        live = self._live_flow
        self._live_flow = None
        self._hero_busy = False
        if live is not None and live is not flow:
            live.cancel()
            try:
                live.stop_game_for_exit()
            except Exception:
                log.exception("No se pudo detener la sesión viva al cerrar")

        # Guardado final SIEMPRE (con o sin juego vivo): si el estado local
        # cambió desde el último sync, sube. Best-effort, presupuesto ~10s:
        # NUNCA bloquea el cierre más que eso. Caso cubierto: jugó, cerró el
        # juego, dejó el launcher abierto horas y lo cierra ahora.
        try:
            if self.autosave.tick(force=True, budget=10.0) == "upload":
                self._log_line_safe("Progreso subido a tu cuenta ✓")
        except Exception:
            log.exception("Guardado final antes de salir falló")

        # Limpieza de timers (best-effort: la ventana puede estar rota ya).
        try:
            self._cancel_stats_timer()
        except Exception:
            pass
        try:
            self._cancel_play_session_timer()
            self._cancel_unlinked_hint()
        except Exception:
            pass
        try:
            self.home_frame.stats_panel.stop_timers()
            self.home_frame.stop_animations()
        except Exception:
            pass

        # Sesión del launcher (cyber-café): tras el upload y ANTES de
        # destruir, con remember_session=false se BORRA el token guardado —
        # la próxima apertura muestra LOGIN (nadie hereda la sesión).
        if not self.cfg.remember_session:
            try:
                self.store.clear()
            except Exception:
                pass
            self._log_line_safe("Sesión cerrada. Hasta la próxima.")
            log.info("Sesión cerrada al salir (remember_session=false).")

        self._log_line_safe("Cerrando…")
        log.info("Cerrando…")
        try:
            self.destroy()
        except Exception:
            pass

    def _log_line_safe(self, msg: str) -> None:
        """log_line tolerante a fallos (para usar durante el cierre)."""
        try:
            self.home_frame.log_line(msg)
        except Exception:
            pass

    def _autosave_log(self, msg: str) -> None:
        """Logs del auto-guardado: al archivo y a la consola mini (en UI)."""
        log.info("[autosave] %s", msg)
        self.post(lambda m=msg: self._log_line_safe(m))
