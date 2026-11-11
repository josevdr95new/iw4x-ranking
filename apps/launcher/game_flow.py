"""Flujo JUGAR: preparar identidad/progreso y abrir el juego.

Corre en un hilo de fondo para no congelar la UI y se comunica mediante
eventos (dicts) a través de un callback ``emit``:

  {"t": "log",     "msg": "..."}                     → línea en la consola mini
  {"t": "success", "msg": "...", "linked": bool}     → fin correcto
  {"t": "failed",  "msg": "...", "retry": bool}      → fin con error (retry
                                                      habilita el botón)

Flujo SIMPLIFICADO (decisión del dueño): JUGAR → juego abre → el launcher se
queda en la home normal. NO hay pantalla de espera de candidatos ni polling
de vinculación: la identidad la vincula el SERVER solo (auto-link por sesión
de juego — ``POST /api/play/session``, que lanza la App). Los logs de la
consola sustituyen a la pantalla de verificación.

Aislamiento de guid.dat por cuenta (fix cyber-café): en el pre-launch
(SIEMPRE con el juego cerrado) se ejecutan DOS capas, en este orden:
1. ``decide_guid_action`` (por la nube): manifest con guid.dat → restore;
   manifest sin guid.dat y con local → CUARENTENA del local; sin ninguno →
   nada (el juego crea el primero).
2. ``decide_guid_validation`` (propiedad, backend /identity/* en vivo): el
   guid.dat VIGENTE se deriva en el server y se comprueba que sea de ESTA
   cuenta — cierra el robo residual (el dueño anterior de la PC subió el
   guid.dat compartido a su nube y el restore lo traía con confianza). Si
   es ajeno: cuarentena + ``claim-fresh`` y el juego crea identidad fresca
   que el auto-link por sesión ata a esta cuenta. API caída → sin
   cuarentena (se conserva la local).

Aislamiento del SAVE DE PROGRESIÓN (fix unlockstats): ``decide_stat_action``
aplica la MISMA regla por-nube al ``iw4x.stat`` base y a cada mod stat —
es UN archivo por PC y sin esta capa pepe heredaba el unlockstats de
admin. Cuarentena ANTES del sync (jamás sube progreso ajeno) y la misma
restauración de seguridad (<10s sin archivos nuevos → repuestos).
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from api_client import ApiClient, ApiError, NetworkError
from classes_export import default_store_path, export_player_classes
from logging_setup import app_data_dir
from save_sync import (GUID_REL, MIN_SIZE_CONFIG, MIN_SIZE_GUID,
                       MIN_SIZE_STAT, UPLOAD_LOCK, decide_guid_action,
                       decide_guid_validation, decide_stat_action,
                       default_guid_path, guid_file_b64,
                       quarantine_local_guid, quarantine_stat_file,
                       stat_rels, sync_after_session, sync_before_launch,
                       verify_restore_complete)

log = logging.getLogger("game_flow")

EventCallback = Callable[[Dict[str, Any]], None]


def build_game_args(
    game_path: str,
    server_address: str,
    display_name: str = "",
    export_classes: bool = True,
) -> List[str]:
    """Construye el comando de arranque del juego (función pura, testeable).

    Devuelve una LISTA de argumentos (nunca string para shell): así los
    espacios en el nick no rompen nada. Formato:

        [iw4x.exe, +set, name, <nick>, +connect, <ip:puerto>
         (, +dumpPlayerData)]

    El nick del ranking SIEMPRE viaja en el comando (decisión del dueño: el
    juego arranca con el displayName de la cuenta, sin toggle ni config).
    Los engines Q3 procesan ``+set`` después de cargar las configs, por lo
    que el nick queda vigente para la sesión aunque el config del juego
    tenga guardado otro nombre. Si ``display_name`` viene vacío no se añade
    el ``+set`` — GameFlow bloquea el arranque antes de llegar aquí.

    ``+dumpPlayerData`` (export_classes, default True) va AL FINAL, después
    de ``+connect``: los ``+`` comandos se ejecutan en orden tras cargar las
    configs, así el dump de clases (customClasses → console_mp.log del
    cliente) corre con el playerdata ya inicializado. Al cerrar la sesión,
    el launcher lee ese log y sube las clases a la API (ver
    ``classes_export.export_player_classes``).
    """
    args = [game_path]
    nick = (display_name or "").strip()
    if nick:
        args += ["+set", "name", nick]
    args += ["+connect", server_address]
    if export_classes:
        args += ["+dumpPlayerData"]
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


# Ventana (s) bajo la cual una sesión muerta cuenta como "falló antes de
# crear identidad": se repone el guid.dat cuarentenado.
GUID_RESTORE_WINDOW = 10.0


class GameFlow:
    """Un intento de 'jugar' (sync + identidad + abrir el juego)."""

    # Presupuestos del cierre del launcher (siempre activo, sin toggle).
    GAME_EXIT_WAIT = 5.0       # espera (s) a que el proceso muera tras el kill
    GAME_UPLOAD_BUDGET = 10.0  # presupuesto (s) de la subida antes de cerrar

    # Mensaje oficial cuando la cuenta no tiene displayName (defensa: el
    # registro ya lo exige). Sin nick no hay partida — decisión del dueño.
    NO_NICK_MSG = (
        "Tu cuenta no tiene nombre visible: actualízalo en Mi Cuenta (web) "
        "antes de jugar."
    )

    # Log de lanzamiento: sustituye a la (eliminada) pantalla de verificación.
    LAUNCH_MSG = (
        "Juego iniciado con tu nick. Tu identidad se vincula "
        "automáticamente al entrar al server."
    )

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
        display_name: str = "",
        cloud_save: bool = True,
        export_classes: bool = True,
        game_dir: str = "",
        user_id: str = "",
        guid_path: Optional[str] = None,
        quarantine_root_path: Optional[Path] = None,
        stat_quarantine_root_path: Optional[Path] = None,
        classes_store_path: Optional[Path] = None,
    ) -> None:
        self.api = api
        self.token = token
        self.game_path = game_path
        self.game_dir = game_dir
        self.server_address = server_address
        self.emit = emit
        self.already_linked = already_linked
        self.simulate = simulate
        self.display_name = display_name
        self.cloud_save = cloud_save
        # Exportación de clases (dump /dumpPlayerData → perfil web) y su
        # store de hash INYECTABLE (tests: jamás toca el %APPDATA% real).
        self.export_classes = export_classes
        self._classes_store_path = classes_store_path or default_store_path()
        self.user_id = user_id
        # Rutas INYECTABLES (tests): nunca tocar guid.dat ni saves reales en
        # pruebas.
        self.guid_path = guid_path or default_guid_path()
        self.quarantine_root_path = quarantine_root_path
        self.stat_quarantine_root_path = stat_quarantine_root_path
        self._process: Optional[Any] = None  # handle de Popen del juego
        self._launched_at: Optional[float] = None  # monotonic del lanzamiento

        # Verificación post-restore: lo que la nube de la cuenta tiene DEBE
        # quedar en disco ({ruta_absoluta: tamaño_mínimo}); vacío → nada que
        # verificar (cuenta nueva, cloud_save off o simulación).
        self._expected_restore: Dict[str, int] = {}

        # Cuarentena de identidad/progreso EN CURSO (para la restauración de
        # seguridad): [{"kind": "guid"|"stat", "file": cuarentenado,
        # "target": ruta original}, ...]
        self._quarantined: List[Dict[str, str]] = []

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
            self._failed(
                f"La API respondió {exc.status}: {exc.message}", retry=True
            )
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

    def _transport_error_text(self, exc: Exception) -> str:
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
                    guid_path=self.guid_path,
                )
        except (NetworkError, ApiError, OSError) as exc:
            self._upload_result = "error"
            self._log(f"⚠ Subida de progreso omitida: "
                      f"{self._transport_error_text(exc)}")
        except Exception:  # nunca tumbar el flujo/cierre por un upload
            self._upload_result = "error"
            log.exception("Upload post-sesión falló de forma inesperada")
        # Exportación de clases (dump del +dumpPlayerData → perfil web):
        # DESPUÉS del save, best-effort, con la misma filosofía no-bloqueante.
        self._maybe_upload_classes()

    def _maybe_upload_classes(self) -> Optional[str]:
        """Exporta las clases del dump del cliente (best-effort, nunca lanza).

        Solo con ``export_classes`` activo, ``game_dir`` conocido y fuera de
        simulación. ``export_player_classes`` ya traga red/API/disco (WARNING
        o skip dim); aquí solo se blinda lo inesperado para no tumbar el
        flujo/cierre del launcher.
        """
        if not (self.export_classes and self.game_dir) or self.simulate:
            return None
        try:
            return export_player_classes(
                self.api, self.token, self.game_dir, log_cb=self._log,
                store_path=self._classes_store_path,
            )
        except Exception:  # jamás bloquea jugar ni el cierre por esto
            log.exception("Exportación de clases falló de forma inesperada")
            return None

    def _await_game_and_upload(self) -> None:
        """POST-sesión: espera al cierre de iw4x.exe y sube el progreso.

        Regla de oro: el juego hace flush del .stat al terminar la ronda, así
        que la subida solo ocurre cuando el proceso YA murió. NUNCA bloquea
        jugar ni toca nada en modo simulación. Si el launcher cerró el juego
        primero, el guard de ``_upload_once`` evita la doble subida.

        Cuando el proceso muere emite SIEMPRE ``{"t": "game_closed", "flow":
        self}`` — también con cloud-sync apagado: es la señal con la que la
        UI devuelve el botón héroe a JUGAR cuando el juego se cierra solo.
        """
        process = self._process
        if process is not None:
            try:
                process.wait()
            except Exception:  # proceso ya recolectado: nada que esperar
                pass
            self._maybe_restore_quarantined_files()
            self.emit({"t": "game_closed", "flow": self})
        if not self._upload_enabled():
            return
        self._log("Juego cerrado: revisando tu progreso…")
        self._upload_once()

    def stop_game_for_exit(self, reason: str = "Launcher cerrado") -> None:
        """Cierre del launcher (o botón DETENER) con juego vivo: kill → subida.

        Comportamiento SIEMPRE (decisión del dueño, sin toggle). SOLO toca el
        árbol del PID que ESTE flujo lanzó — jamás por nombre de proceso (el
        server dedicado también es iw4x.exe). Presupuesto duro: ≤5s esperando
        la muerte + ≤10s de subida. Si el juego ya murió solo NO hace nada:
        el flujo post-sesión normal (``_await_game_and_upload``) se encarga y
        el upload no se duplica. ``reason`` personaliza el log (el botón
        DETENER lo llama sin cerrar el launcher).
        """
        if not self.game_running():
            return
        pid = self.game_pid()
        self._log(f"{reason}: juego detenido.")
        killed = bool(pid) and kill_tree(pid)
        if pid and not killed:
            try:
                self._process.kill()  # fallback: al menos el proceso raíz
            except Exception:
                pass
        if not wait_process_exit(self._process, self.GAME_EXIT_WAIT):
            log.warning("El juego (PID %s) no confirmó su muerte a tiempo; "
                        "el cierre continúa", pid)
        self._maybe_restore_quarantined_files()
        self._log("Juego cerrado: revisando tu progreso…")
        self._upload_once(budget=self.GAME_UPLOAD_BUDGET)
        if self._upload_result == "upload":
            self._log("Progreso subido a tu cuenta ✓")

    # --- Identidad (guid.dat) por cuenta -------------------------------------
    def _apply_guid_identity(self, manifest: Optional[Dict[str, Any]]) -> None:
        """Ejecuta ``decide_guid_action`` en el pre-launch (juego cerrado).

        Solo el caso "quarantine" mueve algo: el local (identidad de OTRO
        jugador de esta PC) va a la cuarentena y el juego, al arrancar sin
        guid.dat, crea uno nuevo y propio que el upload post-sesión sube a
        ESTA cuenta. "restore" ya lo resolvió el sync (download del manifest)
        y "none" no tiene nada que mover. En simulación no se toca nada y si
        el manifiesto no se pudo leer (red caída) NO se cuarentena: ante
        incertidumbre se conserva la identidad local.
        """
        if self.simulate:
            return
        try:
            local_exists = Path(self.guid_path).is_file()
        except OSError:
            return
        action = decide_guid_action(manifest, local_exists)
        if action != "quarantine":
            return
        dest = quarantine_local_guid(
            self.guid_path,
            user_id=self.user_id,
            root=self.quarantine_root_path,
        )
        if dest is None:
            self._log("⚠ No se pudo asegurar tu identidad en esta PC; "
                      "se conserva la identidad local.")
            return
        self._quarantined.append({
            "kind": "guid",
            "file": str(dest / "guid.dat"),
            "target": str(self.guid_path),
        })
        log.info("Identidad local cuarentenada (cuenta %s): %s",
                 self.user_id or "?", dest / "guid.dat")
        self._log("Identidad nueva creada para tu cuenta "
                  "(primera vez en esta PC)")

    def _validate_guid_ownership(self) -> None:
        """Capa NUEVA de propiedad del guid.dat (backend /identity/*, en vivo).

        Corre DESPUÉS de ``_apply_guid_identity`` (capa por-nube) sobre el
        guid.dat ya VIGENTE en disco. Caso real que cierra: el dueño anterior
        de la PC subió ese guid.dat COMPARTIDO a su nube → el restore lo
        traía con confianza y el siguiente jugador heredaba identidad ajena
        (pepe jugaba como admin). El backend deriva el GUID desde el propio
        archivo y responde ``ownedByMe`` / ``ownerNick``; la decisión pura es
        ``decide_guid_validation``:

        - "play" → log dim "Identidad verificada como tuya ✓" (cero fricción).
        - "quarantine+claim-fresh" → cuarentena del local (misma mecánica
          ``<userId>-<ts>``) + POST /identity/claim-fresh + log claro con el
          nick del dueño real; el juego arranca sin guid.dat, crea uno
          fresco y el auto-link por sesión lo vincula a ESTA cuenta.
        - "play-offline" → API caída o request fallido: se conserva la local
          SIN cuarentena (misma filosofía resiliente del sync).
        """
        if self.simulate:
            return
        b64 = guid_file_b64(self.guid_path)
        if b64 is None:
            return  # sin guid.dat local (cuenta 100% nueva): flujo none/fresh
        try:
            resp = self.api.guid_from_file(self.token, b64)
        except (NetworkError, ApiError, OSError) as exc:
            log.info("Validación de propiedad del guid.dat no disponible: %s", exc)
            self._log("No se pudo validar la identidad (sin conexión) — "
                      "se conserva la actual")
            return
        action = decide_guid_validation(
            owned_by_me=bool(resp.get("ownedByMe")),
            has_local_guid=True,  # garantizado: guid_file_b64 devolvió datos
            api_ok=True,          # el request no lanzó: llegamos aquí
        )
        if action == "play":
            self._log("Identidad verificada como tuya ✓")
            return
        # "quarantine+claim-fresh": el guid.dat vigente pertenece a OTRO.
        owner = str(resp.get("ownerNick") or "").strip()
        dest = quarantine_local_guid(
            self.guid_path,
            user_id=self.user_id,
            root=self.quarantine_root_path,
        )
        if dest is None:
            self._log("⚠ No se pudo asegurar tu identidad en esta PC; "
                      "se conserva la identidad local.")
            return
        self._quarantined.append({
            "kind": "guid",
            "file": str(dest / "guid.dat"),
            "target": str(self.guid_path),
        })
        log.info("guid.dat ajeno cuarentenado (cuenta %s): %s",
                 self.user_id or "?", dest / "guid.dat")
        try:
            self.api.claim_fresh(self.token)
        except (NetworkError, ApiError, OSError) as exc:
            self._log(f"⚠ No se pudo marcar tu cuenta para identidad nueva "
                      f"({self._transport_error_text(exc)}); el auto-link "
                      "podría no aceptarla.")
        tenia = (f"pertenecía a {owner}" if owner
                 else "no pertenece a tu cuenta")
        self._log(f"Ese guid.dat {tenia}. Se creará una identidad NUEVA "
                  "para tu cuenta.")

    def _apply_stat_identity(self, manifest: Optional[Dict[str, Any]]) -> int:
        """Aislamiento del SAVE DE PROGRESIÓN por cuenta (juego cerrado).

        Caso real (fix unlockstats): ``players\\iw4x.stat`` es UN SOLO
        archivo para TODA la PC — la cuenta nueva de pepe arrancaba con el
        ``unlockstats`` que admin dejó en el disco. Se aplica la MISMA regla
        del guid (``decide_stat_action``) al stat base y a CADA mod stat:

        - restore: el manifiesto de la cuenta trae ese stat → NADA (el sync
          baja el progreso de la cuenta; lo de tu nube es tuyo — el blob es
          cifrado, no se puede derivar dueño, la regla del manifiesto basta).
        - quarantine: la nube NO lo tiene y el local existe → se APARTA
          (stat-quarantine) ANTES del sync — así el sync JAMÁS sube a esta
          cuenta el progreso ajeno — y el juego arranca con save FRESCO
          (nivel 1). Log único exacto por pre-launch.
        - none: nada que mover.

        Los apartados entran en ``_quarantined`` (restauración de seguridad
        si la sesión muere <10s sin save nuevo). Devuelve cuántos apartó.
        En simulación no se toca nada.
        """
        if self.simulate:
            return 0
        try:
            rels = stat_rels((manifest or {}).get("files"), self.game_dir)
        except OSError:
            return 0
        en_nube = {str(f.get("path") or "") for f in (manifest or {}).get("files") or []
                   if isinstance(f, dict)}
        apartados = 0
        for rel in rels:
            local_path = Path(self.game_dir) / "players" / rel
            try:
                local_exists = local_path.is_file()
            except OSError:
                continue
            if decide_stat_action(rel in en_nube, local_exists) != "quarantine":
                continue
            dest = quarantine_stat_file(
                str(local_path), rel,
                user_id=self.user_id,
                root=self.stat_quarantine_root_path,
            )
            if dest is None:
                continue  # best-effort: sin poder apartarlo, se conserva
            self._quarantined.append({
                "kind": "stat",
                "file": str(dest / rel),
                "target": str(local_path),
            })
            apartados += 1
            log.info("Save de progresión ajeno apartado (cuenta %s): %s",
                     self.user_id or "?", dest / rel)
        if apartados:
            self._log("Save de progresión de otro usuario apartado — "
                      "empiezas desde cero (primera vez en esta PC)")
        return apartados

    def _maybe_restore_quarantined_files(self) -> None:
        """Restauración de seguridad: repone los cuarentenados (best-effort).

        Cubre guid.dat Y los saves de progresión apartados: si la sesión
        murió antes de crear archivos nuevos (<10s —o jamás llegó a
        abrirse— y sin archivo nuevo en la ruta original), CADA cuarentenado
        vuelve a su sitio. Una sola evaluación por sesión (consume el
        estado). Log por tipo: guid → "Tu identidad anterior fue repuesta…"
        (exacto de siempre); stat → "Tu save anterior fue repuesto…".
        """
        entries = self._quarantined
        if not entries:
            return
        self._quarantined = []
        lived_ok = (
            self._launched_at is not None
            and (time.monotonic() - self._launched_at) >= GUID_RESTORE_WINDOW
        )
        if lived_ok:
            return  # sesión larga sin archivos nuevos: no reponer (el upload manda)
        for info in entries:
            target = Path(info["target"])
            try:
                if target.is_file():
                    continue  # el juego ya creó/dejó su archivo: no se toca
            except OSError:
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                src = Path(info["file"])
                if src.is_file():
                    shutil.copy2(src, target)
                    if info.get("kind") == "stat":
                        self._log("Tu save anterior fue repuesto: la sesión "
                                  "no llegó a crear uno nuevo.")
                    else:
                        self._log("Tu identidad anterior fue repuesta: la "
                                  "sesión no llegó a crear una nueva.")
            except OSError:
                log.warning("No se pudo reponer el archivo cuarentenado",
                            exc_info=True)

    def _launch_game(self) -> bool:
        """Abre iw4x.exe conectando al server elegido. False si no se pudo."""
        # El nick del ranking es OBLIGATORIO: sin displayName no se lanza.
        if not (self.display_name or "").strip():
            self._failed(self.NO_NICK_MSG, retry=False)
            self._maybe_restore_quarantined_files()
            return False

        cmd = build_game_args(
            self.game_path, self.server_address, self.display_name,
            export_classes=self.export_classes,
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
            self._maybe_restore_quarantined_files()
            # Arranque fallido temprano: si quedó un dump nuevo de una sesión
            # previa sin subir, es el momento barato de intentarlo.
            self._maybe_upload_classes()
            return False

        self._log(f"Abriendo juego… {subprocess.list2cmdline(cmd[1:])}")
        try:
            self._process = subprocess.Popen(cmd, cwd=str(exe.parent))
            self._launched_at = time.monotonic()
            return True
        except OSError as exc:
            self._failed(f"No se pudo abrir el juego: {exc}", retry=True)
            self._maybe_restore_quarantined_files()
            self._maybe_upload_classes()
            return False

    def _prepare_session(self) -> None:
        """PRE-lanzamiento: cloud-sync + aislamiento de identidad.

        El manifiesto se consulta UNA vez y se comparte entre el sync y la
        decisión del guid.dat. NUNCA bloquea jugar: cualquier error se
        loggea como WARNING y se continúa. En simulación no se toca disco.
        """
        manifest: Optional[Dict[str, Any]] = None
        if self.simulate:
            self._log("Sincronización de progreso omitida (simulado).")
            return
        if not (self.cloud_save and self.game_dir):
            return
        try:
            manifest = self.api.save_manifest(self.token)
        except (NetworkError, ApiError, OSError) as exc:
            self._log(f"⚠ Sincronización de progreso omitida: "
                      f"{self._transport_error_text(exc)}")
            # Sin manifiesto no hay decisión segura de identidad: ante
            # incertidumbre se conserva la identidad local tal cual.
            self._log("No se pudo verificar tu identidad en la nube; "
                      "se conserva la identidad local de esta PC.")
            return
        # Aislamiento del SAVE DE PROGRESIÓN (iw4x.stat + mod stats): ANTES
        # del sync — así el sync JAMÁS sube a esta cuenta el progreso ajeno
        # que se acaba de apartar (caso unlockstats de admin heredado por
        # pepe). Con el manifiesto caído (red) no hay decisión segura: se
        # conserva TODO lo local (misma filosofía resiliente).
        self._apply_stat_identity(manifest)
        try:
            backup_root = (app_data_dir() / "save-backups"
                           / time.strftime("%Y%m%d-%H%M%S"))
            sync_before_launch(self.api, self.token, self.game_dir,
                               log=self._log, backup_root=backup_root,
                               guid_path=self.guid_path, manifest=manifest)
        except (NetworkError, ApiError, OSError) as exc:
            self._log(f"⚠ Sincronización de progreso omitida: "
                      f"{self._transport_error_text(exc)}")
        # SIEMPRE con el juego cerrado (estamos en pre-launch). Capa por-nube
        # (restore/cuarentena si el server no tiene guid.dat) y DESPUÉS la
        # capa de propiedad (el guid vigente debe ser de esta cuenta).
        self._apply_guid_identity(manifest)
        self._validate_guid_ownership()
        # Verificación post-restore: lo que la nube de la cuenta tiene DEBE
        # quedar en disco tras el sync. Mapeo rel → ruta local real (mismas
        # reglas que local_save_files) + tamaño mínimo por tipo (stat 100B ·
        # guid 64B · config 10B, constantes de save_sync).
        self._manifest = manifest
        expected: Dict[str, int] = {}
        cloud_paths = sorted({str(f.get("path") or "")
                              for f in (manifest or {}).get("files") or []
                              if isinstance(f, dict)})
        base = Path(self.game_dir) / "players"
        for rel in cloud_paths:
            if not rel:
                continue
            if rel == GUID_REL:
                expected[self.guid_path] = MIN_SIZE_GUID
            elif rel == "iw4x.stat" or (rel.startswith("mods/")
                                        and rel.endswith("/iw4x.stat")):
                expected[str(base / rel)] = MIN_SIZE_STAT
            else:
                expected[str(base / rel)] = MIN_SIZE_CONFIG
        self._expected_restore = expected

    def _verify_restore_step(self) -> None:
        """Verifica que el restore dejó TODO el progreso en disco.

        Regla del dueño: jugar JAMÁS se bloquea por sync. Si falta algo
        crítico (archivo ausente o menor que su tamaño mínimo), se reintenta
        el restore UNA vez; si sigue fallando, WARNING y se continúa igual.
        En simulación (o sin nada esperado: cuenta nueva, cloud_save off)
        el paso es un no-op que igualmente emite sus logs.
        """
        self._log("Verificando que se cargó todo…")
        if self.simulate or not self._expected_restore:
            self._log("Todo cargado ✓")
            return
        missing = verify_restore_complete(self._expected_restore)
        if missing:
            self._log(f"⚠ No se cargó todo ({len(missing)} archivo(s)) — "
                      "reintentando el restore una vez…")
            try:
                backup_root = (app_data_dir() / "save-backups"
                               / time.strftime("%Y%m%d-%H%M%S"))
                sync_before_launch(self.api, self.token, self.game_dir,
                                   log=self._log, backup_root=backup_root,
                                   guid_path=self.guid_path,
                                   manifest=self._manifest)
            except (NetworkError, ApiError, OSError) as exc:
                self._log(f"⚠ Reintento del restore falló: "
                          f"{self._transport_error_text(exc)}")
            missing = verify_restore_complete(self._expected_restore)
        if missing:
            self._log("⚠ No se pudo verificar todo tu progreso — se "
                      "continúa igual (no perder la partida)")
        else:
            self._log("Todo cargado ✓")

    def _run(self) -> None:
        """ORDEN del arranque (decisión del dueño):

        PASO 1 — CARGAR SAVE (sync/restore + aislamiento de identidad) y
                 VERIFICAR que se cargó todo (1 reintento del restore; si
                 sigue fallando, WARNING y se continúa: jugar jamás se
                 bloquea por sync).
        PASO 2 — EJECUTAR el exe (+dumpPlayerData si export_classes).

        Sin check previo del server (decisión del dueño): si está caído, el
        juego simplemente abre y falla al conectar dentro del juego.
        """
        # Validación dura del nick: el juego SIEMPRE abre con el displayName.
        if not (self.display_name or "").strip():
            self._failed(self.NO_NICK_MSG, retry=False)
            return

        # PASO 1/2 — CARGAR SAVE (los logs existentes del sync quedan).
        self._log("Paso 1/2: Cargando tu progreso…")
        self._prepare_session()
        if self._cancelled.is_set():
            return

        # Verificación del restore (nunca bloquea jugar).
        self._verify_restore_step()
        if self._cancelled.is_set():
            return

        # Cuenta ya verificada: mensaje directo; sin identidad, el server la
        # auto-vincula por sesión de juego (sin pantalla de verificación).
        if self.already_linked:
            self._log("Tu identidad ya está verificada: solo abrimos el juego.")

        # PASO 2/2 — EJECUTAR el juego (log de apertura existente dentro).
        self._log("Paso 2/2: Abriendo juego…")
        if self._cancelled.is_set():
            return
        if not self._launch_game():
            return
        self._log(self.LAUNCH_MSG)
        self._success(
            ("Juego abierto. Conectando a "
             f"{self.server_address}… ¡suerte!") if self.already_linked
            else self.LAUNCH_MSG,
            linked=self.already_linked,
        )
        self._await_game_and_upload()
