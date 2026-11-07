"""Pantalla de login/registro (email + password [+ displayName]).

Visual: terminal de acceso HUD — tarjeta con brackets de esquina, labels
mono en mayúsculas, acción única ámbar. Cero cambios de comportamiento.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import customtkinter as ctk

from api_client import ApiError, NetworkError
from ui.hud import BracketCard, hairline, primary_button, section_label
from ui.theme import COLORS, RADIUS, SP, font, section_text, tracked

if TYPE_CHECKING:  # evita import circular solo por tipado
    from ui.main_window import App

log = logging.getLogger("ui.login")

FIELD_W = 320


class LoginFrame(ctk.CTkFrame):
    """Formulario de entrada; el enlace inferior alterna modo registro."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg_deep"])
        self.app = app
        self._register_mode = False

        # --- Bloque de identidad (display) -----------------------------------
        ctk.CTkLabel(
            self, text=section_text("TERMINAL DE JUGADOR"),
            font=font(10, "bold", mono=True), text_color=COLORS["text_faint"],
        ).pack(pady=(64, SP["s"]))
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
        ).pack(pady=(0, SP["xl"]))

        # --- Tarjeta HUD con brackets ----------------------------------------
        card = BracketCard(self, accent=True)
        card.pack(padx=SP["xl"], pady=SP["s"])
        body = card.inner

        # Campos: NICK siempre visible (credencial de entrada); el EMAIL solo
        # existe al CREAR la cuenta (gestión), en su propia caja oculta.
        self.nick = self._make_entry(body, "pollacaballo")
        self._field(body, "NICK", self.nick, 0)
        self.password = self._make_entry(body, "••••••••", show="•")
        self._field(body, "CONTRASEÑA", self.password, 1)

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

    # --- Comportamiento (idéntico al previo) --------------------------------
    def _toggle_mode(self) -> None:
        """Alterna entre login (solo NICK) y creación (EMAIL + NICK + clave)."""
        self._register_mode = not self._register_mode
        if self._register_mode:
            self.action_btn.configure(text="CREAR CUENTA")
            self.toggle_link.configure(text="Ya tengo cuenta: entrar")
            # El email reaparece justo antes de la línea de estado.
            self.email_box.pack(fill="x", before=self.status)
        else:
            self.action_btn.configure(text="ENTRAR")
            self.toggle_link.configure(text="¿No tienes cuenta? Crear cuenta")
            self.email_box.pack_forget()
        self.status.configure(text="")

    def _on_submit(self) -> None:
        """Valida el formulario y delega en App (petición en hilo de fondo)."""
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

        self.action_btn.configure(state="disabled", text="Conectando…")
        self.status.configure(text="")

    def _on_result(self, error=None) -> None:
        """Callback desde el hilo principal tras la petición de auth."""
        self.action_btn.configure(
            state="normal",
            text="CREAR CUENTA" if self._register_mode else "ENTRAR",
        )
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
        else:  # NetworkError
            msg = str(error)
        self.status.configure(text=msg, text_color=COLORS["danger"])
        log.info("Fallo de autenticación en pantalla login: %s", msg)
