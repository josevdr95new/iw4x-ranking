"""Flujo JUGAR: vincular cuenta ↔ GUID y abrir el juego.

Corre en un hilo de fondo para no congelar la UI y se comunica mediante
eventos (dicts) a través de un callback ``emit``:

  {"t": "log",     "msg": "..."}                     → línea en la consola mini
  {"t": "success", "msg": "...", "linked": bool}     → fin correcto
  {"t": "failed",  "msg": "...", "retry": bool}      → fin con error (retry
                                                      habilita el botón)

Vinculación AUTOMÁTICA por nombre: en cada poll se busca un candidato cuyo
nick normalizado coincida con el displayName de la cuenta (``pick_candidate``)
y se confirma sin preguntar nada. Si nadie coincide se sigue esperando hasta
el timeout. No hay diálogo de selección.

Compatible con el modelo multi-GUID: si el usuario ya tiene ``linkedGuids``
la UI salta la verificación y solo abre el juego.
"""
from __future__ import annotations

import logging
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from api_client import ApiClient, ApiError, NetworkError

log = logging.getLogger("game_flow")

EventCallback = Callable[[Dict[str, Any]], None]

# Códigos de color de Quake (^1, ^7, ^a…) que el server mete en los nicks.
_COLOR_CODE_RE = re.compile(r"\^[0-9a-zA-Z]")


def strip_color_codes(name: str) -> str:
    """Quita códigos de color ^X de un nick proveniente del server."""
    return _COLOR_CODE_RE.sub("", str(name or ""))


def candidate_matches(candidate_name: str, display_name: str) -> bool:
    """¿El nick del candidato coincide con el displayName de la cuenta?

    Normalización: se eliminan los códigos de color ^X del nick del server
    y se compara trim + lower. Función pura, testeable.
    """
    nick = strip_color_codes(candidate_name).strip().lower()
    expected = (display_name or "").strip().lower()
    return bool(nick) and bool(expected) and nick == expected


def pick_candidate(candidates, display_name):
    """Elige el candidato a confirmar según el nick de la cuenta (pura).

    - Normaliza cada ``name`` (códigos ^X fuera, trim, lower) y se queda con
      los que coinciden con ``display_name``.
    - Si hay varios con el mismo nick, desambigua por recencia: gana el de
      ``lastConnection`` más alta (ISO-8601 ordena lexicográficamente).
    - Devuelve el candidate dict elegido o None si nadie coincide.
    """
    matches = [c for c in (candidates or [])
               if candidate_matches(c.get("name"), display_name)]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    return max(matches, key=lambda c: str(c.get("lastConnection") or ""))


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

        # Cancelación (al cerrar la ventana o cerrar sesión).
        self._cancelled = threading.Event()

    # --- API hacia la UI ----------------------------------------------------
    def cancel(self) -> None:
        """Pide abortar el flujo lo antes posible."""
        self._cancelled.set()

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
            return "Tu identidad ya está verificada."
        if exc.code == "GUID_ALREADY_LINKED":
            return (
                "Ese GUID ya pertenece a otra cuenta — no puedes vincularlo. "
                "Si es tu PC compartida, cada jugador debe crear y usar SU "
                "propia cuenta."
            )
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
                self._success("Tu identidad ya estaba verificada ✓", linked=True)
                return True
            self._failed(self._api_error_text(exc), retry=True)
            return True
        except NetworkError as exc:
            self._failed(str(exc), retry=True)
            return True

        name = data.get("name") or "?"
        server = data.get("server") or "—"
        self._log(f"Identidad verificada ✓  Jugador: {name} · GUID: {guid} · Server: {server}")
        self._success("Identidad verificada ✓", linked=True)
        return True

    def _run(self) -> None:
        self._log(f"Preparando conexión al server {self.server_address}…")

        # 0) Cuenta ya vinculada: no hay flujo de vinculación, solo jugamos.
        if self.already_linked:
            self._log("Tu identidad ya está verificada: solo abrimos el juego.")
            if not self._launch_game():
                return
            self._success(
                f"Juego abierto. Conectando a {self.server_address}… ¡suerte!",
                linked=True,
            )
            return

        # 1) Registrar el intento de vinculación (solo se llama desde la UI
        #    cuando linkedGuid es null).
        self._log("Verificando tu identidad contra la API…")
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
                    self._success("Tu identidad ya estaba verificada ✓", linked=True)
                    return
                raise

            candidates = data.get("candidates") or []

            # Vinculación automática por nombre: SOLO se confirma un
            # candidato cuyo nick (normalizado) coincida con la cuenta.
            picked = pick_candidate(candidates, self.display_name)

            if picked is not None:
                guid = str(picked.get("guid", ""))
                nick = strip_color_codes(str(picked.get("name", "")))
                same_nick = sum(
                    1 for c in candidates
                    if candidate_matches(c.get("name"), self.display_name)
                )
                if same_nick > 1:
                    self._log(
                        f"Varios jugadores con tu nick '{nick}' en el server: "
                        f"elegimos el de conexión más reciente (GUID {guid})."
                    )
                else:
                    self._log(f"Identidad detectada en el server: {nick} (GUID {guid})")
                self._confirm_guid(guid)  # siempre termina el flujo
                return

            # Nadie con nuestro nick (aunque haya otros jugadores): seguimos.
            remaining = max(0, int(deadline - time.monotonic()))
            self._log(
                f"Aún no te vemos en el server… intento {attempt} "
                f"(quedan {remaining}s)"
            )

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
            self._failed("Verificación de identidad cancelada.", retry=False)
        else:
            nick = (self.display_name or "").strip() or "tu nick"
            self._failed(
                f"No vimos entrar a nadie con tu nick ({nick}). "
                "¿Entraste al server? El juego debe abrirse con el nick de tu cuenta.",
                retry=True,
            )
