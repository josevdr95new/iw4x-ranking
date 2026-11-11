"""Panel "// TUS STATS //" en vivo de la pantalla principal.

Muestra rank/lvl/kills/deaths/headshots/k/d + MEDALLA (medallón del tier
con su nombre), último server y nombre actual del jugador (con el ratio de
headshots, el ELO del perfil y el balance de cuchillo en la línea de
detalle, más las estrellas de progreso). El LVL es el nivel REAL del
juego, parseado del iw4x.stat subido a la nube (el perfil
trae save: {level, prestige, ...} | null). Los datos los trae App
(GET /api/players/:guid cada 30s o con el botón ↻); este panel solo pinta y
lleva el contador de edad ("hace 12s"). El perfil puede no traer aún el
campo medal (backend a medallas en despliegue) → '—' hasta el próximo ciclo.

El color del K/D sigue los umbrales del diseño (docs/DESIGN.md §1.1):
≥ 1,20 verde · 1,00–1,19 neutro · 0,80–0,99 ámbar · < 0,80 rojo.
Si la cuenta no tiene GUID vinculado, muestra el CTA y detiene timers.
"""
from __future__ import annotations

import logging
import time
import tkinter as tk
from typing import Any, Dict, List, Optional, Tuple

import customtkinter as ctk

from ui.hud import bind_ghost_focus, hairline
from ui.theme import (COLORS, MEDAL_TIER_COLORS, RADIUS, SP, asset_path,
                      font)

log = logging.getLogger("ui.stats")

# --- Grid de valores (medido, SIN solape) -----------------------------------
# Bug del dueño: los captions se leían "DEATHSHEADSHOTSK/D". Causa real: el
# padx separador estaba SOLO en el valor; cuando la caption era más ancha
# que el número de arriba (DEATHS/HEADSHOTS con valores cortos) la columna
# media justo lo que ocupa el texto y las captions quedaban pegadas.
# Fix en tres piezas:
#   1. el padx separador va también en la caption;
#   2. fuentes reducidas 18→16 (valores) y 9→8 (captions);
#   3. layout MEDIDO (no a ojo): los bloques van en UNA fila solo si la
#      suma de anchos requeridos (métrica real de fuente) + huecos cabe en
#      el ancho REAL del panel (winfo_width); si no, dos filas
#      (RANK/LVL/KILLS/DEATHS arriba · HEADSHOTS/K/D/MEDALLA abajo).
# La 7ª clave "medal" participa de la MISMA medición: su columna vale
# max(caption, medallón + aire + nombre del tier) → ver _column_need.
GRID_VALUE_SIZE = 16
GRID_CAPTION_SIZE = 8
GRID_ORDER: Tuple[str, ...] = (
    "rank", "lvl", "kills", "deaths", "hs", "kd", "medal",
)
GRID_TOP: Tuple[str, ...] = ("rank", "lvl", "kills", "deaths")
GRID_BOTTOM: Tuple[str, ...] = ("hs", "kd", "medal")
GRID_ROW_GAP = SP["m"]  # aire vertical entre filas en modo 2 filas
MEDAL_IMG_H = 50  # alto OBJETIVO del medallón en px (subsample entero: sale ~51)


def _fmt_int(value: Any) -> str:
    """Entero con separador de miles estilo es-ES; '—' si no hay dato."""
    try:
        return f"{int(value):,}".replace(",", ".")
    except (TypeError, ValueError):
        return "—"


