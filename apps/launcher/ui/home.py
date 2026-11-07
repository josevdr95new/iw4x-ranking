"""Pantalla principal (logueado): cabecera, server, JUGAR, consola mini."""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Dict, List, Optional

import customtkinter as ctk

from api_client import user_is_linked
from ui.theme import COLORS, font

if TYPE_CHECKING:
    from ui.main_window import App

log = logging.getLogger("ui.home")


class HomeFrame(ctk.CTkFrame):
    """Vista del jugador: estado de vinculación, server y botón JUGAR."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app
        self._servers: List[Dict[str, str]] = []
        self._server_labels: Dict[str, int] = {}  # texto mostrado → índice

        # =================== Cabecera ===================
        header = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=0)
        header.pack(fill="x")

        left = ctk.CTkFrame(header, fg_color="transparent")
        left.pack(side="left", padx=20, pady=12)
        self.user_label = ctk.CTkLabel(
            left, text="—", font=font(17, "bold"), text_color=COLORS["text"]
        )
        self.user_label.pack(anchor="w")
        self.email_label = ctk.CTkLabel(
            left, text="", font=font(11), text_color=COLORS["text_dim"]
        )
        self.email_label.pack(anchor="w")

        # Badge de vinculación (VERIFICADO / SIN VINCULAR).
        self.badge = ctk.CTkLabel(
            header, text="  …  ", font=font(11, "bold"), text_color="#ffffff",
            fg_color=COLORS["warn"], corner_radius=8,
        )
        self.badge.pack(side="right", padx=(10, 20), pady=16)

        right = ctk.CTkFrame(header, fg_color="transparent")
        right.pack(side="right", padx=0, pady=12)
        ctk.CTkButton(
            right, text="⚙ Ajustes", width=90, height=30, font=font(12),
            fg_color=COLORS["panel2"], hover_color=COLORS["bg"],
            text_color=COLORS["text"], command=self.app.show_settings,
        ).pack(side="left", padx=4)
        ctk.CTkButton(
            right, text="Cerrar sesión", width=110, height=30, font=font(12),
            fg_color=COLORS["panel2"], hover_color=COLORS["bg"],
            text_color=COLORS["text"], command=self.app.logout,
        ).pack(side="left", padx=(4, 12))

        # =================== Cuerpo ===================
        body = ctk.CTkFrame(self, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=24, pady=(16, 20))

        # Selector de server + estado.
        row = ctk.CTkFrame(body, fg_color="transparent")
        row.pack(fill="x")
        ctk.CTkLabel(
            row, text="Server:", font=font(13), text_color=COLORS["text_dim"]
        ).pack(side="left")
        self.server_menu = ctk.CTkOptionMenu(
            row, width=280, height=32, font=font(13),
            fg_color=COLORS["panel2"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hover"],
            command=self._on_server_change,
        )
        self.server_menu.pack(side="left", padx=10)
        self.status = ctk.CTkLabel(
            row, text="Todo listo.", font=font(13, "bold"),
            text_color=COLORS["text_dim"],
        )
        self.status.pack(side="left", padx=14)

        # Identidad con la que se jugará (nick del ranking forzado en el juego).
        self.play_as = ctk.CTkLabel(
            body, text="", font=font(11), text_color=COLORS["text_dim"],
            anchor="w",
        )
        self.play_as.pack(fill="x", pady=(6, 0))

        # Botón grande JUGAR.
        self.play_btn = ctk.CTkButton(
            body, text="JUGAR", height=64, font=font(22, "bold"),
            fg_color=COLORS["play"], hover_color=COLORS["play_hover"],
            corner_radius=12, command=self.app.start_play,
        )
        self.play_btn.pack(fill="x", pady=(14, 10), ipady=2)

        # Consola mini (log de estado).
        console_card = ctk.CTkFrame(body, fg_color=COLORS["panel"], corner_radius=12)
        console_card.pack(fill="both", expand=True)
        ctk.CTkLabel(
            console_card, text="  Actividad", font=font(11, "bold"),
            text_color=COLORS["text_dim"], anchor="w",
        ).pack(fill="x", padx=8, pady=(8, 0))
        self.console = ctk.CTkTextbox(
            console_card, font=font(12, mono=True), fg_color=COLORS["panel2"],
            text_color=COLORS["text"], wrap="word", height=220,
        )
        self.console.pack(fill="both", expand=True, padx=8, pady=(4, 10))
        self.console.configure(state="disabled")

    # --- Datos y estado ---------------------------------------------------
    def set_user(self, user: Dict) -> None:
        """Refresca cabecera y badge según el usuario (con GUID o sin él)."""
        self.user_label.configure(text=str(user.get("displayName") or "—"))
        self.email_label.configure(text=str(user.get("email") or ""))
        linked = user_is_linked(user)
        if linked:
            guid = str(user.get("linkedGuid") or user.get("guid") or "")
            self.badge.configure(
                text=f"  VERIFICADO · {guid}  ",
                fg_color=COLORS["play"], text_color="#ffffff",
            )
        else:
            self.badge.configure(
                text="  SIN VINCULAR  ", fg_color=COLORS["warn"], text_color="#ffffff"
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

    def selected_server(self) -> Optional[Dict[str, str]]:
        """Devuelve el server elegido (dict) o None si la config está vacía."""
        label = self.server_menu.get()
        idx = self._server_labels.get(label)
        if idx is None or idx >= len(self._servers):
            return None
        return self._servers[idx]

    def _on_server_change(self, _label: str) -> None:
        self.log_line(f"Server seleccionado: {self.selected_server()}")

    def set_play_as(self, display_name: str, force_nick: bool) -> None:
        """Línea discreta 'Jugando como: <nick>' (solo si se fuerza el nick)."""
        if force_nick and (display_name or "").strip():
            self.play_as.configure(text=f"Jugando como: {display_name.strip()}")
        else:
            self.play_as.configure(text="")

    def set_status(self, text: str, kind: str = "dim") -> None:
        """Texto de estado junto al selector (dim/ok/warn/error)."""
        color = {
            "dim": COLORS["text_dim"], "ok": COLORS["ok"],
            "warn": COLORS["warn"], "error": COLORS["error"],
        }.get(kind, COLORS["text_dim"])
        self.status.configure(text=text, text_color=color)

    def set_playing(self, playing: bool) -> None:
        """Deshabilita JUGAR mientras corre el flujo; REINTENTAR tras fallo."""
        if playing:
            self.play_btn.configure(state="disabled", text="CONECTANDO…")
        else:
            self.play_btn.configure(state="normal", text="JUGAR")

    def set_retry(self) -> None:
        """Tras un fallo con reintento, el botón grande pasa a REINTENTAR."""
        self.play_btn.configure(state="normal", text="REINTENTAR")

    def log_line(self, text: str) -> None:
        """Añade una línea con timestamp a la consola mini (hilo principal)."""
        stamp = time.strftime("%H:%M:%S")
        self.console.configure(state="normal")
        self.console.insert("end", f"[{stamp}] {text}\n")
        self.console.see("end")
        self.console.configure(state="disabled")
