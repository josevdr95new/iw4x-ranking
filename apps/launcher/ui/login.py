"""Pantalla de login/registro (email + password [+ displayName]).

Visual: terminal de acceso HUD — tarjeta con brackets de esquina, labels
mono en mayúsculas, acción única ámbar. Cero gradientes.

LOGIN COMPACTO (decisión del dueño): la columna completa (franja CONEXIÓN +
campos + botones + enlace "¿No tienes cuenta? Crear cuenta") cabe en la
geometría mínima (980x640) SIN maximizar ni scroll:
- paddings verticales reducidos;
- franja CONEXIÓN colapsable: la caption "// CONEXIÓN //" es clickeable y
  expande/colapsa el detalle (URL + PROBAR/GUARDAR + ruta del config);
  colapsada por defecto tras el primer éxito de conexión;
- si AUN así no cabe (pantallas <720px de alto), el contenido vive en un
  Canvas con Scrollbar vertical funcional (también con la rueda del ratón).

Franja CONEXIÓN (arriba del formulario): la API es editable y probable
ANTES de cualquier login — con la API mal configurada no se puede ni
entrar, así que el ajuste no puede vivir solo en Ajustes (tras login).
"""
from __future__ import annotations

import logging
import tkinter as tk
from typing import TYPE_CHECKING, Optional

import customtkinter as ctk

