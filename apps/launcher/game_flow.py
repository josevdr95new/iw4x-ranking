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
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from api_client import ApiClient, ApiError, NetworkError
from logging_setup import app_data_dir
from save_sync import (UPLOAD_LOCK, default_guid_path, sync_after_session,
                       sync_before_launch)

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


KILL_TREE_TIMEOUT = 5.0  # segundos máximos de taskkill (best-effort, corto)


def kill_tree(pid: int, timeout: float = KILL_TREE_TIMEOUT) -> bool:
    """Mata el ÁRBOL completo del proceso ``pid`` (Windows: taskkill /T /F).

    SOLO se invoca con PIDs que el launcher lanzó (el Popen de GameFlow):
    NUNCA se mata por nombre de imagen — iw4x.exe también es el server
    dedicado y un ``taskkill /IM iw4x.exe`` lo tumbaría (prohibido).
    Best-effort: cualquier fallo (taskkill ausente, returncode != 0, PID
    inválido, excepción) devuelve False sin explotar.
    """
    try:
        pid = int(pid)  # rechaza None/basura sin lanzar
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":  # fallback POSIX (solo el proceso; sin árbol)
        try:
            os.kill(pid, 9)
            return True
        except OSError:
            return False
    try:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True, timeout=timeout, check=False,
        )
        return result.returncode == 0
    except Exception:  # OSError/TimeoutExpired/cualquier cosa: best-effort
        return False


def wait_process_exit(process: Any, timeout: float, poll: float = 0.1) -> bool:
    """Espera (poll) a que ``process`` muera. True si murió dentro del plazo."""
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            if process.poll() is not None:
                return True
        except Exception:  # proceso ya recolectado/handle roto: está muerto
            return True
        if time.monotonic() >= deadline:
            try:
                return process.poll() is not None
            except Exception:
                return True
        time.sleep(poll)


