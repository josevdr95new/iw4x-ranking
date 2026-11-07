"""Componentes HUD reutilizables: hairlines, secciones, brackets, chips.

Detalles de "construido, no ensamblado": hairlines de 1px, esquinas con
bracket/chanfle dibujadas en canvas, marcadores de sección '// TEXTO //'.
Nada de gradientes ni glow — la elevación es paso de superficie + hairline.
"""
from __future__ import annotations

from typing import Optional

import customtkinter as ctk
import tkinter as tk

from ui.theme import COLORS, RADIUS, SP, font, section_text


def hairline(parent, color: Optional[str] = None, horizontal: bool = True):
    """Línea de 1px (hairline) — el separador base del sistema."""
    line = tk.Frame(
        parent,
        background=color or COLORS["border"],
        height=1 if horizontal else 1,
        width=9999 if horizontal else 1,
        bd=0,
        highlightthickness=0,
    )
    return line


def section_label(parent, text: str) -> ctk.CTkLabel:
    """Marcador '// SECCIÓN //' en mono — encabezado de bloque HUD."""
    return ctk.CTkLabel(
        parent,
        text=section_text(text),
        font=font(10, "bold", mono=True),
        text_color=COLORS["text_faint"],
        anchor="w",
    )


def ghost_button(parent, text: str, command, width: int = 96) -> ctk.CTkButton:
    """Botón fantasma: fondo transparente + hairline, texto claro."""
    return ctk.CTkButton(
        parent,
        text=text,
        command=command,
        width=width,
        height=30,
        font=font(11, "bold"),
        fg_color="transparent",
        hover_color=COLORS["panel2"],
        text_color=COLORS["text"],
        border_width=1,
        border_color=COLORS["border_strong"],
        corner_radius=RADIUS["btn"],
    )


def primary_button(parent, text: str, command, width: int = 140, height: int = 38):
    """Botón de acción ámbar (único color de acción del sistema)."""
    return ctk.CTkButton(
        parent,
        text=text,
        command=command,
        width=width,
        height=height,
        font=font(13, "bold"),
        fg_color=COLORS["accent"],
        hover_color=COLORS["accent_hover"],
        text_color=COLORS["on_accent"],
        corner_radius=RADIUS["btn"],
    )


def status_chip(parent, text: str, kind: str = "dim") -> ctk.CTkLabel:
    """Chip de estado con hairline (VERIFICADO, SIN VINCULAR, ● LISTO…)."""
    palette = {
        "ok": (COLORS["ok_dim"], COLORS["ok"], COLORS["ok"]),
        "accent": (COLORS["accent_subtle"], COLORS["accent"], COLORS["accent_border"]),
        "dim": ("transparent", COLORS["text_dim"], COLORS["border"]),
        "danger": (COLORS["danger_dim"], COLORS["danger"], COLORS["danger"]),
    }
    bg, fg, border = palette.get(kind, palette["dim"])
    return ctk.CTkLabel(
        parent,
        text=text,
        font=font(11, "bold", mono=True),
        text_color=fg,
        fg_color=bg,
        corner_radius=RADIUS["btn"],
    )


class BracketCard(ctk.CTkFrame):
    """Tarjeta HUD: hairline + brackets de esquina dibujados en canvas.

    Los brackets (chanfles) se dibujan sobre las 4 esquinas con un trazo de
    2px; el resto del borde queda en hairline. `accent=True` usa el ámbar
    del sistema para los brackets (reservado para la tarjeta protagonista).
    """

    def __init__(self, master, arm: int = 12, accent: bool = False,
                 fill: Optional[str] = None, **kw) -> None:
        fill = fill or COLORS["panel"]
        super().__init__(master, fg_color=fill, corner_radius=2, **kw)
        self._arm = arm
        self._bracket_color = COLORS["accent_border"] if accent else COLORS["border_strong"]
        self._canvas = tk.Canvas(
            self, highlightthickness=0, bd=0, bg=fill, insertwidth=0
        )
        self._canvas.place(relx=0, rely=0, relwidth=1, relheight=1)
        # Contenido dentro de la tarjeta: pack con inset para que los
        # brackets de esquina (brazos de ~12px) no tapen el primer widget.
        # SIN este pack el contenido queda en un contenedor jamás mapeado
        # (bug: tarjeta visible pero sin formulario).
        self._inner = ctk.CTkFrame(self, fg_color="transparent")
        self._inner.pack(fill="both", expand=True, padx=10, pady=10)
        self.bind("<Configure>", lambda _e: self._draw_brackets())
        self._draw_brackets()

    @property
    def inner(self) -> ctk.CTkFrame:
        """Frame interior donde va el contenido de la tarjeta."""
        return self._inner

    def _draw_brackets(self) -> None:
        """Dibuja los 4 brackets en L sobre el canvas (no tocar: CTkFrame
        tiene su propio _draw interno y lo pisaríamos)."""
        c = self._canvas
        c.delete("all")
        w = max(c.winfo_width(), 2)
        h = max(c.winfo_height(), 2)
        a = self._arm
        color = self._bracket_color
        # Cuatro brackets en L (2px): esquinas superiores e inferiores.
        for x0, y0, dx, dy in ((0, 0, 1, 1), (w - 1, 0, -1, 1),
                               (0, h - 1, 1, -1), (w - 1, h - 1, -1, -1)):
            c.create_line(x0, y0, x0 + dx * a, y0, fill=color, width=2)
            c.create_line(x0, y0, x0, y0 + dy * a, fill=color, width=2)


class DotState(ctk.CTkLabel):
    """Indicador ● de estado con texto (punto de color + etiqueta mono)."""

    TEXTS = {
        "listo": "● LISTO PARA DESPLEGAR",
        "conectando": "● CONECTANDO",
        "en_partida": "● EN PARTIDA",
        "fallo": "● SIN CONEXIÓN AL SERVER",
    }

    def __init__(self, master, state: str = "listo") -> None:
        super().__init__(
            master, text=self.TEXTS[state], font=font(11, "bold", mono=True),
            text_color=COLORS["ok"], anchor="e",
        )
        self._state = state
        self._blink_after: Optional[str] = None
        self._blink_pos = 0
        self.set_state(state)

    def set_state(self, state: str) -> None:
        """Cambia el estado y su color; CONECTANDO anima sus puntos."""
        self._state = state
        color = {
            "listo": COLORS["ok"],
            "en_partida": COLORS["ok"],
            "conectando": COLORS["accent"],
            "fallo": COLORS["danger"],
        }.get(state, COLORS["text_dim"])
        self.configure(text_color=color)
        self._stop_blink()
        if state == "conectando":
            self._animate()
        else:
            self.configure(text=self.TEXTS.get(state, state))

    def _animate(self) -> None:
        """Micro-interacción: puntos progresivos mientras conecta."""
        dots = "." * (self._blink_pos % 4)
        self._blink_pos += 1
        self.configure(text="● CONECTANDO" + dots)
        self._blink_after = self.after(350, self._animate)

    def _stop_blink(self) -> None:
        if self._blink_after is not None:
            try:
                self.after_cancel(self._blink_after)
            except Exception:
                pass
            self._blink_after = None

    def stop(self) -> None:
        """Cancela la animación (logout/cierre)."""
        self._stop_blink()