def medal_detail_parts(medal: Any) -> Tuple[str, str, str, str]:
    """Partes del segmento MEDALLA de la línea de detalle (pura, testeable).

    Contrato player["medal"]: {tierId 1-8, name, assetId, stars 1-5|null
    (null SOLO tier 8), globalRank int|null, eliteTop12 bool} | null.

    Devuelve (llenas, vacías, texto, tipo):
      - tiers 1-7 → tipo 'estrellas': llenas='★'*stars, vacías='☆'*(5-stars);
        eliteTop12 añade ' · TOP 12' detrás de las vacías.
      - tier 8 → tipo 'leyenda': texto 'LEYENDA #<globalRank>' en ámbar
        (el caller decide el color); sin rank válido → solo el nombre.
      - medal null/ausente/ilegible → tipo 'vacio': el caller pinta '—'
        (convención del panel para dato que aún no llega).
    """
    if not isinstance(medal, dict):
        return ("", "", "—", "vacio")
    try:
        tier = int(medal.get("tierId"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ("", "", "—", "vacio")
    elite = " · TOP 12" if bool(medal.get("eliteTop12")) else ""
    if tier == 8:
        name = str(medal.get("name") or "LEYENDA")
        try:
            text = f"{name} #{int(medal.get('globalRank'))}"  # type: ignore[arg-type]
        except (TypeError, ValueError):
            text = name
        return ("", "", text + elite, "leyenda")
    try:
        stars = int(medal.get("stars"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        stars = 0  # contrato: null solo en tier 8; defenso → 0 llenas
    stars = max(0, min(5, stars))
    empty = "☆" * (5 - stars)
    if elite:
        empty = (empty + elite).lstrip()
    return ("★" * stars, empty, "", "estrellas")


def _fmt_kd(value: Any) -> str:
    try:
        return f"{float(value):.2f}".replace(".", ",")
    except (TypeError, ValueError):
        return "—"


def _fmt_elo(value: Any) -> str:
    """ELO del perfil SIN separador de miles ('1234'); '—' si no hay dato."""
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return "—"


def _fmt_knife(kills: Any, deaths: Any) -> str:
    """Balance de cuchillo como '2/1' (bajas/muertes); '—' si falta
    cualquiera de los dos datos (convención del panel)."""
    try:
        return f"{int(kills)}/{int(deaths)}"
    except (TypeError, ValueError):
        return "—"


def _fmt_lvl(save: Any) -> str:
    """Nivel REAL del juego (save parseado en la nube): '47', o '47·P2' con
    prestigio. '—' si no hay save o el nivel no es utilizable (defensivo:
    la API puede responder aún sin campo save o sin parsear)."""
    if not isinstance(save, dict):
        return "—"
    try:
        level = int(save.get("level"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "—"
    try:
        prestige = int(save.get("prestige") or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        prestige = 0
    return f"{level}·P{prestige}" if prestige > 0 else str(level)


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
        self._blocks: Dict[str, Any] = {}  # CTkLabel (valores) + marco medalla
        self._captions: Dict[str, ctk.CTkLabel] = {}
        specs = [
            ("rank", "RANK", COLORS["ok"]),
            ("lvl", "LVL", COLORS["text"]),
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
        # 7ª clave MEDALLA: el valor es un MARCO (medallón PNG ~50px +
        # nombre del tier en mono pequeño EN SU COLOR de metal), no un
        # label de texto — por eso _column_need la mide a mano y
        # _reset_values la salta.
        self._medal_name_font = font(10, mono=True)
        medal_value = ctk.CTkFrame(self._grid, fg_color="transparent")
        self._medal_img = ctk.CTkLabel(
            medal_value, text="—", font=self._value_font,
            text_color=COLORS["text_faint"], anchor="w",
        )
        self._medal_img.pack(side="left")
        self._medal_name = ctk.CTkLabel(
            medal_value, text="", font=self._medal_name_font,
            text_color=COLORS["text_dim"], anchor="w",
        )
        self._medal_name.pack(side="left", padx=(SP["s"], 0))
        self._blocks["medal"] = medal_value
        self._captions["medal"] = ctk.CTkLabel(
            self._grid, text="MEDALLA", font=self._caption_font,
            text_color=COLORS["text_faint"], anchor="w",
        )
        # Caché de PhotoImage por assetId: Tk borra la imagen si el GC
        # recolecta el objeto Python, así que se retienen aquí.
        self._medal_photos: Dict[str, tk.PhotoImage] = {}
        self._medal_photo: Optional[tk.PhotoImage] = None
        # Estado del layout (para no recolocar si nada cambió).
        self._grid_mode: Optional[str] = None   # "fila" | "dos_filas"
        self._grid_gap: int = -1
        self._grid_avail: int = -1
        # Decisión 1↔2 filas sobre el ancho REAL: al mapear/redimensionar el
        # panel y cada vez que cambian los valores. El bind del frame del grid
        # cubre el desfase de un evento: el <Configure> del panel dispara
        # ANTES de que el hijo se haya reajustado (winfo_width viejo).
        self.bind("<Configure>", lambda _e: self._relayout_grid())
        self._grid.bind("<Configure>", lambda _e: self._relayout_grid())
        self._relayout_grid()

        hairline(self).pack(fill="x", padx=SP["l"], pady=(SP["xs"], 0))

        # --- Fila secundaria ---------------------------------------------------
        self.sub_label = ctk.CTkLabel(
            self, text="", font=font(10, mono=True),
            text_color=COLORS["text_dim"], anchor="w", justify="left",
            wraplength=620,
        )
        self.sub_label.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["m"]))

        # --- Segmento MEDALLA de la línea de detalle ---------------------------
        # 5 estrellas ★/☆ (tiers 1-7, llena ámbar/vacía dim como los PNG
        # star-full/star-empty) o 'LEYENDA #N · TOP 12' en ámbar (tier 8);
        # '—' si el perfil aún no trae medalla. CTkLabel no pinta multi-color
        # en un solo texto → fila propia debajo del detalle, mismo estilo.
        self._medal_detail = ctk.CTkFrame(self, fg_color="transparent")
        self._stars_full = ctk.CTkLabel(
            self._medal_detail, text="", font=font(11, mono=True),
            text_color=COLORS["accent"],  # #E8930C = star-full.png
        )
        self._stars_empty = ctk.CTkLabel(
            self._medal_detail, text="", font=font(11, mono=True),
            text_color=COLORS["border_strong"],  # #3B443E = star-empty.png
        )
        self._medal_text = ctk.CTkLabel(
            self._medal_detail, text="—", font=font(10, mono=True),
            text_color=COLORS["text_faint"],
        )
        for col, lbl in enumerate(
                (self._stars_full, self._stars_empty, self._medal_text)):
            lbl.grid(row=0, column=col, sticky="w")
            lbl.grid_remove()

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

    def set_values(self, player: Dict[str, Any], rank: Any, last_server: Any,
                   save: Any = None) -> None:
        """Pinta una respuesta correcta de GET /api/players/:guid.

        ``save`` es el nivel REAL parseado del iw4x.stat en la nube
        ({level, prestige, xp, parsedAt}) o None si aún no hay save; los
        perfiles viejos sin el campo llegan como None (misma ruta defensiva).
        ``player`` puede traer ``medal`` (contrato de medallas) | null |
        ausente → bloque '—' y detalle '—' sin crash (llega en el próximo
        ciclo de 30s cuando el backend lo sirva).
        """
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
        # LVL real: del save en la nube (no de las partidas). Caption dinámica
        # (dim por defecto, text_faint): solo señala la fuente cuando hay
        # nivel parseado — "LVL" solo, "LVL·SAVE" con save (misma convención
        # compacta del K/D; sin colores nuevos).
        lvl_text = _fmt_lvl(save)
        self._blocks["lvl"].configure(text=lvl_text)
        self._captions["lvl"].configure(
            text="LVL·SAVE" if lvl_text != "—" else "LVL"
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
        # ELO (player.skill, el MISMO número que decide la medalla, 150–2500):
        # 'ELO 1234' junto al HS; '—' si el perfil aún no trae el campo.
        elo = _fmt_elo(player.get("skill"))
        # Cuchillo (knifeKills/knifeDeaths del perfil, como en la web):
        # 'CUCHILLO 2/1'; '—' si falta cualquiera de los dos datos.
        knife = _fmt_knife(player.get("knifeKills"), player.get("knifeDeaths"))
        self.sub_label.configure(
            text=f"TIEMPO {_fmt_time(player.get('timePlayed'))}"
                 f"   //   ULT. SERVER {server}"
                 f"   //   JUGADOR {name}"
                 f"   //   HS {hs_ratio} de bajas"
                 f"   //   ELO {elo}"
                 f"   //   CUCHILLO {knife}"
        )
        # MEDALLA (player["medal"] | null): defensivo — perfiles viejos o
        # backend a medias aún sin el campo → '—' en bloque y detalle; en el
        # próximo ciclo de 30s vuelve a intentarlo con el campo presente.
        medal = player.get("medal")
        self._render_medal_block(medal if isinstance(medal, dict) else None)
        self._render_medal_detail(medal if isinstance(medal, dict) else None)
        # Reinicia el contador de edad y arranca el ticker de 1s.
        self._last_ok = time.monotonic()
        self.age_label.configure(text="hace 0s")
        self._start_age_ticker()
        # Los valores cambiaron: re-decidir 1↔2 filas con los anchos nuevos.
        self._relayout_grid()

    # ================== Medalla (bloque del grid + detalle) ==================
    def _get_medal_photo(self, asset_id: str) -> Optional[tk.PhotoImage]:
        """PhotoImage del medallón a ~50px (PNG 512×512 subsampleado).

        Los assets son decorativos: si el archivo falta (exe viejo sin la
        carpeta medals, assetId desconocido) devuelve None y el bloque cae
        a '—' sin crash. Sin PIL en runtime: Tk 8.6 lee PNG nativo y
        subsamplea por factor entero (factor 10 sobre 512 → ~51×51).
        """
        cached = self._medal_photos.get(asset_id)
        if cached is not None:
            return cached
        try:
            photo = tk.PhotoImage(file=str(asset_path(f"medals/{asset_id}.png")))
        except Exception:  # noqa: BLE001 — TclError (falta/formato)
            return None
        try:
            factor = max(1, round(photo.width() / MEDAL_IMG_H))
            if factor > 1:
                photo = photo.subsample(factor)
        except Exception:  # noqa: BLE001 — deja el original (decorativo)
            pass
        self._medal_photos[asset_id] = photo
        return photo

    def _render_medal_block(self, medal: Optional[Dict[str, Any]]) -> None:
        """Bloque del grid: imagen del medallón + nombre del tier al lado,
        EN EL COLOR del metal del tier (MEDAL_TIER_COLORS, tokens de
        make_medals.py) — la medalla se lee de un vistazo aunque sea
        pequeña. Sin nombre el label se retira (sin gap fantasma: lo que
        se renderiza es exactamente lo que mide _column_need)."""
        asset_id = str(medal.get("assetId") or "") if medal else ""
        name = str(medal.get("name") or "") if medal else ""
        photo = self._get_medal_photo(asset_id) if asset_id else None
        self._medal_photo = photo
        if photo is not None:
            self._medal_img.configure(image=photo, text="")
        else:
            # image="" (no None): CTkLabel no baja la imagen interna con None.
            self._medal_img.configure(image="", text="—")
        # Nombre en el METAL del tier (defensivo: tier desconocido → dim).
        try:
            name_color = MEDAL_TIER_COLORS[int(medal.get("tierId"))] if medal \
                else COLORS["text_dim"]
        except (KeyError, TypeError, ValueError):
            name_color = COLORS["text_dim"]
        self._medal_name.configure(text=name, text_color=name_color)
        if name:
            self._medal_name.pack(side="left", padx=(SP["s"], 0))
        else:
            self._medal_name.pack_forget()

    def _render_medal_detail(self, medal: Optional[Dict[str, Any]]) -> None:
        """Segmento de la línea de detalle según medal_detail_parts()."""
        full, empty, text, kind = medal_detail_parts(medal)
        if kind == "estrellas":
            self._medal_text.grid_remove()
            self._stars_full.configure(text=full)
            self._stars_empty.configure(text=empty)
            self._stars_full.grid()
            self._stars_empty.grid()
        else:
            self._stars_full.grid_remove()
            self._stars_empty.grid_remove()
            self._medal_text.configure(
                text=text,
                text_color=(COLORS["accent"] if kind == "leyenda"
                            else COLORS["text_faint"]),
            )
            self._medal_text.grid()
        self._set_medal_detail_visible(True)

    def _set_medal_detail_visible(self, visible: bool) -> None:
        """La fila del segmento medalla se añade/quita SIN dejar hueco: el
        margen inferior del panel vive aquí (sub_label lo cede al mostrarse)."""
        if visible:
            self._medal_detail.pack(
                fill="x", padx=SP["l"], pady=(SP["xs"], SP["m"]),
                after=self.sub_label,
            )
            self.sub_label.pack_configure(pady=(SP["xs"], 0))
        else:
            self._medal_detail.pack_forget()
            self.sub_label.pack_configure(pady=(SP["xs"], SP["m"]))

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
            "rank": COLORS["ok"], "lvl": COLORS["text"],
            "kills": COLORS["text"], "deaths": COLORS["text"],
            "hs": COLORS["text"], "kd": COLORS["text"],
        }
        for key, block in self._blocks.items():
            if key == "medal":
                continue  # marco (imagen+nombre): se resetea abajo a mano
            block.configure(text="—", text_color=default_colors[key])
        self._captions["lvl"].configure(text="LVL")
        self._medal_photo = None
        self._medal_img.configure(image="", text="—")
        self._medal_name.configure(text="")
        for lbl in (self._stars_full, self._stars_empty, self._medal_text):
            lbl.grid_remove()
        self._set_medal_detail_visible(False)
        self._relayout_grid()

    # ================== Layout medido del grid ==================
    def _column_need(self, key: str) -> int:
        """Ancho mínimo (px) de la columna ``key``: máx. entre su valor y su
        caption, medido con la métrica REAL de la fuente (no estimado)."""
        caption_text = str(self._captions[key].cget("text"))
        cap_w = self._caption_font.measure(caption_text)
        if key == "medal":
            # Valor = medallón (~50px) + aire + nombre del tier en mono
            # pequeño. La métrica de fuente queda corta (CTkLabel añade
            # padding interno escalado: 40px medidos → 64px render), así que
            # se usa el ancho PEDIDO del marco (winfo_reqwidth, exacto y
            # válido antes de mapear) y la métrica queda de respaldo para
            # el primer ciclo antes de que CTk dimensione el canvas.
            name_text = str(self._medal_name.cget("text"))
            if self._medal_photo is not None:
                est = MEDAL_IMG_H
                if name_text:
                    est += SP["s"] + self._medal_name_font.measure(name_text)
            else:
                est = self._value_font.measure("—")
            req_w = self._blocks["medal"].winfo_reqwidth()
            return max(cap_w, est, req_w if req_w > 1 else 0)
        value_text = str(self._blocks[key].cget("text"))
        return max(self._value_font.measure(value_text), cap_w)

    def _row_need(self, keys, gap: int) -> int:
        """Ancho total (px) que pide una fila: sumas + huecos entre columnas."""
        needs = [self._column_need(k) for k in keys]
        return sum(needs) + gap * max(0, len(needs) - 1)

    def _relayout_grid(self) -> None:
        """Coloca los 7 bloques en UNA fila si caben MEDIDOS en el ancho real
        del panel; si no, en dos filas (RANK/LVL/KILLS/DEATHS ·
        HEADSHOTS/K/D/MEDALLA). MEDALLA participa de la misma medición vía
        _column_need (medallón + nombre del tier ≈ 36+8+nombre).

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
