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
from typing import Any, Dict, Optional

import customtkinter as ctk

from ui.hud import bind_ghost_focus, hairline
from ui.theme import COLORS, RADIUS, SP, font

log = logging.getLogger("ui.stats")


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
        grid = ctk.CTkFrame(self, fg_color="transparent")
        grid.pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))
        self._blocks: Dict[str, ctk.CTkLabel] = {}
        specs = [
            ("rank", "RANK", 24, COLORS["ok"]),
            ("kills", "KILLS", 18, COLORS["text"]),
            ("deaths", "DEATHS", 18, COLORS["text"]),
            ("hs", "HEADSHOTS", 18, COLORS["text"]),
            ("kd", "K/D", 18, COLORS["text"]),
        ]
        for col, (key, caption, size, color) in enumerate(specs):
            value = ctk.CTkLabel(
                grid, text="—", font=font(size, "bold", mono=True),
                text_color=color, anchor="w",
            )
            value.grid(row=0, column=col, padx=(0, SP["xl"]), sticky="w")
            ctk.CTkLabel(
                grid, text=caption, font=font(9, "bold"),
                text_color=COLORS["text_faint"], anchor="w",
            ).grid(row=1, column=col, sticky="w")
            self._blocks[key] = value
        grid.columnconfigure(len(specs), weight=1)

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
        """Cuenta SIN vincular: CTA en lugar de números; timers detenidos."""
        self.stop_timers()
        self._last_ok = None
        self.age_label.configure(text="")
        self.status_label.configure(
            text="Dale JUGAR para verificar tu identidad — tus stats aparecerán aquí",
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
