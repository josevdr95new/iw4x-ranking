"""Pantalla de ajustes: api_url, game_path, server por defecto, test de API.

Visual: bloques de sección '// CONEXIÓN //', '// JUEGO //', '// SERVER //'
con hairlines; acción única ámbar (GUARDAR). Sin cambios de comportamiento.
"""
from __future__ import annotations

import logging
from tkinter import filedialog
from typing import TYPE_CHECKING

import customtkinter as ctk

from api_client import NetworkError
from ui.hud import ghost_button, hairline, primary_button, section_label
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


class SettingsFrame(ctk.CTkFrame):
    """Edición de la configuración local (launcher.config.json)."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app

        ctk.CTkLabel(
            self, text=section_text("AJUSTES"), font=font(20, "bold", mono=True),
            text_color=COLORS["text"], anchor="w",
        ).pack(fill="x", padx=SP["xl"], pady=(SP["xl"], SP["s"]))
        hairline(self, COLORS["accent_border"]).pack(
            fill="x", padx=SP["xl"], pady=(0, SP["l"])
        )

        card = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=RADIUS["card"])
        card.pack(padx=SP["xl"], pady=SP["s"], fill="both", expand=True)
        inner = ctk.CTkFrame(card, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=SP["l"], pady=SP["m"])

        # --- Conexión ------------------------------------------------------
        section_label(inner, "CONEXIÓN").pack(fill="x", pady=(0, SP["s"]))
        _caption(inner, "DIRECCIÓN DE LA API").pack(fill="x")
        self.api_url = _entry(inner)
        self.api_url.pack(fill="x", pady=(2, SP["m"]))

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

        # --- Server ----------------------------------------------------------
        section_label(inner, "SERVER").pack(fill="x", pady=(0, SP["s"]))
        _caption(inner, "SERVER POR DEFECTO").pack(fill="x")
        self.server_menu = ctk.CTkOptionMenu(
            inner, width=300, height=32, font=font(12),
            fg_color=COLORS["panel2"], button_color=COLORS["accent"],
            button_hover_color=COLORS["accent_hover"], text_color=COLORS["text"],
            dropdown_fg_color=COLORS["panel"], dropdown_hover_color=COLORS["panel2"],
            corner_radius=RADIUS["input"],
        )
        self.server_menu.pack(anchor="w", pady=(2, SP["m"]))

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

        # --- Acciones ---------------------------------------------------------
        hairline(inner).pack(fill="x", pady=(0, SP["m"]))
        actions = ctk.CTkFrame(inner, fg_color="transparent")
        actions.pack(fill="x", pady=(0, SP["s"]))
        ghost_button(actions, "PROBAR CONEXIÓN API", self._test_api, width=170).pack(
            side="left"
        )
        primary_button(actions, "GUARDAR", self._save, width=140).pack(side="right")

        # Resultado del test de conexión / guardado.
        self.feedback = ctk.CTkLabel(
            inner, text="", font=font(11), justify="left", wraplength=520,
            text_color=COLORS["text_dim"], anchor="w",
        )
        self.feedback.pack(fill="x", pady=(0, SP["s"]))

        # --- Volver -----------------------------------------------------------
        ghost_button(self, "← VOLVER", self.app.show_home, width=110).pack(
            anchor="w", padx=SP["xl"], pady=SP["m"]
        )

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
        if cfg.cloud_save:
            self.cloud_save_check.select()
        else:
            self.cloud_save_check.deselect()
        # Auto-guardado: el valor SIEMPRE va al entry (visible aunque sea 0);
        # el checkbox refleja si está activo (>0).
        self.autosave_minutes.delete(0, "end")
        self.autosave_minutes.insert(0, str(cfg.autosave_minutes))
        if cfg.autosave_minutes > 0:
            self.autosave_check.select()
        else:
            self.autosave_check.deselect()
        self.feedback.configure(text="", text_color=COLORS["text_dim"])

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
        self.feedback.configure(text=f"✘ {msg}", text_color=COLORS["danger"])
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
        cfg.set("cloud_save", bool(self.cloud_save_check.get()))
        # Auto-guardado: solo cuenta si el checkbox está activo; el valor es
        # entero ≥0 (0 = desactivado). Basura en el entry → 0 (sin crash).
        autosave_minutes = self._autosave_minutes_value()
        if not self.autosave_check.get():
            autosave_minutes = 0
        cfg.set("autosave_minutes", autosave_minutes)
        cfg.save()

        # Aplicar en caliente: nuevo cliente con la URL actualizada.
        self.app.apply_api_url(base)
        self.app.refresh_home_servers()
        self.feedback.configure(text="✔ Ajustes guardados.", text_color=COLORS["ok"])
        log.info("Ajustes guardados: api_url=%s default_server=%s "
                 "autosave_minutes=%s", base, idx, autosave_minutes)
        self.app.show_home()
