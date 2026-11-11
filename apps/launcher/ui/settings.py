"""Pantalla de ajustes: API/WEB URL, servers de juego editables, game_path.

Visual: bloques de sección '// CONEXIÓN //', '// JUEGO //' y
'// SERVERS DE JUEGO //' con hairlines; acción única ámbar (GUARDAR).

COMPACTO/SCROLL (mismo patrón que el LOGIN): el contenido vive en un
Canvas+Scrollbar (rueda del ratón) para pantallas bajas, y las ACCIONES
(‹ VOLVER · PROBAR CONEXIÓN API · GUARDAR) viven en un PIE FIJO fuera del
scroll — GUARDAR es SIEMPRE visible sin maximizar, aunque la lista de
servers crezca.

CONEXIÓN: API URL (normalizada al guardar, PROBAR sigue igual) y WEB URL
(el launcher la abre en el navegador con ABRIR; vacía = derivada del
api_url: mismo host, puerto 4173).

SERVERS DE JUEGO: lista EDITABLE completa — cada fila es nombre+dirección
con USAR (default_server, el que usa JUGAR) y BORRAR; AÑADIR agrega una
fila. La validación es pura (app_config.sanitize_servers): dirección
'host:puerto' con puerto 1024-65535, nombre vacío → 'Server N'; una fila
nunca rellenada se descarta; dirección rota → error visible y no se guarda
nada. Todo persiste con el GUARDAR existente (launcher.config.json) y lo
que aplica en caliente sigue aplicando (cliente API + dropdown de home).

SESIÓN (cyber-café): checkbox "Mantener mi sesión abierta al cerrar el
launcher" (remember_session, default DESMARCADO) — desmarcado, al cerrar
se borra el token y la próxima apertura pide LOGIN.

CLASES AL PERFIL WEB: checkbox "Exportar mis clases al perfil web (se
genera al arrancar el juego)" (export_classes, default MARCADO) — el
launcher inyecta +dumpPlayerData al abrir el juego y al cerrarlo sube el
dump del console_mp.log del cliente a la API (sin pasos manuales).
"""
from __future__ import annotations

import logging
import tkinter as tk
import webbrowser
from tkinter import filedialog
from typing import TYPE_CHECKING, Any, Dict, List, Optional

import customtkinter as ctk

import server_status  # llamado vía módulo: el stub de tests parchea el attr
from api_client import NetworkError
from app_config import (
    default_server_after_delete,
    normalize_api_url,
    sanitize_servers,
)
from server_status import (
    SOURCE_API,
    STATE_CHECKING,
    STATE_UNKNOWN,
    ServerStatus,
    format_status_text,
    match_sala,
    probe_server,
    sala_to_status,
    split_address,
    status_color_key,
)
from ui.hud import (
    bind_flat_focus,
    bind_focus_hairline,
    bind_ghost_focus,
    ghost_button,
    hairline,
    primary_button,
    section_label,
    set_button_busy,
    set_button_idle,
)
from ui.theme import COLORS, RADIUS, SP, font, section_text

if TYPE_CHECKING:
    from ui.main_window import App

log = logging.getLogger("ui.settings")


def _entry(parent, width: int = 420) -> ctk.CTkEntry:
    return ctk.CTkEntry(
        parent, width=width, height=34, font=font(12),
        fg_color=COLORS["panel2"], border_color=COLORS["border"],
        text_color=COLORS["text"], corner_radius=RADIUS["input"],
    )


def _caption(parent, text: str) -> ctk.CTkLabel:
    return ctk.CTkLabel(
        parent, text=text, font=font(9, "bold", mono=True),
        text_color=COLORS["text_dim"], anchor="w",
    )


def _hint(parent, text: str) -> ctk.CTkLabel:
    """Nota dim bajo un campo: formato esperado / comportamiento."""
    return ctk.CTkLabel(
        parent, text=text, font=font(10), text_color=COLORS["text_faint"],
        anchor="w", justify="left", wraplength=560,
    )


