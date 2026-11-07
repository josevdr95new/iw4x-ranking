"""Pantalla de ajustes: api_url, game_path, server por defecto, test de API."""
from __future__ import annotations

import logging
from tkinter import filedialog
from typing import TYPE_CHECKING

import customtkinter as ctk

from api_client import NetworkError
from ui.theme import COLORS, font

if TYPE_CHECKING:
    from ui.main_window import App

log = logging.getLogger("ui.settings")


class SettingsFrame(ctk.CTkFrame):
    """Edición de la configuración local (launcher.config.json)."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app

        ctk.CTkLabel(
            self, text="⚙ Ajustes", font=font(22, "bold"), text_color=COLORS["text"]
        ).pack(anchor="w", padx=28, pady=(24, 14))

        card = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=14)
        card.pack(padx=28, pady=6, fill="both", expand=True)

        # --- API URL ------------------------------------------------------
        ctk.CTkLabel(
            card, text="Dirección de la API", font=font(12),
            text_color=COLORS["text_dim"], anchor="w",
        ).pack(fill="x", padx=22, pady=(18, 2))
        self.api_url = ctk.CTkEntry(card, width=420, height=34, font=font(13))
        self.api_url.pack(fill="x", padx=22, pady=(0, 12))

        # --- Game path ------------------------------------------------------
        ctk.CTkLabel(
            card, text="Ruta del juego (iw4x.exe)", font=font(12),
            text_color=COLORS["text_dim"], anchor="w",
        ).pack(fill="x", padx=22, pady=(2, 2))
        path_row = ctk.CTkFrame(card, fg_color="transparent")
        path_row.pack(fill="x", padx=22, pady=(0, 12))
        self.game_path = ctk.CTkEntry(path_row, height=34, font=font(13))
        self.game_path.pack(side="left", fill="x", expand=True)
        ctk.CTkButton(
            path_row, text="Examinar…", width=100, height=34, font=font(12),
            fg_color=COLORS["panel2"], hover_color=COLORS["bg"],
            command=self._browse_game,
        ).pack(side="left", padx=(8, 0))

        # --- Server por defecto ----------------------------------------------
        ctk.CTkLabel(
            card, text="Server por defecto", font=font(12),
            text_color=COLORS["text_dim"], anchor="w",
        ).pack(fill="x", padx=22, pady=(2, 2))
        self.server_menu = ctk.CTkOptionMenu(
            card, width=280, height=32, font=font(13),
            fg_color=COLORS["panel2"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hover"],
        )
        self.server_menu.pack(anchor="w", padx=22, pady=(0, 14))

        # --- Forzar nick del ranking ------------------------------------------
        self.force_nick_check = ctk.CTkCheckBox(
            card, text="Forzar mi nick del ranking en el juego", font=font(12),
            fg_color=COLORS["accent"], hover_color=COLORS["accent_hover"],
            checkmark_color="#ffffff", text_color=COLORS["text"],
        )
        self.force_nick_check.pack(anchor="w", padx=22, pady=(2, 14))

        # --- Acciones -------------------------------------------------------
        actions = ctk.CTkFrame(card, fg_color="transparent")
        actions.pack(fill="x", padx=22, pady=(4, 10))
        ctk.CTkButton(
            actions, text="Probar conexión API", height=36, font=font(12, "bold"),
            fg_color=COLORS["panel2"], hover_color=COLORS["bg"],
            text_color=COLORS["text"], command=self._test_api,
        ).pack(side="left")
        ctk.CTkButton(
            actions, text="Guardar", height=36, width=120, font=font(12, "bold"),
            fg_color=COLORS["play"], hover_color=COLORS["play_hover"],
            command=self._save,
        ).pack(side="right")

        # Resultado del test de conexión / guardado.
        self.feedback = ctk.CTkLabel(
            card, text="", font=font(12), justify="left", wraplength=440,
            text_color=COLORS["text_dim"], anchor="w",
        )
        self.feedback.pack(fill="x", padx=22, pady=(0, 18))

        # --- Volver ---------------------------------------------------------
        ctk.CTkButton(
            self, text="← Volver", width=110, height=34, font=font(12),
            fg_color=COLORS["panel2"], hover_color=COLORS["bg"],
            text_color=COLORS["text"], command=self.app.show_home,
        ).pack(anchor="w", padx=28, pady=14)

    # --- Ciclo de la pantalla ----------------------------------------------
    def load_from_config(self) -> None:
        """Rellena los campos desde la configuración actual."""
        cfg = self.app.cfg
        self.api_url.delete(0, "end")
        self.api_url.insert(0, cfg.api_url)
        self.game_path.delete(0, "end")
        self.game_path.insert(0, cfg.game_path)
        labels = [f"{s['name']}  ({s['address']})" for s in cfg.servers]
        self.server_menu.configure(values=labels)
        idx = min(max(cfg.default_server, 0), len(labels) - 1) if labels else 0
        if labels:
            self.server_menu.set(labels[idx])
        if cfg.force_nick:
            self.force_nick_check.select()
        else:
            self.force_nick_check.deselect()
        self.feedback.configure(text="", text_color=COLORS["text_dim"])

    # --- Acciones ------------------------------------------------------------
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
        """GET /api/sync/status (público) para verificar conectividad."""
        base = self.api_url.get().strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            self.feedback.configure(
                text="La dirección debe empezar por http:// o https://",
                text_color=COLORS["warn"],
            )
            return

        self.feedback.configure(text="Probando conexión…", text_color=COLORS["text_dim"])
        self.app.test_api_connection(base, self._test_ok, self._test_fail)

    def _test_ok(self, info: dict) -> None:
        """Respuesta de /sync/status: mostramos el último sync si existe."""
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
        msg = (
            str(error) if isinstance(error, NetworkError)
            else f"La API respondió con error: {getattr(error, 'message', error)}"
        )
        self.feedback.configure(text=f"✘ {msg}", text_color=COLORS["error"])
        log.info("Test de API falló: %s", msg)

    def _save(self) -> None:
        """Valida, persiste y aplica la configuración."""
        cfg = self.app.cfg
        base = self.api_url.get().strip().rstrip("/")
        if not base.startswith(("http://", "https://")):
            self.feedback.configure(
                text="Dirección de API no válida (debe empezar por http:// o https://)",
                text_color=COLORS["warn"],
            )
            return

        servers = cfg.servers
        labels = [f"{s['name']}  ({s['address']})" for s in servers]
        chosen = self.server_menu.get()
        idx = labels.index(chosen) if chosen in labels else cfg.default_server

        cfg.set("api_url", base)
        cfg.set("game_path", self.game_path.get().strip())
        cfg.set("default_server", idx)
        cfg.set("force_nick", bool(self.force_nick_check.get()))
        cfg.save()

        # Aplicar en caliente: nuevo cliente con la URL actualizada.
        self.app.apply_api_url(base)
        self.app.refresh_home_servers()
        self.feedback.configure(text="✔ Ajustes guardados.", text_color=COLORS["ok"])
        log.info("Ajustes guardados: api_url=%s default_server=%s", base, idx)
        self.app.show_home()
