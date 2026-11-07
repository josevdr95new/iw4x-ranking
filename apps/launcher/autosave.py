"""Auto-guardado periódico del progreso en la nube (hilo de fondo).

Pedido del dueño: "siempre antes de cerrar el launcher y cada X tiempo se
deben salvar los datos del user en la nube para evitar pérdida de progreso".

Reglas del tick (upload-only, decisión de ``decide_sync``):
- Sube SOLO si lo local es más nuevo que el manifiesto del server (o el
  server no tenía save). NUNCA pisa una versión más nueva del server.
- Idéntico al último manifiesto visto → ni consulta la API (caché de hashes).
- Lectura segura con el juego abierto: si un save falla al leerse (el juego
  escribe el .stat a mitad de ronda) el tick se SALTA y reintenta después.
- NUNCA dos subidas concurrentes (``save_sync.UPLOAD_LOCK``) y NUNCA bloquea
  la UI: el ciclo corre en un hilo daemon propio y los logs llegan por
  callback (la App los encola con ``post()``).
- El intervalo aplica TAMBIÉN mientras se juega: si la PC muere a mitad de
  sesión, se pierde como máximo lo de los últimos X minutos (el flush del
  juego es a fin de ronda, así que lo subido es lo último flushed).
"""
from __future__ import annotations

import hashlib
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from save_sync import UPLOAD_LOCK, default_guid_path, sync_after_session

log = logging.getLogger("autosave")


def collect_local_hashes(game_dir: str,
                         guid_path: Optional[str] = None
                         ) -> Tuple[Dict[str, str], List[str]]:
    """Mapea y hashea los saves locales con lectura defensiva.

    Devuelve ``(hashes, failed)``:
    - ``hashes``: {rel: sha256} SOLO de los archivos legibles y existentes.
    - ``failed``: rutas que EXISTEN pero fallaron al leerse (típico: el juego
      está escribiendo el .stat a medias) → el tick debe saltarse entero.
    Los archivos ausentes NO son fallo (todavía no hay save).
    """
    from save_sync import local_save_files  # import tardío: evita ciclos

    hashes: Dict[str, str] = {}
    failed: List[str] = []
    for rel, path in local_save_files(game_dir, guid_path=guid_path).items():
        p = Path(path)
        if not p.exists():
            continue  # ausente: no es error, no hay nada que subir de eso
        try:
            digest = hashlib.sha256()
            with p.open("rb") as fh:
                for chunk in iter(lambda: fh.read(64 * 1024), b""):
                    digest.update(chunk)
            hashes[rel] = digest.hexdigest()
        except OSError:
            # En escritura (o bloqueado): NO se sube a medias; se reintenta.
            failed.append(rel)
    return hashes, failed