class SettingsFrame(ctk.CTkFrame):
    """Edición de la configuración local (launcher.config.json)."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app
        self._busy = False  # guardado en curso (anti doble-submit)

        ctk.CTkLabel(
            self, text=section_text("AJUSTES"), font=font(20, "bold", mono=True),
            text_color=COLORS["text"], anchor="w",
        ).pack(fill="x", padx=SP["xl"], pady=(SP["xl"], SP["s"]))
        hairline(self, COLORS["accent_border"]).pack(
            fill="x", padx=SP["xl"], pady=(0, SP["l"])
        )

        # --- Área de contenido con scroll (mismo patrón que el LOGIN) --------
        # Normalmente cabe en 980x640; con la lista de servers crecida (o en
        # 760x500) aparece la Scrollbar y la rueda hace scroll. Las ACCIONES
        # (GUARDAR) NO viven aquí: pie fijo abajo, siempre visible.
        self._canvas = tk.Canvas(
            self, bg=COLORS["bg"], highlightthickness=0, bd=0,
        )
        self._vbar = ctk.CTkScrollbar(self, command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=self._vbar.set)
        self._scroll_inner = ctk.CTkFrame(self._canvas, fg_color="transparent")
        self._canvas_window = self._canvas.create_window(
            (0, 0), window=self._scroll_inner, anchor="nw",
        )
        self._scroll_inner.bind("<Configure>", lambda _e: self._sync_scroll())
        self._canvas.bind("<Configure>", lambda _e: self._sync_scroll())
        # Rueda del ratón (bind_all con guard, como el login: solo actúa con
        # AJUSTES en pantalla y solo si hace falta scrollear).
        self._canvas.bind_all("<MouseWheel>", self._on_wheel, add="+")
        self._scroll_active = False

        card = ctk.CTkFrame(self._scroll_inner, fg_color=COLORS["panel"],
                            corner_radius=RADIUS["card"])
        card.pack(padx=SP["xl"], pady=SP["s"], fill="both", expand=True)
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=SP["l"], pady=SP["m"])

        # --- Conexión ------------------------------------------------------
        section_label(inner, "CONEXIÓN").pack(fill="x", pady=(0, SP["s"]))
        _caption(inner, "DIRECCIÓN DE LA API").pack(fill="x")
        self.api_url = _entry(inner)
        self.api_url.pack(fill="x", pady=(2, 0))
        _hint(inner, "URL de la API del ranking — ej. http://192.168.2.251:3000"
              ).pack(fill="x", pady=(0, SP["m"]))

        _caption(inner, "WEB URL").pack(fill="x")
        web_row = ctk.CTkFrame(inner, fg_color="transparent")
        web_row.pack(fill="x", pady=(2, 0))
        self.web_url = _entry(web_row)
        self.web_url.pack(side="left", fill="x", expand=True)
        self.web_open_btn = ghost_button(web_row, "ABRIR", self._open_web,
                                         width=86)
        self.web_open_btn.pack(side="left", padx=(SP["s"], 0))
        bind_ghost_focus(self.web_open_btn)
        self.web_hint = _hint(
            inner, "Web del ranking en tu navegador. "
            "vacío = mismo host que la API, puerto 4173")
        self.web_hint.pack(fill="x", pady=(0, SP["m"]))

        hairline(inner).pack(fill="x", pady=(0, SP["m"]))

        # --- Juego ---------------------------------------------------------
        section_label(inner, "JUEGO").pack(fill="x", pady=(0, SP["s"]))
        _caption(inner, "RUTA DEL JUEGO (IW4X.EXE)").pack(fill="x")
        path_row = ctk.CTkFrame(inner, fg_color="transparent")
        path_row.pack(fill="x", pady=(2, SP["m"]))
        self.game_path = _entry(path_row)
        self.game_path.pack(side="left", fill="x", expand=True)
        ghost_button(path_row, "EXAMINAR…", self._browse_game, width=110).pack(
            side="left", padx=(SP["s"], 0)
        )

        # --- Servers de juego (lista editable completa) ---------------------
        # Cada fila: [nombre][dirección host:puerto][USAR][BORRAR]; USAR fija
        # el default_server (el que usa JUGAR). AÑADIR agrega una fila vacía.
        section_label(inner, "SERVERS DE JUEGO").pack(fill="x", pady=(0, SP["s"]))
        _caption(inner, "NOMBRE Y DIRECCIÓN (HOST:PUERTO)").pack(fill="x")
        self.servers_box = ctk.CTkFrame(inner, fg_color="transparent")
        self.servers_box.pack(fill="x", pady=(2, 0))
        self._server_rows: List[Dict[str, Any]] = []  # filas vivas de la UI
        self._default_row = 0                          # fila en uso (USAR)
        # Estado REAL por sala (pedido del dueño): ● ONLINE/OFFLINE junto a
        # cada fila, verificado en hilos de fondo (jamás bloquea la UI).
        btns_row = ctk.CTkFrame(inner, fg_color="transparent")
        btns_row.pack(fill="x", pady=(SP["xs"], 0))
        self.add_server_btn = ghost_button(
            btns_row, "AÑADIR SERVER", self._add_server_row, width=130)
        self.add_server_btn.pack(side="left")
        bind_ghost_focus(self.add_server_btn)
        self.status_refresh_btn = ghost_button(
            btns_row, "ACTUALIZAR ESTADO", self.refresh_server_status,
            width=150)
        self.status_refresh_btn.pack(side="left", padx=(SP["s"], 0))
        bind_ghost_focus(self.status_refresh_btn)
        self.servers_hint = _hint(
            inner, "host:puerto — ej. 192.168.1.50:28961 (puerto 1024-65535). "
            "El server en uso es el que usa JUGAR. El ● de cada fila es el "
            "estado real de la sala (API del backend por RCON; si el API no "
            "responde, chequeo directo TCP): se verifica al entrar, con "
            "ACTUALIZAR ESTADO y cada 30 s.")
        self.servers_hint.pack(fill="x", pady=(0, SP["m"]))

        # --- Nick obligatorio (nota informativa, no editable) ------------------
        ctk.CTkLabel(
            inner,
            text="El juego siempre usa el nombre de tu cuenta del ranking.",
            font=font(11), text_color=COLORS["text_dim"], anchor="w",
            justify="left", wraplength=520,
        ).pack(fill="x", pady=(0, SP["s"]))
        self.cloud_save_check = ctk.CTkCheckBox(
            inner, text="Sincronizar mi progreso (nivel/armas) con mi cuenta",
            font=font(12), fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"],
            checkmark_color=COLORS["on_accent"], text_color=COLORS["text"],
            border_color=COLORS["border_strong"], corner_radius=2,
        )
        self.cloud_save_check.pack(anchor="w", pady=(0, SP["s"]))

        # --- Exportación de clases al perfil web (dump /dumpPlayerData) ------
        # Default MARCADO (decisión del dueño): al arrancar el juego el
        # launcher inyecta +dumpPlayerData y al cerrarlo sube el dump del
        # console_mp.log del cliente → las 15 clases aparecen en el perfil
        # web sin pasos manuales.
        self.export_classes_check = ctk.CTkCheckBox(
            inner,
            text="Exportar mis clases al perfil web "
                 "(se genera al arrancar el juego)",
            font=font(12), fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"],
            checkmark_color=COLORS["on_accent"], text_color=COLORS["text"],
            border_color=COLORS["border_strong"], corner_radius=2,
        )
        self.export_classes_check.pack(anchor="w", pady=(0, SP["s"]))

        # --- Auto-guardado periódico (evita perder progreso si la PC muere) --
        autosave_row = ctk.CTkFrame(inner, fg_color="transparent")
        autosave_row.pack(fill="x", pady=(0, SP["m"]))
        self.autosave_check = ctk.CTkCheckBox(
            autosave_row, text="Auto-guardar progreso cada",
            font=font(12), fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"],
            checkmark_color=COLORS["on_accent"], text_color=COLORS["text"],
            border_color=COLORS["border_strong"], corner_radius=2,
            command=self._autosave_toggle,
        )
        self.autosave_check.pack(side="left")
        self.autosave_minutes = ctk.CTkEntry(
            autosave_row, width=64, height=30, font=font(12),
            fg_color=COLORS["panel2"], border_color=COLORS["border"],
            text_color=COLORS["text"], corner_radius=RADIUS["input"],
            justify="center",
        )
        self.autosave_minutes.pack(side="left", padx=(SP["s"], 0))
        ctk.CTkLabel(
            autosave_row, text="min (0 = nunca)", font=font(11),
            text_color=COLORS["text_dim"], anchor="w",
        ).pack(side="left", padx=(6, 0))

        # --- Sesión (cyber-café): recordar o no el login al cerrar ------------
        # DESMARCADO (default): al cerrar se borra el token guardado y la
        # próxima apertura pide LOGIN — nadie hereda la sesión de otro.
        self.remember_check = ctk.CTkCheckBox(
            inner, text="Mantener mi sesión abierta al cerrar el launcher",
            font=font(12), fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"],
            checkmark_color=COLORS["on_accent"], text_color=COLORS["text"],
            border_color=COLORS["border_strong"], corner_radius=2,
        )
        self.remember_check.pack(anchor="w", pady=(0, SP["s"]))
        _hint(inner, "Desmarcado (recomendado en PC compartida): al cerrar se "
              "cierra tu sesión y el próximo jugador hace su propio login."
              ).pack(fill="x", pady=(0, SP["m"]))

        # --- Pie FIJO (fuera del scroll): GUARDAR SIEMPRE visible -------------
        # Bug del dueño: GUARDAR quedaba cortado bajo la ventana (la pantalla
        # creció con WEB URL + SERVERS). Las acciones viven en un pie que no
        # scrollea: ‹ VOLVER · PROBAR · resultado · GUARDAR. El pie se POCKEA
        # ANTES que el canvas (side="bottom") para RESERVAR la franja
        # inferior: si el canvas se packea primero, se queda toda la cavidad
        # y el pie acaba recortado/arriba (bug de geometría de pack).
        hairline(self).pack(side="bottom", fill="x", padx=SP["xl"])
        footer = ctk.CTkFrame(self, fg_color="transparent")
        footer.pack(side="bottom", fill="x", padx=SP["xl"], pady=SP["m"])
        self.back_btn = ghost_button(footer, "‹ VOLVER", self.app.show_home,
                                     width=110)
        self.back_btn.pack(side="left")
        bind_ghost_focus(self.back_btn)
        self.test_btn = ghost_button(footer, "PROBAR CONEXIÓN API", self._test_api,
                                     width=170)
        self.test_btn.pack(side="left", padx=(SP["m"], 0))
        bind_ghost_focus(self.test_btn)
        # Resultado del test de conexión / guardado (expande entre ambos).
        self.feedback = ctk.CTkLabel(
            footer, text="", font=font(11), justify="left", wraplength=280,
            text_color=COLORS["text_dim"], anchor="w",
        )
        self.feedback.pack(side="left", fill="x", expand=True,
                           padx=(SP["m"], SP["m"]))
        self.save_btn = primary_button(footer, "GUARDAR", self._save, width=140)
        self.save_btn.pack(side="right")
        bind_flat_focus(self.save_btn)

        # --- Foco de teclado (hairline ámbar) en entradas ---------------------
        # (los botones del pie ya se ligaron al crearlos)
        for entry in (self.api_url, self.web_url, self.game_path,
                      self.autosave_minutes):
            bind_focus_hairline(entry, COLORS["border"], COLORS["accent_border"])

        # El canvas se POCKEA AL FINAL (tras reservar cabecera y pie): llena
        # solo el hueco del medio; la Scrollbar (side="right") puede aparecer
        # después sin robarle espacio al contenido (mismo orden que el LOGIN).
        self._canvas.pack(side="left", fill="both", expand=True)

        # Refresco periódico del estado REAL de servers (30 s SOLO mientras
        # AJUSTES esté en pantalla; el tick corre siempre pero es un guard
        # barato). Mismo patrón after()/cancel que el ticker del StatsPanel.
        self._status_after: Optional[str] = None
        self._schedule_status_tick()

    # --- Estado REAL de servers (disponibilidad por sala) --------------------
    def _schedule_status_tick(self) -> None:
        """Reagenda el tick de 30 s (no acumula: un solo after vivo)."""
        if self._status_after is not None:
            try:
                self.after_cancel(self._status_after)
            except Exception:
                pass
        try:
            self._status_after = self.after(30_000, self._status_tick)
        except Exception:  # pantalla destruida: no rearmar
            self._status_after = None

    def _status_tick(self) -> None:
        """Cada 30 s SOLO con AJUSTES visible: re-verifica la lista."""
        try:
            alive = self.winfo_exists()
        except Exception:
            alive = False
        if alive and self.app.current_frame is self:
            self.refresh_server_status()
        if alive:
            self._schedule_status_tick()

    def refresh_server_status(self) -> None:
        """Verifica el estado REAL de todas las filas (hilos de fondo).

        FUENTE APROBADA: ``GET {api_url}/api/salas`` (RCON real del backend,
        que corre EN el LXC junto a las salas) → match por address. Con
        ``configured:false``, salas vacías o API caída → FALLBACK al chequeo
        directo TCP+getstatus por server. Server no listado por el API →
        DESCONOCIDO (dim, sin inventar). Cada fila pasa a '● verificando…'
        (ámbar) y su resultado llega por ``App.run_bg`` → cola de UI: jamás
        toca el hilo de Tk. Los N servers se verifican EN PARALELO.
        """
        self._status_gen = getattr(self, "_status_gen", 0) + 1
        gen = self._status_gen
        for row in self._server_rows:
            address = str(row["addr"].get() or "").strip()
            if split_address(address) is None:
                # Fila vacía o dirección inválida: sin estado que mostrar.
                self._set_row_status(row, None)
                continue
            self._set_row_status(row, ServerStatus(state=STATE_CHECKING))
        self.app.run_bg(
            lambda: server_status.fetch_salas(self.app.cfg.api_url),
            on_ok=lambda salas: self._apply_salas(salas, gen),
        )

    def _apply_salas(self, salas: List[Dict[str, Any]], gen: int) -> None:
        """Resultado de /api/salas en la cola de UI (o fallback TCP)."""
        if gen != getattr(self, "_status_gen", 0):
            return  # resultado rancio: llegó un refresh más nuevo
        if salas:
            # Fuente aprobada: estado real por RCON, matcheado por address.
            for row in self._server_rows:
                address = str(row["addr"].get() or "").strip()
                if split_address(address) is None:
                    continue
                sala = match_sala(salas, address)
                status = sala_to_status(sala) \
                    if sala is not None \
                    else ServerStatus(state=STATE_UNKNOWN, source=SOURCE_API)
                self._set_row_status(row, status)
            return
        # FALLBACK (API caída / configured:false / salas vacías): TCP directo.
        for row in self._server_rows:
            address = str(row["addr"].get() or "").strip()
            if split_address(address) is None:
                continue
            self.app.run_bg(
                lambda addr=address: probe_server(addr),
                on_ok=lambda result, row=row: self._apply_row_status(row, result),
            )

    def _set_row_status(self, row: Dict[str, Any],
                        status: Optional[ServerStatus]) -> None:
        """Pinta dot + texto de una fila (en el hilo de UI)."""
        self._paint_status(row.get("dot"), row.get("state"), status)

    def _apply_row_status(self, row: Dict[str, Any],
                          result: Optional[ServerStatus]) -> None:
        """Resultado del probe en la cola de UI (tolera filas destruidas)."""
        try:
            if not row["frame"].winfo_exists():
                return
        except Exception:
            return
        self._set_row_status(row, result)

    @staticmethod
    def _paint_status(dot, label, status: Optional[ServerStatus]) -> None:
        """Dot de color + texto dim (● ONLINE · N jugadores / OFFLINE / …)."""
        if dot is None or label is None:
            return
        try:
            if not dot.winfo_exists() or not label.winfo_exists():
                return
            key = status_color_key(status)
            dot.configure(
                text="" if status is None else "●",
                # 'dim' no existe como clave de COLORS (el gris apagado es
                # text_faint): .get defensivo — un KeyError aquí mata el
                # callback de UI y la fila queda clavada en 'verificando…'.
                text_color=COLORS.get(key, COLORS["text_faint"]),
            )
            label.configure(
                text=format_status_text(status),
                text_color=COLORS["text_dim"] if status is not None
                else COLORS["text_faint"],
            )
        except tk.TclError:
            pass  # widget destruido entre post y pintado: no importa

    # --- Ciclo de la pantalla ----------------------------------------------
    def load_from_config(self) -> None:
        """Rellena los campos desde la configuración actual."""
        cfg = self.app.cfg
        self.api_url.delete(0, "end")
        self.api_url.insert(0, cfg.api_url)
        # WEB URL: el valor fijado en el config (si la clave no existe, el
        # campo queda VACÍO = se deriva del api_url: mismo host, puerto 4173).
        self.web_url.delete(0, "end")
        self.web_url.insert(0, str(cfg.data.get("web_url") or ""))
        self.game_path.delete(0, "end")
        self.game_path.insert(0, cfg.game_path)
        self._rebuild_server_rows(cfg.servers, cfg.default_server)
        # Disponibilidad REAL por sala (hilos de fondo, UI libre): al abrir
        # AJUSTES la lista ya viene con su ● ONLINE/OFFLINE/verificando….
        self.refresh_server_status()
        if cfg.cloud_save:
            self.cloud_save_check.select()
        else:
            self.cloud_save_check.deselect()
        # Exportación de clases (dump al perfil web): default MARCADO.
        if cfg.export_classes:
            self.export_classes_check.select()
        else:
            self.export_classes_check.deselect()
        # Auto-guardado: el valor SIEMPRE va al entry (visible aunque sea 0);
        # el checkbox refleja si está activo (>0).
        self.autosave_minutes.delete(0, "end")
        self.autosave_minutes.insert(0, str(cfg.autosave_minutes))
        if cfg.autosave_minutes > 0:
            self.autosave_check.select()
        else:
            self.autosave_check.deselect()
        # Sesión (cyber-café): checkbox DESMARCADO por defecto (borrar token
        # al cerrar); marcado solo si el dueño activó recordar la sesión.
        if cfg.remember_session:
            self.remember_check.select()
        else:
            self.remember_check.deselect()
        self.feedback.configure(text="", text_color=COLORS["text_dim"])
        self.reset_scroll()

    # --- Scroll del contenido (mismo patrón que el LOGIN) ---------------------
    def _sync_scroll(self) -> None:
        """Recalcula scrollregion, ancho del contenido y visibilidad del bar."""
        canvas = self._canvas
        content_h = self._scroll_inner.winfo_reqheight()
        canvas.configure(scrollregion=canvas.bbox("all"))
        canvas.itemconfigure(
            self._canvas_window,
            width=canvas.winfo_width(),
            height=max(content_h, canvas.winfo_height()),
        )
        needs = content_h > canvas.winfo_height() + 1
        if needs and not self._scroll_active:
            self._scroll_active = True
            self._vbar.pack(side="right", fill="y")
        elif not needs and self._scroll_active:
            self._scroll_active = False
            self._vbar.pack_forget()
            canvas.yview_moveto(0)

    def _on_wheel(self, event) -> None:
        """Rueda del ratón sobre AJUSTES (ignorada si no está en pantalla)."""
        if self.app.current_frame is not self or not self._scroll_active:
            return
        step = -3 if event.delta > 0 else 3
        self._canvas.yview_scroll(step, "units")

    def reset_scroll(self) -> None:
        """Vuelve arriba (al entrar en la pantalla)."""
        try:
            self._canvas.yview_moveto(0)
        except Exception:
            pass

    # --- Servers de juego: lista editable -----------------------------------
    def _rebuild_server_rows(self, servers: List[Dict[str, str]],
                             default_index: int) -> None:
        """Redibuja la lista desde la config (cada visita a Ajustes)."""
        for row in self._server_rows:
            row["frame"].destroy()
        self._server_rows = []
        self._default_row = default_index if servers else 0
        for i, s in enumerate(servers):
            self._append_server_row(str(s.get("name") or ""),
                                    str(s.get("address") or ""))
        self._refresh_use_buttons()

    def _append_server_row(self, name: str = "", address: str = "") -> None:
        """Una fila: [nombre][dirección host:puerto][USAR][BORRAR].

        Los botones se ligan a la REFERENCIA de la fila (no a su índice, que
        quedaría rancio tras un borrado); el índice se resuelve al vuelo.
        """
        row_frame = ctk.CTkFrame(self.servers_box, fg_color="transparent")
        row_frame.pack(fill="x", pady=(0, SP["xs"]))
        name_entry = _entry(row_frame, width=200)
        name_entry.configure(placeholder_text="Nombre (ej. LAN)")
        name_entry.pack(side="left", fill="x", expand=True)
        if name:
            name_entry.insert(0, name)
        addr_entry = _entry(row_frame, width=210)
        addr_entry.configure(placeholder_text="192.168.1.50:28961")
        addr_entry.pack(side="left", padx=(SP["s"], 0))
        if address:
            addr_entry.insert(0, address)
        use_btn = ghost_button(row_frame, "USAR", lambda: self._use_row(row),
                               width=84)
        use_btn.pack(side="left", padx=(SP["s"], 0))
        bind_ghost_focus(use_btn)
        del_btn = ghost_button(row_frame, "BORRAR", lambda: self._delete_row(row),
                               width=86)
        del_btn.pack(side="left", padx=(SP["xs"], 0))
        bind_ghost_focus(del_btn)
        bind_focus_hairline(name_entry, COLORS["border"], COLORS["accent_border"])
        bind_focus_hairline(addr_entry, COLORS["border"], COLORS["accent_border"])
        # Estado REAL en vivo (misma fila, al final): dot de color + caption
        # dim — ej. `● ONLINE · 6 jugadores`. Mismo lenguaje HUD que la home.
        dot = ctk.CTkLabel(
            row_frame, text="", font=font(11, "bold", mono=True),
            text_color=COLORS["text_faint"],
        )
        dot.pack(side="left", padx=(SP["m"], 0))
        state_lbl = ctk.CTkLabel(
            row_frame, text="", font=font(10, "bold", mono=True),
            text_color=COLORS["text_faint"], anchor="w",
        )
        state_lbl.pack(side="left", padx=(SP["xs"], 0))
        row: Dict[str, Any] = {
            "frame": row_frame, "name": name_entry, "addr": addr_entry,
            "use_btn": use_btn, "del_btn": del_btn,
            "dot": dot, "state": state_lbl,
        }
        self._server_rows.append(row)

    def _row_index(self, row: Dict[str, Any]) -> int:
        """Posición VIGENTE de la fila (los índices cambian al borrar)."""
        return self._server_rows.index(row)

    def _use_row(self, row: Dict[str, Any]) -> None:
        """USAR: esa fila pasa a ser el default_server (el que usa JUGAR)."""
        self._default_row = self._row_index(row)
        self._refresh_use_buttons()

    def _delete_row(self, row: Dict[str, Any]) -> None:
        """BORRAR: quita la fila; el default recae (puramente) en el primero."""
        index = self._row_index(row)
        row["frame"].destroy()
        self._server_rows.pop(index)
        self._default_row = default_server_after_delete(self._default_row, index)
        self._refresh_use_buttons()

    def _add_server_row(self) -> None:
        """AÑADIR: fila nueva nombre+dirección (vacía, con placeholders)."""
        self._append_server_row()
        self._refresh_use_buttons()

    def _refresh_use_buttons(self) -> None:
        """Estado 'radio' de los USAR: la fila en uso muestra EN USO (off)."""
        for i, row in enumerate(self._server_rows):
            in_use = i == self._default_row
            row["use_btn"].configure(
                text="EN USO" if in_use else "USAR",
                state="disabled" if in_use else "normal",
            )

    def _open_web(self) -> None:
        """ABRIR: la web del ranking en el navegador (lo tecleado normalizado;
        con el campo vacío, la URL efectiva del config —derivada del api_url)."""
        typed = self.web_url.get().strip()
        url = normalize_api_url(typed, default="") if typed \
            else self.app.cfg.web_url
        if not url:
            self.feedback.configure(
                text="Sin WEB URL: escríbela o déjala vacía para usar la "
                     "derivada de la API.", text_color=COLORS["warn"])
            return
        log.info("Abriendo la web del ranking (Ajustes): %s", url)
        webbrowser.open(url)

    # --- Acciones ------------------------------------------------------------
    def _autosave_toggle(self) -> None:
        """Al activar el auto-guardado, sugiere 10 min si el entry está en 0."""
        if self.autosave_check.get() \
                and not self.autosave_minutes.get().strip():
            self.autosave_minutes.delete(0, "end")
            self.autosave_minutes.insert(0, "10")

    def _autosave_minutes_value(self) -> int:
        """Minutos del entry acotados a ≥0 (0 = desactivado)."""
        try:
            return max(0, int(self.autosave_minutes.get().strip() or 0))
        except ValueError:
            return 0

    def _browse_game(self) -> None:
        """Selector de archivo para iw4x.exe."""
        chosen = filedialog.askopenfilename(
            title="Selecciona iw4x.exe",
            filetypes=[("Ejecutable", "*.exe"), ("Todos los archivos", "*.*")],
        )
        if chosen:
            self.game_path.delete(0, "end")
            self.game_path.insert(0, chosen.replace("/", "\\"))

    def _test_api(self) -> None:
        """GET /api/sync/status (público) para verificar conectividad.

        Anti doble-submit: "PROBANDO…" y deshabilitado en vuelo; se restaura
        al terminar (éxito o error).
        """
        base = self.api_url.get().strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            self.feedback.configure(
                text="La dirección debe empezar por http:// o https://",
                text_color=COLORS["warn"],
            )
            return

        set_button_busy(self.test_btn, "PROBANDO…")
        self.feedback.configure(text="Probando conexión…", text_color=COLORS["text_dim"])
        self.app.test_api_connection(base, self._test_ok, self._test_fail)

    def _test_ok(self, info: dict) -> None:
        """Respuesta de /sync/status: mostramos el último sync si existe."""
        set_button_idle(self.test_btn, "PROBAR CONEXIÓN API")
        last = info.get("lastSyncAt")
        extra = (
            f" Último sync: {str(last)[:19].replace('T', ' ')}." if last
            else " Aún sin syncs."
        )
        self.feedback.configure(
            text=f"✔ Conexión OK con la API.{extra}", text_color=COLORS["ok"]
        )
        log.info("Test de API OK: %s", info)

    def _test_fail(self, error: Exception) -> None:
        set_button_idle(self.test_btn, "PROBAR CONEXIÓN API")
        msg = (
            str(error) if isinstance(error, NetworkError)
            else f"La API respondió con error: {getattr(error, 'message', error)}"
        )
        self.feedback.configure(text=f"✘ {msg}", text_color=COLORS["danger"])
        log.info("Test de API falló: %s", msg)

    def _save(self) -> None:
        """Valida, persiste y aplica la configuración.

        Anti doble-submit: "GUARDANDO…" y deshabilitado mientras corre. El
        flujo es síncrono y termina en la home; el estado se restaura SIEMPRE
        (finally) para la próxima visita a Ajustes. Validaciones (API y
        servers) corren ANTES del busy: el error queda visible y el botón ni
        se deshabilita.
        """
        if self._busy:
            return
        cfg = self.app.cfg
        base = self.api_url.get().strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            self.feedback.configure(
                text="Dirección de API no válida (debe empezar por http:// o https://)",
                text_color=COLORS["warn"],
            )
            return

        # SERVERS: validación PURA de la lista editable (dirección
        # host:puerto con puerto 1024-65535; nombre vacío → 'Server N'; una
        # fila nunca rellenada se descarta). Error visible → no se guarda.
        rows = [{"name": r["name"].get(), "address": r["addr"].get()}
                for r in self._server_rows]
        try:
            servers, default_idx = sanitize_servers(rows, self._default_row)
        except ValueError as exc:
            self.feedback.configure(text=f"✘ {exc}", text_color=COLORS["warn"])
            return

        self._busy = True
        set_button_busy(self.save_btn, "GUARDANDO…")
        try:
            # WEB URL: normalizada al guardar; VACÍA → se QUITA la clave para
            # que siga derivándose del api_url (mismo host, puerto 4173) y
            # los enlaces WEB no se oculten.
            web_typed = self.web_url.get().strip()
            if web_typed:
                web = normalize_api_url(web_typed, default="")
                if not web:
                    self.feedback.configure(
                        text="WEB URL no válida (ej. http://192.168.2.251:4173)",
                        text_color=COLORS["warn"],
                    )
                    return
                cfg.set("web_url", web)
            else:
                cfg.data.pop("web_url", None)

            cfg.set("api_url", base)
            cfg.set("game_path", self.game_path.get().strip())
            cfg.set("servers", servers)
            cfg.set("default_server", default_idx)
            cfg.set("cloud_save", bool(self.cloud_save_check.get()))
            # Exportación de clases al perfil web (+dumpPlayerData → dump →
            # POST /players/classes): marcado por defecto.
            cfg.set("export_classes", bool(self.export_classes_check.get()))
            # Auto-guardado: solo cuenta si el checkbox está activo; el valor es
            # entero ≥0 (0 = desactivado). Basura en el entry → 0 (sin crash).
            autosave_minutes = self._autosave_minutes_value()
            if not self.autosave_check.get():
                autosave_minutes = 0
            cfg.set("autosave_minutes", autosave_minutes)
            # Sesión: recordar o no el login al cerrar (default DESMARCADO =
            # cerrar cierra la sesión; el próximo arranque pide LOGIN).
            cfg.set("remember_session", bool(self.remember_check.get()))
            cfg.save()

            # Aplicar en caliente: nuevo cliente con la URL actualizada y el
            # dropdown de la home preseleccionando el server en uso (JUGAR
            # lee de ahí: cambiarlo aquí cambia el +connect real).
            self.app.apply_api_url(base)
            self.app.refresh_home_servers()
            self.feedback.configure(text="✔ Ajustes guardados.", text_color=COLORS["ok"])
            log.info("Ajustes guardados: api_url=%s web_url=%s servers=%d "
                     "default_server=%s autosave_minutes=%s", base,
                     cfg.data.get("web_url") or "(derivada)", len(servers),
                     default_idx, autosave_minutes)
            self.app.show_home()
        finally:
            self._busy = False
            set_button_idle(self.save_btn, "GUARDAR")

    def destroy(self) -> None:
        """Cancela el tick del estado de servers (mismo patrón que StatsPanel)."""
        if getattr(self, "_status_after", None) is not None:
            try:
                self.after_cancel(self._status_after)
            except Exception:
                pass
            self._status_after = None
        super().destroy()
