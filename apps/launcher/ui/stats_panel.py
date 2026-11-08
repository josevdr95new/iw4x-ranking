"""Panel "// TUS STATS //" en vivo de la pantalla principal.

Muestra rank/kills/deaths/headshots/k/d + tiempo jugado, último server y
nombre actual del jugador (con el ratio de headshots en la línea de
detalle). Los datos los trae App (GET /api/players/:guid cada 30s o con
el botón ↻); este panel solo pinta y lleva el contador de edad ("hace 12s").

El color del K/D sigue los umbrales del diseño (docs/DESIGN.md §1.1):
≥ 1,20 verde · 1,00–1,19 neutro · 0,80–0,99 ámbar · < 0,80 rojo.
Si la cuenta no tiene GUID vinculado, muestra el CTA y detiene timers.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import customtkinter as ctk

from ui.hud import bind_ghost_focus, hairline
from ui.theme import COLORS, RADIUS, SP, font

log = logging.getLogger("ui.stats")

# --- Grid de valores (medido, SIN solape) -----------------------------------
# Bug del dueño: los captions se leían "DEATHSHEADSHOTSK/D". Causa real: el
# padx separador estaba SOLO en el valor; cuando la caption era más ancha
# que el número de arriba (DEATHS/HEADSHOTS con valores cortos) la columna
# media justo lo que ocupa el texto y las captions quedaban pegadas.
# Fix en tres piezas:
#   1. el padx separador va también en la caption;
#   2. fuentes reducidas 18→16 (valores) y 9→8 (captions);
#   3. layout MEDIDO (no a ojo): los 5 bloques van en UNA fila solo si la
#      suma de anchos requeridos (métrica real de fuente) + huecos cabe en
#      el ancho REAL del panel (winfo_width); si no, dos filas
#      (RANK/KILLS/DEATHS arriba · HEADSHOTS/K/D abajo).
GRID_VALUE_SIZE = 16
GRID_CAPTION_SIZE = 8
GRID_ORDER: Tuple[str, ...] = ("rank", "kills", "deaths", "hs", "kd")
GRID_TOP: Tuple[str, ...] = ("rank", "kills", "deaths")
GRID_BOTTOM: Tuple[str, ...] = ("hs", "kd")
GRID_ROW_GAP = SP["m"]  # aire vertical entre filas en modo 2 filas


def _fmt_int(value: Any) -> str:
    """Entero con separador de miles estilo es-ES; '—' si no hay dato."""
    try:
        return f"{int(value):,}".replace(",", ".")
    except (TypeError, ValueError):
        return "—"


def _fmt_kd(value: Any) -> str:
    try:
        return f"{float(value):.2f}".replace(".", ",")
    except (TypeError, ValueError):
        return "—"


def _fmt_time(seconds: Any) -> str:
    """Segundos → '2h 05m' / '17m'; '—' si no hay dato."""
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return "—"
    hours, rem = divmod(total, 3600)
    minutes = rem // 60
    if hours:
        return f"{hours}h {minutes:02d}m"
    return f"{minutes}m"


def _kd_color(kd: Any) -> str:
    """Color semántico del K/D según los umbrales del diseño."""
    try:
        value = float(kd)
    except (TypeError, ValueError):
        return COLORS["text"]
    if value >= 1.20:
        return COLORS["ok"]
    if value >= 1.00:
        return COLORS["text"]
    if value >= 0.80:
        return COLORS["accent"]
    return COLORS["danger"]


class StatsPanel(ctk.CTkFrame):
    """Tarjeta compacta de stats del jugador (entre server y JUGAR)."""

    def __init__(self, master, on_manual_refresh) -> None:
        super().__init__(
            master, fg_color=COLORS["panel"], corner_radius=RADIUS["card"],
            border_width=1, border_color=COLORS["border"],
        )

        self._age_after: Optional[str] = None   # id del after() del ticker
        self._last_ok: Optional[float] = None   # monotonic de la última carga

        # --- Cabecera: '// TUS STATS //' + edad + ↻ --------------------------
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.pack(fill="x", padx=SP["l"], pady=(SP["m"], 0))
        ctk.CTkLabel(
            head, text="// TUS STATS //", font=font(10, "bold", mono=True),
            text_color=COLORS["text_faint"], anchor="w",
        ).pack(side="left")
        self.age_label = ctk.CTkLabel(
            head, text="", font=font(10, mono=True), text_color=COLORS["text_faint"]
        )
        self.age_label.pack(side="right", padx=(0, SP["s"]))
        self.refresh_btn = ctk.CTkButton(
            head, text="↻", width=30, height=24, font=font(13),
            fg_color="transparent", hover_color=COLORS["panel2"],
            text_color=COLORS["text_dim"], border_width=1,
            border_color=COLORS["border_strong"], corner_radius=RADIUS["btn"],
            command=on_manual_refresh,
        )
        self.refresh_btn.pack(side="right")
        bind_ghost_focus(self.refresh_btn)

        # --- Línea de estado (cargando / error / CTA) -------------------------
        self.status_label = ctk.CTkLabel(
            self, text="", font=font(11), justify="left", wraplength=600,
            text_color=COLORS["text_dim"], anchor="w",
        )
        self.status_label.pack(fill="x", padx=SP["l"], pady=(SP["xs"], 0))

        # --- Valores principales ('—' hasta la primera respuesta) -------------
        self._grid = ctk.CTkFrame(self, fg_color="transparent")
        self._grid.pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))
        self._value_font = font(GRID_VALUE_SIZE, "bold", mono=True)
        self._caption_font = font(GRID_CAPTION_SIZE, "bold")
        self._blocks: Dict[str, ctk.CTkLabel] = {}
        self._captions: Dict[str, ctk.CTkLabel] = {}
        specs = [
            ("rank", "RANK", COLORS["ok"]),
            ("kills", "KILLS", COLORS["text"]),
            ("deaths", "DEATHS", COLORS["text"]),
            ("hs", "HEADSHOTS", COLORS["text"]),
            ("kd", "K/D", COLORS["text"]),
        ]
        for key, caption, color in specs:
            value = ctk.CTkLabel(
                self._grid, text="—", font=self._value_font,
                text_color=color, anchor="w",
            )
            cap = ctk.CTkLabel(
                self._grid, text=caption, font=self._caption_font,
                text_color=COLORS["text_faint"], anchor="w",
            )
            self._blocks[key] = value
            self._captions[key] = cap
        # Estado del layout (para no recolocar si nada cambió).
        self._grid_mode: Optional[str] = None   # "fila" | "dos_filas"
        self._grid_gap: int = -1
        self._grid_avail: int = -1
        # Decisión 1↔2 filas sobre el ancho REAL: al mapear/redimensionar el
        # panel y cada vez que cambian los valores.
        self.bind("<Configure>", lambda _e: self._relayout_grid())
        self._relayout_grid()

        hairline(self).pack(fill="x", padx=SP["l"], pady=(SP["xs"], 0))

        # --- Fila secundaria ---------------------------------------------------
        self.sub_label = ctk.CTkLabel(
            self, text="", font=font(10, mono=True),
            text_color=COLORS["text_dim"], anchor="w", justify="left",
            wraplength=620,
        )
        self.sub_label.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["m"]))

    # ================== Estados del panel ==================
    def show_linked(self) -> None:
        """Cuenta vinculada: panel normal, valores '—' hasta la 1ª respuesta."""
        self.status_label.configure(
            text="Cargando tus stats…", text_color=COLORS["text_dim"]
        )
        self._reset_values()

    def show_cta(self) -> None:
        """Cuenta SIN vincular: badge pasivo (auto-link server-side)."""
        self.stop_timers()
        self._last_ok = None
        self.age_label.configure(text="")
        self.status_label.configure(
            text="Se vincula al entrar — dale JUGAR y tu identidad se "
                 "vincula automáticamente; tus stats aparecerán aquí",
            text_color=COLORS["accent"],
        )
        self._reset_values()
        self.sub_label.configure(text="")

    def set_loading(self) -> None:
        """Refresco manual en curso (conserva los valores visibles)."""
        self.status_label.configure(
            text="Actualizando…", text_color=COLORS["text_dim"]
        )

    def set_error(self, message: str) -> None:
        """API caída/timeout: aviso rojo sin romper la pantalla ni los datos."""
        self.status_label.configure(text=message, text_color=COLORS["danger"])

    def set_no_data(self) -> None:
        """El GUID existe pero aún no tiene partidas registradas."""
        self.status_label.configure(
            text="Aún no tienes partidas registradas.", text_color=COLORS["text_dim"]
        )

    def set_values(self, player: Dict[str, Any], rank: Any, last_server: Any) -> None:
        """Pinta una respuesta correcta de GET /api/players/:guid."""
        self.status_label.configure(text="")
        self._blocks["rank"].configure(
            text="—" if rank is None else _fmt_int(rank)
        )
        self._blocks["kills"].configure(text=_fmt_int(player.get("kills")))
        self._blocks["deaths"].configure(text=_fmt_int(player.get("deaths")))
        self._blocks["hs"].configure(text=_fmt_int(player.get("headshots")))
        kd_text = _fmt_kd(player.get("kd"))
        self._blocks["kd"].configure(
            text=kd_text, text_color=_kd_color(player.get("kd"))
        )

        server = str(last_server) if last_server else "—"
        name = str(player.get("name") or "—")
        # Ratio de headshots (hint equivalente al K/D, sin engordar el grid):
        # 'HS 15% de bajas' en la línea de detalle; '—' si el perfil no trae
        # hsRatio (0 kills o perfil viejo). Se ignora el legacy headshotPct.
        try:
            hs_ratio = f"{float(player.get('hsRatio')) * 100:.0f}%"
        except (TypeError, ValueError):
            hs_ratio = "—"
        self.sub_label.configure(
            text=f"TIEMPO {_fmt_time(player.get('timePlayed'))}"
                 f"   //   SERVER {server}"
                 f"   //   JUGADOR {name}"
                 f"   //   HS {hs_ratio} de bajas"
        )
        # Reinicia el contador de edad y arranca el ticker de 1s.
        self._last_ok = time.monotonic()
        self.age_label.configure(text="hace 0s")
        self._start_age_ticker()
        # Los valores cambiaron: re-decidir 1↔2 filas con los anchos nuevos.
        self._relayout_grid()

    # ================== Ticker de edad ==================
    def _start_age_ticker(self) -> None:
        self._stop_age_ticker()
        self._tick_age()

    def _tick_age(self) -> None:
        if self._last_ok is None:
            return
        secs = int(time.monotonic() - self._last_ok)
        text = f"hace {secs}s" if secs < 90 else f"hace {secs // 60}m"
        self.age_label.configure(text=text)
        self._age_after = self.after(1000, self._tick_age)

    def _stop_age_ticker(self) -> None:
        if self._age_after is not None:
            try:
                self.after_cancel(self._age_after)
            except Exception:
                pass
            self._age_after = None

    def stop_timers(self) -> None:
        """Cancela el ticker (logout / cierre)."""
        self._stop_age_ticker()

    # ================== Internos ==================
    def _reset_values(self) -> None:
        """Todos los valores a '—' (antes de la primera respuesta)."""
        default_colors = {
            "rank": COLORS["ok"], "kills": COLORS["text"],
            "deaths": COLORS["text"], "hs": COLORS["text"],
            "kd": COLORS["text"],
        }
        for key, block in self._blocks.items():
            block.configure(text="—", text_color=default_colors[key])
        self._relayout_grid()

    # ================== Layout medido del grid ==================
    def _column_need(self, key: str) -> int:
        """Ancho mínimo (px) de la columna ``key``: máx. entre su valor y su
        caption, medido con la métrica REAL de la fuente (no estimado)."""
        value_text = str(self._blocks[key].cget("text"))
        caption_text = str(self._captions[key].cget("text"))
        return max(self._value_font.measure(value_text),
                   self._caption_font.measure(caption_text))

    def _row_need(self, keys, gap: int) -> int:
        """Ancho total (px) que pide una fila: sumas + huecos entre columnas."""
        needs = [self._column_need(k) for k in keys]
        return sum(needs) + gap * max(0, len(needs) - 1)

    def _relayout_grid(self) -> None:
        """Coloca los 5 bloques en UNA fila si caben MEDIDOS en el ancho real
        del panel; si no, en dos filas (RANK/KILLS/DEATHS · HEADSHOTS/K/D).

        Ancho disponible: winfo_width() del frame del grid (el panel vive
        empaquetado con fill='x', así que su ancho es el de la ventana). Si
        aún no está mapeado (ancho 1) se aplaza: el <Configure> del panel
        relanzará esta decisión. Con gap de 24px no cabe, se intenta 12px
        antes de partir en dos filas. Idempotente: si la decisión no cambió,
        no se toca nada.
        """
        avail = self._grid.winfo_width()
        if avail <= 1:
            avail = self.winfo_width() - 2 * SP["l"] - 2
        if avail <= 1:
            return  # sin mapear aún: vendrá el <Configure>

        gap = SP["xl"]  # 24px
        fits_one = self._row_need(GRID_ORDER, gap) <= avail
        if not fits_one:
            gap = SP["m"]  # 12px: segundo intento antes de partir
            fits_one = self._row_need(GRID_ORDER, gap) <= avail
        mode = "fila" if fits_one else "dos_filas"

        if (mode == self._grid_mode and gap == self._grid_gap
                and avail == self._grid_avail):
            return
        self._grid_mode, self._grid_gap, self._grid_avail = mode, gap, avail

        pad = (0, gap)
        if mode == "fila":
            for col, key in enumerate(GRID_ORDER):
                self._blocks[key].grid(row=0, column=col, padx=pad, sticky="w")
                self._captions[key].grid(row=1, column=col, padx=pad, sticky="w")
            self._grid.columnconfigure(len(GRID_ORDER), weight=1)
            self._grid.columnconfigure(len(GRID_TOP), weight=0)
        else:
            for col, key in enumerate(GRID_TOP):
                self._blocks[key].grid(row=0, column=col, padx=pad, sticky="w")
                self._captions[key].grid(row=1, column=col, padx=pad, sticky="w")
            for col, key in enumerate(GRID_BOTTOM):
                self._blocks[key].grid(
                    row=2, column=col, padx=pad, pady=(GRID_ROW_GAP, 0),
                    sticky="w",
                )
                self._captions[key].grid(row=3, column=col, padx=pad, sticky="w")
            self._grid.columnconfigure(len(GRID_TOP), weight=1)
            self._grid.columnconfigure(len(GRID_ORDER), weight=0)