class GameFlow:
    """Un intento de 'jugar' (con o sin vinculación pendiente)."""

    # Presupuestos del cierre del launcher (siempre activo, sin toggle).
    GAME_EXIT_WAIT = 5.0       # espera (s) a que el proceso muera tras el kill
    GAME_UPLOAD_BUDGET = 10.0  # presupuesto (s) de la subida antes de cerrar

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
        cloud_save: bool = True,
        game_dir: str = "",
    ) -> None:
        self.api = api
        self.token = token
        self.game_path = game_path
        self.game_dir = game_dir
        self.server_address = server_address
        self.emit = emit
        self.already_linked = already_linked
        self.simulate = simulate
        self.poll_interval = poll_interval
        self.poll_max_seconds = poll_max_seconds
        self.display_name = display_name
        self.cloud_save = cloud_save
        self._process: Optional[Any] = None  # handle de Popen del juego

        # Cancelación (al cerrar la ventana o cerrar sesión).
        self._cancelled = threading.Event()

        # Upload post-sesión: EXACTAMENTE una vez por sesión. El hilo normal
        # (post p.wait()) y el cierre del launcher compiten por el mismo
        # worker; el guard evita subir el save dos veces.
        self._session_lock = threading.Lock()
        self._session_finalized = False
        self._upload_worker: Optional[threading.Thread] = None
        self._upload_result: Optional[str] = None

    # --- API hacia la UI ----------------------------------------------------
    def cancel(self) -> None:
        """Pide abortar el flujo lo antes posible."""
        self._cancelled.set()

    def game_pid(self) -> Optional[int]:
        """PID del juego que ESTE flujo lanzó (None si no hay juego)."""
        p = self._process
        if p is None:
            return None
        try:
            pid = int(p.pid)
        except (AttributeError, TypeError, ValueError):
            return None
        return pid or None

    def game_running(self) -> bool:
        """¿El juego lanzado por este flujo sigue vivo? (nunca mira otros)"""
        p = self._process
        if p is None:
            return False
        try:
            return p.poll() is None
        except Exception:
            return False

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
    def _transport_error_text(exc: Exception) -> str:
        """Mensaje en español para WARNING de sync (red o API)."""
        if isinstance(exc, NetworkError):
            return str(exc)
        if isinstance(exc, ApiError):
            return f"la API respondió {exc.code}: {exc.message}"
        return str(exc)

    def _upload_enabled(self) -> bool:
        """¿Toca subir progreso en esta sesión? (cloud_save activo y real)"""
        return bool(self.cloud_save and self.game_dir) and not self.simulate

    def _upload_once(self, budget: Optional[float] = None) -> None:
        """Sube el progreso UNA sola vez por sesión (guard anti-duplicado).

        La primera llamada gana el flag y lanza el worker en un hilo propio;
        las demás (hilo post-sesión vs. cierre del launcher) esperan al MISMO
        worker — nunca dos uploads. Con ``budget`` (cierre del launcher) la
        espera está acotada; con None (flujo normal) espera lo que tarde,
        igual que antes.
        """
        with self._session_lock:
            if self._session_finalized:
                worker = self._upload_worker  # alguien más ganó: esperarlo
            else:
                self._session_finalized = True
                if not self._upload_enabled():
                    return
                worker = threading.Thread(target=self._upload_work,
                                          daemon=True, name="save-upload")
                self._upload_worker = worker
                worker.start()  # arranca ya: el join de abajo lo espera
        if worker is None:
            return
        if budget is None:
            worker.join()          # flujo normal: espera como siempre
        else:
            worker.join(budget)    # cierre del launcher: presupuesto duro

    def _upload_work(self) -> None:
        """Cuerpo del upload post-sesión (corre en el worker dedicado)."""
        try:
            with UPLOAD_LOCK:  # JAMÁS dos PUTs de saves concurrentes
                self._upload_result = sync_after_session(
                    self.api, self.token, self.game_dir, log=self._log,
                    guid_path=default_guid_path(),
                )
        except (NetworkError, ApiError, OSError) as exc:
            self._upload_result = "error"
            self._log(f"⚠ Subida de progreso omitida: "
                      f"{self._transport_error_text(exc)}")
        except Exception:  # nunca tumbar el flujo/cierre por un upload
            self._upload_result = "error"
            log.exception("Upload post-sesión falló de forma inesperada")

    def _await_game_and_upload(self) -> None:
        """POST-sesión: espera al cierre de iw4x.exe y sube el progreso.

        Regla de oro: el juego hace flush del .stat al terminar la ronda, así
        que la subida solo ocurre cuando el proceso YA murió. NUNCA bloquea
        jugar ni toca nada en modo simulación. Si el launcher cerró el juego
        primero, el guard de ``_upload_once`` evita la doble subida.
        """
        if not self._upload_enabled():
            return
        process = self._process
        if process is None:
            return
        try:
            process.wait()
        except Exception:  # proceso ya recolectado: nada que esperar
            pass
        self._log("Juego cerrado: revisando tu progreso…")
        self._upload_once()

    def stop_game_for_exit(self) -> None:
        """Cierre del launcher con juego vivo: kill tree → muerte → upload.

        Comportamiento SIEMPRE (decisión del dueño, sin toggle). SOLO toca el
        árbol del PID que ESTE flujo lanzó — jamás por nombre de proceso (el
        server dedicado también es iw4x.exe). Presupuesto duro: ≤5s esperando
        la muerte + ≤10s de subida; después el cierre continúa sí o sí.
        Si el juego ya murió solo NO hace nada: el flujo post-sesión normal
        (``_await_game_and_upload``) se encarga y el upload no se duplica.
        """
        if not self.game_running():
            return
        pid = self.game_pid()
        self._log("Launcher cerrado: juego detenido.")
        killed = bool(pid) and kill_tree(pid)
        if pid and not killed:
            try:
                self._process.kill()  # fallback: al menos el proceso raíz
            except Exception:
                pass
        if not wait_process_exit(self._process, self.GAME_EXIT_WAIT):
            log.warning("El juego (PID %s) no confirmó su muerte a tiempo; "
                        "el cierre continúa", pid)
        self._log("Juego cerrado: revisando tu progreso…")
        self._upload_once(budget=self.GAME_UPLOAD_BUDGET)
        if self._upload_result == "upload":
            self._log("Progreso subido a tu cuenta ✓")

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
            self._process = subprocess.Popen(cmd, cwd=str(exe.parent))
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
        # Validación dura del nick: el juego SIEMPRE abre con el displayName.
        if not (self.display_name or "").strip():
            self._failed(self.NO_NICK_MSG, retry=False)
            return

        self._log(f"Preparando conexión al server {self.server_address}…")

        # Cloud-sync PRE-lanzamiento: dejar el progreso de la cuenta listo en
        # disco. En simulación no se toca nada. NUNCA bloquea jugar: cualquier
        # error se loggea como WARNING y se continúa.
        if self.simulate:
            self._log("Sincronización de progreso omitida (simulado).")
        elif self.cloud_save and self.game_dir:
            try:
                backup_root = (app_data_dir() / "save-backups"
                               / time.strftime("%Y%m%d-%H%M%S"))
                sync_before_launch(self.api, self.token, self.game_dir,
                                   log=self._log, backup_root=backup_root,
                                   guid_path=default_guid_path())
            except (NetworkError, ApiError, OSError) as exc:
                self._log(f"⚠ Sincronización de progreso omitida: "
                          f"{self._transport_error_text(exc)}")

        # 0) Cuenta ya verificada: no hay flujo de identidad, solo jugamos.
        if self.already_linked:
            self._log("Tu identidad ya está verificada: solo abrimos el juego.")
            if not self._launch_game():
                return
            self._success(
                f"Juego abierto. Conectando a {self.server_address}… ¡suerte!",
                linked=True,
            )
            self._await_game_and_upload()
            return

        # 1) Verificar identidad contra la API (sin diálogos: por nombre).
        self._log("Verificando tu identidad contra la API…")
        self.api.link_start(self.token)

        # 2) Lanzar el juego.
        if not self._launch_game():
            return
        self._log("Esperando tu conexión en el server…")

        # 3) Polling: cada poll busca un candidato con NUESTRO nick y lo
        #    confirma automáticamente (pick_candidate desambigua por recencia).
        deadline = time.monotonic() + self.poll_max_seconds
        attempt = 0
        while time.monotonic() < deadline and not self._cancelled.is_set():
            attempt += 1
            try:
                data = self.api.link_candidates(self.token)
            except ApiError as exc:
                if exc.status == 409 and exc.code == "USER_ALREADY_LINKED":
                    self._success("Tu identidad ya estaba verificada ✓", linked=True)
                    self._await_game_and_upload()
                    return
                raise

            candidates = data.get("candidates") or []
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
                self._await_game_and_upload()
                return

            # Nadie con nuestro nick (aunque haya otros jugadores): seguimos.
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
