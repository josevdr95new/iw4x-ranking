"""Pantalla de login/registro (email + password [+ displayName]).

Visual: terminal de acceso HUD — tarjeta con brackets de esquina, labels
mono en mayúsculas, acción única ámbar. Cero gradientes.

Franja CONEXIÓN (arriba del formulario): la API es editable y probable
ANTES de cualquier login — con la API mal configurada no se puede ni
entrar, así que el ajuste no puede vivir solo en Ajustes (tras login).
"""
from __future__ import annotations

import logging
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


class LoginFrame(ctk.CTkFrame):
    """Formulario de entrada; el enlace inferior alterna modo registro."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg_deep"])
        self.app = app
        self._register_mode = False
        self._busy = False  # petición de auth en vuelo (anti doble-submit)

        # --- Franja CONEXIÓN (ANTES de cualquier login) -----------------------
        self._build_conn_strip()

        # --- Bloque de identidad (display) -----------------------------------
        ctk.CTkLabel(
            self, text=section_text("TERMINAL DE JUGADOR"),
            font=font(10, "bold", mono=True), text_color=COLORS["text_faint"],
        ).pack(pady=(SP["xl"], SP["s"]))
        ctk.CTkLabel(
            self, text=tracked("IW4X RANKING"), font=font(30, "bold", mono=True),
            text_color=COLORS["text"],
        ).pack()
        hairline(self, COLORS["accent_border"]).pack(
            fill="x", padx=120, pady=(SP["m"], SP["s"])
        )
        ctk.CTkLabel(
            self, text="Entra con tu nick de jugador para jugar y vincular tu GUID",
            font=font(12), text_color=COLORS["text_dim"],
        ).pack(pady=(0, SP["s"]))

        # --- Tarjeta HUD con brackets ----------------------------------------
        card = BracketCard(self, accent=True)
        card.pack(padx=SP["xl"], pady=SP["s"])
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
        self.action_btn.pack(fill="x", padx=SP["l"], pady=(SP["m"], 0))

        hairline(body).pack(fill="x", padx=SP["l"], pady=(SP["m"], 0))

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
        self.toggle_link.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["m"]))

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

    # ================== Franja CONEXIÓN ==================
    def _build_conn_strip(self) -> None:
        """Franja HUD con la dirección de la API: ver/probar/guardar sin login."""
        strip = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=2)
        strip.pack(fill="x", padx=SP["l"], pady=(SP["l"], 0))
        self.conn_strip = strip
        inner = ctk.CTkFrame(strip, fg_color="transparent")
        inner.pack(fill="x", padx=SP["m"], pady=(SP["s"], SP["s"]))

        # Fila 1: marcador de sección + punto de estado.
        row1 = ctk.CTkFrame(inner, fg_color="transparent")
        row1.pack(fill="x")
        section_label(row1, "CONEXIÓN").pack(side="left")
        self.conn_state = ctk.CTkLabel(
            row1, text="● PROBANDO…", font=font(10, "bold", mono=True),
            text_color=COLORS["accent"], anchor="e",
        )
        self.conn_state.pack(side="right")

        # Fila 2: caption + URL (label → click → entry) + acciones.
        row2 = ctk.CTkFrame(inner, fg_color="transparent")
        row2.pack(fill="x", pady=(SP["xs"], 0))
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

        # Fila 3: ruta EXACTA del config (dim) para editarlo a mano.
        self.conn_path_label = ctk.CTkLabel(
            inner, text=f"config: {config_path()}", font=font(9, mono=True),
            text_color=COLORS["text_faint"], anchor="w",
        )
        self.conn_path_label.pack(fill="x", pady=(SP["xs"], 0))

        # Edición inline: Enter/FocusOut aplican (normalizando), Escape cancela.
        self.conn_url_entry.bind("<Return>", lambda _e: self._conn_commit())
        self.conn_url_entry.bind("<FocusOut>", lambda _e: self._conn_commit())
        self.conn_url_entry.bind("<Escape>", lambda _e: self._conn_cancel())

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
        deshabilita sin cambiar su label.
        """
        url = normalize_api_url(base if base is not None else self.app.cfg.api_url)
        self.conn_url_label.configure(text=url)
        self._conn_set_state("test")
        self._conn_buttons(False, initiator=initiator)

        def ok(_data) -> None:
            self._conn_set_state("ok")
            self._conn_buttons(True)

        def fail(_exc: Exception) -> None:
            self._conn_set_state("fail")
            self._conn_buttons(True)
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
                           pady=((SP["l"] if row == 0 else SP["s"]), 2))
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
            self.toggle_link.pack(fill="x", padx=SP["l"], pady=(SP["xs"], SP["m"]))
            self.back_btn.pack_forget()
            self.email_box.pack_forget()
        self.status.configure(text="")

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
