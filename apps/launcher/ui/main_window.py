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
from typing import Any, Callable, Dict, Optional

import customtkinter as ctk

from api_client import ApiClient, ApiError, NetworkError, user_is_linked
from app_config import AppConfig
from game_flow import GameFlow
from ui.home import HomeFrame
from ui.login import LoginFrame
from ui.settings import SettingsFrame
from ui.theme import COLORS
from user_store import UserStore

log = logging.getLogger("app")


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

        # Panel de stats en vivo: id del after() del ciclo de 30s + contadores.
        self._stats_after_id: Optional[str] = None
        self._stats_fetching = False
        self._stats_fetch_count = 0

        # Cola de tareas para el hilo de UI.
        self._tasks: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self.after(60, self._drain_tasks)

        # --- Ventana ---------------------------------------------------------
        self.title("IW4X RANKING // TERMINAL DE JUGADOR")
        self.geometry("840x680")
        self.minsize(800, 620)
        self.configure(fg_color=COLORS["bg"])
        self._center()
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
        """Intenta auto-login con el token guardado; si no, muestra login."""
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

    def _center(self) -> None:
        """Centra la ventana en la pantalla."""
        self.update_idletasks()
        w, h = 780, 580
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
        """Cierra sesión: borra token y vuelve al login."""
        log.info("Cierre de sesión solicitado")
        if self.flow is not None:
            self.flow.cancel()
            self.flow = None
        self.store.clear()
        self.token = None
        self.user = None
        # Detiene el ciclo de stats y animaciones del strip.
        self._cancel_stats_timer()
        self._stats_fetching = False
        self.home_frame.stats_panel.stop_timers()
        self.home_frame.reset_hud()
        self.home_frame.set_status("Todo listo.", "dim")
        self.show_login()

    # ================== Usuario / vinculación ==================
    def _apply_user_to_home(self) -> None:
        """Pinta el usuario en la home y muestra esa pantalla."""
        if self.user is None:
            return
        self.home_frame.set_user(self.user)
        self._update_play_as()
        self._update_stats_panel_state()
        self.show_home()

    def _update_play_as(self) -> None:
        """Refresca 'Jugando como: <nick>' — siempre visible (obligatorio)."""
        name = str((self.user or {}).get("displayName") or "")
        self.home_frame.set_play_as(name)

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
            panel.set_values(data.get("player") or {}, data.get("rank"), last_server)
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
    def start_play(self) -> None:
        """Arranca el flujo JUGAR en un hilo de fondo."""
        if self.flow is not None:
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

        self.flow = GameFlow(
            self.api,
            self.token,
            self.cfg.game_path,
            server["address"],
            self._on_flow_event,
            already_linked=linked,
            simulate=self.cfg.simulate_game,
            poll_interval=self.cfg.link_poll_interval,
            poll_max_seconds=self.cfg.link_poll_max_seconds,
            display_name=display_name,
            cloud_save=self.cfg.cloud_save,
            game_dir=os.path.dirname(self.cfg.game_path) if self.cfg.game_path else "",
        )
        threading.Thread(target=self.flow.run, daemon=True, name="game-flow").start()

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
            home.set_deployed()  # strip ● EN PARTIDA
            self.flow = None

        elif kind == "failed":
            msg = str(event.get("msg", ""))
            home.log_line(f"✘ {msg}")
            home.set_status(msg, "error")
            if event.get("retry"):
                home.set_retry()  # el botón grande pasa a REINTENTAR
            else:
                home.set_playing(False)
            self.flow = None

    # ================== Cierre ==================
    def _on_close(self) -> None:
        log.info("Cerrando launcher")
        if self.flow is not None:
            self.flow.cancel()
        self._cancel_stats_timer()
        self.home_frame.stats_panel.stop_timers()
        self.home_frame.stop_animations()
        self.destroy()
