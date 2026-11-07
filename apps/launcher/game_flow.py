"""Flujo JUGAR: vincular cuenta ↔ GUID y abrir el juego.

Corre en un hilo de fondo para no congelar la UI y se comunica mediante
eventos (dicts) a través de un callback ``emit``:

  {"t": "log",     "msg": "..."}                     → línea en la consola mini
  {"t": "ask",     "candidates": [...]}              → la UI muestra el diálogo
                                                      de elección y responde con
                                                      respond_choice(guid|None)
  {"t": "success", "msg": "...", "linked": bool}     → fin correcto
  {"t": "failed",  "msg": "...", "retry": bool}      → fin con error (retry
                                                      habilita el botón)

Compatible con el modelo actual (1 GUID por cuenta): si el usuario ya tiene
``linkedGuid`` la UI salta la vinculación y solo abre el juego.
"""
from __future__ import annotations

import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from api_client import ApiClient, ApiError, NetworkError

log = logging.getLogger("game_flow")

EventCallback = Callable[[Dict[str, Any]], None]


def build_game_args(
    game_path: str,
    server_address: str,
    display_name: str = "",
) -> List[str]:
    """Construye el comando de arranque del juego (función pura, testeable).

    Devuelve una LISTA de argumentos (nunca string para shell): así los
    espacios en el nick no rompen nada. Formato:

        [iw4x.exe, +set, name, <nick>, +connect, <ip:puerto>]

    El nick del ranking SIEMPRE viaja en el comando (decisión del dueño: el
    juego arranca con el displayName de la cuenta, sin toggle ni config).
    Los engines Q3 procesan ``+set`` después de cargar las configs, por lo
    que el nick queda vigente para la sesión aunque el config del juego
    tenga guardado otro nombre. Si ``display_name`` viene vacío no se añade
    el ``+set`` — GameFlow bloquea el arranque antes de llegar aquí.
    """
    args = [game_path]
    nick = (display_name or "").strip()
    if nick:
        args += ["+set", "name", nick]
    args += ["+connect", server_address]
    return args