class Autosave:
    """Auto-guardado periódico del progreso (upload-only, best-effort).

    Los providers (callables) se resuelven en CADA tick para que los cambios
    de config/login apliquen al vuelo sin reiniciar nada.
    """

    def __init__(
        self,
        *,
        period_provider: Callable[[], Any],
        token_provider: Callable[[], Optional[str]],
        game_dir_provider: Callable[[], str],
        cloud_provider: Callable[[], bool],
        api_provider: Callable[[], Any],
        log_cb: Optional[Callable[[str], None]] = None,
        granularity: float = 60.0,
        guid_path: Optional[str] = None,
    ) -> None:
        self.period_provider = period_provider
        self.token_provider = token_provider
        self.game_dir_provider = game_dir_provider
        self.cloud_provider = cloud_provider
        self.api_provider = api_provider
        self.log_cb = log_cb
        self.granularity = max(1.0, float(granularity))
        self._guid_path = guid_path or default_guid_path()

        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        # Manifiesto (hashes del server) visto en el último sync con API:
        # si lo local es idéntico, el próximo tick ni consulta la API.
        self._cached_hashes: Optional[Dict[str, str]] = None

        # Contadores (diagnóstico y tests).
        self.ticks = 0
        self.api_ticks = 0        # ticks que consultaron la API
        self.upload_ticks = 0     # ticks que hicieron PUT

    # --- Ciclo de vida ------------------------------------------------------
    def start(self) -> None:
        """Arranca el hilo daemon del ciclo (idempotente)."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="autosave")
        self._thread.start()

    def stop(self) -> None:
        """Pide parar el ciclo (el hilo muere en el próximo chequeo)."""
        self._stop.set()

    def _loop(self) -> None:
        """Ciclo: espera ``autosave_minutes`` (revisado cada granularidad)."""
        elapsed = 0.0
        while not self._stop.wait(self.granularity):
            try:
                period = float(self.period_provider() or 0)
            except Exception:
                period = 0.0
            if period <= 0:
                elapsed = 0.0  # desactivado (o config aún 0): re-chequear
                continue
            elapsed += self.granularity
            if elapsed + 1e-9 >= period * 60.0:
                elapsed = 0.0
                try:
                    self.tick()
                except Exception:  # un tick roto NUNCA mata el ciclo
                    log.exception("autosave: tick falló; se reintenta")

    # --- Logging ------------------------------------------------------------
    def _log(self, msg: str) -> None:
        log.info("[autosave] %s", msg)
        if self.log_cb is not None:
            try:
                self.log_cb(msg)
            except Exception:
                pass

    # --- Un tick --------------------------------------------------------------
    def tick(self, force: bool = False,
             budget: Optional[float] = None) -> Optional[str]:
        """Un intento de auto-guardado.

        - ``force=True`` ignora el caché de hashes (guardado final al cerrar)
          pero mantiene la decisión (idéntico → sin PUT; server más nuevo →
          no se pisa). También espera el lock si hay otra subida en vuelo.
        - ``budget`` acota la espera (cierre del launcher, ~10s): corre en un
          hilo propio y se abandona si tarda más. Sin budget corre inline
          (es lo que hace el hilo del ciclo).

        Devuelve una etiqueta para diagnóstico/tests: "upload" | "noop" |
        "download" (server más nuevo → omitido) | "skip-identical" |
        "skip-concurrent" | "busy-read" | "disabled" | "error" | "timeout".
        """
        self.ticks += 1
        if budget is None:
            try:
                return self._tick_impl(force)
            except Exception:
                log.exception("autosave: tick falló")
                return "error"
        box: Dict[str, Optional[str]] = {"r": None}

        def work() -> None:
            try:
                box["r"] = self._tick_impl(force)
            except Exception:
                log.exception("autosave: tick (budget) falló")

        t = threading.Thread(target=work, daemon=True, name="autosave-tick")
        t.start()
        t.join(budget)
        if t.is_alive():
            self._log("autosave: la subida sigue en curso; el cierre "
                      "continúa (best-effort).")
            return "timeout"
        return box["r"]

    def _tick_impl(self, force: bool) -> Optional[str]:
        period = float(self.period_provider() or 0)
        token = self.token_provider()
        game_dir = (self.game_dir_provider() or "").strip()
        cloud = bool(self.cloud_provider())
        if (not cloud) or (not token) or (not game_dir) \
                or (period <= 0 and not force):
            return "disabled"

        # NUNCA dos subidas concurrentes: el tick del ciclo no espera (skip);
        # el forzado del cierre espera acotado (budget ya acota el join).
        if force:
            got = UPLOAD_LOCK.acquire(timeout=30.0)
        else:
            got = UPLOAD_LOCK.acquire(blocking=False)
        if not got:
            log.debug("autosave: otra subida en vuelo; tick omitido")
            return "skip-concurrent"
        try:
            return self._tick_locked(token, game_dir, period, force)
        finally:
            UPLOAD_LOCK.release()

    def _tick_locked(self, token: str, game_dir: str, period: float,
                     force: bool) -> Optional[str]:
        hashes, failed = collect_local_hashes(game_dir,
                                              guid_path=self._guid_path)
        if failed:
            self._log(f"autosave: archivo en escritura "
                      f"({', '.join(failed)}), reintentando en "
                      f"{max(1, int(period or 1))} min")
            return "busy-read"
        if not hashes:
            log.debug("autosave: sin progreso local todavía")
            return "noop"
        # Eficiencia: idéntico al último manifiesto visto → sin llamada.
        if not force and self._cached_hashes == hashes:
            log.debug("autosave: sin cambios desde el último sync (sin API)")
            return "skip-identical"

        self.api_ticks += 1
        # Los logs internos de sync_after_session van SOLO al archivo
        # (log.info): en la consola el autosave es discreto por diseño.
        try:
            result = sync_after_session(self.api_provider(), token, game_dir,
                                        log=log.info,
                                        guid_path=self._guid_path)
        except Exception as exc:
            self._cached_hashes = None  # incertidumbre: re-chequear luego
            self._log(f"autosave: no se pudo subir ahora "
                      f"({exc.__class__.__name__}); se reintenta en el "
                      f"próximo ciclo")
            return "error"

        if result == "upload":
            self.upload_ticks += 1
            self._cached_hashes = hashes  # el server quedó EXACTO a esto
            self._log("Auto-guardado: progreso sincronizado ✓")
        elif result == "download":
            # El server está más nuevo: se respeta, JAMÁS se pisa desde acá.
            self._cached_hashes = None
            self._log("Auto-guardado omitido: el server tiene versión más "
                      "nueva, se respeta al arrancar.")
        else:  # noop: el server ya tenía exactamente estos hashes
            self._cached_hashes = hashes
            log.debug("autosave: sin cambios en tu progreso")
        return result
