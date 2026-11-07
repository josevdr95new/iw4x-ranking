"""Diálogos modales del launcher (tema HUD oscuro, en español).

Tarjetas con brackets de esquina, títulos mono, acción única ámbar.
Mismos comportamientos e internos que la versión previa (el test los usa).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Callable, Dict, List, Optional

import customtkinter as ctk

from ui.hud import ghost_button, hairline, primary_button, section_label
from ui.theme import COLORS, RADIUS, SP, font, section_text

log = logging.getLogger("ui.dialogs")


def _format_hour(iso: str) -> str:
    """ISO-8601 UTC → hora local HH:MM para mostrar al jugador."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M")
    except (ValueError, TypeError):
        return "?"


class ModalDialog(ctk.CTkToplevel):
    """Base de diálogo modal oscuro: panel con hairline + brackets, centrado."""

    def __init__(self, master, title: str) -> None:
        super().__init__(master)
        self.title(title)
        self.configure(fg_color=COLORS["bg"])
        self.resizable(False, False)
        self.transient(master)
        # Centrar respecto de la ventana principal.
        self.update_idletasks()
        w = self.winfo_width() or 440
        mx, my = master.winfo_rootx(), master.winfo_rooty()
        mw, mh = master.winfo_width(), master.winfo_height()
        self.geometry(f"+{mx + max(0, (mw - w) // 2)}+{my + (mh // 3)}")


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
            self, text=section_text("IDENTIFICACIÓN"),
            font=font(10, "bold", mono=True), text_color=COLORS["text_faint"],
            anchor="w",
        ).pack(fill="x", padx=SP["l"], pady=(SP["m"], 0))
        ctk.CTkLabel(
            self,
            text="Vimos varios jugadores conectados ahora mismo.\n"
                 "Selecciona el que eres tú para vincular tu cuenta:",
            font=font(12), justify="left", text_color=COLORS["text"],
            anchor="w",
        ).pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["s"]))

        hairline(self, COLORS["accent_border"]).pack(fill="x", padx=SP["l"])

        # Lista de opciones (radio buttons).
        self._var = ctk.StringVar(value="")
        box = ctk.CTkFrame(self, fg_color="transparent")
        box.pack(padx=SP["l"], pady=SP["s"], fill="both", expand=True)
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
                font=font(11),
                fg_color=COLORS["accent"],
                hover_color=COLORS["accent_hover"],
                border_color=COLORS["border_strong"],
                text_color=COLORS["text"],
            ).pack(anchor="w", pady=3)

        hairline(self).pack(fill="x", padx=SP["l"])

        # Botones de acción.
        row = ctk.CTkFrame(self, fg_color="transparent")
        row.pack(fill="x", padx=SP["l"], pady=(SP["m"], SP["m"]))
        ghost_button(row, "NO SOY NINGUNO", self._cancel, width=130).pack(side="left")
        primary_button(row, "ES MI CUENTA ✓", self._confirm, width=130).pack(side="right")

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
        color = {
            "error": COLORS["danger"], "success": COLORS["ok"],
        }.get(kind, COLORS["text"])
        self.geometry(f"+{master.winfo_rootx() + master.winfo_width() // 2 - 180}"
                      f"+{master.winfo_rooty() + master.winfo_height() // 3}")

        hairline(self, COLORS["accent_border"]).pack(fill="x", padx=SP["l"],
                                                     pady=(SP["m"], 0))
        ctk.CTkLabel(
            self, text=message, font=font(12), text_color=color, justify="left",
            wraplength=340,
        ).pack(padx=SP["l"], pady=(SP["m"], SP["s"]))
        primary_button(self, "ACEPTAR", self.destroy, width=130).pack(
            pady=(0, SP["m"])
        )
        self.after(120, self.grab_set)