from api_client import ApiClient, ApiError, NetworkError
from app_config import config_path, normalize_api_url
from ui.hud import (
    BracketCard,
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
from ui.theme import COLORS, RADIUS, SP, font, section_text, tracked

if TYPE_CHECKING:  # evita import circular solo por tipado
    from ui.main_window import App

log = logging.getLogger("ui.login")

FIELD_W = 320
CONN_TIMEOUT = 3  # segundos: el test de /api/health no puede colgar el login
WHEEL_STEP = 3    # "unidades" de scroll por muesca de la rueda


class LoginFrame(ctk.CTkFrame):
    """Formulario de entrada; el enlace inferior alterna modo registro."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg_deep"])
        self.app = app
        self._register_mode = False
        self._busy = False  # petición de auth en vuelo (anti doble-submit)
        self._conn_expanded = False  # estado real tras el primer pack (abajo)
        self._scroll_active = False

        # --- Franja CONEXIÓN (ANTES de cualquier login) -----------------------
        # Fuera del área con scroll: siempre visible y accesible.
        self._build_conn_strip()

        # --- Área de contenido con scroll de emergencia -----------------------
        # Normalmente todo cabe (login compacto); en pantallas muy bajas el
        # Canvas habilita la Scrollbar + rueda del ratón.
        self._build_scroll_area()
        content = self._scroll_inner

        # --- Bloque de identidad (display) -----------------------------------
        ctk.CTkLabel(
            content, text=section_text("TERMINAL DE JUGADOR"),
            font=font(10, "bold", mono=True), text_color=COLORS["text_faint"],
        ).pack(pady=(SP["l"], SP["xs"]))
        ctk.CTkLabel(
            content, text=tracked("IW4X RANKING"), font=font(30, "bold", mono=True),
            text_color=COLORS["text"],
        ).pack()
        hairline(content, COLORS["accent_border"]).pack(
            fill="x", padx=120, pady=(SP["s"], SP["xs"])
        )
        ctk.CTkLabel(
            content, text="Entra con tu nick de jugador para jugar y vincular tu GUID",
            font=font(12), text_color=COLORS["text_dim"],
        ).pack(pady=(0, SP["xs"]))

        # --- Tarjeta HUD con brackets ----------------------------------------
        card = BracketCard(content, accent=True)
        card.pack(padx=SP["xl"], pady=(SP["xs"], 0))
        body = card.inner

        # Campos: NICK siempre visible (credencial de entrada); el EMAIL solo
        # existe al CREAR la cuenta (gestión), en su propia caja oculta.
        self.nick = self._make_entry(body, "jose")
        self.nick_caption = self._field(body, "NICK", self.nick, 0)
        self.password = self._make_entry(body, "••••••••", show="•")
        self._field(body, "CONTRASEÑA", self.password, 1)

        # Salida clara del registro (audit de navegación): fantasma "‹ VOLVER"
        # arriba de los campos, visible SOLO en modo CREAR CUENTA. Regresa al
        # login conservando lo tecleado (los campos son compartidos entre
        # modos). Fantasma a propósito: el ámbar es del CTA principal.
        self.back_btn = ghost_button(body, "‹ VOLVER", self._back_to_login, width=110)
        self.back_btn.pack(anchor="w", pady=(0, SP["xs"]), before=self.nick_caption)
        self.back_btn.pack_forget()

        # Estado (errores de validación/red) — va justo tras los campos.
        self.status = ctk.CTkLabel(
            body, text="", font=font(11), text_color=COLORS["danger"],
            wraplength=FIELD_W, justify="left", anchor="w",
        )
        self.status.pack(fill="x", padx=SP["l"], pady=(0, 0))

        self.email_box = ctk.CTkFrame(body, fg_color="transparent")
        self.email = self._make_entry(self.email_box, "jugador@ejemplo.com")
        self._field(self.email_box, "EMAIL", self.email, 0)
        # NOTA: pack(after=...) deja widgets gestionados pero sin mapear en
        # este árbol; 'before=status' es la posición determinista que sí mapea.
        self.email_box.pack(fill="x", before=self.status)
        self.email_box.pack_forget()  # visible solo en modo CREAR CUENTA

        self.action_btn = primary_button(
            body, "ENTRAR", self._on_submit, width=FIELD_W, height=44
        )
        self.action_btn.configure(font=font(14, "bold", mono=True))
        self.action_btn.pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))

        hairline(body).pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))

        self.toggle_link = ctk.CTkButton(
            body,
            text="¿No tienes cuenta? Crear cuenta",
            font=font(11),
            text_color=COLORS["text_dim"],
            fg_color="transparent",
            hover_color=COLORS["panel2"],
            corner_radius=RADIUS["btn"],
            command=self._toggle_mode,
        )
        self.toggle_link.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["s"]))

        # Enlace a la web del ranking (debajo de CREAR CUENTA): fantasma y
        # mono (estética de caption), SIN color de acción — el ámbar es solo
        # del CTA primario. Oculto si el config trae web_url vacía.
        self.web_link = ctk.CTkButton(
            body,
            text="RANKING WEB ↗",
            font=font(10, "bold", mono=True),
            text_color=COLORS["text_faint"],
            fg_color="transparent",
            hover_color=COLORS["panel2"],
            corner_radius=RADIUS["btn"],
            height=26,
            command=self.app.open_web,
        )
        if self.app.cfg.web_url:
            self.web_link.pack(fill="x", padx=SP["l"], pady=(0, SP["s"]))

        # Enter = enviar.
        for entry in (self.nick, self.password, self.email):
            entry.bind("<Return>", lambda _e: self._on_submit())

        # --- Foco de teclado + hover coherentes --------------------------------
        # Un solo lenguaje de foco: hairline ámbar tenue (accent_border) en
        # TODO elemento enfocable; el hover ámbar CLARO sigue reservado al CTA
        # primario (lo fija primary_button). El enlace inferior aclara su
        # texto al hover (dim → claro). Tab llega a los botones (CTk no los
        # hace enfocables por defecto).
        bind_flat_focus(self.action_btn)
        bind_flat_focus(self.toggle_link)
        bind_ghost_focus(self.back_btn)
        bind_ghost_focus(self.conn_test_btn)
        bind_ghost_focus(self.conn_save_btn)
        if self.app.cfg.web_url:
            bind_flat_focus(self.web_link)
            self.web_link.bind(
                "<Enter>", lambda _e: self.web_link.configure(
                    text_color=COLORS["text"]))
            self.web_link.bind(
                "<Leave>", lambda _e: self.web_link.configure(
                    text_color=COLORS["text_faint"]))
        for entry in (self.nick, self.password, self.email):
            bind_focus_hairline(entry, COLORS["border"], COLORS["accent_border"])
        bind_focus_hairline(
            self.conn_url_entry, COLORS["border_strong"], COLORS["accent_border"])
        self.toggle_link.bind(
            "<Enter>", lambda _e: self.toggle_link.configure(text_color=COLORS["text"]))
        self.toggle_link.bind(
            "<Leave>", lambda _e: self.toggle_link.configure(text_color=COLORS["text_dim"]))

        # Auto-test de la API al abrir el launcher (hilo de fondo: no
        # bloquea el render; el resultado llega por la cola de la App).
        self._conn_test()

    # ================== Franja CONEXIÓN (colapsable) ==================
    def _build_conn_strip(self) -> None:
        """Franja HUD con la dirección de la API: ver/probar/guardar sin login.

        Compacta: la caption "// CONEXIÓN //" es clickeable y expande/colapsa
        el detalle. Colapsada muestra solo el marcador + punto de estado.
        """
        strip = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=2)
        strip.pack(fill="x", padx=SP["l"], pady=(SP["s"], 0))
        self.conn_strip = strip
        inner = ctk.CTkFrame(strip, fg_color="transparent")
        inner.pack(fill="x", padx=SP["m"], pady=(SP["xs"], SP["xs"]))

        # Fila 1: marcador de sección (CLIC = expandir/colapsar) + punto.
        row1 = ctk.CTkFrame(inner, fg_color="transparent")
        row1.pack(fill="x")
        self.conn_caption = section_label(row1, "CONEXIÓN")
        self.conn_caption.configure(cursor="hand2")
        self.conn_caption.pack(side="left")
        self.conn_caption.bind("<Button-1>", lambda _e: self.toggle_conn())
        self.conn_state = ctk.CTkLabel(
            row1, text="● PROBANDO…", font=font(10, "bold", mono=True),
            text_color=COLORS["accent"], anchor="e",
        )
        self.conn_state.pack(side="right")

        # Fila 2: caption + URL (label → click → entry) + acciones.
        row2 = ctk.CTkFrame(inner, fg_color="transparent")
        ctk.CTkLabel(
            row2, text="API", font=font(9, "bold", mono=True),
            text_color=COLORS["text_dim"],
        ).pack(side="left")

        self.conn_url_entry = ctk.CTkEntry(
            row2, width=250, height=28, font=font(11, mono=True),
            fg_color=COLORS["panel2"], border_color=COLORS["border_strong"],
            text_color=COLORS["text"], corner_radius=RADIUS["input"],
        )
        # Label "editable inline": se muestra como texto; el click lo
        # cambia por un entry (ver _conn_edit). Empieza oculto.
        self.conn_url_entry.pack(side="left", padx=(SP["s"], 0), pady=2)
        self.conn_url_entry.pack_forget()

        self.conn_url_label = ctk.CTkLabel(
            row2, text=self.app.cfg.api_url, font=font(11, mono=True),
            text_color=COLORS["text"], cursor="hand2",
        )
        self.conn_url_label.pack(side="left", padx=(SP["s"], 0))
        self.conn_url_label.bind("<Button-1>", lambda _e: self._conn_edit())

        self.conn_test_btn = ghost_button(row2, "PROBAR", self._conn_on_test, width=90)
        self.conn_test_btn.pack(side="right", padx=(SP["s"], 0))
        self.conn_save_btn = ghost_button(row2, "GUARDAR", self._conn_save, width=100)
        self.conn_save_btn.pack(side="right")
        self.conn_row2 = row2  # se muestra/oculta con el colapso

        # Fila 3: ruta EXACTA del config (dim) para editarlo a mano.
        self.conn_path_label = ctk.CTkLabel(
            inner, text=f"config: {config_path()}", font=font(9, mono=True),
            text_color=COLORS["text_faint"], anchor="w",
        )
        self.conn_row3 = self.conn_path_label  # idem

        # Edición inline: Enter/FocusOut aplican (normalizando), Escape cancela.
        self.conn_url_entry.bind("<Return>", lambda _e: self._conn_commit())
        self.conn_url_entry.bind("<FocusOut>", lambda _e: self._conn_commit())
        self.conn_url_entry.bind("<Escape>", lambda _e: self._conn_cancel())

        # Estado inicial EXPANDIDO (la API puede estar mal: verla ayuda).
        self.set_conn_expanded(True)

    def set_conn_expanded(self, expanded: bool) -> None:
        """Muestra/oculta el detalle de la franja CONEXIÓN (URL + acciones).

        Colapsada queda solo la caption clickeable + punto de estado: la
        columna de login gana ~60px verticales. Es idempotente.
        """
        expanded = bool(expanded)
        if expanded == self._conn_expanded:
            return
        self._conn_expanded = expanded
        if expanded:
            self.conn_row2.pack(fill="x", pady=(SP["xs"], 0))
            self.conn_row3.pack(fill="x", pady=(SP["xs"], 0))
        else:
            self.conn_row2.pack_forget()
            self.conn_row3.pack_forget()
            # El contenido se acorta: volver arriba para ver el formulario.
            self.reset_scroll()

    def toggle_conn(self) -> None:
        """Click en la caption: alterna el detalle de la franja."""
        self.set_conn_expanded(not self._conn_expanded)

    # --- Estado del punto -----------------------------------------------------
    def _conn_set_state(self, kind: str, text: Optional[str] = None) -> None:
        """Pinta el punto: accent=probando, ok=conectado, danger=sin conexión."""
        color = {"test": COLORS["accent"], "ok": COLORS["ok"],
                 "fail": COLORS["danger"]}.get(kind, COLORS["text_dim"])
        default = {"test": "● PROBANDO…", "ok": "● CONECTADO ✓ /api/health",
                   "fail": "● SIN CONEXIÓN — revisa la IP"}.get(kind, "")
        self.conn_state.configure(text=text or default, text_color=color)

    # --- URL mostrada / edición inline -----------------------------------------
    def conn_url_text(self) -> str:
        """URL de la API visible ahora (entry si está editando, si no label)."""
        if self.conn_url_entry.winfo_ismapped():
            return self.conn_url_entry.get().strip()
        return str(self.conn_url_label.cget("text")).strip()

    def _conn_edit(self) -> None:
        """Click en la URL → entry editable inline con la URL actual."""
        if not self._conn_expanded:
            self.set_conn_expanded(True)
        if self.conn_url_entry.winfo_ismapped():
            return
        self.conn_url_entry.delete(0, "end")
        self.conn_url_entry.insert(0, str(self.conn_url_label.cget("text")))
        self.conn_url_label.pack_forget()
        self.conn_url_entry.pack(side="left", padx=(SP["s"], 0), pady=2)
        self.conn_url_entry.focus_set()
        self.conn_url_entry.icursor("end")

    def _conn_commit(self) -> None:
        """Fin de edición: normaliza y vuelve al modo texto (sin guardar)."""
        if not self.conn_url_entry.winfo_ismapped():
            return
        url = normalize_api_url(self.conn_url_entry.get())
        self.conn_url_label.configure(text=url)
        self.conn_url_entry.pack_forget()
        self.conn_url_label.pack(side="left", padx=(SP["s"], 0))

    def _conn_cancel(self) -> None:
        """Escape: descarta lo tecleado y restaura el texto previo."""
        self.conn_url_entry.pack_forget()
        self.conn_url_label.pack(side="left", padx=(SP["s"], 0))

    # --- Probar / guardar -------------------------------------------------------
    def _conn_on_test(self) -> None:
        """PROBAR: normaliza lo mostrado y lanza el test en hilo de fondo."""
        self._conn_commit()  # cierra el editor inline si estaba abierto
        self._conn_test(self.conn_url_text())

    def _conn_test(self, base: Optional[str] = None, initiator: str = "test") -> None:
        """GET {api}/api/health (timeout 3s) y actualiza el punto de estado.

        ``initiator`` elige el label de progreso del botón que lanzó el test
        (PROBAR → "PROBANDO…"; GUARDAR → "GUARDANDO…"). El otro botón se
        deshabilita sin cambiar su label. Tras el PRIMER éxito la franja se
        colapsa sola (login compacto; la caption la reabre con un click).
        """
        url = normalize_api_url(base if base is not None else self.app.cfg.api_url)
        self.conn_url_label.configure(text=url)
        self._conn_set_state("test")
        self._conn_buttons(False, initiator=initiator)

        def ok(_data) -> None:
            self._conn_set_state("ok")
            self._conn_buttons(True)
            self.set_conn_expanded(False)  # primer éxito → colapsada

        def fail(_exc: Exception) -> None:
            self._conn_set_state("fail")
            self._conn_buttons(True)
            self.set_conn_expanded(True)  # sin conexión: el detalle visible
            log.info("Test de conexión falló contra %s", url)

        # Cliente dedicado: timeout corto para no colgar la pantalla.
        self.app.run_bg(ApiClient(url, timeout=CONN_TIMEOUT).health,
                        on_ok=ok, on_err=fail)

    def _conn_save(self) -> None:
        """GUARDAR: persiste la URL en launcher.config.json y re-prueba."""
        self._conn_commit()  # cierra el editor inline si estaba abierto
        url = normalize_api_url(self.conn_url_text())
        self.app.cfg.set("api_url", url)
        self.app.cfg.save()
        self.app.apply_api_url(url)
        self.conn_url_label.configure(text=url)
        log.info("api_url guardada desde login: %s", url)
        self._conn_test(url, initiator="save")

    def _conn_buttons(self, enabled: bool, initiator: str = "test") -> None:
        """En vuelo: ambos deshabilitados + label de progreso; luego reposo.

        El label de progreso es más largo que el de reposo: se ensancha el
        botón en vuelo (set_button_busy) y el ancho vuelve al restaurar.
        """
        if enabled:
            set_button_idle(self.conn_test_btn, "PROBAR")
            set_button_idle(self.conn_save_btn, "GUARDAR")
        elif initiator == "save":
            set_button_busy(self.conn_test_btn, "PROBAR")
            set_button_busy(self.conn_save_btn, "GUARDANDO…", width=122)
        else:
            set_button_busy(self.conn_test_btn, "PROBANDO…", width=112)
            set_button_busy(self.conn_save_btn, "GUARDAR")

    # ================== Área de contenido (scroll de emergencia) ==========
    def _build_scroll_area(self) -> None:
        """Canvas + Scrollbar vertical para pantallas MUY bajas (<720px).

        La columna de login cabe en la geometría mínima (980x640) sin
        scroll; si la ventana se acorta más que el contenido, aparece la
        Scrollbar (y la rueda del ratón hace scroll en toda el área).
        """
        self._canvas = tk.Canvas(
            self, bg=COLORS["bg_deep"], highlightthickness=0, bd=0,
        )
        self._vbar = ctk.CTkScrollbar(self, command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=self._vbar.set)
        self._canvas.pack(side="left", fill="both", expand=True)
        self._scroll_inner = ctk.CTkFrame(self._canvas, fg_color="transparent")
        self._canvas_window = self._canvas.create_window(
            (0, 0), window=self._scroll_inner, anchor="nw",
        )
        self._scroll_inner.bind("<Configure>", lambda _e: self._sync_scroll())
        self._canvas.bind("<Configure>", lambda _e: self._sync_scroll())
        # Rueda del ratón: bind_all (vía el Canvas tk plano — CTk no permite
        # bind_all en sus widgets) con guard: solo actúa con el login en
        # pantalla; el resto de widgets (consola de la home) conservan su
        # scroll propio.
        self._canvas.bind_all("<MouseWheel>", self._on_wheel, add="+")

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
        """Rueda del ratón sobre el login (ignorada si no está en pantalla)."""
        if self.app.current_frame is not self or not self._scroll_active:
            return
        step = -WHEEL_STEP if event.delta > 0 else WHEEL_STEP
        self._canvas.yview_scroll(step, "units")

    def reset_scroll(self) -> None:
        """Vuelve arriba (al mostrar la pantalla o al colapsar la CONEXIÓN)."""
        try:
            self._canvas.yview_moveto(0)
        except Exception:
            pass

    # --- Constructores de campo (entry HUD) ---------------------------------
    @staticmethod
    def _make_entry(parent, placeholder: str, show: str = "") -> ctk.CTkEntry:
        return ctk.CTkEntry(
            parent, width=FIELD_W, height=38, placeholder_text=placeholder,
            show=show, font=font(12),
            fg_color=COLORS["panel2"], border_color=COLORS["border"],
            text_color=COLORS["text"], corner_radius=RADIUS["input"],
        )

    def _field(self, parent, caption: str, entry, row: int):
        """Caption mono + entry; devuelve el caption para poder ocultarlo."""
        caption_label = ctk.CTkLabel(
            parent, text=caption, font=font(9, "bold", mono=True),
            text_color=COLORS["text_dim"], anchor="w",
        )
        caption_label.pack(fill="x", padx=SP["l"],
                           pady=((SP["s"] if row == 0 else SP["xs"]), 2))
        entry.pack(fill="x", padx=SP["l"])
        return caption_label

    # --- Comportamiento ---------------------------------------------------------
    def _toggle_mode(self) -> None:
        """Alterna entre login (solo NICK) y creación (EMAIL + NICK + clave).

        NUNCA borra campos: entrar en registro y arrepentirse no pierde el
        nick ya tecleado en el login.
        """
        self._register_mode = not self._register_mode
        if self._register_mode:
            self.action_btn.configure(text="CREAR CUENTA")
            # Salida clara del registro: VOLVER arriba; el enlace inferior se
            # retira para que exista UNA única ruta de retorno visible.
            self.back_btn.pack(anchor="w", pady=(0, SP["xs"]),
                              before=self.nick_caption)
            self.toggle_link.pack_forget()
            # El email reaparece justo antes de la línea de estado.
            self.email_box.pack(fill="x", before=self.status)
        else:
            self.action_btn.configure(text="ENTRAR")
            self.toggle_link.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["s"]))
            self.back_btn.pack_forget()
            self.email_box.pack_forget()
        self.status.configure(text="")
        self._sync_scroll()
        self.reset_scroll()

    def _back_to_login(self) -> None:
        """‹ VOLVER (solo en registro): vuelve al login conservando campos."""
        if self._busy:
            return
        if self._register_mode:
            self._toggle_mode()

    def _on_submit(self) -> None:
        """Valida el formulario y delega en App (petición en hilo de fondo).

        Anti doble-submit: con una petición en vuelo ni el botón ni Enter
        disparan otra — evita cuentas duplicadas por doble-click.
        """
        if self._busy:
            return
        nick = self.nick.get().strip()
        password = self.password.get()
        if self._register_mode:
            email = self.email.get().strip()
            # En el registro el nick ES el nombre visible de la cuenta.
            if not email or not nick or not password:
                self.status.configure(
                    text="Rellena email, nick y contraseña.",
                    text_color=COLORS["warn"],
                )
                return
            self.app.register(email, password, nick, self._on_result)
        else:
            if not nick or not password:
                self.status.configure(
                    text="Introduce tu nick y contraseña.", text_color=COLORS["warn"]
                )
                return
            self.app.login(nick, password, self._on_result)

        self._busy = True
        set_button_busy(self.action_btn,
                        "CREANDO…" if self._register_mode else "ENTRANDO…")
        self.status.configure(text="")

    def _on_result(self, error=None) -> None:
        """Callback desde el hilo principal tras la petición de auth."""
        self._busy = False
        set_button_idle(self.action_btn,
                        "CREAR CUENTA" if self._register_mode else "ENTRAR")
        if error is None:
            self.status.configure(text="")
            return
        # Mensajes de error claros según el envelope de la API.
        if isinstance(error, ApiError):
            msg = error.message
            if error.code == "INVALID_CREDENTIALS":
                msg = "Email o contraseña incorrectos."
            elif error.code == "EMAIL_TAKEN":
                msg = "Ese email ya tiene una cuenta. Inicia sesión."
            elif error.code == "VALIDATION_ERROR":
                msg = "Datos inválidos: la contraseña necesita 8–72 caracteres "
                msg += "y el nombre 3–32."
        else:  # NetworkError: timeout / conexión rechazada / API caída.
            msg = str(error)
            msg += (f"\nRevisa la CONEXIÓN arriba — hoy apunta a "
                    f"{self.app.cfg.api_url}")
        self.status.configure(text=msg, text_color=COLORS["danger"])
        log.info("Fallo de autenticación en pantalla login: %s", msg)
