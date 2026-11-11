"""Pantalla principal (logueado): cabecera HUD, server, JUGAR héroe, consola.

El botón JUGAR es el protagonista: bloque ámbar grande con strip de estado
(● LISTO → ● CONECTANDO → ● EN PARTIDA / ● FALLO). La consola mini vive en
una barra inferior tipo terminal, con la línea de créditos META en su
cabecera (franja inferior del home).

El MISMO botón hace de JUGAR ⇄ DETENER según el proceso del juego: sin
juego vivo es JUGAR (ámbar); con el juego que este launcher abrió sigue
vivo pasa a DETENER (rojo danger del tema) y al pulsarlo detiene el árbol
del juego y ejecuta el flujo post-sesión (upload del save) SIN cerrar el
launcher. Durante la conexión: CONECTANDO… ; durante la detención:
DETENIENDO… (ambos deshabilitados de verdad).
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Dict, List, Optional

import customtkinter as ctk

from api_client import user_is_linked
import server_status  # llamado vía módulo: el stub de tests parchea el attr
from server_status import (
    SOURCE_API,
    STATE_CHECKING,
    STATE_UNKNOWN,
    ServerStatus,
    format_status_text,
    match_sala,
    probe_server,
    sala_dropdown_label,
    sala_to_status,
    split_address,
    status_color_key,
)
from ui.hud import (
    DotState,
    bind_flat_focus,
    bind_focus_hairline,
    bind_ghost_focus,
    ghost_button,
    hairline,
    section_label,
    set_button_busy,
    set_button_idle,
    status_chip,
)
from ui.stats_panel import StatsPanel
from ui.theme import (COLORS, RADIUS, SP, credits_compact, font, section_text)

if TYPE_CHECKING:
    from ui.main_window import App

log = logging.getLogger("ui.home")

TEXT_LISTO = "JUGAR"
TEXT_CONECTANDO = "CONECTANDO…"
TEXT_REINTENTAR = "REINTENTAR"
TEXT_DETENER = "DETENER"
TEXT_DETENIENDO = "DETENIENDO…"


class HomeFrame(ctk.CTkFrame):
    """Vista del jugador: operador, server, stats y despliegue."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app
        self._servers: List[Dict[str, str]] = []
        self._server_labels: Dict[str, int] = {}  # texto mostrado → índice

        # =================== Cabecera (banda elevada) ===================
        header = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=0)
        header.pack(fill="x")

        left = ctk.CTkFrame(header, fg_color="transparent")
        left.pack(side="left", padx=SP["xl"], pady=SP["m"])
        section_label(left, "OPERADOR").pack(anchor="w")
        self.user_label = ctk.CTkLabel(
            left, text="—", font=font(18, "bold"), text_color=COLORS["text"],
            anchor="w",
        )
        self.user_label.pack(anchor="w")
        self.email_label = ctk.CTkLabel(
            left, text="", font=font(10), text_color=COLORS["text_faint"],
            anchor="w",
        )
        self.email_label.pack(anchor="w")

        right = ctk.CTkFrame(header, fg_color="transparent")
        right.pack(side="right", padx=SP["l"], pady=SP["m"])
        self.badge = status_chip(header, "  …  ", kind="accent")
        self.badge.configure(corner_radius=RADIUS["btn"])
        self.badge.pack(side="right", padx=(SP["s"], SP["xl"]), pady=SP["m"])
        self.settings_btn = ghost_button(right, "AJUSTES", self.app.show_settings,
                                         width=92)
        self.settings_btn.pack(side="left", padx=SP["xs"])
        bind_ghost_focus(self.settings_btn)
        # Web del ranking en el navegador (fantasma, mono, sin color nuevo:
        # el ámbar sigue siendo exclusivo del héroe). Entre AJUSTES y
        # CERRAR SESIÓN; oculto si el config trae web_url vacía.
        self.web_btn = ghost_button(right, "WEB ↗", self.app.open_web, width=78)
        self.web_btn.configure(font=font(11, "bold", mono=True))
        if self.app.cfg.web_url:
            self.web_btn.pack(side="left", padx=SP["xs"],
                              after=self.settings_btn)
        bind_ghost_focus(self.web_btn)
        self.logout_btn = ghost_button(right, "CERRAR SESIÓN", self.app.logout,
                                       width=124)
        self.logout_btn.pack(side="left", padx=SP["s"])
        bind_ghost_focus(self.logout_btn)
        hairline(self).pack(fill="x")

        # =================== Cuerpo ===================
        body = ctk.CTkFrame(self, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=SP["xl"], pady=(SP["l"], SP["m"]))

        # Selector de server + estado + strip HUD.
        row = ctk.CTkFrame(body, fg_color="transparent")
        row.pack(fill="x")
        ctk.CTkLabel(
            row, text=section_text("SERVIDOR"), font=font(10, "bold", mono=True),
            text_color=COLORS["text_dim"],
        ).pack(side="left")
        self.server_menu = ctk.CTkOptionMenu(
            row, width=270, height=32, font=font(12),
            fg_color=COLORS["panel2"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hover"],
            text_color=COLORS["text"], dropdown_fg_color=COLORS["panel"],
            dropdown_hover_color=COLORS["panel2"], corner_radius=RADIUS["input"],
            command=self._on_server_change,
        )
        self.server_menu.pack(side="left", padx=SP["m"])
        # Estado REAL del server SELECCIONADO (pedido del dueño): dot de
        # color + caption dim junto al dropdown — `● ONLINE · 6 jugadores`.
        # El dropdown es una OptionMenu (otro modelo que las filas de
        # Ajustes), así el estado en vivo vive AL LADO, no dentro.
        self.server_dot = ctk.CTkLabel(
            row, text="", font=font(11, "bold", mono=True),
            text_color=COLORS["text_faint"],
        )
        self.server_dot.pack(side="left")
        self.server_state = ctk.CTkLabel(
            row, text="", font=font(10, "bold", mono=True),
            text_color=COLORS["text_faint"], anchor="w",
        )
        self.server_state.pack(side="left", padx=(SP["xs"], 0))
        self.status = ctk.CTkLabel(
            row, text="Todo listo.", font=font(12, "bold"),
            text_color=COLORS["text_dim"], anchor="e",
        )
        self.status.pack(side="right", padx=(SP["m"], 0))
        self.hud_state = DotState(row, "listo")
        self.hud_state.pack(side="right")

        # Identidad con la que se jugará (nick del ranking forzado en el juego).
        self.play_as = ctk.CTkLabel(
            body, text="", font=font(11), text_color=COLORS["text_dim"],
            anchor="w",
        )
        self.play_as.pack(fill="x", pady=(SP["s"], 0))

        # Panel de estadísticas en vivo (rank/kills/etc.), refrescado por App.
        self.stats_panel = StatsPanel(
            body, on_manual_refresh=self.app.refresh_stats_manual
        )
        self.stats_panel.pack(fill="x", pady=(SP["m"], 0))

        # --- Botón héroe JUGAR/DETENER (bloque ámbar, esquinas afiladas) ------
        # El comando SIEMPRE pasa por App.on_hero_button: es el único handler
        # y decide JUGAR o DETENER consultando game_running() del flujo vivo.
        self.play_btn = ctk.CTkButton(
            body, text=TEXT_LISTO, height=64, font=font(26, "bold"),
            fg_color=COLORS["accent"], hover_color=COLORS["accent_hover"],
            text_color=COLORS["on_accent"], corner_radius=RADIUS["btn"],
            text_color_disabled=COLORS["text_faint"],
            command=self.app.on_hero_button,
        )
        self.play_btn.pack(fill="x", pady=(SP["m"], 0), ipady=2)
        bind_flat_focus(self.play_btn)

        # =================== Consola (barra inferior terminal) ============
        hairline(self).pack(fill="x")
        console_card = ctk.CTkFrame(self, fg_color=COLORS["console"],
                                    corner_radius=0)
        console_card.pack(fill="both", expand=True)
        head = ctk.CTkFrame(console_card, fg_color="transparent")
        head.pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))
        ctk.CTkLabel(
            head, text=section_text("REGISTRO DE ACTIVIDAD"),
            font=font(10, "bold", mono=True), text_color=COLORS["text_faint"],
            anchor="w",
        ).pack(side="left")
        # Créditos META (única fuente: ui/theme.py) en la franja inferior:
        # caption dim mono pequeño — copy EXACTO (credits_compact) que
        # comparte fila con el título del registro, ADEMÁS recortado con
        # '…' medido al ancho real (font.measure) en _fit_credits: nunca se
        # corta feo por el borde derecho (bug del dueño con screenshot).
        self._activity_label = head.winfo_children()[-1]
        self._credits_text = credits_compact()
        self._credits_font = font(9, "bold", mono=True)
        self.credits_label = ctk.CTkLabel(
            head, text=self._credits_text, font=self._credits_font,
            text_color=COLORS["text_faint"], anchor="e",
        )
        self.credits_label.pack(side="right")
        head.bind("<Configure>", lambda _e: self._fit_credits())
        self._fit_credits()
        self.console = ctk.CTkTextbox(
            console_card, font=font(11, mono=True), fg_color=COLORS["console"],
            text_color=COLORS["text_dim"], wrap="word", height=170,
        )
        self.console.pack(fill="both", expand=True, padx=SP["l"],
                         pady=(SP["xs"], SP["m"]))
        self.console.configure(state="disabled")

    # --- Créditos de la franja inferior: recorte medido con '…' -----------
    def _fit_credits(self) -> None:
        """Recorta los créditos META con '…' al ancho REAL de la franja.

        Comparten fila con el título REGISTRO DE ACTIVIDAD (label izquierdo):
        se mide con font.measure el copy completo y, si no cabe, se busca el
        prefijo más largo que quepa añadiendo '…'. Nunca se corta feo por el
        borde derecho (bug del dueño con screenshot). El evento <Configure>
        de la cabecera re-dispara el cálculo al redimensionar.
        """
        head = self.credits_label.master
        head_w = head.winfo_width()
        if head_w <= 1:
            # Aún sin mapear (primer build del frame): winfo_width no dice
            # nada útil; el <Configure> al mostrarse vuelve a llamar esto.
            return
        activity_w = max(1, self._activity_label.winfo_reqwidth())
        avail = head_w - activity_w - SP["m"]
        text = self._credits_text
        if self._credits_font.measure(text) <= avail:
            self.credits_label.configure(text=text)
            return
        # Mayor prefijo que quepa con '…' (búsqueda binaria sobre el copy).
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._credits_font.measure(text[:mid] + "…") <= avail:
                lo = mid
            else:
                hi = mid - 1
        self.credits_label.configure(
            text=(text[:lo].rstrip() + "…") if lo else "…")

    # --- Datos y estado ---------------------------------------------------
    def set_user(self, user: Dict) -> None:
        """Refresca cabecera y badge según el usuario (con GUID o sin él)."""
        self.user_label.configure(text=str(user.get("displayName") or "—"))
        self.email_label.configure(text=str(user.get("email") or ""))
        linked = user_is_linked(user)
        if linked:
            # GUID a mostrar: primero de la lista actual (multi-GUID),
            # con fallback al campo legacy por si el backend cambia.
            links = user.get("linkedGuids") or []
            guid = (
                str(links[0].get("guid"))
                if links and links[0].get("guid")
                else str(user.get("linkedGuid") or user.get("guid") or "")
            )
            self.badge.configure(
                text=f"  VERIFICADO · {guid}  ",
                fg_color=COLORS["ok_dim"], text_color=COLORS["ok"],
            )
        else:
            self.badge.configure(
                text="  SIN IDENTIDAD  ",
                fg_color=COLORS["accent_subtle"], text_color=COLORS["accent"],
            )

    def set_servers(self, servers: List[Dict[str, str]], default_index: int) -> None:
        """Carga el dropdown de servers desde la configuración."""
        self._servers = servers
        self._server_labels = {
            f"{s['name']}  ({s['address']})": i for i, s in enumerate(servers)
        }
        labels = list(self._server_labels.keys())
        self.server_menu.configure(values=labels)
        idx = min(max(default_index, 0), len(labels) - 1) if labels else 0
        if labels:
            self.server_menu.set(labels[idx])
        self.refresh_selected_server_status()
        self._ensure_status_tick()

    def selected_server(self) -> Optional[Dict[str, str]]:
        """Devuelve el server elegido (dict) o None si la config está vacía."""
        label = self.server_menu.get()
        idx = self._server_labels.get(label)
        if idx is None or idx >= len(self._servers):
            return None
        return self._servers[idx]

    def _on_server_change(self, _label: str) -> None:
        self.log_line(f"Server seleccionado: {self.selected_server()}")
        self.refresh_selected_server_status()

    # --- Estado REAL del server seleccionado (disponibilidad en vivo) --------
    def refresh_selected_server_status(self) -> None:
        """Verifica en hilos de fondo la sala elegida (FUENTE: /api/salas).

        El backend (en el LXC, junto a las salas) reporta por RCON el estado
        real; el server se matchea por address. Con el API caído/vacío →
        FALLBACK al chequeo directo TCP+getstatus del server seleccionado.
        Cuando el API SÍ responde, además decora el dropdown con las salas
        offline ('● Sala 1 — OFFLINE', solo informativo: JUGAR jamás se
        bloquea). Nunca bloquea la UI: todo por ``App.run_bg`` + contador de
        generación para descartar resultados rancios.
        """
        server = self.selected_server()
        address = str((server or {}).get("address") or "")
        if split_address(address) is None:
            self._paint_selected_status(None)
            return
        self._paint_selected_status(ServerStatus(state=STATE_CHECKING))
        self._live_gen = getattr(self, "_live_gen", 0) + 1
        gen = self._live_gen
        self.app.run_bg(
            lambda: server_status.fetch_salas(self.app.cfg.api_url),
            on_ok=lambda salas: self._apply_live_salas(salas, gen, address),
        )

    def _apply_live_salas(self, salas: List[Dict[str, str]], gen: int,
                          address: str) -> None:
        """Respuesta de /api/salas en la cola de UI (o fallback TCP)."""
        if gen != getattr(self, "_live_gen", 0):
            return
        if salas:
            sala = match_sala(salas, address)
            status = sala_to_status(sala) \
                if sala is not None \
                else ServerStatus(state=STATE_UNKNOWN, source=SOURCE_API)
            self._paint_selected_status(status)
            # Dropdown: decorar las salas OFFLINE confirmadas por el API.
            self._apply_dropdown_labels(salas)
            return
        # FALLBACK (API caída / configured:false / salas vacías): TCP directo
        # del seleccionado; el dropdown NO se decora (TCP es señal débil).
        self.app.run_bg(
            lambda: probe_server(address),
            on_ok=lambda result: self._apply_selected_probe(gen, result),
        )

    def _apply_selected_probe(self, gen: int,
                              result: Optional[ServerStatus]) -> None:
        """Resultado del probe TCP de fallback en la cola de UI."""
        if gen != getattr(self, "_live_gen", 0):
            return
        self._paint_selected_status(result)

    def _apply_dropdown_labels(self, salas: List[Dict[str, str]]) -> None:
        """Re-etiqueta el dropdown con las salas offline (MISMO server fijado).

        Solo decora offline CONFIRMADO por el API (RCON). El server
        seleccionado se conserva (label equivalente a su índice): cambiar la
        selección del jugador con cada refresh sería un bug.
        """
        if not self._servers:
            return
        current_idx = self._server_labels.get(self.server_menu.get())
        labels: Dict[str, int] = {}
        for i, s in enumerate(self._servers):
            sala = match_sala(salas, str(s.get("address") or ""))
            status = sala_to_status(sala) if sala is not None else None
            label = sala_dropdown_label(str(s.get("name") or ""),
                                        str(s.get("address") or ""), status)
            labels[label] = i
        self._server_labels = labels
        self.server_menu.configure(values=list(labels.keys()))
        if current_idx is not None and 0 <= current_idx < len(self._servers):
            for label, idx in labels.items():
                if idx == current_idx:
                    self.server_menu.set(label)
                    break

    def _paint_selected_status(self, status: Optional[ServerStatus]) -> None:
        try:
            self.server_dot.configure(
                text="" if status is None else "●",
                # 'dim' no existe como clave de COLORS: es el gris apagado
                # de los metadatos (text_faint). .get defensivo para que un
                # OFFLINE/DESCONOCIDO no tumbe el callback de UI (KeyError).
                text_color=COLORS.get(status_color_key(status),
                                      COLORS["text_faint"]),
            )
            self.server_state.configure(
                text=format_status_text(status),
                text_color=COLORS["text_dim"] if status is not None
                else COLORS["text_faint"],
            )
        except Exception:  # frame destruido (logout/cierre): no importa
            pass

    def _ensure_status_tick(self) -> None:
        """Refresco periódico (30 s, SOLO con la HOME visible). Un solo after."""
        if getattr(self, "_status_after", None) is None:
            self._schedule_status_tick()

    def _schedule_status_tick(self) -> None:
        try:
            self._status_after = self.after(30_000, self._status_tick)
        except Exception:  # frame destruido: no rearmar
            self._status_after = None

    def _status_tick(self) -> None:
        self._status_after = None
        try:
            alive = self.winfo_exists()
        except Exception:
            alive = False
        if alive:
            if self.app.current_frame is self:
                self.refresh_selected_server_status()
            self._schedule_status_tick()

    def destroy(self) -> None:
        """Cancela el tick del estado (mismo patrón que StatsPanel)."""
        if getattr(self, "_status_after", None) is not None:
            try:
                self.after_cancel(self._status_after)
            except Exception:
                pass
            self._status_after = None
        super().destroy()

    def set_play_as(self, display_name: str) -> None:
        """Línea 'Jugando como: <nick>' — SIEMPRE visible (nick obligatorio)."""
        if (display_name or "").strip():
            self.play_as.configure(text=f"Jugando como: {display_name.strip()}")
        else:
            self.play_as.configure(text="")

    def set_status(self, text: str, kind: str = "dim") -> None:
        """Texto de estado junto al selector (dim/ok/warn/error)."""
        color = {
            "dim": COLORS["text_dim"], "ok": COLORS["ok"],
            "warn": COLORS["accent"], "error": COLORS["danger"],
        }.get(kind, COLORS["text_dim"])
        self.status.configure(text=text, text_color=color)

    # --- Estados del botón héroe (JUGAR ⇄ DETENER) -------------------------
    def _hero_idle(self, text: str) -> None:
        """Héroe en reposo ámbar (JUGAR/REINTENTAR): colores originales desde
        ``_hud_rest`` + anillo de foco de la familia ámbar. Si el botón aún
        no pasó por CONECTANDO (sin ``_hud_rest``), el ámbar se aplica
        explícito — DETENER nunca deja teñido el reposo."""
        if not hasattr(self.play_btn, "_hud_rest"):
            self.play_btn.configure(
                fg_color=COLORS["accent"], hover_color=COLORS["accent_hover"],
                text_color=COLORS["on_accent"],
            )
        set_button_idle(self.play_btn, text)
        bind_focus_hairline(self.play_btn, COLORS["accent"],
                            COLORS["accent_border"], (0, 1))

    def _set_hero_danger(self, text: str, enabled: bool) -> None:
        """Viste el héroe con la familia danger (#D2544A del tema).

        NO toca ``_hud_rest`` (lo guarda set_button_busy): al volver al reposo,
        ``_hero_idle`` restaura el ámbar original exacto.
        """
        if enabled:
            self.play_btn.configure(
                state="normal", text=text,
                fg_color=COLORS["danger"], hover_color=COLORS["danger_hover"],
                text_color=COLORS["text"],
            )
            bind_focus_hairline(self.play_btn, COLORS["danger"],
                                COLORS["accent_border"], (0, 1))
        else:
            # En vuelo: atenuado sobre el fondo sutil de SU familia.
            self.play_btn.configure(
                state="disabled", text=text,
                fg_color=COLORS["danger_dim"], hover_color=COLORS["danger_dim"],
                text_color_disabled=COLORS["text_faint"],
            )

    def set_playing(self, playing: bool) -> None:
        """Estados del héroe: CONECTANDO (dim, no clickable) / JUGAR (fin)."""
        if playing:
            set_button_busy(self.play_btn, TEXT_CONECTANDO)
            self.hud_state.set_state("conectando")
        else:
            self._hero_idle(TEXT_LISTO)
            self.hud_state.set_state("listo")

    def set_stoppable(self) -> None:
        """Juego vivo (lanzado por este launcher): el héroe pasa a DETENER."""
        self._set_hero_danger(TEXT_DETENER, enabled=True)
        self.hud_state.set_state("en_partida")

    def set_deteniendo(self) -> None:
        """Detención en vuelo: DETENIENDO… deshabilitado de verdad."""
        self._set_hero_danger(TEXT_DETENIENDO, enabled=False)
        self.hud_state.set_state("deteniendo")

    def set_deployed(self) -> None:
        """Éxito de lanzamiento sin proceso (simulación): JUGAR + EN PARTIDA."""
        self._hero_idle(TEXT_LISTO)
        self.hud_state.set_state("en_partida")

    def set_retry(self) -> None:
        """Tras un fallo con reintento: REINTENTAR + strip rojo."""
        self._hero_idle(TEXT_REINTENTAR)
        self.hud_state.set_state("fallo")

    def reset_hud(self) -> None:
        """Vuelve al estado JUGAR (logout)."""
        self._hero_idle(TEXT_LISTO)
        self.hud_state.set_state("listo")

    def stop_animations(self) -> None:
        """Cancela animaciones del strip (logout/cierre)."""
        self.hud_state.stop()

    def log_line(self, text: str) -> None:
        """Añade una línea con timestamp a la consola mini (hilo principal)."""
        stamp = time.strftime("%H:%M:%S")
        self.console.configure(state="normal")
        self.console.insert("end", f"[{stamp}] {text}\n")
        self.console.see("end")
        self.console.configure(state="disabled")