class GameFlow:
    """Un intento de 'jugar' (con o sin vinculación pendiente)."""

    def __init__(
        self,
        api: ApiClient,
        token: str,
        game_path: str,
        server_address: str,
        emit: EventCallback,
        *,
        already_linked: bool = False,
        simulate: bool = False,
        poll_interval: int = 10,
        poll_max_seconds: int = 180,
        display_name: str = "",
    ) -> None:
        self.api = api
        self.token = token
        self.game_path = game_path
        self.server_address = server_address
        self.emit = emit
        self.already_linked = already_linked
        self.simulate = simulate
        self.poll_interval = poll_interval
        self.poll_max_seconds = poll_max_seconds
        self.display_name = display_name

        # Sincronización con el diálogo de candidatos (multi-GUID detectado).
        self._choice = threading.Event()
        self._choice_guid: Optional[str] = None
        # Cancelación (al cerrar la ventana o cerrar sesión).
        self._cancelled = threading.Event()

    # --- API hacia la UI ----------------------------------------------------
    def respond_choice(self, guid: Optional[str]) -> None:
        """La UI llama a esto cuando el usuario elige (o no) su GUID."""
        self._choice_guid = guid
        self._choice.set()

    def cancel(self) -> None:
        """Pide abortar el flujo lo antes posible."""
        self._cancelled.set()
        # Si estábamos esperando una elección, desbloqueamos con None.
        self.respond_choice(None)

    # --- Hilo de trabajo ----------------------------------------------------
    def run(self) -> None:
        """Punto de entrada del hilo (ver App.start_play)."""
        try:
            self._run()
        except NetworkError as exc:
            self._failed(str(exc), retry=True)
        except ApiError as exc:
            self._failed(self._api_error_text(exc), retry=True)
        except Exception:  # rara vez: no queremos matar la app
            log.exception("Fallo inesperado en el flujo JUGAR")
            self._failed("Ocurrió un error inesperado. Mira el log para detalles.", retry=True)

    # --- Internos -------------------------------------------------------------
    def _log(self, msg: str) -> None:
        log.info("[flow] %s", msg)
        self.emit({"t": "log", "msg": msg})

    def _failed(self, msg: str, retry: bool = False) -> None:
        log.warning("[flow] fallo: %s", msg)
        self.emit({"t": "failed", "msg": msg, "retry": retry})

    def _success(self, msg: str, linked: bool) -> None:
        log.info("[flow] éxito: %s", msg)
        self.emit({"t": "success", "msg": msg, "linked": linked})

    @staticmethod
    def _api_error_text(exc: ApiError) -> str:
        """Traduce los códigos del envelope a frases para el jugador."""
        if exc.code == "USER_ALREADY_LINKED":
            return "Tu cuenta ya está vinculada a un GUID."
        if exc.code == "GUID_ALREADY_LINKED":
            return "Ese GUID ya está vinculado a otra cuenta."
        if exc.code == "PLAYER_NOT_FOUND":
            return "La API no reconoce ese jugador. ¿Corriste el sync?"
        if exc.code == "UNAUTHORIZED":
            return "Tu sesión expiró. Inicia sesión de nuevo."
        return exc.message

    # Mensaje oficial cuando la cuenta no tiene displayName (defensa: el
    # registro ya lo exige). Sin nick no hay partida — decisión del dueño.
    NO_NICK_MSG = (
        "Tu cuenta no tiene nombre visible: actualízalo en Mi Cuenta (web) "
        "antes de jugar."
    )

    def _launch_game(self) -> bool:
        """Abre iw4x.exe conectando al server elegido. False si no se pudo."""
        # El nick del ranking es OBLIGATORIO: sin displayName no se lanza.
        if not (self.display_name or "").strip():
            self._failed(self.NO_NICK_MSG, retry=False)
            return False

        cmd = build_game_args(
            self.game_path, self.server_address, self.display_name
        )

        if self.simulate:
            self._log("SIMULACIÓN: se omite la apertura del juego (modo prueba).")
            self._log("SIMULACIÓN: comando: " + subprocess.list2cmdline(cmd))
            return True

        exe = Path(self.game_path)
        if not exe.is_file():
            self._failed(
                f"No encuentro el juego en: {self.game_path}\n"
                "Revísalo en Ajustes.",
                retry=False,
            )
            return False

        self._log(f"Abriendo juego… {subprocess.list2cmdline(cmd[1:])}")
        try:
            subprocess.Popen(cmd, cwd=str(exe.parent))
            return True
        except OSError as exc:
            self._failed(f"No se pudo abrir el juego: {exc}", retry=True)
            return False

    def _confirm_guid(self, guid: str) -> bool:
        """Confirma la vinculación con {guid}. True si el flujo terminó aquí."""
        self._log(f"Confirmando GUID {guid}…")
        try:
            data = self.api.link_confirm(self.token, guid)
        except ApiError as exc:
            if exc.status == 409 and exc.code == "USER_ALREADY_LINKED":
                # La cuenta ya tenía GUID: para el jugador es un éxito.
                self._success("Tu cuenta ya está vinculada ✓", linked=True)
                return True
            self._failed(self._api_error_text(exc), retry=True)
            return True
        except NetworkError as exc:
            self._failed(str(exc), retry=True)
            return True

        name = data.get("name") or "?"
        server = data.get("server") or "—"
        self._log(f"Cuenta vinculada ✓  Jugador: {name} · GUID: {guid} · Server: {server}")
        self._success("Cuenta vinculada ✓", linked=True)
        return True

    def _ask_candidate(self, candidates: List[Dict[str, Any]]) -> Optional[str]:
        """Pide a la UI que muestre el diálogo de candidatos y espera la elección."""
        self.emit({"t": "ask", "candidates": candidates})
        # El hilo queda bloqueado hasta que la UI responda (o cancel()).
        self._choice.wait()
        return self._choice_guid

    def _run(self) -> None:
        self._log(f"Preparando conexión al server {self.server_address}…")

        # 0) Cuenta ya vinculada: no hay flujo de vinculación, solo jugamos.
        if self.already_linked:
            self._log("Tu cuenta ya está vinculada: solo abrimos el juego.")
            if not self._launch_game():
                return
            self._success(
                f"Juego abierto. Conectando a {self.server_address}… ¡suerte!",
                linked=True,
            )
            return

        # 1) Registrar el intento de vinculación (solo se llama desde la UI
        #    cuando linkedGuid es null).
        self._log("Registrando intento de vinculación en la API…")
        self.api.link_start(self.token)

        # 2) Lanzar el juego.
        if not self._launch_game():
            return
        self._log("Esperando tu conexión en el server…")

        # 3) Polling de candidatos: cada 10s durante 3 min (configurable).
        deadline = time.monotonic() + self.poll_max_seconds
        attempt = 0
        while time.monotonic() < deadline and not self._cancelled.is_set():
            attempt += 1
            try:
                data = self.api.link_candidates(self.token)
            except ApiError as exc:
                if exc.status == 409 and exc.code == "USER_ALREADY_LINKED":
                    self._success("Tu cuenta ya está vinculada ✓", linked=True)
                    return
                raise

            candidates = data.get("candidates") or []

            if len(candidates) == 1:
                guid = str(candidates[0].get("guid", ""))
                self._log(f"GUID detectado: {guid}")
                self._confirm_guid(guid)  # siempre termina el flujo
                return

            if len(candidates) > 1:
                self._log(
                    f"Vimos {len(candidates)} jugadores nuevos en el server. "
                    "Confirma cuál eres tú."
                )
                guid = self._ask_candidate(candidates)
                if self._cancelled.is_set() and not guid:
                    self._failed("Vinculación cancelada.", retry=False)
                    return
                if guid:
                    self._confirm_guid(guid)  # siempre termina el flujo
                    return
                # El usuario cerró el diálogo sin elegir: seguimos esperando.
                self._log("Sin confirmación; seguimos buscando…")
                continue

            remaining = max(0, int(deadline - time.monotonic()))
            self._log(
                f"Aún no te vemos en el server… intento {attempt} "
                f"(quedan {remaining}s)"
            )

            # sleep fragmentado para reaccionar rápido a cancel().
            slept = 0.0
            while slept < self.poll_interval:
                if self._cancelled.is_set():
                    break
                step = min(0.5, self.poll_interval - slept)
                time.sleep(step)
                slept += step

        if self._cancelled.is_set():
            self._failed("Vinculación cancelada.", retry=False)
        else:
            self._failed(
                "No detectamos tu entrada al server, ¿entraste? "
                "Conéctate al server y reintenta.",
                retry=True,
            )
