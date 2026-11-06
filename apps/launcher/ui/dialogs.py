"""Diálogos modales del launcher (tema oscuro, en español)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

import customtkinter as ctk

from ui.theme import COLORS, font

log = logging.getLogger("ui.dialogs")


def _format_hour(iso: str) -> str:
    """ISO-8601 UTC → hora local HH:MM para mostrar al jugador."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M")
    except (ValueError, TypeError):
        return "?"


class ModalDialog(ctk.CTkToplevel):
    """Base de diálogo modal oscuro: centrado sobre la ventana principal."""

    def __init__(self, master, title: str) -> None:
        super().__init__(master)
        self.title(title)
        self.configure(fg_color=COLORS["panel"])
        self.resizable(False, False)
        self.transient(master)
        # Centrar respecto de la ventana principal.
        self.update_idletasks()
        w, h = self.winfo_width() or 420, 10
        mx, my = master.winfo_rootx(), master.winfo_rooty()
        mw, mh = master.winfo_width(), master.winfo_height()
        self.geometry(f"+{mx + (mw - w) // 2}+{my + (mh - h) // 3}")


class CandidateDialog(ModalDialog):
    """Diálogo para elegir tu GUID cuando la API encuentra varios candidatos.

    Muestra nombre del jugador + hora de su última conexión. Al confirmar
    llama a ``on_result(guid)``; si el usuario cancela, ``on_result(None)``.
    """

    def __init__(
        self,
        master,
        candidates: List[Dict[str, str]],
        on_result: Callable[[Optional[str]], None],
    ) -> None:
        super().__init__(master, title="¿Cuál es tu cuenta?")
        self.on_result = on_result
        self._chosen: Optional[str] = None

        ctk.CTkLabel(
            self,
            text="Vimos varios jugadores conectados ahora mismo.\n"
                 "Selecciona el que eres tú para vincular tu cuenta:",
            font=font(13),
            justify="left",
        ).pack(padx=20, pady=(18, 10), anchor="w")

        # Lista de opciones (radio buttons).
        self._var = ctk.StringVar(value="")
        box = ctk.CTkFrame(self, fg_color="transparent")
        box.pack(padx=20, pady=4, fill="both", expand=True)
        for c in candidates:
            guid = str(c.get("guid", ""))
            name = str(c.get("name", "?"))
            seen = _format_hour(str(c.get("lastConnection", "")))
            label = f"{name}   ·   visto {seen}h   ·   GUID {guid}"
            ctk.CTkRadioButton(
                box,
                text=label,
                variable=self._var,
                value=guid,
                font=font(12),
                fg_color=COLORS["accent"],
            ).pack(anchor="w", pady=3)

        # Botones de acción.
        row = ctk.CTkFrame(self, fg_color="transparent")
        row.pack(padx=20, pady=(10, 18), fill="x")
        ctk.CTkButton(
            row,
            text="No soy ninguno",
            fg_color=COLORS["panel2"],
            hover_color=COLORS["bg"],
            text_color=COLORS["text_dim"],
            command=self._cancel,
        ).pack(side="left")
        ctk.CTkButton(
            row,
            text="Es mi cuenta ✓",
            fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"],
            command=self._confirm,
        ).pack(side="right")

        # Al cerrar con la X se trata como cancelación.
        self.protocol("WM_DELETE_WINDOW", self._cancel)
        # El grab necesita que la ventana ya se haya pintado.
        self.after(120, self.grab_set)
        log.info("Diálogo de candidatos abierto con %d opciones", len(candidates))

    def _confirm(self) -> None:
        guid = self._var.get()
        if not guid:
            return  # sin selección no cerramos
        self._chosen = guid
        self._close()

    def _cancel(self) -> None:
        self._chosen = None
        self._close()

    def _close(self) -> None:
        try:
            self.grab_release()
        except Exception:
            pass
        self.destroy()
        self.on_result(self._chosen)


class MsgBox(ModalDialog):
    """Aviso simple con un botón Aceptar (info / error / éxito)."""

    def __init__(self, master, title: str, message: str, kind: str = "info") -> None:
        super().__init__(master, title=title)
        color = {"error": COLORS["error"], "success": COLORS["ok"]}.get(kind, COLORS["text"])
        self.geometry(f"+{master.winfo_rootx() + master.winfo_width() // 2 - 180}"
                      f"+{master.winfo_rooty() + master.winfo_height() // 3}")

        ctk.CTkLabel(
            self, text=message, font=font(13), text_color=color, justify="left",
            wraplength=320,
        ).pack(padx=24, pady=(22, 12))
        ctk.CTkButton(
            self, text="Aceptar", width=120, fg_color=COLORS["accent"],
            hover_color=COLORS["accent_hover"], command=self.destroy,
        ).pack(pady=(0, 20))
        self.after(120, self.grab_set)
