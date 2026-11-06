"""Pantalla de login/registro (email + password [+ displayName])."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import customtkinter as ctk

from api_client import ApiError, NetworkError
from ui.theme import COLORS, font

if TYPE_CHECKING:  # evita import circular solo por tipado
    from ui.main_window import App

log = logging.getLogger("ui.login")


class LoginFrame(ctk.CTkFrame):
    """Formulario de entrada; el botón del enlace alterna modo registro."""

    def __init__(self, master, app: "App") -> None:
        super().__init__(master, fg_color=COLORS["bg"])
        self.app = app
        self._register_mode = False

        # --- Título ---------------------------------------------------------
        ctk.CTkLabel(
            self, text="IW4X RANKING", font=font(30, "bold"),
            text_color=COLORS["text"],
        ).pack(pady=(70, 2))
        ctk.CTkLabel(
            self, text="Inicia sesión para jugar y vincular tu GUID",
            font=font(13), text_color=COLORS["text_dim"],
        ).pack(pady=(0, 30))

        # --- Tarjeta del formulario ------------------------------------------
        card = ctk.CTkFrame(self, fg_color=COLORS["panel"], corner_radius=14)
        card.pack(padx=40, pady=10)

        self.email = ctk.CTkEntry(
            card, width=300, height=38, placeholder_text="Email",
            font=font(13),
        )
        self.email.pack(padx=24, pady=(24, 8))

        self.password = ctk.CTkEntry(
            card, width=300, height=38, placeholder_text="Contraseña",
            show="•", font=font(13),
        )
        self.password.pack(padx=24, pady=8)

        # Solo visible en modo registro.
        self.display_name = ctk.CTkEntry(
            card, width=300, height=38, placeholder_text="Nombre visible (tu tag)",
            font=font(13),
        )
        self.display_name.pack(padx=24, pady=8)
        self.display_name.pack_forget()

        # Mensaje de estado (errores de validación/red).
        self.status = ctk.CTkLabel(
            card, text="", font=font(12), text_color=COLORS["error"],
            wraplength=300, justify="left",
        )
        self.status.pack(padx=24, pady=(2, 0))

        self.action_btn = ctk.CTkButton(
            card, text="ENTRAR", width=300, height=42, font=font(14, "bold"),
            fg_color=COLORS["accent"], hover_color=COLORS["accent_hover"],
            command=self._on_submit,
        )
        self.action_btn.pack(padx=24, pady=(10, 6))

        # Enlace para alternar registro/login.
        self.toggle_link = ctk.CTkButton(
            card, text="¿No tienes cuenta? Crear cuenta",
            font=font(12), text_color=COLORS["text_dim"],
            fg_color="transparent", hover_color=COLORS["panel"],
            command=self._toggle_mode,
        )
        self.toggle_link.pack(padx=24, pady=(0, 18))

        # Enter = enviar.
        self.email.bind("<Return>", lambda _e: self._on_submit())
        self.password.bind("<Return>", lambda _e: self._on_submit())
        self.display_name.bind("<Return>", lambda _e: self._on_submit())

    # --- Comportamiento -------------------------------------------------------
    def _toggle_mode(self) -> None:
        """Alterna entre login y creación de cuenta."""
        self._register_mode = not self._register_mode
        if self._register_mode:
            self.action_btn.configure(text="CREAR CUENTA")
            self.toggle_link.configure(text="Ya tengo cuenta: entrar")
            self.display_name.pack(padx=24, pady=8)  # type: ignore[no-untyped-call]
        else:
            self.action_btn.configure(text="ENTRAR")
            self.toggle_link.configure(text="¿No tienes cuenta? Crear cuenta")
            self.display_name.pack_forget()
        self.status.configure(text="")

    def _on_submit(self) -> None:
        """Valida el formulario y delega en App (petición en hilo de fondo)."""
        email = self.email.get().strip()
        password = self.password.get()
        if self._register_mode:
            display = self.display_name.get().strip()
            if not email or not password or not display:
                self.status.configure(
                    text="Rellena email, contraseña y nombre visible.",
                    text_color=COLORS["warn"],
                )
                return
            self.app.register(email, password, display, self._on_result)
        else:
            if not email or not password:
                self.status.configure(
                    text="Introduce tu email y contraseña.", text_color=COLORS["warn"]
                )
                return
            self.app.login(email, password, self._on_result)

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
        self.status.configure(text=msg, text_color=COLORS["error"])
        log.info("Fallo de autenticación en pantalla login: %s", msg)
